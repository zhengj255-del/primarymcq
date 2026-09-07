import "./testDb";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sqlite } from "../storage";
import { DISPUTED_SQL_M, NOT_DISPUTED_SQL_M, WEAK_AREAS_SQL, SRS_SITTABLE_SQL } from "../mcqSittable";
import { listMcqs, getMcqStats, listDisputeTriage, updateMcqOverride, getMcq } from "../mcqs";
import { submitAttempt, getWeakAreas } from "../mcqStudy";

// -------------------------------------------------------------------------------------------------
// I-2 — ONE definition per question, pinned by AGREEMENT.
//
// Two predicates in this app answer questions that several surfaces ask
// independently: "is this MCQ effectively disputed?" and "which topics is the
// candidate weak in?". Each had grown extra hand-typed copies — the dispute
// COALESCE had four (the list filter, the stats count, the per-paper flag and
// the triage list). Every copy was CORRECT when written. That is exactly the
// failure mode: a copy is not wrong on the day it is made, it is wrong on the
// day somebody repairs the original and does not know the copy exists. This
// app has already paid that bill — the SRS count that promised reviews the
// queue refused to serve (mcq-engine-srs-study-1), and a weak-area copy that
// ranked a topic revealed with "Don't know" as a 0 % drill
// (mcq-engine-srs-study-2). Both were one surface repaired and another missed.
//
// So this file asserts nothing about WHAT the predicates decide — the tests
// beside it (mcqSittableDisputed, mcqTriageDisputes) own that. It asserts only
// that every surface gives the SAME answer on one seed, and that each surface's
// answer still matches the exported constant it is supposed to be running. It
// is green before the de-duplication and green after: its job is to go RED the
// day a fifth copy appears and drifts.
//
// The escape (D2): none needed — there is no flag to turn this off, because
// there is no legitimate state in which the triage list, the stats header, the
// paper picker and the SRS queue should disagree about whether a given question
// is disputed. If a surface ever NEEDS a different question (as
// computeWeakTopicSlugs does — see the comment on it in mcqStudy.ts), it stops
// being a copy of this predicate and is excluded from the comparison here, with
// the reason written down at its definition.
// -------------------------------------------------------------------------------------------------

/** The reference answer: the shared constant, run directly. Every surface below
 *  must return this same set of ids. */
function disputedIdsFromConstant(): string[] {
  return (sqlite.prepare(
    `SELECT m.id FROM mcqs m WHERE ${DISPUTED_SQL_M} ORDER BY m.id`,
  ).all() as Array<{ id: string }>).map((r) => r.id);
}

function notDisputedCountFromConstant(): number {
  return (sqlite.prepare(
    `SELECT COUNT(*) c FROM mcqs m WHERE ${NOT_DISPUTED_SQL_M}`,
  ).get() as { c: number }).c;
}

/** The list filter's answer (server/mcqs.ts listMcqs). Paged, because the list
 *  caps `limit` at 200 of its own accord and the shipped corpus carries ~247
 *  disputed questions — a single unpaged call would compare the first page
 *  against the whole corpus and fail for a reason that has nothing to do with
 *  the predicate. `total` is asserted against the page count as we go, so a
 *  filter whose COUNT and whose page disagreed would be caught here too. */
function disputedIdsFromListFilter(): string[] {
  const ids: string[] = [];
  let total = 0;
  for (let offset = 0; ; offset += 200) {
    const page = listMcqs({ disputed: true, limit: 200, offset });
    total = page.total;
    ids.push(...page.items.map((m) => m.id));
    if (page.items.length < 200) break;
  }
  expect(ids.length).toBe(total);
  return ids.sort();
}

/** The triage queue's answer, restricted to rows it lists BECAUSE they are
 *  disputed. listDisputeTriage deliberately also keeps rows whose dispute has
 *  been resolved (so the accepted/fixed/discarded bands are not always 0), so
 *  the comparison is against its still-disputed rows only — that is the subset
 *  answering the same question the other surfaces ask. */
function disputedIdsFromTriageQueue(): string[] {
  return listDisputeTriage().items.filter((m) => m.disputed).map((m) => m.id).sort();
}

/** The SRS queue's answer, through the s-aliased form of the same predicate.
 *  Every id passed in is tracked and sittable apart from its dispute, so what
 *  survives SRS_SITTABLE_SQL is exactly "not disputed". */
function notDisputedIdsFromSrsSittable(): string[] {
  return (sqlite.prepare(
    `SELECT s.mcq_id AS id FROM mcq_srs_state s WHERE ${SRS_SITTABLE_SQL} ORDER BY s.mcq_id`,
  ).all() as Array<{ id: string }>).map((r) => r.id);
}

const PAST = Date.now() - 60 * 60 * 1000;
function trackDue(id: string): void {
  sqlite.prepare(
    `INSERT OR REPLACE INTO mcq_srs_state (mcq_id, interval_days, reps, last_reviewed_at, due_at, created_at)
     VALUES (?, 5, 3, ?, ?, ?)`,
  ).run(id, PAST, PAST, PAST);
}

// A canonical past-paper tag with at least three sittable questions: the
// per-paper `sittable` count is one of the four surfaces, and it only moves for
// questions that carry a canonical MonYY tag.
let TAG: string;
let OVR_ID: string;    // disputed ONLY through mcq_overrides (the app's Dispute switch)
let BASE_ID: string;   // disputed ONLY on the base column (the shipped corpus)
let CLEAN_ID: string;  // never disputed — the control
let paperBefore: { count: number; sittable: number; sittableWithDisputed: number };
let disputedBefore: number;

describe("every surface that answers 'is this MCQ disputed' answers from one predicate", () => {
  beforeAll(() => {
    sqlite.prepare("DELETE FROM mcq_overrides").run();
    sqlite.prepare("DELETE FROM mcq_srs_state").run();

    const paper = getMcqStats().papers.find((p) => p.sittable >= 3);
    expect(paper, "corpus sanity: a canonical paper with >= 3 sittable questions").toBeTruthy();
    TAG = paper!.tag;

    const ids = (sqlite.prepare(
      `SELECT id FROM mcqs
        WHERE answer IS NOT NULL AND disputed = 0 AND papers LIKE ?
        ORDER BY id LIMIT 3`,
    ).all(`%"${TAG}"%`) as Array<{ id: string }>).map((r) => r.id);
    expect(ids.length, `corpus sanity: 3 answered, undisputed ${TAG} questions`).toBe(3);
    [OVR_ID, BASE_ID, CLEAN_ID] = ids;

    disputedBefore = getMcqStats().disputed;
    paperBefore = getMcqStats().papers.find((p) => p.tag === TAG)!;

    // All three tracked and due: the SRS sittable count then differs from three
    // only by the dispute predicate.
    for (const id of ids) trackDue(id);

    // The two halves of "effectively disputed", one each, so a surface reading
    // only the base column and a surface reading only the override are both
    // caught by the same seed.
    updateMcqOverride(OVR_ID, { disputed: true });
    sqlite.prepare("UPDATE mcqs SET disputed = 1 WHERE id = ?").run(BASE_ID);
  });

  it("the seed really does exercise both halves — override and base column", () => {
    // Guard the guard: if a future ingest ships OVR_ID as disputed, or the
    // override write stops landing, the agreement below would hold trivially.
    const raw = sqlite.prepare(
      `SELECT m.disputed AS base,
              (SELECT o.disputed FROM mcq_overrides o WHERE o.mcq_id = m.id) AS ovr
         FROM mcqs m WHERE m.id = ?`,
    );
    expect(raw.get(OVR_ID)).toEqual({ base: 0, ovr: 1 });
    expect(raw.get(BASE_ID)).toEqual({ base: 1, ovr: null });
    expect(raw.get(CLEAN_ID)).toEqual({ base: 0, ovr: null });
  });

  it("the list filter, the triage queue and the constant name the same rows", () => {
    const reference = disputedIdsFromConstant();
    expect(reference).toContain(OVR_ID);
    expect(reference).toContain(BASE_ID);
    expect(reference).not.toContain(CLEAN_ID);

    expect(disputedIdsFromListFilter()).toEqual(reference);
    expect(disputedIdsFromTriageQueue()).toEqual(reference);
  });

  it("the stats count is the size of that same set", () => {
    // Both seeded disputes are new, and neither question is discarded, so the
    // header must have moved by exactly two.
    expect(getMcqStats().disputed).toBe(disputedBefore + 2);
    expect(getMcqStats().disputed).toBe(disputedIdsFromConstant().length);
  });

  it("the per-paper sittable flag reads the same two rows out of the paper", () => {
    const after = getMcqStats().papers.find((p) => p.tag === TAG)!;
    // A dispute does not remove a question from the paper, nor from the
    // disputed-allowed pool: it only leaves the DEFAULT sitting.
    expect(after.count).toBe(paperBefore.count);
    expect(after.sittableWithDisputed).toBe(paperBefore.sittableWithDisputed);
    expect(after.sittable).toBe(paperBefore.sittable - 2);
  });

  it("the SRS sittable count keeps exactly the row the other surfaces call clean", () => {
    expect(notDisputedIdsFromSrsSittable()).toEqual([CLEAN_ID]);
  });

  it("the per-question flag the API serves agrees with all of them", () => {
    expect(getMcq(OVR_ID)!.disputed).toBe(true);
    expect(getMcq(BASE_ID)!.disputed).toBe(true);
    expect(getMcq(CLEAN_ID)!.disputed).toBe(false);
  });

  it("the positive and negative forms of the predicate partition the corpus", () => {
    // NOT_DISPUTED_SQL_M is the negation of DISPUTED_SQL_M, not a second
    // hand-written COALESCE that merely looks like one: every row is in exactly
    // one of the two, with no third bucket where a NULL could hide.
    const total = (sqlite.prepare("SELECT COUNT(*) c FROM mcqs").get() as { c: number }).c;
    expect(disputedIdsFromConstant().length + notDisputedCountFromConstant()).toBe(total);
  });

  it("resolving the dispute moves every surface back together, in one step", () => {
    // The override wins in BOTH directions — triage writing 0 over a base 1 is
    // the path that clears the shipped corpus's flags — so a copy that special-
    // cased the base column would strand BASE_ID here while the others freed it.
    updateMcqOverride(BASE_ID, { disputed: false });
    updateMcqOverride(OVR_ID, { disputed: false });

    const reference = disputedIdsFromConstant();
    expect(reference).not.toContain(OVR_ID);
    expect(reference).not.toContain(BASE_ID);
    expect(disputedIdsFromListFilter()).toEqual(reference);
    expect(disputedIdsFromTriageQueue()).toEqual(reference);
    expect(getMcqStats().disputed).toBe(reference.length);
    expect(getMcqStats().papers.find((p) => p.tag === TAG)!.sittable).toBe(paperBefore.sittable);
    expect(notDisputedIdsFromSrsSittable().sort()).toEqual([OVR_ID, BASE_ID, CLEAN_ID].sort());
    expect(getMcq(BASE_ID)!.disputed).toBe(false);
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
    sqlite.prepare("UPDATE mcqs SET disputed = 0 WHERE id IN (?, ?, ?)").run(OVR_ID, BASE_ID, CLEAN_ID);
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
