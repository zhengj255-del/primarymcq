// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { AppRouter, useHashLocationNoQuery } from "@/App";
import { LG_MIN_PX } from "@/pages/MCQs";

// ---------------------------------------------------------------------------
// WHERE THE ANSWER APPEARS ON A PHONE.
//
// The MCQs page is a two-column split at lg: list left, sticky detail right.
// Below lg the grid collapsed to one column and the detail card was simply the
// SECOND COLUMN — so it stacked under all 25 rows AND under the pager. Tapping
// row 1 meant scrolling past 24 questions to read the answer you just asked
// for. The card now renders directly after the row it belongs to.
//
// It MOVES in the DOM rather than being drawn twice behind lg:hidden: McqDetail
// owns `editOpen` and renders McqEditDialog and RevertMcqButton, so a second
// copy would duplicate twelve data-testids and fork that state. Moving the node
// is also what keeps reading order agreeing with what is on screen. The
// duplicate-testid test below is what fails if anyone re-does this the other
// way.
//
// jsdom has no matchMedia, so the component defaults to the mobile placement
// and these tests stub the query to reach the desktop one.
// ---------------------------------------------------------------------------

const MCQ = (id: string, stem: string) => ({
  id, code: id, displayCode: id, topicFile: "t", topicName: "Topic", topicSlug: "t",
  domain: "physiology", section: null, papers: [], stem,
  options: { A: "a", B: "b", C: "c", D: "d", E: "e" },
  answer: "A", reason: "because", urls: [], parentCode: null,
  figure: null, loCodes: [], edited: false, excluded: false,
});

const ROWS = Array.from({ length: 25 }, (_, i) => MCQ(`Q${i + 1}`, `Stem number ${i + 1}`));
const TOTAL = 60; // > PAGE_SIZE, so the pager really renders

/** Stub matchMedia the way a browser at `width` would answer. Omit to leave it
 *  absent, which is jsdom's own state and the component's mobile fallback. */
let resizeTo: ((width: number) => void) | null = null;

function setViewport(width: number | null) {
  resizeTo = null;
  if (width === null) return;
  let current = width;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      get matches() { return min ? current >= Number(min[1]) : false; },
      media: query,
      addEventListener(_: string, fn: () => void) { listeners.add(fn); },
      removeEventListener(_: string, fn: () => void) { listeners.delete(fn); },
      addListener(fn: () => void) { listeners.add(fn); },
      removeListener(fn: () => void) { listeners.delete(fn); },
      dispatchEvent() { return false; },
    };
  });
  // What a real browser does on a resize across the boundary: flip the answer, then notify.
  resizeTo = (next: number) => { current = next; for (const fn of Array.from(listeners)) fn(); };
}

let detailBehaviour: "ok" | "loading" | "error" = "ok";

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = String(input);
    const ok = (body: unknown) => ({ ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any);
    // stats BEFORE the /api/mcqs/<id> arm — "stats" would otherwise read as an id.
    if (url.includes("/api/mcqs/stats")) return ok({ total: TOTAL, withAnswer: TOTAL, byTopic: [], papers: [] });
    if (url.includes("/api/mcqs/user-stats")) return ok({ byTopic: [] });
    const detail = /\/api\/mcqs\/([^?]+)$/.exec(url);
    if (detail && !url.includes("?")) {
      if (detailBehaviour === "loading") return new Promise(() => {}) as any;
      if (detailBehaviour === "error") return { ok: false, status: 500, async json() { return { error: "boom" }; }, async text() { return "boom"; } } as any;
      const id = decodeURIComponent(detail[1]);
      return ok(ROWS.find((m) => m.id === id) ?? MCQ(id, "off-page stem"));
    }
    if (url.includes("/api/mcqs")) {
      const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
      return ok({ total: TOTAL, items: offset === 0 ? ROWS : [MCQ("Q99", "Second page stem")] });
    }
    return ok({});
  }));
}

function renderMcqs() {
  window.history.replaceState(null, "", "/#/mcqs");
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocationNoQuery}>
        <AppRouter />
      </Router>
    </QueryClientProvider>,
  );
}

/** Position of a node in a depth-first walk of the document — the order a
 *  screen reader and the tab key travel in, and (in one column) the order the
 *  eye travels in too. */
function domIndex(el: Element): number {
  const all = Array.from(document.querySelectorAll("*"));
  return all.indexOf(el);
}

beforeEach(() => {
  detailBehaviour = "ok";
  queryClient.clear();
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the detail card on a phone", () => {
  it("opens directly under the row that was tapped, not below the whole list", async () => {
    // THE REPORTED BUG. Pre-fix the card was the second grid column, so it sat
    // after row 25 and after the pager whatever was selected.
    renderMcqs();
    const row3 = await screen.findByTestId("row-mcq-Q3");
    await userEvent.click(row3);
    const card = await screen.findByTestId("card-mcq-detail-Q3");

    expect(domIndex(card)).toBeGreaterThan(domIndex(row3));
    expect(domIndex(card)).toBeLessThan(domIndex(screen.getByTestId("row-mcq-Q4")));
    // …and therefore above the other 21 rows and the pager.
    expect(domIndex(card)).toBeLessThan(domIndex(screen.getByTestId("row-mcq-Q25")));
    expect(domIndex(card)).toBeLessThan(domIndex(screen.getByTestId("text-pager-info")));
    // Ordinal position alone would also be satisfied by the card being nested INSIDE the row, so pin the
    // real relationship: the slot is the row's very next sibling in the list column.
    const slot = screen.getByTestId("mcq-detail-inline");
    expect(row3.nextElementSibling).toBe(slot);
    expect(slot.contains(card)).toBe(true);
    expect(slot.parentElement).toBe(row3.parentElement);
  });

  it("moves to the new row when a different question is opened", async () => {
    renderMcqs();
    await userEvent.click(await screen.findByTestId("row-mcq-Q2"));
    await screen.findByTestId("card-mcq-detail-Q2");
    await userEvent.click(screen.getByTestId("row-mcq-Q9"));
    const card = await screen.findByTestId("card-mcq-detail-Q9");

    expect(screen.queryByTestId("card-mcq-detail-Q2")).toBeNull();
    expect(domIndex(card)).toBeGreaterThan(domIndex(screen.getByTestId("row-mcq-Q9")));
    expect(domIndex(card)).toBeLessThan(domIndex(screen.getByTestId("row-mcq-Q10")));
  });

  it("keeps the tapped row where the thumb left it instead of teleporting the page", async () => {
    // The card is usually taller than the screen. Opening Q9 while Q2's card is
    // open DELETES a screenful from above row 9, so row 9 travels up the
    // document and the browser's preserved scroll offset leaves the user
    // staring at row 10 with the answer they asked for off-screen above. iOS
    // implements no scroll anchoring, so nothing corrects it for free.
    //
    // jsdom lays nothing out (every rect is 0), so the geometry is faked: the
    // row reports one top before the tap and a higher one after, exactly as a
    // real re-layout would, and the correcting scroll is asserted.
    const scrollBy = vi.fn();
    vi.stubGlobal("scrollBy", scrollBy);
    renderMcqs();
    await userEvent.click(await screen.findByTestId("row-mcq-Q2"));
    await screen.findByTestId("card-mcq-detail-Q2");

    // The correcting scroll happens in a layout effect DURING the click, so the
    // two measurements are the first and second calls of one mock: 500 when
    // tapped, then -400 once Q2's ~900px card is removed from above it.
    const row9 = screen.getByTestId("row-mcq-Q9");
    let call = 0;
    vi.spyOn(row9, "getBoundingClientRect").mockImplementation(
      () => ({ top: call++ === 0 ? 500 : -400, height: 60 }) as DOMRect,
    );
    scrollBy.mockClear();
    await userEvent.click(row9);
    await screen.findByTestId("card-mcq-detail-Q9");

    await waitFor(() => expect(scrollBy).toHaveBeenCalled());
    // Scrolled by the drift, which puts the row back at 500 where it was tapped. Exactly once: a second
    // call would mean a stale anchor firing as well. (window.innerHeight is 768 in jsdom and the mocked
    // row reports bottom -340, so the reveal step below does not add a call here.)
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith(0, -900);
  });

  it("does not scroll the page on the FIRST selection, when nothing moved", async () => {
    const scrollBy = vi.fn();
    vi.stubGlobal("scrollBy", scrollBy);
    renderMcqs();
    await userEvent.click(await screen.findByTestId("row-mcq-Q4"));
    await screen.findByTestId("card-mcq-detail-Q4");
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("puts the spinner and the error under the row too, not at the bottom", async () => {
    // A slow or failed fetch is exactly when being stranded at the bottom of
    // the list is worst — the user cannot tell whether the tap registered.
    detailBehaviour = "loading";
    renderMcqs();
    const row5 = await screen.findByTestId("row-mcq-Q5");
    await userEvent.click(row5);
    const slot = await screen.findByTestId("mcq-detail-inline");
    expect(domIndex(slot)).toBeGreaterThan(domIndex(row5));
    expect(domIndex(slot)).toBeLessThan(domIndex(screen.getByTestId("row-mcq-Q6")));
    expect(slot.textContent).toMatch(/Loading/i);

    cleanup();
    queryClient.clear();
    detailBehaviour = "error";
    renderMcqs();
    const row6 = await screen.findByTestId("row-mcq-Q6");
    await userEvent.click(row6);
    const err = await screen.findByTestId("mcq-detail-error");
    expect(domIndex(err)).toBeGreaterThan(domIndex(row6));
    expect(domIndex(err)).toBeLessThan(domIndex(screen.getByTestId("row-mcq-Q7")));
  });

  it("parks the card after the last row when its question is not on this page", async () => {
    // The selection survives paging, so the open question can leave the page.
    // It must not vanish silently.
    renderMcqs();
    await userEvent.click(await screen.findByTestId("row-mcq-Q3"));
    await screen.findByTestId("card-mcq-detail-Q3");
    await userEvent.click(screen.getByTestId("button-page-next"));
    const onlyRow = await screen.findByTestId("row-mcq-Q99");
    const card = await screen.findByTestId("card-mcq-detail-Q3");
    expect(domIndex(card)).toBeGreaterThan(domIndex(onlyRow));
    expect(domIndex(card)).toBeLessThan(domIndex(screen.getByTestId("text-pager-info")));
  });

  it("drops the empty-column placeholder, which a single column has no room for", async () => {
    renderMcqs();
    await screen.findByTestId("row-mcq-Q1");
    expect(screen.queryByTestId("text-detail-placeholder")).toBeNull();
    expect(screen.queryByTestId("mcq-detail-column")).toBeNull();
  });

  it("tells assistive tech the row expands, and what it expanded", async () => {
    renderMcqs();
    const row2 = await screen.findByTestId("row-mcq-Q2");
    expect(row2.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(row2);
    await screen.findByTestId("card-mcq-detail-Q2");
    expect(row2.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(row2.getAttribute("aria-controls")!)).toBeTruthy();
  });

  it("closes back to a plain list", async () => {
    renderMcqs();
    await userEvent.click(await screen.findByTestId("row-mcq-Q7"));
    await screen.findByTestId("card-mcq-detail-Q7");
    await userEvent.click(screen.getByTestId("button-close-detail"));
    await waitFor(() => expect(screen.queryByTestId("mcq-detail-inline")).toBeNull());
  });
});

describe("states the card has to survive", () => {
  it("shows a pending card when the tap cannot even start a fetch (offline)", async () => {
    // React Query pauses an offline query: isPending with fetchStatus "paused", which reports
    // isLoading=false, isError=false and no data. An isLoading branch drew NOTHING for it — below lg
    // the card is the only sign the tap landed, so the app looked broken, and the row was advertising
    // aria-controls to an id that was not in the document.
    const { onlineManager } = await import("@tanstack/react-query");
    renderMcqs();
    const row4 = await screen.findByTestId("row-mcq-Q4");   // list arrives while still online
    onlineManager.setOnline(false);                          // …then the connection drops
    try {
      await userEvent.click(row4);
      const pending = await screen.findByTestId("mcq-detail-pending");
      expect(domIndex(pending)).toBeGreaterThan(domIndex(row4));
      expect(domIndex(pending)).toBeLessThan(domIndex(screen.getByTestId("row-mcq-Q5")));
      // The promise aria-controls makes is kept: the id it names is really there.
      expect(document.getElementById(row4.getAttribute("aria-controls")!)).toBeTruthy();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("collapses when the open row is tapped again, as aria-expanded promises", async () => {
    renderMcqs();
    const row6 = await screen.findByTestId("row-mcq-Q6");
    await userEvent.click(row6);
    await screen.findByTestId("card-mcq-detail-Q6");
    expect(row6.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(row6);
    await waitFor(() => expect(screen.queryByTestId("mcq-detail-inline")).toBeNull());
    expect(row6.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps an open edit dialog and its draft when the viewport crosses the breakpoint", async () => {
    // The card is unmounted and remounted when it changes column, e.g. rotating a tablet. `editOpen`
    // used to live inside it, so the rotation closed the dialog and threw away the correction being
    // typed. It lives on the page now, outside the node that moves.
    setViewport(1440);
    renderMcqs();
    await userEvent.click(await screen.findByTestId("row-mcq-Q5"));
    await screen.findByTestId("card-mcq-detail-Q5");
    await userEvent.click(screen.getByTestId("button-edit-mcq"));
    const dialogOpen = () => document.querySelector('[role="dialog"]');
    await waitFor(() => expect(dialogOpen()).toBeTruthy());

    resizeTo!(390);   // rotate to a phone width
    await waitFor(() => expect(screen.queryByTestId("mcq-detail-inline")).toBeTruthy());
    // The card moved into the list, and the dialog is still open.
    expect(dialogOpen()).toBeTruthy();
  });

  it("re-places the card when the viewport crosses lg — the subscription is live", async () => {
    // Without a real matchMedia listener the placement would freeze at whatever the first render saw.
    setViewport(390);
    renderMcqs();
    await userEvent.click(await screen.findByTestId("row-mcq-Q3"));
    await screen.findByTestId("mcq-detail-inline");

    resizeTo!(1440);
    await waitFor(() => expect(screen.getByTestId("mcq-detail-column")).toBeTruthy());
    expect(screen.queryByTestId("mcq-detail-inline")).toBeNull();
    expect(screen.getByTestId("card-mcq-detail-Q3").className).toMatch(/sticky/);

    resizeTo!(390);
    await waitFor(() => expect(screen.getByTestId("mcq-detail-inline")).toBeTruthy());
    expect(screen.queryByTestId("mcq-detail-column")).toBeNull();
  });
});

describe("the split view on a desktop", () => {
  it("keeps the card in the sticky right-hand column, out of the list", async () => {
    // The user did not complain about the desktop layout; it must not change.
    setViewport(1440);
    renderMcqs();
    await userEvent.click(await screen.findByTestId("row-mcq-Q3"));
    const card = await screen.findByTestId("card-mcq-detail-Q3");

    expect(screen.queryByTestId("mcq-detail-inline")).toBeNull();
    const column = screen.getByTestId("mcq-detail-column");
    expect(column.contains(card)).toBe(true);
    // After EVERY row, i.e. outside the list — the pre-fix arrangement.
    expect(domIndex(card)).toBeGreaterThan(domIndex(screen.getByTestId("row-mcq-Q25")));
    expect(card.className).toMatch(/sticky/);
  });

  it("shows the placeholder in the empty column, and no aria-controls to nothing", async () => {
    setViewport(1440);
    renderMcqs();
    await screen.findByTestId("row-mcq-Q1");
    expect(screen.getByTestId("text-detail-placeholder")).toBeTruthy();
    // aria-controls would be a promise to point at a card that is in the other
    // column, not next to the row.
    expect(screen.getByTestId("row-mcq-Q1").getAttribute("aria-controls")).toBeNull();
    expect(screen.getByTestId("row-mcq-Q1").getAttribute("aria-expanded")).toBeNull();
  });

  it("is inline again just below the breakpoint", async () => {
    setViewport(LG_MIN_PX - 1);
    renderMcqs();
    const row3 = await screen.findByTestId("row-mcq-Q3");
    await userEvent.click(row3);
    const card = await screen.findByTestId("card-mcq-detail-Q3");
    expect(domIndex(card)).toBeLessThan(domIndex(screen.getByTestId("row-mcq-Q4")));
    expect(card.className ?? "").not.toMatch(/sticky/);
  });

  it("never renders the card twice — the whole reason it moves instead of hiding", async () => {
    // If someone re-implements this as lg:hidden + hidden lg:block, every
    // data-testid inside McqDetail lands in the DOM twice and getByTestId
    // starts throwing. Catch it here rather than in a confusing test failure
    // three files away.
    for (const width of [390, 1440]) {
      setViewport(width);
      renderMcqs();
      await userEvent.click(await screen.findByTestId("row-mcq-Q3"));
      await screen.findByTestId("card-mcq-detail-Q3");
      const counts = new Map<string, number>();
      for (const el of Array.from(document.querySelectorAll("[data-testid]"))) {
        const id = el.getAttribute("data-testid")!;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      expect(Array.from(counts).filter(([, n]) => n > 1)).toEqual([]);
      cleanup();
      queryClient.clear();
      vi.unstubAllGlobals();
      stubFetch();
    }
  });
});

describe("the JS breakpoint and the CSS breakpoint", () => {
  it("agree, or the card goes back to the bottom of the list on a mid-width screen", async () => {
    // The one regression no rendered test can see: JS decides WHERE the card
    // goes and CSS decides whether there are two columns to put it in. Let the
    // two drift — change the grid to `xl:` and leave the query at 1024px — and
    // every viewport in between renders the right-hand column while the page is
    // still one column wide, which is the original bug on a wider screen. The
    // suite would stay green, because stubbing matchMedia is exactly what cuts
    // the tests off from the stylesheet. So read the source instead.
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../MCQs.tsx"), "utf-8",
    );
    const grid = /className="grid grid-cols-1 (\w+):grid-cols-\[1fr_420px\]/.exec(src);
    expect(grid, "the split-view grid class changed shape — update this guard").toBeTruthy();
    const TAILWIND_DEFAULTS: Record<string, number> = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 };
    expect(
      TAILWIND_DEFAULTS[grid![1]],
      `the grid splits at ${grid![1]} but the media query says ${LG_MIN_PX}px`,
    ).toBe(LG_MIN_PX);

    // …and the Tailwind default only holds while the project does not redefine it. A custom `screens`
    // block that moved lg would silently repoint the CSS half of the pair while this file still says
    // 1024, which is the same drift by another route.
    const cfg = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../tailwind.config.ts"), "utf-8");
    expect(
      /\bscreens\s*:/.test(cfg),
      "tailwind.config.ts now sets custom screens — check that " + grid![1] + " is still " + LG_MIN_PX + "px",
    ).toBe(false);
  });
});
