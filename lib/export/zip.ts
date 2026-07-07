// Minimal ZIP writer (store method, no compression) for analysis-ready
// bundles (spec §3.6). Hand-rolled to keep the dependency surface at zero:
// local file headers + central directory + end-of-central-directory, with
// standard CRC-32. Readable by unzip, R, Python, macOS Finder.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  content: string | Uint8Array;
}

class ByteWriter {
  #chunks: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }
  bytes(data: Uint8Array): void {
    this.#chunks.push(data);
    this.#length += data.length;
  }
  u16(value: number): void {
    this.bytes(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }
  u32(value: number): void {
    this.bytes(
      new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]),
    );
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** Builds a stored (uncompressed) ZIP archive from named entries. */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const writer = new ByteWriter();
  const central: {
    name: Uint8Array;
    crc: number;
    size: number;
    offset: number;
  }[] = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = typeof entry.content === "string"
      ? encoder.encode(entry.content)
      : entry.content;
    const crc = crc32(data);
    const offset = writer.length;

    writer.u32(0x04034b50); // local file header
    writer.u16(20); // version needed
    writer.u16(0); // flags
    writer.u16(0); // method: store
    writer.u16(0); // mod time
    writer.u16(0x21); // mod date (a fixed valid DOS date)
    writer.u32(crc);
    writer.u32(data.length); // compressed
    writer.u32(data.length); // uncompressed
    writer.u16(name.length);
    writer.u16(0); // extra length
    writer.bytes(name);
    writer.bytes(data);

    central.push({ name, crc, size: data.length, offset });
  }

  const centralStart = writer.length;
  for (const entry of central) {
    writer.u32(0x02014b50); // central directory header
    writer.u16(20); // version made by
    writer.u16(20); // version needed
    writer.u16(0);
    writer.u16(0);
    writer.u16(0);
    writer.u16(0x21);
    writer.u32(entry.crc);
    writer.u32(entry.size);
    writer.u32(entry.size);
    writer.u16(entry.name.length);
    writer.u16(0); // extra
    writer.u16(0); // comment
    writer.u16(0); // disk
    writer.u16(0); // internal attrs
    writer.u32(0); // external attrs
    writer.u32(entry.offset);
    writer.bytes(entry.name);
  }
  const centralSize = writer.length - centralStart;

  writer.u32(0x06054b50); // end of central directory
  writer.u16(0);
  writer.u16(0);
  writer.u16(central.length);
  writer.u16(central.length);
  writer.u32(centralSize);
  writer.u32(centralStart);
  writer.u16(0); // comment length
  return writer.done();
}
