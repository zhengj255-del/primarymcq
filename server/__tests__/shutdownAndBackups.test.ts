import "./testDb"; // MUST be first: points DB_PATH at a throwaway file
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sqlite } from "../storage";
import { runBackupOnce, listBackups } from "../backups";
import { shutdown } from "../shutdown";

// ---------------------------------------------------------------------------
// The machinery the owner only ever uses on their worst day: the rolling
// on-disk backup, and the ordered shutdown that leaves ONE self-contained
// database file behind.
//
// The database is opened in WAL mode (server/storage.ts), so at any moment
// part of it lives in data.db-wal. A process that is simply killed leaves that
// -wal on the volume, and a raw file restore then swaps a snapshot in
// underneath a stale WAL that replays over it. sqlite.close() on the way out
// is the fix: it checkpoints the WAL into the main file and deletes -wal/-shm.
//
// The close case is LAST IN THE FILE, and must stay last: it closes the
// singleton connection every other case in this worker depends on.
// ---------------------------------------------------------------------------

const siteRoot = path.resolve(import.meta.dirname, "../..");
const readSite = (p: string) => fs.readFileSync(path.join(siteRoot, p), "utf8");
const realDbPath = process.env.DB_PATH!;

/**
 * A throwaway <dir>/data.db of `dbBytes`, with the backup directory derived
 * from it: backupDir() is <dirname(DB_PATH)>/backups, resolved at CALL time,
 * so pointing DB_PATH at a scratch directory keeps these cases out of the
 * tmpdir every other test file shares. The live connection is what gets
 * copied — sqlite.backup() reads the OPEN database, not DB_PATH — so the
 * scratch file only has to exist for the free-space arithmetic.
 *
 * `await fn(...)`, not `return fn(...)`: DB_PATH must stay pointed at the
 * scratch volume for the WHOLE body.
 */
async function withScratchVolume<T>(
  dbBytes: number,
  fn: (dir: string, backups: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcq-site-backup-vol-"));
  fs.writeFileSync(path.join(dir, "data.db"), Buffer.alloc(dbBytes));
  process.env.DB_PATH = path.join(dir, "data.db");
  try {
    return await fn(dir, path.join(dir, "backups"));
  } finally {
    process.env.DB_PATH = realDbPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("the production wiring is installed", () => {
  it("index.ts installs the shutdown handlers after the listener is up", () => {
    // We cannot fire a real signal here: the installed handler ends in
    // process.exit(0) and would take the vitest worker with it. So the
    // production wiring is pinned by reading it. This is the only assertion
    // that catches "shutdown.ts exists but nobody calls it".
    const idx = readSite("server/index.ts");
    expect(idx).toContain('from "./shutdown"');
    expect(idx).toContain("installShutdownHandlers(httpServer)");
    expect(idx.indexOf("httpServer.listen(")).toBeLessThan(idx.indexOf("installShutdownHandlers(httpServer)"));
    // …and the backups are started, so a deploy has something to roll back to.
    expect(idx).toContain("startRollingBackups()");
  });

  it("nothing in storage.ts's static import closure reaches shutdown.ts", () => {
    // shutdown.ts imports { sqlite } from "./storage". Anything inside
    // storage's own static import closure that imported shutdown would close a
    // cycle through a module whose top level OPENS THE DATABASE and runs the
    // migrations — a half-initialised storage singleton on every boot. The
    // rule is stated in shutdown.ts's header; this is what enforces it.
    const resolveRel = (from: string, spec: string) => {
      if (!spec.startsWith(".")) return null;
      const p = path.resolve(path.dirname(from), spec);
      for (const c of [`${p}.ts`, path.join(p, "index.ts")]) if (fs.existsSync(c)) return c;
      return null;
    };
    const staticImports = (f: string) => {
      const src = fs.readFileSync(f, "utf8");
      const out: string[] = [];
      for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)) {
        const r = resolveRel(f, m[1]);
        if (r) out.push(r);
      }
      return out;
    };
    expect(fs.existsSync(path.join(siteRoot, "server/shutdown.ts"))).toBe(true);
    const seen = new Set([path.join(siteRoot, "server/storage.ts")]);
    const stack = [...seen];
    while (stack.length) {
      for (const i of staticImports(stack.pop()!)) if (!seen.has(i)) { seen.add(i); stack.push(i); }
    }
    expect([...seen].map((f) => path.relative(siteRoot, f))).not.toContain("server/shutdown.ts");
  });
});

describe("the rolling backup", () => {
  it("runBackupOnce writes a dated .db beside DB_PATH that is a whole, readable database", async () => {
    const liveMcqs = (sqlite.prepare("SELECT COUNT(*) c FROM mcqs").get() as { c: number }).c;
    expect(liveMcqs).toBeGreaterThan(1800);
    await withScratchVolume(64 * 1024, async (dir, backups) => {
      await runBackupOnce();

      const files = fs.readdirSync(backups).sort();
      const dated = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.db$/.test(f));
      expect(dated).toHaveLength(1);
      expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]); // renamed into place, no debris
      expect(path.dirname(path.join(backups, dated[0]))).toBe(path.join(dir, "backups"));

      const listed = listBackups();
      expect(listed).toHaveLength(1);
      expect(listed[0].name).toBe(dated[0]);
      expect(listed[0].sizeBytes).toBeGreaterThan(0);

      // The copy is the whole corpus, self-contained: it opens on its own and
      // reads back what the live database holds.
      const copy = new Database(path.join(backups, dated[0]), { readonly: true });
      try {
        expect((copy.prepare("SELECT COUNT(*) c FROM mcqs").get() as { c: number }).c).toBe(liveMcqs);
        expect((copy.prepare("SELECT COUNT(*) c FROM settings").get() as { c: number }).c).toBe(1);
      } finally {
        copy.close();
      }
      // …and the live connection is untouched.
      expect(sqlite.open).toBe(true);
    });
  });

  it("prunes the .tmp files a failed run left behind, at the start of the next run", async () => {
    // Stand in for the online-backup copy: write the destination so the
    // rename succeeds, without copying the corpus again.
    const backup = vi.spyOn(sqlite, "backup").mockImplementation(async (dest: any) => {
      fs.writeFileSync(dest, "");
      return { totalPages: 0, remainingPages: 0 } as any;
    });
    try {
      await withScratchVolume(64 * 1024, async (_dir, backups) => {
        fs.mkdirSync(backups, { recursive: true });
        // Two runs that died mid-copy. A volume otherwise accumulates one
        // full-size orphan per failure, forever.
        fs.writeFileSync(path.join(backups, "2026-08-01.db.tmp"), Buffer.alloc(4096));
        fs.writeFileSync(path.join(backups, "2026-08-02.db.tmp"), Buffer.alloc(4096));

        await runBackupOnce();

        const left = fs.readdirSync(backups).sort();
        expect(left.filter((f) => f.endsWith(".tmp"))).toEqual([]);
        expect(left.filter((f) => /^\d{4}-\d{2}-\d{2}\.db$/.test(f)).length).toBe(1);
        expect(backup).toHaveBeenCalledTimes(1);
      });
    } finally {
      backup.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// LAST CASE IN THE FILE. shutdown() closes the singleton connection that
// ./testDb set up for this worker, so every statement after it throws "The
// database connection is not open". Nothing may follow.
// ---------------------------------------------------------------------------
describe("the WAL is checkpointed and removed on the way out", () => {
  it("shutdown() closes the database and leaves a single self-contained file behind", async () => {
    const dbPath = process.env.DB_PATH!;
    sqlite.exec("CREATE TABLE IF NOT EXISTS shutdown_probe(a TEXT)");
    sqlite.prepare("INSERT INTO shutdown_probe VALUES (?)").run("checkpoint-me");
    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    // The row lives in data.db-wal, not data.db. THIS is what a `cp` of
    // data.db on a running machine silently leaves behind.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    expect(sqlite.open).toBe(true);

    await shutdown("SIGTERM"); // standDown + closeDatabase; never calls process.exit

    expect(sqlite.open).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    // And the one remaining file is the whole database.
    const reopened = new Database(dbPath, { readonly: true });
    try {
      expect(reopened.prepare("SELECT a FROM shutdown_probe").get()).toEqual({ a: "checkpoint-me" });
      expect((reopened.prepare("SELECT COUNT(*) c FROM mcqs").get() as { c: number }).c).toBeGreaterThan(1800);
    } finally {
      reopened.close();
    }
  });
});
