import "./testDb";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sqlite, appTzDateISO, localMidnightMs } from "../storage";
import { getUserStats } from "../mcqStudy";

// Bug class I — UTC days leaking into Melbourne-day features. All app dates
// are Australia/Melbourne; deriving a "day" from toISOString(), epoch/86400000,
// or server-local midnight (UTC on Fly) puts every Melbourne morning
// (00:00-10/11am local) on the WRONG day. These pin the fixed sites:
// MCQ streak + dueToday, and the local-midnight helper every day boundary
// in the SRS engine is built on.

// Fixed instant: 2026-07-30T01:00:00Z = 11:00 AEST on Thu 30 Jul 2026.
const NOW = Date.parse("2026-07-30T01:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sqlite.prepare("DELETE FROM mcq_attempts").run();
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
});
afterEach(() => {
  vi.useRealTimers();
  sqlite.prepare("DELETE FROM mcq_attempts").run();
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
});

describe("appTzDateISO", () => {
  it("returns the Melbourne date, not the UTC date, for a local-morning instant", () => {
    const nineAmAest = Date.parse("2026-07-29T23:00:00Z"); // 09:00 AEST 30 Jul
    expect(new Date(nineAmAest).toISOString().slice(0, 10)).toBe("2026-07-29"); // the trap
    expect(appTzDateISO(nineAmAest)).toBe("2026-07-30");
  });
});

describe("MCQ streak counts Melbourne days", () => {
  it("a 2-day Melbourne streak spanning one UTC day reads 2, not 1", () => {
    const ins = sqlite.prepare(
      "INSERT INTO mcq_attempts (mcq_id, session_id, mode, selected, correct, time_ms, attempted_at) VALUES ('m1', 's1', 'test', 'A', 1, 0, ?)",
    );
    // Today 09:00 AEST and yesterday 20:00 AEST — the SAME UTC calendar day
    // (both fall on 29 Jul UTC), but consecutive Melbourne days.
    ins.run(Date.parse("2026-07-29T23:00:00Z")); // Thu 30 Jul 09:00 AEST
    ins.run(Date.parse("2026-07-29T10:00:00Z")); // Wed 29 Jul 20:00 AEST
    expect(getUserStats().streakDays).toBe(2);
  });
});

describe("MCQ dueToday ends at Melbourne midnight", () => {
  it("a card due tomorrow morning (Melbourne) is NOT due today", () => {
    // Real sittable corpus questions: the SRS counts share the session
    // pools' sittable predicate, so a synthetic id would (correctly) never
    // count — this test is about the DAY BOUNDARY, not sittability.
    const ids = sqlite.prepare(
      "SELECT id FROM mcqs WHERE answer IS NOT NULL LIMIT 2",
    ).all() as Array<{ id: string }>;
    const ins = sqlite.prepare(
      "INSERT INTO mcq_srs_state (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at) VALUES (?, 2.5, 1, 1, 0, ?, ?)",
    );
    // Due 05:00 AEST on 31 Jul = 19:00 UTC on 30 Jul. The old server-local
    // (UTC) end-of-day was 10:00 AEST on 31 Jul, which wrongly swept this in.
    ins.run(ids[0].id, NOW - 86400000, Date.parse("2026-07-30T19:00:00Z"));
    const stats = getUserStats();
    expect(stats.srsDue.dueToday).toBe(0);
    // And one genuinely due this Melbourne evening IS counted.
    ins.run(ids[1].id, NOW - 86400000, Date.parse("2026-07-30T08:00:00Z")); // 18:00 AEST today
    expect(getUserStats().srsDue.dueToday).toBe(1);
  });
});

describe("localMidnightMs", () => {
  it("is Melbourne midnight (UTC-10h in July), not UTC midnight", () => {
    expect(localMidnightMs("2026-07-30")).toBe(Date.parse("2026-07-29T14:00:00Z")); // AEST = UTC+10
  });

  it("resolves DST-transition days with the offset in force AT local midnight (two-pass)", () => {
    // Sampling the offset at UTC midnight — ~10h AFTER the local midnight
    // being solved for — used the post-transition offset on both DST days,
    // putting every day boundary an hour off (Saturday-23:00 reviews counted
    // as Sunday's "done today").
    // DST STARTS Sun 4 Oct 2026 (02:00 AEST → 03:00 AEDT): midnight is still +10.
    expect(localMidnightMs("2026-10-04")).toBe(Date.parse("2026-10-03T14:00:00Z"));
    // DST ENDS Sun 4 Apr 2027 (03:00 AEDT → 02:00 AEST): midnight is still +11.
    expect(localMidnightMs("2027-04-04")).toBe(Date.parse("2027-04-03T13:00:00Z"));
    // Plain days on either side of the year are unchanged by the two-pass.
    expect(localMidnightMs("2026-12-15")).toBe(Date.parse("2026-12-14T13:00:00Z")); // AEDT = UTC+11
  });
});
