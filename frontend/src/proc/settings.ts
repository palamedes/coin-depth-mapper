// Every adjustable setting. Plain JSON so it can be saved as a preset and sent to workers.
// Spatial sizes are in millimetres on the finished piece, so a preset looks the same at
// any DPI; the pipeline converts them to pixels.

export type CropShape = "circle" | "rect";
export type UpsampleMethod = "guided" | "jbu" | "bilinear";

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Settings {
  crop: {
    shape: CropShape;
    circle: Circle; // in source-image pixels
    rect: Rect; // in source-image pixels
    hideOutsideFromModel: boolean;
  };
  model: { id: string; resolution: number; params: Record<string, number>; allowNonCommercial: boolean; autoRun: boolean };
  tilt: { enabled: boolean };
  upsample: { enabled: boolean; method: UpsampleMethod; radius: number; edge: number };
  detail: { enabled: boolean; radiusMM: number; strength: number; limit: number };
  mask: { enabled: boolean; outside: number; softMM: number };
  flatten: { enabled: boolean; threshold: number; level: number; falloffMM: number };
  rim: { enabled: boolean; widthMM: number; height: number; bevelMM: number };
  levels: { enabled: boolean; black: number; white: number; gamma: number; curve: [number, number][] };
  smooth: {
    despeckle: boolean;
    despeckleRadius: number;
    despeckleThreshold: number;
    bilateral: boolean;
    bilateralMM: number;
    bilateralRange: number;
    gaussianMM: number;
  };
  invert: boolean;
  output: { widthMM: number; dpi: number; bits: 8 | 16; previewSize: number };
  relief: { depthMM: number; baseMM: number; stlGrid: number };
  slices: { passes: number };
}

export function defaultSettings(): Settings {
  return {
    crop: {
      shape: "circle",
      circle: { cx: 0, cy: 0, r: 0 },
      rect: { x: 0, y: 0, w: 0, h: 0 },
      hideOutsideFromModel: false,
    },
    model: { id: "da3-mono-large", resolution: 1008, params: {}, allowNonCommercial: false, autoRun: true },
    tilt: { enabled: true },
    upsample: { enabled: true, method: "guided", radius: 2, edge: -3 },
    detail: { enabled: true, radiusMM: 0.25, strength: 0.2, limit: 0.12 },
    mask: { enabled: true, outside: 0, softMM: 0 },
    flatten: { enabled: false, threshold: 0.3, level: 0.25, falloffMM: 0.3 },
    rim: { enabled: false, widthMM: 1.5, height: 1, bevelMM: 0.3 },
    levels: { enabled: true, black: 0, white: 1, gamma: 1, curve: [] },
    smooth: {
      despeckle: true,
      despeckleRadius: 1,
      despeckleThreshold: 0.04,
      bilateral: false,
      bilateralMM: 0.1,
      bilateralRange: 0.05,
      gaussianMM: 0.02,
    },
    invert: false,
    output: { widthMM: 40, dpi: 1000, bits: 16, previewSize: 1024 },
    relief: { depthMM: 0.5, baseMM: 2, stlGrid: 600 },
    slices: { passes: 256 },
  };
}

/** Fill in anything missing (older presets, partial JSON) from the defaults. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const merge = (a: any, b: any): any => {
    if (b === undefined || b === null) return a;
    if (Array.isArray(a) || typeof a !== "object" || a === null) return typeof b === typeof a || a === null ? b : a;
    const out: any = { ...a };
    for (const k of Object.keys(a)) out[k] = merge(a[k], b[k]);
    // Free-form maps (model params) keep keys the defaults don't know about.
    if (Object.keys(a).length === 0 && typeof b === "object") return { ...b };
    return out;
  };
  return merge(base, patch);
}

/** The part of the settings that belongs in a preset (not tied to one particular image). */
export function presetPart(s: Settings): Partial<Settings> {
  const { crop, ...rest } = structuredClone(s);
  return { ...rest, crop: { shape: crop.shape, hideOutsideFromModel: crop.hideOutsideFromModel } as Settings["crop"] };
}

/** Guided-filter epsilon from the UI's log10 "edge" slider. */
export function edgeEps(edge: number): number {
  return Math.pow(10, edge);
}
