"""Depth Anything 3 (ByteDance Seed), run through the vendored network code."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
from safetensors.torch import load_file

from ..device import DeviceInfo
from ..progress import tracker
from .base import VENDOR_DIR, DepthAdapter, HubWeights, ModelInfo, resize_longest, use_vendored_code

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
PATCH = 14

RES_HELP = (
    "Longest side, in pixels, that the model sees. Higher keeps finer detail but uses more GPU memory "
    "and time. Rounded to a multiple of 14."
)


class DA3Adapter(DepthAdapter):
    # DA3 predicts depth (far = larger), unlike Depth Anything 2 which predicted disparity.
    convention = "depth"

    def __init__(self, info: ModelInfo, repo_id: str):
        super().__init__()
        self.info = info
        self.weights = HubWeights(repo_id, allow_patterns=["config.json", "model.safetensors"])
        self.net: torch.nn.Module | None = None

    def weights_status(self) -> dict:
        return self.weights.status()

    def ensure_weights(self) -> None:
        self.weights.ensure(self.info.id)

    def load(self, device: DeviceInfo) -> None:
        if self.net is not None and self.loaded_on == device.kind:
            return
        path = Path(self.weights.ensure(self.info.id))
        tracker.set("loading", self.info.id, f"Loading {self.info.name}")
        use_vendored_code()
        from depth_anything_3.cfg import create_object, load_config

        config_name = json.loads((path / "config.json").read_text())["model_name"]
        cfg = load_config(str(VENDOR_DIR / "depth_anything_3" / "configs" / f"{config_name}.yaml"))
        net = create_object(cfg)
        # The upstream API wraps the network as `self.model`, so checkpoint keys start with "model.".
        state = {k.removeprefix("model."): v for k, v in load_file(path / "model.safetensors").items()}
        missing, unexpected = net.load_state_dict(state, strict=False)
        # Some any-view checkpoints omit the auxiliary ray head (camera rays, unused for depth);
        # upstream loads non-strictly too. Anything else missing is a real problem.
        missing = [k for k in missing if "_aux" not in k]
        if missing:
            raise RuntimeError(f"{self.info.name}: checkpoint is missing {len(missing)} weights, e.g. {missing[:3]}")
        net.eval().to(device.torch_device)
        self.net = net
        self.loaded_on = device.kind

    def unload(self) -> None:
        self.net = None
        super().unload()

    @torch.inference_mode()
    def predict_raw(self, image: np.ndarray, processing_resolution: int, device: DeviceInfo, **params) -> np.ndarray:
        self.load(device)
        img = resize_longest(image, processing_resolution, PATCH).astype(np.float32) / 255.0
        img = (img - IMAGENET_MEAN) / IMAGENET_STD
        x = torch.from_numpy(img).permute(2, 0, 1)[None, None].to(device.torch_device)  # (B=1, N=1, 3, H, W)

        dtype = device.autocast_dtype
        with torch.autocast(device_type=device.kind, dtype=dtype or torch.float32, enabled=dtype is not None):
            out = self.net(x, None, None, [], False, False, "first")
        return out["depth"][0, 0].float().cpu().numpy()


def _info(id, name, description, license, url, commercial, note, default_res=1008) -> ModelInfo:
    return ModelInfo(
        id=id,
        name=name,
        family="Depth Anything 3",
        description=description,
        license=license,
        license_url=url,
        commercial_use=commercial,
        license_note=note,
        default_resolution=default_res,
        min_resolution=280,
        max_resolution=2016,
        resolution_step=PATCH,
        resolution_help=RES_HELP,
    )


APACHE_NOTE = "Apache-2.0 weights: fine for engraving pieces you sell."
NC_NOTE = "CC BY-NC 4.0 weights: non-commercial use only. Don't use for pieces you sell."


def build() -> list[DA3Adapter]:
    return [
        DA3Adapter(
            _info(
                "da3-mono-large",
                "DA3 Mono Large",
                "Depth Anything 3's dedicated single-image model. Sharp, consistent relative depth. The best default.",
                "Apache-2.0",
                "https://huggingface.co/depth-anything/DA3MONO-LARGE",
                True,
                APACHE_NOTE,
            ),
            "depth-anything/DA3MONO-LARGE",
        ),
        DA3Adapter(
            _info(
                "da3-base",
                "DA3 Base",
                "Smaller any-view Depth Anything 3 model. Faster, a little softer. Good on small GPUs.",
                "Apache-2.0",
                "https://huggingface.co/depth-anything/DA3-BASE",
                True,
                APACHE_NOTE,
            ),
            "depth-anything/DA3-BASE",
        ),
        DA3Adapter(
            _info(
                "da3-large-1.1",
                "DA3 Large 1.1 (non-commercial)",
                "Larger any-view Depth Anything 3 model. Only for personal, non-commercial pieces.",
                "CC-BY-NC-4.0",
                "https://huggingface.co/depth-anything/DA3-LARGE-1.1",
                False,
                NC_NOTE,
            ),
            "depth-anything/DA3-LARGE-1.1",
        ),
    ]
