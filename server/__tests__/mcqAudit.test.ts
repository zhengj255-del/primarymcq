import "./testDb";
import { describe, it, expect, vi, beforeAll } from "vitest";

// Canned adjudicator: the audit pipeline's own mechanics are under test, not
// the model. Verdict per question is chosen by displayCode so each band and
// the missing-key (recall) path all get exercised in one run.
vi.mock("../ai/mcqTriage", () => ({
  triageMcq: vi.fn(async (input: { code: string; currentAnswer: string | null }) => {
    const base = {
      confidence: "high" as const,
      correctedReason: `audited ${input.code}`,
      disputeNote: "",
      clearsDispute: true,
      suggestedStem: null,
      suggestedOptions: null,
      model: "stub-model",
      reasoningEffort: null,
    };
    if (input.code === "FE30") return { ...base, verdict: "confirm_key", suggestedAnswer: input.currentAnswer };
    if (input.code === "25B-84") return { ...base, verdict: "change_answer", suggestedAnswer: "A" }; // keyless recall gets a key
    // A change verdict must actually differ from the stored key to be a change.
    if (input.code === "AD03") return { ...base, verdict: "change_answer", suggestedAnswer: input.currentAnswer === "A" ? "B" : "A" };
    return { ...base, verdict: "ambiguous", suggestedAnswer: null, clearsDispute: false };
  }),
}));

// storage must load before mcqs/mcqAudit (bootstrapMcqs runs at module scope).
import "../storage";
import { sqlite } from "../storage";
import { getMcq, updateMcqOverride, revertMcqOverride } from "../mcqs";
import {
  runAudit, listAuditPending, mcqAuditStatus, listMcqAudit,
  applyMcqAudit, applyAllMcqAudit, dismissMcqAudit, reopenMcqAudit, markMcqAuditFixed, effectiveContentHash,
} from "../mcqAudit";

// The audited fixture: two known acid-base questions, one keyless P25B recall,
// and everything else in their topics falls to the "ambiguous" default.
const CONFIRM_ID = "acid-base__FE30";
const CHANGE_ID = "acid-base__AD03";
const RECALL_ID = "opioids__25B-84";

describe("MCQ corpus audit", () => {
  beforeAll(async () => {
    // Topic-scoped runs keep the test bounded; the mocked adjudicator makes
    // them instant. Acid-base covers the confirm/change fixtures, opioids
    // covers the keyless recall.
    await runAudit({ topic: "acid-base" });
    await runAudit({ topic: "opioids" });
  });

  it("the verdict table exists from boot, not from the first sweep", () => {
    // server/storage.ts calls ensureAuditTable() so /api/export always sees it.
    const t = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcq_audit'").get();
    expect(t).toBeTruthy();
  });

  it("stores a verdict per audited question and drains them from pending", () => {
    const pending = new Set(listAuditPending("acid-base"));
    expect(pending.has(CONFIRM_ID)).toBe(false);
    expect(pending.has(CHANGE_ID)).toBe(false);
    const s = mcqAuditStatus("acid-base");
    expect(s.counts.good).toBeGreaterThanOrEqual(1);
    expect(s.counts.poor).toBeGreaterThanOrEqual(1);
    expect(s.running).toBe(false);
  });

  it("bands the queue: change_answer rows are applicable fixes", () => {
    const { items } = listMcqAudit({ band: "poor", topic: "acid-base" });
    const row = items.find((i) => i.mcq.id === CHANGE_ID);
    expect(row).toBeTruthy();
    expect(row!.audit.suggestedAnswer).not.toBe(row!.mcq.answer);
    expect(row!.applicable).toBe(true);
    // The confirmed question sits in "good" with nothing to apply.
    const good = listMcqAudit({ band: "good", topic: "acid-base" });
    const g = good.items.find((i) => i.mcq.id === CONFIRM_ID);
    expect(g).toBeTruthy();
    expect(g!.applicable).toBe(false);
  });

  it("supplies a key to an answerless recall and applying it makes the question answered", () => {
    const before = getMcq(RECALL_ID)!;
    expect(before.answer).toBeNull();
    const result = applyMcqAudit(RECALL_ID);
    expect("error" in result).toBe(false);
    const after = getMcq(RECALL_ID)!;
    expect(after.answer).toBe("A");
    expect(after.reason).toContain("audited 25B-84");
    // Applied → out of the suggested bands, into handled, and NOT re-pending
    // (the row was re-hashed against the post-apply content).
    expect(listMcqAudit({ band: "poor", topic: "opioids" }).items.find((i) => i.mcq.id === RECALL_ID)).toBeUndefined();
    expect(new Set(listAuditPending("opioids")).has(RECALL_ID)).toBe(false);
    // A second apply is a refused no-op, not a silent rewrite.
    const again = applyMcqAudit(RECALL_ID);
    expect("error" in again && again.status).toBe(409);
  });

  it("dismiss and reopen round-trip without touching content", () => {
    const dismissed = dismissMcqAudit(CHANGE_ID);
    expect(dismissed!.status).toBe("dismissed");
    expect(listMcqAudit({ band: "poor", topic: "acid-base" }).items.find((i) => i.mcq.id === CHANGE_ID)).toBeUndefined();
    expect(new Set(listAuditPending("acid-base")).has(CHANGE_ID)).toBe(false);
    const reopened = reopenMcqAudit(CHANGE_ID);
    expect(reopened!.status).toBe("suggested");
    const back = listMcqAudit({ band: "poor", topic: "acid-base" }).items.find((i) => i.mcq.id === CHANGE_ID);
    expect(back).toBeTruthy();
    // Neither dismiss nor reopen wrote the suggestion into the question.
    expect(getMcq(CHANGE_ID)!.answer).not.toBe(back!.audit.suggestedAnswer);
  });

  it("a content edit re-pends the question — the stored verdict describes stale content", () => {
    const before = effectiveContentHash(getMcq(CONFIRM_ID)!);
    updateMcqOverride(CONFIRM_ID, { stem: "Edited stem — the old verdict no longer applies." });
    expect(effectiveContentHash(getMcq(CONFIRM_ID)!)).not.toBe(before);
    expect(new Set(listAuditPending("acid-base")).has(CONFIRM_ID)).toBe(true);
  });

  it("a manual fix marks the verdict handled without re-pending", () => {
    // Any weak-band (ambiguous) question stands in for the dialog flow: the
    // user edits the question by hand, saves the override, and the verdict is
    // marked fixed against the POST-edit content.
    const target = listMcqAudit({ band: "weak", topic: "acid-base" }).items[0];
    expect(target).toBeTruthy();
    const id = target!.mcq.id;
    updateMcqOverride(id, { stem: "Hand-corrected stem via the fix dialog." });
    const row = markMcqAuditFixed(id);
    expect(row!.status).toBe("applied");
    expect(new Set(listAuditPending("acid-base")).has(id)).toBe(false);
    expect(listMcqAudit({ band: "handled", topic: "acid-base" }).items.some((i) => i.mcq.id === id)).toBe(true);
    expect(listMcqAudit({ band: "weak", topic: "acid-base" }).items.some((i) => i.mcq.id === id)).toBe(false);
  });

  it("a discarded question leaves the audit scope entirely", () => {
    updateMcqOverride(CHANGE_ID, { excluded: true });
    expect(new Set(listAuditPending("acid-base")).has(CHANGE_ID)).toBe(false);
    expect(listMcqAudit({ band: "poor", topic: "acid-base" }).items.find((i) => i.mcq.id === CHANGE_ID)).toBeUndefined();
    updateMcqOverride(CHANGE_ID, { excluded: null });
  });

  it("bulk approve applies exactly the applicable pile and reports honestly", () => {
    // The status count and the sweep must agree — same predicate.
    const before = mcqAuditStatus("acid-base");
    expect(before.counts.applicable).toBeGreaterThanOrEqual(1);
    const result = applyAllMcqAudit({ topic: "acid-base" });
    expect(result.applied).toBe(before.counts.applicable);
    expect(result.failed).toEqual([]);
    // The changed key landed, and nothing applicable remains in scope.
    expect(getMcq(CHANGE_ID)!.answer).toBe(listMcqAudit({ band: "handled", topic: "acid-base" }).items.find((i) => i.mcq.id === CHANGE_ID)!.audit.suggestedAnswer);
    const after = mcqAuditStatus("acid-base");
    expect(after.counts.applicable).toBe(0);
    // Non-applicable verdicts (ambiguous, confirm_key) were skipped, not applied.
    expect(after.counts.weak).toBe(before.counts.weak);
    // A second sweep is a clean no-op.
    expect(applyAllMcqAudit({ topic: "acid-base" }).applied).toBe(0);
  });
});

// A verdict describes the content it was assessed against. Once the user edits
// the question by hand, the stored suggestion targets text that no longer
// exists — applying it would overwrite the hand-written stem/answer/reason with
// the pre-edit AI suggestion, then re-hash the row so no sweep ever revisited
// the loss.
describe("a stale verdict never applies over a newer hand edit", () => {
  const TOPIC = "respiratory";
  let id: string;
  const HAND_STEM = "USER'S CAREFULLY HAND-WRITTEN STEM";

  beforeAll(() => {
    id = (sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL ORDER BY id LIMIT 1")
      .get(TOPIC) as { id: string }).id;
    const rec = getMcq(id)!;
    // A finished sweep left a full-rewrite suggestion against the PRE-edit content...
    sqlite.prepare(`INSERT OR REPLACE INTO mcq_audit
      (mcq_id, content_hash, verdict, confidence, suggested_answer, corrected_reason,
       dispute_note, suggested_stem, suggested_options, model, assessed_at, status)
      VALUES (?,?,'change_answer','high',?,'AI reason from the sweep','',?,NULL,'stub-model',1,'suggested')`)
      .run(id, effectiveContentHash(rec), rec.answer === "A" ? "B" : "A", "AI-REWRITTEN STEM (from the pre-edit sweep)");
    // ...and then the user hand-edited the question.
    updateMcqOverride(id, { stem: HAND_STEM });
  });

  it("drops the stale row from the applicable tally and flags it in the list", () => {
    const s = mcqAuditStatus(TOPIC);
    expect(s.counts.applicable).toBe(0);
    // Stale rows are pending re-audit, not banded — chips + pending must not
    // double-count.
    expect(s.counts.poor).toBe(0);
    expect(new Set(listAuditPending(TOPIC)).has(id)).toBe(true);
    // Chips and lists must share a universe: a stale suggested row is reported
    // as `pending`, is kept out of the band COUNTS, and must therefore be kept
    // out of the band LISTS too.
    const poor = listMcqAudit({ band: "poor", topic: TOPIC });
    expect(poor.items.find((i) => i.mcq.id === id)).toBeUndefined();
    expect(poor.total).toBe(mcqAuditStatus(TOPIC).counts.poor);
  });

  it("keeps every band chip equal to its own list total", () => {
    const c = mcqAuditStatus(TOPIC).counts;
    for (const band of ["poor", "weak", "good", "handled"] as const) {
      expect(listMcqAudit({ band, topic: TOPIC, limit: 200 }).total).toBe(c[band]);
    }
  });

  it("refuses a direct apply with a 409 naming the reason", () => {
    const result = applyMcqAudit(id);
    expect("error" in result).toBe(true);
    expect((result as { error: string; status: number }).status).toBe(409);
    expect((result as { error: string }).error).toMatch(/content changed/i);
    expect(getMcq(id)!.stem).toBe(HAND_STEM);
  });

  it("bulk approve skips it and the hand edit survives verbatim", () => {
    const result = applyAllMcqAudit({ topic: TOPIC });
    expect(result.applied).toBe(0);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const after = getMcq(id)!;
    expect(after.stem).toBe(HAND_STEM);
    expect(after.stem).not.toContain("AI-REWRITTEN");
  });
});

// A confirm_key verdict means "the key is right". The model may still hand back
// a tidied stem, which the PER-ROW Apply legitimately offers. Bulk approve must
// not take it: a bank showing "Poor 11" must not offer "Approve all 24" and
// rewrite 13 past-paper questions the audit had just certified as sound.
describe("bulk approve is scoped to the flagged bands", () => {
  const TOPIC = "renal";
  let goodWithRewrite: string;
  let poorWithFix: string;

  beforeAll(() => {
    const ids = sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = ? ORDER BY id LIMIT 2")
      .all(TOPIC) as Array<{ id: string }>;
    [goodWithRewrite, poorWithFix] = ids.map((r) => r.id);
    const plant = sqlite.prepare(`INSERT OR REPLACE INTO mcq_audit
      (mcq_id, content_hash, verdict, confidence, suggested_answer, corrected_reason,
       dispute_note, suggested_stem, suggested_options, model, assessed_at, status)
      VALUES (?,?,?,'high',?,'','',?,NULL,'stub-model',1,'suggested')`);
    // Good band, but carrying a reworded stem — applicable per-row, off-limits in bulk.
    plant.run(goodWithRewrite, effectiveContentHash(getMcq(goodWithRewrite)!), "confirm_key", null, "A politely reworded stem.");
    // Poor band with a real key change — the one row bulk approve should touch.
    const rec = getMcq(poorWithFix)!;
    plant.run(poorWithFix, effectiveContentHash(rec), "change_answer", rec.answer === "A" ? "B" : "A", null);
  });

  it("counts only flagged-band rows, so the button agrees with the band chips", () => {
    const s = mcqAuditStatus(TOPIC);
    expect(s.counts.good).toBe(1);
    expect(s.counts.poor).toBe(1);
    // The confirm_key row's stem rewrite must NOT inflate the bulk promise.
    expect(s.counts.applicable).toBe(1);
    expect(s.counts.applicable).toBeLessThanOrEqual(s.counts.poor + s.counts.weak);
  });

  it("still offers the rewrite on the Good row individually", () => {
    const good = listMcqAudit({ band: "good", topic: TOPIC }).items.find((i) => i.mcq.id === goodWithRewrite);
    expect(good).toBeTruthy();
    expect(good!.applicable).toBe(true); // per-row Apply stays available
  });

  // updateMcqOverride stores options as one JSON blob and overwrites it whole.
  // The adjudicator may return only the options it repaired, so assigning that
  // partial object verbatim would wipe every option it stayed silent about —
  // B/C/D/E blanked and the keyed answer C left with no text: an unanswerable
  // question in the Study runner.
  it("merges a partial option repair instead of blanking the rest", () => {
    const target = sqlite.prepare(
      "SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL ORDER BY id LIMIT 1 OFFSET 4",
    ).get(TOPIC) as { id: string };
    const before = getMcq(target.id)!;
    const untouched = Object.entries(before.options).filter(([k]) => k !== "A");
    expect(untouched.some(([, v]) => String(v).trim())).toBe(true); // fixture has real text to lose

    sqlite.prepare(`INSERT OR REPLACE INTO mcq_audit
      (mcq_id, content_hash, verdict, confidence, suggested_answer, corrected_reason,
       dispute_note, suggested_stem, suggested_options, model, assessed_at, status)
      VALUES (?,?,'change_answer','high','A','reason','',NULL,?,'stub-model',1,'suggested')`)
      .run(target.id, effectiveContentHash(before), JSON.stringify({ A: "Only option A was repaired." }));

    const result = applyMcqAudit(target.id);
    expect("error" in result).toBe(false);
    const after = getMcq(target.id)!;
    expect(after.options.A).toBe("Only option A was repaired.");
    // Everything the model stayed silent about survived verbatim.
    for (const [k, v] of untouched) expect(after.options[k as keyof typeof after.options]).toBe(v);
    // And the keyed option still has text — the question is still answerable.
    expect(String(after.options[after.answer! as keyof typeof after.options] ?? "").trim().length).toBeGreaterThan(0);
  });

  it("refuses a fix that would leave the keyed option blank", () => {
    const target = sqlite.prepare(
      "SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL ORDER BY id LIMIT 1 OFFSET 6",
    ).get(TOPIC) as { id: string };
    const before = getMcq(target.id)!;
    // A change to a key whose option the "repair" blanks: E, with E rewritten to "".
    sqlite.prepare(`INSERT OR REPLACE INTO mcq_audit
      (mcq_id, content_hash, verdict, confidence, suggested_answer, corrected_reason,
       dispute_note, suggested_stem, suggested_options, model, assessed_at, status)
      VALUES (?,?,'change_answer','high','E','reason','',NULL,?,'stub-model',1,'suggested')`)
      .run(target.id, effectiveContentHash(before), JSON.stringify({ E: "" }));
    const result = applyMcqAudit(target.id);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/keyed option E blank/);
    expect(getMcq(target.id)!.answer).toBe(before.answer);
  });

  it("sweeps the flagged row and leaves the Good question's stem untouched", () => {
    const stemBefore = getMcq(goodWithRewrite)!.stem;
    const result = applyAllMcqAudit({ topic: TOPIC });
    expect(result.applied).toBe(1);
    // The blank-key row above is applicable by verdict but refused by the
    // guard: reported as failed, never silently skipped.
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].error).toMatch(/blank/);
    // The certified-sound question was skipped, not rewritten.
    expect(getMcq(goodWithRewrite)!.stem).toBe(stemBefore);
    expect(listMcqAudit({ band: "good", topic: TOPIC }).items.some((i) => i.mcq.id === goodWithRewrite)).toBe(true);
    // And the flagged row did land.
    expect(listMcqAudit({ band: "handled", topic: TOPIC }).items.some((i) => i.mcq.id === poorWithFix)).toBe(true);
  });
});

// The status endpoint is polled while a sweep runs, and better-sqlite3 is
// synchronous — its cost is event-loop block for everything else the server
// does. These pin (a) numerical equivalence against an independently-computed
// naive reference, and (b) the statement budget, so a future "just call getMcq
// here" can't quietly reintroduce an O(corpus) poll.
describe("mcqAuditStatus is batched", () => {
  it("matches a naive per-row reference exactly", () => {
    const s = mcqAuditStatus();
    // Reference: same spec, computed the slow way with per-row getMcq.
    const ordered = (sqlite.prepare("SELECT id FROM mcqs ORDER BY topic_slug, code").all() as Array<{ id: string }>).map((r) => r.id);
    const excluded = new Set((sqlite.prepare("SELECT mcq_id FROM mcq_overrides WHERE excluded = 1").all() as Array<{ mcq_id: string }>).map((r) => r.mcq_id));
    const ids = ordered.filter((id) => !excluded.has(id));
    const scope = new Set(ids);
    const ref = { poor: 0, weak: 0, good: 0, handled: 0, applicable: 0 };
    const hashById = new Map<string, string>();
    for (const r of sqlite.prepare("SELECT * FROM mcq_audit").all() as Array<Record<string, any>>) {
      hashById.set(r.mcq_id, r.content_hash);
      if (!scope.has(r.mcq_id)) continue;
      if (r.status !== "suggested") { ref.handled += 1; continue; }
      const rec = getMcq(r.mcq_id);
      if (!rec) continue;
      if (r.content_hash !== effectiveContentHash(rec)) continue; // stale → pending, not banded
      if (r.verdict === "confirm_key") ref.good += 1;
      else if (r.verdict === "ambiguous") ref.weak += 1;
      else ref.poor += 1;
      const resolvable = r.verdict === "change_answer" || r.verdict === "confirm_key";
      const applicable = !resolvable ? false
        : r.suggested_stem || r.suggested_options ? true
        : r.verdict === "change_answer" && !!r.suggested_answer && r.suggested_answer !== rec.answer;
      if (r.verdict !== "confirm_key" && applicable) ref.applicable += 1;
    }
    const refPending = ids.filter((id) => {
      const rec = getMcq(id);
      return rec ? hashById.get(id) !== effectiveContentHash(rec) : false;
    }).length;
    expect(s.counts).toEqual(ref);
    expect(s.total).toBe(scope.size);
    expect(s.pending).toBe(refPending);
  });

  it("prepares a bounded number of statements per call, not one per row", () => {
    const spy = vi.spyOn(sqlite as never as { prepare: (sql: string) => unknown }, "prepare");
    try {
      mcqAuditStatus();
      expect(spy.mock.calls.length).toBeLessThan(50);
      listMcqAudit({ band: "good" });
      expect(spy.mock.calls.length).toBeLessThan(100);
    } finally {
      spy.mockRestore();
    }
  });
});

// Attempt correctness is stored denormalised but DERIVED from the key. The
// audit exists to change keys, so an applied key change must re-derive every
// earlier attempt and reset the schedule — the same rule a hand edit follows
// (pinned in detail by mcqKeyChange.test.ts; this pins that the AUDIT's apply
// path goes through it).
describe("an applied key change re-derives past attempts", () => {
  it("flips an attempt graded right under the old key to wrong, and resets SRS", () => {
    const id = (sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = 'cardiovascular' AND answer IS NOT NULL ORDER BY id LIMIT 1")
      .get() as { id: string }).id;
    const rec = getMcq(id)!;
    const oldKey = rec.answer!;
    const newKey = Object.entries(rec.options).find(([k, v]) => k !== oldKey && String(v).trim())![0];
    sqlite.prepare("DELETE FROM mcq_attempts WHERE mcq_id = ?").run(id);
    sqlite.prepare(
      "INSERT INTO mcq_attempts (mcq_id, session_id, mode, selected, correct, time_ms, attempted_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, "s1", "test", oldKey, 1, 1000, Date.now());
    sqlite.prepare(
      `INSERT OR REPLACE INTO mcq_srs_state (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at, stability, difficulty)
       VALUES (?, 1.9, 120, 6, 3, ?, ?, 120.5, 4.2)`,
    ).run(id, Date.now() - 86400000, Date.now() + 90 * 86400000);
    sqlite.prepare(`INSERT OR REPLACE INTO mcq_audit
      (mcq_id, content_hash, verdict, confidence, suggested_answer, corrected_reason,
       dispute_note, suggested_stem, suggested_options, model, assessed_at, status)
      VALUES (?,?,'change_answer','high',?,'the audit reason','',NULL,NULL,'stub-model',1,'suggested')`)
      .run(id, effectiveContentHash(rec), newKey);

    const result = applyMcqAudit(id);
    expect("error" in result).toBe(false);
    expect(getMcq(id)!.answer).toBe(newKey);
    const attempt = sqlite.prepare("SELECT correct FROM mcq_attempts WHERE mcq_id = ?").get(id) as { correct: number };
    expect(attempt.correct).toBe(0);
    const srs = sqlite.prepare("SELECT interval_days, reps, due_at FROM mcq_srs_state WHERE mcq_id = ?").get(id) as any;
    expect(srs.interval_days).toBe(0);
    expect(srs.reps).toBe(0);
    expect(srs.due_at).toBeLessThanOrEqual(Date.now());
    revertMcqOverride(id);
    sqlite.prepare("DELETE FROM mcq_attempts WHERE mcq_id = ?").run(id);
    sqlite.prepare("DELETE FROM mcq_srs_state WHERE mcq_id = ?").run(id);
  });
});
