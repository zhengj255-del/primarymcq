import "./testDb";
import { describe, it, expect, beforeAll } from "vitest";
import { sqlite } from "../storage";
import { startSession } from "../mcqStudy";

// The study-session builder's "review" completion filter must select only
// questions never answered correctly (unseen + previously incorrect), matching
// the browse-list review pool. A single correct attempt removes a question.
let topic: string;
let wrongId: string;
let rightId: string;

beforeAll(() => {
  // Two questions from the SAME topic so the topic filter can't be what
  // excludes the correct one — the review filter must do it.
  topic = (sqlite
    .prepare("SELECT topic_slug FROM mcqs WHERE answer IS NOT NULL GROUP BY topic_slug HAVING COUNT(*) >= 2 LIMIT 1")
    .get() as { topic_slug: string }).topic_slug;
  const rows = sqlite
    .prepare("SELECT id FROM mcqs WHERE answer IS NOT NULL AND topic_slug = ? LIMIT 2")
    .all(topic) as Array<{ id: string }>;
  wrongId = rows[0].id;
  rightId = rows[1].id;
  // Scope the test to a single topic; clear any prior attempts on both.
  for (const id of [wrongId, rightId]) {
    sqlite.prepare("DELETE FROM mcq_attempts WHERE mcq_id = ?").run(id);
  }
  const log = (id: string, correct: 0 | 1) =>
    sqlite
      .prepare(
        `INSERT INTO mcq_attempts (mcq_id, session_id, mode, selected, correct, time_ms, attempted_at, rating)
         VALUES (?, NULL, 'test', 'A', ?, 0, ?, NULL)`,
      )
      .run(id, correct, Date.now());
  log(wrongId, 0); // previously incorrect → stays in pool
  log(rightId, 1); // answered correctly → excluded
});

describe("study session — review pool completion filter", () => {
  it("includes previously-incorrect, excludes previously-correct", () => {
    const s = startSession({
      mode: "tutor",
      topics: [topic],
      completion: "review",
      count: 200,
      excludeDisputed: false,
    } as any);
    const ids = new Set(s.mcqs.map((m) => m.id));
    expect(ids.has(wrongId)).toBe(true);
    expect(ids.has(rightId)).toBe(false);
  });
});
