import { copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodePaths = (process.env.NODE_PATH ?? "")
  .split(delimiter)
  .filter(Boolean);

await rm(resolve(root, "dist"), { recursive: true, force: true });
await rm(resolve(root, "dist-electron"), { recursive: true, force: true });
await mkdir(resolve(root, "dist/renderer"), { recursive: true });
await mkdir(resolve(root, "dist-electron/main"), { recursive: true });
await mkdir(resolve(root, "dist-electron/preload"), { recursive: true });

const shared = {
  absWorkingDir: root,
  bundle: true,
  logLevel: "info",
  nodePaths,
  sourcemap: true,
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/main/index.ts"],
    external: ["electron"],
    format: "cjs",
    outfile: "dist-electron/main/index.js",
    platform: "node",
    target: "node22",
  }),
  build({
    ...shared,
    entryPoints: ["src/preload/index.ts"],
    external: ["electron"],
    format: "cjs",
    outfile: "dist-electron/preload/index.js",
    platform: "node",
    target: "node22",
  }),
  build({
    ...shared,
    entryPoints: ["src/renderer/main.tsx"],
    format: "iife",
    jsx: "automatic",
    outfile: "dist/renderer/renderer.js",
    platform: "browser",
    target: ["chrome120"],
  }),
]);

await Promise.all([
  copyFile(
    resolve(root, "index.html"),
    resolve(root, "dist/renderer/index.html"),
  ),
  copyFile(
    resolve(root, "src/renderer/styles.css"),
    resolve(root, "dist/renderer/styles.css"),
  ),
]);
