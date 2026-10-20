"""Common interface for depth models.

Every adapter returns a float32 array in 0..1 where 1 = nearest to the camera (the highest
part of the relief). Models disagree on conventions: some predict depth (far = large),
others disparity (near = large). `normalize` hides that difference.
"""

from __future__ import annotations

import sys
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
from huggingface_hub import hf_hub_download, snapshot_download
from tqdm.auto import tqdm

from ..device import DeviceInfo
from ..progress import tracker

VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor"


def use_vendored_code() -> None:
    """Make the vendored upstream packages (depth_anything_3, depth_anything_v2) importable."""
    if str(VENDOR_DIR) not in sys.path:
        sys.path.insert(0, str(VENDOR_DIR))


@dataclass
class ParamSpec:
    key: str
    label: str
    default: int
    min: int
    max: int
    step: int = 1
    help: str = ""


@dataclass
class ModelInfo:
    id: str
    name: str
    family: str
    description: str
    license: str
    license_url: str
    commercial_use: bool
    license_note: str
    default_resolution: int
    min_resolution: int
    max_resolution: int
    resolution_step: int
    resolution_help: str
    params: list[ParamSpec] = field(default_factory=list)


class DepthAdapter(ABC):
    info: ModelInfo
    convention: Literal["depth", "disparity"]

    def __init__(self) -> None:
        self.loaded_on: str | None = None

    # ---- weights -----------------------------------------------------------------------
    def availability(self) -> tuple[bool, str]:
        """(usable, reason). Used for models whose weights can't be downloaded automatically."""
        return True, ""

    @abstractmethod
    def weights_status(self) -> dict:
        """{'cached': bool, 'download_bytes': int}"""

    @abstractmethod
    def ensure_weights(self) -> None:
        """Download weights if needed, reporting progress through `tracker`."""

    # ---- model lifecycle ---------------------------------------------------------------
    @abstractmethod
    def load(self, device: DeviceInfo) -> None: ...

    def unload(self) -> None:
        self.loaded_on = None

    # ---- inference ---------------------------------------------------------------------
    @abstractmethod
    def predict_raw(self, image: np.ndarray, processing_resolution: int, device: DeviceInfo, **params) -> np.ndarray:
        """Raw model output (H, W) float32 in the model's own convention."""

    def predict(self, image: np.ndarray, processing_resolution: int, device: DeviceInfo, **params) -> np.ndarray:
        """image: (H, W, 3) uint8 RGB. Returns (h, w) float32 in 0..1 with near = 1."""
        lo, hi = self.info.min_resolution, self.info.max_resolution
        res = int(np.clip(processing_resolution, lo, hi))
        clean = {p.key: int(np.clip(params.get(p.key, p.default), p.min, p.max)) for p in self.info.params}
        raw = self.predict_raw(image, res, device, **clean)
        return normalize(raw, self.convention)

    def describe(self) -> dict:
        ok, reason = self.availability()
        return asdict(self.info) | {
            "available": ok,
            "unavailable_reason": reason,
            "loaded": self.loaded_on is not None,
            **(self.weights_status() if ok else {"cached": False, "download_bytes": 0}),
        }


def normalize(raw: np.ndarray, convention: Literal["depth", "disparity"]) -> np.ndarray:
    """Affine-map model output to 0..1 with near = 1.

    The mapping is linear on purpose: relief models are affine-invariant, so a 1/x
    conversion would bend the relief. Non-finite values (rare, from fp16 overflow) are
    replaced by the far end.
    """
    d = np.asarray(raw, dtype=np.float32)
    finite = np.isfinite(d)
    if not finite.any():
        return np.zeros_like(d)
    lo, hi = float(d[finite].min()), float(d[finite].max())
    if hi - lo < 1e-12:
        return np.full_like(d, 0.5)
    out = (d - lo) / (hi - lo)
    if convention == "depth":
        out = 1.0 - out
    out[~finite] = 0.0
    return np.clip(out, 0.0, 1.0).astype(np.float32)


def resize_longest(image: np.ndarray, longest: int, multiple: int = 1) -> np.ndarray:
    """Resize so the longest side is ~`longest`, each side rounded to the nearest multiple of `multiple`."""
    h, w = image.shape[:2]
    scale = longest / max(h, w)
    nh = max(multiple, int(round(h * scale / multiple)) * multiple)
    nw = max(multiple, int(round(w * scale / multiple)) * multiple)
    if (nh, nw) == (h, w):
        return image
    interp = cv2.INTER_AREA if nh * nw < h * w else cv2.INTER_CUBIC
    return cv2.resize(image, (nw, nh), interpolation=interp)


class _SilentTqdm(tqdm):
    def __init__(self, *args, **kwargs):
        kwargs["disable"] = True
        super().__init__(*args, **kwargs)


class HubWeights:
    """A set of files from one Hugging Face repo, downloaded with byte-level progress."""

    def __init__(self, repo_id: str, allow_patterns: list[str] | None = None, revision: str | None = None):
        self.repo_id = repo_id
        self.allow_patterns = allow_patterns
        self.revision = revision
        self._plan: list | None = None

    def _dry_run(self, offline_ok: bool = True) -> list:
        if self._plan is None:
            try:
                self._plan = snapshot_download(
                    self.repo_id,
                    revision=self.revision,
                    allow_patterns=self.allow_patterns,
                    dry_run=True,
                    tqdm_class=_SilentTqdm,
                )
            except Exception:
                if not offline_ok:
                    raise
                return []
        return self._plan

    def local_dir(self) -> str | None:
        """Snapshot folder if everything is cached (works offline)."""
        try:
            return snapshot_download(
                self.repo_id, revision=self.revision, allow_patterns=self.allow_patterns, local_files_only=True
            )
        except Exception:
            return None

    def status(self) -> dict:
        if self.local_dir() is not None:
            return {"cached": True, "download_bytes": 0}
        plan = self._dry_run()
        return {"cached": False, "download_bytes": sum(f.file_size or 0 for f in plan if f.will_download)}

    def ensure(self, model_id: str) -> str:
        path = self.local_dir()
        if path is not None:
            return path
        self._plan = None
        plan = [f for f in self._dry_run(offline_ok=False) if f.will_download]
        total = sum(f.file_size or 0 for f in plan)
        tracker.set("downloading", model_id, f"Downloading {self.repo_id}", total=total)
        bar = tracker.tqdm_class()
        for f in plan:
            hf_hub_download(self.repo_id, f.filename, revision=self.revision, tqdm_class=bar)
        self._plan = None
        path = self.local_dir()
        if path is None:
            raise RuntimeError(f"Download of {self.repo_id} finished but files are missing from the cache")
        return path
