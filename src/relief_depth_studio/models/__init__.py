"""Registry of depth models. Order here is the order shown in the UI."""

from __future__ import annotations

import gc
import threading

import torch

from ..device import detect_device
from ..progress import tracker
from . import da3, marigold, monorelief
from .base import DepthAdapter

_adapters: dict[str, DepthAdapter] = {a.info.id: a for a in [*da3.build(), *marigold.build(), *monorelief.build()]}
_gpu_lock = threading.Lock()
MAX_LOADED = 2  # keep at most this many models in (GPU) memory

OOM_HELP = (
    "The GPU ran out of memory. Lower the processing resolution (or Marigold's ensemble size), "
    "or close other programs that use the GPU, then try again."
)


def all_models() -> list[DepthAdapter]:
    return list(_adapters.values())


def get(model_id: str) -> DepthAdapter:
    try:
        return _adapters[model_id]
    except KeyError:
        raise KeyError(f"Unknown model {model_id!r}") from None


def register(adapter: DepthAdapter) -> None:
    """Add an adapter at runtime (used by tests)."""
    _adapters[adapter.info.id] = adapter


_recent: list[str] = []


def _release_memory() -> None:
    """Give PyTorch's cached GPU memory back so other programs (and a second app instance) can use it."""
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif torch.backends.mps.is_available():
        torch.mps.empty_cache()


def _touch(model_id: str) -> None:
    if model_id in _recent:
        _recent.remove(model_id)
    _recent.append(model_id)
    while len(_recent) > MAX_LOADED:
        _adapters[_recent.pop(0)].unload()
    _release_memory()


def _unload_others(model_id: str) -> None:
    for other in list(_recent):
        if other != model_id:
            _adapters[other].unload()
            _recent.remove(other)
    _release_memory()


def prepare(model_id: str) -> None:
    """Download (if needed) and load a model, without running it."""
    adapter = get(model_id)
    with _gpu_lock:
        try:
            adapter.load(detect_device())
            _touch(model_id)
        except Exception as e:
            tracker.fail(str(e))
            raise
        tracker.idle()


def predict(model_id: str, image, resolution: int, params: dict):
    adapter = get(model_id)
    ok, reason = adapter.availability()
    if not ok:
        raise FileNotFoundError(reason)
    device = detect_device()
    with _gpu_lock:
        try:
            for attempt in (1, 2):
                try:
                    adapter.load(device)
                    _touch(model_id)
                    if tracker.snapshot()["state"] != "inferring":
                        tracker.set("inferring", model_id, f"{adapter.info.name}: estimating depth")
                    depth = adapter.predict(image, resolution, device, **params)
                    break
                except torch.OutOfMemoryError:
                    # Free everything else this app holds and try once more before giving up.
                    if attempt == 2:
                        raise MemoryError(OOM_HELP) from None
                    _unload_others(model_id)
        except Exception as e:
            tracker.fail(str(e))
            raise
        finally:
            _release_memory()
        tracker.idle()
    return depth
