import { it } from "vitest";
import { makeImg } from "../src/proc/image";
import { runPipeline, PipelineCache } from "../src/proc/pipeline";
import { defaultSettings } from "../src/proc/settings";
import { bilateral, despeckle, guidedUpsample, jointBilateralUpsample, gaussianBlur } from "../src/proc/filters";
import { encodePNG, toGray } from "../src/proc/export";
import * as THREE from "three";
import { prepareRelief, renderFrame } from "../src/ui/softRender";

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

it.skipIf(!process.env.BENCH)("bench software 3D", () => {
  const N = 1024;
  const data = Float32Array.from({ length: N * N }, (_, i) => {
    const x = (i % N) / N - 0.5, y = Math.floor(i / N) / N - 0.5;
    return Math.max(0, 1 - (x * x + y * y) * 4) * (0.8 + 0.2 * Math.sin(x * 90) * Math.cos(y * 70));
  });
  let t0 = performance.now();
  const r = prepareRelief(data, N, N, 40, 40, 6);
  console.log("prepare relief", (performance.now() - t0).toFixed(0), "ms");
  const [W, H] = [1060, 760];
  const cam = new THREE.PerspectiveCamera(35, W / H, 0.1, 5000);
  cam.up.set(0, 0, 1);
  cam.position.set(0, -44, 60);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const M = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
  for (const [grid, scale] of [[160, 0.5], [384, 1], [768, 1]]) {
    const spec = { width: Math.round(W * scale), height: Math.round(H * scale), viewProj: M, camera: [0, -44, 60] as [number, number, number],
      light: [-0.58, 0.58, 0.57] as [number, number, number], color: [0.7, 0.72, 0.76] as [number, number, number], roughness: 0.22, grid };
    renderFrame(r, spec); // builds and caches the mesh
    t0 = performance.now();
    for (let i = 0; i < 3; i++) renderFrame(r, spec);
    console.log(`frame grid ${grid} at ${spec.width}x${spec.height}`, ((performance.now() - t0) / 3).toFixed(0), "ms");
  }
});
