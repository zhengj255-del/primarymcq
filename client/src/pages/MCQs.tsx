import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SittingTag } from "@/components/SittingTag";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, ExternalLink, ChevronLeft, ChevronRight, CheckCircle2, Loader2, Pencil } from "lucide-react";
import { McqFigure } from "@/components/McqFigure";
import type { McqRecord } from "@shared/schema";
import { McqEditDialog } from "@/components/McqEditDialog";
import { RevertMcqButton } from "@/components/RevertMcqButton";

// -------------------------------------------------------------------------------------------------
// Types matching /api/mcqs and /api/mcqs/stats
// -------------------------------------------------------------------------------------------------
interface McqListResp {
  total: number;
  items: McqRecord[];
}
interface McqStats {
  total: number;
  withAnswer: number;
  byTopic: Array<{ slug: string; name: string; domain: string; count: number; linked: number }>;
}

const PAGE_SIZE = 25;

// -------------------------------------------------------------------------------------------------
// WHERE THE DETAIL CARD GOES — the only place in this app that asks the viewport in JS.
//
// This is the app's one master/detail layout. At lg it is list-left / sticky-detail-right, which is
// right and stays. Below lg the grid collapses to a single column, and the detail card was the second
// column — so it stacked under the WHOLE list AND under the pager. Tapping row 1 of 25 on a phone meant
// scrolling past 24 rows to read the answer you just asked for.
//
// The card now renders directly after the row it belongs to below lg. It MOVES IN THE DOM rather than
// being drawn in two places behind `lg:hidden` / `hidden lg:block`: a second copy would put twelve of
// McqDetail's data-testids in the DOM twice and mount RevertMcqButton's dialog alongside its twin.
// Moving the node also keeps reading and focus order agreeing with
// what is on screen — a screen-reader user reaches the card straight after the row they opened, not after
// the remaining 24 rows and the pager (WCAG 1.3.2, 2.4.3). A CSS-only version using `display: contents`
// plus `order` can produce the same picture without JS, but it leaves those two orders disagreeing.
//
// 1024px is Tailwind's default `lg` (tailwind.config.ts declares no `screens`), and is deliberately the
// same number as the `lg:` prefixes on the grid below. THE TWO MUST AGREE: at a width where JS says
// desktop but CSS still says one column, the card goes back to the bottom of the list — the original bug,
// on a wider screen. Nothing in the browser enforces the pairing, so mcqInlineDetail.test.tsx reads this
// file and fails if the two ever drift.
export const LG_MIN_PX = 1024;
const LG_QUERY = `(min-width: ${LG_MIN_PX}px)`;

// jsdom ships no matchMedia at all, so it is guarded rather than assumed. Deliberately not cached at
// module scope: a cached MediaQueryList would outlive a test's stub and leak the first test's `matches`
// into every later one.
const lgQuery = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(LG_QUERY) : null;

function subscribeToLg(onChange: () => void): () => void {
  const mql = lgQuery();
  if (!mql) return () => {};
  // addEventListener on a MediaQueryList is Safari 14+; addListener is the deprecated fallback older
  // WebKit still exposes, and this app is used on phones.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  mql.addListener(onChange);
  return () => mql.removeListener(onChange);
}

/** True when the viewport is wide enough for the two-column split.
 *
 *  useSyncExternalStore rather than useState + useEffect: the value is read DURING the first render, so a
 *  desktop user never sees the card painted inline under its row and then jump to the right-hand column —
 *  an effect runs after paint, which is exactly the flash it would produce.
 *
 *  Falls back to FALSE wherever matchMedia is absent. Mobile is the safe default for the same reason
 *  Tailwind's prefixes are min-width: the inline placement is an ordinary single-column document that
 *  reads correctly at any width, whereas guessing desktop and being wrong puts a phone back on the bug
 *  this exists to fix. In a real browser the fallback is never reached. */
function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeToLg, () => lgQuery()?.matches ?? false, () => false);
}

// -------------------------------------------------------------------------------------------------
// Detail panel — shows the full stem/options/answer/reason with LO links
// -------------------------------------------------------------------------------------------------
function McqDetail({ mcq, onClose, onEdit, className }: {
  mcq: McqRecord;
  onClose: () => void;
  onEdit: () => void;
  className?: string;
}) {
  const answer = mcq.answer;
  // `sticky top-4` is a property of the RIGHT-HAND COLUMN, not of the card: pinned to the viewport top
  // while sitting inline in the list, the card would slide away from the row it belongs to.
  //
  // The Edit dialog and its open flag deliberately live on the PAGE, not here. This card is unmounted and
  // remounted whenever it changes position — which happens when the viewport crosses lg, e.g. rotating a
  // tablet — and local state does not survive that. It used to hold `editOpen`, so a rotation mid-edit
  // closed the dialog and threw away everything typed into it.
  return (
    <Card className={className} data-testid={`card-mcq-detail-${mcq.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <SittingTag code={mcq.code} papers={mcq.papers} className="text-xs" testId="badge-mcq-sitting" />
              <Badge variant="outline" className="text-xs max-w-full whitespace-normal">{mcq.topicName}</Badge>
              {mcq.edited && (
                <Badge variant="secondary" className="text-xs gap-1" data-testid="badge-mcq-edited">
                  <Pencil className="h-3 w-3" /> Edited
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-1 truncate" title={mcq.section ?? undefined}>
              <span className="font-mono" data-testid="text-mcq-code">{mcq.displayCode}</span>
              {mcq.section ? ` · ${mcq.section}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={onEdit}
              data-testid="button-edit-mcq"
            >
              <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
            </Button>
            <RevertMcqButton mcq={mcq} />
            <Button variant="ghost" size="sm" onClick={onClose} data-testid="button-close-detail">Close</Button>
          </div>
        </div>
        {mcq.papers.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {mcq.papers.map((p, i) => (
              <Badge key={i} variant="secondary" className="text-[10px] font-mono">{p}</Badge>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Stem</div>
          <div className="whitespace-pre-wrap" data-testid="text-mcq-stem">{mcq.stem}</div>
          <McqFigure figure={mcq.figure} />
        </div>

        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Options</div>
          <ul className="space-y-1.5">
            {(["A", "B", "C", "D", "E"] as const).map((k) => {
              const opt = mcq.options[k];
              if (!opt) return null;
              const isAnswer = answer === k;
              return (
                <li
                  key={k}
                  className={`flex gap-2 rounded-md border px-2.5 py-1.5 ${isAnswer ? "border-primary bg-primary/5" : "border-border"}`}
                  data-testid={`opt-${k}`}
                >
                  <span className={`font-mono font-semibold ${isAnswer ? "text-primary" : ""}`}>{k}.</span>
                  <span className="min-w-0">{opt}</span>
                  {isAnswer && <CheckCircle2 className="h-4 w-4 text-primary shrink-0 ml-auto" />}
                </li>
              );
            })}
          </ul>
        </div>

        {mcq.answer && (
          <div className="text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Answer </span>
            <span className="font-mono font-semibold text-primary" data-testid="text-mcq-answer">{mcq.answer}</span>
          </div>
        )}

        {mcq.reason && (
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Reasoning</div>
            <div className="whitespace-pre-wrap text-sm leading-relaxed border-l-2 border-muted-foreground/20 pl-3">
              {mcq.reason}
            </div>
          </div>
        )}

        {mcq.urls.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Links</div>
            <ul className="space-y-1 text-sm">
              {mcq.urls.map((u, i) => (
                <li key={i} className="flex gap-1.5 items-start">
                  <ExternalLink className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <a
                    href={u}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline break-all"
                    data-testid={`link-mcq-url-${i}`}
                  >
                    {u}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {mcq.loCodes.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              Linked ANZCA Learning Objectives
            </div>
            <div className="flex flex-wrap gap-1">
              {mcq.loCodes.map((c) => (
                <Badge key={c} variant="outline" className="text-[11px] font-mono" data-testid={`badge-lo-${c}`}>
                  {c}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// -------------------------------------------------------------------------------------------------
// Row in the MCQ list
// -------------------------------------------------------------------------------------------------
function McqRow({
  mcq,
  active,
  onClick,
  controls,
}: {
  mcq: McqRecord;
  active: boolean;
  // Handed the row's own element so the page can keep it under the thumb — see
  // selectRow in MCQsPage.
  onClick: (el: HTMLButtonElement) => void;
  // Set only where the card really does render inline under this row, so the promise
  // aria-controls makes ("the thing I point at is next to me") is not made on desktop,
  // where the card lives in the other column.
  controls?: string;
}) {
  return (
    <button
      className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors hover-elevate ${active ? "border-primary bg-primary/5" : "border-border"}`}
      onClick={(e) => onClick(e.currentTarget)}
      aria-expanded={controls ? active : undefined}
      aria-controls={controls && active ? controls : undefined}
      data-testid={`row-mcq-${mcq.id}`}
    >
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        {/* The sitting(s) the question is known from — from its code (25A-1 →
            2025.1) and its paper tags (Jul97 → 1997.2) alike. The letter code
            lives in the detail panel, not here. */}
        <SittingTag code={mcq.code} papers={mcq.papers} className="text-[10px]" testId={`badge-sitting-${mcq.id}`} />
        <Badge variant="outline" className="text-[10px]">{mcq.topicName}</Badge>
        {mcq.edited && (
          <Badge variant="secondary" className="text-[10px] gap-0.5 py-0 px-1.5" data-testid={`badge-edited-${mcq.id}`}>
            <Pencil className="h-2.5 w-2.5" />
            edited
          </Badge>
        )}
        {mcq.answer && (
          <span className="ml-auto text-xs font-mono text-primary">= {mcq.answer}</span>
        )}
      </div>
      <div className="text-sm leading-snug line-clamp-2">{mcq.stem}</div>
    </button>
  );
}

// -------------------------------------------------------------------------------------------------
// Main page
// -------------------------------------------------------------------------------------------------
export default function MCQsPage() {
  const [topic, setTopic] = useState<string>("");
  const [q, setQ] = useState<string>("");
  const [qDebounced, setQDebounced] = useState<string>("");
  const [completion, setCompletion] = useState<"all" | "completed" | "not-completed" | "review">("all");
  const [page, setPage] = useState<number>(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Owned by the page, not by McqDetail: the card is remounted whenever it changes position (crossing lg),
  // and an open dialog with a half-typed correction in it must survive that.
  const [editOpen, setEditOpen] = useState(false);

  // Debounce search input. Must be useEffect: only an effect's cleanup runs
  // between keystrokes — useMemo's "cleanup" return value is never invoked, so
  // every keystroke's timer fired (one fetch per key, zero debouncing).
  useEffect(() => {
    const t = setTimeout(() => {
      setQDebounced(q);
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const statsQuery = useQuery<McqStats>({
    queryKey: ["/api/mcqs/stats"],
  });

  const params = new URLSearchParams();
  if (topic) params.set("topic", topic);
  if (qDebounced) params.set("q", qDebounced);
  if (completion === "completed") params.set("completed", "true");
  else if (completion === "not-completed") params.set("completed", "false");
  // "Review pool" = not yet answered correctly: unseen questions + ones
  // previously gotten wrong. Backend flag `unmastered` handles both.
  else if (completion === "review") params.set("unmastered", "true");
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(page * PAGE_SIZE));
  const queryKey = ["/api/mcqs", params.toString()];

  const listQuery = useQuery<McqListResp>({
    queryKey,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/mcqs?${params.toString()}`);
      return r.json();
    },
  });

  const detailQuery = useQuery<McqRecord>({
    queryKey: ["/api/mcqs", selectedId],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/mcqs/${encodeURIComponent(selectedId!)}`);
      return r.json();
    },
    enabled: !!selectedId,
  });

  const total = listQuery.data?.total ?? 0;
  const items = listQuery.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const isDesktop = useIsDesktop();

  // ----- Keeping the tapped row under the thumb -------------------------------------------------
  // Inline placement moves a card that is usually TALLER THAN THE SCREEN. Opening question 12 while
  // question 3's card is open removes that card from above row 12 and rebuilds it below, so row 12
  // travels up the document by the old card's height while the rows past it do not move at all. The
  // browser keeps the scroll offset, so the row just tapped — and the answer asked for — end up a
  // screenful above the viewport. iOS Safari implements no scroll anchoring, so on the very phone in
  // question there is no compensation at all.
  //
  // So the row is anchored by hand: its distance from the top of the viewport is read at tap time and
  // restored once React has re-laid-out. In a layout effect, before the browser paints, so nothing is
  // ever drawn in the wrong place. Element.scrollIntoView is NOT used — jsdom does not implement it
  // (it would throw during commit and tear down the tree), and it would move the row to the top of the
  // screen rather than leaving it where the finger already is.
  // The anchor is the row the user just TAPPED — the thing their eye and thumb are on — not whichever
  // row happened to be open. React keeps the same DOM node for a row across the re-render (same key),
  // so the element captured here is the one to re-measure afterwards.
  const anchorRef = useRef<{ el: HTMLElement; top: number } | null>(null);

  const selectRow = (id: string | null, el?: HTMLElement) => {
    // Setting the same id is a React bail-out: no re-render, so the layout effect never runs and would
    // leave this anchor loaded to fire a phantom scroll at the next breakpoint change.
    if (id === selectedId) { anchorRef.current = null; return; }
    // Measured BEFORE setState: once React re-renders, the old geometry is gone.
    anchorRef.current = el ? { el, top: el.getBoundingClientRect().top } : null;
    setSelectedId(id);
  };

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    // Desktop moves nothing in the list, so there is nothing to correct.
    if (!anchor || isDesktop) return;

    // 1. Undo the drift, so the row is back where the thumb left it.
    const drift = anchor.el.getBoundingClientRect().top - anchor.top;
    // Zero on a first selection (nothing above the row changed) and in jsdom, which lays nothing out.
    if (drift !== 0) window.scrollBy(0, drift);

    // 2. Then make sure the answer is actually ON SCREEN. Pinning the row is necessary but not
    //    sufficient: the card begins at the row's bottom edge, so tapping a row low in the viewport
    //    leaves the whole card below the fold and the only visible change is the row's highlight —
    //    the original complaint restated. Lift the row toward the top of the content, but ONLY when
    //    it is sitting low enough for that to be the case, so a tap high on the screen moves nothing.
    const rect = anchor.el.getBoundingClientRect();
    const viewport = window.innerHeight || 0;
    if (viewport > 0 && rect.bottom > viewport / 2) {
      // The app header is sticky at top: 0, so scrolling the row to y=0 would tuck it underneath.
      // Measured rather than guessed — it is two rows tall below 860px and one above.
      const header = document.querySelector(".ledger-sidebar");
      const clear = (header?.getBoundingClientRect().height ?? 0) + 8;
      window.scrollBy(0, rect.top - clear);
    }
  }, [selectedId, isDesktop]);

  // The one detail element. Rendered inline under its row below lg and in the right-hand column at lg —
  // never both, so every data-testid inside it stays unique.
  // Once a row is selected this is NEVER null: below lg the card is the only feedback that the tap landed
  // at all, so every state of the fetch has to draw something. The spinner is the fallthrough rather than
  // an `isLoading` branch on purpose — an offline tap leaves React Query reporting
  // `isPending` with `fetchStatus: "paused"`, which is isLoading=false, isError=false and no data, and an
  // isLoading branch rendered nothing for it: the tap looked broken, and aria-controls pointed at an id
  // that was not in the document.
  const detailNode = !selectedId ? null : detailQuery.data ? (
    <McqDetail
      mcq={detailQuery.data}
      onClose={() => selectRow(null)}
      onEdit={() => setEditOpen(true)}
      className={isDesktop ? "sticky top-4" : undefined}
    />
  ) : detailQuery.isError ? (
    // With a row SELECTED and its fetch failed, falling through to "Select an MCQ…" pretended nothing
    // was clicked — and the cached error made re-clicking the row a silent no-op.
    <Card><CardContent className="py-8 text-center text-sm text-amber-600 dark:text-amber-400" data-testid="mcq-detail-error">
      Couldn't load this MCQ — refresh to retry.
    </CardContent></Card>
  ) : (
    <Card><CardContent className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2" data-testid="mcq-detail-pending">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading...
    </CardContent></Card>
  );

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1400px] mx-auto">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-serif" data-testid="text-page-title">MCQs</h1>
          <p className="text-sm text-muted-foreground">
            Kerry Brandis Black Bank — physiology past questions with reasoning and paper history.
          </p>
        </div>
        {statsQuery.data && (
          <div className="flex gap-3 text-xs text-muted-foreground" data-testid="text-mcq-stats">
            <span><span className="font-mono font-semibold text-foreground">{statsQuery.data.total}</span> total</span>
            <span><span className="font-mono font-semibold text-foreground">{statsQuery.data.withAnswer}</span> with answers</span>
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search stem and reasoning..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-8"
            data-testid="input-search-mcqs"
          />
        </div>
        <Select value={topic || "all"} onValueChange={(v) => { setTopic(v === "all" ? "" : v); setPage(0); }}>
          <SelectTrigger className="w-[220px]" data-testid="select-topic">
            <SelectValue placeholder="All topics" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All topics</SelectItem>
            {statsQuery.data?.byTopic.map((t) => (
              <SelectItem key={t.slug} value={t.slug}>
                {t.name} ({t.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={completion} onValueChange={(v) => { setCompletion(v as typeof completion); setPage(0); }}>
          <SelectTrigger className="w-[230px]" data-testid="select-completion">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All (completion)</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="not-completed">Not completed</SelectItem>
            <SelectItem value="review">Review pool (unseen + incorrect)</SelectItem>
          </SelectContent>
        </Select>
        {(topic || qDebounced || completion !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setTopic(""); setQ(""); setQDebounced(""); setCompletion("all"); setPage(0); }}
            data-testid="button-clear-filters"
          >
            Clear
          </Button>
        )}
      </div>

      {/* Split view: list + detail */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-4">
        <div className="space-y-2 min-w-0">
          {listQuery.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading MCQs...
            </div>
          )}
          {!listQuery.isLoading && listQuery.isError && (
            <div className="text-center py-12 text-sm text-amber-600 dark:text-amber-400" data-testid="mcq-list-error">
              Couldn't load MCQs — refresh to retry.
            </div>
          )}
          {!listQuery.isLoading && !listQuery.isError && items.length === 0 && (
            <div className="text-center py-12 text-muted-foreground text-sm" data-testid="text-empty-state">
              {total > 0 && page > 0
                // The total shrank underneath an open page (e.g. a question
                // discarded elsewhere): matches exist on earlier pages, so saying
                // "no MCQs match" would be a lie. Offer the way back instead.
                ? <>This page is now empty — {total} match{total === 1 ? "es" : ""} on earlier pages. <button className="underline underline-offset-2" onClick={() => setPage(0)} data-testid="button-back-to-first-page">Back to page 1</button></>
                : "No MCQs match those filters."}
            </div>
          )}
          {items.map((m) => (
            <Fragment key={m.id}>
              <McqRow
                mcq={m}
                active={selectedId === m.id}
                // Below lg the row IS a disclosure control (it carries aria-expanded), and activating an
                // expanded disclosure has to collapse it. At lg it stays a selection list, where clicking
                // the selected row again closing the panel would be surprising.
                onClick={(el) => selectRow(!isDesktop && selectedId === m.id ? null : m.id, el)}
                controls={!isDesktop ? "mcq-detail-inline" : undefined}
              />
              {/* Below lg the answer belongs under the question that was tapped — including the
                  spinner and the error card, which would otherwise strand a slow connection at the
                  bottom of the list. At lg this is never rendered; the right-hand column is. */}
              {!isDesktop && selectedId === m.id && detailNode && (
                <div id="mcq-detail-inline" data-testid="mcq-detail-inline">{detailNode}</div>
              )}
            </Fragment>
          ))}
          {/* The selection survives paging and filtering, so the open question can be off the current
              page entirely. Its card then parks after the last row rather than vanishing. */}
          {!isDesktop && selectedId && detailNode && !items.some((m) => m.id === selectedId) && (
            <div id="mcq-detail-inline" data-testid="mcq-detail-inline">{detailNode}</div>
          )}

          {/* Pager */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between pt-2 text-sm">
              <div className="text-muted-foreground" data-testid="text-pager-info">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
              </div>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  data-testid="button-page-prev"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <div className="px-3 flex items-center text-sm font-mono" data-testid="text-page-current">
                  {page + 1} / {totalPages}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  data-testid="button-page-next"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* The right-hand column exists only at lg. Below it the whole column is dropped: the card is
            inline in the list above, and the "Select an MCQ…" placeholder only ever existed to fill an
            empty second column, which a phone does not have. */}
        {isDesktop && (
          <div className="min-w-0" data-testid="mcq-detail-column">
            {detailNode ?? (
              <Card className="border-dashed">
                <CardContent className="py-10 text-center text-sm text-muted-foreground" data-testid="text-detail-placeholder">
                  Select an MCQ to see full stem, options, answer, and reasoning.
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* Outside the detail card on purpose — see McqDetail. Radix portals the dialog, so mounting it here
          costs nothing in layout and means a rotation across lg cannot discard an in-progress edit. */}
      {detailQuery.data && (
        <McqEditDialog mcq={detailQuery.data} open={editOpen} onOpenChange={setEditOpen} />
      )}
    </div>
  );
}
