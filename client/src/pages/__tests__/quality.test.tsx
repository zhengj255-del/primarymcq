// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { useHashLocationNoQuery } from "@/App";
import QualityPage from "@/pages/Quality";

// Quality page: run controls honour the server's state (pending count, key
// present, running), the fix queue renders the current-vs-suggested answer,
// and Apply posts to the audit-apply endpoint.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); queryClient.clear(); });

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
}

const MCQ = {
  id: "acid-base__AD03", code: "AD03", displayCode: "AD03", topicFile: "MCQ-Acid-Base.txt",
  topicName: "Acid-Base", topicSlug: "acid-base", domain: "resp", section: null, papers: [],
  stem: "A stem", options: { A: "one", B: "two", C: "three", D: "four", E: "five" },
  answer: "C", reason: "old reason", urls: [], disputed: false, parentCode: null,
  figure: null, loCodes: [], edited: false, excluded: false,
};
const AUDIT = {
  verdict: "change_answer", confidence: "high", suggestedAnswer: "B",
  correctedReason: "because B", disputeNote: "key looks wrong", suggestedStem: null,
  suggestedOptions: null, model: "stub", assessedAt: 1, status: "suggested",
};

function stub(overrides: { pending?: number; keyPresent?: boolean; items?: unknown[]; applicable?: number } = {}) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const path = url.split("?")[0];
    let body: unknown = {};
    if (path.endsWith("/api/mcqs/audit/status")) body = {
      running: false, progress: { running: false, done: 0, total: 0 },
      pending: overrides.pending ?? 5, total: 10,
      counts: { poor: 1, weak: 1, good: 2, handled: 1, applicable: overrides.applicable ?? 1 },
      lastError: "", keyPresent: overrides.keyPresent ?? true, model: "stub",
    };
    else if (path.endsWith("/api/mcqs/audit")) body = { items: overrides.items ?? [{ mcq: MCQ, audit: AUDIT, applicable: true }], total: (overrides.items ?? [1]).length };
    else if (path.endsWith("/audit-apply")) body = { mcq: MCQ, audit: { ...AUDIT, status: "applied" } };
    else if (path.endsWith("/api/mcqs/audit/apply-all")) body = { applied: 1, skipped: 0, failed: [] };
    else if (path.endsWith("/audit-mark-fixed")) body = { audit: { ...AUDIT, status: "applied" } };
    else if (init?.method === "PATCH") body = { ...MCQ, answer: "B", edited: true };
    else if (path.endsWith("/api/mcqs/stats")) body = { byTopic: [{ slug: "acid-base", name: "Acid-Base", count: 3 }] };
    return jsonResponse(body);
  }));
  return calls;
}

function mount() {
  // The app's real Router (hash hook) so <Link> renders production hrefs.
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocationNoQuery}><QualityPage /></Router>
    </QueryClientProvider>,
  );
}

describe("Quality page", () => {
  it("offers the run button with the pending count and renders the fix queue", async () => {
    stub();
    mount();
    const btn = await screen.findByTestId("button-audit-run");
    // The button exists before the status query resolves — wait for the count.
    await waitFor(() => expect(btn.textContent).toContain("Audit 5 unassessed"));
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    const row = await screen.findByTestId(`audit-row-${MCQ.id}`);
    expect(row.textContent).toContain("answer change");
    expect(row.textContent).toContain("suggested");
    expect(row.textContent).toContain("current");
    // A change_answer verdict reads "poor".
    expect((await screen.findByTestId(`band-${MCQ.id}`)).textContent).toBe("poor");
    expect(screen.queryByTestId("audit-no-key")).toBeNull();
  });

  it("disables the run button when nothing is pending", async () => {
    stub({ pending: 0 });
    mount();
    const btn = await screen.findByTestId("button-audit-run");
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
  });

  it("without a key: the run button is disabled and the page says how to turn the AI on — stored verdicts still work", async () => {
    stub({ keyPresent: false });
    mount();
    const btn = await screen.findByTestId("button-audit-run");
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
    expect(btn.getAttribute("title")).toContain("OPENAI_API_KEY");
    expect((await screen.findByTestId("audit-no-key")).textContent).toContain("OPENAI_API_KEY");
    // The queue and its Apply button are unaffected — verdicts are data.
    expect(await screen.findByTestId(`button-apply-${MCQ.id}`)).toBeTruthy();
  });

  it("Fix… opens the editor already in the post-Suggest state; saving stores the edit then marks the verdict fixed", async () => {
    const calls = stub();
    mount();
    fireEvent.click(await screen.findByTestId(`button-fix-${MCQ.id}`));
    // The full structural editor (same component as Disputes), opened in the
    // exact state pressing "Suggest with AI" would produce: verdict chip,
    // adjudication note, and fields rewritten to the suggestion — not a silent
    // pre-fill that reads as an untouched editor.
    await screen.findByTestId("dialog-mcq-edit");
    expect((await screen.findByTestId("ai-verdict-edit")).textContent).toContain("Change answer → B");
    expect((screen.getByTestId("ai-note-edit")).textContent).toContain("key looks wrong");
    expect((screen.getByTestId("input-edit-reason") as HTMLTextAreaElement).value).toBe("because B");
    expect(screen.getByTestId("select-edit-answer").textContent).toContain("B");
    fireEvent.click(screen.getByTestId("button-save-edit"));
    await waitFor(() => {
      expect(calls.some((c) => c.startsWith(`PATCH /api/mcqs/${encodeURIComponent(MCQ.id)}`))).toBe(true);
      expect(calls.some((c) => c === `POST /api/mcqs/${encodeURIComponent(MCQ.id)}/audit-mark-fixed`)).toBe(true);
    });
  });

  it("Discard routes through the shared triage endpoint", async () => {
    const calls = stub();
    mount();
    fireEvent.click(await screen.findByTestId(`button-discard-${MCQ.id}`));
    await waitFor(() =>
      expect(calls.some((c) => c === `POST /api/mcqs/${encodeURIComponent(MCQ.id)}/triage`)).toBe(true),
    );
  });

  it("bulk approve takes a second click, then posts apply-all", async () => {
    const calls = stub();
    mount();
    // Server-derived count on the button; a single click only arms the confirm.
    const arm = await screen.findByTestId("button-approve-all");
    expect(arm.textContent).toContain("Approve all 1");
    fireEvent.click(arm);
    expect(calls.some((c) => c.includes("apply-all"))).toBe(false);
    fireEvent.click(await screen.findByTestId("button-approve-all-confirm"));
    await waitFor(() =>
      expect(calls.some((c) => c === "POST /api/mcqs/audit/apply-all")).toBe(true),
    );
  });

  it("no bulk-approve button when nothing is applicable", async () => {
    stub({ applicable: 0 });
    mount();
    await screen.findByTestId("button-audit-run");
    expect(screen.queryByTestId("button-approve-all")).toBeNull();
  });

  it("Apply posts to audit-apply for the row", async () => {
    const calls = stub();
    mount();
    fireEvent.click(await screen.findByTestId(`button-apply-${MCQ.id}`));
    await waitFor(() =>
      expect(calls.some((c) => c === `POST /api/mcqs/${encodeURIComponent(MCQ.id)}/audit-apply`)).toBe(true),
    );
  });

  it("cross-links to the Disputes page, so the two review queues explain each other", async () => {
    stub();
    mount();
    const link = await screen.findByTestId("link-to-disputes");
    expect(link.textContent).toContain("Disputes");
    // Real hash href — middle-click / copy-link must land on the page.
    expect(link.getAttribute("href")).toBe("#/disputes");
  });

  it("a stale HANDLED verdict says why, instead of a silent gap", async () => {
    // Stale SUGGESTED rows never reach a band list at all (they are reported
    // as pending). A handled row is the reachable stale case: the fix was
    // applied, then the question was edited again.
    stub({ items: [{ mcq: MCQ, audit: { ...AUDIT, status: "applied" }, applicable: false, stale: true }] });
    mount();
    const note = await screen.findByTestId(`stale-${MCQ.id}`);
    expect(note.textContent).toMatch(/content changed/i);
    expect(screen.queryByTestId(`button-apply-${MCQ.id}`)).toBeNull();
  });

  it("Revert inside Fix… does NOT mark the verdict fixed", async () => {
    // Reverting restores the base corpus text — the content the verdict
    // described. Marking it "fixed" here would hide a known-wrong question
    // from the page and every future sweep while the wrong key went back into
    // the study pool.
    const calls = stub({ items: [{ mcq: { ...MCQ, edited: true }, audit: AUDIT, applicable: true }] });
    mount();
    fireEvent.click(await screen.findByTestId(`button-fix-${MCQ.id}`));
    await screen.findByTestId("dialog-mcq-edit");
    fireEvent.click(screen.getByTestId("button-revert-mcq"));
    await waitFor(() =>
      expect(calls.some((c) => c === `DELETE /api/mcqs/${encodeURIComponent(MCQ.id)}/override`)).toBe(true),
    );
    // The mark-fixed POST must never fire on this path.
    expect(calls.some((c) => c.includes("audit-mark-fixed"))).toBe(false);
  });

  it("hand-fixing an ambiguous row does not raise the disputed flag", async () => {
    // A `setDisputed(!clearsDispute)` would flip an ambiguous/flawed verdict
    // on a CLEAN question to disputed on save — dropping it from the default
    // study pool as a side effect of repairing it.
    const ambiguous = { ...AUDIT, verdict: "ambiguous", suggestedAnswer: null, correctedReason: "needs a tighter stem" };
    const calls = stub({ items: [{ mcq: MCQ, audit: ambiguous, applicable: false }] });
    mount();
    fireEvent.click(await screen.findByTestId(`button-fix-${MCQ.id}`));
    await screen.findByTestId("dialog-mcq-edit");
    fireEvent.click(screen.getByTestId("button-save-edit"));
    await waitFor(() => {
      const patch = calls.find((c) => c.startsWith("PATCH "));
      expect(patch).toBeTruthy();
    });
    const patchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .find(([, init]) => init?.method === "PATCH");
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(patchCall![1].body as string);
    expect(body).not.toHaveProperty("disputed");
    // It did save the actual repair.
    expect(body.reason).toBe("needs a tighter stem");
  });
});
