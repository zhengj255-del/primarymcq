# Corpus additions

Recalled ANZCA Primary MCQ papers, converted into the exact record shape of `server/data/mcqs.json`, so the same file can be dropped into any app that ingests that corpus — this site and the tracker it was cut from alike.

| File | What it is |
|---|---|
| `additions-2025-2026-recalls.json` | The records. An object with `schema`, `generated`, `sources` (one line per sitting: code prefix, section label, where it came from, how many records) and `records`, the array of questions. |
| `merge-additions.mjs` | Merges a records file into a `mcqs.json`, idempotently by `id`. No dependencies beyond Node. |
| `handover-2026-09-07.md` | Hand-over notes written after the 2026-09-07 answer refresh: what the bank holds now, what the tracker's audit changed and where, the conventions that must not be broken (permanent ids, the provenance line at the top of each touched `reason`) and which questions deserve human review first. Read it before editing the corpus. |

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

## Regenerating

The records were produced from the three source files by scripts kept outside the repository (the sources contain recalled exam material and are not committed). To add a further sitting, produce records in the same shape — the `schema` line in the JSON and `merge-additions.mjs` spell out what a record must contain — give the sitting its own code prefix, and merge.
