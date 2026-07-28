# Known limitations

What AudioMX cannot do today, why, and what would unblock it. This is the
running list — when something here stops being true, delete it in the same
commit that fixes it.

Each entry says what the limit *is*, what actually causes it, and what removes
it. Several of these look like bugs from the outside and are not: they are
consequences of being a static site with no backend.

| # | Limitation | Blocks | Removed by |
|---|---|---|---|
| 1 | Data never leaves the browser it was recorded in | Multi-clinician use, multi-site studies | Backend |
| 2 | Not HIPAA-ready | Any real patient data | BAA + backend |
| 3 | Wi-Fi microphone unusable from the published site | Wireless capture outside localhost | Firmware + backend |
| 4 | USB is Chrome/Edge on a computer only | USB capture on iPad or Safari | Nothing — it is a platform fact |
| 5 | iOS runs a reduced app | Full parity on iPad | Partly nothing, partly backend |
| 6 | Epic is sandbox-only, not a real organisation | Real charts | Epic go-live |
| 7 | No risk model connected | Every clinical claim the product makes | Dr Rameau's model + backend |
| 8 | Capture assumptions are not enforced | Cross-device comparability | Calibration work |

---

## 1. Data never leaves the browser it was recorded in

**What.** Patients, sessions and audio live in IndexedDB, in one browser
profile, on one machine. There is no account, no sync, no sharing. Clearing
site data, using a different browser, or using a different computer means
starting from zero. Two clinicians cannot see the same patient. "Export" means
a file the clinician downloads and moves by hand.

**Why.** There is no backend. The app is a static bundle on GitHub Pages;
IndexedDB is the only storage a static page has.

**Removed by.** A backend with real storage. The seam already exists: every
call site talks to the `Storage` interface, and
[src/storage/index.ts](src/storage/index.ts) picks the implementation in one
line. Swapping IndexedDB for a REST adapter does not touch the clinical flow.

## 2. Not HIPAA-ready

**What.** No real patient data may enter the system as it stands — not in the
browser, and not in any free-tier database we build against.

**Why.** Several things are missing at once, and all of them are required:

- No signed BAA with any processor. Free tiers do not come with one; a BAA
  needs a paid plan or a self-hosted deployment. Check current pricing before
  committing — it is a real line item, not a checkbox.
- No audit log. Who opened which chart, and when, is not recorded anywhere.
- No encryption at rest beyond whatever the OS gives the browser profile.
- No access control. Anyone with the machine has every patient on it.
- Epic tokens are handled in the browser. This is deliberate and documented in
  [src/ehr/smart.ts](src/ehr/smart.ts): PKCE with an in-memory token is the
  correct shape for a static site, and it is still not what PHI requires.

**Decision in force.** Build on a free tier with **synthetic data only**. Move
to an environment under BAA on the day a real patient enters the system — not
before, because it costs money, and not after, because that would be a breach.
The architecture does not change between the two; only the project does.

**Removed by.** BAA, audit logging, encryption at rest, authentication, and
moving token handling server-side.

## 3. The Wi-Fi microphone cannot work from the published site

**What.** Wi-Fi capture works from `http://localhost` and nowhere else. From
`https://nathanzittoun.github.io/AudioMX-WebApp/` the device is unreachable.

**Why.** Two separate problems stacked:

1. **Mixed content.** The ESP32 serves `ws://192.168.4.1:81`. A page loaded
   over https is forbidden from opening an unencrypted WebSocket, and the
   failure is silent — the socket simply never opens, which looks exactly like
   a dead device. A bare LAN address cannot hold a TLS certificate, so the
   device cannot simply be upgraded to `wss://` in place. The app detects this
   and explains it rather than hanging; see `wifiSupport()` in
   [src/device/support.ts](src/device/support.ts).
2. **The device is an access point.** The firmware runs
   `WiFi.mode(WIFI_AP)` + `softAP` (`ESP32_Microcontroller.ino:118`), so the
   laptop has to *leave its own network* to reach the microphone. While
   connected to the device there is no internet, which also means no Epic.

**Removed by.** Firmware change plus backend: the ESP32 joins the existing
network in station mode and pushes audio out to the backend over `wss://`, and
the app reads from the backend instead of talking to the device directly. This
fixes both problems at once and is the reason the firmware work is sequenced
after the backend.

## 4. USB is Chrome or Edge on a computer only

**What.** The MEMS device over USB-C requires Web Serial. That is Chrome and
Edge on desktop. Safari does not implement it, and no browser on iOS or iPadOS
does — including Chrome on iOS, which is Safari underneath.

**Why.** Apple has not implemented Web Serial and has given no indication it
will. This is a platform fact, not a gap in the app.

**Removed by.** Nothing, on the web. The app degrades honestly: `serialSupport()`
in [src/device/support.ts](src/device/support.ts) reports the reason in words a
clinician can act on, and the UI marks the input unusable before it is reached
for. Since the Device page exists, that reason is also **printed as text** next
to the input rather than hidden in a tooltip — there is no tooltip on an iPad,
which is exactly where this limitation bites. A native app would be the only
way, and it is not worth it for one input.

## 5. iOS runs a reduced app

**What.** The app installs to the home screen and works offline, but an iPad is
not equivalent to a laptop.

**Why, item by item:**

- **No USB.** See limitation 4.
- **No Wi-Fi device.** See limitation 3. On iOS this leaves the device
  microphone as the only working input.
- **The patient pop-out may not open.** A standalone home-screen app has no
  second window to give, so `window.open` returns null. The app now says so and
  gives the address to open by hand; the patient screen follows the session
  over BroadcastChannel and localStorage, so a manually opened window still
  works. It is a worse workflow, not a broken one.
- **Epic login from a home-screen app is untested.** The PKCE verifier lives in
  `sessionStorage` during the round trip. If iOS runs the Epic login in a
  separate browsing context, the app may come back to a different
  `sessionStorage` and fail the exchange. **This needs testing on a real iPad
  before anyone relies on it** — do not assume either outcome.
- **Sample rate.** Safari may refuse a 16 kHz `AudioContext` and give its own
  rate instead. Handled: [src/core/audioContext.ts](src/core/audioContext.ts)
  falls back and the capture path resamples, so this is a note, not a defect.

## 6. Epic is a sandbox, not a real organisation

**What.** The Epic connection reaches Epic's public R4 **sandbox**, not a real
organisation. The app registration is "AudioMX Clinician", audience **Clinicians
or Administrative Users**, still in **Draft/Test** state.

**Why.** Going beyond the sandbox is an Epic go-live process with a real
organisation, not a code task. Until then only the Non-Production Client ID
works; the production ID exists but authenticates against nothing.

**Settled, 2026-07-27: the standalone launch does establish patient context.**
This was an open question, because Epic's standalone-launch documentation
describes patient context as an EHR-launch property and does not mention a
picker for provider apps. Tested against the sandbox: after the clinician logs
in, Epic presents its own "Search for a Patient" dialog (name/MRN, SSN, birth
date, plus a Recent Patients tab) and the chosen patient comes back in the
token. `launch/patient` is doing its job. **Supporting EHR launch is therefore
not required**, and the absence of a picker in the docs was not evidence of its
absence in the product.

**Note on testing any Epic change.** Epic documents **up to one hour** for a
saved change to reach the sandbox. Probe the authorize endpoint by HTTP status,
not by page content: a working config answers 302 to a login URL, a rejected
one answers 200 with an "OAuth2 Error" page carrying no error code. Judging on
the page alone reads success as failure.

**Also true today:**

- Epic rejects custom Observations, so the write path is DocumentReference
  only. Reading Patient and Observation is what proves the connection.
- Every redirect URI the app can produce must be registered on Epic verbatim.
  `appRoot()` in [src/ehr/config.ts](src/ehr/config.ts) derives it from
  `location`, so both the localhost dev URL and the Pages URL need registering.
- Renaming the repository changes the Pages URL and therefore breaks the Epic
  round trip. `PAGES_BASE` in [vite.config.js](vite.config.js) and the Epic
  registration have to move together.

**Removed by.** An Epic go-live with a real organisation, plus confirming the
launch flow above. The Client ID and scopes are environment-overridable in
[src/ehr/config.ts](src/ehr/config.ts), so moving between registrations is a
value change rather than a code change.

## 7. No risk model is connected

**What.** The app records, measures and exports. It does not score anything.
Every acoustic number it shows — F0, HNR, jitter, shimmer — is computed in the
browser and is a signal measurement, not a clinical result.

**Why.** Dr Rameau's model is Python. It will never run in a browser.

**Removed by.** A scoring service behind the backend. The interface is already
written: [src/storage/riskModel.ts](src/storage/riskModel.ts), and the chart now
asks it rather than describing it — [src/ui/riskPanel.ts](src/ui/riskPanel.ts)
renders "not connected" from `isAvailable()` returning false, and renders a real
result the moment a model is installed through `setRiskModel()`. Until then
`nullRiskModel` reports itself unavailable and refuses to produce a number,
deliberately — a placeholder score displayed next to a real patient is a
clinical hazard, not a harmless stub.

## 8. Capture assumptions are not enforced

**What.** Takes from different devices, rooms or sessions are not guaranteed
comparable, and nothing in the app says so.

**Why.** Distance to the microphone, room noise, gain and input device all
change the numbers, and none of them is recorded, calibrated or constrained.
The quality gate catches gross problems — clipping above 0.5%, a peak hotter
than −1 dBFS, an RMS below −55 dBFS — but that is a floor on signal level, not
calibration, and it says nothing about whether two takes can be compared. The
R&D mode exists to characterise microphones precisely because this is unsolved.

**Removed by.** A calibration step and recorded capture conditions, plus
whatever the model turns out to require. Worth settling with Dr Rameau, since
the answer depends on what the model was trained on.

---

## Not limitations, though they look like it

- **`http://hl7.org/...` strings in the bundle.** FHIR system identifiers.
  They are names, never fetched, and are not mixed content.
- **The service worker serving stale code.** Navigations are network-first and
  assets are content-hashed; see [public/sw.js](public/sw.js) for why an
  updated worker deliberately waits rather than taking over a live page.
- **`window.audiomx`.** The only thing the app puts on the global object, for
  the browser console and the smoke suite. It is not a migration leftover.
