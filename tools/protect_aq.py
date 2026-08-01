"""Realtime UP-AirQuality telemetry from UniFi Protect.

The public Integration API (/proxy/protect/integration/v1/sensors) does NOT
expose air quality: its sensor schema only carries light/humidity/temperature,
all null on a UP-AirQuality. The readings live exclusively on the private
Protect API, which rejects API keys and requires a login session:

    POST /api/auth/login              -> TOKEN cookie (+ x-csrf-token)
    GET  /proxy/protect/api/bootstrap -> sensors[].airQuality snapshot
    WSS  /proxy/protect/ws/updates    -> live pushes

Frames on that socket are undocumented: a sequence of 8-byte headers
(type, format, deflated, _, uint32 size) each followed by an optionally
zlib-deflated payload. Packet 1 is the action, packet 2 the data.
"""

from __future__ import annotations

import asyncio
import http.cookiejar
import json
import ssl
import struct
import time
import urllib.error
import urllib.request
import zlib
from typing import AsyncIterator

import websockets

SENSOR_TYPE = "UP-AirQuality"

# Display order is deliberate: headline index, then gases, then particulates,
# then ambient. Keys are UniFi's own field names.
METRICS: dict[str, tuple[str, str]] = {
    "aqi": ("AQI", ""),
    "vape": ("Vape", ""),
    "co2": ("CO₂", "ppm"),
    "voc": ("VOC", ""),
    "tvoc": ("TVOC", "ppb"),
    "pm1p0": ("PM1.0", "µg/m³"),
    "pm2p5": ("PM2.5", "µg/m³"),
    "pm4p0": ("PM4.0", "µg/m³"),
    "pm10p0": ("PM10", "µg/m³"),
    "temperature": ("Temperature", "°C"),
    "humidity": ("Humidity", "%"),
}


class ProtectAQError(RuntimeError):
    pass


class ProtectAQClient:
    """Session-authenticated client for a Protect console's air quality sensors."""

    def __init__(self, host: str, username: str, password: str, verify_ssl: bool = False):
        self.host = host
        self.username = username
        self.password = password
        self._ssl = ssl.create_default_context()
        if not verify_ssl:
            # UniFi consoles ship a self-signed cert (CN=ui.com) by default.
            self._ssl.check_hostname = False
            self._ssl.verify_mode = ssl.CERT_NONE
        self.cookie: str = ""
        self.csrf: str = ""
        self._opener: urllib.request.OpenerDirector | None = None
        # Last known full airQuality per sensor id, so partial pushes can merge.
        self._state: dict[str, dict] = {}

    # -- blocking HTTP, wrapped by the async helpers below -----------------

    def _login_sync(self) -> None:
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=self._ssl),
            urllib.request.HTTPCookieProcessor(jar),
        )
        body = json.dumps(
            {"username": self.username, "password": self.password, "rememberMe": True}
        ).encode()
        req = urllib.request.Request(
            f"https://{self.host}/api/auth/login",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            resp = opener.open(req, timeout=15)
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise ProtectAQError("login rejected: check UNIFI_USER / UNIFI_PASS") from exc
            if exc.code == 499:
                raise ProtectAQError("login needs 2FA; use a local account without MFA") from exc
            raise ProtectAQError(f"login failed: HTTP {exc.code}") from exc

        self.csrf = resp.headers.get("x-csrf-token", "")
        self.cookie = "; ".join(f"{c.name}={c.value}" for c in jar)
        if "TOKEN=" not in self.cookie:
            raise ProtectAQError("login succeeded but no TOKEN cookie was returned")
        self._opener = opener

    def _get_sync(self, path: str) -> dict:
        if self._opener is None:
            self._login_sync()
        assert self._opener is not None
        req = urllib.request.Request(f"https://{self.host}{path}")
        try:
            return json.loads(self._opener.open(req, timeout=20).read())
        except urllib.error.HTTPError as exc:
            if exc.code == 401:  # session aged out mid-flight
                self._login_sync()
                return json.loads(self._opener.open(req, timeout=20).read())
            raise

    # -- async surface ------------------------------------------------------

    async def login(self) -> None:
        await asyncio.to_thread(self._login_sync)

    async def bootstrap(self) -> dict:
        return await asyncio.to_thread(self._get_sync, "/proxy/protect/api/bootstrap")

    async def sensors(self) -> list[dict]:
        """Air quality sensors, with their current readings already merged in."""
        bs = await self.bootstrap()
        found = [s for s in bs.get("sensors", []) if s.get("type") == SENSOR_TYPE]
        for s in found:
            self._state[s["id"]] = dict(s.get("airQuality") or {})
        return found

    async def snapshot(self) -> list[dict]:
        """One-shot reading for every air quality sensor."""
        return [self._reading(s["id"], s.get("name", "sensor"), s.get("airQuality") or {})
                for s in await self.sensors()]

    async def stream(self) -> AsyncIterator[dict]:
        """Yield a reading every time the console pushes new air quality data.

        Reconnects with backoff and re-authenticates when the session expires,
        so this can be left running indefinitely.
        """
        backoff = 1.0
        while True:
            try:
                bs = await self.bootstrap()
                names = {
                    s["id"]: s.get("name", "sensor")
                    for s in bs.get("sensors", [])
                    if s.get("type") == SENSOR_TYPE
                }
                if not names:
                    raise ProtectAQError(f"no {SENSOR_TYPE} sensor found on {self.host}")
                for s in bs.get("sensors", []):
                    if s["id"] in names:
                        self._state[s["id"]] = dict(s.get("airQuality") or {})
                        yield self._reading(s["id"], names[s["id"]], self._state[s["id"]])

                url = (
                    f"wss://{self.host}/proxy/protect/ws/updates"
                    f"?lastUpdateId={bs['lastUpdateId']}"
                )
                async with websockets.connect(
                    url,
                    additional_headers={
                        "Cookie": self.cookie,
                        "Origin": f"https://{self.host}",
                    },
                    ssl=self._ssl,
                    open_timeout=15,
                    ping_interval=20,
                    max_size=None,
                ) as ws:
                    backoff = 1.0
                    async for msg in ws:
                        if isinstance(msg, str):
                            continue
                        reading = self._decode(msg, names)
                        if reading is not None:
                            yield reading

            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - stream must survive anything
                # 4001 on this socket means the session is no longer accepted.
                if "4001" in str(exc) or isinstance(exc, urllib.error.HTTPError):
                    try:
                        await self.login()
                    except Exception:  # noqa: BLE001
                        pass
                yield {"error": f"{type(exc).__name__}: {exc}", "ts": int(time.time() * 1000)}
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    # -- frame decoding -----------------------------------------------------

    @staticmethod
    def _frames(buf: bytes) -> list[bytes]:
        out, i = [], 0
        while i + 8 <= len(buf):
            _, _, deflated, _, size = struct.unpack("!BBBBI", buf[i:i + 8])
            i += 8
            payload = buf[i:i + size]
            i += size
            if deflated:
                try:
                    payload = zlib.decompress(payload)
                except zlib.error:
                    continue
            out.append(payload)
        return out

    def _decode(self, msg: bytes, names: dict[str, str]) -> dict | None:
        objs = []
        for payload in self._frames(msg):
            try:
                objs.append(json.loads(payload))
            except (ValueError, UnicodeDecodeError):
                return None
        if len(objs) < 2:
            return None
        action, data = objs[0], objs[1]
        if action.get("modelKey") != "sensor" or not isinstance(data, dict):
            return None
        sid = action.get("id")
        if sid not in names or "airQuality" not in data:
            return None
        # Pushes can be partial - merge onto the last known full reading.
        merged = self._state.setdefault(sid, {})
        merged.update(data["airQuality"] or {})
        return self._reading(sid, names[sid], merged)

    @staticmethod
    def _reading(sid: str, name: str, air: dict) -> dict:
        return {
            "ts": int(time.time() * 1000),
            "id": sid,
            "name": name,
            "metrics": {
                k: {"value": v.get("value"), "status": v.get("status", "unknown")}
                for k, v in air.items()
                if isinstance(v, dict) and k in METRICS
            },
        }


def client_from_env() -> ProtectAQClient:
    """Build a client from UNIFI_HOST / UNIFI_USER / UNIFI_PASS (.env supported)."""
    import os
    from pathlib import Path

    for env_file in (Path(__file__).with_name(".env"), Path(__file__).parent.parent / ".env"):
        if not env_file.exists():
            continue
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
        break

    user, password = os.environ.get("UNIFI_USER"), os.environ.get("UNIFI_PASS")
    if not user or not password:
        raise ProtectAQError("set UNIFI_USER and UNIFI_PASS (see .env.example)")
    return ProtectAQClient(
        os.environ.get("UNIFI_HOST", "192.168.1.1"),
        user,
        password,
        verify_ssl=os.environ.get("UNIFI_VERIFY_SSL", "").lower() in ("1", "true", "yes"),
    )
