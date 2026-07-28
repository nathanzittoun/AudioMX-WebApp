// Show capability on the connect buttons, in both R&D and Clinical.
//
// An unsupported input is disabled with its reason as the tooltip, instead of
// the previous behaviour: USB raised a dead-end alert only after being clicked,
// and Wi-Fi over https failed silently with no message at all.

import { el } from "../ui/dom";
import { renderDevicePanel } from "../ui/devicePanel";
import { computerMicSupport, serialSupport, wifiSupport, type Support } from "./support";

/** Default endpoint, mirrored from the Wi-Fi input's initial value. */
const DEFAULT_WIFI_URL = "ws://192.168.4.1:81";

function currentWifiUrl(): string {
  const input = el<HTMLInputElement>("wifiUrlInput");
  return input?.value.trim() || DEFAULT_WIFI_URL;
}

/**
 * `disable` is opt-in because setInputSource() in app.js owns the `disabled`
 * flag of the R&D buttons and drives it from the selected source. Fighting it
 * would produce a button whose state flickers with the last writer. The
 * clinical buttons have no such logic, so there we can disable outright.
 */
function apply(buttonId: string, support: Support, disable: boolean): void {
  const button = el<HTMLButtonElement>(buttonId);
  if (!button) return;

  button.classList.toggle("unsupported", !support.ok);

  if (support.ok) {
    button.removeAttribute("title");
    button.removeAttribute("aria-disabled");
    if (disable) button.disabled = false;
  } else {
    button.title = support.reason;
    button.setAttribute("aria-disabled", "true");
    if (disable) button.disabled = true;
  }
}

/** Re-evaluate every connect control. Safe to call repeatedly. */
export function reflectDeviceSupport(): void {
  const serial = serialSupport();
  const mic = computerMicSupport();
  const wifi = wifiSupport(currentWifiUrl());

  // R&D: annotate only. connectBtn dispatches to USB or the computer mic
  // depending on the selected source, so it is only truly unusable when
  // neither is available.
  apply("connectBtn", serial.ok || mic.ok ? { ok: true } : serial, false);
  apply("connectWifiBtn", wifi, false);

  // Clinical: one button per transport, and nothing else touches disabled.
  apply("cConnectUsb", serial, true);
  apply("cConnectWifi", wifi, true);
  apply("cConnectComputer", mic, true);

  // The Device page shows the same three verdicts as readable text. Drawn from
  // here rather than on its own so it cannot disagree with the buttons.
  renderDevicePanel(currentWifiUrl());
}

/** Wire the Wi-Fi address field so support follows what the user types. */
export function watchWifiUrl(): void {
  el<HTMLInputElement>("wifiUrlInput")?.addEventListener("input", reflectDeviceSupport);
}
