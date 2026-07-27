import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// package.json sets "type": "module", so __dirname does not exist here.
const rootDir = dirname(fileURLToPath(import.meta.url));

// Pages serves this project site at https://nathanzittoun.github.io/AudioMX-WebApp/.
// This must track the repo name: it is also the OAuth redirect URI registered with
// Epic, so renaming the repo means updating this AND the Epic app registration.
const PAGES_BASE = "/AudioMX-WebApp/";

export default defineConfig(({ command }) => ({
  base: command === "build" ? process.env.VITE_BASE ?? PAGES_BASE : "/",

  server: {
    port: 5173,
    // Epic only accepts the redirect URI it has registered. A silent fallback to
    // 5174 would make the OAuth round-trip fail with an opaque error.
    strictPort: true,
  },

  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(rootDir, "index.html"),
        patient: resolve(rootDir, "patient.html"),
      },
    },
  },
}));
