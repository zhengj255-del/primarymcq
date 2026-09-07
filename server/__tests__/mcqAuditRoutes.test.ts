import "./testDb";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";

// ---------------------------------------------------------------------------
// The AI routes, over HTTP, with the gate OPEN (APP_PASSWORD unset). What is
// pinned here is the CONTRACT the two pages rely on — not the model, which is
// a canned adjudicator:
//   - every route that can reach the model refuses with a 503 until a key is
//     set, and the status endpoint says so;
//   - the literal /api/mcqs/audit/... and /api/mcqs/triage/... paths answer
//     before the /api/mcqs/:id wildcard can swallow them;
//   - triage-suggest validates its effort token, passes mode + effort through,
//     and returns the verdict without writing anything;
//   - a sweep kicked over HTTP drains the topic, the row actions and bulk
//     approve behave as their buttons promise, and the verdict ledger rides
//     along in the backup;
//   - a second run, bulk approve and resolve-all are all refused with a 409
//     while a sweep is writing verdicts, and Stop is honoured.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  calls: [] as Array<{ code: string; mode?: string; effort?: string }>,
}));
vi.mock("../ai/mcqTriage", () => ({
  triageMcq: vi.fn(async (input: {
    code: string; currentAnswer: string | null; mode?: string; effort?: string;
    options: Array<{ key: string; text: string }>;
  }) => {
    state.calls.push({ code: input.code, mode: input.mode, effort: input.effort });
    if (state.gate) await state.gate;
    // A key that differs from the stored one AND has option text, so the
    // apply path's keyed-option guard is satisfied.
    const other = input.options.find((o) => o.key !== input.currentAnswer && o.text.trim())?.key ?? "A";
    return {
      verdict: "change_answer", suggestedAnswer: other, confidence: "high",
      correctedReason: `routes ${input.code}`, disputeNote: "via http", clearsDispute: true,
      suggestedStem: null, suggestedOptions: null, model: "stub-model", reasoningEffort: input.effort ?? null,
    };
  }),
}));

import { sqlite } from "../storage";
import { registerRoutes } from "../routes";
import { installAuth } from "../auth";
import { installBodyParsers, safeErrorFields } from "../bodyParsers";

const TOPIC = "gastrointestinal";
const TOPIC_SIZE = 29;

let server: Server;
let baseUrl: string;

const api = (p: string, init?: RequestInit) => fetch(`${baseUrl}${p}`, init);
const post = (p: string, body?: unknown) =>
  api(p, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const patch = (p: string, body: unknown) =>
  api(p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function status(topic?: string): Promise<any> {
  return (await api(`/api/mcqs/audit/status${topic ? `?topic=${topic}` : ""}`)).json();
}
async function untilIdle(topic?: string): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const s = await status(topic);
    if (!s.running) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("sweep never finished");
}

beforeAll(async () => {
  delete process.env.APP_PASSWORD;   // the gate must be OPEN for this file
  delete process.env.OPENAI_API_KEY; // start without the key
  delete process.env.MCQ_AI_MODEL;
  const app = express();
  installAuth(app);
  installBodyParsers(app);
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const { status: st, message } = safeErrorFields(err);
    if (res.headersSent) return next(err);
    res.status(st).json({ message });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  server = httpServer;
});
afterAll(() => { server?.close(); });

describe("without a key", () => {
  it("the status endpoint is reachable (not swallowed as an id) and reports the AI off", async () => {
    const res = await api("/api/mcqs/audit/status");
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.keyPresent).toBe(false);
    expect(s.model).toBe("gpt-5.6-sol");
    expect(s.running).toBe(false);
    expect(s.total).toBeGreaterThan(1000);
    expect(s.pending).toBe(s.total); // nothing audited yet
    expect(s.counts).toEqual({ poor: 0, weak: 0, good: 0, handled: 0, applicable: 0 });
  });

  it("the verdict list is reachable and empty", async () => {
    const res = await api("/api/mcqs/audit?band=poor");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], total: 0 });
  });

  it("every route that reaches the model refuses with a 503 naming the key", async () => {
    const id = (sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = ? LIMIT 1").get(TOPIC) as { id: string }).id;
    for (const p of ["/api/mcqs/audit/run", "/api/mcqs/triage/adjudicate", `/api/mcqs/${encodeURIComponent(id)}/triage-suggest`]) {
      const res = await post(p, {});
      expect(res.status, p).toBe(503);
      expect((await res.json()).error).toMatch(/OPENAI_API_KEY/);
    }
    expect(state.calls).toHaveLength(0);
  });

  it("the Disputes payload carries an (empty) adjudications map", async () => {
    const t = await (await api("/api/mcqs/triage")).json();
    expect(t).toHaveProperty("counts");
    expect(t).toHaveProperty("items");
    expect(t.adjudications).toEqual({});
  });
});

describe("with a key: one suggestion", () => {
  let id: string;
  beforeAll(() => {
    process.env.OPENAI_API_KEY = "test-key";
    id = (sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL ORDER BY id LIMIT 1").get(TOPIC) as { id: string }).id;
  });

  it("404s an unknown id and 400s an unknown effort token", async () => {
    expect((await post("/api/mcqs/nope__X1/triage-suggest")).status).toBe(404);
    const bad = await post(`/api/mcqs/${encodeURIComponent(id)}/triage-suggest?effort=turbo`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/expected one of/);
    expect(state.calls).toHaveLength(0);
  });

  it("passes mode and effort through, returns the verdict, and writes nothing", async () => {
    const before = await (await api(`/api/mcqs/${encodeURIComponent(id)}`)).json();
    const res = await post(`/api/mcqs/${encodeURIComponent(id)}/triage-suggest?mode=audit&effort=max`);
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.verdict).toBe("change_answer");
    expect(s.suggestedAnswer).not.toBe(before.answer);
    expect(s.reasoningEffort).toBe("max");
    expect(state.calls.at(-1)).toMatchObject({ mode: "audit", effort: "max" });
    // The default call uses the dispute framing and no effort.
    await post(`/api/mcqs/${encodeURIComponent(id)}/triage-suggest`);
    expect(state.calls.at(-1)).toMatchObject({ mode: "dispute", effort: undefined });
    // Nothing moved: no override, no verdict row.
    const after = await (await api(`/api/mcqs/${encodeURIComponent(id)}`)).json();
    expect(after).toEqual(before);
    expect((await status(TOPIC)).pending).toBe(TOPIC_SIZE);
  });
});

describe("with a key: a topic sweep over HTTP", () => {
  let poor: any[];
  let disputedId: string;

  it("run kicks the sweep and status drains to zero pending", async () => {
    state.calls.length = 0;
    const res = await post("/api/mcqs/audit/run", { topic: TOPIC });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kicked: true });
    const s = await untilIdle(TOPIC);
    expect(s.pending).toBe(0);
    expect(s.total).toBe(TOPIC_SIZE);
    expect(s.counts).toMatchObject({ poor: TOPIC_SIZE, weak: 0, good: 0, handled: 0, applicable: TOPIC_SIZE });
    expect(s.progress).toMatchObject({ running: false, done: TOPIC_SIZE, total: TOPIC_SIZE });
    expect(state.calls).toHaveLength(TOPIC_SIZE);
    // Every one an audit-framed call: nothing in this topic is disputed.
    for (const c of state.calls) expect(c.mode).toBe("audit");
  });

  it("lists the band with the row flags the buttons key off", async () => {
    const list = await (await api(`/api/mcqs/audit?band=poor&topic=${TOPIC}&limit=5`)).json();
    expect(list.total).toBe(TOPIC_SIZE);
    expect(list.items).toHaveLength(5);
    for (const it of list.items) {
      expect(it.applicable).toBe(true);
      expect(it.stale).toBe(false);
      expect(it.audit.status).toBe("suggested");
      expect(it.audit.verdict).toBe("change_answer");
      expect(it.mcq.topicSlug).toBe(TOPIC);
    }
    poor = list.items;
  });

  it("apply / dismiss / reopen / mark-fixed per row, with honest refusals", async () => {
    const [a, b, c] = poor;
    // Apply: the key moves, the row is handled, a second apply is a 409.
    const applied = await post(`/api/mcqs/${encodeURIComponent(a.mcq.id)}/audit-apply`);
    expect(applied.status).toBe(200);
    const body = await applied.json();
    expect(body.mcq.answer).toBe(a.audit.suggestedAnswer);
    expect(body.mcq.reason).toBe(a.audit.correctedReason);
    expect(body.audit.status).toBe("applied");
    expect((await post(`/api/mcqs/${encodeURIComponent(a.mcq.id)}/audit-apply`)).status).toBe(409);
    // Dismiss then reopen: no content moves.
    const dismissed = await (await post(`/api/mcqs/${encodeURIComponent(b.mcq.id)}/audit-dismiss`)).json();
    expect(dismissed.audit.status).toBe("dismissed");
    const reopened = await (await post(`/api/mcqs/${encodeURIComponent(b.mcq.id)}/audit-reopen`)).json();
    expect(reopened.audit.status).toBe("suggested");
    expect((await (await api(`/api/mcqs/${encodeURIComponent(b.mcq.id)}`)).json()).answer).toBe(b.mcq.answer);
    // Mark fixed (the dialog's save path): handled, re-hashed, not re-pending.
    const fixed = await (await post(`/api/mcqs/${encodeURIComponent(c.mcq.id)}/audit-mark-fixed`)).json();
    expect(fixed.audit.status).toBe("applied");
    // Unknown ids are 404s on every action.
    for (const action of ["audit-apply", "audit-dismiss", "audit-reopen", "audit-mark-fixed"]) {
      expect((await post(`/api/mcqs/nope__X1/${action}`)).status, action).toBe(404);
    }
    const s = await status(TOPIC);
    expect(s.counts).toMatchObject({ handled: 2, poor: TOPIC_SIZE - 2, applicable: TOPIC_SIZE - 2 });
    expect(s.pending).toBe(0);
  });

  it("a hand edit re-pends its question and stales its verdict on the wire", async () => {
    const d = poor[3];
    expect((await patch(`/api/mcqs/${encodeURIComponent(d.mcq.id)}`, { stem: "Hand-edited over HTTP." })).status).toBe(200);
    const s = await status(TOPIC);
    expect(s.pending).toBe(1);
    expect(s.counts.poor).toBe(TOPIC_SIZE - 3); // the stale row leaves the band
    const refused = await post(`/api/mcqs/${encodeURIComponent(d.mcq.id)}/audit-apply`);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/content changed/i);
    const list = await (await api(`/api/mcqs/audit?band=poor&topic=${TOPIC}&limit=200`)).json();
    expect(list.items.some((i: any) => i.mcq.id === d.mcq.id)).toBe(false);
  });

  it("the Disputes payload badges a disputed row's verdict, and resolve-all acts on it", async () => {
    disputedId = poor[4].mcq.id;
    // Raising the dispute is not a content change, so the verdict stays fresh.
    expect((await patch(`/api/mcqs/${encodeURIComponent(disputedId)}`, { disputed: true })).status).toBe(200);
    const t = await (await api("/api/mcqs/triage")).json();
    expect(t.adjudications[disputedId]).toMatchObject({ verdict: "change_answer", applicable: true, stale: false });
    expect(t.items.find((i: any) => i.id === disputedId).triageStatus).toBe("pending");
    const r = await (await post("/api/mcqs/triage/resolve-all", { topic: TOPIC })).json();
    expect(r).toMatchObject({ accepted: 0, fixed: 1, left: 0, unadjudicated: 0, failed: [] });
    const after = await (await api(`/api/mcqs/${encodeURIComponent(disputedId)}`)).json();
    expect(after.disputed).toBe(false);
    expect(after.answer).toBe(poor[4].audit.suggestedAnswer);
    expect((await (await api("/api/mcqs/triage")).json()).items.find((i: any) => i.id === disputedId).triageStatus).toBe("fixed");
  });

  it("apply-all applies exactly the applicable pile and the status agrees", async () => {
    const before = await status(TOPIC);
    const r = await (await post("/api/mcqs/audit/apply-all", { topic: TOPIC })).json();
    expect(r.applied).toBe(before.counts.applicable);
    expect(r.failed).toEqual([]);
    const after = await status(TOPIC);
    expect(after.counts.applicable).toBe(0);
    expect(after.counts.poor).toBe(0);
    // handled = applied (1) + mark-fixed (1) + resolve-all's fix (1) + apply-all's; the
    // hand-edited row is pending, not handled.
    expect(after.counts.handled).toBe(TOPIC_SIZE - 1);
    expect(after.pending).toBe(1);
  });

  it("the backup carries the verdict ledger", async () => {
    const dump = await (await api("/api/export")).json();
    expect(Array.isArray(dump.tables.mcq_audit)).toBe(true);
    expect(dump.tables.mcq_audit.length).toBeGreaterThanOrEqual(TOPIC_SIZE);
    const row = dump.tables.mcq_audit.find((r: any) => r.mcq_id === disputedId);
    expect(row).toMatchObject({ verdict: "change_answer", status: "applied", model: "stub-model" });
  });
});

describe("with a key: interlocks while a sweep runs", () => {
  it("a second run, bulk approve and resolve-all are refused; Stop is honoured", async () => {
    let release!: () => void;
    state.gate = new Promise<void>((r) => { release = r; });
    try {
      // statistics: 4 questions, none audited yet.
      expect((await post("/api/mcqs/audit/run", { topic: "statistics" })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect((await status("statistics")).running).toBe(true);
      expect((await post("/api/mcqs/audit/run", { topic: "statistics" })).status).toBe(409);
      expect((await post("/api/mcqs/triage/adjudicate", {})).status).toBe(409);
      expect((await post("/api/mcqs/audit/apply-all", {})).status).toBe(409);
      expect((await post("/api/mcqs/triage/resolve-all", {})).status).toBe(409);
      expect(await (await post("/api/mcqs/audit/stop")).json()).toEqual({ stopping: true });
    } finally {
      release();
      state.gate = null;
    }
    const s = await untilIdle("statistics");
    // The batch in flight (3 of 4) completed; Stop stopped the next one.
    expect(s.pending).toBe(1);
    expect(s.counts.poor).toBe(3);
    // Stop on an idle server is a no-op that says so.
    expect(await (await post("/api/mcqs/audit/stop")).json()).toEqual({ stopping: false });
  });
});
