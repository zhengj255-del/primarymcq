// -------------------------------------------------------------------------------------------------
// THE sittable predicate — the single definition of "a study session could
// serve this question", shared by every pool, every queue and every count that
// claims to describe them.
//
// This lives in its own module for one reason: storage.ts cannot import
// mcqStudy.ts (circular — mcqStudy imports storage), so without a shared home
// every caller that needs the predicate would grow its own inlined copy, and
// inlined copies drift — a count that promises reviews a sitting then does not
// serve. These are plain strings with no imports, so mcqs.ts, mcqStudy.ts and
// storage.ts can all share them without a cycle.
//
// A question is sittable when its EFFECTIVE answer (an override wins; '' is the
// user clearing it) exists and it has not been discarded by hand. Any count
// computed off the raw base table drifts from the pools the moment an edit
// touches anything.
//
// The dispute predicate that used to be the third half of this test is gone
// with the Disputes page (Sep 2026): nothing marks a question disputed any
// more, so every keyed, undiscarded question is sittable. The columns it read
// (mcqs.disputed, mcq_overrides.disputed) are left on existing volumes rather
// than migrated away; no query reads them.
//
// Declaration order matters: SRS_SITTABLE_SQL composes the pieces below it, so
// it is declared LAST rather than beside its answer/discard halves — a const
// interpolating a later const is a TDZ crash at import, not a lint nit.
// -------------------------------------------------------------------------------------------------

/** Effective-answer test for a query with `mcqs` aliased as `m`. */
export const EFFECTIVE_ANSWER_SQL = `CASE WHEN (SELECT o.answer FROM mcq_overrides o WHERE o.mcq_id = m.id) IS NOT NULL
          THEN NULLIF((SELECT o.answer FROM mcq_overrides o WHERE o.mcq_id = m.id), '')
          ELSE m.answer END IS NOT NULL`;

/** Not-discarded test for a query with `mcqs` aliased as `m`. */
export const NOT_DISCARDED_SQL =
  "NOT EXISTS (SELECT 1 FROM mcq_overrides o WHERE o.mcq_id = m.id AND o.excluded = 1)";

/** The whole sittable test for a query over `mcq_srs_state` aliased as `s`: the
 *  SRS queue and every count of it must only ever include questions a session
 *  can serve — not discarded, and carrying an effective answer.
 *
 *  Keep the count and the queue running THIS constant. The bill for two copies
 *  has already been paid twice here (mcq-engine-srs-study-1): a count computed
 *  without a clause the queue applied promised "MCQ reviews due 247" over a
 *  queue of nothing, with no way for the candidate to clear the pile. A copy is
 *  not wrong the day it is written, it is wrong the day the original is
 *  repaired and the copy is not.
 *
 *  The `m` alias inside the EXISTS is bound here on purpose — a caller
 *  interpolating this into a query that already binds `m` must alias its own
 *  differently, or the EXISTS silently compares the wrong row. */
export const SRS_SITTABLE_SQL = `NOT EXISTS (SELECT 1 FROM mcq_overrides o WHERE o.mcq_id = s.mcq_id AND o.excluded = 1)
      AND EXISTS (SELECT 1 FROM mcqs m WHERE m.id = s.mcq_id AND ${EFFECTIVE_ANSWER_SQL})`;

// The weak-topics list, shared by the two surfaces that SHOW weak topics to the
// candidate: getWeakAreas (mcqStudy.ts — the Study page's list) and the
// next-actions "Drill MCQs: X" block (storage.ts buildNextActions). storage.ts
// cannot import mcqStudy (circular), so the next-actions copy was inlined by
// hand and never got the `a.selected IS NOT NULL` repair the other copies did —
// mcq-engine-srs-study-2: a topic five times revealed with "Don't know" and
// then answered correctly was reported as a 0 % weak area to drill on the one
// surface that decides what the candidate does next, while the Study page
// called it 100 %. Both now interpolate this string; neither retypes it, and
// mcqPredicateSingleSource.test.ts holds them to it.
//
// `a.selected IS NOT NULL` is the load-bearing clause: an SRS reveal ("Don't
// know") writes an attempt with no selection and correct = 0, and counting it
// as a wrong answer invents weakness out of honesty. The escape (D2): none —
// there is no flag that re-admits reveals, because no surface has ever wanted
// them; a caller that genuinely needs "attempts including reveals" needs a
// different query with a different name, not a parameter on this one.
//
// There is a THIRD historical copy, computeWeakTopicSlugs in mcqStudy.ts, and
// it deliberately stays separate: it feeds the weak-areas session FILTER, whose
// bottom-quartile cut needs every qualifying topic as its denominator, so it
// must not carry the LIMIT 8 this one has. See the comment on it before
// "unifying" the two — they are different questions that happen to share a
// FROM clause.
export const WEAK_AREAS_SQL = `
    SELECT m.topic_slug as slug, m.topic_name as name,
           COUNT(*) as attempts,
           COALESCE(SUM(a.correct), 0) as correct
    FROM mcq_attempts a JOIN mcqs m ON m.id = a.mcq_id
    WHERE a.selected IS NOT NULL
    GROUP BY m.topic_slug, m.topic_name
    HAVING attempts >= 5
    ORDER BY (CAST(correct AS REAL) / attempts) ASC
    LIMIT 8
  `;
