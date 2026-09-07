import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { McqRecord } from "@shared/schema";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RotateCcw, Loader2 } from "lucide-react";

// -----------------------------------------------------------------------------
// One-click "revert to original" button for an MCQ. Opens an AlertDialog to
// confirm, then DELETEs /api/mcqs/:id/override to drop the user override so
// the base corpus row shows through again.
//
// Only renders when mcq.edited is true — otherwise nothing to revert.
// -----------------------------------------------------------------------------

interface Props {
  mcq: McqRecord;
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "icon";
  label?: string;             // override the button text (default "Revert")
  iconOnly?: boolean;         // render just the icon, no text
  className?: string;
  onReverted?: (reverted: McqRecord) => void;
}

export function RevertMcqButton({
  mcq,
  variant = "outline",
  size = "sm",
  label = "Revert",
  iconOnly = false,
  className,
  onReverted,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const revertMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/mcqs/${encodeURIComponent(mcq.id)}/override`);
      return (await res.json()) as McqRecord;
    },
    onSuccess: (reverted) => {
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs", mcq.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/user-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/weak-areas"] });
      // Reverting can resurrect/clear a dispute — the triage queue's own key
      // is not covered by the "/api/mcqs" prefix above.
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/triage"] });
      toast({
        title: "Reverted to original",
        description: `${mcq.displayCode} restored to the base corpus value.`,
      });
      onReverted?.(reverted);
      setOpen(false);
    },
    onError: (err) => {
      toast({
        title: "Revert failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  if (!mcq.edited) return null;

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
        data-testid={`button-revert-mcq-${mcq.id}`}
        title="Revert this MCQ to the original corpus value"
      >
        <RotateCcw className={iconOnly ? "h-3.5 w-3.5" : "h-3.5 w-3.5 mr-1"} />
        {!iconOnly && label}
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent data-testid="dialog-revert-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Revert {mcq.displayCode} to original?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes your edits to this MCQ and restores the original stem, options, answer,
              reasoning, and disputed flag from the base corpus. Your attempt history is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-revert-cancel" disabled={revertMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                revertMutation.mutate();
              }}
              disabled={revertMutation.isPending}
              data-testid="button-revert-confirm"
            >
              {revertMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Revert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
