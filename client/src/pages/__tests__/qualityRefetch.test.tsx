// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { useHashLocationNoQuery } from "@/App";
import QualityPage from "@/pages/Quality";

// THE SWEEP ENDS AND THE QUALITY PAGE MUST NOTICE.
//
// The audit sweep is fire-and-forget: POST /audit/run returns before a single
// verdict exists, and the only thing that learns the run has ended is the 3 s
// status poll. The verdict queue rides on ["/api/mcqs/audit", band, topic] with
// `refetchInterval: () => (running ? 4000 : false)`, so the LAST list poll can
// be up to 4 s older than the sweep's final writes, and the moment `running`
// flips false that interval is cleared — under the app's staleTime: Infinity /
// refetchOnWindowFocus: false client (lib/queryClient.ts) nothing ever fetches
// it again. Without a falling-edge invalidation the queue renders the
// mid-sweep snapshot until a row action or a full reload.
//
// These tests drive the REAL page against a stubbed fetch whose status endpoint
// flips running true → false on the second poll, and whose list payload only
// then carries the verdicts the tail of the sweep stored.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); queryClient.clear(); });

const mkMcq = (id: string, code: string) => ({
  id, code, displayCode: code, topicFile: "MCQ-Acid-Base.txt",
  topicName: "Acid-Base", topicSlug: "acid-base", domain: "resp", section: null, papers: [],
  stem: `Stem for ${code}`, options: { A: "one", B: "two", C: "three", D: "four", E: "five" },
  answer: "C", reason: "old reason", urls: [], disputed: false, parentCode: null,
  figure: null, loCodes: [], edited: false, excluded: false,
});
const AUDIT = {
  verdict: "change_answer", confidence: "high", suggestedAnswer: "B",
  correctedReason: "because B", disputeNote: "key looks wrong", suggestedStem: null,
  suggestedOptions: null, model: "stub", assessedAt: 1, status: "suggested",
};
const row = (id: string, code: string) => ({ mcq: mkMcq(id, code), audit: AUDIT, applicable: true, stale: false });

// Mid-sweep the queue holds one verdict; the tail of the run stores a second.
const DURING = [row("acid-base__AD01", "AD01")];
const AFTER = [row("acid-base__AD01", "AD01"), row("acid-base__AD02", "AD02")];

interface StubState { statusCalls: number; listCalls: number }

/** running:true on the first look, false from the second on — the falling edge
 *  the page has to act on. The list payload only grows once that second status
 *  call has happened, so a stale snapshot is distinguishable from a refetch. */
function stub(): StubState {
  const s: StubState = { statusCalls: 0, listCalls: 0 };
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const path = String(input).split("?")[0];
    let body: unknown = {};
    if (path.endsWith("/api/mcqs/audit/status")) {
      s.statusCalls++;
      const running = s.statusCalls < 2;
      body = {
        running, progress: { running, done: running ? 1 : 2, total: 2 },
        pending: running ? 1 : 0, total: 2,
        counts: { poor: running ? 1 : 2, weak: 0, good: 0, handled: 0, applicable: running ? 1 : 2 },
        lastError: "", keyPresent: true, model: "stub",
      };
    } else if (path.endsWith("/api/mcqs/audit")) {
      s.listCalls++;
      body = s.statusCalls >= 2 ? { items: AFTER, total: AFTER.length } : { items: DURING, total: DURING.length };
    } else if (path.endsWith("/api/mcqs/stats")) {
      body = { byTopic: [{ slug: "acid-base", name: "Acid-Base", count: 2 }] };
    }
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
  }));
  return s;
}

function mount() {
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocationNoQuery}><QualityPage /></Router>
    </QueryClientProvider>,
  );
}

describe("Quality page — refetch when the sweep ends", () => {
  it("re-fetches the verdict queue on the running → finished edge", async () => {
    const s = stub();
    mount();

    // Snapshot taken while the sweep is running: one verdict in the queue.
    await screen.findByTestId("audit-run-progress");
    await waitFor(() => expect(s.listCalls).toBe(1));

    // The 3 s status poll observes the run finishing.
    await waitFor(() => expect(s.statusCalls).toBeGreaterThanOrEqual(2), { timeout: 10000 });

    // The 4 s list poll cannot be what fetches again: it is cleared by the very
    // render that flips `running` false, a second before it would next fire.
    // So a second list fetch here is the falling-edge invalidation and nothing
    // else — without it staleTime: Infinity leaves the queue frozen forever.
    await waitFor(() => expect(s.listCalls).toBeGreaterThanOrEqual(2), { timeout: 10000 });
  });

  it("shows the verdicts the tail of the sweep stored without a reload", async () => {
    stub();
    mount();

    await screen.findByTestId("audit-row-acid-base__AD01");
    await screen.findByTestId("audit-row-acid-base__AD02", undefined, { timeout: 10000 });
  });
});
