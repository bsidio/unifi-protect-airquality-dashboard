#!/usr/bin/env python3
"""Serve the live air quality dashboard.

Holds one Protect WebSocket open, keeps a rolling history in memory, and
fans readings out to every connected browser over the same HTTP port.

    python3 server.py            # http://localhost:8099
    python3 server.py --port 9000 --history 3600
"""

from __future__ import annotations

import argparse
import asyncio
import json
import signal
import sys
from collections import deque
from http import HTTPStatus
from pathlib import Path

import websockets
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from protect_aq import METRICS, ProtectAQError, client_from_env

STATIC = Path(__file__).parent / "static"
MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"}

clients: set = set()
history: deque = deque()
sensor_name: str = "Air Quality"
last_error: str | None = None


def _static_response(path: str) -> Response:
    rel = "index.html" if path in ("/", "") else path.lstrip("/")
    target = (STATIC / rel).resolve()
    if not str(target).startswith(str(STATIC.resolve())) or not target.is_file():
        return Response(HTTPStatus.NOT_FOUND, "Not Found",
                        Headers({"Content-Type": "text/plain"}), b"not found")
    body = target.read_bytes()
    return Response(
        HTTPStatus.OK, "OK",
        Headers({"Content-Type": MIME.get(target.suffix, "application/octet-stream"),
                 "Content-Length": str(len(body)),
                 "Cache-Control": "no-store"}),
        body,
    )


def process_request(connection, request):
    """Serve static files; let /ws fall through to the WebSocket handshake."""
    if request.path.split("?")[0] != "/ws":
        return _static_response(request.path.split("?")[0])
    return None


async def handler(ws) -> None:
    clients.add(ws)
    try:
        await ws.send(json.dumps({
            "type": "init",
            "name": sensor_name,
            "metrics": {k: {"label": lbl, "unit": unit} for k, (lbl, unit) in METRICS.items()},
            "history": list(history),
            "error": last_error,
        }))
        await ws.wait_closed()
    finally:
        clients.discard(ws)


async def broadcast(payload: dict) -> None:
    if not clients:
        return
    msg = json.dumps(payload)
    await asyncio.gather(*(c.send(msg) for c in list(clients)), return_exceptions=True)


async def pump(maxlen: int) -> None:
    """Read the Protect stream forever, appending to history and fanning out."""
    global sensor_name, last_error
    client = client_from_env()
    async for reading in client.stream():
        if "error" in reading:
            last_error = reading["error"]
            print(f"[stream] {last_error}", file=sys.stderr)
            await broadcast({"type": "status", "error": last_error})
            continue

        last_error = None
        sensor_name = reading["name"]
        point = {
            "ts": reading["ts"],
            "v": {k: m["value"] for k, m in reading["metrics"].items() if m["value"] is not None},
            "s": {k: m["status"] for k, m in reading["metrics"].items()},
        }
        # Drop duplicate pushes that carry no numeric change.
        if history and history[-1]["v"] == point["v"]:
            history[-1]["ts"] = point["ts"]
        else:
            history.append(point)
            while len(history) > maxlen:
                history.popleft()
        await broadcast({"type": "reading", "name": sensor_name, "point": point})


async def main() -> int:
    ap = argparse.ArgumentParser(description="UniFi air quality dashboard server")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to expose on your LAN")
    ap.add_argument("--history", type=int, default=1800, help="points kept in memory")
    args = ap.parse_args()

    try:
        client_from_env()  # fail fast on bad config
    except ProtectAQError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass

    task = asyncio.create_task(pump(args.history))
    async with serve(handler, args.host, args.port, process_request=process_request):
        shown = "localhost" if args.host == "127.0.0.1" else args.host
        print(f"dashboard → http://{shown}:{args.port}")
        await stop.wait()

    task.cancel()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass
