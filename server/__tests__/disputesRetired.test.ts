import "./testDb";
import { describe, it, expect, beforeAll } from "vitest";
import { sqlite } from "../storage";
import { listMcqs, getMcq, getMcqStats, updateMcqOverride } from "../mcqs";

// ---------------------------------------------------------------------------
// Retiring the Disputes page, on a volume that already ran with it.
//
// The removal is not just a screen going away: two flags in the override layer
// HID questions, and the page that could release one is the page being
// removed. `excluded` (a "discard" verdict) filters a question out of the
// list, the stats and every study pool; `disputed` parked it out of rotation.
// Left behind, a discarded question would be in the database, paid for in the
// user's attempt history, and reachable from nowhere in the app.
//
// So bootstrapMcqs clears both, once, and deletes an override row the clear
// leaves hollow. These tests drive that migration the way an upgrade hits it —
// write the old shapes, re-run the bootstrap, and check what came back — and
// pin the half that must NOT move: a real content edit is not a dispute, and
// survives untouched.
// ---------------------------------------------------------------------------

/** Re-run the boot migration by clearing its marker and calling bootstrap
 *  again. Idempotent in production because the marker is set; here we remove
 *  the marker deliberately to replay the upgrade against a seeded row. */
async function replayBoot(): Promise<void> {
  sqlite.prepare("DELETE FROM mcq_meta WHERE key = 'disputes_retired'").run();
  const mod = await import("../mcqs");
  (mod as unknown as { bootstrapMcqs: () => void }).bootstrapMcqs();
}

let DISCARDED: string;
let PARKED: string;
let EDITED: string;
let totalBefore: number;

describe("the Disputes retirement migration", () => {
  beforeAll(async () => {
    // A database created by the CURRENT schema has neither retired column, so
    // there is nothing for the migration to find. Put `disputed` back to make
    // this the shape a volume that ran the Disputes page actually has —
    // `excluded` is still created by the older ALTER above.
    sqlite.exec("ALTER TABLE mcq_overrides ADD COLUMN disputed INTEGER");
    sqlite.prepare("DELETE FROM mcq_overrides").run();
    totalBefore = getMcqStats().total;
    const ids = (sqlite.prepare(
      "SELECT id FROM mcqs WHERE answer IS NOT NULL ORDER BY id LIMIT 3",
    ).all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toHaveLength(3);
    [DISCARDED, PARKED, EDITED] = ids;

    // The three shapes an old volume can hold. Written as raw SQL because the
    // API that used to produce them is exactly what this change deletes.
    const now = Date.now();
    sqlite.prepare(
      "INSERT INTO mcq_overrides (mcq_id, stem, options, answer, reason, excluded, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(DISCARDED, null, null, null, null, 1, now);
    sqlite.prepare("UPDATE mcq_overrides SET disputed = 0 WHERE mcq_id = ?").run(DISCARDED);
    sqlite.prepare(
      "INSERT INTO mcq_overrides (mcq_id, stem, options, answer, reason, excluded, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(PARKED, null, null, null, null, null, now);
    sqlite.prepare("UPDATE mcq_overrides SET disputed = 1 WHERE mcq_id = ?").run(PARKED);
    updateMcqOverride(EDITED, { reason: "A real edit, made by hand." });
    sqlite.prepare("UPDATE mcq_overrides SET disputed = 1 WHERE mcq_id = ?").run(EDITED);

    // Precondition: the discard really is hiding the question right now.
    expect(listMcqs({ limit: 5000 }).items.some((m) => m.id === DISCARDED)).toBe(false);

    await replayBoot();
  });

  it("returns a discarded question to the bank — it had nowhere else to come back from", () => {
    expect(getMcq(DISCARDED)!.excluded).toBe(false);
    expect(listMcqs({ limit: 5000 }).items.some((m) => m.id === DISCARDED)).toBe(true);
    expect(getMcqStats().total).toBe(totalBefore);
  });

  it("deletes an override row the clear leaves hollow, so the question reads untouched", () => {
    // Both seeded rows carried nothing but the retired flags.
    for (const id of [DISCARDED, PARKED]) {
      expect(sqlite.prepare("SELECT 1 FROM mcq_overrides WHERE mcq_id = ?").get(id)).toBeUndefined();
      expect(getMcq(id)!.edited).toBe(false);
    }
  });

  it("leaves a real content edit alone — an edit is not a dispute", () => {
    const rec = getMcq(EDITED)!;
    expect(rec.reason).toBe("A real edit, made by hand.");
    expect(rec.edited).toBe(true);
    const row = sqlite.prepare("SELECT disputed, excluded FROM mcq_overrides WHERE mcq_id = ?")
      .get(EDITED) as { disputed: number | null; excluded: number | null };
    expect(row).toEqual({ disputed: null, excluded: null });
  });

  it("runs once — a second boot is a no-op over a fresh discard", async () => {
    // The marker is what stops it. Prove the marker is doing the work: set a
    // new excluded flag by hand, boot WITHOUT clearing the marker, and it must
    // survive. (Nothing in the app can set it any more; this is the guard that
    // the migration is a one-time upgrade step, not a permanent sweep that
    // would quietly override a future feature.)
    expect(sqlite.prepare("SELECT value FROM mcq_meta WHERE key = 'disputes_retired'").get()).toBeTruthy();
    sqlite.prepare("UPDATE mcq_overrides SET excluded = 1 WHERE mcq_id = ?").run(EDITED);
    const mod = await import("../mcqs");
    (mod as unknown as { bootstrapMcqs: () => void }).bootstrapMcqs();
    expect(getMcq(EDITED)!.excluded).toBe(true);
    sqlite.prepare("UPDATE mcq_overrides SET excluded = NULL WHERE mcq_id = ?").run(EDITED);
  });
});
