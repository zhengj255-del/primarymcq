// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { AuthGate } from "@/App";

// THE MID-SESSION LOGOUT DEAD END (app shell).
//
// Sessions live in an in-memory store: every redeploy AND every routine Fly
// machine restart wipes them while the 30-day cookie lives on. AuthGate's
// /api/auth/status probe is cached forever (staleTime Infinity, no retries,
// no focus refetch), so after a restart every page query starts 401-failing
// while the gate still believes authed:true — error cards everywhere, and the
// login screen never comes back. On a phone Home-Screen tab there is no
// reload button, so the app was simply dead until the tab was killed.
// The fix has two halves. Any 401 re-probes auth status (queryClient.ts
// onSessionUnauthorized), so the gate stops trusting a session the server has
// already forgotten and re-evaluates to locked. The gate then puts the login
// screen ON TOP of the router rather than swapping it in: swapping unmounts
// every page, and with it the sitting on screen and the option picked but not
// yet submitted — the password would be demanded at the exact moment the work
// was destroyed, and the work would go first. So the app tree stays mounted
// and is made inert beneath the overlay, and a successful login simply drops
// the overlay away onto the page the owner was already on.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); queryClient.clear(); });

/** Stands in for the Study page's stats card — the first thing a page query
 *  fetches on this app's landing route. */
function StudyStatsStub() {
  const { error } = useQuery<unknown>({ queryKey: ["/api/mcqs/user-stats"] });
  return <div data-testid="app-content">{error ? "load failed" : "app running"}</div>;
}

describe("session death mid-use brings the login screen back", () => {
  it("a 401 from any page query raises the login screen over the still-mounted app", async () => {
    // The real sequence: gate probes while the session is alive, then the
    // machine restarts (store wiped) before the page query lands.
    let sessionAlive = true;
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("/api/auth/status")) {
        return {
          ok: true, status: 200,
          async json() { return { required: true, authed: sessionAlive }; },
          async text() { return JSON.stringify({ required: true, authed: sessionAlive }); },
        } as any;
      }
      // First page query arrives AFTER the restart: session is gone.
      sessionAlive = false;
      return {
        ok: false, status: 401,
        async json() { return { error: "auth_required" }; },
        async text() { return '{"error":"auth_required"}'; },
      } as any;
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <AuthGate><StudyStatsStub /></AuthGate>
      </QueryClientProvider>,
    );

    // Gate opens on the live session and the app renders…
    await screen.findByTestId("app-content");
    // …the stats query 401s → the gate must re-probe and lock again. The
    // password box is the proof the re-probe landed: without it the gate would
    // still be sitting on its cached authed:true and nothing would ask.
    const pw = await screen.findByTestId("input-app-password");
    expect(pw).toBeTruthy();
    // It is the RESUMED login screen, layered over the app, not the cold-load
    // one that replaces it — that copy ("still open behind this") is the promise
    // the assertions below hold the implementation to.
    expect(screen.getByTestId("overlay-login")).toBeTruthy();
    expect(screen.getByTestId("text-session-expired")).toBeTruthy();

    // THE POINT OF THE WHOLE DESIGN: the page the owner was on is still mounted.
    // Its query failed, so it shows its error state — but it is the SAME React
    // tree, so the sitting, the revealed feedback and the scroll position are
    // all still there, waiting for the login to succeed. An unmount here would
    // mean the session expiry itself destroyed the sitting.
    const content = screen.getByTestId("app-content");
    expect(content.textContent).toBe("load failed");

    // And it must be unreachable while the overlay is up: a live page whose
    // every save 401s is worse than a dead one if the owner can keep typing into
    // it. `inert` is the real mechanism (no pointer, no focus, no keyboard, out
    // of the a11y tree); aria-hidden and pointer-events:none are the fallback
    // for engines that do not honour it.
    const behind = screen.getByTestId("auth-content");
    expect(behind.contains(content)).toBe(true);
    expect(behind.hasAttribute("inert")).toBe(true);
    expect(behind.getAttribute("aria-hidden")).toBe("true");
    expect(behind.style.pointerEvents).toBe("none");
  });

  it("apiRequest (the runner's write path — attempts, ratings, verdicts) triggers the same recovery", async () => {
    // Page queries go through getQueryFn; every write goes through apiRequest.
    // Both must re-probe on a 401, or a session that dies between the last
    // query and the next answer strands the runner with a toast and no way
    // back in. Defeat the 1s re-probe throttle (shared module state across
    // tests) by jumping the clock.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 401,
      async json() { return { error: "auth_required" }; },
      async text() { return '{"error":"auth_required"}'; },
    }) as any));
    await expect(apiRequest("POST", "/api/mcqs/srs/rate", { mcqId: "Q1", rating: 3 })).rejects.toThrow(/401/);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["/api/auth/status"] });
  });
});
