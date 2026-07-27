// Frame decoder for the ESP32 USB stream.
//
// Wire format, matching sendSerialFrame() in the firmware:
//   0xAA 0x55  <uint16 payload length, little-endian>  <payload bytes>
//
// A USB read returns whatever bytes happened to arrive, so a frame can be split
// anywhere — including between the two sync bytes or halfway through the length
// field. The parser therefore holds a buffer across calls and only yields
// frames it has completely received.
//
// Pure and stateful, with no DOM and no globals, so the awkward cases —
// partial frames, resynchronising after corruption — are testable directly.

const SYNC_0 = 0xaa;
const SYNC_1 = 0x55;
const HEADER_BYTES = 4;

export interface FrameParser {
  /** Feed raw bytes; get back every complete payload they completed. */
  push(bytes: Uint8Array): Uint8Array[];
  /** Discard buffered bytes. Call when a connection opens or closes. */
  reset(): void;
  /** Bytes held back waiting for the rest of a frame. */
  readonly pending: number;
}

export function createFrameParser(): FrameParser {
  let buffer: number[] = [];

  return {
    get pending(): number {
      return buffer.length;
    },

    reset(): void {
      buffer = [];
    },

    push(bytes: Uint8Array): Uint8Array[] {
      for (const b of bytes) buffer.push(b);

      const frames: Uint8Array[] = [];

      while (buffer.length >= HEADER_BYTES) {
        // Not on a frame boundary: drop one byte and look again. This is what
        // lets the stream recover after noise rather than stalling forever.
        if (buffer[0] !== SYNC_0 || buffer[1] !== SYNC_1) {
          buffer.shift();
          continue;
        }

        const length = buffer[2] | (buffer[3] << 8);

        // The payload has not fully arrived yet; keep everything and wait.
        if (buffer.length < HEADER_BYTES + length) break;

        frames.push(new Uint8Array(buffer.slice(HEADER_BYTES, HEADER_BYTES + length)));
        buffer = buffer.slice(HEADER_BYTES + length);
      }

      return frames;
    },
  };
}
