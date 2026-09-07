// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { useHashLocationNoQuery } from "@/App";
import DisputesPage from "@/pages/Disputes";

// The Disputes page's bulk lane: adjudicate the undecided, then resolve what
// the examiner decided — with numbers that promise exactly what the server
// will do (confirm_key or applicable change_answer resolve; ambiguous stays).

afterEach(() => { cleanup(); vi.unstubAllGlobals(); queryClient.clear(); });

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
}

const mkItem = (id: string, code: string) => ({
  id, code, displayCode: code, topicFile: "MCQ-GI.txt",
  topicName: "Gastrointestinal", topicSlug: "gastrointestinal", domain: "gi", section: null, papers: [],
  stem: `Stem for ${code}`, options: { A: "one", B: "two", C: "three", D: "four", E: "five" },
  answer: "A", reason: "because", urls: [], disputed: true, parentCode: null,
  figure: null, loCodes: [], edited: false, excluded: false, triageStatus: "pending",
});

function stub() {
  const calls: Array<{ method: string; path: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const path = url.split("?")[0];
    calls.push({ method: init?.method ?? "GET", path });
    let body: unknown = {};
    if (path.endsWith("/api/mcqs/triage")) body = {
      counts: { pending: 3, accepted: 0, fixed: 0, discarded: 0, total: 3 },
      items: [mkItem("gi__Q1", "Q1"), mkItem("gi__Q2", "Q2"), mkItem("gi__Q3", "Q3")],
      adjudications: {
        gi__Q1: { verdict: "confirm_key", suggestedAnswer: "A", applicable: false, stale: false },
        gi__Q2: { verdict: "change_answer", suggestedAnswer: "B", applicable: true, stale: false },
        // Q3 has no adjudication -> undecided.
      },
    };
    else if (path.endsWith("/api/mcqs/audit/status")) body = {
      running: false, progress: { running: false, done: 0, total: 0 },
      pending: 0, total: 3, counts: { poor: 0, weak: 0, good: 0, handled: 0, applicable: 0 },
      lastError: "", keyPresent: true, model: "stub",
    };
    else if (path.endsWith("/api/mcqs/triage/resolve-all")) body = { accepted: 1, fixed: 1, left: 0, unadjudicated: 1, failed: [] };
    else if (path.endsWith("/api/mcqs/triage/adjudicate")) body = { kicked: true };
    return jsonResponse(body);
  }));
  return calls;
}

function mount() {
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocationNoQuery}><DisputesPage /></Router>
    </QueryClientProvider>,
  );
}

describe("Disputes page — bulk lane", () => {
  it("counts undecided and resolvable from the same predicates the server acts with", async () => {
    stub();
    mount();
    // Q3 has no verdict -> 1 undecided; Q1 (confirm) + Q2 (applicable change) -> 2 resolvable.
    expect((await screen.findByTestId("button-adjudicate")).textContent).toContain("Adjudicate 1 undecided");
    expect((await screen.findByTestId("button-resolve-all")).textContent).toContain("Resolve 2 adjudicated");
  });

  it("badges each pending row with what resolution will DO to it", async () => {
    stub();
    mount();
    expect((await screen.findByTestId("adjudication-gi__Q1")).textContent).toContain("resolves as Accept");
    const fix = await screen.findByTestId("adjudication-gi__Q2");
    expect(fix.textContent).toContain("resolves as Fix");
    expect(fix.textContent).toContain("→ B");
    expect(screen.queryByTestId("adjudication-gi__Q3")).toBeNull();
  });

  it("adjudicate posts the scoped sweep; resolve takes a second click then posts resolve-all", async () => {
    const calls = stub();
    mount();
    fireEvent.click(await screen.findByTestId("button-adjudicate"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/api/mcqs/triage/adjudicate"))).toBe(true));

    fireEvent.click(await screen.findByTestId("button-resolve-all"));
    expect(calls.some((c) => c.path.endsWith("/resolve-all"))).toBe(false); // armed, not fired
    fireEvent.click(await screen.findByTestId("button-resolve-all-confirm"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/api/mcqs/triage/resolve-all"))).toBe(true));
  });

  it("cross-links to the Quality page with a real hash href", async () => {
    stub();
    mount();
    const link = await screen.findByTestId("link-to-quality");
    expect(link.getAttribute("href")).toBe("#/quality");
  });
});
