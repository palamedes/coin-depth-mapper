// 3D preview: the depth map as a displaced, lit metal surface. Loaded on demand.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { resize, makeImg } from "../proc/image";
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

export class View3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
  private controls: OrbitControls;
  private light = new THREE.DirectionalLight(0xffffff, 2.2);
  private material = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.22, side: THREE.DoubleSide });
  private mesh: THREE.Mesh | null = null;
  private data: ReliefData | null = null;
  private opts = { exaggeration: 4, azimuth: 135, elevation: 35, grid: 384, metal: "Polished steel" };
  private frame = 0;

  constructor(private root: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    root.append(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0b0c0e);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.add(this.light, this.light.target, new THREE.AmbientLight(0xffffff, 0.08));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", () => this.render());
    root.append(this.buildControls());
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
        else this.placeLight();
      });
      return h("div", { class: "ctl" }, h("span", { class: "lbl" }, label, helpIcon(tip)), val, input);
    };
    const select = (label: string, tip: string, options: string[], value: string, on: (v: string) => void) => {
      const s = h("select", {}, ...options.map((o) => h("option", { value: o, selected: o === value }, o))) as HTMLSelectElement;
      s.addEventListener("change", () => on(s.value));
      return h("div", { class: "ctl" }, h("span", { class: "lbl" }, label, helpIcon(tip)), h("span"), s);
    };
    return h(
      "div",
      { class: "overlay-controls" },
      slider("Height exaggeration", "Stretch the relief vertically so shallow detail is easier to see. Only affects this preview.", "exaggeration", 1, 30, 0.5, "×"),
      slider("Light direction", "Which side the main light comes from, like turning the piece under a lamp.", "azimuth", 0, 360, 1, "°"),
      slider("Light height", "Low light rakes across the surface and shows small bumps and pits; high light shows overall shape.", "elevation", 3, 88, 1, "°"),
      select("Metal", "Surface look for the preview.", Object.keys(METALS), this.opts.metal, (v) => {
        this.opts.metal = v;
        this.material.color.setHex(METALS[v].color);
        this.material.roughness = METALS[v].roughness;
        this.render();
      }),
      select("Mesh detail", "Vertices along the longer side. Higher shows finer detail but is slower to build.", ["192", "384", "768"], String(this.opts.grid), (v) => {
        this.opts.grid = Number(v);
        this.rebuild();
      }),
      h("button", { class: "btn ghost small", onclick: () => this.resetCamera() }, "Reset view"),
      h("div", { class: "note" }, "Drag to rotate, right-drag to pan, wheel to zoom."),
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
    const scale = Math.min(1, this.opts.grid / Math.max(d.w, d.h));
    const small = resize(makeImg(d.w, d.h, d.out), Math.max(2, Math.round(d.w * scale)), Math.max(2, Math.round(d.h * scale)));
    const geo = new THREE.PlaneGeometry(d.widthMM, d.heightMM, small.w - 1, small.h - 1);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const zScale = d.depthMM * this.opts.exaggeration;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, small.data[i] * zScale);
    geo.computeVertexNormals();
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geo;
    } else {
      this.mesh = new THREE.Mesh(geo, this.material);
      this.scene.add(this.mesh);
    }
    this.placeLight();
  }

  private placeLight() {
    const d = this.data;
    const size = d ? Math.max(d.widthMM, d.heightMM) : 40;
    const az = (this.opts.azimuth * Math.PI) / 180;
    const el = (this.opts.elevation * Math.PI) / 180;
    this.light.position.set(Math.cos(az) * Math.cos(el) * size * 2, Math.sin(az) * Math.cos(el) * size * 2, Math.sin(el) * size * 2);
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
    this.renderer.setSize(r.width, r.height);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.renderer.render(this.scene, this.camera));
  }
}
