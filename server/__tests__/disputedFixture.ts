import { sqlite } from "../storage";

// -----------------------------------------------------------------------------
// The base-disputed fixture the corpus no longer supplies for free.
//
// Until the whole-bank refresh, server/data/mcqs.json shipped with ~247
// questions flagged `disputed` in the base column, and the dispute-predicate
// tests simply picked one. That file is now the tracker's curated copy of the
// bank: every dispute its owner had resolved arrives resolved, so the base
// column can legitimately be all zeros — and a fixture that SELECTs
// `disputed = 1` finds nothing.
//
// These tests are about the PREDICATE ("one definition of disputed across
// stats, list filter, study pool and SRS queue"), not about the data. So give
// them their precondition: mark two answered questions, in a topic small
// enough that a count-200 session selects the topic's whole pool, as disputed
// in THIS test file's database. Each file has its own DB_PATH (./testDb), so
// the mark never leaks between files, and `mcqs` is only re-ingested when the
// corpus file's hash changes — never mid-file.
//
// Idempotent: if the corpus already carries two answered base-disputed
// questions it marks nothing. `ids` is what the fixture may now rely on;
// `marked` is only what THIS call flipped, so a caller that restores the
// corpus afterwards can never un-flag a question that shipped disputed.
// `avoidTopic` keeps the seed out of a topic a file relies on being clean.
// -----------------------------------------------------------------------------
export function ensureBaseDisputed(avoidTopic?: string): { ids: string[]; marked: string[] } {
  const have = (sqlite.prepare(
    "SELECT id FROM mcqs WHERE disputed = 1 AND answer IS NOT NULL ORDER BY id",
  ).all() as Array<{ id: string }>).map((r) => r.id);
  if (have.length >= 2) return { ids: have, marked: [] };
  const rows = sqlite.prepare(
    `SELECT m.id FROM mcqs m
      WHERE m.answer IS NOT NULL AND m.disputed = 0
        AND m.topic_slug <> ?
        AND (SELECT COUNT(*) FROM mcqs t WHERE t.topic_slug = m.topic_slug AND t.answer IS NOT NULL) <= 200
      ORDER BY m.topic_slug, m.id
      LIMIT ?`,
  ).all(avoidTopic ?? "", 2 - have.length) as Array<{ id: string }>;
  const mark = sqlite.prepare("UPDATE mcqs SET disputed = 1 WHERE id = ?");
  for (const r of rows) mark.run(r.id);
  const marked = rows.map((r) => r.id);
  return { ids: [...have, ...marked], marked };
}

/** Undo ensureBaseDisputed() for the ids it MARKED — for a file whose other
 *  tests count disputed questions and must see the corpus as shipped. */
export function clearBaseDisputed(ids: string[]): void {
  const unmark = sqlite.prepare("UPDATE mcqs SET disputed = 0 WHERE id = ?");
  for (const id of ids) unmark.run(id);
}
