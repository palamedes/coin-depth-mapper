"""HTTP API and static file server for the Relief Depth Studio web app."""

from __future__ import annotations

import io
import json
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

from . import __version__, models
from .coin import detect_circles
from .device import detect_device
from .progress import tracker

WEB_DIR = Path(__file__).resolve().parent / "web"
MAX_UPLOAD_PIXELS = 64_000_000  # ~8000 x 8000


def create_app(trusted_hosts: list[str] | None = None) -> FastAPI:
    app = FastAPI(title="Relief Depth Studio", version=__version__)
    if trusted_hosts:  # blocks DNS-rebinding attacks from web pages when listening on localhost
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=trusted_hosts)

    @app.get("/api/system")
    def system():
        import torch

        dev = detect_device()
        return {
            "app": "relief-depth-studio",
            "version": __version__,
            "device": dev.as_dict(),
            "torch": torch.__version__,
        }

    @app.get("/api/models")
    def list_models():
        return [m.describe() for m in models.all_models()]

    @app.post("/api/models/{model_id}/prepare")
    def prepare(model_id: str):
        _known(model_id)
        try:
            models.prepare(model_id)
        except FileNotFoundError as e:
            raise HTTPException(409, str(e))
        except Exception as e:
            raise HTTPException(500, f"Could not load {model_id}: {e}")
        return models.get(model_id).describe()

    @app.get("/api/status")
    def status():
        return tracker.snapshot()

    @app.post("/api/depth")
    def depth(
        image: UploadFile = File(...),
        model_id: str = Form(...),
        resolution: int = Form(...),
        params: str = Form("{}"),
    ):
        """Run a depth model. Returns raw float32 (little-endian, row-major), 0..1, near = 1.
        Width and height are in the X-Depth-Width / X-Depth-Height headers."""
        _known(model_id)
        rgb = _read_image(image)
        try:
            extra = {k: int(v) for k, v in json.loads(params or "{}").items()}
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, "params must be a JSON object of integers")
        t0 = time.time()
        try:
            d = models.predict(model_id, rgb, resolution, extra)
        except FileNotFoundError as e:
            raise HTTPException(409, str(e))
        except MemoryError as e:
            raise HTTPException(507, str(e))
        except Exception as e:
            raise HTTPException(500, f"{model_id} failed: {e}")
        h, w = d.shape
        return Response(
            content=np.ascontiguousarray(d, dtype="<f4").tobytes(),
            media_type="application/octet-stream",
            headers={
                "X-Depth-Width": str(w),
                "X-Depth-Height": str(h),
                "X-Model": model_id,
                "X-Elapsed": f"{time.time() - t0:.3f}",
            },
        )

    @app.post("/api/detect-circle")
    def detect_circle(image: UploadFile = File(...)):
        rgb = _read_image(image)
        return {"width": rgb.shape[1], "height": rgb.shape[0], "circles": detect_circles(rgb)}

    @app.exception_handler(KeyError)
    def _key_error(_, exc: KeyError):
        return JSONResponse({"detail": str(exc.args[0]) if exc.args else "not found"}, status_code=404)

    if (WEB_DIR / "index.html").is_file():
        app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            f = (WEB_DIR / path).resolve()
            if path and f.is_file() and WEB_DIR in f.parents:
                return FileResponse(f)
            return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})
    else:

        @app.get("/", include_in_schema=False)
        def not_built():
            return HTMLResponse(
                "<h1>Relief Depth Studio</h1><p>The web interface has not been built yet. "
                "Run <code>npm install && npm run build</code> in the <code>frontend</code> folder, "
                "or just start the app with <code>./depthmap</code>, which builds it for you.</p>"
            )

    return app


def _known(model_id: str) -> None:
    try:
        models.get(model_id)
    except KeyError as e:
        raise HTTPException(404, str(e.args[0]))


def _read_image(upload: UploadFile) -> np.ndarray:
    data = upload.file.read()
    Image.MAX_IMAGE_PIXELS = MAX_UPLOAD_PIXELS
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            # Transparent areas become black: the model then sees the subject in front of a flat backdrop.
            rgba = img.convert("RGBA")
            bg = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
            img = Image.alpha_composite(bg, rgba)
        return np.asarray(img.convert("RGB"))
    except Image.DecompressionBombError:
        raise HTTPException(413, "Image is too large (over 64 megapixels)")
    except Exception:
        raise HTTPException(400, "Could not read the image. Use PNG, JPG or WebP.")
