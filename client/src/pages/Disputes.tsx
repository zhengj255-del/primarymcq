import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, apiErrorText } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Scale, CheckCircle2, Wrench, Trash2, RotateCcw, ExternalLink, Loader2, ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { McqFigure } from "@/components/McqFigure";
import type { McqRecord, McqTriageStatus } from "@shared/schema";
import { McqEditDialog } from "@/components/McqEditDialog";

// -----------------------------------------------------------------------------
// Disputed MCQs — a review queue over the corpus's disputed questions.
//
// Every verdict is one POST to /api/mcqs/:id/triage:
//   accept  → the dispute is noise; the answer/content stands as-is
//   fix     → apply a corrected answer/explanation AND clear the dispute
//   discard → the question is unsalvageable; exclude it from study pools + SRS
//   reopen  → undo a verdict (content edits are kept)
// Verdicts live in the override layer, so a corpus re-ingest can't undo them.
//
// Disputed questions never enter a study session until they are accepted,
// fixed or discarded here — this page is the only way back into rotation.
//
// The bulk lane borrows the Quality page's sweep: "Adjudicate" asks the
// examiner model for a verdict on every undecided dispute (verdicts only,
// nothing is applied), then "Resolve" accepts every confirmed key and applies
// every adjudicated answer change through the one apply path. Ambiguous and
// flawed verdicts always stay for the human.
// -----------------------------------------------------------------------------

type TriageItem = McqRecord & { triageStatus: McqTriageStatus };
interface Adjudication { verdict: string; suggestedAnswer: string | null; applicable: boolean; stale: boolean }
interface TriagePayload {
  counts: { pending: number; accepted: number; fixed: number; discarded: number; total: number };
  items: TriageItem[];
  // Fresh stored verdicts for the disputed pile (same predicates the server's
  // resolve-all acts with), keyed by mcq id.
  adjudications?: Record<string, Adjudication>;
}

// What bulk resolution will DO with each verdict — shown on pending rows.
const ADJUDICATION_META: Record<string, { label: string; cls: string }> = {
  confirm_key:   { label: "adjudicated: key stands — resolves as Accept", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  change_answer: { label: "adjudicated: answer change — resolves as Fix", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-400" },
  ambiguous:     { label: "adjudicated: ambiguous — stays with you", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  flawed:        { label: "adjudicated: flawed — stays with you", cls: "bg-rose-500/15 text-rose-700 dark:text-rose-400" },
};

const OPTION_KEYS = ["A", "B", "C", "D", "E"] as const;

const STATUS_META: Record<McqTriageStatus, { label: string; cls: string }> = {
  pending:   { label: "Pending",   cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  accepted:  { label: "Accepted",  cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  fixed:     { label: "Fixed",     cls: "bg-sky-500/15 text-sky-700 dark:text-sky-400" },
  discarded: { label: "Discarded", cls: "bg-muted text-muted-foreground line-through" },
};

function invalidateTriage() {
  queryClient.invalidateQueries({ queryKey: ["/api/mcqs/triage"] });
  queryClient.invalidateQueries({ queryKey: ["/api/mcqs/stats"] });
  queryClient.invalidateQueries({ queryKey: ["/api/mcqs"] });
}

function TriageRow({ item, adjudication }: { item: TriageItem; adjudication?: Adjudication }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [fullEdit, setFullEdit] = useState(false);

  const triage = useMutation({
    mutationFn: async (body: { action: string; edit?: Record<string, unknown> }) =>
      (await apiRequest("POST", `/api/mcqs/${encodeURIComponent(item.id)}/triage`, body)).json() as Promise<TriageItem>,
    onSuccess: (updated) => {
      invalidateTriage();
      toast({ description: `${item.displayCode} → ${STATUS_META[updated.triageStatus].label.toLowerCase()}` });
    },
    onError: (e: any) => toast({ variant: "destructive", description: `Triage failed: ${apiErrorText(e)}` }),
  });

  const meta = STATUS_META[item.triageStatus];
  const busy = triage.isPending;

  return (
    <Card data-testid={`triage-row-${item.id}`}>
      <CardContent className="p-4 space-y-3">
        {/* Header: code · topic · papers · status */}
        <div className="flex items-center flex-wrap gap-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-muted-foreground hover:text-foreground"
            data-testid={`button-expand-${item.id}`}
            aria-label="Toggle explanation"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          <span className="font-mono text-sm font-semibold">{item.displayCode}</span>
          <Badge variant="outline" className="font-normal">{item.topicName}</Badge>
          {item.papers.slice(0, 4).map((p) => (
            <span key={p} className="font-mono text-[10px] text-muted-foreground">{p}</span>
          ))}
          {item.edited && <Badge variant="outline" className="text-[10px] gap-1"><Pencil className="h-2.5 w-2.5" /> edited</Badge>}
          <span className={`ml-auto inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${meta.cls}`} data-testid={`status-${item.id}`}>
            {meta.label}
          </span>
          {item.triageStatus === "pending" && adjudication && !adjudication.stale && ADJUDICATION_META[adjudication.verdict] && (
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] ${ADJUDICATION_META[adjudication.verdict].cls}`}
              data-testid={`adjudication-${item.id}`}>
              {ADJUDICATION_META[adjudication.verdict].label}
              {adjudication.verdict === "change_answer" && adjudication.suggestedAnswer ? ` → ${adjudication.suggestedAnswer}` : ""}
            </span>
          )}
        </div>

        {/* Stem + options */}
        <div className={`text-sm whitespace-pre-wrap ${item.triageStatus === "discarded" ? "opacity-50" : ""}`}>{item.stem}</div>
        <McqFigure figure={item.figure} />
        <ul className="space-y-1">
          {OPTION_KEYS.filter((k) => item.options[k]).map((k) => (
            <li
              key={k}
              className={`flex gap-2 text-sm rounded px-2 py-1 ${
                item.answer === k ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 font-medium" : "text-foreground/90"
              }`}
            >
              <span className="font-mono shrink-0">{k}.</span>
              <span className="whitespace-pre-wrap">{item.options[k]}</span>
            </li>
          ))}
        </ul>
        {!item.answer && (
          <div className="text-xs text-signal-amber">No answer on record — the usual reason a question is disputed.</div>
        )}

        {/* Explanation / dispute discussion (collapsed by default — often long) */}
        {expanded && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm whitespace-pre-wrap break-words" data-testid={`reason-${item.id}`}>
            {item.reason?.trim() ? item.reason : <span className="text-muted-foreground">No explanation recorded.</span>}
            {item.urls.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-3">
                {item.urls.map((u) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline text-muted-foreground hover:text-foreground">
                    <ExternalLink className="h-3 w-3" /> source
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Verdict actions. "Fix…" opens the full editor directly — the single,
            canonical fix path (stem, all options, answer, reasoning, AI suggest). */}
        <div className="flex items-center gap-2 pt-1">
          {item.triageStatus === "pending" ? (
            <>
              <Button size="sm" variant="outline" className="text-emerald-700 dark:text-emerald-400"
                onClick={() => triage.mutate({ action: "accept" })} disabled={busy} data-testid={`button-accept-${item.id}`}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                Accept as-is
              </Button>
              <Button size="sm" variant="outline" className="text-sky-700 dark:text-sky-400"
                onClick={() => setFullEdit(true)} disabled={busy} data-testid={`button-fix-${item.id}`}>
                <Wrench className="h-4 w-4 mr-1" /> Fix…
              </Button>
              <Button size="sm" variant="outline" className="text-muted-foreground"
                onClick={() => triage.mutate({ action: "discard" })} disabled={busy} data-testid={`button-discard-${item.id}`}>
                <Trash2 className="h-4 w-4 mr-1" /> Discard
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => triage.mutate({ action: "reopen" })} disabled={busy} data-testid={`button-reopen-${item.id}`}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RotateCcw className="h-4 w-4 mr-1" />}
              Reopen
            </Button>
          )}
        </div>
      </CardContent>

      {/* Full structural editor (stem/options) for the deep fix. Saving there
          stores the content override with the Disputed toggle pre-set OFF, so
          the status derives as "fixed" (content was edited, dispute cleared). */}
      <McqEditDialog mcq={item} open={fullEdit} onOpenChange={setFullEdit} onSaved={() => invalidateTriage()} resolveDisputeOnSave />
    </Card>
  );
}

export default function DisputesPage() {
  const { toast } = useToast();
  const { data, isError: triageError } = useQuery<TriagePayload>({ queryKey: ["/api/mcqs/triage"] });
  const [statusFilter, setStatusFilter] = useState<McqTriageStatus | "all">("pending");
  const [topicFilter, setTopicFilter] = useState<string>("all");

  // Shared run state with the Quality page — the adjudication sweep IS the
  // audit run scoped to disputes, so its progress and keyPresent come from
  // the same status endpoint. Poll only while it runs.
  const auditStatus = useQuery<{ running: boolean; progress: { done: number; total: number }; keyPresent: boolean }>({
    queryKey: ["/api/mcqs/audit/status"],
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  });
  const running = auditStatus.data?.running ?? false;

  // The sweep is fire-and-forget: the POST returns before a single verdict
  // exists, and the status poll is the ONLY thing that learns it has ended.
  // Every verdict it stores rides on ["/api/mcqs/triage"] — the same payload as
  // the items and the counts — and this app's client runs with
  // staleTime: Infinity + refetchOnWindowFocus: false (lib/queryClient.ts), so
  // without this the queue keeps rendering the snapshot taken BEFORE the sweep:
  // no verdict badges, "Adjudicate N undecided" stuck at the old N and the
  // "Resolve N adjudicated" button never appearing, until a row action or a
  // full reload. Refetch on the falling edge of `running` — not in the
  // adjudicate mutation's onSuccess, which fires when the run STARTS, and not
  // on every status poll, which would re-fetch the whole queue every 3 s.
  // The edge fires for a sweep kicked from the Quality page too: both pages
  // read the one status endpoint, and a whole-bank audit stores verdicts for
  // disputed questions just the same.
  const wasRunning = useRef(running);
  useEffect(() => {
    const sweepJustEnded = wasRunning.current && !running;
    wasRunning.current = running;
    // Only the triage payload: the sweep writes verdicts, never MCQ content or
    // dispute status, so /api/mcqs and /api/mcqs/stats are untouched by it
    // (resolve-all, which does move those, invalidates them itself below).
    if (sweepJustEnded) queryClient.invalidateQueries({ queryKey: ["/api/mcqs/triage"] });
  }, [running]);

  const adjudicate = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/mcqs/triage/adjudicate", topicFilter !== "all" ? { topic: topicFilter } : {})).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/mcqs/audit/status"] }),
    onError: (e: any) => toast({ variant: "destructive", description: `Couldn't start adjudication: ${apiErrorText(e)}` }),
  });

  const [confirmResolve, setConfirmResolve] = useState(false);
  const resolveAll = useMutation<{ accepted: number; fixed: number; left: number; unadjudicated: number; failed: Array<{ id: string; error: string }> }>({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/mcqs/triage/resolve-all", topicFilter !== "all" ? { topic: topicFilter } : {})).json(),
    onSuccess: (r) => {
      const bits = [
        r.accepted ? `${r.accepted} accepted (key stands)` : null,
        r.fixed ? `${r.fixed} fixed (answer applied)` : null,
        r.left ? `${r.left} left for you (ambiguous/flawed)` : null,
        r.unadjudicated ? `${r.unadjudicated} still need adjudication` : null,
        r.failed.length ? `${r.failed.length} failed` : null,
      ].filter(Boolean);
      toast({ description: bits.length ? `Resolved — ${bits.join(" · ")}` : "Nothing to resolve.", variant: r.failed.length ? "destructive" : undefined });
    },
    onError: (e: any) => toast({ variant: "destructive", description: `Resolve failed: ${apiErrorText(e)}` }),
    onSettled: () => {
      setConfirmResolve(false);
      invalidateTriage();
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/audit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/audit/status"] });
    },
  });

  // A pending confirm promises a specific scope — a topic change re-arms.
  useEffect(() => setConfirmResolve(false), [topicFilter]);

  const topics = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of data?.items ?? []) m.set(it.topicSlug, it.topicName);
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const shown = useMemo(() => {
    let items = data?.items ?? [];
    if (statusFilter !== "all") items = items.filter((i) => i.triageStatus === statusFilter);
    if (topicFilter !== "all") items = items.filter((i) => i.topicSlug === topicFilter);
    return items;
  }, [data, statusFilter, topicFilter]);

  const c = data?.counts;
  const resolved = c ? c.total - c.pending : 0;
  const pct = c && c.total > 0 ? (resolved / c.total) * 100 : 0;

  // Bulk numbers for the CURRENT topic scope, from the same predicates the
  // server acts with: resolvable = fresh confirm_key, or fresh applicable
  // change_answer; undecided = pending with no fresh verdict.
  const pendingInScope = useMemo(
    () => (data?.items ?? []).filter((i) => i.triageStatus === "pending" && (topicFilter === "all" || i.topicSlug === topicFilter)),
    [data, topicFilter],
  );
  const { resolvable, undecided } = useMemo(() => {
    let res = 0, und = 0;
    for (const i of pendingInScope) {
      const a = data?.adjudications?.[i.id];
      if (!a || a.stale) { und++; continue; }
      if (a.verdict === "confirm_key" || (a.verdict === "change_answer" && a.applicable)) res++;
    }
    return { resolvable: res, undecided: und };
  }, [pendingInScope, data]);

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      <div>
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Black Bank corpus</div>
        <h1 className="font-serif text-xl leading-tight flex items-center gap-2" data-testid="text-page-title">
          <Scale className="h-5 w-5 text-primary" /> Disputed MCQs
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Questions flagged as contested — by you while studying, or shipped disputed in the corpus.
          Disputed questions never enter a study session until they are accepted, fixed or discarded
          here. Work through each once: accept it as-is, fix the answer/explanation, or discard it
          from study rotation. Verdicts survive corpus re-ingests. Looking for the whole-bank AI sweep
          instead? <Link href="/quality" className="underline underline-offset-2 hover:text-foreground" data-testid="link-to-quality">Quality</Link>.
        </p>
      </div>

      {/* Progress + status filter */}
      <Card>
        <CardContent className="pt-4 pb-4 space-y-3">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium" data-testid="text-triage-progress">
              {resolved} of {c?.total ?? 0} triaged
            </span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{pct.toFixed(0)}%</span>
          </div>
          <Progress value={pct} className="h-1.5" />
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {([["pending", c?.pending], ["accepted", c?.accepted], ["fixed", c?.fixed], ["discarded", c?.discarded], ["all", c?.total]] as const).map(([key, n]) => (
              <button
                key={key}
                onClick={() => setStatusFilter(key as McqTriageStatus | "all")}
                className={`px-2.5 py-1 rounded-full border transition-colors ${
                  statusFilter === key ? "bg-primary text-primary-foreground border-transparent" : "bg-muted text-muted-foreground border-border hover:bg-muted/70"
                }`}
                data-testid={`filter-status-${key}`}
              >
                {key === "all" ? "All" : STATUS_META[key as McqTriageStatus].label} {n ?? 0}
              </button>
            ))}
            <div className="ml-auto">
              <Select value={topicFilter} onValueChange={setTopicFilter}>
                <SelectTrigger className="h-8 w-52" data-testid="select-triage-topic"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All topics</SelectItem>
                  {topics.map(([slug, name]) => <SelectItem key={slug} value={slug}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Bulk lane — the audit's fix mechanism pointed at the disputed pile:
              adjudicate the undecided, then resolve what the examiner decided.
              Ambiguous/flawed verdicts always stay for the human. */}
          {(c?.pending ?? 0) > 0 && (
            <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border">
              {running ? (
                <span className="text-xs text-muted-foreground" data-testid="triage-adjudicating">
                  <Loader2 className="h-3.5 w-3.5 mr-1 inline animate-spin" />
                  Adjudicating… {auditStatus.data?.progress.done ?? 0} of {auditStatus.data?.progress.total ?? 0}
                </span>
              ) : (
                <>
                  {undecided > 0 && (
                    <Button size="sm" variant="outline" onClick={() => adjudicate.mutate()}
                      disabled={adjudicate.isPending || !auditStatus.data?.keyPresent}
                      title={!auditStatus.data?.keyPresent ? "AI not configured on this server (OPENAI_API_KEY missing)" : `Ask the examiner model to adjudicate the ${undecided} undecided dispute${undecided === 1 ? "" : "s"} in this scope — verdicts only, nothing is applied`}
                      data-testid="button-adjudicate">
                      {adjudicate.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Scale className="h-4 w-4 mr-1" />}
                      Adjudicate {undecided} undecided
                    </Button>
                  )}
                  {resolvable > 0 && (
                    confirmResolve ? (
                      <>
                        <Button size="sm" className="bg-sky-600 hover:bg-sky-600/90 text-white"
                          onClick={() => resolveAll.mutate()} disabled={resolveAll.isPending}
                          data-testid="button-resolve-all-confirm">
                          {resolveAll.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                          Yes, resolve {resolvable} — sure?
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmResolve(false)}
                          disabled={resolveAll.isPending} data-testid="button-resolve-all-cancel">
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" className="text-sky-700 dark:text-sky-400"
                        onClick={() => setConfirmResolve(true)}
                        title="Accept every dispute the examiner confirmed (key stands, content untouched) and apply every adjudicated answer change — ambiguous/flawed stay in your queue"
                        data-testid="button-resolve-all">
                        <CheckCircle2 className="h-4 w-4 mr-1" /> Resolve {resolvable} adjudicated
                      </Button>
                    )
                  )}
                  {undecided === 0 && resolvable === 0 && (
                    <span className="text-xs text-muted-foreground" data-testid="triage-bulk-none">
                      Every pending dispute here is adjudicated ambiguous/flawed — those need your judgement, row by row.
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Queue */}
      {triageError ? (
        <div className="text-sm text-amber-600 dark:text-amber-400 py-8 text-center" data-testid="triage-error">
          Couldn't load the dispute queue — refresh to retry.
        </div>
      ) : !data ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="text-sm text-muted-foreground py-10 text-center" data-testid="text-triage-empty">
          {statusFilter === "pending" && (c?.pending ?? 0) === 0 && (c?.total ?? 0) > 0
            ? "Queue clear — every dispute has a verdict."
            : "Nothing matches this filter."}
        </div>
      ) : (
        shown.map((item) => <TriageRow key={item.id} item={item} adjudication={data?.adjudications?.[item.id]} />)
      )}
    </div>
  );
}
