import "./testDb";
import { describe, it, expect, beforeAll } from "vitest";
import { sqlite } from "../storage";
import { listMcqs } from "../mcqs";

// Pick one MCQ and its topic so we can scope listMcqs queries tightly.
let mcqId: string;
let topic: string;

beforeAll(() => {
  const row = sqlite
    .prepare("SELECT id, topic_slug FROM mcqs WHERE answer IS NOT NULL LIMIT 1")
    .get() as { id: string; topic_slug: string };
  mcqId = row.id;
  topic = row.topic_slug;
});

const logAttempt = (selected: string | null) =>
  sqlite
    .prepare(
      `INSERT INTO mcq_attempts (mcq_id, session_id, mode, selected, correct, time_ms, attempted_at, rating)
       VALUES (?, NULL, 'test', ?, 0, 0, ?, NULL)`,
    )
    .run(mcqId, selected, Date.now());

const hasId = (completed: boolean) =>
  listMcqs({ topic, completed, limit: 200 }).items.some((m) => m.id === mcqId);

describe("MCQ completion filtering excludes skipped answers", () => {
  it("a skipped attempt does NOT mark a question completed", () => {
    logAttempt(null); // skip
    expect(hasId(true)).toBe(false);   // not completed
    expect(hasId(false)).toBe(true);   // still counts as not-completed
  });

  it("a submitted answer marks the question completed", () => {
    logAttempt("A"); // real answer
    expect(hasId(true)).toBe(true);
    expect(hasId(false)).toBe(false);
  });
});
