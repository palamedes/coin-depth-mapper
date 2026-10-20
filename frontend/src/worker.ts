// Runs the processing pipeline off the main thread so big images never freeze the UI.
// One instance does live previews (keeps a stage cache); a separate instance does exports.

import { buildSTL, encodePNG, toGray } from "./proc/export";
import { type Img, luminance, makeImg } from "./proc/image";
import { runPipeline, PipelineCache } from "./proc/pipeline";
import type { Settings } from "./proc/settings";
import { levelStats } from "./proc/slices";

export type WorkerRequest =
  | { type: "depth"; w: number; h: number; data: Float32Array }
  | { type: "guide"; w: number; h: number; rgba: Uint8ClampedArray }
  | { type: "process"; id: number; settings: Settings; pxPerMM: number }
  | {
      type: "export";
      id: number;
      settings: Settings;
      pxPerMM: number;
      kind: "png" | "stl";
      widthMM: number;
      heightMM: number;
      text: Record<string, string>;
    };

export type WorkerResponse =
  | {
      type: "result";
      id: number;
      w: number;
      h: number;
      out: Float32Array;
      histBefore: Uint32Array;
      histAfter: Uint32Array;
      distinct8: number;
      distinct16: number;
      min8: number;
      max8: number;
      ms: number;
    }
  | { type: "exported"; id: number; bytes: Uint8Array; w: number; h: number; distinct8: number; ms: number }
  | { type: "error"; id: number; message: string };

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

let depth: Img | null = null;
let guide: Img | null = null;
let depthVersion = 0;
let guideVersion = 0;
const cache = new PipelineCache();

ctx.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "depth") {
    depth = makeImg(msg.w, msg.h, msg.data);
    depthVersion++;
    return;
  }
  if (msg.type === "guide") {
    guide = luminance(msg.rgba, msg.w, msg.h);
    guideVersion++;
    return;
  }
  const t0 = performance.now();
  try {
    if (!depth || !guide) throw new Error("No depth map yet");
    const input = { depth, guide, depthVersion, guideVersion };
    if (msg.type === "process") {
      const r = runPipeline(input, msg.settings, msg.pxPerMM, cache);
      const st = levelStats(r.out, msg.settings.slices.passes);
      const out = r.out.data.slice(); // the cache keeps the original
      ctx.postMessage(
        {
          type: "result",
          id: msg.id,
          w: r.out.w,
          h: r.out.h,
          out,
          histBefore: r.histBefore,
          histAfter: r.histAfter,
          distinct8: st.distinct8,
          distinct16: st.distinct16,
          min8: st.min8,
          max8: st.max8,
          ms: performance.now() - t0,
        },
        [out.buffer],
      );
    } else {
      const r = runPipeline(input, msg.settings, msg.pxPerMM);
      let bytes: Uint8Array;
      if (msg.kind === "png") {
        const bits = msg.settings.output.bits;
        bytes = await encodePNG(toGray(r.out, bits), r.out.w, r.out.h, bits, msg.settings.output.dpi, msg.text);
      } else {
        const rel = msg.settings.relief;
        bytes = new Uint8Array(buildSTL(r.out, msg.widthMM, msg.heightMM, rel.depthMM, rel.baseMM, rel.stlGrid));
      }
      const st = levelStats(r.out, msg.settings.slices.passes);
      ctx.postMessage(
        { type: "exported", id: msg.id, bytes, w: r.out.w, h: r.out.h, distinct8: st.distinct8, ms: performance.now() - t0 },
        [bytes.buffer],
      );
    }
  } catch (err) {
    ctx.postMessage({ type: "error", id: (msg as { id: number }).id, message: String((err as Error).message ?? err) });
  }
};
