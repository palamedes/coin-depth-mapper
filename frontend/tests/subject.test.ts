import { describe, expect, it } from "vitest";
import { type Img, fill, makeImg, sample } from "../src/proc/image";
import { type SubjectInput, levelCoin, runPipeline } from "../src/proc/pipeline";
import { extremeFilter } from "../src/proc/filters";
import { defaultSettings, flatTone } from "../src/proc/settings";
import { composeSubject, hasTransparency, placeSubject, sampleSubject, subjectLevels, subjectMeta } from "../src/proc/subject";

// A subject image: 200 x 100 px, visible in the box x 50..150, y 20..80.
const meta = { imageW: 200, imageH: 100, box: { x: 50, y: 20, w: 100, h: 60 }, region: { x: 46, y: 16, w: 108, h: 68 } };

/** A dome on a flat backdrop, like the model's depth of a cut-out in front of gray: backdrop 0.3, top 0.9. */
function domeDepth(w: number, h: number): { depth: Img; alpha: Float32Array } {
  const depth = new Float32Array(w * h);
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = Math.hypot((x + 0.5) / w - 0.5, (y + 0.5) / h - 0.5) / 0.4;
      alpha[y * w + x] = r < 1 ? 1 : 0;
      depth[y * w + x] = 0.3 + 0.6 * Math.max(0, 1 - r * r);
    }
  return { depth: makeImg(w, h, depth), alpha };
}

describe("subject placement", () => {
  it("centres the subject's visible box at the offset and scales its longest side to size x width", () => {
    const W = 400, H = 400;
    const p = placeSubject(meta, { size: 0.5, x: 0.1, y: -0.05, top: 1, edgeMM: 0, tone: flatTone() }, W, H);
    const k = p.toRegion.k; // image px per output px
    expect(meta.box.w / k).toBeCloseTo(200, 6); // 0.5 x 400
    // The box centre (image 100, 50) lands at (200 + 40, 200 - 20).
    expect(p.draw.x + 100 / k).toBeCloseTo(240, 6);
    expect(p.draw.y + 50 / k).toBeCloseTo(180, 6);
    expect(p.draw.w).toBeCloseTo(200 / k, 6);
    // toRegion is the inverse: that output point maps to the box centre in region pixels.
    expect(k * 240 + p.toRegion.ox).toBeCloseTo(100 - meta.region.x, 6);
    expect(k * 180 + p.toRegion.oy).toBeCloseTo(50 - meta.region.y, 6);
  });

  it("finds the visible box from the alpha channel, with a margin for the model, clipped to the image", () => {
    const w = 40, h = 20;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 5; y < 15; y++) for (let x = 0; x < 30; x++) rgba[(y * w + x) * 4 + 3] = 255;
    const m = subjectMeta(rgba, w, h, 80, 40)!; // measured at half size
    expect(m.box).toEqual({ x: 0, y: 10, w: 60, h: 20 });
    expect(m.region.x).toBe(0); // the margin can't go past the left edge
    expect(m.region.y).toBeLessThan(10);
    expect(m.region.x + m.region.w).toBeGreaterThan(60);
    expect(subjectMeta(new Uint8ClampedArray(w * h * 4), w, h)).toBeNull();
  });

  it("calls an image a cut-out only when a real share of it is see-through", () => {
    const rgba = new Uint8ClampedArray(100 * 100 * 4).fill(255);
    expect(hasTransparency(rgba)).toBe(false);
    rgba[3] = 0; // one stray pixel
    expect(hasTransparency(rgba)).toBe(false);
    for (let i = 0; i < 1000; i++) rgba[i * 4 + 3] = 0;
    expect(hasTransparency(rgba)).toBe(true);
  });

  it("reads the backdrop level and the subject's top from its depth", () => {
    const { depth, alpha } = domeDepth(120, 120);
    const { base, peak } = subjectLevels(depth, alpha);
    expect(base).toBeCloseTo(0.3, 3);
    expect(peak).toBeGreaterThan(0.88);
    expect(peak).toBeLessThanOrEqual(0.9);
  });

  it("samples the subject as relief from 0 (where it meets the coin) to 1 (its top), wherever it is placed", () => {
    const { depth } = domeDepth(100, 100);
    // Output 200 x 200; the depth's 100 px span 160 output px, centred at (110, 95).
    const k = 100 / 160;
    const relief = sampleSubject(depth, 0.3, 0.9, { k, ox: 50 - 110 * k, oy: 50 - 95 * k }, 200, 200);
    // Coarser than the output, so it comes back on a grid of the depth's density.
    expect(relief.w).toBe(125);
    const at = (x: number, y: number) => sample(relief, (x * relief.w) / 200, (y * relief.h) / 200);
    expect(at(110, 95)).toBeGreaterThan(0.98);
    expect(at(5, 195)).toBeLessThan(1e-6);
    expect(at(110 + 64, 95)).toBeLessThan(0.05); // the dome's rim
    // Denser than the output: sampled straight at the output size.
    expect(sampleSubject(depth, 0.3, 0.9, { k: 2, ox: 0, oy: 0 }, 50, 50).w).toBe(50);
  });
});

describe("subject on the coin", () => {
  const s = { ...defaultSettings().subject, top: 1, edgeMM: 0 };

  it("stands on the coin's surface, rises to the chosen top, and hides the field texture under it", () => {
    const w = 120, h = 120;
    // Coin: field at 0.3 with a fine 2 px stripe texture of +-0.05.
    const coin = makeImg(w, h, Float32Array.from({ length: w * h }, (_, i) => 0.3 + (i % 2 ? 0.05 : -0.05)));
    const relief = fill(w, h, 0.5);
    const alpha = makeImg(w, h, Float32Array.from({ length: w * h }, (_, i) => (i % w >= 60 ? 1 : 0)));
    const out = composeSubject(coin, relief, alpha, s, 4);
    // Left half: the coin, texture and all.
    expect(out.data[30 * w + 10]).toBeCloseTo(coin.data[30 * w + 10], 6);
    // Right half: half way from the smoothed field (0.3) to the top (1), with no stripes.
    const row = Array.from(out.data.subarray(30 * w + 80, 30 * w + 100));
    for (const v of row) expect(v).toBeCloseTo(0.65, 2);
  });

  it("runs through the pipeline: the subject's top reaches `top`, the crop mask still applies, and moving it moves the peak", () => {
    const st = defaultSettings();
    st.tilt.enabled = false;
    st.detail.enabled = false;
    st.upsample.method = "bilinear";
    st.smooth.despeckle = false;
    st.smooth.gaussianMM = 0;
    st.subject = { ...st.subject, top: 0.9, edgeMM: 0 };
    const W = 100;
    const { depth } = domeDepth(64, 64);
    const subjectAt = (cx: number, version: number): SubjectInput => {
      // The dome's 64 depth px span 50 output px, centred at (cx, 50).
      const k = 64 / 50;
      const alpha = makeImg(W, W, Float32Array.from({ length: W * W }, (_, i) => (Math.hypot((i % W) + 0.5 - cx, Math.floor(i / W) + 0.5 - 50) < 20 ? 1 : 0)));
      return { depth, base: 0.3, peak: 0.9, guide: fill(W, W, 0.5), alpha, toDepth: { k, ox: 32 - cx * k, oy: 32 - 50 * k }, version };
    };
    const coin = fill(16, 16, 0.2);
    const run = (sub: SubjectInput) => runPipeline({ depth: coin, guide: fill(W, W, 0.5), depthVersion: 1, guideVersion: 1, subject: sub }, st, 4).out;
    const a = run(subjectAt(50, 1));
    expect(a.data[50 * W + 50]).toBeCloseTo(0.9, 2);
    expect(a.data[50 * W + 85]).toBeCloseTo(0.2, 2); // the coin's field beside it
    expect(a.data[0]).toBe(st.mask.outside); // corner: outside the circle
    const b = run(subjectAt(35, 2));
    expect(b.data[50 * W + 35]).toBeCloseTo(0.9, 2);
    expect(b.data[50 * W + 65]).toBeCloseTo(0.2, 2);
  });
});

describe("background coin", () => {
  it("takes the tilt and dome out of a blank coin's field, then puts the field at 0 and the rim at 1", () => {
    const n = 200;
    // Field at 0.7 with a tilt and a dome (as depth models see a flat coin), a rim 0.02 higher, and
    // the coin's edge dropping away outside it.
    const d = new Float32Array(n * n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const u = (x + 0.5) / n - 0.5, v = (y + 0.5) / n - 0.5;
        const r = 2 * Math.hypot(u, v);
        d[y * n + x] = 0.7 + 0.3 * v - 0.3 * (u * u + v * v) + (r > 0.88 && r < 0.96 ? 0.02 : 0) - (r > 0.97 ? 0.3 : 0);
      }
    const out = levelCoin(makeImg(n, n, d), "circle", true);
    const at = (u: number, v: number) => sample(out, (u + 0.5) * n, (v + 0.5) * n);
    for (const [u, v] of [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3], [0.2, 0.2], [-0.25, -0.25]]) expect(Math.abs(at(u, v))).toBeLessThan(0.1);
    const rim = [[0.46, 0], [-0.46, 0], [0, 0.46], [0, -0.46]].map(([u, v]) => at(u, v));
    for (const v of rim) expect(v).toBeGreaterThan(0.7);
    expect(Math.max(...rim) - Math.min(...rim)).toBeLessThan(0.05); // the same all the way round: the tilt is gone
    expect(at(0.495, 0)).toBeLessThan(0); // the edge dropping away
    // Without flattening only the scaling happens, so the tilt stays.
    const raw = levelCoin(makeImg(n, n, d), "circle", false);
    expect(sample(raw, n / 2, n * 0.2) - sample(raw, n / 2, n * 0.8)).toBeLessThan(-1);
  });

  it("min/max filters match a brute-force window, with Infinity as no value", () => {
    const w = 23, h = 17, r = 3;
    const src = makeImg(w, h, Float32Array.from({ length: w * h }, (_, i) => (i % 7 === 3 ? Infinity : Math.sin(i * 12.9898) * 43758.5453 % 1)));
    for (const max of [false, true]) {
      const got = extremeFilter(src, r, max).data;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let best = max ? -Infinity : Infinity;
          for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
            for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
              const v = src.data[yy * w + xx];
              best = max ? Math.max(best, v) : Math.min(best, v);
            }
          expect(got[y * w + x]).toBe(Math.fround(best));
        }
    }
  });

  it("doesn't blow up noise on a coin with nothing raised", () => {
    const n = 64;
    const d = Float32Array.from({ length: n * n }, (_, i) => 0.5 + 1e-4 * Math.sin(i * 1.7));
    const out = levelCoin(makeImg(n, n, d), "circle", true);
    for (const v of out.data) expect(Math.abs(v)).toBeLessThan(0.05);
    const flat = levelCoin(makeImg(8, 8, new Float32Array(64)), "circle", true);
    for (const v of flat.data) expect(v).toBe(0);
  });
});
