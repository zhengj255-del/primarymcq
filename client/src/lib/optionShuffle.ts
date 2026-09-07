// -------------------------------------------------------------------------------------------------
// MCQ option display shuffle.
//
// The study runner shuffles the ORDER options are rendered in, per serve, so a
// repeated question can't be answered from positional memory ("it's the third
// one"). Everything else stays canonical on purpose:
//   - each option keeps its own letter chip (A stays labelled A wherever it
//     sits), so the letter the runner POSTs, the reveal highlight, the
//     "answer is C" feedback line, the 300+ bank explanations that name
//     letters in prose, and the session summary all still resolve;
//   - the server never learns display order exists — grading, the boot-time
//     regrade of stored attempts, SRS and stats all live purely in canonical
//     letter space.
//
// The permutation is DETERMINISTIC per serve (seeded from question + serve
// index + sitting), so re-renders and rating-undo show a stable order, while
// an Again-requeue or a new sitting reshuffles.
//
// Questions whose option TEXT is order- or letter-dependent ("All of the
// above", "B & D") are served in canonical order — shuffling them changes
// what the text means. The detector is deliberately trigger-happy: a false
// positive only costs a question its shuffle, never its correctness. Sorted
// numeric ladders (5% | 10% | 30% | ...) are also exempted to keep the exam
// convention of ordered numeric options.
// -------------------------------------------------------------------------------------------------

export const OPTION_KEYS = ["A", "B", "C", "D", "E"] as const;
export type McqOptionKey = (typeof OPTION_KEYS)[number];

/** FNV-1a of the seed key — same construction the server's SRS fuzz uses, so
 *  the same serve always maps to the same permutation. */
export function optionSeed(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fisher–Yates with a mulberry32 PRNG: the full permutation space, driven by
 *  a seed rather than Math.random, so a given serve is reproducible. */
export function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
  const out = [...arr];
  let s = seed >>> 0 || 1;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Options that summarise the whole list ("All of the above") or point at
 *  another option's position. Requires the POSITIONAL sense: a bare "above"
 *  is ordinary clinical prose ("pH above 7.40", "gas above liquid") and
 *  exempting on it alone cost 18 questions their shuffle for nothing. */
function summarisesOtherOptions(t: string): boolean {
  if (/\b(all|none|any|both|neither|either|more than one|only one)\b[^.]{0,30}\b(above|below)\b/i.test(t)) return true;
  if (/\b(of|than|listed)\s+the\s+(above|below)\b/i.test(t)) return true;
  // The whole option is just "none" / "all" — an abbreviated "none of the
  // above" that names no content of its own, so it only makes sense last.
  if (/^(all|none|both|neither|either)\.?$/i.test(t)) return true;
  // Same shape without "above" — absent from today's bank, but a newly
  // imported paper phrasing it this way must not slip through.
  if (/\b(all|none|any|both|neither|either|more than one|only one)\s+of\s+(the\s+)?(these|those|them|following|listed|preceding|statements?|options?|answers?|choices?)\b/i.test(t)) return true;
  return false;
}

/** True when re-ordering these option texts would change their meaning, or
 *  make the list read as broken. Fail-safe by design: a false positive only
 *  forfeits the shuffle, never correctness. */
export function orderDependentOptions(texts: readonly string[]): boolean {
  for (const t of texts) {
    if (summarisesOtherOptions(t)) return true;
    // Cross-references to another option by letter: "B & D", "both A and B".
    if (/\b[A-E]\s*(and|or|&)\s*[A-E]\b/.test(t)) return true;
    if (/\b(option|answer)s?\s+[A-E]\b/i.test(t)) return true;
    if (/\b(first|last)\s+(option|answer)\b/i.test(t)) return true;
  }

  // Options that ARE letters ("A", "B", "C (no change)") — figure and
  // classification questions like the Mapleson circuits. Shuffled, the list
  // renders as an A–E enumeration out of alphabetical order, which reads as
  // a rendering fault and invites clicking by the option's own letter rather
  // than its chip. Two or more, so one incidental single letter is ignored.
  const isLetterOnly = (t: string) => /^\(?[A-F]\)?(\s*\([^)]*\))?\.?$/.test(t);
  if (texts.filter(isLetterOnly).length >= 2) return true;

  // Options that walk a labelled diagram in order ("Curve A is shifted…",
  // "at point C, …", "B occurs due to…"): the sequence IS the explanation.
  // The >= 2 threshold keeps ordinary prose ("A competitive antagonist…")
  // out of it.
  const labelsAPoint = (t: string) =>
    /^(at\s+)?(point|curve|line|position|region|phase|label)\s+[A-E]\b/i.test(t) ||
    /^[A-E]\s+(is|are|was|occurs|corresponds|equals|represents|indicates|shows|denotes|has|reflects)\b/.test(t);
  if (texts.filter(labelsAPoint).length >= 2) return true;

  // Quantity sets — every option opens with a number ("30 min | 1 hr | 2 hr",
  // "10 to 30 ml", "<80%", "1:3"). Exam convention presents these in a
  // deliberate order, and a scrambled dose ladder reads as a fault. Matching
  // on shape rather than parsed magnitude catches the ranges, unit changes
  // and ratios that a single-number comparison misses.
  if (texts.length > 1 && texts.every((t) => /^[<>~≥≤±+-]?\s*\d/.test(t))) return true;

  return false;
}

/**
 * The order the runner should render options in for one serve.
 * Returns CANONICAL keys — only their sequence changes; the letters travel
 * with their text, and the caller must keep POSTing the canonical key.
 */
export function presentOptionKeys(
  options: Record<string, string | undefined>,
  seedKey: string,
): McqOptionKey[] {
  const canonical = OPTION_KEYS.filter((k) => options[k]?.trim());
  if (canonical.length < 2) return canonical;
  if (orderDependentOptions(canonical.map((k) => options[k] as string))) return canonical;
  return seededShuffle(canonical, optionSeed(seedKey));
}
