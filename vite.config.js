import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// package.json sets "type": "module", so __dirname does not exist here.
const rootDir = dirname(fileURLToPath(import.meta.url));

// Repo is served at https://nathanzittoun.github.io/esp32-usb-mic-control/, and that
// exact URL is the redirect URI registered with Epic. Renaming the repo breaks OAuth.
const PAGES_BASE = "/esp32-usb-mic-control/";

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
