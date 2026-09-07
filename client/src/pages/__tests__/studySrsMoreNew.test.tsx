// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { AppRouter, useHashLocationNoQuery } from "@/App";

// "Study N more new today" on the SRS setup panel — get ahead on new intake
// without editing the standing daily limit in Settings. The control appears
// whenever unseen questions exist beyond what today will serve (budget spent
// OR partially used), posts the chosen count, refreshes the queue numbers,
// and stays hidden once the scope has nothing unseen left to offer.

const QUEUE_STATS = {
  learning: 0, dueLearning: 0, reviews: 0, dueReviews: 0,
  newToday: 0, newAvailable: 120,
  limits: {
    newPerDay: 20, maxReviewsPerDay: 200, newRemaining: 0, reviewsRemaining: 200,
    learningPerSitting: 200, extraNewToday: 0,
  },
};

function stubFetch(queueStats: typeof QUEUE_STATS = QUEUE_STATS) {
  const posted: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const path = url.split("?")[0];
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      posted.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
    }
    let body: unknown = {};
    if (path.endsWith("/api/mcqs/stats")) body = { total: 10, withAnswer: 10, byTopic: [{ slug: "t", name: "Topic", domain: "physiology", count: 10 }], papers: [] };
    else if (path.endsWith("/api/mcqs/weak-areas")) body = { items: [] };
    else if (path.endsWith("/api/mcqs/srs/queue-stats")) body = queueStats;
    else if (path.endsWith("/api/mcqs/srs/extra-new")) body = { day: "2026-08-10", extraNew: 10 };
    else if (path.endsWith("/api/mcqs/session")) body = { sessionId: null, mode: "srs", timeLimitSec: null, mcqs: [] };
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
  }));
  return posted;
}

function renderStudy() {
  window.history.replaceState(null, "", "/#/study");
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocationNoQuery}>
        <AppRouter />
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.sessionStorage.clear();
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("study more new today (SRS get-ahead intake)", () => {
  it("offers the control when the day's budget is spent but unseen questions remain", async () => {
    stubFetch();
    renderStudy();
    const ctl = await screen.findByTestId("srs-extra-new");
    // Names what it does AND what it does not touch — the standing limit.
    expect(ctl.textContent).toContain("more new today");
    expect(ctl.textContent).toContain("20/day limit in Settings is unchanged");
    // The "done for today" copy is still honest alongside it.
    expect((await screen.findByTestId("srs-done-today")).textContent).toContain("Today's work is done");
  });

  it("posts the chosen count and refetches the queue numbers", async () => {
    const posted = stubFetch();
    renderStudy();
    await screen.findByTestId("srs-extra-new");

    fireEvent.change(screen.getByTestId("input-extra-new"), { target: { value: "25" } });
    fireEvent.click(screen.getByTestId("button-extra-new"));

    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].url).toContain("/api/mcqs/srs/extra-new");
    expect(posted[0].body).toEqual({ count: 25 });
    // The grant is useless if the panel keeps showing 0 new — the stats must
    // be re-read so the Study button reflects the new queue.
    await waitFor(() => {
      const statCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/mcqs/srs/queue-stats"));
      expect(statCalls.length).toBeGreaterThan(1);
    });
  });

  it("also offers the control while budget remains, and names an active boost", async () => {
    stubFetch({
      ...QUEUE_STATS,
      newToday: 5,
      limits: { ...QUEUE_STATS.limits, newRemaining: 5, extraNewToday: 10 },
    });
    renderStudy();
    expect(await screen.findByTestId("srs-extra-new")).toBeTruthy();
    expect((await screen.findByTestId("srs-held-back")).textContent).toContain("+10 extra new unlocked today");
  });

  it("offers to remove only the unspent part of a partially-spent boost", async () => {
    // Granted +45, then studied past the base limit: 19 boost slots are left.
    // "Remove today's +45" would overpromise — removal can't claw back cards
    // already introduced, so the button names the unspent remainder.
    stubFetch({
      ...QUEUE_STATS,
      newToday: 19,
      limits: { ...QUEUE_STATS.limits, newPerDay: 50, newRemaining: 19, extraNewToday: 45 },
    });
    renderStudy();
    const remove = await screen.findByTestId("button-extra-new-remove");
    expect(remove.textContent).toContain("Remove today's +19");
    // The day's grant is still reported in full — that note is history, not
    // the removal's promise.
    expect((await screen.findByTestId("srs-held-back")).textContent).toContain("+45 extra new unlocked today");
  });

  it("a fully-spent boost has nothing left to remove — the button goes", async () => {
    stubFetch({
      ...QUEUE_STATS,
      limits: { ...QUEUE_STATS.limits, newRemaining: 0, extraNewToday: 20 },
    });
    renderStudy();
    await screen.findByTestId("srs-extra-new");
    expect(screen.queryByTestId("button-extra-new-remove")).toBeNull();
  });

  it("stays hidden when the scope has nothing unseen beyond today's serve", async () => {
    stubFetch({
      ...QUEUE_STATS,
      newToday: 20, newAvailable: 20,
      limits: { ...QUEUE_STATS.limits, newRemaining: 20 },
    });
    renderStudy();
    await screen.findByTestId("srs-queue-stats");
    expect(screen.queryByTestId("srs-extra-new")).toBeNull();
  });
});

describe("no new cards this sitting", () => {
  it("the toggle re-reads the queue with skipNew and starts the sitting with srsSkipNew", async () => {
    // Reviews exist so the Study button stays enabled with new switched off.
    const posted = stubFetch({ ...QUEUE_STATS, reviews: 3, dueReviews: 3 });
    renderStudy();
    await screen.findByTestId("srs-queue-stats");

    fireEvent.click(screen.getByTestId("toggle-skip-new"));
    // The panel's numbers must be the numbers Study will serve.
    await waitFor(() => {
      const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/api/mcqs/srs/queue-stats") && u.includes("skipNew=1"))).toBe(true);
    });

    fireEvent.click(screen.getByTestId("button-start-session"));
    await waitFor(() => expect(posted.some((p) => p.url.includes("/api/mcqs/session"))).toBe(true));
    const start = posted.find((p) => p.url.includes("/api/mcqs/session"))!;
    expect((start.body as Record<string, unknown>).srsSkipNew).toBe(true);
  });

  it("hides the get-ahead grant while new is off, but a granted boost stays removable", async () => {
    const posted = stubFetch({
      ...QUEUE_STATS,
      // An unspent +20 grant on top of the spent base allowance: newRemaining
      // rises with it (the server derives one from the other).
      limits: { ...QUEUE_STATS.limits, newRemaining: 20, extraNewToday: 20 },
    });
    renderStudy();
    await screen.findByTestId("srs-extra-new");
    fireEvent.click(screen.getByTestId("toggle-skip-new"));

    // Granting more new while refusing to be served any is a contradiction —
    // the grant control goes; the escape hatch for the boost stays. (findBy:
    // the toggle changes the stats query key, so the row re-renders after a
    // refetch.)
    const remove = await screen.findByTestId("button-extra-new-remove");
    expect(screen.queryByTestId("input-extra-new")).toBeNull();
    expect(remove.textContent).toContain("Remove today's +20");

    fireEvent.click(remove);
    await waitFor(() =>
      expect(posted.some((p) => p.method === "DELETE" && p.url.includes("/api/mcqs/srs/extra-new"))).toBe(true),
    );
  });

  it("an empty queue with new switched off says so, not 'done for today'", async () => {
    stubFetch(); // 0 learning / 0 reviews / 0 new, 120 unseen available
    renderStudy();
    await screen.findByTestId("srs-queue-stats");
    fireEvent.click(screen.getByTestId("toggle-skip-new"));
    await waitFor(() =>
      expect(screen.getByTestId("srs-done-today").textContent).toContain("new cards are switched off"),
    );
  });
});
