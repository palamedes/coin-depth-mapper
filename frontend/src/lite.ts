// Lite mode: Depth Anything V2 Small running in the browser with Transformers.js
// (WebGPU when available, otherwise WebAssembly). No Python needed.
// This module and the ONNX runtime are only downloaded when lite mode is used.

import type { Depth, ModelInfo } from "./api";

export const LITE_ID = "browser-da2-small";
const REPO = "onnx-community/depth-anything-v2-small";

export function liteModel(primary: boolean): ModelInfo {
  return {
    id: LITE_ID,
    name: "DA-V2 Small (in browser)",
    family: "Depth Anything 2",
    description:
      "Runs inside this browser on the GPU (WebGPU) or CPU, no Python setup needed. Smaller and softer than the " +
      "backend models; good for a quick look or for computers without the full install." +
      (primary ? "" : " The backend models above give better results."),
    license: "Apache-2.0",
    license_url: `https://huggingface.co/${REPO}`,
    commercial_use: true,
    license_note: "Apache-2.0 weights: fine for engraving pieces you sell.",
    default_resolution: 518,
    min_resolution: 280,
    max_resolution: 1022,
    resolution_step: 14,
    resolution_help: "Longest side the model works at. 518 is what it was trained on; higher is sharper but slower.",
    params: [],
    available: true,
    unavailable_reason: "",
    loaded: false,
    cached: true,
    download_bytes: 0,
    browser: true,
  };
}

type Progress = (msg: string, fraction?: number) => void;
let pipePromise: Promise<any> | null = null;
let device: "webgpu" | "wasm" = "wasm";

/** WebGPU if the browser has a usable adapter; fp16 only where the GPU supports half-precision shaders. */
async function pickBackend(): Promise<{ device: "webgpu" | "wasm"; dtype: "fp16" | "fp32" }> {
  const gpu = (navigator as any).gpu;
  const adapter = gpu ? await gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => null) : null;
  const info = adapter?.info ?? {};
  // A software "fallback" adapter (SwiftShader) is far slower than ONNX's own CPU path.
  const software = !adapter || info.isFallbackAdapter || adapter.isFallbackAdapter || /swiftshader/i.test(info.architecture ?? "");
  if (software) return { device: "wasm", dtype: "fp32" };
  return { device: "webgpu", dtype: adapter.features?.has("shader-f16") ? "fp16" : "fp32" };
}

async function getPipeline(progress: Progress) {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      let loading = true; // late download callbacks must not overwrite a finished/failed status
      const onProgress = (p: any) => {
        if (loading && p.status === "progress_total" && p.total) {
          progress(`Downloading the in-browser model: ${Math.round(p.loaded / 1e6)} of ${Math.round(p.total / 1e6)} MB`, p.loaded / p.total);
        }
      };
      const choice = await pickBackend();
      try {
        try {
          device = choice.device;
          return await pipeline("depth-estimation", REPO, { device: choice.device, dtype: choice.dtype, progress_callback: onProgress });
        } catch (err) {
          if (choice.device !== "webgpu") throw err;
          // Some GPUs/drivers fail to create the WebGPU session; the CPU path always works.
          device = "wasm";
          return await pipeline("depth-estimation", REPO, { device: "wasm", dtype: "fp32", progress_callback: onProgress });
        }
      } finally {
        loading = false;
      }
    })();
    pipePromise.catch(() => (pipePromise = null));
  }
  return pipePromise;
}

export async function predictInBrowser(png: Blob, resolution: number, progress: Progress): Promise<Depth> {
  progress("Loading the in-browser model…");
  const pipe = await getPipeline(progress);
  const { RawImage } = await import("@huggingface/transformers");
  const bitmap = await createImageBitmap(png);
  const scale = resolution / Math.max(bitmap.width, bitmap.height);
  const w = Math.max(14, Math.round((bitmap.width * scale) / 14) * 14);
  const h = Math.max(14, Math.round((bitmap.height * scale) / 14) * 14);
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const img = new RawImage(g.getImageData(0, 0, w, h).data, w, h, 4).rgb();
  pipe.processor.image_processor.size = { width: w, height: h };
  progress(`Estimating depth in the browser (${device === "webgpu" ? "WebGPU" : "CPU"})…`);
  const out = await pipe(img);
  const pd = out.predicted_depth;
  const [ph, pw] = pd.dims.slice(-2);
  const raw = pd.data as Float32Array;
  // Depth Anything V2 predicts disparity: larger = nearer, which is already "near = bright".
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of raw) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const data = new Float32Array(raw.length);
  const span = hi - lo || 1;
  for (let i = 0; i < raw.length; i++) data[i] = (raw[i] - lo) / span;
  return { w: pw, h: ph, data };
}
