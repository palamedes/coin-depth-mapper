// Levels (black point, white point, gamma), a smooth tone curve, and histograms.

import type { Img } from "./image";

/** Photoshop-style levels: stretch black..white to 0..1, then gamma (>1 brightens midtones). */
export function levels(v: number, black: number, white: number, gamma: number): number {
  const span = white - black;
  let t = Math.abs(span) < 1e-6 ? (v >= white ? 1 : 0) : (v - black) / span;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return gamma === 1 ? t : Math.pow(t, 1 / gamma);
}

/**
 * Monotone cubic interpolation (Fritsch-Carlson) through the curve points plus the
 * fixed ends (0,0) and (1,1). It never overshoots between points, so a curve can't
 * create spikes or flip the relief.
 */
export function makeCurve(points: [number, number][]): (x: number) => number {
  const pts = [[0, 0] as [number, number], ...points, [1, 1] as [number, number]]
    .map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  // Merge points with (almost) the same x.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of pts) {
    if (xs.length && x - xs[xs.length - 1] < 1e-4) ys[ys.length - 1] = y;
    else {
      xs.push(x);
      ys.push(y);
    }
  }
  const n = xs.length;
  if (n < 2) return (x) => x;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const hgt = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / hgt;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * hgt * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * hgt * m[i + 1]
    );
  };
}

const LUT_SIZE = 16384;

/**
 * Levels + curve as a lookup table over 0..1 (linear interpolation between entries keeps 16-bit
 * smoothness). `strength` scales the result toward `anchor`, keeping its shape: 0.5 is half as far
 * from the anchor, 0 all at it, above 1 further out (may leave 0..1).
 */
export function toneLUT(black: number, white: number, gamma: number, curve: [number, number][], strength = 1, anchor = 0): Float32Array {
  const c = curve.length ? makeCurve(curve) : null;
  const lut = new Float32Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) {
    const v = levels(i / LUT_SIZE, black, white, gamma);
    lut[i] = anchor + strength * ((c ? c(v) : v) - anchor);
  }
  return lut;
}

/** One value through a lookup table from toneLUT (clamped to 0..1, interpolated). */
export function lutAt(lut: Float32Array, v: number): number {
  const n = lut.length - 1;
  const f = (v < 0 ? 0 : v > 1 ? 1 : v) * n;
  const k = Math.min(f | 0, n - 1);
  const t = f - k;
  return lut[k] * (1 - t) + lut[k + 1] * t;
}

export function applyLUT(img: Img, lut: Float32Array): Img {
  const n = lut.length - 1;
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < out.length; i++) {
    let v = img.data[i];
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    const f = v * n;
    const k = Math.min(f | 0, n - 1);
    const t = f - k;
    out[i] = lut[k] * (1 - t) + lut[k + 1] * t;
  }
  return { w: img.w, h: img.h, data: out };
}

/** Histogram of values in 0..1. Pixels where weight < 0.5 are skipped (used to ignore the area outside the mask). */
export function histogram(img: Img, bins = 256, weight?: Float32Array): Uint32Array {
  const h = new Uint32Array(bins);
  const d = img.data;
  for (let i = 0; i < d.length; i++) {
    if (weight && weight[i] < 0.5) continue;
    const v = d[i];
    const b = v <= 0 ? 0 : v >= 1 ? bins - 1 : Math.floor(v * bins);
    h[b]++;
  }
  return h;
}

/** Value below which `p` (0..1) of the histogram lies. */
export function percentile(hist: Uint32Array, p: number): number {
  let total = 0;
  for (const c of hist) total += c;
  if (!total) return p < 0.5 ? 0 : 1;
  const target = p * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return (i + 0.5) / hist.length;
  }
  return 1;
}

/** Black and white points that clip `clip` (e.g. 0.001 = 0.1 %) at each end. */
export function autoLevels(img: Img, weight?: Float32Array, clip = 0.001): { black: number; white: number } {
  const hist = histogram(img, 4096, weight);
  const black = percentile(hist, clip);
  const white = percentile(hist, 1 - clip);
  return white - black < 0.01 ? { black: 0, white: 1 } : { black, white };
}
