import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { storage, sqlite } from "./storage";
import { buildId } from "./buildId";
import {
  listMcqs, getMcq, getMcqsByLo, getMcqStats,
  updateMcqOverride, revertMcqOverride, listDisputeTriage, resolveMcqDispute,
} from "./mcqs";
import {
  startSession as startMcqStudySession,
  submitAttempt as submitMcqAttempt,
  rateSrsAttempt,
  finishSession as finishMcqStudySession,
  getSessionSummary as getMcqSessionSummary,
  getUserStats as getMcqUserStats,
  getSrsDue as getMcqSrsDue,
  getSrsQueueStats as getMcqSrsQueueStats,
  addSrsExtraNew,
  clearSrsExtraNew,
  SRS_EXTRA_NEW_DAILY_CAP,
  undoLastSrsRating,
  getWeakAreas as getMcqWeakAreas,
  resetMcqProgress,
} from "./mcqStudy";
import {
  settingsPatchSchema, sessionFiltersSchema, submitAttemptSchema, srsRateSchema,
  mcqEditSchema, mcqTriageSchema,
} from "@shared/schema";
// The AI quality machinery: the adjudicator, the corpus sweep built on it, and
// the bulk lane the Disputes page borrows from the sweep. Every route below
// that reaches the model 503s cleanly when OPENAI_API_KEY is unset.
import {
  mcqAuditStatus, listMcqAudit, kickAudit, requestAuditStop, isAuditing,
  applyMcqAudit, applyAllMcqAudit, dismissMcqAudit, reopenMcqAudit, markMcqAuditFixed, type McqAuditBand,
  resolveAllDisputes, disputeAdjudications,
} from "./mcqAudit";
import { triageMcq } from "./ai/mcqTriage";
import { hasApiKey, REASONING_EFFORTS, type ReasoningEffort } from "./ai/llm";

// -----------------------------------------------------------------------------
// The tables a backup carries, in ONE place.
//
// GET /api/export writes exactly these and POST /api/import loads exactly
// these, so the two cannot drift: a table that quietly stops being backed up
// is a bug nobody finds until a restore. Everything here is the OWNER'S data —
// their settings, their edits to the corpus, their attempts and schedules.
// The corpus itself (mcqs, mcq_lo_links, mcq_meta) is rebuilt from
// server/data/mcqs.json on every boot and is deliberately not a backup's job.
// -----------------------------------------------------------------------------
export const EXPORT_TABLES = [
  "settings",
  "mcq_overrides",
  "mcq_attempts",
  "mcq_srs_state",
  "mcq_srs_undo",
  "mcq_srs_extra_new",
  "mcq_study_sessions",
  // The AI sweep's verdicts (server/mcqAudit.ts). Hours of model calls and
  // the owner's apply/dismiss decisions — the fixes themselves already live in
  // mcq_overrides above, but losing the verdict ledger on a restore would mean
  // re-auditing the whole bank to find out which rows were handled.
  "mcq_audit",
] as const;

/** The tag every export carries and every import checks — a dump from any
 *  other app (the tracker's, say) is refused before a single row moves. */
export const EXPORT_APP = "mcq-site";

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // -----------------------------------------------------------------------------------------------
  // Health check — touches SQLite so a DB-load failure (e.g. better-sqlite3
  // ABI mismatch after a rebuild) surfaces immediately instead of a half-dead
  // port-open state. Mounted under /api/ and exempted from the auth gate
  // (server/auth.ts) so the Fly health check can reach it.
  // -----------------------------------------------------------------------------------------------
  // Current client build id — polled by the app so a long-lived tab (or a Home
  // Screen web app, which has no reload button) can offer a one-tap update
  // instead of silently running an old bundle.
  app.get("/api/build", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ buildId: buildId() });
  });

  app.get("/api/healthz", (_req, res) => {
    try {
      const row = sqlite.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
      if (!row || row.ok !== 1) throw new Error("sqlite probe returned unexpected shape");
      res.json({ ok: true, db: "ok", serverTime: Date.now() });
    } catch (err: any) {
      // The stack goes to the log for the operator; the caller is anonymous
      // (this route is exempt from the gate), so it gets a fixed body — a
      // SQLite message can name the database path or the native module.
      console.error("[healthz] db probe failed:", err?.stack || err);
      res.status(503).json({ ok: false, db: "error" });
    }
  });

  // ----- Settings -----
  app.get("/api/settings", (_req, res) => {
    res.json(storage.getSettings());
  });

  app.patch("/api/settings", (req, res) => {
    // See settingsPatchSchema (shared/schema.ts) for what each rule is.
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      // A SINGLE STRING, not zod's flattened object: apiErrorText in
      // client/src/lib/queryClient.ts unwraps `error` when it is a string and
      // otherwise renders "[object Object]" — so a bounded PATCH that reported
      // a shape would refuse the owner's edit and tell them nothing about why.
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid settings" });
    }
    res.json(storage.updateSettings(parsed.data));
  });

  // -----------------------------------------------------------------------------------------------
  // MCQs — Kerry Brandis "Black Bank" corpus
  // -----------------------------------------------------------------------------------------------
  app.get("/api/mcqs", (req, res) => {
    const parse = (name: string) => (typeof req.query[name] === "string" ? String(req.query[name]) : undefined);
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const disputedRaw = parse("disputed");
    const completedRaw = parse("completed");
    const result = listMcqs({
      topic: parse("topic"),
      domain: parse("domain"),
      paper: parse("paper"),
      q: parse("q"),
      disputed: disputedRaw === "true" ? true : disputedRaw === "false" ? false : undefined,
      completed: completedRaw === "true" ? true : completedRaw === "false" ? false : undefined,
      unmastered: parse("unmastered") === "true" ? true : undefined,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    res.json(result);
  });

  app.get("/api/mcqs/stats", (_req, res) => {
    res.json(getMcqStats());
  });

  app.get("/api/mcqs/by-lo/:code", (req, res) => {
    // LO codes contain spaces (e.g. "BTGS 1.7") — route with URL encoding, decode here.
    const code = decodeURIComponent(req.params.code);
    res.json({ code, items: getMcqsByLo(code) });
  });

  // -----------------------------------------------------------------------------------------------
  // MCQ study — test / tutor / SRS sessions, attempt logging, aggregate stats.
  // MUST be registered BEFORE the wildcard /api/mcqs/:id detail route so paths
  // like /api/mcqs/user-stats and /api/mcqs/session/:id/summary don't get
  // swallowed as an id lookup.
  // -----------------------------------------------------------------------------------------------
  app.post("/api/mcqs/session", (req, res) => {
    const parsed = sessionFiltersSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const result = startMcqStudySession(parsed.data);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to start session" });
    }
  });

  app.post("/api/mcqs/attempt", (req, res) => {
    const parsed = submitAttemptSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const result = submitMcqAttempt(parsed.data);
      res.json(result);
    } catch (err) {
      // Distinguish a bad request (unknown session/mcq) from a server-side
      // failure — every throw used to come back 400 as if the client erred.
      const msg = err instanceof Error ? err.message : "failed to log attempt";
      if (/not found|unknown/i.test(msg)) return res.status(400).json({ error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // SRS rating — advances the schedule exactly once for a question already
  // logged via /api/mcqs/attempt. Kept separate so revealing the answer and
  // rating it don't double-record the attempt or double-advance the interval.
  app.post("/api/mcqs/srs/rate", (req, res) => {
    const parsed = srsRateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const srs = rateSrsAttempt(parsed.data);
      res.json({ srs });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "failed to rate attempt" });
    }
  });

  app.post("/api/mcqs/session/:id/finish", (req, res) => {
    try {
      const summary = finishMcqStudySession(req.params.id);
      res.json(summary);
    } catch (err) {
      // Only a genuinely unknown session is a 404 — a storage failure
      // mislabelled as "session not found" told the user their sitting
      // vanished when the server had hiccuped.
      const msg = err instanceof Error ? err.message : "failed to finish session";
      if (/not found|unknown session/i.test(msg)) return res.status(404).json({ error: msg });
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/mcqs/session/:id/summary", (req, res) => {
    try {
      const summary = getMcqSessionSummary(req.params.id);
      res.json(summary);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : "session not found" });
    }
  });

  // Wipes ALL MCQ study progress (attempts, SRS state, sessions) ONLY.
  // Does NOT touch the corpus or the owner's edits to it. The app-wide session
  // gate (server/auth.ts) is the auth; the explicit ?confirm=YES is what
  // prevents accidents.
  app.post("/api/mcqs/reset", (req, res) => {
    if (req.query.confirm !== "YES") {
      return res.status(400).json({ error: "pass ?confirm=YES to wipe MCQ study progress" });
    }
    const result = resetMcqProgress();
    res.json({ ok: true, ...result });
  });

  app.get("/api/mcqs/user-stats", (_req, res) => {
    res.json(getMcqUserStats());
  });

  app.get("/api/mcqs/srs/due", (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ items: getMcqSrsDue(Number.isFinite(limit) ? limit : 50) });
  });

  // Undo the most recent SRS rating — the misclick net. Restores the exact
  // pre-rating scheduler state (FSRS has no inverse) and un-stamps the
  // attempt, handing back the daily-review slot it spent.
  app.post("/api/mcqs/srs/undo", (_req, res) => {
    const undone = undoLastSrsRating();
    if (!undone) return res.status(404).json({ error: "nothing to undo" });
    res.json(undone);
  });

  // "Study more new today" — grant extra new-card slots for the current
  // Melbourne day on top of srs_new_per_day, from the SRS setup panel
  // (Anki-style custom study) instead of editing the standing limit in
  // Settings. Adds to any earlier grant; expires at midnight.
  app.post("/api/mcqs/srs/extra-new", (req, res) => {
    const count = Number(req.body?.count);
    if (!Number.isInteger(count) || count < 1 || count > SRS_EXTRA_NEW_DAILY_CAP) {
      return res.status(400).json({ error: `count must be an integer between 1 and ${SRS_EXTRA_NEW_DAILY_CAP}` });
    }
    res.json(addSrsExtraNew(count));
  });

  // Withdraw today's boost (the misclick path — otherwise it stands until
  // midnight). Questions already introduced under it keep their schedules.
  app.delete("/api/mcqs/srs/extra-new", (_req, res) => {
    res.json(clearSrsExtraNew());
  });

  // The Anki-style setup numbers for an SRS sitting (learning / due / new)
  // under the given scope — what "Study" will actually serve, after daily
  // limits. Scope params mirror session filters: comma-separated lists.
  app.get("/api/mcqs/srs/queue-stats", (req, res) => {
    const list = (v: unknown): string[] | undefined => {
      const s = typeof v === "string" ? v.trim() : "";
      if (!s) return undefined;
      const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
      return parts.length > 0 ? parts : undefined;
    };
    res.json(getMcqSrsQueueStats({
      mode: "srs",
      topics: list(req.query.topics),
      domains: list(req.query.domains),
      loCodes: list(req.query.loCodes),
      // ALWAYS true — the `excludeDisputed` query parameter is deliberately
      // not read. Disputed questions are excluded from the SRS queue by one
      // rule, stated once in SRS_SITTABLE_SQL (server/mcqSittable.ts), and
      // every "SRS due N" the app shows inherits it unconditionally. This
      // endpoint describes THAT queue, so it cannot be allowed a second
      // opinion: while it parsed the flag and defaulted it to FALSE, a caller
      // that simply omitted the parameter got a setup strip promising reviews
      // no count agreed with and no sitting would serve.
      // The escape (D2): should a "study disputed questions anyway" pool ever
      // exist, SRS_SITTABLE_SQL becomes a function of that flag FIRST and this
      // route takes the same flag in the same commit — the count and the queue
      // move together or they drift again.
      excludeDisputed: true,
      // Mirror the sitting's no-new toggle so the panel's numbers are the
      // numbers Study will actually serve.
      srsSkipNew: req.query.skipNew === "1" || req.query.skipNew === "true",
      count: 0,
    }));
  });

  app.get("/api/mcqs/weak-areas", (_req, res) => {
    res.json({ items: getMcqWeakAreas() });
  });

  // ----- Dispute triage -----
  // Every base-disputed MCQ with its triage status + counts. Registered
  // before /api/mcqs/:id so "triage" isn't swallowed as an id.
  app.get("/api/mcqs/triage", (_req, res) => {
    // adjudications: fresh stored verdicts for the disputed pile, so the page
    // can badge each pending row and put an honest number on Resolve all —
    // computed by the SAME predicates resolveAllDisputes acts with.
    res.json({ ...listDisputeTriage(), adjudications: disputeAdjudications() });
  });

  // Adjudicate the pending disputes with the shared examiner pipeline — the
  // audit sweep scoped to disputed questions only (each is prompted with the
  // DISPUTE framing, which is literally true for them). Verdicts land in
  // mcq_audit like any sweep's; progress is the same /api/mcqs/audit/status.
  app.post("/api/mcqs/triage/adjudicate", (req, res) => {
    if (!hasApiKey()) return res.status(503).json({ error: "AI not configured (OPENAI_API_KEY missing)" });
    const topic = typeof req.body?.topic === "string" && req.body.topic ? req.body.topic : undefined;
    if (!kickAudit({ topic, disputedOnly: true })) return res.status(409).json({ error: "An audit run is already in progress" });
    res.json({ kicked: true });
  });

  // Bulk-resolve adjudicated disputes: accept confirm_key (flag cleared,
  // content untouched), apply change_answer through the one apply path,
  // leave ambiguous/flawed for the human. Refused while a sweep is writing
  // verdicts, same as bulk approve.
  app.post("/api/mcqs/triage/resolve-all", (req, res) => {
    if (isAuditing()) return res.status(409).json({ error: "An audit run is in progress — resolve once it finishes." });
    const topic = typeof req.body?.topic === "string" && req.body.topic ? req.body.topic : undefined;
    res.json(resolveAllDisputes({ topic }));
  });

  // One triage decision: accept (dispute is noise, content stands), fix
  // (apply edits + clear dispute), discard (exclude from study pools/SRS),
  // reopen (undo the verdict; keeps any content edits).
  app.post("/api/mcqs/:id/triage", (req, res) => {
    const parsed = mcqTriageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const result = resolveMcqDispute(
      decodeURIComponent(req.params.id),
      parsed.data.action,
      parsed.data.edit,
    );
    if (!result) return res.status(404).json({ error: "MCQ not found" });
    res.json(result);
  });

  // AI adjudication for one MCQ. Read-only: the reasoning model independently
  // works the question and returns a suggested verdict/answer/explanation. It
  // writes NOTHING — the user reviews it in the edit dialog and saves through
  // PATCH /api/mcqs/:id. 503s cleanly without a key.
  app.post("/api/mcqs/:id/triage-suggest", async (req, res) => {
    if (!hasApiKey()) return res.status(503).json({ error: "AI not configured (OPENAI_API_KEY missing)" });
    const item = getMcq(decodeURIComponent(req.params.id));
    if (!item) return res.status(404).json({ error: "MCQ not found" });
    // ?mode=audit when the caller is the Quality page. The default dispute
    // framing opens with "someone believes the keyed answer is wrong", which
    // primes the model to hunt for a change — the exact bias AUDIT_SYSTEM was
    // written to remove. Asking for a second opinion on a question nobody
    // disputed must not silently use the adversarial prompt.
    const mode = req.query.mode === "audit" ? "audit" as const : "dispute" as const;
    // ?effort=max — the "suggest with max effort" option: same adjudication,
    // top reasoning rung. An unknown token is a 400, not a silent default: a
    // typo'd client would otherwise read a cheap verdict as a max-effort one.
    let effort: ReasoningEffort | undefined;
    if (typeof req.query.effort === "string" && req.query.effort) {
      if (!(REASONING_EFFORTS as readonly string[]).includes(req.query.effort)) {
        return res.status(400).json({ error: `Unknown effort "${req.query.effort}" — expected one of ${REASONING_EFFORTS.join(", ")}` });
      }
      effort = req.query.effort as ReasoningEffort;
    }
    try {
      const suggestion = await triageMcq({
        mode,
        effort,
        code: item.displayCode,
        topicName: item.topicName,
        domain: item.domain,
        stem: item.stem,
        options: Object.entries(item.options).map(([key, text]) => ({ key, text: String(text) })),
        currentAnswer: item.answer ?? null,
        currentReason: item.reason ?? "",
        loCodes: item.loCodes,
      });
      res.json(suggestion);
    } catch (e: any) {
      res.status(502).json({ error: `AI suggestion failed: ${e?.message || e}` });
    }
  });

  // ----- Corpus audit (Quality page) -----
  // Kick an AI sweep over every non-discarded question, poll status, review
  // verdicts by band, apply or dismiss each suggestion. Registered before
  // /api/mcqs/:id so "audit" isn't swallowed as an id.
  app.get("/api/mcqs/audit/status", (req, res) => {
    const topic = typeof req.query.topic === "string" && req.query.topic ? req.query.topic : undefined;
    res.json(mcqAuditStatus(topic));
  });
  app.get("/api/mcqs/audit", (req, res) => {
    const topic = typeof req.query.topic === "string" && req.query.topic ? req.query.topic : undefined;
    const band = typeof req.query.band === "string" && ["poor", "weak", "good", "handled"].includes(req.query.band)
      ? (req.query.band as McqAuditBand)
      : undefined;
    const limit = Number(req.query.limit);
    res.json(listMcqAudit({ band, topic, limit: Number.isFinite(limit) ? limit : undefined }));
  });
  app.post("/api/mcqs/audit/run", (req, res) => {
    if (!hasApiKey()) return res.status(503).json({ error: "AI not configured (OPENAI_API_KEY missing)" });
    const topic = typeof req.body?.topic === "string" && req.body.topic ? req.body.topic : undefined;
    if (!kickAudit({ topic })) return res.status(409).json({ error: "An audit run is already in progress" });
    res.json({ kicked: true });
  });
  app.post("/api/mcqs/audit/stop", (_req, res) => {
    res.json({ stopping: requestAuditStop() });
  });
  // Bulk approve — apply every applicable suggestion in scope in one action.
  // Refused while a sweep is writing verdicts, so the pile being approved
  // can't change mid-approval.
  app.post("/api/mcqs/audit/apply-all", (req, res) => {
    if (isAuditing()) return res.status(409).json({ error: "An audit run is in progress — approve once it finishes." });
    const topic = typeof req.body?.topic === "string" && req.body.topic ? req.body.topic : undefined;
    res.json(applyAllMcqAudit({ topic }));
  });
  app.post("/api/mcqs/:id/audit-apply", (req, res) => {
    const result = applyMcqAudit(decodeURIComponent(req.params.id));
    if ("error" in result) return res.status(result.status).json({ error: result.error });
    res.json(result);
  });
  app.post("/api/mcqs/:id/audit-mark-fixed", (req, res) => {
    const row = markMcqAuditFixed(decodeURIComponent(req.params.id));
    if (!row) return res.status(404).json({ error: "No audit verdict for this MCQ" });
    res.json({ audit: row });
  });
  app.post("/api/mcqs/:id/audit-dismiss", (req, res) => {
    const row = dismissMcqAudit(decodeURIComponent(req.params.id));
    if (!row) return res.status(404).json({ error: "No audit verdict for this MCQ" });
    res.json({ audit: row });
  });
  app.post("/api/mcqs/:id/audit-reopen", (req, res) => {
    const row = reopenMcqAudit(decodeURIComponent(req.params.id));
    if (!row) return res.status(404).json({ error: "No audit verdict for this MCQ" });
    res.json({ audit: row });
  });

  // Detail route uses the topicSlug__code id form. Match anything (including slashes
  // encoded to %2F if any) via wildcard. Registered AFTER the /api/mcqs/... study
  // routes above so they get first pick.
  app.get("/api/mcqs/:id", (req, res) => {
    const item = getMcq(decodeURIComponent(req.params.id));
    if (!item) return res.status(404).json({ error: "MCQ not found" });
    res.json(item);
  });

  // Edit an MCQ. Stored as an override so corpus re-ingest doesn't wipe user edits.
  app.patch("/api/mcqs/:id", (req, res) => {
    const parsed = mcqEditSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const updated = updateMcqOverride(decodeURIComponent(req.params.id), parsed.data);
    if (!updated) return res.status(404).json({ error: "MCQ not found" });
    res.json(updated);
  });

  // Revert an MCQ back to the base corpus value.
  app.delete("/api/mcqs/:id/override", (req, res) => {
    const reverted = revertMcqOverride(decodeURIComponent(req.params.id));
    if (!reverted) return res.status(404).json({ error: "MCQ not found" });
    res.json(reverted);
  });

  // -----------------------------------------------------------------------------------------------
  // Backup — a logical dump of the owner's data, and its restore.
  //
  // Small by construction: no media, no corpus, no blobs — a handful of text
  // tables that fit comfortably in one JSON document, so the export is built
  // and sent as one object (no streaming needed) and the import parses it as
  // one body. Both sit behind the app-wide session gate like every other
  // route; the import additionally demands ?confirm=YES because it is
  // destructive.
  // -----------------------------------------------------------------------------------------------

  /** The live tables' names, so an export never names a table that does not
   *  exist (a boot that failed half-way) and an import never writes into one. */
  const liveTableNames = (): Set<string> =>
    new Set(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map((r) => r.name),
    );

  app.get("/api/export", (_req: Request, res: Response) => {
    try {
      const live = liveTableNames();
      // Every SELECT inside ONE transaction, so the tables describe the same
      // instant: without it each statement takes its own snapshot and an
      // attempt logged mid-export could appear in mcq_attempts but not yet in
      // mcq_srs_state. Reads only; better-sqlite3 commits a no-op.
      const tables = sqlite.transaction(() => {
        const out: Record<string, Array<Record<string, unknown>>> = {};
        for (const t of EXPORT_TABLES) {
          if (!live.has(t)) continue;
          out[t] = sqlite.prepare(`SELECT * FROM "${t}"`).all() as Array<Record<string, unknown>>;
        }
        return out;
      })();
      const now = new Date();
      const filename = `mcq-backup-${now.toISOString().slice(0, 10)}.json`;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "no-store");
      res.json({ version: 1, exportedAt: now.toISOString(), app: EXPORT_APP, tables });
    } catch (err: any) {
      console.error("[api/export] failed:", err?.stack || err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // What a body has to look like to be a backup OF THIS APP. `version` and
  // `app` are literals on purpose: the tracker's dump has the same outer shape
  // (a `tables` map of row arrays) and sixty tables this schema has never heard
  // of; refusing it by tag is cheaper and clearer than refusing it by table.
  const importSchema = z.object({
    version: z.literal(1),
    app: z.literal(EXPORT_APP),
    exportedAt: z.string().optional(),
    tables: z.record(z.array(z.record(z.unknown()))),
  });

  // Bindable value coercion — export rows are already primitives, but guard
  // against booleans / stray objects so a hand-edited dump fails loudly, not
  // silently.
  const bindable = (v: unknown): string | number | bigint | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
    return JSON.stringify(v); // arrays/objects → JSON text (defensive)
  };

  app.post("/api/import", (req: Request, res: Response) => {
    if (req.query.confirm !== "YES") {
      return res.status(400).json({ error: "pass ?confirm=YES to overwrite the database from this backup" });
    }
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      // A string, for the same reason PATCH /api/settings gives one: the
      // client shows `error` verbatim, and the owner reading it mid-restore
      // needs to know it was the wrong file, not "[object Object]".
      const issue = parsed.error.issues[0];
      const where = issue?.path?.length ? issue.path.join(".") : "body";
      return res.status(400).json({
        error: `this is not an MCQ Study backup (${where}: ${issue?.message ?? "invalid"})`,
      });
    }
    const { tables } = parsed.data;

    // Only the tables an export writes may come back in. Anything else in the
    // document is either another app's data or a hand edit, and neither has a
    // home here.
    const known = new Set<string>(EXPORT_TABLES);
    const unknown = Object.keys(tables).filter((t) => !known.has(t));
    if (unknown.length > 0) {
      return res.status(400).json({
        error: `this is not an MCQ Study backup: unknown table(s) ${unknown.join(", ")}`,
      });
    }
    const names = EXPORT_TABLES.filter((t) => t in tables);
    if (names.length === 0) {
      return res.status(400).json({ error: "this backup carries no tables to restore" });
    }
    // The schema is created at module load (server/storage.ts, server/mcqs.ts),
    // so every known table exists by the time a request can reach this line.
    // Checked anyway: the alternative is a restore that reports rows it never
    // wrote.
    const live = liveTableNames();
    const missing = names.filter((t) => !live.has(t));
    if (missing.length > 0) {
      return res.status(500).json({ ok: false, error: `live schema is missing table(s) ${missing.join(", ")}` });
    }

    const restored: Record<string, number> = {};
    try {
      // One transaction: every table is wiped and reloaded, or none is. The
      // schema declares no cross-table foreign keys, so order is free.
      const run = sqlite.transaction(() => {
        for (const table of names) {
          let rows = tables[table];
          // Columns that actually exist in the live table — the intersection
          // tolerates schema drift (extra columns in the dump are ignored;
          // new columns absent from the dump keep their default/NULL). The
          // union over every row, not the first row's keys: a row with a
          // column the first row lacks would otherwise lose it silently.
          const liveCols = new Set(
            (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name),
          );
          if (table === "settings") {
            // THE SETTINGS ROW IS ALWAYS id = 1. storage.getSettings() reads
            // that one row, so a dump whose settings carried another id — or
            // none — would restore into a database the app cannot read its
            // settings from. One row, forced to id 1; an empty settings table
            // in the dump re-seeds the defaults rather than leaving nothing.
            rows = rows.slice(0, 1).map((r) => ({ ...r, id: 1 }));
          }
          sqlite.prepare(`DELETE FROM "${table}"`).run();
          if (rows.length === 0) {
            if (table === "settings") {
              sqlite.prepare("INSERT INTO settings (id) VALUES (1)").run();
              restored[table] = 1;
            } else {
              restored[table] = 0;
            }
            continue;
          }
          const dumpCols = new Set<string>();
          for (const row of rows) for (const c of Object.keys(row)) dumpCols.add(c);
          const cols = Array.from(dumpCols).filter((c) => liveCols.has(c));
          if (cols.length === 0) {
            if (table === "settings") sqlite.prepare("INSERT INTO settings (id) VALUES (1)").run();
            restored[table] = table === "settings" ? 1 : 0;
            continue;
          }
          const stmt = sqlite.prepare(
            `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
          );
          let n = 0;
          for (const row of rows) {
            stmt.run(...cols.map((c) => bindable(row[c])));
            n += 1;
          }
          restored[table] = n;
        }
      });
      run();
      res.json({ ok: true, restored, restoredAt: Date.now() });
    } catch (err: any) {
      // The transaction rolled back — the live DB is untouched.
      console.error("[api/import] failed (rolled back):", err?.stack || err);
      res.status(500).json({
        ok: false,
        error: String(err?.message || err),
        note: "transaction rolled back — no rows changed",
      });
    }
  });

  return httpServer;
}
