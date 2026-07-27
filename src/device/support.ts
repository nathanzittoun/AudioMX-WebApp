// Can this browser, on this page, actually use each input?
//
// Feature detection only — never user-agent sniffing. Sniffing guesses at a
// capability from a string that lies; detection asks the API whether it exists.
// It is also what keeps iOS working: Safari on iPad has no Web Serial and never
// will, so the USB path must report that as a fact rather than crash or alert.
//
// Every failure carries a reason written for the clinician, because "the button
// is greyed out" with no explanation is indistinguishable from a broken app.

export type Support = { ok: true } | { ok: false; reason: string };

const OK: Support = { ok: true };

/** MEMS over USB — Web Serial. Chrome/Edge on a computer only. */
export function serialSupport(): Support {
  if (!("serial" in navigator)) {
    return {
      ok: false,
      reason:
        "USB needs Chrome or Edge on a computer. Safari and iPad do not support " +
        "Web Serial — use Wi-Fi or the computer microphone there.",
    };
  }
  return OK;
}

/** The computer's own microphone — getUserMedia. */
export function computerMicSupport(): Support {
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason:
        "Microphone access needs a secure page. Open the app over https, or " +
        "over http://localhost during development.",
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: "This browser does not expose microphone capture." };
  }
  return OK;
}

/**
 * MEMS over Wi-Fi — WebSocket to the device.
 *
 * The interesting case is mixed content: a page served over https is forbidden
 * from opening an unencrypted ws:// socket, and the failure is silent — the
 * socket simply never opens, which looks exactly like a dead device. The ESP32
 * speaks ws:// at a bare LAN address, which cannot hold a TLS certificate, so
 * this is a real constraint of the current firmware and not a bug to fix here.
 */
export function wifiSupport(url: string, protocol: string = location.protocol): Support {
  if (protocol === "https:" && url.startsWith("ws://")) {
    return {
      ok: false,
      reason:
        "A page served over https cannot open an unencrypted ws:// connection, " +
        "so the microphone is unreachable from the published site. Run the app " +
        "over http://localhost, or have the device connect out over wss://.",
    };
  }
  return OK;
}
