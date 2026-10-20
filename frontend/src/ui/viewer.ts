// Side-by-side compare view: photo on the left, depth map on the right, with one shared
// zoom/pan. Also hosts the crop editor (left pane shows the whole photo) and the
// cross-section line tool.

import type { Circle, CropShape, Rect } from "../proc/settings";
import { h } from "./dom";

type Pt = { x: number; y: number };
interface View {
  scale: number;
  tx: number;
  ty: number;
}

const SVG = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

interface PaneParts {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  overlay: SVGSVGElement;
}

function makePane(root: HTMLElement): PaneParts {
  const canvas = h("canvas", { class: "img" });
  const overlay = svg("svg", { class: "overlay" }) as SVGSVGElement;
  root.append(canvas, overlay);
  return { root, canvas, overlay };
}

export interface CropState {
  shape: CropShape;
  circle: Circle;
  rect: Rect;
}

export interface ViewerCallbacks {
  onCropChange(c: CropState, final: boolean): void;
  onProfile(a: Pt, b: Pt): void;
}

export class CompareViewer {
  private left: PaneParts;
  private right: PaneParts;
  private view: View = { scale: 1, tx: 0, ty: 0 };
  private cropView: View = { scale: 1, tx: 0, ty: 0 };
  private contentW = 0;
  private contentH = 0;
  private sourceW = 0;
  private sourceH = 0;
  private cropMode = false;
  private profileMode = false;
  private crop: CropState | null = null;
  private line: [Pt, Pt] | null = null;
  private fitted = false;

  constructor(leftRoot: HTMLElement, rightRoot: HTMLElement, private cb: ViewerCallbacks) {
    this.left = makePane(leftRoot);
    this.right = makePane(rightRoot);
    for (const p of [this.left, this.right]) this.bindPane(p);
    new ResizeObserver(() => {
      if (!this.fitted) this.fit();
      this.apply();
    }).observe(rightRoot);
  }

  /** Cropped photo (left) and depth (right) share the same pixel size. */
  setContent(photo: CanvasImageSource | null, depth: ImageData | null, w: number, h: number) {
    const sizeChanged = w !== this.contentW || h !== this.contentH;
    this.contentW = w;
    this.contentH = h;
    if (!this.cropMode && photo) this.drawTo(this.left.canvas, photo, w, h);
    if (depth) {
      const c = this.right.canvas;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      c.getContext("2d")!.putImageData(depth, 0, 0);
    }
    if (sizeChanged) this.fit();
    this.apply();
  }

  private photo: CanvasImageSource | null = null;
  setPhoto(photo: CanvasImageSource) {
    this.photo = photo;
    if (!this.cropMode) this.drawTo(this.left.canvas, photo, this.contentW, this.contentH);
  }

  private drawTo(c: HTMLCanvasElement, src: CanvasImageSource, w: number, h: number) {
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, w, h);
    g.drawImage(src, 0, 0, w, h);
  }

  /** Crop editor: left pane shows the full source photo with a draggable circle/box. */
  setCropMode(on: boolean, source?: ImageBitmap, crop?: CropState) {
    this.cropMode = on;
    if (on && source && crop) {
      this.sourceW = source.width;
      this.sourceH = source.height;
      this.crop = structuredClone(crop);
      this.drawTo(this.left.canvas, source, source.width, source.height);
      this.cropView = this.fitView(this.left.root, source.width, source.height);
    } else if (this.photo) {
      this.drawTo(this.left.canvas, this.photo, this.contentW, this.contentH);
    }
    this.apply();
  }

  updateCrop(crop: CropState) {
    this.crop = structuredClone(crop);
    this.apply();
  }

  setProfileMode(on: boolean) {
    this.profileMode = on;
    for (const p of [this.left, this.right]) p.root.classList.toggle("drawing", on);
    if (!on) this.line = null;
    this.apply();
  }

  get profileLine(): [Pt, Pt] | null {
    return this.line;
  }

  fit() {
    if (!this.contentW) return;
    this.view = this.fitView(this.right.root, this.contentW, this.contentH);
    this.fitted = true;
    if (this.cropMode) this.cropView = this.fitView(this.left.root, this.sourceW, this.sourceH);
    this.apply();
  }

  oneToOne() {
    const r = this.right.root.getBoundingClientRect();
    this.view = { scale: 1 / devicePixelRatio, tx: (r.width - this.contentW / devicePixelRatio) / 2, ty: (r.height - this.contentH / devicePixelRatio) / 2 };
    this.apply();
  }

  private fitView(root: HTMLElement, w: number, h: number): View {
    const r = root.getBoundingClientRect();
    if (!r.width || !w) return { scale: 1, tx: 0, ty: 0 };
    const pad = 16;
    const scale = Math.min((r.width - 2 * pad) / w, (r.height - 2 * pad) / h);
    return { scale, tx: (r.width - w * scale) / 2, ty: (r.height - h * scale) / 2 };
  }

  private viewFor(p: PaneParts): View {
    return p === this.left && this.cropMode ? this.cropView : this.view;
  }

  private apply() {
    for (const p of [this.left, this.right]) {
      const v = this.viewFor(p);
      p.canvas.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
      p.canvas.classList.toggle("pixelated", v.scale > 2);
      this.drawOverlay(p, v);
    }
  }

  private drawOverlay(p: PaneParts, v: View) {
    const o = p.overlay;
    o.replaceChildren();
    const S = (pt: Pt) => ({ x: v.tx + pt.x * v.scale, y: v.ty + pt.y * v.scale });
    if (p === this.left && this.cropMode && this.crop) {
      const c = this.crop;
      // Darken everything outside the crop.
      const W = this.sourceW;
      const H = this.sourceH;
      const tl = S({ x: 0, y: 0 });
      const br = S({ x: W, y: H });
      let hole: string;
      if (c.shape === "circle") {
        const ctr = S({ x: c.circle.cx, y: c.circle.cy });
        const r = c.circle.r * v.scale;
        hole = `M ${ctr.x - r} ${ctr.y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
      } else {
        const a = S({ x: c.rect.x, y: c.rect.y });
        const b = S({ x: c.rect.x + c.rect.w, y: c.rect.y + c.rect.h });
        hole = `M ${a.x} ${a.y} H ${b.x} V ${b.y} H ${a.x} Z`;
      }
      o.append(
        svg("path", {
          d: `M ${tl.x} ${tl.y} H ${br.x} V ${br.y} H ${tl.x} Z ${hole}`,
          fill: "rgba(0,0,0,0.55)",
          "fill-rule": "evenodd",
        }),
      );
      if (c.shape === "circle") {
        const ctr = S({ x: c.circle.cx, y: c.circle.cy });
        const r = c.circle.r * v.scale;
        o.append(
          svg("circle", { cx: ctr.x, cy: ctr.y, r, fill: "none", stroke: "#ffa31a", "stroke-width": 2 }),
          svg("circle", { cx: ctr.x, cy: ctr.y, r: 5, fill: "#ffa31a", stroke: "#121417", "stroke-width": 2 }),
          svg("circle", { cx: ctr.x + r, cy: ctr.y, r: 7, fill: "#ffa31a", stroke: "#121417", "stroke-width": 2 }),
        );
      } else {
        const a = S({ x: c.rect.x, y: c.rect.y });
        const b = S({ x: c.rect.x + c.rect.w, y: c.rect.y + c.rect.h });
        o.append(svg("rect", { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y, fill: "none", stroke: "#ffa31a", "stroke-width": 2 }));
        for (const q of [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]) {
          o.append(svg("rect", { x: q.x - 6, y: q.y - 6, width: 12, height: 12, fill: "#ffa31a", stroke: "#121417", "stroke-width": 2 }));
        }
      }
      return;
    }
    if (this.line) {
      const [a, b] = this.line.map(S);
      o.append(
        svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "#121417", "stroke-width": 5, "stroke-linecap": "round" }),
        svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "#ffa31a", "stroke-width": 2, "stroke-linecap": "round" }),
        svg("circle", { cx: a.x, cy: a.y, r: 4, fill: "#ffa31a", stroke: "#121417", "stroke-width": 2 }),
        svg("circle", { cx: b.x, cy: b.y, r: 4, fill: "#ffa31a", stroke: "#121417", "stroke-width": 2 }),
      );
    }
  }

  private bindPane(p: PaneParts) {
    const root = p.root;
    let mode: "pan" | "line" | "move" | "radius" | "corner" | null = null;
    let start: Pt = { x: 0, y: 0 };
    let startView: View = { scale: 1, tx: 0, ty: 0 };
    let startCrop: CropState | null = null;
    let corner = 0;

    const local = (e: PointerEvent | WheelEvent | MouseEvent): Pt => {
      const r = root.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const toImg = (pt: Pt, v: View): Pt => ({ x: (pt.x - v.tx) / v.scale, y: (pt.y - v.ty) / v.scale });

    root.addEventListener("wheel", (e) => {
      e.preventDefault();
      const v = this.viewFor(p);
      const m = local(e);
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      const scale = Math.min(64, Math.max(0.02, v.scale * f));
      const k = scale / v.scale;
      v.tx = m.x - (m.x - v.tx) * k;
      v.ty = m.y - (m.y - v.ty) * k;
      v.scale = scale;
      this.apply();
    }, { passive: false });

    root.addEventListener("dblclick", () => this.fit());

    root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const v = this.viewFor(p);
      const m = local(e);
      start = m;
      startView = { ...v };
      mode = "pan";
      if (p === this.left && this.cropMode && this.crop) {
        const ip = toImg(m, v);
        const c = this.crop;
        const tol = 10 / v.scale;
        if (c.shape === "circle") {
          const d = Math.hypot(ip.x - c.circle.cx, ip.y - c.circle.cy);
          if (Math.abs(d - c.circle.r) < tol * 1.5) mode = "radius";
          else if (d < c.circle.r) mode = "move";
        } else {
          const cs = [
            [c.rect.x, c.rect.y],
            [c.rect.x + c.rect.w, c.rect.y],
            [c.rect.x + c.rect.w, c.rect.y + c.rect.h],
            [c.rect.x, c.rect.y + c.rect.h],
          ];
          const hit = cs.findIndex(([x, y]) => Math.hypot(ip.x - x, ip.y - y) < tol * 1.5);
          if (hit >= 0) {
            mode = "corner";
            corner = hit;
          } else if (ip.x > c.rect.x && ip.x < c.rect.x + c.rect.w && ip.y > c.rect.y && ip.y < c.rect.y + c.rect.h) mode = "move";
        }
        startCrop = structuredClone(c);
      } else if (this.profileMode && !(p === this.left && this.cropMode)) {
        mode = "line";
        const ip = toImg(m, v);
        this.line = [ip, ip];
      }
      root.setPointerCapture(e.pointerId);
      root.classList.toggle("dragging", mode === "pan");
    });

    root.addEventListener("pointermove", (e) => {
      if (!mode) return;
      const m = local(e);
      const v = this.viewFor(p);
      if (mode === "pan") {
        v.tx = startView.tx + (m.x - start.x);
        v.ty = startView.ty + (m.y - start.y);
        this.apply();
        return;
      }
      const ip = toImg(m, v);
      if (mode === "line" && this.line) {
        let b = ip;
        if (e.shiftKey) {
          // Shift snaps to horizontal / vertical.
          const a = this.line[0];
          b = Math.abs(ip.x - a.x) > Math.abs(ip.y - a.y) ? { x: ip.x, y: a.y } : { x: a.x, y: ip.y };
        }
        this.line = [this.line[0], b];
        this.apply();
        this.cb.onProfile(this.line[0], this.line[1]);
        return;
      }
      if (!this.crop || !startCrop) return;
      const sp = toImg(start, v);
      const dx = ip.x - sp.x;
      const dy = ip.y - sp.y;
      const c = this.crop;
      if (mode === "move") {
        if (c.shape === "circle") {
          c.circle.cx = startCrop.circle.cx + dx;
          c.circle.cy = startCrop.circle.cy + dy;
        } else {
          c.rect.x = startCrop.rect.x + dx;
          c.rect.y = startCrop.rect.y + dy;
        }
      } else if (mode === "radius") {
        c.circle.r = Math.max(8, Math.hypot(ip.x - c.circle.cx, ip.y - c.circle.cy));
      } else if (mode === "corner") {
        const r0 = startCrop.rect;
        let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h;
        if (corner === 0 || corner === 3) x0 += dx;
        else x1 += dx;
        if (corner === 0 || corner === 1) y0 += dy;
        else y1 += dy;
        c.rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(8, Math.abs(x1 - x0)), h: Math.max(8, Math.abs(y1 - y0)) };
      }
      this.apply();
      this.cb.onCropChange(structuredClone(c), false);
    });

    const end = () => {
      if (mode && mode !== "pan" && mode !== "line" && this.crop) this.cb.onCropChange(structuredClone(this.crop), true);
      mode = null;
      root.classList.remove("dragging");
    };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
  }
}
