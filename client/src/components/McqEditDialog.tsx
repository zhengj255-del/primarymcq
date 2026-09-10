import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { McqRecord } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, RotateCcw } from "lucide-react";

// -----------------------------------------------------------------------------
// Edit dialog for a single MCQ. Sends PATCH /api/mcqs/:id with only changed
// fields. Revert button (visible when mcq.edited=true) sends DELETE to strip
// the override and restore the base corpus value.
// -----------------------------------------------------------------------------

interface McqEditDialogProps {
  mcq: McqRecord;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved?: (updated: McqRecord) => void; // optional callback (e.g. Study runner refresh)
  // Fires on Revert-to-original instead of onSaved. Defaults to onSaved when
  // unset — Study legitimately treats a revert like any other content change;
  // a caller that must tell the two apart passes both.
  onReverted?: (reverted: McqRecord) => void;
}

const OPTION_KEYS = ["A", "B", "C", "D", "E"] as const;
type OptKey = (typeof OPTION_KEYS)[number];

export function McqEditDialog({ mcq, open, onOpenChange, onSaved, onReverted }: McqEditDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Local form state, seeded from the mcq. Reseed whenever the dialog opens
  // for a (potentially different) mcq.
  const [stem, setStem] = useState(mcq.stem);
  const [options, setOptions] = useState<Record<OptKey, string>>({ ...mcq.options });
  const [answer, setAnswer] = useState<string>(mcq.answer ?? "__clear__");
  const [reason, setReason] = useState(mcq.reason ?? "");

  useEffect(() => {
    if (open) {
      setStem(mcq.stem);
      setOptions({ ...mcq.options });
      setAnswer(mcq.answer ?? "__clear__");
      setReason(mcq.reason ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mcq]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/mcqs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mcqs", mcq.id] });
    queryClient.invalidateQueries({ queryKey: ["/api/mcqs/stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mcqs/user-stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/mcqs/weak-areas"] });
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
