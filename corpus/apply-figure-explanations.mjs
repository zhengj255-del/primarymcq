#!/usr/bin/env node
// Re-apply this site's own explanations for the questions that ship a plate.
//
//   node corpus/apply-figure-explanations.mjs
//   node corpus/apply-figure-explanations.mjs corpus/figure-explanations.json server/data/mcqs.json
//
// WHY THIS EXISTS. server/data/mcqs.json is a copy of the tracker's bank and a
// refresh replaces it wholesale (README.md, "The corpus"). A handful of
// questions here point at a drawing the tracker does not have, and their
// explanations were written against that drawing - they name what point D on
// our plate is, and what the answer depends on. The tracker's explanation for
// the same question reasons about the apparatus in general and cannot. A
// question does not have to carry a `figure` itself to belong here: 18B-54 is
// the sibling of the vascular-function-curve plate and must name the same
// curve the drawing does. The
// 2026-09-10 refresh took them out silently and the site's own figure tests
// caught it only after the merge; this script is how they go back, and
// server/__tests__/mcqFigures.test.ts fails until they have.
//
// Idempotent: run it after every refresh, and again for good measure.
import { readFileSync, writeFileSync } from "node:fs";

const [overlayPath = "corpus/figure-explanations.json", corpusPath = "server/data/mcqs.json"] =
  process.argv.slice(2);

const overlay = JSON.parse(readFileSync(overlayPath, "utf8")).explanations;
if (!overlay || typeof overlay !== "object") throw new Error(`${overlayPath}: no explanations object`);

const raw = readFileSync(corpusPath, "utf8");
const corpus = JSON.parse(raw);
if (!Array.isArray(corpus)) throw new Error(`${corpusPath}: expected a JSON array`);
const byId = new Map(corpus.map((q) => [q.id, q]));

let applied = 0, already = 0;
for (const [id, reason] of Object.entries(overlay)) {
  const q = byId.get(id);
  // A missing id means the refresh dropped or renamed the question. That is
  // never a silent overlay skip: the plate is still on the site.
  if (!q) throw new Error(`${id}: named in ${overlayPath} but not in ${corpusPath}`);
  if (q.reason === reason) { already++; continue; }
  q.reason = reason;
  applied++;
}

if (applied) {
  const indentMatch = raw.match(/\n( +)[{"]/);
  const indent = indentMatch ? indentMatch[1].length : 2;
  writeFileSync(corpusPath, JSON.stringify(corpus, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
}
console.log(`${corpusPath}: ${applied} explanation(s) restored, ${already} already current`);
