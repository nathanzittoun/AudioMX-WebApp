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
const dialogs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  // Un alert() non traite fige le renderer, et donc tout le run. On note le
  // message et on ferme, ce qui rend aussi les alertes observables.
  if (m.method === "Page.javascriptDialogOpening") {
    dialogs.push(m.params.message);
    cmd("Page.handleJavaScriptDialog", { accept: true });
  }
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

  // Un headless a document.visibilityState === "hidden", et requestAnimationFrame
  // n'y tourne jamais. Les moniteurs live passent tous par rAF : sans ce relais,
  // ils ne dessinent rien ici et le canvas ne peut rien prouver. On remplace la
  // planification, pas la logique — l'app garde son "une frame en attente a la
  // fois", elle est juste declenchee par le timer.
  window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 0);
  window.cancelAnimationFrame = handle => clearTimeout(handle);
})()` });
await cmd("Network.setCacheDisabled", { cacheDisabled: true });
// Fenetre fixe. Sans cela le run herite de la taille laissee sur la cible par
// n'importe quel autre script, et toute assertion qui parle de "sous la ligne
// de flottaison" devient dependante de ce qui a tourne avant.
await cmd("Emulation.setDeviceMetricsOverride",
  { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

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

// Compte les pixels d'une couleur de trace sur un canvas. Les moniteurs live ne
// renvoient rien et n'existent qu'en cours de capture : seul le canvas peut
// dire s'ils dessinent. Un abonnement au bus manquant les avait laisses vides
// pendant plusieurs commits sans qu'aucune assertion ne bronche.
const traced = async (canvasId, [r, g, b]) => ev(`(()=>{
  const cv = document.getElementById('${canvasId}');
  if (!cv) return -1;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4)
    if (Math.abs(d[i]-${r}) < 40 && Math.abs(d[i+1]-${g}) < 40 && Math.abs(d[i+2]-${b}) < 40) n++;
  return n;
})()`);
// Une seule couleur de trace dans toute l'app, cote R&D comme cote clinique :
// PLOT.trace dans src/ui/theme.ts. Depuis le passage aux surfaces sombres du
// langage 1A, c'est un bleu clair — le seul qui ait du poids sur #0e1420.
const TRACE = [91, 155, 224];    // = PLOT.trace (#5b9be0)

// Un seul releve tombe parfois entre un effacement et un trace : les moniteurs
// live redessinent sur rAF (relaye en setTimeout ici) et l'instant du releve
// n'est synchronise avec rien. On echantillonne en continu et on garde le
// maximum — l'assertion reste "il a bien dessine pendant la capture", elle
// cesse juste de dependre du moment ou on regarde.
//
// L'echantillonnage EST l'attente, il ne s'y ajoute pas. Le faire apres coup
// prolongeait la capture d'une seconde : la prise sortait a 4 s la ou
// l'assertion de duree en attend 2. Un correctif de flake qui fabrique un
// echec ailleurs n'est pas un correctif.
const TRACE_CLEARLY_DRAWN = 800;   // largement au-dessus du seuil des assertions
const tracedPeakDuring = async (canvasIds, colour, totalMs) => {
  const best = canvasIds.map(() => 0);
  const until = Date.now() + totalMs;
  while (Date.now() < until) {
    // Chaque releve est un aller-retour CDP plus un getImageData : les
    // enchainer sans repit vole du temps CPU au worklet audio et raccourcit la
    // prise. Des que la reponse est acquise, on arrete de regarder et on laisse
    // la capture se derouler.
    if (!best.every(v => v >= TRACE_CLEARLY_DRAWN)) {
      for (let i = 0; i < canvasIds.length; i++) {
        best[i] = Math.max(best[i], await traced(canvasIds[i], colour));
      }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return best;
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
// Le filtre 404 ci-dessus exempte favicon ; cette assertion verifie l'inverse,
// que l'icone existe vraiment et que %BASE_URL% a bien ete substitue.
T("favicon servie", (await ev(
  "fetch(document.querySelector('link[rel=icon]').href).then(r => r.status)")) === 200);

// --- 1c. navigation ---
// Trois mecanismes de bascule vivent dessous — setAppMode, showTab,
// setClinicalTab — et une seule barre les pilote. Ce qui casse en silence ici,
// c'est la synchro : la barre lit le DOM au lieu de retenir le dernier clic,
// precisement parce que du code navigue aussi (bouton Analyze d'une prise,
// ouverture d'une ligne patient). Une barre qui retiendrait serait fausse a
// chacun de ces appels, sans lever quoi que ce soit.
const navClick = async section => {
  await ev(`document.querySelector('.navBtn[data-nav="${section}"]').click()`);
  await new Promise(r => setTimeout(r, 150));
};
const visible = async id => ev(`(()=>{const n=document.getElementById('${id}');return !!n && !n.hidden})()`);
const navActive = async () => ev(
  "[...document.querySelectorAll('.navBtn.active')].map(b=>b.dataset.nav).join(',')");

// --- 1b. page vitrine ---
// L'app ouvre sur la page produit, pas sur l'outil. Elle remplace toute la
// coque applicative — en-tete et barre comprises — parce qu'elle s'adresse a
// quelqu'un qui n'a pas encore decide de s'en servir.
T("l'app ouvre sur la page produit",
  (await visible("landingMode")) === true && (await visible("appShell")) === false);

// La trace de l'ecran du device est dessinee des le premier rendu, pas a la
// premiere frame : requestAnimationFrame ne tourne pas dans une page cachee
// (onglet en arriere plan, navigateur headless) et l'ecran resterait vide.
T("la trace de l'ecran est faite sans attendre une frame",
  (await ev("(document.getElementById('lScreenWave').getAttribute('d')||'').length")) > 200);
// Les polices sont hebergees localement : un CDN de police est une dependance
// reseau que le service worker ne peut pas satisfaire hors ligne.
T("aucune police chargee depuis un CDN externe",
  (await ev("[...document.querySelectorAll('link')].every(l => !/fonts\\.(googleapis|gstatic)/.test(l.href))")) === true);
// La pile de la maquette : SF Pro d'abord (donc ce que rendent les captures sur
// Mac), Geist auto-heberge en repli pour tout le reste.
const displayStack = await ev("getComputedStyle(document.querySelector('.lTitle')).fontFamily");
T("la pile typographique est celle de la maquette",
  /SF Pro/.test(displayStack) && /Geist/.test(displayStack), displayStack);

// Moitie manquante de l'assertion plus bas : verifier qu'un element est VISIBLE
// une fois atteint ne prouve rien s'il n'a jamais ete masque. Au chargement, la
// bande de specs est sous la ligne de flottaison et doit etre invisible.
T("les cellules de specs sont masquees tant qu'on ne les atteint pas",
  (await ev("getComputedStyle(document.querySelector('.lSpec')).opacity")) === "0");

// "Request a demo" est la seule porte d'entree vers l'app.
await ev("document.querySelector('.lBtn[data-nav=\"home\"]').click()");
await new Promise(r => setTimeout(r, 250));
T("« Request a demo » ouvre l'app",
  (await visible("appShell")) === true && (await visible("landingMode")) === false &&
  (await visible("homeMode")) === true && (await navActive()) === "home");

// Et le logo de l'en-tete est la sortie.
await ev("document.querySelector('.topBar .brand').click()");
await new Promise(r => setTimeout(r, 250));
T("le logo de l'en-tete revient a la page produit",
  (await visible("landingMode")) === true && (await visible("appShell")) === false);
await ev("document.querySelector('.lNavDemo').click()");
await new Promise(r => setTimeout(r, 250));
T("bouton Overview actif une fois dans l'app", (await navActive()) === "home");

// Les elements reveles sont masques par une classe posee en JS, puis reveles par
// un test de rectangle dans la boucle d'animation. Ni IntersectionObserver ni
// les evenements scroll ne se declenchent dans une page cachee : un contenu qui
// en dependrait resterait invisible pour toujours, sans lever d'erreur.
await ev("document.querySelector('.topBar .brand').click()");
await new Promise(r => setTimeout(r, 200));
await ev("document.querySelector('.lSpecs').scrollIntoView()");
await new Promise(r => setTimeout(r, 1200));
// Deux choses, et la distinction compte.
//
// 1. La classe .in est bien posee. C'est LE mecanisme qui etait casse avant :
//    un IntersectionObserver ne se declenche pas dans une page cachee, donc la
//    classe n'arrivait jamais et le contenu restait invisible pour toujours.
// 2. L'etat revele est declare, pas seulement interpole. On coupe les
//    transitions avant de lire : une transition a exactement le meme defaut
//    qu'une animation — sa valeur courante ne progresse pas dans une page qui
//    n'est jamais affichee. La question utile n'est donc pas "l'opacite vaut-
//    elle 1 maintenant" mais "vaudrait-elle 1 si la transition ne tournait
//    jamais", ce qui est la garantie qu'on veut vraiment.
T("la classe de reveal est bien posee",
  (await ev("document.querySelector('.lSpec').classList.contains('in')")) === true);
await ev(`(()=>{const s=document.createElement('style');
  s.id='amxNoTransition';
  s.textContent='#landingMode *{transition:none !important;animation:none !important}';
  document.head.appendChild(s)})()`);
await new Promise(r => setTimeout(r, 120));
T("le contenu revele reste visible sans transition",
  (await ev("getComputedStyle(document.querySelector('.lSpec')).opacity")) === "1");
await ev("document.getElementById('amxNoTransition')?.remove()");
await ev("scrollTo(0,0); document.querySelector('.lNavDemo').click()");
await new Promise(r => setTimeout(r, 250));

await navClick("record");
T("nav -> Record bascule le mode ET l'onglet",
  (await visible("rndMode")) === true &&
  (await ev("document.querySelector('.view.activeView')?.id")) === "recordView" &&
  (await navActive()) === "record");

await navClick("chart");
T("nav -> Chart traverse les deux mecanismes",
  (await visible("clinicalMode")) === true && (await visible("clinChart")) === true &&
  (await navActive()) === "chart");

await navClick("record");
await ev("audiomx.tabs.showTab('analyzeView')"); await new Promise(r => setTimeout(r, 100));
T("la barre suit une navigation declenchee par du code", (await navActive()) === "analyze");
// Cote clinique, le meme cas : ouvrir une ligne patient appelle
// setClinicalTab() sans passer par la barre.
await navClick("patients");
await ev("audiomx.clinical.setClinicalTab('exam')"); await new Promise(r => setTimeout(r, 100));
T("... des deux cotes de l'app", (await navActive()) === "exam");

// L'ancienne interface affichait litteralement deux onglets actifs a la fois,
// un par barre. Une seule barre n'a le droit qu'a une seule reponse.
T("un seul bouton actif a la fois", !(await navActive()).includes(","));

// Laisser une ancienne barre en place reintroduirait une seconde source de
// verite sur "ou suis-je", et elle divergerait en silence.
T("plus aucune ancienne barre dans le DOM",
  (await ev("document.querySelectorAll('.tabBtn, .clinTabBtn, .modeSwitchBtn').length")) === 0);

// L'etat de connexion s'affiche a deux endroits pour une seule ecriture.
await ev("audiomx.status.setStatus('Smoke check', 'connected')");
// Compte volontairement "tous", pas un nombre : ajouter un troisieme affichage
// ne doit pas demander de retoucher l'assertion, mais en oublier un doit la
// faire tomber.
T("l'etat de connexion est mirroite partout ou il est affiche",
  (await ev("(()=>{const t=[...document.querySelectorAll('[data-status-text]')];" +
            "const d=[...document.querySelectorAll('[data-status-dot]')];" +
            "return t.length >= 3 && d.length === t.length &&" +
            " t.every(n=>n.textContent==='Smoke check') &&" +
            " d.every(n=>n.classList.contains('connected'))})()")) === true,
  (await ev("document.querySelectorAll('[data-status-text]').length")) + " affichages");
await ev("audiomx.status.setStatus('Not connected', 'idle')");

// --- 1d. page Device ---
// Les verdicts de support existaient deja et n'annotaient que les boutons, via
// un attribut `title` : invisible sur ecran tactile, a deviner ailleurs. La page
// les rend en toutes lettres. Le risque, c'est que les deux rendus divergent —
// d'ou l'assertion croisee plus bas plutot qu'un simple "il y a 3 cartes".
await navClick("device");
T("nav -> Device", (await visible("deviceMode")) === true && (await navActive()) === "device");
T("caracteristiques rendues depuis les constantes",
  (await ev("document.querySelectorAll('#deviceSpecs > div').length")) === 5 &&
  (await ev("document.getElementById('deviceSpecs').textContent")).includes(
    String(await ev("audiomx.constants.SAMPLE_RATE / 1000")) + " kHz"));
T("trois entrees decrites", (await ev("document.querySelectorAll('.transportCard').length")) === 3);

// Le meme support, rendu deux fois : badge de la carte et classe du bouton
// clinique. S'ils se contredisent, l'un des deux ment au clinicien.
const verdicts = await ev(`(()=>{
  const card = [...document.querySelectorAll('.transportCard')].map(c =>
    c.querySelector('.transportBadge').classList.contains('ok'));
  const btn = ['cConnectUsb','cConnectWifi','cConnectComputer'].map(id =>
    !document.getElementById(id).classList.contains('unsupported'));
  return JSON.stringify(card) + '|' + JSON.stringify(btn);
})()`);
T("cartes et boutons donnent le meme verdict",
  verdicts && verdicts.split("|")[0] === verdicts.split("|")[1], verdicts);

// Ici les trois entrees sont disponibles, donc les deux assertions ci-dessus
// seraient vraies meme si la page ne rendait jamais d'indisponibilite. On
// simule le seul cas qui compte vraiment — Safari et iPad n'ont pas Web Serial
// et n'en auront jamais — en retirant navigator.serial, puis on redemande le
// rendu. La raison de serialSupport() est ecrite pour ce cas precis.
await ev(`(()=>{
  const proto = Object.getPrototypeOf(navigator);
  window.__serialDescriptor = Object.getOwnPropertyDescriptor(proto, 'serial');
  delete proto.serial;
})()`);
await ev("audiomx.reflectSupport.reflectDeviceSupport()");
await new Promise(r => setTimeout(r, 150));

const degraded = await ev(`(()=>{
  const bad = [...document.querySelectorAll('.transportCard.unavailable')];
  const withReason = bad.filter(c => (c.querySelector('.transportReason')?.textContent||'').length > 30);
  const card = [...document.querySelectorAll('.transportCard')].map(c =>
    c.querySelector('.transportBadge').classList.contains('ok'));
  const btn = ['cConnectUsb','cConnectWifi','cConnectComputer'].map(id =>
    !document.getElementById(id).classList.contains('unsupported'));
  return JSON.stringify({ bad: bad.length, withReason: withReason.length,
    agree: JSON.stringify(card) === JSON.stringify(btn), card });
})()`);
const d = degraded ? JSON.parse(degraded) : null;
T("sans Web Serial, l'entree USB passe indisponible", d?.bad === 1 && d?.card?.[0] === false, degraded);
T("et elle affiche sa raison en toutes lettres", d?.withReason === 1);
T("cartes et boutons restent d'accord en mode degrade", d?.agree === true);

await ev(`(()=>{
  if (window.__serialDescriptor)
    Object.defineProperty(Object.getPrototypeOf(navigator), 'serial', window.__serialDescriptor);
})()`);
await ev("audiomx.reflectSupport.reflectDeviceSupport()");
T("navigator.serial restaure",
  (await ev("document.querySelectorAll('.transportCard.unavailable').length")) === 0);

// Le champ d'adresse Wi-Fi a demenage du banc R&D vers cette page ; le
// transport doit toujours le lire.
T("l'adresse Wi-Fi vit sur la page Device",
  (await ev("!!document.getElementById('deviceMode').querySelector('#wifiUrlInput')")) === true &&
  (await ev("audiomx.wifiSource.getWifiUrl()")) === "ws://192.168.4.1:81");

await navClick("home");

// --- 1b. config Epic ---
// Rien ici ne leve d'exception quand c'est faux : Epic repond "error=4" a
// l'autre bout, des minutes plus tard, sans rien dire de la cause. Ces valeurs
// partent dans l'URL de login, donc c'est ici qu'on les verifie.
const epic = await ev(`({
  clientId: audiomx.ehrConfig.SMART.clientId,
  scope: audiomx.ehrConfig.SMART.scope,
  redirect: audiomx.ehrConfig.redirectUri(),
})`);
// Doit etre enregistree telle quelle chez Epic, sinon error=4.
T("redirect_uri = base de l'app", epic?.redirect === BASE, epic?.redirect);
T("client id = app Clinician (non-prod)",
  epic?.clientId === "09a25bf9-07e2-4e13-b27d-486d885d5bde", epic?.clientId);
// Une app d'audience Clinicians agit au nom du clinicien : des scopes patient/
// seraient un retour a l'ancienne inscription, et Epic les refuserait.
T("scopes en user/ et non patient/",
  /user\//.test(epic?.scope || "") && !/patient\//.test(epic?.scope || ""), epic?.scope);
T("Patient.read demande", /user\/Patient\.read/.test(epic?.scope || ""));

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
  // Apres effacement : PLOT.bg partout. La valeur est lue depuis le module, pas
  // recopiee ici — une assertion qui repete un litteral de couleur doit etre
  // reeditee a chaque evolution du design, et signale cette edition comme une
  // panne. C'est exactement ce qui vient d'arriver avec #0e0e14.
  const hex = audiomx.theme.PLOT.bg;
  const want = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16));
  const blank = c.getImageData(0, 0, cv.width, cv.height).data;
  let cleared = true;
  for (let i = 0; i < blank.length; i += 4)
    if (blank[i] !== want[0] || blank[i+1] !== want[1] || blank[i+2] !== want[2]) { cleared = false; break; }

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
// LE test du correctif audio. On bloque volontairement le fil principal 600 ms
// en pleine capture — ce que fait, en plus discret, le dessin des courbes et la
// FFT du spectre live pendant un examen. Un ScriptProcessorNode y perd ses
// blocs en retard, et la prise ressort trouee et plus courte. Un AudioWorklet
// tourne sur le fil audio : les blocs arrivent en retard, pas en moins.
// L'assertion de duree ci-dessous est ce qui le mesure.
await ev("setTimeout(() => { const end = performance.now() + 600;" +
  " while (performance.now() < end); }, 700)");
await ev("audiomx.app.startRecording()");
// Pendant la capture, pas apres : les moniteurs live sont effaces a l'arret.
const [rndWave, rndSpec] = await tracedPeakDuring(["waveform", "liveSpectrum"], TRACE, 2000);
// Un demi-bloc de plus avant l'arret, pour que la queue ne soit pas vide par
// hasard. Sans ce decalage, l'arret peut tomber pile sur une frontiere de bloc
// et l'assertion sur la queue ne mesure plus rien.
await new Promise(r => setTimeout(r, 130));
await ev("audiomx.app.stopRecording()"); await new Promise(r => setTimeout(r, 1200));
T("forme d'onde live dessinee (R&D)", rndWave > 200, rndWave + " px de trace");
T("spectre live dessine (R&D)", rndSpec > 200, rndSpec + " px de trace");
T("enregistrement sauvegarde", (await ev("audiomx.state.library.recordings.length")) === 1);

// "Analyze FFT" existe aussi sur une prise rangee dans le dossier d'un patient,
// donc cliquee depuis le mode clinique. Elle appelait showTab(), qui activait
// l'onglet dans un conteneur masque : la vue devenait active et rien
// n'apparaissait. Le bouton passe par la barre, qui bascule aussi le mode.
await ev("audiomx.app.setAppMode('clinical')");
await ev("audiomx.libraryView.analyzeRecording(audiomx.state.library.recordings[0].id)");
await new Promise(r => setTimeout(r, 250));
T("Analyze depuis le mode clinique arrive sur une vue visible",
  (await visible("rndMode")) === true &&
  (await ev("document.querySelector('.view.activeView')?.id")) === "analyzeView");
await ev("audiomx.app.setAppMode('rnd')");
// La duree est quantifiee par blocs de 4096 trames (0,256 s) : le reste, encore
// dans le tampon du worklet a l'arret, n'arrive jamais. 2 s de capture donnent
// donc 7 blocs complets = 1,792 s, et c'est normal. Un bloc PERDU ferait 1,536.
// Le seuil est place entre les deux, sinon l'assertion ne distingue rien.
const capturedSeconds = await ev("audiomx.state.library.recordings[0]?.duration");
const blockSeconds = 4096 / 16000;
T("aucun bloc perdu malgre 600 ms de fil principal bloque",
  capturedSeconds > 2 - blockSeconds - 0.02,
  capturedSeconds + " s ; un bloc perdu donnerait " + (capturedSeconds - blockSeconds).toFixed(3));

// La queue de la prise. Un bloc n'est poste qu'une fois plein, donc a l'arret
// il en restait jusqu'a 256 ms jamais livrees — perdues en silence, y compris
// sur le test de temps de phonation maximal dont c'est justement le resultat.
// Sans le drainage, le total est TOUJOURS un multiple exact de la taille de
// bloc ; avec, il ne l'est quasiment jamais. C'est ce qui separe les deux.
const capturedFrames = await ev("audiomx.state.library.recordings[0]?.frames");
T("la queue de la prise est bien livree", capturedFrames % 4096 !== 0,
  capturedFrames + " trames = " + (capturedFrames / 4096).toFixed(3) + " blocs");
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

// --- 3b. le warm-up jette bien le pre-roll --------------------------------
// Un ScriptProcessor livre un buffer qui se remplissait deja avant le Start :
// sans ce rejet, la prise s'ouvre sur l'instant d'avant — et en clinique sur
// le bip de depart, qui fausserait F0/HNR/jitter calcules sur toute la prise.
const warm = await ev(`(()=>{
  const c = audiomx.state.capture;
  const block = new Int16Array(4096).fill(1000);
  const preRoll = audiomx.computerMicSource.preRollFrames();

  c.recording = true; c.chunks = []; c.frames = 0; c.values = 0; c.live = [];
  c.warmupFrames = preRoll;
  audiomx.recorder.ingest(block, 1);
  const afterFirst = c.frames;
  audiomx.recorder.ingest(block, 1);
  const afterSecond = c.frames;
  c.recording = false; c.chunks = []; c.frames = 0; c.values = 0; c.live = [];
  return { preRoll, afterFirst, afterSecond };
})()`);
// La capture tourne sur le fil audio quand le navigateur le permet. C'est LA
// difference entre un bloc en retard et un bloc perdu : un callback de
// ScriptProcessor arrive en retard est jete, avec l'audio qu'il portait.
T("la capture tourne sur le fil audio (AudioWorklet)",
  (await ev("audiomx.computerMicSource.captureMode()")) === "worklet",
  await ev("audiomx.computerMicSource.captureMode()"));

// Sur le chemin worklet, le pre-roll vaut zero — non pas parce qu'on renonce a
// le traiter, mais parce que le worklet vide son tampon partiel au Start.
// Garder un rejet non nul y jetterait un bloc d'audio d'APRES le Start.
T("pas de pre-roll a jeter sur le chemin worklet", warm?.preRoll === 0,
  warm ? warm.preRoll + " trames" : "-");
T("rien n'est jete quand le pre-roll est nul", warm?.afterFirst === 4096);
T("le bloc suivant s'ajoute", warm?.afterSecond === 8192, warm?.afterSecond + " trames");

// --- 4. clinique ---
await ev("audiomx.app.setAppMode('clinical'); audiomx.clinical.setClinicalTab('patients')");
await ev("document.getElementById('cNpId').value='PT-SMOKE'; document.getElementById('cNpName').value='Test'; document.getElementById('cNewPatientForm').requestSubmit()");
await new Promise(r => setTimeout(r, 700));
T("patient cree", (await ev("audiomx.clinical.clinicalStateAccess.patients.length")) === 1);
T("patient ouvert", (await ev("audiomx.clinical.clinicalStateAccess.patient?.id")) === "PT-SMOKE");

// La table patients de la reference 2B : un en-tete et des lignes sur la meme
// grille, et deux chiffres derives (sessions, derniere session). Le risque
// propre a une table construite en deux morceaux, c'est que l'en-tete et les
// lignes n'aient pas le meme nombre de colonnes.
const table = await ev(`(()=>{
  const head = document.querySelector('#cPatientTable .patientRowHead');
  const row = document.querySelector('#cPatientTable .patientRow:not(.patientRowHead)');
  if (!head || !row) return null;
  const cols = n => getComputedStyle(n).gridTemplateColumns.split(' ').length;
  return { headCells: head.children.length, rowCells: row.children.length,
           sameGrid: cols(head) === cols(row),
           counts: document.getElementById('cPatientCounts')?.textContent };
})()`);
T("en-tete et lignes partagent la meme grille",
  table && table.headCells === table.rowCells && table.sameGrid === true,
  table ? `${table.headCells} vs ${table.rowCells} colonnes` : "table absente");
T("les compteurs patients/sessions sont derives",
  /^1 patient · \d+ session/.test(table?.counts || ""), table?.counts);
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
await new Promise(r => setTimeout(r, 7000));   // 5 s de decompte + bip de depart + marge
T("le decompte a lance l'enregistrement", (await ev("audiomx.state.capture.recording")) === true);

const [clinWave, clinSpec] = await tracedPeakDuring(["cWaveform", "cSpectrum"], TRACE, 2000);
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
// Le clinicien doit voir le signal pendant l'examen, pas seulement l'entendre
// apres coup : c'est ce qui lui dit que le micro capte vraiment.
T("forme d'onde live dessinee (clinique)", clinWave > 200, clinWave + " px de trace");
T("spectre live dessine (clinique)", clinSpec > 200, clinSpec + " px de trace");
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

// --- 4b. emplacement du modele de risque ---
// storage/riskModel.ts definissait la couture depuis la migration et personne
// ne lui demandait rien : le chart imprimait "pending model" en dur. Un
// litteral est pire qu'un emplacement vide, parce qu'il reste credible le jour
// ou un vrai modele repond — l'app afficherait "pending" par-dessus un score.
await ev("audiomx.clinical.setClinicalTab('chart')");
await new Promise(r => setTimeout(r, 500));
const noModel = await ev(`(()=>{
  const s = document.querySelector('#clinChart .riskSlot');
  if (!s) return 'aucun emplacement';
  return s.querySelector('.riskBadge')?.textContent + '|' + s.textContent;
})()`);
T("sans modele : dit non connecte", /^not connected\|/.test(noModel || ""), (noModel || "").slice(0, 40));
// Le vrai danger, c'est un chiffre affiche a cote d'un patient sans modele
// derriere. Aucun chiffre ne doit sortir de cet emplacement.
T("sans modele : aucun chiffre affiche",
  !/\d+\.\d+/.test((noModel || "").split("|")[1] || ""));

// Un faux modele installe par la couture prevue. Prouve que l'emplacement
// rend un vrai resultat, ce qu'un texte en dur ne ferait jamais.
await ev(`audiomx.riskModel.setRiskModel({
  id: 'smoke-model', version: '1.2',
  isAvailable: async () => true,
  score: async () => ({ modelId: 'smoke-model', modelVersion: '1.2',
    computedAt: new Date().toISOString(),
    scores: [{ label: 'Dysphonia', value: 0.42, ci: [0.31, 0.55] }] }),
})`);
await ev("audiomx.clinical.setClinicalTab('patients'); audiomx.clinical.setClinicalTab('chart')");
await new Promise(r => setTimeout(r, 500));
T("avec modele : propose de scorer", (await ev(
  "document.querySelector('#clinChart .riskSlot .smallBtn')?.textContent")) === "Score this take");
await ev("document.querySelector('#clinChart .riskSlot .smallBtn').click()");
await new Promise(r => setTimeout(r, 500));
const scored = await ev("document.querySelector('#clinChart .riskSlot')?.textContent || ''");
T("avec modele : le score rendu vient du modele",
  scored.includes("Dysphonia") && scored.includes("0.42") && scored.includes("smoke-model"),
  scored.slice(0, 60));
await ev("audiomx.riskModel.setRiskModel(audiomx.riskModel.nullRiskModel)");

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

// window.open renvoie null quand un bloqueur de pop-up intervient — et sur iOS,
// une app installee sur l'ecran d'accueil n'a tout simplement pas de seconde
// fenetre a donner. Le bouton restait muet, ce qui est indiscernable d'un
// bouton mort. On stubbe window.open pour reproduire le cas exactement.
dialogs.length = 0;
const popupBlocked = await ev(`(() => {
  const real = window.open;
  window.open = () => null;
  const before = document.getElementById('log').textContent.length;
  document.getElementById('cPopoutBtn').click();
  window.open = real;
  return document.getElementById('log').textContent.slice(before);
})()`);
T("pop-out bloque : le clinicien est prevenu", dialogs.length === 1 && /blocked/i.test(dialogs[0] || ""),
  (dialogs[0] || "aucune alerte").slice(0, 60));
T("pop-out bloque : l'adresse de repli est donnee", /patient\.html/.test(dialogs[0] || ""));
T("pop-out bloque : trace dans le journal", /blocked/i.test(popupBlocked || ""),
  (popupBlocked || "rien").trim().slice(0, 60));
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

// --- 8. PWA : installable, puis reellement hors ligne ---
// Place en dernier : la coupure reseau plus bas fait remonter des erreurs
// console legitimes, qui fausseraient l'assertion d'exceptions ci-dessus.
const pwa = await ev(`(async () => {
  const link = document.querySelector('link[rel=manifest]');
  if (!link) return { error: 'pas de <link rel=manifest>' };
  const res = await fetch(link.href);
  if (!res.ok) return { error: 'manifest HTTP ' + res.status };
  const m = await res.json();
  // Les URL du manifeste sont relatives — c'est ce qui le fait marcher a la
  // fois sur "/" en dev et sur "/AudioMX-WebApp/" en prod, sans substitution
  // (Vite ne touche pas aux fichiers de public/). On resout comme le navigateur.
  const abs = p => new URL(p, link.href).href;
  return {
    start: abs(m.start_url),
    scope: abs(m.scope),
    display: m.display,
    maskable: m.icons.some(i => i.purpose === 'maskable'),
    iconCodes: await Promise.all(m.icons.map(i => fetch(abs(i.src)).then(r => r.status))),
    // Opaque obligatoire : iOS aplatit une apple-touch-icon transparente sur du noir.
    appleOpaque: await new Promise(done => {
      const el = document.querySelector('link[rel="apple-touch-icon"]');
      if (!el) return done(0);
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = img.width; cv.height = img.height;
        cv.getContext('2d').drawImage(img, 0, 0);
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return done(false);
        done(img.width);
      };
      img.onerror = () => done(0);
      img.src = el.href;
    }),
    viewport: document.querySelector('meta[name=viewport]')?.content || '',
  };
})()`);
T("manifest servi et valide", !pwa?.error, pwa?.error || "");
T("start_url = base de l'app", pwa?.start === BASE, pwa?.start);
T("scope = base de l'app", pwa?.scope === BASE, pwa?.scope);
T("display standalone", pwa?.display === "standalone", pwa?.display);
T("icones du manifeste servies", pwa?.iconCodes?.length === 3 && pwa.iconCodes.every(c => c === 200),
  String(pwa?.iconCodes));
T("une icone maskable declaree", pwa?.maskable === true);
T("apple-touch-icon 180px et opaque", pwa?.appleOpaque === 180, String(pwa?.appleOpaque));
// Sans ce meta, iOS met en page a 980px : les breakpoints de style.css ne se
// declenchent jamais et le CSS responsive existant est du code mort.
T("meta viewport presente", /width=device-width/.test(pwa?.viewport || ""), pwa?.viewport);

if (process.argv[2] === "preview") {
  // Ardoise propre, sinon on teste le worker laisse par le run precedent.
  await ev(`(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    return true;
  })()`);
  await go();   // install + claim ; la page a deja fini ses fetch, cache vide
  await ev("navigator.serviceWorker.ready.then(() => true)");
  await go();   // 2e chargement : tout passe par le worker, le cache se remplit
  T("worker controle la page", (await ev("!!navigator.serviceWorker.controller")) === true);
  T("scope du worker = base de l'app",
    (await ev("navigator.serviceWorker.controller?.scriptURL")) === BASE + "sw.js");

  await cmd("Network.emulateNetworkConditions",
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await go();
  // La vraie question n'est pas "le worker est-il enregistre" mais "l'app
  // demarre-t-elle sans reseau" : un handler fetch casse passe la premiere et
  // echoue la seconde.
  T("l'app demarre hors ligne", (await ev("typeof audiomx?.constants?.SAMPLE_RATE")) === "number");
  T("protocole rendu hors ligne", (await ev("document.getElementById('cTestList')?.children.length")) === 6);
  // On interroge un token, pas une valeur de mise en page. Une propriete
  // personnalisee n'existe que si la feuille est bien la, alors qu'un
  // "max-width: 1240px" code en dur casse des qu'une phase de refonte change
  // legitimement la largeur — ce qui est arrive, et l'assertion a signale une
  // evolution comme une panne.
  T("CSS servi hors ligne", (await ev(
    "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")) === "#2f5d8f");
  await cmd("Network.emulateNetworkConditions",
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await go();
} else {
  // Le garde import.meta.env.PROD : un worker en dev servirait les modules
  // d'hier par-dessus le hot reload.
  T("aucun service worker en dev",
    (await ev("navigator.serviceWorker.getRegistrations().then(r => r.length)")) === 0);
}

await ev("new Promise(r=>{const q=indexedDB.deleteDatabase('acousticConsole');q.onsuccess=q.onerror=q.onblocked=()=>r(1)})");
console.log(`\n  ${fail === 0 ? "✅ TOUT PASSE" : "❌ " + fail + " ECHEC(S)"} — ${pass} ok, ${fail} ko\n`);
process.exit(fail === 0 ? 0 : 1);
