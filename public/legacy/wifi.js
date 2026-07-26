// Wi-Fi (WebSocket) transport for the MEMS device.
//
// Improvements over the basic version:
//   - The server address is read from an input field, so a device on your LAN
//     (station mode) works, not only the fixed 192.168.4.1 access point.
//   - A connection timeout fails fast instead of hanging when the ESP32 is off
//     or you are on the wrong network.
//   - Unexpected drops trigger a bounded, backing-off auto-reconnect; a
//     user-initiated disconnect does not.

const DEFAULT_WIFI_URL = "ws://192.168.4.1:81";
const WIFI_CONNECT_TIMEOUT_MS = 6000;
const WIFI_MAX_RECONNECT_ATTEMPTS = 5;

let wifiIntentionalClose = false;
let wifiReconnectAttempts = 0;
let wifiReconnectTimer = null;
let wifiConnectTimeout = null;

function getWifiUrl() {
  const input = document.getElementById("wifiUrlInput");
  const value = input && input.value ? input.value.trim() : "";
  return value || DEFAULT_WIFI_URL;
}

function connectWifiMems() {
  if (inputSource !== "mems") {
    log("Wi-Fi MEMS can only be used when MEMS mics are selected.");
    return;
  }

  wifiIntentionalClose = false;
  wifiReconnectAttempts = 0;
  openWifiSocket(getWifiUrl());
}

function openWifiSocket(url) {
  try {
    setStatus("Connecting to MEMS Wi-Fi...", "idle");
    log("Connecting to ESP32 WebSocket at " + url + " ...");

    memsConnectionType = "wifi";

    if (wifiSocket) {
      try {
        wifiSocket.close();
      } catch (e) {
        // ignore
      }
      wifiSocket = null;
    }

    wifiSocket = new WebSocket(url);
    wifiSocket.binaryType = "arraybuffer";

    clearTimeout(wifiConnectTimeout);
    wifiConnectTimeout = setTimeout(() => {
      if (wifiSocket && wifiSocket.readyState !== WebSocket.OPEN) {
        log("Wi-Fi connection timed out. Is the ESP32 powered and are you joined to its network?");
        setStatus("Wi-Fi timeout", "idle");

        try {
          wifiSocket.close();
        } catch (e) {
          // ignore
        }
      }
    }, WIFI_CONNECT_TIMEOUT_MS);

    wifiSocket.onopen = function () {
      clearTimeout(wifiConnectTimeout);
      wifiReconnectAttempts = 0;

      wifiConnected = true;
      isConnected = true;

      connectBtn.disabled = true;
      connectWifiBtn.disabled = true;
      startBtn.disabled = false;
      stopBtn.disabled = true;
      calibrateNoiseBtn.disabled = false;
      plotSpectrumBtn.disabled = false;
      noiseAttenuatorBtn.disabled = false;

      setStatus("Connected by Wi-Fi", "connected");
      log("Connected to MEMS over Wi-Fi WebSocket.");
    };

    wifiSocket.onmessage = function (event) {
      if (typeof event.data === "string") {
        log("ESP32_WIFI:" + event.data);
        return;
      }

      // Payload is already right,left,right,left... int16 little-endian.
      const payload = new Uint8Array(event.data);
      addSamples(payload);
    };

    wifiSocket.onerror = function (error) {
      console.error(error);
      log("Wi-Fi WebSocket error.");
      // onclose fires next and handles UI / reconnect.
    };

    wifiSocket.onclose = function () {
      clearTimeout(wifiConnectTimeout);
      wifiConnected = false;

      if (memsConnectionType !== "wifi") {
        return;
      }

      isConnected = false;
      startBtn.disabled = true;
      stopBtn.disabled = true;

      if (wifiIntentionalClose) {
        connectWifiBtn.disabled = false;
        connectBtn.disabled = false;
        setStatus("Wi-Fi disconnected", "idle");
        log("Wi-Fi WebSocket disconnected.");
        return;
      }

      if (wifiReconnectAttempts < WIFI_MAX_RECONNECT_ATTEMPTS) {
        wifiReconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, wifiReconnectAttempts - 1), 8000);

        setStatus("Wi-Fi lost — reconnecting...", "idle");
        log(
          "Wi-Fi dropped. Reconnect attempt " +
            wifiReconnectAttempts +
            "/" +
            WIFI_MAX_RECONNECT_ATTEMPTS +
            " in " +
            delay / 1000 +
            "s."
        );

        clearTimeout(wifiReconnectTimer);
        wifiReconnectTimer = setTimeout(() => openWifiSocket(url), delay);
      } else {
        connectWifiBtn.disabled = false;
        connectBtn.disabled = false;
        setStatus("Wi-Fi disconnected", "idle");
        log("Wi-Fi reconnect failed after " + WIFI_MAX_RECONNECT_ATTEMPTS + " attempts. Press Connect to retry.");
      }
    };
  } catch (error) {
    console.error(error);
    setStatus("Wi-Fi connection failed", "idle");
    log("Wi-Fi connection failed: " + error.message);
  }
}

// User-initiated disconnect: stop reconnecting and close cleanly.
function disconnectWifi() {
  wifiIntentionalClose = true;

  clearTimeout(wifiReconnectTimer);
  clearTimeout(wifiConnectTimeout);

  if (wifiSocket) {
    try {
      wifiSocket.close();
    } catch (e) {
      // ignore
    }
    wifiSocket = null;
  }

  wifiConnected = false;
}

function sendWifiCommand(command) {
  if (!wifiSocket || wifiSocket.readyState !== WebSocket.OPEN) {
    log("Wi-Fi socket is not connected.");
    setStatus("Wi-Fi not connected", "idle");
    return;
  }

  wifiSocket.send(command);
  log("APP_WIFI_SENT:" + command);
}
