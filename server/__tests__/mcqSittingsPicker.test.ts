import "./testDb";
import { describe, it, expect, beforeAll } from "vitest";
import { sqlite } from "../storage";
import { getMcqStats } from "../mcqs";
import { startSession } from "../mcqStudy";
import { parseSittings, sittingsColumn, sittingKey } from "@shared/mcqSittings";

// ---------------------------------------------------------------------------
// "SIT A REAL PAPER" — one definition of which sitting a question is from.
//
// The corpus records a sitting in TWO places: the question CODE for the
// 2014-2026 papers ("26B-14" -> 2026.2), and MonYY paper TAGS for the
// 1996-2015 Black Bank ("Feb12" -> 2012.1). shared/mcqSittings.ts reads both,
// and SittingTag has always badged the MCQs list correctly from it.
//
// getMcqStats hand-rolled a narrower rule beside it — MonYY tags only — and
// that is what fed the picker. So the dropdown listed 33 papers ending at 2015
// while 1,729 of 2,366 questions carried no MonYY tag at all: every sitting
// from 2014 on, 1,363 questions including the 2025 and 2026 recalls, was
// unsittable, even as the badge on the same question read "2026.2". The
// session filter had the matching half of the bug — `papers LIKE '%Feb12%'`
// over the raw tag array can only ever match a tag.
//
// Both now read mcqs.sittings, the space-padded column parseSittings fills at
// ingest. These tests pin the whole path: ingest -> counts -> what a sitting
// actually serves.
// ---------------------------------------------------------------------------

const labels = () => getMcqStats().sittings.map((s) => s.label);
const keys = () => getMcqStats().sittings.map((s) => s.key);

describe("the sittings the picker offers", () => {
  it("covers the modern papers, which carry their sitting in the code and no tag at all", () => {
    const l = labels();
    // The four recalled sittings the MonYY rule could not see.
    for (const want of ["2026.2", "2026.1", "2025.2", "2025.1"]) {
      expect(l, `${want} missing from the picker`).toContain(want);
    }
    // …and the coded papers before them, plus the officially released 2018
    // paper, whose sitting is unknown so it is labelled by year alone.
    for (const want of ["2018.2", "2018.1", "2018", "2016.1", "2014.2"]) {
      expect(l, `${want} missing from the picker`).toContain(want);
    }
    // The Black Bank's MonYY papers are still there — this replaced the rule,
    // it did not narrow it.
    expect(l).toContain("2012.1");
    expect(l).toContain("1996.1");
  });

  it("is strictly most-recent-first, second sitting before first", () => {
    // Deliberately NOT compareSittings' order, which runs ascending within a
    // year for SittingTag's benefit. A picker's ordering promise is "newest
    // paper at the top".
    const l = labels();
    const rank = (label: string) => {
      const [y, half] = label.split(".");
      return Number(y) * 10 + (half ? Number(half) : 0); // 2026.2 > 2026.1 > 2026
    };
    for (let i = 1; i < l.length; i++) {
      expect(rank(l[i - 1]), `${l[i - 1]} should sort above ${l[i]}`).toBeGreaterThan(rank(l[i]));
    }
    expect(l[0]).toBe("2026.2");
  });

  it("counts every question in the sitting, and says how many are actually sittable", () => {
    const stats = getMcqStats();
    const s2026B = stats.sittings.find((s) => s.key === "2026B")!;
    expect(s2026B).toBeTruthy();
    // Counted straight off the corpus by the shared parser, so the picker's
    // number and the pool's number cannot be two different questions.
    const direct = (sqlite.prepare(
      "SELECT COUNT(*) c FROM mcqs WHERE instr(sittings, ' 2026B ') > 0",
    ).get() as { c: number }).c;
    expect(s2026B.count).toBe(direct);
    expect(s2026B.sittable).toBeLessThanOrEqual(s2026B.count);
  });

  it("a question repeated across papers counts in every sitting it belongs to", () => {
    const multi = (sqlite.prepare(
      "SELECT id, sittings FROM mcqs WHERE sittings LIKE '% % % %' LIMIT 1",
    ).get() as { id: string; sittings: string } | undefined);
    expect(multi, "corpus sanity: a question known from more than one sitting").toBeTruthy();
    const mine = multi!.sittings.trim().split(/\s+/);
    expect(mine.length).toBeGreaterThan(1);
    const listed = keys();
    for (const k of mine) expect(listed).toContain(k);
  });

  it("caches the same answer the shared parser gives — the column is not a second opinion", () => {
    const rows = sqlite.prepare(
      "SELECT code, papers, sittings FROM mcqs ORDER BY id LIMIT 400",
    ).all() as Array<{ code: string; papers: string; sittings: string }>;
    expect(rows.length).toBe(400);
    for (const r of rows) {
      const expected = sittingsColumn(parseSittings(r.code, JSON.parse(r.papers)));
      expect(r.sittings, `${r.code} cached the wrong sittings`).toBe(expected);
    }
  });
});

describe("sitting a paper actually serves that paper", () => {
  let sittable2026B = 0;
  beforeAll(() => {
    sittable2026B = getMcqStats().sittings.find((s) => s.key === "2026B")!.sittable;
  });

  it("serves the 2026.2 paper — which the tag-matching filter selected nothing for", () => {
    // The old filter was `m.papers LIKE '%2026B%'`; 2026.2 questions carry no
    // paper tag at all, so it matched nothing and the sitting was empty.
    const sat = startSession({ mode: "tutor", sittings: ["2026B"], count: 200 } as any);
    expect(sat.mcqs.length).toBe(Math.min(200, sittable2026B));
    expect(sat.mcqs.length).toBeGreaterThan(100);
    // Every question served really is from that sitting.
    for (const m of sat.mcqs) {
      expect(parseSittings(m.code, m.papers).map(sittingKey), `${m.code} is not a 2026.2 question`)
        .toContain("2026B");
    }
  });

  it("still serves a MonYY-tagged Black Bank paper", () => {
    const s = getMcqStats().sittings.find((x) => x.key === "2012A")!;
    const sat = startSession({ mode: "tutor", sittings: ["2012A"], count: 200 } as any);
    expect(sat.mcqs.length).toBe(Math.min(200, s.sittable));
    for (const m of sat.mcqs) {
      expect(parseSittings(m.code, m.papers).map(sittingKey)).toContain("2012A");
    }
  });

  it("never confuses one sitting for another, or matches across two keys", () => {
    // The column is space-padded and the needle carries its own spaces, so
    // " 2025A " cannot match inside " 2025B 2018A " or vice versa.
    const a = startSession({ mode: "tutor", sittings: ["2025A"], count: 200 } as any).mcqs.map((m) => m.id);
    const b = startSession({ mode: "tutor", sittings: ["2025B"], count: 200 } as any).mcqs.map((m) => m.id);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    const bSet = new Set(b);
    // 2025.1 and 2025.2 are distinct papers; nothing in one draw is a question
    // known ONLY from the other.
    for (const id of a) {
      if (!bSet.has(id)) continue;
      const row = sqlite.prepare("SELECT sittings FROM mcqs WHERE id = ?").get(id) as { sittings: string };
      expect(row.sittings, `${id} appeared in both draws without belonging to both`).toContain(" 2025A ");
      expect(row.sittings).toContain(" 2025B ");
    }
  });

  it("serves NOTHING for a sitting key it cannot parse, rather than the whole bank", () => {
    // The failure that matters: a filter that silently degrades to "no filter"
    // hands the candidate 200 random questions labelled as the paper they asked
    // to sit, and they score themselves against it.
    for (const junk of ["nonsense", "", "20261", "Feb12"]) {
      const sat = startSession({ mode: "tutor", sittings: [junk], count: 50 } as any);
      expect(sat.mcqs.length, `"${junk}" should select nothing`).toBe(0);
    }
  });

  it("leaves an unfiltered sitting alone", () => {
    const all = startSession({ mode: "tutor", count: 50 } as any);
    expect(all.mcqs.length).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// THE PAGE'S OWN DESCRIPTION OF THE BANK.
//
// The MCQs page called itself "Kerry Brandis Black Bank — physiology past
// questions". Three claims, all false by the time anyone read them: the Black
// Bank is 1,586 of 2,366 questions, pharmacology is within 40 of physiology,
// and a third of the bank is neither. A subtitle is a claim about the data, so
// it gets held to the data like any other.
// ---------------------------------------------------------------------------
describe("what the page says the bank is", () => {
  const slugOf = (f: string) => f.replace(/^MCQ-/, "").replace(/\.txt$/, "").toLowerCase();
  const PHYSIOLOGY = new Set(["acid-base", "cardiovascular", "cellular-metabolic-endocrine",
    "fluids-electrolytes", "gastrointestinal", "haematology-immune-system", "maternal-foetal",
    "neurophysiology-pain", "renal", "respiratory", "thermoregulation"]);
  const PHARMACOLOGY = new Set(["cardiovascular-pharmacology", "general-pharmacology",
    "inhalational-anaesthetics", "intravenous-anaesthetics", "local-anaesthetics",
    "miscellaneous-pharmacology", "muscle-relaxants-reversal-agents", "opioids", "pain-management"]);

  const corpus = () => JSON.parse(
    require("node:fs").readFileSync(
      require("node:path").resolve(import.meta.dirname, "../data/mcqs.json"), "utf-8"),
  ) as Array<{ code: string; topicFile: string; section: string | null; answer: string | null; reason: string }>;

  it("is not a physiology bank, so the subtitle must not claim to be one", () => {
    const all = corpus();
    const phys = all.filter((q) => PHYSIOLOGY.has(slugOf(q.topicFile))).length;
    const pharm = all.filter((q) => PHARMACOLOGY.has(slugOf(q.topicFile))).length;
    const other = all.length - phys - pharm;
    // Pharmacology is not a rounding error beside physiology, and a tenth of the
    // bank is neither.
    expect(pharm).toBeGreaterThan(all.length * 0.4);
    expect(other).toBeGreaterThan(all.length * 0.05);
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(import.meta.dirname, "../../client/src/pages/MCQs.tsx"), "utf-8");
    const subtitle = /text-sm text-muted-foreground">([\s\S]*?)<\/p>/.exec(src)?.[1] ?? "";
    expect(subtitle, "the MCQs subtitle moved — update this guard").toBeTruthy();
    for (const word of ["physiology", "pharmacology"]) {
      expect(subtitle.toLowerCase(), `the subtitle does not mention ${word}`).toContain(word);
    }
  });

  it("is not the Black Bank alone, so the subtitle must name the rest", () => {
    const all = corpus();
    const recalls = all.filter((q) => /RECALL/.test(q.section ?? "")).length;
    const official = all.filter((q) => /^OFF-/.test(q.code)).length;
    expect(recalls).toBeGreaterThan(500);
    expect(official).toBeGreaterThan(100);
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(import.meta.dirname, "../../client/src/pages/MCQs.tsx"), "utf-8");
    const subtitle = /text-sm text-muted-foreground">([\s\S]*?)<\/p>/.exec(src)?.[1] ?? "";
    expect(subtitle.toLowerCase()).toContain("recall");
    expect(subtitle).toMatch(/2018/);
  });

  it("does not hard-code the question count, which a refresh would falsify", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(import.meta.dirname, "../../client/src/pages/MCQs.tsx"), "utf-8");
    const subtitle = /text-sm text-muted-foreground">([\s\S]*?)<\/p>/.exec(src)?.[1] ?? "";
    // The rendered sentence must take its total from the stats, not a literal.
    expect(subtitle).toContain("statsQuery.data.total");
    const rendered = subtitle.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");   // strip the explanatory comment
    // Years are fine and necessary ("the released 2018 paper", "the 2025-2026 recalls"); a COUNT is not.
    // Ban the comma-grouped form and the corpus's actual size in either spelling.
    const total = corpus().length;
    expect(rendered, "a comma-grouped literal in the subtitle goes stale on the next refresh")
      .not.toMatch(/\b\d{1,3},\d{3}\b/);
    expect(rendered, `the subtitle hard-codes the corpus size (${total})`)
      .not.toContain(String(total));
  });
});
