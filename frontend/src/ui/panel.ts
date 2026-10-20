// The left control panel: one collapsible section per pipeline step, in pipeline order.

import type { ModelInfo } from "../api";
import { exportSize } from "../proc/export";
import type { Settings } from "../proc/settings";
import { fmtBytes, h, helpIcon } from "./dom";
import { CurveWidget, LevelsWidget } from "./widgets";

/** What a change invalidates: the model's depth, the crop/guide, the output size, or just post-processing. */
export type ChangeKind = "post" | "model" | "crop" | "size" | "none";

export interface PanelHooks {
  settings(): Settings;
  change(kind: ChangeKind): void;
  models(): ModelInfo[];
  source(): { name: string; w: number; h: number } | null;
  ringInfo(): { index: number; count: number };
  hasBackend(): boolean;
  depthStale(): boolean;
  busy(): boolean;
  openImage(): void;
  detectCoin(): void;
  nextRing(): void;
  toggleCropEditor(): void;
  runModel(): void;
  autoLevels(): void;
  exportPNG(): void;
  exportSTL(): void;
}

const get = (o: any, path: string) => path.split(".").reduce((a, k) => a[k], o);
const set = (o: any, path: string, v: unknown) => {
  const ks = path.split(".");
  const last = ks.pop()!;
  ks.reduce((a, k) => a[k], o)[last] = v;
};

export class Panel {
  private open = new Set(["image", "crop", "model", "levels", "output"]);
  private levelsWidget = new LevelsWidget((black, white, gamma) => {
    const s = this.hooks.settings();
    s.levels.black = +black.toFixed(4);
    s.levels.white = +white.toFixed(4);
    s.levels.gamma = gamma;
    this.refreshValues();
    this.hooks.change("post");
  });
  private curveWidget = new CurveWidget((pts) => {
    this.hooks.settings().levels.curve = pts.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
    this.hooks.change("post");
  });
  private valueLabels: (() => void)[] = [];
  private stats = h("div", { class: "note" });
  private histBefore: Uint32Array | null = null;

  constructor(private root: HTMLElement, private hooks: PanelHooks) {}

  private get s() {
    return this.hooks.settings();
  }

  /** px per mm in the exported file, for "≈ N px" hints. */
  private pxPerMM() {
    return this.s.output.dpi / 25.4;
  }

  render() {
    const scroll = this.root.scrollTop;
    this.valueLabels = [];
    this.root.replaceChildren(
      this.section("image", "1", "Image", null, this.imageBody()),
      this.section("crop", "2", "Crop & mask", null, this.cropBody()),
      this.section("model", "3", "Depth model", null, this.modelBody()),
      this.section("upsample", "4", "Level & upsample", null, this.upsampleBody()),
      this.section("detail", "5", "Detail boost", "detail.enabled", this.detailBody(),
        "Add fine texture (fur, hair, engraving lines) from the photo that depth models smooth away."),
      this.section("flatten", "6", "Background flatten", "flatten.enabled", this.flattenBody(),
        "Make the coin's field (the flat area behind the subject) one perfectly flat level."),
      this.section("rim", "7", "Rim", "rim.enabled", this.rimBody(),
        "Add a raised ring around the edge, like a real coin (a raised frame for rectangles)."),
      this.section("levels", "8", "Levels & curve", "levels.enabled", this.levelsBody(),
        "Set which heights become black (deepest) and white (top). Use the full range so every pass counts."),
      this.section("smooth", "9", "Smoothing", null, this.smoothBody()),
      this.section("output", "10", "Output & export", null, this.outputBody()),
      this.section("relief", "11", "3D preview & STL", null, this.reliefBody()),
    );
    this.root.scrollTop = scroll;
    this.refreshValues();
  }

  /** Update histogram/levels widgets and stats after a pipeline run. */
  showResult(histBefore: Uint32Array, distinct8: number, distinct16: number, min8: number, max8: number) {
    this.histBefore = histBefore;
    const l = this.s.levels;
    this.levelsWidget.set(histBefore, l.black, l.white, l.gamma);
    this.curveWidget.set(l.curve, histBefore, l.black, l.white, l.gamma);
    const bits = this.s.output.bits;
    this.stats.replaceChildren(
      `Uses ${distinct8} of 256 gray levels`,
      bits === 16 ? ` (${distinct16.toLocaleString()} in 16-bit)` : "",
      `. Darkest ${min8}, lightest ${max8}.`,
    );
    this.stats.className = min8 > 2 || max8 < 253 ? "note warn" : "note";
  }

  refreshValues() {
    for (const f of this.valueLabels) f();
  }

  // ---------------------------------------------------------------- building blocks
  private section(id: string, step: string, title: string, togglePath: string | null, body: HTMLElement[], tip?: string) {
    const details = h("details", { class: "section", open: this.open.has(id) }) as HTMLDetailsElement;
    details.addEventListener("toggle", () => (details.open ? this.open.add(id) : this.open.delete(id)));
    const summary = h("summary", {}, h("span", { class: "step" }, step), h("span", { class: "title" }, title));
    if (tip) summary.append(helpIcon(tip));
    if (togglePath) {
      const cb = h("input", { type: "checkbox", class: "toggle", checked: !!get(this.s, togglePath), "aria-label": `Enable ${title}` }) as HTMLInputElement;
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        set(this.s, togglePath, cb.checked);
        details.classList.toggle("disabled", !cb.checked);
        this.hooks.change("post");
      });
      details.classList.toggle("disabled", !cb.checked);
      summary.append(cb);
    }
    details.append(summary, h("div", { class: "section-body" }, ...body));
    return details;
  }

  private slider(o: {
    path: string;
    label: string;
    tip: string;
    min: number;
    max: number;
    step: number;
    kind?: ChangeKind;
    fmt?: (v: number) => string;
    commit?: ChangeKind; // fired on release instead of while dragging
  }) {
    const val = h("span", { class: "val" });
    const input = h("input", { type: "range", min: o.min, max: o.max, step: o.step, "aria-label": o.label }) as HTMLInputElement;
    const fmt = o.fmt ?? ((v: number) => String(+v.toFixed(3)));
    const sync = () => {
      const v = Number(get(this.s, o.path));
      input.value = String(v);
      val.textContent = fmt(v);
    };
    this.valueLabels.push(sync);
    input.addEventListener("input", () => {
      set(this.s, o.path, Number(input.value));
      val.textContent = fmt(Number(input.value));
      if (o.kind) this.hooks.change(o.kind);
    });
    if (o.commit) input.addEventListener("change", () => this.hooks.change(o.commit!));
    return h("div", { class: "ctl" }, h("label", {}, o.label, helpIcon(o.tip)), val, input);
  }

  private check(path: string, label: string, tip: string, kind: ChangeKind, after?: () => void) {
    const cb = h("input", { type: "checkbox", checked: !!get(this.s, path) }) as HTMLInputElement;
    cb.addEventListener("change", () => {
      set(this.s, path, cb.checked);
      this.hooks.change(kind);
      after?.();
    });
    return h("label", { class: "ctl check" }, cb, h("span", { class: "lbl" }, label, helpIcon(tip)));
  }

  private select(path: string, label: string, tip: string, options: [string, string][], kind: ChangeKind, after?: () => void) {
    const sel = h("select", { "aria-label": label }, ...options.map(([v, t]) => h("option", { value: v, selected: String(get(this.s, path)) === v }, t))) as HTMLSelectElement;
    sel.addEventListener("change", () => {
      const cur = get(this.s, path);
      set(this.s, path, typeof cur === "number" ? Number(sel.value) : typeof cur === "boolean" ? sel.value === "true" : sel.value);
      this.hooks.change(kind);
      after?.();
    });
    return h("div", { class: "ctl" }, h("span", { class: "lbl" }, label, helpIcon(tip)), h("span"), sel);
  }

  private number(path: string, label: string, tip: string, min: number, max: number, step: number, kind: ChangeKind, after?: () => void) {
    const input = h("input", { type: "number", min, max, step, value: get(this.s, path), "aria-label": label }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const v = Math.min(max, Math.max(min, Number(input.value) || min));
      input.value = String(v);
      set(this.s, path, v);
      this.hooks.change(kind);
      after?.();
    });
    return h("div", { class: "ctl" }, h("span", { class: "lbl" }, label, helpIcon(tip)), input);
  }

  private mm = (v: number) => `${v.toFixed(2)} mm · ${Math.round(v * this.pxPerMM())} px`;
  private gray = (v: number) => `${Math.round(v * 255)} / 255`;

  // ---------------------------------------------------------------- sections
  private imageBody(): HTMLElement[] {
    const src = this.hooks.source();
    return [
      src
        ? h("div", { class: "kv" }, h("span", {}, "File"), h("b", {}, src.name), h("span", {}, "Size"), h("b", {}, `${src.w} × ${src.h} px`))
        : h("div", { class: "note" }, "No image yet."),
      h("div", { class: "row" }, h("button", { class: "btn ghost", onclick: () => this.hooks.openImage(), "data-tip": "Open a PNG, JPG or WebP (or drag one onto the window, or paste)." }, src ? "Open another…" : "Open image…")),
    ];
  }

  private cropBody(): HTMLElement[] {
    const s = this.s;
    const ring = this.hooks.ringInfo();
    const geom =
      s.crop.shape === "circle"
        ? [
            this.number("crop.circle.cx", "Center X (px)", "Horizontal position of the coin's center in the photo.", -1e5, 1e5, 1, "crop"),
            this.number("crop.circle.cy", "Center Y (px)", "Vertical position of the coin's center in the photo.", -1e5, 1e5, 1, "crop"),
            this.number("crop.circle.r", "Radius (px)", "Radius of the coin in photo pixels. Everything outside this circle is masked.", 4, 1e5, 1, "crop"),
          ]
        : [
            this.number("crop.rect.x", "Left (px)", "Left edge of the crop box in the photo.", -1e5, 1e5, 1, "crop"),
            this.number("crop.rect.y", "Top (px)", "Top edge of the crop box in the photo.", -1e5, 1e5, 1, "crop"),
            this.number("crop.rect.w", "Width (px)", "Width of the crop box in photo pixels.", 4, 1e5, 1, "crop"),
            this.number("crop.rect.h", "Height (px)", "Height of the crop box in photo pixels.", 4, 1e5, 1, "crop"),
          ];
    return [
      this.select("crop.shape", "Shape", "Circle for coins and medallions (outside gets masked). Rectangle for plaques and tiles.",
        [["circle", "Circle (coin / medallion)"], ["rect", "Rectangle"]], "crop", () => this.render()),
      s.crop.shape === "circle"
        ? h(
            "div",
            { class: "row" },
            h("button", { class: "btn ghost small", disabled: !this.hooks.source() || !this.hooks.hasBackend(), onclick: () => this.hooks.detectCoin(),
              "data-tip": "Find the coin's outline automatically (OpenCV Hough circles)." }, "Find coin"),
            h("button", { class: "btn ghost small", disabled: ring.count < 2, onclick: () => this.hooks.nextRing(),
              "data-tip": "Coins have several rings (outer edge, rim, inner field). Step through the ones that were found." },
              ring.count ? `Next ring (${ring.index + 1}/${ring.count})` : "Next ring"),
          )
        : h("span"),
      h("div", { class: "row" }, h("button", { class: "btn ghost small", disabled: !this.hooks.source(), onclick: () => this.hooks.toggleCropEditor(),
        "data-tip": "Show the whole photo: drag inside the shape to move it, drag its edge (or corners) to resize." }, "Edit crop on photo")),
      ...geom,
      this.check("crop.hideOutsideFromModel", "Hide outside from the model", "Paint the area outside the circle black before the depth model sees it. Can help when the background is busy.", "model"),
      this.check("mask.enabled", "Mask outside the circle", "Force everything outside the circle to the Outside level below.", "post"),
      this.slider({ path: "mask.outside", label: "Outside level", min: 0, max: 1, step: 1 / 255, kind: "post", fmt: this.gray,
        tip: "Gray level for everything outside the circle. 0 (black) is engraved deepest, which cuts the background away so the coin stands up. 255 (white) leaves it untouched." }),
      this.slider({ path: "mask.softMM", label: "Mask edge softness", min: 0, max: 2, step: 0.01, kind: "post", fmt: this.mm,
        tip: "Fade from the coin to the outside level over this distance, instead of a hard cliff." }),
    ];
  }

  private modelBody(): HTMLElement[] {
    const s = this.s;
    if (!this.hooks.hasBackend() && !this.hooks.models().length) return [h("div", { class: "note warn" }, "The Python backend isn't running, so only the in-browser model is available.")];
    const models = this.hooks.models().filter((m) => m.commercial_use || s.model.allowNonCommercial || m.id === s.model.id);
    const current = this.hooks.models().find((m) => m.id === s.model.id);
    const opts: [string, string][] = models.map((m) => [m.id, `${m.name}${m.available ? "" : " (weights missing)"}`]);
    const out: HTMLElement[] = [
      this.select("model.id", "Model", "Which AI model estimates depth. Each has different strengths; the license matters if you sell pieces.", opts, "model", () => {
        const m = this.hooks.models().find((x) => x.id === s.model.id);
        if (m) {
          s.model.resolution = m.default_resolution;
          s.model.params = Object.fromEntries(m.params.map((p) => [p.key, p.default]));
        }
        this.render();
      }),
    ];
    if (current) {
      const lic = current.commercial_use
        ? current.license.startsWith("Apache")
          ? h("span", { class: "chip good" }, `${current.license} · OK to sell`)
          : h("span", { class: "chip warn" }, `${current.license} · OK to sell, with use restrictions`)
        : h("span", { class: "chip bad" }, `${current.license} · not for pieces you sell`);
      out.push(
        h("div", { class: "row" }, h("a", { href: current.license_url, target: "_blank", rel: "noopener", "data-tip": current.license_note }, lic)),
        h("div", { class: "note" }, current.description),
      );
      if (!current.available) out.push(h("div", { class: "note bad" }, current.unavailable_reason));
      else if (!current.cached && !current.browser) out.push(h("div", { class: "note warn" }, `First run downloads ${fmtBytes(current.download_bytes)} of model weights.`));
      const res = this.slider({ path: "model.resolution", label: "Processing resolution", min: current.min_resolution, max: current.max_resolution,
        step: current.resolution_step, kind: "none", commit: "model", fmt: (v) => `${Math.round(v)} px`, tip: current.resolution_help });
      out.push(res);
      for (const p of current.params) {
        if (s.model.params[p.key] === undefined) s.model.params[p.key] = p.default;
        out.push(this.slider({ path: `model.params.${p.key}`, label: p.label, min: p.min, max: p.max, step: p.step, kind: "none", commit: "model",
          fmt: (v) => String(Math.round(v)), tip: p.help }));
      }
    }
    const run = h("button", { class: `btn${this.hooks.depthStale() ? " stale" : ""}`, disabled: !this.hooks.source() || this.hooks.busy() || (current && !current.available),
      onclick: () => this.hooks.runModel(), "data-tip": "Run the depth model on the cropped image. Needed again after changing the crop or model settings." },
      this.hooks.depthStale() ? "Generate depth" : "Re-run model");
    out.push(
      h("div", { class: "row" }, run),
      this.check("model.autoRun", "Re-run automatically", "Run the model again by itself after the crop or model settings change.", "none"),
      this.check("model.allowNonCommercial", "Show non-commercial models", "Also list models whose license forbids commercial use (CC BY-NC). Don't use those for pieces you sell.", "none", () => this.render()),
    );
    return out;
  }

  private upsampleBody(): HTMLElement[] {
    return [
      this.check("tilt.enabled", "Remove tilt", "Depth models often read a flat coin as leaning back, so one side comes out deeper than the other. This fits a flat plane to the coin's field and takes the slope out.", "post"),
      this.check("upsample.enabled", "Guided upsampling", "Enlarge the model's depth map to the output size using the photo, so edges stay crisp. Off = plain bilinear enlarging.", "post"),
      this.select("upsample.method", "Method", "How the small depth map is enlarged. Guided filter is fast and keeps edges; joint bilateral is slower and a bit softer; bilinear ignores the photo.",
        [["guided", "Guided filter (recommended)"], ["jbu", "Joint bilateral"], ["bilinear", "Plain bilinear"]], "post"),
      this.slider({ path: "upsample.radius", label: "Window", min: 1, max: 8, step: 1, kind: "post", fmt: (v) => `${v} px`,
        tip: "Neighbourhood size in the model's pixels. Larger follows the photo more broadly; smaller stays closer to the model." }),
      this.slider({ path: "upsample.edge", label: "Edge sensitivity", min: -5, max: -1, step: 0.1, kind: "post", fmt: (v) => (v <= -4 ? "high" : v >= -2 ? "low" : "medium") + ` (${v.toFixed(1)})`,
        tip: "How readily depth edges snap to edges in the photo. High copies more photo detail (and shading) into the depth; low stays smoother." }),
    ];
  }

  private detailBody(): HTMLElement[] {
    return [
      this.slider({ path: "detail.radiusMM", label: "Detail size", min: 0.02, max: 2, step: 0.01, kind: "post", fmt: this.mm,
        tip: "Size of the texture to bring back. Small values pick up hair-fine lines; large values add broader shading." }),
      this.slider({ path: "detail.strength", label: "Strength", min: -1, max: 1, step: 0.01, kind: "post", fmt: (v) => v.toFixed(2),
        tip: "How much photo texture is added as height. Bright details become raised. Negative makes dark details raised instead." }),
      this.slider({ path: "detail.limit", label: "Limit", min: 0.01, max: 0.5, step: 0.01, kind: "post", fmt: (v) => v.toFixed(2),
        tip: "Caps how far any one detail can push the surface, so specular highlights or dark specks can't become spikes or pits." }),
    ];
  }

  private flattenBody(): HTMLElement[] {
    return [
      this.slider({ path: "flatten.threshold", label: "Flatten below", min: 0, max: 1, step: 1 / 255, kind: "post", fmt: this.gray,
        tip: "Anything lower than this height counts as background and is flattened. Check the cross-section to find the field's height." }),
      this.slider({ path: "flatten.level", label: "Flat level", min: 0, max: 1, step: 1 / 255, kind: "post", fmt: this.gray,
        tip: "The height the background is set to. Lower = deeper field, so the subject stands taller." }),
      this.slider({ path: "flatten.falloffMM", label: "Edge falloff", min: 0, max: 3, step: 0.01, kind: "post", fmt: this.mm,
        tip: "Blend the subject's edge into the flat field over this distance, instead of a sharp step." }),
    ];
  }

  private rimBody(): HTMLElement[] {
    return [
      this.slider({ path: "rim.widthMM", label: "Width", min: 0.1, max: 6, step: 0.05, kind: "post", fmt: this.mm, tip: "Width of the raised ring, measured in from the edge." }),
      this.slider({ path: "rim.height", label: "Height", min: 0, max: 1, step: 1 / 255, kind: "post", fmt: this.gray, tip: "Height of the rim. 255 = the top surface (not engraved)." }),
      this.slider({ path: "rim.bevelMM", label: "Inner bevel", min: 0, max: 3, step: 0.01, kind: "post", fmt: this.mm, tip: "Slope on the inside of the rim, so it doesn't drop straight down into the field." }),
    ];
  }

  private levelsBody(): HTMLElement[] {
    const l = this.s.levels;
    queueMicrotask(() => {
      this.levelsWidget.set(this.histBefore, l.black, l.white, l.gamma);
      this.curveWidget.set(l.curve, this.histBefore, l.black, l.white, l.gamma);
    });
    return [
      h("div", { class: "lbl note" }, "Heights inside the mask, before levels. Drag the black, gray (midtone) and white handles."),
      this.levelsWidget.canvas,
      this.slider({ path: "levels.black", label: "Black point", min: 0, max: 1, step: 0.001, kind: "post", fmt: this.gray,
        tip: "This height and anything below becomes pure black: engraved with every pass." }),
      this.slider({ path: "levels.white", label: "White point", min: 0, max: 1, step: 0.001, kind: "post", fmt: this.gray,
        tip: "This height and anything above becomes pure white: the untouched top surface." }),
      this.slider({ path: "levels.gamma", label: "Gamma", min: 0.2, max: 5, step: 0.01, kind: "post", fmt: (v) => v.toFixed(2),
        tip: "Bends the middle heights. Above 1 lifts them (more material left, shallower); below 1 lowers them (deeper)." }),
      h("div", { class: "row" },
        h("button", { class: "btn ghost small", onclick: () => this.hooks.autoLevels(), "data-tip": "Set black and white points to the lowest and highest heights inside the mask (ignoring the extreme 0.1%), so the map uses the full 0-255 range." }, "Auto levels"),
        h("button", { class: "btn ghost small", onclick: () => { this.s.levels.curve = []; this.render(); this.hooks.change("post"); }, "data-tip": "Remove all curve points (straight line)." }, "Reset curve")),
      h("div", { class: "lbl note" }, "Curve: click to add a point, drag to move, double-click to delete."),
      this.curveWidget.canvas,
      this.stats,
    ];
  }

  private smoothBody(): HTMLElement[] {
    return [
      this.check("smooth.despeckle", "Despeckle", "Find single pixels (or tiny clusters) much lower or higher than their neighbours and replace them. Stops isolated pits in the metal.", "post"),
      this.slider({ path: "smooth.despeckleRadius", label: "Speck size", min: 1, max: 3, step: 1, kind: "post", fmt: (v) => `${2 * v + 1}×${2 * v + 1} px`,
        tip: "Largest speck to remove, in pixels." }),
      this.slider({ path: "smooth.despeckleThreshold", label: "Speck threshold", min: 0, max: 0.3, step: 0.005, kind: "post", fmt: (v) => `${Math.round(v * 255)} levels`,
        tip: "Only fix pixels that differ from their neighbours by more than this. 0 smooths every pixel (a plain median filter)." }),
      this.check("smooth.bilateral", "Edge-preserving smooth", "Smooth gentle slopes and noise while keeping sharp steps (like the subject's outline) crisp.", "post"),
      this.slider({ path: "smooth.bilateralMM", label: "Smooth distance", min: 0.01, max: 1, step: 0.01, kind: "post", fmt: this.mm, tip: "How far the edge-preserving smoothing reaches." }),
      this.slider({ path: "smooth.bilateralRange", label: "Keep steps over", min: 0.005, max: 0.3, step: 0.005, kind: "post", fmt: (v) => `${Math.round(v * 255)} levels`,
        tip: "Height differences larger than this count as real edges and are kept sharp." }),
      this.slider({ path: "smooth.gaussianMM", label: "Final blur", min: 0, max: 0.5, step: 0.005, kind: "post", fmt: this.mm,
        tip: "A light overall blur. Removes banding and pixel noise that would otherwise show as texture in the metal." }),
    ];
  }

  private outputBody(): HTMLElement[] {
    const s = this.s;
    const src = this.hooks.source();
    const aspect = s.crop.shape === "circle" ? 1 : s.crop.rect.h / Math.max(1, s.crop.rect.w);
    const sz = exportSize(s.output.widthMM, s.output.dpi, aspect);
    const info = h("div", { class: "kv" },
      h("span", {}, "Export size"), h("b", {}, `${sz.w} × ${sz.h} px`),
      h("span", {}, "Actual"), h("b", {}, `${sz.widthMM.toFixed(2)} × ${sz.heightMM.toFixed(2)} mm @ ${s.output.dpi} DPI`));
    const after = () => this.render();
    return [
      this.select("invert", "Relief type", "Raised: subject high (white), background deep. Sunk (intaglio): the subject is carved into the surface.",
        [["false", "Raised relief (subject high)"], ["true", "Sunk / intaglio (subject deep)"]], "post"),
      this.number("output.widthMM", "Width (mm)", "Physical width of the engraving. The file is resized so it imports at exactly this size.", 1, 1000, 0.1, "size", after),
      this.number("output.dpi", "DPI", "Pixels per inch in the exported file, written into the PNG so LightBurn imports it at the right size. Match your line interval: 1000 DPI = 0.0254 mm.", 50, 2540, 1, "size", after),
      this.select("output.bits", "Bit depth", "16-bit keeps 65,536 smooth levels (LightBurn 2.1+ reads them in 3D Sliced). 8-bit is 256 levels, for older software or EzCad if it rejects 16-bit.",
        [["16", "16-bit grayscale PNG"], ["8", "8-bit grayscale PNG"]], "post"),
      info,
      h("div", { class: "row" },
        h("button", { class: "btn", disabled: !src || this.hooks.depthStale(), onclick: () => this.hooks.exportPNG(), "data-tip": "Process at full resolution and save the depth map PNG." }, "Export PNG")),
      this.select("output.previewSize", "Preview quality", "Size of the live preview. Smaller is faster on slow computers; the export is always full resolution.",
        [["512", "Fast (512 px)"], ["768", "Medium (768 px)"], ["1024", "Sharp (1024 px)"], ["1536", "Very sharp (1536 px)"]], "size"),
    ];
  }

  private reliefBody(): HTMLElement[] {
    return [
      this.slider({ path: "relief.depthMM", label: "Relief depth", min: 0.05, max: 5, step: 0.01, kind: "post", fmt: (v) => `${v.toFixed(2)} mm`,
        tip: "Height from black to white, used for the 3D preview, the cross-section and the STL. Doesn't change the PNG." }),
      this.slider({ path: "relief.baseMM", label: "STL base thickness", min: 0, max: 10, step: 0.1, kind: "none", fmt: (v) => `${v.toFixed(1)} mm`,
        tip: "Solid material under the deepest point in the STL." }),
      this.slider({ path: "relief.stlGrid", label: "STL resolution", min: 100, max: 1200, step: 50, kind: "none", fmt: (v) => `${v} px · ~${Math.round((v * v * 4 * 50) / 1e6)} MB`,
        tip: "Grid size along the longer side. 600 is plenty for checking a relief; higher makes much bigger files." }),
      h("div", { class: "row" }, h("button", { class: "btn ghost", disabled: !this.hooks.source() || this.hooks.depthStale(), onclick: () => this.hooks.exportSTL(),
        "data-tip": "Save a watertight STL in millimetres to check the relief in a slicer, Blender or CNC software." }, "Export STL")),
    ];
  }
}
