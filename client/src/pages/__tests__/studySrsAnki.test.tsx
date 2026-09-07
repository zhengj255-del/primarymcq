// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { AppRouter, useHashLocationNoQuery } from "@/App";

// SRS mode is Anki-style spaced review, not a quiz builder. The setup screen
// shows the day's new/learning/review numbers and a Study button; the
// quiz-shaping controls (completion, question count, weak topics, past paper)
// exist only in test/tutor. In-session, an Again rating requeues the question
// into the SAME sitting — the learning step — so the sitting ends only when
// it's passed.

const MCQ = (id: string, stem: string) => ({
  id, code: id, displayCode: id, topicFile: "t", topicName: "Topic", topicSlug: "t",
  domain: "physiology", section: null, papers: [], stem,
  options: { A: "a", B: "b", C: "c", D: "d", E: "e" },
  answer: "A", reason: "because", urls: [], disputed: false, parentCode: null,
  loCodes: [], edited: false,
});

const QUEUE_STATS = {
  learning: 2, reviews: 3, dueReviews: 5, newToday: 4, newAvailable: 100,
  limits: { newPerDay: 20, maxReviewsPerDay: 200, newRemaining: 20, reviewsRemaining: 200 },
};

function stubFetch(queueStats: typeof QUEUE_STATS = QUEUE_STATS) {
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const path = url.split("?")[0];
    calls.push({ method: init?.method ?? "GET", url });
    let body: unknown = {};
    if (path.endsWith("/api/mcqs/stats")) body = { total: 10, withAnswer: 10, byTopic: [{ slug: "t", name: "Topic", domain: "physiology", count: 10 }], papers: [] };
    else if (path.endsWith("/api/mcqs/weak-areas")) body = { items: [] };
    else if (path.endsWith("/api/mcqs/srs/queue-stats")) body = queueStats;
    else if (path.endsWith("/api/mcqs/session")) body = {
      sessionId: "sess-srs-1", mode: "srs", timeLimitSec: null,
      mcqs: [MCQ("Q1", "First stem"), MCQ("Q2", "Second stem")],
    };
    else if (path.endsWith("/api/mcqs/attempt")) {
      // Grade honestly from the posted body (every MCQ stub keys answer "A"):
      // the runner branches on `correct` — wrong answers get Again only.
      const posted = JSON.parse(init?.body ?? "{}");
      body = {
        correct: posted.selected === "A", correctAnswer: "A", reason: "because",
        srsPreview: { again: 0, hard: 1, good: 2, easy: 45 },
      };
    }
    else if (path.endsWith("/api/mcqs/srs/rate")) body = { dueAt: Date.now() + 600000, intervalDays: 0, stability: 0.21, difficulty: 6.41, reps: 1 };
    else if (path.endsWith("/api/mcqs/srs/undo")) body = { mcqId: "Q1", preview: { again: 0, hard: 1, good: 2, easy: 45 } };
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
  }));
  return calls;
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

describe("SRS setup — spaced review, not a quiz builder", () => {
  it("shows the day's new/learning/review counts and a Study button", async () => {
    const calls = stubFetch();
    renderStudy();
    const strip = await screen.findByTestId("srs-queue-stats");
    expect(strip).toBeTruthy();
    expect((await screen.findByTestId("srs-count-new")).textContent).toContain("4");
    expect((await screen.findByTestId("srs-count-learning")).textContent).toContain("2");
    expect((await screen.findByTestId("srs-count-due")).textContent).toContain("3");
    // 5 due, 3 served -> the overflow is named, not hidden.
    expect(strip.textContent).toContain("2 due beyond today's 200-review limit");
    expect(screen.getByTestId("button-start-session").textContent).toContain("Study");
    // The setup panel draws on this app's own endpoints only — there is no
    // viva corpus beside it any more, so nothing may ask for one.
    expect(calls.some((c) => c.url.includes("/api/viva"))).toBe(false);
  });

  it("hides the quiz controls in SRS mode but keeps them for tutor", async () => {
    stubFetch();
    renderStudy();
    await screen.findByTestId("srs-queue-stats");
    expect(screen.queryByTestId("chip-completion-all")).toBeNull();
    expect(screen.queryByTestId("slider-count")).toBeNull();
    expect(screen.queryByTestId("toggle-weak-areas")).toBeNull();
    expect(screen.queryByTestId("select-paper")).toBeNull();
    // The exclude-disputed toggle is gone in EVERY mode: disputed questions
    // are always excluded and come back via the Disputes page.
    expect(screen.queryByTestId("toggle-exclude-disputed")).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByTestId("button-mode-tutor"));
    expect(await screen.findByTestId("chip-completion-all")).toBeTruthy();
    expect(screen.getByTestId("slider-count")).toBeTruthy();
    expect(screen.queryByTestId("srs-queue-stats")).toBeNull();
    expect(screen.queryByTestId("toggle-exclude-disputed")).toBeNull(); // gone in tutor too
  });

  it("an empty queue reads as 'done for today' and disables Study", async () => {
    stubFetch({ ...QUEUE_STATS, learning: 0, reviews: 0, dueReviews: 0, newToday: 0 });
    renderStudy();
    expect(await screen.findByTestId("srs-done-today")).toBeTruthy();
    expect((screen.getByTestId("button-start-session") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SRS sitting — rating buttons carry their consequences", () => {
  it("a CORRECT answer offers all four buttons, each showing its interval", async () => {
    stubFetch();
    renderStudy();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("button-start-session"));
    await user.click(await screen.findByTestId("button-option-A"));
    await user.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");

    expect(screen.getByTestId("button-rate-again").textContent).toContain("10 min");
    expect(screen.getByTestId("button-rate-hard").textContent).toContain("1 d");
    expect(screen.getByTestId("button-rate-good").textContent).toContain("2 d");
    expect(screen.getByTestId("button-rate-easy").textContent).toContain("1.5 mo"); // 45d reads as months
  });

  it("a WRONG answer offers only Again — the answer itself is the grade", async () => {
    stubFetch();
    renderStudy();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("button-start-session"));
    await user.click(await screen.findByTestId("button-option-B"));
    await user.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");

    expect(screen.getByTestId("button-rate-again").textContent).toContain("10 min");
    expect(screen.queryByTestId("button-rate-hard")).toBeNull();
    expect(screen.queryByTestId("button-rate-good")).toBeNull();
    expect(screen.queryByTestId("button-rate-easy")).toBeNull();
    expect(screen.getByTestId("text-wrong-auto-again")).toBeTruthy();
  });

  it("'Don't know' is a failed recall too — Again only", async () => {
    stubFetch();
    renderStudy();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("button-start-session"));
    await user.click(await screen.findByTestId("button-skip")); // "Don't know"
    await screen.findByTestId("panel-feedback");

    expect(screen.getByTestId("button-rate-again")).toBeTruthy();
    expect(screen.queryByTestId("button-rate-good")).toBeNull();
  });
});

describe("SRS sitting — undoing a misclicked rating", () => {
  it("offers Undo after a rating and puts that question back on its rating buttons", async () => {
    const calls = stubFetch();
    renderStudy();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("button-start-session"));

    // No undo before anything has been rated.
    expect(await screen.findByText("First stem")).toBeTruthy();
    expect(screen.queryByTestId("button-undo-rating")).toBeNull();

    // Misclick "Good" on the first question.
    await user.click(screen.getByTestId("button-option-A"));
    await user.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");
    await user.click(screen.getByTestId("button-rate-good"));
    expect(await screen.findByText("Second stem")).toBeTruthy();

    // Undo is now offered — take it.
    await user.click(await screen.findByTestId("button-undo-rating"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/mcqs/srs/undo"))).toBe(true));

    // Back on the misclicked question, answer still revealed, rating buttons
    // live — no need to answer it again.
    expect(await screen.findByText("First stem")).toBeTruthy();
    expect(screen.getByTestId("panel-feedback")).toBeTruthy();
    expect(screen.getByTestId("button-rate-again")).toBeTruthy();
  });

  it("undoing an Again removes the copy it requeued, so the question isn't queued twice", async () => {
    stubFetch();
    renderStudy();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("button-start-session"));
    expect(screen.getByTestId("text-progress").textContent).toContain("2 left today");

    await user.click(screen.getByTestId("button-option-A"));
    await user.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");
    await user.click(screen.getByTestId("button-rate-again"));
    await screen.findByText("Second stem");
    expect(screen.getByTestId("text-progress").textContent).toContain("2 left today"); // queue grew

    await user.click(await screen.findByTestId("button-undo-rating"));
    await screen.findByText("First stem");
    // Requeued copy dropped: back to the original two.
    expect(screen.getByTestId("text-progress").textContent).toContain("2 left today");
    expect(screen.getByTestId("button-rate-again")).toBeTruthy();
  });
});

describe("SRS sitting — the learning step", () => {
  it("rating Again requeues the question into the SAME sitting", async () => {
    stubFetch();
    renderStudy();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("button-start-session"));

    // Q1: reveal, rate Again — it must come back after Q2.
    expect(await screen.findByText("First stem")).toBeTruthy();
    expect(screen.getByTestId("text-progress").textContent).toContain("2 left today");
    await user.click(screen.getByTestId("button-option-B"));
    await user.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");
    await user.click(screen.getByTestId("button-rate-again"));

    // Q2 shows next — and the queue GREW: still 2 left, Anki-style.
    expect(await screen.findByText("Second stem")).toBeTruthy();
    expect(screen.getByTestId("text-progress").textContent).toContain("2 left today");

    // Pass Q2 with Good...
    await user.click(screen.getByTestId("button-option-A"));
    await user.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");
    await user.click(screen.getByTestId("button-rate-good"));

    // ...and the Again-rated Q1 returns to finish the sitting.
    expect(await screen.findByText("First stem")).toBeTruthy();
    expect(screen.getByTestId("text-progress").textContent).toContain("1 left today");
  });
});
