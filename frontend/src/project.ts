// Projects: everything needed to pick a piece up again later, in one file. A project file is a
// ZIP holding project.json (the settings, names and sizes) and the files it points to: the
// background and subject images exactly as they were opened, the depth the model returned for
// each (so reopening needs no model run and gives exactly the same result), fonts from the fonts
// folder that the text uses, and a small preview of the depth map.

import type { CircleCandidate } from "./api";
import { type Settings, defaultSettings, mergeSettings } from "./proc/settings";
import { readZip, writeZip } from "./zip";

export const PROJECT_EXT = ".rdsproj";
const FORMAT = 1;

export interface ProjectDepth {
  w: number;
  h: number;
  data: Float32Array;
  key: string; // what it was made from (image, crop, model); it's re-run when that changes
}

export interface ProjectData {
  name: string;
  saved: string; // ISO date and time
  appVersion: string;
  settings: Settings;
  source: { name: string; coin: boolean; plain: boolean; image: Blob | null }; // no image for the plain disc
  subject: { name: string; image: Blob } | null;
  depth: ProjectDepth | null;
  subjectDepth: (ProjectDepth & { base: number; peak: number }) | null;
  rings: CircleCandidate[];
  ringIndex: number;
  fonts: { family: string; data: Uint8Array }[]; // fonts from the fonts folder that the text uses
  preview: Blob | null;
}

const IMAGE_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
const IMAGE_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/** Float32 values with their bytes grouped by significance (little-endian), which deflate packs far better. */
export function shuffleFloats(f: Float32Array): Uint8Array {
  const b = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  const n = f.length;
  const out = new Uint8Array(b.length);
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) out[k * n + i] = b[i * 4 + k];
  return out;
}

export function unshuffleFloats(b: Uint8Array): Float32Array {
  const n = b.length >> 2;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) out[i * 4 + k] = b[k * n + i];
  return new Float32Array(out.buffer);
}

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80) || "font";
const FONT_EXT: Record<string, string> = { "\x00\x01\x00\x00": ".ttf", true: ".ttf", OTTO: ".otf", wOFF: ".woff", wOF2: ".woff2" };
const fontExt = (d: Uint8Array) => FONT_EXT[String.fromCharCode(...d.subarray(0, 4))] ?? ".font";

export async function writeProject(p: ProjectData): Promise<Blob> {
  const files: { name: string; data: Uint8Array; compress?: boolean }[] = [];
  const image = async (base: string, b: Blob) => {
    const name = base + (IMAGE_EXT[b.type] ?? ".img");
    files.push({ name, data: await bytesOf(b) });
    return name;
  };
  const depth = (name: string, d: ProjectDepth) => {
    files.push({ name, data: shuffleFloats(d.data), compress: true });
    return { w: d.w, h: d.h, key: d.key, file: name };
  };
  const json = {
    app: "relief-depth-studio",
    type: "project",
    format: FORMAT,
    appVersion: p.appVersion,
    name: p.name,
    saved: p.saved,
    settings: p.settings,
    source: { name: p.source.name, coin: p.source.coin, plain: p.source.plain, file: p.source.image ? await image("background", p.source.image) : null },
    subject: p.subject && { name: p.subject.name, file: await image("subject", p.subject.image) },
    depth: p.depth && depth("depth.f32", p.depth),
    subjectDepth: p.subjectDepth && { ...depth("subject-depth.f32", p.subjectDepth), base: p.subjectDepth.base, peak: p.subjectDepth.peak },
    rings: p.rings,
    ringIndex: p.ringIndex,
    fonts: p.fonts.map((f, i) => {
      const file = `fonts/${i + 1}-${safeName(f.family)}${fontExt(f.data)}`;
      files.push({ name: file, data: f.data, compress: true });
      return { family: f.family, file };
    }),
    preview: p.preview ? "preview.png" : null,
  };
  if (p.preview) files.push({ name: "preview.png", data: await bytesOf(p.preview) });
  const text = new TextEncoder().encode(JSON.stringify(json, null, 1));
  return writeZip([{ name: "project.json", data: text, compress: true }, ...files], new Date(p.saved));
}

export async function readProject(file: Blob): Promise<ProjectData> {
  let zip: Map<string, Uint8Array>;
  try {
    zip = await readZip(await file.arrayBuffer());
  } catch (err) {
    throw new Error(/not a ZIP/.test((err as Error).message) ? "it isn't a project file" : (err as Error).message);
  }
  const raw = zip.get("project.json");
  let j: any;
  try {
    j = raw && JSON.parse(new TextDecoder().decode(raw));
  } catch {
    j = null;
  }
  if (!j || j.app !== "relief-depth-studio" || j.type !== "project") throw new Error("it isn't a project file");
  if (j.format > FORMAT) throw new Error("it was saved by a newer version of the app; update it to open this project");
  const need = (name: string): Uint8Array => {
    const d = zip.get(name);
    if (!d) throw new Error(`the project is missing ${name}`);
    return d;
  };
  const image = (name: string) => new Blob([need(name) as BlobPart], { type: IMAGE_TYPE[name.split(".").pop()!.toLowerCase()] ?? "" });
  const depth = (d: any): ProjectDepth | null => {
    if (!d) return null;
    const data = unshuffleFloats(need(d.file));
    if (data.length !== d.w * d.h) throw new Error(`${d.file} has the wrong size`);
    return { w: d.w, h: d.h, data, key: String(d.key) };
  };
  const sd = depth(j.subjectDepth);
  return {
    name: String(j.name ?? "Project"),
    saved: String(j.saved ?? ""),
    appVersion: String(j.appVersion ?? ""),
    settings: mergeSettings(defaultSettings(), j.settings),
    source: { name: String(j.source?.name ?? "image"), coin: !!j.source?.coin, plain: !!j.source?.plain, image: j.source?.file ? image(j.source.file) : null },
    subject: j.subject ? { name: String(j.subject.name), image: image(j.subject.file) } : null,
    depth: depth(j.depth),
    subjectDepth: sd && { ...sd, base: Number(j.subjectDepth.base), peak: Number(j.subjectDepth.peak) },
    rings: Array.isArray(j.rings) ? j.rings : [],
    ringIndex: Number(j.ringIndex) || 0,
    fonts: (Array.isArray(j.fonts) ? j.fonts : []).filter((f: any) => zip.has(f.file)).map((f: any) => ({ family: String(f.family), data: zip.get(f.file)! })),
    preview: j.preview && zip.has(j.preview) ? new Blob([zip.get(j.preview)! as BlobPart], { type: "image/png" }) : null,
  };
}

/** A project file, by its name or its first bytes (a ZIP). */
export async function isProjectFile(f: Blob, name: string): Promise<boolean> {
  if (name.toLowerCase().endsWith(PROJECT_EXT)) return true;
  if (f.type.startsWith("image/")) return false;
  const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;
}
