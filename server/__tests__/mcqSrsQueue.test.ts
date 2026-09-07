import "./testDb";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { sqlite, localMidnightMs, todayISO, addDaysISO } from "../storage";
import { startSession, getSrsQueueStats, rateSrsAttempt, submitAttempt, getUserStats } from "../mcqStudy";

// The Anki-style SRS queue. Three lanes served in order — learning (interval
// < 1 day, inside the 20-minute learn-ahead), due reviews (DAY-granular on
// Melbourne days, oldest first, capped by srs_max_reviews_per_day), then new
// intake (capped by srs_new_per_day) — with "done today" accounting that
// counts distinct reviews rated today and state rows born today.

const HOUR = 3600000;
const DAY = 86400000;
const F = { mode: "srs" as const, count: 5 }; // count must be IGNORED in SRS

let L_OVERDUE: string, L_SOON: string, L_LATER: string;
let R_OVERDUE: string, R_TONIGHT: string, R_TOMORROW: string, UNTRACKED: string;

const put = (id: string, interval: number, dueAt: number, createdAt: number) =>
  sqlite.prepare(
    `INSERT OR REPLACE INTO mcq_srs_state (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at, stability, difficulty, created_at)
     VALUES (?, 2.5, ?, 1, 0, ?, ?, 2.31, 2.12, ?)`,
  ).run(id, interval, Date.now() - DAY, dueAt, createdAt);
const queueIds = () => startSession(F).mcqs.map((m) => m.id);
const answerOf = (id: string) =>
  (sqlite.prepare("SELECT answer FROM mcqs WHERE id = ?").get(id) as { answer: string }).answer;

beforeAll(() => {
  sqlite.prepare("DELETE FROM mcq_attempts").run();
  sqlite.prepare("DELETE FROM mcq_srs_state").run();
  sqlite.prepare("DELETE FROM mcq_study_sessions").run();
  const ids = (sqlite
    .prepare("SELECT id FROM mcqs WHERE answer IS NOT NULL ORDER BY id LIMIT 7")
    .all() as Array<{ id: string }>).map((r) => r.id);
  [L_OVERDUE, L_SOON, L_LATER, R_OVERDUE, R_TONIGHT, R_TOMORROW, UNTRACKED] = ids;

  const t = Date.now();
  const past = t - 10 * DAY;
  const endOfDay = localMidnightMs(addDaysISO(todayISO(), 1));
  put(L_OVERDUE, 0, t - HOUR, past);            // learn step elapsed an hour ago
  put(L_SOON, 0, t + 10 * 60000, past);         // step due in 10 min — inside learn-ahead
  put(L_LATER, 0, t + 2 * HOUR, past);          // step due in 2h — beyond learn-ahead
  put(R_OVERDUE, 3, t - 2 * DAY, past);         // review overdue by 2 days
  put(R_TONIGHT, 7, endOfDay - 60000, past);    // review due LATER today (11:59pm Melbourne)
  put(R_TOMORROW, 7, endOfDay + HOUR, past);    // review due tomorrow
});

afterEach(() => {
  sqlite.prepare("UPDATE settings SET srs_new_per_day = 20, srs_max_reviews_per_day = 200").run();
});

describe("spaced review is not a session", () => {
  it("creates no session row and returns no session id — the attempt log is the record", () => {
    sqlite.prepare("DELETE FROM mcq_study_sessions").run();
    const s = startSession(F);
    expect(s.mcqs.length).toBeGreaterThan(0);
    expect(s.sessionId).toBeNull();
    expect((sqlite.prepare("SELECT COUNT(*) c FROM mcq_study_sessions").get() as { c: number }).c).toBe(0);

    // Test/tutor sittings ARE records: a random draw that cannot be rebuilt.
    const tutor = startSession({ mode: "tutor", count: 3 });
    expect(typeof tutor.sessionId).toBe("string");
    expect((sqlite.prepare("SELECT COUNT(*) c FROM mcq_study_sessions").get() as { c: number }).c).toBe(1);
    sqlite.prepare("DELETE FROM mcq_study_sessions").run();
  });

  it("keeps spaced review out of the recent-sittings history, including old rows", () => {
    sqlite.prepare("DELETE FROM mcq_study_sessions").run();
    const ins = sqlite.prepare(
      "INSERT INTO mcq_study_sessions (id, mode, filters_json, total_questions, started_at, finished_at) VALUES (?, ?, '{}', 5, ?, ?)",
    );
    ins.run("old-srs", "srs", Date.now() - 1000, Date.now());   // written by an earlier build
    ins.run("a-tutor", "tutor", Date.now() - 2000, Date.now());
    const modes = getUserStats().recentSessions.map((r) => r.mode);
    expect(modes).toEqual(["tutor"]);
    sqlite.prepare("DELETE FROM mcq_study_sessions").run();
  });
});

describe("Anki-style SRS queue", () => {
  it("serves learning → day-due reviews → new, ignoring the requested count", () => {
    const stats = getSrsQueueStats(F);
    expect(stats.learning).toBe(2);       // L_LATER is beyond learn-ahead
    expect(stats.dueReviews).toBe(2);     // R_TONIGHT counts: Anki dues by DAY, not by the minute
    expect(stats.reviews).toBe(2);
    expect(stats.newToday).toBe(20);      // Anki's default new/day

    const ids = queueIds();
    // Lanes in order, oldest first within each.
    expect(ids.slice(0, 4)).toEqual([L_OVERDUE, L_SOON, R_OVERDUE, R_TONIGHT]);
    expect(ids).not.toContain(L_LATER);
    expect(ids).not.toContain(R_TOMORROW);
    // count:5 was ignored — the sitting is today's work: 2+2 due + 20 new.
    expect(ids.length).toBe(24);
  });

  it("caps due reviews at srs_max_reviews_per_day, oldest first — learning is never capped", () => {
    sqlite.prepare("UPDATE settings SET srs_max_reviews_per_day = 1").run();
    const stats = getSrsQueueStats(F);
    expect(stats.dueReviews).toBe(2);
    expect(stats.reviews).toBe(1);
    const ids = queueIds();
    expect(ids).toContain(R_OVERDUE);     // the older due wins the single slot
    expect(ids).not.toContain(R_TONIGHT);
    expect(ids.slice(0, 2)).toEqual([L_OVERDUE, L_SOON]); // learning untouched by the cap
  });

  it("caps new intake at srs_new_per_day, minus questions already introduced today", () => {
    sqlite.prepare("UPDATE settings SET srs_new_per_day = 3").run();
    expect(getSrsQueueStats(F).newToday).toBe(3);

    // A state row born today consumes one of the day's new slots.
    put(UNTRACKED, 1, Date.now() + 3 * DAY, Date.now());
    expect(getSrsQueueStats(F).newToday).toBe(2);
    sqlite.prepare("DELETE FROM mcq_srs_state WHERE mcq_id = ?").run(UNTRACKED);
  });

  it("counts reviews rated today against the daily limit — by LANE, not by state", () => {
    sqlite.prepare("DELETE FROM mcq_attempts").run();
    sqlite.prepare("UPDATE settings SET srs_max_reviews_per_day = 2").run();
    const ins = sqlite.prepare(
      "INSERT INTO mcq_attempts (mcq_id, session_id, mode, selected, correct, time_ms, attempted_at, srs_lane) VALUES (?, 's', 'srs', 'A', 1, 500, ?, ?)",
    );
    // One question answered out of the REVIEW lane today spends one slot.
    ins.run(R_OVERDUE, Date.now(), "review");
    expect(getSrsQueueStats(F).limits.reviewsRemaining).toBe(1);

    // Learning and new lanes are exempt — they never withhold a due review.
    ins.run(L_OVERDUE, Date.now(), "learning");
    ins.run(UNTRACKED, Date.now(), "new");
    expect(getSrsQueueStats(F).limits.reviewsRemaining).toBe(1);

    // Attempts predating the lane migration carry no lane and don't count;
    // the day's allowance is only ever under-spent, never over-spent.
    sqlite.prepare(
      "INSERT INTO mcq_attempts (mcq_id, session_id, mode, selected, correct, time_ms, attempted_at) VALUES (?, 's', 'srs', 'A', 1, 500, ?)",
    ).run(R_TONIGHT, Date.now());
    expect(getSrsQueueStats(F).limits.reviewsRemaining).toBe(1);
    sqlite.prepare("DELETE FROM mcq_attempts").run();
  });

  it("Again keeps a question in today's learning lane; Good graduates it out", () => {
    submitAttempt({ mcqId: L_OVERDUE, sessionId: null, mode: "srs", selected: answerOf(L_OVERDUE), timeMs: 500 });
    rateSrsAttempt({ mcqId: L_OVERDUE, sessionId: null, rating: 1 });
    expect(queueIds()).toContain(L_OVERDUE);      // due in 10 min — learn-ahead serves it

    submitAttempt({ mcqId: L_SOON, sessionId: null, mode: "srs", selected: answerOf(L_SOON), timeMs: 500 });
    rateSrsAttempt({ mcqId: L_SOON, sessionId: null, rating: 3 });
    expect(queueIds()).not.toContain(L_SOON);     // graduated: interval >= 1 day, due beyond today
  });

  it("stamps created_at at the row's birth and never on later reviews", () => {
    submitAttempt({ mcqId: UNTRACKED, sessionId: null, mode: "srs", selected: answerOf(UNTRACKED), timeMs: 500 });
    rateSrsAttempt({ mcqId: UNTRACKED, sessionId: null, rating: 3 });
    const born = (sqlite.prepare("SELECT created_at c FROM mcq_srs_state WHERE mcq_id = ?").get(UNTRACKED) as { c: number }).c;
    expect(born).toBeGreaterThanOrEqual(localMidnightMs(todayISO()));

    submitAttempt({ mcqId: UNTRACKED, sessionId: null, mode: "srs", selected: answerOf(UNTRACKED), timeMs: 500 });
    rateSrsAttempt({ mcqId: UNTRACKED, sessionId: null, rating: 3 });
    const after = (sqlite.prepare("SELECT created_at c FROM mcq_srs_state WHERE mcq_id = ?").get(UNTRACKED) as { c: number }).c;
    expect(after).toBe(born);
  });
});
