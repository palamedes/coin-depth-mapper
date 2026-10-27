// Lite mode check: serve the built page as plain static files (no Python backend) and run
// the in-browser model. Downloads ~100 MB of ONNX weights on first run.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = resolve(here, "../test-results");
mkdirSync(out, { recursive: true });
const port = 8792;
const chromePath = process.env.CHROME ?? ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", join(root, "src/relief_depth_studio/web")], { stdio: "ignore" });
const check = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); console.log(`  ok  ${m}`); };
let browser;
try {
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#panel .section");
  check((await page.locator("#device").textContent()) === "Browser only", "no backend detected: browser-only mode");
  const models = await page.locator("#panel select[aria-label=Model] option").allTextContents();
  check(models.length === 1 && /in browser/.test(models[0]), `only the in-browser model is offered (${models.join(", ")})`);
  const t0 = Date.now();
  await page.setInputFiles("#file-input", join(root, "samples/coin-toby.webp"));
  for (;;) {
    const st = await page.evaluate(() => window.__rds.state);
    if (st.latest) break;
    if (Date.now() - t0 > 600_000) throw new Error("timeout waiting for in-browser depth");
    await new Promise((r) => setTimeout(r, 500));
  }
  const status = await page.locator("#status-text").textContent();
  console.log("  status:", status, `(${((Date.now() - t0) / 1000).toFixed(1)} s incl. download)`);
  check(/done/.test(status), "in-browser model produced a depth map");
  const gpu = await page.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())));
  console.log("  WebGPU adapter in this headless Chrome:", gpu);
  await page.screenshot({ path: join(out, "lite.png") });
  // Projects without the backend: saved as a download, opened again from the file.
  const sum = () => page.evaluate(() => window.__rds.latestOut.out.reduce((a, v) => a + v, 0));
  const before = await sum();
  await page.keyboard.press("Control+s");
  await page.waitForSelector(".projects-dialog[open]");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".project-save .btn").click()]);
  const file = join(out, dl.suggestedFilename());
  await dl.saveAs(file);
  check(dl.suggestedFilename() === "Coin toby.rdsproj", `Save project downloads the project file (${dl.suggestedFilename()})`);
  await page.reload();
  await page.waitForSelector("#panel .section");
  await page.setInputFiles("#file-input", file);
  for (const t1 = Date.now(); !(await page.evaluate(() => window.__rds.state.latest)); ) {
    if (Date.now() - t1 > 60_000) throw new Error("timeout waiting for the project to open");
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 1000));
  check(/^Opened/.test(await page.locator("#status-text").textContent()) && Math.abs((await sum()) - before) < 1e-6,
    "opening it brings back the same depth map without running the model");
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  console.log("LITE E2E PASSED");
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}
