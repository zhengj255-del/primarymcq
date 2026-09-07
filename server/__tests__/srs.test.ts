import "./testDb";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sqlite, appTzDateISO, addDaysISO, localMidnightMs } from "../storage";
import { submitAttempt, rateSrsAttempt } from "../mcqStudy";

// FSRS-6 scheduling, ported from fsrs4anki_scheduler.js v6.1.1. Golden values
// are hand-derived from the reference default weights with fuzz off and
// retention 0.9 (where interval = stability by construction):
//   first rating → S0 = w[g-1] rounded to 2dp:
//     Again 0.21 (10-min relearn) · Hard 1.29 → 1d · Good 2.31 → 2d · Easy 8.3 → 8d
//   first-rating difficulty D0(g) = w4 − e^{w5(g−1)} + 1:
//     Again 6.41 · Hard 5.11 · Good 2.12 · Easy 1 (clamped)
//
// UNITS (changed 3 Sep 2026, audit mcq-engine-srs-study-6): an interval of n
// days is stored as the START of the Melbourne day n days on, not as the
// wall-clock instant t + n × 86 400 000. A relearn STEP is not a day and keeps
// its wall clock — see the lapse assertions, which are unchanged.

const DAY = 86400000;
const TEN_MIN = 10 * 60 * 1000;

let ids: string[]; // [0] drives the contract suite; the rest are engine fixtures
const savedFuzz = process.env.MCQ_SRS_FUZZ;
const savedRetention = process.env.MCQ_SRS_RETENTION;

beforeAll(() => {
  process.env.MCQ_SRS_FUZZ = "0"; // golden values assume no fuzz
  delete process.env.MCQ_SRS_RETENTION;
  ids = (sqlite
    .prepare("SELECT id, answer FROM mcqs WHERE answer IS NOT NULL ORDER BY id LIMIT 12")
    .all() as Array<{ id: string }>).map((r) => r.id);
});

afterAll(() => {
  if (savedFuzz === undefined) delete process.env.MCQ_SRS_FUZZ;
  else process.env.MCQ_SRS_FUZZ = savedFuzz;
  if (savedRetention === undefined) delete process.env.MCQ_SRS_RETENTION;
  else process.env.MCQ_SRS_RETENTION = savedRetention;
  vi.useRealTimers();
});

const answerOf = (id: string) =>
  (sqlite.prepare("SELECT answer FROM mcqs WHERE id = ?").get(id) as { answer: string }).answer;
const attemptCount = (id: string) =>
  (sqlite.prepare("SELECT COUNT(*) AS c FROM mcq_attempts WHERE mcq_id = ?").get(id) as { c: number }).c;
const srsRow = (id: string) =>
  sqlite.prepare("SELECT * FROM mcq_srs_state WHERE mcq_id = ?").get(id) as
    | { reps: number; interval_days: number; lapses: number; due_at: number; stability: number; difficulty: number }
    | undefined;
const rate = (id: string, rating: number) => {
  submitAttempt({ mcqId: id, sessionId: null, mode: "srs", selected: answerOf(id), timeMs: 1000 });
  return rateSrsAttempt({ mcqId: id, sessionId: null, rating })!;
};

describe("SRS single-submission contract", () => {
  it("reveal logs exactly one attempt and does NOT schedule", () => {
    const res = submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 1000 });
    expect(res.correct).toBe(true);
    expect(res.srs).toBeUndefined();
    expect(attemptCount(ids[0])).toBe(1);
    expect(srsRow(ids[0])).toBeUndefined();
  });

  it("rating schedules exactly once and reuses the logged attempt", () => {
    const srs = rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 3 });
    expect(srs).toBeDefined();
    expect(srs!.reps).toBe(1);
    expect(srs!.intervalDays).toBe(2);        // first "Good" → S0 2.31 → 2 days
    expect(srs!.stability).toBe(2.31);
    expect(srs!.difficulty).toBe(2.12);
    expect(srs!.dueAt).toBeGreaterThan(Date.now());

    // Still exactly one attempt row (rating backfilled, not a second insert).
    expect(attemptCount(ids[0])).toBe(1);
    const attempt = sqlite
      .prepare("SELECT rating FROM mcq_attempts WHERE mcq_id = ?")
      .get(ids[0]) as { rating: number };
    expect(attempt.rating).toBe(3);
    expect(srsRow(ids[0])!.reps).toBe(1);
  });

  it("a same-day second Good goes through short-term stability (never shrinks S)", () => {
    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 800 });
    expect(attemptCount(ids[0])).toBe(2);
    expect(srsRow(ids[0])!.reps).toBe(1);     // reveal alone never schedules

    const srs = rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 3 });
    expect(srs!.reps).toBe(2);                // FSRS reps counts reviews; it is not a streak
    expect(srs!.stability).toBe(2.31);        // sinc clamps at 1 for Good/Easy same-day
    // 3, not 2: S is unchanged, but Hard would also schedule 2d here, and on an
    // established memory Anki guarantees Good > Hard. Verified against ts-fsrs.
    expect(srs!.intervalDays).toBe(3);
    expect(attemptCount(ids[0])).toBe(2);
  });

  it("rating 'Again' (1) drops stability, records a lapse, and relearns in 10 minutes", () => {
    const before = srsRow(ids[0])!;
    // Every rating needs its own reveal — rateSrsAttempt refuses a reveal that
    // already carries a rating, so a double-tap can't advance twice.
    submitAttempt({ mcqId: ids[0], sessionId: null, mode: "srs", selected: answerOf(ids[0]), timeMs: 600 });
    const srs = rateSrsAttempt({ mcqId: ids[0], sessionId: null, rating: 1 });
    expect(srs!.reps).toBe(3);                // still a review — the count keeps climbing
    expect(srs!.intervalDays).toBe(0);
    expect(srs!.stability).toBeLessThan(before.stability);
    expect(srs!.stability).toBeGreaterThan(0); // must never re-arm the init sentinel
    expect(srsRow(ids[0])!.lapses).toBe(before.lapses + 1);
    const wait = srs!.dueAt - Date.now();
    expect(wait).toBeGreaterThan(TEN_MIN - 60_000);
    expect(wait).toBeLessThanOrEqual(TEN_MIN);
  });
});

describe("FSRS-6 engine", () => {
  it("initialises S0/D0 per rating with Hard < Good < Easy intervals", () => {
    const again = rate(ids[1], 1);
    const hard = rate(ids[2], 2);
    const good = rate(ids[3], 3);
    const easy = rate(ids[4], 4);

    expect(again.stability).toBe(0.21);
    expect(hard.stability).toBe(1.29);
    expect(good.stability).toBe(2.31);
    expect(easy.stability).toBe(8.3);

    expect(again.difficulty).toBe(6.41);
    expect(hard.difficulty).toBe(5.11);
    expect(good.difficulty).toBe(2.12);
    expect(easy.difficulty).toBe(1);          // D0(Easy) clamps at the floor

    expect(again.intervalDays).toBe(0);
    expect(hard.intervalDays).toBe(1);
    expect(good.intervalDays).toBe(2);
    expect(easy.intervalDays).toBe(8);
  });

  it("grows stability across a real multi-day gap and comes due at the target day's local midnight, then a lapse collapses it to a ten-minute step", () => {
    const T0 = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      const first = rate(ids[5], 3);
      expect(first.intervalDays).toBe(2);

      // Reviewed again 3 days later (late — retrievability below target).
      vi.setSystemTime(T0 + 3 * DAY);
      const second = rate(ids[5], 3);
      expect(second.reps).toBe(2);
      expect(second.stability).toBeGreaterThan(12);   // ≈13.8d from 2.31d
      expect(second.stability).toBeLessThan(16);
      // At retention 0.9 the interval IS the stability (fuzz off).
      expect(second.intervalDays).toBe(Math.round(second.stability));
      // DELIBERATE CONTRACT CHANGE (E7 · mcq-engine-srs-study-6). This line used
      // to read `T0 + 3 * DAY + second.intervalDays * DAY` — the wall-clock
      // anniversary of the rating. The queue has always been DAY-granular: it
      // counts elapsed time in Melbourne day boundaries crossed, and serves
      // anything whose due_at falls before the next local midnight. A multiple
      // of 86 400 000 ms is therefore a different unit from the one every
      // reader of this column uses, and the mismatch bit on the two DST days —
      // rated 23:30 on Sat 3 Oct 2026, a 1-day interval overshot the 23-hour
      // Sunday's two local midnights and the card came back a day LATE, which
      // is exactly when the owner rates and exactly the week they cannot lose.
      // So: due at the START of the Melbourne day the interval lands on. On an
      // ordinary day that is the same calendar day as before — only the time of
      // day moves — which is why this assertion, not the calendar, is what
      // changed. The two DST midnights are pinned by instant in
      // melbourneDays.test.ts (localMidnightMs).
      const landsOn = addDaysISO(appTzDateISO(T0 + 3 * DAY), second.intervalDays);
      expect(appTzDateISO(second.dueAt)).toBe(landsOn);   // the right Melbourne day…
      expect(second.dueAt).toBe(localMidnightMs(landsOn)); // …at 00:00, not 3 days' wall clock

      // Failing it 10 days later costs most of that stability, but not all.
      // Its due instant stays WALL-CLOCK: a lapse schedules a relearn STEP, not
      // a day. It never enters the review lane (interval_days < 1 routes it to
      // the learning lane), so no day boundary is involved and the assertion
      // below is deliberately untouched by the change above.
      vi.setSystemTime(T0 + 13 * DAY);
      const lapse = rate(ids[5], 1);
      expect(lapse.intervalDays).toBe(0);
      expect(lapse.stability).toBeLessThan(second.stability / 2);
      expect(lapse.stability).toBeGreaterThan(0);
      expect(lapse.dueAt).toBe(T0 + 13 * DAY + TEN_MIN);
      expect(srsRow(ids[5])!.lapses).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("MCQ_SRS_RETENTION tightens intervals without touching the memory state", () => {
    process.env.MCQ_SRS_RETENTION = "0.97";
    try {
      const good = rate(ids[6], 3);
      const easy = rate(ids[7], 4);
      expect(good.stability).toBe(2.31);      // S/D are retention-independent
      expect(easy.stability).toBe(8.3);
      expect(good.intervalDays).toBe(1);      // vs 2 at the 0.9 default
      expect(easy.intervalDays).toBeLessThan(8); // vs 8 at the 0.9 default
    } finally {
      delete process.env.MCQ_SRS_RETENTION;
    }
  });

  it("reads retention from app Settings, with the env var as a winning override", () => {
    sqlite.prepare("UPDATE settings SET srs_retention = 0.97").run();
    try {
      // Settings value applies: 0.97 tightens first-Good from 2d to 1d.
      const good = rate(ids[9], 3);
      expect(good.stability).toBe(2.31);
      expect(good.intervalDays).toBe(1);

      // Env override outranks the saved setting (ops/test escape hatch).
      process.env.MCQ_SRS_RETENTION = "0.9";
      sqlite.prepare("DELETE FROM mcq_srs_state WHERE mcq_id = ?").run(ids[9]);
      submitAttempt({ mcqId: ids[9], sessionId: null, mode: "srs", selected: answerOf(ids[9]), timeMs: 600 });
      const replay = rateSrsAttempt({ mcqId: ids[9], sessionId: null, rating: 3 });
      expect(replay!.intervalDays).toBe(2);
    } finally {
      delete process.env.MCQ_SRS_RETENTION;
      sqlite.prepare("UPDATE settings SET srs_retention = 0.9").run();
    }
  });

  it("reads fuzz from app Settings when the env var is absent", () => {
    delete process.env.MCQ_SRS_FUZZ; // suite default was the env override
    sqlite.prepare("UPDATE settings SET srs_fuzz = 0").run();
    try {
      const easy = rate(ids[10], 4);
      expect(easy.intervalDays).toBe(8); // exact — settings turned fuzz off
    } finally {
      sqlite.prepare("UPDATE settings SET srs_fuzz = 1").run();
      process.env.MCQ_SRS_FUZZ = "0";
    }
  });

  it("the reveal's srsPreview is an exact promise of what each button schedules", () => {
    const res = submitAttempt({ mcqId: ids[11], sessionId: null, mode: "srs", selected: answerOf(ids[11]), timeMs: 500 });
    // Fresh-question goldens at retention 0.9, fuzz off.
    expect(res.srsPreview).toEqual({ again: 0, hard: 1, good: 2, easy: 8 });
    // Pressing the button delivers the previewed interval — same outcome table.
    const srs = rateSrsAttempt({ mcqId: ids[11], sessionId: null, rating: 3 });
    expect(srs!.intervalDays).toBe(res.srsPreview!.good);
  });

  it("tutor reveals carry no rating preview", () => {
    const res = submitAttempt({ mcqId: ids[11], sessionId: null, mode: "tutor", selected: answerOf(ids[11]), timeMs: 500 });
    expect(res.srsPreview).toBeUndefined();
  });

  it("fuzz jitters intervals within Anki's [95%−1, 105%+1] band, deterministically", () => {
    delete process.env.MCQ_SRS_FUZZ; // default is ON, like Anki
    try {
      const easy = rate(ids[8], 4);
      expect(easy.stability).toBe(8.3);       // fuzz moves the interval, never the memory
      expect(easy.intervalDays).toBeGreaterThanOrEqual(7);
      expect(easy.intervalDays).toBeLessThanOrEqual(9);

      // Deterministic: replaying the identical (question, rep) review lands
      // on the identical day — no stored PRNG state to drift.
      sqlite.prepare("DELETE FROM mcq_srs_state WHERE mcq_id = ?").run(ids[8]);
      submitAttempt({ mcqId: ids[8], sessionId: null, mode: "srs", selected: answerOf(ids[8]), timeMs: 600 });
      const replay = rateSrsAttempt({ mcqId: ids[8], sessionId: null, rating: 4 });
      expect(replay!.intervalDays).toBe(easy.intervalDays);
    } finally {
      process.env.MCQ_SRS_FUZZ = "0";
    }
  });
});
