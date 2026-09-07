import "./testDb";
import { describe, it, expect, beforeAll } from "vitest";
import { sqlite } from "../storage";
import { seedSrsFromAttempts } from "../mcqStudy";

// The one-shot migration for the move to SRS-first study. Contract under test:
// latest-wrong questions relearn NOW; latest-correct questions re-prove
// themselves on a deterministic 1..7-day stagger (a single prior correct is
// weak evidence — 154 of 199 "done" questions were one first-try correct);
// skip-only and untouched questions stay untracked; and the seed is guarded so
// it can never run against a live scheduler.

const DAY = 86400000;
let WRONG_ID: string, RIGHT_A: string, RIGHT_B: string, SKIP_ID: string, UNTOUCHED_ID: string;
let T0: number;

const srs = (id: string) =>
  sqlite.prepare("SELECT * FROM mcq_srs_state WHERE mcq_id = ?").get(id) as
    | { ease_factor: number; interval_days: number; reps: number; lapses: number; due_at: number; last_reviewed_at: number; stability: number; difficulty: number }
    | undefined;

describe("seedSrsFromAttempts", () => {
  beforeAll(() => {
    sqlite.prepare("DELETE FROM mcq_srs_state").run();
    sqlite.prepare("DELETE FROM mcq_attempts").run();
    const ids = (sqlite.prepare("SELECT id FROM mcqs WHERE answer IS NOT NULL ORDER BY id LIMIT 5").all() as Array<{ id: string }>).map((r) => r.id);
    [WRONG_ID, RIGHT_A, RIGHT_B, SKIP_ID, UNTOUCHED_ID] = ids.sort(); // mcq_id order = stagger order
    T0 = Date.now();
    const ins = sqlite.prepare(
      "INSERT INTO mcq_attempts (mcq_id, session_id, mode, selected, correct, time_ms, attempted_at) VALUES (?,?,?,?,?,?,?)",
    );
    // WRONG_ID: right once long ago, wrong twice since -> latest wrong, 2 lapses.
    ins.run(WRONG_ID, "s", "tutor", "A", 1, 1000, T0 - 30 * DAY);
    ins.run(WRONG_ID, "s", "tutor", "B", 0, 1000, T0 - 20 * DAY);
    ins.run(WRONG_ID, "s", "tutor", "C", 0, 1000, T0 - 10 * DAY);
    // RIGHT_A / RIGHT_B: latest submitted attempt correct.
    ins.run(RIGHT_A, "s", "tutor", "A", 1, 1000, T0 - 5 * DAY);
    ins.run(RIGHT_B, "s", "tutor", "D", 0, 1000, T0 - 9 * DAY);
    ins.run(RIGHT_B, "s", "tutor", "A", 1, 1000, T0 - 2 * DAY);
    // SKIP_ID: only ever skipped (selected NULL) — no submitted answer exists.
    ins.run(SKIP_ID, "s", "tutor", null, 0, 1000, T0 - 1 * DAY);
  });

  it("seeds relearn-now for latest-wrong and a 1..7d verification stagger for latest-correct", () => {
    const r = seedSrsFromAttempts(T0);
    expect(r).toEqual({ seeded: 3, relearnNow: 1, verifyQueued: 2 });

    const wrong = srs(WRONG_ID)!;
    expect(wrong.interval_days).toBe(0);
    expect(wrong.reps).toBe(0);
    expect(wrong.due_at).toBe(T0);            // in the queue immediately
    expect(wrong.lapses).toBe(2);             // lifetime wrong count carried over
    expect(wrong.last_reviewed_at).toBe(T0 - 10 * DAY);
    expect(wrong.stability).toBe(0);          // FSRS init sentinel: first real rating derives S/D

    for (const id of [RIGHT_A, RIGHT_B]) {
      const s = srs(id)!;
      expect(s.reps).toBe(1);
      expect(s.interval_days).toBeGreaterThanOrEqual(1);
      expect(s.interval_days).toBeLessThanOrEqual(7);
      expect(s.due_at).toBe(T0 + s.interval_days * DAY);
      // Tutor-era feedback doesn't price the future: FSRS stays uninitialised
      // (stability 0 sentinel) until the first genuine SRS rating.
      expect(s.stability).toBe(0);
      expect(s.difficulty).toBe(0);
    }
    // Deterministic stagger: consecutive correct questions land on different days.
    expect(srs(RIGHT_A)!.interval_days).not.toBe(srs(RIGHT_B)!.interval_days);

    // Skip-only and never-attempted stay untracked — they arrive as new intake.
    expect(srs(SKIP_ID)).toBeUndefined();
    expect(srs(UNTOUCHED_ID)).toBeUndefined();
  });

  it("is a permanent no-op once any SRS state exists — it can never fight a live scheduler", () => {
    const again = seedSrsFromAttempts();
    expect(again).toEqual({ seeded: 0, relearnNow: 0, verifyQueued: 0 });
    // And the guard is about ANY state, not just its own: fresh table with one
    // hand-made row -> still refuses.
    sqlite.prepare("DELETE FROM mcq_srs_state").run();
    sqlite.prepare(
      "INSERT INTO mcq_srs_state (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at) VALUES (?, 2.5, 3, 1, 0, ?, ?)",
    ).run(RIGHT_A, Date.now(), Date.now() + 3 * DAY);
    expect(seedSrsFromAttempts()).toEqual({ seeded: 0, relearnNow: 0, verifyQueued: 0 });
    expect(srs(WRONG_ID)).toBeUndefined();    // nothing else was created
  });
});
