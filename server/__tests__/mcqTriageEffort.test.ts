import "./testDb";
import { describe, it, expect, afterEach, vi } from "vitest";
import "../storage";
import { triageMcq } from "../ai/mcqTriage";

// "Suggest with max effort" — the adjudicator's effort passthrough. Four
// things matter: the requested effort actually reaches the API, the shared
// reasoning+output budget scales up with it (a 3000 cap at max effort would
// truncate near-every call), the result attributes the rung it ran at so a
// cheap verdict can never masquerade as a max-effort one, and a deployment
// that rejects the rung degrades it rather than failing the call.

process.env.OPENAI_API_KEY = "test-key";
process.env.LLM_RETRY_BACKOFF_MS = "0";
afterEach(() => vi.unstubAllGlobals());

const OK = JSON.stringify({
  verdict: "confirm_key", suggestedAnswer: "A", confidence: "high",
  correctedReason: "fine", disputeNote: "checked", clearsDispute: true,
  suggestedStem: null, suggestedOptions: null,
});

function stubReply(content: string, echo?: Record<string, unknown>): { bodies: any[] } {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
    try { bodies.push(JSON.parse(init.body)); } catch { /* ignore */ }
    return {
      ok: true, status: 200,
      async json() { return { choices: [{ message: { content } }], usage: {}, model: "stub", ...echo }; },
      async text() { return ""; },
    } as any;
  }));
  return { bodies };
}

const INPUT = {
  code: "AD03", topicName: "Acid-Base", domain: "acid_base",
  stem: "A stem", options: [{ key: "A", text: "one" }, { key: "B", text: "two" }],
  currentAnswer: "A", currentReason: "because",
};

describe("suggest with max effort (effort passthrough)", () => {
  it("sends reasoning_effort=max and a larger shared token budget", async () => {
    const a = stubReply(OK);
    await triageMcq({ ...INPUT, effort: "max" });
    const [call] = a.bodies;
    expect(call.reasoning_effort).toBe("max");
    // The budget must grow with the rung: hidden reasoning at max effort eats
    // most of the default 3000 before the visible JSON starts.
    expect(call.max_completion_tokens).toBeGreaterThan(3000);
    // A reasoning-class model takes max_completion_tokens, never max_tokens
    // or a temperature (both 400).
    expect(call.max_tokens).toBeUndefined();
    expect(call.temperature).toBeUndefined();
    expect(call.response_format).toEqual({ type: "json_object" });
  });

  it("the default pass sends NO effort and keeps the cheap cap", async () => {
    const a = stubReply(OK);
    await triageMcq({ ...INPUT });
    const [call] = a.bodies;
    expect(call.reasoning_effort).toBeUndefined();
    expect(call.max_completion_tokens).toBe(3000);
  });

  it("attributes the verdict to the effort in force (the API's echo wins)", async () => {
    const a = stubReply(OK, { reasoning_effort: "xhigh" });
    const r = await triageMcq({ ...INPUT, effort: "max" });
    expect(a.bodies[0].reasoning_effort).toBe("max");
    expect(r.reasoningEffort).toBe("xhigh");
  });

  it("reports null effort on the default pass, so the UI can't badge it as max", async () => {
    stubReply(OK);
    const r = await triageMcq({ ...INPUT });
    expect(r.reasoningEffort).toBeNull();
  });

  it("a deployment that rejects the rung steps down (max → xhigh) instead of failing", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.reasoning_effort === "max") {
        return {
          ok: false, status: 400,
          async text() { return JSON.stringify({ error: { message: "Invalid value: 'max'. Supported values are: 'low', 'medium', 'high', 'xhigh' for parameter 'reasoning_effort'" } }); },
          async json() { return {}; },
        } as any;
      }
      return {
        ok: true, status: 200,
        async json() { return { choices: [{ message: { content: OK } }], usage: {}, model: "stub" }; },
        async text() { return ""; },
      } as any;
    }));
    const r = await triageMcq({ ...INPUT, effort: "max" });
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(["max", "xhigh"]);
    // What actually ran, not what was asked for.
    expect(r.reasoningEffort).toBe("xhigh");
    expect(r.verdict).toBe("confirm_key");
  });

  it("a truncated reply is retried once at a bigger cap, then refused rather than stored half-parsed", async () => {
    const bodies: any[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      calls += 1;
      const cut = calls === 1;
      return {
        ok: true, status: 200,
        async json() {
          return { choices: [{ message: { content: cut ? '{"verdict":"confirm_k' : OK }, finish_reason: cut ? "length" : "stop" }], usage: {}, model: "stub" };
        },
        async text() { return ""; },
      } as any;
    }));
    const r = await triageMcq({ ...INPUT });
    expect(calls).toBe(2);
    expect(bodies[1].max_completion_tokens).toBeGreaterThan(bodies[0].max_completion_tokens);
    expect(r.verdict).toBe("confirm_key");

    // Cut twice: an honest error, never a parse of the fragment.
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      async json() { return { choices: [{ message: { content: '{"verdict":"confirm_k' }, finish_reason: "length" }], usage: {}, model: "stub" }; },
      async text() { return ""; },
    }) as any));
    await expect(triageMcq({ ...INPUT })).rejects.toThrow(/truncated/);
  });

  it("a 429 is retried with backoff; a 401 is not", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 429, async text() { return "slow down"; } } as any;
      return {
        ok: true, status: 200,
        async json() { return { choices: [{ message: { content: OK } }], usage: {}, model: "stub" }; },
        async text() { return ""; },
      } as any;
    }));
    const r = await triageMcq({ ...INPUT });
    expect(n).toBe(2);
    expect(r.verdict).toBe("confirm_key");

    vi.unstubAllGlobals();
    let m = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      m += 1;
      return { ok: false, status: 401, async text() { return "bad key"; } } as any;
    }));
    await expect(triageMcq({ ...INPUT })).rejects.toThrow(/401/);
    expect(m).toBe(1);
  });
});
