// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { AppRouter, useHashLocationNoQuery } from "@/App";
import { saveStudySnapshot, loadStudySnapshot, type StudySnapshot } from "@/pages/Study";

// ---------------------------------------------------------------------------
// Study sessions survive refresh/navigation. The whole run used to live only
// in useState: one pull-to-refresh, or any sidebar tap, silently destroyed a
// 100-question paper — and a TEST sitting never reached /finish, so it never
// showed under Recent sessions with its score. The runner now snapshots to
// sessionStorage and the page offers an explicit resume. Pre-fix code had no
// snapshot and no banner: every test here fails on it.
// ---------------------------------------------------------------------------

const MCQ = (id: string, stem: string) => ({
  id, code: id, displayCode: id, topicFile: "t", topicName: "Topic", topicSlug: "t",
  domain: "physiology", section: null, papers: [], stem,
  options: { A: "a", B: "b", C: "c", D: "d", E: "e" },
  answer: "A", reason: "because", urls: [], disputed: false, parentCode: null,
  loCodes: [], edited: false,
});

const SNAPSHOT: StudySnapshot = {
  session: {
    sessionId: "sess-resume-1",
    mode: "tutor",
    mcqs: [MCQ("Q1", "First stem — already answered"), MCQ("Q2", "Second stem — resumes here")] as any,
    timeLimitSec: null,
  } as any,
  idx: 1,
  answered: [{ mcqId: "Q1", selected: "A", correct: true }],
  sessionStartMs: Date.now() - 60_000,
};

function stubFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    urls.push(String(input));
    return {
      ok: true, status: 200,
      async json() { return {}; },
      async text() { return "{}"; },
    } as any;
  }));
  return urls;
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

let fetched: string[] = [];

beforeEach(() => {
  // The Study page renders a Radix slider (time-limit picker) that observes
  // its track size; jsdom has no ResizeObserver.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.sessionStorage.clear();
  queryClient.clear();
  fetched = stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("mid-session persistence and resume", () => {
  it("a saved snapshot is offered on mount, resumes at the saved question, and Discard clears it", async () => {
    saveStudySnapshot(SNAPSHOT);
    renderStudy();
    const banner = await screen.findByTestId("study-resume-banner");
    expect(banner.textContent).toContain("1 of 2 answered");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("button-study-resume"));
    // The runner picks up at the SAVED index — question 2, not question 1.
    expect(await screen.findByText(/Second stem — resumes here/)).toBeTruthy();
    expect(screen.queryByText(/First stem — already answered/)).toBeNull();
  });

  it("Discard clears the snapshot and the banner", async () => {
    saveStudySnapshot(SNAPSHOT);
    renderStudy();
    await screen.findByTestId("study-resume-banner");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("button-study-discard"));
    expect(screen.queryByTestId("study-resume-banner")).toBeNull();
    expect(loadStudySnapshot()).toBeNull();
  });

  it("no snapshot — no banner (fresh visits stay clean)", async () => {
    renderStudy();
    expect(await screen.findByTestId("page-study")).toBeTruthy();
    expect(screen.queryByTestId("study-resume-banner")).toBeNull();
  });

  it("the page is reachable at both '/' and '/study'", async () => {
    // "/study" is a bookmark or deep link from the old address; "/" is the
    // landing route. Both must land on the same page — a 404 at either would
    // strand a saved snapshot behind a URL that no longer resolves.
    window.history.replaceState(null, "", "/#/");
    render(
      <QueryClientProvider client={queryClient}>
        <Router hook={useHashLocationNoQuery}><AppRouter /></Router>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("page-study")).toBeTruthy();
  });

  it("asks this app's API for its own data and nothing else's", async () => {
    // A standalone MCQ site: the page must not reach for the viva corpus (or
    // any other tracker surface) that used to sit beside it. Every request
    // it makes is to an endpoint in this app's contract.
    renderStudy();
    await screen.findByTestId("page-study");
    await waitFor(() => expect(fetched.some((u) => u.includes("/api/mcqs/stats"))).toBe(true));
    expect(fetched.some((u) => u.includes("/api/viva"))).toBe(false);
    const own = /^\/api\/(mcqs(\/|$)|settings$|auth\/status$|build$)/;
    const stray = fetched.map((u) => u.replace(/\?.*$/, "")).filter((u) => !own.test(u));
    expect(stray).toEqual([]);
  });
});

describe("a sitting the server no longer has", () => {
  it("finishing after a reset/restore (404) drops the snapshot and returns to the start instead of 'press Finish again'", async () => {
    // Settings → Reset progress or Restore from backup replaces the session
    // rows while a sitting is open in this tab. Its /finish then 404s for
    // ever; the old toast said to press Finish again, which could never work,
    // and the resume banner kept offering the dead sitting.
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/api/mcqs/attempt")) {
        const body = { correct: true, correctAnswer: "A", reason: "because" };
        return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
      }
      if (/\/api\/mcqs\/session\/[^/]+\/finish$/.test(url)) {
        return { ok: false, status: 404, async json() { return { error: "Session sess-resume-1 not found" }; }, async text() { return '{"error":"Session sess-resume-1 not found"}'; } } as any;
      }
      return { ok: true, status: 200, async json() { return {}; }, async text() { return "{}"; } } as any;
    }));
    saveStudySnapshot(SNAPSHOT);
    renderStudy();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("button-study-resume"));
    await screen.findByText(/Second stem — resumes here/);

    // Answer the last question and advance — that is the finish.
    await user.click(screen.getByTestId("button-option-A"));
    await user.click(screen.getByTestId("button-submit"));
    await screen.findByTestId("panel-feedback");
    await user.click(screen.getByTestId("button-next"));

    await waitFor(() => expect(urls.some((u) => u.includes("/finish"))).toBe(true));
    // Back at the setup screen, with no dead sitting on offer.
    await screen.findByTestId("button-start-session");
    expect(screen.queryByTestId("study-resume-banner")).toBeNull();
    expect(loadStudySnapshot()).toBeNull();
  });
});
