// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { McqEditDialog } from "@/components/McqEditDialog";

// The edit dialog's AI buttons. "Suggest with max effort" is the top-effort
// variant of "Suggest with AI". What matters: it's an EXTRA option next to the
// plain suggest (not a replacement), the request actually carries effort=max
// (and keeps the audit framing when opened from the Quality page), the verdict
// is attributed to the rung it ran at so the user knows what they paid for,
// and a server without a key says so in plain words.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); queryClient.clear(); });

const MCQ = {
  id: "acid-base__AD03", code: "AD03", displayCode: "AD03", topicFile: "MCQ-Acid-Base.txt",
  topicName: "Acid-Base", topicSlug: "acid-base", domain: "resp", section: null, papers: [],
  stem: "A stem", options: { A: "one", B: "two", C: "three", D: "four", E: "five" },
  answer: "C", reason: "old reason", urls: [], disputed: false, parentCode: null,
  figure: null, loCodes: [], edited: false, excluded: false,
} as never;

const SUGGESTION = {
  verdict: "change_answer", suggestedAnswer: "B", confidence: "high",
  correctedReason: "because B", disputeNote: "key looks wrong", clearsDispute: true,
  suggestedStem: "A tightened stem", suggestedOptions: null, model: "gpt-5.6-sol", reasoningEffort: "max",
};

function stub(opts: { status?: number; error?: string } = {}) {
  const posted: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if ((init?.method ?? "GET").toUpperCase() === "POST") posted.push(url);
    if (opts.status && url.includes("/triage-suggest")) {
      const body = { error: opts.error ?? "nope" };
      return { ok: false, status: opts.status, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
    }
    const body = url.includes("/triage-suggest") ? SUGGESTION : {};
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
  }));
  return posted;
}

function mount(props: Partial<Parameters<typeof McqEditDialog>[0]> = {}) {
  render(
    <QueryClientProvider client={queryClient}>
      <Toaster />
      <McqEditDialog mcq={MCQ} open onOpenChange={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

describe("suggest with AI / max effort", () => {
  it("offers the max option alongside the plain suggest, not instead of it", async () => {
    stub();
    mount();
    const max = await screen.findByTestId("button-ai-suggest-max");
    expect(max.textContent).toContain("max effort");
    // The cheap pass stays the first-line option.
    expect(screen.getByTestId("button-ai-suggest-edit")).toBeTruthy();
    // And the button says what the extra spend buys.
    expect(max.getAttribute("title")).toContain("max");
  });

  it("sends effort=max, pre-fills every field, and badges the verdict with the rung it ran at", async () => {
    const posted = stub();
    mount();
    fireEvent.click(await screen.findByTestId("button-ai-suggest-max"));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toContain("/triage-suggest");
    expect(posted[0]).toContain("effort=max");
    // The suggestion lands in the fields…
    await waitFor(() =>
      expect((screen.getByTestId("input-edit-reason") as HTMLTextAreaElement).value).toBe("because B"),
    );
    expect((screen.getByTestId("input-edit-stem") as HTMLTextAreaElement).value).toBe("A tightened stem");
    expect(screen.getByTestId("select-edit-answer").textContent).toContain("B");
    expect(screen.getByTestId("ai-verdict-edit").textContent).toContain("Change answer → B");
    // …and the attribution names the effort, so a max verdict is visibly max,
    // and says the stem was rewritten so the reader looks at it.
    const note = screen.getByTestId("ai-note-edit").textContent ?? "";
    expect(note).toContain("gpt-5.6-sol@max");
    expect(note).toMatch(/rewrote the stem/);
  });

  it("keeps the audit framing when opened from the Quality page", async () => {
    const posted = stub();
    mount({ suggestMode: "audit" });
    fireEvent.click(await screen.findByTestId("button-ai-suggest-max"));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toContain("mode=audit");
    expect(posted[0]).toContain("effort=max");
  });

  it("the plain suggest still sends NO effort and no mode — max effort is opt-in per click", async () => {
    const posted = stub();
    mount();
    fireEvent.click(await screen.findByTestId("button-ai-suggest-edit"));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toContain("/triage-suggest");
    expect(posted[0]).not.toContain("effort=");
    expect(posted[0]).not.toContain("mode=");
  });

  it("a server without a key gets a plain-words toast, and the fields are untouched", async () => {
    stub({ status: 503, error: "AI not configured (OPENAI_API_KEY missing)" });
    mount();
    fireEvent.click(await screen.findByTestId("button-ai-suggest-edit"));
    await waitFor(() => expect(document.body.textContent).toMatch(/aren't configured on this server/));
    expect((screen.getByTestId("input-edit-reason") as HTMLTextAreaElement).value).toBe("old reason");
    expect(screen.queryByTestId("ai-verdict-edit")).toBeNull();
  });
});
