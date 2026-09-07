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
import { ShieldCheck, Play, CircleStop, CheckCircle2, XCircle, RotateCcw, Loader2, ChevronDown, ChevronRight, Wrench, Trash2 } from "lucide-react";
import { McqFigure } from "@/components/McqFigure";
import type { McqRecord } from "@shared/schema";
import { McqEditDialog, type AiSuggestion } from "@/components/McqEditDialog";

// -----------------------------------------------------------------------------
// Quality — the AI sweep over the whole Black Bank, and its review queue.
//
// One AI audit sweep over every non-discarded question (the audit-mode
// adjudicator works each from first principles), then a review queue in bands:
//   poor — wrong/missing keyed answer (Apply writes the suggestion) or
//          unsalvageable as written
//   weak — ambiguous: >1 defensible answer as written
//   good — key confirmed; nothing to do
// Applied fixes live in the override layer, so they survive corpus re-ingests.
// -----------------------------------------------------------------------------

interface AuditRow {
  verdict: string;
  confidence: string;
  suggestedAnswer: string | null;
  correctedReason: string;
  disputeNote: string;
  suggestedStem: string | null;
  suggestedOptions: Record<string, string> | null;
  model: string;
  assessedAt: number;
  status: "suggested" | "applied" | "dismissed";
}
interface AuditItem { mcq: McqRecord; audit: AuditRow; applicable: boolean; stale: boolean }
interface AuditListPayload { items: AuditItem[]; total: number }
interface AuditStatusPayload {
  running: boolean;
  progress: { running: boolean; done: number; total: number };
  pending: number;
  total: number;
  counts: { poor: number; weak: number; good: number; handled: number; applicable: number };
  lastError: string;
  keyPresent: boolean;
  model: string;
}

// The bands: wrong/missing key or unsalvageable → poor, ambiguous → weak, key
// confirmed → good.
type Band = "poor" | "weak" | "good" | "handled";
const BAND_META: Record<Band, { label: string; cls: string }> = {
  poor:    { label: "Poor",    cls: "bg-red-500/15 text-red-700 dark:text-red-400 border border-red-500/25" },
  weak:    { label: "Weak",    cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/25" },
  good:    { label: "Good",    cls: "bg-teal-500/15 text-teal-700 dark:text-teal-400 border border-teal-500/25" },
  handled: { label: "Handled", cls: "bg-muted text-muted-foreground border border-border" },
};
function bandOf(verdict: string): Exclude<Band, "handled"> {
  if (verdict === "confirm_key") return "good";
  if (verdict === "ambiguous") return "weak";
  return "poor"; // change_answer or flawed
}
const VERDICT_LABEL: Record<string, string> = {
  confirm_key: "key confirmed",
  change_answer: "answer change",
  ambiguous: "ambiguous",
  flawed: "flawed",
};

const OPTION_KEYS = ["A", "B", "C", "D", "E"] as const;

function invalidateAudit() {
  queryClient.invalidateQueries({ queryKey: ["/api/mcqs/audit"] });
  queryClient.invalidateQueries({ queryKey: ["/api/mcqs/audit/status"] });
  queryClient.invalidateQueries({ queryKey: ["/api/mcqs"] });
  queryClient.invalidateQueries({ queryKey: ["/api/mcqs/stats"] });
  // A fix can clear a dispute; the Disputes queue keys on its own string.
  queryClient.invalidateQueries({ queryKey: ["/api/mcqs/triage"] });
}

function AuditItemRow({ item }: { item: AuditItem }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [fullEdit, setFullEdit] = useState(false);
  const { mcq, audit } = item;

  const act = useMutation({
    mutationFn: async (action: "apply" | "dismiss" | "reopen" | "mark-fixed") =>
      (await apiRequest("POST", `/api/mcqs/${encodeURIComponent(mcq.id)}/audit-${action}`)).json(),
    onSuccess: (_d, action) => {
      invalidateAudit();
      const label = action === "apply" ? "suggestion applied"
        : action === "mark-fixed" ? "fixed"
        : action === "dismiss" ? "dismissed" : "reopened";
      toast({ description: `${mcq.displayCode} → ${label}` });
    },
    onError: (e: any) => toast({ variant: "destructive", description: `Audit action failed: ${apiErrorText(e)}` }),
  });
  // Discard = the triage verdict: exclude the question from study pools + SRS.
  // The same endpoint the Disputes page uses, so the two pages share one
  // meaning of "discarded"; the question leaves the audit scope entirely.
  const discard = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/mcqs/${encodeURIComponent(mcq.id)}/triage`, { action: "discard" })).json(),
    onSuccess: () => {
      invalidateAudit();
      toast({ description: `${mcq.displayCode} → discarded from study rotation` });
    },
    onError: (e: any) => toast({ variant: "destructive", description: `Discard failed: ${apiErrorText(e)}` }),
  });
  const busy = act.isPending || discard.isPending;

  return (
    <Card data-testid={`audit-row-${mcq.id}`}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center flex-wrap gap-2">
          <button onClick={() => setExpanded((v) => !v)} className="text-muted-foreground hover:text-foreground"
            data-testid={`button-expand-${mcq.id}`} aria-label="Toggle detail">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          <span className="font-mono text-sm font-semibold">{mcq.displayCode}</span>
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${BAND_META[bandOf(audit.verdict)].cls}`}
            data-testid={`band-${mcq.id}`}>
            {bandOf(audit.verdict)}
          </span>
          <Badge variant="outline" className="font-normal">{mcq.topicName}</Badge>
          <span className="text-[10px] text-muted-foreground font-mono" title={`Audited by ${audit.model}`}>
            {VERDICT_LABEL[audit.verdict] ?? audit.verdict} · {audit.confidence}
          </span>
          {audit.status !== "suggested" && (
            <Badge variant="outline" className="text-[10px]">{audit.status}</Badge>
          )}
        </div>

        <div className="text-sm whitespace-pre-wrap">{mcq.stem}</div>
        <McqFigure figure={mcq.figure} />
        <ul className="space-y-1">
          {OPTION_KEYS.filter((k) => mcq.options[k]).map((k) => {
            const isCurrent = mcq.answer === k;
            const isSuggested = audit.suggestedAnswer === k && audit.verdict === "change_answer";
            return (
              <li key={k} className={`flex gap-2 text-sm rounded px-2 py-1 ${
                isSuggested ? "bg-sky-500/10 text-sky-800 dark:text-sky-300 font-medium"
                : isCurrent ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 font-medium"
                : "text-foreground/90"}`}>
                <span className="font-mono shrink-0">{k}.</span>
                <span className="whitespace-pre-wrap">{mcq.options[k]}</span>
                {isCurrent && <span className="ml-auto text-[10px] shrink-0 self-center text-muted-foreground">current</span>}
                {isSuggested && <span className="ml-auto text-[10px] shrink-0 self-center text-sky-700 dark:text-sky-400">suggested</span>}
              </li>
            );
          })}
        </ul>
        {!mcq.answer && audit.verdict === "change_answer" && (
          <div className="text-xs text-sky-700 dark:text-sky-400">
            No answer on record — the audit supplies {audit.suggestedAnswer ?? "?"} with reasoning.
          </div>
        )}
        {audit.disputeNote && <div className="text-xs text-muted-foreground">⚖ {audit.disputeNote}</div>}

        {expanded && (
          <div className="space-y-2">
            {audit.correctedReason && (
              <div className="rounded-md border border-border bg-muted/40 p-3 text-sm whitespace-pre-wrap break-words" data-testid={`audit-reason-${mcq.id}`}>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Audit reasoning</div>
                {audit.correctedReason}
              </div>
            )}
            {audit.suggestedStem && (
              <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-sm whitespace-pre-wrap" data-testid={`audit-stem-${mcq.id}`}>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Suggested stem rewrite</div>
                {audit.suggestedStem}
              </div>
            )}
            {audit.suggestedOptions && (
              <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-sm" data-testid={`audit-options-${mcq.id}`}>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Suggested options rewrite</div>
                <ul className="space-y-0.5">
                  {OPTION_KEYS.filter((k) => audit.suggestedOptions![k]).map((k) => (
                    <li key={k} className="flex gap-2"><span className="font-mono shrink-0">{k}.</span>{audit.suggestedOptions![k]}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Verdict actions — the Disputes row's workflow. "Fix…" opens the same
            full editor the Disputes page uses (stem, all options, answer,
            reasoning, AI suggest), pre-filled with this audit's stored
            suggestion; "Apply suggestion" is the one-click accept of exactly that. */}
        {/* A stale row's verdict describes content that has since changed. Stale
            SUGGESTED rows never reach a band list (they are reported as pending
            instead), so in practice this marks a HANDLED row whose question was
            edited after the fix landed — worth saying rather than leaving the
            reader to wonder why the stored suggestion doesn't match the text. */}
        {item.stale && (
          <div className="text-xs text-amber-700 dark:text-amber-400" data-testid={`stale-${mcq.id}`}>
            Content changed since this verdict — the next sweep will re-audit this question
          </div>
        )}

        <div className="flex items-center gap-2 pt-1 flex-wrap">
          {audit.status === "suggested" ? (
            <>
              {item.applicable && (
                <Button size="sm" variant="outline" className="text-sky-700 dark:text-sky-400"
                  onClick={() => act.mutate("apply")} disabled={busy} data-testid={`button-apply-${mcq.id}`}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                  Apply suggestion
                </Button>
              )}
              <Button size="sm" variant="outline" className="text-sky-700 dark:text-sky-400"
                onClick={() => setFullEdit(true)} disabled={busy} data-testid={`button-fix-${mcq.id}`}>
                <Wrench className="h-4 w-4 mr-1" /> Fix…
              </Button>
              <Button size="sm" variant="outline" className="text-muted-foreground"
                onClick={() => discard.mutate()} disabled={busy} data-testid={`button-discard-${mcq.id}`}>
                <Trash2 className="h-4 w-4 mr-1" /> Discard
              </Button>
              <Button size="sm" variant="ghost" className="text-muted-foreground"
                onClick={() => act.mutate("dismiss")} disabled={busy} data-testid={`button-dismiss-${mcq.id}`}>
                <XCircle className="h-4 w-4 mr-1" /> Dismiss verdict
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => act.mutate("reopen")} disabled={busy} data-testid={`button-reopen-${mcq.id}`}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RotateCcw className="h-4 w-4 mr-1" />}
              Reopen
            </Button>
          )}
        </div>
      </CardContent>

      {/* The canonical fix path, shared with the Disputes page. The stored audit
          verdict opens the editor in the exact post-"Suggest with AI" state
          (chip, note, rewritten fields); saving stores the override, then the
          verdict is marked fixed (re-hashed) so the question doesn't re-pend. */}
      <McqEditDialog
        mcq={mcq}
        open={fullEdit}
        onOpenChange={setFullEdit}
        resolveDisputeOnSave
        suggestMode="audit"
        suggestion={{
          verdict: audit.verdict as AiSuggestion["verdict"],
          suggestedAnswer: audit.suggestedAnswer,
          confidence: (audit.confidence || "medium") as AiSuggestion["confidence"],
          correctedReason: audit.correctedReason,
          disputeNote: audit.disputeNote,
          // Not persisted on the audit row; resolvable verdicts clear the flag,
          // matching the adjudicator's own contract.
          clearsDispute: audit.verdict === "confirm_key" || audit.verdict === "change_answer",
          suggestedStem: audit.suggestedStem,
          suggestedOptions: audit.suggestedOptions,
          model: audit.model,
        }}
        onSaved={() => act.mutate("mark-fixed")}
        // Revert restores the base corpus text — the verdict now describes
        // exactly that content again and must stay OPEN, not be marked fixed:
        // marking it fixed would put a known-wrong key back in the study pool
        // while hiding the question from the audit and every future sweep. The
        // verdict re-pends via the hash rule; we only refresh the page's data
        // (the dialog's own invalidateAll doesn't cover the audit keys).
        onReverted={() => invalidateAudit()}
      />
    </Card>
  );
}

export default function QualityPage() {
  const { toast } = useToast();
  const [band, setBand] = useState<Band>("poor");
  const [topic, setTopic] = useState<string>("all");
  const topicQ = topic !== "all" ? `topic=${encodeURIComponent(topic)}` : "";

  const status = useQuery<AuditStatusPayload>({
    queryKey: ["/api/mcqs/audit/status", topic],
    queryFn: async () => (await apiRequest("GET", `/api/mcqs/audit/status${topicQ ? `?${topicQ}` : ""}`)).json(),
    // Poll while a sweep is running so the bar and counts move. 3 s, not 1.5:
    // the endpoint hydrates the corpus server-side, and better-sqlite3 is
    // synchronous — every poll briefly blocks everything else the single
    // event loop serves for the whole multi-hour sweep. Progress moves once
    // per audited batch, so 3 s loses nothing.
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  });
  const running = status.data?.running ?? false;

  const list = useQuery<AuditListPayload>({
    queryKey: ["/api/mcqs/audit", band, topic],
    queryFn: async () => {
      const qs = [`band=${band}`, topicQ, "limit=100"].filter(Boolean).join("&");
      return (await apiRequest("GET", `/api/mcqs/audit?${qs}`)).json();
    },
    refetchInterval: () => (running ? 4000 : false),
  });

  // The sweep is fire-and-forget: /audit/run returns before a single verdict
  // exists, and the status poll above is the ONLY thing that learns it ended.
  // The queue's own 4 s poll is cleared by the very render that flips `running`
  // false, so the newest list it ever fetched can be up to 4 s older than the
  // sweep's final writes — and under this app's client (staleTime: Infinity,
  // refetchOnWindowFocus: false — lib/queryClient.ts) nothing fetches it again.
  // Without this the queue and the band chips keep rendering the mid-sweep
  // snapshot until a row action or a full reload. Refetch on the falling edge
  // of `running` — not in the run mutation's onSuccess, which fires when the
  // run STARTS, and not on every status poll, which would re-fetch the whole
  // queue every 3 s for the length of a multi-hour sweep.
  //
  // Two calls because array keys match element-wise: "/api/mcqs/audit" is NOT a
  // prefix of the string "/api/mcqs/audit/status", so the list key never
  // reaches the counts (invalidateAudit() splits them for the same reason). By
  // PREFIX, deliberately, rather than this render's [band, topic]: every cached
  // band and topic scope is equally stale after a sweep.
  const wasRunning = useRef(running);
  useEffect(() => {
    const sweepJustEnded = wasRunning.current && !running;
    wasRunning.current = running;
    if (sweepJustEnded) {
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/audit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/audit/status"] });
    }
  }, [running]);

  // Topic scope options from the stats rollup (whole corpus, override-aware).
  const stats = useQuery<{ byTopic: Array<{ slug: string; name: string; count: number }> }>({
    queryKey: ["/api/mcqs/stats"],
  });

  const run = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/mcqs/audit/run", topic !== "all" ? { topic } : {})).json(),
    onSuccess: () => { invalidateAudit(); },
    onError: (e: any) => toast({ variant: "destructive", description: `Couldn't start the audit: ${apiErrorText(e)}` }),
  });
  const stop = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/mcqs/audit/stop")).json(),
    onError: (e: any) => toast({ variant: "destructive", description: `Couldn't stop the audit: ${apiErrorText(e)}` }),
    onSettled: () => invalidateAudit(),
  });
  // Bulk approve — every applicable suggestion in scope, behind a second-click
  // confirm (a stray click must not rewrite dozens of questions). The count on
  // the button is the server's own applicable tally, computed by the same
  // predicate apply-all runs, so the label can't promise more than it does.
  const [confirmApproveAll, setConfirmApproveAll] = useState(false);
  const approveAll = useMutation<{ applied: number; skipped: number; failed: Array<{ id: string; error: string }> }>({
    mutationFn: async () => (await apiRequest("POST", "/api/mcqs/audit/apply-all", topic !== "all" ? { topic } : {})).json(),
    onSuccess: (r) => {
      toast({
        description: `Applied ${r.applied} fix${r.applied === 1 ? "" : "es"}${r.failed.length ? ` · ${r.failed.length} failed — rows keep their Apply button` : ""}`,
        variant: r.failed.length ? "destructive" : undefined,
      });
    },
    onError: (e: any) => toast({ variant: "destructive", description: `Bulk approve failed: ${apiErrorText(e)}` }),
    onSettled: () => { setConfirmApproveAll(false); invalidateAudit(); },
  });

  // A pending confirm is a promise about a specific scope — changing the
  // topic silently changes what "all" means, so drop back to the first click.
  useEffect(() => { setConfirmApproveAll(false); }, [topic]);

  const s = status.data;
  const assessed = s ? s.total - s.pending : 0;
  const pct = s && s.total > 0 ? (assessed / s.total) * 100 : 0;
  const runPct = s?.progress.total ? Math.round((s.progress.done / s.progress.total) * 100) : 0;

  const bands = useMemo(() => ([
    ["poor", s?.counts.poor], ["weak", s?.counts.weak],
    ["good", s?.counts.good], ["handled", s?.counts.handled],
  ] as Array<[Band, number | undefined]>), [s]);

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      <div>
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Black Bank corpus</div>
        <h1 className="font-serif text-xl leading-tight flex items-center gap-2" data-testid="text-page-title">
          <ShieldCheck className="h-5 w-5 text-primary" /> Quality
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          The whole-bank AI sweep — nobody flagged these questions. The examiner model works every question
          from first principles, confirms sound keys, and proposes fixes for wrong or missing answers,
          garbled stems and broken options. Verdicts come from the model's own knowledge of the prescribed
          texts (this site carries no textbook index), so read anything before you apply it. Applied fixes
          live in the override layer and survive corpus re-ingests. Questions flagged as contested live in{" "}
          <Link href="/disputes" className="underline underline-offset-2 hover:text-foreground" data-testid="link-to-disputes">Disputes</Link>.
        </p>
      </div>

      {/* Run controls + coverage */}
      <Card>
        <CardContent className="pt-4 pb-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={topic} onValueChange={setTopic}>
              <SelectTrigger className="h-9 w-56" data-testid="select-audit-topic"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Whole corpus</SelectItem>
                {(stats.data?.byTopic ?? []).map((t) => (
                  <SelectItem key={t.slug} value={t.slug}>{t.name} ({t.count})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {running ? (
              <Button size="sm" variant="outline" onClick={() => stop.mutate()} data-testid="button-audit-stop">
                <CircleStop className="h-4 w-4 mr-1" /> Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => run.mutate()}
                disabled={run.isPending || !s || s.pending === 0 || !s.keyPresent}
                title={!s?.keyPresent ? "AI not configured on this server (OPENAI_API_KEY missing)" : s?.pending === 0 ? "Everything in scope has a fresh verdict" : undefined}
                data-testid="button-audit-run">
                {run.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Play className="h-4 w-4 mr-1" />}
                Audit {s?.pending ?? 0} unassessed
              </Button>
            )}
            {!running && (s?.counts.applicable ?? 0) > 0 && (
              confirmApproveAll ? (
                <>
                  <Button size="sm" className="bg-sky-600 hover:bg-sky-600/90 text-white"
                    onClick={() => approveAll.mutate()} disabled={approveAll.isPending}
                    data-testid="button-approve-all-confirm">
                    {approveAll.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                    Yes, apply {s!.counts.applicable} — sure?
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmApproveAll(false)}
                    disabled={approveAll.isPending} data-testid="button-approve-all-cancel">
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" className="text-sky-700 dark:text-sky-400"
                  onClick={() => setConfirmApproveAll(true)}
                  title="Apply every suggested fix in this scope — the same edit each row's Apply button makes, written to the override layer"
                  data-testid="button-approve-all">
                  <CheckCircle2 className="h-4 w-4 mr-1" /> Approve all {s!.counts.applicable}
                </Button>
              )
            )}
            <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums" data-testid="text-audit-coverage">
              {assessed}/{s?.total ?? 0} audited
            </span>
          </div>
          {running && (
            <div className="space-y-1" data-testid="audit-run-progress">
              <Progress value={runPct} className="h-1.5" />
              <div className="text-xs text-muted-foreground">
                Auditing… {s?.progress.done ?? 0} of {s?.progress.total ?? 0} this run ({runPct}%) — verdicts stream in below.
              </div>
            </div>
          )}
          {!running && <Progress value={pct} className="h-1.5" />}
          {s && !s.keyPresent && (
            <div className="text-xs text-amber-600 dark:text-amber-400" data-testid="audit-no-key">
              AI is not configured on this server — set OPENAI_API_KEY (see README) to run the sweep.
              Verdicts already stored can still be reviewed and applied below.
            </div>
          )}
          {s?.lastError && (
            <div className="text-xs text-amber-600 dark:text-amber-400 break-words" data-testid="audit-last-error">
              Last run problem: {s.lastError}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {bands.map(([key, n]) => (
              <button key={key} onClick={() => setBand(key)}
                className={`px-2.5 py-1 rounded-full border transition-colors ${
                  band === key ? "bg-primary text-primary-foreground border-transparent" : "bg-muted text-muted-foreground border-border hover:bg-muted/70"
                }`}
                data-testid={`filter-band-${key}`}>
                {BAND_META[key].label} {n ?? 0}
              </button>
            ))}
            {(s?.pending ?? 0) > 0 && (
              <span className="text-muted-foreground ml-auto" data-testid="text-audit-pending">
                {s!.pending} not yet audited
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Verdict queue */}
      {list.isError ? (
        <div className="text-sm text-amber-600 dark:text-amber-400 py-8 text-center" data-testid="audit-list-error">
          Couldn't load the audit queue — refresh to retry.
        </div>
      ) : !list.data ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : list.data.items.length === 0 ? (
        <div className="text-sm text-muted-foreground py-10 text-center" data-testid="text-audit-empty">
          {(s?.total ?? 0) > 0 && assessed === 0
            ? "Nothing audited yet — run the sweep above."
            : `No ${BAND_META[band].label.toLowerCase()} verdicts${topic !== "all" ? " in this topic" : ""}.`}
        </div>
      ) : (
        <>
          {list.data.total > list.data.items.length && (
            <div className="text-xs text-muted-foreground" data-testid="audit-truncation-note">
              Showing the newest {list.data.items.length} of {list.data.total} — handle these and refresh, or narrow by topic.
            </div>
          )}
          {list.data.items.map((item) => <AuditItemRow key={item.mcq.id} item={item} />)}
        </>
      )}
    </div>
  );
}
