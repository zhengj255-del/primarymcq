import "./testDb";
import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../storage";
import { listMcqs, getMcqStats, resolveMcqDispute, updateMcqOverride, revertMcqOverride } from "../mcqs";
import { startSession, getUserStats, getSrsDue } from "../mcqStudy";

// 31 Jul re-audit: "disputed" had three different definitions — the stats
// header counted UNRESOLVED disputes, the "Disputed only" list filter used the
// raw base column (so triaged questions still listed and user-flagged ones
// never did), and the Study "Exclude disputed" toggle did the same. One
// definition everywhere now: effectively-disputed (override wins over base)
// and not discarded.

/** A base-disputed question — flagged HERE, in this file's throwaway database,
 *  the way the ingest flags one the corpus ships as disputed: 1 in
 *  mcqs.disputed with no override row. The shipped corpus has carried none
 *  since the 2026-09-07 whole-bank refresh (every dispute was triaged in the
 *  tracker before the hand-off), so a test of the base-column half of
 *  "effectively disputed" seeds its own rather than hope the corpus still
 *  carries one. Picks an answered, clean question in a topic small enough that
 *  a count-200 session selects the topic's whole pool (making inclusion
 *  deterministic). */
function seedBaseDisputed(): { id: string; topic: string } {
  const row = sqlite.prepare(
    `SELECT m.id, m.topic_slug AS topic FROM mcqs m
      WHERE m.disputed = 0 AND m.answer IS NOT NULL
        AND (SELECT COUNT(*) FROM mcqs t WHERE t.topic_slug = m.topic_slug AND t.answer IS NOT NULL) <= 200
      ORDER BY m.id LIMIT 1`,
  ).get() as { id: string; topic: string } | undefined;
  expect(row, "corpus sanity: an answered, clean MCQ in a small topic").toBeTruthy();
  sqlite.prepare("UPDATE mcqs SET disputed = 1 WHERE id = ?").run(row!.id);
  return row!;
}

beforeEach(() => {
  sqlite.prepare("DELETE FROM mcq_overrides").run();
});

describe("one definition of 'disputed' across stats, list filter, and study pool", () => {
  it("a triage-accepted question leaves the 'Disputed only' list (and the stats count)", () => {
    const row = seedBaseDisputed();
    const before = listMcqs({ disputed: true, limit: 10_000 });
    expect(before.items.some((m) => m.id === row.id)).toBe(true);
    const statsBefore = getMcqStats().disputed;

    resolveMcqDispute(row.id, "accept");
    const after = listMcqs({ disputed: true, limit: 10_000 });
    expect(after.items.some((m) => m.id === row.id)).toBe(false);
    expect(after.total).toBe(before.total - 1);
    expect(getMcqStats().disputed).toBe(statsBefore - 1);
  });

  it("a user-flagged (override-only) dispute shows up in the 'Disputed only' list", () => {
    const row = sqlite.prepare("SELECT id FROM mcqs WHERE disputed = 0 LIMIT 1").get() as { id: string };
    updateMcqOverride(row.id, { disputed: true });
    const list = listMcqs({ disputed: true, limit: 10_000 });
    expect(list.items.some((m) => m.id === row.id)).toBe(true);
  });

  it("Study 'exclude disputed' follows the effective dispute, not the frozen base column", () => {
    const { id, topic } = seedBaseDisputed();
    resolveMcqDispute(id, "accept");
    // Resolved dispute → the question is clean again → sittable with the toggle on.
    const sess = startSession({ mode: "tutor", count: 200, topics: [topic], excludeDisputed: true });
    expect(sess.mcqs.some((m) => m.id === id)).toBe(true);

    // User-flagged dispute → excluded by the toggle even though base says clean.
    const clean = sqlite.prepare(
      "SELECT id FROM mcqs WHERE disputed = 0 AND answer IS NOT NULL AND topic_slug = ? LIMIT 1",
    ).get(topic) as { id: string } | undefined;
    if (clean) {
      updateMcqOverride(clean.id, { disputed: true });
      const sess2 = startSession({ mode: "tutor", count: 200, topics: [topic], excludeDisputed: true });
      expect(sess2.mcqs.some((m) => m.id === clean.id)).toBe(false);
      revertMcqOverride(clean.id);
    }
  });
});

describe("MCQ stats respect the override layer (counts match the sittable pool)", () => {
  it("a discarded question leaves total, withAnswer, and its topic count", () => {
    const row = seedBaseDisputed();
    const before = getMcqStats();
    const topicBefore = before.byTopic.find((t) => t.slug === row.topic)!.count;

    resolveMcqDispute(row.id, "discard");
    const after = getMcqStats();
    expect(after.total).toBe(before.total - 1);
    expect(after.withAnswer).toBe(before.withAnswer - 1);
    expect(after.byTopic.find((t) => t.slug === row.topic)!.count).toBe(topicBefore - 1);
  });

  it("an answer added via fix-override counts in withAnswer", () => {
    const row = sqlite.prepare("SELECT id FROM mcqs WHERE answer IS NULL LIMIT 1").get() as { id: string } | undefined;
    if (!row) return; // corpus has no answerless questions — nothing to pin
    const before = getMcqStats().withAnswer;
    updateMcqOverride(row.id, { answer: "B" });
    expect(getMcqStats().withAnswer).toBe(before + 1);
  });
});

describe("Study-page stats respect the override layer too (getUserStats)", () => {
  it("SRS due counts exclude discarded questions — the tile reconciles with the queue", () => {
    const rows = sqlite.prepare(
      "SELECT id FROM mcqs WHERE answer IS NOT NULL AND disputed = 0 LIMIT 2",
    ).all() as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    const past = Date.now() - 60_000;
    for (const r of rows) {
      sqlite.prepare(
        "INSERT OR REPLACE INTO mcq_srs_state (mcq_id, due_at, last_reviewed_at) VALUES (?, ?, ?)",
      ).run(r.id, past, past);
    }
    // Both tracked and due…
    let s = getUserStats().srsDue;
    expect(s.totalTracked).toBe(2);
    expect(s.dueNow).toBe(2);
    // …then one is discarded in triage. The queue already excluded it — the
    // tile must agree, or "SRS due N" overstates forever with no exit.
    updateMcqOverride(rows[0].id, { excluded: true });
    s = getUserStats().srsDue;
    expect(s.totalTracked).toBe(1);
    expect(s.dueNow).toBe(1);
    expect(s.dueToday).toBe(1);
    expect(getSrsDue().length).toBe(s.dueNow); // the reconciliation itself
    sqlite.prepare("DELETE FROM mcq_srs_state").run();
    revertMcqOverride(rows[0].id);
  });

  it("bank coverage pool and attempt numerators share the sittable predicate", () => {
    const row = sqlite.prepare(
      "SELECT id, topic_slug AS topic FROM mcqs WHERE answer IS NOT NULL AND disputed = 0 LIMIT 1",
    ).get() as { id: string; topic: string };
    const poolBefore = getUserStats().byTopic.find((t) => t.slug === row.topic)!.poolSize;
    // Attempt it, then discard it: both the pool AND the attempted/coverage
    // numerator must drop it, or coverage can exceed its own denominator.
    sqlite.prepare(
      "INSERT INTO mcq_attempts (mcq_id, mode, selected, correct, attempted_at) VALUES (?, 'tutor', 'A', 1, ?)",
    ).run(row.id, Date.now());
    updateMcqOverride(row.id, { excluded: true });
    const topic = getUserStats().byTopic.find((t) => t.slug === row.topic)!;
    expect(topic.poolSize).toBe(poolBefore - 1);
    expect(topic.attempted).toBe(0);
    expect(topic.attempted).toBeLessThanOrEqual(topic.poolSize);
    sqlite.prepare("DELETE FROM mcq_attempts").run();
    revertMcqOverride(row.id);
  });
});

describe("re-audit follow-ups: the sittable predicate is COMPLETE", () => {
  it("an answer CLEARED by override (not discarded) leaves the SRS counts and queue too", () => {
    const row = sqlite.prepare(
      "SELECT id FROM mcqs WHERE answer IS NOT NULL AND disputed = 0 LIMIT 1",
    ).get() as { id: string };
    const past = Date.now() - 60_000;
    sqlite.prepare(
      "INSERT OR REPLACE INTO mcq_srs_state (mcq_id, due_at, last_reviewed_at) VALUES (?, ?, ?)",
    ).run(row.id, past, past);
    expect(getUserStats().srsDue.dueNow).toBe(1);
    // Triage clears the answer with '' — sessions can never serve it, so the
    // due list AND every count must drop it (the discard-only predicate left
    // this sub-case permanently overstating).
    updateMcqOverride(row.id, { answer: "" });
    const s = getUserStats().srsDue;
    expect(s.dueNow).toBe(0);
    expect(s.totalTracked).toBe(0);
    expect(getSrsDue().some((m) => m.id === row.id)).toBe(false);
    sqlite.prepare("DELETE FROM mcq_srs_state").run();
    revertMcqOverride(row.id);
  });

  it("the coverage NUMERATOR (totals.uniqueMcqs) shares the sittable predicate — discards can't push coverage past 100%", () => {
    const row = sqlite.prepare(
      "SELECT id FROM mcqs WHERE answer IS NOT NULL AND disputed = 0 LIMIT 1",
    ).get() as { id: string };
    sqlite.prepare(
      "INSERT INTO mcq_attempts (mcq_id, mode, selected, correct, attempted_at) VALUES (?, 'tutor', 'A', 1, ?)",
    ).run(row.id, Date.now());
    expect(getUserStats().totals.uniqueMcqs).toBe(1);
    updateMcqOverride(row.id, { excluded: true });
    const stats = getUserStats();
    // Numerator excludes it (like the pools) — activity stats stay all-time.
    expect(stats.totals.uniqueMcqs).toBe(0);
    expect(stats.totals.attempted).toBe(1);
    sqlite.prepare("DELETE FROM mcq_attempts").run();
    revertMcqOverride(row.id);
  });
});
