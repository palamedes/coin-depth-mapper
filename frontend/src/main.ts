import "./styles.css";
import * as api from "./api";
import type { Depth, ModelInfo, SystemInfo } from "./api";
import { exportSize } from "./proc/export";
import { makeImg, sample } from "./proc/image";
import { autoLevels } from "./proc/levels";
import { type Settings, defaultSettings, mergeSettings, presetPart } from "./proc/settings";
import { $, download, fmtBytes, installTooltips } from "./ui/dom";
import { type ChangeKind, Panel } from "./ui/panel";
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
let source: { bitmap: ImageBitmap; name: string } | null = null;
let depth: (Depth & { key: string }) | null = null;
let rings: api.CircleCandidate[] = [];
let ringIndex = 0;
let busy = false; // model running or exporting
let cropEditing = false;
let view: "compare" | "3d" | "slices" = "compare";
let latest: Extract<WorkerResponse, { type: "result" }> | null = null;
let working = { w: 0, h: 0, pxPerMM: 1, key: "" };
let photoCanvas: HTMLCanvasElement | null = null;
let view3d: View3D | null = null;
let autoLevelsDone = 0;

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
  depthStale: () => !depth || depth.key !== depthKey(),
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
  requestProcess();
}

function currentModel(): ModelInfo | undefined {
  return models.find((m) => m.id === settings.model.id);
}

/** Everything the model's output depends on. */
function depthKey(): string {
  const c = settings.crop;
  return JSON.stringify([c.shape, c.shape === "circle" ? c.circle : c.rect, c.hideOutsideFromModel, settings.model.id, settings.model.resolution, settings.model.params]);
}

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
  viewer.setPhoto(photoCanvas);
}

function requestProcess() {
  if (!depth || !source) return;
  if (inflight) {
    pending = true;
    return;
  }
  inflight = true;
  pending = false;
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
  const img = new ImageData(r.w, r.h);
  const px = img.data;
  for (let i = 0, j = 0; i < r.out.length; i++, j += 4) {
    const v = Math.round(r.out[i] * 255);
    px[j] = px[j + 1] = px[j + 2] = v;
    px[j + 3] = 255;
  }
  viewer.setContent(photoCanvas, img, r.w, r.h);
  panel.showResult(r.histBefore, r.distinct8, r.distinct16, r.min8, r.max8);
  updateProfile();
  if (view === "slices") updateSlices();
  if (view === "3d") update3D();
}

function autoLevelsFromPreview() {
  // Ask the worker for a run with levels off, then take percentiles of that.
  const s = structuredClone(settings);
  s.levels.enabled = false;
  s.smooth = { ...s.smooth, despeckle: false, bilateral: false, gaussianMM: 0 };
  s.invert = false;
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  post(w, { type: "depth", w: depth!.w, h: depth!.h, data: depth!.data.slice() });
  const rgba = photoCanvas!.getContext("2d")!.getImageData(0, 0, working.w, working.h).data;
  post(w, { type: "guide", w: working.w, h: working.h, rgba }, [rgba.buffer]);
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

// ------------------------------------------------------------------------------------ loading images
async function openFile(file: File | Blob, name = (file as File).name || "pasted-image") {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(name)) {
    setStatus("Please use a PNG, JPG or WebP image.", { error: true });
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
  source?.bitmap.close();
  source = { bitmap, name };
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
  if (settings.crop.shape === "circle" && system) await detectCoin(false);
  const m = currentModel();
  if (m && m.available && (m.cached || m.browser) && settings.model.autoRun) runModel();
  else if (m && !m.cached && !m.browser) setStatus(`Ready. Click Generate depth (first run downloads ${fmtBytes(m.download_bytes)}).`);
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
  busy = true;
  panel.render();
  const key = depthKey();
  const r = cropRegion();
  const longest = Math.min(2048, Math.max(64, Math.round(Math.max(r.w, r.h))));
  const w = Math.round(r.w >= r.h ? longest : (longest * r.w) / r.h);
  const h = Math.round(r.h >= r.w ? longest : (longest * r.h) / r.w);
  const crop = renderCrop(w, h, settings.crop.hideOutsideFromModel);
  setStatus(`${m.name}: starting…`, { progress: "busy" });
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
  const t0 = performance.now();
  try {
    const blob = await new Promise<Blob>((res) => crop.toBlob((x) => res(x!), "image/png"));
    let d: Depth;
    if (m.browser) {
      const { predictInBrowser } = await import("./lite");
      const res = Math.min(m.max_resolution, Math.max(m.min_resolution, settings.model.resolution));
      d = await predictInBrowser(blob, res, (msg, p) => setStatus(msg, { progress: p ?? "busy" }));
    } else d = await api.predictDepth(blob, m.id, settings.model.resolution, settings.model.params);
    depth = { ...d, key };
    post(worker, { type: "depth", w: d.w, h: d.h, data: d.data.slice() });
    setStatus(`${m.name}: done in ${((performance.now() - t0) / 1000).toFixed(1)} s (${d.w} × ${d.h} depth).`);
    if (!m.cached && !m.browser) models = await api.getModels().catch(() => models);
  } catch (err) {
    setStatus(`${m.name} failed: ${(err as Error).message}`, { error: true });
  } finally {
    clearInterval(poll);
    busy = false;
    panel.render();
    requestProcess();
    // The crop or settings may have changed while the model ran.
    if (depth && depth.key !== depthKey() && settings.model.autoRun) setTimeout(runModel, 50);
  }
}

// ------------------------------------------------------------------------------------ export
function baseName(): string {
  return (source?.name ?? "relief").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-");
}

async function runExport(kind: "png" | "stl") {
  if (!source || !depth || busy) return;
  busy = true;
  panel.render();
  const ex = exportSize(settings.output.widthMM, settings.output.dpi, aspect());
  setStatus(`Building the ${ex.w} × ${ex.h} px ${kind.toUpperCase()}…`, { progress: "busy" });
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  try {
    const guide = renderCrop(ex.w, ex.h).getContext("2d")!.getImageData(0, 0, ex.w, ex.h).data;
    post(w, { type: "depth", w: depth.w, h: depth.h, data: depth.data.slice() });
    post(w, { type: "guide", w: ex.w, h: ex.h, rgba: guide }, [guide.buffer]);
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
  if (!view3d) {
    setStatus("Loading the 3D viewer…", { progress: "busy" });
    const { View3D } = await import("./ui/view3d");
    view3d = new View3D($("view-3d"));
    setStatus("3D preview ready.");
  }
  const ex = exportSize(settings.output.widthMM, settings.output.dpi, aspect());
  view3d.setData({ out: latest.out, w: latest.w, h: latest.h, widthMM: ex.widthMM, heightMM: ex.heightMM, depthMM: settings.relief.depthMM });
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
$("btn-edit-crop").addEventListener("click", () => setCropEditing(!cropEditing));
$("btn-fit").addEventListener("click", () => viewer.fit());
$("btn-100").addEventListener("click", () => viewer.oneToOne());
$("btn-profile").addEventListener("click", () => {
  const on = !$("btn-profile").classList.contains("on");
  $("btn-profile").classList.toggle("on", on);
  if (on) setCropEditing(false);
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
    const crop = settings.crop;
    settings = mergeSettings(defaultSettings(), data.settings ?? data);
    settings.crop = { ...crop, shape: settings.crop.shape, hideOutsideFromModel: settings.crop.hideOutsideFromModel };
    setStatus(`Loaded preset ${f.name}.`);
    working.key = "";
    change("crop");
    panel.render();
  } catch {
    setStatus(`${f.name} isn't a valid preset file.`, { error: true });
  }
});
$("btn-reset").addEventListener("click", () => {
  const crop = settings.crop;
  settings = defaultSettings();
  settings.crop = crop;
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
  } else {
    dev.textContent = "Browser only";
    dev.dataset.tip = "The Python backend isn't running, so depth runs in the browser (lite mode).";
  }
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
  if (system?.device.warning) setStatus(system.device.warning);
}
start();

// Exposed for the end-to-end test.
(window as any).__rds = {
  openFile,
  get settings() {
    return settings;
  },
  get state() {
    return { depth: !!depth, busy, stale: !depth || depth.key !== depthKey(), latest: latest && { w: latest.w, h: latest.h, min8: latest.min8, max8: latest.max8, distinct8: latest.distinct8 }, rings: rings.length, autoLevelsDone };
  },
  change,
  runModel,
  runExport,
  setView,
};
