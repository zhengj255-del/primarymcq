// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { AppRouter, useHashLocationNoQuery } from "@/App";
import { saveStudySnapshot, loadStudySnapshot, type StudySnapshot } from "@/pages/Study";

// The Settings page: the FSRS card, the progress reset, and sign-out.
//
// Desired retention is edited as a percentage but stored as a 0..1 fraction —
// an off-by-100 in that conversion would silently reschedule every review, so
// the exact PATCH body is pinned here. The save posts ONLY the fields that
// changed (the server validates each field, so an untouched value must never
// be re-sent as something else), and an emptied box is the owner mid-edit,
// not a request to set zero.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); queryClient.clear(); });

const SETTINGS = { id: 1, srsRetention: 0.9, srsFuzz: 1, srsNewPerDay: 20, srsMaxReviewsPerDay: 200 };

function stub(opts: { patchError?: (body: Record<string, unknown>) => string | null } = {}) {
  const patches: Array<Record<string, unknown>> = [];
  const calls: Array<{ method: string; url: string }> = [];
  let stored = { ...SETTINGS };
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const path = url.split("?")[0];
    const method = String(init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    let body: unknown = {};
    let status = 200;
    if (path.endsWith("/api/settings")) {
      if (method === "PATCH") {
        const patch = JSON.parse(init.body);
        patches.push(patch);
        const refusal = opts.patchError?.(patch) ?? null;
        if (refusal) {
          status = 400;
          body = { error: refusal };
        } else {
          stored = { ...stored, ...patch };
          body = stored;
        }
      } else body = stored;
    }
    else if (path.endsWith("/api/auth/status")) body = { required: true, authed: true };
    else if (path.endsWith("/api/mcqs/reset")) body = { ok: true, deletedAttempts: 3, deletedSrsState: 2, deletedSessions: 1 };
    else if (path.endsWith("/api/logout")) body = { ok: true };
    return { ok: status < 400, status, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
  }));
  return { patches, calls };
}

function mount() {
  window.history.replaceState(null, "", "/#/settings");
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocationNoQuery}><AppRouter /></Router>
    </QueryClientProvider>,
  );
}

// The server's own refusals for the zeroes a backspaced box used to post.
const refuseZeroes = (body: Record<string, unknown>) => {
  if (typeof body.srsRetention === "number" && (body.srsRetention < 0.7 || body.srsRetention > 0.97)) {
    return "srsRetention must be between 0.70 and 0.97";
  }
  return null;
};

describe("Settings — MCQ spaced repetition card", () => {
  it("shows the stored fraction as a percentage and fuzz as On", async () => {
    stub();
    mount();
    const retention = (await screen.findByTestId("input-srs-retention")) as HTMLInputElement;
    expect(retention.value).toBe("90");
    expect((screen.getByTestId("input-srs-new-per-day") as HTMLInputElement).value).toBe("20");
    expect((screen.getByTestId("input-srs-max-reviews") as HTMLInputElement).value).toBe("200");
    expect(screen.getByTestId("select-srs-fuzz").textContent).toContain("On");
    // Nothing pending on first render, so there is nothing to save.
    expect((screen.getByTestId("button-save-srs") as HTMLButtonElement).disabled).toBe(true);
  });

  it("PATCHes retention back as a 0..1 fraction, not the on-screen percentage", async () => {
    const { patches } = stub();
    mount();
    const retention = (await screen.findByTestId("input-srs-retention")) as HTMLInputElement;
    fireEvent.change(retention, { target: { value: "80" } });
    fireEvent.click(screen.getByTestId("button-save-srs"));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ srsRetention: 0.8 });
  });

  it("PATCHes only the fields that changed", async () => {
    const { patches } = stub();
    mount();
    fireEvent.change(await screen.findByTestId("input-srs-new-per-day"), { target: { value: "30" } });
    fireEvent.change(screen.getByTestId("input-srs-max-reviews"), { target: { value: "150" } });
    fireEvent.click(screen.getByTestId("button-save-srs"));
    await waitFor(() => expect(patches.length).toBe(1));
    // Retention and fuzz were never touched: they are not on the wire at all.
    expect(patches[0]).toEqual({ srsNewPerDay: 30, srsMaxReviewsPerDay: 150 });
    // After the save the boxes show what is now stored.
    await waitFor(() =>
      expect((screen.getByTestId("input-srs-new-per-day") as HTMLInputElement).value).toBe("30"));
    expect((screen.getByTestId("button-save-srs") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the card holds exactly the four FSRS dials — retention, new/day, reviews/day, fuzz", async () => {
    // The corpus question is what gets served, so the only select on this
    // card is the fuzz switch; there is no dial for serving anything else.
    stub();
    mount();
    await screen.findByTestId("input-srs-retention");
    const ids = (prefix: string) =>
      Array.from(document.querySelectorAll(`[data-testid^="${prefix}"]`)).map((el) => el.getAttribute("data-testid")).sort();
    expect(ids("select-")).toEqual(["select-srs-fuzz"]);
    expect(ids("input-srs-")).toEqual(["input-srs-max-reviews", "input-srs-new-per-day", "input-srs-retention"]);
  });
});

describe("Settings — an emptied numeric box is mid-edit, not a request to set zero", () => {
  it("clearing desired retention withdraws the edit instead of posting a zero", async () => {
    const { patches } = stub({ patchError: refuseZeroes });
    mount();
    const retention = (await screen.findByTestId("input-srs-retention")) as HTMLInputElement;
    fireEvent.change(retention, { target: { value: "" } });
    expect(retention.value).toBe("");           // the backspace is not undone under the cursor
    // While it is empty the box says what stays saved, rather than silently
    // refilling itself or silently meaning zero.
    expect((await screen.findByTestId("hint-empty-srsRetention")).textContent).toContain("90");
    // The only pending edit was withdrawn, so there is nothing left to save —
    // and pressing Save cannot post the zero that used to be sitting there.
    expect((screen.getByTestId("button-save-srs") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("button-save-srs"));

    await waitFor(() => expect(patches.some((p) => "srsRetention" in p)).toBe(false));
    expect(patches.length).toBe(0);
    expect(screen.queryByText(/srsRetention must be/)).toBeNull();
  });

  it("clearing one box saves the rest of the edit and sends no zero for it", async () => {
    const { patches } = stub({ patchError: refuseZeroes });
    mount();
    fireEvent.change(await screen.findByTestId("input-srs-new-per-day"), { target: { value: "30" } });
    const maxReviews = screen.getByTestId("input-srs-max-reviews") as HTMLInputElement;
    fireEvent.change(maxReviews, { target: { value: "" } });
    expect((await screen.findByTestId("hint-empty-srsMaxReviewsPerDay")).textContent).toContain("200");

    fireEvent.click(screen.getByTestId("button-save-srs"));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ srsNewPerDay: 30 });
    expect(patches[0]).not.toHaveProperty("srsMaxReviewsPerDay");
    // The save went through, so the withdrawn edit is over: the box shows the
    // 200 that is actually stored again.
    await waitFor(() => expect((screen.getByTestId("input-srs-max-reviews") as HTMLInputElement).value).toBe("200"));
  });

  it("typing a real number after clearing still saves it", async () => {
    const { patches } = stub({ patchError: refuseZeroes });
    mount();
    const retention = (await screen.findByTestId("input-srs-retention")) as HTMLInputElement;
    fireEvent.change(retention, { target: { value: "" } });
    fireEvent.change(retention, { target: { value: "85" } });
    expect(retention.value).toBe("85");
    expect(screen.queryByTestId("hint-empty-srsRetention")).toBeNull();
    fireEvent.click(screen.getByTestId("button-save-srs"));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ srsRetention: 0.85 });
  });
});

describe("Settings — reset MCQ progress", () => {
  const resetCalls = (calls: Array<{ method: string; url: string }>) =>
    calls.filter((c) => c.method === "POST" && c.url.includes("/api/mcqs/reset"));

  it("arms on first click, wipes only on confirm — with confirm=YES on the wire", async () => {
    const { calls } = stub();
    mount();
    fireEvent.click(await screen.findByTestId("button-reset-mcq"));
    expect(resetCalls(calls).length).toBe(0);        // armed, nothing fired

    fireEvent.click(screen.getByTestId("button-reset-mcq-confirm"));
    await waitFor(() => expect(resetCalls(calls).length).toBe(1));
    expect(resetCalls(calls)[0].url).toContain("confirm=YES");
    // Back to the armable state once the wipe has landed.
    expect(await screen.findByTestId("button-reset-mcq")).toBeTruthy();
  });

  it("cancel disarms without firing", async () => {
    const { calls } = stub();
    mount();
    fireEvent.click(await screen.findByTestId("button-reset-mcq"));
    fireEvent.click(screen.getByTestId("button-reset-mcq-cancel"));
    expect(screen.queryByTestId("button-reset-mcq-confirm")).toBeNull();
    expect(await screen.findByTestId("button-reset-mcq")).toBeTruthy();
    expect(resetCalls(calls).length).toBe(0);
  });
});

describe("Settings — sign-out", () => {
  it("Sign out POSTs /api/logout", async () => {
    const { calls } = stub();
    mount();
    fireEvent.click(await screen.findByTestId("button-sign-out"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/logout"))).toBe(true));
  });
});

// A sitting snapshotted in this tab refers to a session row. Reset wipes the
// rows, so afterwards the snapshot points at a session the server cannot
// finish — it must be dropped.
const SNAPSHOT: StudySnapshot = {
  session: { sessionId: "sess-doomed", mode: "tutor", mcqs: [{ id: "Q1" }] as any, timeLimitSec: null } as any,
  idx: 0,
  answered: [],
  sessionStartMs: Date.now(),
};

describe("Settings — reset drops the Study snapshot", () => {
  it("Reset MCQ progress clears it", async () => {
    stub();
    saveStudySnapshot(SNAPSHOT);
    mount();
    fireEvent.click(await screen.findByTestId("button-reset-mcq"));
    fireEvent.click(await screen.findByTestId("button-reset-mcq-confirm"));
    await waitFor(() => expect(loadStudySnapshot()).toBeNull());
  });
});
