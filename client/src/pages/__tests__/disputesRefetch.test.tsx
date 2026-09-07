// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { useHashLocationNoQuery } from "@/App";
import DisputesPage from "@/pages/Disputes";

// THE SWEEP ENDS AND THE DISPUTES PAGE MUST NOTICE.
//
// The adjudication sweep is fire-and-forget: the POST returns immediately and
// the only thing the page watches afterwards is the shared status poll. The
// verdicts themselves ride on ["/api/mcqs/triage"] — the same payload as the
// items and the counts — and the app's query client runs with
// staleTime: Infinity + refetchOnWindowFocus: false (queryClient.ts). So when
// `running` falls back to false the badges, the "Adjudicate N undecided" count
// and the "Resolve N adjudicated" button would keep rendering the snapshot
// taken BEFORE the sweep ran, until a row action or a full reload — unless the
// page refetches on that falling edge.
//
// These tests drive the REAL page against a stubbed fetch whose status endpoint
// flips running true → false on the second poll, and whose triage payload gains
// the verdicts the sweep stored.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); queryClient.clear(); });

const mkItem = (id: string, code: string) => ({
  id, code, displayCode: code, topicFile: "MCQ-GI.txt",
  topicName: "Gastrointestinal", topicSlug: "gastrointestinal", domain: "gi", section: null, papers: [],
  stem: `Stem for ${code}`, options: { A: "one", B: "two", C: "three", D: "four", E: "five" },
  answer: "A", reason: "because", urls: [], disputed: true, parentCode: null,
  figure: null, loCodes: [], edited: false, excluded: false, triageStatus: "pending",
});

const COUNTS = { pending: 2, accepted: 0, fixed: 0, discarded: 0, total: 2 };
const ITEMS = [mkItem("gi__Q1", "Q1"), mkItem("gi__Q2", "Q2")];

// What the sweep stores: both pending disputes get a fresh, resolvable verdict.
const ADJUDICATED = {
  gi__Q1: { verdict: "confirm_key", suggestedAnswer: "A", applicable: false, stale: false },
  gi__Q2: { verdict: "change_answer", suggestedAnswer: "B", applicable: true, stale: false },
};

interface StubState {
  statusCalls: number;
  triageCalls: number;
}

/** Status reports running:true on the first look and false from the second on
 *  — the falling edge the page has to act on. The triage payload only carries
 *  the verdicts once that second status call has happened, so a stale snapshot
 *  is distinguishable from a real refetch. */
function stub(): StubState {
  const s: StubState = { statusCalls: 0, triageCalls: 0 };
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const path = String(input).split("?")[0];
    let body: unknown = {};
    if (path.endsWith("/api/mcqs/audit/status")) {
      s.statusCalls++;
      const running = s.statusCalls < 2;
      body = {
        running, progress: { running, done: running ? 1 : 2, total: 2 },
        pending: 0, total: 2, counts: { poor: 0, weak: 0, good: 0, handled: 0, applicable: 0 },
        lastError: "", keyPresent: true, model: "stub",
      };
    } else if (path.endsWith("/api/mcqs/triage")) {
      s.triageCalls++;
      body = { counts: COUNTS, items: ITEMS, adjudications: s.statusCalls >= 2 ? ADJUDICATED : {} };
    }
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
  }));
  return s;
}

function mount() {
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocationNoQuery}><DisputesPage /></Router>
    </QueryClientProvider>,
  );
}

describe("Disputes page — refetch when the sweep ends", () => {
  it("re-fetches the triage payload on the running → finished edge", async () => {
    const s = stub();
    mount();

    // Snapshot taken while the sweep is running: no verdicts yet.
    await screen.findByTestId("triage-adjudicating");
    await waitFor(() => expect(s.triageCalls).toBe(1));

    // The 3 s status poll observes the run finishing.
    await waitFor(() => expect(s.statusCalls).toBeGreaterThanOrEqual(2), { timeout: 10000 });

    // staleTime: Infinity means nothing refetches the queue on its own.
    await waitFor(() => expect(s.triageCalls).toBeGreaterThanOrEqual(2), { timeout: 10000 });
  });

  it("shows the verdicts the sweep stored without a reload", async () => {
    stub();
    mount();

    await screen.findByTestId("triage-adjudicating");

    // Badges say what bulk resolution will DO with each row; the bulk lane
    // swaps "Adjudicate N undecided" for "Resolve N adjudicated".
    expect((await screen.findByTestId("adjudication-gi__Q1", undefined, { timeout: 10000 })).textContent)
      .toContain("resolves as Accept");
    expect((await screen.findByTestId("adjudication-gi__Q2")).textContent).toContain("resolves as Fix");
    expect((await screen.findByTestId("button-resolve-all")).textContent).toContain("Resolve 2 adjudicated");
    expect(screen.queryByTestId("button-adjudicate")).toBeNull();
  });
});
