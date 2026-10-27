// The left control panel: one collapsible section per pipeline step, in pipeline order.

import type { Coin, ModelInfo } from "../api";
import type { FontChoice } from "../fonts";
import { exportSize } from "../proc/export";
import { percentile } from "../proc/levels";
import { type Settings, type TextLayer, type Tone, flatTone } from "../proc/settings";
import { fmtBytes, h, helpIcon } from "./dom";
import { CurveWidget, LevelsWidget } from "./widgets";

/** What a change invalidates: the model's depth, the crop/guide, the output size, where the subject sits, or just post-processing. */
export type ChangeKind = "post" | "model" | "crop" | "size" | "subject" | "text" | "none";

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
  coins(): { list: Coin[]; folder: string; current: string | null };
  pickCoin(c: Coin): void;
  addCoin(): void;
  subject(): { name: string; editing: boolean } | null;
  toggleSubjectEditor(): void;
  removeSubject(): void;
  fonts(): FontChoice[];
  addFont(): void;
  listFonts(): void;
  addText(): void;
  removeText(id: number): void;
}

const get = (o: any, path: string) => path.split(".").reduce((a, k) => a[k], o);
const set = (o: any, path: string, v: unknown) => {
  const ks = path.split(".");
  const last = ks.pop()!;
  ks.reduce((a, k) => a[k], o)[last] = v;
};

/** The layers the Levels & curve section has a tab for, and what their levels and curve act on. */
type ToneTab = "levels" | "coin" | "subject";
const TONE_LAYERS: Record<ToneTab, { label: string; path: string; note: string; black: string; white: string; gamma: string; strength: string; auto: string }> = {
  levels: {
    label: "Master",
    path: "levels",
    note: "Everything together, as the last step: which heights become black (deepest) and white (the top surface).",
    black: "This height and anything below becomes pure black: engraved with every pass.",
    white: "This height and anything above becomes pure white: the untouched top surface.",
    gamma: "Bends the middle heights. Above 1 lifts them (more material left, shallower); below 1 lowers them (deeper).",
    strength: "How deep the whole map goes, keeping the shape you set. Lower leaves the top surface where it is and makes everything shallower " +
      "(0% is no relief at all); above 100% goes deeper, and the deepest parts clip to black.",
    auto: "Set black and white points to the lowest and highest heights inside the mask (ignoring the extreme 0.1%), so the map uses the full 0-255 range.",
  },
  coin: {
    label: "Coin",
    path: "coin.tone",
    note: "The coin on its own, from its field (left) to its top (right), before the subject and text go on. The histogram shows the coin only.",
    black: "This coin height and anything below goes down to the field height.",
    white: "This coin height and anything above goes up to the coin top.",
    gamma: "Bends the coin's middle heights. Above 1 lifts them toward the top; below 1 lowers them toward the field.",
    strength: "How tall the coin's relief stands above its field, keeping the shape you set. Lower is flatter (0% is a flat field); above 100% is taller.",
    auto: "Stretch the coin's lowest to highest heights (ignoring the extreme 0.1%) over its whole range.",
  },
  subject: {
    label: "Subject",
    path: "subject.tone",
    note: "The subject's own relief, from where it meets the coin (left) to its highest point (right). The histogram shows the subject only.",
    black: "This part of the subject's relief and anything below sits flat on the coin.",
    white: "This part of the subject's relief and anything above goes up to the subject's height.",
    gamma: "Bends the subject's middle heights. Above 1 lifts them (fuller); below 1 lowers them (flatter).",
    strength: "How tall the subject stands on the coin, keeping the shape you set. Lower is flatter (0% lies flat on the coin); above 100% stands taller than its height setting.",
    auto: "Stretch the subject's lowest to highest heights (ignoring the extreme 0.1%) over its whole range.",
  },
};
const PROFILE_TIPS = {
  black: "Where the letters' slope starts to rise: this part of it and below stays at the foot.",
  white: "Where the slope reaches the top: this part of it and above is at the letters' full height.",
  gamma: "Bends the slope. Above 1 gives rounder, fuller sides; below 1 hollower, more pointed ones.",
};
const toneChanged = (t: Tone) => t.black !== 0 || t.white !== 1 || t.gamma !== 1 || t.curve.length > 0 || t.strength !== 1;

interface ToneEditor {
  levels: LevelsWidget;
  curve: CurveWidget;
  hist: () => Uint32Array | null;
  tone: () => Tone;
}

export class Panel {
  private open = new Set(["image"]); // open sections: the first on a fresh start, then however they're left
  private openSub = new Set<string>(); // open sub-sections (text layers, letter profiles)
  private tones = new Map<string, ToneEditor>(); // levels & curve widgets, kept across re-renders
  private toneTab: ToneTab = "levels"; // the layer the Levels & curve section shows
  private toneTabs: [ToneTab, HTMLElement][] = [];
  private layerHists: { coin: Uint32Array | null; subject: Uint32Array | null } = { coin: null, subject: null };
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

  /** Fold every section shut (and the text layers inside), as for a project that was just opened. */
  collapseAll() {
    this.open.clear();
    this.openSub.clear();
  }

  render() {
    const scroll = this.root.scrollTop;
    this.valueLabels = [];
    this.root.replaceChildren(
      this.section("image", "1", "Image", null, this.imageBody()),
      this.section("coin", "2", "Coin", null, this.coinBody(),
        "Blank coins to place a cut-out subject on. Every image in the coins folder shows up here."),
      this.section("subject", "3", "Subject", null, this.subjectBody(),
        "A cut-out image (transparent background) placed on the coin. It gets its own depth, so you can move and resize it freely."),
      this.section("text", "4", "Text", null, this.textBody(),
        "Lettering on the coin: straight or around the edge, raised or sunk, with an outline or a background plate."),
      this.section("crop", "5", "Crop & mask", null, this.cropBody()),
      this.section("model", "6", "Depth model", null, this.modelBody()),
      this.section("upsample", "7", "Level & upsample", null, this.upsampleBody()),
      this.section("detail", "8", "Detail boost", "detail.enabled", this.detailBody(),
        "Add fine texture (fur, hair, engraving lines) from the photo that depth models smooth away."),
      this.section("flatten", "9", "Background flatten", "flatten.enabled", this.flattenBody(),
        "Make the coin's field (the flat area behind the subject) one perfectly flat level."),
      this.section("rim", "10", "Rim", "rim.enabled", this.rimBody(),
        "Add a raised ring around the edge, like a real coin (a raised frame for rectangles)."),
      this.section("levels", "11", "Levels & curve", "levels.enabled", this.levelsBody(),
        "Shape the heights. Master works on everything together, as the last step; Coin and Subject work on each layer on its own, before they're combined. Untick to see the map without any of them."),
      this.section("smooth", "12", "Smoothing", null, this.smoothBody()),
      this.section("output", "13", "Output & export", null, this.outputBody()),
      this.section("relief", "14", "3D preview & STL", null, this.reliefBody()),
    );
    this.root.scrollTop = scroll;
    this.refreshValues();
  }

  /** Update histogram/levels widgets and stats after a pipeline run. */
  showResult(histBefore: Uint32Array, distinct8: number, distinct16: number, min8: number, max8: number,
    layers: { coin: Uint32Array | null; subject: Uint32Array | null } = { coin: null, subject: null }) {
    this.histBefore = histBefore;
    this.layerHists = layers;
    for (const t of this.tones.values()) this.drawTone(t);
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
    after?: () => void;
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
      o.after?.();
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
      h("div", { class: "row" }, h("button", { class: "btn ghost", onclick: () => this.hooks.openImage(), "data-tip": "Open a PNG, JPG or WebP (or drag one onto the window, or paste). An image with a transparent background is a cut-out: it's placed on the coin." }, src ? "Open another…" : "Open image…")),
    ];
  }

  private coinBody(): HTMLElement[] {
    const c = this.hooks.coins();
    const add = h("button", { class: "btn ghost small", disabled: this.hooks.busy(), onclick: () => this.hooks.addCoin(),
      "data-tip": this.hooks.hasBackend() ? "Copy an image of a blank coin into the coins folder and use it." : "Use an image of a blank coin (for this session)." },
      this.hooks.hasBackend() ? "Add coin…" : "Use a coin image…");
    if (!this.hooks.hasBackend())
      return [h("div", { class: "note" }, "The coin library needs the Python backend. You can still pick a coin image for this session."), h("div", { class: "row" }, add), ...this.coinHeights(c.current !== null)];
    const tiles = c.list.map((coin) =>
      h("button", { class: `coin-tile${coin.file === c.current ? " on" : ""}`, disabled: this.hooks.busy(), onclick: () => this.hooks.pickCoin(coin),
        "data-tip": coin.file, "aria-pressed": String(coin.file === c.current) },
        h("img", { src: coin.url, alt: "", loading: "lazy", draggable: "false" }), h("span", {}, coin.name)));
    return [
      tiles.length ? h("div", { class: "coin-grid" }, ...tiles) : h("div", { class: "note" }, "No coins yet. Add one below."),
      h("div", { class: "row" }, add),
      ...this.coinHeights(c.current !== null),
      h("div", { class: "note" }, "The coins live in ", h("code", {}, c.folder || "coins"), ". Images you copy there by hand show up after a page reload."),
    ];
  }

  /** Field and top heights, for when the background is a coin. */
  private coinHeights(active: boolean): HTMLElement[] {
    if (!active) return [];
    return [
      this.slider({ path: "coin.field", label: "Field height", min: 0, max: 1, step: 1 / 255, kind: "post", fmt: this.gray,
        tip: "Height of the coin's flat field (the background the subject stands on). Lower is engraved deeper, so the subject and rim stand out more." }),
      this.slider({ path: "coin.top", label: "Coin top", min: 0, max: 1, step: 1 / 255, kind: "post", fmt: this.gray,
        tip: "Height of the coin's highest part, usually the rim. 255 leaves it untouched (the top surface)." }),
    ];
  }

  private subjectBody(): HTMLElement[] {
    const sub = this.hooks.subject();
    if (!sub) return [h("div", { class: "note" }, "Open a PNG or WebP with a transparent background (a cut-out, like a pet portrait) and it's placed on the coin, with its own depth.")];
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const signed = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;
    return [
      h("div", { class: "kv" }, h("span", {}, "File"), h("b", {}, sub.name)),
      h("div", { class: "row" },
        h("button", { class: `btn ghost small${sub.editing ? " on" : ""}`, onclick: () => this.hooks.toggleSubjectEditor(),
          "data-tip": "Drag the subject on the image to move it; drag a corner of its box to resize it." }, sub.editing ? "Done placing" : "Place on coin"),
        h("button", { class: "btn ghost small", onclick: () => this.hooks.removeSubject(), "data-tip": "Take the subject off the coin." }, "Remove")),
      this.slider({ path: "subject.size", label: "Size", min: 0.1, max: 1.5, step: 0.005, kind: "subject", fmt: pct,
        tip: "Longest side of the subject (width or height), as a share of the coin's width." }),
      this.slider({ path: "subject.x", label: "Left / right", min: -0.6, max: 0.6, step: 0.0025, kind: "subject", fmt: signed,
        tip: "Move the subject sideways, as a share of the coin's width." }),
      this.slider({ path: "subject.y", label: "Up / down", min: -0.6, max: 0.6, step: 0.0025, kind: "subject", fmt: signed,
        tip: "Move the subject down (+) or up (-), as a share of the coin's height." }),
      h("div", { class: "row" }, h("button", { class: "btn ghost small", onclick: () => { this.s.subject.x = 0; this.s.subject.y = 0; this.refreshValues(); this.hooks.change("subject"); },
        "data-tip": "Put the middle of the subject in the middle of the coin." }, "Center")),
      this.slider({ path: "subject.top", label: "Height", min: 0, max: 1, step: 1 / 255, kind: "subject", fmt: this.gray,
        tip: "Height of the subject's highest point. It always starts from the coin's surface where it stands, so lower values make a flatter subject." }),
      this.slider({ path: "subject.edgeMM", label: "Edge softness", min: 0, max: 1, step: 0.01, kind: "subject", fmt: this.mm,
        tip: "Blend the subject's outline into the coin over this distance, instead of a sharp step." }),
    ];
  }

  // ---------------------------------------------------------------- levels & curve
  /** Levels, curve and (with a tip for it) strength for one tone. */
  private toneControls(key: string, path: string, hist: () => Uint32Array | null, kind: ChangeKind,
    tips: { black: string; white: string; gamma: string; strength?: string }, auto?: { tip: string; run?: () => void }): HTMLElement[] {
    const tone = () => get(this.s, path) as Tone;
    let t = this.tones.get(key);
    if (!t) {
      const levels = new LevelsWidget((black, white, gamma) => {
        Object.assign(tone(), { black: +black.toFixed(4), white: +white.toFixed(4), gamma });
        this.drawTone(this.tones.get(key)!); // the curve's histogram follows the levels
        this.toneEdited(kind);
      });
      const curve = new CurveWidget((pts) => {
        tone().curve = pts.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
        this.toneEdited(kind);
      });
      t = { levels, curve, hist, tone };
      this.tones.set(key, t);
    }
    t.hist = hist;
    t.tone = tone;
    const editor = t;
    queueMicrotask(() => this.drawTone(editor));
    const redraw = () => {
      this.drawTone(editor);
      this.markTabs();
    };
    const set = (v: Partial<Tone>) => {
      Object.assign(tone(), v);
      redraw();
      this.refreshValues();
      this.hooks.change(kind);
    };
    const fromHist = () => {
      const hs = hist();
      if (hs) set({ black: +percentile(hs, 0.001).toFixed(4), white: +percentile(hs, 0.999).toFixed(4) });
    };
    const gray = this.gray;
    return [
      h("div", { class: "lbl note" }, "Drag the black, gray (midtone) and white handles."),
      t.levels.canvas,
      this.slider({ path: `${path}.black`, label: "Black point", min: 0, max: 1, step: 0.001, kind, fmt: gray, tip: tips.black, after: redraw }),
      this.slider({ path: `${path}.white`, label: "White point", min: 0, max: 1, step: 0.001, kind, fmt: gray, tip: tips.white, after: redraw }),
      this.slider({ path: `${path}.gamma`, label: "Gamma", min: 0.2, max: 5, step: 0.01, kind, fmt: (v) => v.toFixed(2), tip: tips.gamma, after: redraw }),
      h("div", { class: "lbl note" }, "Curve: click to add a point, drag to move, double-click to delete."),
      t.curve.canvas,
      ...(tips.strength
        ? [this.slider({ path: `${path}.strength`, label: "Strength", min: 0, max: 1.2, step: 0.01, kind, fmt: (v) => `${Math.round(v * 100)}%`, tip: tips.strength, after: redraw })]
        : []),
      h("div", { class: "row" },
        auto ? h("button", { class: "btn ghost small", onclick: auto.run ?? fromHist, "data-tip": auto.tip }, "Auto levels") : null,
        h("button", { class: "btn ghost small", onclick: () => set({ curve: [] }), "data-tip": "Remove all curve points (straight line)." }, "Reset curve"),
        h("button", { class: "btn ghost small", onclick: () => set(flatTone()), "data-tip": `Back to no change: levels and curve${tips.strength ? ", strength 100%" : ""}.` }, "Reset all")),
    ];
  }

  private toneEdited(kind: ChangeKind) {
    this.refreshValues();
    this.markTabs();
    this.hooks.change(kind);
  }

  private drawTone(t: ToneEditor) {
    const v = t.tone();
    if (!v) return;
    t.levels.set(t.hist(), v.black, v.white, v.gamma);
    t.curve.set(v.curve, t.hist(), v.black, v.white, v.gamma);
  }

  /** A dot on each layer's tab whose levels or curve change something. */
  private markTabs() {
    for (const [k, b] of this.toneTabs) b.classList.toggle("changed", toneChanged(get(this.s, TONE_LAYERS[k].path)));
  }

  /** A text layer's letter profile: levels and curve, folded away until opened. */
  private toneEditor(key: string, path: string, title: string, tip: string, kind: ChangeKind): HTMLElement {
    const controls = this.toneControls(key, path, () => null, kind, PROFILE_TIPS);
    const details = h("details", { class: "sub", open: this.openSub.has(key) }) as HTMLDetailsElement;
    details.addEventListener("toggle", () => {
      if (details.open) this.openSub.add(key);
      else this.openSub.delete(key);
      this.drawTone(this.tones.get(key)!); // canvases have no width while closed
    });
    details.append(
      h("summary", {}, title, toneChanged(get(this.s, path)) ? h("span", { class: "chip warn" }, "on") : "", helpIcon(tip)),
      h("div", { class: "sub-body" }, ...controls),
    );
    return details;
  }

  // ---------------------------------------------------------------- text layers
  private textBody(): HTMLElement[] {
    const cards = this.s.texts.map((t, i) => this.textCard(t, i));
    return [
      ...(cards.length ? cards : [h("div", { class: "note" }, "Add lettering: a name around the top, a date along the bottom, or a straight line anywhere.")]),
      h("div", { class: "row" }, h("button", { class: "btn ghost small", onclick: () => { this.openSub.add(`text${Math.max(0, ...this.s.texts.map((t) => t.id)) + 1}`); this.hooks.addText(); },
        "data-tip": "Add a new line of text." }, "Add text")),
    ];
  }

  private textCard(t: TextLayer, i: number): HTMLElement {
    const p = `texts.${i}`;
    const key = `text${t.id}`;
    const label = h("span", { class: "text-label" }, t.text || "(empty)");
    const enabled = h("input", { type: "checkbox", class: "toggle", checked: t.enabled, "aria-label": "Show this text" }) as HTMLInputElement;
    enabled.addEventListener("click", (e) => e.stopPropagation());
    enabled.addEventListener("change", () => {
      t.enabled = enabled.checked;
      card.classList.toggle("disabled", !t.enabled);
      this.hooks.change("text");
    });
    const del = h("button", { class: "btn ghost small", "data-tip": "Delete this text.", onclick: (e: Event) => { e.preventDefault(); this.hooks.removeText(t.id); } }, "Delete");
    const card = h("details", { class: `sub text-card${t.enabled ? "" : " disabled"}`, open: this.openSub.has(key) }) as HTMLDetailsElement;
    card.addEventListener("toggle", () => (card.open ? this.openSub.add(key) : this.openSub.delete(key)));

    const input = h("input", { type: "text", class: "text-input", value: t.text, "aria-label": "Text", spellcheck: "false" }) as HTMLInputElement;
    input.addEventListener("input", () => {
      t.text = input.value;
      label.textContent = t.text || "(empty)";
      this.hooks.change("text");
    });
    const fonts = this.hooks.fonts();
    const groups = new Map<string, FontChoice[]>();
    for (const f of fonts) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
    const known = fonts.some((f) => f.family === t.font);
    const fontSel = h("select", { "aria-label": "Font" },
      ...(known ? [] : [h("option", { value: t.font, selected: true }, `${t.font} (not found)`)]),
      ...[...groups].map(([g, list]) => h("optgroup", { label: g }, ...list.map((f) => h("option", { value: f.family, selected: f.family === t.font }, f.family))))) as HTMLSelectElement;
    fontSel.addEventListener("change", () => {
      t.font = fontSel.value;
      this.hooks.change("text");
    });
    const straight = t.layout === "straight";
    const mmFmt = this.mm;
    const body: HTMLElement[] = [
      h("div", { class: "ctl" }, h("span", { class: "lbl" }, "Text", helpIcon("What it says. Capitals read best at small sizes.")), h("span"), input),
      h("div", { class: "ctl" }, h("span", { class: "lbl" }, "Font", helpIcon("Fonts from the fonts folder come first, then fonts installed on this computer. If you sell pieces, check the font's license allows it (Cinzel's does).")), h("span"), fontSel),
      h("div", { class: "row" },
        h("button", { class: "btn ghost small", onclick: () => this.hooks.listFonts(), "data-tip": "List every font installed on this computer (the browser asks for permission)." }, "All installed fonts"),
        h("button", { class: "btn ghost small", onclick: () => this.hooks.addFont(), "data-tip": "Add a TTF, OTF or WOFF font file; it's copied into the fonts folder." }, "Add font file…")),
      h("div", { class: "row checks" }, this.check(`${p}.bold`, "Bold", "Use the font's bold weight.", "text"), this.check(`${p}.italic`, "Italic", "Use the font's italic.", "text")),
      this.slider({ path: `${p}.sizeMM`, label: "Letter size", min: 0.5, max: 15, step: 0.05, kind: "text", fmt: mmFmt, tip: "Height of the capital letters." }),
      this.slider({ path: `${p}.spacing`, label: "Letter spacing", min: -0.2, max: 1.5, step: 0.01, kind: "text", fmt: (v) => `${Math.round(v * 100)}%`,
        tip: "Extra space between letters, as a share of the letter size. Coin lettering is usually spaced out." }),
      this.select(`${p}.layout`, "Layout", "Straight, or curved around the coin's centre: along the top (reading clockwise) or the bottom (upright, reading left to right).",
        [["arcTop", "Arc along the top"], ["arcBottom", "Arc along the bottom"], ["straight", "Straight"]], "text", () => this.render()),
      ...(straight
        ? [
            this.slider({ path: `${p}.x`, label: "Left / right", min: -0.6, max: 0.6, step: 0.0025, kind: "text", fmt: (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`, tip: "Move the text sideways, as a share of the coin's width." }),
            this.slider({ path: `${p}.y`, label: "Up / down", min: -0.6, max: 0.6, step: 0.0025, kind: "text", fmt: (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`, tip: "Move the text down (+) or up (-), as a share of the coin's height." }),
            this.slider({ path: `${p}.rotation`, label: "Rotation", min: -180, max: 180, step: 0.5, kind: "text", fmt: (v) => `${v}°`, tip: "Turn the text, clockwise." }),
          ]
        : [
            this.slider({ path: `${p}.radius`, label: "Radius", min: 0.1, max: 1, step: 0.0025, kind: "text", fmt: (v) => `${Math.round(v * 100)}%`, tip: "Distance from the centre to the middle of the letters, as a share of the coin's radius." }),
            this.slider({ path: `${p}.angle`, label: "Position", min: -180, max: 180, step: 0.5, kind: "text", fmt: (v) => `${v}°`, tip: "Turn the text around the coin, clockwise. 0 is centred at the top (or the bottom)." }),
          ]),
      this.slider({ path: `${p}.height`, label: "Height", min: 0, max: 1, step: 1 / 255, kind: "text", fmt: this.gray,
        tip: "Height of the letters' tops. Above the surface around them they stand up; below it they're cut in (sunk lettering)." }),
      this.slider({ path: `${p}.bevelMM`, label: "Edge slope", min: 0, max: 1.5, step: 0.01, kind: "text", fmt: mmFmt,
        tip: "Width of the letters' sloped sides. 0 is a straight wall; wider gives softer, rounder letters." }),
      this.toneEditor(`${key}tone`, `${p}.tone`, "Letter profile (levels & curve)",
        "Shape of the letters' sloped sides, from their foot (left) to their top (right): bend the curve for rounded, pointed or stepped letters.", "text"),
      this.check(`${p}.outline.enabled`, "Outline", "A raised (or sunk) line around the letters.", "text", () => this.render()),
      ...(t.outline.enabled
        ? [
            this.slider({ path: `${p}.outline.widthMM`, label: "Outline width", min: 0.05, max: 3, step: 0.01, kind: "text", fmt: mmFmt, tip: "Width of the line around the letters." }),
            this.slider({ path: `${p}.outline.gapMM`, label: "Outline gap", min: 0, max: 3, step: 0.01, kind: "text", fmt: mmFmt, tip: "Space between the letters and the outline. 0 makes the outline hug the letters." }),
            this.slider({ path: `${p}.outline.height`, label: "Outline height", min: 0, max: 1, step: 1 / 255, kind: "text", fmt: this.gray, tip: "Height of the outline." }),
          ]
        : []),
      this.check(`${p}.plate.enabled`, "Background", "A plate behind the text: a box (or pill) for straight text, a band that follows the arc for curved text.", "text", () => this.render()),
      ...(t.plate.enabled
        ? [
            this.slider({ path: `${p}.plate.paddingMM`, label: "Padding", min: 0, max: 5, step: 0.05, kind: "text", fmt: mmFmt, tip: "Space around the text inside the plate." }),
            this.check(`${p}.plate.rounded`, "Rounded ends", "Round the plate's ends (a pill or a rounded band) instead of square corners.", "text"),
            this.slider({ path: `${p}.plate.height`, label: "Plate height", min: 0, max: 1, step: 1 / 255, kind: "text", fmt: this.gray, tip: "Height of the plate: above the coin it's raised, below it's a recess the text sits in." }),
            this.slider({ path: `${p}.plate.bevelMM`, label: "Plate edge slope", min: 0, max: 2, step: 0.01, kind: "text", fmt: mmFmt, tip: "Width of the plate's sloped edge." }),
            this.check(`${p}.plate.border.enabled`, "Plate border", "A raised rim along the plate's edge.", "text", () => this.render()),
            ...(t.plate.border.enabled
              ? [
                  this.slider({ path: `${p}.plate.border.widthMM`, label: "Border width", min: 0.05, max: 3, step: 0.01, kind: "text", fmt: mmFmt, tip: "Width of the plate's rim." }),
                  this.slider({ path: `${p}.plate.border.height`, label: "Border height", min: 0, max: 1, step: 1 / 255, kind: "text", fmt: this.gray, tip: "Height of the plate's rim." }),
                ]
              : []),
          ]
        : []),
    ];
    card.append(h("summary", {}, enabled, label, del), h("div", { class: "sub-body" }, ...body));
    return card;
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
      this.check("tilt.enabled", "Remove tilt", "Depth models often read a flat coin as leaning back, so one side comes out deeper than the other. This fits a flat plane to the coin's field and takes the slope out. For a coin from the coin library it also flattens any dome: the rim and pattern are measured from the coin's own base.", "post"),
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
    // A tab for each layer there is: Master always, Coin with a background coin, Subject with a subject.
    const tabs: ToneTab[] = ["levels"];
    if (this.hooks.coins().current !== null) tabs.push("coin");
    if (this.hooks.subject()) tabs.push("subject");
    const tab = tabs.includes(this.toneTab) ? this.toneTab : "levels";
    const L = TONE_LAYERS[tab];
    this.toneTabs = tabs.map((k) => [k, h("button", { class: `seg-btn${k === tab ? " on" : ""}`, role: "tab", "aria-selected": String(k === tab),
      onclick: () => { this.toneTab = k; this.render(); } }, TONE_LAYERS[k].label)]);
    this.markTabs();
    const hist = tab === "levels" ? () => this.histBefore : () => this.layerHists[tab];
    return [
      ...(tabs.length > 1 ? [h("div", { class: "seg", role: "tablist", "aria-label": "Layer" }, ...this.toneTabs.map(([, b]) => b))] : []),
      h("div", { class: "note" }, L.note),
      ...this.toneControls(tab, L.path, hist, "post", L, { tip: L.auto, run: tab === "levels" ? () => this.hooks.autoLevels() : undefined }),
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
