// The post-processing chain, in the order the user sees it:
//   remove tilt -> upsample -> detail boost -> subject -> mask -> background flatten -> rim -> levels/curve -> smoothing -> invert
// Every stage is pure; `PipelineCache` remembers stage outputs so moving a late slider
// (levels, smoothing) doesn't redo the expensive early stages.

import { bilateral, despeckle, extremeFilter, gaussianBlur, guidedUpsample, jointBilateralUpsample } from "./filters";
import { type Img, clamp01, cloneImg, makeImg, resize } from "./image";
import { applyLUT, histogram, lutAt, toneLUT } from "./levels";
import { edgeDistance, maskFromDistance, rimFromDistance } from "./mask";
import { type CropShape, type Settings, type Tone, edgeEps } from "./settings";
import { type PixelMap, composeSubject, sampleSubject } from "./subject";
import { type TextDistances, type TextMasks, composeText, textDistances } from "./text";

export interface PipelineInput {
  depth: Img; // raw model output, 0..1, near = 1
  guide: Img; // luminance of the cropped photo at the output size
  depthVersion: number; // bump when the depth changes
  guideVersion: number; // bump when the photo/crop changes
  coin?: boolean; // the background is a blank coin (levelled and scaled as one, see levelCoin)
  subject?: SubjectInput | null; // a cut-out placed on the coin
  texts?: TextInput | null; // text layers' masks
}

export interface TextInput {
  masks: TextMasks[]; // at the output size, matched to settings.texts by id
  version: number; // bump when any mask changes
}

export interface SubjectInput {
  depth: Img; // the model's depth of the subject image (its own pixels), near = 1
  base: number; // depth where the subject meets its backdrop
  peak: number; // depth of its highest point
  guide: Img; // subject luminance in output pixels (over mid-gray)
  alpha: Img; // subject coverage in output pixels, 0..1
  toDepth: PixelMap; // output pixel -> subject depth pixel
  version: number; // bump when the depth or placement changes
}

export interface PipelineResult {
  out: Img; // final map, 0..1, white = highest
  beforeLevels: Img; // input to the levels step (for the histogram)
  mask: Img | null; // 1 inside the crop mask
  histBefore: Uint32Array; // 256 bins of beforeLevels inside the mask
  histAfter: Uint32Array; // 256 bins of out (whole image)
  histCoin: Uint32Array | null; // a background coin's heights (field 0, top 1) inside the crop, before its tone
  histSubject: Uint32Array | null; // the subject's relief where it is, before its tone
}

export class PipelineCache {
  private stages = new Map<string, { key: string; value: unknown }>();
  get<T = Img>(name: string, key: string, compute: () => T): T {
    const hit = this.stages.get(name);
    if (hit && hit.key === key) return hit.value as T;
    const value = compute();
    this.stages.set(name, { key, value });
    return value;
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
  const plane = tiltPlane(depth, inside);
  if (!plane) return depth;
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

/** The plane z = a + b x + c y (x, y from -0.5 to 0.5) through the field, fitted as described above. */
function tiltPlane(depth: Img, inside: (x: number, y: number) => boolean): number[] | null {
  const { w, h, data } = depth;
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
  if (zs.length < 10) return null;
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
  return plane;
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

/**
 * Level a blank coin for use as a background. Depth models read its flat field as tilted or domed
 * (by different amounts for every coin), and its rim and pattern stand only slightly above the
 * field, so a plane fit isn't enough. With `flatten`, the tilt comes out first (as removeTilt),
 * then every raised detail is measured from the coin's local base: the lower envelope of the depth
 * over a window wider than a rim (a morphological opening, then smoothed). Then the field is scaled
 * to 0 and the highest details, usually the rim, to 1. The coin's outer edge, sloping away, goes
 * below 0.
 */
export function levelCoin(depth: Img, shape: CropShape, flatten: boolean): Img {
  const { w, h, data } = depth;
  // Distance from the centre, 1 at the crop edge.
  const rho = (x: number, y: number) => {
    const u = (x + 0.5) / w - 0.5;
    const v = (y + 0.5) / h - 0.5;
    return shape === "circle" ? 2 * Math.hypot(u, v) : 2 * Math.max(Math.abs(u), Math.abs(v));
  };
  const inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) inside[y * w + x] = rho(x, y) < 0.96 ? 1 : 0;
  const out = data.slice();
  if (flatten) {
    const plane = tiltPlane(depth, (x, y) => inside[y * w + x] === 1);
    if (plane) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] -= plane[1] * (x / w - 0.5) + plane[2] * (y / h - 0.5);
    // Only the coin itself shapes the base: beyond its edge the depth drops away. The window
    // (a tenth of the radius each way) is wider than a rim, so rims count as raised.
    const r = Math.max(1, Math.round(0.1 * (Math.min(w, h) / 2)));
    const masked = (img: Float32Array, none: number) => makeImg(w, h, img.map((v, i) => (inside[i] ? v : none)));
    const lo = extremeFilter(masked(out, Infinity), r, false).data;
    for (let i = 0; i < lo.length; i++) if (!Number.isFinite(lo[i])) lo[i] = out[i];
    const opened = extremeFilter(masked(lo, -Infinity), r, true).data;
    for (let i = 0; i < opened.length; i++) if (!Number.isFinite(opened[i])) opened[i] = out[i];
    const base = gaussianBlur(makeImg(w, h, opened), r / 2).data;
    for (let i = 0; i < out.length; i++) out[i] -= base[i];
  }
  const stride = Math.max(1, Math.round(Math.sqrt((w * h) / 120_000)));
  const field: number[] = [];
  const coin: number[] = [];
  for (let y = 0; y < h; y += stride)
    for (let x = 0; x < w; x += stride) {
      if (!inside[y * w + x]) continue;
      coin.push(out[y * w + x]);
      if (rho(x, y) < 0.6) field.push(out[y * w + x]);
    }
  if (!field.length) return makeImg(w, h, new Float32Array(w * h));
  field.sort((a, b) => a - b);
  coin.sort((a, b) => a - b);
  const level = field[Math.floor(field.length / 2)];
  const top = coin[Math.min(coin.length - 1, Math.floor(coin.length * 0.995))];
  // A coin with nothing raised would have its noise blown up to full height: cap the scaling
  // (model depth is 0..1 over the whole image; a rim is usually a few hundredths of that).
  const span = Math.max(top - level, 0.01);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - level) / span;
  return makeImg(w, h, out);
}

/** Enlarge depth to the guide's size, following the photo's edges (or plain bilinear). */
function upsample(depth: Img, guide: Img, u: Settings["upsample"]): Img {
  if (depth.w === guide.w && depth.h === guide.h && (!u.enabled || u.method === "bilinear")) return depth;
  if (!u.enabled || u.method === "bilinear") return resize(depth, guide.w, guide.h);
  if (u.method === "jbu") return jointBilateralUpsample(depth, guide, u.radius + 1, Math.max(0.01, Math.sqrt(edgeEps(u.edge)) * 2));
  return guidedUpsample(depth, guide, u.radius, edgeEps(u.edge));
}

/** Add the photo's fine texture (high-pass at `radius` px) as height, soft-clipped at the limit. */
function detailBoost(img: Img, guide: Img, d: Settings["detail"], radius: number): Img {
  if (!d.enabled || d.strength === 0) return img;
  const blur = gaussianBlur(guide, radius);
  const out = new Float32Array(img.data.length);
  const lim = Math.max(1e-3, d.limit);
  for (let i = 0; i < out.length; i++) {
    const hp = guide.data[i] - blur.data[i];
    out[i] = img.data[i] + d.strength * lim * Math.tanh(hp / lim);
  }
  return makeImg(img.w, img.h, out);
}

/** pxPerMM: pixels per millimetre at the size being processed (preview or export). */
export function runPipeline(input: PipelineInput, s: Settings, pxPerMM: number, cache = new PipelineCache()): PipelineResult {
  const { w, h } = input.guide;
  const mm = (v: number) => v * pxPerMM;
  const size = `${w}x${h}@${pxPerMM.toFixed(5)}`;
  const shape = s.crop.shape;

  // 0. Remove tilt: depth models read a flat coin as leaning back; take the plane out.
  //    A background coin is levelled and scaled as a blank (field 0, top 1).
  const coin = !!input.coin;
  const kTilt = `${input.depthVersion}/${shape}/${s.tilt.enabled}/${coin}`;
  const level = cache.get("tilt", kTilt, () =>
    coin ? levelCoin(input.depth, shape, s.tilt.enabled) : s.tilt.enabled ? removeTilt(input.depth, shape) : input.depth);

  // 1. Upsample model depth to the output size, guided by the photo.
  const kUp = `${kTilt}/${input.guideVersion}/${size}/${JSON.stringify(s.upsample)}`;
  const up = cache.get("upsample", kUp, () => upsample(level, input.guide, s.upsample));

  // 2. Detail boost: add back fine texture from the photo's high-pass, soft-clipped.
  const kDetail = `${kUp}/${JSON.stringify(s.detail)}`;
  const detailed = cache.get("detail", kDetail, () => detailBoost(up, input.guide, s.detail, mm(s.detail.radiusMM)));

  // 2b. Coin heights: a background coin's field goes to the field level, its top to the coin top,
  //     through the coin's own levels and curve. Below the field (its outer edge) stays linear.
  //     The layers' own levels and curves are off when the levels step is.
  const coinTone = s.levels.enabled ? s.coin.tone : null;
  const subjectTone = s.levels.enabled ? s.subject.tone : null;
  const kCoin = coin ? `${kDetail}/${s.coin.field}/${s.coin.top}/${JSON.stringify(coinTone)}` : kDetail;
  const coinHeights = !coin
    ? detailed
    : cache.get("coin", kCoin, () => {
        const out = new Float32Array(w * h);
        const { field, top } = s.coin;
        const lut = coinTone && toneLUT_(coinTone);
        const k = coinTone ? coinTone.strength : 1;
        for (let i = 0; i < out.length; i++) {
          const c = detailed.data[i];
          const t = c < 0 ? c * k : lut ? lutAt(lut, c) : Math.min(1, c);
          out[i] = Math.min(1, Math.max(0, field + (top - field) * t));
        }
        return makeImg(w, h, out);
      });

  // 2c. Subject: a cut-out with its own depth, upsampled and detailed like the coin, then set on it.
  const sub = input.subject;
  const kRelief = sub ? `${sub.version}/${size}/${JSON.stringify(s.upsample)}/${JSON.stringify(s.detail)}` : "";
  const kSubject = sub ? `${kCoin}/${kRelief}/${s.subject.top}/${s.subject.edgeMM}/${JSON.stringify(subjectTone)}` : kCoin;
  const relief = !sub
    ? null
    : cache.get("subjectRelief", kRelief, () => {
        const placed = sampleSubject(sub.depth, sub.base, sub.peak, sub.toDepth, w, h);
        return detailBoost(upsample(placed, sub.guide, s.upsample), sub.guide, s.detail, mm(s.detail.radiusMM));
      });
  const withSubject = !sub || !relief
    ? coinHeights
    : cache.get("subject", kSubject, () => {
        const lut = subjectTone && toneLUT_(subjectTone);
        return composeSubject(coinHeights, lut ? applyLUT(relief, lut) : relief, sub.alpha, s.subject, pxPerMM);
      });

  // 2d. Text layers, each laid on what's below it.
  const tx = input.texts;
  const layers = tx ? s.texts.filter((t) => t.enabled && tx.masks.some((m) => m.id === t.id)) : [];
  const kText = layers.length ? `${kSubject}/${tx!.version}/${size}/${JSON.stringify(layers)}` : kSubject;
  const withText = !layers.length
    ? withSubject
    : cache.get("text", kText, () => {
        let img = withSubject;
        for (const t of layers) {
          const m = tx!.masks.find((x) => x.id === t.id)!;
          const reach = [t.outline.gapMM, t.outline.widthMM, t.bevelMM, t.plate.bevelMM, t.plate.border.widthMM];
          const dist = cache.get<TextDistances>(`textDist${t.id}`, `${m.version ?? tx!.version}/${size}/${pxPerMM}/${reach}`, () => textDistances(m, w, h, t, pxPerMM));
          img = composeText(img, m, dist, t, pxPerMM, toneLUT_(t.tone, 1));
        }
        return img;
      });

  // 3. Mask: outside the crop shape goes to the chosen outside level.
  const dist = cache.get("dist", `${size}/${shape}`, () => edgeDistance(w, h, shape));
  const maskOn = s.mask.enabled && shape === "circle";
  const kMask = `${size}/${shape}/${s.mask.softMM}`;
  const mask = maskOn ? cache.get("mask", kMask, () => maskFromDistance(dist, mm(s.mask.softMM))) : null;
  const kMasked = `${kText}/${maskOn}/${kMask}/${s.mask.outside}`;
  const masked = cache.get("masked", kMasked, () => {
    if (!mask) return withText;
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = s.mask.outside + (withText.data[i] - s.mask.outside) * mask.data[i];
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

  // 6. Levels + curve. Its strength scales the depth below the top surface (white).
  const kLevels = `${kRim}/${JSON.stringify(s.levels)}`;
  const leveled = cache.get("levels", kLevels, () => {
    const lut = s.levels.enabled && toneLUT_(s.levels, s.levels.strength, 1);
    return clamp01(lut ? applyLUT(rimmed, lut) : cloneImg(rimmed));
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
    histCoin: coin ? cache.get("histCoin", kDetail, () => histogram(detailed, 256, mask?.data)) : null,
    histSubject: sub && relief ? cache.get("histSubject", kRelief, () => histogram(relief, 256, sub.alpha.data)) : null,
  };
}

/**
 * A tone's lookup table, or null when it changes nothing. A layer's strength scales its relief
 * from what it stands on (anchor 0); the final levels' from the top surface (anchor 1).
 */
function toneLUT_(t: Tone, strength = t.strength, anchor = 0): Float32Array | null {
  if (strength === 1 && t.black === 0 && t.white === 1 && t.gamma === 1 && !t.curve.length) return null;
  return toneLUT(t.black, t.white, t.gamma, t.curve, strength, anchor);
}

