// -----------------------------------------------------------------------------
// Build identity, so a long-lived tab can notice it's running stale code.
//
// A single-page app keeps running whatever bundle it loaded at boot — on a phone
// (especially a Home Screen web app, which has no address bar or reload button)
// that can be days old with no obvious way to refresh. The client polls
// /api/build and offers a one-tap update when this id changes.
//
// The id is derived from the built asset filenames, which Vite fingerprints by
// content — so it changes exactly when the client bundle changes, and stays
// stable across server restarts that didn't rebuild.
// -----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

let cached: string | null = null;

export function buildId(): string {
  if (cached) return cached;
  try {
    const indexPath = path.resolve(__dirname, "public", "index.html");
    const html = fs.readFileSync(indexPath, "utf-8");
    // Every fingerprinted asset the page references; content-addressed by Vite.
    const refs = Array.from(html.matchAll(/(?:src|href)\s*=\s*["']([^"']*assets\/[^"']+)["']/gi))
      .map((m) => m[1])
      .sort()
      .join("|");
    cached = createHash("sha1").update(refs || html).digest("hex").slice(0, 12);
  } catch {
    // Dev (no build on disk) — a per-process id keeps the endpoint working
    // without ever falsely prompting a reload in a running dev session.
    cached = "dev";
  }
  return cached;
}
