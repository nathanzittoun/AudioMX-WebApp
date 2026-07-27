// AudioMX smoke test — run after every migration commit.
//   node smoke.mjs            (dev server on :5173)
//   node smoke.mjs preview    (built output on :4173)
// Exits non-zero on any failure so it can gate a commit.

const PORT = process.argv[2] === "preview" ? 4173 : 5173;
const BASE = process.argv[2] === "preview"
  ? `http://localhost:${PORT}/AudioMX-WebApp/`
  : `http://localhost:${PORT}/`;

const targets = await (await fetch("http://localhost:9222/json")).json();
const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const cmd = (m, p = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method: m, params: p })); });

let errs = [];
const net404 = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    errs.push((d.exception?.description || d.text).split("\n")[0]);
  }
  if (m.method === "Log.entryAdded") {
    const e = m.params.entry;
    // The failing URL lives in entry.url, not entry.text — filtering on the
    // text alone let /favicon.ico through and reported it as a real 404.
    const t = (e.url || "") + " " + (e.text || "");
    if (/404|Failed to load resource/.test(t) && !/favicon/.test(t)) net404.push(t.trim());
  }
};

await new Promise(r => ws.onopen = r);
await cmd("Runtime.enable"); await cmd("Page.enable"); await cmd("Network.enable");
// Log.enable replays whatever is already in the browser's log, including 404s
// from an earlier run against a different origin. Clear before listening.
await cmd("Log.enable"); await cmd("Log.clear");
// Compte les AudioContext ouverts par l'app. Injecte avant tout script de la
// page, donc valable des la premiere ligne executee. Un seul est autorise :
// sur macOS un second fait reconfigurer le peripherique par CoreAudio, ce qui
// coupe l'entree du premier — la prise sort a la bonne duree et vide.
await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  const Real = window.AudioContext;
  if (!Real) return;
  window.__audioContexts = 0;
  const Counted = function (...args) { window.__audioContexts++; return new Real(...args); };
  Counted.prototype = Real.prototype;
  window.AudioContext = Counted;
})()` });
await cmd("Network.setCacheDisabled", { cacheDisabled: true });

const ev = async x => {
  const r = await cmd("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  // A hung promise or a thrown expression comes back without `result`; report
  // undefined so one bad probe fails its own assertion instead of the run.
  return r?.result?.value;
};
const go = async () => { await cmd("Page.navigate", { url: BASE }); await new Promise(r => setTimeout(r, 4500)); };

let pass = 0, fail = 0;
const T = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  (${detail})` : ""}`);
};

console.log(`\n  === SMOKE ${BASE} ===`);
await go();
await ev("new Promise(r=>{const q=indexedDB.deleteDatabase('acousticConsole');q.onsuccess=q.onerror=q.onblocked=()=>r(1)})");
await go();
errs = [];

// --- 1. boot ---
T("page charge sans exception", errs.length === 0, errs.join(" | "));
T("aucun 404", net404.length === 0, net404.slice(0, 2).join(" | "));
// window.audiomx est la SEULE chose que l'app pose sur l'objet global : plus de
// pont, plus de script classique, tout passe par des modules ES.
// Aucun de ces noms n'est un id du DOM : le navigateur expose window.log pour
// <div id="log">, ce qui n'aurait rien a voir avec une globale de l'app.
T("aucune globale legacy", (await ev(
  "['SAMPLE_RATE','recordings','initClinical','startRecording','showTab','isRecording'," +
  "'computeSpectrum','createZip','liveSamples','currentPatient','setStatus','encodeWav']" +
  ".every(n => typeof globalThis[n] === 'undefined')")) === true);
for (const path of ["constants.SAMPLE_RATE", "protocol.PROTOCOL_TESTS", "features.extractVoiceFeatures",
                    "zip.createZip", "clinical.initClinical", "app.startRecording",
                    "storage.saveRecording", "smart.launch", "tabs.showTab"]) {
  T(`audiomx.${path}`, (await ev(`typeof audiomx.${path}`)) !== "undefined");
}
T("6 tests de protocole rendus", (await ev("document.getElementById('cTestList')?.children.length")) === 6);

// --- 1a. DSP numerique, deterministe (independant du micro) ---
const dsp = await ev(`(()=>{
  const n = 8192, s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(20000 * Math.sin(2*Math.PI*1000*i/audiomx.constants.SAMPLE_RATE));
  const sp = audiomx.spectrum.computeSpectrum(s);
  if (!sp) return null;
  const peaks = audiomx.spectrum.findDominantFrequencies(sp, 20, 8000);
  const nyquist = sp.frequencies[sp.frequencies.length-1];
  return { peak: peaks[0] ? peaks[0].freq : null, db: peaks[0] ? peaks[0].db : null,
           bins: sp.magnitudes.length, nyquist, rate: sp.sampleRate };
})()`);
T("FFT retrouve un sinus 1000 Hz", dsp && Math.abs(dsp.peak - 1000) < 10, dsp ? dsp.peak.toFixed(1) + " Hz" : "null");
T("amplitude calibree (~-4 dBFS a 20000/32768)", dsp && Math.abs(dsp.db + 4.3) < 1.5, dsp ? dsp.db.toFixed(1) + " dBFS" : "-");
T("axe frequentiel jusqu'a Nyquist", dsp && Math.abs(dsp.nyquist - 8000) < 10, dsp ? Math.round(dsp.nyquist) + " Hz" : "-");
T("dbfs / clamp / goertzel publies", (await ev(
  "Math.round(audiomx.levels.dbfs(32768))===0 && audiomx.levels.clamp(5,0,1)===1 && typeof audiomx.levels.goertzelMagnitude==='function'")) === true);

// --- 1a0d. indicateurs de qualite du signal (banc R&D) ---
// Ils n'existent que branches a un micro : ici on injecte un signal connu et
// on relit ce que le clinicien voit a l'ecran.
const met = await ev(`(()=>{
  const n = 16000, s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(20000 * Math.sin(2*Math.PI*1000*i/16000));
  const txt = id => document.getElementById(id).textContent;
  const bar = id => document.getElementById(id).style.width;

  audiomx.meters.updateNoiseIndicators(s);
  // Releve avant tout autre appel : chaque appel ecrase l'affichage.
  const clean = { rms: parseFloat(txt('rmsDb')), peak: parseFloat(txt('peakDb')), rmsBar: bar('rmsBar') };

  // Bruit de fond a ~ -60 dBFS, une seconde.
  audiomx.state.capture.live.length = 0;
  for (let i = 0; i < 16000; i++) audiomx.state.capture.live.push(Math.round(33 * Math.sin(i)));
  audiomx.meters.calibrateNoiseFloor();
  const floor = txt('noiseFloor');

  // Sature : la remarque doit basculer sur le clipping.
  audiomx.meters.updateNoiseIndicators(new Int16Array(1000).fill(32700));

  return { ...clean, floor, comment: txt('noiseComment') };
})()`);
// Un sinus 20000/32768 : crete -4.3 dBFS, RMS 3 dB plus bas.
T("crete affichee juste", met && Math.abs(met.peak + 4.3) < 0.3, met ? met.peak + " dBFS" : "-");
T("RMS affiche juste (crete - 3 dB)", met && Math.abs(met.rms + 7.3) < 0.3, met ? met.rms + " dBFS" : "-");
T("barre de niveau remplie", met && /%$/.test(met.rmsBar || "") && parseFloat(met.rmsBar) > 50, met?.rmsBar);
T("plancher de bruit calibre", met && /dBFS baseline/.test(met.floor), met?.floor);
T("saturation signalee a l'operateur", met && /Clipping detected/.test(met.comment), met?.comment?.slice(0, 40));

// --- 1a1. spectrogrammes : on lit les pixels, pas le code ---
// Ces fonctions ne renvoient rien et ne tournent qu'avec un micro branche :
// une constante disparue y a vecu 4 commits en jetant une ReferenceError par
// frame, sans que rien ne le signale. Le canvas, lui, ne ment pas.
const sg = await ev(`(()=>{
  const cv = document.getElementById('liveSpectrogram');
  const c = cv.getContext('2d');
  audiomx.spectrogram.clearLiveSpectrogram();
  // Apres effacement : #0e0e14 partout.
  const blank = c.getImageData(0, 0, cv.width, cv.height).data;
  let cleared = true;
  for (let i = 0; i < blank.length; i += 4)
    if (blank[i] !== 14 || blank[i+1] !== 14 || blank[i+2] !== 20) { cleared = false; break; }

  // Trame FFT synthetique : toute l'energie dans les basses frequences.
  const bins = 512, mag = new Float32Array(bins);
  for (let i = 0; i < bins; i++) mag[i] = i < 32 ? -25 : -95;
  audiomx.spectrogram.pushLiveSpectrogramColumn({ magnitudes: mag, fftSize: 1024 }, performance.now());

  const col = c.getImageData(cv.width - 1, 0, 1, cv.height).data;
  const lum = y => col[y*4] + col[y*4+1] + col[y*4+2];
  return { cleared, top: lum(0), bottom: lum(cv.height - 1) };
})()`);
T("spectrogramme live efface au noir", sg?.cleared === true);
// y=0 est le Nyquist, y=height le continu : l'energie basse doit eclairer le bas.
T("spectrogramme live peint la colonne (bas clair, haut sombre)",
  sg && sg.bottom > 400 && sg.top < 100, sg ? `bas ${sg.bottom} / haut ${sg.top}` : "-");

const ssg = await ev(`(()=>{
  const cv = document.getElementById('analysisSpectrogram');
  const n = 16384, s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(12000 * Math.sin(2*Math.PI*1000*i/16000));
  audiomx.spectrogram.renderStaticSpectrogram(cv.getContext('2d'), cv, s, 16000);
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  // La ligne la plus lumineuse est la frequence dominante.
  let bestY = -1, best = -1;
  for (let y = 0; y < cv.height; y++) {
    let sum = 0;
    for (let x = 0; x < cv.width; x++) { const p = (y*cv.width + x)*4; sum += d[p] + d[p+1] + d[p+2]; }
    if (sum > best) { best = sum; bestY = y; }
  }
  return { freq: (1 - bestY/cv.height) * 8000 };
})()`);
T("spectrogramme statique place le 1 kHz au bon endroit",
  ssg && Math.abs(ssg.freq - 1000) < 300, ssg ? Math.round(ssg.freq) + " Hz" : "-");

// --- 1a0. WAV: aller-retour complet, sans micro ---
const wav = await ev(`(()=>{
  const s = Int16Array.from([0, 1000, -1000, 32767, -32768, 42]);
  const b = audiomx.wav.encodeWav(s, 16000, 1);
  const v = new DataView(b);
  const tag = o => String.fromCharCode(v.getUint8(o),v.getUint8(o+1),v.getUint8(o+2),v.getUint8(o+3));
  const back = [];
  for (let i = 0; i < s.length; i++) back.push(v.getInt16(44 + i*2, true));
  return { riff: tag(0), wave: tag(8), fmt: tag(12), data: tag(36),
           pcm: v.getUint16(20,true), channels: v.getUint16(22,true),
           rate: v.getUint32(24,true), byteRate: v.getUint32(28,true),
           blockAlign: v.getUint16(32,true), bits: v.getUint16(34,true),
           dataSize: v.getUint32(40,true), bytes: b.byteLength,
           roundTrip: JSON.stringify(back) === JSON.stringify(Array.from(s)) };
})()`);
T("WAV: en-tetes RIFF/WAVE/fmt/data", wav &&
  wav.riff === "RIFF" && wav.wave === "WAVE" && wav.fmt === "fmt " && wav.data === "data");
T("WAV: PCM 16 bits mono a 16 kHz", wav &&
  wav.pcm === 1 && wav.bits === 16 && wav.channels === 1 && wav.rate === 16000);
T("WAV: byteRate et blockAlign coherents", wav && wav.byteRate === 32000 && wav.blockAlign === 2);
T("WAV: taille = 44 + donnees", wav && wav.dataSize === 12 && wav.bytes === 56);
// Les bornes de l'int16 sont exactement ou un encodeur se casse.
T("WAV: echantillons intacts, bornes comprises", wav?.roundTrip === true);
T("mixage mono d'une prise stereo", (await ev(
  "JSON.stringify(Array.from(audiomx.wav.makeAnalysisSamples(Int16Array.from([100,300, -50,50]), 'stereo')))")) === "[200,0]");

// --- 1a0b. nommage des fichiers exportes ---
// Un fichier sorti de l'app doit rester identifiable seul, dans un dossier.
T("nom de fichier clinique porte patient/session/test", (await ev(`
  audiomx.download.recordingBaseName({ number:1, source:'mic', mode:'mono', createdAt:new Date('2026-07-27T10:00:00Z'),
    meta:{patientId:'PT 0142',sessionId:'S-1',testId:'mpt'} })`)) === 'PT-0142__S-1__mpt__2026-07-27T10-00-00-000Z');
T("nom R&D sans patient", (await ev(`
  audiomx.download.recordingBaseName({ number:7, source:'Computer mic', mode:'stereo',
    createdAt:new Date('2026-07-27T10:00:00Z'), meta:null }).startsWith('audiomx_recording_7_computer_mic_stereo')`)) === true);
T("caracteres dangereux neutralises", (await ev("audiomx.download.sanitizeForFilename('  a/b:c*d  ')")) === 'a-b-c-d');

// --- 1a0c. decodeur de trames USB ---
// Une lecture USB rend les octets arrives, pas des trames : une trame peut
// etre coupee n'importe ou. C'est la que ce genre de code casse en silence.
const fr = await ev(`(()=>{
  const frame = (payload) => {
    const b = new Uint8Array(4 + payload.length);
    b[0]=0xAA; b[1]=0x55; b[2]=payload.length & 0xFF; b[3]=(payload.length>>8)&0xFF;
    b.set(payload, 4); return b;
  };
  const p1 = audiomx.framing.createFrameParser();
  const whole = p1.push(frame(Uint8Array.from([1,2,3,4]))).map(f=>Array.from(f));

  // Coupee en plein milieu : rien ne sort avant que le reste arrive.
  const p2 = audiomx.framing.createFrameParser();
  const f = frame(Uint8Array.from([9,8,7,6]));
  const firstHalf = p2.push(f.slice(0,5)).length;
  const pendingMid = p2.pending;
  const secondHalf = p2.push(f.slice(5)).map(x=>Array.from(x));

  // Deux trames dans une seule lecture.
  const p3 = audiomx.framing.createFrameParser();
  const both = new Uint8Array([...frame(Uint8Array.from([1])), ...frame(Uint8Array.from([2,3]))]);
  const two = p3.push(both).map(x=>Array.from(x));

  // Resynchronisation apres des octets parasites.
  const p4 = audiomx.framing.createFrameParser();
  const noisy = new Uint8Array([0x00,0xFF,0x12, ...frame(Uint8Array.from([5,5]))]);
  const after = p4.push(noisy).map(x=>Array.from(x));

  return { whole, firstHalf, pendingMid, secondHalf, two, after };
})()`);
T("trame complete decodee", JSON.stringify(fr?.whole) === JSON.stringify([[1,2,3,4]]));
T("trame coupee: rien avant d'avoir tout recu", fr?.firstHalf === 0 && fr?.pendingMid === 5);
T("trame coupee: reassemblee a l'arrivee du reste",
  JSON.stringify(fr?.secondHalf) === JSON.stringify([[9,8,7,6]]));
T("deux trames dans une seule lecture", JSON.stringify(fr?.two) === JSON.stringify([[1],[2,3]]));
T("resynchronisation apres octets parasites", JSON.stringify(fr?.after) === JSON.stringify([[5,5]]));

// --- 1a0d. backoff de reconnexion Wi-Fi ---
// Pur, donc verifiable sans attendre 15 secondes de tentatives.
T('backoff exponentiel plafonne a 8 s', (await ev(
  'JSON.stringify([1,2,3,4,5].map(audiomx.wifiSource.reconnectDelayMs))')) === '[1000,2000,4000,8000,8000]');
T('adresse Wi-Fi par defaut si le champ est vide', (await ev(
  "(()=>{const i=document.getElementById('wifiUrlInput');const old=i.value;i.value='  ';const r=audiomx.wifiSource.getWifiUrl();i.value=old;return r})()"
)) === 'ws://192.168.4.1:81');

// --- 1a1. chemin MEMS, sans materiel ---
// serial.js et wifi.js partagent addSamples(). Rien d'autre dans ce test ne
// l'exerce, donc une regression y serait passee inapercue.
const mems = await ev(`(()=>{
  const frames = 4;
  const buf = new Uint8Array(frames * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < frames; i++) { dv.setInt16(i*4, 1000, true); dv.setInt16(i*4+2, -2000, true); }

  audiomx.state.device.connected = true; audiomx.state.device.sourceId = "mems"; audiomx.state.device.transport = "wifi"; audiomx.state.capture.channelMode = "stereo";
  audiomx.app.startRecording();
  audiomx.recorder.ingestMemsFrame(buf);
  const stereo = { frames: audiomx.state.capture.frames, first4: Array.from(audiomx.state.capture.chunks[0] || []).slice(0,4) };

  // "left" garde le second int16 de chaque paire.
  audiomx.state.capture.recording = false; audiomx.state.capture.chunks = []; audiomx.state.capture.frames = 0; audiomx.state.capture.values = 0;
  audiomx.state.capture.channelMode = "left"; audiomx.app.startRecording(); audiomx.recorder.ingestMemsFrame(buf);
  const left = { frames: audiomx.state.capture.frames, first2: Array.from(audiomx.state.capture.chunks[0] || []).slice(0,2) };

  // Le warm-up USB doit avaler les premieres trames.
  audiomx.state.capture.recording = false; audiomx.state.capture.chunks = []; audiomx.state.capture.frames = 0; audiomx.state.capture.values = 0;
  audiomx.state.capture.channelMode = "stereo"; audiomx.state.device.transport = "usb"; audiomx.app.startRecording(); audiomx.recorder.ingestMemsFrame(buf);
  const warm = { frames: audiomx.state.capture.frames };

  audiomx.state.capture.recording = false; audiomx.state.capture.chunks = []; audiomx.state.capture.frames = 0; audiomx.state.capture.values = 0;
  audiomx.state.capture.live = []; audiomx.state.device.connected = false; audiomx.state.device.transport = "usb";
  return { stereo, left, warm };
})()`);
T("MEMS stereo: 4 trames decodees", mems?.stereo.frames === 4, JSON.stringify(mems?.stereo.first4));
T("MEMS stereo: ordre droite/gauche conserve",
  JSON.stringify(mems?.stereo.first4) === JSON.stringify([1000, -2000, 1000, -2000]));
T("MEMS mode 'left' garde le canal gauche",
  mems?.left.frames === 4 && JSON.stringify(mems?.left.first2) === JSON.stringify([-2000, -2000]));
T("warm-up USB avale le transitoire de mise sous tension", mems?.warm.frames === 0);

// --- 1a2. detection de capacites (le chemin iOS) ---
T("micro ordi supporte sur localhost", (await ev("audiomx.support.computerMicSupport().ok")) === true);
T("serialSupport renvoie un verdict", (await ev("typeof audiomx.support.serialSupport().ok")) === "boolean");
// La branche qui compte : https + ws:// est bloque par le navigateur, silencieusement.
T("ws:// depuis https -> refuse avec raison", (await ev(
  "(()=>{const r=audiomx.support.wifiSupport('ws://192.168.4.1:81','https:');return !r.ok && /https/.test(r.reason)})()")) === true);
T("ws:// depuis http -> autorise", (await ev("audiomx.support.wifiSupport('ws://192.168.4.1:81','http:').ok")) === true);
T("wss:// depuis https -> autorise", (await ev("audiomx.support.wifiSupport('wss://device.example/','https:').ok")) === true);
T("un input non supporte expose sa raison", (await ev(`(()=>{
  const ids=['cConnectUsb','cConnectWifi','cConnectComputer'];
  return ids.every(id=>{const b=document.getElementById(id);
    return !b || (b.disabled ? (b.title||'').length>20 : !b.title)});})()`)) === true);

// --- 1a3. panneau Epic ---
T('indice Epic affiche l URI de retour exacte', (await ev(
  "(()=>{const h=document.getElementById('cEhrHint');return !!h && h.textContent.includes(location.origin)})()"
)) === true);
T('nom patient FHIR: champ text prioritaire', (await ev(
  "audiomx.ehrPanel.patientDisplayName({id:'x', name:[{text:'Jane Q Doe', given:['Jane'], family:'Doe'}]})"
)) === 'Jane Q Doe');
T('nom patient FHIR: reconstruit sinon', (await ev(
  "audiomx.ehrPanel.patientDisplayName({id:'x', name:[{given:['Jane','Q'], family:'Doe'}]})"
)) === 'Jane Q Doe');
T('nom patient FHIR: repli sur l id', (await ev("audiomx.ehrPanel.patientDisplayName({id:'epic-123'})")) === 'epic-123');

// --- 1b. bridge accessor: legacy global <-> state.ts, both directions ---
T("filtre OFF au demarrage", (await ev("audiomx.state.capture.noiseFilterEnabled")) === false);
await ev("audiomx.noiseToggle.toggleNoiseAttenuator()");
T("toggle -> global lit true", (await ev("audiomx.state.capture.noiseFilterEnabled")) === true);
T("toggle -> l'UI suit state.ts", (await ev("document.getElementById('noiseAttenuatorBtn').textContent")) === "Noise filter ON");
// A legacy-style direct write must reach state.ts, not a shadowing copy: if it
// did not, the next toggle would read a stale `true` and flip the button OFF.
await ev("audiomx.state.capture.noiseFilterEnabled = false");
await ev("audiomx.noiseToggle.toggleNoiseAttenuator()");
T("ecriture legacy propagee jusqu'a state.ts",
  (await ev("document.getElementById('noiseAttenuatorBtn').textContent")) === "Noise filter ON" &&
  (await ev("audiomx.state.capture.noiseFilterEnabled")) === true);
await ev("audiomx.noiseToggle.toggleNoiseAttenuator()"); // back to OFF for the capture below
T("retour a OFF", (await ev("audiomx.state.capture.noiseFilterEnabled")) === false);

// --- 2. R&D: capture -> library ---
await ev("audiomx.app.setAppMode('rnd')");
await ev("audiomx.app.setInputSource('computer')"); await new Promise(r => setTimeout(r, 300));
await ev("audiomx.computerMicSource.connectComputerMic()"); await new Promise(r => setTimeout(r, 2200));
T("micro ordi connecte", (await ev("audiomx.state.device.connected")) === true);
await ev("audiomx.app.startRecording()"); await new Promise(r => setTimeout(r, 2000));
await ev("audiomx.app.stopRecording()"); await new Promise(r => setTimeout(r, 1200));
T("enregistrement sauvegarde", (await ev("audiomx.state.library.recordings.length")) === 1);
T("duree ~2s", Math.abs((await ev("audiomx.state.library.recordings[0]?.duration")) - 2) < 0.35, (await ev("audiomx.state.library.recordings[0]?.duration")) + "s");
T("features extraites", (await ev("!!audiomx.state.library.recordings[0]?.features")));
T("WAV a 16 kHz", (await ev("audiomx.state.library.recordings[0].blob.arrayBuffer().then(b=>new DataView(b).getUint32(24,true))")) === 16000);

// --- 3. analyse ---  (le select attend "recording-<id>", pas un index)
await ev("document.getElementById('analysisSourceSelect').value='recording-'+audiomx.state.library.recordings[0].id;" +
  "audiomx.analysisSelection.resetAnalysisSelection(); audiomx.fftView.plotNoiseSpectrum()");
T("spectre calcule", (await ev(
  "!!audiomx.state.analysis.lastSpectrum && audiomx.state.analysis.lastSpectrum.magnitudes.length>0 && audiomx.state.analysis.lastSpectrum.frequencies.length>0")));
T("frequences dominantes affichees", (await ev("/\\d+ Hz/.test(document.getElementById('dominantFrequencies').textContent)")) === true);

// La selection a la souris : c'est elle qui decide quel audio part au FFT,
// au CSV et au spectrogramme. On tire vraiment la poignee droite.
const drag = await ev(`(()=>{
  audiomx.tabs.showTab('analyzeView');
  const cv = document.getElementById('analysisWaveformCanvas');
  const r = cv.getBoundingClientRect();
  const at = f => ({ clientX: r.left + r.width*f, clientY: r.top + r.height/2, bubbles: true });
  const a = audiomx.state.analysis;
  const before = { end: a.selectionEnd, source: a.lastSpectrumSourceName };

  cv.dispatchEvent(new MouseEvent('mousedown', at(1)));
  window.dispatchEvent(new MouseEvent('mousemove', at(0.5)));
  window.dispatchEvent(new MouseEvent('mouseup', at(0.5)));

  return { before, end: a.selectionEnd, mode: a.dragMode, source: a.lastSpectrumSourceName,
           label: document.getElementById('selectedRangeLabel').textContent };
})()`);
T("poignee droite deplacee a la moitie", drag && Math.abs(drag.end - 0.5) < 0.02,
  drag ? drag.before?.end + " -> " + drag.end?.toFixed(3) : "-");
T("relacher termine le glisser", drag?.mode === null);
// La source du dernier FFT porte les bornes : preuve que le bus a bien
// declenche le replot, sans que la forme d'onde connaisse le panneau FFT.
T("le glisser a bien replote le FFT", drag && drag.source !== drag.before.source &&
  drag.source.includes("_selected_0_"), drag?.source);
T("duree selectionnee affichee", drag && (drag.label || "").endsWith(" s selected"), drag?.label);

// --- 4. clinique ---
await ev("audiomx.app.setAppMode('clinical'); audiomx.clinical.setClinicalTab('patients')");
await ev("document.getElementById('cNpId').value='PT-SMOKE'; document.getElementById('cNpName').value='Test'; document.getElementById('cNewPatientForm').requestSubmit()");
await new Promise(r => setTimeout(r, 700));
T("patient cree", (await ev("audiomx.clinical.clinicalStateAccess.patients.length")) === 1);
T("patient ouvert", (await ev("audiomx.clinical.clinicalStateAccess.patient?.id")) === "PT-SMOKE");
await ev("audiomx.clinical.startNewSession()"); await new Promise(r => setTimeout(r, 300));
T("session demarree", (await ev("!!audiomx.clinical.clinicalStateAccess.sessionId")));
await ev("audiomx.clinical.selectClinicalTest(audiomx.protocol.PROTOCOL_TESTS[0].id)");
// activeTestMeta is what binds a take to patient/session/test. Set it in the
// same evaluation as startRecording so nothing in between can clear it.
// La meta est desormais un argument de startRecording, plus une globale.
await ev(`audiomx.app.startRecording({patientId:audiomx.clinical.clinicalStateAccess.patient.id,patientName:'Test',sessionId:audiomx.clinical.clinicalStateAccess.sessionId,
          testId:audiomx.protocol.PROTOCOL_TESTS[0].id,testName:audiomx.protocol.PROTOCOL_TESTS[0].name,notes:''})`);
T("meta portee par la prise en cours", (await ev("audiomx.state.capture.pendingMeta?.patientId")) === "PT-SMOKE");
await new Promise(r => setTimeout(r, 1500));
await ev("audiomx.app.stopRecording()"); await new Promise(r => setTimeout(r, 1200));
// recordings.unshift() puts the newest take first, not last.
T("prise clinique rattachee au patient", (await ev("audiomx.state.library.recordings[0]?.meta?.patientId")) === "PT-SMOKE");
T("session retrouvee", (await ev("audiomx.clinical.patientSessions('PT-SMOKE').length")) >= 1);

// The property this design buys: meta is consumed on save, so the next take
// cannot silently inherit the previous patient. On a medical device a
// mis-attributed recording is the failure that matters most.
T("meta consommee apres sauvegarde", (await ev("audiomx.state.capture.pendingMeta")) === null);
await ev("audiomx.app.setAppMode('rnd'); audiomx.app.startRecording()"); await new Promise(r => setTimeout(r, 1200));
await ev("audiomx.app.stopRecording()"); await new Promise(r => setTimeout(r, 1200));
T("prise suivante n'herite PAS du patient", (await ev("audiomx.state.library.recordings[0]?.meta")) === null);
await ev("audiomx.app.setAppMode('clinical')");

// --- 4b. examen complet par l'UI (Start -> "I'm ready" -> decompte -> End) ---
// La section ci-dessus appelle startRecording() directement : elle ne touche ni
// au bouton Start, ni a la barriere de consentement patient, ni au decompte, et
// ne declenche donc aucun bip. C'est precisement ce chemin qui rendait la prise
// silencieuse en clinique, et rien ne le parcourait.
await ev("audiomx.app.setAppMode('clinical'); audiomx.clinical.setClinicalTab('exam')");
await ev("document.getElementById('cConsent').checked = true");
await ev("document.getElementById('cStartBtn').click()");
await new Promise(r => setTimeout(r, 500));
T("Start met l'examen en attente du patient", (await ev(
  "document.getElementById('pReadyWrap')?.style.display")) === "block");

await ev("document.getElementById('pReadyBtn').click()");
await new Promise(r => setTimeout(r, 6500));   // 5 s de decompte + marge
T("le decompte a lance l'enregistrement", (await ev("audiomx.state.capture.recording")) === true);

await new Promise(r => setTimeout(r, 2000));
await ev("document.getElementById('cStopBtn').click()");
await new Promise(r => setTimeout(r, 1500));

// LE test qui compte : la prise ne doit pas etre silencieuse.
const exam = await ev(`(()=>{
  const r = audiomx.state.library.recordings[0];
  if (!r) return { error: 'aucune prise' };
  let max = 0;
  for (let i = 0; i < r.analysisSamples.length; i++) {
    const v = Math.abs(r.analysisSamples[i]);
    if (v > max) max = v;
  }
  return { max, duration: r.duration, patient: r.meta?.patientId,
           contexts: window.__audioContexts,
           gate: document.getElementById('cGateBox')?.style.display };
})()`);
T("un seul AudioContext pour toute l'app", exam?.contexts === 1,
  exam ? exam.contexts + " ouvert(s)" : "-");
// Sans micro reel c'est la tonalite de test de Chrome ; avec un vrai micro
// c'est la voix. Dans les deux cas, zero partout = l'entree est morte.
T("la prise clinique n'est PAS silencieuse", exam && exam.max > 1000,
  exam ? "amplitude max " + exam.max : "-");
T("prise rattachee au patient", exam?.patient === "PT-SMOKE");
T("quality gate affiche apres l'examen", exam?.gate === "block");

// --- 5. persistance + exports ---
const inDb = await ev(`new Promise(res=>{
  const done = n => res(n);
  setTimeout(() => done(-1), 3000);   // blocked open would otherwise hang the run
  const q = indexedDB.open('acousticConsole');
  q.onerror = q.onblocked = () => done(-1);
  q.onsuccess = e => {
    const t = e.target.result.transaction('recordings','readonly').objectStore('recordings').getAll();
    t.onsuccess = () => done(t.result.length);
    t.onerror = () => done(-1);
  };
})`);
T("persiste dans IndexedDB", inDb === 4, inDb + " enregistrements");
// buildFhirBundle is async — it must be awaited, not inspected synchronously.
T("bundle FHIR construit", (await ev(
  "audiomx.fhirExport.buildFhirBundle(audiomx.clinical.clinicalStateAccess.patient, audiomx.state.library.recordings.filter(r=>r.meta&&r.meta.patientId==='PT-SMOKE'))" +
  ".then(b=>!!b && b.resourceType==='Bundle' && b.entry.length>0)")) === true);
T("ZIP construit", (await ev("audiomx.zip.createZip([{name:'a.txt',data:new Uint8Array([1,2,3])}]).size>0")));

// Supprimer une prise depuis le Chart doit la retirer de la memoire ET de la
// base, et liberer son object URL. Deux fonctions differentes portaient le nom
// `deleteRecording` en global ; se tromper de cible laissait la prise a l'ecran
// jusqu'au rechargement, et fuyait le blob. Rien ne le verifiait.
const del = await ev(`(async () => {
  const before = audiomx.state.library.recordings.length;
  const victim = audiomx.state.library.recordings.find(r => r.meta && r.meta.patientId === 'PT-SMOKE');
  if (!victim) return { error: 'aucune prise clinique' };
  audiomx.clinical.deleteClinicalRecording(victim.id, true);
  await new Promise(r => setTimeout(r, 400));
  const inDb = await new Promise(done => {
    const q = indexedDB.open('acousticConsole');
    q.onsuccess = () => {
      const t = q.result.transaction('recordings').objectStore('recordings').getAll();
      t.onsuccess = () => done(t.result.some(x => x.id === victim.id));
      t.onerror = () => done('erreur');
    };
  });
  return { before, after: audiomx.state.library.recordings.length, stillInDb: inDb,
           gone: !audiomx.state.library.recordings.some(r => r.id === victim.id) };
})()`);
T("prise clinique retiree de la memoire", del && del.gone === true && del.after === del.before - 1,
  del ? `${del.before} -> ${del.after}` : "-");
T("prise clinique retiree d'IndexedDB", del?.stillInDb === false);

// --- 6. fenetre patient (page reelle, pas seulement l'API) ---
T("protocole lisible par le pop-out", (await ev("!!audiomx.protocol.getProtocolTest(audiomx.protocol.PROTOCOL_TESTS[0].id)")));
const wantTitle = await ev("audiomx.protocol.PROTOCOL_TESTS[0].patientTitle");
// Same origin, so the snapshot survives the navigation and the pop-out picks
// it up on load exactly as it does when the clinician opens the window.
await ev(`localStorage.setItem('audiomx-patient', JSON.stringify({testId:'${await ev("audiomx.protocol.PROTOCOL_TESTS[0].id")}',go:true}))`);
await cmd("Page.navigate", { url: BASE + "patient.html" });
await new Promise(r => setTimeout(r, 2500));
T("pop-out rend la consigne du protocole", (await ev("document.getElementById('pTaskTitle').textContent")) === wantTitle);
T("pop-out affiche les etapes", (await ev("document.getElementById('pSteps').children.length")) > 0);
T("pop-out reflete l'etat 'recording'", (await ev("document.getElementById('pGoBar').classList.contains('go')")) === true);
await new Promise(r => setTimeout(r, 3500));
T("pop-out ne bascule PAS sur l'erreur apres 5 s",
  (await ev("document.getElementById('pTaskTitle').textContent")) === wantTitle);
await ev("localStorage.removeItem('audiomx-patient')");

// --- 7. reload -> restauration ---
await go();
// 2, pas 3 : la prise supprimee plus haut doit rester supprimee apres reload.
T("recordings restaures apres reload", (await ev("audiomx.state.library.recordings.length")) === 3);
T("patients restaures apres reload", (await ev("audiomx.clinical.clinicalStateAccess.patients.length")) === 1);
T("aucune exception au reload", errs.length === 0, errs.join(" | "));

await ev("new Promise(r=>{const q=indexedDB.deleteDatabase('acousticConsole');q.onsuccess=q.onerror=q.onblocked=()=>r(1)})");
console.log(`\n  ${fail === 0 ? "✅ TOUT PASSE" : "❌ " + fail + " ECHEC(S)"} — ${pass} ok, ${fail} ko\n`);
process.exit(fail === 0 ? 0 : 1);
