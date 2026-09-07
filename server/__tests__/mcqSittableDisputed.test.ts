import "./testDb";
import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../storage";
import { SRS_SITTABLE_SQL } from "../mcqSittable";
import { getUserStats, getSrsDue, getSrsQueueStats, startSession } from "../mcqStudy";
import { updateMcqOverride } from "../mcqs";

// mcq-engine-srs-study-1 / goal-alignment-3 (3 Sep audit, A2): every "SRS due N"
// counted questions the SRS queue never serves.
//
// The study queue ALWAYS excludes effectively-disputed questions — the Study
// page hard-sets excludeDisputed on both the queue-stats request and the
// session request, the old toggle being gone — while SRS_SITTABLE_SQL tested
// only discard + effective answer. So a tracked question that is disputed in
// the corpus, or that the user disputes from the edit panel, sat in the Study
// page's "SRS due N" tile forever, while the sitting behind that tile served
// nothing.
//
// These tests hold the COUNT and the QUEUE against each other on the same
// seeded row: whatever the queue will serve is what the count must say. Both
// halves of "effectively disputed" are covered — the base corpus column and the
// override the user (or triage) writes over it — because the override wins in
// both directions.

const PAST = Date.now() - 60 * 60 * 1000;

/** Track one question as a graduated review that fell due an hour ago:
 *  interval_days >= 1 puts it in the queue's REVIEW lane, not a learning step. */
function trackDue(id: string): void {
  sqlite.prepare(
    `INSERT OR REPLACE INTO mcq_srs_state (mcq_id, interval_days, reps, last_reviewed_at, due_at, created_at)
     VALUES (?, 5, 3, ?, ?, ?)`,
  ).run(id, PAST, PAST, PAST);
}

/** The count every "SRS due N" surface inherits — the shared constant run
 *  directly, exactly as getUserStats interpolates it. Exercised here as the
 *  thing every call site inherits, so a drift in the constant fails this file
 *  before it fails a screen. */
function sittableDueCount(): number {
  return (sqlite.prepare(
    `SELECT COUNT(*) AS c FROM mcq_srs_state s WHERE s.due_at <= ? AND ${SRS_SITTABLE_SQL}`,
  ).get(Date.now()) as { c: number }).c;
}

/** What the sitting actually serves in this scope. srsSkipNew keeps the new
 *  lane out, so `mcqs` is exactly the tracked-and-due questions — the queue
 *  side of the reconciliation, uncontaminated by fresh intake. */
function queueServes(topic: string): string[] {
  return startSession({
    mode: "srs", count: 0, topics: [topic], excludeDisputed: true, srsSkipNew: true,
  }).mcqs.map((m) => m.id);
}

function queueDueReviews(topic: string): number {
  return getSrsQueueStats({
    mode: "srs", count: 0, topics: [topic], excludeDisputed: true, srsSkipNew: true,
  }).dueReviews;
}

function pick(where: string): { id: string; topic: string } {
  const row = sqlite.prepare(
    `SELECT id, topic_slug AS topic FROM mcqs WHERE answer IS NOT NULL AND ${where} LIMIT 1`,
  ).get() as { id: string; topic: string } | undefined;
  expect(row, `corpus sanity: an answered MCQ with ${where}`).toBeTruthy();
  return row!;
}

beforeEach(() => {
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
  sqlite.prepare("DELETE FROM mcq_overrides").run();
});

describe("SRS due counts and the SRS queue share ONE dispute predicate", () => {
  it("a due question disputed in the base corpus is counted 0 and served 0", () => {
    const { id, topic } = pick("disputed = 1");
    trackDue(id);

    const s = getUserStats().srsDue;
    expect(s.dueNow).toBe(0);
    expect(s.dueToday).toBe(0);
    expect(s.totalTracked).toBe(0);
    expect(sittableDueCount()).toBe(0);
    expect(getSrsDue().some((m) => m.id === id)).toBe(false);
    // …and the queue agrees, because it always did — it was the count that lied.
    expect(queueDueReviews(topic)).toBe(0);
    expect(queueServes(topic)).toEqual([]);
  });

  it("a due undisputed question is counted 1 and served 1", () => {
    const { id, topic } = pick("disputed = 0");
    trackDue(id);

    const s = getUserStats().srsDue;
    expect(s.dueNow).toBe(1);
    expect(s.dueToday).toBe(1);
    expect(s.totalTracked).toBe(1);
    expect(sittableDueCount()).toBe(1);
    expect(getSrsDue().map((m) => m.id)).toEqual([id]);
    expect(queueDueReviews(topic)).toBe(1);
    expect(queueServes(topic)).toEqual([id]);
  });

  it("a dispute the user raises via mcq_overrides drops it from the counts too", () => {
    const { id, topic } = pick("disputed = 0");
    trackDue(id);
    expect(getUserStats().srsDue.dueNow).toBe(1); // clean: counted and served

    // The edit panel's Dispute switch writes the override; the base column
    // still reads 0, so a count that trusts the corpus keeps promising it.
    updateMcqOverride(id, { disputed: true });

    const s = getUserStats().srsDue;
    expect(s.dueNow).toBe(0);
    expect(s.dueToday).toBe(0);
    expect(s.totalTracked).toBe(0);
    expect(sittableDueCount()).toBe(0);
    expect(getSrsDue().some((m) => m.id === id)).toBe(false);
    expect(queueDueReviews(topic)).toBe(0);
    expect(queueServes(topic)).toEqual([]);
  });

  it("a dispute RESOLVED in triage returns to the counts and the queue", () => {
    // The override wins in BOTH directions: 0 written over a base 1 makes the
    // question sittable again. A predicate that simply refused base-disputed
    // rows would strand every question triage has cleared.
    const { id, topic } = pick("disputed = 1");
    trackDue(id);
    updateMcqOverride(id, { disputed: false });

    const s = getUserStats().srsDue;
    expect(s.dueNow).toBe(1);
    expect(s.totalTracked).toBe(1);
    expect(sittableDueCount()).toBe(1);
    expect(getSrsDue().map((m) => m.id)).toEqual([id]);
    expect(queueDueReviews(topic)).toBe(1);
    expect(queueServes(topic)).toEqual([id]);
  });
});
