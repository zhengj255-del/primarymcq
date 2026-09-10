import "./testDb";
import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../storage";
import { updateMcqOverride, revertMcqOverride, reconcileAttemptCorrectness, getMcq } from "../mcqs";
import { submitAttempt, rateSrsAttempt } from "../mcqStudy";

// ---------------------------------------------------------------------------
// A keyed answer that MOVES (a hand edit, a revert) invalidates
// two things at once: every stored attempt's correctness, which was graded
// against the old key, and the SRS schedule, which was built from feedback
// given against it. mcqs.ts repairs both — regradeAttempts() for the log,
// resetSrsOnKeyChange() for the schedule — on every path that can change the
// effective key, and reconcileAttemptCorrectness() re-derives the log at boot
// for rows that predate those repairs. This pins all of it: the exact UPDATE
// statements are the ones the port carried over (minus the variant clause),
// and nothing else in the suite exercises them.
// ---------------------------------------------------------------------------

const LETTERS = ["A", "B", "C", "D", "E"];
let id: string;

const answerOf = (mcqId: string) => getMcq(mcqId)!.answer!;
const otherThan = (letter: string) => LETTERS.find((k) => k !== letter)!;
const corrects = (mcqId: string) =>
  (sqlite.prepare("SELECT correct FROM mcq_attempts WHERE mcq_id = ? ORDER BY id").all(mcqId) as Array<{ correct: number }>)
    .map((r) => r.correct);
const srs = (mcqId: string) =>
  sqlite.prepare("SELECT interval_days, stability, due_at, reps, lapses FROM mcq_srs_state WHERE mcq_id = ?").get(mcqId) as
    | { interval_days: number; stability: number; due_at: number; reps: number; lapses: number }
    | undefined;

beforeEach(() => {
  sqlite.prepare("DELETE FROM mcq_attempts").run();
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
  sqlite.prepare("DELETE FROM mcq_srs_undo").run();
  sqlite.prepare("DELETE FROM mcq_overrides").run();
  id = (sqlite.prepare("SELECT id FROM mcqs WHERE answer IS NOT NULL ORDER BY id LIMIT 1").get() as { id: string }).id;
});

/** One correct SRS attempt rated Good (so a real schedule exists), one wrong
 *  tutor attempt, and one "don't know" reveal — three rows with a known
 *  correctness pattern [1, 0, NULL-selected 0]. */
function seedHistory(): { key: string; wrong: string } {
  const key = answerOf(id);
  const wrong = otherThan(key);
  submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: key, timeMs: 500 });
  rateSrsAttempt({ mcqId: id, sessionId: null, rating: 3 });
  submitAttempt({ mcqId: id, sessionId: null, mode: "tutor", selected: wrong, timeMs: 500 });
  submitAttempt({ mcqId: id, sessionId: null, mode: "tutor", selected: null, timeMs: 500 });
  expect(corrects(id)).toEqual([1, 0, 0]);
  const state = srs(id)!;
  expect(state.interval_days).toBeGreaterThanOrEqual(1);
  expect(state.stability).toBeGreaterThan(0);
  return { key, wrong };
}

describe("a key change regrades the attempt log and resets the schedule", () => {
  it("moving the key to the option the user actually picked flips [1,0,0] to [0,1,0] and relearns now", () => {
    const { wrong } = seedHistory();
    const before = Date.now();
    const rec = updateMcqOverride(id, { answer: wrong })!;
    expect(rec.answer).toBe(wrong);

    // The attempt that matched the OLD key is now wrong, the one that matched
    // the NEW key is now right, and the selected=NULL reveal is untouched.
    expect(corrects(id)).toEqual([0, 1, 0]);
    // Schedule: due now, interval 0, stability 0 (FSRS "uninitialised"), reps
    // 0 — lapses is a lifetime counter and survives.
    const state = srs(id)!;
    expect(state.interval_days).toBe(0);
    expect(state.stability).toBe(0);
    expect(state.reps).toBe(0);
    expect(state.due_at).toBeGreaterThanOrEqual(before);
    expect(state.due_at).toBeLessThanOrEqual(Date.now());
  });

  it("reverting the override restores the base key, regrades back and resets again", () => {
    const { key, wrong } = seedHistory();
    updateMcqOverride(id, { answer: wrong });
    // Rate once more under the new key so there is a live schedule to reset.
    submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: wrong, timeMs: 500 });
    rateSrsAttempt({ mcqId: id, sessionId: null, rating: 3 });
    expect(srs(id)!.stability).toBeGreaterThan(0);

    const rec = revertMcqOverride(id)!;
    expect(rec.answer).toBe(key);
    expect(rec.edited).toBe(false);
    expect(corrects(id)).toEqual([1, 0, 0, 0]);   // the 4th row picked `wrong`, now wrong again
    const state = srs(id)!;
    expect(state.interval_days).toBe(0);
    expect(state.stability).toBe(0);
  });

  it("an edit that leaves the key alone touches neither the log nor the schedule", () => {
    seedHistory();
    const before = srs(id)!;
    updateMcqOverride(id, { stem: "A reworded stem", reason: "A clearer reason" });
    expect(corrects(id)).toEqual([1, 0, 0]);
    expect(srs(id)).toEqual(before);
    // Re-asserting the SAME key is not a change either.
    updateMcqOverride(id, { answer: answerOf(id) });
    expect(corrects(id)).toEqual([1, 0, 0]);
    expect(srs(id)).toEqual(before);
  });

  it("clearing the key to '' resets the schedule but leaves the grades alone", () => {
    seedHistory();
    updateMcqOverride(id, { answer: null });
    expect(getMcq(id)!.answer).toBeNull();
    // regradeAttempts() has no key to grade against, so the log stands…
    expect(corrects(id)).toEqual([1, 0, 0]);
    // …but the schedule was built against a key that no longer exists.
    const state = srs(id)!;
    expect(state.interval_days).toBe(0);
    expect(state.stability).toBe(0);
  });
});

describe("boot reconcile", () => {
  it("re-derives a tampered row from the current key and is idempotent", () => {
    seedHistory();
    // A row mis-graded on disk (as key changes applied before regradeAttempts
    // existed left behind): the correct attempt marked wrong.
    sqlite.prepare("UPDATE mcq_attempts SET correct = 0 WHERE mcq_id = ? AND selected = ?").run(id, answerOf(id));
    expect(corrects(id)).toEqual([0, 0, 0]);

    expect(reconcileAttemptCorrectness()).toBe(1);
    expect(corrects(id)).toEqual([1, 0, 0]);
    expect(reconcileAttemptCorrectness()).toBe(0);   // nothing left to fix
  });

  it("grades against the EFFECTIVE key — an override wins over the corpus", () => {
    const { wrong } = seedHistory();
    // Write the override row directly, bypassing updateMcqOverride's regrade,
    // so the log is stale relative to the override — the boot case.
    sqlite.prepare(
      "INSERT INTO mcq_overrides (mcq_id, answer, updated_at) VALUES (?, ?, ?)",
    ).run(id, wrong, Date.now());
    expect(corrects(id)).toEqual([1, 0, 0]);
    expect(reconcileAttemptCorrectness()).toBe(2);
    expect(corrects(id)).toEqual([0, 1, 0]);
  });
});
