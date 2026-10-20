// Calls to the Python backend.

export interface ParamSpec {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  help: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  description: string;
  license: string;
  license_url: string;
  commercial_use: boolean;
  license_note: string;
  default_resolution: number;
  min_resolution: number;
  max_resolution: number;
  resolution_step: number;
  resolution_help: string;
  params: ParamSpec[];
  available: boolean;
  unavailable_reason: string;
  loaded: boolean;
  cached: boolean;
  download_bytes: number;
  browser?: boolean; // runs in the browser (lite mode), not on the backend
}

export interface SystemInfo {
  app: string;
  version: string;
  torch: string;
  device: { kind: "cuda" | "mps" | "cpu"; name: string; memory_gb: number | null; warning: string | null; label: string };
}

export interface Status {
  state: "idle" | "downloading" | "loading" | "inferring" | "error";
  model_id: string | null;
  message: string;
  done: number;
  total: number;
  elapsed: number;
  error: string | null;
}

export interface CircleCandidate {
  cx: number;
  cy: number;
  r: number;
  score: number;
}

export interface Depth {
  w: number;
  h: number;
  data: Float32Array;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export async function getSystem(): Promise<SystemInfo | null> {
  try {
    const res = await fetch("api/system", { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const s = (await res.json()) as SystemInfo;
    return s.app === "relief-depth-studio" ? s : null;
  } catch {
    return null; // no backend: lite mode only
  }
}

export const getModels = () => fetch("api/models").then((r) => json<ModelInfo[]>(r));
export const getStatus = () => fetch("api/status").then((r) => json<Status>(r));

export async function detectCircles(png: Blob): Promise<{ width: number; height: number; circles: CircleCandidate[] }> {
  const fd = new FormData();
  fd.append("image", png, "image.png");
  return json(await fetch("api/detect-circle", { method: "POST", body: fd }));
}

export async function predictDepth(png: Blob, modelId: string, resolution: number, params: Record<string, number>): Promise<Depth> {
  const fd = new FormData();
  fd.append("image", png, "crop.png");
  fd.append("model_id", modelId);
  fd.append("resolution", String(Math.round(resolution)));
  fd.append("params", JSON.stringify(params));
  const res = await fetch("api/depth", { method: "POST", body: fd });
  if (!res.ok) await json(res); // throws with the server's message
  const w = Number(res.headers.get("X-Depth-Width"));
  const h = Number(res.headers.get("X-Depth-Height"));
  const data = new Float32Array(await res.arrayBuffer());
  if (data.length !== w * h) throw new Error("Depth size mismatch from server");
  return { w, h, data };
}
