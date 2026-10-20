// Canvas widgets: levels histogram, tone-curve editor, cross-section chart.
// Single-series charts: no legend (the heading names them), 2 px lines, hairline grid,
// text in text colours, hover crosshair + tooltip on the line chart.

import { levels, makeCurve } from "../proc/levels";
import { h } from "./dom";

const C = {
  grid: "#2a2f35",
  axis: "#3a4047",
  text: "#b4bcc6",
  muted: "#8a939e",
  series: "#d9dde2",
  seriesWash: "rgba(217,221,226,0.14)",
  accent: "#ffa31a",
  accentWash: "rgba(255,163,26,0.10)",
  shade: "rgba(0,0,0,0.45)",
  surface: "#121417",
};

function setup(canvas: HTMLCanvasElement, cssH: number): { g: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  canvas.style.height = `${cssH}px`;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, cssH);
  return { g, w, h: cssH };
}

/** Area histogram, square-root scaled so small populations stay visible. */
function drawHist(g: CanvasRenderingContext2D, hist: Uint32Array | null, x0: number, y0: number, w: number, hgt: number, color: string, wash: string) {
  if (!hist) return;
  let max = 0;
  for (let i = 1; i < hist.length - 1; i++) max = Math.max(max, hist[i]); // ignore the end bins (often the masked background)
  max = Math.max(max, 1);
  const n = hist.length;
  g.beginPath();
  g.moveTo(x0, y0 + hgt);
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, Math.sqrt(hist[i] / max));
    g.lineTo(x0 + ((i + 0.5) / n) * w, y0 + hgt - v * hgt);
  }
  g.lineTo(x0 + w, y0 + hgt);
  g.closePath();
  g.fillStyle = wash;
  g.fill();
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, Math.sqrt(hist[i] / max));
    const x = x0 + ((i + 0.5) / n) * w;
    const y = y0 + hgt - v * hgt;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.lineJoin = "round";
  g.stroke();
}

// ------------------------------------------------------------------------------- levels
export class LevelsWidget {
  readonly canvas = h("canvas", { class: "widget", "aria-label": "Histogram of heights before levels, with black point, midtone (gamma) and white point handles" });
  private hist: Uint32Array | null = null;
  private black = 0;
  private white = 1;
  private gamma = 1;
  private drag: "black" | "white" | "gamma" | null = null;
  private readonly H = 96;
  private readonly pad = 8;

  constructor(private onChange: (black: number, white: number, gamma: number) => void) {
    const c = this.canvas;
    const valueAt = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left - this.pad) / (r.width - 2 * this.pad)));
    };
    c.addEventListener("pointerdown", (e) => {
      const v = valueAt(e);
      // Grab whichever handle is under the pointer; a click elsewhere moves the nearer of black/white there.
      this.drag = this.handleAt(e) ?? (Math.abs(v - this.black) <= Math.abs(v - this.white) ? "black" : "white");
      c.setPointerCapture(e.pointerId);
      this.move(v);
    });
    c.addEventListener("pointermove", (e) => {
      if (this.drag) this.move(valueAt(e));
      else c.style.cursor = this.handleAt(e) ? "ew-resize" : "";
    });
    c.addEventListener("pointerup", () => (this.drag = null));
  }

  /** Midtone handle position: where the output reaches 50% gray. */
  private mid(): number {
    return this.black + (this.white - this.black) * Math.pow(0.5, this.gamma);
  }

  private handleAt(e: PointerEvent): "black" | "white" | "gamma" | null {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const X = (v: number) => this.pad + v * (r.width - 2 * this.pad);
    // Black/white win exact ties so the end points can always be pulled apart.
    const near = (["black", "white", "gamma"] as const)
      .map((k) => ({ k, d: Math.abs(x - X(k === "gamma" ? this.mid() : this[k])) }))
      .filter((h) => h.d <= 12)
      .sort((a, b) => a.d - b.d);
    return near[0]?.k ?? null;
  }

  private move(v: number) {
    if (this.drag === "black") this.black = Math.min(v, this.white - 0.005);
    else if (this.drag === "white") this.white = Math.max(v, this.black + 0.005);
    else {
      // The handle sits at black + (white - black) * 0.5^gamma; invert that, within the slider's 0.2..5 range.
      const t = Math.min(Math.pow(0.5, 0.2), Math.max(Math.pow(0.5, 5), (v - this.black) / (this.white - this.black)));
      this.gamma = Math.round((Math.log(t) / Math.log(0.5)) * 100) / 100;
    }
    this.draw();
    this.onChange(this.black, this.white, this.gamma);
  }

  set(hist: Uint32Array | null, black: number, white: number, gamma: number) {
    if (hist) this.hist = hist;
    this.black = black;
    this.white = white;
    this.gamma = gamma;
    this.draw();
  }

  draw() {
    const { g, w } = setup(this.canvas, this.H);
    const p = this.pad;
    const pw = w - 2 * p;
    const ph = this.H - 22;
    const X = (v: number) => p + v * pw;
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    for (const q of [0.25, 0.5, 0.75]) {
      g.beginPath();
      g.moveTo(Math.round(X(q)) + 0.5, 4);
      g.lineTo(Math.round(X(q)) + 0.5, 4 + ph);
      g.stroke();
    }
    drawHist(g, this.hist, p, 4, pw, ph, C.series, C.seriesWash);
    // Clipped regions outside black/white.
    g.fillStyle = C.shade;
    g.fillRect(p, 4, X(this.black) - p, ph);
    g.fillRect(X(this.white), 4, p + pw - X(this.white), ph);
    // Handles: black, gamma midpoint, white.
    const mid = this.mid();
    const tri = (v: number, fill: string) => {
      const x = X(v);
      g.beginPath();
      g.moveTo(x, ph + 6);
      g.lineTo(x - 7, ph + 18);
      g.lineTo(x + 7, ph + 18);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = C.text;
      g.lineWidth = 1.5;
      g.stroke();
    };
    tri(this.black, "#000");
    tri(mid, "#777");
    tri(this.white, "#fff");
  }
}

// ------------------------------------------------------------------------------- curve
export class CurveWidget {
  readonly canvas = h("canvas", {
    class: "widget",
    "aria-label": "Tone curve. Click to add a point, drag to move it, double-click a point to remove it.",
  });
  private points: [number, number][] = [];
  private hist: Uint32Array | null = null;
  private dragIdx = -1;
  private readonly H = 200;
  private readonly pad = 10;

  constructor(private onChange: (points: [number, number][]) => void) {
    const c = this.canvas;
    const pos = (e: PointerEvent | MouseEvent) => {
      const r = c.getBoundingClientRect();
      const x = (e.clientX - r.left - this.pad) / (r.width - 2 * this.pad);
      const y = 1 - (e.clientY - r.top - this.pad) / (this.H - 2 * this.pad);
      return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))] as [number, number];
    };
    const hit = (p: [number, number]) => {
      const r = c.getBoundingClientRect();
      const sx = r.width - 2 * this.pad;
      const sy = this.H - 2 * this.pad;
      return this.points.findIndex(([x, y]) => Math.hypot((x - p[0]) * sx, (y - p[1]) * sy) < 10);
    };
    c.addEventListener("pointerdown", (e) => {
      const p = pos(e);
      let i = hit(p);
      if (i < 0) {
        if (p[0] < 0.02 || p[0] > 0.98) return;
        const y = makeCurve(this.points)(p[0]);
        this.points.push([p[0], y]);
        this.points.sort((a, b) => a[0] - b[0]);
        i = this.points.findIndex((q) => q[0] === p[0]);
      }
      this.dragIdx = i;
      c.setPointerCapture(e.pointerId);
      this.emit();
    });
    c.addEventListener("pointermove", (e) => {
      if (this.dragIdx < 0) return;
      const [x, y] = pos(e);
      const lo = this.dragIdx > 0 ? this.points[this.dragIdx - 1][0] + 0.01 : 0.01;
      const hi = this.dragIdx < this.points.length - 1 ? this.points[this.dragIdx + 1][0] - 0.01 : 0.99;
      this.points[this.dragIdx] = [Math.min(hi, Math.max(lo, x)), y];
      this.emit();
    });
    c.addEventListener("pointerup", () => (this.dragIdx = -1));
    c.addEventListener("dblclick", (e) => {
      const i = hit(pos(e));
      if (i >= 0) {
        this.points.splice(i, 1);
        this.emit();
      }
    });
  }

  private emit() {
    this.draw();
    this.onChange(this.points.map(([x, y]) => [x, y]));
  }

  /** hist: histogram before levels; it is remapped through levels so it lines up with the curve's input. */
  set(points: [number, number][], hist: Uint32Array | null, black: number, white: number, gamma: number) {
    this.points = points.map(([x, y]) => [x, y]);
    if (hist) {
      // Spread each input bin over the output range it maps to, so stretched levels
      // don't leave a comb of empty bins.
      const n = 128;
      const acc = new Float64Array(n);
      for (let i = 0; i < hist.length; i++) {
        if (!hist[i]) continue;
        const a = levels(i / hist.length, black, white, gamma) * n;
        const b = levels((i + 1) / hist.length, black, white, gamma) * n;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        if (hi - lo < 1e-9) {
          acc[Math.min(n - 1, Math.floor(lo))] += hist[i];
          continue;
        }
        for (let k = Math.floor(lo); k < Math.min(n, Math.ceil(hi)); k++) {
          const overlap = Math.min(hi, k + 1) - Math.max(lo, k);
          if (overlap > 0) acc[k] += (hist[i] * overlap) / (hi - lo);
        }
      }
      this.hist = Uint32Array.from(acc, Math.round);
    }
    this.draw();
  }

  draw() {
    const { g, w } = setup(this.canvas, this.H);
    const p = this.pad;
    const pw = w - 2 * p;
    const ph = this.H - 2 * p;
    const X = (v: number) => p + v * pw;
    const Y = (v: number) => p + (1 - v) * ph;
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    for (const q of [0, 0.25, 0.5, 0.75, 1]) {
      g.beginPath();
      g.moveTo(Math.round(X(q)) + 0.5, p);
      g.lineTo(Math.round(X(q)) + 0.5, p + ph);
      g.moveTo(p, Math.round(Y(q)) + 0.5);
      g.lineTo(p + pw, Math.round(Y(q)) + 0.5);
      g.stroke();
    }
    drawHist(g, this.hist, p, p, pw, ph, "rgba(217,221,226,0.35)", "rgba(217,221,226,0.07)");
    g.strokeStyle = C.axis;
    g.beginPath();
    g.moveTo(X(0), Y(0));
    g.lineTo(X(1), Y(1));
    g.stroke();
    const f = makeCurve(this.points);
    g.beginPath();
    for (let i = 0; i <= 200; i++) {
      const x = i / 200;
      if (i) g.lineTo(X(x), Y(f(x)));
      else g.moveTo(X(x), Y(f(x)));
    }
    g.strokeStyle = C.accent;
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.lineCap = "round";
    g.stroke();
    for (const [x, y] of this.points) {
      g.beginPath();
      g.arc(X(x), Y(y), 5, 0, Math.PI * 2);
      g.fillStyle = C.accent;
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = C.surface;
      g.stroke();
    }
    g.fillStyle = C.muted;
    g.font = "11px system-ui, sans-serif";
    g.fillText("deep", p + 4, Y(0) - 4);
    g.textAlign = "right";
    g.fillText("high", X(1) - 4, Y(1) + 12);
    g.textAlign = "left";
  }
}

// ------------------------------------------------------------------------------- profile chart
export interface ProfileData {
  values: Float32Array; // 0..1 along the line
  lengthMM: number;
  reliefMM: number;
  passes: number;
  bits: 8 | 16;
}

export class ProfileChart {
  readonly canvas = h("canvas", { "aria-label": "Height along the cross-section line" });
  private tip = h("div", { class: "chart-tip", hidden: true });
  private hint = h("div", { class: "hint" }, "Drag across the photo or depth map to draw a cross-section. Hold Shift for a straight line.");
  private data: ProfileData | null = null;
  private hover: number | null = null;
  private readonly m = { l: 46, r: 16, t: 26, b: 28 };

  constructor(private root: HTMLElement) {
    root.append(this.canvas, this.tip, this.hint);
    new ResizeObserver(() => this.draw()).observe(root);
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.data) return;
      const r = this.canvas.getBoundingClientRect();
      const t = (e.clientX - r.left - this.m.l) / (r.width - this.m.l - this.m.r);
      this.hover = t >= 0 && t <= 1 ? t : null;
      this.draw();
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.draw();
    });
  }

  set(d: ProfileData | null) {
    this.data = d;
    this.hint.hidden = !!d;
    this.draw();
  }

  draw() {
    const H = this.root.clientHeight || 200;
    const { g, w } = setup(this.canvas, H);
    this.canvas.style.width = "100%";
    const { l, r, t, b } = this.m;
    const pw = w - l - r;
    const ph = H - t - b;
    g.fillStyle = C.text;
    g.font = "600 12px system-ui, sans-serif";
    g.fillText("Height along the line", l, 16);
    const d = this.data;
    if (!d || d.values.length < 2) {
      this.tip.hidden = true;
      return;
    }
    g.font = "11px system-ui, sans-serif";
    g.fillStyle = C.muted;
    g.textAlign = "right";
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    const X = (u: number) => l + u * pw;
    const Y = (v: number) => t + (1 - v) * ph;
    for (const gray of [0, 64, 128, 192, 255]) {
      const y = Math.round(Y(gray / 255)) + 0.5;
      g.beginPath();
      g.moveTo(l, y);
      g.lineTo(l + pw, y);
      g.stroke();
      g.fillText(String(gray), l - 6, y + 4);
    }
    g.save();
    g.translate(12, t + ph / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = "center";
    g.fillText("gray level", 0, 0);
    g.restore();
    // X ticks in mm.
    g.textAlign = "center";
    const step = niceStep(d.lengthMM / 6);
    for (let mm = 0; mm <= d.lengthMM + 1e-9; mm += step) {
      const x = X(mm / d.lengthMM);
      g.fillText(`${+mm.toFixed(2)}`, x, t + ph + 16);
    }
    g.textAlign = "right";
    g.fillText("mm", l + pw, t + ph + 16);
    g.textAlign = "left";
    // Series: area wash + 2 px line.
    const n = d.values.length;
    g.beginPath();
    g.moveTo(X(0), Y(0));
    for (let i = 0; i < n; i++) g.lineTo(X(i / (n - 1)), Y(d.values[i]));
    g.lineTo(X(1), Y(0));
    g.closePath();
    g.fillStyle = C.accentWash;
    g.fill();
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = X(i / (n - 1));
      const y = Y(d.values[i]);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.strokeStyle = C.accent;
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.lineCap = "round";
    g.stroke();
    // Crosshair + tooltip.
    if (this.hover !== null) {
      const i = Math.round(this.hover * (n - 1));
      const v = d.values[i];
      const x = X(i / (n - 1));
      g.strokeStyle = C.axis;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, t);
      g.lineTo(Math.round(x) + 0.5, t + ph);
      g.stroke();
      g.beginPath();
      g.arc(x, Y(v), 4.5, 0, Math.PI * 2);
      g.fillStyle = C.accent;
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = C.surface;
      g.stroke();
      const gray = Math.round(v * 255);
      const max = d.bits === 16 ? 65535 : 255;
      const q = Math.round(v * max);
      const passes = d.passes - Math.ceil((q / max) * d.passes - 1e-9);
      this.tip.innerHTML = `${((i / (n - 1)) * d.lengthMM).toFixed(2)} mm along<br>gray <b>${gray}</b> · ${Math.max(0, passes)} of ${d.passes} passes<br>${((1 - v) * d.reliefMM).toFixed(3)} mm below the top`;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = `${Math.min(w - tw - 6, x + 12)}px`;
      this.tip.style.top = `${t}px`;
    } else this.tip.hidden = true;
  }
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
