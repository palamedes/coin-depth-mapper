// Mask and rim geometry in output pixels. The crop is already applied, so a circle crop
// is the inscribed circle of the output square and a rectangle crop is the whole frame.

import { type Img, makeImg } from "./image";
import type { CropShape } from "./settings";

/** Signed distance (pixels) from each pixel centre to the mask edge; positive inside. */
export function edgeDistance(w: number, h: number, shape: CropShape): Img {
  const out = new Float32Array(w * h);
  if (shape === "circle") {
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2;
    for (let y = 0; y < h; y++) {
      const dy = y + 0.5 - cy;
      for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - cx;
        out[y * w + x] = r - Math.sqrt(dx * dx + dy * dy);
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const ey = Math.min(y + 0.5, h - y - 0.5);
      for (let x = 0; x < w; x++) out[y * w + x] = Math.min(ey, Math.min(x + 0.5, w - x - 0.5));
    }
  }
  return makeImg(w, h, out);
}

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** 1 inside, 0 outside. `soft` px fades in from the edge inwards; 0 gives a 1-px anti-aliased edge. */
export function maskFromDistance(dist: Img, soft: number): Img {
  const out = new Float32Array(dist.data.length);
  for (let i = 0; i < out.length; i++) {
    const e = dist.data[i];
    out[i] = soft > 0.5 ? smoothstep(0, soft, e) : Math.min(1, Math.max(0, e + 0.5));
  }
  return makeImg(dist.w, dist.h, out);
}

/** Rim weight: 1 within `width` px of the edge, easing to 0 over `bevel` px further in. */
export function rimFromDistance(dist: Img, width: number, bevel: number): Img {
  const out = new Float32Array(dist.data.length);
  for (let i = 0; i < out.length; i++) {
    const e = dist.data[i];
    out[i] = e < 0 ? 0 : 1 - smoothstep(width, width + Math.max(bevel, 0.5), e);
  }
  return makeImg(dist.w, dist.h, out);
}
