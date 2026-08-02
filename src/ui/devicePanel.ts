// The Device page: what AudioMX captures with, and what this browser can reach.
//
// The support checks already existed and already annotated the connect buttons
// (device/reflectSupport). What was missing was anywhere to *read* the reason.
// A greyed-out button carrying its explanation in a `title` attribute is not an
// explanation: on a touch screen there is no tooltip at all, and on a desktop
// you have to guess that hovering would tell you something. The reasons in
// device/support.ts are written for a clinician, and this is where they are
// finally shown as text.
//
// Both blocks are rendered from code rather than written into index.html so the
// numbers cannot drift: the sample rate and baud rate come from the same
// constants the transports and the DSP use.

import { BAUD_RATE, SAMPLE_RATE } from "../core/constants";
import { computerMicSupport, serialSupport, wifiSupport, type Support } from "../device/support";
import { el } from "./dom";

interface Transport {
  name: string;
  detail: string;
  support: Support;
  /** Where this input is connected from. The Device page describes; the pages
   *  that run a capture are where you act. */
  connectFrom: { label: string; nav: string };
}

function specs(): Array<[string, string]> {
  return [
    ["Capsules", "2 × MEMS, stereo, left or right alone"],
    ["Sample rate", (SAMPLE_RATE / 1000) + " kHz, 16-bit"],
    ["Wired", "USB-C, serial at " + BAUD_RATE.toLocaleString("en-US") + " baud"],
    ["Wireless", "Wi-Fi access point, audio over WebSocket"],
    ["Controller", "ESP32"],
  ];
}

function transportCard(transport: Transport): HTMLElement {
  const card = document.createElement("div");
  card.className = "transportCard" + (transport.support.ok ? "" : " unavailable");

  const head = document.createElement("div");
  head.className = "transportHead";

  const name = document.createElement("h3");
  name.textContent = transport.name;

  const badge = document.createElement("span");
  badge.className = "transportBadge " + (transport.support.ok ? "ok" : "no");
  badge.textContent = transport.support.ok ? "Available here" : "Unavailable here";

  head.append(name, badge);

  const detail = document.createElement("p");
  detail.className = "transportDetail";
  detail.textContent = transport.detail;

  card.append(head, detail);

  // The reason only exists when something is wrong, and it is the whole point
  // of the card when it does.
  if (!transport.support.ok) {
    const reason = document.createElement("p");
    reason.className = "transportReason";
    reason.textContent = transport.support.reason;
    card.appendChild(reason);
  } else {
    const link = document.createElement("button");
    link.className = "transportLink";
    link.dataset["nav"] = transport.connectFrom.nav;
    link.textContent = transport.connectFrom.label + " →";
    card.appendChild(link);
  }

  return card;
}

/** Redraw the Device page. Called from reflectDeviceSupport(), so it is always
 *  in step with the connect buttons rather than a second opinion about them. */
export function renderDevicePanel(wifiUrl: string): void {
  const specHost = el("deviceSpecs");
  if (specHost) {
    specHost.replaceChildren(...specs().map(([term, value]) => {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      row.append(dt, dd);
      return row;
    }));
  }

  const host = el("transportList");
  if (!host) return;

  const transports: Transport[] = [
    {
      name: "MEMS over USB-C",
      detail: "The device plugged into this computer, streaming over a serial port.",
      support: serialSupport(),
      connectFrom: { label: "Connect on the Exam page", nav: "exam" },
    },
    {
      name: "MEMS over Wi-Fi",
      detail: "The device as its own access point, streaming over a WebSocket.",
      support: wifiSupport(wifiUrl),
      connectFrom: { label: "Connect on the Exam page", nav: "exam" },
    },
    {
      name: "Computer microphone",
      detail: "The machine's own input. Always the fallback, never the reference.",
      support: computerMicSupport(),
      connectFrom: { label: "Connect on the Exam page", nav: "exam" },
    },
  ];

  host.replaceChildren(...transports.map(transportCard));
}
