import "./testDb";
import { describe, it, expect, afterEach, vi } from "vitest";
import "../storage";
import { triageMcq } from "../ai/mcqTriage";

// The adjudicator's response parser is the last line of defence between a
// model that returns something unexpected and a corpus edit. Three properties
// matter: an UNRECOGNISED verdict must never carry edits into the bank, the
// audit sweep must use the audit framing rather than the dispute one, and the
// prompt must not promise textbook passages this site never supplies.

process.env.OPENAI_API_KEY = "test-key";
afterEach(() => vi.unstubAllGlobals());

function stubReply(content: string): { systems: string[]; users: string[] } {
  const systems: string[] = [];
  const users: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
    try {
      const body = JSON.parse(init.body);
      const sys = (body.messages ?? []).find((m: any) => m.role === "system");
      const usr = (body.messages ?? []).find((m: any) => m.role === "user");
      if (sys) systems.push(String(sys.content));
      if (usr) users.push(String(usr.content));
    } catch { /* ignore */ }
    return {
      ok: true, status: 200,
      async json() { return { choices: [{ message: { content } }], usage: {}, model: "stub" }; },
      async text() { return ""; },
    } as any;
  }));
  return { systems, users };
}

const INPUT = {
  code: "AD03", topicName: "Acid-Base", domain: "acid_base",
  stem: "A stem", options: [{ key: "A", text: "one" }, { key: "B", text: "two" }],
  currentAnswer: "A", currentReason: "because",
};

describe("adjudicator response parsing", () => {
  it("an unrecognised verdict lands as ambiguous but carries NO edits", async () => {
    // `ambiguous` is the parser's fallback for an unparseable verdict — and
    // ambiguous sits in the weak band the review queue surfaces. Left with
    // its suggestions attached, a garbled reply could have been applied to
    // the corpus with nobody reading it.
    stubReply(JSON.stringify({
      verdict: "probably-fine",              // not one of the four
      suggestedAnswer: "B",
      confidence: "high",
      correctedReason: "some reasoning",
      disputeNote: "",
      clearsDispute: true,
      suggestedStem: "A REWRITTEN STEM",
      suggestedOptions: { A: "rewritten one", B: "rewritten two" },
    }));
    const r = await triageMcq({ ...INPUT, mode: "audit" });
    expect(r.verdict).toBe("ambiguous");     // still surfaced for a human look
    expect(r.suggestedStem).toBeNull();
    expect(r.suggestedOptions).toBeNull();
    expect(r.suggestedAnswer).toBeNull();
  });

  it("a recognised verdict keeps its repair", async () => {
    stubReply(JSON.stringify({
      verdict: "change_answer", suggestedAnswer: "B", confidence: "high",
      correctedReason: "B is right", disputeNote: "", clearsDispute: true,
      suggestedStem: "A REWRITTEN STEM", suggestedOptions: { A: "one", B: "two" },
    }));
    const r = await triageMcq({ ...INPUT, mode: "audit" });
    expect(r.verdict).toBe("change_answer");
    expect(r.suggestedStem).toBe("A REWRITTEN STEM");
    expect(r.suggestedAnswer).toBe("B");
  });

  it("a suggested answer pointing at an option the repair dropped is discarded", async () => {
    stubReply(JSON.stringify({
      verdict: "change_answer", suggestedAnswer: "E", confidence: "high",
      correctedReason: "E", disputeNote: "", clearsDispute: true,
      suggestedStem: null, suggestedOptions: { A: "one", B: "two" },
    }));
    const r = await triageMcq({ ...INPUT });
    expect(r.suggestedAnswer).toBeNull();
  });

  it("a keyless question is never 'confirmed': with a key it is a change, without one it is ambiguous", async () => {
    stubReply(JSON.stringify({
      verdict: "confirm_key", suggestedAnswer: "B", confidence: "high",
      correctedReason: "B", disputeNote: "", clearsDispute: true, suggestedStem: null, suggestedOptions: null,
    }));
    const withKey = await triageMcq({ ...INPUT, currentAnswer: null, mode: "audit" });
    expect(withKey.verdict).toBe("change_answer");
    expect(withKey.suggestedAnswer).toBe("B");
    vi.unstubAllGlobals();
    stubReply(JSON.stringify({
      verdict: "confirm_key", suggestedAnswer: null, confidence: "high",
      correctedReason: "", disputeNote: "", clearsDispute: true, suggestedStem: null, suggestedOptions: null,
    }));
    const without = await triageMcq({ ...INPUT, currentAnswer: null, mode: "audit" });
    expect(without.verdict).toBe("ambiguous");
    expect(without.clearsDispute).toBe(false);
  });

  it("a fenced or prose-wrapped JSON reply still parses", async () => {
    stubReply("Here you go:\n```json\n" + JSON.stringify({
      verdict: "confirm_key", suggestedAnswer: "A", confidence: "medium",
      correctedReason: "fine", disputeNote: "ok", clearsDispute: true, suggestedStem: null, suggestedOptions: null,
    }) + "\n```\nDone.");
    const r = await triageMcq({ ...INPUT });
    expect(r.verdict).toBe("confirm_key");
    expect(r.suggestedAnswer).toBe("A");
    expect(r.confidence).toBe("medium");
  });

  it("audit mode uses the audit framing, not the adversarial dispute prompt", async () => {
    const ok = JSON.stringify({
      verdict: "confirm_key", suggestedAnswer: "A", confidence: "high",
      correctedReason: "fine", disputeNote: "", clearsDispute: true,
      suggestedStem: null, suggestedOptions: null,
    });
    const a = stubReply(ok);
    await triageMcq({ ...INPUT, mode: "audit" });
    expect(a.systems[0]).toContain("AUDITING");
    expect(a.systems[0]).not.toContain("A dispute means someone believes");
    expect(a.users[0]).toContain("MCQ AUDIT");
    vi.unstubAllGlobals();
    const d = stubReply(ok);
    await triageMcq({ ...INPUT, mode: "dispute" });
    expect(d.systems[0]).toContain("DISPUTED");
    expect(d.users[0]).toContain("DISPUTED MCQ");
  });

  it("the prompt promises no textbook passages and forbids invented citations", async () => {
    // This site carries no textbook index. A prompt that said passages were
    // "supplied at the end of the user message" would invite the model to
    // cite passages it never saw.
    const ok = JSON.stringify({
      verdict: "confirm_key", suggestedAnswer: "A", confidence: "high",
      correctedReason: "fine", disputeNote: "", clearsDispute: true, suggestedStem: null, suggestedOptions: null,
    });
    const a = stubReply(ok);
    await triageMcq({ ...INPUT, mode: "audit" });
    await triageMcq({ ...INPUT, mode: "dispute" });
    for (const sys of a.systems) {
      expect(sys).toContain("no textbook passages are supplied");
      expect(sys).toMatch(/Do NOT invent citations/);
      expect(sys).not.toMatch(/supplied at the end of the user message/);
    }
    for (const usr of a.users) expect(usr).not.toMatch(/PRESCRIBED TEXTBOOK PASSAGES/);
  });
});
