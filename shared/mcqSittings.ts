// -----------------------------------------------------------------------------
// Exam sittings — which ANZCA Primary paper(s) an MCQ is known from, as a
// (year, half) pair, derived from the two places the corpus records it:
//
//   · the question CODE, for the 2014+ papers: "25A-1", "18B-67", "17Ax-58",
//     "14A 146", "16B-x2" all start with a two-digit year and the sitting
//     letter (A = first sitting of the year, B = second). "OFF-2018-Q114" is
//     the officially released 2018 paper — the year is known, the sitting is
//     not.
//   · the PAPERS tags, for the 1996–2015 Black Bank questions: "Mar99",
//     "Jul97", "Feb00", and a scatter of long forms the transcription left
//     behind ("Apr 2001", "July 2000", "Jul-06", "Mar 05"). The first sitting
//     is held in the first half of the year and the second in the second, so
//     the month decides the half. A tag may also be a bare sitting key in the
//     coded-paper shape ("13B", "17B") — the Black Bank cross-referenced a
//     few of its questions to the 2013–2017 papers that way, and a question
//     recalled from a sitting other than the one its own code names carries
//     that sitting as a tag. The arrays also carry parse fragments ("d",
//     "ackmo", "Alt version") which carry no date and are ignored.
//
// One question can belong to several sittings (a Black Bank question repeated
// across papers); a question with neither shape of evidence has none.
//
// The server caches the result in mcqs.sittings as a space-delimited, space-
// padded list of keys — " 2025A 1999B " — so a year or sitting filter is one
// substring test (sittingScopeSql) instead of a re-parse per row. The client
// re-derives from the record for display. Both sides use THIS file, so the
// rule lives in one place.
// -----------------------------------------------------------------------------

export type SittingHalf = "A" | "B";

export interface McqSitting {
  year: number;               // four-digit
  half: SittingHalf | null;   // null = year known, sitting not (the OFF-… codes)
}

const CODE_RE = /^(\d{2})([AB])/i;                     // 25A-1, 18B-67, 17Ax-58, 14A 146, 16B-x2
const OFFICIAL_RE = /^OFF-(\d{4})-Q/i;                 // OFF-2018-Q114
const PAPER_RE = /^([A-Za-z]{3,9})[\s-]*(\d{2}|\d{4})$/; // Mar99, Jul 01, Apr 2001, July-07
const PAPER_KEY_RE = /^(\d{2})([AB])$/i;                   // 13B, 17B — a bare sitting as a tag
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Two-digit years: the Black Bank starts in 1996 and the coded papers run
 *  2014–2026, so 50 is a safe pivot for as long as this bank exists. */
function fourDigit(yy: number): number {
  return yy >= 50 ? 1900 + yy : 2000 + yy;
}

const HALF_ORDER: Record<string, number> = { A: 0, B: 1, "": 2 };

/** Newest year first; within a year, first sitting, second, then unknown. */
export function compareSittings(a: McqSitting, b: McqSitting): number {
  if (a.year !== b.year) return b.year - a.year;
  return HALF_ORDER[a.half ?? ""] - HALF_ORDER[b.half ?? ""];
}

/** "2025A", "1999B", or "2018" when the sitting is unknown. */
export function sittingKey(s: McqSitting): string {
  return `${s.year}${s.half ?? ""}`;
}

/** The inverse of sittingKey; null for anything that is not one. */
export function parseSittingKey(key: string): McqSitting | null {
  const m = /^(\d{4})([AB])?$/.exec(String(key ?? "").trim());
  if (!m) return null;
  return { year: Number(m[1]), half: (m[2] as SittingHalf | undefined) ?? null };
}

/** How the college names them: "2025.1", "2025.2"; a bare "2018" when the
 *  sitting is unknown. */
export function sittingLabel(s: McqSitting): string {
  return s.half ? `${s.year}.${s.half === "A" ? 1 : 2}` : String(s.year);
}

export function halfLabel(half: SittingHalf): string {
  return half === "A" ? "1st sitting (A)" : "2nd sitting (B)";
}

/** Every sitting a question is known from, deduplicated, newest first. */
export function parseSittings(code: string, papers: readonly string[] = []): McqSitting[] {
  const out = new Map<string, McqSitting>();
  const add = (s: McqSitting) => { out.set(sittingKey(s), s); };

  const c = String(code ?? "").trim();
  const coded = CODE_RE.exec(c);
  if (coded) {
    add({ year: fourDigit(Number(coded[1])), half: coded[2].toUpperCase() as SittingHalf });
  } else {
    const official = OFFICIAL_RE.exec(c);
    if (official) add({ year: Number(official[1]), half: null });
  }

  for (const raw of papers ?? []) {
    const tag = String(raw ?? "").trim();
    const key = PAPER_KEY_RE.exec(tag);
    if (key) {
      add({ year: fourDigit(Number(key[1])), half: key[2].toUpperCase() as SittingHalf });
      continue;
    }
    const m = PAPER_RE.exec(tag);
    if (!m) continue;
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (month < 0) continue;
    const year = m[2].length === 4 ? Number(m[2]) : fourDigit(Number(m[2]));
    add({ year, half: month < 6 ? "A" : "B" });
  }

  return Array.from(out.values()).sort(compareSittings);
}

/** The cached-column form: space-padded so every key is bounded by spaces
 *  and a substring test cannot match across two keys. "" when there are none. */
export function sittingsColumn(sittings: readonly McqSitting[]): string {
  return sittings.length ? ` ${sittings.map(sittingKey).join(" ")} ` : "";
}

/** The needle a filter looks for inside the cached column. A year alone is
 *  " 2025" — the start of " 2025A ", " 2025B " and " 2025 " alike; a half alone
 *  is "A " — the end of every first-sitting key; both is the whole key. */
export function sittingNeedle(year: number | undefined, half: SittingHalf | undefined): string {
  if (year !== undefined && half) return ` ${year}${half} `;
  if (year !== undefined) return ` ${year}`;
  return `${half} `;
}

/** The SQL predicate over alias `m` (the mcqs table) for "any of these years"
 *  AND "this half", each optional; null when neither is asked for. Pure string
 *  building — the caller binds `params` in order. */
export function sittingScopeSql(
  years: readonly number[] | undefined,
  half: SittingHalf | undefined,
): { sql: string; params: string[] } | null {
  const ys = (years ?? []).filter((y) => Number.isInteger(y) && y > 0);
  if (ys.length === 0 && !half) return null;
  const needles = ys.length ? ys.map((y) => sittingNeedle(y, half)) : [sittingNeedle(undefined, half)];
  const sql = needles.map(() => "instr(m.sittings, ?) > 0").join(" OR ");
  return { sql: needles.length > 1 ? `(${sql})` : sql, params: needles };
}
