import "dotenv/config";
import express, { Response, NextFunction } from "express";
import type { Request } from "express";
import { registerRoutes } from "./routes";
import { installAuth } from "./auth";
import { serveStatic } from "./static";
import { startRollingBackups } from "./backups";
import { installShutdownHandlers } from "./shutdown";
import { installBodyParsers, safeErrorFields } from "./bodyParsers";
import { serializeForLog } from "./logRedact";
import { createServer } from "node:http";

const app = express();
const httpServer = createServer(app);

// Global crash handlers. If any async code throws unhandled, log the stack so
// it can be diagnosed from the process log instead of a silent exit.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack || err);
});
process.on("unhandledRejection", (reason: any) => {
  console.error("[unhandledRejection]", reason?.stack || reason);
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        // Redacted + bounded: this line reaches the Fly log stream and any
        // drain, so it must never carry a secret and must cost O(cap), not
        // O(body) — see logRedact.ts.
        logLine += ` :: ${serializeForLog(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

// ---------------------------------------------------------------------------
// THE GATE FIRST, THEN THE PARSERS — and both below the request logger above.
//
// Registered the other way round, an anonymous caller has 50 MB — or 500 MB on
// /api/import — buffered and PARSED for them before the 401 answers: work, and
// memory pressure, done on a small machine for someone who is not logged in.
// Nothing below this line may read a request body for a caller nobody has
// identified.
//
// BELOW THE LOGGER, though, and not above it: the logger wraps res.json, so a
// gate registered ahead of it would silently stop every 401 reaching the Fly
// log stream — the one line an operator has to go on when a login is failing.
//
// /api/login is the exception that proves the rule. It needs a body to check a
// password and it must be reachable before the gate, so it carries its own
// 16 KB parser and its own parse-error guard (server/auth.ts).
// ---------------------------------------------------------------------------
installAuth(app);

// JSON/urlencoded parsing lives in bodyParsers.ts — /api/import is exempted
// from the global 50 MB limit there so a real backup can be restored.
installBodyParsers(app);

(async () => {
  // Both of the above must be installed before registerRoutes, so that the
  // gate runs first and every route below still gets a parsed body.
  await registerRoutes(httpServer, app);

  // Rolling on-disk backups of the SQLite database. Non-blocking; failures
  // are logged and never crash the boot sequence.
  try {
    startRollingBackups();
  } catch (err: any) {
    console.error("[startup] backup init failed:", err?.stack || err);
  }

  // The API error handler. It may never print the error OBJECT: body-parser
  // attaches the RAW REQUEST TEXT to a parse failure (lib/read.js), so a
  // `console.error(<label>, err)` here would print the login password verbatim
  // into the Fly log stream, and the echoed err.message would go into the 400
  // body — which the request logger above then serialises, where logRedact's
  // SECRET_KEY does not match the key "message". safeErrorFields
  // (server/bodyParsers.ts) is the one definition of what may be said about an
  // error out loud; named fields only is the durable half, because a future
  // middleware that hangs request text off a NEW field cannot re-open the leak
  // through a line that reads five known keys.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const { status, type, name, message, stack } = safeErrorFields(err);

    console.error("[api] error", { status, type, name, message, stack });

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // (8080 in the Fly image). Default to 5000 if not specified.
  // this serves both the API and the client.
  const port = parseInt(process.env.PORT || "5000", 10);

  // Explicit error listener — if the socket fails to bind (port conflict,
  // permission error, etc.) surface a hard non-zero exit so the platform
  // sees a real failure rather than a half-dead process.
  httpServer.on("error", (err: any) => {
    console.error("[server.listen] fatal error:", err?.stack || err);
    process.exit(1);
  });

  httpServer.on("listening", () => {
    log(`listening on 0.0.0.0:${port}`);
  });

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );

  // SIGTERM/SIGINT: stop accepting connections, stand the backup timer down,
  // then sqlite.close() — which checkpoints the WAL and removes data.db-wal /
  // data.db-shm. Without this the file sitting on the Fly volume is only ever
  // PART of the database, and a raw file restore swaps a snapshot in
  // underneath a stale WAL that then replays over it.
  //
  // Registered here, after listen(), for two reasons: the drain needs a
  // listening server to close, and registering at module scope would put a real
  // SIGINT handler into every vitest worker that transitively imports the
  // module. See server/shutdown.ts for what it deliberately does NOT promise.
  installShutdownHandlers(httpServer);
})().catch((err: any) => {
  // Any error during route registration / vite bootstrap / static setup
  // must crash the process loudly. A silent async failure is the most
  // likely cause of a stuck, half-alive process.
  console.error("[startup] fatal error during bootstrap:", err?.stack || err);
  process.exit(1);
});
