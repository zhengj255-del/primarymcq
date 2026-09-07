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
// user clearing it) exists, it has not been discarded in dispute triage, and it
// is not effectively disputed. Any count computed off the raw base table drifts
// from the pools the moment triage touches anything.
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

// -------------------------------------------------------------------------------------------------
// Dispute — the other half of "a session could serve this question".
//
// A dispute raised in the app is written to `mcq_overrides`, and triage
// resolving one writes 0 there over a base column that may still say 1: the
// override always wins, '' and NULL meaning "the user has said nothing, use the
// base". Every study pool applies this under `excludeDisputed`, and the Study
// page always sets that flag (client/src/pages/Study.tsx:464, :519) — so any
// count computed without it promises questions the queue will not serve.
// -------------------------------------------------------------------------------------------------

/** Effectively-disputed test for a query with `mcqs` aliased as `m`. The
 *  POSITIVE form exists because four surfaces ask the question that way round —
 *  the /mcqs list filter, the stats header's `disputed` count, the per-paper
 *  `isDisputed` flag behind "Sit a real paper", and the triage queue — and each
 *  had hand-typed its own COALESCE. Every one of them was correct; that is the
 *  point. A copy is not wrong the day it is written, it is wrong the day the
 *  original is repaired and the copy is not, which is precisely how the SRS
 *  count came to promise reviews the queue would not serve
 *  (mcq-engine-srs-study-1). Import this; do not retype it.
 *
 *  `= 1` rather than `<> 0` on purpose: both columns are written only ever as
 *  0 or 1 (mcqs.disputed by ingest as `rec.disputed ? 1 : 0`,
 *  mcq_overrides.disputed by updateMcqOverride as `edit.disputed ? 1 : 0` or
 *  NULL), so the two spellings agree, and `= 1` is the one every call site
 *  already used. */
export const DISPUTED_SQL_M =
  "COALESCE((SELECT o.disputed FROM mcq_overrides o WHERE o.mcq_id = m.id), m.disputed) = 1";

/** Not-disputed test for a query with `mcqs` aliased as `m`. Behaviourally
 *  identical to the predicate the study pool has always used under
 *  `excludeDisputed` (mcqStudy.ts scopeWhere) — it is imported rather than
 *  retyped so the count and the queue cannot drift again.
 *
 *  Defined as the negation of DISPUTED_SQL_M rather than as a second
 *  hand-written `... = 0`, so that a repair to one form cannot leave the other
 *  behind. The negation is total: the inner correlated subquery may be NULL (no
 *  override row, or an override that says nothing about disputes), but
 *  `mcqs.disputed` is NOT NULL DEFAULT 0, so the COALESCE always yields a
 *  value and there is no third bucket where a row could satisfy neither form.
 *  `NOT (...)` is parenthesised at the point of use by that construction, so
 *  interpolating it into a longer `AND` chain needs no extra brackets. */
export const NOT_DISPUTED_SQL_M = `NOT (${DISPUTED_SQL_M})`;

/** The same test for a query over `mcq_srs_state` aliased as `s`, which does
 *  not have `mcqs` in scope: the base column is fetched by a second correlated
 *  subquery. Aliased `m2` on purpose — SRS_SITTABLE_SQL already binds `m` in
 *  its own EXISTS, and a shadowing alias inside it would silently compare the
 *  wrong row. */
export const NOT_DISPUTED_SQL_S =
  `COALESCE((SELECT o.disputed FROM mcq_overrides o WHERE o.mcq_id = s.mcq_id),
               (SELECT m2.disputed FROM mcqs m2 WHERE m2.id = s.mcq_id)) = 0`;

/** The whole sittable test for a query over `mcq_srs_state` aliased as `s`: the
 *  SRS queue and every count of it must only ever include questions a session
 *  can serve — not discarded, an effective answer, and not effectively
 *  disputed.
 *
 *  The dispute clause is the third drift of the same defect (after the
 *  discarded-only and then answer-blind versions): the queue drops disputed
 *  questions unconditionally, because the Study page hard-sets
 *  `excludeDisputed` on both the queue-stats request and the session request
 *  and the old toggle is gone, so a count without it promised reviews the
 *  sitting refused to serve — "MCQ reviews due 247" over a queue of nothing,
 *  with no way for the candidate to clear the pile. It is unconditional here
 *  for the same reason: no caller of this constant carries an
 *  `excludeDisputed` flag, and the only surface that can re-admit a disputed
 *  question is dispute triage, which resolves it (writing 0 over the base
 *  column, which the COALESCE above honours). Should a "study disputed
 *  questions anyway" pool ever exist, this becomes a function of that flag —
 *  and the count for THAT caller must take the same flag, or the pair drifts
 *  again. */
export const SRS_SITTABLE_SQL = `NOT EXISTS (SELECT 1 FROM mcq_overrides o WHERE o.mcq_id = s.mcq_id AND o.excluded = 1)
      AND EXISTS (SELECT 1 FROM mcqs m WHERE m.id = s.mcq_id AND ${EFFECTIVE_ANSWER_SQL})
      AND ${NOT_DISPUTED_SQL_S}`;

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
