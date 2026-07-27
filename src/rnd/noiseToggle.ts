// The R&D "Noise filter ON/OFF" button. Separated from the DSP so the filter
// itself stays pure and testable, and so this UI concern can move out of core/
// when the R&D mode is fully isolated.

import { capture } from "../core/state";
import { resetNoiseAttenuator } from "../core/dsp/noiseFilter";

export function toggleNoiseAttenuator(): void {
  capture.noiseFilterEnabled = !capture.noiseFilterEnabled;

  noiseAttenuatorBtn.classList.toggle("noiseOn", capture.noiseFilterEnabled);

  if (capture.noiseFilterEnabled) {
    noiseAttenuatorBtn.textContent = "Noise filter ON";
    log("Noise filter ON: recordings are cleaned (high-pass + notches + low-pass + gate). Turn OFF for the raw signal.");
  } else {
    noiseAttenuatorBtn.textContent = "Noise filter OFF";
    log("Noise filter OFF: recordings are raw.");
  }

  // Flipping the toggle mid-session would otherwise leave the delay lines and
  // gate envelopes holding state from the previous mode.
  resetNoiseAttenuator();
}
