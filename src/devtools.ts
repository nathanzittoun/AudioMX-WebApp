// A single, deliberate handle on the app's internals: `window.audiomx`.
//
// Two callers. The browser console, when something has to be poked at on a
// machine that has the real microphone attached. And scripts/smoke.mjs, which
// drives the app over the Chrome DevTools Protocol and can only reach it
// through globals.
//
// It exists to keep bridge.ts honest. Everything bridge.ts publishes is there
// because a *legacy* file needs it under that exact name, and each conversion
// should shorten that list — but the smoke suite was also reading those
// globals, so pruning one would have broken the tests for no real reason and
// the two purposes would have stayed tangled. Now the seam shrinks on its own
// schedule and the tests hold on to this instead.
//
// Not stripped from the production build, on purpose: the smoke suite runs
// against the built output precisely so that what ships is what was tested. A
// hook that disappeared in production would defeat that. Nothing here is a
// secret — the whole app is static files anyone can read.

import * as bus from "./core/bus";
import * as constants from "./core/constants";
import * as features from "./core/features";
import * as protocol from "./core/protocol";
import * as recorder from "./core/recorder";
import * as state from "./core/state";
import * as wav from "./core/wav";
import * as zip from "./core/zip";
import * as fft from "./core/dsp/fft";
import * as levels from "./core/dsp/levels";
import * as noiseFilter from "./core/dsp/noiseFilter";
import * as spectrum from "./core/dsp/spectrum";
import * as framing from "./device/framing";
import * as support from "./device/support";
import * as fhirExport from "./ehr/fhirExport";
import * as smart from "./ehr/smart";
import * as analysisSelection from "./rnd/analysisSelection";
import * as fftView from "./rnd/fftView";
import * as libraryView from "./rnd/libraryView";
import * as liveSpectrum from "./rnd/liveSpectrum";
import * as meters from "./rnd/meters";
import * as storage from "./storage/library";
import * as riskModel from "./storage/riskModel";
import * as download from "./ui/download";
import * as spectrogram from "./ui/canvas/spectrogram";
import * as clinical from "./clinical";

const api = {
  bus, constants, features, protocol, recorder, state, wav, zip,
  fft, levels, noiseFilter, spectrum,
  framing, support,
  fhirExport, smart,
  analysisSelection, fftView, libraryView, liveSpectrum, meters,
  storage, riskModel,
  download, spectrogram, clinical,
};

declare global {
  // eslint-disable-next-line no-var
  var audiomx: typeof api;
}

globalThis.audiomx = api;
