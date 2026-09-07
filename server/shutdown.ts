// -------------------------------------------------------------------------------------------------
// Ordered shutdown for a WAL SQLite process.
//
// WHY THIS FILE EXISTS (schema-storage-integrity-2). server/storage.ts opens
// DB_PATH at module top level and sets `journal_mode = WAL`, so at any moment
// part of the database lives in data.db-wal rather than in data.db. Nothing
// ever closed it: Fly killed the process, the -wal survived on the volume, and
// a raw restore (copying a dated backup over data.db — README.md, "Backups and
// restore") swapped a snapshot in underneath that stale -wal, which then
// replayed over the file the operator had just restored. A rollback copy taken
// from data.db alone was missing every un-checkpointed write. So the obvious
// recovery destroyed both the restore and the rollback.
//
// sqlite.close() is the fix: on the LAST connection it checkpoints the WAL into
// the main file and DELETES data.db-wal and data.db-shm, leaving one
// self-contained file that can be copied, moved and replaced safely. That is
// the property the restore steps in README.md rely on, and it is pinned by
// server/__tests__/shutdownAndBackups.test.ts.
//
// WHY A FLAG AND NOT JUST close(). better-sqlite3 is SYNCHRONOUS. A signal
// handler is an ordinary JS callback on the same thread, so it can only run
// when the stack is empty — BETWEEN statements. close() can therefore never
// tear a statement or a `sqlite.transaction(...)` in half; every transaction
// has committed or rolled back before the handler gets the thread. And because
// process.exit(0) runs on the tick after the close, no queued macrotask ever
// executes against the closed handle either.
//   The flag is not, then, a correctness device for synchronous callers. It is
// there for the periodic backup timer (server/backups.ts), whose tick could
// otherwise fire after the close and throw "The database connection is not
// open". Nothing is corrupted — SQLite is transactionally consistent and
// nothing was mid-write — but it is noise on every single deploy. The flag
// turns it into a clean early return.
//
// WHAT THIS CANNOT DO, stated plainly because a backup you trust is worse than
// no backup: shutdown cannot be made fast. A long SYNCHRONOUS statement (a full
// sync's upsert, a whole-corpus scan) holds the thread, and the signal handler
// simply does not run until it returns. If the platform's kill timeout expires
// first the process is SIGKILLed and the -wal survives exactly as it does
// today. This module is a strong default, not a guarantee — which is why the
// restore steps in README.md say to delete any data.db-wal / data.db-shm
// beside the file being replaced. That step is not belt-and-braces; it is
// this fix's only backstop.
//
// IMPORT RULE: nothing inside server/storage.ts's static import closure may
// import this module — it would close a cycle through a module whose top level
// opens the database and runs the migrations. The test enforces it by
// recomputing that closure.
// -------------------------------------------------------------------------------------------------

import type { Server } from "node:http";
import { sqlite } from "./storage";

let shuttingDown = false;
const hooks: Array<{ name: string; fn: () => void | Promise<void> }> = [];

/**
 * True from the moment a signal arrives. Every periodic tick and every
 * cooperative job runner checks this before touching the database.
 *
 * THE ESCAPE: the flag is one-way and process-local. Only a signal — or a test
 * calling standDown()/shutdown() — raises it, and the process exits
 * immediately afterwards, so it can never wedge a live server into refusing
 * work. _resetShutdownForTests() drops it.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Register a stand-down step: clear a timer, drop a claim, release a lock.
 * Hooks run in registration order, before the database is closed. A hook that
 * throws is logged and skipped — one bad hook must never cost us the
 * checkpoint, which is the only part of this sequence that protects data.
 */
export function onShutdown(name: string, fn: () => void | Promise<void>): void {
  hooks.push({ name, fn });
}

/**
 * How long to wait for in-flight HTTP before closing anyway.
 *
 * THE BOUND (D1): this bounds how long WE WAIT, never any user data and never
 * the size of anything. When it expires we still close, so every committed
 * transaction is still checkpointed — we only stop waiting for requests that
 * have not finished. THE ESCAPE: SHUTDOWN_GRACE_MS overrides it; 0 proceeds at
 * once; a nonsense value falls back to the default rather than to NaN (which
 * would make setTimeout fire immediately and silently drop the drain).
 */
function graceMs(): number {
  const raw = process.env.SHUTDOWN_GRACE_MS;
  if (raw === undefined || raw === "") return 3_000;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 3_000;
}

/**
 * Phase 1 — raise the flag, stop accepting connections, drain, run the hooks.
 *
 * Deliberately does NOT close the database. The two phases are separate
 * exports because closing tears down a process-wide singleton: a test that
 * wants to prove the timers stood down must be able to do so without killing
 * the connection every later case in the same worker depends on.
 */
export async function standDown(signal: string, httpServer?: Server): Promise<void> {
  if (shuttingDown) return; // idempotent: a second signal is a no-op here
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — draining`);

  if (httpServer) {
    await new Promise<void>((resolve) => {
      let done = false;
      let t: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (t) clearTimeout(t);
        resolve();
      };
      httpServer.close(finish); // stop accepting new connections
      // Express keeps HTTP/1.1 keep-alive sockets open. Without this, one idle
      // browser tab left open on any page holds close()'s callback for as
      // long as it likes and the grace timer below becomes the only exit.
      httpServer.closeIdleConnections?.();
      // NOT unref'd, and cleared in finish(): this timer is the only thing that
      // GUARANTEES we reach sqlite.close(). Unref'd, an event loop that empties
      // while the close callback is still pending lets Node exit 0 with the WAL
      // still on disk — the exact failure this module exists to prevent.
      t = setTimeout(() => {
        // Requests still running after the grace are cut off here. Nothing is
        // left half-written: better-sqlite3 commits or rolls back each
        // transaction inside one synchronous call, so a socket dying mid-
        // response cannot leave a partial row behind.
        httpServer.closeAllConnections?.();
        finish();
      }, graceMs());
    });
  }

  for (const h of hooks) {
    try {
      await h.fn();
    } catch (err: any) {
      console.error(`[shutdown] hook ${h.name} failed:`, err?.stack || err);
    }
  }
}

/**
 * Phase 2 — checkpoint the WAL and drop -wal/-shm. Safe to call twice, and
 * deliberately NOT gated on the flag: a second signal must still be able to
 * reach the close if the first drain went wrong.
 */
export function closeDatabase(): void {
  try {
    if (sqlite.open) sqlite.close(); // checkpoints the WAL; removes -wal/-shm
    console.log("[shutdown] database closed (WAL checkpointed)");
  } catch (err: any) {
    console.error("[shutdown] sqlite.close() failed:", err?.stack || err);
  }
}

/** The whole sequence minus process.exit — exported so a test can drive it. */
export async function shutdown(signal: string, httpServer?: Server): Promise<void> {
  await standDown(signal, httpServer);
  closeDatabase();
}

/**
 * Wire SIGTERM/SIGINT. Called ONCE from server/index.ts after listen() — never
 * at module scope. Most server test files transitively import this module (via
 * routes.ts -> backups.ts), and a module-scope registration would put a real
 * SIGINT handler in every vitest worker, swallowing the developer's Ctrl-C.
 */
export function installShutdownHandlers(httpServer: Server): void {
  // Register BOTH signals. Fly sends the machine's kill_signal on a deploy, a
  // `machine stop` or a `machine update`, and a local Ctrl-C sends SIGINT.
  // fly.toml sets no kill_signal, so the platform default applies — a handler
  // wired only to SIGTERM would look correct in review and never fire in
  // production, which is the failure mode this whole batch is about.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      // A SECOND signal is the operator saying "now". Honour it rather than
      // making them reach for SIGKILL, which is what leaves a -wal behind.
      process.on(sig, () => {
        console.error(`[shutdown] second ${sig} — exiting now`);
        process.exit(1);
      });
      shutdown(sig, httpServer)
        .catch((err: any) => console.error("[shutdown] failed:", err?.stack || err))
        .finally(() => process.exit(0));
    });
  }
}

/**
 * Test seam: drop the flag and the registered hooks between cases. It does NOT
 * reopen the database — once closeDatabase() has run the singleton is gone for
 * the life of the worker, and no boolean can bring it back.
 */
export function _resetShutdownForTests(): void {
  shuttingDown = false;
  hooks.length = 0;
}
