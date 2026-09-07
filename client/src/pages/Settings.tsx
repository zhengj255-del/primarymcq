import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, apiErrorText, API_BASE } from "@/lib/queryClient";
import { useRef, useState } from "react";
import type { Settings } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Save, Download, Upload, LogOut, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { clearStudySnapshot } from "@/pages/Study";
import { markDeliberateSignOut } from "@/lib/signOut";

// -----------------------------------------------------------------------------
// Settings — the FSRS dials, the progress reset, backup/restore, and sign-out.
// One settings row (id = 1) on the server; PATCH /api/settings takes only the
// fields that changed.
// -----------------------------------------------------------------------------

/** What GET /api/export produces — and the only thing POST /api/import takes. */
interface BackupFile {
  version: number;
  app: string;
  exportedAt?: string;
  tables: Record<string, unknown[]>;
}

export default function SettingsPage() {
  const { data: settings, isError: settingsError } = useQuery<Settings>({ queryKey: ["/api/settings"] });
  // Cached by AuthGate already — no extra request. Tells the sign-out card
  // whether there is a password to sign out from.
  const { data: auth } = useQuery<{ required: boolean; authed: boolean }>({ queryKey: ["/api/auth/status"] });
  const { toast } = useToast();

  const [form, setForm] = useState<Partial<Settings>>({});
  const merged = { ...(settings ?? {}), ...form } as Settings;

  // AN EMPTY NUMERIC BOX IS THE OWNER MID-EDIT, NOT A REQUEST TO SET ZERO.
  // A number field that reads `Number(e.target.value)` turns a backspaced box
  // into a real zero in the pending form — and PATCH /api/settings validates,
  // so that zero comes back as a refusal thrown at the owner mid-keystroke
  // ("srsRetention must be between 0.70 and 0.97").
  //
  // So the raw TEXT of a number box lives here while it is being edited, and
  // only text that parses to a finite number reaches `form`. Clearing a box
  // WITHDRAWS its pending edit rather than posting a zero: the save simply
  // does not mention that field, the stored value stands, and every other
  // pending edit still saves. The box keeps showing empty (the backspace is
  // not undone under the cursor) with a line saying what stays saved, so the
  // withdrawal is stated rather than silent.
  const [numDrafts, setNumDrafts] = useState<Record<string, string>>({});
  const setNum = (key: string, raw: string, toStored?: (n: number) => number) => {
    setNumDrafts({ ...numDrafts, [key]: raw });
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) {
      const next = { ...form } as Record<string, unknown>;
      delete next[key];
      setForm(next as Partial<Settings>);
      return;
    }
    setForm({ ...form, [key]: toStored ? toStored(n) : n } as Partial<Settings>);
  };
  /** What the box shows: the owner's own text while they are editing it,
   *  otherwise the stored (or defaulted) value. */
  const numValue = (key: string, shown: number) =>
    numDrafts[key] ?? String(shown);
  /** Shown only once the owner has typed something unusable into a box —
   *  never on first render, and never for a value that will actually save. */
  const numHint = (key: string, stored: number, unit: string) => {
    const draft = numDrafts[key];
    if (draft === undefined) return null;
    const blank = draft.trim() === "";
    if (!blank && Number.isFinite(Number(draft))) return null;
    return (
      <div className="text-xs text-amber-600 dark:text-amber-400" data-testid={`hint-empty-${key}`}>
        {blank ? "Empty" : "Not a number"} — {stored}{unit} stays saved until you type one.
      </div>
    );
  };

  const save = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", "/api/settings", form)).json(),
    onSuccess: () => {
      // Invalidate everything: the SRS limits shape every queue-stats answer
      // (keyed by their full scoped URL) and the Study page's counts, and every
      // query in this app is staleTime: Infinity (lib/queryClient.ts), so a
      // named list is a list that goes stale the next time a surface is added.
      // GETs only, a handful of times a month.
      queryClient.invalidateQueries();
      toast({ title: "Settings saved" });
      setForm({});
      // The half-typed text goes with the pending edits it belonged to, so
      // every box goes back to showing what is now actually stored.
      setNumDrafts({});
    },
    // A failed save must say so — and in the server's words ("srsRetention
    // must be between 0.70 and 0.97"), not as an HTTP status glued to JSON.
    onError: (e: any) => toast({ variant: "destructive", title: "Save failed", description: apiErrorText(e) }),
  });

  // Reset MCQ progress — destructive, so it takes two clicks: arm, confirm.
  const [resetArmed, setResetArmed] = useState(false);
  const resetMcq = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/mcqs/reset?confirm=YES")).json() as Promise<{
        ok: boolean; deletedAttempts: number; deletedSrsState: number; deletedSessions: number;
      }>,
    onSuccess: (r) => {
      setResetArmed(false);
      // The session rows are gone, so a sitting snapshotted in this tab now
      // points at a session the server cannot finish — drop the resume offer
      // rather than leave a "press Finish again" that can never succeed.
      clearStudySnapshot();
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/user-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs/weak-areas"] });
      // The browse list's completed / not-completed / review-pool filters.
      queryClient.invalidateQueries({ queryKey: ["/api/mcqs"] });
      // Queue counts are keyed by their full scoped URL — match by prefix.
      queryClient.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === "string"
          && (q.queryKey[0] as string).startsWith("/api/mcqs/srs/queue-stats"),
      });
      toast({
        title: "MCQ progress reset",
        description: `Wiped ${r.deletedAttempts} attempts, ${r.deletedSessions} sessions and ${r.deletedSrsState} scheduled questions.`,
      });
    },
    onError: (e: any) => {
      setResetArmed(false);
      toast({ variant: "destructive", title: "Reset failed", description: e?.message || String(e) });
    },
  });

  // Restore from a backup file. Two steps on purpose: picking the file only
  // READS it (and says what it holds); the overwrite happens on an explicit
  // confirm, the same arm-then-confirm shape as the reset above.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ name: string; backup: BackupFile } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const onPickBackup = async (file: File | undefined) => {
    setReadError(null);
    setPendingRestore(null);
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as BackupFile;
      // A cheap local shape check so an obviously wrong file (another app's
      // dump, a CSV, a truncated download) is refused before the confirm step
      // rather than after it. The server re-validates on import.
      if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || parsed.app !== "mcq-site"
          || !parsed.tables || typeof parsed.tables !== "object") {
        setReadError("That file is not an MCQ Study backup.");
        return;
      }
      setPendingRestore({ name: file.name, backup: parsed });
    } catch {
      setReadError("Couldn't read that file as JSON.");
    }
  };
  const cancelRestore = () => {
    setPendingRestore(null);
    setReadError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };
  const restore = useMutation({
    mutationFn: async (backup: BackupFile) =>
      (await apiRequest("POST", "/api/import?confirm=YES", backup)).json() as Promise<{ ok: boolean; restored: Record<string, number> }>,
    onSuccess: (r) => {
      cancelRestore();
      // mcq_study_sessions was replaced wholesale, so a sitting snapshotted in
      // this tab refers to a session id that no longer exists (same reasoning
      // as the reset above).
      clearStudySnapshot();
      // Every table this app reads was just replaced — nothing cached is true
      // any more.
      queryClient.invalidateQueries();
      const rows = Object.values(r.restored ?? {}).reduce((a, n) => a + n, 0);
      toast({
        title: "Backup restored",
        description: `${rows} row${rows === 1 ? "" : "s"} across ${Object.keys(r.restored ?? {}).length} table${Object.keys(r.restored ?? {}).length === 1 ? "" : "s"}.`,
      });
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Restore failed", description: apiErrorText(e) }),
  });

  const signOut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/logout")).json(),
    // A fresh start, not a lost session: the next person at this browser must
    // not find the last person's sitting behind the password box (see
    // lib/signOut.ts). The snapshot goes, the gate is told this lock is
    // deliberate, and ONLY the status probe is refetched — it flips to
    // authed:false, AuthGate unmounts the tree and shows the plain login
    // screen, and the successful login that follows refetches everything.
    onSuccess: () => {
      clearStudySnapshot();
      markDeliberateSignOut();
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
    },
    onError: (e: any) => toast({ variant: "destructive", title: "Sign out failed", description: e?.message || String(e) }),
  });

  if (settingsError) return (
    <div className="p-6 text-sm text-amber-600 dark:text-amber-400" data-testid="settings-error">
      Couldn't load settings — refresh to retry.
    </div>
  );
  if (!settings) return <div className="p-6">Loading...</div>;

  const restoreTables = pendingRestore
    ? Object.entries(pendingRestore.backup.tables).filter(([, rows]) => Array.isArray(rows))
    : [];
  const restoreRows = restoreTables.reduce((a, [, rows]) => a + (rows as unknown[]).length, 0);

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      <div>
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Configuration</div>
        <h1 className="font-serif text-xl leading-tight" data-testid="text-page-title">Settings</h1>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">MCQ spaced repetition (FSRS)</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="srs-retention">Desired retention %</Label>
            <Input
              id="srs-retention"
              type="number"
              min={70}
              max={97}
              step="1"
              value={numValue("srsRetention", Math.round(((merged.srsRetention as number | undefined) ?? 0.9) * 100))}
              // The box is a percentage and the column is a 0..1 fraction, so
              // the draft holds what is on screen and only the stored value is
              // converted.
              onChange={(e) => setNum("srsRetention", e.target.value, (n) => n / 100)}
              data-testid="input-srs-retention"
            />
            {numHint("srsRetention", Math.round(((settings.srsRetention as number | undefined) ?? 0.9) * 100), "%")}
            <div className="text-xs text-muted-foreground">
              A question comes due when predicted recall drops to this. Anki's dial: higher = shorter
              intervals and more daily reviews for fewer misses. Default 90, allowed 70–97.
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="srs-new-per-day">New questions per day</Label>
            <Input
              id="srs-new-per-day"
              type="number"
              min={0}
              step="1"
              value={numValue("srsNewPerDay", (merged.srsNewPerDay as number | undefined) ?? 20)}
              onChange={(e) => setNum("srsNewPerDay", e.target.value)}
              data-testid="input-srs-new-per-day"
            />
            {numHint("srsNewPerDay", (settings.srsNewPerDay as number | undefined) ?? 20, " a day")}
            <div className="text-xs text-muted-foreground">
              How many never-seen questions each day's SRS sitting introduces. Anki's default is 20.
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="srs-max-reviews">Maximum reviews per day</Label>
            <Input
              id="srs-max-reviews"
              type="number"
              min={0}
              step="10"
              value={numValue("srsMaxReviewsPerDay", (merged.srsMaxReviewsPerDay as number | undefined) ?? 200)}
              onChange={(e) => setNum("srsMaxReviewsPerDay", e.target.value)}
              data-testid="input-srs-max-reviews"
            />
            {numHint("srsMaxReviewsPerDay", (settings.srsMaxReviewsPerDay as number | undefined) ?? 200, " a day")}
            <div className="text-xs text-muted-foreground">
              Caps due reviews served per day (overflow waits, oldest first). Relearning steps are never capped.
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="srs-fuzz">Interval fuzz</Label>
            <Select
              value={((merged.srsFuzz as number | undefined) ?? 1) !== 0 ? "on" : "off"}
              onValueChange={(v) => setForm({ ...form, srsFuzz: v === "on" ? 1 : 0 })}
            >
              <SelectTrigger id="srs-fuzz" data-testid="select-srs-fuzz"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="on">On (Anki default)</SelectItem>
                <SelectItem value="off">Off — exact intervals</SelectItem>
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground">
              Jitters intervals ±5% so questions first answered together don't come due as one clump forever.
            </div>
          </div>
          <div className="md:col-span-2">
            <Button onClick={() => save.mutate()} disabled={Object.keys(form).length === 0 || save.isPending} data-testid="button-save-srs">
              <Save className="h-4 w-4 mr-2" />Save SRS settings
            </Button>
          </div>
          <div className="md:col-span-2 space-y-2 rounded-lg border border-destructive/40 p-3">
            <div className="text-sm font-medium">Reset MCQ progress</div>
            <div className="text-xs text-muted-foreground">
              Wipes every MCQ attempt, study session and the whole SRS schedule — the scheduler restarts
              from zero and every question arrives as new. The question bank, your edits and dispute
              resolutions are untouched. This cannot be undone.
            </div>
            {resetArmed ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => resetMcq.mutate()}
                  disabled={resetMcq.isPending}
                  data-testid="button-reset-mcq-confirm"
                >
                  {resetMcq.isPending ? "Wiping…" : "Yes, wipe my MCQ progress"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setResetArmed(false)} data-testid="button-reset-mcq-cancel">
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setResetArmed(true)} data-testid="button-reset-mcq">
                Reset MCQ progress…
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Backup</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              A backup is one JSON file with your settings, MCQ edits and dispute verdicts, every attempt,
              the SRS schedule and your study sessions. The question bank itself is not included — it ships
              with the app.
            </div>
            {/* A real link, not a fetch: the browser saves the response under
                the server's Content-Disposition filename. */}
            <Button asChild variant="outline" size="sm">
              <a href={`${API_BASE}/api/export`} download data-testid="link-download-backup">
                <Download className="h-4 w-4 mr-2" /> Download backup
              </a>
            </Button>
          </div>

          <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
            <div className="text-sm font-medium">Restore from backup…</div>
            <div className="text-xs text-muted-foreground">
              Replaces everything listed above with the file's contents — what is on this server now is
              gone. Only a backup made by MCQ Study is accepted.
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="block text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground"
              onChange={(e) => void onPickBackup(e.target.files?.[0])}
              disabled={restore.isPending}
              data-testid="input-restore-file"
            />
            {readError && (
              <div className="text-xs text-destructive" data-testid="text-restore-error">{readError}</div>
            )}
            {pendingRestore && (
              <div className="space-y-2" data-testid="panel-restore-confirm">
                <div className="text-xs">
                  <span className="font-medium">{pendingRestore.name}</span>
                  {pendingRestore.backup.exportedAt ? ` · exported ${new Date(pendingRestore.backup.exportedAt).toLocaleString()}` : ""}
                  {` · ${restoreRows} row${restoreRows === 1 ? "" : "s"} in ${restoreTables.length} table${restoreTables.length === 1 ? "" : "s"}`}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => restore.mutate(pendingRestore.backup)}
                    disabled={restore.isPending}
                    data-testid="button-restore-confirm"
                  >
                    {restore.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
                    {restore.isPending ? "Restoring…" : "Yes, overwrite with this backup"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={cancelRestore} disabled={restore.isPending} data-testid="button-restore-cancel">
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Session</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="text-xs text-muted-foreground">
            {auth && !auth.required
              ? "No app password is set on this server, so there is no session to end."
              : "Ends this browser's session. You'll need the app password to get back in."}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending || (!!auth && !auth.required)}
            data-testid="button-sign-out"
          >
            <LogOut className="h-4 w-4 mr-2" />
            {signOut.isPending ? "Signing out…" : "Sign out"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
