import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import react from "@vitejs/plugin-react";

// Keep existing deployment targets; use a standalone Node server by default.
const explicitPreset = process.env.NITRO_PRESET || (process.env.VERCEL ? "vercel" : undefined);
const nodeMiddleware = process.env.DEPLOY_TARGET === "node" || explicitPreset === "node-middleware" || explicitPreset === "node";
const preset = nodeMiddleware ? "node-middleware" : process.env.NETLIFY === "true" ? "netlify" : explicitPreset || "node-server";

export default defineConfig(({ command }) => ({
  base: process.env.PUBLIC_BASE_URL || "/",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }, dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-start"] },
  plugins: [
    tailwindcss(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      importProtection: { behavior: "error", client: { files: ["**/server/**"], specifiers: ["server-only"] } },
      server: { entry: "server", ...(nodeMiddleware ? { preset: "node-middleware" as const } : {}) },
    }),
    ...(command === "build"
      ? [
          nitro({
            preset,
            ...(preset === "netlify" ? { noExternals: ["tslib"] } : {}),
            // `wrangler deploy` replaces the Worker's `[vars]` wholesale on every
            // deploy, wiping out anything set by hand in the Cloudflare dashboard.
            // Bake the build's own APP_MODE/DEMO_MODE in here so the server-side
            // demo-mode checks (process.env, via nodejs_compat) actually see them
            // at runtime instead of silently falling back to "production".
            ...(preset === "cloudflare-module"
              ? {
                  cloudflare: {
                    wrangler: {
                      vars: {
                        APP_MODE: process.env.APP_MODE ?? "production",
                        DEMO_MODE: process.env.DEMO_MODE ?? "false",
                      },
                    },
                  },
                }
              : {}),
          }),
        ]
      : []),
    react(),
  ],
}));
