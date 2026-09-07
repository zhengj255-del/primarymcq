// -------------------------------------------------------------------------------------------------
// THE Melbourne calendar — the single definition of "which day is it" for the
// whole server.
//
// These helpers lived in storage.ts, which meant every module that needed to
// know what "today" is had to import storage.ts and drag the whole database
// layer (and its module-load side effects) in with it. Anything storage.ts
// itself imports therefore could not use them at all — a leaf module that
// wanted a Melbourne date either re-derived one with toISOString().slice(0,10)
// (UTC days: wrong every Melbourne morning) or grew its own copy of the
// two-pass DST logic below. This module imports NOTHING from server/, so any
// module on any side of the storage graph can share one definition; storage.ts
// re-exports the same symbols so its ~129 existing importers keep working.
// -------------------------------------------------------------------------------------------------

// User is in Melbourne (Australia/Melbourne). "Today" and daily boundaries
// must follow the user's local calendar, not UTC — otherwise a review at
// 11pm AEST is bucketed into the next UTC day, and a review at 8am AEST
// falls under the previous UTC day. Using Intl to compute the local date
// avoids DST edge cases automatically (Melbourne DST switches Oct/Apr).
export const APP_TZ = "Australia/Melbourne";
export const _dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function todayISO(): string {
  // en-CA formats as YYYY-MM-DD which matches ISO.
  return _dateFmt.format(new Date());
}

/** The Melbourne-local calendar date (YYYY-MM-DD) an epoch-ms instant falls on.
 *  Bucketing by new Date(ms).toISOString() uses UTC days: every Melbourne
 *  morning (00:00-10/11:00 local) lands on the WRONG (previous) day. */
export function appTzDateISO(ms: number): string {
  return _dateFmt.format(new Date(ms));
}

// Returns the epoch-ms of local-midnight for the given ISO date in APP_TZ.
// Handles DST correctly by resolving the UTC instant that renders as
// 00:00 wall-clock in Melbourne on that calendar date.
export function localMidnightMs(isoDate: string): number {
  const utcMid = Date.parse(isoDate + "T00:00:00Z");
  // TWO-PASS offset resolution. Sampling the offset at UTC midnight is wrong
  // on the two DST-transition days each year: UTC midnight falls ~10-11h
  // AFTER the local midnight being solved for, so on a transition day the one
  // sample used the NEW offset and every "Melbourne day" boundary landed an
  // hour off (Saturday-23:00 reviews counted as Sunday's, calendar-day totals
  // disagreed with the month bucketing). Pass 1 estimates local midnight with
  // the offset at UTC midnight; pass 2 re-samples AT that estimate — Melbourne
  // transitions at 02:00/03:00 local, so local midnight is never inside the
  // skipped/repeated hour and the second pass is exact.
  const t1 = utcMid - tzOffsetMsAt(utcMid);
  return utcMid - tzOffsetMsAt(t1);
}

/** APP_TZ's UTC offset (ms) in force at the given instant. */
export function tzOffsetMsAt(ms: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  // parts.hour may be "24" for midnight in some locales — normalise.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const asIfLocal = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second),
  );
  return asIfLocal - ms; // e.g. +10h in AEST, +11h in AEDT
}
/** Whole calendar days from one YYYY-MM-DD to another. Exported because the
 *  FSRS scheduler must count DAY BOUNDARIES crossed, not elapsed hours — see
 *  srsOutcomes in mcqStudy.ts. */
export function daysBetweenISO(fromISO: string, toISO: string): number {
  const a = Date.parse(fromISO + "T00:00:00Z");
  const b = Date.parse(toISO + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}
// Add integer number of days to an ISO date, return the new ISO date.
export function addDaysISO(iso: string, days: number): string {
  const t = Date.parse(iso + "T00:00:00Z") + days * 86_400_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
