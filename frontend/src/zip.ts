// A small ZIP writer and reader for project files: stored or deflated entries, UTF-8 names, no
// ZIP64 (entries under 4 GB). Any unzip tool can open what this writes.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}

/** Date and time in the MS-DOS format ZIP uses. */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  compress?: boolean; // deflate it (images that are already compressed are better stored)
}

export async function writeZip(entries: ZipEntry[], when = new Date()): Promise<Blob> {
  const enc = new TextEncoder();
  const { time, date } = dosTime(when);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    let body = e.data;
    let method = 0;
    if (e.compress) {
      const z = await through(e.data, new CompressionStream("deflate-raw"));
      if (z.length < e.data.length) {
        body = z;
        method = 8;
      }
    }
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true); // version needed
    l.setUint16(6, 0x0800, true); // names are UTF-8
    l.setUint16(8, method, true);
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, e.data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const dir = new Uint8Array(46 + name.length);
    const c = new DataView(dir.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true); // made by
    c.setUint16(6, 20, true); // version needed
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, method, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    dir.set(name, 46);
    parts.push(local, body);
    central.push(dir);
    offset += local.length + body.length;
  }
  const size = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, size, true);
  v.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end] as BlobPart[], { type: "application/zip" });
}

/** Every file in a ZIP, by name. Throws if it isn't one, or a file in it is damaged. */
export async function readZip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buf);
  const v = new DataView(buf);
  // The end record is the last 22 bytes, unless a comment (up to 64 kB) follows it.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("not a ZIP file");
  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error("damaged ZIP file");
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const packed = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const at = v.getUint32(p + 42, true);
    const start = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true);
    const body = bytes.subarray(start, start + packed);
    let data: Uint8Array;
    if (method === 0) data = body.slice();
    else if (method === 8) data = await through(body, new DecompressionStream("deflate-raw"));
    else throw new Error(`${name} uses a compression this app can't read`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name} is damaged`);
    out.set(name, data);
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return out;
}
