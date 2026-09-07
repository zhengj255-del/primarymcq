import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, mkdir, cp } from "node:fs/promises";

// Server deps bundled into dist/index.cjs (fewer openat(2) calls at cold
// start). Everything else — better-sqlite3 above all, which is a native
// module — stays external and is installed in the runtime image.
const allowlist = [
  "express",
  "express-session",
  "memorystore",
  "nanoid",
  "zod",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // The MCQ corpus is read at runtime via __dirname — a build that skips this
  // boots into an app with no questions.
  console.log("copying server data files...");
  await mkdir("dist/data", { recursive: true });
  await cp("server/data", "dist/data", { recursive: true });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
