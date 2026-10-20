"""Find a round coin or medallion in an image.

Hough circles give a first center. Coins usually have several concentric rings (outer
edge, rim, inner field) that share one center, and Hough keeps only one radius per
center, so the rings are read off a radial edge profile around that center. Each ring is
then refined on its own (center and radius), looking only at a narrow band of radii, so
other strong edges in the design can't pull it off.
"""

from __future__ import annotations

import cv2
import numpy as np

WORK_SIZE = 800


def detect_circles(image: np.ndarray, max_candidates: int = 6) -> list[dict]:
    """image: (H, W, 3) uint8 RGB. Returns circles in image pixels, outer coin edge first:
    [{"cx", "cy", "r", "score"}], score in 0..1 (share of the ring with a clear edge)."""
    h, w = image.shape[:2]
    scale = min(1.0, WORK_SIZE / max(h, w))
    small = cv2.resize(image, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else image
    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_RGB2GRAY), (0, 0), 1.5)
    sh, sw = gray.shape
    size = min(sh, sw)

    centers = _hough_centers(gray) or [(sw / 2, sh / 2)]
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)

    found: list[dict] = []
    for cx, cy in centers[:2]:
        for r in _ring_radii(gx, gy, cx, cy, size):
            fcx, fcy, fr = _refine_ring(gx, gy, cx, cy, r, size)
            score = _ring_score(gx, gy, fcx, fcy, fr)
            found.append({"cx": fcx / scale, "cy": fcy / scale, "r": fr / scale, "score": score})

    # Drop near-duplicates (the same ring found twice), keep the better one.
    found.sort(key=lambda c: -c["score"])
    unique: list[dict] = []
    for c in found:
        if all(np.hypot(c["cx"] - u["cx"], c["cy"] - u["cy"]) + abs(c["r"] - u["r"]) > 0.008 * max(h, w) for u in unique):
            unique.append(c)
    if not unique:
        return []

    # The coin's outer edge is the widest ring that is clearly a full circle; list it first,
    # then the rest from large to small. (A threshold relative to the best ring fails when an
    # inner ring happens to be perfect.)
    strong = [u for u in unique if u["score"] >= 0.7] or unique
    outer = max(strong, key=lambda u: u["r"])
    rest = sorted((u for u in unique if u is not outer), key=lambda u: -u["r"])
    return [_rounded(c) for c in [outer, *rest][:max_candidates]]


def _rounded(c: dict) -> dict:
    return {"cx": round(c["cx"], 1), "cy": round(c["cy"], 1), "r": round(c["r"], 1), "score": round(c["score"], 3)}


def _hough_centers(gray: np.ndarray) -> list[tuple[float, float]]:
    sh, sw = gray.shape
    min_r, max_r = int(0.12 * min(sh, sw)), int(0.6 * max(sh, sw))
    for method, p1, p2 in ((cv2.HOUGH_GRADIENT_ALT, 300, 0.8), (cv2.HOUGH_GRADIENT_ALT, 150, 0.6), (cv2.HOUGH_GRADIENT, 120, 40)):
        circles = cv2.HoughCircles(
            gray, method, dp=1.5, minDist=min(sh, sw) / 8, param1=p1, param2=p2, minRadius=min_r, maxRadius=max_r
        )
        if circles is not None and len(circles[0]):
            # Larger circles first: in a coin photo the coin is the big thing in frame.
            cs = sorted(circles[0].tolist(), key=lambda c: -c[2])
            return [(c[0], c[1]) for c in cs]
    return []


def _radial_samples(gx, gy, cx, cy, radii, n_angles=720):
    """|radial gradient| at each (radius, angle), and whether the sample lies inside the image."""
    t = np.linspace(0, 2 * np.pi, n_angles, endpoint=False, dtype=np.float32)
    cos, sin = np.cos(t), np.sin(t)
    xs = (cx + radii[:, None] * cos[None, :]).astype(np.float32)
    ys = (cy + radii[:, None] * sin[None, :]).astype(np.float32)
    h, w = gx.shape
    inside = (xs >= 0) & (xs <= w - 1) & (ys >= 0) & (ys <= h - 1)
    sx = cv2.remap(gx, xs, ys, cv2.INTER_LINEAR)
    sy = cv2.remap(gy, xs, ys, cv2.INTER_LINEAR)
    return np.abs(sx * cos[None, :] + sy * sin[None, :]), inside


def _profile(gx, gy, cx, cy, radii, n_angles=720):
    """Mean radial gradient per radius over the visible part of each circle (nan if mostly off-image)."""
    radial, inside = _radial_samples(gx, gy, cx, cy, radii, n_angles)
    visible = inside.sum(axis=1)
    prof = np.where(inside, radial, 0).sum(axis=1) / np.maximum(visible, 1)
    return np.where(visible > 0.6 * n_angles, prof, np.nan)


def _ring_radii(gx, gy, cx, cy, size) -> list[float]:
    """Radii of concentric edges around (cx, cy): peaks of the mean radial gradient."""
    radii = np.arange(0.12 * size, 0.75 * size, 0.5, dtype=np.float32)
    prof = np.nan_to_num(_profile(gx, gy, cx, cy, radii))
    prof = np.convolve(prof, np.ones(3) / 3, mode="same")
    if prof.max() <= 0:
        return []
    k = 4  # +-2 px
    peaks = [
        (float(radii[i]), float(prof[i]))
        for i in range(k, len(prof) - k)
        if prof[i] >= 0.3 * prof.max() and prof[i] == prof[i - k : i + k + 1].max()
    ]
    # Merge peaks closer than 0.8% of the image (one physical edge seen as a double line).
    merged: list[tuple[float, float]] = []
    for r, m in peaks:
        if merged and r - merged[-1][0] < 0.008 * size:
            if m > merged[-1][1]:
                merged[-1] = (r, m)
        else:
            merged.append((r, m))
    return [r for r, _ in merged]


def _refine_ring(gx, gy, cx, cy, r, size) -> tuple[float, float, float]:
    """Coarse-to-fine search for the center (and radius) that makes this one ring sharpest.
    Only radii within a narrow band around r are considered."""
    band = max(2.0, 0.006 * size)

    def sharpness(x, y, around):
        radii = np.arange(around - band, around + band + 0.25, 0.5, dtype=np.float32)
        prof = _profile(gx, gy, x, y, radii, 360)
        if np.all(np.isnan(prof)):
            return -1.0, around
        i = int(np.nanargmax(prof))
        return float(prof[i]), float(radii[i])

    best_s, best_r = sharpness(cx, cy, r)
    step = 0.01 * size
    while step >= 0.25:
        improved = True
        while improved:
            improved = False
            for dx, dy in ((step, 0), (-step, 0), (0, step), (0, -step), (step, step), (-step, -step), (step, -step), (-step, step)):
                s, rr = sharpness(cx + dx, cy + dy, best_r)
                # Stay on this ring: don't let the search hop to a neighbouring one.
                if s > best_s + 1e-6 and abs(rr - r) <= 2 * band:
                    best_s, best_r, cx, cy, improved = s, rr, cx + dx, cy + dy, True
        step /= 2
    return cx, cy, best_r


def _ring_score(gx, gy, cx, cy, r) -> float:
    """Share of the visible circumference where this edge is really present (a rim has an edge
    all the way round; texture such as fur makes strong but patchy edges)."""
    radii = np.arange(r - 2, r + 2.25, 0.5, dtype=np.float32)
    radial, inside = _radial_samples(gx, gy, cx, cy, radii)
    local_max = np.where(inside, radial, 0).max(axis=0)
    visible = inside.any(axis=0)
    if visible.sum() < 0.6 * len(visible):
        return 0.0
    typical = float(np.mean(local_max[visible]))
    return float(((local_max >= 0.35 * typical) & visible).sum() / visible.sum())
