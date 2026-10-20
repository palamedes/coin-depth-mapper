"""What the backend is busy with right now, polled by the UI via GET /api/status."""

from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass, field

from tqdm.auto import tqdm


@dataclass
class Status:
    state: str = "idle"  # idle | downloading | loading | inferring | error
    model_id: str | None = None
    message: str = ""
    done: float = 0  # bytes (downloading) or steps (inferring)
    total: float = 0
    started: float = field(default_factory=time.time)
    error: str | None = None


class Tracker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._status = Status()

    def snapshot(self) -> dict:
        with self._lock:
            d = asdict(self._status)
        d["elapsed"] = time.time() - d.pop("started")
        return d

    def set(self, state: str, model_id: str | None = None, message: str = "", total: float = 0) -> None:
        with self._lock:
            self._status = Status(state=state, model_id=model_id, message=message, total=total)

    def advance(self, n: float) -> None:
        with self._lock:
            self._status.done += n

    def fail(self, error: str) -> None:
        with self._lock:
            self._status.state = "error"
            self._status.error = error

    def idle(self) -> None:
        self.set("idle")

    def tqdm_class(self) -> type[tqdm]:
        """A tqdm subclass that forwards byte counts to this tracker (for huggingface_hub downloads)."""
        tracker = self

        class _Forwarding(tqdm):
            def __init__(self, *args, **kwargs):
                kwargs["disable"] = False
                kwargs["file"] = _NullFile()
                super().__init__(*args, **kwargs)

            def update(self, n=1):
                # Xet downloads open two bars per file, "reconstructing file" and "downloading bytes",
                # over the same bytes. Count only the first (plain HTTP downloads have just one bar).
                if n and "downloading bytes" not in (self.desc or ""):
                    tracker.advance(n)
                return super().update(n)

        return _Forwarding


class _NullFile:
    def write(self, *_):
        pass

    def flush(self):
        pass


tracker = Tracker()
