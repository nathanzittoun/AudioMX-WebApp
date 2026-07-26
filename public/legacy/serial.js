// USB-C serial transport for the MEMS device.
//
// Improvements over the basic version:
//   - Remembers a previously authorized device and silently reconnects on load
//     (navigator.serial.getPorts), so a page refresh does not force re-picking.
//   - Detects physical unplug (serial 'disconnect' event) and a dropped read
//     loop, and reflects the loss in the UI instead of pretending to stay
//     connected.
//   - Separates the user-initiated disconnect from an unexpected one so the two
//     are handled differently.

let serialIntentionalClose = false;

async function connectSerial() {
  if (inputSource === "computer") {
    await connectComputerMic();
    return;
  }

  if (!("serial" in navigator)) {
    alert("Web Serial is not supported. Use Chrome or Edge.");
    return;
  }

  try {
    const selectedPort = await navigator.serial.requestPort();
    await openSerialPort(selectedPort);
  } catch (error) {
    console.error(error);
    setStatus("Connection failed", "idle");
    log("Connection error: " + error.message);
  }
}

async function openSerialPort(selectedPort) {
  port = selectedPort;

  await port.open({
    baudRate: BAUD_RATE
  });

  reader = port.readable.getReader();
  writer = port.writable.getWriter();

  isConnected = true;
  memsConnectionType = "usb";
  serialIntentionalClose = false;

  connectBtn.disabled = true;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  calibrateNoiseBtn.disabled = false;
  plotSpectrumBtn.disabled = false;
  noiseAttenuatorBtn.disabled = false;

  setStatus("Connected", "connected");
  log("Connected to ESP32 over USB-C serial.");

  readLoop();
}

async function readLoop() {
  while (isConnected && reader) {
    try {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      if (value) {
        processIncomingBytes(value);
      }
    } catch (error) {
      console.error(error);
      log("Read error: " + error.message);
      break;
    }
  }

  // The read loop only ends when the port closes. If the user did not ask for
  // that, treat it as a lost connection.
  if (!serialIntentionalClose && memsConnectionType === "usb") {
    handleSerialDisconnected();
  }
}

function handleSerialDisconnected() {
  isConnected = false;
  isRecording = false;

  reader = null;
  writer = null;
  port = null;

  startBtn.disabled = true;
  stopBtn.disabled = true;
  calibrateNoiseBtn.disabled = true;
  noiseAttenuatorBtn.disabled = true;
  connectBtn.disabled = false;

  setStatus("USB disconnected", "idle");
  log("USB serial connection lost. Reconnect the device and press Connect.");
}

async function sendCommand(command) {
  if (!writer) {
    setStatus("Not connected", "idle");
    return;
  }

  const encoder = new TextEncoder();

  await writer.write(encoder.encode(command + "\n"));

  log("APP_SENT:" + command);
}

function processIncomingBytes(newBytes) {
  for (const b of newBytes) {
    byteBuffer.push(b);
  }

  while (byteBuffer.length >= 4) {
    if (byteBuffer[0] !== 0xAA || byteBuffer[1] !== 0x55) {
      byteBuffer.shift();
      continue;
    }

    const length = byteBuffer[2] | (byteBuffer[3] << 8);

    if (byteBuffer.length < 4 + length) {
      return;
    }

    const payload = byteBuffer.slice(4, 4 + length);
    byteBuffer = byteBuffer.slice(4 + length);

    addSamples(new Uint8Array(payload));
  }
}

// React to the device being physically unplugged.
if ("serial" in navigator && navigator.serial.addEventListener) {
  navigator.serial.addEventListener("disconnect", event => {
    if (memsConnectionType === "usb" && port && event.target === port) {
      serialIntentionalClose = false;
      handleSerialDisconnected();
    }
  });
}
