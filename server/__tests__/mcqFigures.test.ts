import "./testDb";
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
// storage must load before mcqs: storage.ts calls bootstrapMcqs() at module
// scope, and importing mcqs first enters that cycle before it is defined.
import "../storage";
import { listMcqs, getMcq } from "../mcqs";

// ---------------------------------------------------------------------------
// A handful of official questions were transcribed without the plate their
// stem points at ("Please see graph below"), leaving options like
// "A / B / C (no change) / D / E" completely unanswerable. These pin the
// figure plumbing AND the integrity of the assets themselves: a figure key
// with no file, or a file that is not valid XML, renders as a broken-image
// icon in the middle of an exam question — worse than the missing plate.
//
// Both halves live inside mcq-site: the SVGs under client/public/mcq-figures
// and the registry in client/src/components/McqFigure.tsx. Nothing here may
// reach outside this directory for an asset.
// ---------------------------------------------------------------------------

const FIG_DIR = path.resolve(import.meta.dirname, "../../client/public/mcq-figures");
const COMPONENT = path.resolve(import.meta.dirname, "../../client/src/components/McqFigure.tsx");

// Parse exactly as a browser does for an <img src="*.svg">: strict XML, where
// a duplicate attribute or unclosed tag yields a broken-image icon rather than
// the lenient recovery HTML parsing would give.
const domParser = new (new JSDOM().window.DOMParser)();
function svgParseError(svg: string): string | null {
  const doc = domParser.parseFromString(svg, "image/svg+xml");
  const err = doc.querySelector("parsererror");
  return err ? err.textContent!.replace(/\s+/g, " ").slice(0, 200) : null;
}

/** Figure keys declared in the component's MCQ_FIGURES registry. */
function registryKeys(): string[] {
  const src = fs.readFileSync(COMPONENT, "utf-8");
  const block = src.slice(src.indexOf("MCQ_FIGURES"), src.indexOf("export function McqFigure"));
  return [...block.matchAll(/^\s{2}"([a-z0-9-]+)":\s*\{/gm)].map((m) => m[1]);
}

// Read the corpus directly rather than through listMcqs: that API clamps
// `limit` to 200 of 1853 rows, so a paginated sweep silently checks only the
// figures that happen to land on the first page.
const CORPUS = path.resolve(import.meta.dirname, "../data/mcqs.json");
function figureKeysInUse(): Array<{ id: string; displayCode: string; figure: string }> {
  const all = JSON.parse(fs.readFileSync(CORPUS, "utf-8")) as Array<{
    id: string; displayCode: string; figure?: string | null;
  }>;
  return all.filter((m) => m.figure).map((m) => ({ id: m.id, displayCode: m.displayCode, figure: m.figure as string }));
}

describe("MCQ figures", () => {
  it("serves the figure through the API for questions whose stem needs one", () => {
    // 2018-23's options are the bare letters A–E: without the plate the
    // question cannot be answered at all.
    const q = getMcq("cardiovascular__OFF-2018-Q23");
    expect(q).toBeTruthy();
    expect(q!.stem).toMatch(/see graph below/i);
    expect(q!.figure).toBe("vascular-function-curve");
  });

  it("leaves ordinary text-only questions without a figure", () => {
    const withFigure = figureKeysInUse();
    // This is a targeted repair of the questions that name a plate, not a
    // blanket tagging exercise.
    expect(withFigure.length).toBeGreaterThanOrEqual(6);
    expect(withFigure.length).toBeLessThan(20);
    const { items } = listMcqs({ limit: 200 });
    expect(items.find((m) => m.displayCode === "FE30")?.figure).toBeNull();
  });

  it("every figure a question points at exists on disk and is valid XML", () => {
    const inUse = figureKeysInUse();
    // All six tagged questions must be swept, not just the first page of them.
    expect(inUse.length).toBeGreaterThanOrEqual(6);
    for (const { displayCode, figure } of inUse) {
      const file = path.join(FIG_DIR, `${figure}.svg`);
      expect(fs.existsSync(file), `${displayCode} -> missing ${figure}.svg`).toBe(true);
      const svg = fs.readFileSync(file, "utf-8");
      expect(svgParseError(svg), `${figure}.svg would render as a broken image`).toBeNull();
      // A viewBox is what lets the plate scale down to a phone without
      // overflowing the content column.
      expect(svg, `${figure}.svg has no viewBox`).toMatch(/viewBox="/);
    }
  });

  it("every figure in use is declared in the component registry (else it renders nothing)", () => {
    const declared = new Set(registryKeys());
    expect(declared.size).toBeGreaterThan(0);
    for (const { displayCode, figure } of figureKeysInUse()) {
      expect(declared.has(figure), `${displayCode} uses "${figure}", absent from MCQ_FIGURES`).toBe(true);
    }
  });

  it("the lettered circle plate is never attached to a question whose options are component names", () => {
    // 18A-59's options name components ("The inspiratory limb"), which do NOT
    // line up with the plate's A–E points; showing the lettered plate beside
    // them would make four of five option letters point somewhere unrelated.
    const q = getMcq("equipment-safety__18A-59");
    expect(q!.figure).toBe("circle-system-plain");
    const plain = fs.readFileSync(path.join(FIG_DIR, "circle-system-plain.svg"), "utf-8");
    // The plain plate names components but carries no A–E point badges.
    expect(plain).toMatch(/Inspiratory limb/);
    expect(plain).toMatch(/absorber/);
    const lettered = fs.readFileSync(path.join(FIG_DIR, "circle-system.svg"), "utf-8");
    expect(lettered.length).toBeGreaterThan(plain.length);
  });

  it("explains the fresh-gas precondition wherever the retrograde-flow answer is used", () => {
    // The circle answer only holds while fresh gas is flowing; shipping the
    // plate without saying so would teach an unconditional rule that is false.
    const q = getMcq("equipment-safety__OFF-2018-Q30");
    expect(q!.figure).toBe("circle-system");
    expect(q!.reason).toMatch(/zero fresh gas flow/i);
  });

  it("does not describe the phentolamine effect as a cardiac function curve", () => {
    // The shipped plate is a VASCULAR function curve; the sibling question's
    // stored explanation used to name the wrong curve entirely.
    const q = getMcq("cardiovascular__18B-54");
    expect(q!.reason).toMatch(/vascular \(venous return\) function curve/i);
    expect(q!.reason).not.toMatch(/cardiac function curve/i);
  });
});
