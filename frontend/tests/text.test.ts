import { describe, expect, it } from "vitest";
import { fill, makeImg } from "../src/proc/image";
import { PipelineCache, runPipeline } from "../src/proc/pipeline";
import { defaultSettings, defaultTextLayer, flatTone, mergeSettings } from "../src/proc/settings";
import { composeText, distanceTo, signedDistance, textDistances, type TextMasks } from "../src/proc/text";

const W = 120;
const H = 80;

/** A filled rectangle as a coverage mask. */
function rect(x0: number, y0: number, x1: number, y1: number): Float32Array {
  const m = new Float32Array(W * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1;
  return m;
}

describe("distance transform", () => {
  it("matches brute force", () => {
    const w = 31, h = 23;
    const f = new Uint8Array(w * h);
    for (const i of [5, 100, 333, 600, 700]) f[i] = 1;
    const d = distanceTo(f, w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let i = 0; i < f.length; i++) if (f[i]) best = Math.min(best, Math.hypot(x - (i % w), y - Math.floor(i / w)));
        expect(d[y * w + x]).toBeCloseTo(best, 4);
      }
  });

  it("gives signed distance to a mask's edge: + inside, - outside, only around the mask", () => {
    const sd = signedDistance(rect(40, 30, 80, 50), W, H, 5)!;
    const at = (x: number, y: number) => sd.d[(y - sd.y0) * sd.bw + (x - sd.x0)];
    expect(at(40, 40)).toBeCloseTo(0.5); // first pixel inside the left edge
    expect(at(39, 40)).toBeCloseTo(-0.5);
    expect(at(60, 40)).toBeCloseTo(9.5); // middle: 10 px from the top and bottom edges
    expect(at(35, 40)).toBeCloseTo(-4.5);
    expect(sd.bw).toBeLessThan(W);
    expect(signedDistance(new Float32Array(W * H), W, H, 5)).toBeNull();
  });
});

describe("text layers", () => {
  const masks = (plate = false): TextMasks => ({ id: 1, glyph: rect(40, 30, 80, 50), plate: plate ? rect(30, 22, 90, 58) : null });

  it("raises letters to their height, with a sloped edge of the set width", () => {
    const t = { ...defaultTextLayer(1), height: 0.9, bevelMM: 2 }; // 2 mm at 2 px/mm = 4 px
    const surface = fill(W, H, 0.3);
    const m = masks();
    const out = composeText(surface, m, textDistances(m, W, H, t, 2), t, 2, null).data;
    expect(out[40 * W + 60]).toBeCloseTo(0.9, 5); // well inside
    expect(out[40 * W + 41]).toBeCloseTo(0.3 + 0.6 * (1.5 / 4), 5); // 1.5 px up a 4 px slope
    expect(out[40 * W + 20]).toBeCloseTo(0.3, 5); // the coin, untouched
  });

  it("sinks letters below the surface when their height is lower", () => {
    const t = { ...defaultTextLayer(1), height: 0.1, bevelMM: 0 };
    const m = masks();
    const out = composeText(fill(W, H, 0.5), m, textDistances(m, W, H, t, 2), t, 2, null).data;
    expect(out[40 * W + 60]).toBeCloseTo(0.1, 5);
  });

  it("puts an outline ring at the gap around the letters, and a plate with a border under them", () => {
    const t = defaultTextLayer(1);
    Object.assign(t, { height: 1, bevelMM: 0 });
    t.outline = { enabled: true, widthMM: 1, gapMM: 1, height: 0.7 }; // 2 px wide, 2 px out
    t.plate = { enabled: true, paddingMM: 0, rounded: false, height: 0.5, bevelMM: 0, border: { enabled: true, widthMM: 1, height: 0.8 } };
    const m = masks(true);
    const out = composeText(fill(W, H, 0.2), m, textDistances(m, W, H, t, 2), t, 2, null).data;
    expect(out[40 * W + 60]).toBeCloseTo(1, 5); // letter
    expect(out[40 * W + 39]).toBeCloseTo(0.5, 5); // gap: the plate shows
    expect(out[40 * W + 37]).toBeCloseTo(0.7, 5); // outline, 2-4 px out
    expect(out[40 * W + 34]).toBeCloseTo(0.5, 5); // plate again
    expect(out[40 * W + 30]).toBeCloseTo(0.8, 5); // plate border at its edge
    expect(out[40 * W + 25]).toBeCloseTo(0.2, 5); // the coin outside the plate
  });

  it("runs in the pipeline, matched to the settings by id, and only when enabled", () => {
    const s = defaultSettings();
    Object.assign(s.tilt, { enabled: false });
    s.detail.enabled = false;
    s.upsample.method = "bilinear";
    s.smooth.despeckle = false;
    s.smooth.gaussianMM = 0;
    s.crop.shape = "rect";
    s.texts = [{ ...defaultTextLayer(7), height: 1, bevelMM: 0 }];
    const input = (version: number) => ({ depth: fill(8, 8, 0.4), guide: fill(W, H, 0.5), depthVersion: 1, guideVersion: 1, texts: { masks: [{ ...masks(), id: 7 }], version } });
    expect(runPipeline(input(1), s, 2).out.data[40 * W + 60]).toBeCloseTo(1, 5);
    s.texts[0].enabled = false;
    expect(runPipeline(input(2), s, 2).out.data[40 * W + 60]).toBeCloseTo(0.4, 5);
    s.texts[0].enabled = true;
    s.texts[0].id = 8; // masks for another layer: nothing drawn
    expect(runPipeline(input(3), s, 2).out.data[40 * W + 60]).toBeCloseTo(0.4, 5);
  });

  it("text layers in saved settings are filled in from the defaults", () => {
    const s = mergeSettings(defaultSettings(), { texts: [{ id: 3, text: "TOBY", outline: { enabled: true } }] });
    expect(s.texts[0].text).toBe("TOBY");
    expect(s.texts[0].outline).toEqual({ ...defaultTextLayer(3).outline, enabled: true });
    expect(s.texts[0].plate.border.widthMM).toBe(defaultTextLayer(3).plate.border.widthMM);
  });
});

describe("per-layer levels and curve", () => {
  it("the coin's tone shapes the coin only; the subject keeps its own", () => {
    const s = defaultSettings();
    s.tilt.enabled = false;
    s.detail.enabled = false;
    s.upsample.method = "bilinear";
    s.smooth.despeckle = false;
    s.smooth.gaussianMM = 0;
    s.crop.shape = "rect";
    s.coin = { field: 0, top: 1, tone: flatTone() };
    s.subject = { ...s.subject, top: 1, edgeMM: 0 };
    // Coin: a left-to-right ramp (levelled to 0..1 without flattening). Subject: a flat top on the right half.
    const n = 64;
    const coinDepth = makeImg(n, n, Float32Array.from({ length: n * n }, (_, i) => (i % n) / (n - 1)));
    const alpha = makeImg(n, n, Float32Array.from({ length: n * n }, (_, i) => (i % n >= 48 ? 1 : 0)));
    const subject = { depth: fill(4, 4, 1), base: 0, peak: 1, guide: fill(n, n, 0.5), alpha, toDepth: { k: 0.01, ox: 1, oy: 1 }, version: 1 };
    const run = () => runPipeline({ depth: coinDepth, guide: fill(n, n, 0.5), depthVersion: 1, guideVersion: 1, coin: true, subject }, s, 4).out.data;
    const a = run();
    s.coin.tone.gamma = 2; // lifts the coin's middle heights
    const b = run();
    const mid = 32 * n + 44; // on the coin, part way up the ramp (its field level is the middle of the coin)
    expect(b[mid]).toBeGreaterThan(a[mid] + 0.1);
    expect(b[32 * n + 56]).toBeCloseTo(a[32 * n + 56], 5); // on the subject: unchanged
    s.subject.tone.white = 0.5; s.subject.tone.black = 0.4; // the subject's relief is all 1: stays at its top
    expect(run()[32 * n + 56]).toBeCloseTo(1, 5);
  });
  it("strength scales each layer's relief from what it stands on, levels or not; unticking the step turns them all off", () => {
    const s = defaultSettings();
    s.tilt.enabled = false;
    s.detail.enabled = false;
    s.upsample.method = "bilinear";
    s.smooth.despeckle = false;
    s.smooth.gaussianMM = 0;
    s.crop.shape = "rect";
    s.coin = { field: 0, top: 1, tone: flatTone() };
    s.subject = { ...s.subject, top: 1, edgeMM: 0 };
    // Coin: a ramp. Subject: halfway up its relief everywhere, on the right quarter.
    const n = 64;
    const coinDepth = makeImg(n, n, Float32Array.from({ length: n * n }, (_, i) => (i % n) / (n - 1)));
    const alpha = makeImg(n, n, Float32Array.from({ length: n * n }, (_, i) => (i % n >= 48 ? 1 : 0)));
    const subject = { depth: fill(4, 4, 0.5), base: 0, peak: 1, guide: fill(n, n, 0.5), alpha, toDepth: { k: 0.01, ox: 1, oy: 1 }, version: 1 };
    // One cache across runs, as in the app: a changed tone must still re-run its stage.
    const cache = new PipelineCache();
    const run = () => runPipeline({ depth: coinDepth, guide: fill(n, n, 0.5), depthVersion: 1, guideVersion: 1, coin: true, subject }, s, 4, cache).out.data;
    const onCoin = 32 * n + 44;
    const onSubject = 32 * n + 56;
    const a = run();
    expect(a[onCoin]).toBeGreaterThan(0.2);
    // The coin, with its levels and curve untouched: its height above the field (0 here) scales.
    s.coin.tone.strength = 0.5;
    expect(run()[onCoin]).toBeCloseTo(a[onCoin] / 2, 4);
    s.coin.tone.strength = 1.2;
    expect(run()[onCoin]).toBeCloseTo(a[onCoin] * 1.2, 4);
    s.coin.tone.strength = 0;
    expect(Math.max(...run().filter((_, i) => i % n < 40))).toBeCloseTo(0, 5); // flat field
    s.coin.tone.strength = 1;
    // With a curve the shape is kept and scaled the same way.
    s.coin.tone.gamma = 2;
    const coin = run();
    expect(coin[onCoin]).toBeGreaterThan(a[onCoin] + 0.05);
    s.coin.tone.strength = 0.5;
    expect(run()[onCoin]).toBeCloseTo(coin[onCoin] / 2, 4);
    s.coin.tone.strength = 1;
    // The subject: it stands on the (smoothed) coin under it; strength scales how far it rises from there.
    s.subject.tone.strength = 0;
    const lying = run();
    s.subject.tone.strength = 1;
    const standing = run();
    expect(standing[onSubject]).toBeGreaterThan(lying[onSubject] + 0.005);
    s.subject.tone.strength = 0.5;
    expect(run()[onSubject]).toBeCloseTo((lying[onSubject] + standing[onSubject]) / 2, 4);
    s.subject.tone.strength = 1;
    // The final levels' strength scales the depth below the top surface.
    s.levels.gamma = 0.5;
    const master = run();
    s.levels.strength = 0.5;
    expect(run()[onCoin]).toBeCloseTo((1 + master[onCoin]) / 2, 4);
    s.levels.strength = 0;
    expect(Math.min(...run())).toBeCloseTo(1, 5); // no relief at all: everything is the top surface
    s.levels.strength = 1.2;
    expect(Math.min(...run())).toBe(0); // deeper, the deepest clipped to black
    // Unticked: no levels, curves or strengths at all, the layers' own included.
    s.coin.tone.strength = 0.3;
    s.subject.tone.strength = 0.3;
    s.levels.enabled = false;
    const off = run();
    expect(off[onCoin]).toBeCloseTo(a[onCoin], 5);
    expect(off[onSubject]).toBeCloseTo(a[onSubject], 5);
  });
});
