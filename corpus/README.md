# Corpus additions

Recalled ANZCA Primary MCQ papers, converted into the exact record shape of `server/data/mcqs.json`, so the same file can be dropped into any app that ingests that corpus — this site and the tracker it was cut from alike.

| File | What it is |
|---|---|
| `additions-2025-2026-recalls.json` | The records. An object with `schema`, `generated`, `sources` (one line per sitting: code prefix, section label, where it came from, how many records) and `records`, the array of questions. |
| `merge-additions.mjs` | Merges a records file into a `mcqs.json`, idempotently by `id`. No dependencies beyond Node. |

## Sittings in the file

| Code prefix | Section | Source | Answers |
|---|---|---|---|
| `25A-n` | `2025.1 (P25A) RECALL` | An Anki package, deck *MCQs::2025 MCQ*, 282 cards. Taken to be the 2025.1 sitting: it shares only a handful of questions with the 2025.2 recall already in the corpus. | The card's back, where it gave one (256 of 276). They are the deck author's answers and are marked unverified in each record's `reason`. The remaining 20 were answered by the tracker's audit (see below). |
| `26A-n` | `2026.1 (P26A) RECALL` | The *2026.1 MCQs* document: three recallers' lists concatenated, the first with lettered options, the second unnumbered, the third a "rough recall" with options written inline. Duplicates across the three lists were merged; items with fewer than two recalled options were left out. | 2 from the recallers ("(correct)" beside an option); the other 105 from the tracker's audit (see below). Recallers' annotations and explanatory notes are kept in `reason`. |
| `26B-n` | `2026.2 (P26B) RECALL` | The *2026.2 Recall* document, numbered 1–132 (83 absent from the source, 121 had one option). `n` is the document's own number. | None from the recallers; all 130 from the tracker's audit (see below). This is the least-corroborated sitting in the file. |

Questions that showed a figure carry a description of it in the stem, in square brackets. The images themselves are not shipped: the app's figure pipeline takes original SVG drawings only, and screenshots of exam material are not ours to publish.

Where a question recurs from an earlier sitting it is kept as a separate record under the new sitting's code, as the corpus already does for repeated papers. The ids are `<topic slug>__<code>`; topics were assigned by keyword rules and then checked by hand.

## Where the answers came from

The recallers wrote down the questions, not the answers: 255 of the 513 arrived with no key at all. Those were answered by the **renton-tracker MCQ audit** — a per-question adjudication against the prescribed texts (the sixteen sources listed under [The grounding corpus](#the-grounding-corpus) below) — and folded back into this file. Every record it touched carries one line at the top of its `reason` saying so, for example:

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

## The grounding corpus

Every answer, explanation and repair in this file that is credited to the tracker's audit was reached "against the prescribed texts". That phrase means one specific thing: the **prescribed-textbook retrieval store** the tracker (`zhengj255-del/renton-tracker`) keeps on its Fly volume. It is built by `scripts/chunk_textbooks.mjs` and `scripts/embed_textbooks.mjs` in that repository from the owner's PDFs, and it is not committed anywhere — the store is derived data, re-creatable from the books, and the books themselves are not ours to publish.

The store covers these sixteen sources, under the labels the audit cites them by (the label is what appears after `Source:` in an explanation):

| # | Label as cited | Source |
|---|---|---|
| 1 | ANZCA Curriculum Appendix 2 | Anaesthesia training program curriculum v1.13, Appendix 2 |
| 2 | Anatomy for Anaesthetists | Anatomy for Anaesthetists (Blackwell, 2014) |
| 3 | Anesthetic Pharmacology (Evers) | Anesthetic Pharmacology: Basic Principles and Clinical Practice, 2nd ed. |
| 4 | Essentials of Anaesthetic Equipment | Essentials of Anaesthetic Equipment |
| 5 | Nunn & Lumb's Respiratory Physiology | Nunn and Lumb's Applied Respiratory Physiology |
| 6 | Rang & Dale's Pharmacology | Rang and Dale's Pharmacology |
| 7 | Stoelting's Pharmacology & Physiology | Stoelting's Pharmacology and Physiology in Anesthetic Practice |
| 8 | Vander's Renal Physiology | Vander's Renal Physiology |
| 9 | Pappano Cardiovascular Physiology | Pappano & Wier, Cardiovascular Physiology |
| 10 | West's Respiratory Physiology | West's Respiratory Physiology: The Essentials |
| 11 | Guyton & Hall Physiology | Guyton and Hall Textbook of Medical Physiology |
| 12 | Dorsch & Dorsch Equipment | Dorsch & Dorsch, Understanding Anesthesia Equipment |
| 13 | Clinical Pain Management (Acute Pain) | Clinical Pain Management: Acute Pain |
| 14 | Principles of Physiology for the Anaesthetist (Kam & Power) | Kam & Power, Principles of Physiology for the Anaesthetist |
| 15 | Cousins & Bridenbaugh Neural Blockade | Cousins & Bridenbaugh's Neural Blockade in Clinical Anesthesia and Pain Medicine |
| 16 | Foundations of Anesthesia (Hemmings & Hopkins) | Hemmings & Hopkins, Foundations of Anesthesia |

How the store is made and read:

* Each PDF is extracted page by page and packed into chunks of roughly 800 tokens with about 15% overlap, tagged `{book, page}`. The page is the **physical PDF page index**, 1-based — not the printed page number — so a cited `p. 614` is the 614th page of the file.
* Chunks are embedded with OpenAI `text-embedding-3-large` at 1536 dimensions; the store holds about 15.5k chunks.
* At adjudication time the question's stem and options are embedded once and the ten most similar passages (cosine similarity) are handed to the model, which may cite only passages it was shown. A citation naming a book or page outside the retrieved set is stripped before the explanation is saved, so a `Source:` line can never be invented. Where no passage supported the point, the line reads `Source: not in the prescribed-text store`.
* Nothing outside these sixteen sources is consulted. Recalled exam material, Anki decks and the model's own training are not grounding: a claim that rests on them carries no citation.

Two caveats. The list is what the bake script targets; a book only reaches the store if its PDF filename matched at bake time, and the script's own history records books silently missing for that reason. And the labels are what the audit writes — check the store's `textbook_embeddings.meta.json` on the volume to confirm which of the sixteen are actually loaded on a given day.
