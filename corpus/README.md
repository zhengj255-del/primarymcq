# Corpus additions

Recalled ANZCA Primary MCQ papers, converted into the exact record shape of `server/data/mcqs.json`, so the same file can be dropped into any app that ingests that corpus — this site and the tracker it was cut from alike.

| File | What it is |
|---|---|
| `additions-2025-2026-recalls.json` | The records. An object with `schema`, `generated`, `sources` (one line per sitting: code prefix, section label, where it came from, how many records) and `records`, the array of questions. |
| `merge-additions.mjs` | Merges a records file into a `mcqs.json`, idempotently by `id`. No dependencies beyond Node. |
| `primarymcq-corpus.meta.json` | What the tracker folded into the corpus this site now ships (see *The whole-bank refresh* below): export time, record count, and per-shape counts of keys supplied, keys corrected, stems and options repaired, disputes cleared. Copied from the tracker unchanged; the tracker writes it beside its `primarymcq-corpus.json`. |
| `handover-2026-09-07.md` | Hand-over notes written after the recall-only answer refresh of 2026-09-07 (the site at `2fad5e7`): the conventions that must not be broken (permanent ids, the provenance line at the top of each touched `reason`) and which questions deserve human review first. Its counts predate the whole-bank refresh later that day and are marked as such at the top of the file. |

## Sittings in the file

| Code prefix | Section | Source | Answers |
|---|---|---|---|
| `25A-n` | `2025.1 (P25A) RECALL` | An Anki package, deck *MCQs::2025 MCQ*, 282 cards. Taken to be the 2025.1 sitting: it shares only a handful of questions with the 2025.2 recall already in the corpus. | The card's back, where it gave one (256 of 276). They are the deck author's answers and are marked unverified in each record's `reason`. The remaining 20 were answered by the tracker's audit (see below). |
| `26A-n` | `2026.1 (P26A) RECALL` | The *2026.1 MCQs* document: three recallers' lists concatenated, the first with lettered options, the second unnumbered, the third a "rough recall" with options written inline. Duplicates across the three lists were merged; items with fewer than two recalled options were left out. | 2 from the recallers ("(correct)" beside an option); the other 105 from the tracker's audit (see below). Recallers' annotations and explanatory notes are kept in `reason`. |
| `26B-n` | `2026.2 (P26B) RECALL` | The *2026.2 Recall* document, numbered 1–132 (83 absent from the source, 121 had one option). `n` is the document's own number. | None from the recallers; all 130 from the tracker's audit (see below). This is the least-corroborated sitting in the file. |

Questions that showed a figure carry a description of it in the stem, in square brackets. The images themselves are not shipped: the app's figure pipeline takes original SVG drawings only, and screenshots of exam material are not ours to publish.

Where a question recurs from an earlier sitting it is kept as a separate record under the new sitting's code, as the corpus already does for repeated papers. The ids are `<topic slug>__<code>`; topics were assigned by keyword rules and then checked by hand.

## Where the answers came from

The recallers wrote down the questions, not the answers: 255 of the 513 arrived with no key at all. Those were answered by the **renton-tracker MCQ audit** — a per-question adjudication against the prescribed texts — and folded back into this file. Every record it touched carries one line at the top of its `reason` saying so, for example:

> Answer and explanation supplied by the tracker's GPT audit (gpt-5.6-sol, prescribed-text grounded), 2026-09-07 — not examiner-verified.

**No examiner has confirmed any of these answers**, and nor has a human. Treat them as a study aid, not as a mark scheme — the wording above is deliberately on every affected question so nobody mistakes one for the other while sitting it. Where the adjudication could not settle a question, the record is left `disputed: true` and lands on the Disputes page rather than being served with a key nobody trusts.

The audit also repaired question text where the recall was incomplete: 78 stems and 56 option sets. In 16 of those the option set gained choices the recallers had not captured, which means those distractors are the adjudicator's own writing rather than the paper's.

The `baked` block in the JSON records the model, the date and the counts.

## Merging

```sh
# this repository (already done for the shipped corpus)
node corpus/merge-additions.mjs corpus/additions-2025-2026-recalls.json server/data/mcqs.json

# the tracker, from its repository root, after copying the two files across
node corpus/merge-additions.mjs corpus/additions-2025-2026-recalls.json server/data/mcqs.json
```

The script appends records whose `id` is new and replaces records whose `id` already exists, then rewrites the file with its existing indentation. Running it again is a no-op. Both apps re-ingest the corpus at the next boot when the file's hash changes; attempts, spaced-repetition state and edits are keyed by question id and survive the refresh.

## The whole-bank refresh

Since 2026-09-07 this site's `server/data/mcqs.json` is no longer the tracker's raw file plus the additions above. It is the tracker's **whole-bank hand-off**, `corpus/primarymcq-corpus.json`, taken wholesale. The tracker's `bake-overrides.mjs --scope all` folds every row of its override layer — months of curation on the Black Bank questions as well as the recall answers — into a full corpus, and its *MCQ recall bake* workflow writes that file beside the additions file, with `primarymcq-corpus.meta.json` recording what was folded. The copy of that meta file here is from the export of 2026-09-07T14:20:23Z: 2366 records, 981 overrides folded.

Against the corpus this site shipped before it, 683 records changed:

- **Every question now has a key.** The 149 that were keyless — 146 of them the entire 2025.2 (P25B) recall sitting — were answered by the tracker's audit, and 117 Black Bank keys were corrected. No key was cleared.
- **No question is `disputed` any more.** 247 Black Bank disputes were triaged and closed in the tracker, and `clinical-measurement__25A-35`, which the recall bake had left disputed, has a repaired stem and the key C.
- Stems and option sets were repaired on a few hundred questions and reasons rewritten on about six hundred; the meta file has the counts by shape.

Each changed `reason` starts with one provenance line naming its source, and the wording tells you which kind of change it was:

- `… the tracker's GPT audit (MODEL, prescribed-text grounded), DATE — not examiner-verified.` — a change whose audit verdict was applied.
- `… in the tracker's curated copy, DATE — …` — a hand edit or a dispute-triage decision by the tracker's owner.
- `… the tracker's GPT generator …` — an explanation or added distractors written by the tracker's bulk generator with the key held fixed (none in this export).

A question the tracker discards is kept here and parked as `disputed: true`, never dropped, so nobody's attempts or spaced-repetition state on it are lost. Ids never change.

To refresh again: run the tracker's *MCQ recall bake* workflow, then copy the tracker's `corpus/primarymcq-corpus.json` over `server/data/mcqs.json`, and its `corpus/additions-2025-2026-recalls.json` and `corpus/primarymcq-corpus.meta.json` over the files here. Then run the merge below — it must report 513 replaced and leave the file's bytes unchanged, because the hand-off already contains the additions; if it changes anything, the tracker's two files disagree and the bake should be re-run — and `npm run check && npm test` before pushing.

## Regenerating

The records were produced from the three source files by scripts kept outside the repository (the sources contain recalled exam material and are not committed). To add a further sitting, produce records in the same shape — the `schema` line in the JSON and `merge-additions.mjs` spell out what a record must contain — give the sitting its own code prefix, and merge.
