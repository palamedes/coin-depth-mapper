// A cut-out subject (an image with a transparent background, like a pet portrait) placed on a
// coin. The subject gets its own depth-model run on its own pixels, so moving or resizing it
// on the coin only resamples that depth; the model never runs again.

import { gaussianBlur } from "./filters";
import { type Img, makeImg, sample } from "./image";
import type { Settings } from "./settings";

type Box = { x: number; y: number; w: number; h: number };

/** Where the subject is in its own image, in that image's pixels. */
export interface SubjectMeta {
  imageW: number;
  imageH: number;
  box: Box; // around the visible (non-transparent) pixels
  region: Box; // box plus a margin, clipped to the image: what the depth model sees
}

/** An affine map from output pixel coordinates to another image's pixel coordinates. */
export interface PixelMap {
  k: number;
  ox: number;
  oy: number;
}

export interface Placement {
  draw: Box; // where the whole subject image lands, in output pixels
  toRegion: PixelMap; // output pixel -> pixel in the region the model saw
}

/** Subject placement on a W x H output: centred at (x, y) and scaled so its longest side is size x W. */
export function placeSubject(meta: SubjectMeta, s: Settings["subject"], W: number, H: number): Placement {
  const k = Math.max(meta.box.w, meta.box.h) / Math.max(1e-6, s.size * W); // image px per output px
  const cx = W / 2 + s.x * W;
  const cy = H / 2 + s.y * H;
  const bx = meta.box.x + meta.box.w / 2;
  const by = meta.box.y + meta.box.h / 2;
  return {
    draw: { x: cx - bx / k, y: cy - by / k, w: meta.imageW / k, h: meta.imageH / k },
    toRegion: { k, ox: bx - cx * k - meta.region.x, oy: by - cy * k - meta.region.y },
  };
}

/** The visible part of an image from its alpha channel (RGBA bytes), with a margin for the model. */
export function subjectMeta(rgba: Uint8ClampedArray, w: number, h: number, imageW = w, imageH = h): SubjectMeta | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (rgba[(y * w + x) * 4 + 3] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const sx = imageW / w;
  const sy = imageH / h;
  const box = { x: x0 * sx, y: y0 * sy, w: (x1 + 1 - x0) * sx, h: (y1 + 1 - y0) * sy };
  const m = 0.04 * Math.max(box.w, box.h);
  const rx = Math.max(0, Math.floor(box.x - m));
  const ry = Math.max(0, Math.floor(box.y - m));
  const region = { x: rx, y: ry, w: Math.min(imageW, Math.ceil(box.x + box.w + m)) - rx, h: Math.min(imageH, Math.ceil(box.y + box.h + m)) - ry };
  return { imageW, imageH, box, region };
}

/** True when more than a sliver of the image is see-through. */
export function hasTransparency(rgba: Uint8ClampedArray): boolean {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) n++;
  return n > (rgba.length / 4) * 0.005;
}

/**
 * Depth of the plain background around the subject (base) and of its highest point (peak), from
 * the model's depth and the subject's coverage at the same size. The model sees the subject in
 * front of flat gray, so the base is where the subject meets the coin.
 */
export function subjectLevels(depth: Img, alpha: Float32Array): { base: number; peak: number } {
  const bg: number[] = [];
  const fg: number[] = [];
  const stride = Math.max(1, Math.floor(Math.sqrt(depth.data.length / 250_000)));
  for (let y = 0; y < depth.h; y += stride)
    for (let x = 0; x < depth.w; x += stride) {
      const i = y * depth.w + x;
      if (alpha[i] < 0.02) bg.push(depth.data[i]);
      else if (alpha[i] > 0.5) fg.push(depth.data[i]);
    }
  if (!fg.length) return { base: 0, peak: 1 };
  fg.sort((a, b) => a - b);
  bg.sort((a, b) => a - b);
  const at = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  const base = bg.length > 0.01 * (bg.length + fg.length) ? at(bg, 0.5) : at(fg, 0.01);
  const peak = Math.max(base + 1e-3, at(fg, 0.998));
  return { base, peak };
}

/**
 * Sample the subject's depth into output pixels as relief: 0 where it meets the coin, 1 at its
 * highest point. Returns it on a grid as dense as the model's pixels (at most the output size),
 * for the caller to upsample guided by the subject's photo.
 */
export function sampleSubject(depth: Img, base: number, peak: number, toDepth: PixelMap, w: number, h: number): Img {
  const { k, ox, oy } = toDepth;
  // Shrinking: blur first so fine depth doesn't alias. Enlarging: sample at the model's density.
  const src = k > 1.5 ? gaussianBlur(depth, 0.5 * k) : depth;
  const gw = k < 1 ? Math.max(2, Math.round(w * k)) : w;
  const gh = k < 1 ? Math.max(2, Math.round(h * k)) : h;
  const span = Math.max(1e-6, peak - base);
  const out = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const Y = ((gy + 0.5) * h) / gh;
    for (let gx = 0; gx < gw; gx++) {
      const X = ((gx + 0.5) * w) / gw;
      const d = sample(src, k * X + ox, k * Y + oy);
      const r = (d - base) / span;
      out[gy * gw + gx] = r < 0 ? 0 : r > 1 ? 1 : r;
    }
  }
  return makeImg(gw, gh, out);
}

/**
 * Set the subject on the coin. Under the subject the coin is smoothed (its field texture would
 * otherwise show through), the subject stands on that surface and rises to `top`. `alpha` is the
 * subject's coverage; the edge softness blurs it so the outline eases into the coin.
 */
export function composeSubject(coin: Img, relief: Img, alpha: Img, s: Settings["subject"], pxPerMM: number): Img {
  const base = gaussianBlur(coin, 0.75 * pxPerMM).data;
  const m = s.edgeMM > 0 ? gaussianBlur(alpha, (s.edgeMM * pxPerMM) / 2).data : alpha.data;
  const out = new Float32Array(coin.data.length);
  for (let i = 0; i < out.length; i++) {
    const c = coin.data[i];
    const standing = base[i] + relief.data[i] * (s.top - base[i]);
    out[i] = c + (standing - c) * m[i];
  }
  return makeImg(coin.w, coin.h, out);
}
