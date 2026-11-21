/** Deploy one generated Cloudflare Worker to exactly one custom domain. */
import { readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

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

/**
 * Variables that must NOT become Worker secrets.
 *
 * - CLOUDFLARE_*  deploy-target config and API credentials. Handing a Worker a
 *   token that can redeploy itself turns one bug into account-wide access.
 * - VITE_*        inlined into the client bundle at build time; as a runtime
 *   secret they do nothing except suggest they are secret, which they aren't.
 * - the rest      CLI tooling (migrations, package registries, process config)
 *   that the running app has no use for.
 */
const SKIP_PREFIXES = ["CLOUDFLARE_", "VITE_"];
const SKIP_KEYS = new Set([
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_PROJECT_REF",
  "NPM_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NODE_ENV",
  "NITRO_PRESET",
  "PORT",
  "HOST",
]);

const splitList = (value) =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/** Binding names the build already ships as plain vars in wrangler.json. */
function buildVarNames() {
  try {
    const config = JSON.parse(readFileSync(resolve(".output/server/wrangler.json"), "utf8"));
    return new Set(Object.keys(config.vars ?? {}));
  } catch {
    // No build artifact yet (`--list-secrets` can run before a build).
    return new Set();
  }
}

/** The variables that should exist on the deployed Worker, by name. */
function selectSecrets(env, reserved = buildVarNames()) {
  const only = new Set(splitList(env.CLOUDFLARE_SECRETS_ONLY));
  const skip = new Set(splitList(env.CLOUDFLARE_SECRETS_SKIP));
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (only.size > 0) {
      if (only.has(key) && !reserved.has(key)) out[key] = value;
      continue;
    }
    if (skip.has(key) || SKIP_KEYS.has(key)) continue;
    // Already a plain var on the Worker; sending it as a secret fails the
    // whole request, taking every other secret down with it.
    if (reserved.has(key)) continue;
    if (SKIP_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    // An empty value would overwrite a good secret with nothing.
    if (value === "") continue;
    out[key] = value;
  }
  return out;
}

// Prints the names of the variables that would be uploaded, and nothing else —
// no values — so the selection can be checked before a real deploy.
if (args.includes("--list-secrets")) {
  const keys = Object.keys(selectSecrets(fileEnv)).sort();
  console.log(`${keys.length} secret(s) would be uploaded:`);
  for (const key of keys) console.log(`  ${key}`);
  process.exit(0);
}

if (args.includes("--help")) {
  console.log(`Usage:
  npm run deploy:cloudflare

Target selection (in .env or .env.local):
  CLOUDFLARE_WORKER_NAME, CLOUDFLARE_DOMAIN, CLOUDFLARE_ZONE_NAME
  Optional command-line values override the local environment.

Runtime secrets:
  After a successful deploy, every variable in .env / .env.local is uploaded to
  the Worker as an encrypted secret, so the deployed app sees the same
  configuration you run locally. Build-time and deploy-tooling variables are
  skipped (see SKIP_PREFIXES in this file).

  Variables the build ships as plain vars (APP_MODE, DEMO_MODE) are skipped too:
  Cloudflare refuses a name that is both a var and a secret.

  --list-secrets               Print the key names that would be uploaded, then exit.
  --secrets-only               Upload the secrets to the existing Worker; deploy no code.
  --no-secrets                 Deploy the code only; leave secrets untouched.
  CLOUDFLARE_SECRETS_ONLY=A,B  Upload only these keys.
  CLOUDFLARE_SECRETS_SKIP=A,B  Upload everything except these keys.`);
  process.exit(0);
}

const workerName = valueFor("--name") ?? process.env.CLOUDFLARE_WORKER_NAME ?? fileEnv.CLOUDFLARE_WORKER_NAME;
const domain = valueFor("--domain") ?? process.env.CLOUDFLARE_DOMAIN ?? fileEnv.CLOUDFLARE_DOMAIN;
const zoneName = valueFor("--zone") ?? process.env.CLOUDFLARE_ZONE_NAME ?? fileEnv.CLOUDFLARE_ZONE_NAME;

if (!workerName || !/^[a-z0-9][a-z0-9_-]*$/i.test(workerName)) {
  throw new Error("Provide a valid Worker name with --name or CLOUDFLARE_WORKER_NAME.");
}
if (!domain || !/^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.(?!-)[a-z0-9-]+)+$/i.test(domain)) {
  throw new Error("Provide a valid hostname with --domain or CLOUDFLARE_DOMAIN.");
}
if (zoneName) {
  const normalizedDomain = domain.toLowerCase();
  const normalizedZone = zoneName.toLowerCase();
  if (normalizedDomain !== normalizedZone && !normalizedDomain.endsWith(`.${normalizedZone}`)) {
    throw new Error(`Domain ${domain} is not inside zone ${zoneName}.`);
  }
}

const generatedPath = resolve(".output/server/wrangler.json");
const deployPath = resolve(".output/server/wrangler.deploy.json");
const generatedConfig = await readFile(generatedPath, "utf8").catch((error) => {
  if (error?.code === "ENOENT") {
    throw new Error("Prebuilt Cloudflare artifact not found. Run `npm run build` locally first.");
  }
  throw error;
});
const config = JSON.parse(generatedConfig);
const todayUtc = new Date().toISOString().slice(0, 10);

config.name = workerName;
config.routes = [{
  pattern: domain,
  custom_domain: true,
  ...(zoneName ? { zone_name: zoneName } : {}),
}];
config.workers_dev = true;
if (config.compatibility_date > todayUtc) config.compatibility_date = todayUtc;

await writeFile(deployPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Deploying Worker "${workerName}" to only "${domain}".`);

const wranglerArgs = ["wrangler", "deploy", "--config", deployPath];
if (args.includes("--dry-run")) wranglerArgs.push("--dry-run");


/**
 * Uploads the selected variables with `wrangler secret bulk`, which creates or
 * updates the named secrets and leaves every other secret on the Worker alone.
 * Values go in over stdin rather than a temp file so they are never written to
 * disk, and only key names are ever printed.
 */
function syncSecrets(npmCli, reserved) {
  const secrets = selectSecrets(fileEnv, reserved);
  const keys = Object.keys(secrets).sort();
  if (keys.length === 0) {
    console.log("No runtime secrets to upload.");
    return 0;
  }

  // Wrangler accepts at most 100 secrets per request.
  const CHUNK = 100;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const payload = {};
    for (const key of slice) payload[key] = secrets[key];
    // Run through npm when it launched us, and fall back to npx so
    // `--secrets-only` also works when the script is invoked with plain node.
    const run = npmCli
      ? spawnSync(
          process.execPath,
          [npmCli, "exec", "--", "wrangler", "secret", "bulk", "--name", workerName],
          { input: JSON.stringify(payload), stdio: ["pipe", "inherit", "inherit"] },
        )
      : spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "secret", "bulk", "--name", workerName], {
          input: JSON.stringify(payload),
          stdio: ["pipe", "inherit", "inherit"],
        });
    if (run.error) throw run.error;
    if (run.status !== 0) return run.status ?? 1;
  }

  console.log(`Uploaded ${keys.length} secret(s) to "${workerName}": ${keys.join(", ")}`);
  return 0;
}

const secretsOnly = args.includes("--secrets-only");

let deployStatus = 0;
if (secretsOnly) {
  // The Worker is already deployed; this re-syncs its configuration without
  // shipping the build again.
  await rm(deployPath, { force: true });
} else try {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run deployment with `npm run deploy:cloudflare`.");
  const deploy = spawnSync(process.execPath, [npmCli, "exec", "--", ...wranglerArgs], { stdio: "inherit" });
  if (deploy.error) throw deploy.error;
  deployStatus = deploy.status ?? 1;
  if (deployStatus !== 0) process.exitCode = deployStatus;
} finally {
  await rm(deployPath, { force: true });
}

// Secrets are set on the Worker, so it has to exist before they can be
// uploaded — and uploading them after a failed deploy would be pointless.
if (deployStatus === 0 && !args.includes("--dry-run") && !args.includes("--no-secrets")) {
  if (secretsOnly) console.log(`Syncing secrets only — no code deployed.`);
  const status = syncSecrets(process.env.npm_execpath, new Set(Object.keys(config.vars ?? {})));
  if (status !== 0) process.exitCode = status;
}
