"""Inspect an exported depth PNG with Pillow (independent of the app's own encoder).

    python tests/check_export.py depth.png [ground-truth-height.png]

Prints JSON: mode, size, dpi, value range, mean outside the coin circle, and (with a ground
truth) the correlation with the true height inside the coin.
"""

from __future__ import annotations

import json
import sys

import numpy as np
from PIL import Image


def main(path: str, truth: str = "") -> dict:
    img = Image.open(path)
    a = np.asarray(img).astype(np.float64)
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx + 0.5 - w / 2, yy + 0.5 - h / 2)
    inside = r < 0.85 * min(w, h) / 2
    outside = r > min(w, h) / 2 + 2
    report = {
        "mode": img.mode,
        "size": list(img.size),
        "dpi": [float(v) for v in img.info.get("dpi", (0, 0))],
        "min": int(a.min()),
        "max": int(a.max()),
        "outside_mean": float(a[outside].mean()) if outside.any() else None,
        "software": img.info.get("Software"),
    }
    if truth:
        gt = np.asarray(Image.open(truth)).astype(np.float64)
        # The app crops to the detected circle; the synthetic coin is centred with r = 0.44 * size.
        size = gt.shape[0]
        c, rr = size / 2, 0.44 * size
        crop = Image.fromarray(gt[int(c - rr) : int(c + rr), int(c - rr) : int(c + rr)].astype(np.float32))
        gt_small = np.asarray(crop.resize((w, h), Image.BILINEAR))
        report["corr"] = float(np.corrcoef(a[inside], gt_small[inside])[0, 1])
    return report


if __name__ == "__main__":
    print(json.dumps(main(*sys.argv[1:])))
