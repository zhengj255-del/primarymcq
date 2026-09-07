import "./testDb";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { sqlite, todayISO } from "../storage";
import { startSession, getSrsQueueStats, addSrsExtraNew, clearSrsExtraNew, SRS_EXTRA_NEW_DAILY_CAP } from "../mcqStudy";

// "Study more new today" — the SRS setup panel's get-ahead intake. The boost
// must behave like Anki's custom study: it stacks with the day's ordinary
// allowance, is SPENT by the same introduced-today accounting (never re-minted
// per sitting), applies only to the day it was granted, and leaves the
// standing srs_new_per_day setting untouched.

const DAY = 86400000;
const F = { mode: "srs" as const, count: 5 };

const introduce = (id: string) =>
  sqlite.prepare(
    `INSERT OR REPLACE INTO mcq_srs_state (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at, stability, difficulty, created_at)
     VALUES (?, 2.5, 3, 1, 0, ?, ?, 2.31, 2.12, ?)`,
  ).run(id, Date.now(), Date.now() + 3 * DAY, Date.now());

let IDS: string[];

beforeAll(() => {
  sqlite.prepare("DELETE FROM mcq_attempts").run();
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
  sqlite.prepare("DELETE FROM mcq_study_sessions").run();
  IDS = (sqlite
    .prepare("SELECT id FROM mcqs WHERE answer IS NOT NULL ORDER BY id LIMIT 6")
    .all() as Array<{ id: string }>).map((r) => r.id);
});

afterEach(() => {
  sqlite.prepare("UPDATE settings SET srs_new_per_day = 20, srs_max_reviews_per_day = 200").run();
  sqlite.prepare("DELETE FROM mcq_srs_extra_new").run();
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
});

describe("study more new today", () => {
  it("re-opens intake after the daily budget is spent, and the sitting serves it", () => {
    sqlite.prepare("UPDATE settings SET srs_new_per_day = 3").run();
    IDS.slice(0, 3).forEach(introduce); // today's 3 slots all spent
    expect(getSrsQueueStats(F).newToday).toBe(0);

    const grant = addSrsExtraNew(2);
    expect(grant.day).toBe(todayISO());
    expect(grant.extraNew).toBe(2);

    const stats = getSrsQueueStats(F);
    expect(stats.newToday).toBe(2);
    expect(stats.limits.newRemaining).toBe(2);
    expect(stats.limits.extraNewToday).toBe(2);
    // The standing daily limit is NOT what changed.
    expect(stats.limits.newPerDay).toBe(3);
    expect(
      (sqlite.prepare("SELECT srs_new_per_day n FROM settings LIMIT 1").get() as { n: number }).n,
    ).toBe(3);

    // And the sitting actually serves the extra intake (no learning/reviews
    // seeded, so the queue is exactly the new lane).
    expect(startSession(F).mcqs.length).toBe(2);
  });

  it("grants accumulate within the day and are spent, not re-minted per sitting", () => {
    sqlite.prepare("UPDATE settings SET srs_new_per_day = 0").run();
    addSrsExtraNew(1);
    addSrsExtraNew(2);
    expect(getSrsQueueStats(F).newToday).toBe(3);

    // Introducing questions consumes the boost through the same
    // introduced-today counter — reopening Study must not re-mint it.
    IDS.slice(0, 2).forEach(introduce);
    const stats = getSrsQueueStats(F);
    expect(stats.newToday).toBe(1);
    expect(stats.limits.extraNewToday).toBe(3);
  });

  it("yesterday's leftover grant is dead: never applied, pruned on the next grant", () => {
    sqlite.prepare("UPDATE settings SET srs_new_per_day = 0").run();
    sqlite.prepare("INSERT INTO mcq_srs_extra_new (day, extra) VALUES ('2020-01-01', 50)").run();
    const stats = getSrsQueueStats(F);
    expect(stats.newToday).toBe(0);
    expect(stats.limits.extraNewToday).toBe(0);

    addSrsExtraNew(4);
    const rows = sqlite.prepare("SELECT day, extra FROM mcq_srs_extra_new ORDER BY day").all() as
      Array<{ day: string; extra: number }>;
    expect(rows).toEqual([{ day: todayISO(), extra: 4 }]);
  });

  it("withdrawing a part-spent boost keeps the next grant alive", () => {
    sqlite.prepare("UPDATE settings SET srs_new_per_day = 2").run();
    addSrsExtraNew(4); // allowance 6
    IDS.slice(0, 4).forEach(introduce); // base 2 + 2 boost slots spent, 2 unspent
    expect(getSrsQueueStats(F).limits.newRemaining).toBe(2);

    // Withdrawal takes only the unspent 2; the 2 introduced under the boost
    // stay on the ledger, since introducedToday counts them forever.
    expect(clearSrsExtraNew().extraNew).toBe(2);
    expect(getSrsQueueStats(F).newToday).toBe(0);

    // The very next grant must serve exactly what it says. With the spent
    // portion deleted too, this +1 would be swallowed by the deficit and the
    // button would appear dead until a grant outgrew the withdrawn boost.
    addSrsExtraNew(1);
    const stats = getSrsQueueStats(F);
    expect(stats.newToday).toBe(1);
    expect(stats.limits.newRemaining).toBe(1);
  });

  it("a grant lands even after the standing limit was lowered mid-day", () => {
    sqlite.prepare("UPDATE settings SET srs_new_per_day = 4").run();
    IDS.slice(0, 4).forEach(introduce);
    sqlite.prepare("UPDATE settings SET srs_new_per_day = 2").run(); // 2 introduced over the new limit
    expect(getSrsQueueStats(F).newToday).toBe(0);

    addSrsExtraNew(2);
    const stats = getSrsQueueStats(F);
    expect(stats.newToday).toBe(2);
    expect(stats.limits.newRemaining).toBe(2);
  });

  it("caps the day's total boost and rejects non-positive grants", () => {
    addSrsExtraNew(SRS_EXTRA_NEW_DAILY_CAP - 1);
    expect(addSrsExtraNew(400).extraNew).toBe(SRS_EXTRA_NEW_DAILY_CAP);
    expect(() => addSrsExtraNew(0)).toThrow();
    expect(() => addSrsExtraNew(-5)).toThrow();
  });
});

describe("no new cards this sitting (srsSkipNew)", () => {
  const putDue = (id: string, interval: number, dueAt: number) =>
    sqlite.prepare(
      `INSERT OR REPLACE INTO mcq_srs_state (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at, stability, difficulty, created_at)
       VALUES (?, 2.5, ?, 1, 0, ?, ?, 2.31, 2.12, ?)`,
    ).run(id, interval, Date.now() - DAY, dueAt, Date.now() - 10 * DAY);

  it("serves learning + reviews only, and the day's allowance is NOT spent", () => {
    sqlite.prepare("UPDATE settings SET srs_new_per_day = 5").run();
    putDue(IDS[0], 0, Date.now() - 3600000); // learning step, elapsed
    putDue(IDS[1], 3, Date.now() - DAY);     // review, overdue

    const skip = { ...F, srsSkipNew: true };
    const stats = getSrsQueueStats(skip);
    expect(stats.newToday).toBe(0);
    expect(stats.learning).toBe(1);
    expect(stats.reviews).toBe(1);
    // Skipping serves nothing new, so nothing is introduced and the budget
    // survives intact for a later sitting with the toggle off.
    expect(stats.limits.newRemaining).toBe(5);
    expect(stats.newAvailable).toBeGreaterThan(0); // the unseen pile is still reported

    const ids = startSession(skip).mcqs.map((m) => m.id);
    expect(ids).toEqual([IDS[0], IDS[1]]);

    // Toggle off: same day, the withheld intake is served after all.
    expect(getSrsQueueStats(F).newToday).toBe(5);
  });

  it("a granted boost can be withdrawn — the misclick path", () => {
    sqlite.prepare("UPDATE settings SET srs_new_per_day = 0").run();
    addSrsExtraNew(20);
    expect(getSrsQueueStats(F).newToday).toBe(20);

    expect(clearSrsExtraNew().extraNew).toBe(0);
    const stats = getSrsQueueStats(F);
    expect(stats.newToday).toBe(0);
    expect(stats.limits.extraNewToday).toBe(0);
    expect(
      (sqlite.prepare("SELECT COUNT(*) c FROM mcq_srs_extra_new").get() as { c: number }).c,
    ).toBe(0);
  });
});
