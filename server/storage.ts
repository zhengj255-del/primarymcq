// -------------------------------------------------------------------------------------------------
// Database layer — opens the SQLite file, creates the settings + study tables,
// and runs the boot sequence (corpus ingest, attempt reconcile, deferred
// housekeeping). Single-user app: no user_id anywhere.
//
// The MCQ corpus tables (mcqs, mcq_lo_links, mcq_overrides, mcq_meta) are
// created by server/mcqs.ts bootstrapMcqs(), called from the bottom of this
// file once `sqlite` exists. The study engine (server/mcqStudy.ts) owns no DDL:
// its tables are created here so /api/export and the rolling backup always see
// the complete schema, whether or not a session has ever been started.
// -------------------------------------------------------------------------------------------------

import Database from "better-sqlite3";
import type { Settings, SettingsPatch } from "@shared/schema";
import { bootstrapMcqs, reconcileAttemptCorrectness } from "./mcqs";
import { ensureAuditTable } from "./mcqAudit";

// The Melbourne calendar helpers (todayISO, localMidnightMs, the two-pass DST
// offset resolution) live in ./dates, a leaf module that imports nothing from
// server/ — so the modules storage.ts itself imports can share one definition
// of "today" instead of re-deriving UTC days. Re-exported here because the
// study engine and the tests import them from "./storage".
export { todayISO, appTzDateISO, localMidnightMs, daysBetweenISO, addDaysISO } from "./dates";

const sqlite = new Database(process.env.DB_PATH || "data.db");
export { sqlite };
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// -------------------------------------------------------------------------------------------------
// Bootstrap — create tables if missing (idempotent DDL, re-run on every boot)
// -------------------------------------------------------------------------------------------------
function bootstrap() {
  sqlite.exec(`
    -- FSRS knobs for MCQ spaced repetition (server/mcqStudy.ts reads them
    -- fresh on every scheduling decision). One row, id = 1.
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      srs_retention REAL NOT NULL DEFAULT 0.9,
      srs_fuzz INTEGER NOT NULL DEFAULT 1,
      srs_new_per_day INTEGER NOT NULL DEFAULT 20,
      srs_max_reviews_per_day INTEGER NOT NULL DEFAULT 200
    );
    CREATE TABLE IF NOT EXISTS mcq_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mcq_id TEXT NOT NULL,
      session_id TEXT,
      mode TEXT NOT NULL,
      selected TEXT,
      correct INTEGER NOT NULL,
      time_ms INTEGER NOT NULL DEFAULT 0,
      attempted_at INTEGER NOT NULL,
      rating INTEGER,
      srs_lane TEXT            -- 'new' | 'learning' | 'review' at rating time
    );
    CREATE INDEX IF NOT EXISTS mcq_attempts_mcq_idx ON mcq_attempts(mcq_id);
    CREATE INDEX IF NOT EXISTS mcq_attempts_session_idx ON mcq_attempts(session_id);
    CREATE INDEX IF NOT EXISTS mcq_attempts_attempted_at_idx ON mcq_attempts(attempted_at);
    CREATE TABLE IF NOT EXISTS mcq_srs_state (
      mcq_id TEXT PRIMARY KEY,
      ease_factor REAL NOT NULL DEFAULT 2.5,   -- legacy SM-2 column; FSRS ignores it
      interval_days REAL NOT NULL DEFAULT 0,
      reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      last_reviewed_at INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL DEFAULT 0,
      stability REAL NOT NULL DEFAULT 0,       -- FSRS memory stability (days to R=90%)
      difficulty REAL NOT NULL DEFAULT 0,      -- FSRS difficulty, 1..10; 0 = uninitialised
      created_at INTEGER NOT NULL DEFAULT 0    -- when the question entered SRS (new/day accounting)
    );
    CREATE INDEX IF NOT EXISTS mcq_srs_due_idx ON mcq_srs_state(due_at);
    -- Undo stack for SRS ratings (misclicks). Each row is the EXACT scheduler
    -- state a rating overwrote, so undo restores rather than guessing an
    -- inverse — FSRS has no inverse. had_state = 0 means the rating created
    -- the row (a new question), so undo deletes it again.
    CREATE TABLE IF NOT EXISTS mcq_srs_undo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mcq_id TEXT NOT NULL,
      attempt_id INTEGER,
      had_state INTEGER NOT NULL,
      ease_factor REAL, interval_days REAL, reps INTEGER, lapses INTEGER,
      last_reviewed_at INTEGER, due_at INTEGER, stability REAL, difficulty REAL,
      created_at INTEGER,
      prev_rating INTEGER,
      prev_lane TEXT,
      rated_at INTEGER NOT NULL
    );
    -- "Study more new today": per-Melbourne-day boost on top of
    -- srs_new_per_day, granted from the SRS setup panel (Anki's custom-study
    -- "increase today's new card limit"). Keyed by day so it expires at
    -- midnight on its own; old rows are pruned on write.
    CREATE TABLE IF NOT EXISTS mcq_srs_extra_new (
      day TEXT PRIMARY KEY,
      extra INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcq_study_sessions (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      total_questions INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mcq_study_sessions_started_at_idx ON mcq_study_sessions(started_at);
  `);

  // Which Anki lane a rated question came from. Anki's daily review limit
  // counts cards answered FROM THE REVIEW QUEUE; (re)learning steps are
  // exempt. Only the rating moment knows the lane (the state is overwritten
  // immediately after), so it is stamped there and read back by the limit.
  // Pre-migration rows stay NULL and simply don't count as reviews.
  {
    const cols = sqlite.prepare("PRAGMA table_info(mcq_attempts)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("srs_lane")) {
      sqlite.exec("ALTER TABLE mcq_attempts ADD COLUMN srs_lane TEXT");
    }
  }

  // FSRS columns for mcq_srs_state: the scheduler tracks memory stability +
  // difficulty per question. CREATE TABLE IF NOT EXISTS won't add new columns
  // to an existing table, so PRAGMA-check and ALTER as needed.
  {
    const cols = sqlite.prepare("PRAGMA table_info(mcq_srs_state)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("stability")) {
      sqlite.exec("ALTER TABLE mcq_srs_state ADD COLUMN stability REAL NOT NULL DEFAULT 0");
    }
    if (!names.has("difficulty")) {
      sqlite.exec("ALTER TABLE mcq_srs_state ADD COLUMN difficulty REAL NOT NULL DEFAULT 0");
    }
    // Anki-style new-cards-per-day accounting needs to know WHEN a question
    // entered SRS. Backfill existing rows with last_reviewed_at (their real
    // introduction is unknowable; any past timestamp keeps them out of
    // today's new count, which is the property that matters).
    if (!names.has("created_at")) {
      sqlite.exec("ALTER TABLE mcq_srs_state ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
      sqlite.exec("UPDATE mcq_srs_state SET created_at = last_reviewed_at WHERE created_at = 0");
    }
  }

  // Idempotent column migrations for the `settings` table.
  {
    const cols = sqlite.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("srs_retention")) {
      sqlite.exec("ALTER TABLE settings ADD COLUMN srs_retention REAL NOT NULL DEFAULT 0.9");
    }
    if (!names.has("srs_fuzz")) {
      sqlite.exec("ALTER TABLE settings ADD COLUMN srs_fuzz INTEGER NOT NULL DEFAULT 1");
    }
    if (!names.has("srs_new_per_day")) {
      sqlite.exec("ALTER TABLE settings ADD COLUMN srs_new_per_day INTEGER NOT NULL DEFAULT 20");
    }
    if (!names.has("srs_max_reviews_per_day")) {
      sqlite.exec("ALTER TABLE settings ADD COLUMN srs_max_reviews_per_day INTEGER NOT NULL DEFAULT 200");
    }
  }

  // Seed the single settings row if missing. Always id = 1: the row is
  // addressed by that id everywhere (getSettings, updateSettings, the
  // import/export round-trip), so it must never drift to another value.
  const settingsCount = sqlite.prepare("SELECT COUNT(*) as c FROM settings").get() as { c: number };
  if (settingsCount.c === 0) {
    sqlite.prepare("INSERT INTO settings (id) VALUES (1)").run();
  }
}
bootstrap();
// MCQ ingest runs after bootstrap so the mcqs.ts module can reuse the same
// `sqlite` handle and see all tables created here. ESM circular import
// resolves lazily: mcqs.ts imports sqlite but only uses it inside functions,
// so by the time bootstrapMcqs() is called, sqlite is fully initialised.
bootstrapMcqs();
// The AI sweep's verdict table (server/mcqAudit.ts). Created here, at boot,
// rather than lazily on the first sweep, so /api/export and the rolling backup
// always see the complete schema — a table that only exists once a feature has
// been used is a table a restore can silently skip.
ensureAuditTable();
// Attempt correctness is stored denormalised but DERIVED from the key, and a
// triage fix or a hand edit changes keys. Re-derive any row left disagreeing
// with its current key by a key change that predates regradeAttempts().
try {
  const regraded = reconcileAttemptCorrectness();
  if (regraded > 0) console.log(`[mcqs] boot reconcile: re-derived ${regraded} attempt(s) against their current key`);
} catch (err: any) {
  console.warn("[mcqs] attempt reconcile failed:", err?.message || err);
}
process.nextTick(() => {
  // Housekeeping: drop abandoned/empty study sessions and orphaned MCQ rows
  // (e.g. attempts/SRS state left behind after a corpus re-ingest). Deferred to
  // boot so it never runs on the request path. Imported dynamically to avoid a
  // static circular import with mcqStudy.ts (which imports this module).
  void import("./mcqStudy")
    .then(({ cleanupStudyData, seedSrsFromAttempts }) => {
      const c = cleanupStudyData();
      if (c.deletedEmptySessions || c.closedStaleSessions || c.orphanedAttempts || c.orphanedSrs) {
        console.log(
          `[mcq-study] boot cleanup: emptySessions=${c.deletedEmptySessions} ` +
          `closedStale=${c.closedStaleSessions} orphanAttempts=${c.orphanedAttempts} orphanSrs=${c.orphanedSrs}`,
        );
      }
      // One-shot SRS migration for the move to SRS-first study. Runs only
      // while mcq_srs_state is EMPTY (never fights a live scheduler), and
      // after reconcileAttemptCorrectness above, so it seeds from grades
      // re-derived against current keys.
      const seed = seedSrsFromAttempts();
      if (seed.seeded > 0) {
        console.log(
          `[mcq-study] seeded SRS from ${seed.seeded} attempted question(s): ` +
          `${seed.relearnNow} relearn now, ${seed.verifyQueued} verification spread over 7d`,
        );
      }
    })
    .catch((err: any) => console.warn("[mcq-study] boot cleanup failed:", err?.message || err));
});

// -------------------------------------------------------------------------------------------------
// Settings accessors — plain SQL with the camelCase <-> snake_case mapping done
// by hand. The row is created by bootstrap() above, so getSettings never sees
// an empty table.
// -------------------------------------------------------------------------------------------------

interface SettingsRow {
  id: number;
  srs_retention: number;
  srs_fuzz: number;
  srs_new_per_day: number;
  srs_max_reviews_per_day: number;
}

function rowToSettings(row: SettingsRow): Settings {
  return {
    id: row.id,
    srsRetention: row.srs_retention,
    srsFuzz: row.srs_fuzz,
    srsNewPerDay: row.srs_new_per_day,
    srsMaxReviewsPerDay: row.srs_max_reviews_per_day,
  };
}

// Patch key -> column, for updateSettings. Anything not listed here is
// ignored, so an unknown key can never become a SQL identifier.
const SETTINGS_COLUMNS: Record<keyof SettingsPatch, string> = {
  srsRetention: "srs_retention",
  srsFuzz: "srs_fuzz",
  srsNewPerDay: "srs_new_per_day",
  srsMaxReviewsPerDay: "srs_max_reviews_per_day",
};

export const storage = {
  getSettings(): Settings {
    const row = sqlite.prepare(
      "SELECT id, srs_retention, srs_fuzz, srs_new_per_day, srs_max_reviews_per_day FROM settings ORDER BY id LIMIT 1",
    ).get() as SettingsRow | undefined;
    if (!row) {
      // bootstrap() seeds the row, so this only happens if something deleted
      // it (a bad import). Re-seed rather than crash every reader.
      sqlite.prepare("INSERT INTO settings (id) VALUES (1)").run();
      return storage.getSettings();
    }
    return rowToSettings(row);
  },

  /** Apply only the fields present in `patch` (undefined = untouched) and
   *  return the merged row. */
  updateSettings(patch: SettingsPatch): Settings {
    const current = storage.getSettings();
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of Object.keys(SETTINGS_COLUMNS) as Array<keyof SettingsPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${SETTINGS_COLUMNS[key]} = ?`);
      params.push(value);
    }
    if (sets.length > 0) {
      sqlite.prepare(`UPDATE settings SET ${sets.join(", ")} WHERE id = ?`).run(...params, current.id);
    }
    return storage.getSettings();
  },
};
