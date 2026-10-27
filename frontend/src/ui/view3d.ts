// 3D preview: the depth map as a displaced, lit metal surface. Loaded on demand.
// Drawn by the GPU with WebGL when the browser has it, otherwise by a software renderer in a web
// worker (see softRender.ts). The camera, controls and settings are shared by both.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { resize, makeImg } from "../proc/image";
import type { SoftRequest, SoftResponse } from "../softWorker";
import { h, helpIcon } from "./dom";

export interface ReliefData {
  out: Float32Array;
  w: number;
  h: number;
  widthMM: number;
  heightMM: number;
  depthMM: number;
}

const METALS: Record<string, { color: number; roughness: number }> = {
  "Polished steel": { color: 0xd9dde2, roughness: 0.22 },
  "Brushed steel": { color: 0xc7ccd2, roughness: 0.45 },
  Brass: { color: 0xd8b46a, roughness: 0.3 },
  Copper: { color: 0xd08a5a, roughness: 0.32 },
};

/** Lighting and surface, in the scene's terms. */
interface Look {
  light: THREE.Vector3; // unit vector toward the light
  size: number; // longer side of the piece in mm
  color: THREE.Color; // linear RGB
  roughness: number;
}

/** What the view needs from a renderer. */
interface Surface {
  readonly canvas: HTMLCanvasElement;
  setRelief(d: ReliefData, zScale: number, grid: number): void;
  setLook(look: Look): void;
  setSize(w: number, h: number): void;
  draw(camera: THREE.PerspectiveCamera): void;
}

class GLSurface implements Surface {
  readonly canvas = document.createElement("canvas");
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private light = new THREE.DirectionalLight(0xffffff, 2.2);
  private material = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.22, side: THREE.DoubleSide });
  private mesh: THREE.Mesh | null = null;
  private frame = 0;

  /** Throws if the browser can't provide WebGL. */
  constructor() {
    // Ask for the context ourselves so a missing WebGL is a clean "no" rather than three.js console errors.
    const context = this.canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!context) throw new Error("WebGL is not available");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, context, antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.background = new THREE.Color(0x0b0c0e);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.add(this.light, this.light.target, new THREE.AmbientLight(0xffffff, 0.08));
  }

  setRelief(d: ReliefData, zScale: number, grid: number) {
    const scale = Math.min(1, grid / Math.max(d.w, d.h));
    const small = resize(makeImg(d.w, d.h, d.out), Math.max(2, Math.round(d.w * scale)), Math.max(2, Math.round(d.h * scale)));
    const geo = new THREE.PlaneGeometry(d.widthMM, d.heightMM, small.w - 1, small.h - 1);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, small.data[i] * zScale);
    geo.computeVertexNormals();
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geo;
    } else {
      this.mesh = new THREE.Mesh(geo, this.material);
      this.scene.add(this.mesh);
    }
  }

  setLook(look: Look) {
    this.light.position.copy(look.light).multiplyScalar(look.size * 2);
    this.material.color.copy(look.color);
    this.material.roughness = look.roughness;
  }

  setSize(w: number, h: number) {
    this.renderer.setSize(w, h);
  }

  draw(camera: THREE.PerspectiveCamera) {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.renderer.render(this.scene, camera));
  }
}

/** Renders in a web worker and shows the result on a 2D canvas. Drags get quick low-res frames, then a full one. */
class SoftSurface implements Surface {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private worker = new Worker(new URL("../softWorker.ts", import.meta.url), { type: "module" });
  private size = { w: 1, h: 1 };
  private look: Look | null = null;
  private grid = 384;
  private camera: THREE.PerspectiveCamera | null = null;
  private busy = false;
  private queued: "draft" | "full" | null = null;
  private lastDraw = 0;
  private settle = 0;
  private viewProj = new THREE.Matrix4();

  constructor() {
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.worker.onmessage = (e: MessageEvent<SoftResponse>) => {
      const { width, height, pixels, ms } = e.data;
      if (pixels) {
        if (this.canvas.width !== width || this.canvas.height !== height) {
          this.canvas.width = width;
          this.canvas.height = height;
        }
        this.ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
        this.canvas.dataset.frameMs = ms.toFixed(0); // for tests and the curious
      }
      this.busy = false;
      const next = this.queued;
      this.queued = null;
      if (next) this.request(next);
    };
  }

  private post(msg: SoftRequest) {
    this.worker.postMessage(msg);
  }

  setRelief(d: ReliefData, zScale: number, grid: number) {
    this.grid = grid;
    this.post({ type: "relief", data: d.out, w: d.w, h: d.h, widthMM: d.widthMM, heightMM: d.heightMM, zScale });
  }

  setLook(look: Look) {
    this.look = look;
  }

  setSize(w: number, h: number) {
    this.size = { w, h };
  }

  draw(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    // Redraws in quick succession (dragging the view or a slider) get a fast draft; a full frame follows.
    const now = performance.now();
    const draft = now - this.lastDraw < 250;
    this.lastDraw = now;
    clearTimeout(this.settle);
    if (draft) this.settle = window.setTimeout(() => this.request("full"), 250);
    this.request(draft ? "draft" : "full");
  }

  private request(quality: "draft" | "full") {
    if (this.busy) {
      this.queued = quality;
      return;
    }
    const camera = this.camera;
    const look = this.look;
    if (!camera || !look) return;
    const scale = Math.min(devicePixelRatio, 1.5) * (quality === "draft" ? 0.6 : 1);
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.busy = true;
    this.post({
      type: "frame",
      spec: {
        width: Math.max(1, Math.round(this.size.w * scale)),
        height: Math.max(1, Math.round(this.size.h * scale)),
        viewProj: this.viewProj.elements.slice(),
        camera: [camera.position.x, camera.position.y, camera.position.z],
        light: [look.light.x, look.light.y, look.light.z],
        color: [look.color.r, look.color.g, look.color.b],
        roughness: look.roughness,
        grid: quality === "draft" ? Math.min(this.grid, 192) : this.grid,
      },
    });
  }
}

export class View3D {
  /** "gpu" when WebGL works, otherwise "software". */
  readonly mode: "gpu" | "software";
  private surface: Surface;
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
  private controls: OrbitControls;
  private data: ReliefData | null = null;
  private opts = { exaggeration: 4, azimuth: 135, elevation: 35, grid: 384, metal: "Polished steel" };

  constructor(private root: HTMLElement) {
    try {
      this.surface = new GLSurface();
      this.mode = "gpu";
    } catch {
      this.surface = new SoftSurface();
      this.mode = "software";
    }
    root.dataset.renderer = this.mode;
    root.append(this.surface.canvas);
    this.controls = new OrbitControls(this.camera, this.surface.canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", () => this.render());
    root.append(this.buildControls());
    this.updateLook();
    new ResizeObserver(() => this.resize()).observe(root);
  }

  private buildControls(): HTMLElement {
    const slider = (label: string, tip: string, key: "exaggeration" | "azimuth" | "elevation", min: number, max: number, step: number, unit: string) => {
      const val = h("span", { class: "val" }, `${this.opts[key]}${unit}`);
      const input = h("input", { type: "range", min, max, step, value: this.opts[key] }) as HTMLInputElement;
      input.addEventListener("input", () => {
        this.opts[key] = Number(input.value);
        val.textContent = `${input.value}${unit}`;
        if (key === "exaggeration") this.rebuild();
        else this.updateLook();
      });
      return h("div", { class: "ctl" }, h("span", { class: "lbl" }, label, helpIcon(tip)), val, input);
    };
    const select = (label: string, tip: string, options: string[], value: string, on: (v: string) => void) => {
      const s = h("select", {}, ...options.map((o) => h("option", { value: o, selected: o === value }, o))) as HTMLSelectElement;
      s.addEventListener("change", () => on(s.value));
      return h("div", { class: "ctl" }, h("span", { class: "lbl" }, label, helpIcon(tip)), h("span"), s);
    };
    const renderer =
      this.mode === "gpu"
        ? h("div", { class: "note renderer" }, "Drawn on the GPU (WebGL).")
        : h(
            "div",
            { class: "note renderer" },
            "Drawn in software (no WebGL). ",
            helpIcon(
              "Your browser has no WebGL, usually because graphics acceleration is turned off, so the CPU draws this view. " +
                "It looks the same but is slower while you drag. For a smoother view, turn graphics acceleration on " +
                "(Chrome or Edge: Settings → System; Firefox: Settings → General → Performance) and restart the browser.",
            ),
          );
    return h(
      "div",
      { class: "overlay-controls" },
      slider("Height exaggeration", "Stretch the relief vertically so shallow detail is easier to see. Only affects this preview.", "exaggeration", 1, 30, 0.5, "×"),
      slider("Light direction", "Which side the main light comes from, like turning the piece under a lamp.", "azimuth", 0, 360, 1, "°"),
      slider("Light height", "Low light rakes across the surface and shows small bumps and pits; high light shows overall shape.", "elevation", 3, 88, 1, "°"),
      select("Metal", "Surface look for the preview.", Object.keys(METALS), this.opts.metal, (v) => {
        this.opts.metal = v;
        this.updateLook();
      }),
      select("Mesh detail", "Vertices along the longer side. Higher shows finer detail but is slower to build.", ["192", "384", "768"], String(this.opts.grid), (v) => {
        this.opts.grid = Number(v);
        this.rebuild();
      }),
      h("button", { class: "btn ghost small", onclick: () => this.resetCamera() }, "Reset view"),
      h("div", { class: "note" }, "Drag to rotate, right-drag to pan, wheel to zoom."),
      renderer,
    );
  }

  setData(d: ReliefData) {
    const first = !this.data || this.data.widthMM !== d.widthMM;
    this.data = d;
    this.rebuild();
    if (first) this.resetCamera();
  }

  private rebuild() {
    const d = this.data;
    if (!d) return;
    this.surface.setRelief(d, d.depthMM * this.opts.exaggeration, this.opts.grid);
    this.updateLook();
  }

  private updateLook() {
    const d = this.data;
    const az = (this.opts.azimuth * Math.PI) / 180;
    const el = (this.opts.elevation * Math.PI) / 180;
    const metal = METALS[this.opts.metal];
    this.surface.setLook({
      light: new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)),
      size: d ? Math.max(d.widthMM, d.heightMM) : 40,
      color: new THREE.Color(metal.color),
      roughness: metal.roughness,
    });
    this.render();
  }

  private resetCamera() {
    const d = this.data;
    const size = d ? Math.max(d.widthMM, d.heightMM) : 40;
    this.camera.position.set(0, -size * 1.1, size * 1.5);
    this.camera.up.set(0, 0, 1);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.render();
  }

  private resize() {
    const r = this.root.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.surface.setSize(r.width, r.height);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.surface.draw(this.camera);
  }
}
