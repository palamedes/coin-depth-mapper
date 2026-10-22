"""HTTP API and static file server for the Relief Depth Studio web app."""

from __future__ import annotations

import io
import json
import os
import re
import time
import zipfile
from pathlib import Path
from urllib.parse import quote

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
PROJECT_DIR = Path(__file__).resolve().parents[2]
MAX_UPLOAD_PIXELS = 64_000_000  # ~8000 x 8000
COIN_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
FONT_TYPES = {".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2"}
PROJECT_EXT = ".rdsproj"


def default_coins_dir() -> Path:
    """Background coins a cut-out subject can be placed on: every image in this folder."""
    return Path(os.environ.get("RDS_COINS_DIR", PROJECT_DIR / "coins"))


def default_fonts_dir() -> Path:
    """Fonts for text layers, on top of the ones installed on the computer."""
    return Path(os.environ.get("RDS_FONTS_DIR", PROJECT_DIR / "fonts"))


def default_projects_dir() -> Path:
    """Saved projects (one .rdsproj file each)."""
    return Path(os.environ.get("RDS_PROJECTS_DIR", PROJECT_DIR / "projects"))


def create_app(
    trusted_hosts: list[str] | None = None,
    coins_dir: Path | None = None,
    fonts_dir: Path | None = None,
    projects_dir: Path | None = None,
) -> FastAPI:
    app = FastAPI(title="Relief Depth Studio", version=__version__)
    coins = (coins_dir or default_coins_dir()).resolve()
    fonts = (fonts_dir or default_fonts_dir()).resolve()
    projects = (projects_dir or default_projects_dir()).resolve()
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

    _add_library(app, "coins", coins, COIN_TYPES, _image_ext, "standard")
    _add_library(app, "fonts", fonts, FONT_TYPES, _font_ext)
    _add_projects(app, projects)

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


def _display_name(f: Path) -> str:
    name = re.sub(r"[-_]+", " ", f.stem).strip()
    return name[:1].upper() + name[1:]


def _new_path(folder: Path, filename: str | None, ext: str, fallback: str) -> Path:
    """An unused path in the folder for an uploaded file, with a safe name based on its own."""
    stem = re.sub(r"[^A-Za-z0-9 _-]+", "", Path(filename or "").stem).strip(" .-_")[:60] or fallback
    folder.mkdir(parents=True, exist_ok=True)
    f = folder / f"{stem}{ext}"
    n = 2
    while f.exists():
        f = folder / f"{stem}-{n}{ext}"
        n += 1
    return f


def _in_folder(folder: Path, name: str, types) -> Path:
    """The file of that name directly in the folder (never anywhere else), or a 404."""
    f = (folder / name).resolve()
    if f.parent != folder or not f.is_file() or f.suffix.lower() not in types:
        raise HTTPException(404, f"No file named {name}")
    return f


def _add_library(app: FastAPI, kind: str, folder: Path, types: dict[str, str], detect, first: str | None = None) -> None:
    """A folder of files the app lists, serves and adds to: GET /api/<kind>, GET /api/<kind>/<file>, POST /api/<kind>."""

    def entry(f: Path) -> dict:
        return {"file": f.name, "name": _display_name(f), "url": f"api/{kind}/{quote(f.name)}"}

    @app.get(f"/api/{kind}")
    def list_files():
        files = [f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in types] if folder.is_dir() else []
        files.sort(key=lambda f: (f.stem.lower() != first, f.name.lower()))
        return {"folder": str(folder), kind: [entry(f) for f in files]}

    @app.get(f"/api/{kind}/{{name}}")
    def get_file(name: str):
        f = _in_folder(folder, name, types)
        return FileResponse(f, media_type=types[f.suffix.lower()])

    @app.post(f"/api/{kind}")
    def add_file(file: UploadFile = File(...)):
        """Copy a file into the folder (kept as it is) under a safe, unused name, and return its entry."""
        data = file.file.read()
        f = _new_path(folder, file.filename, detect(data), kind[:-1])
        f.write_bytes(data)
        return entry(f)


def _add_projects(app: FastAPI, folder: Path) -> None:
    """Saved projects: listed newest first, opened, saved as new, saved over, deleted, and previewed."""
    types = {PROJECT_EXT}

    def entry(f: Path) -> dict:
        st = f.stat()
        url = f"api/projects/{quote(f.name)}"
        return {"file": f.name, "name": _display_name(f), "url": url, "preview": f"{url}/preview?v={st.st_mtime_ns}",
                "saved": st.st_mtime, "bytes": st.st_size}

    def write(f: Path, data: bytes) -> None:
        # Write beside it and swap it in, so a failed save never leaves half a project.
        tmp = folder / f".saving-{os.getpid()}-{time.time_ns()}{PROJECT_EXT}"
        try:
            with open(tmp, "xb") as out:
                out.write(data)
            os.replace(tmp, f)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    @app.get("/api/projects")
    def list_projects():
        files = [f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in types and not f.name.startswith(".")] if folder.is_dir() else []
        return {"folder": str(folder), "projects": sorted((entry(f) for f in files), key=lambda e: -e["saved"])}

    @app.get("/api/projects/{name}")
    def get_project(name: str):
        return FileResponse(_in_folder(folder, name, types), media_type="application/zip")

    @app.get("/api/projects/{name}/preview")
    def project_preview(name: str):
        try:
            with zipfile.ZipFile(_in_folder(folder, name, types)) as z:
                png = z.read("preview.png")
        except (KeyError, zipfile.BadZipFile):
            raise HTTPException(404, f"{name} has no preview")
        return Response(png, media_type="image/png", headers={"Cache-Control": "max-age=31536000"})

    @app.post("/api/projects")
    def add_project(file: UploadFile = File(...)):
        """Save a new project under a safe, unused name based on the uploaded file's name."""
        data = file.file.read()
        _check_project(data)
        f = _new_path(folder, file.filename, PROJECT_EXT, "project")
        write(f, data)
        return entry(f)

    @app.put("/api/projects/{name}")
    def replace_project(name: str, file: UploadFile = File(...)):
        """Save over an existing project."""
        f = _in_folder(folder, name, types)
        data = file.file.read()
        _check_project(data)
        write(f, data)
        return entry(f)

    @app.delete("/api/projects/{name}")
    def delete_project(name: str):
        _in_folder(folder, name, types).unlink()
        return {"deleted": name}


def _check_project(data: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            meta = json.loads(z.read("project.json"))
    except (zipfile.BadZipFile, KeyError, ValueError):
        meta = None
    if not isinstance(meta, dict) or meta.get("app") != "relief-depth-studio" or meta.get("type") != "project":
        raise HTTPException(400, "That isn't a Relief Depth Studio project file.")


def _image_ext(data: bytes) -> str:
    Image.MAX_IMAGE_PIXELS = MAX_UPLOAD_PIXELS
    try:
        fmt = Image.open(io.BytesIO(data)).format
    except Exception:
        raise HTTPException(400, "Could not read the image. Use PNG, JPG or WebP.")
    ext = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}.get(fmt or "")
    if not ext:
        raise HTTPException(400, "Coins must be PNG, JPG or WebP images.")
    return ext


def _font_ext(data: bytes) -> str:
    ext = {b"\x00\x01\x00\x00": ".ttf", b"true": ".ttf", b"OTTO": ".otf", b"wOFF": ".woff", b"wOF2": ".woff2"}.get(data[:4])
    if not ext:
        raise HTTPException(400, "Fonts must be TTF, OTF, WOFF or WOFF2 files.")
    return ext


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
