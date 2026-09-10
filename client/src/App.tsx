import { Switch, Route, Router, Link, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient, apiRequest } from "./lib/queryClient";
import { takeDeliberateSignOut } from "./lib/signOut";
import { QueryClientProvider, useQuery, useMutation } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect, useState, useRef, Component, type ReactNode } from "react";
import NotFound from "@/pages/not-found";
import StudyPage from "@/pages/Study";
import MCQsPage from "@/pages/MCQs";
import SettingsPage from "@/pages/Settings";
import { Brain, FileQuestion, Settings as SettingsIcon, RefreshCw, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export const NAV: Array<{ href: string; label: string; icon: any; testId: string }> = [
  { href: "/", label: "Study", icon: Brain, testId: "link-study" },
  { href: "/mcqs", label: "MCQs", icon: FileQuestion, testId: "link-mcqs" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, testId: "link-settings" },
];

// "/study" is the Study page under its own name (a bookmark or a deep link),
// "/" is the same page as the landing route. One NAV entry covers both, so
// active-state matching and the document title fold the alias onto "/".
const ROUTE_ALIASES: Record<string, string> = { "/study": "/" };
const canonicalPath = (location: string) => ROUTE_ALIASES[location] ?? location;

function DarkModeToggle() {
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const saved = window.localStorage?.getItem("theme");
    if (saved === "dark") return true;
    if (saved === "light") return false;
    // No saved preference: defaults to dark (index.html applies the same
    // default before first paint, so there is no flash).
    return true;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try { window.localStorage?.setItem("theme", dark ? "dark" : "light"); } catch {}
  }, [dark]);
  // Labelled pill toggle: a track that slides + a mono DARK/LIGHT label.
  return (
    <button
      type="button"
      onClick={() => setDark((d) => !d)}
      data-testid="button-toggle-theme"
      aria-label="Dark theme"
      role="switch"
      aria-checked={dark}
      className="inline-flex items-center gap-2 rounded-full border border-card-border bg-card/60 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover-elevate"
    >
      <span className="relative inline-block h-3.5 w-6 rounded-full bg-primary">
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-primary-foreground transition-all ${dark ? "right-0.5" : "left-0.5"}`} />
      </span>
      {dark ? "Dark" : "Light"}
    </button>
  );
}

// Global refresh: re-pull whatever the visible page is querying, via the shared
// queryClient. invalidateQueries() marks every cached query stale and refetches
// the ACTIVE ones (the current page's), so this works on every route without
// per-page wiring. It is a plain re-fetch — GETs only — and the states are
// honest: spin only while the refetches are actually in flight, "Updated" only
// once they've all resolved, an error mark if any of them failed.
type RefreshState = "idle" | "busy" | "done" | "error";

export function GlobalRefreshButton({ testId = "global-refresh" }: { testId?: string }) {
  const [state, setState] = useState<RefreshState>("idle");
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const refresh = async () => {
    if (state === "busy") return; // double-tap guard (button is also disabled)
    if (timer.current !== null) window.clearTimeout(timer.current);
    setState("busy");
    let next: RefreshState = "done";
    try {
      await queryClient.invalidateQueries();
      // invalidateQueries resolves even when refetches fail — check the cache
      // so a failed refresh never shows a false "Updated".
      const anyFailed = queryClient
        .getQueryCache()
        .findAll({ type: "active" })
        .some((q) => q.state.status === "error");
      if (anyFailed) next = "error";
    } catch {
      next = "error";
    }
    setState(next);
    timer.current = window.setTimeout(() => { setState("idle"); timer.current = null; }, 1500);
  };

  const busy = state === "busy";
  const Icon = state === "done" ? Check : state === "error" ? AlertCircle : RefreshCw;
  return (
    <button
      type="button"
      onClick={refresh}
      disabled={busy}
      aria-label="Refresh"
      aria-busy={busy}
      title={state === "done" ? "Updated" : state === "error" ? "Refresh failed" : "Refresh"}
      data-testid={testId}
      data-state={state}
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-card-border bg-card/60 text-muted-foreground hover-elevate disabled:opacity-60"
    >
      {/* motion-safe: users with prefers-reduced-motion get a static busy
          state (dimmed button + aria-busy) instead of the spin. */}
      <Icon className={`h-4 w-4 ${busy ? "motion-safe:animate-spin" : ""} ${state === "done" ? "text-primary" : ""} ${state === "error" ? "text-destructive" : ""}`} />
      <span className="sr-only" role="status">
        {state === "done" ? "Updated" : state === "error" ? "Refresh failed" : ""}
      </span>
    </button>
  );
}

// Active-state helper — nav entries may include a query string (e.g. /mcqs?x=1)
// which wouter's location hook strips out. Match on path + optional query flag.
export function isNavActive(location: string, href: string): boolean {
  const [hrefPath, hrefQuery] = href.split("?");
  if (canonicalPath(location) !== hrefPath) return false;
  if (!hrefQuery) {
    // A query-free entry is active for ANY view of its path.
    return true;
  }
  // href carries query — verify at least one flag matches the current hash.
  if (typeof window === "undefined") return false;
  const hash = window.location.hash || "";
  const qIdx = hash.indexOf("?");
  if (qIdx < 0) return false;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const hrefParams = new URLSearchParams(hrefQuery);
  for (const [k, v] of Array.from(hrefParams.entries())) {
    if (params.get(k) !== v) return false;
  }
  return true;
}

// The brand mark: a plain monogram block, the same one the login screen
// shows, so the app is recognisable from either.
function BrandMark({ className = "" }: { className?: string }) {
  return <span className={`ledger-monogram ${className}`} aria-hidden="true">M</span>;
}

export function Sidebar() {
  const [location] = useLocation();
  return (
    <aside className="ledger-sidebar bg-sidebar text-sidebar-foreground border-b border-sidebar-border">
      <Link href="/" className="ledger-brand flex items-center gap-2.5" aria-label="MCQ Study home">
        <BrandMark />
        <div className="min-w-0">
          <div className="ledger-brand-name">MCQ Study</div>
          <div className="ledger-brand-meta">ANZCA PRIMARY</div>
        </div>
      </Link>
      {/* Four routes, one flat row — no menus to open. overflow-x-auto lets a
          phone scroll the row rather than wrap the sticky bar. */}
      <nav className="ledger-nav overflow-x-auto" aria-label="Primary navigation">
        {NAV.map((n) => {
          const active = isNavActive(location, n.href);
          const Icon = n.icon;
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`ledger-nav-link !w-auto !min-h-[2.5rem] !rounded-full !px-4 !py-2 gap-2 text-sm shrink-0 ${active ? "is-active" : ""}`}
              data-testid={n.testId}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{n.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="ledger-rail-footer">
        <div className="ledger-rail-controls">
          <DarkModeToggle />
          <GlobalRefreshButton />
        </div>
      </div>
    </aside>
  );
}

export function MobileNav() {
  const [location] = useLocation();
  return (
    <div className="md:hidden sticky top-0 z-40 bg-sidebar text-sidebar-foreground border-b border-sidebar-border">
      <div className="flex items-center justify-between gap-2 p-3">
        <Link href="/" className="flex min-w-0 items-center gap-2" aria-label="MCQ Study home">
          <BrandMark className="!h-7 !w-8 !text-sm" />
          <span className="truncate font-serif text-base">MCQ Study</span>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <GlobalRefreshButton testId="global-refresh-mobile" />
          <DarkModeToggle />
        </div>
      </div>
      <nav className="flex overflow-x-auto border-t border-sidebar-border">
        {NAV.map((n) => {
          const active = isNavActive(location, n.href);
          return (
            <Link key={n.href} href={n.href} className={`px-3 py-2 text-xs whitespace-nowrap ${active ? "border-b-2 border-sidebar-primary text-sidebar-accent-foreground" : "opacity-70"}`}
              data-testid={n.testId + "-mobile"}>
              {n.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * A single-page app keeps running the bundle it loaded at boot. On a phone —
 * especially a Home Screen web app, which has no address bar, reload button or
 * pull-to-refresh — that can silently be days-old code with no obvious way to
 * refresh. Poll the server's build id and offer a one-tap update when it moves.
 */
function UpdateBanner() {
  const bootId = useRef<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/build", { cache: "no-store" });
        if (!res.ok) return;                    // not logged in yet, etc. — ignore
        const { buildId } = await res.json();
        if (cancelled || !buildId || buildId === "dev") return;
        if (bootId.current === null) bootId.current = buildId;
        else if (buildId !== bootId.current) setStale(true);
      } catch { /* offline — try again next tick */ }
    };
    check();
    const timer = window.setInterval(check, 60_000);
    // Coming back to the app is the moment a stale tab matters most.
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  if (!stale) return null;
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
        <span className="text-sm">A new version is available</span>
        <Button size="sm" onClick={() => window.location.reload()} data-testid="button-app-update">
          Update
        </Button>
      </div>
    </div>
  );
}

export function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={StudyPage} />
      <Route path="/study" component={StudyPage} />
      <Route path="/mcqs" component={MCQsPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

// Wrap wouter's hash-location hook so route MATCHING ignores any query string
// in the hash (e.g. "#/mcqs?topic=x"). Without this, wouter tries to match the
// path "/mcqs?topic=x" against Route path="/mcqs", fails, and renders the 404.
// Navigation is passed straight through, so the full hash (incl. the query)
// is still written to the URL and remains readable via window.location.hash.
export function useHashLocationNoQuery(): [string, (to: string, opts?: any) => void] {
  const [loc, navigate] = useHashLocation();
  const qIdx = loc.indexOf("?");
  const path = qIdx === -1 ? loc : loc.slice(0, qIdx);
  return [path, navigate];
}
// Carry the stock hook's href formatter ("#" + path) onto the wrapper. Wouter
// reads `hook.hrefs` to build every <Link>'s DOM href; without it each link
// rendered href="/mcqs" — fine on left click (navigate() intercepts) but a
// middle-click / copy-link / open-in-new-tab hit the path as a URL, which the
// server answers with the SPA shell at "/", deep link silently gone. Attached
// to the hook (not a <Router hrefs> prop) so every consumer, tests included,
// gets the same formatter.
useHashLocationNoQuery.hrefs = (useHashLocation as unknown as { hrefs: (href: string) => string }).hrefs;

// ---------------------------------------------------------------------------
// App password gate. The server closes every /api route unless the session
// cookie is authenticated (or APP_PASSWORD is unset, e.g. local dev — then
// /api/auth/status reports required=false and this renders nothing extra).
// ---------------------------------------------------------------------------
// `resumed` = this is the OVERLAY over a page that is still open behind it (a
// session that died mid-use), not a cold load. The user is looking at a login
// box that appeared over their half-finished sitting, so say plainly that the
// work is still there — otherwise the honest assumption is that it is gone
// and the rational move is a panicked reload, which is what actually loses it.
function LoginScreen({ resumed = false }: { resumed?: boolean }) {
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/login", { password })).json(),
    onSuccess: () => {
      // Every query so far 401'd — refetch the world now that we have a session.
      queryClient.invalidateQueries();
    },
  });
  const locked = login.isError && String((login.error as Error)?.message ?? "").startsWith("429");
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-xl border border-card-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">ANZCA Primary</div>
            <div className="text-base font-semibold leading-tight">MCQ Study</div>
          </div>
        </div>
        {resumed && (
          <p className="text-sm text-muted-foreground" data-testid="text-session-expired">
            Your session expired — the page you were on is still open behind this, with your work on
            it. Sign in to carry on where you were.
          </p>
        )}
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); if (password && !login.isPending) login.mutate(); }}
        >
          <label htmlFor="app-password" className="block text-sm font-medium">
            App password
          </label>
          <input
            id="app-password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="App password"
            aria-invalid={login.isError}
            aria-describedby={login.isError ? "login-error" : undefined}
            data-testid="input-app-password"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
          />
          <Button type="submit" className="w-full" disabled={!password || login.isPending} data-testid="button-login">
            {login.isPending ? "Checking…" : "Unlock"}
          </Button>
          {login.isError && (
            <p id="login-error" role="alert" className="text-xs text-destructive" data-testid="text-login-error">
              {locked ? "Too many attempts — wait 30 seconds." : "Wrong password."}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery<{ required: boolean; authed: boolean }>({
    queryKey: ["/api/auth/status"],
  });
  // Sessions live in an in-memory store, so a redeploy or a routine Fly machine
  // restart revokes this tab's session while the 30-day cookie lives on. This
  // gate used to answer that by SWAPPING the login screen in for the router,
  // which unmounts every page — and with it every piece of React state the user
  // has not saved: the sitting on screen, the option picked but not yet
  // submitted, where the timer started. The password was asked for at the
  // exact moment the work was destroyed, and the work was destroyed first. So
  // once the gate has opened in THIS page session there is a live tree worth
  // keeping, and the login screen goes ON TOP of it instead of replacing it.
  // (The Study page's sessionStorage snapshot is the primary protection for a
  // test/tutor sitting; this is the second layer, and the only one that keeps
  // what the snapshot does not: the revealed feedback, scroll position, every
  // other page's state.)
  const everAuthed = useRef(false);
  if (data && (!data.required || data.authed)) everAuthed.current = true;
  const locked = !!data && data.required && !data.authed;
  // Settings → Sign out (lib/signOut.ts): the lock this render sees was asked
  // for, so there is no work behind it to keep — forget that the gate was
  // ever open and fall through to the cold-load branch below, which unmounts
  // the tree and shows the plain login screen rather than the "expired" one.
  if (locked && takeDeliberateSignOut()) everAuthed.current = false;

  // Modal focus etiquette, and it matters more here than usual: focus goes INTO
  // the password box while the overlay is up (LoginScreen autoFocuses), and it
  // must come back to whatever the user was on when the session died —
  // otherwise logging back in lands the cursor at the top of the document.
  // Declared before the early returns below so the hook order never changes.
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const wasLocked = useRef(false);
  if (locked && !wasLocked.current) {
    // Captured HERE, in the render that first sees the lock, and not in an
    // effect: LoginScreen's autoFocus runs in the commit phase, i.e. BEFORE any
    // effect of this component, so by the time an effect looked, the element it
    // found would already be the password box. document.body means nothing was
    // focused, and focusing that back is pointless.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) returnFocusTo.current = active;
  }
  wasLocked.current = locked;
  useEffect(() => {
    if (locked) return;
    const el = returnFocusTo.current;
    returnFocusTo.current = null;
    if (el && el.isConnected) el.focus();
  }, [locked]);

  // While the status probe is in flight, render nothing rather than flashing
  // the login form at users whose session is already valid.
  if (isLoading) return null;
  // Cold load: nothing is typed yet, so there is nothing to protect, and
  // mounting the router behind the login screen would only fire a page full of
  // queries that are all certain to 401. Keep that path exactly as it was.
  if (locked && !everAuthed.current) return <LoginScreen />;
  return (
    <>
      {/* Rendered in EVERY state, because React reconciles by position: adding
          this wrapper only while locked would insert a new parent element around
          the whole router and remount precisely the subtree this exists to keep
          alive. `display: contents` means it generates no box, so it changes no
          layout in the normal (unlocked) case. */}
      <div
        data-testid="auth-content"
        aria-hidden={locked || undefined}
        style={locked ? { display: "contents", pointerEvents: "none" } : { display: "contents" }}
        // A live page whose every save 401s is WORSE than an unmount if the
        // user can keep clicking into it, so the overlay has to be genuinely
        // modal. `inert` is the mechanism (no pointer, no focus, no keyboard,
        // out of the a11y tree); aria-hidden and pointer-events are the fallback
        // for anything too old to honour it. React 18's DOM props do not know
        // `inert`, hence the cast — it is a plain HTML attribute either way.
        {...(locked ? ({ inert: "" } as any) : {})}
      >
        {children}
      </div>
      {locked && (
        // Above everything the shell itself puts on screen (UpdateBanner z-50,
        // skip link z-[100]) — the update banner's reload button in particular
        // must not be reachable, since reloading is what loses the sitting.
        // ESCAPE: the overlay is dismissed by exactly one thing, a successful
        // login, which invalidates every query so the pages behind refetch on
        // the new session. There is deliberately no dismiss button: nothing
        // behind it can talk to the server until the session is back.
        <div
          className="fixed inset-0 z-[200] overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Session expired — sign in to continue"
          data-testid="overlay-login"
        >
          <LoginScreen resumed />
        </div>
      )}
    </>
  );
}

// A render crash anywhere in a page used to blank the ENTIRE SPA — on a phone
// Home-Screen tab (no reload button) that's a hard dead end. The boundary
// keeps the shell alive, says honestly what happened, and offers the reload.
export class PageErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-6 max-w-md mx-auto space-y-3" data-testid="page-error-boundary">
          <div className="text-sm font-medium">This page hit an error and couldn't render.</div>
          <div className="text-xs text-muted-foreground break-words">
            {String(this.state.error?.message ?? this.state.error).slice(0, 300)}
          </div>
          <div className="flex items-center gap-2">
            {/* Same-route retry for transient crashes — navigation resets the
                boundary via its route key, but re-tapping the CURRENT nav
                entry doesn't change the key. */}
            <Button size="sm" variant="outline" onClick={() => this.setState({ error: null })} data-testid="button-error-retry">
              Try again
            </Button>
            <Button size="sm" onClick={() => window.location.reload()} data-testid="button-error-reload">
              Reload the app
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Key the boundary by route so navigating away from a crashed page remounts
// it clean — without this the fallback stuck to every route until a full
// reload, which made the nav itself look broken.
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <PageErrorBoundary key={location}>{children}</PageErrorBoundary>;
}

// Hash routing does not update the document title by itself. Keep the browser
// title useful, and move keyboard/screen-reader focus to the newly rendered
// page after in-app navigation (but not on the initial load).
export function RouteAccessibility() {
  const [location] = useLocation();
  const initialRender = useRef(true);

  useEffect(() => {
    const path = canonicalPath(location);
    const navItem = NAV.find((item) => item.href === path);
    const pageName = navItem ? navItem.label : "Page not found";
    document.title = path === "/"
      ? "MCQ Study"
      : `${pageName} · MCQ Study`;

    if (initialRender.current) {
      initialRender.current = false;
      return;
    }
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [location]);

  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthGate>
          <Router hook={useHashLocationNoQuery}>
            <RouteAccessibility />
            <div className="app-shell min-h-screen flex flex-col bg-background">
              <a
                href="#main-content"
                onClick={(event) => {
                  // A plain fragment would collide with the app's hash-based
                  // router, so retain link semantics without changing routes.
                  event.preventDefault();
                  document.getElementById("main-content")?.focus({ preventScroll: true });
                }}
                className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:border focus:border-ring focus:bg-background focus:px-4 focus:py-2 focus:text-foreground"
              >
                Skip to main content
              </a>
              <Sidebar />
              <main id="main-content" tabIndex={-1} className="app-ledger-workspace flex-1 min-w-0">
                <RoutedErrorBoundary><AppRouter /></RoutedErrorBoundary>
              </main>
            </div>
            <UpdateBanner />
          </Router>
        </AuthGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
