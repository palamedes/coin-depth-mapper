// Fonts for text layers: the ones in the fonts folder (loaded into the page), common fonts that are
// installed on this computer, and, where the browser allows it, every installed font.

import * as api from "./api";

export interface FontChoice {
  family: string;
  group: "Fonts folder" | "In this project" | "Installed" | "Generic";
  url?: string; // the file, for fonts from the fonts folder
}

// Checked one by one; only the installed ones are offered.
const COMMON = [
  "DejaVu Serif", "DejaVu Sans", "Liberation Serif", "Liberation Sans", "Noto Serif", "Noto Sans", "Fira Sans", "Cantarell",
  "Ubuntu", "Georgia", "Times New Roman", "Garamond", "EB Garamond", "Palatino Linotype", "Palatino", "Book Antiqua",
  "Baskerville", "Didot", "Bodoni 72", "Trajan Pro", "Optima", "Futura", "Gill Sans", "Copperplate", "Copperplate Gothic Bold",
  "Cambria", "Constantia", "Arial", "Helvetica", "Verdana", "Tahoma", "Trebuchet MS", "Segoe UI", "Impact",
];

let library: FontChoice[] = [];
let installed: FontChoice[] = [];
let folder = "";

export function fontChoices(): FontChoice[] {
  return [...library, ...installed, { family: "serif", group: "Generic" }, { family: "sans-serif", group: "Generic" }];
}

export const fontsFolder = () => folder;

/** The file of a font from the fonts folder (so a project can carry it), or null. */
export const libraryFontUrl = (family: string) => library.find((f) => f.family === family)?.url ?? null;

/** True when text can be drawn in this font here. */
export function fontAvailable(family: string): boolean {
  return fontChoices().some((f) => f.family === family) || isInstalled(family);
}

/** A font a project brought with it, for this session (it isn't added to the fonts folder). */
export async function addProjectFont(family: string, data: Uint8Array): Promise<void> {
  await addFace(family, data.slice().buffer);
  library.push({ family, group: "In this project" });
}

/** True when text in `family` measures differently from the fallbacks, so the font exists. */
function isInstalled(family: string): boolean {
  const g = document.createElement("canvas").getContext("2d")!;
  const sample = "mmmmmmmmmmlliWQ@#0123";
  return ["monospace", "serif", "sans-serif"].some((base) => {
    g.font = `72px ${base}`;
    const w0 = g.measureText(sample).width;
    g.font = `72px "${family}", ${base}`;
    return g.measureText(sample).width !== w0;
  });
}

/** A variable font has an 'fvar' table; declare its weight range so bold uses the real bold. */
function isVariable(buf: ArrayBuffer): boolean {
  const v = new DataView(buf);
  if (buf.byteLength < 12) return false;
  const tag = v.getUint32(0);
  // TrueType / OpenType: 12-byte header, 16-byte table records. WOFF: 44-byte header, 20-byte records.
  const woff = tag === 0x774f4646;
  const n = v.getUint16(woff ? 12 : 4);
  const start = woff ? 44 : 12;
  const size = woff ? 20 : 16;
  for (let i = 0; i < n && start + i * size + 4 <= buf.byteLength; i++) if (v.getUint32(start + i * size) === 0x66766172) return true;
  return false;
}

async function addFace(family: string, buf: ArrayBuffer) {
  const face = new FontFace(family, buf, isVariable(buf) ? { weight: "100 900" } : {});
  await face.load();
  document.fonts.add(face);
}

/** Load the fonts folder (needs the backend) and find the common installed fonts. */
export async function initFonts(hasBackend: boolean): Promise<void> {
  installed = COMMON.filter(isInstalled).map((family) => ({ family, group: "Installed" as const }));
  if (!hasBackend) return;
  try {
    const r = await api.getFonts();
    folder = r.folder;
    const loaded = await Promise.all(
      r.fonts.map(async (f) => {
        try {
          await addFace(f.name, await (await fetch(f.url)).arrayBuffer());
          return { family: f.name, group: "Fonts folder" as const, url: f.url };
        } catch {
          return null; // not a usable font file
        }
      }),
    );
    library = loaded.filter((x) => !!x);
  } catch {
    library = [];
  }
}

/** Every installed font, where the browser offers it (Chrome and Edge ask for permission). */
export async function listAllInstalled(): Promise<number> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!query) throw new Error("This browser can't list installed fonts. Type a font name instead, or add a font file.");
  const all = await query();
  const seen = new Set([...library, ...installed].map((f) => f.family));
  for (const f of all) {
    if (seen.has(f.family)) continue;
    seen.add(f.family);
    installed.push({ family: f.family, group: "Installed" });
  }
  installed.sort((a, b) => a.family.localeCompare(b.family));
  return seen.size;
}

/** Add a font file: kept in the fonts folder when the backend runs, otherwise for this session. */
export async function addFontFile(file: File, hasBackend: boolean): Promise<string> {
  if (!hasBackend) {
    const family = file.name.replace(/\.[^.]+$/, "");
    await addFace(family, await file.arrayBuffer());
    library.push({ family, group: "Fonts folder", url: URL.createObjectURL(file) });
    return family;
  }
  const entry = await api.addToLibrary("fonts", file, file.name);
  await addFace(entry.name, await (await fetch(entry.url)).arrayBuffer());
  library.push({ family: entry.name, group: "Fonts folder", url: entry.url });
  return entry.name;
}
