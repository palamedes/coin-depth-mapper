// Single-channel float images and resampling. Values are usually 0..1.

export interface Img {
  w: number;
  h: number;
  data: Float32Array;
}

export function makeImg(w: number, h: number, data?: Float32Array): Img {
  if (data && data.length !== w * h) throw new Error(`image data has ${data.length} values, expected ${w * h}`);
  return { w, h, data: data ?? new Float32Array(w * h) };
}

export function cloneImg(a: Img): Img {
  return { w: a.w, h: a.h, data: a.data.slice() };
}

export function fill(w: number, h: number, v: number): Img {
  return makeImg(w, h, new Float32Array(w * h).fill(v));
}

/** Rec. 709 luma of 8-bit RGBA pixels, scaled to 0..1. */
export function luminance(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Img {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
  }
  return makeImg(w, h, out);
}

interface Taps {
  start: Int32Array;
  count: Int32Array;
  weights: Float32Array;
  stride: number;
}

// Separable resampling with a triangle (tent) kernel whose support grows with the
// shrink factor: bilinear when enlarging, properly anti-aliased when shrinking.
// Pixel centres are at i + 0.5, so the image maps edge-to-edge.
function taps(inSize: number, outSize: number): Taps {
  const scale = inSize / outSize;
  const support = Math.max(1, scale);
  const stride = Math.ceil(support) * 2 + 1;
  const start = new Int32Array(outSize);
  const count = new Int32Array(outSize);
  const weights = new Float32Array(outSize * stride);
  for (let o = 0; o < outSize; o++) {
    const center = (o + 0.5) * scale - 0.5;
    let lo = Math.ceil(center - support);
    let hi = Math.floor(center + support);
    lo = Math.max(lo, 0);
    hi = Math.min(hi, inSize - 1);
    let sum = 0;
    let n = 0;
    for (let i = lo; i <= hi && n < stride; i++, n++) {
      const wgt = Math.max(0, 1 - Math.abs(i - center) / support);
      weights[o * stride + n] = wgt;
      sum += wgt;
    }
    if (sum <= 0) {
      // Output centre falls outside the input (tiny inputs): take the nearest pixel.
      const nearest = Math.min(inSize - 1, Math.max(0, Math.round(center)));
      start[o] = nearest;
      count[o] = 1;
      weights[o * stride] = 1;
      continue;
    }
    for (let k = 0; k < n; k++) weights[o * stride + k] /= sum;
    start[o] = lo;
    count[o] = n;
  }
  return { start, count, weights, stride };
}

export function resize(src: Img, w: number, h: number): Img {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w === src.w && h === src.h) return cloneImg(src);
  // Horizontal pass: src.w -> w, keeping src.h rows.
  const tx = taps(src.w, w);
  const tmp = new Float32Array(w * src.h);
  for (let y = 0; y < src.h; y++) {
    const row = y * src.w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      const s = tx.start[x];
      const base = x * tx.stride;
      for (let k = 0; k < tx.count[x]; k++) acc += src.data[row + s + k] * tx.weights[base + k];
      tmp[y * w + x] = acc;
    }
  }
  // Vertical pass: src.h -> h.
  const ty = taps(src.h, h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const s = ty.start[y];
    const base = y * ty.stride;
    const o = y * w;
    for (let k = 0; k < ty.count[y]; k++) {
      const wgt = ty.weights[base + k];
      const r = (s + k) * w;
      for (let x = 0; x < w; x++) out[o + x] += tmp[r + x] * wgt;
    }
  }
  return makeImg(w, h, out);
}

/** Bilinear sample at continuous pixel coordinates (pixel centres at i + 0.5). */
export function sample(img: Img, x: number, y: number): number {
  const fx = Math.min(Math.max(x - 0.5, 0), img.w - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), img.h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, img.w - 1);
  const y1 = Math.min(y0 + 1, img.h - 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const d = img.data;
  const top = d[y0 * img.w + x0] * (1 - ax) + d[y0 * img.w + x1] * ax;
  const bot = d[y1 * img.w + x0] * (1 - ax) + d[y1 * img.w + x1] * ax;
  return top * (1 - ay) + bot * ay;
}

export function clamp01(img: Img): Img {
  const d = img.data;
  for (let i = 0; i < d.length; i++) d[i] = d[i] < 0 ? 0 : d[i] > 1 ? 1 : d[i];
  return img;
}

export function minMax(img: Img): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of img.data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}
