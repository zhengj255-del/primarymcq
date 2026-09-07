// -------------------------------------------------------------------------------------------------
// App-wide auth gate.
//
// Single-user app, so auth is deliberately simple: one shared password
// (APP_PASSWORD, a Fly secret) exchanged for a session cookie. Every /api
// route is then closed unless the request carries an authenticated session
// cookie (the browser, after /api/login). There is no second credential: the
// browser is the only client this site has, and nothing else talks to it.
// /api/healthz stays open for the Fly health check, and the auth endpoints
// themselves are registered before the gate so login is reachable.
//
// THIS WHOLE FILE IS INSTALLED BEFORE THE BODY PARSERS (server/index.ts): no
// body may be buffered or parsed for a caller nobody has identified yet. The
// consequence is that /api/login brings its own small parser, below.
//
// If APP_PASSWORD is unset the gate is disabled entirely — local dev and the
// test suite run exactly as before — with a loud warning in production.
// -------------------------------------------------------------------------------------------------

import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import createMemoryStore from "memorystore";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { bodyParseErrorGuard } from "./bodyParsers";

declare module "express-session" {
  interface SessionData {
    authed?: boolean;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The gate is registered BEFORE the body parsers (server/index.ts), so the one
// route that must read a body to work — /api/login, checking a password —
// brings its own parser. 16 KB bounds ONE UNAUTHENTICATED ROUTE'S INPUT, never
// the owner's data: /api/import keeps its 500 MB parser (bodyParsers.ts) and
// every authenticated route keeps the 50 MB global one.
// ESCAPE (D2): raise this literal if the login body ever carries more than a
// password. There is no runtime switch, because nothing else may be posted here
// — a body that does not fit a password is not a login attempt.
const LOGIN_BODY_LIMIT = "16kb";

// ---------------------------------------------------------------------------
// "THE GATE IS INSTALLED AND OPEN" — said once, through the exact expression
// every session check reads.
//
// With APP_PASSWORD unset the app-wide gate opens (below), but nothing ever
// sets req.session.authed: the login stub returns `{authed:true}` without
// touching the session, and the client's AuthGate never even POSTs /api/login
// when `required:false` (client/src/App.tsx). GET /api/auth/status answers
// `authed: !enabled || hasAuthedSession(req)`; this makes the request agree
// with the answer the gate is already giving about it, so any route that reads
// `req.session.authed` sees the same thing in open dev/test mode as it does
// behind a real login.
//
// NON-ENUMERABLE ON PURPOSE. express-session decides whether to persist a
// session and re-send its cookie by hashing JSON.stringify(session); an
// enumerable property would mark EVERY anonymous request dirty and mint a store
// entry plus a Set-Cookie for it — turning a change about not doing work for
// anonymous callers into work done for anonymous callers, and growing the
// memory store for a cookie-less script for the 30-day cookie life. A
// non-enumerable value is invisible to that hash and to any later save, so
// nothing is stored and no cookie is sent, while `req.session.authed === true`
// still reads true for this request alone.
//
// ESCAPE (D2): set APP_PASSWORD and the stamp is never applied — a real login
// is required exactly as in production.
// ---------------------------------------------------------------------------
function markGateOpen(req: Request): void {
  const s = (req as any).session;
  if (!s || s.authed === true) return;
  Object.defineProperty(s, "authed", {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

// Constant-time string comparison.
function safeEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True when the request's session has been authenticated via /api/login. */
export function hasAuthedSession(req: Request): boolean {
  return (req as any).session?.authed === true;
}

export function installAuth(app: Express): void {
  const password = process.env.APP_PASSWORD ?? "";
  const enabled = password.length > 0;
  if (!enabled) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[auth] WARNING: APP_PASSWORD is not set — every API route is open to the internet. " +
          "Set it with `fly secrets set APP_PASSWORD=...`",
      );
    } else {
      console.log("[auth] APP_PASSWORD not set — auth gate disabled (dev/test mode)");
    }
  }

  // Fly terminates TLS at the edge; trust its X-Forwarded-Proto so secure
  // cookies work behind the proxy.
  app.set("trust proxy", 1);

  const MemoryStore = createMemoryStore(session);
  // Deterministic secret derived from the password so sessions survive
  // process restarts (memorystore itself does not, but the cookie signature
  // stays valid across deploys if a persistent store is swapped in later).
  const secret =
    process.env.SESSION_SECRET ||
    (enabled
      ? createHash("sha256").update(`mcq-site-session:${password}`).digest("hex")
      : randomBytes(32).toString("hex"));

  app.use(
    session({
      store: new MemoryStore({ checkPeriod: DAY_MS }),
      secret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 30 * DAY_MS,
      },
    }),
  );

  // Tiny brute-force throttle: 5 consecutive failures from one client lock
  // THAT client out of login for 30s. Keyed by client address, not one global
  // counter: a shared counter let any anonymous caller keep the owner locked
  // out indefinitely with five wrong passwords every 30 s — a denial of login
  // with no password at risk, but a denial all the same. req.ip is the address
  // Fly's edge appended to X-Forwarded-For (trust proxy 1, above), so a client
  // cannot pick its own key. The table is bounded: entries are swept once
  // their lock has lapsed, and a flood of distinct addresses is capped at a
  // size a memory-only process can hold without noticing.
  type Throttle = { failures: number; lockedUntil: number; seenAt: number };
  const throttle = new Map<string, Throttle>();
  const THROTTLE_MAX_CLIENTS = 10_000;
  const THROTTLE_IDLE_MS = 5 * 60_000;
  const sweepThrottle = (now: number) => {
    throttle.forEach((t, ip) => {
      if (t.lockedUntil <= now && now - t.seenAt > THROTTLE_IDLE_MS) throttle.delete(ip);
    });
    // Still over the cap after the sweep (a flood mid-window): drop the
    // oldest entries — forgetting a failure count is the safe direction.
    if (throttle.size > THROTTLE_MAX_CLIENTS) {
      const excess = Array.from(throttle.entries())
        .sort((a, b) => a[1].seenAt - b[1].seenAt)
        .slice(0, throttle.size - THROTTLE_MAX_CLIENTS);
      for (const [ip] of excess) throttle.delete(ip);
    }
  };
  const throttleFor = (req: Request, now: number): Throttle => {
    if (throttle.size >= THROTTLE_MAX_CLIENTS) sweepThrottle(now);
    const key = req.ip || "unknown";
    let t = throttle.get(key);
    if (!t) {
      t = { failures: 0, lockedUntil: 0, seenAt: now };
      throttle.set(key, t);
    }
    t.seenAt = now;
    return t;
  };

  app.get("/api/auth/status", (req: Request, res: Response) => {
    res.json({ required: enabled, authed: !enabled || hasAuthedSession(req) });
  });

  app.post("/api/login", express.json({ limit: LOGIN_BODY_LIMIT }), (req: Request, res: Response) => {
    if (!enabled) return res.json({ ok: true, authed: true });
    const now = Date.now();
    const t = throttleFor(req, now);
    if (now < t.lockedUntil) {
      return res.status(429).json({ error: "too_many_attempts", retryAfterMs: t.lockedUntil - now });
    }
    const provided = typeof req.body?.password === "string" ? req.body.password : "";
    if (!safeEqual(provided, password)) {
      t.failures += 1;
      if (t.failures >= 5) {
        t.lockedUntil = now + 30_000;
        t.failures = 0;
      }
      return res.status(401).json({ error: "wrong_password" });
    }
    throttle.delete(req.ip || "unknown");
    req.session.authed = true;
    res.json({ ok: true, authed: true });
  });

  // A malformed login body is the ONE parse failure that can be made of the
  // owner's password, and the parser above runs before the global one, so it
  // needs the same guard the global parsers get (server/bodyParsers.ts). One
  // definition, registered wherever a parser is.
  app.use("/api/login", bodyParseErrorGuard);

  app.post("/api/logout", (req: Request, res: Response) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // The gate itself. Registered AFTER the auth endpoints above (so they are
  // always reachable) and BEFORE registerRoutes (so every API route is
  // covered). req.path here is relative to the /api mount.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) {
      markGateOpen(req); // see markGateOpen: the request agrees with the gate
      return next();
    }
    if (req.path === "/healthz") return next(); // Fly health check
    // The stale-tab update poll: a long-lived Home-Screen tab loses its session
    // on redeploy (in-memory store) — exactly the surface the poll exists for.
    // Leaks only a 12-hex content-derived build id.
    if (req.path === "/build") return next();
    if (hasAuthedSession(req)) return next();
    res.status(401).json({ error: "auth_required" });
  });
}
