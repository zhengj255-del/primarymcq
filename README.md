# MCQ Study

A stand-alone website for working through the Kerry Brandis "Black Bank" ANZCA Primary MCQ corpus. It is the MCQ function of the study tracker it was extracted from (a separate repository) cut out into its own application so a study partner can use it on its own: separate repository, separate app, separate database, separate password, separate dependencies, separate build and deploy. Nothing here calls the tracker, and nothing in the tracker calls this.

It has **no Anki integration** and none of the tracker's other surfaces (mocks, viva, dashboard, session planner, learning-objective coverage, SAQs, the textbook index). One piece of the tracker's AI is carried across: the MCQ adjudicator and the whole-bank quality sweep built on it — the **Quality** page, the **Adjudicate / Resolve** lane on Disputes, and the **Suggest with AI** buttons in the edit dialog — for polishing the bank before handing it over. It is optional and off until an OpenAI key is set; see [AI quality sweep](#ai-quality-sweep).

## What it does

| Page | Route | What it does |
|---|---|---|
| Study | `#/` (also `#/study`) | Pick a mode, scope the questions (topics, domains, past papers, learning objectives, completion state, weak areas), sit them. A sitting survives a reload; option order is shuffled per sitting. Below the picker: coverage, streak, per-topic accuracy, recent sessions. |
| MCQs | `#/mcqs` | Browse and search the corpus; filter by topic, paper, disputed, completed; open a question; edit it (stem, options, answer, reason) or revert an edit. |
| Disputes | `#/disputes` | The corpus flags some answer keys as disputed. Disputed questions never enter a study session until they are accepted as-is, fixed (edited) or discarded here. With an AI key, **Adjudicate** asks the model for a verdict on every undecided dispute and **Resolve** accepts every confirmed key and applies every adjudicated answer change; ambiguous and flawed verdicts stay for you. |
| Quality | `#/quality` | The AI sweep over the whole bank (or one topic), then a review queue by band — Poor (wrong or missing key, or unsalvageable), Weak (ambiguous), Good (key confirmed), Handled. Apply a suggestion, fix by hand, discard the question, or dismiss the verdict; *Approve all* applies every applicable Poor/Weak fix in one action. Needs `OPENAI_API_KEY`; stored verdicts can be reviewed and applied without it. |
| Settings | `#/settings` | Spaced-repetition parameters, reset progress, sign out. |

Study modes:

- **Test** — exam-style, no feedback until you finish; optional time limit. A finished Test sitting shows under Recent sessions with its score.
- **Tutor** — immediate feedback: answer and reason after each question.
- **Spaced review** — FSRS-6 scheduling with an Anki-style day model: three lanes served in order (learning, review, new), a daily new-question limit and a daily review limit (both in Settings), "more new" top-ups (at most 500 extra per day), and undo of the last rating. "Today" is the Melbourne calendar day.

## AI quality sweep

Optional. The tracker's MCQ adjudicator, carried across so the bank can be polished before it is handed over. A reasoning model (OpenAI, `gpt-5.6-sol` by default) works each question from first principles — ignoring the stored key until it has its own answer — and returns one of four verdicts: **confirm_key**, **change_answer** (a different key, or a key for a question that has none), **ambiguous** (more than one defensible answer as written), **flawed** (unsalvageable as written), with a corrected explanation and, when the question itself is broken, a rewritten stem or option set. Verdicts are stored in `mcq_audit`; applied fixes are written to `mcq_overrides`, the same place your own edits live, so every consumer (study pools, spaced review, stats, the backup) sees them without new plumbing.

Three places use it:

- **Quality** (`#/quality`) — the whole-bank sweep. Pick the whole corpus or one topic and press *Audit N unassessed*; verdicts stream in and the page polls while the run lasts. Then work the bands: *Apply suggestion* writes the fix; *Fix…* opens the editor pre-filled with the suggestion for a hand edit (saving marks the verdict handled); *Discard* drops the question from study rotation, exactly as the Disputes page's Discard does; *Dismiss verdict* leaves the question as it is. *Approve all N* applies every applicable fix in the Poor and Weak bands in one action, behind a second click. Good-band rows are never swept, even when they carry a tidied stem — rewriting a past-paper question the audit just called sound is a per-row decision.
- **Disputes** — *Adjudicate N undecided* runs the same sweep over the pending disputes only, with the dispute framing (someone really has flagged them); *Resolve N adjudicated* accepts every confirmed key and applies every adjudicated answer change through the one apply path. Ambiguous and flawed verdicts always stay in your queue.
- **The edit dialog** (MCQs, Disputes, Quality, the Study runner) — *Suggest with AI* asks for one verdict and pre-fills every field with it; *Suggest with max effort* is the same call at the model's top reasoning rung, slower and dearer, for a question the cheap pass got wrong. Nothing is written until you press Save.

Things worth knowing:

- **Verdicts are keyed to content.** Each verdict stores a hash of the question's effective stem, options, answer and explanation. Edit the question by hand and the verdict goes stale: it drops out of the bands, its Apply button disappears (a direct request is refused with a 409), and the question re-enters the pending pool for the next sweep. A stale verdict can never overwrite a newer hand edit, and an ambiguous or flawed verdict is never applied — its repair text, if any, is offered only through *Fix…*.
- **Applying a key change re-grades history.** The same rule as a hand edit: earlier attempts are re-derived against the new key and the question's spaced-repetition schedule resets to relearn now.
- **No textbook grounding.** In the tracker the adjudicator read passages retrieved from the prescribed texts; that index is not part of this site. Verdicts here come from the model's own knowledge, and the prompt tells it not to invent citations. Read anything before you apply it, and use *Suggest with max effort* on anything that matters.
- **Cost and time.** One model call per question, three in flight at once; a whole-bank sweep is roughly 1,850 calls. Expect a few hours and a few dollars at the default effort. The run lives in the server process, so you can leave the page. A redeploy or restart ends the run, but every verdict already stored stays and *Audit N unassessed* resumes from where it stopped; five consecutive failures (a dead key, an unknown model) abort the run with the error shown on the page.
- **Setup.** `fly secrets set OPENAI_API_KEY='sk-...' --app <name>` (or `OPENAI_API_KEY=` in `.env` locally). `MCQ_AI_MODEL` picks another model; `OPENAI_BASE_URL` points at a compatible endpoint. Without a key the Quality page says AI is off, the AI buttons are disabled or refuse with a clear message, and everything else about the site is unchanged. Remove the secret when the polishing is done and the site is back to a plain study tool.
- **Backups carry the verdicts.** `mcq_audit` is in the JSON export, so a restore brings the ledger back along with the fixes themselves.

## Running locally

Node 20 (the Dockerfile uses `node:20-slim`). `better-sqlite3` compiles a native module, so a C++ toolchain and Python must be present (Xcode command-line tools on macOS; `python3 make g++` on Debian/Ubuntu).

```sh
npm install
npm run dev          # http://localhost:5000 — Express + Vite with hot reload
```

| Command | What it does |
|---|---|
| `npm run dev` | Starts the server with `tsx` and serves the client through Vite (development mode). Vite's own errors (a refused `/@fs` request, a transform error) are logged, not fatal. |
| `npm run check` | `tsc` type-check of `server/`, `shared/` and `client/src` (test files excluded). |
| `npm test` | `vitest run` — server tests in node, each file against its own throw-away SQLite file; client tests in jsdom. |
| `npm run build` | Vite build of the client to `dist/public`, esbuild bundle of the server to `dist/index.cjs`, corpus copied to `dist/data/mcqs.json`. |
| `NODE_ENV=production node dist/index.cjs` | Runs the production build (same as `npm start`). Listens on `PORT`, default 5000. Run it from the repository root so `dist/` is found. |

Configuration comes from the environment; `server/index.ts` loads a `.env` file if one exists. Copy `.env.example` to `.env` to start — every value in it is optional locally. With `APP_PASSWORD` unset the login gate is **off**: right for development and tests, wrong for anything reachable from the internet (the server prints a warning at boot in that case).

The database is created on first start at `DB_PATH` (default `./data.db` in the working directory, WAL mode, so `data.db-wal` and `data.db-shm` appear beside it). Delete those three files to start over; the corpus is re-ingested from `server/data/mcqs.json` on the next boot.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `APP_PASSWORD` | unset | The site's one password. When set, every `/api` route except `/api/healthz`, `/api/build` and the auth endpoints (`/api/auth/status`, `/api/login`, `/api/logout`) requires the session cookie that `POST /api/login` issues. Five wrong passwords from one client address lock that client out of login for 30 s (other clients are unaffected). The cookie lasts 30 days, but sessions are held in memory, so a redeploy or restart — or a machine that stops when idle, see `fly.toml` below — signs everyone out. When **unset** the gate is open to anyone who can reach the port. |
| `SESSION_SECRET` | derived from `APP_PASSWORD` | Cookie-signing secret. Only set it if you want one that is not derived from the password. |
| `DB_PATH` | `data.db` | Path of the SQLite database. The Fly image sets `/data/data.db` (the volume). Rolling backups go to a `backups/` directory beside this file. |
| `PORT` | `5000` | TCP port to listen on. The Fly image sets `8080`, which is what `internal_port` in `fly.toml` expects. |
| `NODE_ENV` | — | `production` serves the built client from `dist/public`; anything else runs Vite in middleware mode. |
| `IMPORT_BODY_LIMIT` | `500mb` | Ceiling on the body of `POST /api/import` (the restore). A backup of this app is a few megabytes, so the default is never the limiting factor; it exists so the refusal of an absurd body is a clean 413 rather than a crash inside the parser. |
| `OPENAI_API_KEY` | unset | Turns the AI quality sweep on (see above). Read at call time, never sent to the browser. When **unset**, `POST /api/mcqs/audit/run`, `POST /api/mcqs/triage/adjudicate` and `POST /api/mcqs/:id/triage-suggest` answer 503 and the pages say the AI is off. |
| `MCQ_AI_MODEL` | `gpt-5.6-sol` | The adjudicator model. Any chat-completions model id; reasoning-class ids (`gpt-5*`, `gpt-6*`, o-series) get `max_completion_tokens` and a `reasoning_effort`, classic ids get `max_tokens`. |
| `OPENAI_BASE_URL` | `https://api.openai.com` | An OpenAI-compatible base for a proxy or another provider. |
| `LLM_TIMEOUT_MS` | `600000` | Wall-clock cap on one model call (10 min). A dropped connection becomes a retried timeout instead of a run frozen forever. |

The day model ("today", streaks, daily limits) is the Melbourne calendar, fixed as the constant `APP_TZ` in `server/dates.ts`; it is not read from the environment. To change the timezone, change that constant.

## Deploying as its own Fly app

This is a separate Fly app from the tracker — its own name, volume and secrets. One-time setup, from the repository root:

```sh
fly apps create <name>                                          # then set app = '<name>' in fly.toml (it ships as 'primarymcq')
fly volumes create mcq_data --region syd --size 1 --app <name>  # mounted at /data; holds data.db and backups/
fly secrets set APP_PASSWORD='...' --app <name>                 # OPTIONAL — skip it to leave the site open to anyone with the URL
fly secrets set OPENAI_API_KEY='sk-...' --app <name>            # OPTIONAL — the AI quality sweep; unset it again when the polishing is done
fly deploy --remote-only --wait-timeout 600                     # builds the Dockerfile on Fly's builders, rolls out
```

Afterwards `fly deploy` from the repository root is the whole release process, or let GitHub Actions do it (below). `fly logs --app <name>` for the server log, `fly open --app <name>` for the site.

Things `fly.toml` decides:

- The machine is kept running (`auto_stop_machines = 'off'`, `min_machines_running = 1`), as the tracker's is. Sessions live in memory, so a machine that stopped when idle would sign the user out after every quiet spell despite the 30-day cookie. If re-typing the password after each break is acceptable, `auto_stop_machines = 'stop'` and `min_machines_running = 0` is cheaper; the first request after a pause then takes a few seconds while the machine wakes.
- The health check is `GET /api/healthz`, which is open without a password.
- `kill_signal = 'SIGTERM'` and `kill_timeout = '30s'` give the server time to close SQLite cleanly (checkpoint the WAL) on every deploy. They are top-level keys and must stay above the first `[...]` header — placed after a table header flyctl silently drops them.
- 1 shared CPU, 512 MB. The database is a few megabytes; 1 GB of volume is plenty.

### Its own URL

The site is reached at a different address from the tracker, because it is a different Fly app:

- **Default hostname.** Every Fly app gets `https://<name>.fly.dev`, so the app name you choose in `fly apps create <name>` (and in `fly.toml`) *is* the URL — `primarymcq` gives `https://primarymcq.fly.dev`. App names are global across Fly, so if the one you want is taken `fly apps create` says so; pick another and set it in `fly.toml`. Nothing about the tracker's hostname changes.
- **Custom domain (optional).** From the repository root: `fly certs add mcq.example.com --app <name>`, then at your DNS provider add a `CNAME` for `mcq.example.com` pointing at `<name>.fly.dev` (or the `A`/`AAAA` records that `fly ips list --app <name>` prints). `fly certs check mcq.example.com --app <name>` reports when the certificate has been issued, usually within minutes. `force_https = true` in `fly.toml` already redirects plain HTTP.
- **Sharing it.** Give your study partner the URL. If you set an `APP_PASSWORD`, give them that too; it unlocks only this site and nothing else. Without one the site is open to anyone who has the address — they can study, edit questions and reset progress — which is the intended setup for a single trusted partner.

### GitHub Actions

`.github/workflows/deploy.yml` ("Deploy") runs `npm ci`, `npm run check` and `npm test` on every push and pull request. On a push to `main`/`master`, or a manual run, it then runs `flyctl deploy --remote-only`. It needs:

- the Fly app from the steps above to exist — otherwise the deploy job fails. The volume is created on the first deploy if it is missing; the password is optional (the job prints a warning when the app has none and continues, and sets one automatically if a repository secret named `MCQ_APP_PASSWORD` exists);
- a repository secret `FLY_API_TOKEN` that is allowed to deploy this app: GitHub → Settings → Secrets and variables → Actions → New repository secret. Make a token with `fly tokens create deploy --app <name>` (scoped to this app only) or use a personal token from `fly tokens create org`.

## Backups and restore

1. **Rolling copies on the volume.** At boot and every 24 h the server copies the live database (SQLite online-backup API, safe alongside writes) to `<directory of DB_PATH>/backups/YYYY-MM-DD.db` — `/data/backups/` on Fly. The newest three dated files are kept. A run that would not leave twice the database's size free on the volume prunes older copies first and, if still short, skips with an error in the log rather than fill the volume. These copies survive redeploys but not the loss of the volume.
2. **JSON export** — `GET /api/export`; there is no button for it in the app, so open `https://<name>.fly.dev/api/export` in a browser that is signed in (the file downloads) or fetch it with `curl` and the session cookie. One JSON document, `{ version: 1, exportedAt, app: "mcq-site", tables: {...} }`, with the raw rows (snake_case columns) of `settings`, `mcq_overrides`, `mcq_attempts`, `mcq_srs_state`, `mcq_srs_undo`, `mcq_srs_extra_new`, `mcq_study_sessions` and `mcq_audit` (the AI sweep's verdict ledger). The corpus is not in it — that is code (`server/data/mcqs.json`), not data. Download one before a restore, a corpus refresh or a progress reset, and keep it somewhere other than the volume.
3. **Restore** — `POST /api/import?confirm=YES` with the export as the JSON body; there is no button for it in the app either, so this is a `curl` from a machine you trust, e.g. `curl -b cookies.txt -H 'Content-Type: application/json' --data-binary @mcq-backup-2026-09-07.json 'https://<name>.fly.dev/api/import?confirm=YES'` after logging in with `curl -c cookies.txt -H 'Content-Type: application/json' -d '{"password":"..."}' https://<name>.fly.dev/api/login`. Every table present in the file is wiped and reloaded in one transaction (all or nothing); tables absent from the file are left alone; the settings row keeps id 1. A file that is not an export of this app (wrong `app` tag, wrong `version`, unknown tables) is refused with a 400 and nothing changes — the tracker's export cannot be imported here, nor this one there.

The dated `.db` copies are ordinary SQLite files: `fly sftp get /data/backups/<date>.db --app <name>` downloads one. To put one back you would stop the machine, replace `/data/data.db` (and delete any `data.db-wal` / `data.db-shm` beside it), and start it again — the JSON route above is the one to reach for first.

## Separation guarantees

- **Own app.** `fly.toml` names its own Fly app and volume (`mcq_data`) and its own secret. Nothing reads the tracker's app, volume or secrets.
- **Own database.** `DB_PATH` is this app's SQLite file with its own schema: `settings`, `mcqs`, `mcq_lo_links`, `mcq_overrides`, `mcq_meta`, `mcq_attempts`, `mcq_srs_state`, `mcq_srs_undo`, `mcq_srs_extra_new`, `mcq_study_sessions`, `mcq_audit`. No table is shared with the tracker and no data moves between the two.
- **Own password.** `APP_PASSWORD` here is unrelated to the tracker's. The only other secret is the optional `OPENAI_API_KEY`, which the server uses and never sends to the browser.
- **Own dependencies and build.** `package.json`, `package-lock.json` and `node_modules` live in this repository; `npm run build` bundles only files in it; the Dockerfile's build context is this repository alone. No ORM, no model SDK (the AI client is one file over global `fetch`), no websocket library.
- **Self-contained.** `server/__tests__/standalone.test.ts` fails `npm test` if a file under `server/`, `shared/` or `client/src` — or any of the root-level config, deploy and docs files — names any of the tracker-only machinery (its generated-question layer, its textbook index, its Anki bridge, its viva corpus), if any relative path climbs out of the repository, if `package.json` lists a model SDK, or if anything but `server/ai/llm.ts` talks to the model API.
- **Outbound traffic: the model API only, and only when asked.** With `OPENAI_API_KEY` unset the server makes no network requests of its own. With it set, the only outbound calls are to `OPENAI_BASE_URL` (chat completions), made while a sweep runs or a suggestion is requested; the question's text goes out, nothing else does.

## API

JSON throughout. The first five routes are open; everything else needs the session cookie when `APP_PASSWORD` is set. Literal `/api/mcqs/...` paths are registered before the `/api/mcqs/:id` wildcard.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/healthz` | `{ok:true}` — Fly health check |
| GET | `/api/build` | `{buildId}` — the client polls it to offer a reload after a deploy |
| GET | `/api/auth/status` | `{required, authed}` |
| POST | `/api/login` | `{password}` → `{ok, authed}`; 401 `wrong_password`, 429 `too_many_attempts` |
| POST | `/api/logout` | destroys the session |
| GET | `/api/settings` | `Settings` |
| PATCH | `/api/settings` | partial `{srsRetention, srsFuzz, srsNewPerDay, srsMaxReviewsPerDay}` → `Settings`; 400 `{error}` on a bad field |
| GET | `/api/mcqs` | query `topic, domain, paper, q, disputed, completed, unmastered, limit, offset` → `{total, items}` |
| GET | `/api/mcqs/stats` | corpus totals, per-topic counts, per-paper sittable counts |
| GET | `/api/mcqs/by-lo/:code` | `{code, items}` — questions linked to a learning objective |
| POST | `/api/mcqs/session` | session filters (`mode: test\|tutor\|srs`, scope, `count`, `timeLimitSec`) → `{sessionId, mode, mcqs, timeLimitSec}` |
| POST | `/api/mcqs/attempt` | `{mcqId, sessionId?, mode, selected, timeMs}` → `{correct, correctAnswer, reason, srsPreview?}` |
| POST | `/api/mcqs/srs/rate` | `{mcqId, rating, sessionId?}` → `{srs}` |
| POST | `/api/mcqs/session/:id/finish` | `SessionSummary`; 404 unknown session |
| GET | `/api/mcqs/session/:id/summary` | `SessionSummary` |
| POST | `/api/mcqs/reset?confirm=YES` | wipes attempts, SRS state and sessions → `{ok, deletedAttempts, deletedSrsState, deletedSessions}`; 400 without `confirm=YES` |
| GET | `/api/mcqs/user-stats` | coverage, streak, per-topic accuracy, recent sessions |
| GET | `/api/mcqs/srs/due?limit` | `{items}` |
| POST | `/api/mcqs/srs/undo` | undo the last rating; 404 when there is nothing to undo |
| POST / DELETE | `/api/mcqs/srs/extra-new` | `{count}` adds to today's new allowance; DELETE clears it → `{day, extraNew}` |
| GET | `/api/mcqs/srs/queue-stats?topics=&domains=&loCodes=&skipNew=1` | lane counts for the scope (disputed questions always excluded) |
| GET | `/api/mcqs/weak-areas` | `{items}` — lowest-accuracy topics |
| GET | `/api/mcqs/triage` | `{counts: {pending, accepted, fixed, discarded, total}, items, adjudications}` — `adjudications` maps a disputed id to its fresh AI verdict (`{verdict, suggestedAnswer, applicable, stale}`) |
| POST | `/api/mcqs/triage/adjudicate` | `{topic?}` → `{kicked}` — the AI sweep over the pending disputes only; 503 without a key, 409 while a run is in progress |
| POST | `/api/mcqs/triage/resolve-all` | `{topic?}` → `{accepted, fixed, left, unadjudicated, failed}`; 409 while a run is in progress |
| POST | `/api/mcqs/:id/triage` | `{action: accept\|fix\|discard\|reopen, edit?}` → the question with `triageStatus` |
| POST | `/api/mcqs/:id/triage-suggest?mode=&effort=` | one AI adjudication, returned, nothing written. `mode=audit` for the verification framing (default: dispute); `effort` one of `low\|medium\|high\|xhigh\|max` (400 otherwise). 503 without a key, 502 on a model failure |
| GET | `/api/mcqs/audit/status?topic=` | `{running, progress, pending, total, counts: {poor, weak, good, handled, applicable}, lastError, keyPresent, model}` |
| GET | `/api/mcqs/audit?band=&topic=&limit=` | `{items: [{mcq, audit, applicable, stale}], total}` — `band` one of `poor\|weak\|good\|handled` |
| POST | `/api/mcqs/audit/run` | `{topic?}` → `{kicked}`; 503 without a key, 409 while a run is in progress |
| POST | `/api/mcqs/audit/stop` | `{stopping}` — honoured between batches |
| POST | `/api/mcqs/audit/apply-all` | `{topic?}` → `{applied, skipped, failed}` — the Poor/Weak applicable pile; 409 while a run is in progress |
| POST | `/api/mcqs/:id/audit-apply` | applies the stored suggestion → `{mcq, audit}`; 404 no verdict, 409 already handled / stale / nothing to apply / would blank the keyed option |
| POST | `/api/mcqs/:id/audit-mark-fixed` | after a hand edit: `{audit}` re-hashed and marked applied |
| POST | `/api/mcqs/:id/audit-dismiss`, `/audit-reopen` | `{audit}` |
| GET | `/api/mcqs/:id` | one question; 404 |
| PATCH | `/api/mcqs/:id` | edit (override) stem / options / answer / reason / disputed |
| DELETE | `/api/mcqs/:id/override` | revert to the corpus text |
| GET | `/api/export` | the JSON backup (attachment `mcq-backup-<date>.json`) |
| POST | `/api/import?confirm=YES` | body = an export → `{ok, restored: {table: rows}}`; 400 without `confirm=YES` or on a file that is not this app's export |

Types for the request and response shapes are in `shared/schema.ts`.

## The corpus

`server/data/mcqs.json` (1853 questions) is a **copy** of the tracker's `server/data/mcqs.json`, taken on 2026-09-06. To refresh it, copy the tracker's file over this repository's `server/data/mcqs.json` and push; the deploy workflow does the rest. At boot the server hashes the file; when the hash differs from the one stored in `mcq_meta` it wipes and re-ingests `mcqs` and `mcq_lo_links` (learning-objective links are re-derived). Everything keyed by question id — edits in `mcq_overrides`, attempts, SRS state, sessions — is untouched, so progress survives a refresh as long as question ids stay stable. `client/public/mcq-figures/*.svg` are the figures some questions reference; copy new ones across too if the corpus gains any.

## Layout

```
.
  client/            React 18 + wouter + TanStack Query, Tailwind, shadcn components
    src/pages/       Study, MCQs, Disputes, Quality, Settings, not-found
    public/          favicon, mcq-figures/
  server/            Express 5 + better-sqlite3
    index.ts         entry: logger, auth, body parsers, routes, backups, static/Vite, shutdown
    auth.ts          APP_PASSWORD gate and session cookie
    routes.ts        the API above, incl. export/import
    storage.ts       database open + schema bootstrap + settings
    mcqs.ts          corpus ingest, queries, edits, dispute triage
    mcqAudit.ts      the AI quality sweep: verdict ledger, bands, apply / dismiss, bulk approve, bulk dispute resolution
    ai/config.ts     OPENAI_API_KEY, MCQ_AI_MODEL, OPENAI_BASE_URL (read at call time)
    ai/llm.ts        chat-completions client over global fetch: retries, effort step-down, truncation retry
    ai/mcqTriage.ts  the adjudicator: dispute / audit prompts, JSON contract, response validation
    mcqStudy.ts      sessions, attempts, FSRS-6 scheduling, lanes, undo, stats
    mcqSittable.ts   the single "may this question be served" predicate
    backups.ts       rolling on-volume copies
    dates.ts         the Melbourne calendar
    data/mcqs.json   the corpus
    __tests__/       vitest (server)
  shared/schema.ts   types and zod schemas shared by client and server
  script/build.ts    production build
  .github/workflows/deploy.yml  test + deploy
  Dockerfile, fly.toml, .env.example
```
