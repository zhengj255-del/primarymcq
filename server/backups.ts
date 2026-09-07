// -------------------------------------------------------------------------------------------------
// Rolling on-disk backups of the SQLite database.
//
// Runs at server startup and then once every 24h. Uses SQLite's Online Backup
// API (better-sqlite3's `db.backup(dest)`) which is safe against concurrent
// writes — no need to shut down. Backups land next to the live DB on the
// same Fly volume (/data), so they survive redeploys but NOT volume loss;
// pair this with the JSON backup download (Settings → Backup, GET /api/export)
// kept somewhere off the machine for full safety.
//
// Retention: keeps the last KEEP most recent files. Filenames are ISO date
// stamped (YYYY-MM-DD.db) so re-running the same day overwrites — one file
// per calendar day.
//
// THE VOLUME IS SHARED WITH THE THING BEING PROTECTED.
// Every copy here is a FULL copy of the live database, written to the same
// volume the live database lives on. Three things follow, and all three are
// enforced below rather than hoped for:
//   1. A run that dies mid-copy leaves a `<date>.db.tmp` orphan the size of the
//      whole database, and nothing ever removed it. One failure per week and
//      the volume fills with debris — so every run prunes them first.
//   2. Copying without looking at free space can push the volume to 100% and
//      take the LIVE database down with it. A backup that kills the database it
//      is protecting is the worst outcome available, so a run that cannot fit
//      prunes oldest-first and then refuses, loudly, rather than trying.
//   3. Keeping many copies of a growing database on a fixed volume is the same
//      bug on a slower clock. KEEP is deliberately small; the downloaded JSON
//      backups are the deep history, not this directory.
// -------------------------------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { sqlite } from "./storage";
import { isShuttingDown, onShutdown } from "./shutdown";

// Three, not seven. Seven full copies of a database that only grows, on the
// same volume as the original, is how the backup becomes the thing that fills
// the disk.
const DEFAULT_KEEP = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// Require this many times the live database size free before copying. 1x is
// what the copy itself needs; the second multiple is headroom so the LIVE
// database can still grow (and still checkpoint its WAL) while the copy runs.
// A backup is not worth a full volume.
const REQUIRED_FREE_MULTIPLE = 2;

/** True while a pass is in flight. See runOnce() for why this must exist. */
let running = false;

function dbPath(): string {
  return path.resolve(process.env.DB_PATH || "data.db");
}

function backupDir(): string {
  return path.join(path.dirname(dbPath()), "backups");
}

function todayStamp(): string {
  // YYYY-MM-DD in UTC — one snapshot per calendar day is plenty and avoids
  // TZ drift issues in the retention window calculation.
  return new Date().toISOString().slice(0, 10);
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** Dated snapshots in this directory, OLDEST FIRST (the stamp sorts). */
function datedSnapshots(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
}

/**
 * How big a copy of the live database will be.
 *
 * data.db ALONE is not the answer: in WAL mode a chunk of the database lives in
 * data.db-wal, and the online-backup API materialises that content into the
 * destination. Sizing on data.db alone under-counts by exactly the amount a
 * busy period adds — which is the moment the free-space check matters most.
 */
function liveDbBytes(): number {
  let total = 0;
  for (const p of [dbPath(), `${dbPath()}-wal`]) {
    try {
      total += fs.statSync(p).size;
    } catch {
      // Absent (no WAL right now, or no DB file yet) — contributes nothing.
    }
  }
  return total;
}

/**
 * Free bytes on the filesystem holding `dir`, or null if we cannot tell.
 *
 * THE ESCAPE, and it matters: null means "unknown", and an unknown free space
 * PROCEEDS with the backup. statfsSync is Node >= 18.15 and can fail on an
 * unusual mount; refusing to back up merely because we could not measure would
 * turn a diagnostic into an outage of the safety net itself.
 */
function freeBytes(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    // bavail, not bfree: bfree includes blocks reserved for root, which this
    // process cannot use.
    return Number(st.bavail) * Number(st.bsize);
  } catch (err: any) {
    console.error("[backup] free-space check unavailable, proceeding:", err?.message || err);
    return null;
  }
}

/**
 * Remove `<date>.db.tmp` orphans left by runs that died mid-copy.
 *
 * Unconditional, and safe to be unconditional ONLY because runOnce() refuses to
 * start a second overlapping pass — so when this runs, no .tmp in this
 * directory can belong to a copy still in flight. (Even if one did, POSIX
 * unlink does not disturb an open writer's fd; only its rename would fail, into
 * the catch that already handles it. The overlap guard is what makes that
 * reasoning unnecessary rather than merely probable.)
 */
function pruneStaleTmp(dir: string): void {
  try {
    let n = 0;
    let bytes = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.db\.tmp$/.test(f)) continue;
      const p = path.join(dir, f);
      try {
        bytes += fs.statSync(p).size;
      } catch {
        // best-effort size accounting only
      }
      fs.unlinkSync(p);
      n++;
    }
    if (n > 0) console.log(`[backup] pruned ${n} orphaned .tmp file(s), reclaiming ${mb(bytes)} MB`);
  } catch (err: any) {
    console.error("[backup] .tmp prune failed:", err?.stack || err);
  }
}

/**
 * Make room for one more copy, or say why we are not making one.
 * Returns true when it is safe to proceed.
 *
 * ON PRUNING THAT DOES NOT SAVE THE RUN. This deletes old snapshots oldest-
 * first and may still end up skipping — i.e. it can destroy copies and get
 * nothing for them. That is deliberate, and it is the right way round: on a
 * volume this short, the thing most in need of free blocks is the LIVE
 * database, which has to keep writing and keep checkpointing its WAL. A stale
 * full-size copy of it is exactly the wrong thing to be holding on to at that
 * moment. The MOST RECENT snapshot is never pruned — it is the rollback point
 * of last resort, and it is the one copy worth its blocks.
 */
function ensureRoomFor(dir: string, need: number): boolean {
  if (need <= 0) return true; // no database to copy yet; nothing to reason about
  let free = freeBytes(dir);
  if (free === null) return true; // unknown — see freeBytes()

  const snaps = datedSnapshots(dir); // oldest first
  let pruned = 0;
  while (free !== null && free < need && snaps.length > 1) {
    const oldest = snaps.shift()!;
    try {
      fs.unlinkSync(path.join(dir, oldest));
      pruned++;
      console.warn(`[backup] low disk: pruned ${oldest} to make room`);
    } catch (err: any) {
      console.error(`[backup] could not prune ${oldest}:`, err?.message || err);
      break;
    }
    free = freeBytes(dir);
  }

  if (free !== null && free < need) {
    // LOUD, and with the numbers, because the alternative is a copy that fills
    // the volume and takes the live database down with it. Nothing was copied;
    // the live database and the newest snapshot are untouched.
    console.error(
      `[backup] SKIPPED — not enough room in ${dir}: ${mb(free)} MB free, need ${mb(need)} MB ` +
        `(${mb(need / REQUIRED_FREE_MULTIPLE)} MB database x${REQUIRED_FREE_MULTIPLE}); ` +
        `pruned ${pruned} old snapshot(s) and it was still short. ` +
        `Nothing was copied; the live database is untouched. Free space on the volume, ` +
        `and download a JSON backup from Settings in the meantime.`,
    );
    return false;
  }
  return true;
}

/**
 * One backup pass. Callers go through runOnce(), never here.
 */
async function runBackupPass(): Promise<void> {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });

  // Debris first: it costs nothing and it is space we may need two lines down.
  pruneStaleTmp(dir);

  if (!ensureRoomFor(dir, liveDbBytes() * REQUIRED_FREE_MULTIPLE)) return;

  const dest = path.join(dir, `${todayStamp()}.db`);
  const tmp = `${dest}.tmp`;

  try {
    // better-sqlite3's backup() returns a promise and copies safely alongside
    // ongoing writes. We write to a .tmp then rename atomically so a crash
    // mid-copy can never leave a truncated backup file in place.
    await sqlite.backup(tmp);
    fs.renameSync(tmp, dest);
    const size = fs.statSync(dest).size;
    console.log(`[backup] wrote ${dest} (${mb(size)} MB)`);
  } catch (err: any) {
    console.error("[backup] failed:", err?.stack || err);
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup — the next run's pruneStaleTmp() is the backstop
    }
    return;
  }

  // Retention: keep the newest DEFAULT_KEEP daily snapshots.
  try {
    const files = datedSnapshots(dir); // oldest first
    for (const f of files.slice(0, Math.max(0, files.length - DEFAULT_KEEP))) {
      fs.unlinkSync(path.join(dir, f));
      console.log(`[backup] pruned old ${f}`);
    }
  } catch (err: any) {
    console.error("[backup] retention prune failed:", err?.stack || err);
  }
}

async function runOnce(): Promise<void> {
  // Shutdown has begun. sqlite.backup() would start a copy we are about to
  // abandon when the connection closes. Skip the tick entirely — including
  // the filesystem work — so a deploy does not spend its grace period copying
  // a file nobody will keep.
  // THE ESCAPE (D2): the flag goes up only on SIGTERM/SIGINT and the process
  // exits straight after; nothing else can suppress a backup.
  if (isShuttingDown()) return;

  // Never overlap. Two passes racing would fight over the same `<date>.db.tmp`,
  // and it is what makes pruneStaleTmp()'s unconditional unlink provably safe
  // rather than probably safe. A copy that is still running 24h later is
  // already broken; starting a second one on top of it does not help.
  if (running) {
    console.warn("[backup] previous run still in flight — skipping this tick");
    return;
  }
  running = true;
  try {
    await runBackupPass();
  } finally {
    running = false;
  }
}

/** Exported under an explicit name so a test can drive exactly one pass,
 *  through the same guards production goes through. */
export { runOnce as runBackupOnce };

/**
 * Start the rolling backup loop. Runs once immediately (fire-and-forget) and
 * then every 24h. Safe to call on every boot.
 */
export function startRollingBackups(): void {
  // First run — do NOT await, we don't want to delay server listen.
  runOnce().catch((err) => console.error("[backup] initial run failed:", err));
  // 24h cadence. setInterval keeps the reference so the process stays alive,
  // but the http server already does that; unref to be defensive.
  const timer = setInterval(() => {
    runOnce().catch((err) => console.error("[backup] scheduled run failed:", err));
  }, DAY_MS);
  timer.unref?.();

  // Stop the cadence on the way out, then get out of the way.
  //
  // A copy already in flight is deliberately NOT awaited. Closing the database
  // mid-backup is clean: close() succeeds, the backup promise rejects with
  // "The database connection is not open" into the .catch above, better-sqlite3
  // removes its own destination .tmp, the WAL is checkpointed and every row
  // survives. Whereas WAITING for a multi-hundred-megabyte copy can push us
  // past the platform's kill timeout into a SIGKILL — which leaves the -wal on
  // disk and reinstates the exact failure this guard exists to prevent. Closing
  // beats copying.
  onShutdown("backups", () => {
    clearInterval(timer);
  });
}

/** List backup files on disk, newest first. */
export function listBackups(): Array<{ name: string; sizeBytes: number; mtimeMs: number }> {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return datedSnapshots(dir)
    .map((name) => {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      return { name, sizeBytes: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}
