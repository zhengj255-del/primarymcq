import "./testDb";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { sqlite } from "../storage";
import {
  submitAttempt, rateSrsAttempt, previewSrsIntervals,
  getSrsQueueStats, getUserStats, getWeakAreas,
} from "../mcqStudy";

// SRS regressions. Each case pins a scheduling defect found after the engine
// was first thought complete — elapsed time in Melbourne days, the same-day
// stability rule, lane stamping, the reveal-then-rate precondition, wrong
// answers, the per-sitting learning cap, skip handling in the stats, rating
// order, tie-breaks and the key-change reset. The engine here is the tracker's
// FSRS-6 implementation carried over unchanged, so these must stay green.

const DAY = 86400000;
const HOUR = 3600000;
// Melbourne is AEST (UTC+10) in August — no DST transition in this window.
const MON_8PM = Date.parse("2026-08-10T20:00:00+10:00");
const MON_9AM = Date.parse("2026-08-10T09:00:00+10:00");

let ids: string[];
const savedFuzz = process.env.MCQ_SRS_FUZZ;

beforeAll(() => {
  process.env.MCQ_SRS_FUZZ = "0"; // goldens below are exact intervals
});
afterAll(() => {
  if (savedFuzz === undefined) delete process.env.MCQ_SRS_FUZZ;
  else process.env.MCQ_SRS_FUZZ = savedFuzz;
  vi.useRealTimers();
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM mcq_attempts").run();
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
  sqlite.prepare("DELETE FROM mcq_srs_undo").run();
  sqlite.prepare("UPDATE settings SET srs_new_per_day = 20, srs_max_reviews_per_day = 200").run();
  ids = (sqlite.prepare("SELECT id FROM mcqs WHERE answer IS NOT NULL ORDER BY id LIMIT 40")
    .all() as Array<{ id: string }>).map((r) => r.id);
});

const answerOf = (id: string) =>
  (sqlite.prepare("SELECT answer FROM mcqs WHERE id = ?").get(id) as { answer: string }).answer;
const wrongFor = (id: string) => (["A", "B", "C", "D", "E"].find((k) => k !== answerOf(id)))!;
const rate = (id: string, rating: number) => {
  submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: answerOf(id), timeMs: 500 });
  return rateSrsAttempt({ mcqId: id, sessionId: null, rating })!;
};
const laneOf = (id: string) =>
  (sqlite.prepare("SELECT srs_lane FROM mcq_attempts WHERE mcq_id = ? ORDER BY id DESC LIMIT 1")
    .get(id) as { srs_lane: string | null }).srs_lane;
const putState = (id: string, interval: number, dueAt: number, stability: number) =>
  sqlite.prepare(
    `INSERT OR REPLACE INTO mcq_srs_state
       (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at, stability, difficulty, created_at)
     VALUES (?, 2.5, ?, 1, 0, ?, ?, ?, 5, ?)`,
  ).run(id, interval, Date.now() - DAY, dueAt, stability, Date.now() - 10 * DAY);

// -------------------------------------------------------------------------------------------------
// S1 — elapsed time is counted in day boundaries crossed, not in hours.
// -------------------------------------------------------------------------------------------------

describe("elapsed time is measured in Melbourne days, not a rolling 24h window", () => {
  it("a review 23h later on the NEXT day is a real review, not a same-day one", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(MON_8PM);
      const first = rate(ids[0], 3);
      expect(first.stability).toBe(2.31);
      expect(first.intervalDays).toBe(2);

      // 7pm Tuesday: 23 hours later, but one Melbourne day boundary crossed.
      // The queue serves reviews day-granularly on purpose, so this is the
      // NORMAL case for a short-interval question, not an edge case.
      vi.setSystemTime(MON_8PM + 23 * HOUR);
      const second = rate(ids[0], 3);
      expect(second.stability).toBe(7.32);   // long-term recall formula
      expect(second.intervalDays).toBe(7);
      // The bug: the short-term formula clamps sinc to 1 for Good, so S would
      // have stayed 2.31 and the interval 2 — forever, for anyone who studies
      // at a consistent or slightly earlier hour.
      expect(second.stability).toBeGreaterThan(first.stability);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second review 13h later on the SAME day still takes the short-term path", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(MON_9AM);
      const first = rate(ids[1], 3);
      expect(first.stability).toBe(2.31);

      vi.setSystemTime(MON_9AM + 13 * HOUR); // 10pm the same Melbourne day
      const second = rate(ids[1], 3);
      expect(second.stability).toBe(2.31);   // sinc clamps at 1 for Good
      // 3, not 2: the memory is unchanged, but Hard schedules 2d here too and
      // Good must clear it (see the ordering suite below).
      expect(second.intervalDays).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("eight daily Goods 23h apart grow the interval instead of stalling at 1-2 days", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(MON_8PM);
      rate(ids[2], 2);                        // Hard on a fresh card -> 1 day
      let t = MON_8PM;
      let last = 0;
      for (let d = 0; d < 4; d++) {
        t += 23 * HOUR;
        vi.setSystemTime(t);
        last = rate(ids[2], 3).intervalDays;
      }
      // Pre-fix this walked 1,1,1,1 (stability 1.29 -> 1.45).
      expect(last).toBeGreaterThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the reveal's preview still matches what the button schedules across a day boundary", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(MON_8PM);
      rate(ids[3], 3);

      // Reveal at 7:59pm Tuesday, rate two minutes later. Both instants sit in
      // the same Melbourne day, so both take the same branch — the promise on
      // the button holds. Under the 24h test these straddled the boundary and
      // the button said "2 d" while pressing it scheduled 7.
      vi.setSystemTime(MON_8PM + 24 * HOUR - 60_000);
      const res = submitAttempt({ mcqId: ids[3], sessionId: null, mode: "srs", selected: answerOf(ids[3]), timeMs: 500 });
      vi.setSystemTime(MON_8PM + 24 * HOUR + 60_000);
      const applied = rateSrsAttempt({ mcqId: ids[3], sessionId: null, rating: 3 })!;
      expect(applied.intervalDays).toBe(res.srsPreview!.good);
    } finally {
      vi.useRealTimers();
    }
  });
});

// -------------------------------------------------------------------------------------------------
// S8 — the short-term formula never shrinks S for anything but Again.
// -------------------------------------------------------------------------------------------------

describe("same-day short-term stability", () => {
  it("Hard never shrinks S (the reference clamps at rating >= 2, not >= 3)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(MON_9AM);
      const first = rate(ids[4], 3);
      expect(first.stability).toBe(2.31);

      vi.setSystemTime(MON_9AM + 2 * HOUR);
      const hard = rate(ids[4], 2);
      // Pre-fix: 2.31 * 0.578 = 1.34 — a second penalty for pressing Hard
      // rather than Again on a question already in a relearn step.
      expect(hard.stability).toBe(2.31);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Again still collapses S same-day", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(MON_9AM);
      rate(ids[5], 3);
      vi.setSystemTime(MON_9AM + 2 * HOUR);
      const again = rate(ids[5], 1);
      expect(again.stability).toBeLessThan(2.31);
      expect(again.stability).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// -------------------------------------------------------------------------------------------------
// S2 — the lane stamped at rating time must match the lane the queue served.
// -------------------------------------------------------------------------------------------------

describe("lane classification matches the queue's own split", () => {
  it("a graduated question with an uninitialised memory is a REVIEW, not a new card", () => {
    // The shape the one-shot seed's verification-pass branch writes, and the
    // shape every row that predates the FSRS migration carries
    // (ALTER TABLE ... stability REAL NOT NULL DEFAULT 0).
    putState(ids[6], 3, Date.now() - HOUR, 0);
    expect(getSrsQueueStats({ mode: "srs", count: 0 }).dueReviews).toBe(1);

    sqlite.prepare("UPDATE settings SET srs_max_reviews_per_day = 5").run();
    rate(ids[6], 3);
    expect(laneOf(ids[6])).toBe("review");
    // Pre-fix this stamped 'new', so the day's review allowance never
    // decremented and srs_max_reviews_per_day was unenforceable across
    // sittings for the whole seeded backlog.
    expect(getSrsQueueStats({ mode: "srs", count: 0 }).limits.reviewsRemaining).toBe(4);
  });

  it("a relearn step is still exempt, and a never-tracked question is still new", () => {
    putState(ids[7], 0, Date.now() - HOUR, 1.2);   // genuine relearn step
    sqlite.prepare("UPDATE settings SET srs_max_reviews_per_day = 5").run();

    rate(ids[7], 3);
    expect(laneOf(ids[7])).toBe("learning");
    expect(getSrsQueueStats({ mode: "srs", count: 0 }).limits.reviewsRemaining).toBe(5);

    rate(ids[8], 3);                               // no state row at all
    expect(laneOf(ids[8])).toBe("new");
    expect(getSrsQueueStats({ mode: "srs", count: 0 }).limits.reviewsRemaining).toBe(5);
  });
});

// -------------------------------------------------------------------------------------------------
// S5 / S6 — reveal-then-rate is a precondition, not a convention.
// -------------------------------------------------------------------------------------------------

describe("rating requires an unrated SRS reveal", () => {
  it("refuses to schedule a question that was never revealed", () => {
    expect(() => rateSrsAttempt({ mcqId: ids[9], sessionId: null, rating: 4 }))
      .toThrow(/reveal the answer first/);
    expect(sqlite.prepare("SELECT COUNT(*) c FROM mcq_srs_state WHERE mcq_id = ?").get(ids[9]))
      .toEqual({ c: 0 });
  });

  it("refuses a second rating of the same reveal, so a double-tap cannot compound", () => {
    const first = rate(ids[10], 4);
    expect(() => rateSrsAttempt({ mcqId: ids[10], sessionId: null, rating: 4 }))
      .toThrow(/already rated/);
    const row = sqlite.prepare("SELECT interval_days, reps FROM mcq_srs_state WHERE mcq_id = ?").get(ids[10]);
    expect(row).toEqual({ interval_days: first.intervalDays, reps: 1 });
    // Exactly one undo record — the misclick net stays one press deep.
    expect(sqlite.prepare("SELECT COUNT(*) c FROM mcq_srs_undo WHERE mcq_id = ?").get(ids[10]))
      .toEqual({ c: 1 });
  });

  it("never annotates a tutor attempt", () => {
    submitAttempt({ mcqId: ids[11], sessionId: null, mode: "tutor", selected: answerOf(ids[11]), timeMs: 500 });
    expect(() => rateSrsAttempt({ mcqId: ids[11], sessionId: null, rating: 3 }))
      .toThrow(/reveal the answer first/);
    const row = sqlite.prepare("SELECT mode, rating, srs_lane FROM mcq_attempts WHERE mcq_id = ?").get(ids[11]);
    expect(row).toEqual({ mode: "tutor", rating: null, srs_lane: null });
  });

  it("a fresh reveal after a rating can be rated again (the Again requeue)", () => {
    rate(ids[12], 1);
    const second = rate(ids[12], 3);   // same sitting, new reveal
    expect(second.reps).toBe(2);
  });
});

// -------------------------------------------------------------------------------------------------
// A wrong answer can only be rated Again. The MCQ carries its own evidence:
// the selected option missed the key, so the recall failed — pressing Good
// would push the question weeks out on a memory the attempt just disproved.
// Enforced server-side; the client showing a single Again button is cosmetic.
// -------------------------------------------------------------------------------------------------

describe("a wrong answer can only be rated Again", () => {
  it("refuses Hard, Good and Easy on an incorrect attempt, writing nothing", () => {
    submitAttempt({ mcqId: ids[14], sessionId: null, mode: "srs", selected: wrongFor(ids[14]), timeMs: 500 });
    for (const g of [2, 3, 4]) {
      expect(() => rateSrsAttempt({ mcqId: ids[14], sessionId: null, rating: g }))
        .toThrow(/can only be rated Again/);
    }
    expect(sqlite.prepare("SELECT COUNT(*) c FROM mcq_srs_state WHERE mcq_id = ?").get(ids[14]))
      .toEqual({ c: 0 });
    // The reveal is still unrated, so Again itself goes through normally.
    const srs = rateSrsAttempt({ mcqId: ids[14], sessionId: null, rating: 1 })!;
    expect(srs.intervalDays).toBe(0);   // the 10-minute relearn step
    expect(sqlite.prepare("SELECT lapses FROM mcq_srs_state WHERE mcq_id = ?").get(ids[14]))
      .toEqual({ lapses: 1 });
  });

  it("a 'Don't know' reveal (no answer) is a failed recall — Again only", () => {
    submitAttempt({ mcqId: ids[15], sessionId: null, mode: "srs", selected: null, timeMs: 500 });
    expect(() => rateSrsAttempt({ mcqId: ids[15], sessionId: null, rating: 3 }))
      .toThrow(/can only be rated Again/);
    const srs = rateSrsAttempt({ mcqId: ids[15], sessionId: null, rating: 1 })!;
    expect(srs.intervalDays).toBe(0);
  });

  it("a correct answer keeps all four ratings, Again included", () => {
    const first = rate(ids[16], 3);           // correct answer + Good
    expect(first.intervalDays).toBeGreaterThanOrEqual(1);
    const second = rate(ids[17], 4);          // correct answer + Easy
    expect(second.intervalDays).toBeGreaterThan(first.intervalDays);
    const confessed = rate(ids[18], 1);       // correct answer, honest Again
    expect(confessed.intervalDays).toBe(0);
  });

  it("the enforcement reads the attempt being rated, not older history", () => {
    // Wrong yesterday (rated Again), correct on today's relearn step: the new
    // reveal is correct, so the full button row must be legal again.
    submitAttempt({ mcqId: ids[19], sessionId: null, mode: "srs", selected: wrongFor(ids[19]), timeMs: 500 });
    rateSrsAttempt({ mcqId: ids[19], sessionId: null, rating: 1 });
    const srs = rate(ids[19], 3);             // fresh correct reveal + Good
    expect(srs.reps).toBe(2);
    expect(srs.intervalDays).toBeGreaterThanOrEqual(1);
  });
});

// -------------------------------------------------------------------------------------------------
// S7 — the learning lane is bounded per sitting.
// -------------------------------------------------------------------------------------------------

describe("the learning lane is bounded per sitting", () => {
  it("caps the relearn wall a bulk key-change or the seed can mint, and reports the truth", () => {
    for (const id of ids.slice(0, 30)) putState(id, 0, Date.now() - HOUR, 0);
    sqlite.prepare("UPDATE settings SET srs_max_reviews_per_day = 5, srs_new_per_day = 0").run();

    const stats = getSrsQueueStats({ mode: "srs", count: 0 });
    expect(stats.dueLearning).toBe(30);            // all 30 really are due
    expect(stats.learning).toBe(20);               // floor of the per-sitting cap
    expect(stats.limits.learningPerSitting).toBe(20);
    // Nothing is "spent": the overflow stays due and the next sitting serves it.
    expect(getSrsQueueStats({ mode: "srs", count: 0 }).dueLearning).toBe(30);
  });

  it("a normal relearn backlog is served whole", () => {
    for (const id of ids.slice(0, 3)) putState(id, 0, Date.now() - HOUR, 1.2);
    const stats = getSrsQueueStats({ mode: "srs", count: 0 });
    expect(stats.learning).toBe(3);
    expect(stats.dueLearning).toBe(3);
  });
});

// -------------------------------------------------------------------------------------------------
// S3 — "Don't know" is not a wrong answer, in EVERY stat.
// -------------------------------------------------------------------------------------------------

describe("a reveal without an answer is not a wrong answer — by-domain and weak areas", () => {
  const topicOf = (id: string) =>
    sqlite.prepare("SELECT topic_slug AS slug, domain FROM mcqs WHERE id = ?").get(id) as { slug: string; domain: string };

  it("by-domain accuracy agrees with by-topic instead of being dragged down by skips", () => {
    const scope = sqlite.prepare(
      "SELECT topic_slug AS slug, domain, COUNT(*) c FROM mcqs m WHERE answer IS NOT NULL GROUP BY topic_slug HAVING c >= 6 LIMIT 1",
    ).get() as { slug: string; domain: string };
    const tIds = (sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL LIMIT 5")
      .all(scope.slug) as Array<{ id: string }>).map((r) => r.id);

    for (const id of tIds) submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: answerOf(id), timeMs: 500 });
    for (const id of tIds) submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: null, timeMs: 500 });

    const s = getUserStats();
    expect(s.byTopic.find((t) => t.slug === scope.slug)!.accuracy).toBe(1);
    // Pre-fix: 0.5, below every topic accuracy it aggregates.
    expect(s.byDomain.find((d) => d.domain === scope.domain)!.accuracy).toBe(1);
  });

  it("a question only ever skipped is not 'attempted at 0%' for its domain", () => {
    const { domain } = topicOf(ids[0]);
    for (const id of ids.slice(0, 4)) {
      submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: null, timeMs: 500 });
    }
    const d = getUserStats().byDomain.find((x) => x.domain === domain)!;
    expect(d.attempted).toBe(0);   // pre-fix: 4
    expect(d.accuracy).toBeNull(); // pre-fix: 0
  });

  it("the weak-areas list uses the same predicate as the pool the weak filter samples", () => {
    const scope = sqlite.prepare(
      "SELECT topic_slug AS slug, COUNT(*) c FROM mcqs m WHERE answer IS NOT NULL GROUP BY topic_slug HAVING c >= 6 LIMIT 1",
    ).get() as { slug: string };
    const tIds = (sqlite.prepare("SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL LIMIT 5")
      .all(scope.slug) as Array<{ id: string }>).map((r) => r.id);

    for (const id of tIds) submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: answerOf(id), timeMs: 500 });
    for (const id of tIds) submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: null, timeMs: 500 });

    // 5 answered < the HAVING attempts >= 5 bar is met exactly, and all 5 were
    // right — so the topic is not weak. Pre-fix it entered at 0.5 over "10".
    const entry = getWeakAreas().find((w) => w.slug === scope.slug);
    expect(entry?.accuracy ?? 1).toBe(1);
    expect(entry?.attempts ?? 5).toBe(5);
  });

  it("a genuinely wrong answer still counts in both", () => {
    const { domain } = topicOf(ids[0]);
    for (const id of ids.slice(0, 4)) {
      submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: wrongFor(id), timeMs: 500 });
    }
    expect(getUserStats().byDomain.find((x) => x.domain === domain)!.accuracy).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
// Rating-button ordering. Found by differential-testing the whole engine
// against ts-fsrs v5.4.1 (FSRS-6.0) over a 700-case (S, D, elapsed, rating)
// grid: stability matched the reference exactly everywhere, but 45 same-day
// intervals did not, because the ordering pass was gated on `!sameDay`.
// -------------------------------------------------------------------------------------------------

describe("rating buttons are strictly ordered on an established memory", () => {
  const seedState = (id: string, s: number, d: number, lastReviewedAt: number) =>
    sqlite.prepare(
      `INSERT OR REPLACE INTO mcq_srs_state
         (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at, stability, difficulty, created_at)
       VALUES (?, 2.5, ?, 3, 0, ?, ?, ?, ?, ?)`,
    ).run(id, Math.max(1, Math.round(s)), lastReviewedAt, lastReviewedAt, s, d, lastReviewedAt - 30 * DAY);

  it("Hard < Good < Easy across a grid of memory states and gaps, same-day included", () => {
    vi.useFakeTimers();
    try {
      for (const s of [0.5, 1.29, 2.31, 7.5, 20, 60, 180]) {
        for (const d of [1, 2.12, 5, 7.5, 10]) {
          for (const gapDays of [0, 1, 3, 10, 60]) {
            const id = ids[30];
            sqlite.prepare("DELETE FROM mcq_srs_state WHERE mcq_id = ?").run(id);
            const last = gapDays === 0 ? MON_9AM - 3 * HOUR : MON_9AM - gapDays * DAY;
            seedState(id, s, d, last);
            vi.setSystemTime(MON_9AM);
            const p = previewSrsIntervals(id);
            const where = `S=${s} D=${d} gap=${gapDays}`;
            expect(p.again, where).toBe(0);          // the 10-minute relearn step
            expect(p.hard, where).toBeLessThan(p.good);
            expect(p.good, where).toBeLessThan(p.easy);
          }
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("the FIRST rating is exempt — Hard and Good may tie, as in the reference", () => {
    // At a tight retention the reference schedules a brand-new card Hard 1d /
    // Good 1d. Forcing Good to 2d there would invent an interval FSRS doesn't.
    sqlite.prepare("UPDATE settings SET srs_retention = 0.97").run();
    try {
      const p = previewSrsIntervals(ids[31]);   // never tracked
      expect(p).toEqual({ again: 0, hard: 1, good: 1, easy: 2 });
    } finally {
      sqlite.prepare("UPDATE settings SET srs_retention = 0.9").run();
    }
  });

  it("first-rating intervals at the default retention are unchanged", () => {
    expect(previewSrsIntervals(ids[32])).toEqual({ again: 0, hard: 1, good: 2, easy: 8 });
  });
});

// -------------------------------------------------------------------------------------------------
// S13 — latest-attempt-correct is deterministic when two attempts share a ms.
// -------------------------------------------------------------------------------------------------

describe("latest-attempt-correct", () => {
  it("breaks a same-millisecond tie by insertion order, not arbitrarily", () => {
    const at = Date.now();
    const ins = sqlite.prepare(
      "INSERT INTO mcq_attempts (mcq_id, session_id, mode, selected, correct, time_ms, attempted_at) VALUES (?, NULL, 'srs', 'A', ?, 500, ?)",
    );
    ins.run(ids[0], 1, at);   // earlier row: correct
    ins.run(ids[0], 0, at);   // later row, same ms: wrong — this is "latest"
    const total = getUserStats().byTopic.reduce((n, t) => n + t.correctLatest, 0);
    expect(total).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
// Preview stays exact for a question whose schedule was reset by a key change.
// -------------------------------------------------------------------------------------------------

describe("preview", () => {
  it("treats a key-change reset (stability 0) as a fresh memory", () => {
    putState(ids[13], 0, Date.now(), 0);
    expect(previewSrsIntervals(ids[13])).toEqual({ again: 0, hard: 1, good: 2, easy: 8 });
  });
});
