// EHR (Epic) integration for the Clinical area — bridges the SMART on FHIR
// client (smart.js) into AudioMX's UI so a clinician can connect to Epic,
// pull the patient's chart, and (later) file voice-biomarker results.
//
// This is a standalone SMART launch: clicking "Connect to Epic" redirects the
// whole page to Epic's login and back to this app. On return we finish the
// OAuth handshake (smartHandleRedirect) and show the patient — read-only for
// now, which is the part Epic fully supports from a patient/standalone launch.

function ehrEl(id) { return document.getElementById(id); }

function setEhrStatus(text, kind) {
  const el = ehrEl("cEhrStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "clinEhrStatus" + (kind ? " " + kind : "");
}

function ehrPatientName(p) {
  if (p.name && p.name[0]) {
    return p.name[0].text ||
      [(p.name[0].given || []).join(" "), p.name[0].family].filter(Boolean).join(" ");
  }
  return p.id;
}

// Show the exact redirect URI (and warn if this page can't be it) so a
// mismatch with the Epic registration is obvious before the user connects.
function renderEhrHint() {
  const hint = ehrEl("cEhrHint");
  if (!hint) return;
  const onHost = !(location.protocol === "file:" ||
    /^(127\.0\.0\.1|localhost)/.test(location.host));
  if (onHost) {
    hint.className = "clinEhrHint";
    hint.textContent = "Sign-in returns to " + SMART.redirectUri +
      " — this must be registered on Epic.";
  } else {
    hint.className = "clinEhrHint warn";
    hint.textContent = "⚠ Open the app at " + SMART.redirectUri +
      " to connect to Epic — a local/Live Server URL will be rejected.";
  }
}

async function initEhr() {
  const connectBtn = ehrEl("cEhrConnect");
  if (connectBtn) connectBtn.addEventListener("click", connectEhr);
  const pullBtn = ehrEl("cEhrPull");
  if (pullBtn) pullBtn.addEventListener("click", pullEhrChart);
  renderEhrHint();

  // If Epic just redirected us back (URL has ?code=…), finish the login and
  // jump the user to the Exam tab where the EHR panel lives.
  try {
    const done = await smartHandleRedirect();
    if (done) {
      if (typeof setAppMode === "function") setAppMode("clinical");
      if (typeof setClinicalTab === "function") setClinicalTab("exam");
      await afterEhrConnected();
    }
  } catch (e) {
    setEhrStatus("Error: " + e.message, "err");
    if (typeof log === "function") log("EHR error: " + e.message);
  }
}

async function connectEhr() {
  try {
    setEhrStatus("Redirecting to Epic…");
    await smartLaunch(); // navigates away to Epic
  } catch (e) {
    setEhrStatus("Error: " + e.message, "err");
  }
}

async function afterEhrConnected() {
  setEhrStatus("✓ Connected", "ok");
  const connectBtn = ehrEl("cEhrConnect");
  if (connectBtn) connectBtn.textContent = "Reconnect";
  const pullBtn = ehrEl("cEhrPull");
  if (pullBtn) pullBtn.style.display = "";

  try {
    const p = await smartLoadPatient();
    const name = ehrPatientName(p);
    ehrEl("cEhrPatient").innerHTML =
      "<strong>" + name + "</strong> · " + (p.gender || "?") +
      " · DOB " + (p.birthDate || "?") +
      " <span class='ehrId'>Epic id " + p.id + "</span>";
    if (typeof log === "function") log("EHR: connected to Epic, loaded " + name + ".");
  } catch (e) {
    ehrEl("cEhrPatient").textContent = "Connected, but could not load patient: " + e.message;
  }
}

async function pullEhrChart() {
  const box = ehrEl("cEhrObs");
  box.innerHTML = "<div class='empty'>Loading observations from Epic…</div>";
  try {
    const bundle = await smartListObservations();
    const entries = (bundle.entry || [])
      .filter(e => e.resource && e.resource.resourceType === "Observation");

    if (!entries.length) {
      box.innerHTML = "<div class='empty'>No lab/vital observations found for this patient.</div>";
      return;
    }

    let html = "<div class='ehrObsHead'>" + entries.length + " observation(s) from Epic</div><ul class='ehrObsList'>";
    for (const e of entries) {
      const o = e.resource;
      const label = (o.code && (o.code.text ||
        (o.code.coding && o.code.coding[0] && o.code.coding[0].display))) || "Observation";
      const val = o.valueQuantity
        ? (o.valueQuantity.value + (o.valueQuantity.unit ? " " + o.valueQuantity.unit : ""))
        : (o.valueString || "");
      const when = o.effectiveDateTime ? new Date(o.effectiveDateTime).toLocaleDateString() : "";
      html += "<li><strong>" + label + "</strong>: " + val +
        (when ? " <span class='ehrObsDate'>(" + when + ")</span>" : "") + "</li>";
    }
    html += "</ul>";
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = "<div class='empty'>Could not read observations: " + e.message + "</div>";
  }
}
