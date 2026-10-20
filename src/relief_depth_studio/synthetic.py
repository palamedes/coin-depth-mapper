"""Synthetic coin relief with known height, for tests and demos.

    python -m relief_depth_studio.synthetic out_dir [size]

writes synthetic-coin.png (a shaded "photo" of the relief) and synthetic-coin-height.png
(16-bit ground truth, white = highest).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np


def make_relief(size: int = 1024, seed: int = 7) -> tuple[np.ndarray, np.ndarray, dict]:
    """Returns (rgb uint8 HxWx3, height float32 HxW in 0..1, info with the coin circle)."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    cx, cy, R = size * 0.5, size * 0.5, size * 0.44
    r = np.hypot(x - cx, y - cy) / R  # 1.0 at the coin edge
    theta = np.arctan2(y - cy, x - cx)

    h = np.zeros((size, size), np.float32)
    coin = r <= 1.0
    h[coin] = 0.25  # field
    # Raised rim with rounded profile between r = 0.88 and 1.0
    rim = (r > 0.88) & (r <= 1.0)
    h[rim] = 0.25 + 0.45 * np.clip(np.sin(np.pi * (r[rim] - 0.88) / 0.12), 0, 1) ** 0.5

    # Dome ("head") off-centre and a five-pointed star
    dx, dy = (x - (cx - 0.12 * R)) / (0.42 * R), (y - (cy - 0.05 * R)) / (0.42 * R)
    dome = np.clip(1 - dx**2 - dy**2, 0, None) ** 0.5
    h = np.maximum(h, 0.25 + 0.7 * dome * coin)

    sx, sy = x - (cx + 0.45 * R), y - (cy + 0.4 * R)
    sr = np.hypot(sx, sy) / (0.22 * R)
    st = np.arctan2(sy, sx)
    star_edge = 0.55 + 0.45 * np.cos(5 * st) ** 2
    star = np.clip(1 - sr / star_edge, 0, 1)
    h = np.maximum(h, 0.25 + 0.4 * np.minimum(star * 3, 1) * coin)

    # Fine "fur" ridges on the dome: directional sinusoid with jitter, small amplitude
    fur = np.sin(0.35 * (x * np.cos(0.6) + y * np.sin(0.6)) + 2 * np.sin(theta * 7)) * 0.02
    h += fur * (dome > 0.05)
    h += rng.normal(0, 0.002, h.shape).astype(np.float32) * coin  # casting texture
    h = np.clip(h, 0, 1)

    # Shade like polished silver: Lambert + Blinn-Phong highlight, light from upper left
    relief_px = 0.06 * size
    gy, gx = np.gradient(h * relief_px)
    n = np.stack([-gx, -gy, np.ones_like(gx)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    light = np.array([-0.5, -0.6, 0.62], np.float32)
    light /= np.linalg.norm(light)
    half = light + np.array([0, 0, 1], np.float32)
    half /= np.linalg.norm(half)
    diffuse = np.clip(n @ light, 0, 1)
    spec = np.clip(n @ half, 0, 1) ** 40
    shade = 0.18 + 0.62 * diffuse + 0.5 * spec
    # Ambient occlusion-ish darkening in the low field
    shade *= 0.75 + 0.25 * np.clip(h / 0.5, 0, 1)

    background = 0.78 - 0.18 * (x + y) / (2 * size)
    img = np.where(coin, shade, background)
    rgb = np.clip(np.stack([img * 0.97, img * 0.98, img], axis=-1) * 255, 0, 255).astype(np.uint8)
    return rgb, h.astype(np.float32), {"cx": cx, "cy": cy, "r": R}


def main(argv: list[str]) -> None:
    from PIL import Image

    out = Path(argv[0] if argv else ".")
    size = int(argv[1]) if len(argv) > 1 else 1024
    out.mkdir(parents=True, exist_ok=True)
    rgb, h, _ = make_relief(size)
    Image.fromarray(rgb).save(out / "synthetic-coin.png")
    Image.fromarray((h * 65535).round().astype(np.uint16)).save(out / "synthetic-coin-height.png")
    print(f"wrote {out / 'synthetic-coin.png'} and {out / 'synthetic-coin-height.png'}")


if __name__ == "__main__":
    main(sys.argv[1:])
