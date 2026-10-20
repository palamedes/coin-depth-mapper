import { it } from "vitest";
import { makeImg } from "../src/proc/image";
import { runPipeline, PipelineCache } from "../src/proc/pipeline";
import { defaultSettings } from "../src/proc/settings";
import { bilateral, despeckle, guidedUpsample, jointBilateralUpsample, gaussianBlur } from "../src/proc/filters";
import { encodePNG, toGray } from "../src/proc/export";

it.skipIf(!process.env.BENCH)("bench", async () => {
  for (const N of [1024, 2000]) {
    const d = makeImg(1008, 1008, Float32Array.from({ length: 1008 * 1008 }, (_, i) => Math.abs(Math.sin(i * 0.001))));
    const g = makeImg(N, N, Float32Array.from({ length: N * N }, (_, i) => Math.abs(Math.cos(i * 0.0007))));
    const t = (name: string, f: () => unknown) => { const t0 = performance.now(); f(); console.log(N, name, (performance.now() - t0).toFixed(0), "ms"); };
    t("guided", () => guidedUpsample(d, g, 2, 1e-3));
    t("jbu", () => jointBilateralUpsample(d, g, 2, 0.06));
    t("gauss s=8", () => gaussianBlur(g, 8));
    t("bilateral s=4", () => bilateral(g, 4, 0.05));
    t("despeckle r1", () => despeckle(g, 1, 0.04));
    const s = defaultSettings();
    const inp = { depth: d, guide: g, depthVersion: 1, guideVersion: 1 };
    const cache = new PipelineCache();
    t("full default", () => runPipeline(inp, s, N / 40, cache));
    s.levels.gamma = 1.2;
    t("levels change (cached)", () => runPipeline(inp, s, N / 40, cache));
    const out = runPipeline(inp, s, N / 40, cache).out;
    const t0 = performance.now(); await encodePNG(toGray(out, 16), N, N, 16, 1000); console.log(N, "png16", (performance.now() - t0).toFixed(0), "ms");
  }
});
