#!/usr/bin/env node
// Merge a corpus-additions file into a mcqs.json.
//
//   node corpus/merge-additions.mjs corpus/additions-2025-2026-recalls.json server/data/mcqs.json
//
// The additions file is either a bare array of records or an object with a
// `records` array; every record must have the full shape of a mcqs.json entry.
// Merging is idempotent and keyed by `id`: a record whose id is already in the
// corpus replaces that entry, any other record is appended. Nothing else in
// the corpus is touched, so running it twice, or after a corpus refresh,
// is safe. The file is rewritten with the indentation it already uses.
//
// The same command works against the tracker's server/data/mcqs.json: the
// record shape is the one both apps ingest.
import { readFileSync, writeFileSync } from "node:fs";

const [addPath, corpusPath] = process.argv.slice(2);
if (!addPath || !corpusPath) {
  console.error("usage: node corpus/merge-additions.mjs <additions.json> <mcqs.json>");
  process.exit(2);
}

const REQUIRED = ["code", "displayCode", "papers", "topicFile", "topicName", "section", "parentCode",
  "stem", "options", "answer", "reason", "urls", "disputed", "id"];

const raw = readFileSync(corpusPath, "utf8");
const corpus = JSON.parse(raw);
if (!Array.isArray(corpus)) throw new Error(`${corpusPath}: expected a JSON array`);
const parsed = JSON.parse(readFileSync(addPath, "utf8"));
const additions = Array.isArray(parsed) ? parsed : parsed.records;
if (!Array.isArray(additions)) throw new Error(`${addPath}: expected an array or an object with a records array`);

const byId = new Map(corpus.map((q, i) => [q.id, i]));
let added = 0, replaced = 0;
for (const q of additions) {
  for (const k of REQUIRED) if (!(k in q)) throw new Error(`${q.id ?? q.code ?? "?"}: missing field ${k}`);
  if (typeof q.options !== "object" || Object.keys(q.options).length < 2) throw new Error(`${q.id}: needs at least two options`);
  if (q.answer !== null && !(q.answer in q.options)) throw new Error(`${q.id}: answer ${q.answer} is not an option`);
  const expectedId = `${q.topicFile.replace(/^MCQ-/, "").replace(/\.txt$/, "").toLowerCase()}__${q.code}`;
  if (q.id !== expectedId) throw new Error(`${q.id}: id should be ${expectedId}`);
  if (byId.has(q.id)) { corpus[byId.get(q.id)] = q; replaced++; }
  else { byId.set(q.id, corpus.length); corpus.push(q); added++; }
}

// Keep the file's existing indentation: the width of the first indented line
// (the opening brace of the first record; the shipped corpus uses two spaces).
const indentMatch = raw.match(/\n( +)[{"]/);
const indent = indentMatch ? indentMatch[1].length : 2;
writeFileSync(corpusPath, JSON.stringify(corpus, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
console.log(`${corpusPath}: ${added} added, ${replaced} replaced, ${corpus.length} questions now`);
