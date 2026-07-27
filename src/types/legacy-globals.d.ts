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
declare function renderLiveMonitors(): void;
declare function setInputSource(source: string): Promise<void>;
declare function startRecording(meta?: unknown): Promise<void>;
declare function stopRecording(): Promise<void>;

// ---- transports ----
declare function closeSerialPort(): Promise<void>;
declare function disconnectWifi(): void;
declare function disconnectComputerMic(): Promise<void>;

// ---- capture + library (audio.js) ----
declare function onClinicalRecordingSaved(recording: unknown): void;
declare function drawClinicalMonitors(): void;
declare function clearClinicalMonitors(): void;

// ---- noise filter (noiseAttenuator.js) ----
declare function toggleNoiseAttenuator(): void;

// ---- storage (db.js) ----


// ---- clinical + EHR ----
// Declared as `let`, not `const`: clearAllData() resets them. Module code can
// assign these because a classic script's top-level `let` lives in the global
// lexical environment, which module scope also chains to.
declare let clinicalPatients: unknown[];
// Typed as the persisted shape, which is what clinical.js actually puts here —
// the FHIR export reads name/age/sex off it to build the Patient resource.
declare let currentPatient: import("../storage/types").StoredPatient | null;
declare let currentSessionId: string | null;
declare function loadClinicalPatients(): void;
declare function renderPatientTable(): void;
declare function renderExamHeader(): void;
declare function renderChart(): void;
declare function initClinical(): void;
declare function setClinicalTab(tab: string): void;
