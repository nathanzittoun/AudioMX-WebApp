// Fixed acquisition parameters, shared by the DSP, the transports and the UI.

/**
 * Capture rate for the whole pipeline. The ESP32 firmware streams at this rate;
 * the computer mic is resampled to it when the browser hands us another.
 * Everything downstream — FFT axis, WAV header, durations — assumes it.
 */
export const SAMPLE_RATE = 16000;

/** USB serial rate. Must match SERIAL_BAUD in the ESP32 firmware. */
export const BAUD_RATE = 921600;

/** Rolling window feeding the live monitors: one second at SAMPLE_RATE. */
export const MAX_LIVE_SAMPLES = 16000;

/** Upper bound on the analysis FFT length, in samples. */
export const FFT_SIZE = 4096;
