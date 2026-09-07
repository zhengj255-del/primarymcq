// -----------------------------------------------------------------------------
// MCQ adjudicator — the reasoning model works one question from first
// principles and proposes a resolution the user can accept or dismiss.
//
// Two framings, one contract:
//   - "dispute": someone believes the keyed answer is wrong, the question is
//     ambiguous, or the explanation is faulty. Adjudicate.
//   - "audit": a routine quality sweep over a question nobody flagged. Most
//     keys are right; a MISSING key (exam recall) should be supplied rather
//     than treated as an error. Verify.
// Either way the model returns a structured verdict:
//   - verdict: "confirm_key" | "change_answer" | "ambiguous" | "flawed"
//   - suggestedAnswer: 'A'..'E' | null
//   - a corrected reason (explanation), an optional stem / options repair, and
//     whether the dispute flag should clear.
//
// This module WRITES NOTHING. The route returns the verdict for the user to
// review in the edit dialog, and the audit sweep (server/mcqAudit.ts) stores
// it for later apply/dismiss. Grounding: this site carries no textbook index
// (that is the tracker's machinery), so the model reasons from its own
// knowledge of the prescribed texts and is told not to invent citations.
// -----------------------------------------------------------------------------

import { chatWithLengthRetry, type ReasoningEffort } from "./llm";
import { mcqModel } from "./config";

export interface McqTriageInput {
  code: string;                 // display code, e.g. "RE17"
  topicName: string;
  domain: string;
  stem: string;
  options: Array<{ key: string; text: string }>; // A..E
  currentAnswer: string | null; // the keyed answer, if any ('A'..'E')
  currentReason: string;        // the existing explanation
  loCodes?: string[];
  // "dispute" (default): adjudicate a question someone flagged as wrong.
  // "audit": sweep an ordinary corpus question — most keys are right, and a
  // missing key (exam recall) should be supplied rather than treated as an
  // error. Same result shape either way, so one apply path serves both.
  mode?: "dispute" | "audit";
  // Reasoning effort for the call. Omitted = the API's default (the cheap
  // everyday pass). "max" is the user-facing "suggest with max effort"
  // option — the top rung.
  effort?: ReasoningEffort;
}

export type McqTriageVerdict =
  | "confirm_key"   // keyed answer is correct as-is
  | "change_answer" // a different option is the best answer
  | "ambiguous"     // >1 defensible answer; stem needs a fix, keep disputed
  | "flawed";       // question is unsalvageable as written, keep disputed

export interface McqTriageResult {
  verdict: McqTriageVerdict;
  suggestedAnswer: string | null; // 'A'..'E' or null
  confidence: "high" | "medium" | "low";
  correctedReason: string;        // clean explanation for the chosen answer
  disputeNote: string;            // one-line rationale for the verdict
  clearsDispute: boolean;         // true → accepting resolves the dispute flag
  suggestedStem: string | null;   // rewritten stem, or null to keep as-is
  suggestedOptions: Record<string, string> | null; // rewritten A..E, or null to keep as-is
  model: string;                  // echo the model that produced this
  // The reasoning effort actually in force (the API's echo, else what was
  // requested). Null when none was requested — the default cheap pass. Lets
  // the UI attribute a verdict to max effort vs the everyday suggestion.
  reasoningEffort: string | null;
}

// Shared tail of both prompts: the repair licence, the rules and the JSON
// contract are identical; only the framing (dispute vs audit) differs.
const REPAIR_RULES = `You may also REPAIR the question itself when it is broken. You are editing the full question — stem, options, answer, and explanation are all in scope:
- If the stem is ambiguous, under-specified, or has a wrong premise, provide a corrected stem in "suggestedStem".
- If an option is missing, a placeholder (e.g. "?"), duplicated, or wrong, provide a full corrected A..E option set in "suggestedOptions".
- Preserve the question's intent and difficulty; make the smallest edit that makes it a clean, single-best-answer ANZCA Primary question. Keep the same number of options where possible.
- When you repair a stem/options so a single best answer now exists, you SHOULD return verdict "change_answer" (or "confirm_key" if the original key becomes correct), set suggestedAnswer, and set clearsDispute true — the repair resolves the problem.`;

const GROUNDING_RULE = `- GROUNDING: no textbook passages are supplied. Base every judgement on the standard prescribed texts of the ANZCA Primary examination as you know them, using their terminology, values and units. Do NOT invent citations, page numbers or quotations; name a source in correctedReason only when you are certain of it.`;

const JSON_CONTRACT = `Return ONLY a JSON object with EXACTLY these keys:
{
  "verdict": "confirm_key" | "change_answer" | "ambiguous" | "flawed",
  "suggestedAnswer": "A" | "B" | "C" | "D" | "E" | null,
  "confidence": "high" | "medium" | "low",
  "correctedReason": string,
  "disputeNote": string,
  "clearsDispute": boolean,
  "suggestedStem": string | null,
  "suggestedOptions": { "A": string, "B": string, ... } | null
}`;

const SYSTEM = `You are a senior ANZCA Primary examiner adjudicating a DISPUTED multiple-choice question in anaesthetic basic sciences (pharmacology, physiology, physics/measurement, anatomy). A dispute means someone believes the keyed answer is wrong, the question is ambiguous, or the explanation is faulty.

Your job: work the question independently from first principles, ignore the existing key until you have your own answer, then compare.

Decide ONE verdict:
- "confirm_key": the existing keyed answer is correct. Only choose this if you are confident the key is right.
- "change_answer": a DIFFERENT option is unambiguously the single best answer. Provide it.
- "ambiguous": two or more options are defensibly correct as the stem is written, OR the stem is under-specified so no single answer is safe. Keep it disputed.
- "flawed": the question is unsalvageable as written (wrong premise, no correct option, internally contradictory). Keep it disputed.

${REPAIR_RULES}

Rules:
- Base every judgement on established ANZCA Primary-level science. Prefer the standard exam-correct answer, not edge-case pedantry.
- If you change or confirm an answer, the corrected reason must justify the chosen option AND briefly say why the key was wrong (when it was).
- Be decisive: reserve "ambiguous"/"flawed" for questions you cannot repair into a single-best-answer form.
- correctedReason: <=80 words, precise, exam-focused. Bold nothing — plain text.
- confidence reflects how sure you are of the verdict.
- suggestedStem: only when you actually change the stem; otherwise null.
- suggestedOptions: only when you actually change one or more options; return the COMPLETE set (all keys the question should have), not just the changed ones. Otherwise null.
- suggestedAnswer must refer to a key that exists in suggestedOptions (or the current options when suggestedOptions is null).
- clearsDispute: true for confirm_key/change_answer (a resolvable outcome, including after a repair); false only for ambiguous/flawed you could not repair.
${GROUNDING_RULE}

${JSON_CONTRACT}
For confirm_key, suggestedAnswer must equal the current key. No prose outside the JSON.`;

// Audit framing: same verdicts, same JSON contract, but the prior is inverted —
// nobody has flagged this question, so most keys are correct and the job is
// verification, not adjudication. Without this reframing the dispute prompt
// ("someone believes the keyed answer is wrong") primes the model to hunt for
// a change on all ~1800 questions of a corpus sweep.
const AUDIT_SYSTEM = `You are a senior ANZCA Primary examiner AUDITING a multiple-choice question from a study bank in anaesthetic basic sciences (pharmacology, physiology, physics/measurement, anatomy). Nobody has disputed this question — this is a routine quality sweep, and most questions in the bank are sound.

Your job: work the question independently from first principles, ignore the existing key until you have your own answer, then compare.

Decide ONE verdict:
- "confirm_key": the existing keyed answer is correct. This is the expected verdict for most questions — choose it whenever the key matches your independent answer.
- "change_answer": a DIFFERENT option is unambiguously the single best answer, OR the question has NO keyed answer (exam recall) and you can determine the single best answer. Provide it.
- "ambiguous": two or more options are defensibly correct as the stem is written, OR the stem is under-specified so no single answer is safe.
- "flawed": the question is unsalvageable as written (wrong premise, no correct option, internally contradictory).

${REPAIR_RULES}

Rules:
- Base every judgement on established ANZCA Primary-level science. Prefer the standard exam-correct answer, not edge-case pedantry.
- Do NOT manufacture problems: reserve change_answer for keys that are clearly wrong, and ambiguous/flawed for questions you could not repair into a single-best-answer form. Minor stylistic imperfections are NOT defects.
- If you change a key or supply a missing one, the corrected reason must justify the chosen option (and briefly say why the old key was wrong, when there was one).
- correctedReason: <=80 words, precise, exam-focused. Always provide it for the answer you chose — it becomes the stored explanation for questions that lack one. Bold nothing — plain text.
- confidence reflects how sure you are of the verdict.
- suggestedStem: only when you actually change the stem; otherwise null.
- suggestedOptions: only when you actually change one or more options; return the COMPLETE set (all keys the question should have), not just the changed ones. Otherwise null.
- suggestedAnswer must refer to a key that exists in suggestedOptions (or the current options when suggestedOptions is null).
- clearsDispute: true for confirm_key/change_answer; false for ambiguous/flawed.
${GROUNDING_RULE}

${JSON_CONTRACT}
For confirm_key, suggestedAnswer must equal the current key. A question with no current key can never be confirm_key. No prose outside the JSON.`;

function parseJsonLoose<T>(raw: string): T {
  try { return JSON.parse(raw) as T; } catch { /* fall through */ }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]) as T; } catch { /* continue */ } }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1)) as T;
  throw new Error("AI did not return valid JSON");
}

function optionsBlock(opts: Array<{ key: string; text: string }>): string {
  return opts.map((o) => `${o.key}. ${o.text}`).join("\n");
}

const VALID_KEYS = new Set(["A", "B", "C", "D", "E"]);
const VALID_VERDICTS = new Set<McqTriageVerdict>(["confirm_key", "change_answer", "ambiguous", "flawed"]);

// Base completion cap per requested effort (unlisted efforts use the 3000
// default). The cap is shared with hidden reasoning, and higher rungs reason
// for longer before the visible JSON starts.
const EFFORT_TOKEN_CAPS: Record<string, number> = { high: 6000, xhigh: 9000, max: 12000 };

/**
 * Adjudicate one MCQ with the reasoning model. Throws on API/parse failure so
 * the route can surface the upstream status; never invents fields.
 */
export async function triageMcq(input: McqTriageInput): Promise<McqTriageResult> {
  const audit = input.mode === "audit";
  const user = [
    audit ? `MCQ AUDIT — verify this question.` : `DISPUTED MCQ — adjudicate.`,
    `Code: ${input.code} | Topic: ${input.topicName} | Domain: ${input.domain}${input.loCodes?.length ? ` | LOs: ${input.loCodes.join(", ")}` : ""}`,
    ``,
    `STEM:`,
    input.stem || "(empty)",
    ``,
    `OPTIONS:`,
    optionsBlock(input.options),
    ``,
    `CURRENT KEYED ANSWER: ${input.currentAnswer ?? "(none)"}`,
    `EXISTING EXPLANATION: ${input.currentReason || "(none)"}`,
  ].join("\n");

  const model = mcqModel();
  // The adjudicator is a reasoning model and this cap is shared with its
  // hidden reasoning — a bare call at 3000 could truncate the JSON and surface
  // as a parse error on EVERY retry of the same question. Higher effort thinks
  // longer, so the shared budget scales with it; chatWithLengthRetry still
  // retries once bigger if even this is cut.
  const res = await chatWithLengthRetry({
    model,
    json: true,
    maxTokens: EFFORT_TOKEN_CAPS[input.effort ?? ""] ?? 3000,
    reasoningEffort: input.effort,
    messages: [
      { role: "system", content: audit ? AUDIT_SYSTEM : SYSTEM },
      { role: "user", content: user },
    ],
  });

  const raw = parseJsonLoose<Partial<McqTriageResult>>(res.content);

  // Coerce + validate defensively — never trust the shape blindly.
  const verdictWasValid = VALID_VERDICTS.has(raw.verdict as McqTriageVerdict);
  let verdict = (verdictWasValid ? raw.verdict : "ambiguous") as McqTriageVerdict;

  let suggestedAnswer: string | null = null;
  if (typeof raw.suggestedAnswer === "string" && VALID_KEYS.has(raw.suggestedAnswer.toUpperCase())) {
    suggestedAnswer = raw.suggestedAnswer.toUpperCase();
  }
  // confirm_key must echo the current key; if the model dropped it, restore it.
  if (verdict === "confirm_key" && !suggestedAnswer && input.currentAnswer) {
    suggestedAnswer = input.currentAnswer;
  }
  // A keyless question cannot be "confirmed": with a suggested answer that is
  // really a change (the audit path for exam recalls); without one it's a
  // non-verdict — downgrade rather than store a vacuous confirmation.
  if (verdict === "confirm_key" && !input.currentAnswer) {
    verdict = suggestedAnswer ? "change_answer" : "ambiguous";
  }

  const confidence = (["high", "medium", "low"].includes(String(raw.confidence))
    ? raw.confidence
    : "medium") as "high" | "medium" | "low";

  // clearsDispute only makes sense for resolvable verdicts.
  const resolvable = verdict === "confirm_key" || verdict === "change_answer";
  const clearsDispute = resolvable && raw.clearsDispute !== false;

  // Optional full-question repair. Only surface a stem/options edit when the
  // model actually returned one; otherwise null = keep the existing value.
  let suggestedStem =
    typeof raw.suggestedStem === "string" && raw.suggestedStem.trim()
      ? raw.suggestedStem.trim()
      : null;

  let suggestedOptions: Record<string, string> | null = null;
  if (raw.suggestedOptions && typeof raw.suggestedOptions === "object") {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.suggestedOptions as Record<string, unknown>)) {
      const key = String(k).toUpperCase();
      if (VALID_KEYS.has(key) && typeof v === "string" && v.trim()) clean[key] = v.trim();
    }
    if (Object.keys(clean).length > 0) suggestedOptions = clean;
  }
  // A suggested answer that points at a non-existent repaired option is unsafe — drop it.
  if (suggestedAnswer && suggestedOptions && !suggestedOptions[suggestedAnswer]) {
    suggestedAnswer = null;
  }

  // A response whose `verdict` was missing or unrecognised is a response we
  // could not parse — so none of its other fields are trustworthy either.
  // "ambiguous" is only a safe LANDING PLACE for such a row, not a licence to
  // carry its edits: ambiguous sits in the weak band, which the review queue
  // surfaces, so an unparseable reply with an intact suggestedStem could have
  // been applied to the corpus without anyone reading it. Keep the row (it
  // flags a question worth a human look) and drop the edits.
  if (!verdictWasValid) {
    suggestedAnswer = null;
    suggestedStem = null;
    suggestedOptions = null;
  }

  return {
    verdict,
    suggestedAnswer,
    confidence,
    correctedReason: (raw.correctedReason ?? "").toString().trim(),
    disputeNote: (raw.disputeNote ?? "").toString().trim(),
    clearsDispute,
    suggestedStem,
    suggestedOptions,
    model: res.model ?? model,
    reasoningEffort: res.reasoningEffort ?? input.effort ?? null,
  };
}
