// Software renderer for the 3D preview, used when the browser has no WebGL (for example Chrome with
// graphics acceleration turned off). Pure functions with no DOM, so they run in a web worker.
//
// Geometry is the same displaced grid as the WebGL view, rasterized with a z-buffer, and shaded per
// pixel with the grid's vertex normals interpolated across it, so both views show the same detail.
// Lighting follows three.js's MeshStandardMaterial with metalness 1: a GGX highlight from one
// directional light plus reflections of the same room environment (baked into roomEnv.ts), then ACES
// tone mapping and sRGB output.

import { makeImg, resize } from "../proc/image";
import { ENV_DATA, ENV_H, ENV_ROUGHNESS, ENV_W } from "./roomEnv";

export interface SoftRelief {
  /** The preview depth (0..1) the meshes are built from. */
  source: { w: number; h: number; data: Float32Array };
  widthMM: number;
  heightMM: number;
  zScale: number;
  /** Meshes built so far, by grid size. */
  meshes: Map<number, SoftMesh>;
}

export interface SoftMesh {
  gw: number;
  gh: number;
  /** x, y, z per vertex in mm, rows from the top of the image like three.js's PlaneGeometry. */
  pos: Float32Array;
  /** Unit normal per vertex (x, y, z). */
  normal: Float32Array;
  /** Room light arriving at each vertex (from its normal); doesn't depend on the view. */
  irradiance: Float32Array;
}

export interface FrameSpec {
  width: number;
  height: number;
  /** Projection × view matrix, column-major (three.js Matrix4.elements). */
  viewProj: ArrayLike<number>;
  camera: [number, number, number];
  /** Unit vector pointing toward the light. */
  light: [number, number, number];
  /** Metal color, linear RGB. */
  color: [number, number, number];
  roughness: number;
  /** Mesh vertices along the longer side. */
  grid: number;
}

export interface Raster {
  w: number;
  h: number;
  /** NDC depth per pixel; Infinity where nothing was drawn. */
  depth: Float32Array;
  /** Surface position (0..1 across the image, 0 = left / top) per pixel. */
  u: Float32Array;
  v: Float32Array;
  /** 1 where the pixel shows the underside. */
  back: Uint8Array;
}

const SUB = 8; // sub-pixel steps; vertices snap to 1/8 px so shared edges never leave gaps
const LIGHT_INTENSITY = 2.2; // as the WebGL view's DirectionalLight
const ENV_INTENSITY = 0.55; // as the WebGL view's scene.environmentIntensity
const BACKGROUND = [0x0b, 0x0c, 0x0e];

export function prepareRelief(data: Float32Array, w: number, h: number, widthMM: number, heightMM: number, zScale: number): SoftRelief {
  return { source: makeImg(w, h, data), widthMM, heightMM, zScale, meshes: new Map() };
}

/** The displaced grid for a mesh detail, matching the WebGL view's geometry. */
export function meshFor(r: SoftRelief, grid: number): SoftMesh {
  let m = r.meshes.get(grid);
  if (m) return m;
  const { w, h } = r.source;
  const scale = Math.min(1, grid / Math.max(w, h));
  const small = resize(r.source, Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale)));
  const gw = small.w;
  const gh = small.h;
  const z = small.data.map((v) => v * r.zScale);
  const pos = new Float32Array(gw * gh * 3);
  const normal = new Float32Array(gw * gh * 3);
  const dx = r.widthMM / (gw - 1);
  const dy = r.heightMM / (gh - 1);
  for (let row = 0, i = 0; row < gh; row++) {
    const up = Math.max(0, row - 1);
    const down = Math.min(gh - 1, row + 1);
    for (let col = 0; col < gw; col++, i++) {
      pos[i * 3] = (col / (gw - 1) - 0.5) * r.widthMM;
      pos[i * 3 + 1] = (0.5 - row / (gh - 1)) * r.heightMM;
      pos[i * 3 + 2] = z[i];
      // Central differences; world +y is up the image (decreasing row).
      const left = Math.max(0, col - 1);
      const right = Math.min(gw - 1, col + 1);
      const gx = (z[row * gw + right] - z[row * gw + left]) / ((right - left) * dx);
      const gy = (z[up * gw + col] - z[down * gw + col]) / ((down - up) * dy);
      const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      normal[i * 3] = -gx * inv;
      normal[i * 3 + 1] = -gy * inv;
      normal[i * 3 + 2] = inv;
    }
  }
  const irradiance = new Float32Array(gw * gh);
  for (let i = 0; i < irradiance.length; i++) irradiance[i] = sampleEnv(LAST_LEVEL, normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]);
  m = { gw, gh, pos, normal, irradiance };
  r.meshes.set(grid, m);
  return m;
}

/** Project and rasterize the mesh with a z-buffer, keeping the surface position of the nearest hit per pixel. */
export function rasterize(mesh: SoftMesh, W: number, H: number, M: ArrayLike<number>): Raster {
  const { gw, gh, pos } = mesh;
  const n = gw * gh;
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const sz = new Float32Array(n);
  const ok = new Uint8Array(n);
  const LIM = 1e6 * SUB;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (cw < 1e-6) continue; // behind the camera
    const nz = (M[2] * x + M[6] * y + M[10] * z + M[14]) / cw;
    if (nz < -1 || nz > 1) continue; // outside the near / far planes
    const X = Math.round(((M[0] * x + M[4] * y + M[8] * z + M[12]) / cw + 1) * 0.5 * W * SUB);
    const Y = Math.round((1 - (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw) * 0.5 * H * SUB);
    if (Math.abs(X) > LIM || Math.abs(Y) > LIM) continue;
    sx[i] = X;
    sy[i] = Y;
    sz[i] = nz;
    ok[i] = 1;
  }

  const depth = new Float32Array(W * H).fill(Infinity);
  const U = new Float32Array(W * H);
  const V = new Float32Array(W * H);
  const back = new Uint8Array(W * H);
  const du = 1 / (gw - 1);
  const dv = 1 / (gh - 1);
  const HALF = SUB / 2;

  const tri = (i0: number, i1: number, i2: number) => {
    if (!ok[i0] || !ok[i1] || !ok[i2]) return;
    let x1 = sx[i1], y1 = sy[i1], x2 = sx[i2], y2 = sy[i2];
    const x0 = sx[i0], y0 = sy[i0];
    let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (area === 0) return;
    // The top of the relief winds negatively on screen (y points down); flip so area > 0.
    let isBack = 1;
    if (area < 0) {
      const i = i1, x = x1, y = y1;
      i1 = i2;
      x1 = x2;
      y1 = y2;
      i2 = i;
      x2 = x;
      y2 = y;
      area = -area;
      isBack = 0;
    }
    const minX = Math.max(0, Math.ceil((Math.min(x0, x1, x2) - HALF) / SUB));
    const maxX = Math.min(W - 1, Math.floor((Math.max(x0, x1, x2) - HALF) / SUB));
    const minY = Math.max(0, Math.ceil((Math.min(y0, y1, y2) - HALF) / SUB));
    const maxY = Math.min(H - 1, Math.floor((Math.max(y0, y1, y2) - HALF) / SUB));
    if (minX > maxX || minY > maxY) return;
    // Edge functions at the first pixel centre, and their steps per pixel (exact integers).
    const px = minX * SUB + HALF;
    const py = minY * SUB + HALF;
    let r0 = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
    let r1 = (x0 - x2) * (py - y2) - (y0 - y2) * (px - x2);
    let r2 = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
    const A0 = (y1 - y2) * SUB, B0 = (x2 - x1) * SUB;
    const A1 = (y2 - y0) * SUB, B1 = (x0 - x2) * SUB;
    const A2 = (y0 - y1) * SUB, B2 = (x1 - x0) * SUB;
    const inv = 1 / area;
    const z0 = sz[i0], z1 = sz[i1], z2 = sz[i2];
    const u0 = (i0 % gw) * du, u1 = (i1 % gw) * du, u2 = (i2 % gw) * du;
    const v0 = Math.floor(i0 / gw) * dv, v1 = Math.floor(i1 / gw) * dv, v2 = Math.floor(i2 / gw) * dv;
    for (let y = minY; y <= maxY; y++) {
      let w0 = r0, w1 = r1, w2 = r2;
      let k = y * W + minX;
      for (let x = minX; x <= maxX; x++, k++) {
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
          const z = (w0 * z0 + w1 * z1 + w2 * z2) * inv;
          if (z < depth[k]) {
            depth[k] = z;
            U[k] = (w0 * u0 + w1 * u1 + w2 * u2) * inv;
            V[k] = (w0 * v0 + w1 * v1 + w2 * v2) * inv;
            back[k] = isBack;
          }
        }
        w0 += A0;
        w1 += A1;
        w2 += A2;
      }
      r0 += B0;
      r1 += B1;
      r2 += B2;
    }
  };

  // Same two triangles per cell as three.js's PlaneGeometry.
  for (let row = 0; row < gh - 1; row++) {
    for (let col = 0; col < gw - 1; col++) {
      const a = row * gw + col;
      const b = a + gw;
      tri(a, b, a + 1);
      tri(b, b + 1, a + 1);
    }
  }
  return { w: W, h: H, depth, u: U, v: V, back };
}

const SRGB = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) {
  const c = i / 4096;
  SRGB[i] = Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
}

// three.js ACESFilmicToneMapping, per channel after its input matrix.
function rrtOdt(v: number): number {
  return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
}

const ENV_MAPS = (() => {
  const bin = atob(ENV_DATA);
  const n = ENV_W * ENV_H;
  return ENV_ROUGHNESS.map((_, level) => {
    const map = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = (level * n + i) * 2;
      map[i] = 2 ** ((bin.charCodeAt(k) | (bin.charCodeAt(k + 1) << 8)) / 2048 - 16);
    }
    return map;
  });
})();
const LAST_LEVEL = ENV_ROUGHNESS.length - 1;

/** Position of a roughness among the baked levels, as index + fraction. */
function envLevel(roughness: number): number {
  let i = 0;
  while (i < LAST_LEVEL - 1 && roughness > ENV_ROUGHNESS[i + 1]) i++;
  const t = (roughness - ENV_ROUGHNESS[i]) / (ENV_ROUGHNESS[i + 1] - ENV_ROUGHNESS[i]);
  return i + Math.min(1, Math.max(0, t));
}

/** The room in a unit direction, as seen by a surface at this (fractional) roughness level. */
function sampleEnv(level: number, x: number, y: number, z: number): number {
  const fx = ((Math.atan2(x, z) + Math.PI) / (2 * Math.PI)) * ENV_W - 0.5;
  const fy = (Math.acos(Math.min(1, Math.max(-1, y))) / Math.PI) * ENV_H - 0.5;
  const xf = Math.floor(fx);
  const yf = Math.floor(fy);
  const tx = fx - xf;
  const ty = fy - yf;
  const x0 = (xf + ENV_W) % ENV_W;
  const x1 = (x0 + 1) % ENV_W;
  const y0 = Math.max(0, yf) * ENV_W;
  const y1 = Math.min(ENV_H - 1, yf + 1) * ENV_W;
  const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
  const i = Math.floor(level);
  const t = level - i;
  let m = ENV_MAPS[i];
  const a = m[y0 + x0] * w00 + m[y0 + x1] * w01 + m[y1 + x0] * w10 + m[y1 + x1] * w11;
  if (t === 0) return a;
  m = ENV_MAPS[i + 1];
  return a + (m[y0 + x0] * w00 + m[y0 + x1] * w01 + m[y1 + x0] * w10 + m[y1 + x1] * w11 - a) * t;
}

/** Light the rasterized surface. Returns RGBA pixels. */
export function shade(r: SoftRelief, mesh: SoftMesh, ras: Raster, f: FrameSpec): Uint8ClampedArray<ArrayBuffer> {
  const { gw, gh, pos, normal, irradiance } = mesh;
  const { w: W, h: H, depth } = ras;
  const n = W * H;

  // Pass 1: surface normal, height and room light per pixel (bilinear between vertices).
  const N = new Float32Array(n * 3);
  const Z = new Float32Array(n);
  const I = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (depth[k] === Infinity) continue;
    const fx = ras.u[k] * (gw - 1);
    const fy = ras.v[k] * (gh - 1);
    const x0 = Math.min(gw - 2, Math.max(0, Math.floor(fx)));
    const y0 = Math.min(gh - 2, Math.max(0, Math.floor(fy)));
    const tx = fx - x0, ty = fy - y0;
    const i00 = y0 * gw + x0, i10 = i00 + 1, i01 = i00 + gw, i11 = i01 + 1;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    const nx = w00 * normal[i00 * 3] + w10 * normal[i10 * 3] + w01 * normal[i01 * 3] + w11 * normal[i11 * 3];
    const ny = w00 * normal[i00 * 3 + 1] + w10 * normal[i10 * 3 + 1] + w01 * normal[i01 * 3 + 1] + w11 * normal[i11 * 3 + 1];
    const nz = w00 * normal[i00 * 3 + 2] + w10 * normal[i10 * 3 + 2] + w01 * normal[i01 * 3 + 2] + w11 * normal[i11 * 3 + 2];
    let nl = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (ras.back[k]) nl = -nl;
    N[k * 3] = nx * nl;
    N[k * 3 + 1] = ny * nl;
    N[k * 3 + 2] = nz * nl;
    Z[k] = w00 * pos[i00 * 3 + 2] + w10 * pos[i10 * 3 + 2] + w01 * pos[i01 * 3 + 2] + w11 * pos[i11 * 3 + 2];
    I[k] = ras.back[k]
      ? sampleEnv(LAST_LEVEL, nx * nl, ny * nl, nz * nl)
      : w00 * irradiance[i00] + w10 * irradiance[i10] + w01 * irradiance[i01] + w11 * irradiance[i11];
  }

  // Pass 2: light each pixel.
  const out = new Uint8ClampedArray(n * 4);
  const [cx, cy, cz] = f.camera;
  const [lx, ly, lz] = f.light;
  const baseRough = Math.max(0.0525, f.roughness);
  const exposure = 1 / 0.6;
  const [f0r, f0g, f0b] = f.color;
  // Multiple-scattering average Fresnel per channel.
  const favgR = f0r + (1 - f0r) / 21, favgG = f0g + (1 - f0g) / 21, favgB = f0b + (1 - f0b) / 21;
  // Neighbours further apart on the surface than this are across an occlusion edge, not a slope.
  const near = (a: number, b: number) => depth[b] !== Infinity && Math.abs(ras.u[a] - ras.u[b]) * gw + Math.abs(ras.v[a] - ras.v[b]) * gh < 2;
  const slopeChange = (a: number, b: number) =>
    Math.max(Math.abs(N[a * 3] - N[b * 3]), Math.abs(N[a * 3 + 1] - N[b * 3 + 1]), Math.abs(N[a * 3 + 2] - N[b * 3 + 2]));

  for (let y = 0, k = 0, p = 0; y < H; y++) {
    for (let x = 0; x < W; x++, k++, p += 4) {
      if (depth[k] === Infinity) {
        out[p] = BACKGROUND[0];
        out[p + 1] = BACKGROUND[1];
        out[p + 2] = BACKGROUND[2];
        out[p + 3] = 255;
        continue;
      }
      const nx = N[k * 3], ny = N[k * 3 + 1], nz = N[k * 3 + 2];
      // Like three.js, roughen where the normal changes quickly from pixel to pixel; this keeps
      // detail finer than a pixel from sparkling.
      let geo = 0;
      if (x + 1 < W && near(k, k + 1)) geo = slopeChange(k, k + 1);
      else if (x > 0 && near(k, k - 1)) geo = slopeChange(k, k - 1);
      if (y + 1 < H && near(k, k + W)) geo = Math.max(geo, slopeChange(k, k + W));
      else if (y > 0 && near(k, k - W)) geo = Math.max(geo, slopeChange(k, k - W));
      const rough = Math.min(1, baseRough + geo);
      const alpha = rough * rough;
      const a2 = alpha * alpha;

      // View direction from the surface point to the camera.
      let vx = cx - (ras.u[k] - 0.5) * r.widthMM;
      let vy = cy - (0.5 - ras.v[k]) * r.heightMM;
      let vz = cz - Z[k];
      const vl = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
      vx *= vl;
      vy *= vl;
      vz *= vl;
      const nvRaw = nx * vx + ny * vy + nz * vz;
      const nv = Math.max(1e-4, nvRaw);
      // three.js's DFGApprox (a fit of the lookup table it uses): how much of the environment is reflected.
      const rc0 = 1 - rough, rc1 = -0.0275 * rough + 0.0425;
      const a004 = Math.min(rc0 * rc0, Math.exp(-6.43236 * nv)) * rc0 + rc1; // exp2(-9.28 nv)
      const fa = -1.04 * a004 - 0.572 * rough + 1.04;
      const fb = 1.04 * a004 + 0.022 * rough - 0.04;
      const ess = fa + fb;
      const ems = 1 - ess;

      // Direct light: GGX highlight with Schlick Fresnel, scaled up for energy lost to multiple scattering.
      let spec = 0;
      let fres = 0;
      const nlDot = nx * lx + ny * ly + nz * lz;
      if (nlDot > 0) {
        let hx = lx + vx, hy = ly + vy, hz = lz + vz;
        const hl = 1 / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
        hx *= hl;
        hy *= hl;
        hz *= hl;
        const nh = Math.max(0, nx * hx + ny * hy + nz * hz);
        const vh = Math.max(0, vx * hx + vy * hy + vz * hz);
        const d = nh * nh * (a2 - 1) + 1;
        const D = a2 / (Math.PI * d * d);
        const vis = 0.5 / (nlDot * Math.sqrt(nv * nv * (1 - a2) + a2) + nv * Math.sqrt(nlDot * nlDot * (1 - a2) + a2));
        spec = LIGHT_INTENSITY * nlDot * D * vis;
        const c = 1 - vh;
        fres = c * c * c * c * c;
      }
      const msc = 1 / ess - 1;

      // Environment: the room in the mirror direction (bent toward the normal by roughness^4, as three.js
      // does), plus multiple scattering lit by the room as seen from the normal.
      let rx = 2 * nvRaw * nx - vx, ry = 2 * nvRaw * ny - vy, rz = 2 * nvRaw * nz - vz;
      rx += (nx - rx) * a2;
      ry += (ny - ry) * a2;
      rz += (nz - rz) * a2;
      const rl = 1 / (Math.sqrt(rx * rx + ry * ry + rz * rz) || 1);
      const rad = ENV_INTENSITY * sampleEnv(envLevel(rough), rx * rl, ry * rl, rz * rl);
      const irr = ENV_INTENSITY * I[k];

      // Metal: everything is tinted by its color.
      const ssR = f0r * fa + fb, ssG = f0g * fa + fb, ssB = f0b * fa + fb;
      const cr = (spec * (f0r + (1 - f0r) * fres) * (1 + f0r * msc) + rad * ssR + irr * ems * ((ssR * favgR) / (1 - ems * favgR))) * exposure;
      const cg = (spec * (f0g + (1 - f0g) * fres) * (1 + f0g * msc) + rad * ssG + irr * ems * ((ssG * favgG) / (1 - ems * favgG))) * exposure;
      const cb = (spec * (f0b + (1 - f0b) * fres) * (1 + f0b * msc) + rad * ssB + irr * ems * ((ssB * favgB) / (1 - ems * favgB))) * exposure;
      // ACES: input matrix, curve, output matrix (column-major in three.js's shader).
      const ir = rrtOdt(0.59719 * cr + 0.35458 * cg + 0.04823 * cb);
      const ig = rrtOdt(0.076 * cr + 0.90834 * cg + 0.01566 * cb);
      const ib = rrtOdt(0.0284 * cr + 0.13383 * cg + 0.83777 * cb);
      const or = 1.60475 * ir - 0.53108 * ig - 0.07367 * ib;
      const og = -0.10208 * ir + 1.10813 * ig - 0.00605 * ib;
      const ob = -0.00327 * ir - 0.07276 * ig + 1.07602 * ib;
      out[p] = SRGB[Math.round(Math.min(1, Math.max(0, or)) * 4096)];
      out[p + 1] = SRGB[Math.round(Math.min(1, Math.max(0, og)) * 4096)];
      out[p + 2] = SRGB[Math.round(Math.min(1, Math.max(0, ob)) * 4096)];
      out[p + 3] = 255;
    }
  }
  return out;
}

export function renderFrame(r: SoftRelief, f: FrameSpec): Uint8ClampedArray<ArrayBuffer> {
  const mesh = meshFor(r, f.grid);
  return shade(r, mesh, rasterize(mesh, f.width, f.height, f.viewProj), f);
}
