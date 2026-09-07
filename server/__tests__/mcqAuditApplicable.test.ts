import "./testDb";
import { describe, it, expect, vi, beforeAll } from "vitest";

// No adjudicator runs here. Every verdict below is PLANTED in mcq_audit exactly
// as a finished sweep leaves it, because the property under test is what the
// apply path does with a stored verdict, not how the verdict was produced. The
// module is stubbed anyway so importing mcqAudit can never reach a model.
vi.mock("../ai/mcqTriage", () => ({
  triageMcq: vi.fn(async () => {
    throw new Error("no model calls in this test — verdicts are planted");
  }),
}));

// storage must load before mcqs/mcqAudit (bootstrapMcqs runs at module scope).
import "../storage";
import { sqlite } from "../storage";
import { getMcq } from "../mcqs";
import {
  mcqAuditStatus, listMcqAudit, applyMcqAudit, applyAllMcqAudit, effectiveContentHash,
} from "../mcqAudit";

// ambiguous = "more than one answer is defensible as written"; flawed =
// "unsalvageable as written". Both are the adjudicator saying it could NOT
// settle this question. The model may still attach a tidied stem or a partial
// option repair to such a verdict — and an isApplicable that consulted the
// repair BEFORE the verdict would let "Approve all N" rewrite questions the
// audit had just refused to stand behind, and store the ambiguity note ("Both
// B and C are defensible") as the reveal explanation, all while keeping the
// key the note says may be wrong.
//
// NOTE for the next reader: feeding an UNPARSABLE verdict does not reproduce
// this. mcqTriage strips every suggestion from a reply whose verdict it could
// not parse, so such a row carries nothing to apply. The live case is a
// perfectly VALID ambiguous/flawed verdict that carries a repair, which is
// what these rows are.
describe("only a resolvable verdict is applicable", () => {
  let TOPIC: string;
  let ambiguousId: string;
  let flawedId: string;
  let changeId: string;
  let newKey: string;

  const AMBIGUOUS_STEM = "AI-REWRITTEN STEM (from a verdict that could not answer the question)";
  const AMBIGUOUS_REASON = "Both B and C are defensible as written.";
  const FLAWED_REASON = "No option is correct as written.";
  const FLAWED_OPTION_A = "PARTIAL REPAIR from a flawed verdict.";
  const CHANGE_STEM = "A tightened stem from a resolvable verdict.";
  const CHANGE_REASON = "The key is the one supported by the prescribed text.";

  const plant = (
    id: string, verdict: string, answer: string | null, reason: string,
    stem: string | null, options: Record<string, string> | null,
  ) => {
    sqlite.prepare(`INSERT OR REPLACE INTO mcq_audit
      (mcq_id, content_hash, verdict, confidence, suggested_answer, corrected_reason,
       dispute_note, suggested_stem, suggested_options, model, assessed_at, status)
      VALUES (?,?,?,'high',?,?,'',?,?,'stub-model',1,'suggested')`)
      .run(id, effectiveContentHash(getMcq(id)!), verdict, answer, reason, stem,
        options ? JSON.stringify(options) : null);
  };

  beforeAll(() => {
    // Any topic with three keyed questions; the fixture corpus, not a hand-built
    // one, so the rows go through the same override/hash machinery as production.
    TOPIC = (sqlite.prepare(
      `SELECT topic_slug FROM mcqs WHERE answer IS NOT NULL
       GROUP BY topic_slug HAVING COUNT(*) >= 3 ORDER BY topic_slug LIMIT 1`,
    ).get() as { topic_slug: string }).topic_slug;
    const ids = (sqlite.prepare(
      "SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL ORDER BY id LIMIT 3",
    ).all(TOPIC) as Array<{ id: string }>).map((r) => r.id);
    [ambiguousId, flawedId, changeId] = ids;

    plant(ambiguousId, "ambiguous", null, AMBIGUOUS_REASON, AMBIGUOUS_STEM, null);
    plant(flawedId, "flawed", null, FLAWED_REASON, null, { A: FLAWED_OPTION_A });
    // The resolvable control: a real key change, carrying a repair of its own.
    const rec = getMcq(changeId)!;
    newKey = Object.entries(rec.options)
      .find(([k, v]) => k !== rec.answer && String(v).trim())![0];
    plant(changeId, "change_answer", newKey, CHANGE_REASON, CHANGE_STEM, null);
  });

  it("bands an ambiguous verdict as weak and offers nothing to apply", () => {
    const row = listMcqAudit({ band: "weak", topic: TOPIC }).items.find((i) => i.mcq.id === ambiguousId);
    expect(row).toBeTruthy();
    expect(row!.stale).toBe(false);                       // a live verdict, not a stale one
    expect(row!.audit.suggestedStem).toBe(AMBIGUOUS_STEM); // ...that really does carry a repair
    expect(row!.applicable).toBe(false);
  });

  it("bands a flawed verdict as poor and offers nothing to apply", () => {
    const row = listMcqAudit({ band: "poor", topic: TOPIC }).items.find((i) => i.mcq.id === flawedId);
    expect(row).toBeTruthy();
    expect(row!.stale).toBe(false);
    expect(row!.audit.suggestedOptions).toEqual({ A: FLAWED_OPTION_A });
    expect(row!.applicable).toBe(false);
  });

  it("promises only the resolvable row on the bulk button", () => {
    const s = mcqAuditStatus(TOPIC);
    expect(s.counts.weak).toBe(1);
    expect(s.counts.poor).toBe(2);       // change_answer + flawed share the poor band
    expect(s.counts.applicable).toBe(1); // ...but only change_answer can be applied
  });

  it("refuses a direct Apply on an unresolvable verdict without touching the question", () => {
    for (const id of [ambiguousId, flawedId]) {
      const before = getMcq(id)!;
      const result = applyMcqAudit(id);
      expect("error" in result).toBe(true);
      expect((result as { status: number }).status).toBe(409);
      const after = getMcq(id)!;
      expect(after.stem).toBe(before.stem);
      expect(after.options).toEqual(before.options);
      expect(after.answer).toBe(before.answer);
      expect(after.reason).toBe(before.reason);
    }
  });

  it("bulk approve applies the resolvable row and leaves the unresolvable ones alone", () => {
    const ambiguousBefore = getMcq(ambiguousId)!;
    const flawedBefore = getMcq(flawedId)!;
    const changeBefore = getMcq(changeId)!;

    const result = applyAllMcqAudit({ topic: TOPIC });
    expect(result.applied).toBe(1);
    expect(result.failed).toEqual([]);

    // The ambiguous question: stem untouched, key untouched, and — the part the
    // candidate actually reads — the ambiguity note was NOT stored as the
    // explanation of an answer the verdict never endorsed.
    const ambiguousAfter = getMcq(ambiguousId)!;
    expect(ambiguousAfter.stem).toBe(ambiguousBefore.stem);
    expect(ambiguousAfter.stem).not.toContain("AI-REWRITTEN");
    expect(ambiguousAfter.answer).toBe(ambiguousBefore.answer);
    expect(ambiguousAfter.reason).toBe(ambiguousBefore.reason);
    expect(ambiguousAfter.reason).not.toContain(AMBIGUOUS_REASON);

    // The flawed question: the partial option repair never landed either.
    const flawedAfter = getMcq(flawedId)!;
    expect(flawedAfter.options).toEqual(flawedBefore.options);
    expect(flawedAfter.reason).toBe(flawedBefore.reason);
    expect(flawedAfter.reason).not.toContain(FLAWED_REASON);

    // Both rows are still waiting for a human, not silently marked handled.
    expect(listMcqAudit({ band: "handled", topic: TOPIC }).items.map((i) => i.mcq.id))
      .not.toContain(ambiguousId);
    expect(listMcqAudit({ band: "weak", topic: TOPIC }).items.some((i) => i.mcq.id === ambiguousId)).toBe(true);
    expect(listMcqAudit({ band: "poor", topic: TOPIC }).items.some((i) => i.mcq.id === flawedId)).toBe(true);

    // ...and the working path is untouched: change_answer still writes its key,
    // its stem repair and its explanation in one click.
    const changeAfter = getMcq(changeId)!;
    expect(changeAfter.answer).toBe(newKey);
    expect(changeAfter.answer).not.toBe(changeBefore.answer);
    expect(changeAfter.stem).toBe(CHANGE_STEM);
    expect(changeAfter.reason).toBe(CHANGE_REASON);
    expect(listMcqAudit({ band: "handled", topic: TOPIC }).items.some((i) => i.mcq.id === changeId)).toBe(true);
  });
});
