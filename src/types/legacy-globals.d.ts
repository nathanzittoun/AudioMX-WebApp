// Ambient declarations for symbols still living in public/legacy/.
//
// These are declared as bare globals on purpose. Legacy files use top-level
// `let`/`const`, which create global *lexical* bindings — they are reachable as
// bare identifiers but are NOT properties of `window`. So module code must
// write `SAMPLE_RATE`, never `window.SAMPLE_RATE`, or it gets undefined at
// runtime while type-checking cleanly. That trap is the reason this file exists
// instead of a loose `declare global { interface Window }`.
//
// Every conversion deletes lines from here. The file goes away with public/legacy/.

// ---- constants (app.js) ----
declare const SAMPLE_RATE: number;

// ---- shared DOM references (app.js) ----
declare const connectBtn: HTMLButtonElement;
declare const connectWifiBtn: HTMLButtonElement;
declare const startBtn: HTMLButtonElement;
declare const stopBtn: HTMLButtonElement;
declare const calibrateNoiseBtn: HTMLButtonElement;
declare const noiseAttenuatorBtn: HTMLButtonElement;
declare const plotSpectrumBtn: HTMLButtonElement;
declare const resetZoomBtn: HTMLButtonElement;
declare const downloadFftBtn: HTMLButtonElement;
declare const fftMinFreqInput: HTMLInputElement;
declare const fftMaxFreqInput: HTMLInputElement;
declare const analysisSourceSelect: HTMLSelectElement;

// ---- app shell (app.js) ----
declare function setAppMode(mode: string): void;
declare function setStatus(text: string, kind: string): void;
declare function log(message: string): void;
declare function clearCanvas(): void;
declare function updateCurrentStats(): void;
declare function setInputSource(source: string): Promise<void>;
declare function startRecording(): Promise<void>;
declare function stopRecording(): Promise<void>;

// ---- transports ----
declare function connectSerial(): Promise<void>;
declare function connectWifiMems(): void;

// ---- capture + library (audio.js) ----
declare function setAudioMode(mode: string): void;
declare function renderRecordings(): void;
declare function updateAnalysisSourceSelect(): void;

// ---- analysis (analysis.js) ----
declare function drawSpectrumBackground(minFreq?: number, maxFreq?: number): void;
declare function drawLiveSpectrum(): void;
declare function clearLiveSpectrogram(): void;
declare function calibrateNoiseFloor(): void;
declare function plotNoiseSpectrum(): void;
declare function resetFftZoom(): void;
declare function downloadFftCsv(): void;
declare function resetAnalysisSelection(): void;
declare function drawAnalysisWaveform(): void;
declare function initAnalysisWaveformSelection(): void;

// ---- noise filter (noiseAttenuator.js) ----
declare function toggleNoiseAttenuator(): void;

// ---- storage (db.js) ----


// ---- clinical + EHR ----
// Declared as `let`, not `const`: clearAllData() resets them. Module code can
// assign these because a classic script's top-level `let` lives in the global
// lexical environment, which module scope also chains to.
declare let clinicalPatients: unknown[];
declare let currentPatient: { id: string } | null;
declare let currentSessionId: string | null;
declare function loadClinicalPatients(): void;
declare function renderPatientTable(): void;
declare function renderExamHeader(): void;
declare function renderChart(): void;
declare function initClinical(): void;
declare function initEhr(): Promise<void>;
