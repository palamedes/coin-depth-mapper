import "./styles.css";
import * as api from "./api";
import type { Depth, ModelInfo, SystemInfo } from "./api";
import { exportSize } from "./proc/export";
import { makeImg, sample } from "./proc/image";
import { autoLevels } from "./proc/levels";
import { type Settings, type TextLayer, defaultSettings, defaultTextLayer, flatTone, mergeSettings, presetPart } from "./proc/settings";
import { addFontFile, addProjectFont, fontAvailable, fontChoices, initFonts, libraryFontUrl, listAllInstalled } from "./fonts";
import { type ProjectData, isProjectFile, readProject, writeProject } from "./project";
import { fontReady, loadFonts, renderTextMasks, textGeometryKey } from "./textRender";
import { type PixelMap, type Placement, type SubjectMeta, hasTransparency, placeSubject, subjectLevels, subjectMeta } from "./proc/subject";
import { $, download, fmtBytes, h, installTooltips } from "./ui/dom";
import { type ChangeKind, Panel } from "./ui/panel";
import { ProjectsDialog, projectFile, projectTile } from "./ui/projects";
import { SlicesView } from "./ui/slicesView";
import { CompareViewer } from "./ui/viewer";
import type { View3D } from "./ui/view3d";
import { ProfileChart } from "./ui/widgets";
import type { WorkerRequest, WorkerResponse } from "./worker";

const STORAGE_KEY = "rds.settings.v1";
const VERSION = "0.1.0";

// ------------------------------------------------------------------------------------ state
let settings: Settings = loadSettings();
let system: SystemInfo | null = null;
let models: ModelInfo[] = [];
/** The background: a coin (from the coins folder, or any image under a subject) or a photo on its own. `blob`: the file as opened. */
let source: { bitmap: ImageBitmap; blob: Blob | null; name: string; coin: boolean; plain?: boolean } | null = null;
let depth: (Depth & { key: string }) | null = null;
/** A cut-out (transparent background) placed on the coin, with its own depth. */
let subject: { bitmap: ImageBitmap; blob: Blob; name: string; meta: SubjectMeta } | null = null;
let subjectDepth: (Depth & { key: string; base: number; peak: number }) | null = null;
let coins: api.Coin[] = [];
let coinsFolder = "";
let rings: api.CircleCandidate[] = [];
let ringIndex = 0;
let busy = false; // model running or exporting
let cropEditing = false;
let subjectEditing = false;
let view: "compare" | "3d" | "slices" = "compare";
let latest: Extract<WorkerResponse, { type: "result" }> | null = null;
let working = { w: 0, h: 0, pxPerMM: 1, key: "" };
let photoCanvas: HTMLCanvasElement | null = null; // the crop of the background
let viewCanvas: HTMLCanvasElement | null = null; // the same with the subject on it (left pane)
let view3d: Promise<View3D | null> | null = null; // loaded on first use; resolves null if it can't start
let autoLevelsDone = 0;
/** The project being worked on: its file in the projects folder (null when it isn't saved there). */
let project: { file: string | null; name: string } | null = null;
let dirty = false; // changed since it was opened or saved

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return mergeSettings(defaultSettings(), JSON.parse(raw));
  } catch {
    /* private mode or corrupt: use defaults */
  }
  return defaultSettings();
}

let saveTimer = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage full or blocked: settings just won't be remembered */
    }
  }, 300);
}

// ------------------------------------------------------------------------------------ status bar
function setStatus(text: string, opts: { progress?: number | "busy"; error?: boolean } = {}) {
  $("status-text").textContent = text;
  $("status").classList.toggle("error", !!opts.error);
  const bar = $("progress");
  bar.hidden = opts.progress === undefined;
  bar.classList.toggle("indeterminate", opts.progress === "busy");
  if (typeof opts.progress === "number") $("progress-bar").style.width = `${Math.round(opts.progress * 100)}%`;
  else $("progress-bar").style.width = "";
}

// ------------------------------------------------------------------------------------ UI parts
installTooltips();
const viewer = new CompareViewer($("pane-left"), $("pane-right"), {
  onCropChange(c, final) {
    settings.crop.shape = c.shape;
    settings.crop.circle = roundGeom(c.circle);
    settings.crop.rect = roundGeom(c.rect);
    if (final) change("crop");
    else panel.refreshValues();
  },
  onProfile: () => updateProfile(),
  onSubjectChange(b) {
    const { w, h } = working;
    const s = settings.subject;
    s.x = Math.round(((b.cx - w / 2) / w) * 1e4) / 1e4;
    s.y = Math.round(((b.cy - h / 2) / h) * 1e4) / 1e4;
    s.size = Math.round((Math.max(b.w, b.h) / w) * 1e4) / 1e4;
    panel.refreshValues();
    change("subject");
  },
});
const profile = new ProfileChart($("profile"));
const slices = new SlicesView($("view-slices"), (n) => {
  settings.slices.passes = n;
  change("post");
});

const panel = new Panel($("panel"), {
  settings: () => settings,
  change,
  models: () => models,
  source: () => (source ? { name: source.name, w: source.bitmap.width, h: source.bitmap.height } : null),
  ringInfo: () => ({ index: ringIndex, count: rings.length }),
  hasBackend: () => !!system,
  depthStale: () => coinStale() || subjectStale(),
  coins: () => ({ list: coins, folder: coinsFolder, current: source?.coin ? source.name : null }),
  pickCoin: (c) => pickCoin(c),
  addCoin: () => ($("coin-input") as HTMLInputElement).click(),
  subject: () => (subject ? { name: subject.name, editing: subjectEditing } : null),
  toggleSubjectEditor: () => setSubjectEditing(!subjectEditing),
  removeSubject: () => removeSubject(),
  fonts: () => fontChoices(),
  addFont: () => ($("font-input") as HTMLInputElement).click(),
  listFonts: async () => {
    try {
      const n = await listAllInstalled();
      setStatus(`${n} fonts available.`);
      panel.render();
    } catch (err) {
      setStatus((err as Error).message, { error: true });
    }
  },
  addText: () => {
    const id = Math.max(0, ...settings.texts.map((t) => t.id)) + 1;
    const t = defaultTextLayer(id);
    if (subject) t.text = subject.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").toUpperCase();
    if (settings.texts.some((x) => x.layout === "arcTop")) t.layout = "arcBottom";
    settings.texts.push(t);
    panel.render();
    change("text");
  },
  removeText: (id) => {
    settings.texts = settings.texts.filter((t) => t.id !== id);
    panel.render();
    change("text");
  },
  busy: () => busy,
  openImage: () => ($("file-input") as HTMLInputElement).click(),
  detectCoin: () => detectCoin(),
  nextRing: () => {
    if (!rings.length) return;
    ringIndex = (ringIndex + 1) % rings.length;
    applyRing();
  },
  toggleCropEditor: () => setCropEditing(!cropEditing),
  runModel: () => runModel(),
  autoLevels: () => {
    if (!latest) return;
    // Auto levels works on the image *before* levels, inside the mask.
    autoLevelsFromPreview();
  },
  exportPNG: () => runExport("png"),
  exportSTL: () => runExport("stl"),
});

function roundGeom<T extends object>(g: T): T {
  return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Math.round((v as number) * 10) / 10])) as T;
}

// ------------------------------------------------------------------------------------ change handling
let autoRunTimer = 0;
function change(kind: ChangeKind) {
  saveSettings();
  setDirty(true);
  if (kind === "none") return;
  if (kind === "crop" || kind === "size") {
    updateWorkingSize();
    if (cropEditing && source) viewer.updateCrop(settings.crop);
  }
  if (kind === "crop" || kind === "model") {
    panel.render();
    if (settings.model.autoRun && source && !busy && currentModel()?.available) {
      clearTimeout(autoRunTimer);
      autoRunTimer = window.setTimeout(() => runModel(), 350);
    }
  }
  if (kind === "size") panel.render();
  if (kind === "subject") {
    refreshSubject();
    if (subjectEditing) viewer.updateSubjectBox(subjectBox());
  }
  if (kind === "text") {
    loadFonts(settings.texts).then(requestProcess);
    return;
  }
  requestProcess();
}

function currentModel(): ModelInfo | undefined {
  return models.find((m) => m.id === settings.model.id);
}

/** Everything the model's output for the background depends on. */
function depthKey(): string {
  const c = settings.crop;
  return JSON.stringify([source?.name, c.shape, c.shape === "circle" ? c.circle : c.rect, c.hideOutsideFromModel, settings.model.id, settings.model.resolution, settings.model.params]);
}

/** Everything the model's output for the subject depends on (not where it sits). */
function subjectKey(): string {
  return JSON.stringify([subject?.name, subject?.bitmap.width, settings.model.id, settings.model.resolution, settings.model.params]);
}

const coinStale = () => !depth || depth.key !== depthKey();
const subjectStale = () => !!subject && (!subjectDepth || subjectDepth.key !== subjectKey());

function cropRegion(): { x: number; y: number; w: number; h: number } {
  const c = settings.crop;
  if (c.shape === "circle") return { x: c.circle.cx - c.circle.r, y: c.circle.cy - c.circle.r, w: 2 * c.circle.r, h: 2 * c.circle.r };
  return { ...c.rect };
}

function aspect(): number {
  const r = cropRegion();
  return r.h / Math.max(1, r.w);
}

/** Draw the crop of the source photo at w x h (black outside the photo). */
function renderCrop(w: number, h: number, hideOutside = false): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  if (!source) return c;
  const r = cropRegion();
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  if (hideOutside && settings.crop.shape === "circle") {
    g.save();
    g.beginPath();
    g.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
    g.clip();
  }
  g.drawImage(source.bitmap, r.x, r.y, r.w, r.h, 0, 0, w, h);
  if (hideOutside && settings.crop.shape === "circle") g.restore();
  return c;
}

// ------------------------------------------------------------------------------------ preview worker
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let inflight = false;
let pending = false;
let reqId = 0;

function post(w: Worker, msg: WorkerRequest, transfer: Transferable[] = []) {
  w.postMessage(msg, transfer);
}

/** Recompute the preview size and, if it changed, the guide image the worker uses. */
function updateWorkingSize() {
  if (!source) return;
  const ex = exportSize(settings.output.widthMM, settings.output.dpi, aspect());
  const scale = Math.min(1, settings.output.previewSize / Math.max(ex.w, ex.h));
  const w = Math.max(16, Math.round(ex.w * scale));
  const h = Math.max(16, Math.round(ex.h * scale));
  const key = JSON.stringify([cropRegion(), w, h, source.name, source.bitmap.width]);
  working = { w, h, pxPerMM: (ex.pxPerMM * w) / ex.w, key: working.key };
  if (key === working.key) return;
  working.key = key;
  photoCanvas = renderCrop(w, h);
  const rgba = photoCanvas.getContext("2d")!.getImageData(0, 0, w, h).data;
  post(worker, { type: "guide", w, h, rgba }, [rgba.buffer]);
  refreshSubject();
  loadFonts(settings.texts).then(requestProcess);
}

// ------------------------------------------------------------------------------------ text
/** What the preview worker's text masks were drawn from: the output size, and each layer's shape by id. */
let textSize = "";
let textSent = new Map<number, string>();

const liveTexts = () => settings.texts.filter((t) => t.enabled && t.text.trim());

/** Draw text layers for a w x h output and send them to a worker (the worker drops layers not in `keep`). */
function postTexts(wk: Worker, w: number, h: number, pxPerMM: number, layers: TextLayer[], keep: number[]) {
  const masks = layers.map((t) => renderTextMasks(t, w, h, pxPerMM));
  const transfer = masks.flatMap((l) => (l.plate ? [l.glyph.buffer, l.plate.buffer] : [l.glyph.buffer]));
  post(wk, { type: "texts", w, h, layers: masks, keep }, transfer);
}

/**
 * Just before a preview run, redraw the text layers that were added, moved or reshaped since the
 * last run. Doing it here (not on every slider move) keeps the worker from falling behind while
 * dragging. A layer drawn while its font was still loading is drawn again once it has loaded.
 */
function syncTexts() {
  const size = `${working.w}x${working.h}@${working.pxPerMM}`;
  if (size !== textSize) {
    textSize = size;
    textSent = new Map();
  }
  const live = liveTexts();
  const shapes = new Map(live.map((t) => [t.id, textGeometryKey(t) + (fontReady(t) ? "" : "/loading")]));
  const changed = live.filter((t) => textSent.get(t.id) !== shapes.get(t.id));
  const dropped = [...textSent.keys()].some((id) => !shapes.has(id));
  textSent = shapes;
  if (changed.length || dropped) postTexts(worker, working.w, working.h, working.pxPerMM, changed, live.map((t) => t.id));
}

// ------------------------------------------------------------------------------------ subject
function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** The subject drawn where it sits on a w x h output, transparent around it. */
function renderSubjectLayer(w: number, h: number): { layer: HTMLCanvasElement; placement: Placement } {
  const placement = placeSubject(subject!.meta, settings.subject, w, h);
  const layer = canvas(w, h);
  const g = layer.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingQuality = "high";
  const d = placement.draw;
  g.drawImage(subject!.bitmap, d.x, d.y, d.w, d.h);
  return { layer, placement };
}

/** Output pixel -> subject depth pixel, for the depth the model returned. */
function toDepth(p: Placement): PixelMap {
  const ds = subjectDepth!.w / subject!.meta.region.w;
  return { k: p.toRegion.k * ds, ox: p.toRegion.ox * ds, oy: p.toRegion.oy * ds };
}

/** Send the subject to a worker for a w x h output: its depth (when asked) and where it sits. */
function postSubject(wk: Worker, w: number, h: number, withDepth: boolean): HTMLCanvasElement | null {
  if (withDepth) {
    const d = subject && subjectDepth;
    post(wk, { type: "subjectDepth", depth: d ? { w: d.w, h: d.h, data: d.data.slice(), base: d.base, peak: d.peak } : null });
  }
  if (!subject) return null;
  const { layer, placement } = renderSubjectLayer(w, h);
  if (subjectDepth) {
    const rgba = layer.getContext("2d")!.getImageData(0, 0, w, h).data;
    post(wk, { type: "subjectLayer", w, h, rgba, toDepth: toDepth(placement) }, [rgba.buffer]);
  }
  return layer;
}

/** The subject drawn where it sits on the preview, kept until it moves or the preview size changes. */
let subjectView: { key: string; bitmap: ImageBitmap; layer: HTMLCanvasElement; placement: Placement } | null = null;
/** The subject layer the preview worker has ("" = it needs sending). */
let subjectSent = "";

function previewSubjectLayer() {
  const s = settings.subject;
  const key = JSON.stringify([working.w, working.h, s.size, s.x, s.y]);
  if (subjectView?.key !== key || subjectView.bitmap !== subject!.bitmap)
    subjectView = { key, bitmap: subject!.bitmap, ...renderSubjectLayer(working.w, working.h) };
  return subjectView;
}

/**
 * Re-place the subject on the photo pane (after it moved, or the preview size changed); the worker
 * gets the new placement just before its next run (see syncSubject). `withDepth`: send the
 * worker the subject's depth now (or tell it the subject is gone).
 */
function refreshSubject(withDepth = false) {
  if (!photoCanvas) return;
  if (withDepth) {
    const d = subject && subjectDepth;
    post(worker, { type: "subjectDepth", depth: d ? { w: d.w, h: d.h, data: d.data.slice(), base: d.base, peak: d.peak } : null });
    subjectSent = "";
  }
  if (subject) {
    viewCanvas = canvas(working.w, working.h);
    const g = viewCanvas.getContext("2d")!;
    g.drawImage(photoCanvas, 0, 0);
    g.drawImage(previewSubjectLayer().layer, 0, 0);
  } else viewCanvas = photoCanvas;
  viewer.setPhoto(viewCanvas);
}

/** Just before a preview run, send the worker the subject where it now sits (once per run, however fast it's dragged). */
function syncSubject() {
  if (!subject || !subjectDepth) return;
  const v = previewSubjectLayer();
  const key = `${v.key}/${subjectDepth.w}`;
  if (key === subjectSent) return;
  subjectSent = key;
  const rgba = v.layer.getContext("2d")!.getImageData(0, 0, working.w, working.h).data;
  post(worker, { type: "subjectLayer", w: working.w, h: working.h, rgba, toDepth: toDepth(v.placement) }, [rgba.buffer]);
}

/** The subject's visible box in preview pixels, for dragging it around. */
function subjectBox() {
  const { w, h } = working;
  const p = placeSubject(subject!.meta, settings.subject, w, h);
  const k = p.toRegion.k;
  return { cx: w / 2 + settings.subject.x * w, cy: h / 2 + settings.subject.y * h, w: subject!.meta.box.w / k, h: subject!.meta.box.h / k };
}

function setSubjectEditing(on: boolean) {
  subjectEditing = on && !!subject;
  if (subjectEditing) {
    setCropEditing(false);
    if ($("btn-profile").classList.contains("on")) $("btn-profile").click();
  }
  $("btn-place").classList.toggle("on", subjectEditing);
  $("label-left").textContent = subjectEditing ? "Drag the subject to move it, drag a corner to resize" : "Photo";
  viewer.setSubjectMode(subjectEditing, subjectEditing ? subjectBox() : undefined);
  panel.render();
}

function removeSubject() {
  if (!subject) return;
  setSubjectEditing(false);
  subject.bitmap.close();
  subject = null;
  subjectDepth = null;
  setDirty(true);
  $("btn-place").hidden = true;
  refreshSubject(true);
  setStatus("Removed the subject.");
  panel.render();
  requestProcess();
}

function requestProcess() {
  if (!depth || !source) return;
  if (inflight) {
    pending = true;
    return;
  }
  inflight = true;
  pending = false;
  syncTexts();
  syncSubject();
  post(worker, { type: "process", id: ++reqId, settings: structuredClone(settings), pxPerMM: working.pxPerMM });
  $("pane-right").dataset.busy = "1";
}

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  inflight = false;
  if (msg.type === "result") {
    latest = msg;
    showResult(msg);
  } else if (msg.type === "error") setStatus(`Processing failed: ${msg.message}`, { error: true });
  if (pending) requestProcess();
};

function showResult(r: Extract<WorkerResponse, { type: "result" }>) {
  viewer.setContent(viewCanvas, depthImage(r), r.w, r.h);
  panel.showResult(r.histBefore, r.distinct8, r.distinct16, r.min8, r.max8, { coin: r.histCoin, subject: r.histSubject });
  updateProfile();
  if (view === "slices") updateSlices();
  if (view === "3d") update3D();
}

function autoLevelsFromPreview() {
  // Ask the worker for a run with the final levels flat (the layers' own still on), then take percentiles of that.
  const s = structuredClone(settings);
  s.levels = { ...flatTone(), enabled: true };
  s.smooth = { ...s.smooth, despeckle: false, bilateral: false, gaussianMM: 0 };
  s.invert = false;
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  primeWorker(w, photoCanvas!, working.pxPerMM);
  post(w, { type: "process", id: 0, settings: s, pxPerMM: working.pxPerMM });
  w.onmessage = (e: MessageEvent<WorkerResponse>) => {
    w.terminate();
    if (e.data.type !== "result") return;
    const before = makeImg(e.data.w, e.data.h, e.data.out);
    let weight: Float32Array | undefined;
    if (settings.crop.shape === "circle" && settings.mask.enabled) {
      weight = new Float32Array(before.data.length);
      const r = Math.min(before.w, before.h) / 2 - 1;
      for (let y = 0; y < before.h; y++)
        for (let x = 0; x < before.w; x++) weight[y * before.w + x] = Math.hypot(x + 0.5 - before.w / 2, y + 0.5 - before.h / 2) < r ? 1 : 0;
    }
    const { black, white } = autoLevels(before, weight);
    settings.levels.black = +black.toFixed(4);
    settings.levels.white = +white.toFixed(4);
    settings.levels.enabled = true;
    autoLevelsDone++;
    panel.render();
    change("post");
  };
}

/** Give a fresh worker everything it needs to process at the size of `guide` (the background crop). */
function primeWorker(wk: Worker, guide: HTMLCanvasElement, pxPerMM: number) {
  const { width: w, height: h } = guide;
  const texts = liveTexts();
  postTexts(wk, w, h, pxPerMM, texts, texts.map((t) => t.id));
  post(wk, { type: "depth", w: depth!.w, h: depth!.h, data: depth!.data.slice(), coin: source!.coin });
  const rgba = guide.getContext("2d")!.getImageData(0, 0, w, h).data;
  post(wk, { type: "guide", w, h, rgba }, [rgba.buffer]);
  postSubject(wk, w, h, true);
}

// ------------------------------------------------------------------------------------ loading images
async function openFile(file: File | Blob, name = (file as File).name || "pasted-image") {
  if (await isProjectFile(file, name)) {
    if (confirmDiscard(name)) await openProject(file, null);
    return;
  }
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(name)) {
    setStatus("Please use a PNG, JPG or WebP image, or a project file.", { error: true });
    return;
  }
  setStatus(`Opening ${name}…`, { progress: "busy" });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    setStatus(`Couldn't read ${name}. Is it a valid PNG, JPG or WebP?`, { error: true });
    return;
  }
  if (isCutout(bitmap)) return openSubject(bitmap, file, name);
  // With a subject on the coin, any other image becomes its new background.
  const coin = !!subject;
  await setBackground(bitmap, file, name, coin);
  if (coin) setStatus(`${name} is now the coin behind ${subject!.name}.`);
  maybeRunModel();
}

/** A see-through image is a cut-out to place on a coin. */
function isCutout(b: ImageBitmap): boolean {
  const s = Math.min(1, 256 / Math.max(b.width, b.height));
  const c = canvas(Math.max(1, Math.round(b.width * s)), Math.max(1, Math.round(b.height * s)));
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(b, 0, 0, c.width, c.height);
  return hasTransparency(g.getImageData(0, 0, c.width, c.height).data);
}

/** Where a cut-out's visible part is, or null when it's completely transparent. */
function measureSubject(bitmap: ImageBitmap): SubjectMeta | null {
  const s = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const c = canvas(Math.max(1, Math.round(bitmap.width * s)), Math.max(1, Math.round(bitmap.height * s)));
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bitmap, 0, 0, c.width, c.height);
  return subjectMeta(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, bitmap.width, bitmap.height);
}

async function openSubject(bitmap: ImageBitmap, blob: Blob, name: string) {
  const meta = measureSubject(bitmap);
  if (!meta) {
    setStatus(`${name} is completely transparent.`, { error: true });
    return;
  }
  subject?.bitmap.close();
  subject = { bitmap, blob, name, meta };
  setDirty(true);
  subjectDepth = null;
  const d = defaultSettings().subject;
  settings.subject = { ...settings.subject, size: d.size, x: d.x, y: d.y };
  post(worker, { type: "subjectDepth", depth: null });
  $("btn-place").hidden = false;
  if (!source || !source.coin) await useDefaultCoin();
  else refreshSubject();
  if (subjectEditing) viewer.updateSubjectBox(subjectBox());
  panel.render();
  setStatus(`${name} has a transparent background, so it's placed on the coin (${source!.plain ? "a plain disc" : source!.name}). Use Place subject to move or resize it.`);
  maybeRunModel();
}

/** The first coin in the coins folder, or a plain flat disc when there is none. */
async function useDefaultCoin() {
  if (system) {
    await refreshCoins();
    if (coins.length && (await loadCoin(coins[0]))) return;
  }
  await setBackground(await plainDisc(), null, "plain", true, true);
}

/** A flat mid-gray square: a coin with no detail. */
function plainDisc(): Promise<ImageBitmap> {
  const c = canvas(1024, 1024);
  const g = c.getContext("2d")!;
  g.fillStyle = "#808080";
  g.fillRect(0, 0, c.width, c.height);
  return createImageBitmap(c);
}

async function refreshCoins() {
  try {
    const r = await api.getCoins();
    coins = r.coins;
    coinsFolder = r.folder;
  } catch {
    coins = [];
  }
}

async function loadCoin(c: api.Coin): Promise<boolean> {
  setStatus(`Opening coin ${c.name}…`, { progress: "busy" });
  try {
    const blob = await (await fetch(c.url)).blob();
    await setBackground(await createImageBitmap(blob, { imageOrientation: "from-image" }), blob, c.file, true);
    return true;
  } catch {
    setStatus(`Couldn't open coin ${c.name}.`, { error: true });
    return false;
  }
}

async function pickCoin(c: api.Coin) {
  if (busy || !(await loadCoin(c))) return;
  setStatus(subject ? `${subject.name} on ${c.name}.` : `Coin ${c.name}. Open a cut-out image (transparent background) to place on it.`);
  maybeRunModel();
}

async function addCoin(file: File) {
  if (!system) {
    // No backend to keep it: use it for this session only.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
    if (!bitmap) return setStatus(`Couldn't read ${file.name}.`, { error: true });
    await setBackground(bitmap, file, file.name, true);
    return maybeRunModel();
  }
  try {
    const c = await api.addToLibrary("coins", file, file.name);
    await refreshCoins();
    setStatus(`Added ${c.name} to the coins folder.`);
    await pickCoin(c);
  } catch (err) {
    setStatus(`Couldn't add the coin: ${(err as Error).message}`, { error: true });
  }
}

/** Run the model now if that's set to happen by itself, otherwise say what's needed. */
function maybeRunModel() {
  const m = currentModel();
  panel.render();
  if (m && m.available && (m.cached || m.browser) && settings.model.autoRun) runModel();
  else if (m && !m.cached && !m.browser) setStatus(`Ready. Click Generate depth (first run downloads ${fmtBytes(m.download_bytes)}).`);
}

/** Make this image the background. `plain`: a flat disc with no detail, so no model run. */
async function setBackground(bitmap: ImageBitmap, blob: Blob | null, name: string, coin: boolean, plain = false) {
  if (source && source.bitmap !== bitmap) source.bitmap.close();
  source = { bitmap, blob, name, coin, plain };
  setDirty(true);
  depth = null;
  latest = null;
  rings = [];
  ringIndex = 0;
  $("empty").hidden = true;
  const s = Math.min(bitmap.width, bitmap.height);
  settings.crop.circle = { cx: bitmap.width / 2, cy: bitmap.height / 2, r: Math.round(s * 0.48) };
  settings.crop.rect = { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  working.key = "";
  updateWorkingSize();
  viewer.fit();
  setStatus(`${name}: ${bitmap.width} × ${bitmap.height} px`);
  panel.render();
  if (settings.crop.shape === "circle" && system && !plain) await detectCoin(false);
}

async function detectCoin(rerun = true) {
  if (!source || !system) return;
  setStatus("Looking for the coin outline…", { progress: "busy" });
  const b = source.bitmap;
  const scale = Math.min(1, 1024 / Math.max(b.width, b.height));
  const c = document.createElement("canvas");
  c.width = Math.round(b.width * scale);
  c.height = Math.round(b.height * scale);
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(b, 0, 0, c.width, c.height);
  try {
    const blob = await new Promise<Blob>((res) => c.toBlob((x) => res(x!), "image/png"));
    const r = await api.detectCircles(blob);
    const k = b.width / r.width;
    rings = r.circles.map((x) => ({ ...x, cx: x.cx * k, cy: x.cy * k, r: x.r * k }));
    ringIndex = 0;
    if (!rings.length) {
      setStatus("No circle found. Drag the circle into place with Edit crop.");
      panel.render();
      return;
    }
    setStatus(`Found the coin${rings.length > 1 ? ` and ${rings.length - 1} inner ring(s)` : ""}.`);
    applyRing(rerun);
  } catch (err) {
    setStatus(`Circle detection failed: ${(err as Error).message}`, { error: true });
  }
}

function applyRing(rerun = true) {
  const r = rings[ringIndex];
  settings.crop.circle = roundGeom({ cx: r.cx, cy: r.cy, r: r.r });
  if (rerun) change("crop");
  else {
    updateWorkingSize();
    if (cropEditing) viewer.updateCrop(settings.crop);
    panel.render();
  }
}

function setCropEditing(on: boolean) {
  cropEditing = on && !!source;
  if (cropEditing && subjectEditing) setSubjectEditing(false);
  $("btn-edit-crop").classList.toggle("on", cropEditing);
  $("label-left").textContent = cropEditing ? "Whole photo: drag the shape or its edge" : "Photo";
  if (cropEditing && source) viewer.setCropMode(true, source.bitmap, settings.crop);
  else viewer.setCropMode(false);
}

// ------------------------------------------------------------------------------------ model
async function runModel() {
  if (!source || busy) return;
  const m = currentModel();
  if (!m) return;
  if (!m.available) {
    setStatus(m.unavailable_reason, { error: true });
    return;
  }
  // Run what's out of date; with nothing out of date (the Re-run button), run everything.
  const doCoin = coinStale() || !subjectStale();
  const doSubject = !!subject && (subjectStale() || !coinStale());
  busy = true;
  panel.render();
  const poll = window.setInterval(async () => {
    try {
      const st = await api.getStatus();
      if (st.state === "downloading") setStatus(`Downloading ${m.name}: ${fmtBytes(st.done)} of ${fmtBytes(st.total)}`, { progress: st.total ? st.done / st.total : "busy" });
      else if (st.state === "loading") setStatus(`Loading ${m.name} onto the ${system?.device.kind.toUpperCase()}…`, { progress: "busy" });
      else if (st.state === "inferring") setStatus(st.total ? `${st.message} ${st.done} / ${st.total}` : `${m.name}: estimating depth…`, { progress: st.total ? st.done / st.total : "busy" });
    } catch {
      /* status is best effort */
    }
  }, 400);
  const predict = async (c: HTMLCanvasElement): Promise<Depth> => {
    const blob = await new Promise<Blob>((res) => c.toBlob((x) => res(x!), "image/png"));
    if (!m.browser) return api.predictDepth(blob, m.id, settings.model.resolution, settings.model.params);
    const { predictInBrowser } = await import("./lite");
    const res = Math.min(m.max_resolution, Math.max(m.min_resolution, settings.model.resolution));
    return predictInBrowser(blob, res, (msg, p) => setStatus(msg, { progress: p ?? "busy" }));
  };
  const t0 = performance.now();
  try {
    if (doCoin) {
      const key = depthKey();
      let d: Depth;
      if (source.plain) d = { w: 16, h: 16, data: new Float32Array(256) }; // a flat disc: nothing to estimate
      else {
        setStatus(`${m.name}: starting…`, { progress: "busy" });
        const r = cropRegion();
        const longest = Math.min(2048, Math.max(64, Math.round(Math.max(r.w, r.h))));
        const w = Math.round(r.w >= r.h ? longest : (longest * r.w) / r.h);
        const h = Math.round(r.h >= r.w ? longest : (longest * r.h) / r.w);
        d = await predict(renderCrop(w, h, settings.crop.hideOutsideFromModel));
      }
      depth = { ...d, key };
      post(worker, { type: "depth", w: d.w, h: d.h, data: d.data.slice(), coin: source.coin });
    }
    if (doSubject && subject) {
      const sub = subject;
      const key = subjectKey();
      setStatus(`${m.name}: depth for ${sub.name}…`, { progress: "busy" });
      // The subject alone in front of flat mid-gray: the model then reads the backdrop as one
      // plane and the subject's outline eases down to it (black or white backdrops confuse it).
      const r = sub.meta.region;
      const longest = Math.min(2048, Math.max(64, Math.max(r.w, r.h)));
      const c = canvas(Math.round((r.w * longest) / Math.max(r.w, r.h)), Math.round((r.h * longest) / Math.max(r.w, r.h)));
      const g = c.getContext("2d")!;
      g.fillStyle = "#808080";
      g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingQuality = "high";
      g.drawImage(sub.bitmap, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      const d = await predict(c);
      if (subject === sub) {
        // Coverage at the depth's size, to find the backdrop level and the subject's top.
        const a = canvas(d.w, d.h);
        const ga = a.getContext("2d", { willReadFrequently: true })!;
        ga.drawImage(sub.bitmap, r.x, r.y, r.w, r.h, 0, 0, d.w, d.h);
        const px = ga.getImageData(0, 0, d.w, d.h).data;
        const alpha = new Float32Array(d.w * d.h);
        for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3] / 255;
        subjectDepth = { ...d, key, ...subjectLevels(makeImg(d.w, d.h, d.data), alpha) };
        refreshSubject(true);
      }
    }
    setStatus(`${m.name}: done in ${((performance.now() - t0) / 1000).toFixed(1)} s${depth ? ` (${depth.w} × ${depth.h} depth)` : ""}.`);
    if (!m.cached && !m.browser) models = await api.getModels().catch(() => models);
  } catch (err) {
    setStatus(`${m.name} failed: ${(err as Error).message}`, { error: true });
  } finally {
    clearInterval(poll);
    busy = false;
    panel.render();
    requestProcess();
    // The crop, subject or settings may have changed while the model ran.
    if (((depth && coinStale()) || (subjectDepth && subjectStale())) && settings.model.autoRun) setTimeout(runModel, 50);
  }
}

// ------------------------------------------------------------------------------------ export
function baseName(): string {
  const stem = (n: string) => n.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-");
  if (subject && source) return `${stem(subject.name)}_on_${source.plain ? "plain" : stem(source.name)}`;
  return stem(source?.name ?? "relief");
}

async function runExport(kind: "png" | "stl") {
  if (!source || !depth || busy) return;
  busy = true;
  panel.render();
  const ex = exportSize(settings.output.widthMM, settings.output.dpi, aspect());
  setStatus(`Building the ${ex.w} × ${ex.h} px ${kind.toUpperCase()}…`, { progress: "busy" });
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  try {
    await loadFonts(settings.texts);
    primeWorker(w, renderCrop(ex.w, ex.h), ex.pxPerMM);
    const result = await new Promise<WorkerResponse>((resolve) => {
      w.onmessage = (e) => resolve(e.data);
      post(w, {
        type: "export",
        id: 1,
        settings: structuredClone(settings),
        pxPerMM: ex.pxPerMM,
        kind,
        widthMM: ex.widthMM,
        heightMM: ex.heightMM,
        text: {
          Software: `Relief Depth Studio ${VERSION}`,
          Description: `Depth map for 3D sliced engraving. ${ex.widthMM.toFixed(2)} x ${ex.heightMM.toFixed(2)} mm at ${settings.output.dpi} DPI. White = highest.`,
          Comment: JSON.stringify(presetPart(settings)),
        },
      });
    });
    if (result.type === "error") throw new Error(result.message);
    if (result.type !== "exported") throw new Error("unexpected reply");
    const mm = +settings.output.widthMM.toFixed(2);
    if (kind === "png") {
      download(result.bytes, `${baseName()}_${mm}mm_${settings.output.dpi}dpi_${settings.output.bits}bit.png`, "image/png");
      setStatus(`Saved ${result.w} × ${result.h} px ${settings.output.bits}-bit PNG (${result.distinct8} gray levels) in ${(result.ms / 1000).toFixed(1)} s.`);
    } else {
      download(result.bytes, `${baseName()}_${mm}mm_relief.stl`, "model/stl");
      setStatus(`Saved STL (${fmtBytes(result.bytes.length)}) in ${(result.ms / 1000).toFixed(1)} s.`);
    }
  } catch (err) {
    setStatus(`Export failed: ${(err as Error).message}`, { error: true });
  } finally {
    w.terminate();
    busy = false;
    panel.render();
  }
}

// ------------------------------------------------------------------------------------ projects
const projectsDialog = new ProjectsDialog({
  hasBackend: () => !!system,
  canSave: () => !!source,
  current: () => project,
  suggestedName,
  save: saveProject,
  open: (p) => openProjectEntry(p),
  openFile: () => ($("project-input") as HTMLInputElement).click(),
  download: (name) => downloadProject(name),
  deleted: (p) => {
    if (project?.file === p.file) {
      project = { file: null, name: project.name };
      setDirty(true);
    }
    refreshRecent();
  },
});

function setDirty(on: boolean) {
  dirty = on;
  $("btn-save").classList.toggle("dirty", on && !!source);
  document.title = project ? `${project.name}${on ? " (edited)" : ""} – Relief Depth Studio` : "Relief Depth Studio";
}

/** "toby_on-swirl.webp" -> "Toby on swirl" */
function prettyName(file: string): string {
  const s = file.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function suggestedName(): string {
  if (project) return project.name;
  if (subject && source) return `${prettyName(subject.name)} on ${source.plain ? "plain" : prettyName(source.name).toLowerCase()}`;
  return prettyName(source?.name ?? "Project");
}

/** The latest preview as gray pixels. */
function depthImage(r: { w: number; h: number; out: Float32Array }): ImageData {
  const img = new ImageData(r.w, r.h);
  const px = img.data;
  for (let i = 0, j = 0; i < r.out.length; i++, j += 4) {
    const v = Math.round(r.out[i] * 255);
    px[j] = px[j + 1] = px[j + 2] = v;
    px[j + 3] = 255;
  }
  return img;
}

/** A small picture of the depth map, for the project list. */
async function previewPNG(): Promise<Blob | null> {
  if (!latest) return null;
  const full = canvas(latest.w, latest.h);
  full.getContext("2d")!.putImageData(depthImage(latest), 0, 0);
  const k = Math.min(1, 320 / Math.max(latest.w, latest.h));
  const small = canvas(Math.max(1, Math.round(latest.w * k)), Math.max(1, Math.round(latest.h * k)));
  const g = small.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(full, 0, 0, small.width, small.height);
  return new Promise((res) => small.toBlob(res, "image/png"));
}

async function buildProject(name: string): Promise<Blob> {
  // Fonts from the fonts folder travel with the project; installed fonts can't be copied.
  const fonts: ProjectData["fonts"] = [];
  for (const family of new Set(liveTexts().map((t) => t.font))) {
    const url = libraryFontUrl(family);
    if (!url) continue;
    try {
      fonts.push({ family, data: new Uint8Array(await (await fetch(url)).arrayBuffer()) });
    } catch {
      /* left out: without it the text falls back to another font */
    }
  }
  return writeProject({
    name,
    saved: new Date().toISOString(),
    appVersion: VERSION,
    settings: structuredClone(settings),
    source: { name: source!.name, coin: source!.coin, plain: !!source!.plain, image: source!.blob },
    subject: subject && { name: subject.name, image: subject.blob },
    depth,
    subjectDepth: subject ? subjectDepth : null,
    rings,
    ringIndex,
    fonts,
    preview: await previewPNG(),
  });
}

/** Save the project as `name`: over the saved project `replace`, or as a new one (a download without the backend). */
async function saveProject(name: string, replace: string | null): Promise<boolean> {
  if (!source) return false;
  if (busy) {
    setStatus("Wait for the model to finish, then save.");
    return false;
  }
  setStatus(`Saving ${name}…`, { progress: "busy" });
  try {
    const blob = await buildProject(name);
    if (system) {
      const entry = await api.saveProject(blob, projectFile(name), replace ?? undefined);
      project = { file: entry.file, name: entry.name };
      setStatus(`Saved the project ${entry.name} (${fmtBytes(blob.size)}).`);
    } else {
      download(blob, projectFile(name));
      project = { file: null, name };
      setStatus(`Saved the project as ${projectFile(name)} in your downloads.`);
    }
    setDirty(false);
    refreshRecent();
    return true;
  } catch (err) {
    setStatus(`Couldn't save the project: ${(err as Error).message}`, { error: true });
    return false;
  }
}

async function downloadProject(name: string) {
  if (!source) return;
  try {
    download(await buildProject(name), projectFile(name));
  } catch (err) {
    setStatus(`Couldn't build the project file: ${(err as Error).message}`, { error: true });
  }
}

/** Ctrl+S: save over the project being worked on, or ask for a name the first time. */
function quickSave() {
  if (!source) return setStatus("Open an image first; then you can save it as a project.");
  if (system && project?.file) saveProject(project.name, project.file);
  else projectsDialog.show();
}

function confirmDiscard(next: string, same = false): boolean {
  if (!source || !dirty) return true;
  if (same) return confirm(`Your changes to “${next}” aren't saved. Go back to the saved version?`);
  const what = project ? `Your changes to “${project.name}” aren't saved.` : "This work isn't saved as a project.";
  return confirm(`${what} Open “${next}” anyway?`);
}

async function openProjectEntry(p: api.Project) {
  if (!confirmDiscard(p.name, p.file === project?.file)) return;
  setStatus(`Opening ${p.name}…`, { progress: "busy" });
  try {
    const res = await fetch(p.url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    await openProject(await res.blob(), { file: p.file, name: p.name });
  } catch (err) {
    setStatus(`Couldn't open ${p.name}: ${(err as Error).message}`, { error: true });
  }
}

/**
 * Open a project file. Everything comes back as it was saved, including the depth maps, so the
 * model only runs again if they're missing. `entry`: its place in the projects folder, if any.
 */
async function openProject(file: Blob, entry: { file: string; name: string } | null) {
  if (busy) return setStatus("Wait for the model to finish, then open the project.");
  setStatus("Opening the project…", { progress: "busy" });
  let p: ProjectData;
  let bg: ImageBitmap;
  let sub: { bitmap: ImageBitmap; meta: SubjectMeta } | null = null;
  try {
    p = await readProject(file);
    bg = p.source.image ? await createImageBitmap(p.source.image, { imageOrientation: "from-image" }) : await plainDisc();
    if (p.subject) {
      const bitmap = await createImageBitmap(p.subject.image, { imageOrientation: "from-image" });
      const meta = measureSubject(bitmap);
      if (meta) sub = { bitmap, meta };
    }
  } catch (err) {
    setStatus(`Couldn't open the project: ${(err as Error).message}.`, { error: true });
    return;
  }
  // Fonts it brought along, unless this computer has them already.
  for (const f of p.fonts) if (!fontAvailable(f.family)) await addProjectFont(f.family, f.data).catch(() => {});
  const missing = [...new Set(p.settings.texts.filter((t) => t.enabled && t.text.trim() && !fontAvailable(t.font)).map((t) => t.font))];

  setCropEditing(false);
  setSubjectEditing(false);
  source?.bitmap.close();
  subject?.bitmap.close();
  settings = p.settings;
  source = { bitmap: bg, blob: p.source.image, name: p.source.name, coin: p.source.coin, plain: p.source.plain };
  subject = sub && { ...sub, blob: p.subject!.image, name: p.subject!.name };
  depth = p.depth;
  subjectDepth = subject ? p.subjectDepth : null;
  rings = p.rings;
  ringIndex = Math.min(p.ringIndex, Math.max(0, rings.length - 1));
  latest = null;
  project = entry ?? { file: null, name: p.name };
  $("empty").hidden = true;
  $("btn-place").hidden = !subject;
  if (depth) post(worker, { type: "depth", w: depth.w, h: depth.h, data: depth.data.slice(), coin: source.coin });
  working.key = "";
  updateWorkingSize();
  refreshSubject(true);
  viewer.fit();
  saveSettings();
  panel.collapseAll();
  panel.render();
  setDirty(false);
  const when = p.saved ? `, saved ${new Date(p.saved).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : "";
  if (missing.length) setStatus(`Opened ${project.name}${when}. ${missing.join(", ")} isn't installed here, so that text is drawn in another font.`, { error: true });
  else setStatus(`Opened ${project.name}${when}.`);
  if (coinStale() || subjectStale()) maybeRunModel();
  else requestProcess();
}

/** Saved projects on the start screen. */
async function refreshRecent() {
  const box = $("recent");
  let list: api.Project[] = [];
  if (system) {
    try {
      list = (await api.getProjects()).projects;
    } catch {
      /* no list: nothing to show */
    }
  }
  box.hidden = !list.length;
  box.replaceChildren(
    h("div", { class: "recent-head" }, h("h3", {}, "Recent projects"),
      h("button", { class: "btn ghost small", onclick: () => projectsDialog.show() }, list.length > 6 ? `All ${list.length} projects…` : "Projects…")),
    h("div", { class: "project-grid" }, ...list.slice(0, 6).map((p) => projectTile(p, () => openProjectEntry(p)))),
  );
}

// ------------------------------------------------------------------------------------ views
function setView(v: typeof view) {
  view = v;
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  $("view-compare").hidden = v !== "compare";
  $("view-3d").hidden = v !== "3d";
  $("view-slices").hidden = v !== "slices";
  $("tools-compare").hidden = v !== "compare";
  $("profile").hidden = v !== "compare" || !$("btn-profile").classList.contains("on");
  if (v !== "slices") slices.stop();
  if (v === "slices") updateSlices();
  if (v === "3d") update3D();
}

function updateSlices() {
  if (!latest) return;
  slices.set({ out: latest.out, w: latest.w, h: latest.h, bits: settings.output.bits, passes: settings.slices.passes,
    distinct8: latest.distinct8, distinct16: latest.distinct16, min8: latest.min8, max8: latest.max8 });
}

async function update3D() {
  if (!latest) return;
  view3d ??= load3D();
  const v = await view3d;
  if (!v || !latest) return;
  const ex = exportSize(settings.output.widthMM, settings.output.dpi, aspect());
  v.setData({ out: latest.out, w: latest.w, h: latest.h, widthMM: ex.widthMM, heightMM: ex.heightMM, depthMM: settings.relief.depthMM });
}

async function load3D(): Promise<View3D | null> {
  const root = $("view-3d");
  root.replaceChildren();
  setStatus("Loading the 3D viewer…", { progress: "busy" });
  let mod: typeof import("./ui/view3d");
  try {
    mod = await import("./ui/view3d");
  } catch {
    // The browser remembers a failed import, so only a reload can fetch it again.
    return fail3D(
      "Couldn't load the 3D viewer",
      "The app was probably restarted or updated since this page was opened. Reload the page; your settings are kept, " +
        "but you'll need to open the image again.",
      h("button", { class: "btn small", onclick: () => location.reload() }, "Reload page"),
    );
  }
  try {
    const v = new mod.View3D(root);
    setStatus(v.mode === "gpu" ? "3D preview ready." : "3D preview ready (drawn in software: this browser has no WebGL).");
    return v;
  } catch (err) {
    root.replaceChildren();
    return fail3D(
      "The 3D preview couldn't start",
      `${(err as Error).message}. Everything else works without it, including the PNG and STL export.`,
      h("button", { class: "btn small", onclick: () => ((view3d = null), update3D()) }, "Try again"),
    );
  }
}

function fail3D(title: string, text: string, action: HTMLElement): null {
  setStatus(`${title}.`, { error: true });
  $("view-3d").replaceChildren(h("div", { class: "view-message" }, h("div", { class: "empty-card" }, h("h2", {}, title), h("p", {}, text), action)));
  return null;
}

function updateProfile() {
  const line = viewer.profileLine;
  if (!line || !latest) return profile.set(null);
  const [a, b] = line;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 2) return profile.set(null);
  const n = Math.max(2, Math.ceil(len));
  const img = makeImg(latest.w, latest.h, latest.out);
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    values[i] = sample(img, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  }
  profile.set({ values, lengthMM: len / working.pxPerMM, reliefMM: settings.relief.depthMM, passes: settings.slices.passes, bits: settings.output.bits });
}

// ------------------------------------------------------------------------------------ wiring
document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view as typeof view)));
$("btn-open").addEventListener("click", () => ($("file-input") as HTMLInputElement).click());
$("file-input").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) openFile(f);
  (e.target as HTMLInputElement).value = "";
});
$("btn-projects").addEventListener("click", () => projectsDialog.show());
$("btn-save").addEventListener("click", () => quickSave());
$("project-input").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = "";
  if (f && confirmDiscard(f.name)) {
    projectsDialog.close();
    openProject(f, null);
  }
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (e.shiftKey) projectsDialog.show(); // save under another name
    else quickSave();
  }
});
$("btn-edit-crop").addEventListener("click", () => setCropEditing(!cropEditing));
$("btn-place").addEventListener("click", () => setSubjectEditing(!subjectEditing));
$("font-input").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = "";
  if (!f) return;
  try {
    const family = await addFontFile(f, !!system);
    setStatus(`Added the font ${family}${system ? " to the fonts folder" : " for this session"}.`);
    panel.render();
  } catch (err) {
    setStatus(`Couldn't add ${f.name}: ${(err as Error).message}`, { error: true });
  }
});
$("coin-input").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = "";
  if (f) addCoin(f);
});
$("btn-fit").addEventListener("click", () => viewer.fit());
$("btn-100").addEventListener("click", () => viewer.oneToOne());
$("btn-profile").addEventListener("click", () => {
  const on = !$("btn-profile").classList.contains("on");
  $("btn-profile").classList.toggle("on", on);
  if (on) {
    setCropEditing(false);
    if (subjectEditing) setSubjectEditing(false);
  }
  viewer.setProfileMode(on);
  $("profile").hidden = !on;
  updateProfile();
});

$("btn-preset-save").addEventListener("click", () => {
  const json = JSON.stringify({ app: "relief-depth-studio", version: VERSION, settings: presetPart(settings) }, null, 2);
  download(new Blob([json], { type: "application/json" }), `${baseName()}-preset.json`);
});
$("btn-preset-load").addEventListener("click", () => ($("preset-input") as HTMLInputElement).click());
$("preset-input").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const { crop, subject: place } = settings;
    settings = mergeSettings(defaultSettings(), data.settings ?? data);
    settings.crop = { ...crop, shape: settings.crop.shape, hideOutsideFromModel: settings.crop.hideOutsideFromModel };
    settings.subject = { ...settings.subject, size: place.size, x: place.x, y: place.y };
    setStatus(`Loaded preset ${f.name}.`);
    working.key = "";
    change("crop");
    panel.render();
  } catch {
    setStatus(`${f.name} isn't a valid preset file.`, { error: true });
  }
});
$("btn-reset").addEventListener("click", () => {
  const { crop, subject: place } = settings;
  settings = defaultSettings();
  settings.crop = crop;
  settings.subject = { ...settings.subject, size: place.size, x: place.x, y: place.y };
  working.key = "";
  setStatus("Settings reset to defaults.");
  change("crop");
  panel.render();
});

// Drag and drop / paste
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  $("drop-overlay").hidden = false;
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drop-overlay").hidden = true;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop-overlay").hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});
window.addEventListener("paste", (e) => {
  const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
  const f = item?.getAsFile();
  if (f) openFile(f, f.name && f.name !== "image.png" ? f.name : "pasted-image.png");
});

// ------------------------------------------------------------------------------------ start
async function start() {
  system = await api.getSystem();
  const dev = $("device");
  if (system) {
    dev.textContent = system.device.label;
    dev.classList.toggle("cpu", system.device.kind === "cpu");
    if (system.device.warning) dev.dataset.tip = system.device.warning;
    try {
      models = await api.getModels();
    } catch (err) {
      setStatus(`Couldn't list models: ${(err as Error).message}`, { error: true });
    }
    await refreshCoins();
  } else {
    dev.textContent = "Browser only";
    dev.dataset.tip = "The Python backend isn't running, so depth runs in the browser (lite mode).";
  }
  await initFonts(!!system);
  const { liteModel } = await import("./lite");
  models.push(liteModel(!system));
  if (!currentModel()?.available) {
    // The saved model isn't usable here (e.g. no backend): switch to one that is, with its defaults.
    const m = models.find((x) => x.available && (x.commercial_use || settings.model.allowNonCommercial));
    if (m) {
      settings.model.id = m.id;
      settings.model.resolution = m.default_resolution;
      settings.model.params = Object.fromEntries(m.params.map((p) => [p.key, p.default]));
    }
  }
  panel.render();
  if (!source) refreshRecent();
  if (system?.device.warning) setStatus(system.device.warning);
  // An image opened before the models were listed hasn't had its depth run yet.
  if (source && !busy && (coinStale() || subjectStale())) maybeRunModel();
}
start();

// Exposed for the end-to-end test.
(window as any).__rds = {
  openFile,
  get settings() {
    return settings;
  },
  get state() {
    return { depth: !!depth, busy, stale: coinStale() || subjectStale(), latest: latest && { w: latest.w, h: latest.h, min8: latest.min8, max8: latest.max8, distinct8: latest.distinct8 }, rings: rings.length, autoLevelsDone,
      source: source && { name: source.name, coin: source.coin, plain: !!source.plain }, subject: subject && { name: subject.name, depth: !!subjectDepth }, coins: coins.map((c) => c.file) };
  },
  change,
  runModel,
  pickCoin,
  removeSubject,
  get latestOut() {
    return latest && { w: latest.w, h: latest.h, out: latest.out };
  },
  get project() {
    return project && { ...project, dirty };
  },
  runExport,
  setView,
};
