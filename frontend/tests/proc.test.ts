import { describe, expect, it } from "vitest";
import { buildSTL, crc32, dpiToPixelsPerMeter, encodePNG, exportSize, toGray } from "../src/proc/export";
import { boxBlur, bilateral, despeckle, gaussianBlur, guidedUpsample, jointBilateralUpsample } from "../src/proc/filters";
import { type Img, fill, luminance, makeImg, minMax, resize, sample } from "../src/proc/image";
import { applyLUT, autoLevels, histogram, levels, makeCurve, toneLUT } from "../src/proc/levels";
import { edgeDistance, maskFromDistance, rimFromDistance } from "../src/proc/mask";
import { removeTilt, runPipeline, PipelineCache } from "../src/proc/pipeline";
import { defaultSettings, mergeSettings, presetPart, type Settings } from "../src/proc/settings";
import { firesOnPass, levelStats, passesFor, quantize, sliceMask } from "../src/proc/slices";

const ramp = (w: number, h: number): Img => {
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = x / (w - 1);
  return makeImg(w, h, d);
};
const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a: Float32Array) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
};

// ---------------------------------------------------------------------------------- levels
describe("levels", () => {
  it("maps black and white points to 0 and 1 and clamps outside", () => {
    expect(levels(0.2, 0.2, 0.8, 1)).toBe(0);
    expect(levels(0.8, 0.2, 0.8, 1)).toBe(1);
    expect(levels(0.5, 0.2, 0.8, 1)).toBeCloseTo(0.5);
    expect(levels(0.1, 0.2, 0.8, 1)).toBe(0);
    expect(levels(0.95, 0.2, 0.8, 1)).toBe(1);
  });
  it("gamma above 1 lifts midtones, below 1 darkens them, ends stay fixed", () => {
    expect(levels(0.5, 0, 1, 2)).toBeCloseTo(Math.SQRT1_2);
    expect(levels(0.5, 0, 1, 0.5)).toBeCloseTo(0.25);
    for (const g of [0.3, 1, 3]) {
      expect(levels(0, 0, 1, g)).toBe(0);
      expect(levels(1, 0, 1, g)).toBe(1);
    }
  });
  it("degenerate black == white acts as a threshold", () => {
    expect(levels(0.49, 0.5, 0.5, 1)).toBe(0);
    expect(levels(0.5, 0.5, 0.5, 1)).toBe(1);
  });
  it("tone LUT is monotone and hits the ends", () => {
    const lut = toneLUT(0.1, 0.9, 1.4, [[0.3, 0.2], [0.7, 0.85]]);
    for (let i = 1; i < lut.length; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    expect(lut[0]).toBe(0);
    expect(lut[lut.length - 1]).toBe(1);
  });
  it("applyLUT keeps 16-bit smoothness (no 8-bit steps)", () => {
    const img = ramp(4096, 1);
    const out = applyLUT(img, toneLUT(0, 1, 1.3, []));
    const q = new Set(Array.from(out.data, (v) => quantize(v, 16)));
    expect(q.size).toBeGreaterThan(3500);
  });
  it("autoLevels finds the 0.1% / 99.9% points and ignores masked-out pixels", () => {
    const img = ramp(1000, 1);
    for (let i = 0; i < 1000; i++) img.data[i] = 0.3 + 0.4 * img.data[i];
    const weight = new Float32Array(1000).fill(1);
    img.data[0] = 0; // outside the mask, must be ignored
    weight[0] = 0;
    const { black, white } = autoLevels(img, weight);
    expect(black).toBeCloseTo(0.3, 2);
    expect(white).toBeCloseTo(0.7, 2);
  });
  it("histogram counts and skips weight < 0.5", () => {
    const img = makeImg(4, 1, new Float32Array([0, 0.5, 1, 1]));
    const h = histogram(img, 2, new Float32Array([1, 1, 1, 0]));
    expect(Array.from(h)).toEqual([1, 2]);
  });
});

describe("curve", () => {
  it("passes through its points and is identity with none", () => {
    const c = makeCurve([[0.25, 0.1], [0.75, 0.9]]);
    expect(c(0.25)).toBeCloseTo(0.1);
    expect(c(0.75)).toBeCloseTo(0.9);
    expect(c(0)).toBe(0);
    expect(c(1)).toBe(1);
    const id = makeCurve([]);
    for (const x of [0, 0.3, 0.77, 1]) expect(id(x)).toBeCloseTo(x);
  });
  it("never overshoots between monotone points (no spikes)", () => {
    const c = makeCurve([[0.1, 0.8], [0.2, 0.82], [0.9, 0.85]]);
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.001) {
      const y = c(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(y).toBeLessThanOrEqual(1);
      prev = y;
    }
  });
});

// ---------------------------------------------------------------------------------- masks
describe("masking", () => {
  it("circle edge distance is r at the centre and ~0 on the edge", () => {
    const d = edgeDistance(101, 101, "circle");
    expect(d.data[50 * 101 + 50]).toBeCloseTo(50.5 - Math.SQRT1_2 * 0, 0);
    expect(Math.abs(d.data[50 * 101 + 0])).toBeLessThan(0.6);
    expect(d.data[0]).toBeLessThan(0); // corner is outside
  });
  it("hard mask is 1 inside, 0 outside, anti-aliased on the edge", () => {
    const m = maskFromDistance(edgeDistance(64, 64, "circle"), 0);
    expect(m.data[32 * 64 + 32]).toBe(1);
    expect(m.data[0]).toBe(0);
    const edge = Array.from(m.data).filter((v) => v > 0 && v < 1).length;
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(64 * 4 * 1.2);
  });
  it("soft mask fades over the given width, inward from the edge", () => {
    const m = maskFromDistance(edgeDistance(200, 200, "circle"), 10);
    const row = 100 * 200;
    expect(m.data[row + 0]).toBeLessThan(0.02); // pixel centre 0.5 px inside the edge
    expect(m.data[row + 5]).toBeGreaterThan(0.3);
    expect(m.data[row + 5]).toBeLessThan(0.8);
    expect(m.data[row + 12]).toBe(1);
  });
  it("rim weight covers the band next to the edge only", () => {
    const r = rimFromDistance(edgeDistance(200, 200, "circle"), 8, 2);
    const row = 100 * 200;
    expect(r.data[row + 3]).toBe(1);
    expect(r.data[row + 20]).toBe(0);
    expect(r.data[row + 100]).toBe(0);
  });
  it("pipeline sets outside the circle to the outside value", () => {
    const s = baseSettings();
    s.mask.outside = 0.37;
    const res = runPipeline(input(fill(32, 32, 0.8), fill(64, 64, 0.5)), s, 10);
    expect(res.out.data[0]).toBeCloseTo(0.37);
    expect(res.out.data[32 * 64 + 32]).toBeCloseTo(0.8);
  });
  it("rectangle crops are not masked", () => {
    const s = baseSettings();
    s.crop.shape = "rect";
    const res = runPipeline(input(fill(32, 32, 0.8), fill(64, 64, 0.5)), s, 10);
    expect(res.out.data[0]).toBeCloseTo(0.8);
    expect(res.mask).toBeNull();
  });
});

// ---------------------------------------------------------------------------------- invert
describe("invert", () => {
  it("tilt removal passes a flat map through unchanged", () => {
    const flat = fill(16, 16, 0.42);
    expect(removeTilt(flat, "circle")).toBe(flat);
  });
  it("flips every value around 0.5", () => {
    const s = baseSettings();
    s.crop.shape = "rect";
    const d = ramp(32, 4);
    const a = runPipeline(input(d, resize(d, 32, 4)), s, 1).out;
    s.invert = true;
    const b = runPipeline(input(d, resize(d, 32, 4)), s, 1).out;
    for (let i = 0; i < a.data.length; i++) expect(a.data[i] + b.data[i]).toBeCloseTo(1, 5);
  });
  it("inverting makes the masked background white (not engraved)", () => {
    const s = baseSettings();
    s.invert = true;
    const res = runPipeline(input(fill(16, 16, 0.6), fill(32, 32, 0.5)), s, 1);
    expect(res.out.data[0]).toBe(1);
  });
});

// ---------------------------------------------------------------------------------- slices
describe("LightBurn 3D Sliced model", () => {
  it("white gets no passes, black gets all of them", () => {
    for (const n of [1, 10, 255, 256, 1000]) {
      expect(passesFor(255, 255, n)).toBe(0);
      expect(passesFor(0, 255, n)).toBe(n);
      expect(passesFor(65535, 65535, n)).toBe(0);
      expect(passesFor(0, 65535, n)).toBe(n);
    }
  });
  it("255 passes on 8-bit is exactly one pass per gray level", () => {
    for (let v = 0; v <= 255; v++) expect(passesFor(v, 255, 255)).toBe(255 - v);
  });
  it("256 passes: every non-white level gets at least one pass, counts never increase with brightness", () => {
    let prev = Infinity;
    for (let v = 0; v <= 255; v++) {
      const p = passesFor(v, 255, 256);
      expect(p).toBeLessThanOrEqual(prev);
      if (v < 255) expect(p).toBeGreaterThanOrEqual(1);
      prev = p;
    }
    expect(passesFor(254, 255, 256)).toBe(1);
  });
  it("fewer passes group gray levels into evenly spaced bands", () => {
    // 4 passes: thresholds at 1/4 steps of the range.
    expect(passesFor(0, 255, 4)).toBe(4);
    expect(passesFor(63, 255, 4)).toBe(3);
    expect(passesFor(64, 255, 4)).toBe(2);
    expect(passesFor(128, 255, 4)).toBe(1);
    expect(passesFor(191, 255, 4)).toBe(1);
    expect(passesFor(192, 255, 4)).toBe(0);
  });
  it("engraved area grows pass by pass; a pixel fires on exactly passesFor() passes", () => {
    const n = 16;
    for (const v of [0, 17, 100, 200, 254, 255]) {
      let count = 0;
      let wasFiring = false;
      for (let k = 1; k <= n; k++) {
        const f = firesOnPass(v, 255, n, k);
        if (wasFiring) expect(f).toBe(true); // once it starts it keeps firing
        wasFiring ||= f;
        if (f) count++;
      }
      expect(count).toBe(passesFor(v, 255, n));
    }
  });
  it("slice mask and level stats on an image", () => {
    const img = makeImg(4, 1, new Float32Array([0, 0.5, 0.999, 1]));
    expect(Array.from(sliceMask(img, 8, 256, 1))).toEqual([1, 0, 0, 0]); // pass 1: deepest only
    expect(Array.from(sliceMask(img, 8, 256, 256))).toEqual([1, 1, 0, 0]); // last pass: everything but white
    const st = levelStats(img, 256);
    expect(st.min8).toBe(0);
    expect(st.max8).toBe(255);
    expect(st.distinct8).toBe(3); // 0.999 rounds to 255
    expect(st.distinct16).toBe(4);
    expect(st.maxPasses).toBe(256);
  });
});

// ---------------------------------------------------------------------------------- export / DPI
describe("DPI and export size", () => {
  it("computes pixels from millimetres and DPI", () => {
    const s = exportSize(40, 1000, 1);
    expect(s.w).toBe(1575);
    expect(s.h).toBe(1575);
    expect(s.widthMM).toBeCloseTo(40, 1);
    expect(exportSize(25.4, 600, 1).w).toBe(600);
    expect(exportSize(50, 600, 0.5)).toMatchObject({ w: 1181, h: 591 });
  });
  it("converts DPI to pHYs pixels per metre", () => {
    expect(dpiToPixelsPerMeter(1000)).toBe(39370);
    expect(dpiToPixelsPerMeter(254)).toBe(10000);
    expect(39370 * 0.0254).toBeCloseTo(1000, 0);
  });
  it("never dithers: quantization is plain rounding", () => {
    const img = fill(100, 1, 0.5004);
    const g = toGray(img, 8);
    expect(new Set(g).size).toBe(1);
    expect(g[0]).toBe(128);
    expect(toGray(fill(1, 1, 1), 16)[0]).toBe(65535);
  });
  it("writes a valid 16-bit grayscale PNG with pHYs that decodes to the same values", async () => {
    const w = 37;
    const h = 23;
    const vals = new Uint16Array(w * h);
    for (let i = 0; i < vals.length; i++) vals[i] = (i * 2731 + ((i * i) % 977)) & 0xffff;
    const png = await encodePNG(vals, w, h, 16, 1000, { Software: "test" });
    const dec = await decodePNG(png);
    expect(dec).toMatchObject({ w, h, bits: 16, colorType: 0, ppm: 39370, unit: 1 });
    expect(Array.from(dec.values)).toEqual(Array.from(vals));
    expect(dec.text.Software).toBe("test");
  });
  it("writes an 8-bit PNG too", async () => {
    const vals = new Uint8Array([0, 10, 255, 128, 3, 200]);
    const dec = await decodePNG(await encodePNG(vals, 3, 2, 8, 600));
    expect(dec.bits).toBe(8);
    expect(Array.from(dec.values)).toEqual(Array.from(vals));
    expect(dec.ppm).toBe(dpiToPixelsPerMeter(600));
  });
  it("builds a watertight STL of the right size", () => {
    const img = ramp(9, 6);
    const buf = buildSTL(img, 30, 20, 2, 1, 100);
    const dv = new DataView(buf);
    const n = dv.getUint32(80, true);
    expect(buf.byteLength).toBe(84 + 50 * n);
    const edges = new Map<string, number>();
    let maxX = 0, maxY = 0, maxZ = 0, minZ = Infinity;
    const key = (o: number) => [0, 4, 8].map((k) => dv.getFloat32(o + k, true).toFixed(4)).join(",");
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12;
      const vs = [key(o), key(o + 12), key(o + 24)];
      for (let k = 0; k < 3; k++) {
        const e = [vs[k], vs[(k + 1) % 3]].sort().join("|");
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
      for (const off of [o, o + 12, o + 24]) {
        maxX = Math.max(maxX, dv.getFloat32(off, true));
        maxY = Math.max(maxY, dv.getFloat32(off + 4, true));
        const z = dv.getFloat32(off + 8, true);
        maxZ = Math.max(maxZ, z);
        minZ = Math.min(minZ, z);
      }
    }
    for (const c of edges.values()) expect(c).toBe(2); // every edge shared by exactly two triangles
    expect(maxX).toBeCloseTo(30);
    expect(maxY).toBeCloseTo(20);
    expect(minZ).toBe(0);
    expect(maxZ).toBeCloseTo(3); // base 1 + relief 2 at white
  });
});

// ---------------------------------------------------------------------------------- image ops
describe("resampling and filters", () => {
  it("resize keeps constants and means, and is linear on ramps when enlarging", () => {
    const c = resize(fill(10, 7, 0.4), 33, 21);
    for (const v of c.data) expect(v).toBeCloseTo(0.4, 6);
    const r = ramp(64, 8);
    const small = resize(r, 16, 2);
    expect(mean(small.data)).toBeCloseTo(mean(r.data), 2);
    const big = resize(ramp(8, 1), 64, 1);
    const diffs = Array.from(big.data).slice(5, 58).map((v, i, a) => (i ? v - a[i - 1] : 0)).slice(1);
    for (const d of diffs) expect(d).toBeCloseTo(diffs[0], 5);
  });
  it("bilinear sample hits pixel centres exactly", () => {
    const img = makeImg(2, 2, new Float32Array([0, 1, 2, 3]));
    expect(sample(img, 0.5, 0.5)).toBe(0);
    expect(sample(img, 1.5, 1.5)).toBe(3);
    expect(sample(img, 1, 1)).toBeCloseTo(1.5);
  });
  it("luminance uses Rec.709 weights", () => {
    const l = luminance(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), 2, 1);
    expect(l.data[0]).toBeCloseTo(0.2126);
    expect(l.data[1]).toBeCloseTo(0.7152);
  });
  it("box and gaussian blur preserve the mean and reduce noise", () => {
    const n = makeImg(64, 64, Float32Array.from({ length: 4096 }, (_, i) => ((i * 7919) % 101) / 100));
    for (const b of [boxBlur(n, 3), gaussianBlur(n, 1.5), gaussianBlur(n, 6)]) {
      expect(mean(b.data)).toBeCloseTo(mean(n.data), 2);
      expect(std(b.data)).toBeLessThan(std(n.data) * 0.5);
    }
  });
  it("despeckle removes an isolated pit and leaves a clean edge alone", () => {
    const img = fill(20, 20, 0.8);
    for (let y = 0; y < 20; y++) for (let x = 10; x < 20; x++) img.data[y * 20 + x] = 0.2;
    img.data[5 * 20 + 5] = 0.0; // pit
    const out = despeckle(img, 1, 0.05);
    expect(out.data[5 * 20 + 5]).toBeCloseTo(0.8);
    expect(out.data[5 * 20 + 9]).toBeCloseTo(0.8);
    expect(out.data[5 * 20 + 10]).toBeCloseTo(0.2);
  });
  it("bilateral smooths noise but keeps a step edge", () => {
    const img = makeImg(40, 10, new Float32Array(400));
    for (let i = 0; i < 400; i++) img.data[i] = (i % 40 < 20 ? 0.2 : 0.8) + (((i * 37) % 11) - 5) * 0.004;
    const out = bilateral(img, 3, 0.05);
    expect(out.data[5 * 40 + 19]).toBeLessThan(0.3);
    expect(out.data[5 * 40 + 20]).toBeGreaterThan(0.7);
    expect(std(out.data.slice(0, 15))).toBeLessThan(std(img.data.slice(0, 15)));
  });
  it("guided upsampling puts the depth edge where the photo edge is", () => {
    // Low-res depth has a blurry step; the high-res guide has a sharp step at x = 41.
    const lo = makeImg(16, 4, new Float32Array(64));
    for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) lo.data[y * 16 + x] = Math.min(1, Math.max(0, (x - 8) / 4 + 0.5));
    const guide = makeImg(64, 16, new Float32Array(1024));
    for (let y = 0; y < 16; y++) for (let x = 0; x < 64; x++) guide.data[y * 64 + x] = x >= 41 ? 0.9 : 0.1;
    const plain = resize(lo, 64, 16);
    for (const up of [guidedUpsample(lo, guide, 2, 1e-4), jointBilateralUpsample(lo, guide, 2, 0.1)]) {
      const jumpGuided = up.data[8 * 64 + 41] - up.data[8 * 64 + 40];
      const jumpPlain = plain.data[8 * 64 + 41] - plain.data[8 * 64 + 40];
      expect(jumpGuided).toBeGreaterThan(jumpPlain * 3);
    }
  });
});

describe("pipeline", () => {
  it("detail boost is soft-clipped so it can't create spikes", () => {
    const s = baseSettings();
    s.crop.shape = "rect";
    s.smooth.despeckle = false;
    s.smooth.gaussianMM = 0;
    s.detail = { enabled: true, radiusMM: 0.5, strength: 1, limit: 0.05 };
    const guide = fill(64, 64, 0);
    guide.data[32 * 64 + 32] = 1; // extreme single bright pixel
    s.levels.enabled = false;
    const out = runPipeline(input(fill(16, 16, 0.5), guide), s, 4).out;
    const [lo, hi] = minMax(out);
    expect(hi - 0.5).toBeLessThanOrEqual(0.05 + 1e-6);
    expect(0.5 - lo).toBeLessThanOrEqual(0.05 + 1e-6);
  });
  it("background flatten sets everything below the threshold to the level", () => {
    const s = baseSettings();
    s.crop.shape = "rect";
    s.flatten = { enabled: true, threshold: 0.5, level: 0.1, falloffMM: 0 };
    const d = ramp(64, 4);
    const out = runPipeline(input(d, resize(d, 64, 4)), s, 1).out;
    expect(out.data[2 * 64 + 5]).toBeCloseTo(0.1, 2);
    expect(out.data[2 * 64 + 60]).toBeCloseTo(60 / 63, 2);
  });
  it("rim raises a ring along the circle edge", () => {
    const s = baseSettings();
    s.rim = { enabled: true, widthMM: 1, height: 1, bevelMM: 0 };
    const out = runPipeline(input(fill(32, 32, 0.4), fill(100, 100, 0.5)), s, 10).out;
    expect(out.data[50 * 100 + 4]).toBeCloseTo(1, 1); // 4 px in from the edge, inside the 10 px rim
    expect(out.data[50 * 100 + 50]).toBeCloseTo(0.4, 2);
    expect(out.data[0]).toBe(0);
  });
  it("output is finite, in 0..1, and the cache gives identical results", () => {
    const s = defaultSettings();
    const d = makeImg(40, 40, Float32Array.from({ length: 1600 }, (_, i) => Math.abs(Math.sin(i * 0.37))));
    const g = makeImg(80, 80, Float32Array.from({ length: 6400 }, (_, i) => Math.abs(Math.cos(i * 0.11))));
    const cache = new PipelineCache();
    const inp = input(d, g);
    const a = runPipeline(inp, s, 8, cache).out;
    const b = runPipeline(inp, s, 8, cache).out;
    expect(b).toBe(a);
    for (const v of a.data) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    s.levels.gamma = 1.5; // late change re-runs only the late stages
    const c = runPipeline(inp, s, 8, cache).out;
    expect(c).not.toBe(a);
  });
});

describe("tilt removal", () => {
  it("levels a tilted field and keeps the raised subject on top", () => {
    const n = 101;
    const d = new Float32Array(n * n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const tilt = 0.3 + 0.4 * (y / n); // field leans back
        const bump = Math.hypot(x - 50, y - 50) < 15 ? 0.25 : 0; // raised subject
        d[y * n + x] = tilt + bump;
      }
    const out = removeTilt(makeImg(n, n, d), "circle");
    const at = (x: number, y: number) => out.data[y * n + x];
    // Field at top and bottom of the coin are now the same height.
    expect(Math.abs(at(50, 15) - at(50, 85))).toBeLessThan(0.02);
    expect(Math.abs(at(15, 50) - at(85, 50))).toBeLessThan(0.02);
    // Subject is still clearly above the field, and the range is renormalised.
    expect(at(50, 50) - at(50, 85)).toBeGreaterThan(0.5);
    const [lo, hi] = minMax(out);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });
  it("leaves an untilted map's shape alone", () => {
    const d = ramp(64, 64);
    for (let i = 0; i < d.data.length; i++) d.data[i] = 0.5;
    d.data[32 * 64 + 32] = 0.9;
    const out = removeTilt(d, "rect");
    expect(out.data[0]).toBeCloseTo(out.data[63], 5);
    expect(out.data[32 * 64 + 32]).toBeGreaterThan(out.data[0]);
  });
});

describe("settings", () => {
  it("merge fills gaps from defaults and keeps model params", () => {
    const m = mergeSettings(defaultSettings(), { levels: { gamma: 2 }, model: { params: { steps: 7 } }, bogus: 1 });
    expect(m.levels.gamma).toBe(2);
    expect(m.levels.black).toBe(0);
    expect(m.model.params.steps).toBe(7);
    expect((m as any).bogus).toBeUndefined();
  });
  it("presets leave out the image-specific crop geometry", () => {
    const p = presetPart(defaultSettings());
    expect(p.crop).toEqual({ shape: "circle", hideOutsideFromModel: false });
  });
});

// ---------------------------------------------------------------------------------- helpers
function baseSettings(): Settings {
  const s = defaultSettings();
  s.tilt.enabled = false;
  s.detail.enabled = false;
  s.upsample.method = "bilinear";
  s.smooth.despeckle = false;
  s.smooth.gaussianMM = 0;
  return s;
}

let version = 0;
function input(depth: Img, guide: Img) {
  version++;
  return { depth, guide, depthVersion: version, guideVersion: version };
}

/** Minimal independent PNG decoder for the tests (grayscale, 8/16-bit, all five filters). */
async function decodePNG(png: Uint8Array) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let o = 8;
  let w = 0, h = 0, bits = 0, colorType = -1, ppm = 0, unit = -1;
  const idat: Uint8Array[] = [];
  const text: Record<string, string> = {};
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...png.slice(o + 4, o + 8));
    const data = png.slice(o + 8, o + 8 + len);
    const crc = dv.getUint32(o + 8 + len);
    expect((crc32(png.slice(o + 4, o + 8 + len)) ^ 0xffffffff) >>> 0).toBe(crc);
    const cd = new DataView(data.buffer);
    if (type === "IHDR") {
      w = cd.getUint32(0);
      h = cd.getUint32(4);
      bits = data[8];
      colorType = data[9];
    } else if (type === "pHYs") {
      ppm = cd.getUint32(0);
      expect(cd.getUint32(4)).toBe(ppm);
      unit = data[8];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "tEXt") {
      const z = data.indexOf(0);
      text[String.fromCharCode(...data.slice(0, z))] = String.fromCharCode(...data.slice(z + 1));
    }
    o += 12 + len;
  }
  const all = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of idat) {
    all.set(c, p);
    p += c.length;
  }
  const raw = new Uint8Array(await new Response(new Blob([all]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const bpp = bits / 8;
  const rb = w * bpp;
  const pix = new Uint8Array(h * rb);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (rb + 1)];
    for (let i = 0; i < rb; i++) {
      const x = raw[y * (rb + 1) + 1 + i];
      const a = i >= bpp ? pix[y * rb + i - bpp] : 0;
      const b = y ? pix[(y - 1) * rb + i] : 0;
      const c = y && i >= bpp ? pix[(y - 1) * rb + i - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const pred = [0, a, b, (a + b) >> 1, pr][f];
      pix[y * rb + i] = (x + pred) & 0xff;
    }
  }
  const values = bits === 16 ? new Uint16Array(w * h).map((_, i) => (pix[2 * i] << 8) | pix[2 * i + 1]) : pix;
  return { w, h, bits, colorType, ppm, unit, values, text };
}
