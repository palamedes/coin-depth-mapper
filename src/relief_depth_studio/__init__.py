"""Relief Depth Studio: turn an image into a grayscale depth map for 3D Sliced laser engraving."""

from __future__ import annotations

import argparse
import json
import socket
import threading
import urllib.request
import webbrowser

__version__ = "0.1.0"
DEFAULT_PORT = 8790


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="depthmap",
        description="Open Relief Depth Studio, a local web page that turns an image into a depth map for laser engraving.",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port for the local web page (default: {DEFAULT_PORT})")
    parser.add_argument(
        "--host", default="127.0.0.1", help="address to listen on; 0.0.0.0 lets other devices on your network in"
    )
    parser.add_argument("--no-browser", action="store_true", help="don't open the page in a browser")
    args = parser.parse_args(argv)

    local = args.host in ("127.0.0.1", "localhost")
    url = f"http://{args.host if local else '127.0.0.1'}:{args.port}/"

    if _already_running(url):
        print(f"Relief Depth Studio is already running at {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return
    if not _port_free(args.host, args.port):
        parser.exit(1, f"Port {args.port} is already in use. Try another one, e.g. --port {args.port + 1}\n")

    _quiet_third_party_warnings()
    import uvicorn

    from .device import detect_device
    from .server import create_app

    app = create_app(trusted_hosts=["127.0.0.1", "localhost"] if local else None)
    dev = detect_device()

    print(f"Relief Depth Studio is running at {url}\nCompute device: {dev.label}", flush=True)
    if dev.warning:
        print(f"Note: {dev.warning}", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, [url]).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


def _quiet_third_party_warnings() -> None:
    """Deprecation notices from model libraries mean nothing to someone engraving a coin."""
    import warnings

    warnings.filterwarnings("ignore", category=FutureWarning)
    warnings.filterwarnings("ignore", category=DeprecationWarning)
    warnings.filterwarnings("ignore", message=".*register_new_resolver.*")
    try:
        from huggingface_hub.utils import logging as hf_logging

        hf_logging.set_verbosity_error()  # e.g. "unauthenticated requests" on every download
    except Exception:
        pass


def _already_running(url: str) -> bool:
    try:
        with urllib.request.urlopen(url + "api/system", timeout=1) as r:
            return json.load(r).get("app") == "relief-depth-studio"
    except Exception:
        return False


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # same as uvicorn
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False
