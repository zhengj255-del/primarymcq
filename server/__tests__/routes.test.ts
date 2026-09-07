import "./testDb";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sqlite, storage, todayISO } from "../storage";
import { registerRoutes, EXPORT_TABLES } from "../routes";
import { installAuth } from "../auth";
import { installBodyParsers, safeErrorFields } from "../bodyParsers";
import { serveStatic } from "../static";

// ---------------------------------------------------------------------------
// The whole API contract, over HTTP, with the gate OPEN (APP_PASSWORD unset —
// dev/test mode). Every route the client calls is driven here the way the
// client calls it: the study loops (tutor → attempts → finish → summary; SRS →
// reveal → rate → undo), settings, the progress wipe, the backup round-trip,
// the corpus edit/triage routes, and — the one that is easy to lose in a
// refactor — ROUTE ORDER: every literal /api/mcqs/... path must answer before
// the wildcard /api/mcqs/:id can swallow it as an id lookup.
//
// The app is assembled as server/index.ts assembles it, then serveStatic is
// mounted on a throwaway dist so the production catch-all's JSON 404 for an
// unknown /api path can be asserted without a client build.
// ---------------------------------------------------------------------------

// A topic that ships with no disputed questions, so `excludeDisputed` sittings
// draw from a pool whose size is known and every sitting is deterministic.
const TOPIC = "gastrointestinal";

let server: Server;
let baseUrl: string;
let distDir: string;
const savedFuzz = process.env.MCQ_SRS_FUZZ;

const api = (p: string, init?: RequestInit) => fetch(`${baseUrl}${p}`, init);
const post = (p: string, body?: unknown) =>
  api(p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const patch = (p: string, body: unknown) =>
  api(p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const del = (p: string) => api(p, { method: "DELETE" });

const answerOf = (id: string) =>
  (sqlite.prepare("SELECT answer FROM mcqs WHERE id = ?").get(id) as { answer: string }).answer;
const wrongFor = (id: string) => (["A", "B", "C", "D", "E"].find((k) => k !== answerOf(id)))!;
const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) c FROM "${table}"`).get() as { c: number }).c;
const topicTotal = (sqlite.prepare("SELECT COUNT(*) c FROM mcqs WHERE topic_slug = ?").get(TOPIC) as { c: number }).c;
const topicAnswered = (sqlite.prepare(
  "SELECT COUNT(*) c FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL",
).get(TOPIC) as { c: number }).c;

beforeAll(async () => {
  delete process.env.APP_PASSWORD; // the gate must be OPEN for this file
  process.env.MCQ_SRS_FUZZ = "0";  // exact interval goldens below
  sqlite.prepare("DELETE FROM mcq_attempts").run();
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
  sqlite.prepare("DELETE FROM mcq_srs_undo").run();
  sqlite.prepare("DELETE FROM mcq_srs_extra_new").run();
  sqlite.prepare("DELETE FROM mcq_study_sessions").run();
  sqlite.prepare("DELETE FROM mcq_overrides").run();
  // The shipped corpus has carried no disputed questions since the 2026-09-07
  // whole-bank refresh (every dispute was triaged in the tracker before the
  // hand-off). The stats header and the triage queue are asserted non-empty
  // below, so flag ONE question here the way the ingest flags one the corpus
  // ships disputed — outside TOPIC, whose pool must stay clean.
  sqlite.prepare(
    "UPDATE mcqs SET disputed = 1 WHERE id = (SELECT id FROM mcqs WHERE topic_slug <> ? AND answer IS NOT NULL ORDER BY id LIMIT 1)",
  ).run(TOPIC);

  const app = express();
  installAuth(app);
  installBodyParsers(app);
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  // The API error handler, as index.ts installs it.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const { status, message } = safeErrorFields(err);
    if (res.headersSent) return next(err);
    res.status(status).json({ message });
  });
  // The production catch-all over a stand-in client build.
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcq-site-dist-"));
  fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>MCQ Study shell</title>");
  serveStatic(app, distDir);

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  server = httpServer;
});

afterAll(() => {
  if (savedFuzz === undefined) delete process.env.MCQ_SRS_FUZZ;
  else process.env.MCQ_SRS_FUZZ = savedFuzz;
  server?.closeAllConnections?.();
  server?.close();
  fs.rmSync(distDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe("open endpoints", () => {
  it("the gate reports itself open and the caller as authed", async () => {
    const res = await api("/api/auth/status");
    expect(await res.json()).toEqual({ required: false, authed: true });
  });

  it("healthz touches the database and says so", async () => {
    const res = await api("/api/healthz");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("build id is a string", async () => {
    const res = await api("/api/build");
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).buildId).toBe("string");
  });
});

// ---------------------------------------------------------------------------
describe("corpus reads", () => {
  it("GET /api/mcqs/stats has the McqStats shape", async () => {
    const res = await api("/api/mcqs/stats");
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(Object.keys(s).sort()).toEqual(["byTopic", "disputed", "papers", "total", "withAnswer"]);
    expect(s.total).toBeGreaterThan(1800);
    // Every shipped question is keyed since the whole-bank refresh, so the two
    // counts coincide; withAnswer can never exceed total.
    expect(s.withAnswer).toBeLessThanOrEqual(s.total);
    expect(s.disputed).toBeGreaterThan(0);
    const gi = s.byTopic.find((t: any) => t.slug === TOPIC);
    expect(gi).toMatchObject({ slug: TOPIC, name: expect.any(String), domain: expect.any(String), count: topicTotal });
    expect(typeof gi.linked).toBe("number");
    expect(s.papers.length).toBeGreaterThan(0);
    for (const p of s.papers) {
      expect(Object.keys(p).sort()).toEqual(["count", "sittable", "sittableWithDisputed", "tag"]);
    }
  });

  it("GET /api/mcqs pages and filters", async () => {
    const page = await (await api(`/api/mcqs?topic=${TOPIC}&limit=5`)).json();
    expect(page.total).toBe(topicTotal);
    expect(page.items).toHaveLength(5);
    for (const m of page.items) {
      expect(m.topicSlug).toBe(TOPIC);
      expect(Object.keys(m)).toEqual(expect.arrayContaining([
        "id", "code", "displayCode", "topicName", "domain", "papers", "stem", "options",
        "answer", "reason", "urls", "disputed", "figure", "loCodes", "edited", "excluded",
      ]));
    }
    const next = await (await api(`/api/mcqs?topic=${TOPIC}&limit=5&offset=5`)).json();
    expect(next.items.map((m: any) => m.id)).not.toEqual(page.items.map((m: any) => m.id));

    // The limit clamps at 200 whatever the client asks for.
    const big = await (await api("/api/mcqs?limit=1000")).json();
    expect(big.items).toHaveLength(200);
    expect(big.total).toBeGreaterThan(200);

    // disputed=true is the stats header's own count, row for row.
    const stats = await (await api("/api/mcqs/stats")).json();
    const disputed = await (await api("/api/mcqs?disputed=true&limit=200")).json();
    expect(disputed.total).toBe(stats.disputed);
    expect(disputed.items.every((m: any) => m.disputed === true)).toBe(true);
    const clean = await (await api(`/api/mcqs?topic=${TOPIC}&disputed=false&limit=200`)).json();
    expect(clean.total).toBe(topicTotal);

    // Nothing has been attempted yet: completed=false is the whole topic and
    // completed=true is empty; the unmastered pool is everything.
    expect((await (await api(`/api/mcqs?topic=${TOPIC}&completed=false&limit=1`)).json()).total).toBe(topicTotal);
    expect((await (await api(`/api/mcqs?topic=${TOPIC}&completed=true&limit=1`)).json()).total).toBe(0);
    expect((await (await api(`/api/mcqs?topic=${TOPIC}&unmastered=true&limit=1`)).json()).total).toBe(topicTotal);

    // Free-text search over the stem finds a known question. The longest stem
    // in the topic, because some stems are a bare "Bile:" with no word in them
    // worth searching for.
    const rich = sqlite.prepare(
      "SELECT id, stem FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL ORDER BY LENGTH(stem) DESC LIMIT 1",
    ).get(TOPIC) as { id: string; stem: string };
    const word = rich.stem.split(/[^A-Za-z]+/).find((w) => w.length >= 7);
    expect(word, `a searchable word in: ${rich.stem}`).toBeTruthy();
    const hits = await (await api(`/api/mcqs?topic=${TOPIC}&q=${encodeURIComponent(word!)}&limit=200`)).json();
    expect(hits.items.some((m: any) => m.id === rich.id)).toBe(true);
    expect(hits.total).toBe(hits.items.length);
    // …and a word no stem contains finds nothing.
    expect((await (await api(`/api/mcqs?topic=${TOPIC}&q=zxqvwxyzzy&limit=1`)).json()).total).toBe(0);
  });

  it("GET /api/mcqs/by-lo/:code decodes the code and returns its questions", async () => {
    const link = sqlite.prepare(
      "SELECT lo_code AS code, COUNT(*) c FROM mcq_lo_links GROUP BY lo_code ORDER BY c DESC LIMIT 1",
    ).get() as { code: string; c: number };
    const res = await api(`/api/mcqs/by-lo/${encodeURIComponent(link.code)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(link.code);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((m: any) => m.loCodes.includes(link.code))).toBe(true);
  });

  it("GET /api/mcqs/:id serves one question and 404s an unknown id", async () => {
    const id = (sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = ? ORDER BY id LIMIT 1").get(TOPIC) as { id: string }).id;
    const res = await api(`/api/mcqs/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(id);
    const missing = await api("/api/mcqs/no-such-topic__NOPE-1");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "MCQ not found" });
  });
});

// ---------------------------------------------------------------------------
let tutorSessionId: string;
let tutorIds: string[];

describe("the tutor loop: start → attempts → finish → summary", () => {
  it("starts a tutor sitting of the requested size", async () => {
    const res = await post("/api/mcqs/session", { mode: "tutor", topics: [TOPIC], count: 3, excludeDisputed: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.sessionId).toBe("string");
    expect(body.mode).toBe("tutor");
    expect(body.mcqs).toHaveLength(3);
    expect(body.timeLimitSec).toBeNull();
    expect(body.mcqs.every((m: any) => m.topicSlug === TOPIC && m.answer !== null)).toBe(true);
    tutorSessionId = body.sessionId;
    tutorIds = body.mcqs.map((m: any) => m.id);
  });

  it("logs a correct, a wrong and a skipped attempt", async () => {
    const [a, b, c] = tutorIds;
    const right = await (await post("/api/mcqs/attempt", {
      sessionId: tutorSessionId, mcqId: a, mode: "tutor", selected: answerOf(a), timeMs: 4000,
    })).json();
    expect(right).toMatchObject({ correct: true, correctAnswer: answerOf(a) });
    expect(typeof right.reason).toBe("string");
    expect(right.srsPreview).toBeUndefined(); // tutor reveals carry no rating preview

    const wrong = await (await post("/api/mcqs/attempt", {
      sessionId: tutorSessionId, mcqId: b, mode: "tutor", selected: wrongFor(b), timeMs: 2000,
    })).json();
    expect(wrong).toMatchObject({ correct: false, correctAnswer: answerOf(b) });

    const skipped = await (await post("/api/mcqs/attempt", {
      sessionId: tutorSessionId, mcqId: c, mode: "tutor", selected: null, timeMs: 1000,
    })).json();
    expect(skipped.correct).toBe(false);
    expect(count("mcq_attempts")).toBe(3);
  });

  it("refuses a malformed attempt and an unknown question", async () => {
    const bad = await post("/api/mcqs/attempt", { mcqId: tutorIds[0], mode: "tutor" }); // no `selected`
    expect(bad.status).toBe(400);
    const unknown = await post("/api/mcqs/attempt", {
      sessionId: tutorSessionId, mcqId: "no-such-topic__NOPE-1", mode: "tutor", selected: "A", timeMs: 1,
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toMatch(/not found/i);
  });

  it("a body that is not JSON is refused with a fixed message", async () => {
    const res = await api("/api/mcqs/session", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "request body is not valid JSON" });
  });

  it("finishes the sitting and the summary is what was graded", async () => {
    const res = await post(`/api/mcqs/session/${tutorSessionId}/finish`);
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.session.id).toBe(tutorSessionId);
    expect(s.session.mode).toBe("tutor");
    expect(s.session.totalQuestions).toBe(3);
    expect(typeof s.session.finishedAt).toBe("number");
    expect(s).toMatchObject({ totalAnswered: 3, correctCount: 1, incorrectCount: 1, skippedCount: 1, accuracyPct: 33 });
    expect(s.medianTimeSec).toBe(2);
    expect(s.attempts).toHaveLength(3);
    expect(s.attempts[0]).toMatchObject({ mcqId: tutorIds[0], correct: 1, correctAnswer: answerOf(tutorIds[0]) });
    expect(typeof s.attempts[0].stem).toBe("string");
    expect(s.byTopic).toEqual([expect.objectContaining({ slug: TOPIC, answered: 3, correct: 1 })]);

    // Reloadable: the summary route returns the same thing, finishedAt intact.
    const again = await (await api(`/api/mcqs/session/${tutorSessionId}/summary`)).json();
    expect(again.session.finishedAt).toBe(s.session.finishedAt);
    expect(again.correctCount).toBe(1);
  });

  it("an unknown session is a 404 on both finish and summary", async () => {
    expect((await post("/api/mcqs/session/not-a-session/finish")).status).toBe(404);
    expect((await api("/api/mcqs/session/not-a-session/summary")).status).toBe(404);
  });

  it("a test sitting carries its time limit", async () => {
    const res = await post("/api/mcqs/session", { mode: "test", topics: [TOPIC], count: 2, timeLimitSec: 600 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("test");
    expect(body.mcqs).toHaveLength(2);
    expect(body.timeLimitSec).toBe(600);
  });

  it("rejects a session request the schema refuses", async () => {
    expect((await post("/api/mcqs/session", { mode: "exam", count: 5 })).status).toBe(400);
    expect((await post("/api/mcqs/session", { mode: "tutor", count: 0 })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("route order: literal /api/mcqs/... paths answer before the :id wildcard", () => {
  it("GET /api/mcqs/user-stats is the stats, not an MCQ lookup", async () => {
    const res = await api("/api/mcqs/user-stats");
    expect(res.status).toBe(200);
    const s = await res.json();
    // The skipped attempt is not an attempt; the correct and the wrong one are.
    expect(s.totals).toMatchObject({ attempted: 2, uniqueMcqs: 2, correct: 1, accuracy: 0.5 });
    expect(s.streakDays).toBe(1);
    expect(s.srsDue).toEqual({ dueNow: 0, dueToday: 0, totalTracked: 0 });
    const sess = s.recentSessions.find((r: any) => r.id === tutorSessionId);
    expect(sess).toMatchObject({ mode: "tutor", totalQuestions: 3, correctCount: 1 });
    expect(typeof sess.finishedAt).toBe("number");
    expect(s.byTopic.find((t: any) => t.slug === TOPIC)).toMatchObject({ poolSize: topicAnswered, attempted: 2, correctLatest: 1 });
  });

  it("GET /api/mcqs/triage is the queue, with counts and rows only", async () => {
    const res = await api("/api/mcqs/triage");
    expect(res.status).toBe(200);
    const t = await res.json();
    expect(Object.keys(t).sort()).toEqual(["counts", "items"]);
    expect(Object.keys(t.counts).sort()).toEqual(["accepted", "discarded", "fixed", "pending", "total"]);
    expect(t.items.length).toBe(t.counts.total);
    expect(t.counts.pending).toBeGreaterThan(0);
    expect(t.items.every((m: any) => typeof m.triageStatus === "string")).toBe(true);
  });

  it("the other literal paths answer too", async () => {
    expect(await (await api("/api/mcqs/weak-areas")).json()).toEqual({ items: [] });
    expect(await (await api("/api/mcqs/srs/due")).json()).toEqual({ items: [] });
    expect((await api("/api/mcqs/stats")).status).toBe(200);
    const qs = await api(`/api/mcqs/srs/queue-stats?topics=${TOPIC}`);
    expect(qs.status).toBe(200);
    expect(typeof (await qs.json()).newAvailable).toBe("number");
  });

  it("…and only a genuinely unknown id reaches the wildcard", async () => {
    const res = await api("/api/mcqs/user-stats-typo");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "MCQ not found" });
  });
});

// ---------------------------------------------------------------------------
let srsIds: string[];

describe("the SRS loop: start → reveal → rate → undo, with queue-stats in step", () => {
  it("an SRS sitting is not a session and serves today's new intake", async () => {
    const res = await post("/api/mcqs/session", { mode: "srs", topics: [TOPIC], count: 1, excludeDisputed: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBeNull();
    expect(body.mode).toBe("srs");
    expect(body.timeLimitSec).toBeNull();
    // Nothing tracked yet, so the queue is exactly the new lane: min(pool, 20).
    expect(body.mcqs).toHaveLength(Math.min(topicAnswered, 20));
    srsIds = body.mcqs.map((m: any) => m.id);
    expect(count("mcq_study_sessions")).toBe(2); // tutor + test only; SRS wrote none
  });

  it("queue-stats describes that queue", async () => {
    const s = await (await api(`/api/mcqs/srs/queue-stats?topics=${TOPIC}`)).json();
    expect(Object.keys(s).sort()).toEqual(["dueLearning", "dueReviews", "learning", "limits", "newAvailable", "newToday", "reviews"]);
    expect(s).toMatchObject({ learning: 0, dueLearning: 0, reviews: 0, dueReviews: 0, newAvailable: topicAnswered, newToday: Math.min(topicAnswered, 20) });
    expect(s.limits).toMatchObject({ newPerDay: 20, maxReviewsPerDay: 200, newRemaining: 20, reviewsRemaining: 200, extraNewToday: 0 });
    // skipNew withholds the new lane and spends nothing.
    const skip = await (await api(`/api/mcqs/srs/queue-stats?topics=${TOPIC}&skipNew=1`)).json();
    expect(skip.newToday).toBe(0);
    expect(skip.limits.newRemaining).toBe(20);
  });

  it("a reveal previews exactly what each button will schedule; rating delivers it", async () => {
    const id = srsIds[0];
    const reveal = await (await post("/api/mcqs/attempt", {
      sessionId: null, mcqId: id, mode: "srs", selected: answerOf(id), timeMs: 1500,
    })).json();
    expect(reveal.correct).toBe(true);
    expect(reveal.srsPreview).toEqual({ again: 0, hard: 1, good: 2, easy: 8 }); // fresh question, fuzz off

    const rated = await post("/api/mcqs/srs/rate", { mcqId: id, rating: 3 });
    expect(rated.status).toBe(200);
    const { srs } = await rated.json();
    expect(srs).toMatchObject({ reps: 1, intervalDays: 2, stability: 2.31, difficulty: 2.12 });
    expect(srs.dueAt).toBeGreaterThan(Date.now());

    // The rating spent one new-intake slot.
    const s = await (await api(`/api/mcqs/srs/queue-stats?topics=${TOPIC}`)).json();
    expect(s.limits.newRemaining).toBe(19);
    expect(s.newAvailable).toBe(topicAnswered - 1);
  });

  it("a second rating of the same reveal is refused (no double-advance)", async () => {
    const res = await post("/api/mcqs/srs/rate", { mcqId: srsIds[0], rating: 3 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already rated/i);
  });

  it("a missed question can only be rated Again", async () => {
    const id = srsIds[1];
    const reveal = await (await post("/api/mcqs/attempt", {
      sessionId: null, mcqId: id, mode: "srs", selected: wrongFor(id), timeMs: 900,
    })).json();
    expect(reveal.correct).toBe(false);
    const good = await post("/api/mcqs/srs/rate", { mcqId: id, rating: 3 });
    expect(good.status).toBe(400);
    expect((await good.json()).error).toMatch(/Again/);
    const again = await post("/api/mcqs/srs/rate", { mcqId: id, rating: 1 });
    expect(again.status).toBe(200);
    expect((await again.json()).srs.intervalDays).toBe(0);
    expect((await (await api("/api/mcqs/srs/due")).json()).items.map((m: any) => m.id)).toEqual([]); // 10-min step, not due yet
  });

  it("rejects a rating the schema refuses and a rating with no reveal", async () => {
    expect((await post("/api/mcqs/srs/rate", { mcqId: srsIds[0], rating: 5 })).status).toBe(400);
    const noReveal = await post("/api/mcqs/srs/rate", { mcqId: srsIds[2], rating: 3 });
    expect(noReveal.status).toBe(400);
    expect((await noReveal.json()).error).toMatch(/reveal/i);
  });

  it("undo walks the ratings back most-recent first, then 404s", async () => {
    const first = await post("/api/mcqs/srs/undo");
    expect(first.status).toBe(200);
    const u1 = await first.json();
    expect(u1.mcqId).toBe(srsIds[1]);
    expect(Object.keys(u1.preview).sort()).toEqual(["again", "easy", "good", "hard"]);

    const second = await (await post("/api/mcqs/srs/undo")).json();
    expect(second.mcqId).toBe(srsIds[0]);

    const empty = await post("/api/mcqs/srs/undo");
    expect(empty.status).toBe(404);
    expect(await empty.json()).toEqual({ error: "nothing to undo" });

    // Both questions are new again and the day's intake is whole.
    expect(count("mcq_srs_state")).toBe(0);
    const s = await (await api(`/api/mcqs/srs/queue-stats?topics=${TOPIC}`)).json();
    expect(s.limits.newRemaining).toBe(20);
    // The answers stand; only the ratings were undone.
    expect(count("mcq_attempts")).toBe(5);
    expect((sqlite.prepare("SELECT COUNT(*) c FROM mcq_attempts WHERE rating IS NOT NULL").get() as { c: number }).c).toBe(0);
  });

  it("study more new today: grant, see it in the strip, withdraw it", async () => {
    const grant = await post("/api/mcqs/srs/extra-new", { count: 5 });
    expect(grant.status).toBe(200);
    expect(await grant.json()).toEqual({ day: todayISO(), extraNew: 5 });
    const s = await (await api(`/api/mcqs/srs/queue-stats?topics=${TOPIC}`)).json();
    expect(s.limits.extraNewToday).toBe(5);
    expect(s.limits.newRemaining).toBe(25);
    expect(s.newToday).toBe(Math.min(topicAnswered, 25));

    const withdrawn = await del("/api/mcqs/srs/extra-new");
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toEqual({ day: todayISO(), extraNew: 0 });

    for (const bad of [{ count: 0 }, { count: -1 }, { count: 501 }, { count: "many" }, {}]) {
      expect((await post("/api/mcqs/srs/extra-new", bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
describe("settings", () => {
  it("GET returns the one row with its defaults", async () => {
    const res = await api("/api/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, srsRetention: 0.9, srsFuzz: 1, srsNewPerDay: 20, srsMaxReviewsPerDay: 200 });
  });

  it("PATCH applies only the fields sent and returns the merged row", async () => {
    const res = await patch("/api/settings", { srsRetention: 0.85, srsNewPerDay: 15 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, srsRetention: 0.85, srsFuzz: 1, srsNewPerDay: 15, srsMaxReviewsPerDay: 200 });
    // Unknown keys are stripped, not refused; an empty patch is a no-op.
    expect(await (await patch("/api/settings", { somethingElse: 1 })).json()).toMatchObject({ srsRetention: 0.85 });
    expect(await (await patch("/api/settings", {})).json()).toMatchObject({ srsNewPerDay: 15 });
    expect(storage.getSettings().srsNewPerDay).toBe(15);
  });

  it("a bad field is a 400 whose error is a STRING the client can show", async () => {
    const low = await patch("/api/settings", { srsRetention: 0.5 });
    expect(low.status).toBe(400);
    expect(await low.json()).toEqual({ error: "srsRetention must be between 0.70 and 0.97" });
    const high = await patch("/api/settings", { srsRetention: 0.99 });
    expect(high.status).toBe(400);
    expect(typeof (await high.json()).error).toBe("string");
    for (const bad of [{ srsNewPerDay: -1 }, { srsNewPerDay: 1.5 }, { srsMaxReviewsPerDay: -5 }, { srsFuzz: 2 }, { srsFuzz: "on" }]) {
      const res = await patch("/api/settings", bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(typeof (await res.json()).error, JSON.stringify(bad)).toBe("string");
    }
    // Nothing from a refused patch landed.
    expect(await (await api("/api/settings")).json()).toEqual({ id: 1, srsRetention: 0.85, srsFuzz: 1, srsNewPerDay: 15, srsMaxReviewsPerDay: 200 });
    // Back to the defaults for the cases below.
    await patch("/api/settings", { srsRetention: 0.9, srsNewPerDay: 20 });
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/mcqs/reset", () => {
  it("refuses without ?confirm=YES and touches nothing", async () => {
    const before = count("mcq_attempts");
    expect(before).toBeGreaterThan(0);
    const res = await post("/api/mcqs/reset");
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
    expect(count("mcq_attempts")).toBe(before);
  });

  it("wipes attempts, schedule and sittings — and reports each count", async () => {
    const attempts = count("mcq_attempts");
    const srs = count("mcq_srs_state");
    const sessions = count("mcq_study_sessions");
    expect(sessions).toBe(2);
    const res = await post("/api/mcqs/reset?confirm=YES");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deletedAttempts: attempts, deletedSrsState: srs, deletedSessions: sessions });
    for (const t of ["mcq_attempts", "mcq_srs_state", "mcq_study_sessions", "mcq_srs_undo"]) expect(count(t), t).toBe(0);
    // The corpus, its LO links and the settings row are untouched.
    expect(count("mcqs")).toBeGreaterThan(1800);
    expect(count("mcq_lo_links")).toBeGreaterThan(0);
    expect(count("settings")).toBe(1);
    const stats = await (await api("/api/mcqs/user-stats")).json();
    expect(stats.totals.attempted).toBe(0);
    expect(stats.recentSessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("editing and triaging a question", () => {
  let id: string;
  beforeAll(() => {
    id = (sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL ORDER BY id LIMIT 1").get(TOPIC) as { id: string }).id;
  });
  const enc = () => encodeURIComponent(id);

  it("PATCH stores an override; GET serves it merged", async () => {
    const res = await patch(`/api/mcqs/${enc()}`, { reason: "Edited on the site.", disputed: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, reason: "Edited on the site.", disputed: true, edited: true, excluded: false });
    expect(await (await api(`/api/mcqs/${enc()}`)).json()).toMatchObject({ reason: "Edited on the site.", disputed: true, edited: true });
    // The dispute the user raised is now in the triage queue, pending.
    const t = await (await api("/api/mcqs/triage")).json();
    expect(t.items.find((m: any) => m.id === id)?.triageStatus).toBe("pending");
  });

  it("PATCH refuses a bad edit and an unknown id", async () => {
    expect((await patch(`/api/mcqs/${enc()}`, { answer: "Z" })).status).toBe(400);
    expect((await patch(`/api/mcqs/${enc()}`, { stem: "" })).status).toBe(400);
    expect((await patch("/api/mcqs/no-such-topic__NOPE-1", { reason: "x" })).status).toBe(404);
  });

  it("triage: accept → reopen → discard → fix, each visible on the record", async () => {
    const accept = await post(`/api/mcqs/${enc()}/triage`, { action: "accept" });
    expect(accept.status).toBe(200);
    // The dispute is cleared and the earlier reason edit is kept — which is
    // exactly what makes the verdict read "fixed" rather than "accepted": a
    // resolved dispute on a content-edited question IS a fix.
    expect(await accept.json()).toMatchObject({ id, triageStatus: "fixed", disputed: false, edited: true, reason: "Edited on the site." });

    // A plain accept on an untouched question reads "accepted".
    const other = (sqlite.prepare(
      "SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL AND id <> ? ORDER BY id LIMIT 1",
    ).get(TOPIC, id) as { id: string }).id;
    await patch(`/api/mcqs/${encodeURIComponent(other)}`, { disputed: true });
    expect(await (await post(`/api/mcqs/${encodeURIComponent(other)}/triage`, { action: "accept" })).json())
      .toMatchObject({ id: other, triageStatus: "accepted", disputed: false });
    await del(`/api/mcqs/${encodeURIComponent(other)}/override`);

    expect(await (await post(`/api/mcqs/${enc()}/triage`, { action: "reopen" })).json()).toMatchObject({ triageStatus: "pending" });

    const discard = await (await post(`/api/mcqs/${enc()}/triage`, { action: "discard" })).json();
    expect(discard).toMatchObject({ triageStatus: "discarded", excluded: true });
    // Discarded: out of the bank's list, still on the Disputes ledger.
    const list = await (await api(`/api/mcqs?topic=${TOPIC}&limit=200`)).json();
    expect(list.total).toBe(topicTotal - 1);
    expect(list.items.some((m: any) => m.id === id)).toBe(false);
    const t = await (await api("/api/mcqs/triage")).json();
    expect(t.items.find((m: any) => m.id === id)?.triageStatus).toBe("discarded");
    expect(t.counts.discarded).toBe(1);

    // fix applies edits AND clears the dispute in one step.
    const fix = await (await post(`/api/mcqs/${enc()}/triage`, { action: "fix", edit: { reason: "Fixed in triage." } })).json();
    expect(fix).toMatchObject({ triageStatus: "fixed", disputed: false, excluded: false, reason: "Fixed in triage." });

    expect((await post(`/api/mcqs/${enc()}/triage`, { action: "burn" })).status).toBe(400);
    expect((await post("/api/mcqs/no-such-topic__NOPE-1/triage", { action: "accept" })).status).toBe(404);
  });

  it("DELETE …/override reverts to the corpus", async () => {
    const res = await del(`/api/mcqs/${enc()}/override`);
    expect(res.status).toBe(200);
    const rec = await res.json();
    expect(rec).toMatchObject({ id, edited: false, excluded: false, disputed: false });
    expect(rec.reason).not.toBe("Fixed in triage.");
    expect((await del("/api/mcqs/no-such-topic__NOPE-1/override")).status).toBe(404);
    expect((await (await api(`/api/mcqs?topic=${TOPIC}&limit=1`)).json()).total).toBe(topicTotal);
  });
});

// ---------------------------------------------------------------------------
describe("backup: GET /api/export → POST /api/import?confirm=YES", () => {
  let editedId: string;
  let dump: any;

  beforeAll(async () => {
    // One row in every table a backup carries, each recognisable.
    editedId = (sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL ORDER BY id LIMIT 1").get(TOPIC) as { id: string }).id;
    await patch("/api/settings", { srsNewPerDay: 33 });
    await patch(`/api/mcqs/${encodeURIComponent(editedId)}`, { reason: "Kept across the round-trip." });
    const sitting = await (await post("/api/mcqs/session", { mode: "srs", topics: [TOPIC], count: 1, excludeDisputed: true })).json();
    const id = sitting.mcqs[0].id;
    await post("/api/mcqs/attempt", { sessionId: null, mcqId: id, mode: "srs", selected: answerOf(id), timeMs: 700 });
    await post("/api/mcqs/srs/rate", { mcqId: id, rating: 3 }); // attempts + srs_state + srs_undo
    await post("/api/mcqs/srs/extra-new", { count: 2 });          // srs_extra_new
    await post("/api/mcqs/session", { mode: "tutor", topics: [TOPIC], count: 2 }); // study_sessions
  });

  it("the export names every table in the contract, as raw snake_case rows, as a download", async () => {
    const res = await api("/api/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="mcq-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    dump = await res.json();
    expect(dump.version).toBe(1);
    expect(dump.app).toBe("mcq-site");
    expect(typeof dump.exportedAt).toBe("string");
    expect(Object.keys(dump.tables).sort()).toEqual([...EXPORT_TABLES].sort());
    expect([...EXPORT_TABLES].sort()).toEqual([
      "mcq_attempts", "mcq_overrides", "mcq_srs_extra_new", "mcq_srs_state", "mcq_srs_undo", "mcq_study_sessions", "settings",
    ]);
    for (const t of EXPORT_TABLES) {
      expect(Array.isArray(dump.tables[t]), t).toBe(true);
      expect(dump.tables[t].length, t).toBe(count(t));
      expect(dump.tables[t].length, `${t} is seeded`).toBeGreaterThan(0);
    }
    expect(dump.tables.settings).toEqual([{ id: 1, srs_retention: 0.9, srs_fuzz: 1, srs_new_per_day: 33, srs_max_reviews_per_day: 200 }]);
    expect(dump.tables.mcq_overrides[0]).toMatchObject({ mcq_id: editedId, reason: "Kept across the round-trip." });
    expect(dump.tables.mcq_attempts[0]).toHaveProperty("mcq_id");
    expect(dump.tables.mcq_attempts[0]).toHaveProperty("attempted_at");
    expect(dump.tables.mcq_srs_state[0]).toHaveProperty("due_at");
    expect(dump.tables.mcq_srs_extra_new).toEqual([{ day: todayISO(), extra: 2 }]);
  });

  it("import refuses without confirm, refuses a body that is not this app's export, and touches nothing", async () => {
    const before = Object.fromEntries(EXPORT_TABLES.map((t) => [t, count(t)]));
    expect((await post("/api/import", dump)).status).toBe(400);

    const notAnExport = await post("/api/import?confirm=YES", { tables: {} });
    expect(notAnExport.status).toBe(400);
    expect((await notAnExport.json()).error).toMatch(/not an MCQ Study backup/);

    const otherApp = await post("/api/import?confirm=YES", { version: 1, app: "some-other-app", tables: { cards: [] } });
    expect(otherApp.status).toBe(400);
    expect(typeof (await otherApp.json()).error).toBe("string");

    const unknownTable = await post("/api/import?confirm=YES", { version: 1, app: "mcq-site", tables: { cards: [] } });
    expect(unknownTable.status).toBe(400);
    expect((await unknownTable.json()).error).toMatch(/unknown table/);

    expect((await post("/api/import?confirm=YES", { version: 2, app: "mcq-site", tables: {} })).status).toBe(400);
    expect((await post("/api/import?confirm=YES", { version: 1, app: "mcq-site", tables: {} })).status).toBe(400);

    expect(Object.fromEntries(EXPORT_TABLES.map((t) => [t, count(t)]))).toEqual(before);
  });

  it("a dump that fails half-way is rolled back whole", async () => {
    // settings would land first; the attempt row then violates NOT NULL.
    const res = await post("/api/import?confirm=YES", {
      version: 1, app: "mcq-site",
      tables: {
        settings: [{ id: 1, srs_new_per_day: 44 }],
        mcq_attempts: [{ mcq_id: editedId, mode: "srs", correct: null, attempted_at: 1 }],
      },
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.note).toMatch(/rolled back/);
    expect(storage.getSettings().srsNewPerDay).toBe(33); // the first table did NOT stick
    expect(count("mcq_attempts")).toBe(dump.tables.mcq_attempts.length);
  });

  it("restores every table from the export after a wipe, settings at id 1", async () => {
    for (const t of EXPORT_TABLES) sqlite.prepare(`DELETE FROM "${t}"`).run();
    expect(count("mcq_attempts")).toBe(0);

    // A dump whose settings row wandered off id 1 must still restore to id 1:
    // storage.getSettings() reads that one row.
    const wandered = { ...dump, tables: { ...dump.tables, settings: [{ ...dump.tables.settings[0], id: 7 }] } };
    const res = await post("/api/import?confirm=YES", wandered);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.restored).toEqual(Object.fromEntries(EXPORT_TABLES.map((t) => [t, dump.tables[t].length])));

    for (const t of EXPORT_TABLES) expect(count(t), t).toBe(dump.tables[t].length);
    expect(sqlite.prepare("SELECT id FROM settings").all()).toEqual([{ id: 1 }]);
    expect(await (await api("/api/settings")).json()).toEqual({ id: 1, srsRetention: 0.9, srsFuzz: 1, srsNewPerDay: 33, srsMaxReviewsPerDay: 200 });
    expect((await (await api(`/api/mcqs/${encodeURIComponent(editedId)}`)).json()).reason).toBe("Kept across the round-trip.");
    const s = await (await api(`/api/mcqs/srs/queue-stats?topics=${TOPIC}`)).json();
    expect(s.limits.extraNewToday).toBe(2);
    expect(s.limits.newRemaining).toBe(33 + 2 - 1);
    // And it exports again identically (bar the timestamp).
    const again = await (await api("/api/export")).json();
    expect(again.tables).toEqual(dump.tables);
  });

  it("an empty settings table in the dump re-seeds the defaults at id 1", async () => {
    const res = await post("/api/import?confirm=YES", { version: 1, app: "mcq-site", tables: { settings: [] } });
    expect(res.status).toBe(200);
    expect((await res.json()).restored).toEqual({ settings: 1 });
    expect(await (await api("/api/settings")).json()).toEqual({ id: 1, srsRetention: 0.9, srsFuzz: 1, srsNewPerDay: 20, srsMaxReviewsPerDay: 200 });
  });
});

// ---------------------------------------------------------------------------
describe("the production catch-all (server/static.ts)", () => {
  it("answers an unknown /api path with a JSON 404, never the HTML shell", async () => {
    const res = await api("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such API endpoint: GET /api/nope" });
    const nested = await post("/api/mcqs/srs/nope", {});
    expect(nested.status).toBe(404);
    expect((await nested.json()).error).toMatch(/no such API endpoint: POST/);
  });

  it("serves the shell for an app route and 404s a missing file", async () => {
    const shell = await api("/settings");
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("MCQ Study shell");
    const missing = await api("/assets/app-does-not-exist.js");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("<!doctype html");
  });
});
