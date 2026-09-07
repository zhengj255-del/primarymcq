import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// "NO AI" and "shares NOTHING", enforced by reading the tree.
//
// mcq-site is a complete, separate application: its own database, its own
// password, its own build. Two things follow, and both are cheap to lose in a
// port that copies files from the tracker one at a time:
//
//   1. Nothing under it may mention the machinery it was cut away from — the
//      model client and its key, the generated-question layer, the adjudication
//      sweep, the per-machine credential, the mock bridge, the viva corpus.
//      A stray identifier in a comment is how a "removed" feature gets pasted
//      back in by the next person grepping for it.
//   2. Nothing under it may import from outside it. A relative path that
//      climbs out of mcq-site/ is a runtime dependency on the tracker's tree,
//      and the Dockerfile builds mcq-site/ alone.
//
// The pattern list is case-insensitive on purpose: the tokens are identifiers
// and env names, and a casing variant is the same leak.
// ---------------------------------------------------------------------------

const MCQ_SITE = path.resolve(import.meta.dirname, "../..");
const THIS_FILE = path.resolve(import.meta.dirname, "noAi.test.ts");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".vite"]);

const FORBIDDEN =
  /openai|OPENAI_API_KEY|hasApiKey|\bllm\b|gpt|triage-suggest|adjudicat|mcq_variants|mcqVariants|variantId|mcqAudit|mcq_audit|textbook|device_token|deviceToken|ankiaddon|\/api\/anki|syncAutoMock|mock_attempts|vivaCorpus|renton/i;

// The question bank is data, not code: its prose is whatever the Black Bank
// says, so it is not scanned for identifiers (it is still walked by the
// relative-path scan below, which only reads code files).
const CORPUS_DIR = "server/data";

// Root-level files that are not under any of the source roots but still ship
// with the app: build and styling config, the deploy recipe, the docs.
const ROOT_FILES = [
  "tailwind.config.ts", "vite.config.ts", "vitest.config.ts", "postcss.config.js", "tsconfig.json",
  "package.json", "README.md", "fly.toml", "Dockerfile", ".dockerignore", ".env.example",
  "client/index.html", "script/build.ts",
];

/** Every regular file under `dir`, recursively, skipping build and dependency trees. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const rel = (f: string) => path.relative(MCQ_SITE, f);

describe("no AI, no tracker-only machinery, anywhere under mcq-site", () => {
  it("server/, shared/, client/src and the root config files carry none of the removed identifiers", () => {
    const roots = ["server", "shared", "client/src"].map((d) => path.join(MCQ_SITE, d));
    for (const r of roots) expect(fs.existsSync(r), `${rel(r)} exists`).toBe(true);
    const rootFiles = ROOT_FILES.map((f) => path.join(MCQ_SITE, f));
    for (const f of rootFiles) expect(fs.existsSync(f), `${rel(f)} exists`).toBe(true);
    const corpus = path.join(MCQ_SITE, CORPUS_DIR);
    const files = [...roots.flatMap((r) => walk(r)), ...rootFiles]
      .filter((f) => f !== THIS_FILE && !f.startsWith(corpus + path.sep));
    expect(files.length).toBeGreaterThan(20);

    const hits: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (FORBIDDEN.test(line)) hits.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("package.json lists no model client, no ORM and no websocket library", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(MCQ_SITE, "package.json"), "utf8"));
    const names = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.optionalDependencies ?? {}) });
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => /openai|anthropic|drizzle|ws$/.test(n))).toEqual([]);
    // And the site is its own package, not the tracker's.
    expect(pkg.name).toBe("mcq-site");
  });
});

describe("mcq-site imports nothing from outside mcq-site", () => {
  /** True when `p` is MCQ_SITE itself or lies beneath it. */
  const inside = (p: string): boolean => {
    const r = path.relative(MCQ_SITE, p);
    return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  };

  it("no relative path in any source file resolves above the directory", () => {
    const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html"]);
    const files = walk(MCQ_SITE).filter((f) => CODE.has(path.extname(f)));
    expect(files.length).toBeGreaterThan(20);

    // Every quoted string that starts with ./ or ../ — import specifiers,
    // require()s, dynamic imports, CSS @imports and path.resolve arguments
    // alike. Over-inclusive on purpose: a file READ from the tracker's tree is
    // the same dependency as a module imported from it.
    const REL = /["'](\.\.?\/[^"'\n]*)["']/g;
    const escapes: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(REL)) {
        const target = path.resolve(path.dirname(f), m[1]);
        if (!inside(target)) escapes.push(`${rel(f)} -> ${m[1]}`);
      }
    }
    expect(escapes).toEqual([]);
  });

  it("the path aliases point inside too", () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(MCQ_SITE, "tsconfig.json"), "utf8"));
    const paths: Record<string, string[]> = tsconfig.compilerOptions?.paths ?? {};
    expect(Object.keys(paths)).toEqual(expect.arrayContaining(["@/*", "@shared/*"]));
    for (const [alias, targets] of Object.entries(paths)) {
      for (const t of targets) {
        expect(inside(path.resolve(MCQ_SITE, t.replace(/\*$/, ""))), `${alias} -> ${t}`).toBe(true);
      }
    }
    for (const cfg of ["vite.config.ts", "vitest.config.ts"]) {
      const src = fs.readFileSync(path.join(MCQ_SITE, cfg), "utf8");
      // The aliases are built from import.meta.dirname — this directory — and
      // never from a parent of it.
      expect(src, cfg).not.toMatch(/import\.meta\.dirname,\s*["']\.\./);
      expect(src, cfg).not.toMatch(/__dirname,\s*["']\.\./);
    }
  });

  it("the server entry does not wire in anything this site does not own", () => {
    const idx = fs.readFileSync(path.join(MCQ_SITE, "server/index.ts"), "utf8");
    for (const gone of ["deckPathMigration", "loAutoEmbed", "server/ai", "./ai/"]) {
      expect(idx, gone).not.toContain(gone);
    }
    // Every local import of index.ts is a file under mcq-site/server.
    for (const m of idx.matchAll(/from\s+["'](\.\/[^"']+)["']/g)) {
      const candidate = path.resolve(MCQ_SITE, "server", m[1]);
      expect(
        fs.existsSync(`${candidate}.ts`) || fs.existsSync(path.join(candidate, "index.ts")),
        `index.ts imports ${m[1]}`,
      ).toBe(true);
    }
  });
});
