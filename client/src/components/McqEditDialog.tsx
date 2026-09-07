import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, apiErrorText } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { McqRecord } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";

// -----------------------------------------------------------------------------
// Edit dialog for a single MCQ. Sends PATCH /api/mcqs/:id with only changed
// fields. Revert button (visible when mcq.edited=true) sends DELETE to strip
// the override and restore the base corpus value.
//
// "Suggest with AI" asks the adjudicator (POST /api/mcqs/:id/triage-suggest)
// for a verdict and pre-fills every field with its proposed fix; the user
// reviews, then saves through the same PATCH. The model writes nothing itself.
// -----------------------------------------------------------------------------

// The adjudicator's verdict, as returned by POST /api/mcqs/:id/triage-suggest
// and as stored per row by the Quality page's sweep.
type AiVerdict = "confirm_key" | "change_answer" | "ambiguous" | "flawed";
export interface AiSuggestion {
  verdict: AiVerdict;
  suggestedAnswer: string | null;
  confidence: "high" | "medium" | "low";
  correctedReason: string;
  disputeNote: string;
  clearsDispute: boolean;
  suggestedStem: string | null;
  suggestedOptions: Record<string, string> | null;
  model: string;
  // Effort the call ran at ("max" for the max-effort option); null/absent on
  // the default cheap pass and on stored verdicts from a sweep.
  reasoningEffort?: string | null;
}
const AI_VERDICT_META: Record<AiVerdict, { label: string; cls: string }> = {
  confirm_key:   { label: "Confirm key",   cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  change_answer: { label: "Change answer", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-400" },
  ambiguous:     { label: "Ambiguous",     cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  flawed:        { label: "Flawed",        cls: "bg-rose-500/15 text-rose-700 dark:text-rose-400" },
};

interface McqEditDialogProps {
  mcq: McqRecord;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved?: (updated: McqRecord) => void; // optional callback (e.g. Study runner refresh)
  // Fires on Revert-to-original instead of onSaved. Defaults to onSaved when
  // unset — Disputes and Study legitimately treat a revert like any other
  // content change. The Quality page MUST split them: its onSaved marks the
  // verdict fixed, and marking a verdict fixed after a REVERT would hide a
  // known-wrong question from the audit and every future sweep.
  onReverted?: (reverted: McqRecord) => void;
  // When opened from dispute triage, seed the Disputed toggle OFF so a normal
  // correct-and-save clears the dispute (advancing the item to "fixed").
  // Without this the toggle defaults to the card's current disputed=true and
  // the item would stay pending forever.
  resolveDisputeOnSave?: boolean;
  // Optional stored adjudication to present ON OPEN, exactly as if "Suggest
  // with AI" had just returned it: verdict chip, note, model attribution, and
  // every field pre-filled with the proposed fix. The Quality page passes its
  // sweep's stored verdict here so the user reviews the suggestion without a
  // fresh AI call (the "Suggest with AI" button remains for a second opinion).
  suggestion?: AiSuggestion | null;
  // "audit" when this dialog is opened from the Quality page. The server's
  // default dispute framing tells the model someone believes the key is wrong,
  // which biases it toward changing a question nobody disputed.
  suggestMode?: "dispute" | "audit";
}

const OPTION_KEYS = ["A", "B", "C", "D", "E"] as const;
type OptKey = (typeof OPTION_KEYS)[number];

export function McqEditDialog({ mcq, open, onOpenChange, onSaved, onReverted, resolveDisputeOnSave, suggestion, suggestMode }: McqEditDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Local form state, seeded from the mcq. Reseed whenever the dialog opens
  // for a (potentially different) mcq.
  const [stem, setStem] = useState(mcq.stem);
  const [options, setOptions] = useState<Record<OptKey, string>>({ ...mcq.options });
  const [answer, setAnswer] = useState<string>(mcq.answer ?? "__clear__");
  const [reason, setReason] = useState(mcq.reason ?? "");
  const [disputed, setDisputed] = useState<boolean>(resolveDisputeOnSave ? false : mcq.disputed);
  const [ai, setAi] = useState<AiSuggestion | null>(null);

  // Present an adjudication: badge + note via `ai`, and every editable field
  // pre-filled with the recommendation — stem, options, answer, reason, and
  // the disputed flag. Shared between the live "Suggest with AI" call and a
  // stored suggestion passed in by the Quality page, so both present identically.
  const applySuggestion = (s: AiSuggestion) => {
    setAi(s);
    if (s.suggestedStem) setStem(s.suggestedStem);
    if (s.suggestedOptions) {
      setOptions((prev) => {
        const next = { ...prev };
        for (const k of OPTION_KEYS) if (s.suggestedOptions![k]) next[k] = s.suggestedOptions![k];
        return next;
      });
    }
    if (s.suggestedAnswer) setAnswer(s.suggestedAnswer);
    if (s.correctedReason) setReason(s.correctedReason);
    // A suggestion may only ever CLEAR the dispute flag relative to the
    // record's own state — raising it stays a manual Switch action. A
    // `setDisputed(!s.clearsDispute)` would raise the flag for any
    // ambiguous/flawed verdict on a CLEAN question, so hand-fixing an audit
    // row would silently flip it to disputed and drop it from the study pool.
    setDisputed(mcq.disputed && !s.clearsDispute);
  };

  useEffect(() => {
    if (open) {
      setStem(mcq.stem);
      setOptions({ ...mcq.options });
      setAnswer(mcq.answer ?? "__clear__");
      setReason(mcq.reason ?? "");
      setDisputed(resolveDisputeOnSave ? false : mcq.disputed);
      setAi(null);
      // A stored verdict opens the dialog in the exact post-"Suggest with AI"
      // state — chip, note, and rewritten fields — instead of a silent pre-fill
      // that reads as an untouched editor.
      if (suggestion) applySuggestion(suggestion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mcq]);

  // AI adjudication (read-only). The user reviews, then saves via the
  // existing PATCH. The model writes nothing itself. `effort: "max"` is the
  // max-effort option — same call, reasoning effort forced to the top rung.
  const suggestMutation = useMutation({
    mutationFn: async (effort?: "max") => {
      const params = new URLSearchParams();
      if (suggestMode === "audit") params.set("mode", "audit");
      if (effort) params.set("effort", effort);
      const qs = params.toString();
      const res = await apiRequest("POST", `/api/mcqs/${encodeURIComponent(mcq.id)}/triage-suggest${qs ? `?${qs}` : ""}`);
      return (await res.json()) as AiSuggestion;
    },
    onSuccess: applySuggestion,
    onError: (err) => {
      let msg = apiErrorText(err) || "AI suggestion failed";
      if (/OPENAI_API_KEY|not configured/i.test(msg)) msg = "AI suggestions aren't configured on this server (no OPENAI_API_KEY).";
      toast({ title: "AI suggestion failed", description: msg, variant: "destructive" });
    },
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/mcqs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mcqs", mcq.id] });
    queryClient.invalidateQueries({ queryKey: ["/api/mcqs/stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mcqs/user-stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mcqs/weak-areas"] });
    // The triage queue keys on its own single string — the "/api/mcqs" prefix
    // above does NOT match it. Without this, resolving a dispute from the
    // MCQs page or Study runner left the Disputes "Pending N" stale all session.
    queryClient.invalidateQueries({ queryKey: ["/api/mcqs/triage"] });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Build a partial edit — only send changed fields
      const body: Record<string, unknown> = {};
      if (stem !== mcq.stem) body.stem = stem;
      const optionsChanged = OPTION_KEYS.some((k) => options[k] !== mcq.options[k]);
      if (optionsChanged) body.options = options;
      const nextAnswer = answer === "__clear__" ? "" : answer;
      const baseAnswer = mcq.answer ?? "";
      if (nextAnswer !== baseAnswer) body.answer = nextAnswer;
      if (reason !== (mcq.reason ?? "")) body.reason = reason;
      if (disputed !== mcq.disputed) body.disputed = disputed;

      if (Object.keys(body).length === 0) {
        return null; // no-op
      }
      const res = await apiRequest("PATCH", `/api/mcqs/${encodeURIComponent(mcq.id)}`, body);
      return (await res.json()) as McqRecord;
    },
    onSuccess: (updated) => {
      invalidateAll();
      if (updated) {
        toast({ title: "MCQ updated", description: `${mcq.displayCode} saved.` });
        onSaved?.(updated);
      } else {
        toast({ title: "No changes", description: "Nothing to save." });
      }
      onOpenChange(false);
    },
    onError: (err) => {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const revertMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/mcqs/${encodeURIComponent(mcq.id)}/override`);
      return (await res.json()) as McqRecord;
    },
    onSuccess: (reverted) => {
      invalidateAll();
      toast({ title: "Edit reverted", description: `${mcq.displayCode} restored to original.` });
      (onReverted ?? onSaved)?.(reverted);
      onOpenChange(false);
    },
    onError: (err) => {
      toast({
        title: "Revert failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-mcq-edit">
        <DialogHeader>
          <DialogTitle>Edit MCQ · {mcq.displayCode}</DialogTitle>
          <DialogDescription>
            Changes are saved as your override on top of the base corpus. Reverting removes the override.
          </DialogDescription>
        </DialogHeader>

        {/* AI full-question editor. Adjudicates and pre-fills every field
            below; the user reviews then Saves. */}
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              type="button" size="sm" variant="outline"
              onClick={() => suggestMutation.mutate(undefined)}
              disabled={suggestMutation.isPending}
              data-testid="button-ai-suggest-edit"
            >
              {suggestMutation.isPending && !suggestMutation.variables ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Sparkles className="h-4 w-4 mr-1" />}
              Suggest with AI
            </Button>
            {/* Same adjudication, reasoning effort forced to the top rung —
                slower and dearer, for a question the cheap pass got wrong. */}
            <Button
              type="button" size="sm" variant="outline"
              onClick={() => suggestMutation.mutate("max")}
              disabled={suggestMutation.isPending}
              title="Same adjudication with reasoning effort forced to max — slower and costs more than the plain suggest"
              data-testid="button-ai-suggest-max"
            >
              {suggestMutation.isPending && suggestMutation.variables === "max" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Sparkles className="h-4 w-4 mr-1" />}
              Suggest with max effort
            </Button>
            {ai && (
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${AI_VERDICT_META[ai.verdict].cls}`} data-testid="ai-verdict-edit">
                {AI_VERDICT_META[ai.verdict].label}{ai.suggestedAnswer ? ` → ${ai.suggestedAnswer}` : ""} · {ai.confidence}
              </span>
            )}
            <span className="text-[11px] text-muted-foreground ml-auto">Edits every field — review before saving</span>
          </div>
          {ai?.disputeNote && (
            <div className="text-xs text-muted-foreground" data-testid="ai-note-edit">
              {ai.disputeNote}
              <span className="font-mono ml-1 opacity-70">({ai.model}{ai.reasoningEffort ? `@${ai.reasoningEffort}` : ""})</span>
              {(ai.suggestedStem || ai.suggestedOptions) && (
                <span className="text-signal-amber"> — the model also rewrote the {ai.suggestedStem && ai.suggestedOptions ? "stem & options" : ai.suggestedStem ? "stem" : "options"} below.</span>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-stem">Stem</Label>
            <Textarea
              id="edit-stem"
              value={stem}
              onChange={(e) => setStem(e.target.value)}
              rows={3}
              data-testid="input-edit-stem"
            />
          </div>

          <div className="space-y-2">
            <Label>Options</Label>
            {OPTION_KEYS.map((k) => (
              <div key={k} className="flex gap-2 items-start">
                <span className="font-mono font-semibold text-sm pt-2 w-5 shrink-0">{k}.</span>
                <Textarea
                  value={options[k]}
                  onChange={(e) => setOptions((prev) => ({ ...prev, [k]: e.target.value }))}
                  rows={1}
                  className="min-h-[36px]"
                  data-testid={`input-edit-option-${k}`}
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-answer">Correct answer</Label>
              <Select value={answer} onValueChange={setAnswer}>
                <SelectTrigger id="edit-answer" data-testid="select-edit-answer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPTION_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>{k}</SelectItem>
                  ))}
                  <SelectItem value="__clear__">(no answer)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-disputed" className="block">Disputed</Label>
              <div className="flex items-center gap-2 pt-2">
                <Switch
                  id="edit-disputed"
                  checked={disputed}
                  onCheckedChange={setDisputed}
                  data-testid="switch-edit-disputed"
                />
                <span className="text-sm text-muted-foreground">
                  {disputed ? "Flagged as disputed" : "Not disputed"}
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-reason">Reasoning / explanation</Label>
            <Textarea
              id="edit-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={6}
              data-testid="input-edit-reason"
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {mcq.edited && (
              <Button
                type="button"
                variant="outline"
                onClick={() => revertMutation.mutate()}
                disabled={revertMutation.isPending || saveMutation.isPending}
                data-testid="button-revert-mcq"
              >
                {revertMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="mr-2 h-4 w-4" />
                )}
                Revert to original
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={saveMutation.isPending}
              data-testid="button-cancel-edit"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || revertMutation.isPending}
              data-testid="button-save-edit"
            >
              {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
