// End-to-end test: start the app, drive it in headless Chrome, export, and verify the files.
//
//   npm run e2e                         # synthetic coin (has a known height map)
//   npm run e2e -- ../samples/coin-toby.webp
//
// Needs Google Chrome or Chromium installed (set CHROME=/path/to/chrome if it isn't found).
// Screenshots and exports go to frontend/test-results/.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// Projects saved by the test go to a temporary folder, not the real projects folder.
const projectsDir = mkdtempSync(join(tmpdir(), "rds-e2e-projects-"));
const server = spawn(join(root, "depthmap"), ["--no-browser", "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, RDS_PROJECTS_DIR: projectsDir },
});
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
  const dialogs = [];
  page.on("dialog", (d) => (dialogs.push(d.message()), d.accept()));
  let depthRuns = 0;
  page.on("request", (r) => r.url().endsWith("/api/depth") && depthRuns++);
  // Count what the page sends its workers, by message type.
  await page.addInitScript(() => {
    window.__posts = {};
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, t) {
      window.__posts[m.type] = (window.__posts[m.type] ?? 0) + 1;
      return orig.call(this, m, t);
    };
  });
  await page.goto(url);
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {}
  });
  await page.reload();
  await page.waitForSelector("#panel .section");
  check(await page.locator(".section").count() === 14, "control panel shows 14 sections");
  // A fresh start unfolds only the first section; the rest open as they're needed.
  const openTitles = () => page.evaluate(() => [...document.querySelectorAll("#panel details.section[open] .title")].map((t) => t.textContent));
  const openSection = async (title) => {
    if (!(await openTitles()).includes(title)) await page.locator("#panel details.section > summary").filter({ hasText: title }).first().click();
  };
  check(String(await openTitles()) === "Image", "a fresh start opens only the first section");
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
  await openSection("Levels & curve");
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

  // 3D view. Headless Chrome has WebGL (in software), so this is the GPU path.
  await page.click('.tab[data-view="3d"]');
  await waitFor(() => page.locator("#view-3d canvas").count(), "3D canvas");
  check((await page.locator("#view-3d").getAttribute("data-renderer")) === "gpu", "3D view draws with WebGL when the browser has it");
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
  await openSection("Output & export");
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.getByRole("button", { name: "Export PNG" }).click()]);
  const pngPath = join(out, dl.suggestedFilename());
  await dl.saveAs(pngPath);
  check(/_40mm_1000dpi_16bit\.png$/.test(pngPath), `PNG export: ${dl.suggestedFilename()}`);

  await openSection("3D preview & STL");
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

  // A cut-out (transparent background) goes on the first coin in the coins folder, with its own depth.
  await page.setInputFiles("#file-input", join(root, "samples/toby.webp"));
  const ready = () => page.evaluate(() => { const s = window.__rds.state; return s.subject?.depth && s.depth && !s.busy && !s.stale && s.latest; });
  await waitFor(ready, "depth of the coin and the cut-out");
  const cs = await page.evaluate(() => window.__rds.state);
  check(cs.subject.name === "toby.webp" && cs.source.coin && (cs.coins.length ? cs.source.name === cs.coins[0] : cs.source.plain),
    `a cut-out goes on the coin ${cs.source.plain ? "(a plain disc: the coins folder is empty)" : cs.source.name}`);
  if (cs.coins.length) check(await page.locator(".coin-tile.on").count() === 1, "and that coin is highlighted in the coin library");
  const mapSum = () => page.evaluate(() => window.__rds.latestOut.out.reduce((a, v) => a + v, 0));
  const sum0 = await mapSum();
  await page.click("#btn-place");
  const rp = await page.locator("#pane-right").boundingBox();
  await page.mouse.move(rp.x + rp.width / 2, rp.y + rp.height / 2);
  await page.mouse.down();
  await page.mouse.move(rp.x + rp.width / 2 + 80, rp.y + rp.height / 2, { steps: 8 });
  await page.mouse.up();
  await waitFor(async () => (await mapSum()) !== sum0, "the depth map to follow the subject");
  const moved = await page.evaluate(() => ({ ...window.__rds.settings.subject, ...window.__rds.state }));
  check(moved.x > 0.03 && Math.abs(moved.y) < 0.01, `dragging moves the subject (x ${moved.x}, y ${moved.y})`);
  check(!moved.stale && !moved.busy, "moving it needs no new model run");
  // Text: "Add text" puts the subject's name around the top in raised letters.
  await openSection("Text");
  await page.getByRole("button", { name: "Add text" }).click();
  const topBand = () => page.evaluate(() => {
    const l = window.__rds.latestOut;
    let max = 0;
    for (let y = Math.round(l.h * 0.05); y < l.h * 0.16; y++) for (let x = Math.round(l.w * 0.35); x < l.w * 0.65; x++) max = Math.max(max, l.out[y * l.w + x]);
    return max;
  });
  await waitFor(async () => (await topBand()) > 0.97, "raised lettering along the top");
  check((await page.locator(".text-card .text-input").inputValue()) === "TOBY", "a new text layer starts with the subject's name, raised along the top");
  // The coin's own levels change the coin, not the subject.
  const subjectPeak = () => page.evaluate(() => window.__rds.latestOut.out.reduce((a, v) => Math.max(a, v), 0));
  const peak0 = await subjectPeak();
  const coinSum0 = await mapSum();
  await page.evaluate(() => { window.__rds.settings.coin.tone.gamma = 3; window.__rds.change("post"); });
  await waitFor(async () => Math.abs((await mapSum()) - coinSum0) > 100, "coin levels to apply");
  check(Math.abs((await subjectPeak()) - peak0) < 1e-6, "the coin's own levels leave the subject's top alone");
  // Each layer's levels live on its tab in Levels & curve; Strength turns the layer's relief down
  // (or up), whether or not its levels and curve were changed.
  // Waits until the map stops changing (no run in flight, the same sum a few times running).
  const settled = async () => {
    let last = await mapSum();
    for (let still = 0; still < 6; ) {
      await page.waitForTimeout(150);
      const now = await mapSum();
      const busy = await page.evaluate(() => window.__rds.state.busy);
      still = now === last && !busy ? still + 1 : 0;
      last = now;
    }
    return last;
  };
  const levelsSec = page.locator("#panel .section").filter({ has: page.locator(".seg") });
  check(String(await levelsSec.locator(".seg-btn").allTextContents()) === "Master,Coin,Subject", "Levels & curve has Master, Coin and Subject tabs");
  const slide = (label, v) => levelsSec.locator(`input[aria-label="${label}"]`).evaluate((e, v) => {
    e.value = String(v);
    e.dispatchEvent(new Event("input", { bubbles: true }));
  }, v);
  const slideTo = async (label, v, what) => {
    const before = await mapSum();
    await slide(label, v);
    await waitFor(async () => Math.abs((await mapSum()) - before) > 100, what);
    return settled();
  };
  await page.evaluate(() => { Object.assign(window.__rds.settings.coin.tone, { gamma: 1 }); window.__rds.change("post"); });
  await levelsSec.getByRole("tab", { name: "Coin" }).click();
  const coinFull = await settled();
  const coinHalf = await slideTo("Strength", 0.5, "coin strength 50% to apply");
  check(coinHalf < coinFull - 100, `coin strength 50% lowers the coin's relief with its levels untouched (${Math.round(coinFull)} -> ${Math.round(coinHalf)})`);
  check(await levelsSec.locator(".seg-btn.on.changed").count() === 1, "the Coin tab is marked as changed");
  check(Math.abs((await slideTo("Strength", 1, "coin strength 100% to apply")) - coinFull) < 1, "coin strength back to 100% gives back the same map");
  await levelsSec.getByRole("tab", { name: "Subject" }).click();
  // The middle of the map, where the subject is.
  const middle = () => page.evaluate(() => {
    const l = window.__rds.latestOut;
    let sum = 0, n = 0;
    for (let y = Math.round(l.h * 0.4); y < l.h * 0.6; y++) for (let x = Math.round(l.w * 0.4); x < l.w * 0.6; x++) sum += l.out[y * l.w + x], n++;
    return sum / n;
  });
  const subFull = await settled();
  const midFull = await middle();
  const subFlat = await slideTo("Strength", 0, "subject strength 0% to apply");
  const midFlat = await middle();
  const subHalf = await slideTo("Strength", 0.5, "subject strength 50% to apply");
  check(midFlat < midFull - 0.1, `subject strength 0% lays it flat on the coin (middle of the map ${midFull.toFixed(3)} -> ${midFlat.toFixed(3)})`);
  check(Math.abs(subHalf - (subFlat + subFull) / 2) < 0.03 * Math.abs(subFull - subFlat),
    `subject strength 50% is about halfway: ${Math.round(subFlat)} / ${Math.round(subHalf)} / ${Math.round(subFull)}`);
  await page.evaluate(() => { window.__rds.settings.subject.tone.strength = 1; window.__rds.change("post"); });
  await page.screenshot({ path: join(out, "subject.png") });
  const [dl3] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.getByRole("button", { name: "Export PNG" }).click()]);
  check(/^toby_on_.+_40mm_1000dpi_16bit\.png$/.test(dl3.suggestedFilename()), `export is named after both: ${dl3.suggestedFilename()}`);

  // Dragging a text slider: the text is redrawn once per preview run, not once per mouse move.
  const position = page.locator(".text-card").first().locator('input[aria-label="Position"]');
  await position.scrollIntoViewIfNeeded();
  const pb = await position.boundingBox();
  await settled();
  await page.evaluate(() => (window.__posts = {}));
  await page.mouse.move(pb.x + pb.width * 0.5, pb.y + pb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(pb.x + pb.width * (0.5 + (0.25 * i) / 40), pb.y + pb.height / 2);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await settled();
  const posts = await page.evaluate(() => window.__posts);
  check(posts.texts > 1 && posts.texts <= posts.process, `dragging a text slider keeps up: ${posts.texts} text redraws for ${posts.process} preview runs (40 mouse moves)`);

  // Projects: save everything under a name, change it and save again, reload, and open it from the start screen.
  await page.click("#btn-projects");
  const suggested = await page.locator(".project-name-input").inputValue();
  check(/^Toby on /.test(suggested), `the Projects dialog suggests a name: "${suggested}"`);
  await page.locator(".project-save .btn").click();
  await waitFor(() => page.evaluate(() => window.__rds.project?.file && !window.__rds.project.dirty), "project saved");
  const savedFiles = readdirSync(projectsDir);
  check(savedFiles.length === 1 && savedFiles[0] === `${suggested}.rdsproj`, `saved "${savedFiles[0]}" in the projects folder`);
  const savedSum = await settled();
  await page.evaluate(() => { window.__rds.settings.subject.top = 0.85; window.__rds.change("subject"); });
  await waitFor(async () => (await mapSum()) !== savedSum, "the subject's height to change");
  check((await page.evaluate(() => window.__rds.project.dirty)) && (await page.locator("#btn-save.dirty").count()) === 1, "a change marks the project as edited");
  const editedSum = await settled();
  await page.keyboard.press("Control+s");
  await waitFor(() => page.evaluate(() => !window.__rds.project.dirty), "Ctrl+S to save");
  check(readdirSync(projectsDir).length === 1, "Ctrl+S saves over the same project");
  await page.click("#btn-projects");
  const [dlp] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download as file" }).click()]);
  const projectCopy = join(out, dlp.suggestedFilename());
  await dlp.saveAs(projectCopy);
  await page.keyboard.press("Escape");
  check(dlp.suggestedFilename() === savedFiles[0], `"Download as file" gives the project as one file (${dlp.suggestedFilename()})`);
  await page.reload();
  await page.waitForSelector("#recent:not([hidden]) .project-tile");
  check((await page.locator("#recent .project-name").allTextContents()).includes(suggested), "after a reload, the start screen lists the saved project");
  depthRuns = 0;
  await page.locator("#recent .project-open").first().click();
  await waitFor(() => page.evaluate(() => window.__rds.state.latest), "the project to open");
  const reopened = await page.evaluate(() => ({ ...window.__rds.state, top: window.__rds.settings.subject.top, texts: window.__rds.settings.texts.map((t) => t.text), project: window.__rds.project }));
  check(reopened.source?.coin && reopened.subject?.name === "toby.webp" && reopened.subject.depth && !reopened.stale && reopened.top === 0.85 && reopened.texts[0] === "TOBY",
    "opening it brings back the coin, the subject and its depth, the text and every setting");
  check((await openTitles()).length === 0, "an opened project starts with every section folded");
  check(Math.abs((await settled()) - editedSum) < 1e-6 && depthRuns === 0, "and the depth map is identical, with no model run");
  check(reopened.project.file === savedFiles[0] && !reopened.project.dirty, "it opens as the project being worked on (Ctrl+S saves over it)");
  await page.setInputFiles("#file-input", projectCopy);
  await waitFor(() => page.evaluate(() => /^Opened/.test(document.querySelector("#status-text").textContent)), "the project file to open");
  check((await page.evaluate(() => window.__rds.project.file)) === null && depthRuns === 0, "a project file opens like an image too (Open image…, or drag it in)");
  check(dialogs.length === 0, `no confirmation was needed for unchanged work${dialogs.length ? ": " + dialogs.join(" | ") : ""}`);
  await page.evaluate(() => { window.__rds.settings.subject.top = 0.8; window.__rds.change("subject"); });
  await page.click("#btn-projects");
  await page.locator(".projects-dialog .project-open").first().click();
  await waitFor(() => dialogs.length === 1, "a question before discarding changes");
  check(/aren't saved|isn't saved/.test(dialogs[0]), `opening a project asks first when there are unsaved changes ("${dialogs[0]}")`);
  await waitFor(() => page.evaluate(() => window.__rds.settings.subject.top === 0.85 && !window.__rds.project.dirty), "the saved project to open");
  await openSection("Subject");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  check((await page.evaluate(() => window.__rds.state.subject)) === null && (await page.locator("#btn-place").isHidden()), "Remove takes the subject off the coin");

  // A browser without WebGL (Chrome with graphics acceleration off): the 3D view is drawn in software.
  const noGL = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await noGL.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return String(type).startsWith("webgl") ? null : orig.call(this, type, ...rest);
    };
  });
  const page2 = await noGL.newPage();
  const errors2 = [];
  page2.on("pageerror", (e) => errors2.push(String(e)));
  page2.on("console", (m) => m.type() === "error" && errors2.push(m.text()));
  await page2.goto(url);
  await page2.waitForSelector("#panel .section");
  await page2.setInputFiles("#file-input", sample);
  await waitFor(() => page2.evaluate(() => window.__rds.state.latest), "depth result (no-WebGL page)");
  // First the viewer's code fails to download, as when the app was updated since the page was opened.
  await page2.route("**/assets/view3d-*.js", (r) => r.abort());
  await page2.click('.tab[data-view="3d"]');
  await waitFor(() => page2.locator("#view-3d .view-message").count(), "load-failure message");
  check(
    (await page2.locator("#progress").isHidden()) && /Reload the page/.test(await page2.locator("#view-3d .view-message").textContent()),
    "if the 3D code can't load, the tab says to reload instead of spinning",
  );
  await page2.unroute("**/assets/view3d-*.js");
  await Promise.all([page2.waitForEvent("load"), page2.getByRole("button", { name: "Reload page" }).click()]);
  errors2.length = 0; // the blocked download is logged; that's expected here
  await page2.waitForSelector("#panel .section");
  await page2.setInputFiles("#file-input", sample);
  await waitFor(() => page2.evaluate(() => window.__rds.state.latest), "depth result after reload");
  await page2.click('.tab[data-view="3d"]');
  const softCanvas = page2.locator("#view-3d canvas");
  await waitFor(() => page2.evaluate(() => document.querySelector("#view-3d canvas")?.dataset.frameMs), "software 3D frame");
  check((await page2.locator("#view-3d").getAttribute("data-renderer")) === "software", "without WebGL the 3D view is drawn in software");
  check(await page2.locator("#progress").isHidden(), "and the spinner stops");
  check(/Drawn in software/.test(await page2.locator("#view-3d .overlay-controls").textContent()), "the 3D controls say it is drawn in software");
  await page2.waitForTimeout(800);
  const pixels = () =>
    page2.evaluate(() => {
      const c = document.querySelector("#view-3d canvas");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 1] > 40) lit++;
        sum += d[i + 1];
      }
      return { lit: lit / (d.length / 4), sum, w: c.width, ms: c.dataset.frameMs };
    });
  const before = await pixels();
  check(before.lit > 0.2, `software 3D view draws the relief (${(before.lit * 100).toFixed(0)}% of the view, ${before.ms} ms per frame)`);
  const cb = await softCanvas.boundingBox();
  await page2.mouse.move(cb.x + cb.width * 0.3, cb.y + cb.height * 0.6);
  await page2.mouse.down();
  await page2.mouse.move(cb.x + cb.width * 0.45, cb.y + cb.height * 0.6, { steps: 12 });
  await page2.mouse.up();
  await page2.waitForTimeout(1200);
  const after = await pixels();
  check(after.sum !== before.sum && after.w === before.w, "dragging rotates the software view, then it redraws at full quality");
  await page2.screenshot({ path: join(out, "3d-software.png") });
  errors.push(...errors2);
  await noGL.close();

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
  rmSync(projectsDir, { recursive: true, force: true });
}
