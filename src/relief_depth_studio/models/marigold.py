"""Marigold depth (ETH Zurich), a fine-tuned Stable Diffusion model, through diffusers."""

from __future__ import annotations

import math

import numpy as np
import torch
from PIL import Image

from ..device import DeviceInfo
from ..progress import tracker
from .base import DepthAdapter, HubWeights, ModelInfo, ParamSpec

REPO = "prs-eth/marigold-depth-v1-1"


class MarigoldAdapter(DepthAdapter):
    # Affine-invariant depth in 0..1 with 0 at the near plane (verified in tests/test_models_gpu.py).
    convention = "depth"

    info = ModelInfo(
        id="marigold-v1-1",
        name="Marigold Depth v1.1",
        family="Marigold",
        description=(
            "Diffusion-based depth. Very fine detail and crisp edges, slower than DA3. "
            "Results vary slightly with the seed; more ensemble members average that out."
        ),
        license="OpenRAIL++-M",
        license_url="https://huggingface.co/prs-eth/marigold-depth-v1-1",
        commercial_use=True,
        license_note=(
            "CreativeML Open RAIL++-M: commercial use is allowed, with use-based restrictions "
            "(no harmful uses). Selling engraved pieces is fine."
        ),
        default_resolution=768,
        min_resolution=512,
        max_resolution=1536,
        resolution_step=64,
        resolution_help=(
            "Longest side the model works at. 768 is what Marigold was trained on. Higher gives crisper "
            "detail but can lose overall shape."
        ),
        params=[
            ParamSpec("steps", "Denoising steps", 4, 1, 50, 1,
                      "How many diffusion steps to run. v1.1 is tuned for 1 to 4; more is slower and rarely better."),
            ParamSpec("ensemble", "Ensemble size", 1, 1, 10, 1,
                      "Run the model this many times with different noise and take the median. "
                      "Smoother, more reliable depth; time grows with each member."),
            ParamSpec("seed", "Seed", 0, 0, 9999, 1,
                      "Starting noise. Keep it fixed so re-running gives the same result."),
        ],
    )

    def __init__(self) -> None:
        super().__init__()
        self.weights = HubWeights(
            REPO, allow_patterns=["*.json", "*.txt", "tokenizer/*", "*.fp16.safetensors"]
        )
        self.pipe = None

    def weights_status(self) -> dict:
        return self.weights.status()

    def ensure_weights(self) -> None:
        self.weights.ensure(self.info.id)

    def load(self, device: DeviceInfo) -> None:
        if self.pipe is not None and self.loaded_on == device.kind:
            return
        path = self.weights.ensure(self.info.id)
        tracker.set("loading", self.info.id, f"Loading {self.info.name}")
        from diffusers import MarigoldDepthPipeline

        # fp16 weights are upcast on the CPU, where half precision is slow or unsupported.
        dtype = torch.float32 if device.kind == "cpu" else torch.float16
        pipe = MarigoldDepthPipeline.from_pretrained(path, variant="fp16", torch_dtype=dtype)
        pipe.set_progress_bar_config(disable=True)
        self.pipe = pipe.to(device.torch_device)
        self.loaded_on = device.kind

    def unload(self) -> None:
        self.pipe = None
        super().unload()

    def predict_raw(self, image: np.ndarray, processing_resolution: int, device: DeviceInfo, **params) -> np.ndarray:
        self.load(device)
        steps, ensemble, seed = params["steps"], params["ensemble"], params["seed"]
        batch = min(ensemble, 4) if device.kind == "cuda" else 1
        tracker.set("inferring", self.info.id, f"{self.info.name}: denoising", total=steps * math.ceil(ensemble / batch))
        self.pipe.progress_bar = _counting_progress

        generator = torch.Generator(device="cpu").manual_seed(seed)
        out = self.pipe(
            Image.fromarray(image),
            num_inference_steps=steps,
            ensemble_size=ensemble,
            processing_resolution=processing_resolution,
            match_input_resolution=False,
            batch_size=batch,
            generator=generator,
            output_type="np",
        )
        return np.asarray(out.prediction)[0, :, :, 0]


def _counting_progress(iterable=None, total=None, desc=None, **_):
    """Stand-in for DiffusionPipeline.progress_bar that reports each denoising step to the UI.
    The pipeline also wraps its outer ensemble loop in a progress bar; only the inner
    "Diffusion steps..." loop is counted."""
    counting = (desc or "").startswith("Diffusion")
    for item in iterable if iterable is not None else range(total or 0):
        yield item
        if counting:
            tracker.advance(1)


def build() -> list[MarigoldAdapter]:
    return [MarigoldAdapter()]
