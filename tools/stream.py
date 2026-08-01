#!/usr/bin/env python3
"""Print UP-AirQuality readings to the terminal as they arrive.

    python3 stream.py            # stream live
    python3 stream.py --once     # single snapshot, then exit
"""

import argparse
import asyncio
import sys
from datetime import datetime

from protect_aq import METRICS, ProtectAQError, client_from_env

# Status -> ANSI colour, matching the status vocabulary UniFi reports.
COLOURS = {
    "safe": "\033[32m", "good": "\033[32m", "neutral": "\033[36m",
    "warning": "\033[33m", "moderate": "\033[33m",
    "serious": "\033[35m", "critical": "\033[31m", "unhealthy": "\033[31m",
}
DIM, RESET = "\033[2m", "\033[0m"


def render(reading: dict, use_colour: bool) -> str:
    stamp = datetime.fromtimestamp(reading["ts"] / 1000).strftime("%H:%M:%S")
    parts = []
    for key, (label, unit) in METRICS.items():
        m = reading["metrics"].get(key)
        if not m or m.get("value") is None:
            continue
        value = m["value"]
        text = f"{label} {value:g}{unit}"
        if use_colour:
            text = f"{COLOURS.get(m.get('status'), '')}{text}{RESET}"
        parts.append(text)
    head = f"{DIM}{stamp}{RESET} " if use_colour else f"{stamp} "
    return head + "  ".join(parts)


async def main() -> int:
    ap = argparse.ArgumentParser(description="Stream UniFi UP-AirQuality readings")
    ap.add_argument("--once", action="store_true", help="print one snapshot and exit")
    ap.add_argument("--no-colour", action="store_true", help="disable ANSI colour")
    args = ap.parse_args()
    use_colour = sys.stdout.isatty() and not args.no_colour

    try:
        client = client_from_env()
    except ProtectAQError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    try:
        if args.once:
            readings = await client.snapshot()
            if not readings:
                print("error: no UP-AirQuality sensor found", file=sys.stderr)
                return 1
            for r in readings:
                print(f"{r['name']}:")
                print("  " + render(r, use_colour))
            return 0

        print("connecting to UniFi Protect…", file=sys.stderr)
        async for reading in client.stream():
            if "error" in reading:
                print(f"{DIM}… {reading['error']}{RESET}", file=sys.stderr)
                continue
            print(render(reading, use_colour), flush=True)
    except ProtectAQError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass
