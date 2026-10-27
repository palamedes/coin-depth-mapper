// Every adjustable setting. Plain JSON so it can be saved as a preset and sent to workers.
// Spatial sizes are in millimetres on the finished piece, so a preset looks the same at
// any DPI; the pipeline converts them to pixels.

export type CropShape = "circle" | "rect";
export type TextLayout = "straight" | "arcTop" | "arcBottom";
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

/** Levels and a curve, for one layer's heights (or a text layer's edge profile). */
export interface Tone {
  black: number;
  white: number;
  gamma: number;
  curve: [number, number][];
  strength: number; // how strong the relief is after them: 1 as set, 0 flat, up to 1.2 (not used for a letter profile)
}

/** A line of text on the coin, with an optional outline and background plate. Heights are absolute (0..1). */
export interface TextLayer {
  id: number;
  enabled: boolean;
  text: string;
  font: string; // CSS font family
  bold: boolean;
  italic: boolean;
  sizeMM: number; // height of the capital letters
  spacing: number; // extra space between letters, as a share of the letter height
  layout: TextLayout;
  x: number; // straight: centre offset, fraction of the crop width (+ right)
  y: number; // straight: centre offset, fraction of the crop height (+ down)
  rotation: number; // straight: degrees clockwise
  radius: number; // arc: middle of the letters, fraction of the crop radius
  angle: number; // arc: degrees clockwise from the top (or from the bottom for a bottom arc)
  height: number; // letters' top; below the surface they stand on, they're sunk instead
  bevelMM: number; // width of the letters' sloped edge
  tone: Tone; // shape of that slope
  outline: { enabled: boolean; widthMM: number; gapMM: number; height: number };
  plate: {
    enabled: boolean;
    paddingMM: number;
    rounded: boolean;
    height: number;
    bevelMM: number;
    border: { enabled: boolean; widthMM: number; height: number };
  };
}

export const flatTone = (): Tone => ({ black: 0, white: 1, gamma: 1, curve: [], strength: 1 });

export function defaultTextLayer(id: number): TextLayer {
  return {
    id,
    enabled: true,
    text: "TEXT",
    font: "Cinzel",
    bold: true,
    italic: false,
    sizeMM: 3,
    spacing: 0.1,
    layout: "arcTop",
    x: 0,
    y: 0.3,
    rotation: 0,
    radius: 0.8,
    angle: 0,
    height: 1,
    bevelMM: 0.1,
    tone: flatTone(),
    outline: { enabled: false, widthMM: 0.3, gapMM: 0.2, height: 0.8 },
    plate: { enabled: false, paddingMM: 1, rounded: true, height: 0.5, bevelMM: 0.15, border: { enabled: false, widthMM: 0.3, height: 0.8 } },
  };
}

export interface Settings {
  crop: {
    shape: CropShape;
    circle: Circle; // in source-image pixels
    rect: Rect; // in source-image pixels
    hideOutsideFromModel: boolean;
  };
  /** Heights for a background coin (from the coins folder), levelled so its field is 0 and its top 1. */
  coin: { field: number; top: number; tone: Tone };
  /** A cut-out image (transparent background) placed on the coin. Sizes are fractions of the crop. */
  subject: {
    size: number; // longest side of the subject, as a fraction of the crop width
    x: number; // centre offset, fraction of the crop width (+ right)
    y: number; // centre offset, fraction of the crop height (+ down)
    top: number; // height of the subject's highest point
    edgeMM: number; // soften its outline into the coin
    tone: Tone; // its relief (0 at the coin, 1 at its top) before the height is applied
  };
  texts: TextLayer[];
  model: { id: string; resolution: number; params: Record<string, number>; allowNonCommercial: boolean; autoRun: boolean };
  tilt: { enabled: boolean };
  upsample: { enabled: boolean; method: UpsampleMethod; radius: number; edge: number };
  detail: { enabled: boolean; radiusMM: number; strength: number; limit: number };
  mask: { enabled: boolean; outside: number; softMM: number };
  flatten: { enabled: boolean; threshold: number; level: number; falloffMM: number };
  rim: { enabled: boolean; widthMM: number; height: number; bevelMM: number };
  /** The final levels and curve, over everything. Turning it off also turns off the coin's and subject's own. */
  levels: Tone & { enabled: boolean };
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
    coin: { field: 0.25, top: 1, tone: flatTone() },
    subject: { size: 0.8, x: 0, y: 0, top: 1, edgeMM: 0.05, tone: flatTone() },
    texts: [],
    model: { id: "da3-mono-large", resolution: 1008, params: {}, allowNonCommercial: false, autoRun: true },
    tilt: { enabled: true },
    upsample: { enabled: true, method: "guided", radius: 2, edge: -3 },
    detail: { enabled: true, radiusMM: 0.25, strength: 0.2, limit: 0.12 },
    mask: { enabled: true, outside: 0, softMM: 0 },
    flatten: { enabled: false, threshold: 0.3, level: 0.25, falloffMM: 0.3 },
    rim: { enabled: false, widthMM: 1.5, height: 1, bevelMM: 0.3 },
    levels: { enabled: true, ...flatTone() },
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
  const s: Settings = merge(base, patch);
  // Text layers: each one filled in from the defaults too.
  s.texts = Array.isArray(s.texts) ? s.texts.map((t, i) => merge(defaultTextLayer(i + 1), t)) : [];
  return s;
}

/** The part of the settings that belongs in a preset (not tied to one particular image). */
export function presetPart(s: Settings): Partial<Settings> {
  const { crop, subject, ...rest } = structuredClone(s);
  return {
    ...rest,
    crop: { shape: crop.shape, hideOutsideFromModel: crop.hideOutsideFromModel } as Settings["crop"],
    subject: { top: subject.top, edgeMM: subject.edgeMM, tone: subject.tone } as Settings["subject"],
  };
}

/** Guided-filter epsilon from the UI's log10 "edge" slider. */
export function edgeEps(edge: number): number {
  return Math.pow(10, edge);
}
