// -----------------------------------------------------------------------------
// Configuration for the one AI feature this site has: the MCQ adjudicator
// (server/ai/mcqTriage.ts) and the corpus sweep built on it (server/mcqAudit.ts).
//
// Every value is read from the environment AT CALL TIME, not at module load:
// the key is a Fly secret, and the tests toggle it between cases. With no key
// the feature is simply off — the routes answer 503, the pages say so, and
// nothing else in the app changes. There is no other model, no embedding
// store and no second credential.
// -----------------------------------------------------------------------------

/** OpenAI-compatible chat-completions base, no trailing slash. */
export function openaiBase(): string {
  return (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
}

/** The API key. Empty string means "not configured". */
export function openaiApiKey(): string {
  return process.env.OPENAI_API_KEY ?? "";
}

/**
 * The adjudicator model. gpt-5.6-sol is a reasoning-class model: it accepts
 * ONLY `max_completion_tokens` (not `max_tokens`) and the default temperature,
 * and takes a `reasoning_effort`. The client (llm.ts) picks that request
 * shape from isReasoningModel() below, so pointing MCQ_AI_MODEL at a classic
 * model is safe — it is sent without either parameter.
 */
export const MCQ_AI_MODEL_DEFAULT = "gpt-5.6-sol";
export function mcqModel(): string {
  return process.env.MCQ_AI_MODEL || MCQ_AI_MODEL_DEFAULT;
}

/**
 * Reasoning-class models that must use the `reasoning` request shape
 * (max_completion_tokens, no custom temperature, `reasoning_effort` sent).
 * Matched as a prefix set so dated aliases (gpt-5.6-sol-2026-xx-xx) are
 * covered. o-series included.
 */
const REASONING_PREFIXES = ["gpt-5", "gpt-6", "o1", "o3", "o4"];
export function isReasoningModel(model: string): boolean {
  return REASONING_PREFIXES.some((p) => model.startsWith(p));
}
