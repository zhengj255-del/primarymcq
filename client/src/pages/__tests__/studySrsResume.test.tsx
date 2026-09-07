// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { AppRouter, useHashLocationNoQuery } from "@/App";
import { saveStudySnapshot, loadStudySnapshot } from "@/pages/Study";

// Spaced review is not a session, so there is nothing to resume: the queue is
// derived from due state, and reopening rebuilds whatever is still due. Only
// test/tutor sittings — random draws that cannot be reconstructed — are
// snapshotted. This also retires the whole "resume landed past the end of the
// queue" failure mode, since an SRS "Again" no longer has a stale list to
// disagree with.

const MCQ = (id: string, stem: string) => ({
  id, code: id, displayCode: id, topicFile: "t", topicName: "Topic", topicSlug: "t",
  domain: "physiology", section: null, papers: [], stem,
  options: { A: "a", B: "b", C: "c", D: "d", E: "e" },
  answer: "A", reason: "because", urls: [], disputed: false, parentCode: null,
  loCodes: [], edited: false,
});

let sessionBody: any;
let queueStatsFetches = 0;

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const path = String(input).split("?")[0];
    let body: unknown = {};
    if (path.endsWith("/api/mcqs/stats")) body = { total: 10, withAnswer: 10, byTopic: [{ slug: "t", name: "Topic", domain: "physiology", count: 10 }], papers: [] };
    else if (path.endsWith("/api/mcqs/weak-areas")) body = { items: [] };
    else if (path.endsWith("/api/mcqs/srs/queue-stats")) {
      queueStatsFetches++;
      body = { learning: 0, reviews: 2, dueReviews: 2, newToday: 0, newAvailable: 0,
        limits: { newPerDay: 20, maxReviewsPerDay: 200, newRemaining: 20, reviewsRemaining: 200 } };
    }
    else if (path.endsWith("/api/mcqs/session")) body = sessionBody;
    else if (path.endsWith("/api/mcqs/attempt")) {
      // Grade honestly (answer is "A"): wrong answers get Again only.
      const posted = JSON.parse(init?.body ?? "{}");
      body = {
        correct: posted.selected === "A", correctAnswer: "A", reason: "because",
        srsPreview: { again: 0, hard: 1, good: 2, easy: 8 },
      };
    }
    else if (path.endsWith("/api/mcqs/srs/rate")) body = { dueAt: Date.now(), intervalDays: 0, stability: 1, difficulty: 5, reps: 1 };
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
  }));
}

function renderStudy() {
  window.history.replaceState(null, "", "/#/study");
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocationNoQuery}><AppRouter /></Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.sessionStorage.clear();
  queryClient.clear();
  queueStatsFetches = 0;
  // SRS: the server hands back a queue with NO session id.
  sessionBody = { sessionId: null, mode: "srs", timeLimitSec: null, mcqs: [MCQ("Q1", "First stem"), MCQ("Q2", "Second stem")] };
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("spaced review is not a session", () => {
  it("writes no resume snapshot, even after an Again requeue", async () => {
    const user = userEvent.setup();
    renderStudy();
    await user.click(await screen.findByTestId("button-start-session"));

    await user.click(await screen.findByTestId("button-option-B"));
    await user.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");
    await user.click(screen.getByTestId("button-rate-again"));
    await screen.findByText("Second stem");

    expect(loadStudySnapshot()).toBeNull();

    // A refresh therefore offers no resume — the queue rebuilds from due state.
    cleanup();
    queryClient.clear();
    renderStudy();
    await screen.findByTestId("srs-queue-stats");
    expect(screen.queryByTestId("study-resume-banner")).toBeNull();
  });

  it("a snapshot left by an older build is discarded, not offered", async () => {
    saveStudySnapshot({
      session: { sessionId: "old-srs", mode: "srs", mcqs: [MCQ("Q1", "First stem")] as any, timeLimitSec: null } as any,
      idx: 5,
      answered: [{ mcqId: "Q1", selected: "A", correct: true }],
      sessionStartMs: Date.now() - 60_000,
    });
    renderStudy();
    await screen.findByTestId("srs-queue-stats");
    expect(screen.queryByTestId("study-resume-banner")).toBeNull();
  });

  it("ending a sitting refreshes the queue counts instead of scoring it", async () => {
    const user = userEvent.setup();
    renderStudy();
    await screen.findByTestId("srs-queue-stats");
    const before = queueStatsFetches;

    await user.click(screen.getByTestId("button-start-session"));
    await user.click(await screen.findByTestId("button-option-A"));
    await user.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");
    await user.click(screen.getByTestId("button-rate-good"));
    await user.click(await screen.findByTestId("button-option-A"));
    await user.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");
    await user.click(screen.getByTestId("button-rate-good"));

    // Back on the deck screen with FRESH counts — no scored summary anywhere.
    await screen.findByTestId("srs-queue-stats");
    expect(queueStatsFetches).toBeGreaterThan(before);
    expect(screen.queryByTestId("section-summary")).toBeNull();
  });

  it("test mode still snapshots — a random draw cannot be rebuilt", async () => {
    sessionBody = { sessionId: "sess-tutor", mode: "tutor", timeLimitSec: null, mcqs: [MCQ("Q1", "First stem"), MCQ("Q2", "Second stem")] };
    const user = userEvent.setup();
    renderStudy();
    await user.click(await screen.findByTestId("button-mode-tutor"));
    await user.click(await screen.findByTestId("button-start-session"));
    await screen.findByText("First stem");
    expect(loadStudySnapshot()?.session.sessionId).toBe("sess-tutor");
  });
});
