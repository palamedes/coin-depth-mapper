import { describe, expect, it } from "vitest";
import { type ProjectData, isProjectFile, readProject, shuffleFloats, unshuffleFloats, writeProject } from "../src/project";
import { defaultSettings, defaultTextLayer } from "../src/proc/settings";
import { crc32, readZip, writeZip } from "../src/zip";

const bytes = (b: Blob) => b.arrayBuffer().then((x) => new Uint8Array(x));
const text = (s: string) => new TextEncoder().encode(s);

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("reads back what it writes, stored or deflated, with UTF-8 names", async () => {
    const big = text("depth ".repeat(5000));
    const zip = await writeZip([
      { name: "a.txt", data: text("hello") },
      { name: "dir/big.bin", data: big, compress: true },
      { name: "émoji-☀.txt", data: text("sun") },
    ]);
    expect(zip.size).toBeLessThan(big.length / 4); // the repetitive file was deflated
    const files = await readZip(await zip.arrayBuffer());
    expect([...files.keys()]).toEqual(["a.txt", "dir/big.bin", "émoji-☀.txt"]);
    expect(new TextDecoder().decode(files.get("a.txt"))).toBe("hello");
    expect(files.get("dir/big.bin")).toEqual(big);
    expect(new TextDecoder().decode(files.get("émoji-☀.txt"))).toBe("sun");
  });

  it("refuses files that aren't ZIPs, and notices damage", async () => {
    await expect(readZip(text("not a zip at all, just some text").buffer as ArrayBuffer)).rejects.toThrow(/not a ZIP/);
    const zip = await bytes(await writeZip([{ name: "a.txt", data: text("hello world") }]));
    zip[30 + "a.txt".length + 2] ^= 0xff; // a byte of the stored file
    await expect(readZip(zip.buffer as ArrayBuffer)).rejects.toThrow(/a\.txt is damaged/);
  });
});

describe("project files", () => {
  const depth = (w: number, h: number, seed: number) =>
    Float32Array.from({ length: w * h }, (_, i) => Math.fround(0.5 + 0.4 * Math.sin(i * 0.013 + seed) + 1e-7 * ((i * 7919) % 101)));

  function sample(): ProjectData {
    const settings = defaultSettings();
    settings.crop.circle = { cx: 627, cy: 627, r: 601.9 };
    settings.subject = { ...settings.subject, size: 0.72, x: 0.05, y: -0.02 };
    settings.coin.tone.gamma = 1.4;
    settings.texts = [{ ...defaultTextLayer(1), text: "TOBY", outline: { enabled: true, widthMM: 0.3, gapMM: 0.2, height: 0.8 } }];
    return {
      name: "Toby on swirl",
      saved: "2026-10-22T19:30:00.000Z",
      appVersion: "0.1.0",
      settings,
      source: { name: "swirl.webp", coin: true, plain: false, image: new Blob([text("WEBP-BYTES")], { type: "image/webp" }) },
      subject: { name: "toby.webp", image: new Blob([text("TOBY-PNG")], { type: "image/png" }) },
      depth: { w: 40, h: 30, data: depth(40, 30, 1), key: '["swirl.webp","circle"]' },
      subjectDepth: { w: 20, h: 25, data: depth(20, 25, 2), key: '["toby.webp"]', base: 0.31, peak: 0.97 },
      rings: [{ cx: 627, cy: 627, r: 601.9, score: 0.9 }],
      ringIndex: 0,
      fonts: [{ family: "Cinzel", data: Uint8Array.from([0, 1, 0, 0, 9, 9, 9]) }],
      preview: new Blob([text("PREVIEW")], { type: "image/png" }),
    };
  }

  it("brings back everything exactly as it was saved", async () => {
    const p = sample();
    const back = await readProject(await writeProject(p));
    expect(back.name).toBe("Toby on swirl");
    expect(back.saved).toBe(p.saved);
    expect(back.settings).toEqual(p.settings);
    expect(back.source).toMatchObject({ name: "swirl.webp", coin: true, plain: false });
    expect(back.source.image!.type).toBe("image/webp");
    expect(await bytes(back.source.image!)).toEqual(text("WEBP-BYTES"));
    expect(back.subject!.name).toBe("toby.webp");
    expect(back.subject!.image.type).toBe("image/png");
    expect(await bytes(back.subject!.image)).toEqual(text("TOBY-PNG"));
    // Depth maps bit for bit, so the result is identical without running the model.
    expect(back.depth).toEqual(p.depth);
    expect(back.subjectDepth).toEqual(p.subjectDepth);
    expect(back.rings).toEqual(p.rings);
    expect(back.fonts).toEqual(p.fonts);
    expect(await bytes(back.preview!)).toEqual(text("PREVIEW"));
  });

  it("is an ordinary ZIP with readable contents", async () => {
    const files = await readZip(await (await writeProject(sample())).arrayBuffer());
    expect([...files.keys()].sort()).toEqual(["background.webp", "depth.f32", "fonts/1-Cinzel.ttf", "preview.png", "project.json", "subject-depth.f32", "subject.png"]);
    const j = JSON.parse(new TextDecoder().decode(files.get("project.json")));
    expect(j).toMatchObject({ app: "relief-depth-studio", type: "project", format: 1, name: "Toby on swirl", source: { file: "background.webp" } });
  });

  it("saves the plain disc and a coin with no subject or depth yet", async () => {
    const p = { ...sample(), source: { name: "plain", coin: true, plain: true, image: null }, subject: null, depth: null, subjectDepth: null, fonts: [], preview: null };
    const back = await readProject(await writeProject(p));
    expect(back.source).toEqual({ name: "plain", coin: true, plain: true, image: null });
    expect(back.subject).toBeNull();
    expect(back.depth).toBeNull();
    expect(back.preview).toBeNull();
  });

  it("fills in settings added since the project was saved", async () => {
    const files = await readZip(await (await writeProject(sample())).arrayBuffer());
    const j = JSON.parse(new TextDecoder().decode(files.get("project.json")));
    delete j.settings.rim;
    delete j.settings.texts[0].plate;
    const old = await writeZip([...files].map(([name, data]) => ({ name, data: name === "project.json" ? text(JSON.stringify(j)) : data })));
    const back = await readProject(old);
    expect(back.settings.rim).toEqual(defaultSettings().rim);
    expect(back.settings.texts[0].plate).toEqual(defaultTextLayer(1).plate);
    expect(back.settings.texts[0].text).toBe("TOBY");
  });

  it("refuses other files with a plain reason", async () => {
    await expect(readProject(new Blob([text("hello")]))).rejects.toThrow("it isn't a project file");
    const other = await writeZip([{ name: "project.json", data: text('{"app":"something-else"}') }]);
    await expect(readProject(other)).rejects.toThrow("it isn't a project file");
    const newer = await writeZip([{ name: "project.json", data: text('{"app":"relief-depth-studio","type":"project","format":99}') }]);
    await expect(readProject(newer)).rejects.toThrow(/newer version/);
    const files = await readZip(await (await writeProject(sample())).arrayBuffer());
    const noDepth = await writeZip([...files].filter(([n]) => n !== "depth.f32").map(([name, data]) => ({ name, data })));
    await expect(readProject(noDepth)).rejects.toThrow(/missing depth\.f32/);
  });

  it("is recognised by name or by its first bytes", async () => {
    const zip = await writeProject(sample());
    expect(await isProjectFile(zip, "anything")).toBe(true);
    expect(await isProjectFile(new Blob([text("x")]), "Toby.rdsproj")).toBe(true);
    expect(await isProjectFile(new Blob([text("PNG")], { type: "image/png" }), "toby.png")).toBe(false);
  });

  it("stores depth compactly: float bytes grouped by significance", async () => {
    const d = depth(256, 256, 3);
    expect(unshuffleFloats(shuffleFloats(d))).toEqual(d);
    const raw = await writeZip([{ name: "d", data: new Uint8Array(d.buffer), compress: true }]);
    const grouped = await writeZip([{ name: "d", data: shuffleFloats(d), compress: true }]);
    expect(grouped.size).toBeLessThan(raw.size * 0.9);
  });
});
