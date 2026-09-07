import "./testDb";
import { describe, it, expect, vi, beforeAll } from "vitest";

// Bulk dispute resolution = the audit's fix mechanism pointed at the disputed
// pile. These pin the three properties that make that reuse safe:
//   1. the disputes-scoped sweep audits ONLY pending disputes, with the
//      DISPUTE prompt (its "someone flagged this" premise is true for them);
//   2. resolve-all maps verdicts onto the Disputes page's own action
//      vocabulary — confirm_key -> Accept (flag cleared, content untouched),
//      change_answer -> the ONE apply path (guards, merge, regrade included),
//      ambiguous/flawed -> left for the human;
//   3. a stale verdict resolves NOTHING (same staleness rule as the audit).

const seen = vi.hoisted(() => ({ modes: [] as Array<{ code: string; mode: string | undefined }> }));
vi.mock("../ai/mcqTriage", () => ({
  triageMcq: vi.fn(async (input: { code: string; currentAnswer: string | null; mode?: string }) => {
    seen.modes.push({ code: input.code, mode: input.mode });
    const base = {
      confidence: "high" as const,
      correctedReason: `adjudicated ${input.code}`,
      disputeNote: "",
      clearsDispute: true,
      suggestedStem: null,
      suggestedOptions: null,
      model: "stub-model",
      reasoningEffort: null,
    };
    if (input.code.endsWith("KEEP")) return { ...base, verdict: "confirm_key", suggestedAnswer: input.currentAnswer };
    if (input.code.endsWith("FIX")) return { ...base, verdict: "change_answer", suggestedAnswer: input.currentAnswer === "A" ? "B" : "A" };
    return { ...base, verdict: "ambiguous", suggestedAnswer: null, clearsDispute: false };
  }),
}));

import "../storage";
import { sqlite } from "../storage";
import { getMcq, updateMcqOverride, listDisputeTriage } from "../mcqs";
import { runAudit, resolveAllDisputes, disputeAdjudications, listAuditPending } from "../mcqAudit";

// A topic that ships with ZERO disputed questions, so the fixture owns the pile.
const TOPIC = "gastrointestinal";
const TOPIC_SIZE = 29;
let KEEP_ID: string;   // examiner will confirm the key -> bulk Accept
let FIX_ID: string;    // examiner will change the answer -> bulk Fix
let HUMAN_ID: string;  // examiner will call it ambiguous -> stays with the user
let STALE_ID: string;  // adjudicated, then edited -> verdict stale, resolves nothing

describe("bulk dispute resolution", () => {
  beforeAll(async () => {
    const shipped = (sqlite.prepare("SELECT COUNT(*) c FROM mcqs WHERE topic_slug = ? AND disputed = 1").get(TOPIC) as { c: number }).c;
    expect(shipped).toBe(0); // the fixture owns every dispute in this topic
    expect((sqlite.prepare("SELECT COUNT(*) c FROM mcqs WHERE topic_slug = ?").get(TOPIC) as { c: number }).c).toBe(TOPIC_SIZE);

    const ids = (sqlite.prepare(
      "SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL ORDER BY id LIMIT 4",
    ).all(TOPIC) as Array<{ id: string }>).map((r) => r.id);
    [KEEP_ID, FIX_ID, HUMAN_ID, STALE_ID] = ids;
    // Rename via display_code so the mock picks verdicts per question.
    sqlite.prepare("UPDATE mcqs SET display_code = display_code || '-KEEP' WHERE id = ?").run(KEEP_ID);
    sqlite.prepare("UPDATE mcqs SET display_code = display_code || '-FIX' WHERE id = ?").run(FIX_ID);
    sqlite.prepare("UPDATE mcqs SET disputed = 1 WHERE id IN (?,?,?,?)").run(KEEP_ID, FIX_ID, HUMAN_ID, STALE_ID);

    await runAudit({ topic: TOPIC, disputedOnly: true });
  });

  it("adjudicates ONLY the pending disputes, each with the dispute framing", () => {
    // 4 disputes in a 29-question topic: the scoped sweep must not spend the
    // other 25 model calls.
    expect(seen.modes).toHaveLength(4);
    for (const m of seen.modes) expect(m.mode).toBe("dispute");
    // The rest of the topic is still unaudited.
    expect(listAuditPending(TOPIC).length).toBe(TOPIC_SIZE - 4);
  });

  it("exposes each dispute's adjudication under the same predicates resolve-all uses", () => {
    // Make STALE_ID's verdict describe outdated content: a hand edit after the sweep.
    updateMcqOverride(STALE_ID, { stem: "Edited after adjudication — the verdict is stale." });
    const adj = disputeAdjudications();
    expect(adj[KEEP_ID]).toMatchObject({ verdict: "confirm_key", stale: false });
    expect(adj[FIX_ID]).toMatchObject({ verdict: "change_answer", applicable: true, stale: false });
    expect(adj[HUMAN_ID]).toMatchObject({ verdict: "ambiguous", stale: false });
    expect(adj[STALE_ID].stale).toBe(true);
  });

  it("resolves the pile: accept the confirmed, apply the changed, leave the rest", () => {
    const fixBefore = getMcq(FIX_ID)!;
    const keepBefore = getMcq(KEEP_ID)!;
    const r = resolveAllDisputes({ topic: TOPIC });
    expect(r).toMatchObject({ accepted: 1, fixed: 1, left: 1, unadjudicated: 1, failed: [] });

    // Accept: flag cleared, content byte-identical (the page's own Accept).
    const keep = getMcq(KEEP_ID)!;
    expect(keep.disputed).toBe(false);
    expect(keep.stem).toBe(keepBefore.stem);
    expect(keep.answer).toBe(keepBefore.answer);

    // Fix: went through applyMcqAudit — answer changed, flag cleared.
    const fix = getMcq(FIX_ID)!;
    expect(fix.disputed).toBe(false);
    expect(fix.answer).not.toBe(fixBefore.answer);
    expect(fix.reason).toContain("adjudicated");

    // Ambiguous and stale: still disputed, still pending for the human.
    expect(getMcq(HUMAN_ID)!.disputed).toBe(true);
    expect(getMcq(STALE_ID)!.disputed).toBe(true);
    expect(getMcq(STALE_ID)!.stem).toContain("Edited after adjudication");

    // The triage ledger agrees: accepted + fixed counted, 2 still pending here.
    const t = listDisputeTriage();
    const mine = t.items.filter((i) => [KEEP_ID, FIX_ID, HUMAN_ID, STALE_ID].includes(i.id));
    expect(mine.find((i) => i.id === KEEP_ID)!.triageStatus).toBe("accepted");
    expect(mine.find((i) => i.id === FIX_ID)!.triageStatus).toBe("fixed");
    expect(mine.find((i) => i.id === HUMAN_ID)!.triageStatus).toBe("pending");
    expect(mine.find((i) => i.id === STALE_ID)!.triageStatus).toBe("pending");
  });

  it("is idempotent: a second resolve finds only the human-owned remainder", () => {
    const r = resolveAllDisputes({ topic: TOPIC });
    expect(r).toMatchObject({ accepted: 0, fixed: 0, left: 1, unadjudicated: 1, failed: [] });
  });

  it("the whole-bank sweep uses the audit framing for undisputed questions and the dispute framing for disputed ones", async () => {
    seen.modes.length = 0;
    await runAudit({ topic: TOPIC }); // no disputedOnly: the remaining 25 + the re-pended stale dispute
    const disputed = seen.modes.filter((m) => m.mode === "dispute");
    const auditFramed = seen.modes.filter((m) => m.mode === "audit");
    // The stale dispute re-pended (content changed) and is the only disputed
    // question in the pending pool; everything else uses the audit prior.
    expect(seen.modes.length).toBe(TOPIC_SIZE - 4 + 1);
    expect(disputed.length).toBe(1);
    expect(auditFramed.length).toBe(TOPIC_SIZE - 4);
  });
});
