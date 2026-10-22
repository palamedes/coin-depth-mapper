// Smoothing, edge-aware filtering and guided upsampling on single-channel images.
// Edges are handled by clamping (repeating the border pixel).

import { type Img, makeImg, resize } from "./image";

/**
 * Minimum (or maximum) over a (2r+1)x(2r+1) window, O(1) per pixel (van Herk / Gil-Werman).
 * Outside the image counts as no value; +-Infinity in the data also counts as no value.
 */
export function extremeFilter(src: Img, r: number, max: boolean): Img {
  r = Math.floor(r);
  const { w, h } = src;
  if (r < 1) return makeImg(w, h, src.data.slice());
  const none = max ? -Infinity : Infinity;
  const pick = max ? Math.max : Math.min;
  const s = 2 * r + 1;
  const run = (line: Float32Array, n: number, out: Float32Array) => {
    // Pad with `none`, then per block of s: g = running extreme from the block start, hh = to the block end.
    const len = Math.ceil((n + 2 * r) / s) * s;
    const g = new Float32Array(len);
    const hh = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const v = i >= r && i < n + r ? line[i - r] : none;
      g[i] = i % s === 0 ? v : pick(g[i - 1], v);
    }
    for (let i = len - 1; i >= 0; i--) {
      const v = i >= r && i < n + r ? line[i - r] : none;
      hh[i] = i % s === s - 1 || i === len - 1 ? v : pick(hh[i + 1], v);
    }
    for (let i = 0; i < n; i++) out[i] = pick(hh[i], g[i + s - 1]);
  };
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const line = new Float32Array(Math.max(w, h));
  const res = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    run(src.data.subarray(y * w, y * w + w), w, res);
    tmp.set(res.subarray(0, w), y * w);
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = tmp[y * w + x];
    run(line, h, res);
    for (let y = 0; y < h; y++) out[y * w + x] = res[y];
  }
  return makeImg(w, h, out);
}

/** Mean over a (2r+1)x(2r+1) window. O(1) per pixel. */
export function boxBlur(src: Img, r: number): Img {
  r = Math.floor(r);
  if (r < 1) return makeImg(src.w, src.h, src.data.slice());
  const { w, h } = src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  // Horizontal running sums (float64 accumulator so long rows don't drift).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src.data[row + Math.min(Math.max(k, 0), w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      const add = Math.min(x + r + 1, w - 1);
      const sub = Math.max(x - r, 0);
      acc += src.data[row + add] - src.data[row + sub];
    }
  }
  // Vertical: a running sum per column, walking rows in order (cache friendly).
  const col = new Float64Array(w);
  for (let k = -r; k <= r; k++) {
    const yy = Math.min(Math.max(k, 0), h - 1) * w;
    for (let x = 0; x < w; x++) col[x] += tmp[yy + x];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) out[row + x] = col[x] / n;
    const add = Math.min(y + r + 1, h - 1) * w;
    const sub = Math.max(y - r, 0) * w;
    for (let x = 0; x < w; x++) col[x] += tmp[add + x] - tmp[sub + x];
  }
  return makeImg(w, h, out);
}

/** Box sizes whose triple convolution approximates a Gaussian (Kovesi, "Fast almost-Gaussian filtering"). */
function boxesForGauss(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

function separable(src: Img, kernel: Float32Array): Img {
  const { w, h } = src;
  const r = (kernel.length - 1) / 2;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src.data[row + Math.min(Math.max(x + k, 0), w - 1)] * kernel[k + r];
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let k = -r; k <= r; k++) {
      const yy = Math.min(Math.max(y + k, 0), h - 1) * w;
      const wk = kernel[k + r];
      for (let x = 0; x < w; x++) out[row + x] += tmp[yy + x] * wk;
    }
  }
  return makeImg(w, h, out);
}

/** Gaussian blur with standard deviation `sigma` pixels. Exact kernel for small sigma, three box passes above 3 px. */
export function gaussianBlur(src: Img, sigma: number): Img {
  if (!(sigma > 0.3)) return makeImg(src.w, src.h, src.data.slice());
  if (sigma <= 3) {
    const r = Math.ceil(3 * sigma);
    const k = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return separable(src, k);
  }
  let out = src;
  for (const size of boxesForGauss(sigma, 3)) out = boxBlur(out, (size - 1) / 2);
  return out;
}

/**
 * Edge-preserving smoothing: a bilateral filter run as two 1-D passes (Pham & van Vliet),
 * which is much faster than the full 2-D window and visually equivalent on depth maps.
 * sigmaS in pixels, sigmaR in value units (depth 0..1).
 */
export function bilateral(src: Img, sigmaS: number, sigmaR: number): Img {
  if (!(sigmaS > 0.3) || !(sigmaR > 0)) return makeImg(src.w, src.h, src.data.slice());
  const r = Math.min(Math.ceil(2 * sigmaS), 24);
  const spatial = new Float32Array(2 * r + 1);
  for (let i = -r; i <= r; i++) spatial[i + r] = Math.exp((-i * i) / (2 * sigmaS * sigmaS));
  const LUT = 2048;
  const maxDiff = 4 * sigmaR;
  const range = new Float32Array(LUT + 1);
  for (let i = 0; i <= LUT; i++) {
    const d = (i / LUT) * maxDiff;
    range[i] = Math.exp((-d * d) / (2 * sigmaR * sigmaR));
  }
  const scale = LUT / maxDiff;
  const pass = (a: Float32Array, w: number, h: number, horizontal: boolean): Float32Array => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c = a[i];
        let acc = 0;
        let norm = 0;
        for (let k = -r; k <= r; k++) {
          const j = horizontal ? y * w + Math.min(Math.max(x + k, 0), w - 1) : Math.min(Math.max(y + k, 0), h - 1) * w + x;
          const v = a[j];
          const di = Math.abs(v - c) * scale;
          if (di >= LUT) continue;
          const wgt = spatial[k + r] * range[di | 0];
          acc += v * wgt;
          norm += wgt;
        }
        out[i] = acc / norm;
      }
    }
    return out;
  };
  const h1 = pass(src.data, src.w, src.h, true);
  return makeImg(src.w, src.h, pass(h1, src.w, src.h, false));
}

/**
 * Remove isolated pits and spikes: a pixel is replaced by the median of its
 * (2r+1)^2 neighbourhood only when it differs from that median by more than
 * `threshold`. threshold = 0 is a plain median filter.
 */
export function despeckle(src: Img, r: number, threshold: number): Img {
  r = Math.max(1, Math.min(3, Math.round(r)));
  const { w, h, data } = src;
  const out = data.slice();
  const win = new Float32Array((2 * r + 1) * (2 * r + 1));
  const mid = (win.length - 1) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(Math.max(y + dy, 0), h - 1) * w;
        for (let dx = -r; dx <= r; dx++) win[n++] = data[yy + Math.min(Math.max(x + dx, 0), w - 1)];
      }
      // Insertion sort: windows are 9, 25 or 49 values.
      for (let i = 1; i < n; i++) {
        const v = win[i];
        let j = i - 1;
        while (j >= 0 && win[j] > v) {
          win[j + 1] = win[j];
          j--;
        }
        win[j + 1] = v;
      }
      const med = win[mid];
      const i = y * w + x;
      if (Math.abs(data[i] - med) > threshold) out[i] = med;
    }
  }
  return makeImg(w, h, out);
}

function mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] * b[i];
  return o;
}

/** Guided filter coefficients (He et al.): q = a * I + b, both box-averaged. */
function guidedCoefficients(I: Img, p: Img, r: number, eps: number): [Img, Img] {
  const { w, h } = I;
  const mI = boxBlur(I, r).data;
  const mp = boxBlur(p, r).data;
  const mIp = boxBlur(makeImg(w, h, mul(I.data, p.data)), r).data;
  const mII = boxBlur(makeImg(w, h, mul(I.data, I.data)), r).data;
  const a = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) {
    const cov = mIp[i] - mI[i] * mp[i];
    const varI = mII[i] - mI[i] * mI[i];
    a[i] = cov / (varI + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  return [boxBlur(makeImg(w, h, a), r), boxBlur(makeImg(w, h, b), r)];
}

/** Classic guided filter: smooth `p` while following the edges of guide `I` (same size). */
export function guidedFilter(I: Img, p: Img, r: number, eps: number): Img {
  const [a, b] = guidedCoefficients(I, p, r, eps);
  const out = new Float32Array(I.w * I.h);
  for (let i = 0; i < out.length; i++) out[i] = a.data[i] * I.data[i] + b.data[i];
  return makeImg(I.w, I.h, out);
}

/**
 * Guided upsampling ("fast guided filter", He & Sun 2015): fit the local linear model
 * depth = a * guide + b at the depth map's resolution, then apply it with the
 * full-resolution guide. Depth edges snap to edges in the photo.
 * r is in low-resolution pixels; eps sets how strong a photo edge must be to be followed.
 */
export function guidedUpsample(depth: Img, guideHi: Img, r: number, eps: number): Img {
  const guideLo = resize(guideHi, depth.w, depth.h);
  const [a, b] = guidedCoefficients(guideLo, depth, Math.max(1, Math.round(r)), eps);
  const A = resize(a, guideHi.w, guideHi.h).data;
  const B = resize(b, guideHi.w, guideHi.h).data;
  const out = new Float32Array(guideHi.w * guideHi.h);
  for (let i = 0; i < out.length; i++) out[i] = A[i] * guideHi.data[i] + B[i];
  return makeImg(guideHi.w, guideHi.h, out);
}

/**
 * Joint bilateral upsampling (Kopf et al. 2007): each output pixel averages nearby
 * low-resolution depth samples, weighted by distance and by how similar the photo is.
 * r and sigmaS are in low-resolution pixels, sigmaR in luminance units.
 */
export function jointBilateralUpsample(depth: Img, guideHi: Img, r: number, sigmaR: number): Img {
  const guideLo = resize(guideHi, depth.w, depth.h);
  const W = guideHi.w;
  const H = guideHi.h;
  const sx = depth.w / W;
  const sy = depth.h / H;
  r = Math.max(1, Math.round(r));
  const sigmaS = Math.max(0.5, r / 2);
  const inv2s = 1 / (2 * sigmaS * sigmaS);
  const inv2r = 1 / (2 * sigmaR * sigmaR);
  const out = new Float32Array(W * H);
  const dd = depth.data;
  const gl = guideLo.data;
  for (let y = 0; y < H; y++) {
    const cy = (y + 0.5) * sy - 0.5;
    const y0 = Math.round(cy);
    for (let x = 0; x < W; x++) {
      const cx = (x + 0.5) * sx - 0.5;
      const x0 = Math.round(cx);
      const g = guideHi.data[y * W + x];
      let acc = 0;
      let norm = 0;
      let fallback = 0;
      let fallbackW = 0;
      for (let j = y0 - r; j <= y0 + r; j++) {
        if (j < 0 || j >= depth.h) continue;
        for (let i = x0 - r; i <= x0 + r; i++) {
          if (i < 0 || i >= depth.w) continue;
          const k = j * depth.w + i;
          const ds = ((i - cx) * (i - cx) + (j - cy) * (j - cy)) * inv2s;
          const dg = gl[k] - g;
          const ws = Math.exp(-ds);
          const wgt = ws * Math.exp(-dg * dg * inv2r);
          acc += dd[k] * wgt;
          norm += wgt;
          fallback += dd[k] * ws;
          fallbackW += ws;
        }
      }
      out[y * W + x] = norm > 1e-8 ? acc / norm : fallback / fallbackW;
    }
  }
  return makeImg(W, H, out);
}
