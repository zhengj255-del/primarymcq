import "./testDb";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sqlite } from "../storage";
import { WEAK_AREAS_SQL, SRS_SITTABLE_SQL, EFFECTIVE_ANSWER_SQL, NOT_DISCARDED_SQL } from "../mcqSittable";
import { listMcqs, getMcqStats, updateMcqOverride } from "../mcqs";
import { submitAttempt, getWeakAreas, startSession } from "../mcqStudy";

// -------------------------------------------------------------------------------------------------
// I-2 — ONE definition per question, pinned by AGREEMENT.
//
// Two predicates in this app answer questions that several surfaces ask
// independently: "could a sitting serve this question?" and "which topics is
// the candidate weak in?". Each had grown extra hand-typed copies. Every copy
// was CORRECT when written. That is exactly the failure mode: a copy is not
// wrong on the day it is made, it is wrong on the day somebody repairs the
// original and does not know the copy exists. This app has already paid that
// bill — the SRS count that promised reviews the queue refused to serve
// (mcq-engine-srs-study-1), and a weak-area copy that ranked a topic revealed
// with "Don't know" as a 0 % drill (mcq-engine-srs-study-2). Both were one
// surface repaired and another missed.
//
// So this file asserts nothing about WHAT the predicates decide. It asserts
// only that every surface gives the SAME answer on one seed, and that each
// surface's answer still matches the exported constant it is supposed to be
// running. Its job is to go RED the day a fresh copy appears and drifts.
//
// The dispute half of this file went with the Disputes page (Sep 2026) —
// nothing marks a question disputed any more. What replaces it is the
// assertion below that NOTHING is held out: the sittable predicate is now
// exactly "keyed and not discarded", and the bank the list shows is the bank
// a sitting can serve.
// -------------------------------------------------------------------------------------------------

const SITTABLE_M = `${EFFECTIVE_ANSWER_SQL} AND ${NOT_DISCARDED_SQL}`;

const sittableIdsFromConstant = () =>
  (sqlite.prepare(`SELECT m.id FROM mcqs m WHERE ${SITTABLE_M} ORDER BY m.id`)
    .all() as Array<{ id: string }>).map((r) => r.id);

/** Every id the list filter will page through, unfiltered. */
function allIdsFromListFilter(): string[] {
  const ids: string[] = [];
  let total = 0;
  for (let offset = 0; ; offset += 200) {
    const page = listMcqs({ limit: 200, offset });
    total = page.total;
    ids.push(...page.items.map((m) => m.id));
    if (page.items.length < 200) break;
  }
  expect(ids.length).toBe(total);
  return ids.sort();
}

const PAST = Date.now() - 60 * 60 * 1000;
function trackDue(id: string): void {
  sqlite.prepare(
    `INSERT OR REPLACE INTO mcq_srs_state (mcq_id, interval_days, reps, last_reviewed_at, due_at, created_at)
     VALUES (?, 5, 3, ?, ?, ?)`,
  ).run(id, PAST, PAST, PAST);
}

let SITTING: string;   // a sitting key, e.g. "2026B"
let KEPT: string;      // an ordinary sittable question — the control
let DISCARDED: string; // discarded by hand: the ONE way a question leaves the bank
let sittingBefore: { count: number; sittable: number };

describe("nothing is held out of the bank except a hand discard", () => {
  beforeAll(() => {
    sqlite.prepare("DELETE FROM mcq_overrides").run();
    sqlite.prepare("DELETE FROM mcq_srs_state").run();

    const paper = getMcqStats().sittings.find((p) => p.sittable >= 3);
    expect(paper, "corpus sanity: a sitting with >= 3 sittable questions").toBeTruthy();
    SITTING = paper!.key;
    sittingBefore = getMcqStats().sittings.find((p) => p.key === SITTING)!;

    // Read from the cached, space-padded sittings column — the same one the picker counts and the
    // session filter matches, so this fixture cannot drift from what it is testing.
    const ids = (sqlite.prepare(
      `SELECT id FROM mcqs WHERE answer IS NOT NULL AND instr(sittings, ?) > 0 ORDER BY id LIMIT 2`,
    ).all(` ${SITTING} `) as Array<{ id: string }>).map((r) => r.id);
    expect(ids.length, `corpus sanity: 2 answered ${SITTING} questions`).toBe(2);
    [KEPT, DISCARDED] = ids;
    for (const id of ids) trackDue(id);
  });

  it("every keyed question in the shipped corpus is sittable — nothing is parked", () => {
    // THE assertion the Disputes removal is for. Before it, 79 questions
    // carried disputed = 1 and no sitting would serve them; the only screen
    // that could release one was the page that has now gone. If a future
    // corpus, ingest or predicate starts holding questions back again, the
    // two counts part company here.
    const keyed = (sqlite.prepare(
      `SELECT COUNT(*) c FROM mcqs m WHERE ${EFFECTIVE_ANSWER_SQL}`,
    ).get() as { c: number }).c;
    expect(keyed).toBeGreaterThan(1800);
    expect(sittableIdsFromConstant().length).toBe(keyed);
    expect(getMcqStats().withAnswer).toBe(keyed);
  });

  it("the list, the stats header and the constant describe one bank", () => {
    const listed = allIdsFromListFilter();
    expect(listed.length).toBe(getMcqStats().total);
    // Everything sittable is listed. (The reverse does not hold: a keyless
    // question is listed but cannot be sat.)
    const listedSet = new Set(listed);
    for (const id of sittableIdsFromConstant()) expect(listedSet.has(id)).toBe(true);
  });

  it("a hand discard is the one thing that removes a question, from every surface at once", () => {
    updateMcqOverride(DISCARDED, { excluded: true });

    expect(sittableIdsFromConstant()).not.toContain(DISCARDED);
    expect(allIdsFromListFilter()).not.toContain(DISCARDED);
    expect(getMcqStats().sittings.find((p) => p.key === SITTING)!.sittable).toBe(sittingBefore.sittable - 1);
    // …and out of the SRS queue too, through the s-aliased form.
    const srsIds = (sqlite.prepare(
      `SELECT s.mcq_id AS id FROM mcq_srs_state s WHERE ${SRS_SITTABLE_SQL} ORDER BY s.mcq_id`,
    ).all() as Array<{ id: string }>).map((r) => r.id);
    expect(srsIds).toContain(KEPT);
    expect(srsIds).not.toContain(DISCARDED);
  });

  it("reverting the discard puts it back on every surface, in one step", () => {
    updateMcqOverride(DISCARDED, { excluded: null });
    expect(sittableIdsFromConstant()).toContain(DISCARDED);
    expect(allIdsFromListFilter()).toContain(DISCARDED);
    expect(getMcqStats().sittings.find((p) => p.key === SITTING)!.sittable).toBe(sittingBefore.sittable);
  });

  it("a sitting over the whole bank draws only from the sittable set", () => {
    sqlite.prepare("DELETE FROM mcq_overrides").run();
    const sittable = new Set(sittableIdsFromConstant());
    const sat = startSession({ mode: "tutor", count: 50 });
    expect(sat.mcqs.length).toBe(50);
    for (const m of sat.mcqs) expect(sittable.has(m.id)).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// The weak-area query — the same agreement, for the other shared predicate.
// getWeakAreas (the Study page's weak-topics list) must be RUNNING the exported
// WEAK_AREAS_SQL constant, not a re-inlined copy of it.
// -------------------------------------------------------------------------------------------------

const weakTopics = sqlite.prepare(
  `SELECT topic_slug AS slug, topic_name AS name, COUNT(*) c
     FROM mcqs WHERE answer IS NOT NULL
    GROUP BY topic_slug HAVING c >= 5 ORDER BY topic_slug LIMIT 2`,
).all() as Array<{ slug: string; name: string; c: number }>;

const SKIPPED = weakTopics[0];
const WEAK = weakTopics[1];

const idsFor = (slug: string) =>
  (sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL ORDER BY id LIMIT 5")
    .all(slug) as Array<{ id: string }>).map((r) => r.id);
const answerOf = (id: string) =>
  (sqlite.prepare("SELECT answer FROM mcqs WHERE id = ?").get(id) as { answer: string }).answer;
const wrongFor = (id: string) => (["A", "B", "C", "D", "E"].find((k) => k !== answerOf(id)))!;

describe("getWeakAreas runs the shared WEAK_AREAS_SQL constant", () => {
  beforeEach(() => {
    sqlite.prepare("DELETE FROM mcq_attempts").run();
    sqlite.prepare("DELETE FROM mcq_srs_state").run();
    sqlite.prepare("DELETE FROM mcq_overrides").run();
  });

  it("getWeakAreas is the shared constant, row for row", () => {
    // The drift pin proper: "is getWeakAreas running the constant that is
    // exported for everyone to share". A re-inlined copy that later loses
    // `a.selected IS NOT NULL`, or gains a different HAVING or LIMIT, fails
    // here on the first divergent seed.
    for (const id of idsFor(SKIPPED.slug)) {
      submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: null, timeMs: 500 });
    }
    idsFor(WEAK.slug).forEach((id, i) => {
      submitAttempt({
        mcqId: id, sessionId: null, mode: "srs",
        selected: i < 2 ? answerOf(id) : wrongFor(id), timeMs: 500,
      });
    });

    const direct = (sqlite.prepare(WEAK_AREAS_SQL).all() as Array<{
      slug: string; name: string; attempts: number; correct: number;
    }>).map((r) => ({
      slug: r.slug, name: r.name, attempts: r.attempts, accuracy: r.correct / r.attempts,
    }));
    expect(getWeakAreas()).toEqual(direct);
    // …and the seed is not vacuous: the answered topic is in the list at its
    // real accuracy, the reveals-only topic is absent from both.
    expect(direct.map((r) => r.slug)).toEqual([WEAK.slug]);
    expect(getWeakAreas()[0].accuracy).toBe(0.4);
  });

  it("a topic revealed only with 'Don't know' is not a weak area", () => {
    // `a.selected IS NOT NULL` is the load-bearing clause: an SRS reveal
    // ("Don't know") writes an attempt with no selection and correct = 0, and
    // counting it as a wrong answer invents weakness out of honesty.
    for (const id of idsFor(SKIPPED.slug)) {
      submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: null, timeMs: 500 });
    }
    expect(getWeakAreas().map((w) => w.slug)).not.toContain(SKIPPED.slug);
    expect(getWeakAreas()).toEqual([]);
  });
});
