# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

AudioMX — voice biomarker capture and analysis, running as a **static site with no backend**. Audio comes in from one of three inputs (a MEMS device over USB serial, the same device over Wi-Fi, or the computer's own microphone), is recorded and measured in the browser, and is stored in IndexedDB. It ships to GitHub Pages.

Most of the surprising constraints in this codebase follow from "static site, no backend". Read `LIMITATIONS.md` before concluding something is a bug — it lists what the app cannot do, why, and what would unblock it. Several entries look like defects from the outside and are not.

## Commands

```bash
npm run dev          # Vite dev server on :5173 (strictPort), base "/"
npm run build        # → dist/, base "/AudioMX-WebApp/"
npm run preview      # serves dist/ on :4173 at the built base
npm run typecheck    # tsc --noEmit
npm run smoke        # the entire test suite — see below
```

### The smoke suite

`scripts/smoke.mjs` is the only test suite. There is no unit-test framework, and **no way to run a single test** — it is one linear script of ~160 assertions that boots the real app and drives it. Assertions are added inline next to the behaviour they cover.

It does not launch a browser. It attaches to an already-running Chrome over the DevTools Protocol at `http://localhost:9222/json`, so before running it you need Chrome listening on `--remote-debugging-port=9222`, with microphone capture available without a permission prompt (a fake capture device is what CI-style runs use; the exact launch flags are not recorded in the repo, so confirm them rather than assuming).

Two modes, and both are expected before a commit:

```bash
node scripts/smoke.mjs           # against the dev server on :5173
node scripts/smoke.mjs preview   # against the built output on :4173
```

Preview runs more assertions than dev — the service worker is production-only, so the offline tests only exist there. Run both: the dev/preview base-path split has broken the built artefact while dev looked perfect.

The suite reaches the app exclusively through `window.audiomx` (see `src/devtools.ts`), which is deliberately **not** stripped from the production build, so what ships is what was tested.

Assertions in this suite are written in French; the source code and its comments are in English.

## Architecture

### Layers and dependency direction

```
core/     audio, DSP, protocol, state, event bus — no UI imports
device/   the three transports; each hands samples to core/recorder
storage/  the persistence seam behind an interface
ehr/      Epic SMART-on-FHIR
rnd/      R&D bench views          } UI
ui/       shared UI + canvas       }
clinical.ts, app.ts, main.ts       } shells
```

Lower layers must not import views. Where `core/` or `storage/` needs the UI to refresh, it **emits an event** instead — `src/core/bus.ts` is a small typed bus that exists to keep that direction from inverting. Events are notification only and never carry state; the data stays in `state.ts`.

The bus is also how genuine cycles are avoided: `app.ts` emits `monitors:tick` rather than calling into `clinical.ts`, because `clinical.ts` imports the capture controls from `app.ts`.

### Shared state

`src/core/state.ts` holds app-wide mutable state as plain exported objects (`device`, `capture`, `library`, `ui`, `analysis`). Objects rather than exported `let`s because ES module bindings are read-only for importers.

It describes itself as a holding pen — state is meant to migrate down into whichever module actually owns it. Don't add to it reflexively.

### One capture path

Every transport converges on `core/recorder.ts`. `ingest()` is the single entry point for a block of audio; `ingestMemsFrame()` decodes the device's wire format and calls it. There used to be two copies of this logic and fixes kept missing one — keep it that way.

`saveCurrentRecording()` closes out a take: merge, encode WAV, extract features, file it, persist. Note that `capture.pendingMeta` is **consumed** on save, so the next take cannot silently inherit the previous patient. On a medical device a mis-attributed recording is the failure that matters most; there is an assertion for it.

### Audio thread rules

- **One `AudioContext` for the whole app** (`core/audioContext.ts`). This is a bug fix, not tidiness: on macOS a second context makes CoreAudio reconfigure the shared device and silently kills the first one's input — takes come out the right length and completely silent. The smoke suite counts contexts and fails at two.
- **Capture runs in an AudioWorklet** (`public/capture-worklet.js`), not a `ScriptProcessorNode`. A ScriptProcessor callback that arrives while the main thread is drawing a waveform is *late*, and a late block is dropped. The worklet is served from `public/` rather than imported because Vite would inline a file that small as a `data:` URI, which `addModule()` will not load. A ScriptProcessor fallback remains for browsers without AudioWorklet.
- `SAMPLE_RATE` (16 kHz, `core/constants.ts`) is assumed by the FFT axis, WAV header and durations. Sources that arrive at another rate are resampled; the browser is allowed to refuse the rate hint, so read `context.sampleRate` rather than assuming.

### Storage seam

Everything persisted goes through the `Storage` interface in `storage/types.ts`, and `storage/index.ts` picks the implementation in one line. Swapping IndexedDB for a REST adapter is meant to be that one line — don't let IndexedDB specifics leak past the adapter. `AudioRef` already models "bytes inline" vs "URL" for the same reason.

### Navigation

Five top-level containers, switched by `setAppMode()` in `app.ts`: `landing`, `home`, `device`, `rnd`, `clinical`. `landing` is the product page and replaces the whole application shell, header and nav included.

There are three switching mechanisms underneath — `setAppMode`, `showTab`, `setClinicalTab` — driven by **one** nav bar. The bar reads the DOM rather than remembering the last click, because code navigates too (a take's Analyze button, opening a patient row). Handlers are injected into `initNav()` from `main.ts` rather than imported by `nav.ts`, which would be a cycle.

### Entry points

Two HTML entry points, both declared in `vite.config.js`:

- `index.html` → `src/main.ts` — the app.
- `patient.html` → `src/patient.ts` — the patient-facing pop-out shown on a second screen.

The two windows share exactly two things: the `PatientMessage` contract and the test definitions, both in `core/protocol.ts`. Neither may import the other; the pop-out must stay loadable on its own. They communicate over BroadcastChannel and localStorage.

Everything in `main.ts` happens inside `boot()` on `DOMContentLoaded`, and that is load-bearing — the build injects the bundle in `<head>`, so evaluating at module scope runs too early. The `readyState` test is `"complete"`, not `!== "loading"`, because a deferred module already sees `"interactive"`.

### DOM access

Use `el()` / `requireEl()` / `ctx2d()` from `ui/dom.ts` — lazy and cached. Do not capture elements at module scope: that is what made the old code loadable only on `index.html`. `requireEl` is for where absence is a bug; `el` returns null for where it is a variant.

Canvas colours live in `ui/theme.ts` (`PLOT`), because a 2D context cannot read a CSS custom property. Those values mirror tokens at the top of `style.css` and must move with them. Red means capture in progress, errors and destructive actions — a signal trace is none of those, and is brand blue.

## Things that will bite you

- **The base path is coupled to Epic.** `PAGES_BASE` in `vite.config.js` must track the repo name, because the Pages URL is also the OAuth redirect URI registered with Epic. `appRoot()` in `ehr/config.ts` derives it from `location`, so *every* URL the app can be served from — localhost and Pages — must be registered on Epic verbatim. Renaming the repo breaks the Epic round trip.
- **`vite preview` runs with `command === "serve"`.** The config tests `command === "build" || isPreview` for exactly this reason; testing `command` alone served `dist` at `/` while the built HTML asked for `/AudioMX-WebApp/`.
- **Epic changes take up to an hour** to reach the sandbox, and a rejected config answers HTTP 200 with an error page carrying no error code. Probe by status, not page content.
- **`ws://` from an `https://` page is blocked silently**, which is why the Wi-Fi microphone cannot work from the published site. `device/support.ts` detects and explains this rather than hanging.
- **Web Serial is Chrome/Edge on desktop only.** Not Safari, not any iOS browser. Support verdicts are rendered as *text* next to the input, not as a `title` tooltip — there are no tooltips on an iPad, which is exactly where this bites.
- **The service worker is production-only** (`src/pwa.ts`). In dev it would serve yesterday's modules over hot reload. It deliberately does not `skipWaiting()`; see the reasoning at the top of `public/sw.js` before changing it.
- **Feature extraction must never cost a take.** It is wrapped in try/catch in `recorder.ts` — a failure there would lose audio that cannot be recorded again.
- **No risk model is connected**, and `nullRiskModel` refuses to produce a number rather than showing a placeholder. A stub score next to a real patient is a clinical hazard. Don't "helpfully" fill it in.

## Conventions

- **Comments explain why, not what** — and specifically, they record the bug that a piece of code exists to prevent. This is heavy throughout and is the house style; match it. When you remove the reason, remove the comment.
- **`LIMITATIONS.md` is live.** When something on that list stops being true, delete the entry in the same commit that fixes it.
- **Commit messages** are an imperative one-line summary of the *intent* ("Deliver the end of the take instead of dropping it"), then a body explaining the reasoning, what was ruled out, and what is proven versus merely believed. They end with a verification line in the form `typecheck + build clean, smoke 154/154 dev and 158/158 preview.`
- TypeScript is `strict`, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. `allowJs` is on with `checkJs` off.
- CI (`.github/workflows/deploy.yml`) runs `npm ci`, `typecheck`, `build` on push to `main` and deploys to Pages. It does **not** run the smoke suite — that gate is local, which is why the count goes in the commit message.
