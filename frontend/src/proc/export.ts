// Output size from millimetres and DPI, grayscale PNG (8/16-bit with pHYs), binary STL.

import type { Img } from "./image";
import { quantize } from "./slices";

export const MM_PER_INCH = 25.4;

export interface ExportSize {
  w: number;
  h: number;
  pxPerMM: number;
  widthMM: number; // actual size after rounding to whole pixels
  heightMM: number;
}

/** Pixel size for a piece `widthMM` wide at `dpi`, keeping the crop's aspect (height / width). */
export function exportSize(widthMM: number, dpi: number, aspect: number): ExportSize {
  const pxPerMM = dpi / MM_PER_INCH;
  const w = Math.max(1, Math.round(widthMM * pxPerMM));
  const h = Math.max(1, Math.round(widthMM * aspect * pxPerMM));
  return { w, h, pxPerMM, widthMM: w / pxPerMM, heightMM: h / pxPerMM };
}

/** PNG pHYs stores pixels per metre. */
export function dpiToPixelsPerMeter(dpi: number): number {
  return Math.round(dpi / 0.0254);
}

/** Quantize to 8 or 16-bit gray by rounding. Never dithers: dither noise would become pits in metal. */
export function toGray(img: Img, bits: 8 | 16): Uint8Array | Uint16Array {
  const out = bits === 16 ? new Uint16Array(img.data.length) : new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = quantize(img.data[i], bits);
  return out;
}

// ---- PNG -----------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Raw scanlines with a per-row PNG filter chosen by the minimum-sum-of-absolute-differences heuristic. */
function filteredScanlines(gray: Uint8Array | Uint16Array, w: number, h: number, bits: 8 | 16): Uint8Array {
  const bpp = bits / 8;
  const rowBytes = w * bpp;
  const raw = new Uint8Array(h * rowBytes);
  for (let i = 0; i < gray.length; i++) {
    if (bits === 16) {
      raw[2 * i] = gray[i] >>> 8;
      raw[2 * i + 1] = gray[i] & 0xff;
    } else raw[i] = gray[i];
  }
  const out = new Uint8Array(h * (rowBytes + 1));
  const cand = Array.from({ length: 5 }, () => new Uint8Array(rowBytes));
  for (let y = 0; y < h; y++) {
    const cur = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? raw.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const cc = prev && i >= bpp ? prev[i - bpp] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >>> 1 : paeth(a, b, cc);
        const v = (cur[i] - pred) & 0xff;
        c[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    const o = y * (rowBytes + 1);
    out[o] = best;
    out.set(cand[best], o + 1);
  }
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Grayscale PNG (colour type 0) at 8 or 16 bits with the DPI written to pHYs, so
 * LightBurn and EzCad import it at the intended physical size.
 */
export async function encodePNG(
  gray: Uint8Array | Uint16Array,
  w: number,
  h: number,
  bits: 8 | 16,
  dpi: number,
  text: Record<string, string> = {},
): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = bits;
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const phys = new Uint8Array(9);
  const pv = new DataView(phys.buffer);
  const ppm = dpiToPixelsPerMeter(dpi);
  pv.setUint32(0, ppm);
  pv.setUint32(4, ppm);
  phys[8] = 1; // unit: metre
  const idat = await zlib(filteredScanlines(gray, w, h, bits));
  const texts = Object.entries(text).map(([k, v]) => chunk("tEXt", latin1(`${k}\0${v}`)));
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("pHYs", phys),
    ...texts,
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- STL -----------------------------------------------------------------------------------

/**
 * Watertight binary STL of the relief: a top surface from the height map (white = highest),
 * four walls and a flat bottom. Units are millimetres. The map is resampled to at most
 * `maxGrid` vertices along its longer side to keep the file manageable.
 */
export function buildSTL(img: Img, widthMM: number, heightMM: number, reliefMM: number, baseMM: number, maxGrid: number): ArrayBuffer {
  const scale = Math.min(1, maxGrid / Math.max(img.w, img.h));
  const gw = Math.max(2, Math.round(img.w * scale));
  const gh = Math.max(2, Math.round(img.h * scale));
  // Nearest-neighbour is enough here: callers pass an already-smoothed, resized map.
  const z = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const sy = Math.min(img.h - 1, Math.floor(((y + 0.5) * img.h) / gh));
    for (let x = 0; x < gw; x++) {
      const sx = Math.min(img.w - 1, Math.floor(((x + 0.5) * img.w) / gw));
      const v = img.data[sy * img.w + sx];
      z[y * gw + x] = baseMM + Math.min(1, Math.max(0, v)) * reliefMM;
    }
  }
  const dx = widthMM / (gw - 1);
  const dy = heightMM / (gh - 1);
  // Image rows run top-down; flip so the model isn't mirrored when viewed from above.
  const X = (x: number) => x * dx;
  const Y = (y: number) => (gh - 1 - y) * dy;
  const tris = 2 * (gw - 1) * (gh - 1) * 2 + 4 * (gw - 1) + 4 * (gh - 1);
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const header = "Relief Depth Studio STL, units: mm";
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris, true);
  let o = 84;
  const tri = (a: number[], b: number[], c: number[]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const v of [nx, ny, nz, ...a, ...b, ...c]) {
      dv.setFloat32(o, v, true);
      o += 4;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  };
  const top = (x: number, y: number) => [X(x), Y(y), z[y * gw + x]];
  const bot = (x: number, y: number) => [X(x), Y(y), 0];
  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      // Top faces point up (+z), bottom faces down; counter-clockwise seen from outside.
      tri(top(x, y), top(x, y + 1), top(x + 1, y));
      tri(top(x + 1, y), top(x, y + 1), top(x + 1, y + 1));
      tri(bot(x, y), bot(x + 1, y), bot(x, y + 1));
      tri(bot(x + 1, y), bot(x + 1, y + 1), bot(x, y + 1));
    }
  }
  for (let x = 0; x < gw - 1; x++) {
    // Back edge (image top, y = 0, largest Y) faces +Y; front edge (y = gh-1) faces -Y.
    tri(top(x, 0), top(x + 1, 0), bot(x, 0));
    tri(top(x + 1, 0), bot(x + 1, 0), bot(x, 0));
    tri(top(x, gh - 1), bot(x, gh - 1), top(x + 1, gh - 1));
    tri(top(x + 1, gh - 1), bot(x, gh - 1), bot(x + 1, gh - 1));
  }
  for (let y = 0; y < gh - 1; y++) {
    // Left edge (x = 0) faces -X; right edge faces +X.
    tri(top(0, y), bot(0, y), top(0, y + 1));
    tri(top(0, y + 1), bot(0, y), bot(0, y + 1));
    tri(top(gw - 1, y), top(gw - 1, y + 1), bot(gw - 1, y));
    tri(top(gw - 1, y + 1), bot(gw - 1, y + 1), bot(gw - 1, y));
  }
  return buf;
}
