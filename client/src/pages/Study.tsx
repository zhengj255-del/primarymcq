// -------------------------------------------------------------------------------------------------
// Study — MCQ testing / tutor / SRS runner.
//
// Structure:
//   <Study>                       page wrapper; owns the "phase" state machine
//     ├─ <ModeSelector />         card-picker for Test / Tutor / SRS
//     ├─ <FilterBuilder />        topic/domain/LO/count/time
//     ├─ <SessionRunner />        question view, submit, feedback, progress bar
//     ├─ <SessionSummary />       accuracy, per-topic, per-attempt review
//     └─ <StudyStats />           stats view when idle
// -------------------------------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient, isHttpRefusal } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SittingTag } from "@/components/SittingTag";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Timer, GraduationCap, Repeat, CheckCircle2, XCircle, ChevronRight,
  Flame, Clock, TrendingUp, BarChart3, AlertCircle, History, ArrowLeft, Pencil,
  Undo2,
} from "lucide-react";
import { McqEditDialog } from "@/components/McqEditDialog";
import { McqFigure } from "@/components/McqFigure";
import { RevertMcqButton } from "@/components/RevertMcqButton";
import { presentOptionKeys } from "@/lib/optionShuffle";
import type {
  McqRecord, SessionFilters, SessionSummary, McqUserStats,
} from "@shared/schema";

// -------------------------------------------------------------------------------------------------
// API response shapes
// -------------------------------------------------------------------------------------------------

interface StartResp {
  // null in SRS — spaced review is a derived queue, not a recorded session.
  sessionId: string | null;
  mode: "test" | "tutor" | "srs";
  mcqs: McqRecord[];
  timeLimitSec: number | null;
}
interface AttemptResp {
  correct: boolean;
  correctAnswer: string | null;
  reason: string;
  srs?: { dueAt: number; intervalDays: number; stability: number; difficulty: number; reps: number };
  srsPreview?: { again: number; hard: number; good: number; easy: number };
}
interface McqStats {
  total: number; withAnswer: number;
  byTopic: Array<{ slug: string; name: string; domain: string; count: number; linked: number }>;
  // Every exam sitting the bank knows, newest first: `key` is what a session filter takes ("2026B"),
  // `label` is how the college names it ("2026.2").
  sittings: Array<{ key: string; label: string; count: number; sittable?: number }>;
}

type Mode = "test" | "tutor" | "srs";

/** The paper-picker side note. A finished test OR tutor sitting is recorded
 *  under Recent sessions with its score (the server lists every non-SRS
 *  session), so the only real difference between the two is WHEN the answers
 *  are revealed — and that is what the note says. */
export function paperSittingNote(mode: Mode): string {
  return mode === "test"
    ? "Sitting the full paper — answers are revealed at the end, and it shows under Recent sessions with its score."
    : "Practice run — each answer is revealed as you go; it still shows under Recent sessions with its score.";
}
type Phase = "idle" | "running" | "summary";

// ------------------------------------------------------------------------
// Mid-session persistence. The whole run used to live only in useState: one
// pull-to-refresh (or any nav tap — navigation unmounts this page) threw
// away a 100-question paper silently, and the sitting never reached /finish.
// Snapshot the session to sessionStorage on every answer and offer an
// explicit resume. sessionStorage (not localStorage): scoped to the tab,
// gone when it closes — a stale days-old paper should not haunt a fresh
// visit.
const STUDY_SNAPSHOT_KEY = "study.session.v1";
export type StudySnapshot = {
  session: StartResp;
  idx: number;
  answered: Array<{ mcqId: string; selected: string | null; correct: boolean }>;
  sessionStartMs: number;
};
export function loadStudySnapshot(): StudySnapshot | null {
  try {
    const raw = window.sessionStorage?.getItem(STUDY_SNAPSHOT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StudySnapshot;
    if (!s?.session?.sessionId || !Array.isArray(s.session.mcqs)) return null;
    // SRS snapshots are never written any more; drop any left by an older
    // build rather than offering to resume a queue that has since moved on.
    if (s.session.mode === "srs") return null;
    return s;
  } catch { return null; }
}
export function saveStudySnapshot(s: StudySnapshot): void {
  try { window.sessionStorage?.setItem(STUDY_SNAPSHOT_KEY, JSON.stringify(s)); } catch { /* quota/private mode */ }
}
export function clearStudySnapshot(): void {
  try { window.sessionStorage?.removeItem(STUDY_SNAPSHOT_KEY); } catch { /* ignore */ }
}

const MODE_META: Record<Mode, { title: string; icon: any; blurb: string; accent: string }> = {
  test: {
    title: "Test",
    icon: Timer,
    blurb: "Exam-style. Answer, no feedback until you finish.",
    accent: "text-primary",
  },
  tutor: {
    title: "Tutor",
    icon: GraduationCap,
    blurb: "Immediate feedback. See the answer and reason after each question.",
    accent: "text-primary",
  },
  srs: {
    title: "Spaced review",
    icon: Repeat,
    blurb: "Anki-style. Rate each answer to schedule the next review.",
    accent: "text-primary",
  },
};

// -------------------------------------------------------------------------------------------------
// Root page component
// -------------------------------------------------------------------------------------------------

export default function StudyPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  // SRS-first: the scheduler only learns from sessions that run through it.
  // Test/Tutor stay one click away for paper sits and untimed browsing.
  const [mode, setMode] = useState<Mode>("srs");
  const [session, setSession] = useState<StartResp | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  // A snapshot saved by a previous mount of this page (refresh or navigation
  // mid-run). Offered, never auto-restored: silently dropping the user into
  // question 37 would be its own surprise.
  const [pendingResume, setPendingResume] = useState<StudySnapshot | null>(() => loadStudySnapshot());
  const [resume, setResume] = useState<StudySnapshot | null>(null);

  const reset = () => {
    setPhase("idle");
    setSession(null);
    setSummary(null);
    setResume(null);
    // Surface the resume offer again if a snapshot survives (e.g. the user
    // backed out of a running session with "New session" — the snapshot is
    // only cleared by finishing or explicitly discarding).
    setPendingResume(loadStudySnapshot());
  };

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-6" data-testid="page-study">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-xl md:text-2xl">Study</h1>
          <p className="text-sm text-muted-foreground">
            Test yourself, learn interactively, or work your spaced-repetition queue.
          </p>
        </div>
        {phase !== "idle" && (
          <Button variant="ghost" size="sm" onClick={reset} data-testid="button-study-home">
            <ArrowLeft className="h-4 w-4 mr-1" /> New session
          </Button>
        )}
      </header>

      {phase === "idle" && pendingResume && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 flex flex-wrap items-center gap-3" data-testid="study-resume-banner">
          <div className="text-sm">
            A {pendingResume.session.mode} session is in progress — {pendingResume.answered.length} of {pendingResume.session.mcqs.length} answered.
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Button size="sm" data-testid="button-study-resume" onClick={() => {
              setResume(pendingResume);
              setSession(pendingResume.session);
              setPendingResume(null);
              setPhase("running");
            }}>Resume</Button>
            <Button size="sm" variant="ghost" data-testid="button-study-discard" onClick={() => {
              clearStudySnapshot();
              setPendingResume(null);
            }}>Discard</Button>
          </div>
        </div>
      )}
      {phase === "idle" && (
        <>
          <ModeSelector mode={mode} onChange={setMode} />
          <FilterBuilder
            mode={mode}
            onStart={(s) => {
              setSession(s);
              setPhase("running");
            }}
          />
          <StudyStats />
        </>
      )}

      {phase === "running" && session && (
        <SessionRunner
          session={session}
          resume={resume ?? undefined}
          onFinish={(s) => {
            // SRS returns null: there is no scored sitting to show. Landing
            // back on the deck screen — now reading 0 new / 0 learning /
            // 0 to review, or whatever is genuinely left — IS the Anki
            // "finished for now" state, and it stays truthful if the queue
            // is not actually empty (daily limit reached, more due tomorrow).
            if (!s) { reset(); return; }
            setSummary(s);
            setPhase("summary");
          }}
        />
      )}

      {phase === "summary" && summary && (
        <SessionSummaryView summary={summary} onDone={reset} />
      )}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Mode selector
// -------------------------------------------------------------------------------------------------

function ModeSelector({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {(Object.keys(MODE_META) as Mode[]).map((m) => {
        const meta = MODE_META[m];
        const Icon = meta.icon;
        const selected = mode === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            data-testid={`button-mode-${m}`}
            className={`text-left rounded-lg border p-4 transition-colors hover-elevate ${
              selected ? "border-primary bg-primary/5" : "border-border bg-card"
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <Icon className={`h-4 w-4 ${meta.accent}`} />
              <div className="font-medium text-sm">{meta.title}</div>
              {selected && <CheckCircle2 className="h-4 w-4 text-primary ml-auto" />}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{meta.blurb}</p>
          </button>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Filter builder — topics, domains, LO codes, weak-areas, count, time-limit
// -------------------------------------------------------------------------------------------------

type SrsQueueStats = {
  learning: number; dueLearning: number;
  reviews: number; dueReviews: number;
  newToday: number; newAvailable: number;
  limits: {
    newPerDay: number; maxReviewsPerDay: number;
    newRemaining: number; reviewsRemaining: number;
    learningPerSitting: number;
    extraNewToday: number;
  };
};

/** Why a lane is serving fewer than exist, in the user's words. The daily
 *  limits are bank-wide while the lanes are scoped, so "0 new" has two very
 *  different meanings — "today's budget is spent" and "this scope is
 *  exhausted" — and the panel used to render both as a bare 0. */
function srsHeldBack(s: SrsQueueStats): string[] {
  const notes: string[] = [];
  if (s.dueReviews > s.reviews) {
    notes.push(`${s.dueReviews - s.reviews} due beyond today's ${s.limits.maxReviewsPerDay}-review limit`);
  }
  if (s.newAvailable > s.newToday && s.limits.newRemaining <= 0) {
    notes.push(`new intake used up for today (${s.limits.newPerDay}/day, bank-wide)`);
  }
  // Optional-chained: unlike the branches above, this one has no count guard
  // in front of it, so a stats payload without `limits` must read as "no
  // boost", not crash the setup panel.
  if ((s.limits?.extraNewToday ?? 0) > 0) {
    notes.push(`+${s.limits.extraNewToday} extra new unlocked today`);
  }
  if (s.dueLearning > s.learning) {
    notes.push(`${s.dueLearning - s.learning} relearn steps held for the next sitting`);
  }
  return notes;
}

function FilterBuilder({ mode, onStart }: { mode: Mode; onStart: (s: StartResp) => void }) {
  const statsQ = useQuery<McqStats>({ queryKey: ["/api/mcqs/stats"] });
  const weakQ = useQuery<{ items: Array<{ slug: string; name: string; accuracy: number; attempts: number }> }>({
    queryKey: ["/api/mcqs/weak-areas"],
  });

  const [topics, setTopics] = useState<Set<string>>(new Set());
  const [domains, setDomains] = useState<Set<string>>(new Set());
  const [completion, setCompletion] = useState<"all" | "completed" | "not-completed" | "review">("all");
  const [weakAreas, setWeakAreas] = useState<boolean>(false);
  const [count, setCount] = useState<number>(20);
  const [loInput, setLoInput] = useState<string>("");
  const [timeLimitMin, setTimeLimitMin] = useState<number>(0);
  // "Sit a real paper": constrains the pool to one past-paper tag and sizes
  // the session to the whole paper — the most authentic practice available.
  const [paper, setPaper] = useState<string>("all");   // a sitting key ("2026B"), or "all"

  // SRS mode is Anki, not a quiz builder: the sitting is "today's work"
  // (learning + due reviews + new intake under the daily limits), so the
  // quiz-shaping controls (completion, question count, weak-topics, paper)
  // don't apply — scope (topics/domains/LOs) does.
  const srs = mode === "srs";
  // No-new toggle: a sitting of pure catch-up (learning + reviews). The
  // day's new allowance isn't spent — it waits for a sitting with this off.
  const [skipNew, setSkipNew] = useState<boolean>(false);
  const loCodesParsed = loInput.trim() ? loInput.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const queueStatsUrl = useMemo(() => {
    const q = new URLSearchParams();
    if (topics.size > 0) q.set("topics", Array.from(topics).join(","));
    if (domains.size > 0) q.set("domains", Array.from(domains).join(","));
    if (loCodesParsed?.length) q.set("loCodes", loCodesParsed.join(","));
    // The panel's numbers must be the numbers Study will serve — the no-new
    // toggle changes both through the same flag.
    if (skipNew) q.set("skipNew", "1");
    const qs = q.toString();
    return `/api/mcqs/srs/queue-stats${qs ? `?${qs}` : ""}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topics, domains, loInput, skipNew]);
  const queueQ = useQuery<SrsQueueStats>({ queryKey: [queueStatsUrl], enabled: srs });
  const queueEmpty = srs && !!queueQ.data &&
    queueQ.data.learning + queueQ.data.reviews + queueQ.data.newToday === 0;

  // "Study more new today" — Anki's custom study, without a Settings
  // round-trip: grant extra new-card slots for TODAY only; the standing
  // srs_new_per_day limit is untouched and tomorrow returns to normal.
  const [extraNewCount, setExtraNewCount] = useState<number>(10);
  const addExtraNew = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/mcqs/srs/extra-new", { count: extraNewCount })).json(),
    // The boost changes the queue everywhere it's shown, not just this scope.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [queueStatsUrl] }),
    onError: (e: any) => toast({ variant: "destructive", title: "Couldn't add new questions", description: e?.message || String(e) }),
  });
  // The misclick path — a granted boost otherwise stands until midnight.
  const removeExtraNew = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", "/api/mcqs/srs/extra-new")).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [queueStatsUrl] }),
    onError: (e: any) => toast({ variant: "destructive", title: "Couldn't remove today's extra new", description: e?.message || String(e) }),
  });
  const extraBoost = queueQ.data?.limits?.extraNewToday ?? 0;
  // Removing the boost only takes back slots not yet spent on an introduction
  // — cards already served keep their schedules. After studying into a +45
  // grant with 19 slots left, "Remove today's +45" would overpromise: the
  // button must offer the unspent part, and vanish once the grant is used up.
  const extraBoostUnspent = Math.min(extraBoost, queueQ.data?.limits?.newRemaining ?? 0);

  const start = useMutation({
    mutationFn: async (): Promise<StartResp> => {
      const payload: SessionFilters = {
        mode,
        topics: topics.size > 0 ? Array.from(topics) : undefined,
        domains: domains.size > 0 ? Array.from(domains) : undefined,
        loCodes: loCodesParsed,
        completion: srs || completion === "all" ? undefined : completion,
        srsSkipNew: (srs && skipNew) || undefined,
        weakAreas: (!srs && weakAreas) || undefined,
        count,
        sittings: !srs && paper !== "all" ? [paper] : undefined,
        timeLimitSec: mode === "test" && timeLimitMin > 0 ? timeLimitMin * 60 : null,
      };
      const res = await apiRequest("POST", "/api/mcqs/session", payload);
      return res.json();
    },
    onSuccess: (data) => {
      if (data.mcqs.length === 0) {
        if (srs) {
          // Not an error in Anki terms — the day's queue is simply empty.
          queryClient.invalidateQueries({ queryKey: [queueStatsUrl] });
        } else {
          alert("No MCQs matched those filters. Try relaxing them.");
        }
        return;
      }
      onStart(data);
    },
    onError: (err) => {
      alert(err instanceof Error ? err.message : "Failed to start session");
    },
  });

  const byTopic = statsQ.data?.byTopic ?? [];
  const domainList = useMemo(() => {
    const set = new Set<string>();
    byTopic.forEach((t) => set.add(t.domain));
    return Array.from(set).sort();
  }, [byTopic]);

  const toggle = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  };

  return (
    <Card data-testid="card-filter-builder">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Session filters</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Topics */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Topics</Label>
            {topics.size > 0 && (
              <Button variant="ghost" size="sm" className="h-auto py-1 text-xs" onClick={() => setTopics(new Set())} data-testid="button-clear-topics">
                Clear
              </Button>
            )}
          </div>
          {statsQ.isLoading ? (
            <div className="flex flex-wrap gap-2">{Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-6 w-24" />)}</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {byTopic.map((t) => {
                const on = topics.has(t.slug);
                return (
                  <button
                    key={t.slug}
                    type="button"
                    onClick={() => toggle(topics, t.slug, setTopics)}
                    data-testid={`chip-topic-${t.slug}`}
                    className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                      on ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-accent"
                    }`}
                  >
                    {t.name}
                    <span className="ml-1.5 opacity-60 tabular-nums">{t.count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Domains */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Domains</Label>
            {domains.size > 0 && (
              <Button variant="ghost" size="sm" className="h-auto py-1 text-xs" onClick={() => setDomains(new Set())} data-testid="button-clear-domains">
                Clear
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {domainList.map((d) => {
              const on = domains.has(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggle(domains, d, setDomains)}
                  data-testid={`chip-domain-${d}`}
                  className={`px-2.5 py-1 rounded-md text-xs border transition-colors font-mono uppercase ${
                    on ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-accent"
                  }`}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>

        {/* LO codes */}
        <div>
          <Label className="text-xs uppercase tracking-wide text-muted-foreground" htmlFor="input-lo-codes">
            Learning objectives (optional)
          </Label>
          <Input
            id="input-lo-codes"
            value={loInput}
            onChange={(e) => setLoInput(e.target.value)}
            placeholder="e.g. BTGS 1.7, BTPH 1.3 — comma separated"
            className="mt-1.5 font-mono text-xs"
            data-testid="input-lo-codes"
          />
        </div>

        <Separator />

        {/* Toggles. */}
        {!srs && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex items-center gap-2.5 cursor-pointer" data-testid="toggle-weak-areas">
              <Switch checked={weakAreas} onCheckedChange={setWeakAreas} />
              <span className="text-sm">Focus on my weak topics</span>
            </label>
          </div>
        )}

        {/* Completion filter — quiz concept; in SRS the due-state IS the pool */}
        {!srs && (
          <div>
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Completion</Label>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {([
                { v: "all", label: "All" },
                { v: "not-completed", label: "Not completed" },
                { v: "completed", label: "Completed" },
                { v: "review", label: "Review pool (unseen + incorrect)" },
              ] as const).map((opt) => {
                const on = completion === opt.v;
                return (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setCompletion(opt.v)}
                    data-testid={`chip-completion-${opt.v}`}
                    className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                      on ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-accent"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {!srs && weakAreas && weakQ.data && weakQ.data.items.length > 0 && (
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="text-xs text-muted-foreground mb-1.5">Weak topics right now:</div>
            <div className="flex flex-wrap gap-1.5">
              {weakQ.data.items.slice(0, 6).map((w) => (
                <Badge key={w.slug} variant="outline" className="text-xs" data-testid={`badge-weak-${w.slug}`}>
                  {w.name} · {Math.round(w.accuracy * 100)}%
                </Badge>
              ))}
            </div>
          </div>
        )}
        {!srs && weakAreas && weakQ.data && weakQ.data.items.length === 0 && (
          <div className="text-xs text-muted-foreground">
            No weak topics yet — you need at least 5 attempts in a topic to be considered.
          </div>
        )}

        {/* Sit a real past paper (test/tutor — SRS reviews aren't paper-shaped) */}
        {!srs && (
        <div className="flex items-center gap-3 flex-wrap">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground shrink-0">Past paper</Label>
          <Select
            value={paper}
            onValueChange={(v) => {
              setPaper(v);
              if (v !== "all") {
                const p = statsQ.data?.sittings.find((x) => x.key === v);
                // Sit what the pool can actually SERVE — requesting the
                // corpus count silently delivered fewer ("the full paper"
                // served 96 of 103) and the sitting was scored out of the
                // smaller number.
                if (p) setCount(Math.min(200, p.sittable ?? p.count));
              }
            }}
          >
            <SelectTrigger className="h-9 w-56" data-testid="select-paper"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any (no paper constraint)</SelectItem>
              {/* Labelled the way the college names them ("2026.2"), not by the corpus's internal
                  MonYY tag. The list now includes every sitting the bank holds — it was built from
                  MonYY tags alone and stopped at 2015, so the 2025 and 2026 recalls were unsittable. */}
              {(statsQ.data?.sittings ?? []).map((p) => (
                <SelectItem key={p.key} value={p.key}>{p.label} · {p.count} Qs</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {paper !== "all" && (
            <span className="text-xs text-muted-foreground" data-testid="paper-mode-note">
              {paperSittingNote(mode)}
              {(() => {
                const p = statsQ.data?.sittings.find((x) => x.key === paper);
                if (!p) return "";
                // Attribute any gap between the paper's corpus size and what
                // this sitting will serve, BEFORE the user commits.
                const sittable = p.sittable ?? p.count;
                const gap = p.count - sittable;
                const gapNote = gap > 0
                  ? ` · sits ${sittable} of its ${p.count} Qs (${gap} unanswerable excluded)`
                  : "";
                const capNote = sittable > 200 ? ` · capped at 200 randomly-drawn of its ${sittable} sittable Qs` : "";
                return `${gapNote}${capNote}`;
              })()}
            </span>
          )}
        </div>
        )}

        {/* Anki-style today counts — what "Study" will actually serve */}
        {srs && (
          <div className="rounded-md border border-border bg-muted/30 p-3" data-testid="srs-queue-stats">
            {queueQ.data ? (
              <div className="flex items-center gap-4 text-sm tabular-nums">
                <span className="text-sky-600 dark:text-sky-400" data-testid="srs-count-new">
                  <span className="font-semibold">{queueQ.data.newToday}</span> new
                </span>
                <span className="text-red-600 dark:text-red-400" data-testid="srs-count-learning">
                  <span className="font-semibold">{queueQ.data.learning}</span> learning
                </span>
                <span className="text-green-600 dark:text-green-400" data-testid="srs-count-due">
                  <span className="font-semibold">{queueQ.data.reviews}</span> to review
                </span>
                <span className="text-xs text-muted-foreground ml-auto" data-testid="srs-held-back">
                  {srsHeldBack(queueQ.data).map((n) => `${n} · `).join("")}
                  limits in Settings
                </span>
              </div>
            ) : (
              <Skeleton className="h-5 w-64" />
            )}
            {/* Pure catch-up: reviews and learning only, no new intake. The
                allowance isn't spent — it waits for a sitting with this off. */}
            <div className="mt-2 flex items-center gap-2" data-testid="srs-skip-new">
              <Switch
                id="srs-skip-new-toggle"
                checked={skipNew}
                onCheckedChange={setSkipNew}
                data-testid="toggle-skip-new"
              />
              <Label htmlFor="srs-skip-new-toggle" className="text-xs font-normal text-muted-foreground">
                No new cards this sitting — reviews and learning only
              </Label>
            </div>
            {queueEmpty && (
              <div className="mt-2 text-sm text-green-600 dark:text-green-400" data-testid="srs-done-today">
                {/* "Nothing due", "budget spent" and "new switched off" are
                    different facts. Saying the first when another is true told
                    the user there was nothing left to learn in a scope that
                    still had hundreds. */}
                {queueQ.data && skipNew && queueQ.data.newAvailable > 0
                  ? "Nothing due — and new cards are switched off for this sitting."
                  : queueQ.data && queueQ.data.newAvailable > 0 && queueQ.data.limits.newRemaining <= 0
                  ? `Today's work is done — ${queueQ.data.newAvailable} unseen question${queueQ.data.newAvailable === 1 ? "" : "s"} left in this scope, released ${queueQ.data.limits.newPerDay}/day.`
                  : "Nothing due — you're done for today. New questions and reviews return tomorrow."}
              </div>
            )}
            {/* Get-ahead intake: whenever unseen questions exist beyond what
                today will serve, offer more new TODAY — Anki's custom study —
                instead of sending the user to Settings to raise the standing
                daily limit. Hidden while new cards are switched off; the
                remove-boost action stays reachable either way. */}
            {queueQ.data && ((!skipNew && queueQ.data.newAvailable > queueQ.data.newToday) || extraBoostUnspent > 0) && (
              <div className="mt-2 flex items-center gap-2 flex-wrap" data-testid="srs-extra-new">
                {!skipNew && queueQ.data.newAvailable > queueQ.data.newToday && (
                  <>
                    <Input
                      type="number"
                      min={1}
                      max={500}
                      value={extraNewCount}
                      onChange={(e) => setExtraNewCount(Math.max(1, Math.min(500, Math.floor(Number(e.target.value) || 1))))}
                      className="w-20 h-8"
                      data-testid="input-extra-new"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => addExtraNew.mutate()}
                      disabled={addExtraNew.isPending}
                      data-testid="button-extra-new"
                    >
                      Study {extraNewCount} more new today
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      Adds to today only — the daily {queueQ.data.limits.newPerDay}/day limit in Settings is unchanged.
                    </span>
                  </>
                )}
                {extraBoostUnspent > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeExtraNew.mutate()}
                    disabled={removeExtraNew.isPending}
                    data-testid="button-extra-new-remove"
                  >
                    Remove today's +{extraBoostUnspent}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Count + time */}
        {!srs && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Questions
              </Label>
              <span className="text-sm font-mono tabular-nums" data-testid="text-count-value">{count}</span>
            </div>
            <Slider
              min={5}
              // Fixed at the session engine's own cap (schema caps count at
              // 200): picking a >100-question paper sets count above the old
              // max of 100, pinning the thumb at the edge. A value-tracking
              // max was worse — the thumb sat pinned at 100% while dragging
              // and the slider became a one-way down ratchet.
              max={200}
              step={5}
              value={[count]}
              onValueChange={(v) => setCount(v[0] ?? 20)}
              data-testid="slider-count"
            />
          </div>
          {mode === "test" && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Time limit
                </Label>
                <span className="text-sm font-mono tabular-nums" data-testid="text-time-limit">
                  {timeLimitMin === 0 ? "off" : `${timeLimitMin} min`}
                </span>
              </div>
              <Slider
                min={0}
                max={180}
                step={5}
                value={[timeLimitMin]}
                onValueChange={(v) => setTimeLimitMin(v[0] ?? 0)}
                data-testid="slider-time-limit"
              />
            </div>
          )}
        </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            onClick={() => start.mutate()}
            disabled={start.isPending || queueEmpty}
            data-testid="button-start-session"
          >
            {start.isPending ? "Starting..." : srs ? "Study" : `Start ${MODE_META[mode].title} session`}
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// -------------------------------------------------------------------------------------------------
// Session runner
// -------------------------------------------------------------------------------------------------

function SessionRunner({ session, onFinish, resume }: { session: StartResp; onFinish: (s: SessionSummary | null) => void; resume?: StudySnapshot }) {
  const { mode, sessionId, timeLimitSec } = session;
  // Local copy of the mcq list so edits can update the current card without
  // restarting the session. Seeded from the session prop, mutated by the edit dialog.
  const [mcqs, setMcqs] = useState<McqRecord[]>(session.mcqs);
  const [idx, setIdx] = useState(resume?.idx ?? 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<AttemptResp | null>(null);
  const [answered, setAnswered] = useState<Array<{ mcqId: string; selected: string | null; correct: boolean }>>(resume?.answered ?? []);
  const [editOpen, setEditOpen] = useState(false);
  const questionStartRef = useRef<number>(Date.now());
  // Screen state for the last rating, so an undo can restore the exact view.
  const undoRef = useRef<{ mcqId: string; idx: number; feedback: AttemptResp | null; requeued: boolean } | null>(null);
  // Resuming keeps the ORIGINAL start time so a test-mode clock cannot be
  // reset by refreshing; if the limit passed while away, the timer effect's
  // first tick finishes the sitting honestly.
  const sessionStartRef = useRef<number>(resume?.sessionStartMs ?? Date.now());
  const [elapsedSec, setElapsedSec] = useState(0);
  const [finishing, setFinishing] = useState(false);

  const mcq = mcqs[idx];
  const total = mcqs.length;

  // Display order for the current serve: shuffled per (question, serve
  // index, sitting) so repeat exposures can't be answered from positional
  // memory. Canonical letters travel with their text and remain what gets
  // POSTed — the server never learns display order exists. The seed is
  // stable across re-renders and rating-undo of the same serve, and rolls
  // for an Again-requeue (new idx) or a new sitting. Order-dependent option
  // sets ("All of the above") come back in canonical order — see
  // optionShuffle. Depending on the mcq OBJECT (not id) re-derives after an
  // inline edit splices a rewritten record in.
  // The seed keeps an empty middle segment ("id||idx|start") so a given
  // serve maps to the same permutation it always has — a reshuffle of every
  // question would be visible to anyone mid-sitting on a resumed snapshot.
  const displayKeys = useMemo(
    () => (mcq ? presentOptionKeys(mcq.options, `${mcq.id}||${idx}|${sessionStartRef.current}`) : []),
    [mcq, idx],
  );

  // When the edit dialog saves or reverts an MCQ, splice the returned record
  // into the local session list so the runner shows the new content immediately.
  const handleMcqSaved = (updated: McqRecord) => {
    setMcqs((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  };

  useEffect(() => {
    questionStartRef.current = Date.now();
  }, [idx]);

  // Snapshot progress after every answer/advance so refresh or navigation
  // can offer a resume instead of silently destroying the sitting.
  useEffect(() => {
    // Only sittings that CANNOT be reconstructed are persisted. A test or
    // tutor run is a random draw — lose it and it is gone, so it is
    // snapshotted (the LIVE list, since an inline edit can rewrite a
    // question). An SRS queue is derived from due state: closing the tab
    // costs nothing, because reopening rebuilds exactly what is still due,
    // minus everything already answered. Persisting it could only ever
    // resurrect a stale queue.
    if (mode === "srs") return;
    saveStudySnapshot({ session: { ...session, mcqs }, idx, answered, sessionStartMs: sessionStartRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, answered, mcqs]);

  // Session timer for test mode
  useEffect(() => {
    if (mode !== "test" || !timeLimitSec) return;
    const t = setInterval(() => {
      const s = Math.floor((Date.now() - sessionStartRef.current) / 1000);
      setElapsedSec(s);
      if (s >= timeLimitSec) {
        clearInterval(t);
        void finish();
      }
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, timeLimitSec]);

  // Log the answered/skipped question exactly once. In SRS mode this reveals
  // the answer; the schedule is advanced separately via the `rate` mutation
  // when the user picks a rating (see SrsRatingRow below).
  const submit = useMutation({
    mutationFn: async (payload: { selected: string | null }): Promise<AttemptResp> => {
      const timeMs = Date.now() - questionStartRef.current;
      const res = await apiRequest("POST", "/api/mcqs/attempt", {
        sessionId,
        mcqId: mcq.id,
        mode,
        selected: payload.selected,
        timeMs,
      });
      return res.json();
    },
    onSuccess: (data, vars) => {
      setAnswered((a) => [...a, { mcqId: mcq.id, selected: vars.selected, correct: data.correct }]);
      if (mode === "tutor" || mode === "srs") {
        setFeedback(data);
      } else {
        // test mode: no feedback, advance immediately
        advance();
      }
    },
    // A failed attempt POST used to do NOTHING — "Check answer" looked broken.
    onError: (e: any) => toast({ variant: "destructive", title: "Answer didn't save", description: `${e?.message || e} — try again.` }),
  });

  // SRS rating — advances the schedule once for the already-logged attempt.
  const rate = useMutation({
    mutationFn: async (rating: number): Promise<number> => {
      await apiRequest("POST", "/api/mcqs/srs/rate", {
        sessionId,
        mcqId: mcq.id,
        rating,
      });
      return rating;
    },
    onSuccess: (rating) => {
      // Remember enough to put this exact question back if the rating was a
      // misclick. The server owns the schedule rollback; this is only the
      // screen state — which question, where it sat, and the revealed
      // feedback, so undo lands back on the rating buttons and not on a
      // blank stem the user would have to answer again.
      undoRef.current = { mcqId: mcq.id, idx, feedback, requeued: rating === 1 };
      if (rating === 1) {
        // Anki learning step: an Again-rated question returns later in the
        // SAME sitting (its 10-minute relearn step sits inside the
        // learn-ahead window). Requeue it at the end — the next reveal logs
        // a fresh attempt and the same-day short-term formula reschedules.
        // A refresh drops the requeue, but the question is due in 10 min,
        // so the next sitting serves it regardless.
        setMcqs((prev) => [...prev, mcq]);
        setSelected(null);
        setFeedback(null);
        setIdx(idx + 1); // safe: the append guarantees a next question exists
      } else {
        advance();
      }
    },
    onError: (e: any) => {
      const msg = e?.message || String(e);
      // The server refuses to rate the same reveal twice (a double-tap used
      // to advance the schedule a second time — 24 days became 35). The first
      // press DID land, so this half of the race must move on, not tell the
      // user their rating was lost.
      if (/already rated/i.test(msg)) {
        advance();
        return;
      }
      toast({ variant: "destructive", title: "Rating didn't save", description: `${msg} — pick the rating again.` });
    },
  });

  // Undo the last rating (misclicked "Good" on a question that needed
  // "Again"). Server restores the schedule; we restore the screen.
  const undo = useMutation({
    mutationFn: async (): Promise<{ mcqId: string; preview: AttemptResp["srsPreview"] }> =>
      (await apiRequest("POST", "/api/mcqs/srs/undo")).json(),
    onSuccess: (data) => {
      const u = undoRef.current;
      undoRef.current = null;
      if (!u) return;
      // Drop the copy an "Again" appended, so the question isn't queued twice.
      if (u.requeued) setMcqs((prev) => prev.slice(0, -1));
      setIdx(u.idx);
      setSelected(null);
      setFeedback(u.feedback ? { ...u.feedback, srsPreview: data.preview ?? u.feedback.srsPreview } : null);
      toast({ title: "Rating undone", description: "Schedule restored — rate it again." });
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Couldn't undo", description: e?.message || String(e) }),
  });

  const finishMut = useMutation({
    mutationFn: async (): Promise<SessionSummary> => {
      const res = await apiRequest("POST", `/api/mcqs/session/${sessionId}/finish`, {});
      return res.json();
    },
    onSuccess: (data) => {
      // The sitting is complete and recorded — the resume snapshot would now
      // only offer to replay a finished session.
      clearStudySnapshot();
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/user-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/weak-areas"] });
      // The browse list's completed / not-completed / review-pool filters
      // changed with every answer just given (staleTime is Infinity, so
      // nothing refetches on its own).
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs"] });
      onFinish(data);
    },
    // One failed finish used to strand the session: `finishing` stayed true,
    // permanently disabling the button with no message.
    onError: (e: any) => {
      setFinishing(false);
      // A 404 is the server saying this sitting no longer exists — progress
      // was reset, or a backup restored, while it was open in this tab. No
      // number of retries can finish it, so drop the snapshot (or the resume
      // banner would offer it again) and go back to the start.
      if (isHttpRefusal(e) && String(e?.message || "").startsWith("404")) {
        clearStudySnapshot();
        toast({
          variant: "destructive",
          title: "This sitting no longer exists",
          description: "Progress was reset or a backup restored while it was open, so there is nothing to finish.",
        });
        onFinish(null);
        return;
      }
      toast({ variant: "destructive", title: "Couldn't finish the session", description: `${e?.message || e} — press Finish again.` });
    },
  });

  const advance = () => {
    setSelected(null);
    setFeedback(null);
    if (idx + 1 >= total) {
      finish();
    } else {
      setIdx(idx + 1);
    }
  };

  const finish = async () => {
    // SRS has nothing to finish: no session row exists, and the day's work is
    // already recorded attempt by attempt. Ending is just leaving — the queue
    // counts refresh and the setup screen says what (if anything) is left.
    if (sessionId == null) {
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/user-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/weak-areas"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs"] });
      // Queue counts are keyed by their full scoped URL, so match by prefix —
      // otherwise the setup screen keeps showing pre-sitting numbers (the
      // cache is configured staleTime: Infinity and never refetches on its own).
      queryClient.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === "string"
          && (q.queryKey[0] as string).startsWith("/api/mcqs/srs/queue-stats"),
      });
      onFinish(null);
      return;
    }
    setFinishing(true);
    finishMut.mutate();
  };

  if (!mcq) {
    // Reachable when a resumed snapshot points past its queue (older
    // snapshots saved before the live-queue fix). Never a dead end: the
    // sitting can always be closed off and its attempts kept.
    return (
      <Card>
        <CardContent className="p-6 text-center space-y-3">
          <div className="text-sm text-muted-foreground">
            {answered.length > 0
              ? `No more questions in this sitting — ${answered.length} answered.`
              : "No questions available."}
          </div>
          <Button size="sm" onClick={finish} disabled={finishing} data-testid="button-finish-empty">
            {finishing ? "Finishing…" : "Finish session"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const options = mcq.options;

  const progressPct = total > 0 ? Math.round((idx / total) * 100) : 0;
  const remainingSec = timeLimitSec ? Math.max(0, timeLimitSec - elapsedSec) : null;
  const timeStr = remainingSec !== null
    ? `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")}`
    : null;

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="tabular-nums" data-testid="text-progress">
          {/* SRS counts DOWN like Anki (Again grows the queue); quizzes count up. */}
          {mode === "srs" ? `${total - idx} left today` : `Question ${idx + 1} / ${total}`}
        </span>
        <Progress value={progressPct} className="flex-1 h-1.5" />
        {timeStr && (
          <span className="flex items-center gap-1 tabular-nums font-mono" data-testid="text-timer">
            <Clock className="h-3 w-3" /> {timeStr}
          </span>
        )}
        <Badge variant="outline" className="text-[10px] uppercase" data-testid={`badge-mode-${mode}`}>
          {mode}
        </Badge>
      </div>

      <Card data-testid="card-question">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <SittingTag code={mcq.code} papers={mcq.papers} className="text-[10px]" testId="badge-mcq-sitting" />
            <Badge variant="outline" className="text-[10px]">{mcq.topicName}</Badge>
            {mcq.edited && (
              <Badge variant="secondary" className="text-[10px] gap-1" data-testid="badge-mcq-edited">
                <Pencil className="h-2.5 w-2.5" /> Edited
              </Badge>
            )}
            {/* Only expose Edit / Revert once the answer is revealed (tutor/srs
                after feedback). In test mode, opening either would leak the
                answer — so we hide them until the session is complete. */}
            {feedback !== null && (
              <div className="ml-auto flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setEditOpen(true)}
                  data-testid="button-edit-mcq-inline"
                >
                  <Pencil className="h-3 w-3 mr-1" /> Edit
                </Button>
                <RevertMcqButton
                  mcq={mcq}
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onReverted={handleMcqSaved}
                />
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-[15px] leading-relaxed whitespace-pre-wrap break-words" data-testid="text-stem">
            {mcq.stem}
          </div>
          {/* Stems that say "see graph below" are unanswerable without it. */}
          <McqFigure figure={mcq.figure} />

          <div className="space-y-2" role="radiogroup">
            {displayKeys.map((k) => {
              const chosen = selected === k;
              const isCorrect = feedback?.correctAnswer === k;
              const isSelectedWrong = feedback && chosen && !feedback.correct;
              const disabled = submit.isPending || feedback !== null;

              let cls = "border-border bg-card hover:bg-accent";
              if (feedback) {
                if (isCorrect) cls = "border-green-600 bg-green-50 dark:bg-green-950/30";
                else if (isSelectedWrong) cls = "border-red-600 bg-red-50 dark:bg-red-950/30";
                else cls = "border-border bg-card opacity-70";
              } else if (chosen) {
                cls = "border-primary bg-primary/5";
              }

              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => !disabled && setSelected(k)}
                  disabled={disabled}
                  data-testid={`button-option-${k}`}
                  className={`w-full text-left rounded-md border p-3 transition-colors flex items-start gap-3 ${cls} ${disabled ? "cursor-default" : "cursor-pointer"}`}
                >
                  <span className={`shrink-0 font-mono text-xs w-6 h-6 rounded flex items-center justify-center border ${
                    chosen || isCorrect ? "border-current" : "border-border"
                  }`}>
                    {k}
                  </span>
                  <span className="text-sm flex-1 min-w-0 break-words">{options[k]}</span>
                  {feedback && isCorrect && <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />}
                  {feedback && isSelectedWrong && <XCircle className="h-4 w-4 text-red-600 shrink-0" />}
                </button>
              );
            })}
          </div>

          {/* Feedback panel (tutor + srs after submit) */}
          {feedback && (
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2" data-testid="panel-feedback">
              <div className="flex items-center gap-2 text-sm font-medium">
                {feedback.correct ? (
                  <><CheckCircle2 className="h-4 w-4 text-green-600" /> Correct</>
                ) : (
                  <><XCircle className="h-4 w-4 text-red-600" /> Incorrect — answer is {feedback.correctAnswer}</>
                )}
              </div>
              {feedback.reason && (
                <div className="text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words" data-testid="text-reason">
                  {feedback.reason}
                </div>
              )}
            </div>
          )}

          {/* Action row */}
          <div className="flex items-center justify-between pt-2 gap-3 flex-wrap">
            {mode === "srs" && undoRef.current && !feedback && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => undo.mutate()}
                disabled={undo.isPending}
                data-testid="button-undo-rating"
                title="Undo the last rating"
              >
                <Undo2 className="h-4 w-4 mr-1" />
                {undo.isPending ? "Undoing…" : "Undo"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => submit.mutate({ selected: null })}
              disabled={submit.isPending || feedback !== null}
              data-testid="button-skip"
            >
              {/* In SRS this is Anki's "show answer without guessing". It is
                  NOT a wrong answer in the accuracy stats — but it IS a failed
                  recall, so the reveal offers only the Again rating, same as a
                  wrong answer. */}
              {mode === "srs" ? "Don't know" : "Skip"}
            </Button>

            {mode === "srs" && feedback ? (
              <SrsRatingRow
                pending={rate.isPending}
                preview={feedback.srsPreview}
                correct={feedback.correct}
                onRate={(rating) => rate.mutate(rating)}
              />
            ) : feedback ? (
              <Button size="sm" onClick={advance} data-testid="button-next">
                Next <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                {mode === "srs" ? (
                  <Button
                    size="sm"
                    onClick={() => selected && submit.mutate({ selected })}
                    disabled={!selected || submit.isPending}
                    data-testid="button-submit"
                  >
                    Reveal answer
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => selected && submit.mutate({ selected })}
                    disabled={!selected || submit.isPending}
                    data-testid="button-submit"
                  >
                    {mode === "test" ? "Submit" : "Check answer"}
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <McqEditDialog
        mcq={mcq}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={handleMcqSaved}
      />

      {/* Bottom actions */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span data-testid="text-answered-count">
          Answered {answered.length} · Correct {answered.filter((a) => a.correct).length}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={finish}
          disabled={finishing}
          data-testid="button-finish-early"
        >
          {/* SRS isn't a sitting you abandon — stopping just leaves the rest
              due, exactly like closing Anki. */}
          {mode === "srs" ? "Done for now" : "Finish session early"}
        </Button>
      </div>
    </div>
  );
}

// Anki-style interval label for a rating button: 0 is the 10-minute relearn
// step; day counts read as days up to a month, then months, then years.
function formatRatingInterval(days: number): string {
  if (days <= 0) return "10 min";
  if (days < 30) return `${days} d`;
  if (days < 365) return `${(days / 30.4).toFixed(1)} mo`;
  return `${(days / 365).toFixed(1)} y`;
}

// FSRS ratings: 1=Again, 2=Hard, 3=Good, 4=Easy. Each button carries the
// interval it would schedule (from the server's outcome table — an exact
// promise, fuzz included), the way Anki shows consequences before you commit.
//
// A WRONG answer (or a "Don't know" reveal) is not self-graded: unlike a
// flashcard, the MCQ carries its own evidence, and it says the recall failed.
// Only Again is offered — and the server refuses anything else for an
// incorrect attempt, so this isn't merely cosmetic. Correct answers keep all
// four buttons, Again included (a lucky guess is the user's to confess).
function SrsRatingRow({ onRate, pending, preview, correct }: {
  onRate: (rating: number) => void;
  pending: boolean;
  preview?: { again: number; hard: number; good: number; easy: number };
  correct: boolean;
}) {
  const buttons = correct ? [
    { rating: 1, label: "Again", days: preview?.again, cls: "text-red-600 border-red-600/40", testId: "button-rate-again" },
    { rating: 2, label: "Hard", days: preview?.hard, cls: "", testId: "button-rate-hard" },
    { rating: 3, label: "Good", days: preview?.good, cls: "", testId: "button-rate-good" },
    { rating: 4, label: "Easy", days: preview?.easy, cls: "", testId: "button-rate-easy" },
  ] : [
    { rating: 1, label: "Again", days: preview?.again, cls: "text-red-600 border-red-600/40", testId: "button-rate-again" },
  ];
  return (
    <div className="flex items-center gap-1.5">
      {!correct && (
        <span className="text-xs text-muted-foreground" data-testid="text-wrong-auto-again">
          Missed questions re-queue as Again
        </span>
      )}
      {buttons.map((b) => (
        <Button
          key={b.rating}
          size="sm"
          variant="outline"
          className={`${b.cls} h-auto py-1 flex-col gap-0`}
          disabled={pending}
          onClick={() => onRate(b.rating)}
          data-testid={b.testId}
        >
          <span>{b.label}</span>
          {b.days !== undefined && (
            <span className="text-[10px] font-normal opacity-70 tabular-nums">{formatRatingInterval(b.days)}</span>
          )}
        </Button>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Session summary
// -------------------------------------------------------------------------------------------------

function SessionSummaryView({ summary, onDone }: { summary: SessionSummary; onDone: () => void }) {
  const wrongAttempts = summary.attempts.filter((a) => a.correct === 0);
  return (
    <div className="space-y-5" data-testid="section-summary">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Accuracy" value={`${summary.accuracyPct}%`} sub={`${summary.correctCount} of ${summary.totalAnswered}`} testId="metric-accuracy" />
        <MetricCard label="Correct" value={String(summary.correctCount)} sub="" testId="metric-correct" />
        <MetricCard label="Incorrect" value={String(summary.incorrectCount)} sub={summary.skippedCount > 0 ? `${summary.skippedCount} skipped` : ""} testId="metric-incorrect" />
        <MetricCard label="Median time" value={`${summary.medianTimeSec}s`} sub="per question" testId="metric-median" />
      </div>

      {summary.byTopic.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">By topic</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {summary.byTopic.map((t) => (
              <div key={t.slug} className="flex items-center gap-3" data-testid={`row-topic-${t.slug}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{t.name}</div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    {t.correct}/{t.answered}
                  </div>
                </div>
                <div className="w-32">
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary" style={{ width: `${Math.round(t.accuracy * 100)}%` }} />
                  </div>
                </div>
                <div className="w-10 text-right text-xs tabular-nums font-mono">
                  {Math.round(t.accuracy * 100)}%
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {wrongAttempts.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Review missed ({wrongAttempts.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {wrongAttempts.map((a) => (
              <div key={a.id} className="rounded-md border border-border p-3" data-testid={`review-${a.id}`}>
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  <Badge variant="outline" className="text-[10px] font-mono max-w-full min-w-0"><span className="truncate">{a.mcqId}</span></Badge>
                  <span className="text-[11px] text-muted-foreground min-w-0">{a.topicName}</span>
                  <span className="text-[11px] ml-auto">
                    You: <span className="font-mono">{a.selected ?? "—"}</span> · Answer: <span className="font-mono text-green-700 dark:text-green-400">{a.correctAnswer ?? "?"}</span>
                  </span>
                </div>
                <div className="text-xs leading-relaxed line-clamp-3">{a.stem}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={onDone} data-testid="button-summary-done">Done</Button>
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, testId }: { label: string; value: string; sub: string; testId: string }) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="font-serif text-xl mt-0.5 tabular-nums" data-testid={`${testId}-value`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">{sub}</div>}
      </CardContent>
    </Card>
  );
}

// -------------------------------------------------------------------------------------------------
// Study stats (visible when idle)
// -------------------------------------------------------------------------------------------------

function StudyStats() {
  const statsQ = useQuery<McqUserStats>({ queryKey: ["/api/mcqs/user-stats"] });
  // Per-topic list sort/filter controls. Coverage-ascending is the default so
  // the most-neglected topics surface first — that's the whole point of the
  // "how much have I covered?" view. Users can flip to accuracy-ascending to
  // triage weak areas, or hide the untouched rows once they've made a dent.
  const [topicSort, setTopicSort] = useState<"coverage-asc" | "coverage-desc" | "accuracy-asc" | "name">("coverage-asc");
  const [hideUntouched, setHideUntouched] = useState(false);

  if (statsQ.isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
    );
  }
  const s = statsQ.data;
  if (statsQ.isError) return (
    <div className="text-xs text-amber-600 dark:text-amber-400" data-testid="study-stats-error">
      Couldn't load study stats — refresh to retry.
    </div>
  );
  // Shape-guard, not just presence: an empty or unexpected payload used to
  // crash the WHOLE Study page on `s.totals.accuracy` (first-run/empty-state
  // crash class) — the error boundary caught it, but a crash is still a bug.
  if (!s?.totals) return null;
  const totalAcc = Math.round(s.totals.accuracy * 100);

  // Coverage = distinct MCQs the user has attempted at least once, out of the
  // full MCQ bank (sum of every topic's pool). uniqueMcqs comes from the
  // server as the count of DISTINCT mcqId with >=1 attempt, so it's the same
  // "coverage" concept just aggregated — no double counting when an MCQ
  // appears in multiple sessions.
  const bankSize = s.byTopic.reduce((a, t) => a + t.poolSize, 0);
  const coverage = s.totals.uniqueMcqs;
  const coveragePct = bankSize > 0 ? (coverage / bankSize) * 100 : 0;
  const remaining = Math.max(0, bankSize - coverage);

  // Sort topic list by the current control. "coverage-asc" is deliberately
  // lowest-coverage-first, which places untouched topics (0/N) at the top.
  const sortedTopics = [...s.byTopic]
    .filter((t) => (hideUntouched ? t.attempted > 0 : true))
    .sort((a, b) => {
      const covA = a.poolSize > 0 ? a.attempted / a.poolSize : 0;
      const covB = b.poolSize > 0 ? b.attempted / b.poolSize : 0;
      if (topicSort === "coverage-asc") return covA - covB || b.poolSize - a.poolSize;
      if (topicSort === "coverage-desc") return covB - covA || b.poolSize - a.poolSize;
      if (topicSort === "accuracy-asc") {
        // Nulls (never attempted) sort last so this stays a triage view.
        const accA = a.accuracy ?? Infinity;
        const accB = b.accuracy ?? Infinity;
        return accA - accB;
      }
      return a.name.localeCompare(b.name);
    });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Total accuracy" value={s.totals.attempted > 0 ? `${totalAcc}%` : "—"} sub={`${s.totals.attempted} attempts`} testId="stat-accuracy" />
        <MetricCard
          label="MCQ bank coverage"
          value={bankSize > 0 ? `${coverage} / ${bankSize}` : "—"}
          sub={bankSize > 0 ? `${coveragePct.toFixed(1)}% covered · ${remaining} left` : "no MCQs in bank"}
          testId="stat-coverage"
        />
        <MetricCard
          label="Streak"
          value={`${s.streakDays}d`}
          sub={s.streakDays > 0 ? "consecutive days" : "start today"}
          testId="stat-streak"
        />
        <MetricCard
          label="SRS due"
          value={String(s.srsDue.dueNow)}
          sub={`${s.srsDue.dueToday} today · ${s.srsDue.totalTracked} tracked`}
          testId="stat-srs-due"
        />
      </div>

      {/* MCQ bank coverage — headline progress bar + per-domain breakdown.
          Domain rows only render when there is at least one MCQ in that
          domain's pool, so empty domains don't pad the card. */}
      {bankSize > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 className="h-4 w-4" /> MCQ bank coverage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3" data-testid="card-coverage">
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium">Overall</span>
                <span className="tabular-nums text-muted-foreground">
                  <span className="text-foreground font-medium" data-testid="text-coverage-overall">
                    {coverage} / {bankSize}
                  </span>{" "}
                  · {coveragePct.toFixed(1)}%
                </span>
              </div>
              <Progress value={coveragePct} className="h-2" />
            </div>
            {s.byDomain.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="text-[11px] uppercase text-muted-foreground">By domain</div>
                {[...s.byDomain]
                  .filter((d) => d.poolSize > 0)
                  .sort((a, b) => {
                    const ca = a.poolSize > 0 ? a.attempted / a.poolSize : 0;
                    const cb = b.poolSize > 0 ? b.attempted / b.poolSize : 0;
                    return ca - cb;
                  })
                  .map((d) => {
                    const pct = d.poolSize > 0 ? (d.attempted / d.poolSize) * 100 : 0;
                    return (
                      <div key={d.domain} className="flex items-center gap-3 text-sm" data-testid={`stat-domain-${d.domain}`}>
                        <div className="flex-1 min-w-0 truncate">{d.domain}</div>
                        <div className="text-[11px] text-muted-foreground tabular-nums w-14 sm:w-20 text-right">
                          {d.attempted}/{d.poolSize}
                        </div>
                        <div className="w-24 sm:w-32">
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                        <div className="w-10 text-right text-xs font-mono tabular-nums">
                          {pct.toFixed(0)}%
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {(s.last7d.attempted > 0 || s.last30d.attempted > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="h-4 w-4" /> Recent activity</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-[11px] uppercase text-muted-foreground">Last 7 days</div>
              <div className="tabular-nums">{s.last7d.attempted} attempts · {Math.round(s.last7d.accuracy * 100)}% accuracy</div>
            </div>
            <div>
              <div className="text-[11px] uppercase text-muted-foreground">Last 30 days</div>
              <div className="tabular-nums">{s.last30d.attempted} attempts · {Math.round(s.last30d.accuracy * 100)}% accuracy</div>
            </div>
          </CardContent>
        </Card>
      )}

      {sortedTopics.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart3 className="h-4 w-4" /> Per-topic coverage
              </CardTitle>
              {/* flex-wrap: the filter + sort chips outgrow a 375px phone — let them flow */}
              <div className="flex items-center gap-1.5 text-xs flex-wrap">
                <label className="flex items-center gap-1.5 cursor-pointer text-muted-foreground" data-testid="toggle-hide-untouched">
                  <input
                    type="checkbox"
                    checked={hideUntouched}
                    onChange={(e) => setHideUntouched(e.target.checked)}
                    className="h-3 w-3"
                  />
                  Hide untouched
                </label>
                <span className="h-3 w-px bg-border mx-1" />
                {([
                  ["coverage-asc", "least covered"],
                  ["coverage-desc", "most covered"],
                  ["accuracy-asc", "weakest"],
                  ["name", "A–Z"],
                ] as const).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setTopicSort(k)}
                    className={`px-2 py-0.5 rounded ${topicSort === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
                    data-testid={`button-topic-sort-${k}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {sortedTopics.map((t) => {
              const covPct = t.poolSize > 0 ? (t.attempted / t.poolSize) * 100 : 0;
              const untouched = t.attempted === 0;
              return (
                <div key={t.slug} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid={`stat-topic-${t.slug}`}>
                  <div className={`w-full sm:w-auto sm:flex-1 min-w-0 truncate ${untouched ? "text-muted-foreground" : ""}`}>{t.name}</div>
                  <div className="text-[11px] text-muted-foreground tabular-nums w-16 text-right">
                    {t.attempted}/{t.poolSize}
                  </div>
                  {/* Coverage bar (how many of this topic's MCQs have been seen) */}
                  <div className="w-24" title={`${covPct.toFixed(0)}% covered`}>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500/70" style={{ width: `${covPct}%` }} />
                    </div>
                  </div>
                  <div className="w-9 text-right text-[11px] font-mono tabular-nums text-muted-foreground">
                    {covPct.toFixed(0)}%
                  </div>
                  {/* Accuracy bar (only meaningful when attempted > 0) */}
                  <div className="w-24" title={t.accuracy != null ? `${Math.round(t.accuracy * 100)}% accuracy` : "no attempts"}>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary"
                        style={{ width: t.accuracy != null ? `${Math.round(t.accuracy * 100)}%` : "0%" }}
                      />
                    </div>
                  </div>
                  <div className="w-10 text-right text-xs font-mono tabular-nums">
                    {t.accuracy != null ? `${Math.round(t.accuracy * 100)}%` : "—"}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {s.recentSessions.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><History className="h-4 w-4" /> Recent sessions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {s.recentSessions.map((r) => (
              <div key={r.id} className="flex items-center gap-3 text-xs tabular-nums" data-testid={`row-session-${r.id}`}>
                <Badge variant="outline" className="text-[10px] uppercase">{r.mode}</Badge>
                <span className="text-muted-foreground">{new Date(r.startedAt).toLocaleString()}</span>
                <span className="ml-auto">{r.correctCount}/{r.totalQuestions}</span>
                <span className="w-12 text-right font-mono">
                  {r.accuracy != null ? `${Math.round(r.accuracy * 100)}%` : "—"}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {s.totals.attempted === 0 && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            <Flame className="h-6 w-6 mx-auto mb-2 opacity-50" />
            No attempts logged yet. Start a session above to build your accuracy profile.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
