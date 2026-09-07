import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, AlertCircle, ExternalLink, ChevronLeft, ChevronRight, CheckCircle2, Loader2, Pencil } from "lucide-react";
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
  disputed: number;
  byTopic: Array<{ slug: string; name: string; domain: string; count: number; linked: number }>;
}

const PAGE_SIZE = 25;

// -------------------------------------------------------------------------------------------------
// Detail panel — shows the full stem/options/answer/reason with LO links
// -------------------------------------------------------------------------------------------------
function McqDetail({ mcq, onClose }: { mcq: McqRecord; onClose: () => void }) {
  const answer = mcq.answer;
  const [editOpen, setEditOpen] = useState(false);
  return (
    <Card className="sticky top-4" data-testid={`card-mcq-detail-${mcq.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base font-mono" data-testid="text-mcq-code">{mcq.displayCode}</CardTitle>
              <Badge variant="outline" className="text-xs max-w-full whitespace-normal">{mcq.topicName}</Badge>
              {mcq.disputed && (
                <Badge variant="destructive" className="text-xs gap-1">
                  <AlertCircle className="h-3 w-3" /> Disputed
                </Badge>
              )}
              {mcq.edited && (
                <Badge variant="secondary" className="text-xs gap-1" data-testid="badge-mcq-edited">
                  <Pencil className="h-3 w-3" /> Edited
                </Badge>
              )}
            </div>
            {mcq.section && (
              <div className="text-xs text-muted-foreground mt-1 truncate" title={mcq.section}>{mcq.section}</div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditOpen(true)}
              data-testid="button-edit-mcq"
            >
              <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
            </Button>
            <RevertMcqButton mcq={mcq} />
            <Button variant="ghost" size="sm" onClick={onClose} data-testid="button-close-detail">Close</Button>
          </div>
        </div>
        <McqEditDialog mcq={mcq} open={editOpen} onOpenChange={setEditOpen} />
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
}: {
  mcq: McqRecord;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors hover-elevate ${active ? "border-primary bg-primary/5" : "border-border"}`}
      onClick={onClick}
      data-testid={`row-mcq-${mcq.id}`}
    >
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="font-mono text-xs font-semibold" data-testid={`text-code-${mcq.id}`}>{mcq.displayCode}</span>
        <Badge variant="outline" className="text-[10px]">{mcq.topicName}</Badge>
        {mcq.papers.slice(0, 4).map((p, i) => (
          <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{p}</span>
        ))}
        {mcq.papers.length > 4 && (
          <span className="text-[10px] text-muted-foreground">+{mcq.papers.length - 4}</span>
        )}
        {mcq.disputed && (
          <Badge variant="destructive" className="text-[10px] gap-0.5 py-0 px-1.5">
            <AlertCircle className="h-2.5 w-2.5" />
            disputed
          </Badge>
        )}
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
  const [disputedOnly, setDisputedOnly] = useState<boolean>(false);
  const [completion, setCompletion] = useState<"all" | "completed" | "not-completed" | "review">("all");
  const [page, setPage] = useState<number>(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
  if (disputedOnly) params.set("disputed", "true");
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
            <span><span className="font-mono font-semibold text-foreground">{statsQuery.data.disputed}</span> disputed</span>
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
        <Button
          variant={disputedOnly ? "default" : "outline"}
          size="sm"
          onClick={() => { setDisputedOnly((v) => !v); setPage(0); }}
          data-testid="button-toggle-disputed"
        >
          <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
          Disputed only
        </Button>
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
        {(topic || qDebounced || disputedOnly || completion !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setTopic(""); setQ(""); setQDebounced(""); setDisputedOnly(false); setCompletion("all"); setPage(0); }}
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
                // The total shrank underneath an open page (e.g. a concurrent
                // triage discard): matches exist on earlier pages, so saying
                // "no MCQs match" would be a lie. Offer the way back instead.
                ? <>This page is now empty — {total} match{total === 1 ? "es" : ""} on earlier pages. <button className="underline underline-offset-2" onClick={() => setPage(0)} data-testid="button-back-to-first-page">Back to page 1</button></>
                : "No MCQs match those filters."}
            </div>
          )}
          {items.map((m) => (
            <McqRow
              key={m.id}
              mcq={m}
              active={selectedId === m.id}
              onClick={() => setSelectedId(m.id)}
            />
          ))}

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

        <div className="min-w-0">
          {selectedId && detailQuery.data ? (
            <McqDetail mcq={detailQuery.data} onClose={() => setSelectedId(null)} />
          ) : selectedId && detailQuery.isLoading ? (
            <Card><CardContent className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading...
            </CardContent></Card>
          ) : selectedId && detailQuery.isError ? (
            // With a row SELECTED and its fetch failed, falling through to
            // "Select an MCQ…" pretended nothing was clicked — and the cached
            // error made re-clicking the row a silent no-op.
            <Card><CardContent className="py-8 text-center text-sm text-amber-600 dark:text-amber-400" data-testid="mcq-detail-error">
              Couldn't load this MCQ — refresh to retry.
            </CardContent></Card>
          ) : (
            <Card className="border-dashed">
              <CardContent className="py-10 text-center text-sm text-muted-foreground" data-testid="text-detail-placeholder">
                Select an MCQ to see full stem, options, answer, and reasoning.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
