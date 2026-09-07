// -----------------------------------------------------------------------------
// Global body parsers, with ONE deliberate exemption. /api/import restores a
// whole logical backup in one request body, and a global JSON parser rejects a
// body over its limit with a 413 BEFORE the route stack ever runs — a
// route-level parser alone cannot fix that (the global one still runs first),
// so the import path is skipped here and given its own parser with its own
// limit. Limits are parameterised only so tests can exercise the exemption
// cheaply; production always uses the defaults.
//
// WHAT A BACKUP IS. GET /api/export (server/routes.ts, EXPORT_TABLES) writes
// one JSON document holding the raw rows of seven small text tables —
// settings, mcq_overrides, mcq_attempts, mcq_srs_state, mcq_srs_undo,
// mcq_srs_extra_new and mcq_study_sessions. No media, no corpus (that ships
// with the app): a few megabytes at most, even after years of use. See
// README.md, "Backups and restore".
// -----------------------------------------------------------------------------
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

export const IMPORT_PATH = "/api/import";

// The import parser's ceiling. It is a bound on the OWNER'S DATA, so it is only
// defensible as a bound Node already enforces — and it is one: body-parser
// turns the buffered body into ONE JavaScript string, and V8 caps a string at
// buffer.constants.MAX_STRING_LENGTH = 536,870,888, so a limit above that would
// ACCEPT a body and then die with an opaque RangeError deep inside the parser
// instead of a clean 413. 500 MB (524,288,000 bytes) is strictly under the cap;
// the comparison is safe in the right direction because the limit counts UTF-8
// BYTES and the cap counts UTF-16 units, and a UTF-8 decode never produces more
// units than input bytes. A backup of this app is a few megabytes, so the limit
// never shrinks what can be restored; it only makes the refusal honest and
// early.
//
// ESCAPE: IMPORT_BODY_LIMIT overrides it (an environment variable — see the
// README's table), and installBodyParsers still takes an explicit
// opts.importLimit for tests. Neither can get past V8's string cap.
export const IMPORT_LIMIT_DEFAULT = process.env.IMPORT_BODY_LIMIT ?? "500mb";

// -----------------------------------------------------------------------------
// WHAT A BODY-PARSER FAILURE MAY SAY OUT LOUD (auth-security-5).
//
// Two of body-parser's error types are made OUT OF THE REQUEST ITSELF:
//   * entity.parse.failed — lib/read.js attaches the RAW REQUEST TEXT as
//     `err.body`, and V8's SyntaxError quotes the first characters of that text
//     back in `err.message`. Measured on the installed body-parser 2.3.0: a body
//     of `SuperSecret123` yields `Unexpected token 'S', "SuperSecret123" is not
//     valid JSON`.
//   * entity.verify.failed — the same, for a rejecting verify hook.
// Every other type ("entity.too.large", "encoding.unsupported", …) is body-free
// and is exactly what an operator reads when a restore is refused, so it passes
// through untouched.
//
// The one route that carries a secret is POST /api/login, so `console.error(…,
// err)` in the API error handler printed the owner's password verbatim into the
// Fly log stream, and the echoed `err.message` went into the 400 body — which
// the request logger then serialises (server/index.ts), where logRedact's
// SECRET_KEY never matches the key "message". Both paths close here.
// -----------------------------------------------------------------------------

/** The replacement message. Says what went wrong without repeating any of it. */
const BODY_NOT_JSON = "request body is not valid JSON";

/** True for the error types whose message and `body` are made of the request. */
function isMadeOfTheRequest(err: unknown): boolean {
  const type = (err as { type?: unknown } | null)?.type;
  return type === "entity.parse.failed" || type === "entity.verify.failed";
}

/**
 * The ONLY view of an error that may reach a log line or a response body.
 * Named fields, never the error object — that is the durable half: a future
 * parser or middleware that hangs request text off a NEW field cannot re-open
 * the leak through a caller that only ever reads these five.
 */
export function safeErrorFields(err: any): {
  status: number;
  type?: string;
  name?: string;
  message: string;
  stack?: string;
} {
  const madeOfTheRequest = isMadeOfTheRequest(err);
  return {
    status: err?.status || err?.statusCode || 500,
    type: typeof err?.type === "string" ? err.type : undefined,
    name: typeof err?.name === "string" ? err.name : undefined,
    message: madeOfTheRequest ? BODY_NOT_JSON : err?.message || "Internal Server Error",
    // The stack of a parse failure is a stack THROUGH JSON.parse whose top line
    // is the leaking message; withholding it costs an operator nothing. Every
    // other error keeps it, because that is what they actually read at 3 a.m.
    stack: madeOfTheRequest ? undefined : err?.stack,
  };
}

/**
 * Answers a body-parse failure where it happens, with a body-free 400 and a
 * body-free log line.
 *
 * Installed twice on purpose: once here, after the global parsers, and once by
 * installAuth after /api/login's own parser (which runs BEFORE these, since the
 * gate must be registered first — see server/index.ts). Handling the parser's
 * own failure mode next to the parser means the password's fate does not depend
 * on an error handler a hundred lines away in another file; the handler in
 * index.ts is hardened too, and is what catches everything else.
 */
export const bodyParseErrorGuard: ErrorRequestHandler = (err, _req, res, next) => {
  if (!isMadeOfTheRequest(err)) return next(err);
  const { status, type, name, message } = safeErrorFields(err);
  console.error("[api] body parse failed", { status, type, name, message });
  if (res.headersSent) return next(err);
  res.status(status).json({ message });
};

export function installBodyParsers(
  app: Express,
  opts: { globalLimit?: string; importLimit?: string } = {},
): void {
  const globalLimit = opts.globalLimit ?? "50mb";
  const importLimit = opts.importLimit ?? IMPORT_LIMIT_DEFAULT;
  const json: RequestHandler = express.json({
    limit: globalLimit,
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  });
  app.use((req, res, next) => (req.path === IMPORT_PATH ? next() : json(req, res, next)));
  app.use(IMPORT_PATH, express.json({ limit: importLimit }));
  app.use(express.urlencoded({ extended: false, limit: globalLimit }));
  // Immediately after the parsers, so it sees THEIR failures and nothing else:
  // Express only walks forward from the layer that failed, so an error thrown
  // by a route registered later skips this and lands on index.ts's handler.
  app.use(bodyParseErrorGuard);
}
