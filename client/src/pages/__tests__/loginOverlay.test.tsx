// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { AuthGate } from "@/App";

// A SESSION EXPIRY MUST NOT THROW AWAY A SITTING.
//
// Sessions live in an in-memory store, so a redeploy or a routine Fly machine
// restart revokes this tab's session while the 30-day cookie lives on. The gate
// used to answer that by SWAPPING the login screen in for the router — which
// unmounts every page, and with it every piece of React state the candidate has
// not saved: the paper on screen, the option picked but not yet submitted, the
// timer's start point. The password was being asked for at the exact moment
// the work was destroyed, and the work was destroyed first.
//
// The gate must instead keep the tree MOUNTED and put the login screen on top of
// it. The Study page's sessionStorage snapshot is the primary protection for a
// test/tutor sitting; this overlay is the second layer, and it is the only
// layer that keeps state the snapshot does not cover (the revealed feedback,
// the scroll position, every other page's state).
//
// The overlay has to be genuinely modal: a page that is still live but whose
// every save 401s is worse than an unmount if the candidate can keep clicking
// into it. So the tree behind is `inert` + `aria-hidden` + `pointer-events:
// none`, and focus is moved into the password field.
//
// 401 STORM (the trap): keeping the tree mounted does NOT create one.
// queryClient.ts sets retry:false for queries AND mutations, refetchInterval:false,
// refetchOnWindowFocus:false and staleTime:Infinity, so a mounted-but-locked page
// fires nothing new on its own; onSessionUnauthorized is throttled to one probe a
// second and invalidates only ["/api/auth/status"], which is pre-gate and never
// itself 401s, so there is no invalidate -> refetch -> 401 loop.

let mounts = 0;

/** Stands in for a page mid-sitting: its answer lives ONLY in React state, so
 *  the assertions below are assertions about the component instance surviving. */
function SittingStub() {
  const [answer, setAnswer] = useState("");
  useEffect(() => {
    mounts += 1;
  }, []);
  return (
    <div>
      <textarea
        data-testid="sitting-answer"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
      />
      <button
        data-testid="button-save"
        onClick={() => {
          // The real save path: a 401 here is what tells the client the session
          // died (queryClient.onSessionUnauthorized re-probes /api/auth/status).
          apiRequest("POST", "/api/mcqs/attempt", { mcqId: "Q1", mode: "tutor", selected: answer, timeMs: 1 }).catch(() => {});
        }}
      >
        Save
      </button>
    </div>
  );
}

type Session = { alive: boolean };

function stubFetch(session: Session) {
  const reply = (status: number, body: unknown) =>
    ({
      ok: status < 400,
      status,
      async json() {
        return body;
      },
      async text() {
        return JSON.stringify(body);
      },
    }) as any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = String(input);
      // Pre-gate: answers whether the cookie is still honoured.
      if (url.includes("/api/auth/status")) return reply(200, { required: true, authed: session.alive });
      if (url.includes("/api/login")) {
        session.alive = true;
        return reply(200, { ok: true, authed: true });
      }
      return session.alive ? reply(200, {}) : reply(401, { error: "auth_required" });
    }),
  );
}

function renderGate() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <SittingStub />
      </AuthGate>
    </QueryClientProvider>,
  );
}

/** Kill the session and re-probe. The production trigger is a 401 from any page
 *  request (exercised in the first test); it is driven directly here because
 *  onSessionUnauthorized's 1 s throttle is module state shared by every test in
 *  this file, so a second 401-driven flip inside the same second is swallowed. */
async function killSession(session: Session) {
  session.alive = false;
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
  });
}

beforeEach(() => {
  mounts = 0;
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("a session that dies mid-sitting is a login overlay, not an unmount", () => {
  it("keeps the page mounted with its state intact and puts the login screen on top", async () => {
    const user = userEvent.setup();
    const session: Session = { alive: true };
    stubFetch(session);
    renderGate();

    const textarea = await screen.findByTestId("sitting-answer");
    await user.type(textarea, "adrenaline acts on beta-1");
    expect((textarea as HTMLTextAreaElement).value).toBe("adrenaline acts on beta-1");

    // The machine restarts: the very next save 401s, which re-probes auth.
    session.alive = false;
    await user.click(screen.getByTestId("button-save"));

    // The login screen must arrive…
    await screen.findByTestId("input-app-password");
    // …WITHOUT taking the sitting with it: same component instance (one mount,
    // never remounted) still holding the text that was never sent anywhere.
    const after = screen.getByTestId("sitting-answer") as HTMLTextAreaElement;
    expect(after.value).toBe("adrenaline acts on beta-1");
    expect(mounts).toBe(1);
    expect(screen.getByTestId("overlay-login")).toBeTruthy();
  });

  it("is genuinely modal: the tree behind is inert and unclickable, focus is in the password field", async () => {
    const user = userEvent.setup();
    const session: Session = { alive: true };
    stubFetch(session);
    renderGate();
    await screen.findByTestId("sitting-answer");

    await killSession(session);
    await screen.findByTestId("input-app-password");

    const behind = screen.getByTestId("auth-content");
    // inert is the mechanism (no clicks, no focus, out of the a11y tree);
    // aria-hidden and pointer-events are the fallback for browsers without it.
    expect(behind.hasAttribute("inert")).toBe(true);
    expect(behind.getAttribute("aria-hidden")).toBe("true");
    expect(behind.style.pointerEvents).toBe("none");

    const overlay = screen.getByTestId("overlay-login");
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-modal")).toBe("true");

    // Typing must land in the password box, not in the dead page behind it.
    expect(document.activeElement).toBe(screen.getByTestId("input-app-password"));
    // And the page behind cannot be interacted with at all.
    await expect(user.click(screen.getByTestId("button-save"))).rejects.toThrow(/pointer-events/);
  });

  it("hands the sitting back after login, still holding the unsaved answer", async () => {
    const user = userEvent.setup();
    const session: Session = { alive: true };
    stubFetch(session);
    renderGate();

    const textarea = await screen.findByTestId("sitting-answer");
    await user.type(textarea, "the anion gap is");
    await killSession(session);

    const password = await screen.findByTestId("input-app-password");
    await user.type(password, "hunter2");
    await user.click(screen.getByTestId("button-login"));

    // LoginScreen.onSuccess invalidates every query, so the gate re-probes,
    // sees authed:true and drops the overlay — the only escape there is.
    await waitFor(() => expect(screen.queryByTestId("overlay-login")).toBeNull());
    const after = screen.getByTestId("sitting-answer") as HTMLTextAreaElement;
    expect(after.value).toBe("the anion gap is");
    expect(mounts).toBe(1);
    expect(screen.getByTestId("auth-content").hasAttribute("inert")).toBe(false);
    // …and the cursor goes back where it was, not to the top of the document.
    expect(document.activeElement).toBe(after);
  });

  it("a cold load still shows the plain login screen and mounts no page behind it", async () => {
    // REGRESSION GUARD, not a bug pin: this passes before and after the fix, and
    // it is here because the overlay must NOT change the cold-load path. Nothing
    // is typed yet on a cold load, so there is nothing to protect, and mounting
    // the router behind the login screen would only fire a page full of queries
    // that are all certain to 401.
    const session: Session = { alive: false };
    stubFetch(session);
    renderGate();

    await screen.findByTestId("input-app-password");
    expect(screen.queryByTestId("sitting-answer")).toBeNull();
    expect(screen.queryByTestId("overlay-login")).toBeNull();
    expect(mounts).toBe(0);
  });

  it("an open gate (no APP_PASSWORD set) renders the page with no login screen at all", async () => {
    // Dev/test mode: the server reports required:false and the gate must be
    // invisible — no overlay, no password box, page mounted and interactive.
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      const body = url.includes("/api/auth/status") ? { required: false, authed: false } : {};
      return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } } as any;
    }));
    renderGate();
    await screen.findByTestId("sitting-answer");
    expect(screen.queryByTestId("input-app-password")).toBeNull();
    expect(screen.queryByTestId("overlay-login")).toBeNull();
    expect(screen.getByTestId("auth-content").hasAttribute("inert")).toBe(false);
    expect(mounts).toBe(1);
  });
});
