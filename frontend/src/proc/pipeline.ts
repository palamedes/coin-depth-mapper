// The post-processing chain, in the order the user sees it:
//   remove tilt -> upsample -> detail boost -> mask -> background flatten -> rim -> levels/curve -> smoothing -> invert
// Every stage is pure; `PipelineCache` remembers stage outputs so moving a late slider
// (levels, smoothing) doesn't redo the expensive early stages.

import { bilateral, despeckle, gaussianBlur, guidedUpsample, jointBilateralUpsample } from "./filters";
import { type Img, clamp01, cloneImg, makeImg, resize } from "./image";
import { applyLUT, histogram, toneLUT } from "./levels";
import { edgeDistance, maskFromDistance, rimFromDistance } from "./mask";
import { type CropShape, type Settings, edgeEps } from "./settings";

export interface PipelineInput {
  depth: Img; // raw model output, 0..1, near = 1
  guide: Img; // luminance of the cropped photo at the output size
  depthVersion: number; // bump when the depth changes
  guideVersion: number; // bump when the photo/crop changes
}

export interface PipelineResult {
  out: Img; // final map, 0..1, white = highest
  beforeLevels: Img; // input to the levels step (for the histogram)
  mask: Img | null; // 1 inside the crop mask
  histBefore: Uint32Array; // 256 bins of beforeLevels inside the mask
  histAfter: Uint32Array; // 256 bins of out (whole image)
}

type Stage = { key: string; img: Img };

export class PipelineCache {
  private stages = new Map<string, Stage>();
  get(name: string, key: string, compute: () => Img): Img {
    const hit = this.stages.get(name);
    if (hit && hit.key === key) return hit.img;
    const img = compute();
    this.stages.set(name, { key, img });
    return img;
  }
  clear() {
    this.stages.clear();
  }
}

/**
 * Fit a plane z = a + b x + c y to the depth inside the crop and subtract its slope, then
 * rescale to 0..1. The fit is repeated on the lower 40% of points (relative to the plane),
 * so it settles on the coin's field rather than being lifted by the raised subject.
 */
export function removeTilt(depth: Img, shape: CropShape): Img {
  const { w, h, data } = depth;
  const r = (Math.min(w, h) / 2) * 0.96;
  const inside = (x: number, y: number) => shape !== "circle" || Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) < r;
  const stride = Math.max(1, Math.round(Math.sqrt((w * h) / 120_000)));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let y = 0; y < h; y += stride)
    for (let x = 0; x < w; x += stride)
      if (inside(x, y)) {
        xs.push(x / w - 0.5);
        ys.push(y / h - 0.5);
        zs.push(data[y * w + x]);
      }
  if (zs.length < 10) return depth;
  let keep = zs.map(() => true);
  let plane = [0, 0, 0];
  for (let iter = 0; iter < 4; iter++) {
    const fit = fitPlane(xs, ys, zs, keep);
    if (!fit) break;
    plane = fit;
    const res = zs.map((z, i) => z - (plane[0] + plane[1] * xs[i] + plane[2] * ys[i]));
    const sorted = res.slice().sort((a, b) => a - b);
    const cut = sorted[Math.floor(sorted.length * 0.4)];
    keep = res.map((v) => v <= cut);
  }
  const out = new Float32Array(w * h);
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x] - (plane[1] * (x / w - 0.5) + plane[2] * (y / h - 0.5));
      out[y * w + x] = v;
      if (inside(x, y)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  const span = hi - lo;
  if (!(span > 1e-6)) return depth; // flat map: nothing to level
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, (out[i] - lo) / span));
  return makeImg(w, h, out);
}

function fitPlane(xs: number[], ys: number[], zs: number[], keep: boolean[]): [number, number, number] | null {
  // Normal equations for z = a + b x + c y.
  let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (let i = 0; i < zs.length; i++) {
    if (!keep[i]) continue;
    const x = xs[i], y = ys[i], z = zs[i];
    n++; sx += x; sy += y; sz += z; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z;
  }
  if (n < 3) return null;
  const m = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
  const v = [sz, sxz, syz];
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  const col = (k: number) => m.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

/** pxPerMM: pixels per millimetre at the size being processed (preview or export). */
export function runPipeline(input: PipelineInput, s: Settings, pxPerMM: number, cache = new PipelineCache()): PipelineResult {
  const { w, h } = input.guide;
  const mm = (v: number) => v * pxPerMM;
  const size = `${w}x${h}@${pxPerMM.toFixed(5)}`;
  const shape = s.crop.shape;

  // 0. Remove tilt: depth models read a flat coin as leaning back; take the plane out.
  const kTilt = `${input.depthVersion}/${shape}/${s.tilt.enabled}`;
  const level = cache.get("tilt", kTilt, () => (s.tilt.enabled ? removeTilt(input.depth, shape) : input.depth));

  // 1. Upsample model depth to the output size, guided by the photo.
  const kUp = `${kTilt}/${input.guideVersion}/${size}/${JSON.stringify(s.upsample)}`;
  const up = cache.get("upsample", kUp, () => {
    const u = s.upsample;
    if (!u.enabled || u.method === "bilinear") return resize(level, w, h);
    if (u.method === "jbu") return jointBilateralUpsample(level, input.guide, u.radius + 1, Math.max(0.01, Math.sqrt(edgeEps(u.edge)) * 2));
    return guidedUpsample(level, input.guide, u.radius, edgeEps(u.edge));
  });

  // 2. Detail boost: add back fine texture from the photo's high-pass, soft-clipped.
  const kDetail = `${kUp}/${JSON.stringify(s.detail)}`;
  const detailed = cache.get("detail", kDetail, () => {
    const d = s.detail;
    if (!d.enabled || d.strength === 0) return up;
    const blur = gaussianBlur(input.guide, mm(d.radiusMM));
    const out = new Float32Array(w * h);
    const lim = Math.max(1e-3, d.limit);
    for (let i = 0; i < out.length; i++) {
      const hp = input.guide.data[i] - blur.data[i];
      out[i] = up.data[i] + d.strength * lim * Math.tanh(hp / lim);
    }
    return makeImg(w, h, out);
  });

  // 3. Mask: outside the crop shape goes to the chosen outside level.
  const dist = cache.get("dist", `${size}/${shape}`, () => edgeDistance(w, h, shape));
  const maskOn = s.mask.enabled && shape === "circle";
  const kMask = `${size}/${shape}/${s.mask.softMM}`;
  const mask = maskOn ? cache.get("mask", kMask, () => maskFromDistance(dist, mm(s.mask.softMM))) : null;
  const kMasked = `${kDetail}/${maskOn}/${kMask}/${s.mask.outside}`;
  const masked = cache.get("masked", kMasked, () => {
    if (!mask) return detailed;
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = s.mask.outside + (detailed.data[i] - s.mask.outside) * mask.data[i];
    return makeImg(w, h, out);
  });

  // 4. Background flatten: everything below the threshold becomes one flat level.
  const kFlat = `${kMasked}/${JSON.stringify(s.flatten)}`;
  const flat = cache.get("flatten", kFlat, () => {
    const f = s.flatten;
    if (!f.enabled) return masked;
    const keep = new Float32Array(w * h);
    for (let i = 0; i < keep.length; i++) keep[i] = masked.data[i] >= f.threshold ? 1 : 0;
    const soft = gaussianBlur(makeImg(w, h, keep), mm(f.falloffMM) / 2).data;
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) {
      const m = mask ? mask.data[i] : 1;
      const flattened = f.level + (masked.data[i] - f.level) * soft[i];
      out[i] = masked.data[i] + (flattened - masked.data[i]) * m;
    }
    return makeImg(w, h, out);
  });

  // 5. Rim: a raised ring (circle) or frame (rectangle) along the edge.
  const kRim = `${kFlat}/${JSON.stringify(s.rim)}`;
  const rimmed = cache.get("rim", kRim, () => {
    const r = s.rim;
    if (!r.enabled) return flat;
    const wgt = rimFromDistance(dist, mm(r.widthMM), mm(r.bevelMM)).data;
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) {
      const a = wgt[i] * (mask ? mask.data[i] : 1);
      out[i] = flat.data[i] + (r.height - flat.data[i]) * a;
    }
    return makeImg(w, h, out);
  });

  // 6. Levels + curve.
  const kLevels = `${kRim}/${JSON.stringify(s.levels)}`;
  const leveled = cache.get("levels", kLevels, () => {
    const l = s.levels;
    if (!l.enabled) return clamp01(cloneImg(rimmed));
    return applyLUT(rimmed, toneLUT(l.black, l.white, l.gamma, l.curve));
  });

  // 7. Smoothing: despeckle (isolated pits), edge-preserving bilateral, then a light Gaussian.
  const kSmooth = `${kLevels}/${JSON.stringify(s.smooth)}`;
  const smoothed = cache.get("smooth", kSmooth, () => {
    const m = s.smooth;
    let img = leveled;
    // Despeckle works on a 1-3 pixel neighbourhood at whatever size is being processed.
    if (m.despeckle) img = despeckle(img, Math.max(1, Math.round(m.despeckleRadius)), m.despeckleThreshold);
    if (m.bilateral) img = bilateral(img, mm(m.bilateralMM), m.bilateralRange);
    if (m.gaussianMM > 0) img = gaussianBlur(img, mm(m.gaussianMM));
    return img;
  });

  // 8. Invert for intaglio (sunk) engraving.
  const out = cache.get("invert", `${kSmooth}/${s.invert}`, () => {
    const o = clamp01(cloneImg(smoothed));
    if (s.invert) for (let i = 0; i < o.data.length; i++) o.data[i] = 1 - o.data[i];
    return o;
  });

  return {
    out,
    beforeLevels: rimmed,
    mask,
    histBefore: histogram(rimmed, 256, mask?.data),
    histAfter: histogram(out, 256),
  };
}
