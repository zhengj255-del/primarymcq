import "./testDb";
import { describe, it, expect, beforeAll } from "vitest";
import "../storage";
import { sqlite } from "../storage";
import { listDisputeTriage, listMcqs, updateMcqOverride, getMcqStats, resolveMcqDispute } from "../mcqs";

// The Disputes page's queue must list the SAME disputes every other reader
// sees.
//
// A dispute raised in the app (McqEditDialog's Disputed toggle -> PATCH
// /api/mcqs/:id -> updateMcqOverride) is written to `mcq_overrides`; the
// shipped Black Bank flags live in the base `mcqs.disputed` column. The stats
// header, the /mcqs list filter and the study pools all read the EFFECTIVE flag
// (override wins over base). listDisputeTriage once read the base column
// alone, so a question the candidate flagged mid-study never appeared in the
// queue that exists to clear it.
//
// These pin: both dispute paths reach the queue; the queue's pending count and
// the header count are one number; and a human verdict (Accept / Discard /
// Reopen) retires or restores a row on the ledger without it vanishing.

// A topic that ships with ZERO disputed questions, so the fixture owns the
// pile and the assertions below can name exact ids.
const TOPIC = "gastrointestinal";
let APP_ID: string;   // flagged by the candidate in the app -> mcq_overrides
let BASE_ID: string;  // flagged in the shipped corpus -> mcqs.disputed
let EDIT_ID: string;  // hand-edited, never disputed -> must stay out of the queue

describe("dispute triage queue — both dispute paths", () => {
  beforeAll(() => {
    const shipped = (sqlite.prepare(
      "SELECT COUNT(*) c FROM mcqs WHERE topic_slug = ? AND disputed = 1",
    ).get(TOPIC) as { c: number }).c;
    expect(shipped).toBe(0);

    const ids = (sqlite.prepare(
      "SELECT id FROM mcqs WHERE topic_slug = ? AND answer IS NOT NULL ORDER BY id LIMIT 3",
    ).all(TOPIC) as Array<{ id: string }>).map((r) => r.id);
    [APP_ID, BASE_ID, EDIT_ID] = ids;

    // The two ways a question becomes disputed.
    updateMcqOverride(APP_ID, { disputed: true });                                  // in the app
    sqlite.prepare("UPDATE mcqs SET disputed = 1 WHERE id = ?").run(BASE_ID);       // in the corpus
    // And a question that merely carries a hand edit: an override row, but no
    // dispute and no triage verdict.
    updateMcqOverride(EDIT_ID, { reason: "Typo fixed while reading." });
  });

  it("lists a dispute raised in the app", () => {
    const t = listDisputeTriage();
    const item = t.items.find((i) => i.id === APP_ID);
    expect(item).toBeDefined();
    expect(item!.disputed).toBe(true);
    expect(item!.triageStatus).toBe("pending");
  });

  it("still lists a dispute that came with the corpus, exactly once", () => {
    const t = listDisputeTriage();
    // Once: the override join must not fan a question out into two rows.
    expect(t.items.filter((i) => i.id === BASE_ID)).toHaveLength(1);
    expect(t.items.find((i) => i.id === BASE_ID)!.triageStatus).toBe("pending");
    expect(t.items).toHaveLength(t.counts.total);
    // An override row is not a dispute: a hand edit must not turn up here as a
    // phantom pending item (which would also push counts.pending past the
    // header count again).
    expect(t.items.some((i) => i.id === EDIT_ID)).toBe(false);
  });

  it("counts the same disputes the MCQs header counts", () => {
    // The header (getMcqStats) has always used the effective flag; the queue
    // used the base column, so the two disagreed by the number of user flags.
    expect(listDisputeTriage().counts.pending).toBe(getMcqStats().disputed);
    // And the payload carries nothing but the counts and the rows — there is
    // no machine verdict lane on this site.
    expect(Object.keys(listDisputeTriage()).sort()).toEqual(["counts", "items"]);
  });

  it("Accept retires the app-raised dispute from the pending count but keeps it on the ledger", () => {
    const r = resolveMcqDispute(APP_ID, "accept")!;
    expect(r.triageStatus).toBe("accepted");
    expect(r.disputed).toBe(false);

    const t = listDisputeTriage();
    // Still listed, with the verdict on it: the queue is the ledger of what
    // triage did, so a resolved dispute stays visible (and reopenable) rather
    // than vanishing the moment the flag clears.
    expect(t.items.find((i) => i.id === APP_ID)?.triageStatus).toBe("accepted");
    expect(t.counts.accepted).toBe(1);
    // Cleared from the pending queue, and the header agrees.
    expect(t.items.filter((i) => i.id === APP_ID && i.triageStatus === "pending")).toHaveLength(0);
    expect(t.counts.pending).toBe(getMcqStats().disputed);
    // …and it is sittable again: the list filter no longer calls it disputed.
    expect(listMcqs({ topic: TOPIC, disputed: true, limit: 200 }).items.some((m) => m.id === APP_ID)).toBe(false);
  });

  it("Accept then Reopen returns a corpus dispute to the pending queue", () => {
    // Reopen clears the verdict (override.disputed back to NULL), so what is
    // left is whatever the corpus says — for BASE_ID, disputed. (An app-raised
    // dispute lives ONLY in that override column, so reopening one withdraws
    // the user's own flag; that is why this case uses the corpus dispute.)
    expect(resolveMcqDispute(BASE_ID, "accept")!.triageStatus).toBe("accepted");
    expect(listDisputeTriage().counts.accepted).toBe(2);

    expect(resolveMcqDispute(BASE_ID, "reopen")!.triageStatus).toBe("pending");
    const t = listDisputeTriage();
    expect(t.items.find((i) => i.id === BASE_ID)?.triageStatus).toBe("pending");
    expect(t.items.find((i) => i.id === BASE_ID)?.disputed).toBe(true);
    expect(t.counts.accepted).toBe(1); // APP_ID's verdict stands
    expect(t.counts.pending).toBe(getMcqStats().disputed);
    expect(listMcqs({ topic: TOPIC, disputed: true, limit: 200 }).items.some((m) => m.id === BASE_ID)).toBe(true);
  });

  it("Discard hides the corpus dispute from the bank but keeps it on the ledger", () => {
    const r = resolveMcqDispute(BASE_ID, "discard")!;
    expect(r.triageStatus).toBe("discarded");
    expect(r.excluded).toBe(true);

    const t = listDisputeTriage();
    expect(t.items.find((i) => i.id === BASE_ID)?.triageStatus).toBe("discarded");
    expect(t.counts.discarded).toBe(1);
    // A discarded question leaves every read of the bank — the browse list
    // included — but the Disputes page still shows it so it can be reopened.
    expect(listMcqs({ topic: TOPIC, limit: 200 }).items.some((m) => m.id === BASE_ID)).toBe(false);
    expect(t.counts.pending).toBe(getMcqStats().disputed);
  });
});
