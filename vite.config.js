import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// package.json sets "type": "module", so __dirname does not exist here.
const rootDir = dirname(fileURLToPath(import.meta.url));

// Pages serves this project site at https://nathanzittoun.github.io/AudioMX-WebApp/.
// This must track the repo name: it is also the OAuth redirect URI registered with
// Epic, so renaming the repo means updating this AND the Epic app registration.
const PAGES_BASE = "/AudioMX-WebApp/";

export default defineConfig(({ command, isPreview }) => ({
  // `vite preview` runs with command === "serve", so testing command alone
  // served dist at "/" while the built HTML asked for /AudioMX-WebApp/ —
  // every request fell through to index.html and the page loaded nothing.
  // Preview has to use the same base the build baked in, or it cannot verify
  // the artefact that actually ships.
  base: command === "build" || isPreview ? process.env.VITE_BASE ?? PAGES_BASE : "/",

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
        // Three pages, three audiences. index.html is the product site,
        // app.html the clinical tool, patient.html the second display.
        main: resolve(rootDir, "index.html"),
        app: resolve(rootDir, "app.html"),
        patient: resolve(rootDir, "patient.html"),
      },
    },
  },
}));
