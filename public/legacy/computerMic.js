// ---- resampling to SAMPLE_RATE ------------------------------------------
// Averages over one output period before decimating. Picking the nearest
// sample instead would fold everything above 8 kHz back into the voice band,
// which would corrupt exactly the measurements this device exists to make
// (jitter, HNR, formants). State is kept between blocks so the fractional
// cursor and the averaging window stay continuous across buffer boundaries.

let micResampleCarry = null;
let micResamplePos = 0;

function resetMicResampler() {
  micResampleCarry = null;
  micResamplePos = 0;
}

function resampleMicBlock(input, inRate, outRate) {
  const ratio = inRate / outRate;
  const half = ratio > 1 ? ratio / 2 : 0.5;
  const pad = Math.ceil(half) + 1;

  // Splice the previous block's tail in front, so the averaging window never
  // runs off the start of the buffer and invents a discontinuity.
  const carryLen = micResampleCarry ? micResampleCarry.length : 0;
  const buf = new Float32Array(carryLen + input.length);
  if (micResampleCarry) buf.set(micResampleCarry, 0);
  buf.set(input, carryLen);

  // Stop short of the end: those samples need the next block to average over.
  const limit = buf.length - pad;
  const out = [];
  let pos = micResamplePos + carryLen;

  while (pos < limit) {
    const from = Math.max(0, Math.ceil(pos - half));
    const to = Math.min(buf.length - 1, Math.floor(pos + half));
    let sum = 0;
    for (let i = from; i <= to; i++) sum += buf[i];
    out.push(to >= from ? sum / (to - from + 1) : 0);
    pos += ratio;
  }

  const keep = Math.min(buf.length, pad * 2);
  micResampleCarry = buf.slice(buf.length - keep);
  micResamplePos = pos - (buf.length - keep);
  return out;
}

async function connectComputerMic() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Computer microphone access is not supported in this browser.");
      return;
    }

    computerMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    try {
      computerAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch (e) {
      // Safari and some devices reject a forced rate outright.
      computerAudioContext = new AudioContext();
    }

    // Never assume the rate we asked for is the rate we got. Chrome usually
    // honours it, Safari ignores it, and a device already open at another rate
    // can override it. Everything downstream (FFT axis, WAV header, duration)
    // is hardcoded to SAMPLE_RATE, so a silent mismatch plays back at the wrong
    // speed. Resample here instead, and the rest of the app stays correct.
    computerCaptureRate = computerAudioContext.sampleRate;
    resetMicResampler();
    if (computerCaptureRate !== SAMPLE_RATE) {
      log("Mic runs at " + computerCaptureRate + " Hz; resampling to " + SAMPLE_RATE + " Hz.");
    }

    computerSourceNode = computerAudioContext.createMediaStreamSource(computerMediaStream);

    computerProcessorNode = computerAudioContext.createScriptProcessor(4096, 1, 1);

    computerProcessorNode.onaudioprocess = function(event) {
      if (!isRecording || inputSource !== "computer") {
        return;
      }

      const input = event.inputBuffer.getChannelData(0);
      const source = computerCaptureRate === SAMPLE_RATE
        ? input
        : resampleMicBlock(input, computerCaptureRate, SAMPLE_RATE);

      const samples = new Int16Array(source.length);

      for (let i = 0; i < source.length; i++) {
        let s = source[i];

        if (s > 1) s = 1;
        if (s < -1) s = -1;

        samples[i] = Math.round(s * 32767);
      }

      addComputerMicSamples(samples);
    };

    computerSourceNode.connect(computerProcessorNode);
    computerProcessorNode.connect(computerAudioContext.destination);

    computerMicReady = true;
    isConnected = true;

    connectBtn.disabled = true;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    calibrateNoiseBtn.disabled = false;
    plotSpectrumBtn.disabled = false;
    noiseAttenuatorBtn.disabled = false;

    setStatus("Computer mic ready", "connected");
    log("Connected to computer microphone.");

  } catch (error) {
    console.error(error);
    setStatus("Computer mic failed", "idle");
    log("Computer mic error: " + error.message);
  }
}

function startComputerMicCapture() {
  if (computerAudioContext && computerAudioContext.state === "suspended") {
    computerAudioContext.resume();
  }

  log("Computer mic recording started.");
}

function stopComputerMicCapture() {
  log("Computer mic recording stopped.");
}

function addComputerMicSamples(samples) {
  if (!isRecording || inputSource !== "computer") {
    return;
  }

  // Bake the filter into the stored audio when ON; store raw when OFF.
  const stored = noiseAttenuatorEnabled ? processNoiseAttenuator(samples, 1) : samples;

  currentChunks.push(stored);
  currentFrameCount += stored.length;
  currentValueCount += stored.length;

  for (let i = 0; i < stored.length; i++) {
    liveSamples.push(stored[i]);
  }

  if (liveSamples.length > MAX_LIVE_SAMPLES) {
    liveSamples = liveSamples.slice(liveSamples.length - MAX_LIVE_SAMPLES);
  }

  updateCurrentStats();
  renderLiveMonitors();
}