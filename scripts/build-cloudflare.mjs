/** Build the Cloudflare Worker locally using the normal short build command. */
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Vite's own env loading only exposes VITE_-prefixed keys to import.meta.env —
// it never writes unprefixed keys like APP_MODE back onto process.env. A
// manual `npm run build:cloudflare` run therefore silently fell back to
// "production" (vite.config.mts's default) even with APP_MODE=demo sitting
// in .env, unless the shell itself had exported it first. CI (deploy-cloudflare.yml)
// already sets these as real env vars, so this is a no-op there.
const loadEnvValues = async (path) => {
  const source = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]] = value;
  }
  return values;
};

const fileEnv = {
  ...(await loadEnvValues(resolve(".env"))),
  ...(await loadEnvValues(resolve(".env.local"))),
};

const appModeEnv = {};
for (const key of ["APP_MODE", "DEMO_MODE", "VITE_APP_MODE", "VITE_DEMO_MODE"]) {
  if (process.env[key] === undefined && fileEnv[key] !== undefined) appModeEnv[key] = fileEnv[key];
}

const build = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  // Respect an already-set NITRO_PRESET (e.g. the Dockerfile's `node-server`,
  // set via `ENV` before `RUN npm run build`) instead of always clobbering it
  // — this script previously forced "cloudflare-module" unconditionally,
  // which silently made every Docker/production build emit a Cloudflare
  // Worker bundle that `node .output/server/index.mjs` can't actually run.
  env: { ...process.env, ...appModeEnv, NITRO_PRESET: process.env.NITRO_PRESET || "cloudflare-module" },
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
