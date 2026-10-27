// Draws the 3D preview in software when the browser has no WebGL, off the main thread.

import { type FrameSpec, type SoftRelief, prepareRelief, renderFrame } from "./ui/softRender";

export type SoftRequest =
  | { type: "relief"; data: Float32Array; w: number; h: number; widthMM: number; heightMM: number; zScale: number }
  | { type: "frame"; spec: FrameSpec };

/** pixels is null until a relief has arrived. */
export type SoftResponse = { type: "frame"; width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer> | null; ms: number };

const ctx = self as unknown as {
  postMessage(msg: SoftResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<SoftRequest>) => void) | null;
};

let relief: SoftRelief | null = null;

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "relief") {
    relief = prepareRelief(msg.data, msg.w, msg.h, msg.widthMM, msg.heightMM, msg.zScale);
    return;
  }
  const { width, height } = msg.spec;
  const t0 = performance.now();
  const pixels = relief ? renderFrame(relief, msg.spec) : null;
  ctx.postMessage({ type: "frame", width, height, pixels, ms: performance.now() - t0 }, pixels ? [pixels.buffer] : []);
};
