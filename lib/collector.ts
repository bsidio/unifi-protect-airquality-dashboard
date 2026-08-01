import "server-only";

import { EventEmitter } from "node:events";

import { ensureSchema, insertReadings, type Row } from "./clickhouse";
import { env } from "./env";
import { METRIC_KEYS } from "./metrics";
import { ProtectClient, type Reading } from "./protect";

/**
 * Owns the single long-lived Protect connection for this server process:
 * writes every reading to ClickHouse in batches and re-broadcasts it to any
 * connected browser via the `reading` event.
 */

export type CollectorStatus = {
  running: boolean;
  connected: boolean;
  error: string | null;
  startedAt: number | null;
  lastReadingAt: number | null;
  received: number;
  written: number;
  pending: number;
  lastFlushAt: number | null;
  lastWriteError: string | null;
};

type CollectorState = {
  bus: EventEmitter;
  status: CollectorStatus;
  latest: Map<string, Reading>;
  buffer: Row[];
  lastValue: Map<string, string>;
  controller: AbortController | null;
  timer: NodeJS.Timeout | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __collector: CollectorState | undefined;
}

function state(): CollectorState {
  if (!globalThis.__collector) {
    const bus = new EventEmitter();
    bus.setMaxListeners(0); // one listener per open browser tab
    globalThis.__collector = {
      bus,
      status: {
        running: false, connected: false, error: null, startedAt: null,
        lastReadingAt: null, received: 0, written: 0, pending: 0,
        lastFlushAt: null, lastWriteError: null,
      },
      latest: new Map(),
      buffer: [],
      lastValue: new Map(),
      controller: null,
      timer: null,
    };
  }
  return globalThis.__collector;
}

export function collectorStatus(): CollectorStatus {
  const s = state();
  return { ...s.status, pending: s.buffer.length };
}

export function latestReadings(): Reading[] {
  return [...state().latest.values()];
}

export function subscribe(fn: (r: Reading) => void): () => void {
  const s = state();
  s.bus.on("reading", fn);
  return () => s.bus.off("reading", fn);
}

function toRows(r: Reading): Row[] {
  const s = state();
  const ts = new Date(r.ts).toISOString().replace("T", " ").replace("Z", "");
  const rows: Row[] = [];

  for (const [metric, sample] of Object.entries(r.metrics)) {
    if (!METRIC_KEYS.includes(metric as never)) continue;
    if (sample.value === null || !Number.isFinite(sample.value)) continue;

    if (env.collector.dedupe) {
      const key = `${r.sensorId}:${metric}`;
      const fingerprint = `${sample.value}|${sample.status}`;
      if (s.lastValue.get(key) === fingerprint) continue;
      s.lastValue.set(key, fingerprint);
    }

    rows.push({
      ts,
      console: r.console,
      sensor_id: r.sensorId,
      sensor_name: r.sensorName,
      metric,
      value: sample.value,
      status: sample.status,
    });
  }
  return rows;
}

async function flush(): Promise<void> {
  const s = state();
  if (s.buffer.length === 0) return;
  const batch = s.buffer.splice(0, s.buffer.length);
  try {
    await insertReadings(batch);
    s.status.written += batch.length;
    s.status.lastFlushAt = Date.now();
    s.status.lastWriteError = null;
  } catch (err) {
    s.status.lastWriteError = err instanceof Error ? err.message : String(err);
    // Keep the batch so the next tick retries, but never grow without bound.
    s.buffer.unshift(...batch.slice(-20_000));
  }
}

export async function startCollector(): Promise<void> {
  const s = state();
  if (s.status.running) return;
  if (!env.collector.enabled) return;

  const { host, user, pass, verifySsl } = env.unifi;
  if (!host || !user || !pass) {
    s.status.error = "UNIFI_HOST / UNIFI_USER / UNIFI_PASS are not configured";
    return;
  }

  s.status.running = true;
  s.status.startedAt = Date.now();
  s.status.error = null;

  try {
    await ensureSchema();
  } catch (err) {
    s.status.lastWriteError = err instanceof Error ? err.message : String(err);
  }

  s.controller = new AbortController();
  s.timer = setInterval(() => void flush(), env.collector.flushMs);

  const client = new ProtectClient({ host, username: user, password: pass, verifySsl });

  void client
    .run(
      (reading) => {
        s.status.received += 1;
        s.status.lastReadingAt = reading.ts;
        s.latest.set(reading.sensorId, reading);
        s.buffer.push(...toRows(reading));
        s.bus.emit("reading", reading);
      },
      {
        signal: s.controller.signal,
        onStatus: ({ connected, error }) => {
          s.status.connected = connected;
          s.status.error = error ?? null;
        },
      },
    )
    .catch((err) => {
      s.status.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      s.status.running = false;
      s.status.connected = false;
    });
}

export async function stopCollector(): Promise<void> {
  const s = state();
  s.controller?.abort();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  await flush();
  s.status.running = false;
  s.status.connected = false;
}
