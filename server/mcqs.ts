// -------------------------------------------------------------------------------------------------
// MCQ ingest & query helpers — Kerry Brandis "Black Bank" corpus.
//
// Loads /server/data/mcqs.json (produced by scripts/parse_mcqs.py) into the
// mcqs + mcq_lo_links tables at server startup. Idempotent: reingests only
// when the stored content hash doesn't match the JSON file.
//
// Auto-links each MCQ to ANZCA learning objectives by running a whole-word
// keyword matcher against a canonical haystack built from stem + options +
// section.
// -------------------------------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sqlite } from "./storage";
import type { McqRecord } from "@shared/schema";
import { LEARNING_OBJECTIVES } from "./learningObjectives";

// Resolve the mcqs.json data file. Search a set of candidate paths so we
// work in dev (tsx from the app root => server/data/mcqs.json), production
// (bundled CJS at dist/index.cjs => dist/data/mcqs.json), and any other
// working-directory layout Fly happens to use.
function resolveMcqsJson(): string {
  const candidates: string[] = [];
  // 1) alongside the running module (works for both dev and prod bundles).
  try {
    const here = typeof __dirname !== "undefined"
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, "data", "mcqs.json"));
    candidates.push(path.join(here, "..", "server", "data", "mcqs.json"));
  } catch {
    // ignore — fall through to cwd candidates
  }
  // 2) relative to the process working directory.
  candidates.push(path.resolve(process.cwd(), "server/data/mcqs.json"));
  candidates.push(path.resolve(process.cwd(), "dist/data/mcqs.json"));
  candidates.push(path.resolve(process.cwd(), "data/mcqs.json"));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Return the first candidate so the error message shows something useful.
  return candidates[0] || path.resolve(process.cwd(), "server/data/mcqs.json");
}

const MCQS_JSON = resolveMcqsJson();

// Whole-word keyword matcher. Splits the keyword into alphanumeric tokens (a
// hyphen or space becomes a separator) and requires each token to appear
// bordered by non-word characters in the haystack, in order but not
// necessarily contiguously — so short acronyms like "mac" don't fire on
// "macintosh" or "macrolide".
function matchesKeyword(haystack: string, keyword: string): boolean {
  const tokens = keyword.split(/[^a-z0-9]+/i).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  let cursor = 0;
  for (const tok of tokens) {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i");
    const slice = haystack.slice(cursor);
    const m = re.exec(slice);
    if (!m) return false;
    cursor += (m.index ?? 0) + m[0].length;
  }
  return true;
}

// Given an MCQ, return the ANZCA LO codes that match its stem+options+section.
// We do NOT include `reason` — reasons quote long explanatory passages and would
// over-match (every "define / describe" verb becomes a link).
function findMatchingLOs(
  stem: string,
  optionsJoined: string,
  section: string | null,
  domain: string,
): string[] {
  const haystack = `${stem} ${optionsJoined} ${section ?? ""}`.toLowerCase();
  const matches: string[] = [];
  for (const lo of LEARNING_OBJECTIVES) {
    // Only consider LOs from the same broad domain — cross-domain matches on
    // generic terms like "receptor" or "gradient" are too noisy.
    if (lo.domain !== domain && !crossDomainAllowed(lo.domain, domain)) continue;
    for (const kw of lo.keywords) {
      if (matchesKeyword(haystack, kw.toLowerCase())) {
        matches.push(lo.code);
        break;
      }
    }
  }
  return matches;
}

// Some LO domains overlap heavily with MCQ topics — e.g. renal MCQs frequently
// hit endocrine or fluids LOs. Whitelist a few known overlaps so we don't
// under-link.
const CROSS_DOMAIN_MAP: Record<string, Set<string>> = {
  // --- Physiology topics ---
  renal:      new Set(["endo", "pharm_prin", "cvs_pharm"]),
  cvs:        new Set(["cvs_pharm", "auto_pharm"]),
  resp:       new Set(["resp_pharm", "va", "gas"]),
  cellular:   new Set(["endo", "muscle", "pharm_prin"]),
  neuro:      new Set(["pain", "la", "ia", "opioids", "nmb"]),
  haem:       new Set(["immun", "misc_pharm"]),
  gi:         new Set(["misc_pharm", "opioids"]),
  obs:        new Set(["pharm_prin"]),
  thermo:     new Set(["va", "muscle"]),
  acid_base:  new Set(["renal", "resp"]),
  fluids:     new Set(["renal", "endo"]),
  // --- Pharmacology topics: pair each pharma domain with its physiology counterpart
  //     and pharm_prin (general principles apply everywhere). ---
  cvs_pharm:   new Set(["cvs", "pharm_prin", "auto_pharm"]),
  pharm_prin:  new Set(["cvs_pharm", "resp_pharm", "misc_pharm", "auto_pharm"]),
  va:          new Set(["resp", "pharm_prin", "gas", "neuro"]),
  ia:          new Set(["neuro", "pharm_prin", "cvs"]),
  la:          new Set(["neuro", "pharm_prin", "pain"]),
  misc_pharm:  new Set(["pharm_prin", "gi", "haem", "endo", "immun"]),
  nmb:         new Set(["muscle", "pharm_prin", "neuro"]),
  opioids:     new Set(["pain", "neuro", "pharm_prin"]),
  pain:        new Set(["neuro", "opioids", "pharm_prin", "la"]),
  // --- Miscellaneous topics ---
  //   equip  = clinical measurement, equipment, physics — overlaps safety, gas, resp (breathing circuits/ventilators), va
  //   Procedural anatomy uses `neuro` as primary; existing neuro cross-links already reach la/pain
  equip:       new Set(["safety", "gas", "resp", "va"]),
};

function crossDomainAllowed(loDomain: string, mcqDomain: string): boolean {
  const allow = CROSS_DOMAIN_MAP[mcqDomain];
  return allow ? allow.has(loDomain) : false;
}

// Domain mapping keyed by topic slug (matches TOPIC_META in parse_mcqs.py).
const TOPIC_DOMAIN: Record<string, string> = {
  // Physiology
  "acid-base": "acid_base",
  "cardiovascular": "cvs",
  "cellular-metabolic-endocrine": "cellular",
  "fluids-electrolytes": "fluids",
  "gastrointestinal": "gi",
  "haematology-immune-system": "haem",
  "maternal-foetal": "obs",
  "neurophysiology-pain": "neuro",
  "renal": "renal",
  "respiratory": "resp",
  "thermoregulation": "thermo",
  // Pharmacology
  "cardiovascular-pharmacology": "cvs_pharm",
  "general-pharmacology": "pharm_prin",
  "inhalational-anaesthetics": "va",
  "intravenous-anaesthetics": "ia",
  "local-anaesthetics": "la",
  "miscellaneous-pharmacology": "misc_pharm",
  "muscle-relaxants-reversal-agents": "nmb",
  "opioids": "opioids",
  "pain-management": "pain",
  // Miscellaneous
  "clinical-measurement": "equip",
  "equipment-safety": "equip",
  "procedural-anatomy": "neuro",
  "statistics": "equip",
};

// Broad-domain -> curriculum-domain: MCQs are grouped by physiology topic,
// but ANZCA LOs live in a finer 25-domain taxonomy. Store the closest
// curriculum-domain on each MCQ so the frontend can filter by domain.
const MCQ_DOMAIN_FALLBACK: Record<string, string> = {
  acid_base: "resp",   // acid-base sits in resp/renal — pick resp as the primary
  cellular:  "endo",   // cellular/metabolic/endocrine — nearest 25-domain is endo
  fluids:    "renal",
  thermo:    "va",     // thermoregulation shares heavily with volatile anaesthetics
};

function mcqDomain(topicDomain: string): string {
  return MCQ_DOMAIN_FALLBACK[topicDomain] ?? topicDomain;
}

interface ParsedMcq {
  id: string;
  code: string;
  displayCode: string;
  topicFile: string;
  topicName: string;
  section: string;
  papers: string[];
  stem: string;
  options: Record<string, string>;
  answer: string | null;
  reason: string;
  urls: string[];
  parentCode: string | null;
  figure?: string | null;
}

/**
 * Create MCQ tables if missing, then ingest server/data/mcqs.json if the
 * stored content hash doesn't match. Idempotent — safe to call on every boot.
 */
export function bootstrapMcqs(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mcqs (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      display_code TEXT NOT NULL,
      topic_file TEXT NOT NULL,
      topic_name TEXT NOT NULL,
      topic_slug TEXT NOT NULL,
      domain TEXT NOT NULL,
      section TEXT,
      papers TEXT NOT NULL DEFAULT '[]',
      stem TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '{}',
      answer TEXT,
      reason TEXT NOT NULL DEFAULT '',
      urls TEXT NOT NULL DEFAULT '[]',
      parent_code TEXT,
      figure TEXT
    );
    CREATE INDEX IF NOT EXISTS mcqs_topic_idx ON mcqs(topic_slug);
    CREATE INDEX IF NOT EXISTS mcqs_domain_idx ON mcqs(domain);
    CREATE INDEX IF NOT EXISTS mcqs_code_idx ON mcqs(code);

    CREATE TABLE IF NOT EXISTS mcq_lo_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mcq_id TEXT NOT NULL,
      lo_code TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mcq_lo_links_mcq_idx ON mcq_lo_links(mcq_id);
    CREATE INDEX IF NOT EXISTS mcq_lo_links_lo_idx ON mcq_lo_links(lo_code);
    CREATE UNIQUE INDEX IF NOT EXISTS mcq_lo_links_uniq ON mcq_lo_links(mcq_id, lo_code);

    -- User edits layered on top of the base mcqs row. Kept separate so the
    -- mcqs.json re-ingest doesn't blow away user work.
    CREATE TABLE IF NOT EXISTS mcq_overrides (
      mcq_id TEXT PRIMARY KEY,
      stem TEXT,
      options TEXT,
      answer TEXT,
      reason TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcq_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  // mcq_overrides gained `excluded`: a discarded question stays visible in
  // lists (badged) but drops out of study pools and SRS.
  {
    const cols = sqlite.prepare("PRAGMA table_info(mcq_overrides)").all() as Array<{ name: string }>;
    if (!new Set(cols.map((c) => c.name)).has("excluded")) {
      sqlite.exec("ALTER TABLE mcq_overrides ADD COLUMN excluded INTEGER");
    }
  }

  // Retiring the Disputes page (Sep 2026) leaves two dead flags behind on an
  // existing volume, and each one HIDES something with no screen left to
  // release it:
  //   mcq_overrides.excluded — a "discard" verdict. A discarded question is
  //     filtered out of listMcqs, the stats and every pool, and the triage
  //     queue was the only surface that still showed it. Left as-is it would
  //     be gone from the app entirely.
  //   mcq_overrides.disputed — a dispute raised or resolved by hand. Nothing
  //     reads it any more; a row whose ONLY value was this flag would sit in
  //     the override layer forever, and the `edited` badge already ignores it.
  // Both are cleared once, and an override row emptied by the clear is
  // deleted so the question reads as untouched rather than as a hollow edit.
  // Nothing else in the row is touched: a stem, option, answer or reason edit
  // survives, and the marker in mcq_meta stops this running twice. The
  // COLUMNS stay — dropping them would rewrite a table on the user's volume
  // for no gain, and no query reads them.
  {
    const done = sqlite.prepare("SELECT value FROM mcq_meta WHERE key = 'disputes_retired'").get() as
      | { value: string } | undefined;
    const cols = new Set((sqlite.prepare("PRAGMA table_info(mcq_overrides)").all() as Array<{ name: string }>)
      .map((c) => c.name));
    // Each column independently: a database created AFTER this change has
    // neither and there is nothing to clear, and the two were added at
    // different times, so neither implies the other.
    const retired = ["excluded", "disputed"].filter((c) => cols.has(c));
    if (!done && retired.length > 0) {
      const freed = cols.has("excluded")
        ? (sqlite.prepare("SELECT COUNT(*) c FROM mcq_overrides WHERE excluded = 1").get() as { c: number }).c
        : 0;
      const setNull = retired.map((c) => `${c} = NULL`).join(", ");
      const anySet = retired.map((c) => `${c} IS NOT NULL`).join(" OR ");
      const allNull = retired.map((c) => `${c} IS NULL`).join(" AND ");
      sqlite.exec(`
        UPDATE mcq_overrides SET ${setNull} WHERE ${anySet};
        DELETE FROM mcq_overrides
         WHERE stem IS NULL AND options IS NULL AND answer IS NULL AND reason IS NULL
           AND ${allNull};
      `);
      sqlite.prepare("INSERT OR REPLACE INTO mcq_meta (key, value) VALUES ('disputes_retired', ?)")
        .run(String(Date.now()));
      if (freed > 0) console.log(`[mcqs] disputes retired — ${freed} discarded question(s) returned to the bank`);
    }
  }

  // mcqs gained `figure` for questions whose stem points at a graph/diagram
  // ("see graph below") that was never digitised. Existing databases predate
  // the column, so add it before any read touches it.
  {
    const cols = sqlite.prepare("PRAGMA table_info(mcqs)").all() as Array<{ name: string }>;
    if (!new Set(cols.map((c) => c.name)).has("figure")) {
      sqlite.exec("ALTER TABLE mcqs ADD COLUMN figure TEXT");
    }
  }

  if (!fs.existsSync(MCQS_JSON)) {
    console.warn(`[mcqs] ${MCQS_JSON} missing — MCQ ingest skipped`);
    return;
  }
  const raw = fs.readFileSync(MCQS_JSON, "utf-8");
  const parsed: ParsedMcq[] = JSON.parse(raw);
  // Detect corpus changes by content hash rather than row count. A row-count
  // check misses edits/replacements that keep the same number of questions
  // (e.g. a fixed answer key or reworded stem), leaving the DB stale. The hash
  // covers the full file contents so any change triggers a re-ingest.
  const contentHash = createHash("sha256").update(raw).digest("hex");
  const storedHash = (sqlite.prepare("SELECT value FROM mcq_meta WHERE key = 'content_hash'").get() as { value: string } | undefined)?.value;
  const current = (sqlite.prepare("SELECT COUNT(*) as c FROM mcqs").get() as { c: number }).c;
  if (current === parsed.length && storedHash === contentHash) {
    // Content hash matches and rows are present — in sync. Cheap early-out.
    return;
  }

  const insert = sqlite.prepare(`
    INSERT OR REPLACE INTO mcqs
      (id, code, display_code, topic_file, topic_name, topic_slug, domain,
       section, papers, stem, options, answer, reason, urls, parent_code,
       figure)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const linkInsert = sqlite.prepare(
    "INSERT OR IGNORE INTO mcq_lo_links (mcq_id, lo_code) VALUES (?, ?)",
  );

  const tx = sqlite.transaction(() => {
    sqlite.exec("DELETE FROM mcqs; DELETE FROM mcq_lo_links;");
    for (const rec of parsed) {
      const slug = rec.topicFile.replace(/^MCQ-/, "").replace(/\.txt$/, "").toLowerCase();
      const topicDomain = TOPIC_DOMAIN[slug] ?? "resp";
      const domain = mcqDomain(topicDomain);
      insert.run(
        rec.id,
        rec.code,
        rec.displayCode,
        rec.topicFile,
        rec.topicName,
        slug,
        domain,
        rec.section || null,
        JSON.stringify(rec.papers ?? []),
        rec.stem,
        JSON.stringify(rec.options ?? {}),
        rec.answer,
        rec.reason ?? "",
        JSON.stringify(rec.urls ?? []),
        rec.parentCode,
        rec.figure ?? null,
      );
      const optJoined = Object.values(rec.options ?? {}).join(" ");
      const loCodes = findMatchingLOs(rec.stem, optJoined, rec.section, topicDomain);
      for (const lo of loCodes) {
        linkInsert.run(rec.id, lo);
      }
    }
    sqlite.prepare("INSERT OR REPLACE INTO mcq_meta (key, value) VALUES ('content_hash', ?)").run(contentHash);
  });
  tx();
  const linked = (sqlite.prepare("SELECT COUNT(*) as c FROM mcq_lo_links").get() as { c: number }).c;
  console.log(`[mcqs] ingested ${parsed.length} MCQs, ${linked} LO links`);
}

// -------------------------------------------------------------------------------------------------
// Query helpers
// -------------------------------------------------------------------------------------------------

interface Row {
  id: string;
  code: string;
  display_code: string;
  topic_file: string;
  topic_name: string;
  topic_slug: string;
  domain: string;
  section: string | null;
  papers: string;
  stem: string;
  options: string;
  answer: string | null;
  reason: string;
  urls: string;
  parent_code: string | null;
  figure: string | null;
}

interface OverrideRow {
  mcq_id: string;
  stem: string | null;
  options: string | null;
  answer: string | null;
  reason: string | null;
  excluded: number | null;
}

function getOverrideMap(ids: string[]): Map<string, OverrideRow> {
  const out = new Map<string, OverrideRow>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const rows = sqlite.prepare(
    `SELECT mcq_id, stem, options, answer, reason, excluded
     FROM mcq_overrides WHERE mcq_id IN (${placeholders})`,
  ).all(...ids) as OverrideRow[];
  for (const r of rows) out.set(r.mcq_id, r);
  return out;
}

function rowToRecord(row: Row, loCodes: string[], ovr?: OverrideRow): McqRecord {
  let stem = row.stem;
  let options = safeParseOptions(row.options);
  let answer: string | null = row.answer;
  let reason = row.reason;
  let edited = false;
  let excluded = false;

  if (ovr) {
    if (ovr.stem !== null) { stem = ovr.stem; edited = true; }
    if (ovr.options !== null) { options = safeParseOptions(ovr.options); edited = true; }
    if (ovr.answer !== null) {
      // empty string means "user cleared the answer"
      answer = ovr.answer === "" ? null : ovr.answer;
      edited = true;
    }
    if (ovr.reason !== null) { reason = ovr.reason; edited = true; }
    if (ovr.excluded !== null) excluded = !!ovr.excluded;
  }

  return {
    id: row.id,
    code: row.code,
    displayCode: row.display_code,
    topicFile: row.topic_file,
    topicName: row.topic_name,
    topicSlug: row.topic_slug,
    domain: row.domain,
    section: row.section,
    papers: safeParseArray(row.papers),
    stem,
    options,
    answer,
    reason,
    urls: safeParseArray(row.urls),
    parentCode: row.parent_code,
    // Corpus-supplied; deliberately outside the override layer so a user's
    // stem/answer edit never detaches the figure the stem refers to.
    figure: row.figure ?? null,
    loCodes,
    edited,
    excluded,
  };
}

function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function safeParseOptions(s: string): McqRecord["options"] {
  try {
    const v = JSON.parse(s);
    const out = { A: "", B: "", C: "", D: "", E: "" };
    for (const k of ["A", "B", "C", "D", "E"] as const) {
      if (v && typeof v[k] === "string") out[k] = v[k];
    }
    return out;
  } catch {
    return { A: "", B: "", C: "", D: "", E: "" };
  }
}

function getLoCodesFor(mcqIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (mcqIds.length === 0) return out;
  const placeholders = mcqIds.map(() => "?").join(",");
  const rows = sqlite.prepare(
    `SELECT mcq_id, lo_code FROM mcq_lo_links WHERE mcq_id IN (${placeholders})`,
  ).all(...mcqIds) as Array<{ mcq_id: string; lo_code: string }>;
  for (const r of rows) {
    const list = out.get(r.mcq_id) ?? [];
    list.push(r.lo_code);
    out.set(r.mcq_id, list);
  }
  return out;
}

export interface McqQuery {
  topic?: string;      // topic_slug
  domain?: string;
  paper?: string;      // matches any paper in the papers[] JSON
  q?: string;          // free-text search over stem
  completed?: boolean; // true = has ≥1 attempt, false = has none
  // "unmastered" = the review pool: questions never answered CORRECTLY, i.e.
  // never attempted OR attempted but every attempt was wrong. A question the
  // user got right (even after earlier misses) is considered mastered and is
  // excluded. Combines with completed via AND.
  unmastered?: boolean;
  limit?: number;
  offset?: number;
}

export function listMcqs(query: McqQuery = {}): { total: number; items: McqRecord[] } {
  // The table is aliased `m` throughout so this query can interpolate the
  // shared predicates, which are all written against that alias (the study
  // pools, the SRS counts and getMcqStats already spell it that way). SQLite
  // hides the real table name once an alias is given, so every correlated
  // subquery below says `m.id`, not `mcqs.id`; the alias is the only reason
  // any of those lines changed.
  //
  // Discarded questions leave EVERY read of the bank together: the stats
  // (getMcqStats), the study pools (NOT_DISCARDED_SQL) — and this list. The
  // list used to keep them, so the header said "1706 total" over a pager
  // reading "of 1707" and the discarded row rendered with no badge. Revert to
  // original on the MCQs page is the way back.
  const where: string[] = [
    "COALESCE((SELECT o.excluded FROM mcq_overrides o WHERE o.mcq_id = m.id), 0) = 0",
  ];
  const params: unknown[] = [];
  if (query.topic) {
    where.push("topic_slug = ?");
    params.push(query.topic);
  }
  if (query.domain) {
    where.push("domain = ?");
    params.push(query.domain);
  }
  if (query.paper) {
    // Match paper JSON as substring — cheap and effective for short tags.
    where.push("papers LIKE ?");
    params.push(`%${JSON.stringify(query.paper).slice(1, -1)}%`);
  }
  if (query.q) {
    // Search the EFFECTIVE text — a repaired stem/reason lives in the
    // override and IS what the row displays (rowToRecord's plain null-
    // fallback for these two columns). Searching the base made a repaired
    // question unfindable by its new wording while still matching text it no
    // longer contains.
    where.push(`(
      LOWER(COALESCE((SELECT o.stem FROM mcq_overrides o WHERE o.mcq_id = m.id), m.stem)) LIKE ?
      OR LOWER(COALESCE((SELECT o.reason FROM mcq_overrides o WHERE o.mcq_id = m.id), m.reason)) LIKE ?
    )`);
    const like = `%${query.q.toLowerCase()}%`;
    params.push(like, like);
  }
  if (typeof query.completed === "boolean") {
    // "Completed" = has at least one submitted answer. Skipped attempts
    // (selected IS NULL) do not mark a question complete.
    where.push(
      query.completed
        ? "EXISTS (SELECT 1 FROM mcq_attempts a WHERE a.mcq_id = m.id AND a.selected IS NOT NULL)"
        : "NOT EXISTS (SELECT 1 FROM mcq_attempts a WHERE a.mcq_id = m.id AND a.selected IS NOT NULL)",
    );
  }
  if (query.unmastered) {
    // Review pool: no correct answer on record → unseen OR previously incorrect.
    where.push(
      "NOT EXISTS (SELECT 1 FROM mcq_attempts a WHERE a.mcq_id = m.id AND a.correct = 1)",
    );
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // Both statements take `params` in the order the clauses were pushed above,
  // and the count runs the identical WHERE — the pager's "of N" and the page
  // itself must never be two different questions. The page appends its own two
  // bindings AFTER the shared ones.
  const total = (sqlite.prepare(
    `SELECT COUNT(*) as c FROM mcqs m ${clause}`,
  ).get(...params) as { c: number }).c;

  const limit = Math.min(query.limit ?? 50, 200);
  const offset = query.offset ?? 0;
  const rows = sqlite.prepare(
    `SELECT m.* FROM mcqs m ${clause}
     ORDER BY m.topic_slug, CAST(SUBSTR(m.code, 3) AS INTEGER), m.code
     LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as Row[];

  const ids = rows.map((r) => r.id);
  const loMap = getLoCodesFor(ids);
  const ovrMap = getOverrideMap(ids);
  return {
    total,
    items: rows.map((r) => rowToRecord(r, loMap.get(r.id) ?? [], ovrMap.get(r.id))),
  };
}

/** Hydrate the WHOLE corpus in three statements — for callers that touch most
 *  of it anyway. A per-row getMcq() costs ~3 statements × ~1,853 rows, ~300 ms
 *  of synchronous SQLite. Scans the two side tables unfiltered (mcq_lo_links
 *  ~1,700 rows, mcq_overrides usually near-empty): cheaper and safer than an
 *  IN(...) with a corpus-sized parameter list. Same hydration as getMcq — lo
 *  codes sorted, override layer applied. */
export function getMcqMap(): Map<string, McqRecord> {
  const rows = sqlite.prepare("SELECT * FROM mcqs").all() as Row[];
  const loMap = new Map<string, string[]>();
  for (const r of sqlite.prepare("SELECT mcq_id, lo_code FROM mcq_lo_links ORDER BY lo_code").all() as Array<{ mcq_id: string; lo_code: string }>) {
    const list = loMap.get(r.mcq_id);
    if (list) list.push(r.lo_code); else loMap.set(r.mcq_id, [r.lo_code]);
  }
  const ovrMap = new Map<string, OverrideRow>();
  for (const r of sqlite.prepare(
    "SELECT mcq_id, stem, options, answer, reason, excluded FROM mcq_overrides",
  ).all() as OverrideRow[]) ovrMap.set(r.mcq_id, r);
  const out = new Map<string, McqRecord>();
  for (const row of rows) out.set(row.id, rowToRecord(row, loMap.get(row.id) ?? [], ovrMap.get(row.id)));
  return out;
}

export function getMcq(id: string): McqRecord | null {
  const row = sqlite.prepare("SELECT * FROM mcqs WHERE id = ?").get(id) as Row | undefined;
  if (!row) return null;
  const los = sqlite.prepare(
    "SELECT lo_code FROM mcq_lo_links WHERE mcq_id = ? ORDER BY lo_code",
  ).all(id) as Array<{ lo_code: string }>;
  const ovr = sqlite.prepare(
    "SELECT mcq_id, stem, options, answer, reason, excluded FROM mcq_overrides WHERE mcq_id = ?",
  ).get(id) as OverrideRow | undefined;
  return rowToRecord(row, los.map((l) => l.lo_code), ovr);
}

export function getMcqsByLo(loCode: string): McqRecord[] {
  const rows = sqlite.prepare(
    `SELECT m.* FROM mcqs m
     JOIN mcq_lo_links l ON l.mcq_id = m.id
     WHERE l.lo_code = ?
       AND NOT EXISTS (SELECT 1 FROM mcq_overrides o WHERE o.mcq_id = m.id AND o.excluded = 1)
     ORDER BY m.topic_slug, CAST(SUBSTR(m.code, 3) AS INTEGER), m.code`,
  ).all(loCode) as Row[];
  const ids = rows.map((r) => r.id);
  const loMap = getLoCodesFor(ids);
  const ovrMap = getOverrideMap(ids);
  return rows.map((r) => rowToRecord(r, loMap.get(r.id) ?? [], ovrMap.get(r.id)));
}

/**
 * Re-derive `mcq_attempts.correct` for one question after its keyed answer
 * changed.
 *
 * Correctness is a DERIVED fact (selected === key) that this table stores
 * denormalised at attempt time. That was harmless while keys never moved —
 * but hand edits exist precisely to change wrong keys, and
 * every applied key change silently invalidated the stored verdict of every
 * earlier attempt. Two consequences, both silent:
 *   - an attempt recorded CORRECT under the old key keeps `correct = 1`, and
 *     the study pool's "any correct attempt retires this question" rule
 *     (mcqStudy.ts) then hides a question the user actually got wrong — it
 *     never comes back;
 *   - an attempt recorded WRONG under the old key keeps `correct = 0` and
 *     drags the weak-area / accuracy stats that rank what to study next.
 *
 * Only rows with a recorded `selected` can be re-derived. A key CLEARED to
 * null is deliberately left alone: "no key" makes correctness undefined, not
 * false, and marking every past attempt wrong would be its own falsehood.
 */
// UPPER() on both sides, here and in reconcileAttemptCorrectness below: SQLite
// `=` on TEXT is case-sensitive, while the grader that WROTE these rows
// (mcqStudy.submitAttempt) compares with toUpperCase(). One lowercase key would
// therefore make these two disagree — every attempt graded correct at answer
// time silently flipped to wrong on the next boot, and the reconcile's output
// feeds seedSrsFromAttempts' relearn-now branch. Nothing can currently store a
// lowercase key (mcqEditSchema is an uppercase enum) so this is belt and
// braces — but it costs nothing and the failure it prevents is silent and
// destructive.
function regradeAttempts(mcqId: string, newAnswer: string | null): number {
  if (!newAnswer) return 0;
  return sqlite.prepare(
    `UPDATE mcq_attempts
        SET correct = CASE WHEN UPPER(selected) = UPPER(?) THEN 1 ELSE 0 END
      WHERE mcq_id = ?
        AND selected IS NOT NULL
        AND correct <> CASE WHEN UPPER(selected) = UPPER(?) THEN 1 ELSE 0 END`,
  ).run(newAnswer, mcqId, newAnswer).changes;
}

/**
 * Boot reconcile: re-derive every attempt whose stored correctness disagrees
 * with its question's CURRENT key. regradeAttempts() keeps new key changes
 * honest from here on, but rows mis-graded by key changes applied BEFORE it
 * existed are already on disk — and each one either hides a question the user
 * got wrong or penalises one they got right. Cheap (one indexed pass),
 * idempotent, and silent when there is nothing to fix.
 */
export function reconcileAttemptCorrectness(): number {
  const fixed = sqlite.prepare(
    `UPDATE mcq_attempts
        SET correct = CASE WHEN UPPER(selected) = UPPER((
              SELECT COALESCE(NULLIF(o.answer, ''), m.answer)
                FROM mcqs m LEFT JOIN mcq_overrides o ON o.mcq_id = m.id
               WHERE m.id = mcq_attempts.mcq_id
            )) THEN 1 ELSE 0 END
      WHERE selected IS NOT NULL
        AND (SELECT COALESCE(NULLIF(o.answer, ''), m.answer)
               FROM mcqs m LEFT JOIN mcq_overrides o ON o.mcq_id = m.id
              WHERE m.id = mcq_attempts.mcq_id) IS NOT NULL
        AND correct <> CASE WHEN UPPER(selected) = UPPER((
              SELECT COALESCE(NULLIF(o.answer, ''), m.answer)
                FROM mcqs m LEFT JOIN mcq_overrides o ON o.mcq_id = m.id
               WHERE m.id = mcq_attempts.mcq_id
            )) THEN 1 ELSE 0 END`,
  ).run().changes;
  return fixed;
}

/**
 * Reset a question's SRS schedule after its keyed answer changed.
 *
 * Everything the user experienced on this question before the fix was against
 * the OLD key: the correct/incorrect feedback shown on reveal was wrong, and
 * their Again/Hard/Good/Easy self-ratings responded to that wrong feedback.
 * The interval, reps and ease built from those ratings therefore schedule a
 * MEMORY OF THE WRONG FACT — worst case a question "passed" under a wrong key
 * sits months out while the user retains the very answer the fix corrected.
 * Companion to regradeAttempts(): that repairs the attempt LOG, this repairs
 * the SCHEDULE. Scheduling fields reset (due now, relearn from scratch);
 * stability = 0 is the FSRS "uninitialised" sentinel, so the next rating
 * re-derives S and D from scratch instead of growing a poisoned memory.
 * `lapses` is kept — it is a lifetime counter, not scheduling state. A no-op
 * for questions SRS never tracked (UPDATE matches nothing).
 */
function resetSrsOnKeyChange(mcqId: string): number {
  return sqlite.prepare(
    `UPDATE mcq_srs_state
        SET ease_factor = 2.5, interval_days = 0, reps = 0, due_at = ?,
            stability = 0, difficulty = 0
      WHERE mcq_id = ?`,
  ).run(Date.now(), mcqId).changes;
}

// -------------------------------------------------------------------------------------------------
// User edits
// -------------------------------------------------------------------------------------------------

export interface McqEditInput {
  stem?: string;
  options?: { A: string; B: string; C: string; D: string; E: string };
  answer?: string | null;   // 'A'..'E', empty string, or null
  reason?: string;
  excluded?: boolean | null; // true = hide from study pools; null = clear the flag
}

/** Upsert the override row for one MCQ. Only fields present in `edit` are
 *  changed — pass an object with only the fields you want to update. Returns
 *  the merged McqRecord (or null if the base MCQ id doesn't exist).
 */
export function updateMcqOverride(id: string, edit: McqEditInput): McqRecord | null {
  const base = sqlite.prepare("SELECT id FROM mcqs WHERE id = ?").get(id) as { id: string } | undefined;
  if (!base) return null;

  const beforeAnswer = getMcq(id)?.answer ?? null;

  const existing = sqlite.prepare(
    "SELECT stem, options, answer, reason, excluded FROM mcq_overrides WHERE mcq_id = ?",
  ).get(id) as {
    stem: string | null;
    options: string | null;
    answer: string | null;
    reason: string | null;
    excluded: number | null;
  } | undefined;

  const next = {
    stem: existing?.stem ?? null,
    options: existing?.options ?? null,
    answer: existing?.answer ?? null,
    reason: existing?.reason ?? null,
    excluded: existing?.excluded ?? null,
  };
  if (edit.stem !== undefined) next.stem = edit.stem;
  if (edit.options !== undefined) next.options = JSON.stringify(edit.options);
  if (edit.answer !== undefined) next.answer = edit.answer === null ? "" : edit.answer;
  if (edit.reason !== undefined) next.reason = edit.reason;
  if (edit.excluded !== undefined) next.excluded = edit.excluded === null ? null : edit.excluded ? 1 : 0;

  sqlite.prepare(`
    INSERT INTO mcq_overrides (mcq_id, stem, options, answer, reason, excluded, updated_at)
    VALUES (@id, @stem, @options, @answer, @reason, @excl, @now)
    ON CONFLICT(mcq_id) DO UPDATE SET
      stem = @stem,
      options = @options,
      answer = @answer,
      reason = @reason,
      excluded = @excl,
      updated_at = @now
  `).run({ id, stem: next.stem, options: next.options, answer: next.answer, reason: next.reason, excl: next.excluded, now: Date.now() });

  const after = getMcq(id);
  // The keyed answer moved (a hand edit) — every earlier
  // attempt's stored correctness now describes the OLD key, and any SRS
  // schedule was built from feedback given against it.
  if (after && (after.answer ?? null) !== beforeAnswer) {
    regradeAttempts(id, after.answer ?? null);
    resetSrsOnKeyChange(id);
  }
  return after;
}

/** Revert to the original by deleting the override row. Returns the base record. */
export function revertMcqOverride(id: string): McqRecord | null {
  const beforeAnswer = getMcq(id)?.answer ?? null;
  sqlite.prepare("DELETE FROM mcq_overrides WHERE mcq_id = ?").run(id);
  const after = getMcq(id);
  // Reverting restores the base key, which is just as much a key change as
  // applying one — re-derive and re-schedule the same way.
  if (after && (after.answer ?? null) !== beforeAnswer) {
    regradeAttempts(id, after.answer ?? null);
    resetSrsOnKeyChange(id);
  }
  return after;
}

export interface McqStats {
  total: number;
  withAnswer: number;
  byTopic: Array<{ slug: string; name: string; domain: string; count: number; linked: number }>;
  // Distinct past-paper tags with their question counts, newest tag first.
  // Powers the "sit a real paper" picker on the Study page.
  papers: Array<{ tag: string; count: number; sittable: number }>;
}

export function getMcqStats(): McqStats {
  // Every count here respects the override layer, so the header numbers and
  // the Study page's topic chips describe the SITTABLE corpus: discarded
  // questions are out, and an answer added (or cleared) via fix-override
  // moves withAnswer accordingly.
  const notDiscarded = "COALESCE((SELECT o.excluded FROM mcq_overrides o WHERE o.mcq_id = m.id), 0) = 0";
  const total = (sqlite.prepare(`SELECT COUNT(*) as c FROM mcqs m WHERE ${notDiscarded}`).get() as { c: number }).c;
  const withAnswer = (sqlite.prepare(
    `SELECT COUNT(*) as c FROM mcqs m
      WHERE ${notDiscarded}
        AND CASE WHEN (SELECT o.answer FROM mcq_overrides o WHERE o.mcq_id = m.id) IS NOT NULL
                 THEN NULLIF((SELECT o.answer FROM mcq_overrides o WHERE o.mcq_id = m.id), '')
                 ELSE m.answer END IS NOT NULL`,
  ).get() as { c: number }).c;
  const byTopic = sqlite.prepare(`
    SELECT topic_slug as slug, topic_name as name, domain, COUNT(*) as count,
           (SELECT COUNT(DISTINCT mcq_id) FROM mcq_lo_links l
            WHERE l.mcq_id IN (SELECT id FROM mcqs m2 WHERE m2.topic_slug = m.topic_slug)) as linked
    FROM mcqs m
    WHERE ${notDiscarded}
    GROUP BY topic_slug, topic_name, domain
    ORDER BY topic_name
  `).all() as Array<{ slug: string; name: string; domain: string; count: number; linked: number }>;
  // Only canonical MonYY tags (Mar99, Jul04, …) are real sittings — the
  // corpus's papers arrays also carry parse fragments ("d", "qr", "mnop")
  // and stray long-form spellings ("July 2000") with 1-5 questions each.
  // 33 canonical tags cover 1,322 of the 1,707 questions.
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const canonical = /^[A-Z][a-z]{2}\d{2}$/;
  const paperSortKey = (tag: string): number => {
    const mon = MONTHS.indexOf(tag.slice(0, 3));
    const yy = Number(tag.slice(3));
    const year = yy >= 90 ? 1900 + yy : 2000 + yy;
    return year * 100 + (mon >= 0 ? mon : 0);
  };
  // Per paper: the corpus count AND what a session can actually serve — the
  // pool predicate (effective answer, not discarded) trims most papers, and
  // "Sit a real paper" must promise the SITTABLE size, not the corpus size
  // (a paper with 103 questions serves fewer when some carry no key).
  const paperCounts = new Map<string, number>();
  const paperSittable = new Map<string, number>();
  const paperRows = sqlite.prepare(`
    SELECT papers,
           (CASE WHEN (SELECT o.answer FROM mcq_overrides o WHERE o.mcq_id = m.id) IS NOT NULL
                 THEN NULLIF((SELECT o.answer FROM mcq_overrides o WHERE o.mcq_id = m.id), '')
                 ELSE m.answer END IS NOT NULL) AS hasAnswer
      FROM mcqs m WHERE ${notDiscarded}`).all() as Array<{ papers: string; hasAnswer: number }>;
  for (const r of paperRows) {
    for (const tag of safeParseArray(r.papers)) {
      if (!canonical.test(tag) || MONTHS.indexOf(tag.slice(0, 3)) < 0) continue;
      paperCounts.set(tag, (paperCounts.get(tag) ?? 0) + 1);
      if (r.hasAnswer) paperSittable.set(tag, (paperSittable.get(tag) ?? 0) + 1);
    }
  }
  const papers = Array.from(paperCounts.entries())
    .map(([tag, count]) => ({ tag, count, sittable: paperSittable.get(tag) ?? 0 }))
    .sort((a, b) => paperSortKey(b.tag) - paperSortKey(a.tag));
  return { total, withAnswer, byTopic, papers };
}
