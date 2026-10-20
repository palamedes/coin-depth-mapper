"""Fast backend tests (no model downloads): normalization, coin detection, HTTP API."""

from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from relief_depth_studio import models
from relief_depth_studio.coin import detect_circles
from relief_depth_studio.models.base import DepthAdapter, ModelInfo, normalize, resize_longest
from relief_depth_studio.server import create_app
from relief_depth_studio.synthetic import make_relief

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


# ---- normalization -------------------------------------------------------------------------


def test_normalize_depth_makes_near_bright():
    raw = np.array([[1.0, 2.0], [3.0, 5.0]], np.float32)  # depth: 1 is nearest
    out = normalize(raw, "depth")
    assert out[0, 0] == 1.0 and out[1, 1] == 0.0
    np.testing.assert_allclose(out[0, 1], 0.75)


def test_normalize_disparity_keeps_near_bright():
    raw = np.array([[0.0, 4.0]], np.float32)  # disparity: 4 is nearest
    out = normalize(raw, "disparity")
    np.testing.assert_array_equal(out, [[0.0, 1.0]])


def test_normalize_is_affine_not_reciprocal():
    raw = np.linspace(1, 10, 10, dtype=np.float32)[None]
    out = normalize(raw, "depth")
    assert np.allclose(np.diff(out), np.diff(out)[0])  # evenly spaced in, evenly spaced out


def test_normalize_handles_flat_and_nonfinite():
    assert np.all(normalize(np.full((3, 3), 7.0), "depth") == 0.5)
    raw = np.array([[1.0, np.nan, np.inf, 3.0]], np.float32)
    out = normalize(raw, "disparity")
    assert np.isfinite(out).all() and out.dtype == np.float32
    np.testing.assert_allclose(out[0], [0.0, 0.0, 0.0, 1.0])


def test_resize_longest_rounds_to_patch_multiple():
    img = np.zeros((600, 900, 3), np.uint8)
    out = resize_longest(img, 518, 14)
    assert out.shape[0] % 14 == 0 and out.shape[1] % 14 == 0
    assert abs(out.shape[1] - 518) <= 7


# ---- coin detection ------------------------------------------------------------------------


@pytest.mark.parametrize("size", [500, 800, 1024, 1500, 2400])
def test_detects_synthetic_coin_outer_edge(size):
    rgb, _, info = make_relief(size)
    circles = detect_circles(rgb)
    assert circles, "no circle found"
    c = circles[0]
    tol = 0.006 * size  # ~5 px at 800
    assert abs(c["cx"] - info["cx"]) < tol and abs(c["cy"] - info["cy"]) < tol
    assert abs(c["r"] - info["r"]) < tol


def test_detects_offcentre_coin_in_wide_image():
    rgb, _, info = make_relief(600)
    wide = np.full((700, 1200, 3), 200, np.uint8)
    wide[40:640, 500:1100] = rgb
    c = detect_circles(wide)[0]
    assert abs(c["cx"] - (500 + info["cx"])) < 6 and abs(c["cy"] - (40 + info["cy"])) < 6
    assert abs(c["r"] - info["r"]) < 0.02 * info["r"]


def test_detects_sample_coin_outer_rim():
    rgb = np.asarray(Image.open(SAMPLES / "coin-westie.webp").convert("RGB"))
    circles = detect_circles(rgb)
    c = circles[0]
    # Measured by hand: the coin's outer edge is centred near (623, 611) with radius ~593.
    assert abs(c["cx"] - 623) < 8 and abs(c["cy"] - 611) < 8 and abs(c["r"] - 593) < 10
    assert len(circles) >= 2  # inner rings offered as alternatives


def test_no_crash_on_blank_image():
    assert isinstance(detect_circles(np.full((300, 400, 3), 128, np.uint8)), list)


# ---- HTTP API --------------------------------------------------------------------------------


class FakeAdapter(DepthAdapter):
    """Returns a left-to-right ramp in the model's 'depth' convention."""

    convention = "depth"
    info = ModelInfo(
        id="fake", name="Fake", family="Test", description="", license="MIT", license_url="",
        commercial_use=True, license_note="", default_resolution=64, min_resolution=32,
        max_resolution=128, resolution_step=1, resolution_help="",
    )

    def weights_status(self):
        return {"cached": True, "download_bytes": 0}

    def ensure_weights(self):
        pass

    def load(self, device):
        self.loaded_on = device.kind

    def predict_raw(self, image, processing_resolution, device, **params):
        h, w = image.shape[:2]
        s = processing_resolution / max(h, w)
        return np.tile(np.arange(round(w * s), dtype=np.float32), (round(h * s), 1))


@pytest.fixture(scope="module")
def client():
    models.register(FakeAdapter())
    return TestClient(create_app())


def _png(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


def test_system_reports_device(client):
    d = client.get("/api/system").json()
    assert d["app"] == "relief-depth-studio"
    assert d["device"]["kind"] in ("cuda", "mps", "cpu")


def test_models_list_shows_licenses(client):
    ms = {m["id"]: m for m in client.get("/api/models").json()}
    assert ms["da3-mono-large"]["license"] == "Apache-2.0" and ms["da3-mono-large"]["commercial_use"]
    assert ms["da3-large-1.1"]["license"].startswith("CC-BY-NC") and not ms["da3-large-1.1"]["commercial_use"]
    assert ms["marigold-v1-1"]["license"] == "OpenRAIL++-M"
    assert [p["key"] for p in ms["marigold-v1-1"]["params"]] == ["steps", "ensemble", "seed"]
    for m in ms.values():
        if m["id"] != "fake":
            assert m["license_note"] and m["description"]


def test_depth_returns_float32_near_bright(client):
    img = np.zeros((50, 100, 3), np.uint8)
    r = client.post(
        "/api/depth",
        files={"image": ("x.png", _png(img), "image/png")},
        data={"model_id": "fake", "resolution": "64", "params": "{}"},
    )
    assert r.status_code == 200, r.text
    w, h = int(r.headers["X-Depth-Width"]), int(r.headers["X-Depth-Height"])
    d = np.frombuffer(r.content, "<f4").reshape(h, w)
    assert (w, h) == (64, 32)
    assert d[0, 0] == 1.0 and d[0, -1] == 0.0  # ramp was depth, so the left (small depth) is near


def test_depth_clamps_resolution_to_model_range(client):
    img = np.zeros((40, 40, 3), np.uint8)
    r = client.post("/api/depth", files={"image": ("x.png", _png(img))}, data={"model_id": "fake", "resolution": "5000"})
    assert int(r.headers["X-Depth-Width"]) == 128


def test_depth_rejects_unknown_model_and_bad_image(client):
    img = np.zeros((10, 10, 3), np.uint8)
    assert client.post("/api/depth", files={"image": ("x.png", _png(img))}, data={"model_id": "nope", "resolution": "64"}).status_code == 404
    r = client.post("/api/depth", files={"image": ("x.png", b"not an image")}, data={"model_id": "fake", "resolution": "64"})
    assert r.status_code == 400


def test_transparent_png_is_flattened_on_black(client):
    rgba = np.zeros((20, 20, 4), np.uint8)
    rgba[5:15, 5:15] = (255, 255, 255, 255)
    r = client.post("/api/depth", files={"image": ("x.png", _png(rgba))}, data={"model_id": "fake", "resolution": "32"})
    assert r.status_code == 200


def test_monorelief_without_weights_gives_clear_409(client, tmp_path, monkeypatch):
    monkeypatch.setenv("RDS_MODELS_DIR", str(tmp_path))
    ms = {m["id"]: m for m in client.get("/api/models").json()}
    assert not ms["monorelief-v2"]["available"]
    assert "not been released" in ms["monorelief-v2"]["unavailable_reason"]
    img = np.zeros((10, 10, 3), np.uint8)
    r = client.post("/api/depth", files={"image": ("x.png", _png(img))}, data={"model_id": "monorelief-v2", "resolution": "280"})
    assert r.status_code == 409 and "README" in r.json()["detail"]


def test_detect_circle_endpoint(client):
    rgb, _, info = make_relief(500)
    r = client.post("/api/detect-circle", files={"image": ("c.png", _png(rgb))}).json()
    assert r["width"] == 500 and abs(r["circles"][0]["r"] - info["r"]) < 0.03 * info["r"]


class OomAdapter(FakeAdapter):
    """Runs out of GPU memory on the first call only."""

    info = ModelInfo(**{**FakeAdapter.info.__dict__, "id": "oom"})
    calls = 0

    def predict_raw(self, image, processing_resolution, device, **params):
        OomAdapter.calls += 1
        if OomAdapter.calls == 1:
            import torch

            raise torch.OutOfMemoryError("CUDA out of memory (simulated)")
        return super().predict_raw(image, processing_resolution, device, **params)


def test_out_of_memory_frees_other_models_and_retries(client):
    models.register(OomAdapter())
    img = np.zeros((20, 20, 3), np.uint8)
    r = client.post("/api/depth", files={"image": ("x.png", _png(img))}, data={"model_id": "oom", "resolution": "32"})
    assert r.status_code == 200 and OomAdapter.calls == 2


def test_out_of_memory_twice_gives_plain_advice(client, monkeypatch):
    import torch

    def always_oom(self, *a, **k):
        raise torch.OutOfMemoryError("CUDA out of memory (simulated)")

    monkeypatch.setattr(FakeAdapter, "predict_raw", always_oom)
    img = np.zeros((20, 20, 3), np.uint8)
    r = client.post("/api/depth", files={"image": ("x.png", _png(img))}, data={"model_id": "fake", "resolution": "32"})
    assert r.status_code == 507 and "processing resolution" in r.json()["detail"]
    assert client.get("/api/status").json()["state"] == "error"


def test_params_must_be_json_ints(client):
    img = np.zeros((10, 10, 3), np.uint8)
    r = client.post("/api/depth", files={"image": ("x.png", _png(img))},
                    data={"model_id": "fake", "resolution": "32", "params": json.dumps(["x"])})
    assert r.status_code == 400
