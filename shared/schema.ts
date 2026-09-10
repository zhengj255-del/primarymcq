// -------------------------------------------------------------------------------------------------
// shared/schema.ts — TYPES ONLY. This file does not create, migrate or own the database.
//
// The live SQLite schema is built by the server itself at boot: server/storage.ts owns the
// settings + study tables (mcq_attempts, mcq_srs_state, mcq_srs_undo, mcq_srs_extra_new,
// mcq_study_sessions) and server/mcqs.ts owns the corpus tables (mcqs, mcq_lo_links,
// mcq_overrides, mcq_meta). Every DDL step is `CREATE TABLE IF NOT EXISTS` / PRAGMA-guarded
// `ALTER TABLE ... ADD COLUMN`, idempotent, and re-runs on every boot.
//
// What is declared BELOW is consumed only as types and as the zod request schemas the routes and
// the client share. Nothing in the running app reads these declarations to shape storage, so a
// column missing here costs a type, never a row. Plain TypeScript interfaces + zod — no ORM.
// -------------------------------------------------------------------------------------------------
import { z } from "zod";

// -------------------------------------------------------------------------------------------------
// Settings — the FSRS knobs for MCQ spaced repetition (server/mcqStudy.ts).
// One row (id = 1), created and seeded by server/storage.ts bootstrap.
// -------------------------------------------------------------------------------------------------
export interface Settings {
  id: number;
  // Desired retention: review when predicted recall falls to this — Anki's
  // dial, clamped to 0.70–0.97 at read time. Higher = shorter intervals, more
  // reviews, fewer misses.
  srsRetention: number;
  // Interval fuzz (Anki's ±5% band so questions first seen together don't
  // travel as a clump forever). Stored 0/1.
  srsFuzz: number;
  // Anki-style daily limits for the SRS queue. New questions introduced per
  // Melbourne day (Anki's default 20) and maximum review-queue questions per
  // day (Anki's default 200). Learning/relearn steps are never capped.
  srsNewPerDay: number;
  srsMaxReviewsPerDay: number;
}

// -------------------------------------------------------------------------------------------------
// WHAT PATCH /api/settings WILL ACCEPT.
//
// Every rule below is either a FORMAT rule (a stored 0/1 boolean is 0 or 1; a
// count is a whole number) or a bound something downstream ALREADY imposes
// (srsRetention is clamped to 0.70–0.97 at read time in server/mcqStudy.ts).
// Nothing here caps the size of the owner's ambition: srsNewPerDay and
// srsMaxReviewsPerDay take any non-negative value.
//
// ESCAPE: every field stays optional, so a client may send only what it
// changed; unknown keys are STRIPPED rather than refused.
// -------------------------------------------------------------------------------------------------
export const settingsPatchSchema = z.object({
  // Anki's desired-retention dial, and the exact band mcqStudy.ts clamps to.
  srsRetention: z.number().min(0.7, "srsRetention must be between 0.70 and 0.97")
    .max(0.97, "srsRetention must be between 0.70 and 0.97").optional(),
  // Stored 0/1 boolean.
  srsFuzz: z.number().int().min(0, "srsFuzz must be 0 or 1").max(1, "srsFuzz must be 0 or 1").optional(),
  // Counts. Integer and non-negative — no ceiling; see above.
  srsNewPerDay: z.number().int().nonnegative("srsNewPerDay must be a whole number, 0 or more").optional(),
  srsMaxReviewsPerDay: z.number().int().nonnegative("srsMaxReviewsPerDay must be a whole number, 0 or more").optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

// -------------------------------------------------------------------------------------------------
// MCQs — Kerry Brandis "Black Bank" past-question corpus.
// Ingested at startup from server/data/mcqs.json (server/mcqs.ts). Idempotent —
// skipped when the stored content hash already matches. Not user-authored, so
// no insert schema is exposed to the API.
//
// User edits to MCQs (stem/options/answer/reason) are stored in a
// separate mcq_overrides table so the mcqs.json re-ingest on boot doesn't wipe
// them. One row per edited MCQ. Only overridden fields are non-null; unset
// fields fall through to the base mcqs row. An empty-string answer override
// means "the user cleared the answer".
// -------------------------------------------------------------------------------------------------
export const mcqEditSchema = z.object({
  stem: z.string().min(1).max(10000).optional(),
  options: z.object({
    A: z.string().max(4000),
    B: z.string().max(4000),
    C: z.string().max(4000),
    D: z.string().max(4000),
    E: z.string().max(4000),
  }).optional(),
  answer: z.enum(["A", "B", "C", "D", "E", ""]).nullable().optional(),
  reason: z.string().max(20000).optional(),
});
export type McqEdit = z.infer<typeof mcqEditSchema>;

// -------------------------------------------------------------------------------------------------
// MCQ study session — logical grouping of attempts (a "test" you took).
// Stores the filter used and finished timestamp so summaries can be reloaded.
// Spaced review is NOT a session (see server/mcqStudy.ts startSession).
// -------------------------------------------------------------------------------------------------
export interface McqStudySession {
  id: string;                    // uuid
  mode: string;                  // 'test' | 'tutor' | 'srs'
  filtersJson: string;           // JSON of the SessionFilters shape below
  totalQuestions: number;
  startedAt: number;             // ms epoch
  finishedAt: number | null;     // null while in-progress
}

// -------------------------------------------------------------------------------------------------
// MCQ attempts — every question a user answers, in any mode (test / tutor / srs)
// -------------------------------------------------------------------------------------------------
export interface McqAttempt {
  id: number;
  mcqId: string;                 // -> mcqs.id
  sessionId: string | null;      // groups attempts within one session (null for SRS / ad-hoc)
  mode: string;                  // 'test' | 'tutor' | 'srs'
  selected: string | null;       // 'A'..'E' or null (skipped/timed-out/"Don't know")
  correct: number;               // 0/1
  timeMs: number;                // time spent on this question
  attemptedAt: number;           // ms epoch
  // SRS-only: user self-rating, 1=Again .. 4=Easy. Null for test/tutor
  // attempts, and for an SRS reveal that has not been rated yet.
  rating: number | null;
}

// Filter shape used when starting an MCQ study session.
export const sessionFiltersSchema = z.object({
  mode: z.enum(["test", "tutor", "srs"]),
  topics: z.array(z.string()).optional(),         // topicSlug list; empty/undef = all
  domains: z.array(z.string()).optional(),        // domain key list; empty/undef = all
  loCodes: z.array(z.string()).optional(),        // LO code list; empty/undef = all
  sittings: z.array(z.string()).optional(),       // exam-sitting keys (e.g. "2026B"); empty/undef = all
  completion: z.enum(["all", "completed", "not-completed", "review"]).optional(), // filter by prior-attempt status; "review" = never answered correctly (unseen + previously incorrect)
  srsSkipNew: z.boolean().optional(),             // SRS only: serve learning + reviews, no new intake this sitting
  weakAreas: z.boolean().optional(),              // auto-pick from lowest-accuracy topics
  count: z.number().int().min(1).max(200).default(20),
  timeLimitSec: z.number().int().nullable().optional(), // test mode only
});
export type SessionFilters = z.infer<typeof sessionFiltersSchema>;

export const submitAttemptSchema = z.object({
  sessionId: z.string().nullable().optional(),
  mcqId: z.string(),
  mode: z.enum(["test", "tutor", "srs"]),
  selected: z.string().max(1).nullable(),         // 'A'..'E' or null
  timeMs: z.number().int().min(0).default(0),
  rating: z.number().int().min(1).max(4).nullable().optional(), // SRS only
});
export type SubmitAttempt = z.infer<typeof submitAttemptSchema>;

// SRS rating is submitted separately from the answer reveal so that logging the
// attempt and advancing the schedule happen exactly once each.
export const srsRateSchema = z.object({
  sessionId: z.string().nullable().optional(),
  mcqId: z.string(),
  rating: z.number().int().min(1).max(4),
});
export type SrsRate = z.infer<typeof srsRateSchema>;

// Session summary returned after a session finishes (or when reloaded).
export interface SessionSummary {
  session: McqStudySession;
  totalAnswered: number;
  correctCount: number;
  incorrectCount: number;
  skippedCount: number;
  accuracyPct: number;                            // 0..100
  medianTimeSec: number;
  byTopic: Array<{ slug: string; name: string; answered: number; correct: number; accuracy: number }>;
  byDomain: Array<{ domain: string; answered: number; correct: number; accuracy: number }>;
  attempts: Array<McqAttempt & { stem: string; correctAnswer: string | null; topicSlug: string; topicName: string; domain: string }>;
}

// Aggregate user stats surfaced on the Study page.
export interface McqUserStats {
  totals: {
    attempted: number;             // total attempts, all modes
    uniqueMcqs: number;            // distinct MCQs attempted
    correct: number;
    accuracy: number;              // 0..1
  };
  last7d: { attempted: number; correct: number; accuracy: number };
  last30d: { attempted: number; correct: number; accuracy: number };
  streakDays: number;              // consecutive days with >=1 attempt
  byTopic: Array<{
    slug: string;
    name: string;
    domain: string;
    poolSize: number;              // total MCQs in this topic
    attempted: number;             // unique MCQs attempted
    correctLatest: number;         // MCQs whose most-recent attempt was correct
    accuracy: number | null;       // over ALL attempts in the topic (nullable when 0)
    lastAttemptedAt: number | null;
  }>;
  byDomain: Array<{
    domain: string;
    poolSize: number;
    attempted: number;
    accuracy: number | null;
  }>;
  srsDue: { dueNow: number; dueToday: number; totalTracked: number };
  recentSessions: Array<Pick<McqStudySession, "id" | "mode" | "totalQuestions" | "startedAt" | "finishedAt"> & { correctCount: number; accuracy: number | null }>;
}

// API-shape record: options/papers/urls parsed back to arrays/objects and LO codes joined in.
export interface McqRecord {
  id: string;                    // topicSlug__code (globally unique)
  code: string;                  // e.g. "RE17", "15A-30", "OFF-2018-Q114"
  displayCode: string;           // human-friendly label to show in UI
  topicFile: string;
  topicName: string;             // e.g. "Respiratory"
  topicSlug: string;             // e.g. "respiratory"
  domain: string;                // curriculum domain key (resp, cvs, ...)
  section: string | null;        // nearest section header above the question
  papers: string[];              // paper tags
  stem: string;
  options: Record<"A" | "B" | "C" | "D" | "E", string>;
  answer: string | null;         // 'A'..'E' or null
  reason: string;
  urls: string[];                // extracted from reason
  parentCode: string | null;     // for alt-versions grouped under parent
  // Basename of an SVG in client/public/mcq-figures/ for questions whose stem
  // refers to a graph/diagram ("see graph below"). Null for the vast majority
  // that are text-only. Corpus-supplied — not part of the user override layer.
  figure: string | null;
  loCodes: string[];        // ANZCA LO codes linked to this MCQ (empty if none matched)
  edited: boolean;          // true if user has overridden any field for this MCQ
  excluded: boolean;        // true = discarded by hand; hidden from study pools/SRS
}

