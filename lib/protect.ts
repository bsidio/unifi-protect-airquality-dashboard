import "server-only";

import https from "node:https";
import { inflateSync } from "node:zlib";
import WebSocket from "ws";

/**
 * Realtime UP-AirQuality telemetry from a UniFi Protect console.
 *
 * The public Integration API does NOT carry air quality — its sensor schema
 * stops at light/humidity/temperature (all null on a UP-AirQuality), and it
 * rejects nothing but API keys. The readings exist only on the private API,
 * which requires a real login session:
 *
 *   POST /api/auth/login              -> TOKEN cookie
 *   GET  /proxy/protect/api/bootstrap -> sensors[].airQuality snapshot
 *   WSS  /proxy/protect/ws/updates    -> live pushes
 *
 * Frames on that socket are undocumented: a run of 8-byte headers
 * (type, format, deflated, _, uint32 size) each followed by an optionally
 * zlib-deflated payload. Packet 1 is the action, packet 2 the data.
 */

export const SENSOR_TYPE = "UP-AirQuality";

export type MetricSample = { value: number | null; status: string };
export type Reading = {
  ts: number;
  sensorId: string;
  sensorName: string;
  console: string;
  metrics: Record<string, MetricSample>;
};

export type ProtectOptions = {
  host: string;
  username: string;
  password: string;
  verifySsl?: boolean;
};

type RequestResult = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

function request(
  opts: ProtectOptions,
  path: string,
  init: { method?: string; body?: string; cookie?: string } = {},
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: opts.host,
        path,
        method: init.method ?? "GET",
        rejectUnauthorized: opts.verifySsl ?? false,
        headers: {
          ...(init.body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(init.body) } : {}),
          ...(init.cookie ? { Cookie: init.cookie } : {}),
        },
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    if (init.body) req.write(init.body);
    req.end();
  });
}

export class ProtectClient {
  private cookie = "";
  /** Last full airQuality per sensor, so partial pushes can be merged. */
  private state = new Map<string, Record<string, MetricSample>>();

  constructor(private opts: ProtectOptions) {}

  get consoleHost(): string {
    return this.opts.host;
  }

  async login(): Promise<void> {
    const body = JSON.stringify({
      username: this.opts.username,
      password: this.opts.password,
      rememberMe: true,
    });
    const res = await request(this.opts, "/api/auth/login", { method: "POST", body });
    if (res.status === 499) throw new Error("login needs 2FA — use a local account without MFA");
    if (res.status >= 400) throw new Error(`login failed: HTTP ${res.status}`);

    const setCookie = res.headers["set-cookie"];
    const jar = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [])
      .map((c) => c.split(";")[0])
      .filter(Boolean);
    if (!jar.some((c) => c.startsWith("TOKEN="))) {
      throw new Error("login succeeded but no TOKEN cookie was returned");
    }
    this.cookie = jar.join("; ");
  }

  private async getJson<T>(path: string): Promise<T> {
    if (!this.cookie) await this.login();
    let res = await request(this.opts, path, { cookie: this.cookie });
    if (res.status === 401) {
      await this.login();
      res = await request(this.opts, path, { cookie: this.cookie });
    }
    if (res.status >= 400) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
    return JSON.parse(res.body.toString("utf8")) as T;
  }

  async bootstrap(): Promise<any> {
    return this.getJson<any>("/proxy/protect/api/bootstrap");
  }

  /** Air quality sensors currently known to the console. */
  async sensors(): Promise<any[]> {
    const bs = await this.bootstrap();
    return (bs?.sensors ?? []).filter((s: any) => s?.type === SENSOR_TYPE);
  }

  async snapshot(): Promise<Reading[]> {
    return (await this.sensors()).map((s) => {
      const metrics = normalise(s.airQuality ?? {});
      this.state.set(s.id, metrics);
      return this.toReading(s.id, s.name ?? "sensor", metrics);
    });
  }

  private toReading(id: string, name: string, metrics: Record<string, MetricSample>): Reading {
    return { ts: Date.now(), sensorId: id, sensorName: name, console: this.opts.host, metrics };
  }

  private decode(buf: Buffer, names: Map<string, string>): Reading | null {
    const objs: any[] = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const deflated = buf[i + 2];
      const size = buf.readUInt32BE(i + 4);
      i += 8;
      let payload = buf.subarray(i, i + size);
      i += size;
      if (deflated) {
        try {
          payload = inflateSync(payload);
        } catch {
          return null;
        }
      }
      try {
        objs.push(JSON.parse(payload.toString("utf8")));
      } catch {
        return null;
      }
    }
    if (objs.length < 2) return null;

    const [action, data] = objs;
    if (action?.modelKey !== "sensor" || !data || typeof data !== "object") return null;
    const id: string = action.id;
    if (!names.has(id) || !data.airQuality) return null;

    // Pushes may be partial — merge onto the last known full reading.
    const merged = { ...(this.state.get(id) ?? {}), ...normalise(data.airQuality) };
    this.state.set(id, merged);
    return this.toReading(id, names.get(id)!, merged);
  }

  /**
   * Holds the Protect socket open, invoking `onReading` for every push.
   * Reconnects with backoff and re-authenticates when the session ages out.
   * Resolves only when `signal` aborts.
   */
  async run(
    onReading: (r: Reading) => void,
    opts: { signal?: AbortSignal; onStatus?: (s: { connected: boolean; error?: string }) => void } = {},
  ): Promise<void> {
    let backoff = 1000;

    while (!opts.signal?.aborted) {
      let socket: WebSocket | null = null;
      try {
        const bs = await this.bootstrap();
        const names = new Map<string, string>();
        for (const s of bs?.sensors ?? []) {
          if (s?.type === SENSOR_TYPE) names.set(s.id, s.name ?? "sensor");
        }
        if (names.size === 0) throw new Error(`no ${SENSOR_TYPE} sensor found on ${this.opts.host}`);

        // Seed from the snapshot so a chart has data immediately.
        for (const s of bs.sensors ?? []) {
          if (!names.has(s.id)) continue;
          const metrics = normalise(s.airQuality ?? {});
          this.state.set(s.id, metrics);
          onReading(this.toReading(s.id, names.get(s.id)!, metrics));
        }

        const url = `wss://${this.opts.host}/proxy/protect/ws/updates?lastUpdateId=${bs.lastUpdateId}`;
        socket = new WebSocket(url, {
          rejectUnauthorized: this.opts.verifySsl ?? false,
          headers: { Cookie: this.cookie, Origin: `https://${this.opts.host}` },
        });

        await new Promise<void>((resolve, reject) => {
          const ws = socket!;
          const abort = () => ws.close();
          opts.signal?.addEventListener("abort", abort, { once: true });

          ws.on("open", () => {
            backoff = 1000;
            opts.onStatus?.({ connected: true });
          });
          ws.on("message", (data) => {
            if (!Buffer.isBuffer(data)) return;
            const reading = this.decode(data, names);
            if (reading) onReading(reading);
          });
          ws.on("error", (err) => reject(err));
          ws.on("close", (code) => {
            opts.signal?.removeEventListener("abort", abort);
            if (opts.signal?.aborted) return resolve();
            // 4001 means the console no longer accepts this session.
            reject(new Error(`socket closed (${code})`));
          });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.onStatus?.({ connected: false, error: message });
        if (message.includes("4001") || message.includes("401")) this.cookie = "";
        if (opts.signal?.aborted) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      } finally {
        socket?.removeAllListeners();
        if (socket && socket.readyState === WebSocket.OPEN) socket.close();
      }
    }
  }
}

function normalise(air: Record<string, any>): Record<string, MetricSample> {
  const out: Record<string, MetricSample> = {};
  for (const [k, v] of Object.entries(air ?? {})) {
    if (v && typeof v === "object" && "value" in v) {
      out[k] = { value: typeof v.value === "number" ? v.value : null, status: String(v.status ?? "unknown") };
    }
  }
  return out;
}
