import "./testDb";
import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../storage";
import { submitAttempt, rateSrsAttempt, undoLastSrsRating, getSrsQueueStats, resetMcqProgress } from "../mcqStudy";

// Undo for the misclick — "Good" on a question that deserved "Again".
//
// FSRS has no inverse: stability and difficulty are lossy functions of the
// state they replaced, so the rating cannot be computed backwards. Undo
// restores a RECORD of the exact prior state captured at rating time, and
// un-stamps the attempt so the daily review slot is handed back. The user's
// ANSWER stands — only the self-rating is undone.

const DAY = 86400000;
const F = { mode: "srs" as const, count: 20 };
let ids: string[];

const put = (id: string, interval: number, dueAt: number, createdAt: number, stability = 12.5, difficulty = 4.2) =>
  sqlite.prepare(
    `INSERT OR REPLACE INTO mcq_srs_state (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at, stability, difficulty, created_at)
     VALUES (?, 2.5, ?, 4, 1, ?, ?, ?, ?, ?)`,
  ).run(id, interval, Date.now() - DAY, dueAt, stability, difficulty, createdAt);
const answerOf = (id: string) =>
  (sqlite.prepare("SELECT answer FROM mcqs WHERE id = ?").get(id) as { answer: string }).answer;
const state = (id: string) =>
  sqlite.prepare("SELECT * FROM mcq_srs_state WHERE mcq_id = ?").get(id) as any;
const attempt = (id: string) =>
  sqlite.prepare("SELECT * FROM mcq_attempts WHERE mcq_id = ? ORDER BY id DESC LIMIT 1").get(id) as any;

beforeEach(() => {
  sqlite.prepare("DELETE FROM mcq_attempts").run();
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
  sqlite.prepare("DELETE FROM mcq_srs_undo").run();
  sqlite.prepare("UPDATE settings SET srs_max_reviews_per_day = 200, srs_new_per_day = 20").run();
  ids = (sqlite.prepare("SELECT id FROM mcqs WHERE answer IS NOT NULL ORDER BY id LIMIT 12").all() as Array<{ id: string }>).map((r) => r.id);
});

describe("undoing an SRS rating", () => {
  it("restores the exact prior schedule, byte for byte", () => {
    const yesterday = Date.now() - DAY;
    put(ids[0], 9, Date.now() - 1000, yesterday);
    const before = state(ids[0]);

    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 500 });
    const rated = rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 3 })!;
    expect(rated.intervalDays).toBeGreaterThan(9);        // the misclick pushed it out
    expect(state(ids[0]).stability).not.toBe(before.stability);

    const undone = undoLastSrsRating();
    expect(undone!.mcqId).toBe(ids[0]);
    const after = state(ids[0]);
    for (const col of ["interval_days", "reps", "lapses", "last_reviewed_at", "due_at", "stability", "difficulty", "created_at"]) {
      expect(after[col]).toBe(before[col]);
    }
    // And it offers the same choices as before the misclick.
    expect(undone!.preview.good).toBeDefined();
  });

  it("keeps the answer but clears the rating, handing back the review slot", () => {
    const yesterday = Date.now() - DAY;
    put(ids[0], 9, Date.now() - 1000, yesterday);
    for (let i = 1; i <= 3; i++) put(ids[i], 5, Date.now() - DAY, yesterday);
    sqlite.prepare("UPDATE settings SET srs_max_reviews_per_day = 4").run();

    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 500 });
    rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 3 });
    expect(getSrsQueueStats(F).limits.reviewsRemaining).toBe(3);
    expect(attempt(ids[0]).rating).toBe(3);

    undoLastSrsRating();
    const a = attempt(ids[0]);
    expect(a.selected).toBe(answerOf(ids[0]));   // the ANSWER stands
    expect(a.correct).toBe(1);
    expect(a.rating).toBeNull();                 // only the rating is undone
    expect(a.srs_lane).toBeNull();
    expect(getSrsQueueStats(F).limits.reviewsRemaining).toBe(4); // slot returned
  });

  it("makes a newly-introduced question new again, returning its intake slot", () => {
    sqlite.prepare("UPDATE settings SET srs_new_per_day = 5").run();
    expect(getSrsQueueStats(F).limits.newRemaining).toBe(5);

    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 500 });
    rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 4 });
    expect(state(ids[0])).toBeDefined();
    expect(getSrsQueueStats(F).limits.newRemaining).toBe(4);

    undoLastSrsRating();
    expect(state(ids[0])).toBeUndefined();       // untracked again, not a 0-state ghost
    expect(getSrsQueueStats(F).limits.newRemaining).toBe(5);
  });

  it("walks back several ratings, most recent first, then reports nothing left", () => {
    const yesterday = Date.now() - DAY;
    put(ids[0], 9, Date.now() - 1000, yesterday);
    put(ids[1], 9, Date.now() - 1000, yesterday);
    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 500 });
    rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 3 });
    submitAttempt({ mcqId: ids[1], sessionId: null, mode: "srs", selected: answerOf(ids[1]), timeMs: 500 });
    rateSrsAttempt({ mcqId: ids[1], sessionId: null, rating: 1 });

    expect(undoLastSrsRating()!.mcqId).toBe(ids[1]);
    expect(undoLastSrsRating()!.mcqId).toBe(ids[0]);
    expect(undoLastSrsRating()).toBeNull();
  });

  it("undoing an Again restores the lapse count too", () => {
    const yesterday = Date.now() - DAY;
    put(ids[0], 9, Date.now() - 1000, yesterday);
    const lapsesBefore = state(ids[0]).lapses;

    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 500 });
    rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 1 });
    expect(state(ids[0]).lapses).toBe(lapsesBefore + 1);

    undoLastSrsRating();
    expect(state(ids[0]).lapses).toBe(lapsesBefore);
  });

  it("a progress wipe takes the undo stack with it — undo can't resurrect wiped state", () => {
    const yesterday = Date.now() - DAY;
    put(ids[0], 9, Date.now() - 1000, yesterday);
    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 500 });
    rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 3 });

    resetMcqProgress();
    expect(undoLastSrsRating()).toBeNull();
    expect(state(ids[0])).toBeUndefined();
  });
});
