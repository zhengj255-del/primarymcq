// -------------------------------------------------------------------------------------------------
// MCQ study engine — Test / Tutor / SRS modes.
//
// Sits on top of the mcqs corpus + mcq_lo_links (from server/mcqs.ts) and adds
// three lightweight tables (already created in storage.ts bootstrap):
//   - mcq_study_sessions  (one row per logical study session)
//   - mcq_attempts        (append-only log of every answered/skipped question)
//   - mcq_srs_state       (per-MCQ FSRS-6 scheduling state; see FSRS_W below)
//
// All timestamps are milliseconds since epoch. Single-user app: no user_id.
// -------------------------------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { sqlite, appTzDateISO, todayISO, addDaysISO, daysBetweenISO, localMidnightMs } from "./storage";
import { EFFECTIVE_ANSWER_SQL, NOT_DISCARDED_SQL, NOT_DISPUTED_SQL_M, SRS_SITTABLE_SQL, WEAK_AREAS_SQL } from "./mcqSittable";
import type {
  SessionFilters, SubmitAttempt, SessionSummary, McqUserStats,
  McqRecord, McqStudySession,
} from "@shared/schema";
import { getMcq } from "./mcqs";

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

const DAY_MS = 86400000;

function now(): number { return Date.now(); }

// -------------------------------------------------------------------------------------------------
// MCQ selection — assemble a filtered pool and randomly pick `count` ids.
// -------------------------------------------------------------------------------------------------

interface SelectionOpts {
  filters: SessionFilters;
  count: number;
  now: number;
}

// THE pool predicate (EFFECTIVE_ANSWER_SQL / NOT_DISCARDED_SQL /
// SRS_SITTABLE_SQL) lives in ./mcqSittable so every reader — the pools, the
// queue and the counts that describe them — shares the one definition instead
// of inlining its own copy. See that file for why.

// Scope filters shared by every mode's pool (alias m = mcqs): the question
// must be sittable (effective answer, not discarded) and inside the user's
// chosen slice of the bank.
function scopeWhere(filters: SessionFilters): { where: string[]; params: unknown[] } {
  const where: string[] = [
    // EFFECTIVE answer (an override can add one, or clear one with '') — the
    // pool must match the withAnswer stat the UI shows.
    EFFECTIVE_ANSWER_SQL,
    // Questions discarded in dispute triage never enter a study pool.
    NOT_DISCARDED_SQL,
  ];
  const params: unknown[] = [];

  if (filters.topics && filters.topics.length > 0) {
    where.push(`m.topic_slug IN (${filters.topics.map(() => "?").join(",")})`);
    params.push(...filters.topics);
  }
  if (filters.domains && filters.domains.length > 0) {
    where.push(`m.domain IN (${filters.domains.map(() => "?").join(",")})`);
    params.push(...filters.domains);
  }
  if (filters.loCodes && filters.loCodes.length > 0) {
    where.push(
      `m.id IN (SELECT mcq_id FROM mcq_lo_links WHERE lo_code IN (${filters.loCodes.map(() => "?").join(",")}))`,
    );
    params.push(...filters.loCodes);
  }
  if (filters.papers && filters.papers.length > 0) {
    // papers is a JSON array column; substring-match each quoted tag (same
    // technique as listMcqs' paper filter). Enables "sit the Apr01 paper".
    where.push(`(${filters.papers.map(() => "m.papers LIKE ?").join(" OR ")})`);
    params.push(...filters.papers.map((p) => `%${JSON.stringify(p).slice(1, -1)}%`));
  }
  if (filters.excludeDisputed) {
    // Effective dispute (override wins over base) — same definition as the
    // MCQs page filter and stats. The raw base column kept excluding disputes
    // the user already resolved in triage, and never excluded ones they raised.
    // THE shared constant, not a retyped copy: SRS_SITTABLE_SQL carries the
    // same test, and the count and the queue lying to each other is precisely
    // the defect that predicate exists to prevent.
    where.push(NOT_DISPUTED_SQL_M);
  }
  return { where, params };
}

function pickMcqIds(opts: SelectionOpts): string[] {
  const { filters, count } = opts;
  const { where, params } = scopeWhere(filters);
  // "Completed" means the question has an actually-submitted answer. Skipped
  // attempts (selected IS NULL) don't count as completed. SRS mode never
  // reaches this function (srsQueueParts owns that pool), so completion and
  // weak-areas here only ever shape test/tutor sittings.
  if (filters.completion === "completed") {
    where.push("EXISTS (SELECT 1 FROM mcq_attempts a WHERE a.mcq_id = m.id AND a.selected IS NOT NULL)");
  } else if (filters.completion === "not-completed") {
    where.push("NOT EXISTS (SELECT 1 FROM mcq_attempts a WHERE a.mcq_id = m.id AND a.selected IS NOT NULL)");
  } else if (filters.completion === "review") {
    // Review pool: questions never answered CORRECTLY — unseen OR previously
    // incorrect. A single correct attempt removes it from the pool.
    where.push("NOT EXISTS (SELECT 1 FROM mcq_attempts a WHERE a.mcq_id = m.id AND a.correct = 1)");
  }
  if (filters.weakAreas) {
    // Bottom-quartile topics by accuracy (only those with attempts).
    const weakSlugs = computeWeakTopicSlugs();
    if (weakSlugs.length > 0) {
      where.push(`m.topic_slug IN (${weakSlugs.map(() => "?").join(",")})`);
      params.push(...weakSlugs);
    }
  }

  const rows = sqlite.prepare(
    `SELECT m.id FROM mcqs m
     WHERE ${where.join(" AND ")}
     ORDER BY RANDOM()
     LIMIT ?`,
  ).all(...params, count) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// -------------------------------------------------------------------------------------------------
// Anki-style SRS queue.
//
// Three lanes, served in order, mirroring Anki's day model:
//   1. LEARNING — questions in a (re)learn step (interval_days < 1: a lapse,
//      or a seeded relearn-now). Served once their step timer is inside
//      Anki's default 20-minute learn-ahead window, oldest first. Never spends
//      the daily REVIEW allowance — same as Anki — but bounded PER SITTING
//      (see LEARNING_LANE_CAP below).
//   2. REVIEWS — graduated questions (interval_days >= 1) due before the END
//      of the Melbourne day. Anki schedules reviews at day granularity: a
//      question rated 11pm yesterday is due this morning, not 11pm tonight.
//      Oldest due first, capped by what's left of srs_max_reviews_per_day.
//   3. NEW — never-tracked questions, random order, capped by what's left of
//      srs_new_per_day.
//
// "Done today" accounting runs on Melbourne days: reviews done = distinct
// questions rated today OUT OF THE REVIEW LANE (the lane is stamped on the
// attempt at rating time, so relearning steps never spend review allowance);
// new introduced = state rows born today (created_at). Limits live in
// app Settings.
//
// SCOPE vs LIMITS. The lanes are filtered by the user's scope (topics /
// domains / LOs / disputed); the daily limits are deliberately BANK-WIDE, one
// budget for the whole corpus, which is what the Settings copy promises and
// what stops scope-switching from minting fresh allowance. That means "0 new"
// can mean "today's budget is spent" rather than "nothing left to learn here",
// so the stats below report `newAvailable` / `dueReviews` (what exists in
// scope) alongside `newToday` / `reviews` (what this sitting will serve) and
// the client distinguishes the two.
// -------------------------------------------------------------------------------------------------

const LEARN_AHEAD_MS = 20 * 60 * 1000; // Anki's default learn-ahead limit

// Per-SITTING bound on the learning lane. It is NOT a daily allowance: nothing
// is "spent", overflow stays due, and reopening Study serves the next batch —
// which is right, because relearn steps are due within minutes anyway. It
// exists because two operations mint interval-0 rows in BULK, outside anything
// Anki has an equivalent for: resetSrsOnKeyChange (every applied answer-key
// change — a triage fix, a hand edit, or a revert) and the one-shot seed's
// relearn-now branch. Without it a run of key changes produced one sitting of
// every question it touched, with srs_max_reviews_per_day and srs_new_per_day
// both powerless to bound it. Reuses the review limit rather than adding a
// knob: whatever the user considers a day's worth of reviewing is a sane
// ceiling on a single sitting.
const learningLaneCap = (maxReviewsPerDay: number) => Math.max(20, maxReviewsPerDay);

function srsDailyLimits(): { newPerDay: number; maxReviewsPerDay: number } {
  const row = sqlite.prepare(
    "SELECT srs_new_per_day AS n, srs_max_reviews_per_day AS r FROM settings LIMIT 1",
  ).get() as { n: number; r: number } | undefined;
  return { newPerDay: Math.max(0, row?.n ?? 20), maxReviewsPerDay: Math.max(0, row?.r ?? 200) };
}

// -------------------------------------------------------------------------------------------------
// "Study more new today" — Anki's custom-study "increase today's new card
// limit", from the SRS setup panel instead of a Settings round-trip. The boost
// lives in mcq_srs_extra_new keyed by Melbourne day, so it stacks with the
// day's ordinary allowance, is spent by the same introducedToday accounting,
// and expires at midnight without touching srs_new_per_day (tomorrow returns
// to normal). Bank-wide like the base limit — scope-switching must not mint
// fresh allowance here either.
// -------------------------------------------------------------------------------------------------

function srsExtraNewToday(): number {
  const row = sqlite.prepare("SELECT extra FROM mcq_srs_extra_new WHERE day = ?")
    .get(todayISO()) as { extra: number } | undefined;
  return Math.max(0, row?.extra ?? 0);
}

/** Cumulative cap on a day's boost — a fat-fingered 5000 would otherwise pin
 *  the queue to the whole bank for the rest of the day with no way back. */
export const SRS_EXTRA_NEW_DAILY_CAP = 500;

/** How many introductions today have already overrun the standing daily
 *  limit. Normally covered by the day's boost row, but a boost withdrawn
 *  part-spent or a limit lowered mid-day leaves the overrun uncovered. */
function srsIntroDeficit(day: string): number {
  const { newPerDay } = srsDailyLimits();
  const introducedToday = (sqlite.prepare(
    "SELECT COUNT(*) c FROM mcq_srs_state WHERE created_at >= ?",
  ).get(localMidnightMs(day)) as { c: number }).c;
  return Math.max(0, introducedToday - newPerDay);
}

/** Grant `count` extra new-card slots for TODAY (adds to any earlier grant).
 *  Returns the day's total boost after the grant. */
export function addSrsExtraNew(count: number): { day: string; extraNew: number } {
  const add = Math.floor(count);
  if (!Number.isFinite(add) || add < 1) throw new Error("count must be a positive integer");
  const day = todayISO();
  const tx = sqlite.transaction(() => {
    // Spent boosts from previous days are dead rows — this table only ever
    // answers "how much extra TODAY", so prune on write.
    sqlite.prepare("DELETE FROM mcq_srs_extra_new WHERE day != ?").run(day);
    // The button's promise is N MORE cards. Allowance is newPerDay + extra −
    // introducedToday, so when introductions already overrun newPerDay + extra
    // (a boost withdrawn part-spent, or the standing limit lowered mid-day) a
    // flat `extra + N` is swallowed by that deficit and the click serves
    // nothing. Top the row up to the deficit first so exactly N slots open.
    const base = Math.max(srsExtraNewToday(), srsIntroDeficit(day));
    sqlite.prepare(
      `INSERT INTO mcq_srs_extra_new (day, extra) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET extra = excluded.extra`,
    ).run(day, Math.min(SRS_EXTRA_NEW_DAILY_CAP, base + add));
  });
  tx();
  return { day, extraNew: srsExtraNewToday() };
}

/** Revoke today's boost (the misclick/regret path — a grant is otherwise
 *  irrevocable until midnight). Already-introduced questions keep their
 *  schedules; only the unspent allowance is withdrawn. The spent portion
 *  stays on the row: those introductions count in introducedToday forever,
 *  and deleting them from the ledger would leave a deficit that silently
 *  swallows the day's next grant. */
export function clearSrsExtraNew(): { day: string; extraNew: number } {
  const day = todayISO();
  const spent = Math.min(srsExtraNewToday(), srsIntroDeficit(day));
  const tx = sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM mcq_srs_extra_new").run();
    if (spent > 0) {
      sqlite.prepare("INSERT INTO mcq_srs_extra_new (day, extra) VALUES (?, ?)").run(day, spent);
    }
  });
  tx();
  return { day, extraNew: spent };
}

export interface SrsQueueStats {
  learning: number;      // (re)learn steps this sitting will actually serve
  dueLearning: number;   // (re)learn steps due now, before the per-sitting cap
  reviews: number;       // due reviews today's sitting will actually serve
  dueReviews: number;    // due reviews before the daily cap
  newToday: number;      // new intake today's sitting will actually serve
  newAvailable: number;  // never-tracked questions in scope
  limits: {
    newPerDay: number; maxReviewsPerDay: number;
    newRemaining: number; reviewsRemaining: number;
    learningPerSitting: number;
    /** Today's "study more new" boost on top of newPerDay (0 = none granted). */
    extraNewToday: number;
  };
}

function srsQueueParts(filters: SessionFilters, t: number): {
  learning: string[]; reviews: string[]; fresh: string[]; stats: SrsQueueStats;
} {
  const { where, params } = scopeWhere(filters);
  const scope = where.join(" AND ");
  const todayMid = localMidnightMs(todayISO());
  const endOfDay = localMidnightMs(addDaysISO(todayISO(), 1));
  const { newPerDay, maxReviewsPerDay } = srsDailyLimits();

  const introducedToday = (sqlite.prepare(
    `SELECT COUNT(*) c FROM mcq_srs_state WHERE created_at >= ?`,
  ).get(todayMid) as { c: number }).c;
  // Only questions RATED out of the review lane spend the review allowance —
  // the lane is stamped on the attempt at rating time. Relearning steps and
  // new intake are exempt, exactly as in Anki, so a relearn backlog can never
  // withhold genuine due reviews.
  const reviewsDoneToday = (sqlite.prepare(
    `SELECT COUNT(DISTINCT a.mcq_id) c
       FROM mcq_attempts a
      WHERE a.mode = 'srs' AND a.srs_lane = 'review' AND a.attempted_at >= ?`,
  ).get(todayMid) as { c: number }).c;
  // Today's allowance = the standing daily limit + any "study more new today"
  // boost. The boost is spent by the same introducedToday counter, so serving
  // the extra cards uses it up rather than re-minting it every sitting.
  const extraNewToday = srsExtraNewToday();
  const newRemaining = Math.max(0, newPerDay + extraNewToday - introducedToday);
  const reviewsRemaining = Math.max(0, maxReviewsPerDay - reviewsDoneToday);

  // `, s.mcq_id` is a TIEBREAK, not decoration. Since due_at became the start
  // of the Melbourne day an interval lands on (srsOutcomes), every review
  // scheduled for the same day carries the SAME due_at, so ordering by due_at
  // alone left within-day order to whatever row order SQLite happened to
  // choose — unstable across an index change and not reproducible for the
  // owner, who can reopen the queue and see a different sequence. mcq_id is
  // stable, unique and already the join key.
  const dueLearningIds = (sqlite.prepare(
    `SELECT m.id FROM mcqs m JOIN mcq_srs_state s ON s.mcq_id = m.id
      WHERE ${scope} AND s.interval_days < 1 AND s.due_at <= ?
      ORDER BY s.due_at ASC, s.mcq_id ASC`,
  ).all(...params, t + LEARN_AHEAD_MS) as Array<{ id: string }>).map((r) => r.id);
  const learningPerSitting = learningLaneCap(maxReviewsPerDay);
  const learning = dueLearningIds.slice(0, learningPerSitting);

  const dueReviewIds = (sqlite.prepare(
    `SELECT m.id FROM mcqs m JOIN mcq_srs_state s ON s.mcq_id = m.id
      WHERE ${scope} AND s.interval_days >= 1 AND s.due_at < ?
      ORDER BY s.due_at ASC, s.mcq_id ASC`,
  ).all(...params, endOfDay) as Array<{ id: string }>).map((r) => r.id);
  const reviews = dueReviewIds.slice(0, reviewsRemaining);

  const newAvailable = (sqlite.prepare(
    `SELECT COUNT(*) c FROM mcqs m LEFT JOIN mcq_srs_state s ON s.mcq_id = m.id
      WHERE ${scope} AND s.mcq_id IS NULL`,
  ).get(...params) as { c: number }).c;
  // srsSkipNew: the user wants this sitting to be pure catch-up — learning +
  // reviews, no new intake. Nothing is spent (allowance is only consumed when
  // a new question is RATED, and none are served), so the day's remaining
  // budget survives for a later sitting with the toggle off.
  const fresh = newRemaining > 0 && !filters.srsSkipNew
    ? (sqlite.prepare(
        `SELECT m.id FROM mcqs m LEFT JOIN mcq_srs_state s ON s.mcq_id = m.id
          WHERE ${scope} AND s.mcq_id IS NULL
          ORDER BY RANDOM() LIMIT ?`,
      ).all(...params, newRemaining) as Array<{ id: string }>).map((r) => r.id)
    : [];

  return {
    learning, reviews, fresh,
    stats: {
      learning: learning.length,
      dueLearning: dueLearningIds.length,
      reviews: reviews.length,
      dueReviews: dueReviewIds.length,
      newToday: fresh.length,
      newAvailable,
      limits: { newPerDay, maxReviewsPerDay, newRemaining, reviewsRemaining, learningPerSitting, extraNewToday },
    },
  };
}

// (The queue itself is assembled inline in startSession — learning, then
// reviews, then new.)

/** The Anki-style setup numbers (learning / due / new) for a filter scope. */
export function getSrsQueueStats(filters: SessionFilters): SrsQueueStats {
  return srsQueueParts(filters, now()).stats;
}

// Bottom-quartile topics by overall accuracy — only include topics with >=5 attempts.
//
// This is a deliberate second copy of the weak-area SQL, and it stays a copy:
// it asks a DIFFERENT question from WEAK_AREAS_SQL and must not be "unified"
// with it. The shared constant answers "which topics do I SHOW the candidate
// as weak", and is capped at LIMIT 8 because that is a list on a page. This
// one answers "which topics does the weak-areas FILTER sample from", and the
// answer is a quartile — `Math.ceil(rows.length / 4)` below — so it needs the
// FULL set of qualifying topics as its denominator. Borrowing the constant
// would silently redefine the quartile as a quarter of eight: a candidate with
// 40 attempted topics would have his weak-topics sitting drawn from 2 topics
// instead of 10, and nothing would look broken.
//
// Everything else about the two IS the same on purpose and must stay so: the
// `a.selected IS NOT NULL` reveal test (a "Don't know" is not a wrong answer),
// the `HAVING attempts >= 5` bar, and the accuracy ordering. The name column
// and the COALESCE around SUM(a.correct) are absent here only because this
// query returns slugs and never divides a NULL — mcq_attempts.correct is NOT
// NULL and HAVING guarantees at least five rows per group.
function computeWeakTopicSlugs(): string[] {
  const rows = sqlite.prepare(`
    SELECT m.topic_slug as slug,
           COUNT(*) as attempts,
           SUM(a.correct) as correct
    FROM mcq_attempts a
    JOIN mcqs m ON m.id = a.mcq_id
    WHERE a.selected IS NOT NULL
    GROUP BY m.topic_slug
    HAVING attempts >= 5
    ORDER BY (CAST(correct AS REAL) / attempts) ASC
  `).all() as Array<{ slug: string; attempts: number; correct: number }>;
  if (rows.length === 0) return [];
  const q = Math.max(1, Math.ceil(rows.length / 4));
  return rows.slice(0, q).map((r) => r.slug);
}

// -------------------------------------------------------------------------------------------------
// Session lifecycle
// -------------------------------------------------------------------------------------------------

export interface StartSessionResult {
  // null in SRS: spaced review is not a "session". See startSession.
  sessionId: string | null;
  mode: "test" | "tutor" | "srs";
  mcqs: McqRecord[];
  timeLimitSec: number | null;
}

export function startSession(filters: SessionFilters): StartSessionResult {
  const t = now();
  // SRS ignores the requested count: the sitting is "today's work" — due
  // learning + capped reviews + capped new intake — exactly like opening an
  // Anki deck. Test/tutor keep the user-chosen size.
  let mcqs: McqRecord[];
  if (filters.mode === "srs") {
    const parts = srsQueueParts(filters, t);
    mcqs = [...parts.learning, ...parts.reviews, ...parts.fresh]
      .map((id) => getMcq(id))
      .filter((m): m is McqRecord => !!m);
  } else {
    const ids = pickMcqIds({ filters, count: filters.count, now: t });
    mcqs = ids.map((id) => getMcq(id)).filter((m): m is McqRecord => !!m);
  }

  // Spaced review is NOT a session. A test or tutor sitting is a randomly
  // drawn sample that exists only because we drew it — it has a start, an
  // end, a score, and it cannot be reconstructed, so it is recorded. An SRS
  // queue is pure derived state: it IS whatever is due right now, it empties
  // as you answer, and reopening rebuilds it. Recording it invented a
  // scored, resumable object where Anki has none — which is what produced
  // 0-question session rows, totals that disagreed with requeues, and
  // "sittings" in the history that were really just a day's reviews.
  // Attempts carry session_id NULL in SRS; the attempt log is the record.
  if (filters.mode === "srs") {
    return { sessionId: null, mode: filters.mode, mcqs, timeLimitSec: null };
  }

  const sessionId = randomUUID();
  sqlite.prepare(
    `INSERT INTO mcq_study_sessions (id, mode, filters_json, total_questions, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(sessionId, filters.mode, JSON.stringify(filters), mcqs.length, t);
  return {
    sessionId,
    mode: filters.mode,
    mcqs,
    timeLimitSec: filters.timeLimitSec ?? null,
  };
}

export interface SubmitAttemptResult {
  correct: boolean;
  correctAnswer: string | null;
  reason: string;
  srs?: { dueAt: number; intervalDays: number; stability: number; difficulty: number; reps: number };
  // SRS reveal only: what each rating button would schedule, in days
  // (again = 0 = the 10-minute relearn step). Computed from the same outcome
  // table the rating itself uses, so the labels are exact promises.
  srsPreview?: { again: number; hard: number; good: number; easy: number };
}

// Log a single answered/skipped question. This is the ONE place an attempt row
// is written per completed question — for every mode, including SRS. SRS
// scheduling is intentionally NOT performed here: in SRS mode the flow is
// (1) reveal → submitAttempt logs the attempt, then (2) rate → rateSrsAttempt
// advances the interval exactly once. Doing both here would double-count.
export function submitAttempt(data: SubmitAttempt): SubmitAttemptResult {
  const mcq = getMcq(data.mcqId);
  if (!mcq) throw new Error(`MCQ ${data.mcqId} not found`);

  const keyed = mcq.answer;
  const correct = data.selected !== null && keyed !== null &&
    data.selected.toUpperCase() === keyed.toUpperCase();
  const t = now();

  sqlite.prepare(
    `INSERT INTO mcq_attempts
      (mcq_id, session_id, mode, selected, correct, time_ms, attempted_at, rating)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.mcqId,
    data.sessionId ?? null,
    data.mode,
    data.selected,
    correct ? 1 : 0,
    data.timeMs,
    t,
    data.rating ?? null,
  );

  return {
    correct,
    correctAnswer: keyed,
    reason: mcq.reason,
    // SRS reveal: the rating buttons carry their consequences, Anki-style.
    ...(data.mode === "srs" ? { srsPreview: previewSrsIntervals(data.mcqId, t) } : {}),
  };
}

export interface RateSrsAttemptInput {
  mcqId: string;
  sessionId?: string | null;
  rating: number; // 1..4
}

// Apply the SRS schedule for a question that was already logged via
// submitAttempt. Advances the interval exactly once and records the rating
// against that attempt row (so the attempt log and schedule agree).
//
// PRECONDITION, enforced: the newest attempt for this question must be an SRS
// reveal that has not been rated yet. Without it the endpoint would (a) happily
// schedule a question that was never answered — breaking this module's own
// "the attempt log is the record" contract, since nothing then counts toward
// reviewsDoneToday or any stat — and (b) re-apply on a duplicate POST, so one
// double-tap turned a 24-day interval into 35. It also used to stamp the rating
// onto whatever the newest row happened to be, tutor attempts included, which
// then surfaced in that tutor session's summary.
export function rateSrsAttempt(input: RateSrsAttemptInput): SubmitAttemptResult["srs"] {
  const mcq = getMcq(input.mcqId);
  if (!mcq) throw new Error(`MCQ ${input.mcqId} not found`);
  const t = now();

  // The attempt row this rating annotates — resolved BEFORE the update so the
  // undo record can name it precisely.
  const row = sqlite.prepare(
    input.sessionId != null
      ? `SELECT id, mode, correct, rating, srs_lane AS lane FROM mcq_attempts WHERE mcq_id = ? AND session_id = ? ORDER BY id DESC LIMIT 1`
      : `SELECT id, mode, correct, rating, srs_lane AS lane FROM mcq_attempts WHERE mcq_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(...(input.sessionId != null ? [input.mcqId, input.sessionId] : [input.mcqId])) as
    { id: number; mode: string; correct: number; rating: number | null; lane: string | null } | undefined;

  if (!row || row.mode !== "srs") {
    throw new Error(`No SRS reveal to rate for MCQ ${input.mcqId} — reveal the answer first`);
  }
  if (row.rating != null) {
    throw new Error(`That reveal of MCQ ${input.mcqId} was already rated`);
  }
  // A wrong answer — or a "Don't know" reveal — is not self-graded. Unlike a
  // flashcard, an MCQ carries its own evidence: the selected option either
  // matched the key or it didn't, and if it didn't, the recall failed. Letting
  // the user press Good on a missed question would push it weeks out on a
  // memory the attempt just disproved, so the only rating the server accepts
  // for an incorrect attempt is Again. Correct answers keep all four buttons —
  // including Again, because a lucky guess is the user's to confess.
  if (row.correct === 0 && input.rating !== 1) {
    throw new Error(`MCQ ${input.mcqId} was answered incorrectly — a missed question can only be rated Again`);
  }

  // Which lane this question was served from — read BEFORE the update
  // overwrites the state. Anki's daily review limit counts only what came out
  // of the review queue; (re)learning steps are exempt, so without this the
  // relearn backlog would eat the day's review allowance.
  //
  // The split MUST match the one the queue serves by (interval_days), not
  // stability. Keying "new" off stability <= 0 disagreed for every row with a
  // graduated interval and an uninitialised memory — the seed's ~200
  // verification-pass rows, and every row that predates the FSRS migration
  // (ALTER TABLE ... stability REAL NOT NULL DEFAULT 0). Those were served out
  // of the review lane and stamped 'new', so they never spent the day's review
  // allowance and srs_max_reviews_per_day was unenforceable across sittings.
  const before = getSrsRow(input.mcqId);
  const lane = !before ? "new" : before.interval_days >= 1 ? "review" : "learning";

  // One transaction: a throw between the three writes would otherwise leave an
  // advanced schedule with no undo record, or a rated schedule whose attempt
  // carries no lane (and so never spends the review allowance).
  const tx = sqlite.transaction(() => {
    const srs = applySrsUpdate(input.mcqId, input.rating, t);
    sqlite.prepare(`UPDATE mcq_attempts SET rating = ?, srs_lane = ? WHERE id = ?`)
      .run(input.rating, lane, row.id);
    pushSrsUndo(input.mcqId, before, row, t);
    return srs;
  });
  return tx();
}

// -------------------------------------------------------------------------------------------------
// Undo — for the misclick ("Good" on a question that deserved "Again").
//
// FSRS has no inverse: stability and difficulty are lossy functions of the
// state they replaced, so a rating cannot be computed backwards. Undo
// therefore restores a RECORD of the exact prior state, captured at rating
// time. It also clears the rating and lane stamp from the attempt row, which
// hands back the daily-review slot the rating spent. The user's ANSWER is
// untouched — they did answer the question; only the self-rating is undone.
// -------------------------------------------------------------------------------------------------

const UNDO_DEPTH = 20;

function pushSrsUndo(
  mcqId: string,
  before: SrsRow | undefined,
  attempt: { id: number; rating: number | null; lane: string | null } | undefined,
  t: number,
): void {
  sqlite.prepare(
    `INSERT INTO mcq_srs_undo
       (mcq_id, attempt_id, had_state, ease_factor, interval_days, reps, lapses,
        last_reviewed_at, due_at, stability, difficulty, created_at, prev_rating, prev_lane, rated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    mcqId, attempt?.id ?? null, before ? 1 : 0,
    before?.ease_factor ?? null, before?.interval_days ?? null, before?.reps ?? null,
    before?.lapses ?? null, before?.last_reviewed_at ?? null, before?.due_at ?? null,
    before?.stability ?? null, before?.difficulty ?? null,
    before?.created_at ?? null,
    attempt?.rating ?? null, attempt?.lane ?? null, t,
  );
  // Keep the stack shallow — this is a misclick net, not a full history.
  sqlite.prepare(
    `DELETE FROM mcq_srs_undo WHERE id NOT IN (SELECT id FROM mcq_srs_undo ORDER BY id DESC LIMIT ?)`,
  ).run(UNDO_DEPTH);
}

export interface SrsUndoResult {
  mcqId: string;
  /** What the rating buttons should read now that the schedule is back. */
  preview: { again: number; hard: number; good: number; easy: number };
}

/** Revert the most recent SRS rating. Returns null when there is nothing to undo. */
export function undoLastSrsRating(): SrsUndoResult | null {
  const rec = sqlite.prepare(
    `SELECT * FROM mcq_srs_undo ORDER BY id DESC LIMIT 1`,
  ).get() as {
    id: number; mcq_id: string; attempt_id: number | null; had_state: number;
    ease_factor: number | null; interval_days: number | null; reps: number | null;
    lapses: number | null; last_reviewed_at: number | null; due_at: number | null;
    stability: number | null; difficulty: number | null; created_at: number | null;
    prev_rating: number | null; prev_lane: string | null;
  } | undefined;
  if (!rec) return null;

  const tx = sqlite.transaction(() => {
    if (rec.had_state === 1) {
      sqlite.prepare(
        `UPDATE mcq_srs_state
            SET ease_factor = ?, interval_days = ?, reps = ?, lapses = ?,
                last_reviewed_at = ?, due_at = ?, stability = ?, difficulty = ?, created_at = ?
          WHERE mcq_id = ?`,
      ).run(
        rec.ease_factor, rec.interval_days, rec.reps, rec.lapses,
        rec.last_reviewed_at, rec.due_at, rec.stability, rec.difficulty, rec.created_at,
        rec.mcq_id,
      );
    } else {
      // The rating introduced this question; undoing it makes it new again,
      // which also gives back the new-intake slot it consumed today.
      sqlite.prepare(`DELETE FROM mcq_srs_state WHERE mcq_id = ?`).run(rec.mcq_id);
    }
    if (rec.attempt_id != null) {
      sqlite.prepare(`UPDATE mcq_attempts SET rating = ?, srs_lane = ? WHERE id = ?`)
        .run(rec.prev_rating, rec.prev_lane, rec.attempt_id);
    }
    sqlite.prepare(`DELETE FROM mcq_srs_undo WHERE id = ?`).run(rec.id);
  });
  tx();

  return { mcqId: rec.mcq_id, preview: previewSrsIntervals(rec.mcq_id) };
}

// FSRS-6 — Anki's scheduler (Free Spaced Repetition Scheduler), ported
// formula-for-formula from the reference implementation in
// open-spaced-repetition/fsrs4anki (fsrs4anki_scheduler.js v6.1.1), replacing
// the earlier SM-2-lite. Same four ratings (1 Again · 2 Hard · 3 Good ·
// 4 Easy), same reveal-then-rate flow; what changes is the memory model: each
// question carries
//   stability  S — days for recall probability to fall to 90%
//   difficulty D — 1..10, how much a lapse costs this question
// and the next interval is chosen so predicted retrievability at review time
// equals the retention target (default 0.9, i.e. review when ~10% forgotten).
// Weights are the FSRS-6 defaults every fresh Anki ships — per-user
// optimisation needs months of review history.
// Known deviations from Anki, all deliberate:
//   · no (re)learning-step queue — Again is a single 10-minute step, and a
//     first-rating Hard is day-scheduled from S0(Hard) instead of held in
//     learning;
//   · maximum interval 365 days (Anki defaults to 100 years) — the exam is
//     the horizon here;
//   · interval fuzz is seeded from (question, rep count) instead of a stored
//     PRNG state, so schedules are reproducible.
const FSRS_W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722,
  0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425,
  0.0912, 0.0658, 0.1542,
] as const;
// FSRS-6 learns the forgetting-curve shape per user too (w20); FSRS-5 fixed
// DECAY at -0.5. FACTOR keeps R(interval, S) = 90% by construction.
const FSRS_DECAY = -FSRS_W[20];
const FSRS_FACTOR = Math.pow(0.9, 1 / FSRS_DECAY) - 1;
const MAX_INTERVAL_DAYS = 365;
// Scheduling knobs live in app Settings (Settings page → MCQ spaced
// repetition), read fresh on every scheduling decision so a save applies to
// the very next rating. The MCQ_SRS_* env vars remain as an override that
// wins when set — an ops escape hatch, and how the tests pin behaviour.
function srsKnobRow(): { retention: number; fuzz: number } | undefined {
  return sqlite.prepare(
    "SELECT srs_retention AS retention, srs_fuzz AS fuzz FROM settings LIMIT 1",
  ).get() as { retention: number; fuzz: number } | undefined;
}
// Review when predicted recall drops to this. Higher = shorter intervals and
// more reviews for a lower miss rate at the exam. Clamped to Anki's sane band.
const RETENTION = () => {
  const env = process.env.MCQ_SRS_RETENTION;
  const raw = env != null && env !== "" && Number.isFinite(Number(env))
    ? Number(env)
    : srsKnobRow()?.retention ?? 0.9;
  return Math.min(0.97, Math.max(0.7, raw));
};
// Fuzz (±5%ish, Anki's apply_fuzz) stops questions first seen together from
// travelling as a clump forever.
const FUZZ_ENABLED = () => {
  const env = process.env.MCQ_SRS_FUZZ;
  if (env != null && env !== "") return env !== "0";
  return (srsKnobRow()?.fuzz ?? 1) !== 0;
};

// The reference scheduler stores S and D rounded to 2dp (toFixed(2)) at every
// step; matching that keeps our trajectories bit-identical to Anki's.
const round2 = (x: number) => +x.toFixed(2);
const clampD = (d: number) => Math.min(Math.max(round2(d), 1), 10);
const initStability = (g: number) => round2(Math.max(FSRS_W[g - 1], 0.1));
const initDifficulty = (g: number) => clampD(FSRS_W[4] - Math.exp(FSRS_W[5] * (g - 1)) + 1);
/** Predicted recall probability after `days` on stability S (power curve). */
export function fsrsRetrievability(days: number, stability: number): number {
  return Math.pow(1 + (FSRS_FACTOR * days) / stability, FSRS_DECAY);
}
/** Deterministic stand-in for Anki's seeded PRNG: FNV-1a of (question, rep
 *  count) mapped to [0,1). Same review -> same fuzz, forever. */
function fuzzFactor(mcqId: string, reps: number): number {
  const key = `${mcqId}|${reps}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}
/** Anki's apply_fuzz: nothing under 2.5d; otherwise land in [95%−1, 105%+1],
 *  never shrinking a growing interval back to (or below) the previous one. */
function applyFuzz(ivl: number, fuzz: number, prevIvl: number): number {
  if (!FUZZ_ENABLED() || ivl < 2.5) return ivl;
  ivl = Math.round(ivl);
  let min = Math.max(2, Math.round(ivl * 0.95 - 1));
  const max = Math.round(ivl * 1.05 + 1);
  if (prevIvl > 0 && ivl > prevIvl) min = Math.max(min, prevIvl + 1);
  return Math.floor(fuzz * (max - min + 1) + min);
}
/** Days until predicted recall falls to the retention target: at 0.9 this is
 *  exactly S (FACTOR is constructed that way). Fuzzed, then clamped. */
function nextInterval(stability: number, fuzz: number, prevIvl: number): number {
  const raw = (stability / FSRS_FACTOR) * (Math.pow(RETENTION(), 1 / FSRS_DECAY) - 1);
  return Math.min(Math.max(Math.round(applyFuzz(raw, fuzz, prevIvl)), 1), MAX_INTERVAL_DAYS);
}
function nextDifficulty(d: number, g: number): number {
  const delta = -FSRS_W[6] * (g - 3);
  const damped = d + delta * ((10 - d) / 9); // linear damping toward the ceiling
  // Mean reversion toward D0(Easy) so difficulty can recover over time.
  return clampD(FSRS_W[7] * initDifficulty(4) + (1 - FSRS_W[7]) * damped);
}
function recallStability(s: number, d: number, r: number, g: number): number {
  const hardPenalty = g === 2 ? FSRS_W[15] : 1;
  const easyBonus = g === 4 ? FSRS_W[16] : 1;
  return round2(s * (1 + Math.exp(FSRS_W[8]) * (11 - d) * Math.pow(s, -FSRS_W[9]) *
    (Math.exp(FSRS_W[10] * (1 - r)) - 1) * hardPenalty * easyBonus));
}
function forgetStability(s: number, d: number, r: number): number {
  // sMin: a lapse never RAISES stability (v6 ceiling, replaces v5's min(s, ·)).
  const sMin = s / Math.exp(FSRS_W[17] * FSRS_W[18]);
  const sf = FSRS_W[11] * Math.pow(d, -FSRS_W[12]) *
    (Math.pow(s + 1, FSRS_W[13]) - 1) * Math.exp(FSRS_W[14] * (1 - r));
  // 0.01 floor: stability<=0 is our "uninitialised" sentinel and 2dp rounding
  // of a collapsed S must never fabricate it.
  return Math.max(0.01, round2(Math.min(sf, sMin)));
}
/** Same-day review: the power curve is meaningless at hours-scale, so FSRS-6
 *  has a dedicated short-term formula. Anything but Again can never shrink S
 *  here — the reference clamps at `rating >= 2` (fsrs-rs
 *  src/model.rs::stability_short_term), i.e. Hard is clamped too. Clamping only
 *  Good/Easy multiplied S by ~0.61 for a same-day Hard, stacking a second
 *  penalty on top of the Again that put the question in the relearn step. */
function shortTermStability(s: number, g: number): number {
  let sinc = Math.exp(FSRS_W[17] * (g - 3 + FSRS_W[18])) * Math.pow(s, -FSRS_W[19]);
  if (g >= 2) sinc = Math.max(sinc, 1);
  return Math.max(0.01, round2(s * sinc));
}

interface SrsRow {
  mcq_id: string; ease_factor: number; interval_days: number;
  reps: number; lapses: number; last_reviewed_at: number; due_at: number;
  stability: number; difficulty: number; created_at: number;
}

function getSrsRow(mcqId: string): SrsRow | undefined {
  return sqlite.prepare("SELECT * FROM mcq_srs_state WHERE mcq_id = ?").get(mcqId) as SrsRow | undefined;
}

interface SrsOutcome { stability: number; difficulty: number; intervalDays: number; dueAt: number }

// The full FSRS outcome table for one question at time t — what EACH of the
// four buttons would do. applySrsUpdate persists exactly one row of this
// table; the reveal-time preview shows all four. One shared computation is
// what keeps the button labels honest: they can never drift from what
// pressing the button actually schedules (deterministic fuzz included).
function srsOutcomes(cur: SrsRow | undefined, mcqId: string, t: number): Record<1 | 2 | 3 | 4, SrsOutcome> {
  // stability <= 0 marks an uninitialised memory: brand-new question, a row
  // seeded from tutor-era attempts (single attempts aren't review history),
  // or one whose schedule was reset because its keyed answer changed (all
  // prior feedback was against the old key). Either way the rating
  // (re)initialises S and D from scratch.
  const fresh = !cur || cur.stability <= 0;
  const prevS = fresh ? 0 : cur!.stability;
  const prevD = fresh ? 0 : cur!.difficulty > 0 ? cur!.difficulty : initDifficulty(3);
  // Elapsed time is counted in DAY BOUNDARIES CROSSED (Melbourne days), never
  // in elapsed hours. The reference scheduler takes `delta_t: u32` — whole days
  // from the collection's day cutoff — and switches to the short-term formula
  // only at `delta_t == 0` (fsrs-rs, src/model.rs::step).
  //
  // A rolling 24h test looks equivalent and is not, because this queue serves
  // reviews DAY-granularly on purpose (due_at < endOfDay, so "rated 11pm
  // yesterday" is served this morning). That guarantees a 1-day-interval
  // question is re-rated in UNDER 24 hours, which sent every one of them down
  // the same-day path: eight consecutive Goods 23h apart moved a card 1→1→1→1→
  // 1→2→2→2 days (S 1.29→1.59), where the same card 25h apart went 5→8→11→14→
  // 17 (S 17.23). It also broke the rating-button preview's exactness whenever
  // reveal and rating straddled the 24h mark.
  const elapsedDays = fresh
    ? 0
    : Math.max(0, daysBetweenISO(appTzDateISO(cur!.last_reviewed_at), appTzDateISO(t)));
  const sameDay = !fresh && elapsedDays === 0;

  // Memory state each button would produce. The neighbours matter: Anki
  // computes all four every review and guarantees Hard ≤ Good < Easy on the
  // intervals it offers, so we reproduce that ordering below.
  const nextState = (g: number): { s: number; d: number } => {
    if (fresh) return { s: initStability(g), d: initDifficulty(g) };
    const d = nextDifficulty(prevD, g);
    if (sameDay) return { s: shortTermStability(prevS, g), d };
    const r = fsrsRetrievability(elapsedDays, prevS);
    return { s: g === 1 ? forgetStability(prevS, prevD, r) : recallStability(prevS, prevD, r, g), d };
  };

  const again = nextState(1);
  const hardState = nextState(2);
  const goodState = nextState(3);
  const easyState = nextState(4);

  const fuzz = fuzzFactor(mcqId, cur?.reps ?? 0);
  const prevIvl = cur?.interval_days ?? 0;
  let hard = nextInterval(hardState.s, fuzz, prevIvl);
  let good = nextInterval(goodState.s, fuzz, prevIvl);
  let easy = nextInterval(easyState.s, fuzz, prevIvl);
  // Anki's ordering: on any review of an ESTABLISHED memory, Hard may never
  // outrun Good. That includes same-day reviews — the previous `!sameDay`
  // guard let a same-day Good offer the SAME interval as Hard (S 2.31 → Hard
  // 2d, Good 2d, where the reference gives 3d), and on a low-stability card
  // collapsed all three toward 1d. Differential-tested against ts-fsrs v5.4.1
  // over a 700-case (S, D, elapsed, rating) grid.
  //
  // The FIRST rating is deliberately exempt, because the reference exempts it:
  // a brand-new card at retention 0.97 schedules Hard 1d / Good 1d, and
  // forcing Good to 2d there would invent an interval FSRS does not.
  if (!fresh) {
    hard = Math.min(hard, good);
    good = Math.max(good, hard + 1);
  }
  // …and Easy always clears Good (every branch of the reference scheduler).
  easy = Math.max(easy, good + 1);

  // DUE AT THE START OF THE MELBOURNE DAY THE INTERVAL LANDS ON, not at the
  // 24 h × N anniversary of the rating.
  //
  // This queue is DAY-GRANULAR by design, and has been since it was written:
  // it counts elapsed time in day boundaries crossed (the long comment above),
  // serves reviews with `due_at < endOfDay` where endOfDay is the next local
  // midnight (srsQueueParts), and reports "due today" the same way. A
  // wall-clock multiple of 86 400 000 ms is a different unit from the one
  // every reader of this column uses, and the mismatch showed up as the card
  // coming back on the WRONG DAY:
  //   * rated 23:30 on Sat 3 Oct 2026, a 1-day interval landed at
  //     2026-10-05 00:30 AEDT — a day LATE — because 4 Oct 2026 is only 23
  //     hours long and the anniversary overshot two local midnights. Late
  //     evening is when the owner actually rates, and a lost day is a lost day;
  //   * rated 00:30 on Sun 4 Apr 2027 (a 25-hour day), the same 1-day
  //     interval landed at 23:30 THAT SAME EVENING, so the card was served
  //     twice on the day it was scheduled — a day EARLY.
  // It is broader than the two DST days, and that breadth is intended: a card
  // rated at 09:00 with a 1-day interval is now due at tomorrow's local
  // midnight rather than tomorrow 09:00. That is Anki's day-cutoff semantics
  // and exactly what the queue was already serving; only the stored number was
  // pretending otherwise.
  //
  // RATING 1 KEEPS ITS WALL-CLOCK 10-MINUTE STEP. A relearn step is a step,
  // not a day: it must come back in ten minutes, in this sitting. It also
  // never enters the review lane (interval_days < 1 routes it to the learning
  // lane, which is served by `due_at <= t + LEARN_AHEAD_MS`), so no day
  // boundary is involved. nextInterval floors at 1, so 2/3/4 can never produce
  // a 0-day interval that would fall into that lane by accident.
  //
  // ESCAPE: none — this is the definition of when a review is due, and it is
  // the same definition the queue reads with.
  const dueOn = (days: number) => localMidnightMs(addDaysISO(appTzDateISO(t), days));

  return {
    1: { stability: again.s, difficulty: again.d, intervalDays: 0, dueAt: t + 10 * 60 * 1000 },
    2: { stability: hardState.s, difficulty: hardState.d, intervalDays: hard, dueAt: dueOn(hard) },
    3: { stability: goodState.s, difficulty: goodState.d, intervalDays: good, dueAt: dueOn(good) },
    4: { stability: easyState.s, difficulty: easyState.d, intervalDays: easy, dueAt: dueOn(easy) },
  };
}

/** What each rating button would schedule, in days (0 = the 10-minute relearn
 *  step). Shown on the buttons at reveal time, Anki-style. */
export function previewSrsIntervals(mcqId: string, t: number = now()): {
  again: number; hard: number; good: number; easy: number;
} {
  const out = srsOutcomes(getSrsRow(mcqId), mcqId, t);
  return { again: out[1].intervalDays, hard: out[2].intervalDays, good: out[3].intervalDays, easy: out[4].intervalDays };
}

function applySrsUpdate(mcqId: string, rating: number, t: number) {
  const cur = getSrsRow(mcqId);
  const out = srsOutcomes(cur, mcqId, t)[rating as 1 | 2 | 3 | 4];
  const { stability, difficulty, intervalDays: interval, dueAt } = out;
  const reps = (cur?.reps ?? 0) + 1;
  const lapses = (cur?.lapses ?? 0) + (rating === 1 ? 1 : 0);

  sqlite.prepare(
    // created_at is written once, on the row's birth — it feeds the Anki-style
    // "new questions introduced today" count, so updates must never touch it.
    `INSERT INTO mcq_srs_state (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at, stability, difficulty, created_at)
     VALUES (?, 2.5, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mcq_id) DO UPDATE SET
       interval_days = excluded.interval_days,
       reps = excluded.reps,
       lapses = excluded.lapses,
       last_reviewed_at = excluded.last_reviewed_at,
       due_at = excluded.due_at,
       stability = excluded.stability,
       difficulty = excluded.difficulty`,
  ).run(mcqId, interval, reps, lapses, t, dueAt, stability, difficulty, t);

  return { dueAt, intervalDays: interval, stability, difficulty, reps };
}

export function finishSession(sessionId: string): SessionSummary {
  const t = now();
  sqlite.prepare(
    "UPDATE mcq_study_sessions SET finished_at = COALESCE(finished_at, ?) WHERE id = ?",
  ).run(t, sessionId);
  return getSessionSummary(sessionId);
}

// -------------------------------------------------------------------------------------------------
// Maintenance — safe housekeeping run at boot.
//   1. Abandoned sessions: an open session (finished_at IS NULL) with NO logged
//      attempts, started more than ABANDON_MS ago, is deleted (it holds no data).
//   2. Stale open sessions that DID record attempts are closed off (finished_at
//      backfilled to their last attempt time) rather than deleted — the attempts
//      are real study history and must be preserved. A closed session shows up
//      under Recent sessions with its score exactly as if it had been finished
//      by hand.
//   3. Orphaned rows: attempts and SRS state referencing an mcq_id that no longer
//      exists in the mcqs corpus (e.g. after a corpus re-ingest replaced ids).
// All deletions target only rows that carry no retained study value.
// -------------------------------------------------------------------------------------------------
const ABANDON_MS = 24 * 60 * 60 * 1000; // 24h

export function cleanupStudyData(t: number = now()): {
  deletedEmptySessions: number;
  closedStaleSessions: number;
  orphanedAttempts: number;
  orphanedSrs: number;
} {
  const cutoff = t - ABANDON_MS;
  const tx = sqlite.transaction(() => {
    const deletedEmpty = sqlite.prepare(
      `DELETE FROM mcq_study_sessions
        WHERE finished_at IS NULL
          AND started_at < ?
          AND NOT EXISTS (SELECT 1 FROM mcq_attempts a WHERE a.session_id = mcq_study_sessions.id)`,
    ).run(cutoff);

    const closedStale = sqlite.prepare(
      `UPDATE mcq_study_sessions
          SET finished_at = (
            SELECT MAX(a.attempted_at) FROM mcq_attempts a WHERE a.session_id = mcq_study_sessions.id
          )
        WHERE finished_at IS NULL
          AND started_at < ?
          AND EXISTS (SELECT 1 FROM mcq_attempts a WHERE a.session_id = mcq_study_sessions.id)`,
    ).run(cutoff);

    const orphanAttempts = sqlite.prepare(
      `DELETE FROM mcq_attempts
        WHERE mcq_id NOT IN (SELECT id FROM mcqs)`,
    ).run();

    const orphanSrs = sqlite.prepare(
      `DELETE FROM mcq_srs_state
        WHERE mcq_id NOT IN (SELECT id FROM mcqs)`,
    ).run();

    sqlite.prepare(
      `DELETE FROM mcq_srs_undo WHERE mcq_id NOT IN (SELECT id FROM mcqs)`,
    ).run();

    return {
      deletedEmptySessions: deletedEmpty.changes ?? 0,
      closedStaleSessions: closedStale.changes ?? 0,
      orphanedAttempts: orphanAttempts.changes ?? 0,
      orphanedSrs: orphanSrs.changes ?? 0,
    };
  });
  return tx();
}

/**
 * One-shot migration: seed the SRS scheduler from the existing attempt log.
 *
 * The user is moving ALL MCQ study to SRS mode, but every prior session ran
 * in tutor mode, which deliberately writes no schedule — so the scheduler
 * would start blind: 250 attempted questions (including every one "retired"
 * on a single lucky correct) indistinguishable from the 1,600 never seen.
 *
 * Seeding rules, reading `correct` AS RE-DERIVED by the attempt reconcile
 * (this runs after it at boot, so grades reflect current keys):
 *   - latest submitted attempt WRONG  -> relearn NOW: interval 0, reps 0,
 *     due immediately. These are the questions the exam would catch.
 *   - latest submitted attempt RIGHT  -> verification pass: reps 1, interval
 *     staggered deterministically over 1..7 days so ~200 questions don't
 *     land as one day-one wall. A single prior correct proves little (154 of
 *     199 "done" questions were one-first-try-correct), so they must re-prove
 *     themselves soon — just not all at once.
 *   - skip-only or never-attempted    -> untouched; they arrive through the
 *     SRS pool's untracked intake as normal new questions.
 * `lapses` seeds from the count of wrong submitted attempts (lifetime
 * counter). FSRS stability/difficulty are deliberately LEFT AT 0 — the
 * uninitialised sentinel — because single tutor-mode attempts (partly graded
 * against keys since corrected) are not review history: the first real
 * Again/Hard/Good/Easy rating initialises S and D properly. The seed only
 * decides WHEN each question first surfaces, never how it is priced
 * afterwards.
 *
 * GUARDED: runs only when mcq_srs_state is completely empty, so it can never
 * fight a live scheduler; after its first run it is a permanent no-op.
 */
export function seedSrsFromAttempts(t: number = now()): { seeded: number; relearnNow: number; verifyQueued: number } {
  const existing = (sqlite.prepare("SELECT COUNT(*) AS c FROM mcq_srs_state").get() as { c: number }).c;
  if (existing > 0) return { seeded: 0, relearnNow: 0, verifyQueued: 0 };

  const rows = sqlite.prepare(
    `SELECT a.mcq_id AS mcqId, a.correct AS latestCorrect, a.attempted_at AS attemptedAt,
            (SELECT COUNT(*) FROM mcq_attempts w
              WHERE w.mcq_id = a.mcq_id AND w.selected IS NOT NULL AND w.correct = 0) AS wrongCount
       FROM mcq_attempts a
      WHERE a.selected IS NOT NULL
        AND a.id = (SELECT MAX(b.id) FROM mcq_attempts b
                     WHERE b.mcq_id = a.mcq_id AND b.selected IS NOT NULL)
        AND EXISTS (SELECT 1 FROM mcqs m WHERE m.id = a.mcq_id)
      ORDER BY a.mcq_id`,
  ).all() as Array<{ mcqId: string; latestCorrect: number; attemptedAt: number; wrongCount: number }>;

  const ins = sqlite.prepare(
    // created_at backdates to the question's last real attempt: seeded rows
    // are BACKFILL of past study, and must never count toward today's
    // Anki-style new-cards-per-day allowance.
    `INSERT INTO mcq_srs_state (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at, created_at)
     VALUES (?, 2.5, ?, ?, ?, ?, ?, ?)`,
  );
  let relearnNow = 0;
  let verifyQueued = 0;
  const tx = sqlite.transaction(() => {
    let i = 0;
    for (const r of rows) {
      if (r.latestCorrect) {
        const interval = 1 + (i++ % 7);
        ins.run(r.mcqId, interval, 1, r.wrongCount, r.attemptedAt, t + interval * DAY_MS, r.attemptedAt);
        verifyQueued += 1;
      } else {
        ins.run(r.mcqId, 0, 0, r.wrongCount, r.attemptedAt, t, r.attemptedAt);
        relearnNow += 1;
      }
    }
  });
  tx();
  return { seeded: rows.length, relearnNow, verifyQueued };
}

export function getSessionSummary(sessionId: string): SessionSummary {
  const sess = sqlite.prepare(
    `SELECT id, mode, filters_json as filtersJson, total_questions as totalQuestions,
            started_at as startedAt, finished_at as finishedAt
     FROM mcq_study_sessions WHERE id = ?`,
  ).get(sessionId) as (McqStudySession & { filtersJson: string }) | undefined;

  if (!sess) throw new Error(`Session ${sessionId} not found`);

  // The summary must show what the user was GRADED against: getMcq applied the
  // override during the session (repaired stem, corrected answer), so reading
  // the base columns here rendered "You: C · Answer: C" under "Review missed"
  // for a fixed question. Same override semantics as rowToRecord: stem is a
  // plain null-fallback; answer treats '' as "cleared by the user".
  const attemptRows = sqlite.prepare(
    `SELECT a.id, a.mcq_id as mcqId, a.session_id as sessionId, a.mode,
            a.selected, a.correct, a.time_ms as timeMs, a.attempted_at as attemptedAt,
            a.rating,
            COALESCE(o.stem, m.stem) as stem,
            CASE WHEN o.answer IS NOT NULL THEN NULLIF(o.answer, '') ELSE m.answer END as correctAnswer,
            m.topic_slug as topicSlug, m.topic_name as topicName, m.domain
     FROM mcq_attempts a
     JOIN mcqs m ON m.id = a.mcq_id
     LEFT JOIN mcq_overrides o ON o.mcq_id = a.mcq_id
     WHERE a.session_id = ?
     ORDER BY a.id ASC`,
  ).all(sessionId) as Array<SessionSummary["attempts"][number]>;

  const totalAnswered = attemptRows.length;
  const correctCount = attemptRows.filter((r) => r.correct === 1).length;
  const skippedCount = attemptRows.filter((r) => r.selected == null).length;
  const incorrectCount = totalAnswered - correctCount - skippedCount;
  const accuracyPct = totalAnswered > 0 ? Math.round((correctCount / totalAnswered) * 100) : 0;

  // Median time
  const times = attemptRows.map((r) => r.timeMs).sort((a, b) => a - b);
  const median = times.length === 0 ? 0
    : times.length % 2 ? times[(times.length - 1) / 2]
    : Math.round((times[times.length / 2 - 1] + times[times.length / 2]) / 2);

  // By topic
  const topicMap = new Map<string, { slug: string; name: string; answered: number; correct: number }>();
  const domainMap = new Map<string, { domain: string; answered: number; correct: number }>();
  for (const r of attemptRows) {
    const tk = r.topicSlug;
    const te = topicMap.get(tk) ?? { slug: r.topicSlug, name: r.topicName, answered: 0, correct: 0 };
    te.answered += 1; te.correct += r.correct;
    topicMap.set(tk, te);
    const de = domainMap.get(r.domain) ?? { domain: r.domain, answered: 0, correct: 0 };
    de.answered += 1; de.correct += r.correct;
    domainMap.set(r.domain, de);
  }

  return {
    session: {
      id: sess.id, mode: sess.mode, filtersJson: sess.filtersJson,
      totalQuestions: sess.totalQuestions, startedAt: sess.startedAt, finishedAt: sess.finishedAt,
    },
    totalAnswered,
    correctCount,
    incorrectCount,
    skippedCount,
    accuracyPct,
    medianTimeSec: Math.round(median / 1000),
    byTopic: Array.from(topicMap.values()).map((t) => ({
      ...t,
      accuracy: t.answered > 0 ? t.correct / t.answered : 0,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    byDomain: Array.from(domainMap.values()).map((d) => ({
      ...d,
      accuracy: d.answered > 0 ? d.correct / d.answered : 0,
    })).sort((a, b) => a.domain.localeCompare(b.domain)),
    attempts: attemptRows,
  };
}

// -------------------------------------------------------------------------------------------------
// Study stats
// -------------------------------------------------------------------------------------------------

export function getUserStats(): McqUserStats {
  const t = now();
  const totalRow = sqlite.prepare(`
    SELECT COUNT(*) as attempted,
           COALESCE(SUM(correct), 0) as correct
    FROM mcq_attempts WHERE selected IS NOT NULL
  `).get() as { attempted: number; correct: number };
  // uniqueMcqs is the COVERAGE NUMERATOR (Study divides it by the sittable
  // bankSize), so it must share the sittable predicate with the pools —
  // otherwise attempts on since-discarded questions push coverage past 100%
  // the moment anything is discarded. attempted/accuracy stay all-time
  // activity stats (what you actually did), deliberately unfiltered.
  const uniqueRow = sqlite.prepare(`
    SELECT COUNT(DISTINCT a.mcq_id) as uniqueMcqs
    FROM mcq_attempts a JOIN mcqs m ON m.id = a.mcq_id
    WHERE a.selected IS NOT NULL AND ${EFFECTIVE_ANSWER_SQL} AND ${NOT_DISCARDED_SQL}
  `).get() as { uniqueMcqs: number };
  const totals = {
    attempted: totalRow.attempted,
    uniqueMcqs: uniqueRow.uniqueMcqs,
    correct: totalRow.correct,
    accuracy: totalRow.attempted > 0 ? totalRow.correct / totalRow.attempted : 0,
  };

  const windowStat = (fromMs: number) => {
    const r = sqlite.prepare(`
      SELECT COUNT(*) as attempted, COALESCE(SUM(correct), 0) as correct
      FROM mcq_attempts WHERE selected IS NOT NULL AND attempted_at >= ?
    `).get(fromMs) as { attempted: number; correct: number };
    return {
      attempted: r.attempted,
      correct: r.correct,
      accuracy: r.attempted > 0 ? r.correct / r.attempted : 0,
    };
  };
  const last7d = windowStat(t - 7 * DAY_MS);
  const last30d = windowStat(t - 30 * DAY_MS);

  // Streak: count consecutive MELBOURNE days ending today (or yesterday) with
  // >=1 attempt. UTC day-keys (attempted_at / DAY_MS) broke every morning: an
  // attempt at 9am Melbourne is 23:00 UTC the previous day, so a genuine
  // daily streak read one day short.
  const attemptRows = sqlite.prepare(
    "SELECT attempted_at AS at FROM mcq_attempts WHERE attempted_at >= ?",
  ).all(t - 400 * DAY_MS) as Array<{ at: number }>;
  const daySet = new Set(attemptRows.map((r) => appTzDateISO(r.at)));
  let streak = 0;
  const today = todayISO();
  let cursor = daySet.has(today) ? today : addDaysISO(today, -1);
  while (daySet.has(cursor)) { streak += 1; cursor = addDaysISO(cursor, -1); }

  // Per-topic. Pool AND attempt-derived numerators all use the shared sittable
  // predicate: with the base-table version, a discarded question kept inflating
  // bankSize (100% coverage unreachable) while attempts on it still counted in
  // the numerator (coverage could exceed the denominator).
  const topicPools = sqlite.prepare(`
    SELECT topic_slug as slug, topic_name as name, domain, COUNT(*) as poolSize
    FROM mcqs m WHERE ${EFFECTIVE_ANSWER_SQL} AND ${NOT_DISCARDED_SQL}
    GROUP BY topic_slug, topic_name, domain
  `).all() as Array<{ slug: string; name: string; domain: string; poolSize: number }>;

  const topicStats = sqlite.prepare(`
    SELECT m.topic_slug as slug,
           COUNT(*) as attempted,
           COALESCE(SUM(a.correct), 0) as correct,
           MAX(a.attempted_at) as lastAttemptedAt,
           COUNT(DISTINCT a.mcq_id) as uniqueMcqs
    FROM mcq_attempts a JOIN mcqs m ON m.id = a.mcq_id
    WHERE a.selected IS NOT NULL AND ${EFFECTIVE_ANSWER_SQL} AND ${NOT_DISCARDED_SQL}
    GROUP BY m.topic_slug
  `).all() as Array<{ slug: string; attempted: number; correct: number; lastAttemptedAt: number; uniqueMcqs: number }>;
  const topicStatMap = new Map(topicStats.map((r) => [r.slug, r]));

  // Latest-attempt-correct per topic (was the most recent attempt on each MCQ correct?)
  const latestCorrect = sqlite.prepare(`
    SELECT m.topic_slug as slug, COUNT(*) as correctLatest
    FROM (
      -- id DESC breaks ties: attempted_at is millisecond-resolution and the
      -- Again-requeue flow logs two attempts on one question in a single
      -- sitting, which made "latest" arbitrary between reads.
      SELECT mcq_id, correct, ROW_NUMBER() OVER (PARTITION BY mcq_id ORDER BY attempted_at DESC, id DESC) rn
      FROM mcq_attempts WHERE selected IS NOT NULL
    ) x JOIN mcqs m ON m.id = x.mcq_id
    WHERE x.rn = 1 AND x.correct = 1 AND ${EFFECTIVE_ANSWER_SQL} AND ${NOT_DISCARDED_SQL}
    GROUP BY m.topic_slug
  `).all() as Array<{ slug: string; correctLatest: number }>;
  const latestMap = new Map(latestCorrect.map((r) => [r.slug, r.correctLatest]));

  const byTopic = topicPools.map((p) => {
    const s = topicStatMap.get(p.slug);
    return {
      slug: p.slug,
      name: p.name,
      domain: p.domain,
      poolSize: p.poolSize,
      attempted: s?.uniqueMcqs ?? 0,
      correctLatest: latestMap.get(p.slug) ?? 0,
      accuracy: s && s.attempted > 0 ? s.correct / s.attempted : null,
      lastAttemptedAt: s?.lastAttemptedAt ?? null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Per-domain aggregate
  const byDomainMap = new Map<string, { domain: string; poolSize: number; attempted: number; correct: number; total: number }>();
  for (const p of topicPools) {
    const e = byDomainMap.get(p.domain) ?? { domain: p.domain, poolSize: 0, attempted: 0, correct: 0, total: 0 };
    e.poolSize += p.poolSize;
    byDomainMap.set(p.domain, e);
  }
  // `a.selected IS NOT NULL` is not optional here: a "Don't know" reveal is
  // NOT a wrong answer (it is Anki's show-answer), and every other stat on this
  // page already excludes it. Without the filter, by-domain accuracy was
  // dragged below the accuracies of the very topics it aggregates, and a
  // question the user had only ever skipped still counted as attempted at 0%.
  const domainStats = sqlite.prepare(`
    SELECT m.domain as domain,
           COUNT(*) as total,
           COALESCE(SUM(a.correct), 0) as correct,
           COUNT(DISTINCT a.mcq_id) as uniqueMcqs
    FROM mcq_attempts a JOIN mcqs m ON m.id = a.mcq_id
    WHERE a.selected IS NOT NULL AND ${EFFECTIVE_ANSWER_SQL} AND ${NOT_DISCARDED_SQL}
    GROUP BY m.domain
  `).all() as Array<{ domain: string; total: number; correct: number; uniqueMcqs: number }>;
  for (const d of domainStats) {
    const e = byDomainMap.get(d.domain);
    if (e) {
      e.attempted = d.uniqueMcqs;
      e.correct = d.correct;
      e.total = d.total;
    }
  }
  const byDomain = Array.from(byDomainMap.values()).map((d) => ({
    domain: d.domain,
    poolSize: d.poolSize,
    attempted: d.attempted,
    accuracy: d.total > 0 ? d.correct / d.total : null,
  })).sort((a, b) => a.domain.localeCompare(b.domain));

  // SRS due counts. Same FULL sittable predicate as the session pools: not
  // discarded AND an effective answer exists (an override can clear one with
  // '') — either condition failing means no session will ever serve the
  // question, so counting it left "SRS due N" permanently overstating.
  const totalTracked = (sqlite.prepare(`SELECT COUNT(*) as c FROM mcq_srs_state s WHERE ${SRS_SITTABLE_SQL}`).get() as { c: number }).c;
  const dueNow = (sqlite.prepare(
    `SELECT COUNT(*) as c FROM mcq_srs_state s WHERE s.due_at <= ? AND ${SRS_SITTABLE_SQL}`,
  ).get(t) as { c: number }).c;
  // End of the MELBOURNE day — server-local midnight is UTC on Fly, which cut
  // "due today" off at 10-11am local.
  const endOfDay = localMidnightMs(addDaysISO(todayISO(), 1));
  // STRICTLY `<`, and it has to be, now that due_at IS a local midnight
  // (srsOutcomes). endOfDay is the FIRST INSTANT OF TOMORROW: a card due at
  // exactly that instant is due tomorrow, not today. Under the old wall-clock
  // due_at, landing exactly on the boundary was a one-in-86-million accident
  // and `<=` was harmless; under day-start scheduling it is the common case,
  // and `<=` would have counted EVERY card scheduled for tomorrow in "SRS due
  // today" — an amber "N due → Study" link whose queue then serves nothing.
  // The queue lane this number is supposed to describe has always used `<`
  // (srsQueueParts' dueReviewIds), so this is the count catching up with it.
  const dueToday = (sqlite.prepare(
    `SELECT COUNT(*) as c FROM mcq_srs_state s WHERE s.due_at < ? AND ${SRS_SITTABLE_SQL}`,
  ).get(endOfDay) as { c: number }).c;

  // Recent sittings — test and tutor only. A day's spaced review is not a
  // sitting with a score, so it never belongs in this list; the filter also
  // hides the SRS rows written before spaced review stopped creating them.
  const sessRows = sqlite.prepare(`
    SELECT s.id, s.mode, s.total_questions as totalQuestions,
           s.started_at as startedAt, s.finished_at as finishedAt,
           (SELECT COUNT(*) FROM mcq_attempts a WHERE a.session_id = s.id) as answered,
           (SELECT COALESCE(SUM(correct), 0) FROM mcq_attempts a WHERE a.session_id = s.id) as correctCount
    FROM mcq_study_sessions s
    WHERE s.mode <> 'srs'
    ORDER BY s.started_at DESC
    LIMIT 10
  `).all() as Array<{ id: string; mode: string; totalQuestions: number; startedAt: number; finishedAt: number | null; answered: number; correctCount: number }>;
  const recentSessions = sessRows.map((r) => ({
    id: r.id,
    mode: r.mode,
    totalQuestions: r.totalQuestions,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    correctCount: r.correctCount,
    accuracy: r.answered > 0 ? r.correctCount / r.answered : null,
  }));

  return {
    totals,
    last7d,
    last30d,
    streakDays: streak,
    byTopic,
    byDomain,
    srsDue: { dueNow, dueToday, totalTracked },
    recentSessions,
  };
}

export function getSrsDue(limit = 50): McqRecord[] {
  const t = now();
  const rows = sqlite.prepare(
    `SELECT s.mcq_id FROM mcq_srs_state s
      WHERE s.due_at <= ? AND ${SRS_SITTABLE_SQL}
      ORDER BY s.due_at ASC, s.mcq_id ASC LIMIT ?`,
  ).all(t, limit) as Array<{ mcq_id: string }>;
  return rows.map((r) => getMcq(r.mcq_id)).filter((m): m is McqRecord => !!m);
}

// Wipes ALL MCQ study progress: attempts log, SRS scheduling state, and study
// sessions. Leaves the mcqs corpus + LO links + overrides untouched. Returns
// per-table deleted counts. Used by the /api/mcqs/reset route (Settings →
// Reset MCQ progress). Atomic: a partial wipe would leave attempts without
// their schedule — and because the one-shot seed only runs against a
// COMPLETELY empty mcq_srs_state, surviving attempts with a wiped schedule
// would quietly re-seed at next boot.
export function resetMcqProgress(): {
  deletedAttempts: number;
  deletedSrsState: number;
  deletedSessions: number;
} {
  const tx = sqlite.transaction(() => {
    const a = sqlite.prepare(`DELETE FROM mcq_attempts`).run();
    const s = sqlite.prepare(`DELETE FROM mcq_srs_state`).run();
    const ss = sqlite.prepare(`DELETE FROM mcq_study_sessions`).run();
    // Undo records point at rows that no longer exist — keeping them would let
    // an undo resurrect a schedule for a question whose history was just wiped.
    sqlite.prepare(`DELETE FROM mcq_srs_undo`).run();
    return {
      deletedAttempts: a.changes ?? 0,
      deletedSrsState: s.changes ?? 0,
      deletedSessions: ss.changes ?? 0,
    };
  });
  return tx();
}

// The weak-topics list the Study page shows. The query itself is
// WEAK_AREAS_SQL in ./mcqSittable, interpolated rather than retyped so that a
// repair to the predicate (`a.selected IS NOT NULL`: a topic the candidate had
// revealed with "Don't know" is not a topic he got wrong) reaches every reader
// at once instead of the one copy someone remembered.
//
// Note this is NOT the predicate behind the "weak topics" session filter — see
// computeWeakTopicSlugs above, which deliberately asks a different question.
export function getWeakAreas(): Array<{ slug: string; name: string; accuracy: number; attempts: number }> {
  const rows = sqlite.prepare(WEAK_AREAS_SQL)
    .all() as Array<{ slug: string; name: string; attempts: number; correct: number }>;
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    accuracy: r.correct / r.attempts,
    attempts: r.attempts,
  }));
}
