// Text layers as relief. The letters (and the background plate, if any) arrive as coverage masks
// drawn in the browser; here they become heights. Edge slopes, the outline ring around the
// letters and the plate's border all come from distances to the mask edges, so they keep their
// size in millimetres at any resolution.

import type { Img } from "./image";
import { lutAt } from "./levels";
import type { TextLayer } from "./settings";

/** One text layer's masks at the output size: coverage 0..1 of the letters and of the plate. */
export interface TextMasks {
  id: number;
  glyph: Float32Array;
  plate: Float32Array | null;
  version?: number; // bump when this layer's masks change (otherwise the set's version counts)
}

/** Signed distance to the mask's edge in pixels (+ inside, - outside), within the box around it. */
export interface SignedDistance {
  x0: number;
  y0: number;
  bw: number;
  bh: number;
  d: Float32Array; // bw x bh
}

const FAR = 1e20;

/** Squared distance to the nearest zero of f along one line (Felzenszwalb & Huttenlocher). */
function dt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Euclidean distance from every pixel to the nearest pixel where `feature` is set (0 on them). */
export function distanceTo(feature: Uint8Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = feature[y * w + x] ? 0 : FAR;
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

/** Signed distance to the edge of a coverage mask, computed only around it (`margin` px beyond it). */
export function signedDistance(mask: Float32Array, w: number, h: number, margin: number): SignedDistance | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x] >= 0.5) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const m = Math.ceil(margin) + 2;
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m);
  y1 = Math.min(h - 1, y1 + m);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const inside = new Uint8Array(bw * bh);
  const outside = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      const on = mask[(y + y0) * w + x + x0] >= 0.5;
      inside[i] = on ? 1 : 0;
      outside[i] = on ? 0 : 1;
    }
  const toOutside = distanceTo(outside, bw, bh);
  const toInside = distanceTo(inside, bw, bh);
  const d = new Float32Array(bw * bh);
  // Pixel centres are half a pixel from an edge between two pixels.
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? toOutside[i] - 0.5 : 0.5 - toInside[i];
  return { x0, y0, bw, bh, d };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Rise from the edge (0) to full height (1) over `slope` px; antialiased coverage when there's no slope. */
function rise(sd: number, slope: number, coverage: number): number {
  return slope <= 1 ? coverage : clamp01(sd / slope);
}

export interface TextDistances {
  glyph: SignedDistance | null;
  plate: SignedDistance | null;
}

/** Distances for one layer, reaching far enough for its outline, slopes and plate border. */
export function textDistances(m: TextMasks, w: number, h: number, t: TextLayer, pxPerMM: number): TextDistances {
  const reach = (t.outline.gapMM + t.outline.widthMM + t.bevelMM) * pxPerMM;
  return {
    glyph: signedDistance(m.glyph, w, h, reach),
    plate: m.plate ? signedDistance(m.plate, w, h, (t.plate.bevelMM + t.plate.border.widthMM) * pxPerMM) : null,
  };
}

/**
 * Lay one text layer onto the surface, in order: plate, plate border, outline, letters. Each
 * part pulls the surface toward its own height (raised above it, or sunk below it) by how far
 * up its edge slope the pixel is.
 */
export function composeText(surface: Img, m: TextMasks, dist: TextDistances, t: TextLayer, pxPerMM: number, toneLut: Float32Array | null): Img {
  const { w } = surface;
  const out = surface.data.slice();
  const each = (sd: SignedDistance, fn: (i: number, d: number) => void) => {
    for (let y = 0; y < sd.bh; y++)
      for (let x = 0; x < sd.bw; x++) fn((y + sd.y0) * w + x + sd.x0, sd.d[y * sd.bw + x]);
  };
  const plate = dist.plate;
  if (t.plate.enabled && plate && m.plate) {
    const slope = t.plate.bevelMM * pxPerMM;
    const cov = m.plate;
    each(plate, (i, d) => {
      const p = rise(d, slope, cov[i]);
      out[i] += p * (t.plate.height - out[i]);
    });
    const b = t.plate.border;
    if (b.enabled) {
      const bw = b.widthMM * pxPerMM;
      each(plate, (i, d) => {
        const p = Math.min(rise(d, slope, cov[i]), clamp01(bw - d + 0.5));
        out[i] += p * (b.height - out[i]);
      });
    }
  }
  const glyph = dist.glyph;
  if (!glyph) return { w, h: surface.h, data: out };
  const o = t.outline;
  if (o.enabled) {
    const gap = o.gapMM * pxPerMM;
    const ow = o.widthMM * pxPerMM;
    each(glyph, (i, d) => {
      const e = -d; // distance outside the letters
      const p = clamp01(e - gap + 0.5) * clamp01(gap + ow - e + 0.5);
      out[i] += p * (o.height - out[i]);
    });
  }
  const slope = t.bevelMM * pxPerMM;
  const cov = m.glyph;
  each(glyph, (i, d) => {
    let p = rise(d, slope, cov[i]);
    if (p <= 0) return;
    if (toneLut) p = lutAt(toneLut, p);
    out[i] += p * (t.height - out[i]);
  });
  return { w, h: surface.h, data: out };
}
