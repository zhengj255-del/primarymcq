import "./testDb";
import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../storage";
import { getSrsQueueStats, submitAttempt, rateSrsAttempt, getUserStats } from "../mcqStudy";

// Two Anki-parity accounting rules the SRS audit found broken:
//
//  1. The daily REVIEW limit counts only questions answered out of the REVIEW
//     lane. Relearning steps are exempt — otherwise a relearn backlog (54
//     questions, in the real seeded corpus) silently withholds that many
//     genuine due reviews.
//  2. A reveal without an answer ("Don't know") is NOT a wrong answer. It was
//     logged with correct = 0 and counted everywhere accuracy is computed,
//     dragging down topic accuracy, mis-flagging weak topics, and knocking a
//     mastered question out of the latest-attempt-correct count.

const DAY = 86400000;
const F = { mode: "srs" as const, count: 20 };
let ids: string[];

const put = (id: string, interval: number, dueAt: number, createdAt: number) =>
  sqlite.prepare(
    `INSERT OR REPLACE INTO mcq_srs_state (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at, stability, difficulty, created_at)
     VALUES (?, 2.5, ?, 1, 0, ?, ?, 2.31, 2.12, ?)`,
  ).run(id, interval, Date.now() - DAY, dueAt, createdAt);
const answerOf = (id: string) =>
  (sqlite.prepare("SELECT answer FROM mcqs WHERE id = ?").get(id) as { answer: string }).answer;
const wrongFor = (id: string) => (["A", "B", "C", "D", "E"].find((k) => k !== answerOf(id)))!;

beforeEach(() => {
  sqlite.prepare("DELETE FROM mcq_attempts").run();
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
  sqlite.prepare("UPDATE settings SET srs_max_reviews_per_day = 200, srs_new_per_day = 20").run();
  ids = (sqlite.prepare("SELECT id FROM mcqs WHERE answer IS NOT NULL ORDER BY id LIMIT 12").all() as Array<{ id: string }>).map((r) => r.id);
});

describe("daily review limit counts the review lane only", () => {
  it("relearning steps never spend review allowance", () => {
    const yesterday = Date.now() - DAY;
    put(ids[0], 0, Date.now() - 1000, yesterday);            // relearn step
    for (let i = 1; i <= 5; i++) put(ids[i], 5, Date.now() - DAY, yesterday); // due reviews
    sqlite.prepare("UPDATE settings SET srs_max_reviews_per_day = 5").run();
    expect(getSrsQueueStats(F).reviews).toBe(5);

    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 500 });
    rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 1 });

    const after = getSrsQueueStats(F);
    expect(after.limits.reviewsRemaining).toBe(5); // untouched by the relearn
    expect(after.reviews).toBe(5);                 // no due review withheld
  });

  it("answering out of the review lane does spend it, once per question", () => {
    const yesterday = Date.now() - DAY;
    for (let i = 0; i < 3; i++) put(ids[i], 5, Date.now() - DAY, yesterday);
    sqlite.prepare("UPDATE settings SET srs_max_reviews_per_day = 3").run();

    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 500 });
    rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 1 }); // lapses to learning
    expect(getSrsQueueStats(F).limits.reviewsRemaining).toBe(2);

    // Its relearn step later the same day must not spend a second slot.
    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 500 });
    rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 3 });
    expect(getSrsQueueStats(F).limits.reviewsRemaining).toBe(2);
  });

  it("new intake is exempt from the review limit", () => {
    sqlite.prepare("UPDATE settings SET srs_max_reviews_per_day = 2").run();
    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 500 });
    rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 3 });
    expect(getSrsQueueStats(F).limits.reviewsRemaining).toBe(2);
  });
});

describe("a reveal without an answer is not a wrong answer", () => {
  it("is excluded from accuracy, topic accuracy and the latest-correct count", () => {
    // One genuine correct answer, then a "Don't know" reveal on the same question.
    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 500 });
    const afterCorrect = getUserStats();
    expect(afterCorrect.totals.attempted).toBe(1);
    expect(afterCorrect.totals.accuracy).toBe(1);

    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: null, timeMs: 500 });
    const afterSkip = getUserStats();
    expect(afterSkip.totals.attempted).toBe(1);   // the skip is not an attempt
    expect(afterSkip.totals.accuracy).toBe(1);    // and cannot drag accuracy down
    expect(afterSkip.last7d.attempted).toBe(1);

    const topic = afterSkip.byTopic.find((tp) => tp.accuracy !== null);
    expect(topic!.accuracy).toBe(1);
    // The skip is the LATEST attempt but must not un-master the question.
    expect(afterSkip.byTopic.reduce((n, tp) => n + tp.correctLatest, 0)).toBe(1);
  });

  it("a genuinely wrong answer still counts", () => {
    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: wrongFor(ids[0]), timeMs: 500 });
    const s = getUserStats();
    expect(s.totals.attempted).toBe(1);
    expect(s.totals.accuracy).toBe(0);
  });
});
