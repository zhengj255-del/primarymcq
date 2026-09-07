// -------------------------------------------------------------------------------------------------
// MCQ corpus audit — the AI quality sweep over the Black Bank.
//
// One AI sweep over every non-discarded question: the audit-mode adjudicator
// (server/ai/mcqTriage.ts) works each question from first principles and
// returns a verdict:
//   confirm_key   — key correct as-is (the "good" band)
//   change_answer — a different/missing key; suggestion carries the fix
//   ambiguous     — >1 defensible answer as written
//   flawed        — unsalvageable as written
//
// Verdicts persist in mcq_audit keyed by an EFFECTIVE-content hash (override
// layer included), so a question re-enters the pending pool only when its
// content actually changes. Applying a suggestion writes the existing
// mcq_overrides layer — the same store user edits and dispute triage use — so
// fixes survive corpus re-ingests and every consumer (study pools, SRS,
// stats) sees them without new plumbing.
// -------------------------------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { sqlite } from "./storage";
import { getMcq, getMcqMap, updateMcqOverride, resolveMcqDispute } from "./mcqs";
import type { McqRecord } from "@shared/schema";
import { triageMcq, type McqTriageResult } from "./ai/mcqTriage";
import { hasApiKey } from "./ai/llm";
import { mcqModel } from "./ai/config";

export type McqAuditStatusValue = "suggested" | "applied" | "dismissed";

export interface McqAuditRow {
  mcqId: string;
  // The effective-content hash AT ASSESSMENT TIME. A mismatch against the
  // current effectiveContentHash(rec) means the verdict describes content
  // that no longer exists — the row is stale and its suggestion must never
  // apply (it would overwrite whatever changed the content, e.g. a hand edit).
  contentHash: string;
  verdict: string;             // confirm_key | change_answer | ambiguous | flawed
  confidence: string;
  suggestedAnswer: string | null;
  correctedReason: string;
  disputeNote: string;
  suggestedStem: string | null;
  suggestedOptions: Record<string, string> | null;
  model: string;
  assessedAt: number;
  status: McqAuditStatusValue;
}

let ensured = false;
/** Create the verdict table. Idempotent; latches after the first call. Called
 *  at boot from server/storage.ts so /api/export always sees the table, and
 *  again (as a no-op) by every entry point below. */
export function ensureAuditTable(): void {
  if (ensured) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mcq_audit (
      mcq_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      verdict TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'medium',
      suggested_answer TEXT,
      corrected_reason TEXT NOT NULL DEFAULT '',
      dispute_note TEXT NOT NULL DEFAULT '',
      suggested_stem TEXT,
      suggested_options TEXT,
      model TEXT NOT NULL DEFAULT '',
      assessed_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'suggested'
    );
    CREATE INDEX IF NOT EXISTS mcq_audit_verdict_idx ON mcq_audit(verdict, status);
  `);
  ensured = true;
}

// Hash of what the model actually judged: the EFFECTIVE stem/options/answer/
// reason after overrides. Any content change — user edit, applied fix, triage
// repair — invalidates the stored verdict and re-pends the question.
export function effectiveContentHash(rec: McqRecord): string {
  return createHash("sha256")
    .update(rec.stem)
    .update("\0")
    .update(JSON.stringify(rec.options))
    .update("\0")
    .update(rec.answer ?? "")
    .update("\0")
    .update(rec.reason)
    .digest("hex");
}

interface AuditDbRow {
  mcq_id: string; content_hash: string; verdict: string; confidence: string;
  suggested_answer: string | null; corrected_reason: string; dispute_note: string;
  suggested_stem: string | null; suggested_options: string | null;
  model: string; assessed_at: number; status: string;
}

function rowToAudit(r: AuditDbRow): McqAuditRow {
  let suggestedOptions: Record<string, string> | null = null;
  if (r.suggested_options) {
    try { suggestedOptions = JSON.parse(r.suggested_options); } catch { /* corrupt row — treat as no repair */ }
  }
  return {
    mcqId: r.mcq_id,
    contentHash: r.content_hash,
    verdict: r.verdict,
    confidence: r.confidence,
    suggestedAnswer: r.suggested_answer,
    correctedReason: r.corrected_reason,
    disputeNote: r.dispute_note,
    suggestedStem: r.suggested_stem,
    suggestedOptions,
    model: r.model,
    assessedAt: r.assessed_at,
    status: (["suggested", "applied", "dismissed"].includes(r.status) ? r.status : "suggested") as McqAuditStatusValue,
  };
}

/** Ids of every auditable MCQ in scope (not discarded), oldest topics first.
 *  One statement for the exclusions, not one per row — this runs on the status
 *  endpoint the audit page polls. */
function idsInScope(topic?: string): string[] {
  const rows = (topic
    ? sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = ? ORDER BY topic_slug, code").all(topic)
    : sqlite.prepare("SELECT id FROM mcqs ORDER BY topic_slug, code").all()) as Array<{ id: string }>;
  const excluded = new Set(
    (sqlite.prepare("SELECT mcq_id FROM mcq_overrides WHERE excluded = 1").all() as Array<{ mcq_id: string }>)
      .map((r) => r.mcq_id),
  );
  return rows.map((r) => r.id).filter((id) => !excluded.has(id));
}

/** Pending = in scope, and no stored verdict for the CURRENT effective content.
 *  The hash is always computed from the hydrated record IN MEMORY — never
 *  stored-current-hash joined in SQL, which would silently kill re-pending
 *  after a user edit or applied fix (the whole design of this table).
 *  `pre` lets mcqAuditStatus share one scope pass and one corpus hydration
 *  instead of recomputing both. */
export function listAuditPending(
  topic?: string,
  pre?: { ids?: string[]; recs?: Map<string, McqRecord> },
): string[] {
  ensureAuditTable();
  const hashById = new Map<string, string>();
  for (const r of sqlite.prepare("SELECT mcq_id, content_hash FROM mcq_audit").all() as Array<{ mcq_id: string; content_hash: string }>) {
    hashById.set(r.mcq_id, r.content_hash);
  }
  const recs = pre?.recs ?? getMcqMap();
  const pending: string[] = [];
  for (const id of pre?.ids ?? idsInScope(topic)) {
    const rec = recs.get(id);
    if (!rec) continue;
    if (hashById.get(id) !== effectiveContentHash(rec)) pending.push(id);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Run machinery — fire-and-forget: kick returns immediately, a status poll
// tracks progress, stop is honoured between batches. In-process only: a
// redeploy mid-sweep ends the run, but every verdict already stored persists,
// and the next "Audit N unassessed" picks up where it left off.
// ---------------------------------------------------------------------------
let progress = { running: false, done: 0, total: 0 };
let stopRequested = false;
let lastError = "";

export function isAuditing(): boolean {
  return progress.running;
}

export function requestAuditStop(): boolean {
  if (!progress.running) return false;
  stopRequested = true;
  return true;
}

const AUDIT_CONCURRENCY = 3;
// Persistent-failure brake: a dead API key or model shouldn't spin through the
// whole corpus recording nothing. Consecutive failures only — one flaky call
// among successes must not kill a 1800-question sweep.
const MAX_CONSECUTIVE_FAILURES = 5;

async function auditOne(id: string): Promise<void> {
  const rec = getMcq(id);
  if (!rec) return;
  const hash = effectiveContentHash(rec);
  const result: McqTriageResult = await triageMcq({
    code: rec.displayCode,
    topicName: rec.topicName,
    domain: rec.domain,
    stem: rec.stem,
    options: Object.entries(rec.options)
      .filter(([, text]) => String(text ?? "").trim())
      .map(([key, text]) => ({ key, text: String(text) })),
    currentAnswer: rec.answer ?? null,
    currentReason: rec.reason ?? "",
    loCodes: rec.loCodes,
    // A disputed question HAS been flagged by someone — the dispute framing's
    // "someone believes the keyed answer is wrong" is literally true for it,
    // and the audit framing's "nobody has disputed this question" would be a
    // false premise in the prompt. Everything downstream (verdict vocabulary,
    // JSON contract, bands, apply) is identical either way.
    mode: rec.disputed ? "dispute" : "audit",
  });
  sqlite.prepare(`
    INSERT OR REPLACE INTO mcq_audit
      (mcq_id, content_hash, verdict, confidence, suggested_answer, corrected_reason,
       dispute_note, suggested_stem, suggested_options, model, assessed_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested')
  `).run(
    id, hash, result.verdict, result.confidence, result.suggestedAnswer,
    result.correctedReason, result.disputeNote, result.suggestedStem,
    result.suggestedOptions ? JSON.stringify(result.suggestedOptions) : null,
    result.model, Date.now(),
  );
}

/** The sweep itself — exported so tests can await it; kickAudit wraps it. */
export async function runAudit(opts: { topic?: string; limit?: number; disputedOnly?: boolean } = {}): Promise<{ done: number; failed: number }> {
  ensureAuditTable();
  if (progress.running) return { done: 0, failed: 0 };
  let pending = listAuditPending(opts.topic);
  if (opts.disputedOnly) {
    // The disputes page adjudicates ONLY the contested pile — sweeping a whole
    // topic to reach its 5 disputes would spend ~20x the model calls.
    const recs = getMcqMap();
    pending = pending.filter((id) => recs.get(id)?.disputed);
  }
  if (opts.limit && opts.limit > 0) pending = pending.slice(0, opts.limit);
  progress = { running: true, done: 0, total: pending.length };
  stopRequested = false;
  lastError = "";
  let failed = 0;
  let consecutiveFailures = 0;
  try {
    for (let i = 0; i < pending.length && !stopRequested; i += AUDIT_CONCURRENCY) {
      const slice = pending.slice(i, i + AUDIT_CONCURRENCY);
      const results = await Promise.allSettled(slice.map((id) => auditOne(id)));
      for (const r of results) {
        if (r.status === "rejected") {
          failed += 1;
          consecutiveFailures += 1;
          lastError = String((r.reason as Error)?.message ?? r.reason).slice(0, 300);
        } else {
          consecutiveFailures = 0;
        }
      }
      progress.done += slice.length;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        lastError = `run aborted after ${consecutiveFailures} consecutive failures — last: ${lastError}`;
        break;
      }
    }
  } finally {
    progress.running = false;
  }
  return { done: progress.done - failed, failed };
}

export function kickAudit(opts: { topic?: string; disputedOnly?: boolean } = {}): boolean {
  if (progress.running) return false;
  void runAudit(opts).catch((e) => {
    lastError = String((e as Error)?.message ?? e).slice(0, 300);
    progress.running = false;
  });
  return true;
}

// ---------------------------------------------------------------------------
// Status + list
// ---------------------------------------------------------------------------
// The review bands:
//   poor — genuine defects: wrong/missing key (change_answer) or unsalvageable
//          as written (flawed)
//   weak — ambiguous: works, but >1 defensible answer / under-specified
//   good — key confirmed
// (the per-row verdict still distinguishes change_answer from flawed).
export interface McqAuditCounts {
  poor: number;       // change_answer or flawed, suggested
  weak: number;       // ambiguous, suggested
  good: number;       // confirm_key, suggested
  handled: number;    // applied or dismissed, any verdict
  // How many suggested fixes bulk-approve would apply — derived from the SAME
  // pair of predicates applyAllMcqAudit uses (isFlaggedVerdict + isApplicable),
  // so the button's promise and the action's work cannot drift.
  //
  // NB this is deliberately NARROWER than the per-row `applicable` flag on a
  // listMcqAudit item: a confirm_key row can carry a tidied stem, which IS
  // applicable per-row but must never ride along in a bulk sweep. Counting
  // those would make the button read "Approve all 24" next to chips reading
  // "Poor 11" — 13 of the 24 being questions the audit called sound.
  applicable: number;
}

export function mcqAuditStatus(topic?: string): {
  running: boolean;
  progress: { running: boolean; done: number; total: number };
  pending: number;
  total: number;
  counts: McqAuditCounts;
  lastError: string;
  keyPresent: boolean;
  model: string;
} {
  ensureAuditTable();
  // One scope pass and one corpus hydration for the whole request. This
  // endpoint is polled during a sweep, and a per-row getMcq here
  // (~3 statements × corpus × 2 passes ≈ 14,800 statements, ~300 ms) would
  // block the single synchronous event loop for every poll. No caching here —
  // `progress` must stay live, and the page refetches immediately after every
  // apply/dismiss, which a memo would serve stale.
  const ids = idsInScope(topic);
  const scope = new Set(ids);
  const recs = getMcqMap();
  const counts: McqAuditCounts = { poor: 0, weak: 0, good: 0, handled: 0, applicable: 0 };
  for (const r of sqlite.prepare("SELECT * FROM mcq_audit").all() as AuditDbRow[]) {
    if (!scope.has(r.mcq_id)) continue;
    if (r.status !== "suggested") { counts.handled += 1; continue; }
    const rec = recs.get(r.mcq_id);
    if (!rec) continue;
    const audit = rowToAudit(r);
    // A stale suggested row is already counted by `pending` (same hash rule in
    // listAuditPending) — banding it too would make chips + "not yet audited"
    // exceed the total.
    if (isStale(audit, rec)) continue;
    if (r.verdict === "confirm_key") counts.good += 1;
    else if (r.verdict === "ambiguous") counts.weak += 1;
    else counts.poor += 1; // change_answer or flawed
    if (isFlaggedVerdict(r.verdict) && isApplicable(audit, rec)) counts.applicable += 1;
  }
  return {
    running: progress.running,
    progress: { ...progress },
    pending: listAuditPending(topic, { ids, recs }).length,
    total: scope.size,
    counts,
    lastError,
    keyPresent: hasApiKey(),
    model: mcqModel(),
  };
}

export type McqAuditBand = "poor" | "weak" | "good" | "handled";

/** The bands the audit FLAGS as problematic: poor (change_answer / flawed) and
 *  weak (ambiguous). Mirrors the client's bandOf() — anything that is not
 *  confirm_key lands in poor or weak — so the button's tally and the page's
 *  band chips partition the same rows.
 *
 *  Bulk approve is scoped to these. A confirm_key row may still carry a
 *  reworded stem or rewritten options, but rewriting a past-paper question the
 *  audit just certified as sound is a per-row judgement call, never something
 *  to sweep through in one click. Those rows keep their per-row Apply. */
function isFlaggedVerdict(verdict: string): boolean {
  return verdict !== "confirm_key";
}

/** A fix is applicable when accepting it would change the stored question —
 *  AND the verdict RESOLVED the question — AND the verdict still describes the
 *  question's current content. A stale verdict (content edited since the sweep:
 *  hand fix, dispute triage, applied suggestion elsewhere) must never apply:
 *  doing so would overwrite the user's hand-written stem/answer/reason with the
 *  pre-edit AI suggestion, then re-hash the row so no future sweep ever
 *  revisited the loss. */
function isApplicable(audit: McqAuditRow, rec: McqRecord): boolean {
  if (audit.status !== "suggested") return false;
  if (isStale(audit, rec)) return false;
  // THE VERDICT DECIDES FIRST — before any repair text attached to it.
  // ambiguous and flawed both mean the adjudicator could not settle the
  // question ("more than one answer is defensible", "unsalvageable as
  // written"), yet it may still hand back a tidied stem or a partial option
  // repair; applying that would rewrite a past-paper question the model had
  // refused to answer, KEEP the key it had just called unsafe, and store the
  // ambiguity note ("Both B and C are defensible") as the reveal explanation —
  // correctedReason is defined as the explanation for the CHOSEN answer, and
  // there is no chosen answer here. Those rows belong to a human: the same
  // policy resolveAllDisputes states for the dispute lane. An unrecognised
  // verdict string lands here too — nothing writes on a verdict this code
  // cannot reason about. (A human can still edit the question by hand from
  // the row's own fix dialog, which is exactly the intent.)
  if (audit.verdict !== "change_answer" && audit.verdict !== "confirm_key") return false;
  // A resolved verdict may carry a repair on top of its key ruling; confirm_key
  // certifies the key, so a repair is the only thing it ever has to apply
  // (per row only — isFlaggedVerdict keeps bulk approve off that band).
  if (audit.suggestedStem || audit.suggestedOptions) return true;
  if (audit.verdict !== "change_answer") return false;
  return !!audit.suggestedAnswer && audit.suggestedAnswer !== rec.answer;
}

/** Does the stored verdict describe content that has since changed? Such a row
 *  is already back in listAuditPending (same hash comparison) awaiting a
 *  re-audit; its suggestion targets text that no longer exists. */
function isStale(audit: McqAuditRow, rec: McqRecord): boolean {
  return audit.contentHash !== effectiveContentHash(rec);
}

export function listMcqAudit(opts: { band?: McqAuditBand; topic?: string; limit?: number } = {}): {
  items: Array<{ mcq: McqRecord; audit: McqAuditRow; applicable: boolean; stale: boolean }>;
  total: number;
} {
  ensureAuditTable();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const where: string[] = [];
  if (opts.band === "handled") {
    where.push("status != 'suggested'");
  } else if (opts.band === "good") {
    where.push("status = 'suggested' AND verdict = 'confirm_key'");
  } else if (opts.band === "weak") {
    where.push("status = 'suggested' AND verdict = 'ambiguous'");
  } else if (opts.band === "poor") {
    where.push("status = 'suggested' AND verdict IN ('change_answer', 'flawed')");
  }
  const rows = sqlite.prepare(
    `SELECT * FROM mcq_audit${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY assessed_at DESC`,
  ).all() as AuditDbRow[];

  const items: Array<{ mcq: McqRecord; audit: McqAuditRow; applicable: boolean; stale: boolean }> = [];
  // Whole-corpus hydration in three statements — a getMcq per audit row made
  // the unfiltered ?band=good listing ~100 ms of synchronous SQLite.
  const recs = getMcqMap();
  let total = 0;
  for (const r of rows) {
    const rec = recs.get(r.mcq_id);
    if (!rec || rec.excluded) continue;
    if (opts.topic && rec.topicSlug !== opts.topic) continue;
    const audit = rowToAudit(r);
    const stale = isStale(audit, rec);
    // A STALE SUGGESTED row describes content that no longer exists. It is
    // already reported as `pending` (same hash rule) and mcqAuditStatus keeps
    // it out of the band counts, so listing it here would put a row in the
    // band that its own chip does not count. It reappears in its band as soon
    // as the next sweep re-audits it.
    //
    // Handled rows are exempt: mcqAuditStatus counts them by status BEFORE the
    // staleness test, so a stale applied/dismissed row is in the handled chip
    // and belongs in the handled list too.
    if (stale && audit.status === "suggested") continue;
    total += 1;
    if (items.length < limit) {
      items.push({ mcq: rec, audit, applicable: isApplicable(audit, rec), stale });
    }
  }
  return { items, total };
}

// ---------------------------------------------------------------------------
// Verdict actions
// ---------------------------------------------------------------------------

/** Apply a suggested fix: write answer/reason (and stem/options when repaired)
 *  into the override layer, clear the dispute flag for resolvable verdicts, and
 *  mark the audit row applied — re-hashed against the NEW content so the
 *  applied question doesn't bounce straight back into the pending pool. */
export function applyMcqAudit(id: string): { mcq: McqRecord; audit: McqAuditRow } | { error: string; status: number } {
  ensureAuditTable();
  const raw = sqlite.prepare("SELECT * FROM mcq_audit WHERE mcq_id = ?").get(id) as AuditDbRow | undefined;
  if (!raw) return { error: "No audit verdict for this MCQ", status: 404 };
  const audit = rowToAudit(raw);
  const rec = getMcq(id);
  if (!rec) return { error: "MCQ not found", status: 404 };
  if (audit.status !== "suggested") return { error: `Already ${audit.status}`, status: 409 };
  // Named check ahead of the general predicate (which also covers staleness):
  // a stale client can POST this endpoint directly long after an edit, and
  // "Nothing to apply" would misdescribe why it was refused.
  if (isStale(audit, rec)) {
    return { error: "Content changed since this verdict — re-audit before applying", status: 409 };
  }
  if (!isApplicable(audit, rec)) return { error: "Nothing to apply for this verdict", status: 409 };

  const edit: Parameters<typeof updateMcqOverride>[1] = {};
  if (audit.suggestedAnswer) edit.answer = audit.suggestedAnswer;
  // Only ever reached for a RESOLVED verdict (the isApplicable gate above):
  // correctedReason is the explanation for the answer the adjudicator chose,
  // so on an ambiguous/flawed row it is a note about why no answer could be
  // chosen and must never become the question's reveal text.
  if (audit.correctedReason) edit.reason = audit.correctedReason;
  if (audit.suggestedStem) edit.stem = audit.suggestedStem;
  if (audit.suggestedOptions) {
    // MERGE, never replace. updateMcqOverride stores `options` as one JSON blob
    // and overwrites it wholesale, while the model may return only the options
    // it actually repaired. Assigning a partial object verbatim would wipe
    // every option it stayed silent about — including, routinely, the keyed
    // one, leaving an "applied fix" unanswerable in the Study runner. Keys the
    // model DID return win; keys it omitted keep their existing text.
    edit.options = { ...rec.options, ...audit.suggestedOptions } as never;
  }
  if (rec.disputed && (audit.verdict === "confirm_key" || audit.verdict === "change_answer")) {
    edit.disputed = false;
  }

  // Belt and braces on top of the merge above: never write a fix that leaves the
  // KEYED option with no text. That is an unanswerable question in the Study
  // runner. Refuse instead of corrupting — the row stays in the queue for a
  // hand fix.
  const nextOptions = (edit.options ?? rec.options) as Record<string, string>;
  const nextAnswer = edit.answer ?? rec.answer;
  if (nextAnswer && !String(nextOptions[nextAnswer] ?? "").trim()) {
    return {
      error: `Suggestion would leave the keyed option ${nextAnswer} blank — fix this question by hand`,
      status: 409,
    };
  }

  const updated = updateMcqOverride(id, edit);
  if (!updated) return { error: "MCQ not found", status: 404 };

  sqlite.prepare(
    "UPDATE mcq_audit SET status = 'applied', content_hash = ? WHERE mcq_id = ?",
  ).run(effectiveContentHash(updated), id);
  return { mcq: updated, audit: { ...audit, status: "applied" } };
}

/** Mark a verdict handled after a MANUAL fix (the edit dialog): the user
 *  reviewed the suggestion, edited the question through the override layer,
 *  and saved. The row re-hashes against the post-edit content so the
 *  hand-fixed question doesn't bounce straight back into the pending pool. */
export function markMcqAuditFixed(id: string): McqAuditRow | null {
  ensureAuditTable();
  const raw = sqlite.prepare("SELECT * FROM mcq_audit WHERE mcq_id = ?").get(id) as AuditDbRow | undefined;
  const rec = getMcq(id);
  if (!raw || !rec) return null;
  sqlite.prepare(
    "UPDATE mcq_audit SET status = 'applied', content_hash = ? WHERE mcq_id = ?",
  ).run(effectiveContentHash(rec), id);
  return { ...rowToAudit(raw), status: "applied" };
}

/** Bulk approve: press Apply on every applicable row IN A FLAGGED BAND (poor or
 *  weak) in one action. Iterates the SAME per-row apply (one code path), so the
 *  result is exactly what clicking each of those buttons would have produced;
 *  per-row failures are collected rather than aborting the sweep.
 *
 *  Good (confirm_key) rows are skipped even when they carry an applicable stem
 *  or option rewrite — see isFlaggedVerdict. The scope here MUST stay in step
 *  with counts.applicable in mcqAuditStatus, which is what the button promises. */
export function applyAllMcqAudit(opts: { topic?: string } = {}): { applied: number; skipped: number; failed: Array<{ id: string; error: string }> } {
  ensureAuditTable();
  const scope = new Set(idsInScope(opts.topic));
  const suggested = (sqlite.prepare("SELECT * FROM mcq_audit WHERE status = 'suggested'").all() as AuditDbRow[])
    .filter((r) => scope.has(r.mcq_id));
  let applied = 0;
  let skipped = 0;
  const failed: Array<{ id: string; error: string }> = [];
  for (const r of suggested) {
    const rec = getMcq(r.mcq_id);
    if (!rec || !isFlaggedVerdict(r.verdict) || !isApplicable(rowToAudit(r), rec)) { skipped += 1; continue; }
    const result = applyMcqAudit(r.mcq_id);
    if ("error" in result) failed.push({ id: r.mcq_id, error: result.error });
    else applied += 1;
  }
  return { applied, skipped, failed };
}

// ---------------------------------------------------------------------------
// Bulk dispute resolution — the audit's fix mechanism pointed at the disputed
// pile. One adjudication per dispute (the sweep above with disputedOnly), then
// one action per verdict, mirroring the Disputes page's own vocabulary:
//   confirm_key   -> ACCEPT: the dispute is noise; clear the flag, touch no
//                    content (exactly the page's Accept button).
//   change_answer -> FIX: apply through the ONE apply path (applyMcqAudit), so
//                    staleness, the keyed-option guard, the option merge, the
//                    attempt re-grade and the dispute clear all hold.
//   ambiguous/flawed -> left pending: the adjudicator itself says no single
//                    answer is safe, so a human decides. Bulk never applies
//                    their edits (the same policy that keeps bulk approve off
//                    the Good band).
// ---------------------------------------------------------------------------
export function resolveAllDisputes(opts: { topic?: string } = {}): {
  accepted: number; fixed: number; left: number; unadjudicated: number;
  failed: Array<{ id: string; error: string }>;
} {
  ensureAuditTable();
  const recs = getMcqMap();
  const byId = new Map(
    (sqlite.prepare("SELECT * FROM mcq_audit WHERE status = 'suggested'").all() as AuditDbRow[])
      .map((r) => [r.mcq_id, r] as const),
  );
  let accepted = 0, fixed = 0, left = 0, unadjudicated = 0;
  const failed: Array<{ id: string; error: string }> = [];
  for (const rec of Array.from(recs.values())) {
    if (!rec.disputed || rec.excluded) continue;
    if (opts.topic && rec.topicSlug !== opts.topic) continue;
    const raw = byId.get(rec.id);
    const audit = raw ? rowToAudit(raw) : null;
    // No verdict, or one describing content that has since changed: this
    // dispute needs (re-)adjudication before anything may act on it.
    if (!audit || isStale(audit, rec)) { unadjudicated += 1; continue; }
    if (audit.verdict === "confirm_key") {
      resolveMcqDispute(rec.id, "accept");
      accepted += 1;
    } else if (audit.verdict === "change_answer") {
      const result = applyMcqAudit(rec.id);
      if ("error" in result) failed.push({ id: rec.id, error: result.error });
      else fixed += 1;
    } else {
      left += 1;
    }
  }
  return { accepted, fixed, left, unadjudicated, failed };
}

/** Fresh (and stale, flagged as such) suggested verdicts for the DISPUTED
 *  pile, keyed by mcq id — lets the Disputes page show each pending row's
 *  adjudication and put an honest number on its Resolve button using the same
 *  predicates resolveAllDisputes will act with. */
export function disputeAdjudications(): Record<string, { verdict: string; suggestedAnswer: string | null; applicable: boolean; stale: boolean }> {
  ensureAuditTable();
  const recs = getMcqMap();
  const out: Record<string, { verdict: string; suggestedAnswer: string | null; applicable: boolean; stale: boolean }> = {};
  for (const r of sqlite.prepare("SELECT * FROM mcq_audit WHERE status = 'suggested'").all() as AuditDbRow[]) {
    const rec = recs.get(r.mcq_id);
    if (!rec || !rec.disputed || rec.excluded) continue;
    const audit = rowToAudit(r);
    out[r.mcq_id] = {
      verdict: audit.verdict,
      suggestedAnswer: audit.suggestedAnswer,
      applicable: isApplicable(audit, rec),
      stale: isStale(audit, rec),
    };
  }
  return out;
}

export function dismissMcqAudit(id: string): McqAuditRow | null {
  ensureAuditTable();
  const raw = sqlite.prepare("SELECT * FROM mcq_audit WHERE mcq_id = ?").get(id) as AuditDbRow | undefined;
  if (!raw) return null;
  sqlite.prepare("UPDATE mcq_audit SET status = 'dismissed' WHERE mcq_id = ?").run(id);
  return { ...rowToAudit(raw), status: "dismissed" };
}

/** Reopen a handled verdict back to suggested (applied content edits stay —
 *  they live in the override layer, same contract as triage reopen). */
export function reopenMcqAudit(id: string): McqAuditRow | null {
  ensureAuditTable();
  const raw = sqlite.prepare("SELECT * FROM mcq_audit WHERE mcq_id = ?").get(id) as AuditDbRow | undefined;
  if (!raw) return null;
  sqlite.prepare("UPDATE mcq_audit SET status = 'suggested' WHERE mcq_id = ?").run(id);
  return { ...rowToAudit(raw), status: "suggested" };
}
