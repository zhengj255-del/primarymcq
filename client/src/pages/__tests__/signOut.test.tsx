// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { AppRouter, AuthGate, useHashLocationNoQuery } from "@/App";
import { saveStudySnapshot, loadStudySnapshot, type StudySnapshot } from "@/pages/Study";

// ---------------------------------------------------------------------------
// A DELIBERATE SIGN-OUT IS A FRESH START, NOT A LOST SESSION.
//
// AuthGate keeps the page tree mounted behind a login overlay when a session
// dies mid-use (see loginOverlay.test.tsx) — that is the right answer to a
// machine restart. It was the wrong answer to Settings → Sign out: the gate
// only knew "locked, and it was open before", so it showed the overlay with
// its "Your session expired — the page you were on is still open behind
// this" copy over the signed-out person's half-finished sitting, and whoever
// typed the shared password next inherited all of it. The Study snapshot in
// sessionStorage survived too, so the next person was also offered the
// previous person's paper to resume.
//
// After a sign-out the gate must show the PLAIN login screen with the tree
// unmounted, and the snapshot must be gone.
// ---------------------------------------------------------------------------

const SETTINGS = { id: 1, srsRetention: 0.9, srsFuzz: 1, srsNewPerDay: 20, srsMaxReviewsPerDay: 200 };

const SNAPSHOT: StudySnapshot = {
  session: { sessionId: "sess-left-behind", mode: "tutor", mcqs: [{ id: "Q1" }] as any, timeLimitSec: null } as any,
  idx: 0,
  answered: [],
  sessionStartMs: Date.now(),
};

function stubFetch() {
  let authed = true;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const path = url.split("?")[0];
    const method = String(init?.method ?? "GET").toUpperCase();
    let body: unknown = {};
    let status = 200;
    if (path.endsWith("/api/auth/status")) body = { required: true, authed };
    else if (path.endsWith("/api/logout") && method === "POST") { authed = false; body = { ok: true }; }
    else if (path.endsWith("/api/settings")) body = SETTINGS;
    else if (!authed) { status = 401; body = { error: "auth_required" }; }
    return { ok: status < 400, status, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
  }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  queryClient.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); queryClient.clear(); });

describe("Settings → Sign out", () => {
  it("shows the plain login screen, unmounts the page and drops the Study snapshot", async () => {
    stubFetch();
    saveStudySnapshot(SNAPSHOT);
    window.history.replaceState(null, "", "/#/settings");
    render(
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <Router hook={useHashLocationNoQuery}><AppRouter /></Router>
        </AuthGate>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByTestId("button-sign-out"));

    // The password box comes back…
    await screen.findByTestId("input-app-password");
    // …as the COLD screen: no overlay, no "expired" copy, and nothing mounted
    // behind it — the Settings page (and every other page) is gone.
    expect(screen.queryByTestId("overlay-login")).toBeNull();
    expect(screen.queryByTestId("text-session-expired")).toBeNull();
    expect(screen.queryByTestId("auth-content")).toBeNull();
    expect(screen.queryByTestId("button-sign-out")).toBeNull();
    // The previous person's sitting is not offered to the next one.
    expect(loadStudySnapshot()).toBeNull();
  });

  it("a genuine expiry afterwards still gets the overlay (the flag is consumed, not sticky)", async () => {
    // Same sequence, then log back in and let a page query 401: the gate
    // must be back to protecting the tree, i.e. the resumed overlay.
    let authed = true;
    let logins = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      const path = url.split("?")[0];
      const method = String(init?.method ?? "GET").toUpperCase();
      let body: unknown = {};
      let status = 200;
      if (path.endsWith("/api/auth/status")) body = { required: true, authed };
      else if (path.endsWith("/api/logout") && method === "POST") { authed = false; body = { ok: true }; }
      else if (path.endsWith("/api/login") && method === "POST") { authed = true; logins += 1; body = { ok: true, authed: true }; }
      else if (path.endsWith("/api/settings")) {
        // After the second session begins, the very next page query finds the
        // session gone (a restart) — the mid-use death the overlay exists for.
        if (logins >= 1) { authed = false; status = 401; body = { error: "auth_required" }; }
        else body = SETTINGS;
      }
      return { ok: status < 400, status, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
    }));
    window.history.replaceState(null, "", "/#/settings");
    render(
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <Router hook={useHashLocationNoQuery}><AppRouter /></Router>
        </AuthGate>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByTestId("button-sign-out"));
    await screen.findByTestId("input-app-password");
    expect(screen.queryByTestId("overlay-login")).toBeNull();

    // Log back in → the tree mounts → its first query 401s → overlay.
    fireEvent.change(screen.getByTestId("input-app-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("button-login"));
    await waitFor(() => expect(screen.queryByTestId("overlay-login")).not.toBeNull());
    expect(screen.getByTestId("text-session-expired")).toBeTruthy();
    expect(screen.getByTestId("auth-content")).toBeTruthy();
  });
});
