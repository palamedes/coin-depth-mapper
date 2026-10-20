"""Pick the compute device: NVIDIA CUDA, then Apple MPS, then CPU."""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from functools import lru_cache

import torch


@dataclass(frozen=True)
class DeviceInfo:
    kind: str  # "cuda" | "mps" | "cpu"
    name: str
    memory_gb: float | None
    warning: str | None

    @property
    def torch_device(self) -> torch.device:
        return torch.device(self.kind)

    @property
    def label(self) -> str:
        mem = f", {self.memory_gb:.0f} GB" if self.memory_gb else ""
        return f"{self.kind.upper()} ({self.name}{mem})"

    @property
    def autocast_dtype(self) -> torch.dtype | None:
        """Reduced precision for the transformer backbones; None means plain float32."""
        if self.kind == "cuda":
            return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        if self.kind == "mps":
            return torch.float16
        return None

    def as_dict(self) -> dict:
        return asdict(self) | {"label": self.label}


@lru_cache(maxsize=1)
def detect_device() -> DeviceInfo:
    forced = os.environ.get("RDS_DEVICE", "").lower()  # escape hatch: RDS_DEVICE=cpu
    if forced not in ("", "cuda", "mps", "cpu"):
        raise ValueError(f"RDS_DEVICE must be cuda, mps or cpu, not {forced!r}")

    if forced in ("", "cuda") and torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        return DeviceInfo("cuda", props.name, props.total_memory / 2**30, None)
    if forced in ("", "mps") and torch.backends.mps.is_available():
        return DeviceInfo("mps", "Apple GPU", None, None)
    return DeviceInfo(
        "cpu",
        "CPU",
        None,
        "No GPU found, so depth models run on the CPU. Expect 30 seconds to several minutes per image "
        "(Marigold is the slowest). Lower the processing resolution to speed it up.",
    )
