// Slice preview: which pixels LightBurn's 3D Sliced mode fires on pass k of N.

import { firesOnPass, passesFor, quantize } from "../proc/slices";
import { h, helpIcon } from "./dom";

export interface SliceData {
  out: Float32Array;
  w: number;
  h: number;
  bits: 8 | 16;
  passes: number;
  distinct8: number;
  distinct16: number;
  min8: number;
  max8: number;
}

export class SlicesView {
  private canvas = h("canvas");
  private pass = 1;
  private data: SliceData | null = null;
  private passInput = h("input", { type: "range", min: 1, max: 256, step: 1, value: 1 }) as HTMLInputElement;
  private passVal = h("span", { class: "val" });
  private passesInput = h("input", { type: "number", min: 1, max: 5000, step: 1 }) as HTMLInputElement;
  private firing = h("div", { class: "note" });
  private stats = h("div", { class: "kv" });
  private warnings = h("div", {});
  private playBtn = h("button", { class: "btn ghost small" }, "Play");
  private timer = 0;

  constructor(root: HTMLElement, private onPasses: (n: number) => void) {
    root.append(
      h("div", { class: "slices-canvas-wrap" }, this.canvas),
      h(
        "div",
        { class: "slices-side" },
        h(
          "div",
          { class: "ctl" },
          h("span", { class: "lbl" }, "Number of passes", helpIcon("The Number of Passes you will set in LightBurn's 3D Sliced cut settings. 256 gives one pass per gray level of an 8-bit image.")),
          this.passesInput,
        ),
        h(
          "div",
          { class: "ctl" },
          h("span", { class: "lbl" }, "Show pass", helpIcon("Pick a pass to see which pixels the laser fires on during it (orange). Like LightBurn's preview, the engraved area grows with each pass: pass 1 is only the deepest spots, the last pass covers everything that isn't pure white.")),
          this.passVal,
          this.passInput,
        ),
        h("div", { class: "row" }, this.playBtn),
        this.firing,
        h("h4", { style: "margin:6px 0 0" }, "Gray levels in the export"),
        this.stats,
        this.warnings,
        h("p", { class: "note muted" }, "Model of LightBurn 3D Sliced: each pass engraves the pixels darker than that pass's threshold, thresholds evenly spaced from white to black. Pure white gets no passes, pure black gets all of them."),
      ),
    );
    this.passInput.addEventListener("input", () => {
      this.pass = Number(this.passInput.value);
      this.draw();
    });
    this.passesInput.addEventListener("change", () => {
      const n = Math.max(1, Math.min(5000, Math.round(Number(this.passesInput.value) || 256)));
      this.onPasses(n);
    });
    this.playBtn.addEventListener("click", () => this.togglePlay());
  }

  private togglePlay() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = 0;
      this.playBtn.textContent = "Play";
      return;
    }
    this.playBtn.textContent = "Stop";
    const n = this.data?.passes ?? 256;
    const stepSize = Math.max(1, Math.round(n / 120));
    this.timer = window.setInterval(() => {
      this.pass = this.pass >= n ? 1 : Math.min(n, this.pass + stepSize);
      this.passInput.value = String(this.pass);
      this.draw();
    }, 50);
  }

  stop() {
    if (this.timer) this.togglePlay();
  }

  set(d: SliceData) {
    this.data = d;
    this.passInput.max = String(d.passes);
    this.passesInput.value = String(d.passes);
    this.pass = Math.min(this.pass, d.passes);
    this.passInput.value = String(this.pass);
    const max = d.bits === 16 ? 65535 : 255;
    const deepest = passesFor(quantize(d.min8 / 255, d.bits), max, d.passes);
    const shallowest = passesFor(quantize(d.max8 / 255, d.bits), max, d.passes);
    this.stats.replaceChildren(
      h("span", {}, "8-bit levels used"), h("b", {}, `${d.distinct8} of 256`),
      h("span", {}, "16-bit values used"), h("b", {}, d.distinct16.toLocaleString()),
      h("span", {}, "Darkest / lightest"), h("b", {}, `${d.min8} / ${d.max8}`),
      h("span", {}, "Passes on deepest pixel"), h("b", {}, `${deepest} of ${d.passes}`),
      h("span", {}, "Passes on highest pixel"), h("b", {}, String(shallowest)),
    );
    const warn: HTMLElement[] = [];
    if (d.min8 > 2)
      warn.push(h("p", { class: "note warn" }, `The darkest pixel is gray ${d.min8}, not 0, so the deepest spot gets only ${deepest} of ${d.passes} passes and some depth goes unused. Pull the Levels black point up to use the full range.`));
    if (d.max8 < 253)
      warn.push(h("p", { class: "note warn" }, `The lightest pixel is gray ${d.max8}, not 255, so every pixel gets at least ${shallowest} pass(es): the whole surface will be engraved. Lower the Levels white point if the top should stay untouched.`));
    if (d.bits === 8 && d.distinct8 < 128)
      warn.push(h("p", { class: "note warn" }, `Only ${d.distinct8} gray levels are in use, so depth steps will be coarse. Widen the range with Levels or export 16-bit.`));
    this.warnings.replaceChildren(...warn);
    this.draw();
  }

  private draw() {
    const d = this.data;
    if (!d) return;
    this.passVal.textContent = `${this.pass} of ${d.passes}`;
    const c = this.canvas;
    if (c.width !== d.w || c.height !== d.h) {
      c.width = d.w;
      c.height = d.h;
    }
    const g = c.getContext("2d")!;
    const img = g.createImageData(d.w, d.h);
    const px = img.data;
    const max = d.bits === 16 ? 65535 : 255;
    let fired = 0;
    for (let i = 0, j = 0; i < d.out.length; i++, j += 4) {
      const v = d.out[i];
      if (firesOnPass(quantize(v, d.bits), max, d.passes, this.pass)) {
        fired++;
        px[j] = 255;
        px[j + 1] = 107;
        px[j + 2] = 26;
      } else {
        const gray = 20 + v * 70;
        px[j] = px[j + 1] = px[j + 2] = gray;
      }
      px[j + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.firing.textContent = `Pass ${this.pass} fires on ${((100 * fired) / d.out.length).toFixed(1)}% of the image.`;
  }
}
