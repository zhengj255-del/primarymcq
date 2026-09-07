import "./testDb";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { registerRoutes } from "../routes";
import { installAuth } from "../auth";
import { installBodyParsers } from "../bodyParsers";

// ---------------------------------------------------------------------------
// The app-wide password gate (server/auth.ts). This site has exactly ONE
// credential: APP_PASSWORD, exchanged at /api/login for a session cookie. There
// is no second way in — no bearer, no per-machine secret — so with the
// password set, every /api route except /api/healthz, /api/build and the auth
// endpoints themselves is closed to anyone without the cookie.
//
// The app is assembled exactly as server/index.ts assembles it — installAuth,
// THEN installBodyParsers, THEN registerRoutes — because the order is the
// point: no body is parsed for a caller nobody has identified, and the login
// route carries its own bounded parser so it still works ahead of the global
// ones. Driven over a real socket with fetch, carrying the cookie by hand.
// ---------------------------------------------------------------------------

const PASSWORD = "test-app-password";
let server: Server;
let baseUrl: string;

/** The session cookie a login handed back, as a request `cookie` header. */
function cookieFrom(res: globalThis.Response): string {
  const all: string[] = typeof (res.headers as any).getSetCookie === "function"
    ? (res.headers as any).getSetCookie()
    : [res.headers.get("set-cookie") ?? ""];
  return all.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const login = (password: string) => fetch(`${baseUrl}/api/login`, json({ password }));

beforeAll(async () => {
  // MUST be set before installAuth: the gate reads it once, at install time.
  process.env.APP_PASSWORD = PASSWORD;
  const app = express();
  installAuth(app);
  installBodyParsers(app);
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  server = httpServer;
});

afterAll(() => {
  delete process.env.APP_PASSWORD;
  server?.closeAllConnections?.();
  server?.close();
});

describe("with APP_PASSWORD set, the gate is closed", () => {
  it("reports auth as required and the caller as unauthenticated", async () => {
    const res = await fetch(`${baseUrl}/api/auth/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: true, authed: false });
  });

  it("closes a gated route with a JSON 401", async () => {
    const res = await fetch(`${baseUrl}/api/mcqs/stats`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
  });

  it("closes reads and writes alike, all the way down the MCQ API", async () => {
    for (const path of ["/api/settings", "/api/mcqs", "/api/mcqs/user-stats", "/api/mcqs/triage", "/api/export"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, path).toBe(401);
    }
    const write = await fetch(`${baseUrl}/api/mcqs/session`, json({ mode: "tutor", count: 5 }));
    expect(write.status).toBe(401);
    const wipe = await fetch(`${baseUrl}/api/mcqs/reset?confirm=YES`, { method: "POST" });
    expect(wipe.status).toBe(401);
    const restore = await fetch(`${baseUrl}/api/import?confirm=YES`, json({ version: 1, app: "mcq-site", tables: {} }));
    expect(restore.status).toBe(401);
  });

  it("leaves /api/healthz open for the platform health check", async () => {
    const res = await fetch(`${baseUrl}/api/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("leaves /api/build open for the stale-tab update poll", async () => {
    // A long-lived Home-Screen tab loses its session on redeploy (in-memory
    // store) — exactly the surface the build poll exists for. It must answer.
    const res = await fetch(`${baseUrl}/api/build`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.buildId).toBe("string");
    expect(body.buildId.length).toBeGreaterThan(0);
  });
});

describe("login, session cookie, logout", () => {
  it("rejects a wrong password without a cookie", async () => {
    const res = await login("wrong");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "wrong_password" });
    expect(cookieFrom(res)).toBe("");
  });

  it("a malformed login body is refused without echoing it anywhere", async () => {
    // The one route that carries a secret has its own parser AND its own
    // parse-error guard (server/bodyParsers.ts): a body that is not JSON is
    // answered with a fixed message, never with the text that was sent.
    const res = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "SuperSecret123",
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("SuperSecret123");
    expect(JSON.parse(text)).toEqual({ message: "request body is not valid JSON" });
  });

  it("the right password sets a cookie that opens the gate, and logout closes it again", async () => {
    const res = await login(PASSWORD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, authed: true });
    const cookie = cookieFrom(res);
    expect(cookie).not.toBe("");

    const stats = await fetch(`${baseUrl}/api/mcqs/stats`, { headers: { cookie } });
    expect(stats.status).toBe(200);
    const body = await stats.json();
    expect(typeof body.total).toBe("number");
    expect(body.total).toBeGreaterThan(0);

    const status = await fetch(`${baseUrl}/api/auth/status`, { headers: { cookie } });
    expect(await status.json()).toEqual({ required: true, authed: true });

    // The same cookie reaches the write routes too.
    const settings = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(settings.status).toBe(200);

    // Logout destroys the session; the cookie no longer names one.
    const out = await fetch(`${baseUrl}/api/logout`, { method: "POST", headers: { cookie } });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
    const after = await fetch(`${baseUrl}/api/mcqs/stats`, { headers: { cookie } });
    expect(after.status).toBe(401);
    const afterStatus = await fetch(`${baseUrl}/api/auth/status`, { headers: { cookie } });
    expect(await afterStatus.json()).toEqual({ required: true, authed: false });
  });

  it("a forged cookie is not a session", async () => {
    const res = await fetch(`${baseUrl}/api/mcqs/stats`, {
      headers: { cookie: "connect.sid=s%3Anot-a-real-session.forged-signature" },
    });
    expect(res.status).toBe(401);
  });
});

// The throttle is keyed by client address. trust proxy is 1 (Fly's edge), so
// the address is the last X-Forwarded-For entry when one is present — which
// lets these cases stand in for two different clients from one socket. A
// lock on one address must never refuse another: a global counter let any
// anonymous caller keep the owner locked out for as long as they liked.
describe("brute-force throttle is per client", () => {
  const as = (ip: string, password: string) =>
    fetch(`${baseUrl}/api/login`, {
      ...json({ password }),
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
    });

  it("five failures from one address lock that address only", async () => {
    for (let i = 1; i <= 5; i++) {
      expect((await as("10.0.0.1", `wrong-${i}`)).status, `wrong attempt ${i}`).toBe(401);
    }
    expect((await as("10.0.0.1", PASSWORD)).status).toBe(429);
    // A different client, right password, same moment: in.
    const other = await as("10.0.0.2", PASSWORD);
    expect(other.status).toBe(200);
    expect(cookieFrom(other)).not.toBe("");
    // And the lock itself is still in force for the first address.
    expect((await as("10.0.0.1", PASSWORD)).status).toBe(429);
  });

  it("a success clears that client's failure count without touching another's", async () => {
    for (let i = 1; i <= 4; i++) expect((await as("10.0.0.3", `wrong-${i}`)).status).toBe(401);
    expect((await as("10.0.0.3", PASSWORD)).status).toBe(200);   // 4 failures, then success
    for (let i = 1; i <= 4; i++) expect((await as("10.0.0.3", `wrong-${i}`)).status).toBe(401);
    // Four more after the reset is still four, not eight — no lock.
    expect((await as("10.0.0.3", PASSWORD)).status).toBe(200);
  });
});

// LAST: the lock this arms lives in module state for 30 s, and would refuse
// every login attempted after it in this worker.
describe("brute-force throttle", () => {
  it("five wrong attempts lock login for a while — even the right password is refused", async () => {
    // A successful login zeroes the failure counter, so the count below starts
    // from a known state whatever the earlier cases did.
    expect((await login(PASSWORD)).status).toBe(200);

    for (let i = 1; i <= 5; i++) {
      const res = await login(`wrong-${i}`);
      expect(res.status, `wrong attempt ${i}`).toBe(401);
    }
    const locked = await login(PASSWORD);
    expect(locked.status).toBe(429);
    const body = await locked.json();
    expect(body.error).toBe("too_many_attempts");
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.retryAfterMs).toBeLessThanOrEqual(30_000);
    expect(cookieFrom(locked)).toBe("");
  });
});
