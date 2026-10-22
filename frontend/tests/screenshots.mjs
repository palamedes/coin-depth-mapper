// Regenerate the README screenshots in docs/screenshots/.
//
//   npm run screenshots                               # starts its own server on port 8791
//   RDS_URL=http://127.0.0.1:8790/ npm run screenshots   # or use an instance that's already running
//
// Needs Google Chrome or Chromium (set CHROME=/path/to/chrome if it isn't found).

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = join(root, "docs/screenshots");
mkdirSync(out, { recursive: true });
const sample = join(root, "samples/coin-toby.webp");
const chromePath =
  process.env.CHROME ??
  ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);

let server = null;
let url = process.env.RDS_URL;
if (!url) {
  url = "http://127.0.0.1:8791/";
  server = spawn(join(root, "depthmap"), ["--no-browser", "--port", "8791"], { stdio: "ignore" });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 300_000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await wait(300);
  }
}

let browser;
try {
  await until(() => fetch(url + "api/system").then((r) => r.ok), "server");
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(url);
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {}
  });
  await page.reload();
  await page.waitForSelector("#panel .section");

  const settle = async (ms = 600) => {
    // Park the pointer on the empty top bar and drop focus so no tooltip or focus ring shows.
    await page.mouse.move(900, 26);
    await page.evaluate(() => document.activeElement?.blur?.());
    await wait(ms);
  };
  const shot = async (name, el) => {
    await settle();
    const path = join(out, name);
    if (el) await el.screenshot({ path });
    else await page.screenshot({ path });
    console.log("wrote", path);
  };

  // Unfold the sections shown below (a fresh start opens only the first).
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("#panel details.section"))
      if (["Depth model", "Levels & curve"].includes(d.querySelector(".title")?.textContent)) d.open = true;
  });
  await page.setInputFiles("#file-input", sample);
  await until(() => page.evaluate(() => !!window.__rds.state.latest), "depth");
  await page.getByRole("button", { name: "Auto levels" }).click();
  await until(() => page.evaluate(() => window.__rds.state.autoLevelsDone > 0), "auto levels");
  await wait(1500);
  await page.evaluate(() => (document.getElementById("panel").scrollTop = 0));
  await shot("compare.png");

  // Crop editor.
  await page.click("#btn-edit-crop");
  await shot("crop-editor.png");
  await page.click("#btn-edit-crop");

  // Cross-section through the eyes, with the hover readout.
  await page.click("#btn-profile");
  const box = await page.locator("#pane-right").boundingBox();
  await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.47);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.47, { steps: 10 });
  await page.mouse.up();
  await wait(400);
  await page.mouse.move(900, 26);
  const prof = await page.locator("#profile canvas").boundingBox();
  await page.mouse.move(prof.x + prof.width * 0.42, prof.y + prof.height * 0.5);
  await wait(400);
  await page.screenshot({ path: join(out, "cross-section.png") });
  console.log("wrote", join(out, "cross-section.png"));
  await page.click("#btn-profile");

  // Panel close-ups: model + license, and levels + curve with a gentle S-curve.
  const section = (title) => page.locator("details.section", { hasText: title }).first();
  await section("Depth model").scrollIntoViewIfNeeded();
  await shot("model-licenses.png", section("Depth model"));
  const curve = page.locator('canvas[aria-label^="Tone curve"]');
  await curve.scrollIntoViewIfNeeded();
  const cb = await curve.boundingBox();
  const pt = (x, y) => [cb.x + 10 + x * (cb.width - 20), cb.y + 10 + (1 - y) * (cb.height - 20)];
  for (const [x, y] of [[0.3, 0.22], [0.7, 0.8]]) {
    const [px, py] = pt(x, x);
    const [tx, ty] = pt(x, y);
    await page.mouse.move(px, py);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 5 });
    await page.mouse.up();
  }
  await wait(1200);
  await section("Levels & curve").scrollIntoViewIfNeeded();
  await shot("levels-curve.png", section("Levels & curve"));
  await page.getByRole("button", { name: "Reset curve" }).click();
  await wait(1200);

  // 3D view with a low, raking light.
  await page.click('.tab[data-view="3d"]');
  await until(() => page.locator("#view-3d canvas").count(), "3D view");
  const ranges = page.locator("#view-3d .overlay-controls input[type=range]");
  await ranges.nth(0).fill("6");
  await ranges.nth(2).fill("28");
  await wait(2500);
  await shot("3d.png");

  // Slices view part-way through the passes.
  await page.click('.tab[data-view="slices"]');
  await page.locator(".slices-side input[type=range]").fill("96");
  await shot("slices.png");

  const blender = join(root, "samples/demo/coin-toby_blender-preview.png");
  if (existsSync(blender)) copyFileSync(blender, join(out, "blender.png"));
  console.log("done");
} catch (err) {
  console.error(String(err));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.kill("SIGINT");
}
