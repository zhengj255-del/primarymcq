import "./testDb";
import { describe, it, expect, beforeAll } from "vitest";
import { sqlite } from "../storage";
import { resetMcqProgress } from "../mcqStudy";

// The Settings "Reset MCQ progress" wipe. Contract: attempts, sessions and
// the SRS schedule go to zero in one atomic sweep; the question corpus and
// its LO links are untouched. The all-or-nothing part matters beyond tidiness:
// the one-shot SRS seed only runs against a COMPLETELY empty mcq_srs_state,
// so a partial wipe (schedule gone, attempts surviving) would quietly re-seed
// old history at next boot instead of the fresh start the user asked for.

let mcqCountBefore: number;
let loLinksBefore: number;

describe("resetMcqProgress", () => {
  beforeAll(() => {
    sqlite.prepare("DELETE FROM mcq_attempts").run();
    sqlite.prepare("DELETE FROM mcq_srs_state").run();
    sqlite.prepare("DELETE FROM mcq_study_sessions").run();
    const ids = (sqlite.prepare("SELECT id FROM mcqs LIMIT 3").all() as Array<{ id: string }>).map((r) => r.id);
    sqlite.prepare(
      "INSERT INTO mcq_study_sessions (id, mode, filters_json, total_questions, started_at) VALUES ('sess-reset', 'srs', '{}', 3, ?)",
    ).run(Date.now());
    const ins = sqlite.prepare(
      "INSERT INTO mcq_attempts (mcq_id, session_id, mode, selected, correct, time_ms, attempted_at) VALUES (?, 'sess-reset', 'srs', 'A', 1, 1000, ?)",
    );
    for (const id of ids) ins.run(id, Date.now());
    const srs = sqlite.prepare(
      "INSERT INTO mcq_srs_state (mcq_id, ease_factor, interval_days, reps, lapses, last_reviewed_at, due_at, stability, difficulty) VALUES (?, 2.5, 3, 1, 0, ?, ?, 2.31, 2.12)",
    );
    for (const id of ids.slice(0, 2)) srs.run(id, Date.now(), Date.now());
    mcqCountBefore = (sqlite.prepare("SELECT COUNT(*) c FROM mcqs").get() as { c: number }).c;
    loLinksBefore = (sqlite.prepare("SELECT COUNT(*) c FROM mcq_lo_links").get() as { c: number }).c;
  });

  it("wipes attempts, sessions and schedule; leaves the corpus alone", () => {
    const r = resetMcqProgress();
    expect(r).toEqual({ deletedAttempts: 3, deletedSrsState: 2, deletedSessions: 1 });

    const count = (sql: string) => (sqlite.prepare(sql).get() as { c: number }).c;
    expect(count("SELECT COUNT(*) c FROM mcq_attempts")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM mcq_srs_state")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM mcq_study_sessions")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM mcqs")).toBe(mcqCountBefore);
    expect(count("SELECT COUNT(*) c FROM mcq_lo_links")).toBe(loLinksBefore);
  });

  it("is idempotent — a second wipe deletes nothing and doesn't throw", () => {
    expect(resetMcqProgress()).toEqual({ deletedAttempts: 0, deletedSrsState: 0, deletedSessions: 0 });
  });
});
