// Draws text layers into coverage masks for the worker: the letters, and the background plate.
// Straight text sits at a position and angle; arc text follows a circle around the coin's centre,
// reading clockwise along the top or left to right along the bottom, letters upright.

import type { TextLayer } from "./proc/settings";

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);

export function cssFont(t: Pick<TextLayer, "font" | "bold" | "italic">, px: number): string {
  const family = GENERIC.has(t.font) ? t.font : `"${t.font.replace(/"/g, "")}", serif`;
  return `${t.italic ? "italic " : ""}${t.bold ? 700 : 400} ${px}px ${family}`;
}

/** Everything that changes which pixels a layer covers (not their heights). */
export function textGeometryKey(t: TextLayer): string {
  return JSON.stringify([t.id, t.enabled, t.text, t.font, t.bold, t.italic, t.sizeMM, t.spacing, t.layout, t.x, t.y, t.rotation, t.radius, t.angle,
    t.plate.enabled, t.plate.paddingMM, t.plate.rounded]);
}

/** Make sure the layers' fonts are loaded before drawing (fonts from the fonts folder load lazily). */
export async function loadFonts(layers: TextLayer[]): Promise<void> {
  await Promise.all(layers.map((t) => document.fonts.load(cssFont(t, 32), t.text || "A").catch(() => [])));
}

/** False while the layer's font is still loading (it would be drawn in a fallback font). */
export function fontReady(t: TextLayer): boolean {
  try {
    return document.fonts.check(cssFont(t, 32), t.text || "A");
  } catch {
    return true;
  }
}

export interface TextMaskBytes {
  id: number;
  glyph: Uint8Array;
  plate: Uint8Array | null;
}

/** Coverage masks (0..255) for one layer on a w x h output at pxPerMM. */
export function renderTextMasks(t: TextLayer, w: number, h: number, pxPerMM: number): TextMaskBytes {
  const glyphs = canvas(w, h);
  const g = glyphs.getContext("2d", { willReadFrequently: true })!;
  // Size by the capital letters' height, which is what engravers measure.
  g.font = cssFont(t, 100);
  const capRatio = (g.measureText("H").actualBoundingBoxAscent || 70) / 100;
  const cap = t.sizeMM * pxPerMM;
  g.font = cssFont(t, cap / capRatio);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  const chars = Array.from(t.text);
  const gap = t.spacing * cap;
  // Each letter's centre along the line, measured on growing prefixes so the font's kerning is kept.
  const prefix = [0];
  for (let i = 1; i <= chars.length; i++) prefix.push(g.measureText(chars.slice(0, i).join("")).width);
  const total = prefix[chars.length] + gap * Math.max(0, chars.length - 1);
  const centres = chars.map((_, i) => prefix[i] + gap * i + (prefix[i + 1] - prefix[i]) / 2 - total / 2);
  const m = g.measureText(t.text);
  const ascent = Math.max(cap, m.actualBoundingBoxAscent || 0);
  const descent = Math.max(0, m.actualBoundingBoxDescent || 0);
  const pad = t.plate.paddingMM * pxPerMM;

  const plateCanvas = t.plate.enabled && chars.length ? canvas(w, h) : null;
  const p = plateCanvas?.getContext("2d", { willReadFrequently: true }) ?? null;
  if (p) {
    p.fillStyle = "#fff";
    p.strokeStyle = "#fff";
  }

  if (t.layout === "straight") {
    for (const c of [g, p]) {
      c?.translate(w / 2 + t.x * w, h / 2 + t.y * h);
      c?.rotate((t.rotation * Math.PI) / 180);
    }
    // The middle of the capitals sits on the anchor point.
    chars.forEach((ch, i) => g.fillText(ch, centres[i], cap / 2));
    if (p) {
      const top = cap / 2 - ascent - pad;
      const bh = ascent + descent + 2 * pad;
      p.beginPath();
      p.roundRect(-total / 2 - pad, top, total + 2 * pad, bh, t.plate.rounded ? bh / 2 : 0);
      p.fill();
    }
  } else {
    const R = Math.max(1, t.radius * (Math.min(w, h) / 2)); // middle of the capitals
    const top = t.layout === "arcTop";
    const a0 = (t.angle * Math.PI) / 180;
    // Top: letters stand outward from a baseline inside R. Bottom: upright, baseline outside R.
    const base = top ? R - cap / 2 : R + cap / 2;
    g.translate(w / 2, h / 2);
    chars.forEach((ch, i) => {
      const phi = top ? a0 + centres[i] / R : Math.PI + a0 - centres[i] / R; // clockwise from the top
      g.save();
      g.rotate(top ? phi : phi - Math.PI);
      g.fillText(ch, 0, top ? -base : base);
      g.restore();
    });
    if (p) {
      const inner = top ? base - descent - pad : base - ascent - pad;
      const outer = top ? base + ascent + pad : base + descent + pad;
      const mid = (inner + outer) / 2;
      const band = outer - inner;
      // Round ends add half the band's width; take that back so the padding stays the same.
      const half = Math.max(0, (total / 2 + pad - (t.plate.rounded ? band / 2 : 0)) / mid);
      const centre = (top ? a0 : Math.PI + a0) - Math.PI / 2; // canvas angles start at 3 o'clock
      p.lineWidth = band;
      p.lineCap = t.plate.rounded ? "round" : "butt";
      p.beginPath();
      p.arc(w / 2, h / 2, mid, centre - half, centre + half);
      p.stroke();
    }
  }
  return { id: t.id, glyph: alpha(g, w, h), plate: p ? alpha(p, w, h) : null };
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function alpha(c: CanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const px = c.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3];
  return out;
}
