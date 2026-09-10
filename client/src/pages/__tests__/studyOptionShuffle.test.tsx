// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { AppRouter, useHashLocationNoQuery } from "@/App";
import { presentOptionKeys } from "@/lib/optionShuffle";

// The runner's option display shuffle. What must hold for it to be
// watertight: the rendered rows are a permutation of the question's options
// with each row keeping its own CANONICAL letter chip; the letter POSTed to
// /api/mcqs/attempt is the canonical key of the clicked row (never a display
// position); the order is stable across re-renders of one serve; and
// order-dependent questions render in canonical order.

const FIXED_NOW = 1754800000000;

const OPTS = { A: "alpha", B: "bravo", C: "charlie", D: "delta", E: "echo" };
const MCQ = (id: string, options: Record<string, string>) => ({
  id, code: id, displayCode: id, topicFile: "t", topicName: "Topic", topicSlug: "t",
  domain: "physiology", section: null, papers: [], stem: `${id} stem`,
  options, answer: "A", reason: "because", urls: [], parentCode: null,
  loCodes: [], edited: false,
});

function stubFetch(mcqs: unknown[]) {
  const posted: Array<{ url: string; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const path = url.split("?")[0];
    if ((init?.method ?? "GET").toUpperCase() === "POST") {
      posted.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    }
    let body: unknown = {};
    if (path.endsWith("/api/mcqs/stats")) body = { total: 10, withAnswer: 10, byTopic: [{ slug: "t", name: "Topic", domain: "physiology", count: 10 }], papers: [] };
    else if (path.endsWith("/api/mcqs/weak-areas")) body = { items: [] };
    else if (path.endsWith("/api/mcqs/srs/queue-stats")) body = {
      learning: 0, dueLearning: 0, reviews: 1, dueReviews: 1, newToday: 0, newAvailable: 0,
      limits: { newPerDay: 20, maxReviewsPerDay: 200, newRemaining: 20, reviewsRemaining: 200, learningPerSitting: 200, extraNewToday: 0 },
    };
    else if (path.endsWith("/api/mcqs/session")) body = { sessionId: null, mode: "srs", timeLimitSec: null, mcqs };
    else if (path.endsWith("/api/mcqs/attempt")) {
      const p = JSON.parse(init?.body ?? "{}");
      body = { correct: p.selected === "A", correctAnswer: "A", reason: "because", srsPreview: { again: 0, hard: 1, good: 2, easy: 45 } };
    }
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

/** The option rows currently in the DOM, in visual order, as canonical letters. */
function renderedOrder(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="button-option-"]'))
    .map((el) => (el.getAttribute("data-testid") ?? "").replace("button-option-", ""));
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // Pins the runner's sessionStart seed component so the permutation is the
  // one this test computes for itself.
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  window.sessionStorage.clear();
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function startSitting(mcqs: unknown[]) {
  const posted = stubFetch(mcqs);
  renderStudy();
  fireEvent.click(await screen.findByTestId("button-start-session"));
  await screen.findByText(/stem/);
  return posted;
}

describe("option display shuffle", () => {
  it("renders the exact permutation the serve's seed dictates — canonical letters intact", async () => {
    await startSitting([MCQ("Q1", OPTS)]);
    // Same derivation the runner uses: (id | <empty slot> | idx | sessionStart).
    // The empty second slot is deliberate — it keeps the seed string, and so
    // the permutation every existing serve produced, identical.
    const expected = presentOptionKeys(OPTS, `Q1||0|${FIXED_NOW}`);
    expect(expected.join("")).not.toBe("ABCDE"); // this seed really shuffles
    expect(renderedOrder()).toEqual(expected);
    // Every row keeps its own letter chip and its own text — relabeling by
    // position is the poison path this design forbids.
    for (const k of ["A", "B", "C", "D", "E"] as const) {
      const btn = screen.getByTestId(`button-option-${k}`);
      expect(btn.textContent).toContain(k);
      expect(btn.textContent).toContain(OPTS[k]);
    }
  });

  it("POSTs the canonical letter of the clicked row, wherever it was displayed", async () => {
    const posted = await startSitting([MCQ("Q1", OPTS)]);
    // Click the SECOND rendered row — under this seed (ADEBC) that's
    // canonical D. A position-relabeling bug would post "B" here.
    const second = renderedOrder()[1];
    expect(second).toBe("D");
    fireEvent.click(screen.getByTestId(`button-option-${second}`));
    fireEvent.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");
    const attempt = posted.find((p) => p.url.includes("/api/mcqs/attempt"))!;
    expect(attempt.body.selected).toBe("D");
    // The attempt names the question and the sitting — nothing else about
    // how it was served rides along.
    expect(attempt.body.mcqId).toBe("Q1");
    expect(Object.keys(attempt.body).sort()).toEqual(["mcqId", "mode", "selected", "sessionId", "timeMs"]);
  });

  it("keeps one serve's order stable across re-renders (selection state change)", async () => {
    await startSitting([MCQ("Q1", OPTS)]);
    const before = renderedOrder();
    fireEvent.click(screen.getByTestId(`button-option-${before[2]}`)); // re-render via setSelected
    expect(renderedOrder()).toEqual(before);
  });

  it("serves order-dependent questions in canonical order", async () => {
    await startSitting([MCQ("Q1", { A: "one", B: "two", C: "three", D: "four", E: "None of the above" })]);
    expect(renderedOrder()).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("highlights the correct row at reveal by letter, not by position", async () => {
    await startSitting([MCQ("Q1", OPTS)]);
    fireEvent.click(screen.getByTestId("button-option-B")); // wrong on purpose
    fireEvent.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");
    // The green tick sits on canonical A's row wherever it rendered.
    const correctRow = screen.getByTestId("button-option-A");
    expect(correctRow.className).toContain("border-green-600");
    expect(screen.getByTestId("panel-feedback").textContent).toContain("answer is A");
  });
});
