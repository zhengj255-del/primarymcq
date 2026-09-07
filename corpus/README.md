# Corpus additions

Recalled ANZCA Primary MCQ papers, converted into the exact record shape of `server/data/mcqs.json`, so the same file can be dropped into any app that ingests that corpus — this site and the tracker it was cut from alike.

| File | What it is |
|---|---|
| `additions-2025-2026-recalls.json` | The records. An object with `schema`, `generated`, `sources` (one line per sitting: code prefix, section label, where it came from, how many records) and `records`, the array of questions. |
| `merge-additions.mjs` | Merges a records file into a `mcqs.json`, idempotently by `id`. No dependencies beyond Node. |

## Sittings in the file

| Code prefix | Section | Source | Answers |
|---|---|---|---|
| `25A-n` | `2025.1 (P25A) RECALL` | An Anki package, deck *MCQs::2025 MCQ*, 282 cards. Taken to be the 2025.1 sitting: it shares only a handful of questions with the 2025.2 recall already in the corpus. | The card's back, where it gave one (about 85% of cards). They are the deck author's answers and are marked unverified in each record's `reason`. |
| `26A-n` | `2026.1 (P26A) RECALL` | The *2026.1 MCQs* document: three recallers' lists concatenated, the first with lettered options, the second unnumbered, the third a "rough recall" with options written inline. Duplicates across the three lists were merged; items with fewer than two recalled options were left out. | None, except where the recaller wrote "(correct)" next to an option. Recallers' annotations and explanatory notes are kept in `reason`. |
| `26B-n` | `2026.2 (P26B) RECALL` | The *2026.2 Recall* document, numbered 1–132 (83 absent from the source, 121 had one option). `n` is the document's own number. | None. |

Questions that showed a figure carry a description of it in the stem, in square brackets. The images themselves are not shipped: the app's figure pipeline takes original SVG drawings only, and screenshots of exam material are not ours to publish.

Where a question recurs from an earlier sitting it is kept as a separate record under the new sitting's code, as the corpus already does for repeated papers. The ids are `<topic slug>__<code>`; topics were assigned by keyword rules and then checked by hand.

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
