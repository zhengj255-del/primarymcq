import "./testDb";
import { describe, it, expect, beforeAll } from "vitest";
import { sqlite } from "../storage";
import { listMcqs } from "../mcqs";

// "Review pool" (unmastered) = questions never answered correctly:
//   unseen (no attempts) OR attempted but every attempt was wrong.
// A question with at least one correct attempt is mastered and excluded.
let mcqId: string;
let topic: string;

beforeAll(() => {
  const row = sqlite
    .prepare("SELECT id, topic_slug FROM mcqs WHERE answer IS NOT NULL LIMIT 1")
    .get() as { id: string; topic_slug: string };
  mcqId = row.id;
  topic = row.topic_slug;
  // Isolate this question's attempt history so ordering across tests is stable.
  sqlite.prepare("DELETE FROM mcq_attempts WHERE mcq_id = ?").run(mcqId);
});

const logAttempt = (selected: string | null, correct: 0 | 1) =>
  sqlite
    .prepare(
      `INSERT INTO mcq_attempts (mcq_id, session_id, mode, selected, correct, time_ms, attempted_at, rating)
       VALUES (?, NULL, 'test', ?, ?, 0, ?, NULL)`,
    )
    .run(mcqId, selected, correct, Date.now());

const inReviewPool = () =>
  listMcqs({ topic, unmastered: true, limit: 200 }).items.some((m) => m.id === mcqId);

describe("MCQ review pool (unseen + previously incorrect)", () => {
  it("includes an unseen question (no attempts)", () => {
    expect(inReviewPool()).toBe(true);
  });

  it("still includes a question answered only incorrectly", () => {
    logAttempt("B", 0);
    logAttempt("C", 0);
    expect(inReviewPool()).toBe(true);
  });

  it("excludes a question once answered correctly, even after earlier misses", () => {
    logAttempt("A", 1);
    expect(inReviewPool()).toBe(false);
  });
});
