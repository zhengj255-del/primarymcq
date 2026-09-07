import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

/**
 * Does this URL name a FILE rather than an app route? Such a request must 404
 * when the file is absent — answering with the HTML shell and a 200 hands back
 * a fake file (a download that is really index.html renamed).
 */
export function looksLikeFileRequest(url: string): boolean {
  const p = (url || "").split("?")[0].split("#")[0];
  return /\.[a-z0-9]{2,10}$/i.test(p);
}

export function serveStatic(app: Express, rootDir?: string) {
  const distPath = rootDir ?? path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Vite fingerprints everything under /assets, so those files are immutable —
  // cache them hard. index.html is the pointer to the current build, so it must
  // NEVER be cached: a stale copy pins the browser to an old bundle and the app
  // silently keeps running yesterday's code after a deploy.
  app.use(express.static(distPath, {
    index: false,
    setHeaders(res, filePath) {
      if (/[\\/]assets[\\/]/.test(filePath) && !filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }));

  // Fall through to index.html for app routes. A request that names a FILE
  // (anything with an extension) must 404 instead: serving the HTML shell with
  // a 200 hands back a fake file — e.g. a stale /assets/*.js requested
  // mid-deploy, or a missing /mcq-figures/*.svg, would come back as index.html
  // wearing the wrong name, and the browser reports a baffling parse error
  // instead of the plain 404 that says what happened.
  app.use("/{*path}", (req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    // NB: inside app.use(pattern) Express moves the matched path into
    // req.baseUrl and leaves req.path as "/", so the check MUST read
    // originalUrl — testing req.path silently matched nothing.
    //
    // An /api path that reaches this catch-all is an endpoint that does not
    // exist (mistyped, or removed in a deploy while a stale client still calls
    // it). Serving the HTML shell with a 200 here is worse than the fake-file
    // case below: apiRequest only checks res.ok, so a MUTATION to a dead
    // endpoint reported success while nothing happened server-side, and a GET
    // surfaced as "Unexpected token '<'". Answer JSON 404 like a real API.
    const urlPath = (req.originalUrl || "").split("?")[0];
    if (urlPath === "/api" || urlPath.startsWith("/api/")) {
      return res.status(404).json({ error: `no such API endpoint: ${req.method} ${urlPath}` });
    }
    if (looksLikeFileRequest(req.originalUrl)) {
      return res.status(404).type("text/plain").send("Not found");
    }
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
