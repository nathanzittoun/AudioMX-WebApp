// Minimal store-only (uncompressed) ZIP writer, so a whole session — WAVs plus
// a manifest.csv — downloads as one file, with no external library. WAV data is
// already uncompressed, so "store" is fine.

// Pinned to ArrayBuffer rather than the default ArrayBufferLike: Blob rejects a
// view backed by a SharedArrayBuffer, and every array here is a plain one.
type Bytes = Uint8Array<ArrayBuffer>;

export interface ZipFile {
  name: string;
  data: Bytes;
}

// Built once on first use. The legacy version cached this on the function
// object (zipCrc32.table), which has no place in a typed signature.
let crcTable: Uint32Array | null = null;

function crc32Table(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export function zipCrc32(bytes: Bytes): number {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(files: ZipFile[]): Blob {
  const enc = new TextEncoder();
  const chunks: Bytes[] = [];
  const central: Bytes[] = [];
  let offset = 0;

  const u16 = (arr: number[], v: number): number =>
    arr.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (arr: number[], v: number): number =>
    arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data;
    const crc = zipCrc32(data);
    const size = data.length;

    const local: number[] = [];
    u32(local, 0x04034b50);
    u16(local, 20); u16(local, 0); u16(local, 0); // version, flags, method (store)
    u16(local, 0); u16(local, 0);                 // mod time, mod date
    u32(local, crc); u32(local, size); u32(local, size);
    u16(local, nameBytes.length); u16(local, 0);

    const localOffset = offset;
    const localHeader = new Uint8Array(local);
    chunks.push(localHeader); offset += localHeader.length;
    chunks.push(nameBytes); offset += nameBytes.length;
    chunks.push(data); offset += size;

    const cen: number[] = [];
    u32(cen, 0x02014b50);
    u16(cen, 20); u16(cen, 20); u16(cen, 0); u16(cen, 0);
    u16(cen, 0); u16(cen, 0);
    u32(cen, crc); u32(cen, size); u32(cen, size);
    u16(cen, nameBytes.length); u16(cen, 0); u16(cen, 0);
    u16(cen, 0); u16(cen, 0); u32(cen, 0);
    u32(cen, localOffset);
    central.push(new Uint8Array(cen));
    central.push(nameBytes);
  }

  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const centralOffset = offset;

  const eocd: number[] = [];
  u32(eocd, 0x06054b50);
  u16(eocd, 0); u16(eocd, 0);
  u16(eocd, files.length); u16(eocd, files.length);
  u32(eocd, centralSize);
  u32(eocd, centralOffset);
  u16(eocd, 0);

  return new Blob([...chunks, ...central, new Uint8Array(eocd)], { type: "application/zip" });
}
