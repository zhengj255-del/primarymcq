import "./testDb";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ensureBaseDisputed } from "./disputedFixture";
import express from "express";
import { createServer, type Server } from "node:http";
import { sqlite } from "../storage";
import { registerRoutes } from "../routes";
import { SRS_SITTABLE_SQL } from "../mcqSittable";
import { startSession } from "../mcqStudy";
import { updateMcqOverride } from "../mcqs";

// ---------------------------------------------------------------------------
// mcq-engine-srs-study-1, mirrored — the SECOND direction of the same drift.
//
// A2 made SRS_SITTABLE_SQL drop effectively-disputed questions
// UNCONDITIONALLY, so every "SRS due N" (the Study tile) now counts only what
// a sitting will actually serve. But the queue lanes themselves are built by
// scopeWhere, which drops disputed questions only under `excludeDisputed` —
// and the queue-stats ROUTE parsed that flag out of the query string and
// defaulted it to FALSE when the parameter was absent. A caller that omitted
// it therefore got a setup strip describing a queue WITH disputed questions in
// it while every count of that queue excluded them: A2's defect, mirrored.
//
// It was latent, not live — the Study page hard-sets excludeDisputed=1 on both
// the queue-stats request and the session request — which is exactly why it
// needed a test: nothing on any screen would have shown it, and the next
// caller of this endpoint would have inherited it.
//
// The fix is that the route no longer reads the parameter at all: the SRS queue
// has ONE dispute rule, the same one SRS_SITTABLE_SQL states, and no caller can
// ask this endpoint to describe a queue the counts disagree with. So these
// tests assert three things at once — absent, =1 and =0 all describe the same
// queue, and that queue is the one SRS_SITTABLE_SQL counts.
//
// The app-wide gate is open here (APP_PASSWORD unset), so the route is driven
// with plain GETs and no credential of any kind.
// ---------------------------------------------------------------------------

const PAST = Date.now() - 60 * 60 * 1000;

let server: Server;
let baseUrl: string;

/** Two answered, un-disputed questions that share a topic slug, so one topic
 *  scopes the whole fixture and the corpus's other questions stay out of it. */
function pickPair(): { topic: string; a: string; b: string } {
  const topicRow = sqlite.prepare(
    `SELECT topic_slug AS topic FROM mcqs
      WHERE answer IS NOT NULL AND disputed = 0
      GROUP BY topic_slug HAVING COUNT(*) >= 2 LIMIT 1`,
  ).get() as { topic: string } | undefined;
  expect(topicRow, "corpus sanity: a topic with two answered, un-disputed MCQs").toBeTruthy();
  const rows = sqlite.prepare(
    `SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL AND disputed = 0
      ORDER BY id LIMIT 2`,
  ).all(topicRow!.topic) as Array<{ id: string }>;
  return { topic: topicRow!.topic, a: rows[0].id, b: rows[1].id };
}

/** Track a question as a graduated review that fell due an hour ago:
 *  interval_days >= 1 puts it in the REVIEW lane, not a learning step. */
function trackDue(id: string): void {
  sqlite.prepare(
    `INSERT OR REPLACE INTO mcq_srs_state (mcq_id, interval_days, reps, last_reviewed_at, due_at, created_at)
     VALUES (?, 5, 3, ?, ?, ?)`,
  ).run(id, PAST, PAST, PAST);
}

/** The count every "SRS due N" surface inherits, scoped to this fixture's
 *  topic. Outer alias `mm` on purpose: SRS_SITTABLE_SQL binds `m` inside its
 *  own EXISTS, and an outer `m` would be shadowed there. */
function sittableDueCount(topic: string): number {
  return (sqlite.prepare(
    `SELECT COUNT(*) AS c FROM mcq_srs_state s JOIN mcqs mm ON mm.id = s.mcq_id
      WHERE s.due_at <= ? AND mm.topic_slug = ? AND ${SRS_SITTABLE_SQL}`,
  ).get(Date.now(), topic) as { c: number }).c;
}

/** What the sitting actually serves in this scope — the Study page's own
 *  filters. srsSkipNew keeps the new lane out, so this is exactly the
 *  tracked-and-due questions. */
function queueServes(topic: string): string[] {
  return startSession({
    mode: "srs", count: 0, topics: [topic], excludeDisputed: true, srsSkipNew: true,
  }).mcqs.map((m) => m.id);
}

/** GET the queue-stats route. `disputedParam` undefined = omit it entirely,
 *  which is the case this file exists for. */
async function queueStats(topic: string, disputedParam?: "0" | "1"): Promise<any> {
  const q = new URLSearchParams({ topics: topic, skipNew: "1" });
  if (disputedParam !== undefined) q.set("excludeDisputed", disputedParam);
  const res = await fetch(`${baseUrl}/api/mcqs/srs/queue-stats?${q.toString()}`);
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  // The shipped corpus may carry no base-disputed question (see disputedFixture.ts).
  ensureBaseDisputed();
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  server = httpServer;
});
afterAll(() => { server?.close(); });

beforeEach(() => {
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
  sqlite.prepare("DELETE FROM mcq_overrides").run();
  sqlite.prepare("DELETE FROM mcq_attempts").run();
});

describe("GET /api/mcqs/srs/queue-stats describes the queue it will actually serve", () => {
  it("with NO excludeDisputed parameter, the disputed due question is neither counted nor served", async () => {
    const { topic, a, b } = pickPair();
    trackDue(a);
    trackDue(b);
    // `b` is disputed the way the user disputes one from the edit panel: an
    // override row over a base column that says 0. The override wins.
    updateMcqOverride(b, { disputed: true });

    // The queue side of the reconciliation: exactly the clean question.
    expect(queueServes(topic)).toEqual([a]);
    expect(sittableDueCount(topic)).toBe(1);

    const stats = await queueStats(topic);
    expect(stats.dueReviews).toBe(1);
    expect(stats.reviews).toBe(1);
    // No new intake was requested, so the strip's total IS the review pile —
    // the number the setup panel puts in front of the candidate.
    expect(stats.learning + stats.reviews + stats.newToday).toBe(1);
  });

  it("omitting the parameter, sending 1, and sending 0 all describe the same queue", async () => {
    const { topic, a, b } = pickPair();
    trackDue(a);
    trackDue(b);
    updateMcqOverride(b, { disputed: true });

    const absent = await queueStats(topic);
    const explicitTrue = await queueStats(topic, "1");
    // Explicit 0 is the request that used to re-admit disputed questions. It
    // cannot be honoured: SRS_SITTABLE_SQL — every count of this queue —
    // excludes them unconditionally, so serving them here would put the strip
    // back into disagreement with the tile. The endpoint has one answer.
    const explicitFalse = await queueStats(topic, "0");

    expect(explicitTrue).toEqual(absent);
    expect(explicitFalse).toEqual(absent);
    expect(absent.dueReviews).toBe(1);
  });

  it("a due question DISPUTED IN THE BASE CORPUS is excluded with no parameter either", async () => {
    const row = sqlite.prepare(
      `SELECT id, topic_slug AS topic FROM mcqs WHERE answer IS NOT NULL AND disputed = 1 LIMIT 1`,
    ).get() as { id: string; topic: string } | undefined;
    expect(row, "corpus sanity: an answered, base-disputed MCQ").toBeTruthy();
    trackDue(row!.id);

    const stats = await queueStats(row!.topic);
    expect(stats.dueReviews).toBe(0);
    expect(stats.reviews).toBe(0);
    expect(queueServes(row!.topic)).toEqual([]);
    expect(sittableDueCount(row!.topic)).toBe(0);
  });
});
