// Runs the processing pipeline off the main thread so big images never freeze the UI.
// One instance does live previews (keeps a stage cache); a separate instance does exports.

import { buildSTL, encodePNG, toGray } from "./proc/export";
import { type Img, luminance, makeImg } from "./proc/image";
import { type SubjectInput, runPipeline, PipelineCache } from "./proc/pipeline";
import type { Settings } from "./proc/settings";
import type { PixelMap } from "./proc/subject";
import type { TextMasks } from "./proc/text";
import { levelStats } from "./proc/slices";

export type WorkerRequest =
  | { type: "depth"; w: number; h: number; data: Float32Array; coin?: boolean } // coin: the background is a blank coin
  | { type: "guide"; w: number; h: number; rgba: Uint8ClampedArray }
  /** A cut-out subject's own depth (null removes the subject). */
  | { type: "subjectDepth"; depth: { w: number; h: number; data: Float32Array; base: number; peak: number } | null }
  /** The subject drawn where it sits on the output (transparent around it), and where its depth lands. */
  | { type: "subjectLayer"; w: number; h: number; rgba: Uint8ClampedArray; toDepth: PixelMap }
  /** Text layers' masks (coverage 0..255) at the output size: these layers are new or redrawn; layers not in `keep` are dropped. */
  | { type: "texts"; w: number; h: number; layers: { id: number; glyph: Uint8Array; plate: Uint8Array | null }[]; keep: number[] }
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
      histCoin: Uint32Array | null;
      histSubject: Uint32Array | null;
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
let coin = false;
let guide: Img | null = null;
let depthVersion = 0;
let guideVersion = 0;
let subjectDepth: { depth: Img; base: number; peak: number } | null = null;
let subjectLayer: { guide: Img; alpha: Img; toDepth: PixelMap } | null = null;
let subjectVersion = 0;
let texts: { w: number; h: number; masks: Map<number, TextMasks> } | null = null;
let textVersion = 0;

function coverage(a: Uint8Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] / 255;
  return out;
}
const cache = new PipelineCache();

/** Luminance over mid-gray (what the model saw behind the subject) and coverage, from RGBA. */
function splitLayer(rgba: Uint8ClampedArray, w: number, h: number): { guide: Img; alpha: Img } {
  const guide = luminance(rgba, w, h).data;
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < alpha.length; i++) {
    const a = rgba[i * 4 + 3] / 255;
    guide[i] = guide[i] * a + 0.5 * (1 - a); // the canvas gives un-premultiplied colour
    // Lossy WebP leaves the inside a little below opaque; stretch so it reads as fully covered.
    alpha[i] = Math.min(1, Math.max(0, (a - 0.04) / 0.92));
  }
  return { guide: makeImg(w, h, guide), alpha: makeImg(w, h, alpha) };
}

function subjectInput(): SubjectInput | null {
  if (!subjectDepth || !subjectLayer || !guide || subjectLayer.guide.w !== guide.w || subjectLayer.guide.h !== guide.h) return null;
  return { ...subjectDepth, ...subjectLayer, version: subjectVersion };
}

ctx.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "depth") {
    depth = makeImg(msg.w, msg.h, msg.data);
    coin = !!msg.coin;
    depthVersion++;
    return;
  }
  if (msg.type === "guide") {
    guide = luminance(msg.rgba, msg.w, msg.h);
    guideVersion++;
    return;
  }
  if (msg.type === "subjectDepth") {
    const d = msg.depth;
    subjectDepth = d && { depth: makeImg(d.w, d.h, d.data), base: d.base, peak: d.peak };
    subjectVersion++;
    return;
  }
  if (msg.type === "texts") {
    if (!texts || texts.w !== msg.w || texts.h !== msg.h) texts = { w: msg.w, h: msg.h, masks: new Map() };
    for (const id of texts.masks.keys()) if (!msg.keep.includes(id)) texts.masks.delete(id);
    for (const l of msg.layers) texts.masks.set(l.id, { id: l.id, glyph: coverage(l.glyph), plate: l.plate && coverage(l.plate), version: ++textVersion });
    textVersion++;
    return;
  }
  if (msg.type === "subjectLayer") {
    subjectLayer = { ...splitLayer(msg.rgba, msg.w, msg.h), toDepth: msg.toDepth };
    subjectVersion++;
    return;
  }
  const t0 = performance.now();
  try {
    if (!depth || !guide) throw new Error("No depth map yet");
    const sized = texts && texts.w === guide.w && texts.h === guide.h ? texts : null;
    const input = { depth, guide, depthVersion, guideVersion, coin, subject: subjectInput(), texts: sized && { masks: [...sized.masks.values()], version: textVersion } };
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
          histCoin: r.histCoin,
          histSubject: r.histSubject,
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
