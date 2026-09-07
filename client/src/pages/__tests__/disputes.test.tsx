// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { AppRouter, useHashLocationNoQuery } from "@/App";

// THE DISPUTES PAGE — human triage of the corpus's contested questions.
//
// Disputed questions never enter a study session until they are accepted,
// fixed or discarded here, so this page is the only way back into rotation.
// Every verdict is one POST to /api/mcqs/:id/triage, and the whole page reads
// from one payload, ["/api/mcqs/triage"] — counts, progress and rows alike.
// The app's query client runs with staleTime: Infinity and no focus refetch
// (queryClient.ts), so nothing on this page updates by itself: a verdict
// that does not invalidate the queue leaves the "Pending N" chip, the
// progress bar and the row it just resolved all showing the snapshot taken
// before the click, until a full reload.
//
// These tests drive the REAL page against a stubbed fetch whose triage
// payload changes only when a verdict is POSTed — so a stale snapshot is
// distinguishable from a real refetch.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); queryClient.clear(); });

type Status = "pending" | "accepted" | "fixed" | "discarded";

const mkItem = (id: string, code: string, triageStatus: Status = "pending") => ({
  id, code, displayCode: code, topicFile: "MCQ-GI.txt",
  topicName: "Gastrointestinal", topicSlug: "gastrointestinal", domain: "gi", section: null, papers: ["2019-A"],
  stem: `Stem for ${code}`, options: { A: "one", B: "two", C: "three", D: "four", E: "five" },
  answer: "A", reason: `Why ${code} is contested: the key may be B.`, urls: [], disputed: true, parentCode: null,
  figure: null, loCodes: [], edited: false, excluded: false, triageStatus,
});

interface StubState {
  triageCalls: number;
  posts: Array<{ method: string; url: string; body: unknown }>;
  items: ReturnType<typeof mkItem>[];
}

/** The server as the page sees it: verdicts move an item's status, and the
 *  triage payload is recomputed from the items on every GET. */
function stub(initial: ReturnType<typeof mkItem>[] = [mkItem("gi__Q1", "Q1"), mkItem("gi__Q2", "Q2")]): StubState {
  const s: StubState = { triageCalls: 0, posts: [], items: initial.map((i) => ({ ...i })) };
  const counts = () => {
    const c = { pending: 0, accepted: 0, fixed: 0, discarded: 0, total: s.items.length };
    for (const it of s.items) c[it.triageStatus] += 1;
    return c;
  };
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const path = url.split("?")[0];
    const method = String(init?.method ?? "GET").toUpperCase();
    const parsed = init?.body ? JSON.parse(init.body) : undefined;
    if (method !== "GET") s.posts.push({ method, url, body: parsed });
    let body: unknown = {};
    const triageMatch = path.match(/\/api\/mcqs\/([^/]+)\/triage$/);
    if (path.endsWith("/api/mcqs/triage")) {
      s.triageCalls++;
      body = { counts: counts(), items: s.items };
    } else if (triageMatch && method === "POST") {
      const item = s.items.find((i) => i.id === decodeURIComponent(triageMatch[1]))!;
      const action = (parsed as { action: string }).action;
      item.triageStatus = action === "accept" ? "accepted" : action === "discard" ? "discarded" : action === "fix" ? "fixed" : "pending";
      if (action !== "reopen") item.disputed = false; else item.disputed = true;
      body = item;
    } else if (method === "PATCH" && path.includes("/api/mcqs/")) {
      // The Fix… editor's save: the override lands, the dispute clears, the
      // status derives as fixed.
      const id = decodeURIComponent(path.split("/api/mcqs/")[1]);
      const item = s.items.find((i) => i.id === id)!;
      Object.assign(item, parsed, { edited: true });
      if (parsed && parsed.disputed === false) item.triageStatus = "fixed";
      body = item;
    }
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
  }));
  return s;
}

function mount() {
  window.history.replaceState(null, "", "/#/disputes");
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocationNoQuery}><AppRouter /></Router>
    </QueryClientProvider>,
  );
}

const verdictPosts = (s: StubState) => s.posts.filter((p) => p.method === "POST" && /\/api\/mcqs\/[^/]+\/triage$/.test(p.url.split("?")[0]));

describe("disputes page — the queue and its promise", () => {
  it("lists the pending rows with counts and says why they are here", async () => {
    stub();
    mount();
    expect(await screen.findByTestId("triage-row-gi__Q1")).toBeTruthy();
    expect(screen.getByTestId("triage-row-gi__Q2")).toBeTruthy();
    expect(screen.getByTestId("text-triage-progress").textContent).toContain("0 of 2 triaged");
    expect(screen.getByTestId("filter-status-pending").textContent).toContain("2");
    expect(screen.getByTestId("status-gi__Q1").textContent).toContain("Pending");
    // The contract with the Study page, stated on the page itself.
    expect(document.body.textContent).toMatch(/never enter a study session until they are accepted, fixed or discarded/);
  });

  it("expand shows the dispute reason for that row", async () => {
    stub();
    mount();
    await screen.findByTestId("triage-row-gi__Q1");
    expect(screen.queryByTestId("reason-gi__Q1")).toBeNull();
    fireEvent.click(screen.getByTestId("button-expand-gi__Q1"));
    expect((await screen.findByTestId("reason-gi__Q1")).textContent).toContain("Why Q1 is contested");
    // Only the row that was opened.
    expect(screen.queryByTestId("reason-gi__Q2")).toBeNull();
  });

  it("without an AI key the bulk lane is offered but disabled, and nothing polls or sweeps on its own", async () => {
    // The stub answers /api/mcqs/audit/status with {} — no key, nothing
    // running — which is what a server without OPENAI_API_KEY looks like to
    // this page.
    const s = stub();
    mount();
    await screen.findByTestId("triage-row-gi__Q1");
    // Two pending disputes, no verdicts: the adjudicate button is there,
    // disabled, and says why. Nothing is resolvable, so no Resolve button.
    const adj = await screen.findByTestId("button-adjudicate");
    expect(adj.textContent).toContain("Adjudicate 2 undecided");
    expect((adj as HTMLButtonElement).disabled).toBe(true);
    expect(adj.getAttribute("title")).toContain("OPENAI_API_KEY");
    expect(screen.queryByTestId("button-resolve-all")).toBeNull();
    expect(screen.queryByTestId("triage-adjudicating")).toBeNull();
    // Everything on the page is one of these: the header, the counts and
    // filters, the bulk lane, and a row's own controls. Any extra lane adds a
    // testid that is not in this list.
    const allowed = [
      /^text-page-title$/, /^link-to-quality$/, /^text-triage-progress$/, /^filter-status-/, /^select-triage-topic$/,
      /^button-adjudicate$/, /^button-resolve-all/, /^triage-bulk-none$/, /^triage-adjudicating$/, /^adjudication-/,
      /^triage-row-/, /^button-expand-/, /^status-/, /^reason-/,
      /^button-accept-/, /^button-fix-/, /^button-discard-/, /^button-reopen-/,
      /^text-triage-empty$/,
    ];
    const ids = Array.from(document.querySelectorAll("[data-testid]")).map((el) => el.getAttribute("data-testid") ?? "");
    expect(ids).toContain("button-accept-gi__Q1");
    expect(ids.filter((id) => !allowed.some((re) => re.test(id)))).toEqual([]);
    // Until a verdict is given the page reads exactly two things: the queue,
    // and the sweep status — ONCE, since nothing is running and so nothing
    // polls. It never POSTs by itself.
    const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]).replace(/\?.*$/, ""));
    expect(new Set(urls)).toEqual(new Set(["/api/mcqs/triage", "/api/mcqs/audit/status"]));
    expect(urls.filter((u) => u.endsWith("/api/mcqs/audit/status"))).toHaveLength(1);
    expect(s.posts.length).toBe(0);
  });
});

describe("disputes page — per-row verdicts refetch the queue", () => {
  it("Accept POSTs the verdict, then the row leaves Pending and the counts move", async () => {
    const s = stub();
    mount();
    await screen.findByTestId("triage-row-gi__Q1");
    await waitFor(() => expect(s.triageCalls).toBe(1));

    fireEvent.click(screen.getByTestId("button-accept-gi__Q1"));
    await waitFor(() => expect(verdictPosts(s).length).toBe(1));
    expect(verdictPosts(s)[0].url).toContain("/api/mcqs/gi__Q1/triage");
    expect(verdictPosts(s)[0].body).toEqual({ action: "accept" });

    // staleTime: Infinity means nothing refetches the queue on its own — the
    // verdict has to invalidate it.
    await waitFor(() => expect(s.triageCalls).toBeGreaterThanOrEqual(2));
    // The pending filter is the default view: the accepted row is gone from
    // it, Q2 is still waiting, and the progress line says so.
    await waitFor(() => expect(screen.queryByTestId("triage-row-gi__Q1")).toBeNull());
    expect(screen.getByTestId("triage-row-gi__Q2")).toBeTruthy();
    expect(screen.getByTestId("text-triage-progress").textContent).toContain("1 of 2 triaged");
    expect(screen.getByTestId("filter-status-pending").textContent).toContain("1");
    expect(screen.getByTestId("filter-status-accepted").textContent).toContain("1");
  });

  it("Discard POSTs discard and refetches", async () => {
    const s = stub();
    mount();
    await screen.findByTestId("triage-row-gi__Q2");
    fireEvent.click(screen.getByTestId("button-discard-gi__Q2"));
    await waitFor(() => expect(verdictPosts(s).length).toBe(1));
    expect(verdictPosts(s)[0].url).toContain("/api/mcqs/gi__Q2/triage");
    expect(verdictPosts(s)[0].body).toEqual({ action: "discard" });
    await waitFor(() => expect(s.triageCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByTestId("triage-row-gi__Q2")).toBeNull());
    expect(screen.getByTestId("filter-status-discarded").textContent).toContain("1");
  });

  it("a resolved row offers Reopen, which POSTs reopen and brings it back to Pending", async () => {
    const s = stub([mkItem("gi__Q1", "Q1", "accepted"), mkItem("gi__Q2", "Q2")]);
    mount();
    // Resolved rows live behind their own status chip.
    await screen.findByTestId("triage-row-gi__Q2");
    expect(screen.queryByTestId("triage-row-gi__Q1")).toBeNull();
    fireEvent.click(screen.getByTestId("filter-status-accepted"));
    const row = await screen.findByTestId("triage-row-gi__Q1");
    expect(row.querySelector('[data-testid="button-accept-gi__Q1"]')).toBeNull();
    expect(screen.getByTestId("status-gi__Q1").textContent).toContain("Accepted");

    fireEvent.click(screen.getByTestId("button-reopen-gi__Q1"));
    await waitFor(() => expect(verdictPosts(s).length).toBe(1));
    expect(verdictPosts(s)[0].body).toEqual({ action: "reopen" });
    await waitFor(() => expect(s.triageCalls).toBeGreaterThanOrEqual(2));
    // Under the Accepted filter the reopened row is gone; Pending counts it again.
    await waitFor(() => expect(screen.queryByTestId("triage-row-gi__Q1")).toBeNull());
    expect(screen.getByTestId("filter-status-pending").textContent).toContain("2");
  });

  it("Fix… opens the editor with the dispute pre-cleared; saving PATCHes only that and refetches", async () => {
    const s = stub();
    mount();
    await screen.findByTestId("triage-row-gi__Q1");
    fireEvent.click(screen.getByTestId("button-fix-gi__Q1"));
    await screen.findByTestId("dialog-mcq-edit");
    // resolveDisputeOnSave seeds the toggle OFF: a plain correct-and-save
    // clears the dispute instead of leaving the item pending forever.
    expect(screen.getByTestId("switch-edit-disputed").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByTestId("button-save-edit"));
    const patch = await waitFor(() => {
      const p = s.posts.find((x) => x.method === "PATCH");
      expect(p).toBeTruthy();
      return p!;
    });
    // Changed fields only — the untouched stem/options/answer/reason stay out
    // of the override, so a later corpus correction still reaches them.
    expect(patch.url).toContain("/api/mcqs/gi__Q1");
    expect(patch.body).toEqual({ disputed: false });
    expect(verdictPosts(s).length).toBe(0); // the editor IS the fix path; no separate verdict POST

    await waitFor(() => expect(s.triageCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByTestId("triage-row-gi__Q1")).toBeNull());
    expect(screen.getByTestId("filter-status-fixed").textContent).toContain("1");
    expect(screen.getByTestId("text-triage-progress").textContent).toContain("1 of 2 triaged");
  });

  it("clearing the queue reads as done, not as an empty filter", async () => {
    const s = stub([mkItem("gi__Q1", "Q1")]);
    mount();
    await screen.findByTestId("triage-row-gi__Q1");
    fireEvent.click(screen.getByTestId("button-accept-gi__Q1"));
    await waitFor(() => expect(s.triageCalls).toBeGreaterThanOrEqual(2));
    expect((await screen.findByTestId("text-triage-empty")).textContent).toContain("Queue clear");
  });
});
