// -----------------------------------------------------------------------------
// Thin, dependency-free OpenAI chat-completions client.
//
// Deliberately uses global fetch — no SDK, so package.json carries no model
// client and the production bundle gains nothing. One endpoint
// (/v1/chat/completions), one caller (server/ai/mcqTriage.ts).
//
// The client auto-selects the request shape for reasoning-class models
// (gpt-5.x, gpt-6, o-series — see isReasoningModel): those require
// `max_completion_tokens` and reject a non-default `temperature`, so we must
// NOT send `temperature` for them. They also take a `reasoning_effort`; a
// deployment that rejects the requested rung steps DOWN (max→xhigh→high→
// dropped) rather than aborting the call, and the result reports the rung
// actually in force.
// -----------------------------------------------------------------------------
import { openaiBase, openaiApiKey, isReasoningModel } from "./config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// The one allowed set of reasoning_effort tokens, lowest to highest. The
// route's query validation and the chat() passthrough both key off THIS
// constant so they can't drift apart. "max" is the top tier the deployed
// GPT-5.6 reasoning models expose, one rung above "xhigh".
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

// Base backoff between retry attempts (ms). Overridable via LLM_RETRY_BACKOFF_MS
// so tests can zero it and exercise retry paths without real-time sleeps.
function retryBackoffMs(): number {
  const v = Number(process.env.LLM_RETRY_BACKOFF_MS);
  return Number.isFinite(v) && v >= 0 ? v : 800;
}

// Hard per-call wall-clock cap on every upstream HTTP request. Without one, a
// single dropped connection (the request is sent, the response never comes)
// hangs its caller FOREVER — in the audit sweep that would freeze the run with
// the progress bar stuck and no error to surface. The cap converts a hang into
// an AbortError, which the retry loop treats as transient. Default 10 minutes:
// above the longest legitimate max-effort reasoning call (including the
// once-bigger truncation retry), far below "stuck until redeploy".
function llmTimeoutMs(): number {
  const v = Number(process.env.LLM_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 1000 ? v : 600_000;
}

/** True for the abort produced by AbortSignal.timeout (undici throws a
 *  DOMException named "TimeoutError"; some runtimes surface "AbortError"). */
function isTimeoutErr(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Only applied to non-reasoning models; ignored for gpt-5.x, gpt-6 and o-series. */
  temperature?: number;
  /** Force strict JSON object output. */
  json?: boolean;
  /** Reasoning-class models only: how hard to think. Never sent for classic
   *  models (they 400 on the parameter). Omitted = the API's default. */
  reasoningEffort?: ReasoningEffort;
}

export interface ChatResult {
  content: string;
  usage: { prompt: number; completion: number; total: number };
  model: string;
  /** The reasoning effort in force for this call: the API's echoed value when
   *  present, else what was actually SENT (which the 400 fallback may have
   *  downgraded from what was requested). Undefined when none was requested. */
  reasoningEffort?: string;
  /** The API's completion finish reason ("stop", "length", ...). "length"
   *  means the output was cut off at max_completion_tokens — on reasoning
   *  models the hidden reasoning can eat the budget, truncating the visible
   *  answer mid-value. Callers that parse JSON must treat this as a retryable
   *  truncation, not a bad model. */
  finishReason?: string;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const key = openaiApiKey();
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

export class LlmError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`OpenAI HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
  }
}

/**
 * The model's answer was cut off at max_completion_tokens even after a retry
 * at a much larger cap. On reasoning models the cap is SHARED with hidden
 * reasoning tokens, so "length" can mean the visible answer is half a JSON
 * value. This error is the HONEST terminal outcome: callers must surface it,
 * never parse-and-store the truncated content as if it were complete.
 */
export class LlmTruncationError extends Error {
  finalCap: number;
  constructor(finalCap: number, context: string) {
    super(`model output truncated at max_completion_tokens=${finalCap} even after a retry at a larger cap (${context})`);
    this.name = "LlmTruncationError";
    this.finalCap = finalCap;
  }
}

/** The larger cap a truncated call is retried at: 4x the original, min 16k. */
function retryCapFor(cap: number): number {
  return Math.max(cap * 4, 16000);
}

/**
 * The next rung DOWN the degrade ladder, or null to drop the effort parameter
 * entirely and take the API default: max -> xhigh -> high -> dropped. A
 * deployment that lacks "max" almost certainly speaks "xhigh", so the top
 * rung steps down one rung rather than straight to "high".
 */
function degradeEffort(rejected: string): string | null {
  if (rejected === "max") return "xhigh";
  if (rejected !== "high") return "high";
  return null;
}

/**
 * One chat completion. Retries 429/5xx with exponential backoff (3 tries).
 * Throws LlmError with the upstream status + body on non-retryable failure so
 * callers can surface a precise message (e.g. bad model string, missing key).
 */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const reasoning = isReasoningModel(opts.model);
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
  };
  // Token cap: reasoning models use max_completion_tokens; classic use max_tokens.
  const cap = opts.maxTokens ?? 4000;
  if (reasoning) body.max_completion_tokens = cap;
  else body.max_tokens = cap;
  // Temperature: only for classic models. Reasoning models 400 on non-default.
  if (!reasoning && opts.temperature !== undefined) body.temperature = opts.temperature;
  // Reasoning effort: reasoning-class models only — classic models 400 on it.
  if (reasoning && opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  if (opts.json) body.response_format = { type: "json_object" };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${openaiBase()}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(llmTimeoutMs()),
      });
      if (!res.ok) {
        const text = await res.text();
        // A model that doesn't know the requested effort token must degrade
        // the EFFORT, not abort the whole adjudication: step down one rung,
        // and if even "high" is refused, drop the parameter and take the API
        // default. Logged so the rejection is visible; the return value
        // reports the effort actually in force.
        if (res.status === 400 && typeof body.reasoning_effort === "string" && /reasoning[_.\s]?effort/i.test(text)) {
          const rejected = body.reasoning_effort;
          const detail = text.slice(0, 300).trim();
          const next = degradeEffort(rejected);
          if (next) {
            console.error(`[llm] model rejected reasoning_effort=${rejected}; falling back to ${next} — API said: ${detail}`);
            body.reasoning_effort = next;
          } else {
            console.error(`[llm] model rejected reasoning_effort=${rejected}; dropping the parameter — API said: ${detail}`);
            delete body.reasoning_effort;
          }
          // A degrade step is not a transient failure — don't let it eat the
          // retry budget, or the full max→xhigh→high→drop chain can't finish.
          attempt--;
          continue; // retry immediately with the downgraded request
        }
        if (res.status === 429 || res.status >= 500) {
          lastErr = new LlmError(res.status, text);
          await new Promise((r) => setTimeout(r, retryBackoffMs() * Math.pow(2, attempt)));
          continue;
        }
        throw new LlmError(res.status, text);
      }
      const json: any = await res.json();
      const content: string = json.choices?.[0]?.message?.content ?? "";
      const u = json.usage ?? {};
      return {
        content,
        usage: {
          prompt: u.prompt_tokens ?? 0,
          completion: u.completion_tokens ?? 0,
          total: u.total_tokens ?? 0,
        },
        model: json.model ?? opts.model,
        // Prefer the API's echo; fall back to what this call actually SENT.
        reasoningEffort: (typeof json.reasoning_effort === "string" ? json.reasoning_effort : undefined)
          ?? (typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined),
        finishReason: typeof json.choices?.[0]?.finish_reason === "string" ? json.choices[0].finish_reason : undefined,
      };
    } catch (err) {
      lastErr = isTimeoutErr(err)
        ? new Error(`LLM call timed out after ${llmTimeoutMs()}ms (model ${opts.model})`)
        : err;
      if (err instanceof LlmError && err.status < 500 && err.status !== 429) throw err;
      await new Promise((r) => setTimeout(r, retryBackoffMs() * Math.pow(2, attempt)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("chat failed");
}

/**
 * chat() with the standard truncation ladder: when the answer comes back with
 * finish_reason "length" (the shared reasoning+output budget ran out before
 * the visible answer finished), retry ONCE at a much larger cap; if even that
 * is cut, throw {@link LlmTruncationError} rather than hand the caller a
 * half-answer to parse-and-store. Every JSON-parsing call goes through this —
 * a bare chat() call would silently re-run at the same too-small cap forever,
 * or store truncated output as if it were complete.
 */
export async function chatWithLengthRetry(opts: ChatOptions & { retryMaxTokens?: number }): Promise<ChatResult> {
  const { retryMaxTokens, ...base } = opts;
  let res = await chat(base);
  if (res.finishReason === "length") {
    const cap = retryMaxTokens ?? retryCapFor(base.maxTokens ?? 4000);
    console.error(`[llm] output truncated at max_completion_tokens=${base.maxTokens ?? 4000} (model ${base.model}); retrying once at ${cap}`);
    res = await chat({ ...base, maxTokens: cap });
    if (res.finishReason === "length") throw new LlmTruncationError(cap, `model ${base.model}`);
  }
  return res;
}

/** Whether a runtime key is configured (does not validate it). */
export function hasApiKey(): boolean {
  return openaiApiKey().length > 0;
}
