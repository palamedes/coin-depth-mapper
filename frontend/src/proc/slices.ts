// Model of LightBurn's "3D Sliced" image mode.
//
// LightBurn docs: the darkest shades get the full Number of Passes, lighter shades get
// progressively fewer, pure white gets none. LightBurn staff on the forum: each pass is
// the image thresholded at one level, run as a 1-bit image, with thresholds spaced evenly
// from white to black, so 256 passes on an 8-bit image is one pass per gray level.
// LightBurn 2.1+ reads 16-bit images for this mode.
//
// So a pixel with value v (0..max) gets passes(v) = N - ceil(v / max * N): white -> 0,
// black -> N. The exact rounding at the extremes inside LightBurn isn't documented and may
// differ by one pass.

import type { Img } from "./image";

export function quantize(v: number, bits: 8 | 16): number {
  const max = bits === 16 ? 65535 : 255;
  const q = Math.round(v * max);
  return q < 0 ? 0 : q > max ? max : q;
}

/** How many passes LightBurn fires on a pixel of gray value q (0..max). */
export function passesFor(q: number, max: number, passes: number): number {
  const p = passes - Math.ceil((q / max) * passes - 1e-9);
  return p < 0 ? 0 : p > passes ? passes : p;
}

/**
 * Pixels that fire on pass k (1-based). Passes are numbered the way LightBurn's preview
 * shows them: the engraved area grows with each pass, so pass 1 is only the deepest pixels
 * and pass N is every pixel that isn't pure white. The order doesn't change the result,
 * only which picture you see for a given pass number.
 */
export function firesOnPass(q: number, max: number, passes: number, k: number): boolean {
  return passesFor(q, max, passes) >= passes - k + 1;
}

export function sliceMask(img: Img, bits: 8 | 16, passes: number, k: number): Uint8Array {
  const max = bits === 16 ? 65535 : 255;
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = firesOnPass(quantize(img.data[i], bits), max, passes, k) ? 1 : 0;
  return out;
}

export interface LevelStats {
  distinct8: number; // gray levels used once saved as 8-bit
  distinct16: number; // values used once saved as 16-bit
  min8: number;
  max8: number;
  maxPasses: number; // passes the deepest pixel gets
  histogram8: Uint32Array;
}

export function levelStats(img: Img, passes: number): LevelStats {
  const h8 = new Uint32Array(256);
  const seen16 = new Uint8Array(65536);
  let distinct16 = 0;
  for (const v of img.data) {
    h8[quantize(v, 8)]++;
    const q = quantize(v, 16);
    if (!seen16[q]) {
      seen16[q] = 1;
      distinct16++;
    }
  }
  let distinct8 = 0;
  let min8 = 255;
  let max8 = 0;
  for (let i = 0; i < 256; i++) {
    if (!h8[i]) continue;
    distinct8++;
    if (i < min8) min8 = i;
    if (i > max8) max8 = i;
  }
  return { distinct8, distinct16, min8, max8, maxPasses: passesFor(min8, 255, passes), histogram8: h8 };
}
