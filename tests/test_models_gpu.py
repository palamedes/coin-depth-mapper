"""Real-model tests. They download weights on first run (DA3 ~1.3 GB, Marigold ~2.6 GB).

Run with:  uv run pytest -m gpu
Each model must reproduce the synthetic coin's height with near = bright, which is what
proves the per-model depth/disparity convention is handled correctly.
"""

from __future__ import annotations

import numpy as np
import pytest
import torch
from peft import LoraConfig, get_peft_model

from relief_depth_studio import models
from relief_depth_studio.device import detect_device
from relief_depth_studio.models.base import use_vendored_code
from relief_depth_studio.models.monorelief import VITB, MonoReliefAdapter
from relief_depth_studio.synthetic import make_relief

pytestmark = pytest.mark.gpu


def _resize(a: np.ndarray, shape) -> np.ndarray:
    import cv2

    return cv2.resize(a, (shape[1], shape[0]), interpolation=cv2.INTER_AREA)


@pytest.fixture(scope="module")
def relief():
    return make_relief(768)


@pytest.mark.parametrize(
    "model_id,res,params,min_corr",
    [
        ("da3-mono-large", 756, {}, 0.6),
        ("da3-base", 756, {}, 0.1),  # keeps fine texture but flattens the big dome
        ("marigold-v1-1", 768, {"steps": 4, "ensemble": 1, "seed": 0}, 0.6),
    ],
)
def test_model_recovers_synthetic_height(relief, model_id, res, params, min_corr):
    rgb, height, info = relief
    d = models.predict(model_id, rgb, res, params)
    assert d.dtype == np.float32 and d.min() >= 0 and d.max() <= 1
    gt = _resize(height, d.shape)
    yy, xx = np.mgrid[0 : d.shape[0], 0 : d.shape[1]]
    s = d.shape[1] / rgb.shape[1]
    inside = np.hypot(xx - info["cx"] * s, yy - info["cy"] * s) < 0.85 * info["r"] * s
    # Convention: raised parts (dome, star) must come out brighter than the flat field.
    raised, field = inside & (gt > 0.45), inside & (np.abs(gt - 0.25) < 0.01)
    assert d[raised].mean() > d[field].mean() + 0.02, f"{model_id}: raised areas are not brighter (near/far flipped?)"
    corr = np.corrcoef(d[inside], gt[inside])[0, 1]
    assert corr > min_corr, f"{model_id}: correlation with true height {corr:.2f}"


def test_monorelief_adapter_runs_with_stand_in_weights(tmp_path):
    """The real weights are not public, so check the loading/inference path with random
    weights and a LoRA saved in the same layout the upstream script expects."""
    use_vendored_code()
    from depth_anything_v2.dpt import DepthAnythingV2

    torch.manual_seed(0)
    base = DepthAnythingV2(**VITB)
    torch.save(base.state_dict(), tmp_path / "Moreliefv2.pth")
    peft = get_peft_model(base, LoraConfig(r=4, target_modules=["qkv"]))
    peft.save_pretrained(tmp_path / "lora")

    adapter = MonoReliefAdapter(folder=tmp_path)
    assert adapter.availability() == (True, "")
    rgb, _, _ = make_relief(300)
    d = adapter.predict(rgb, 280, detect_device())
    assert d.shape == (280, 280) and np.isfinite(d).all()
