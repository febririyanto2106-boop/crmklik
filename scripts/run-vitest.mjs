#!/usr/bin/env node
/**
 * Runs Vitest from the canonically cased working directory.
 *
 * Why this exists: on Windows a shell can hand Node a lower-case drive letter
 * — Git Bash's `/d/DEV_PROJECTS/wacrm` becomes `d:\DEV_PROJECTS\wacrm` — while
 * Node's own ESM loader normalises file URLs to the upper-case form
 * (`file:///D:/...`). Vitest's worker is loaded through Vite's module runner
 * (lower case) and the test file's `import { describe } from "vitest"` is
 * externalised to Node's loader (upper case), so the process ends up holding
 * **two copies of `@vitest/runner`**: the worker initialises one, the test
 * file calls into the other. The second copy's `runner` is still undefined, so
 * every `describe()` dies at collection time with
 *
 *     TypeError: Cannot read properties of undefined (reading 'config')
 *
 * before a single test runs. Nothing is wrong with the tests — only with how
 * the path was spelled on the way in. PowerShell and cmd hand Node the
 * canonical casing, which is why the same suite passes there.
 *
 * `fs.realpathSync.native()` returns the real on-disk spelling, so re-running
 * from it makes both halves agree whatever shell started us.
 */
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The real on-disk spelling of a path, or the path itself if it cannot be read. */
function canonical(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

const require = createRequire(import.meta.url);
// The CLI is only reachable through the package's "bin" field; vitest does not
// export the file path itself.
const manifestPath = require.resolve("vitest/package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const cliPath = path.resolve(path.dirname(manifestPath), manifest.bin.vitest);
// Resolve the CLI's own spelling too: a lower-cased require.resolve() here
// would re-introduce the same split inside the child process.
const cli = canonical(cliPath);
const args = process.argv.slice(2);

const cwd = process.cwd();
const real = canonical(cwd);

if (real === cwd) {
  // Already canonical (the normal case): no extra process, no extra startup.
  await import(pathToFileURL(cli).href);
} else {
  const child = spawn(process.execPath, [cli, ...args], { cwd: real, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
