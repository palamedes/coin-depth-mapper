"""MonoRelief V2 (Zhang et al. 2025): Depth Anything V2 ViT-B fine-tuned with a LoRA for reliefs.

The code is Apache-2.0 and vendored under vendor/depth_anything_v2, but the authors have
not published the trained weights (github.com/glp1001/MonoreliefV2, issues #1, #3, #4).
This adapter works as soon as the weights are placed in the models folder:

    models/monorelief_v2/Moreliefv2.pth          (base checkpoint, any *.pth name works)
    models/monorelief_v2/lora/adapter_config.json
    models/monorelief_v2/lora/adapter_model.safetensors   (or adapter_model.bin)
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import torch

from ..device import DeviceInfo
from ..progress import tracker
from .base import DepthAdapter, ModelInfo, resize_longest, use_vendored_code

PROJECT_DIR = Path(__file__).resolve().parents[3]
VITB = {"encoder": "vitb", "features": 128, "out_channels": [96, 192, 384, 768]}


def weights_dir() -> Path:
    base = Path(os.environ.get("RDS_MODELS_DIR", PROJECT_DIR / "models"))
    return base / "monorelief_v2"


class MonoReliefAdapter(DepthAdapter):
    # DPT head with ReLU, trained like Depth Anything V2: larger = nearer (the upstream
    # script negates nothing before meshing with z = depth).
    convention = "disparity"

    info = ModelInfo(
        id="monorelief-v2",
        name="MonoRelief V2",
        family="MonoRelief",
        description=(
            "Trained specifically on reliefs (coins, medallions, carvings). Expects an image that already "
            "looks like a relief, not a photo of a real scene."
        ),
        license="Apache-2.0 (code)",
        license_url="https://github.com/glp1001/MonoreliefV2",
        commercial_use=True,
        license_note=(
            "The code is Apache-2.0. The weights are not public yet; check the license that comes with "
            "them if the authors send or publish them."
        ),
        default_resolution=1022,
        min_resolution=280,
        max_resolution=2016,
        resolution_step=14,
        resolution_help="Longest side the model works at. The authors use 1022. Rounded to a multiple of 14.",
    )

    def __init__(self, folder: Path | None = None) -> None:
        super().__init__()
        self.folder = folder
        self.net = None

    def _files(self) -> tuple[Path | None, Path]:
        folder = self.folder or weights_dir()
        ckpts = sorted(folder.glob("*.pth")) if folder.is_dir() else []
        return (ckpts[0] if ckpts else None), folder / "lora"

    def availability(self) -> tuple[bool, str]:
        ckpt, lora = self._files()
        if ckpt and (lora / "adapter_config.json").is_file():
            return True, ""
        return False, (
            "The MonoRelief V2 weights have not been released publicly. If you get them from the authors, "
            f"put the .pth file and the lora/ folder in {ckpt.parent if ckpt else (self.folder or weights_dir())}. "
            "See the README."
        )

    def weights_status(self) -> dict:
        return {"cached": True, "download_bytes": 0}

    def ensure_weights(self) -> None:
        ok, reason = self.availability()
        if not ok:
            raise FileNotFoundError(reason)

    def load(self, device: DeviceInfo) -> None:
        if self.net is not None and self.loaded_on == device.kind:
            return
        self.ensure_weights()
        tracker.set("loading", self.info.id, f"Loading {self.info.name}")
        use_vendored_code()
        from depth_anything_v2.dpt import DepthAnythingV2
        from peft import PeftModel

        ckpt, lora = self._files()
        net = DepthAnythingV2(**VITB)
        net.load_state_dict(torch.load(ckpt, map_location="cpu", weights_only=True))
        # PeftModel injects the LoRA layers into `net` in place, so we keep calling `net` directly.
        PeftModel.from_pretrained(net, str(lora))
        self.net = net.eval().to(device.torch_device)
        self.loaded_on = device.kind

    def unload(self) -> None:
        self.net = None
        super().unload()

    @torch.inference_mode()
    def predict_raw(self, image: np.ndarray, processing_resolution: int, device: DeviceInfo, **params) -> np.ndarray:
        self.load(device)
        # Mirrors the upstream image2tensor: RGB in 0..1, no ImageNet normalisation, sides divisible by 14.
        img = resize_longest(image, processing_resolution, 14).astype(np.float32) / 255.0
        x = torch.from_numpy(img).permute(2, 0, 1)[None].to(device.torch_device)
        dtype = device.autocast_dtype
        with torch.autocast(device_type=device.kind, dtype=dtype or torch.float32, enabled=dtype is not None):
            depth = self.net(x)
        return depth[0].float().cpu().numpy()


def build() -> list[MonoReliefAdapter]:
    return [MonoReliefAdapter()]
