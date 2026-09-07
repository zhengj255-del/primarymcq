import { defineConfig } from "vitest/config";
import path from "node:path";

// Server tests run in node against a throwaway SQLite DB (each test file
// imports ./testDb first, which points DB_PATH at a temp file before
// server/storage.ts opens the database). Client component tests
// (client/**/*.test.tsx) run in jsdom.
export default defineConfig({
  // The app compiles JSX with the automatic runtime (no `import React`);
  // vitest's esbuild must match or every .tsx import fails at runtime.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  test: {
    include: ["server/**/*.test.ts", "client/src/**/*.test.tsx"],
    environment: "node",
    environmentMatchGlobs: [["client/**", "jsdom"]],
    // One process per test file so the storage singleton (and its DB_PATH)
    // never leaks between files.
    pool: "forks",
    poolOptions: { forks: { singleFork: false } },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
