import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { meshFor, prepareRelief, rasterize, renderFrame, type FrameSpec } from "../src/ui/softRender";

const W = 80;
const H = 60;

// Looking straight down, screen-up is +y (the top of the image); otherwise +z, as in the app.
function camera(pos: [number, number, number], target: [number, number, number] = [0, 0, 0]) {
  const cam = new THREE.PerspectiveCamera(35, W / H, 0.1, 5000);
  if (pos[0] === target[0] && pos[1] === target[1]) cam.up.set(0, 1, 0);
  else cam.up.set(0, 0, 1);
  cam.position.set(...pos);
  cam.lookAt(...target);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return { cam, M: new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements };
}

function relief(w: number, h: number, f: (x: number, y: number) => number, mm = 40, zScale = 1) {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x / (w - 1), y / (h - 1));
  return prepareRelief(data, w, h, mm, (mm * h) / w, zScale);
}

function spec(cam: THREE.PerspectiveCamera, M: ArrayLike<number>, light: [number, number, number], grid = 128): FrameSpec {
  const l = Math.hypot(...light);
  return {
    width: W, height: H, viewProj: M, grid, roughness: 0.3, color: [0.8, 0.8, 0.8],
    camera: [cam.position.x, cam.position.y, cam.position.z],
    light: [light[0] / l, light[1] / l, light[2] / l],
  };
}

describe("software 3D renderer", () => {
  it("covers the surface without gaps, even when triangles are smaller than a pixel", () => {
    const { cam, M } = camera([0, 0, 90]);
    for (const grid of [5, 64, 400]) {
      const r = relief(400, 400, () => 0);
      const ras = rasterize(meshFor(r, grid), W, H, M);
      // Projected square: [-20, 20] mm on both axes.
      const a = new THREE.Vector3(-20, 20, 0).project(cam);
      const b = new THREE.Vector3(20, -20, 0).project(cam);
      const x0 = ((a.x + 1) / 2) * W, x1 = ((b.x + 1) / 2) * W;
      const y0 = ((1 - a.y) / 2) * H, y1 = ((1 - b.y) / 2) * H;
      let holes = 0, outside = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const cx = x + 0.5, cy = y + 0.5;
          const drawn = ras.depth[y * W + x] !== Infinity;
          if (cx > x0 + 0.5 && cx < x1 - 0.5 && cy > y0 + 0.5 && cy < y1 - 0.5 && !drawn) holes++;
          if ((cx < x0 - 0.5 || cx > x1 + 0.5 || cy < y0 - 0.5 || cy > y1 + 0.5) && drawn) outside++;
        }
      }
      expect(holes, `grid ${grid}`).toBe(0);
      expect(outside, `grid ${grid}`).toBe(0);
    }
  });

  it("keeps the image the right way up: top-left of the image is top-left on screen", () => {
    const { M } = camera([0, 0, 90]);
    const ras = rasterize(meshFor(relief(64, 64, () => 0), 64), W, H, M);
    const first = ras.depth.findIndex((d) => d !== Infinity);
    const last = ras.depth.findLastIndex((d) => d !== Infinity);
    expect(ras.u[first]).toBeLessThan(0.05);
    expect(ras.v[first]).toBeLessThan(0.05);
    expect(ras.u[last]).toBeGreaterThan(0.95);
    expect(ras.v[last]).toBeGreaterThan(0.95);
  });

  it("hides what is behind a taller part (z-buffer)", () => {
    // A tall wall at x = -5 mm, then flat ground. Seen from low on the left, the wall blocks the
    // view of the ground at the centre; it is drawn first, so painter's order alone would get this wrong.
    const r = relief(200, 200, (u) => (Math.abs(u * 40 - 20 + 5) < 1 ? 1 : 0), 40, 20);
    const { M } = camera([-100, 0, 10]);
    const ras = rasterize(meshFor(r, 200), W, H, M);
    const centre = (H / 2) * W + W / 2;
    expect(ras.depth[centre]).not.toBe(Infinity);
    expect(Math.abs(ras.u[centre] * 40 - 20 - -5)).toBeLessThan(1.5);
  });

  it("lights raised detail from the light's side", () => {
    // Render with the light on one side, then the other: the environment cancels in the difference.
    const dome = (u: number, v: number) => Math.max(0, 1 - ((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.09);
    const r = relief(128, 128, dome, 40, 8);
    const { cam, M } = camera([0, 0, 120]);
    const sideDiff = (a: [number, number, number], b: [number, number, number], first: (x: number, y: number) => boolean) => {
      const pa = renderFrame(r, spec(cam, M, a));
      const pb = renderFrame(r, spec(cam, M, b));
      let near = 0, far = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const d = pa[(y * W + x) * 4 + 1] - pb[(y * W + x) * 4 + 1];
          if (first(x, y)) near += d;
          else far += d;
        }
      }
      return { near, far };
    };
    const lr = sideDiff([1, 0, 0.6], [-1, 0, 0.6], (x) => x >= W / 2);
    expect(lr.near).toBeGreaterThan(1000);
    expect(lr.far).toBeLessThan(-1000);
    const tb = sideDiff([0, 1, 0.6], [0, -1, 0.6], (_, y) => y < H / 2); // +y is the top of the image
    expect(tb.near).toBeGreaterThan(1000);
    expect(tb.far).toBeLessThan(-1000);
  });

  it("fills empty space with the background color", () => {
    const r = relief(32, 32, () => 0);
    const { cam, M } = camera([0, 0, 400]);
    const px = renderFrame(r, spec(cam, M, [0, 0, 1], 32));
    expect([...px.slice(0, 4)]).toEqual([0x0b, 0x0c, 0x0e, 255]);
    const c = ((H / 2) * W + W / 2) * 4;
    expect(px[c]).toBeGreaterThan(0x0b);
  });
});
