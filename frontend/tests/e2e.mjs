// End-to-end test: start the app, drive it in headless Chrome, export, and verify the files.
//
//   npm run e2e                         # synthetic coin (has a known height map)
//   npm run e2e -- ../samples/coin-westie.webp
//
// Needs Google Chrome or Chromium installed (set CHROME=/path/to/chrome if it isn't found).
// Screenshots and exports go to frontend/test-results/.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = resolve(here, "../test-results");
mkdirSync(out, { recursive: true });
const sample = resolve(process.argv[2] ?? join(root, "samples/synthetic-coin.png"));
const synthetic = sample.endsWith("synthetic-coin.png");
const port = Number(process.env.PORT ?? 8791);
const url = `http://127.0.0.1:${port}/`;

const chromePath =
  process.env.CHROME ??
  ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
   "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find(existsSync);
if (!chromePath) throw new Error("Chrome not found; set CHROME=/path/to/chrome");

function check(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok  ${msg}`);
}

async function waitFor(fn, what, timeout = 180_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const server = spawn(join(root, "depthmap"), ["--no-browser", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let browser;
try {
  await waitFor(async () => fetch(url + "api/system").then((r) => r.ok).catch(() => false), "server", 120_000);
  console.log(`server up at ${url}`);
  browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {}
  });
  await page.reload();
  await page.waitForSelector("#panel .section");
  check(await page.locator(".section").count() === 11, "control panel shows 11 pipeline sections");
  check((await page.locator("#device").textContent()).length > 3, `device badge: ${await page.locator("#device").textContent()}`);

  // Every control has a plain-language tooltip.
  const untipped = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#panel input[type=range], #panel select, #panel input[type=number]"))
      .filter((el) => !el.closest(".ctl")?.querySelector("[data-tip]")).length,
  );
  check(untipped === 0, "every slider/select/number in the panel has a tooltip");

  // Open the image through the real file input.
  await page.setInputFiles("#file-input", sample);
  await waitFor(() => page.evaluate(() => window.__rds.state.latest), "first depth result");
  const st = await page.evaluate(() => window.__rds.state);
  check(st.rings >= 1, `coin outline detected (${st.rings} ring candidates)`);
  check(!st.stale, "depth is up to date with the crop");
  const crop = await page.evaluate(() => window.__rds.settings.crop.circle);
  console.log("  crop circle", crop);
  if (synthetic) check(Math.abs(crop.r - 450.6) < 12 && Math.abs(crop.cx - 512) < 6, "synthetic coin circle found within 2.5%");

  // Auto levels, then the map should span (almost) the full range.
  await page.getByRole("button", { name: "Auto levels" }).click();
  await waitFor(() => page.evaluate(() => window.__rds.state.autoLevelsDone > 0), "auto levels");
  await page.waitForTimeout(1500);
  const lvl = await page.evaluate(() => window.__rds.state.latest);
  check(lvl.min8 <= 2 && lvl.max8 >= 250, `after Auto levels the map spans ${lvl.min8}..${lvl.max8}`);
  check(lvl.distinct8 > 200, `uses ${lvl.distinct8} of 256 gray levels`);
  // Levels handles: the gray midtone triangle drags gamma; black/white stay put.
  const levelsCanvas = page.locator('canvas[aria-label^="Histogram of heights"]');
  await levelsCanvas.scrollIntoViewIfNeeded();
  const lb = await levelsCanvas.boundingBox();
  const hx = (v) => lb.x + 8 + v * (lb.width - 16);
  const handleY = lb.y + 86;
  const lv = () => page.evaluate(() => ({ ...window.__rds.settings.levels }));
  const drag = async (from, to) => {
    await page.mouse.move(from, handleY);
    await page.mouse.down();
    await page.mouse.move(to, handleY, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  };
  let L0 = await lv();
  const midOf = (L) => L.black + (L.white - L.black) * Math.pow(0.5, L.gamma);
  await drag(hx(midOf(L0)), hx(midOf(L0)) - lb.width * 0.15);
  let L1 = await lv();
  check(L1.gamma > L0.gamma + 0.2 && L1.black === L0.black && L1.white === L0.white,
    `dragging the gray handle left raises gamma ${L0.gamma} -> ${L1.gamma}, black/white unchanged`);
  await drag(hx(midOf(L1)), hx(midOf(L1)) + lb.width * 0.3);
  const L2 = await lv();
  check(L2.gamma < 1 && L2.black === L0.black && L2.white === L0.white, `dragging it right lowers gamma to ${L2.gamma}`);
  const gammaSlider = await page.locator('#panel input[aria-label="Gamma"]').inputValue();
  check(Math.abs(Number(gammaSlider) - L2.gamma) < 1e-6, "gamma slider follows the handle");
  await drag(hx(L2.black), hx(L2.black) + lb.width * 0.1);
  const L3 = await lv();
  check(L3.black > L2.black + 0.05 && L3.gamma === L2.gamma, "black handle still drags on its own");
  await page.evaluate(() => {
    const l = window.__rds.settings.levels;
    Object.assign(l, { black: 0, white: 1, gamma: 1 });
    window.__rds.change("post");
  });
  await page.getByRole("button", { name: "Auto levels" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, "compare.png") });

  // Cross-section: draw a line across the depth pane.
  await page.click("#btn-profile");
  const box = await page.locator("#pane-right").boundingBox();
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height + 120);
  await page.waitForTimeout(300);
  check(await page.locator("#profile .hint").isHidden(), "cross-section chart shows a profile");
  await page.screenshot({ path: join(out, "profile.png") });
  await page.click("#btn-profile");

  // Crop editor.
  await page.click("#btn-edit-crop");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, "crop-editor.png") });
  await page.click("#btn-edit-crop");

  // 3D view.
  await page.click('.tab[data-view="3d"]');
  await waitFor(() => page.locator("#view-3d canvas").count(), "3D canvas");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, "3d.png") });

  // Slices view.
  await page.click('.tab[data-view="slices"]');
  await page.waitForTimeout(500);
  const sliceText = await page.locator(".slices-side").textContent();
  check(/levels used/.test(sliceText), "slice view shows gray level stats");
  const range = page.locator(".slices-side input[type=range]");
  await range.fill("128");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, "slices.png") });
  await page.click('.tab[data-view="compare"]');

  // Export 16-bit PNG at 40 mm / 1000 DPI.
  await page.evaluate(() => {
    const s = window.__rds.settings;
    s.output.widthMM = 40;
    s.output.dpi = 1000;
    s.output.bits = 16;
    window.__rds.change("size");
  });
  await page.waitForTimeout(500);
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.getByRole("button", { name: "Export PNG" }).click()]);
  const pngPath = join(out, dl.suggestedFilename());
  await dl.saveAs(pngPath);
  check(/_40mm_1000dpi_16bit\.png$/.test(pngPath), `PNG export: ${dl.suggestedFilename()}`);

  await page.locator("details.section", { hasText: "3D preview & STL" }).locator("summary").click();
  const [dl2] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.getByRole("button", { name: "Export STL" }).click()]);
  const stlPath = join(out, dl2.suggestedFilename());
  await dl2.saveAs(stlPath);
  const stl = readFileSync(stlPath);
  const tris = stl.readUInt32LE(80);
  check(stl.length === 84 + 50 * tris && tris > 100_000, `STL export: ${tris.toLocaleString()} triangles`);

  // Independent check of the PNG with Pillow.
  const py = join(root, ".venv/bin/python");
  const report = JSON.parse(
    execFileSync(py, [join(root, "tests/check_export.py"), pngPath, synthetic ? join(root, "samples/synthetic-coin-height.png") : ""], { encoding: "utf8" }),
  );
  console.log("  png", report);
  check(report.mode === "I;16" && report.size[0] === 1575 && report.size[1] === 1575, "PNG is 16-bit grayscale, 1575 × 1575 px (40 mm at 1000 DPI)");
  check(Math.abs(report.dpi[0] - 1000) < 0.5, `PNG says ${report.dpi[0].toFixed(2)} DPI`);
  check(report.min === 0 && report.max === 65535, "PNG uses the full 0..65535 range");
  check(report.outside_mean < 50, "outside the coin is black (deepest) by default");
  if (synthetic) check(report.corr > 0.75, `export matches the true relief height (correlation ${report.corr.toFixed(3)})`);

  check(errors.length === 0, `no browser console errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  writeFileSync(join(out, "report.json"), JSON.stringify({ sample, report, tris }, null, 2));
  console.log("E2E PASSED");
} catch (err) {
  console.error(String(err));
  console.error("--- server log ---\n" + serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGINT");
}
