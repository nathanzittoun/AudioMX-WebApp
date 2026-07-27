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
    const t = m.params.entry.text || "";
    if (/404|Failed to load resource/.test(t) && !/favicon/.test(t)) net404.push(t);
  }
};

await new Promise(r => ws.onopen = r);
await cmd("Runtime.enable"); await cmd("Page.enable"); await cmd("Log.enable"); await cmd("Network.enable");
await cmd("Network.setCacheDisabled", { cacheDisabled: true });

const ev = async x => (await cmd("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.value;
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
for (const g of ["SAMPLE_RATE", "PROTOCOL_TESTS", "extractVoiceFeatures", "createZip",
                 "initClinical", "startRecording", "saveRecordingToDb", "smartLaunch", "showTab"]) {
  T(`global ${g}`, (await ev(`typeof ${g}`)) !== "undefined");
}
T("6 tests de protocole rendus", (await ev("document.getElementById('cTestList')?.children.length")) === 6);

// --- 1a. DSP numerique, deterministe (independant du micro) ---
const dsp = await ev(`(()=>{
  const n = 8192, s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(20000 * Math.sin(2*Math.PI*1000*i/SAMPLE_RATE));
  const sp = computeSpectrum(s);
  if (!sp) return null;
  const peaks = findDominantFrequencies(sp, 20, 8000);
  const nyquist = sp.frequencies[sp.frequencies.length-1];
  return { peak: peaks[0] ? peaks[0].freq : null, db: peaks[0] ? peaks[0].db : null,
           bins: sp.magnitudes.length, nyquist, rate: sp.sampleRate };
})()`);
T("FFT retrouve un sinus 1000 Hz", dsp && Math.abs(dsp.peak - 1000) < 10, dsp ? dsp.peak.toFixed(1) + " Hz" : "null");
T("amplitude calibree (~-4 dBFS a 20000/32768)", dsp && Math.abs(dsp.db + 4.3) < 1.5, dsp ? dsp.db.toFixed(1) + " dBFS" : "-");
T("axe frequentiel jusqu'a Nyquist", dsp && Math.abs(dsp.nyquist - 8000) < 10, dsp ? Math.round(dsp.nyquist) + " Hz" : "-");
T("dbfs / clamp / goertzel publies", (await ev(
  "Math.round(dbfs(32768))===0 && clamp(5,0,1)===1 && typeof goertzelMagnitude==='function'")) === true);

// --- 1a1. chemin MEMS, sans materiel ---
// serial.js et wifi.js partagent addSamples(). Rien d'autre dans ce test ne
// l'exerce, donc une regression y serait passee inapercue.
const mems = await ev(`(()=>{
  const frames = 4;
  const buf = new Uint8Array(frames * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < frames; i++) { dv.setInt16(i*4, 1000, true); dv.setInt16(i*4+2, -2000, true); }

  isConnected = true; inputSource = "mems"; memsConnectionType = "wifi"; audioMode = "stereo";
  startRecording();
  addSamples(buf);
  const stereo = { frames: currentFrameCount, first4: Array.from(currentChunks[0] || []).slice(0,4) };

  // "left" garde le second int16 de chaque paire.
  isRecording = false; currentChunks = []; currentFrameCount = 0; currentValueCount = 0;
  audioMode = "left"; startRecording(); addSamples(buf);
  const left = { frames: currentFrameCount, first2: Array.from(currentChunks[0] || []).slice(0,2) };

  // Le warm-up USB doit avaler les premieres trames.
  isRecording = false; currentChunks = []; currentFrameCount = 0; currentValueCount = 0;
  audioMode = "stereo"; memsConnectionType = "usb"; startRecording(); addSamples(buf);
  const warm = { frames: currentFrameCount };

  isRecording = false; currentChunks = []; currentFrameCount = 0; currentValueCount = 0;
  liveSamples = []; isConnected = false; memsConnectionType = "usb";
  return { stereo, left, warm };
})()`);
T("MEMS stereo: 4 trames decodees", mems?.stereo.frames === 4, JSON.stringify(mems?.stereo.first4));
T("MEMS stereo: ordre droite/gauche conserve",
  JSON.stringify(mems?.stereo.first4) === JSON.stringify([1000, -2000, 1000, -2000]));
T("MEMS mode 'left' garde le canal gauche",
  mems?.left.frames === 4 && JSON.stringify(mems?.left.first2) === JSON.stringify([-2000, -2000]));
T("warm-up USB avale le transitoire de mise sous tension", mems?.warm.frames === 0);

// --- 1a2. detection de capacites (le chemin iOS) ---
T("micro ordi supporte sur localhost", (await ev("computerMicSupport().ok")) === true);
T("serialSupport renvoie un verdict", (await ev("typeof serialSupport().ok")) === "boolean");
// La branche qui compte : https + ws:// est bloque par le navigateur, silencieusement.
T("ws:// depuis https -> refuse avec raison", (await ev(
  "(()=>{const r=wifiSupport('ws://192.168.4.1:81','https:');return !r.ok && /https/.test(r.reason)})()")) === true);
T("ws:// depuis http -> autorise", (await ev("wifiSupport('ws://192.168.4.1:81','http:').ok")) === true);
T("wss:// depuis https -> autorise", (await ev("wifiSupport('wss://device.example/','https:').ok")) === true);
T("un input non supporte expose sa raison", (await ev(`(()=>{
  const ids=['cConnectUsb','cConnectWifi','cConnectComputer'];
  return ids.every(id=>{const b=document.getElementById(id);
    return !b || (b.disabled ? (b.title||'').length>20 : !b.title)});})()`)) === true);

// --- 1b. bridge accessor: legacy global <-> state.ts, both directions ---
T("filtre OFF au demarrage", (await ev("noiseAttenuatorEnabled")) === false);
await ev("toggleNoiseAttenuator()");
T("toggle -> global lit true", (await ev("noiseAttenuatorEnabled")) === true);
T("toggle -> l'UI suit state.ts", (await ev("noiseAttenuatorBtn.textContent")) === "Noise filter ON");
// A legacy-style direct write must reach state.ts, not a shadowing copy: if it
// did not, the next toggle would read a stale `true` and flip the button OFF.
await ev("noiseAttenuatorEnabled = false");
await ev("toggleNoiseAttenuator()");
T("ecriture legacy propagee jusqu'a state.ts",
  (await ev("noiseAttenuatorBtn.textContent")) === "Noise filter ON" &&
  (await ev("noiseAttenuatorEnabled")) === true);
await ev("toggleNoiseAttenuator()"); // back to OFF for the capture below
T("retour a OFF", (await ev("noiseAttenuatorEnabled")) === false);

// --- 2. R&D: capture -> library ---
await ev("setAppMode('rnd')");
await ev("setInputSource('computer')"); await new Promise(r => setTimeout(r, 300));
await ev("connectComputerMic()"); await new Promise(r => setTimeout(r, 2200));
T("micro ordi connecte", (await ev("isConnected")) === true);
await ev("startRecording()"); await new Promise(r => setTimeout(r, 2000));
await ev("stopRecording()"); await new Promise(r => setTimeout(r, 1200));
T("enregistrement sauvegarde", (await ev("recordings.length")) === 1);
T("duree ~2s", Math.abs((await ev("recordings[0]?.duration")) - 2) < 0.35, (await ev("recordings[0]?.duration")) + "s");
T("features extraites", (await ev("!!recordings[0]?.features")));
T("WAV a 16 kHz", (await ev("recordings[0].blob.arrayBuffer().then(b=>new DataView(b).getUint32(24,true))")) === 16000);

// --- 3. analyse ---  (le select attend "recording-<id>", pas un index)
await ev("analysisSourceSelect.value='recording-'+recordings[0].id; resetAnalysisSelection(); plotNoiseSpectrum()");
T("spectre calcule", (await ev(
  "!!lastSpectrum && lastSpectrum.magnitudes.length>0 && lastSpectrum.frequencies.length>0")));
T("frequences dominantes affichees", (await ev("/\\d+ Hz/.test(dominantFrequenciesEl.textContent)")) === true);

// --- 4. clinique ---
await ev("setAppMode('clinical'); setClinicalTab('patients')");
await ev("document.getElementById('cNpId').value='PT-SMOKE'; document.getElementById('cNpName').value='Test'; document.getElementById('cNewPatientForm').requestSubmit()");
await new Promise(r => setTimeout(r, 700));
T("patient cree", (await ev("clinicalPatients.length")) === 1);
T("patient ouvert", (await ev("currentPatient?.id")) === "PT-SMOKE");
await ev("startNewSession()"); await new Promise(r => setTimeout(r, 300));
T("session demarree", (await ev("!!currentSessionId")));
await ev("selectClinicalTest(PROTOCOL_TESTS[0].id)");
// activeTestMeta is what binds a take to patient/session/test. Set it in the
// same evaluation as startRecording so nothing in between can clear it.
// La meta est desormais un argument de startRecording, plus une globale.
await ev(`startRecording({patientId:currentPatient.id,patientName:'Test',sessionId:currentSessionId,
          testId:PROTOCOL_TESTS[0].id,testName:PROTOCOL_TESTS[0].name,notes:''})`);
T("meta portee par la prise en cours", (await ev("pendingTestMeta?.patientId")) === "PT-SMOKE");
await new Promise(r => setTimeout(r, 1500));
await ev("stopRecording()"); await new Promise(r => setTimeout(r, 1200));
// recordings.unshift() puts the newest take first, not last.
T("prise clinique rattachee au patient", (await ev("recordings[0]?.meta?.patientId")) === "PT-SMOKE");
T("session retrouvee", (await ev("patientSessions('PT-SMOKE').length")) >= 1);

// The property this design buys: meta is consumed on save, so the next take
// cannot silently inherit the previous patient. On a medical device a
// mis-attributed recording is the failure that matters most.
T("meta consommee apres sauvegarde", (await ev("pendingTestMeta")) === null);
await ev("setAppMode('rnd'); startRecording()"); await new Promise(r => setTimeout(r, 1200));
await ev("stopRecording()"); await new Promise(r => setTimeout(r, 1200));
T("prise suivante n'herite PAS du patient", (await ev("recordings[0]?.meta")) === null);
await ev("setAppMode('clinical')");

// --- 5. persistance + exports ---
const inDb = await ev("new Promise(r=>{const q=indexedDB.open('acousticConsole');q.onsuccess=e=>{const t=e.target.result.transaction('recordings','readonly').objectStore('recordings').getAll();t.onsuccess=()=>r(t.result.length)}})");
T("persiste dans IndexedDB", inDb === 3, inDb + " enregistrements");
// buildFhirBundle is async — it must be awaited, not inspected synchronously.
T("bundle FHIR construit", (await ev(
  "buildFhirBundle(currentPatient, recordings.filter(r=>r.meta&&r.meta.patientId==='PT-SMOKE'))" +
  ".then(b=>!!b && b.resourceType==='Bundle' && b.entry.length>0)")) === true);
T("ZIP construit", (await ev("createZip([{name:'a.txt',data:new Uint8Array([1,2,3])}]).size>0")));

// --- 6. fenetre patient (page reelle, pas seulement l'API) ---
T("protocole lisible par le pop-out", (await ev("!!getProtocolTest(PROTOCOL_TESTS[0].id)")));
const wantTitle = await ev("PROTOCOL_TESTS[0].patientTitle");
// Same origin, so the snapshot survives the navigation and the pop-out picks
// it up on load exactly as it does when the clinician opens the window.
await ev(`localStorage.setItem('audiomx-patient', JSON.stringify({testId:'${await ev("PROTOCOL_TESTS[0].id")}',go:true}))`);
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
T("recordings restaures apres reload", (await ev("recordings.length")) === 3);
T("patients restaures apres reload", (await ev("clinicalPatients.length")) === 1);
T("aucune exception au reload", errs.length === 0, errs.join(" | "));

await ev("new Promise(r=>{const q=indexedDB.deleteDatabase('acousticConsole');q.onsuccess=q.onerror=q.onblocked=()=>r(1)})");
console.log(`\n  ${fail === 0 ? "✅ TOUT PASSE" : "❌ " + fail + " ECHEC(S)"} — ${pass} ok, ${fail} ko\n`);
process.exit(fail === 0 ? 0 : 1);
