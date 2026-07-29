// Capture on the audio thread.
//
// This file is NOT part of the module graph: it is loaded by URL into an
// AudioWorklet, which runs in its own global scope on the audio rendering
// thread. It cannot import from the app, and the app cannot call into it —
// everything crosses by postMessage. That isolation is the entire point.
//
// What it replaces: a ScriptProcessorNode, whose onaudioprocess runs on the
// main thread. During a clinical exam the main thread is redrawing a waveform
// and computing an FFT for the live spectrum on every block. A processor
// callback that arrives while that is running is simply late, and a late
// ScriptProcessor block is *dropped* — the audio in it never reaches the
// recording. That is what a take full of holes is.
//
// Here, process() is called by the audio thread on a fixed schedule that main
// thread work cannot delay. Blocks are posted across; if the main thread is
// busy the messages queue and arrive late, but nothing is lost.

/** Native frames per posted block. 4096 keeps the message rate low (about 12/s
 *  at 48 kHz) while staying well under any sane queue depth. */
const BLOCK = 4096;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BLOCK);
    this.filled = 0;

    // "flush" drops whatever has been collected but not yet posted. Sent when a
    // take starts, so the first block of a recording begins within one render
    // quantum — 128 frames, under 3 ms — of the moment Start was pressed,
    // instead of reaching back over a whole buffer.
    this.port.onmessage = event => {
      if (event.data === "flush") {
        this.filled = 0;
        return;
      }
      if (event.data === "drain") {
        // The tail: whatever has been collected but not yet posted, up to one
        // block short of a full one. Without this it is simply never delivered,
        // so up to 256 ms of the END of every take was lost — which is exactly
        // the quantity the maximum phonation time test is measuring.
        // Always answered, even empty, because the caller waits for it.
        const tail = this.filled > 0 ? this.buffer.slice(0, this.filled) : null;
        this.filled = 0;
        if (tail) this.port.postMessage({ drained: tail }, [tail.buffer]);
        else this.port.postMessage({ drained: null });
      }
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input connected yet, or the track ended. Staying alive is correct:
    // returning false would tear the node down permanently.
    if (!channel) return true;

    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(BLOCK - this.filled, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;

      if (this.filled === BLOCK) {
        // A copy, transferred rather than cloned. The worklet keeps its own
        // buffer to carry on filling.
        const out = this.buffer.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this.filled = 0;
      }
    }

    return true;
  }
}

registerProcessor("audiomx-capture", CaptureProcessor);
