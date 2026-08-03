import "server-only";

import {
  bucketSeries,
  computeHeatmap,
  computeStats,
  computeVentilation,
  toCsv,
  type Sample,
} from "./analytics";
import type {
  DecayEvent,
  DeviceRow,
  HeatCell,
  LatestRow,
  MetricStats,
  SeriesPoint,
} from "./clickhouse";
import { env } from "./env";
import { METRIC_KEYS, OPENAQI_UNSUPPORTED } from "./metrics";
import type { Interval, Provenance, StoreHealth, StoreMode } from "./store-types";
import { parseStoreTs } from "./utils";

/**
 * Reading this sensor's history back out of openaqi.
 *
 * The counterpart to `lib/openaqi.ts`, which only ever writes. Together they
 * make openaqi usable as the dashboard's whole store, so that contributing
 * readings and keeping them stop being two separate jobs — and nobody has to
 * run a database to see their own air.
 *
 * openaqi has no query engine to push work into, so it returns rows and the
 * arithmetic happens here, in `lib/analytics.ts`. That is deliberate: it keeps
 * openaqi's API from growing a bespoke endpoint per chart, and it keeps the
 * statistics next to the ClickHouse SQL they mirror.
 */

/** openaqi's catalogue has no `vape` — it is a UniFi-specific index with no
 *  published health meaning, so it is never sent and has no history to read. */
const NO_REMOTE_HISTORY = new Set(OPENAQI_UNSUPPORTED);

/** Requests are cheap (own-station reads are not charged to the public quota),
 *  but four panels asking for overlapping windows is still four round trips. */
const CACHE_TTL_RECENT_MS = 30_000;
/** A window that ended in the past cannot change. */
const CACHE_TTL_PAST_MS = 3_600_000;
const CACHE_MAX = 24;

/** Below the API's 20 000 hard cap, with room for the odd dense metric. */
const TARGET_POINTS = 15_000;

type Station = { id: string; name: string; timezone: string };

type CacheEntry = { at: number; ttl: number; value: FetchResult };

type FetchResult = {
  samples: Sample[];
  basis: Interval;
  truncated: boolean;
  unavailable: string[];
};

type State = {
  station: { at: number; value: Station | null } | null;
  cache: Map<string, CacheEntry>;
  inflight: Map<string, Promise<FetchResult>>;
  /** Set when the key is refused. Mirrors the write side so the two halves
   *  never disagree about whether the key is good. */
  halted: string | null;
  cooldownUntil: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __openaqiRead: State | undefined;
}

function state(): State {
  if (!globalThis.__openaqiRead) {
    globalThis.__openaqiRead = {
      station: null,
      cache: new Map(),
      inflight: new Map(),
      halted: null,
      cooldownUntil: 0,
    };
  }
  return globalThis.__openaqiRead;
}

/* ── transport ─────────────────────────────────────────────────────────────── */

async function api<T>(path: string): Promise<T> {
  const s = state();
  if (s.halted) throw new Error(s.halted);

  const cfg = env.openaqi;
  if (!cfg.key) throw new Error("OPENAQI_KEY is not set");

  const res = await fetch(`${cfg.api}${path}`, {
    headers: {
      authorization: `Bearer ${cfg.key}`,
      "user-agent": "unifi-airquality-dashboard",
    },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });

  if (res.status === 401 || res.status === 403) {
    // Will not fix itself, and the same message the write side uses, so an
    // operator sees one problem rather than two.
    s.halted =
      "openaqi rejected the API key. Check OPENAQI_KEY, or issue a new one at https://openaqi.net/account";
    throw new Error(s.halted);
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? 30);
    s.cooldownUntil = Date.now() + Math.max(30, retry) * 1000;
    throw new Error(`openaqi is rate-limiting; retrying after ${retry}s`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openaqi returned HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { data: T };
  return json.data;
}

/**
 * Which station this key opens.
 *
 * An ingest key resolves to exactly one, which is what keeps configuration at a
 * single variable — the dashboard is given a key, not a key and an id.
 */
async function station(): Promise<Station> {
  const s = state();
  if (s.station && Date.now() - s.station.at < 600_000 && s.station.value) {
    return s.station.value;
  }

  const explicit = env.openaqi.stationId;
  const data = await api<{ stations: Station[] }>("/api/v1/stations");
  const found = explicit
    ? data.stations.find((st) => st.id === explicit)
    : data.stations[0];

  if (!found) {
    throw new Error(
      explicit
        ? `OPENAQI_STATION=${explicit} is not a station this key opens`
        : "This key opens no stations — register one at https://openaqi.net/account",
    );
  }
  s.station = { at: Date.now(), value: found };
  return found;
}

/* ── window → interval ─────────────────────────────────────────────────────── */

/**
 * The finest resolution that keeps a window under the API's point cap.
 *
 * Finest rather than "enough for a chart", because one fetch serves both the
 * chart and the statistics: a chart needs ~400 points, but `p95` and
 * time-above-threshold get better the closer the data is to raw.
 */
export function intervalFor(spanMs: number): Interval {
  const h = spanMs / 3_600_000;
  if (h <= 2) return "raw";
  if (h <= 48) return "1m";
  if (h <= 240) return "5m";
  if (h <= 1080) return "15m";
  if (h <= 4320) return "1h";
  return "6h";
}

const SECONDS: Record<Interval, number> = {
  raw: 0,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "3h": 10800,
  "6h": 21600,
  "1d": 86400,
};

/** One step coarser, for when a window truncates anyway. */
function coarser(i: Interval): Interval | null {
  const order: Interval[] = ["raw", "1m", "5m", "15m", "1h", "3h", "6h", "1d"];
  const next = order[order.indexOf(i) + 1];
  return next ?? null;
}

/* ── the primitive everything is built on ──────────────────────────────────── */

/**
 * Raw-ish rows for a window, in the long form the analytics want.
 *
 * The API returns wide rows aligned by timestamp (`{t, pm2p5, co2}`) because
 * that is what charts and dataframes want; the statistics want one sample per
 * metric per instant. Converting here means the API stays the shape everyone
 * else needs and only this file pays for it.
 */
async function fetchSamples(opts: {
  metrics: string[];
  fromMs: number;
  toMs: number;
  interval?: Interval;
}): Promise<FetchResult> {
  const wanted = opts.metrics.filter((m) => METRIC_KEYS.includes(m as never));
  const unavailable = wanted.filter((m) => NO_REMOTE_HISTORY.has(m));
  const askable = wanted.filter((m) => !NO_REMOTE_HISTORY.has(m));

  if (!askable.length) {
    return { samples: [], basis: "raw", truncated: false, unavailable };
  }

  // Snapped to a 30s grid before it becomes a cache key. Without this,
  // `to = Date.now()` makes every request unique and the cache never hits.
  const from = Math.floor(opts.fromMs / 30_000) * 30_000;
  const to = Math.ceil(opts.toMs / 30_000) * 30_000;
  const interval = opts.interval ?? intervalFor(to - from);
  const key = `${from}:${to}:${interval}:${[...askable].sort().join(",")}`;

  const s = state();
  const hit = s.cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) {
    return { ...hit.value, unavailable };
  }

  // While rate-limited, stale beats nothing and beats an error page.
  if (Date.now() < s.cooldownUntil && hit) {
    return { ...hit.value, unavailable };
  }

  const flying = s.inflight.get(key);
  if (flying) return { ...(await flying), unavailable };

  const work = (async (): Promise<FetchResult> => {
    const st = await station();
    let use = interval;
    let samples: Sample[] = [];
    let truncated = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      samples = [];
      truncated = false;
      let cursor = from;

      // Bounded, so a pathological window cannot walk forever.
      for (let page = 0; page < 4; page++) {
        const qs = new URLSearchParams({
          from: new Date(cursor).toISOString(),
          to: new Date(to).toISOString(),
          interval: use,
          metrics: askable.join(","),
        });
        const data = await api<{
          metrics: string[];
          points: Record<string, unknown>[];
          truncated: boolean;
          continue_from?: string | null;
        }>(`/api/v1/stations/${st.id}/readings?${qs}`);

        // Iterate what the server says it returned, not what we asked for: a
        // metric it silently has nothing for becomes `unavailable` rather than
        // a column of nulls nobody can explain.
        for (const p of data.points) {
          const ts = parseStoreTs(String(p.t));
          if (!Number.isFinite(ts)) continue;
          for (const m of data.metrics) {
            const v = Number(p[m]);
            if (Number.isFinite(v)) samples.push({ ts, metric: m, value: v });
          }
        }

        truncated = Boolean(data.truncated);
        if (!truncated || !data.continue_from) break;
        const next = parseStoreTs(data.continue_from);
        if (!Number.isFinite(next) || next <= cursor) break;
        cursor = next + 1;
      }

      if (!truncated) break;
      const wider = coarser(use);
      if (!wider) break;
      use = wider;
    }

    return { samples, basis: use, truncated, unavailable: [] };
  })();

  s.inflight.set(key, work);
  try {
    const value = await work;
    const ttl = to < Date.now() - 60_000 ? CACHE_TTL_PAST_MS : CACHE_TTL_RECENT_MS;
    s.cache.set(key, { at: Date.now(), ttl, value });
    if (s.cache.size > CACHE_MAX) {
      const oldest = [...s.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) s.cache.delete(oldest[0]);
    }
    return { ...value, unavailable };
  } finally {
    s.inflight.delete(key);
  }
}

function provenanceOf(r: FetchResult): Provenance {
  return {
    backend: "openaqi",
    basis: r.basis,
    ...(r.truncated ? { truncated: true } : {}),
    ...(r.unavailable.length ? { unavailable: r.unavailable } : {}),
    ...(Date.now() < state().cooldownUntil ? { stale: true } : {}),
  };
}

/* ── the store surface ─────────────────────────────────────────────────────── */

/**
 * One device, always: a key opens one station, and the readings it holds came
 * from this sensor. The id is openaqi's; `app/api/devices` overlays the live
 * name and id from the collector when the sensor is connected, so the picker
 * does not show two entries for one sensor.
 */
export async function listDevices(): Promise<{ devices: DeviceRow[]; provenance: Provenance }> {
  const st = await station();
  const latest = await api<{
    coverage: { readings: number; first_reading: string | null; last_reading: string | null };
  }>(`/api/v1/stations/${st.id}/latest`);

  return {
    devices: [
      {
        sensor_id: st.id,
        sensor_name: st.name,
        last_seen: latest.coverage.last_reading ?? "",
        first_seen: latest.coverage.first_reading ?? "",
        points: latest.coverage.readings,
      },
    ],
    provenance: { backend: "openaqi", basis: "raw" },
  };
}

export async function latestReadings(
  _sensorId: string,
): Promise<{ rows: LatestRow[]; provenance: Provenance }> {
  const st = await station();
  const data = await api<{
    readings: { metric: string; value: number; ts: string }[];
  }>(`/api/v1/stations/${st.id}/latest`);

  return {
    rows: data.readings.map((r) => ({
      metric: r.metric,
      value: r.value,
      // Empty, not openaqi's own severity grade: the UI's tooltip says this is
      // the word the sensor reported, and openaqi's grading is not that.
      status: "",
      ts: r.ts,
    })),
    provenance: { backend: "openaqi", basis: "raw" },
  };
}

export async function series(opts: {
  sensorId: string;
  metrics: string[];
  fromMs: number;
  toMs: number;
  points?: number;
}): Promise<{ points: SeriesPoint[]; provenance: Provenance }> {
  const r = await fetchSamples({ metrics: opts.metrics, fromMs: opts.fromMs, toMs: opts.toMs });
  const charted = opts.metrics.filter((m) => !NO_REMOTE_HISTORY.has(m));
  return {
    points: bucketSeries(r.samples, charted, opts.fromMs, opts.toMs, opts.points ?? 400),
    provenance: provenanceOf(r),
  };
}

export async function stats(opts: {
  sensorId: string;
  fromMs: number;
  toMs: number;
  thresholds: Record<string, number>;
}): Promise<{ stats: MetricStats[]; provenance: Provenance }> {
  // Same window and the same cache entry the chart just used, so the two panels
  // cost one request between them.
  const r = await fetchSamples({
    metrics: Object.keys(opts.thresholds),
    fromMs: opts.fromMs,
    toMs: opts.toMs,
  });
  return {
    stats: computeStats(r.samples, opts.thresholds, opts.toMs),
    provenance: provenanceOf(r),
  };
}

export async function heatmap(opts: {
  sensorId: string;
  metric: string;
  fromMs: number;
  toMs: number;
}): Promise<{ cells: HeatCell[]; provenance: Provenance }> {
  const r = await fetchSamples({
    metrics: [opts.metric],
    fromMs: opts.fromMs,
    toMs: opts.toMs,
  });
  return { cells: computeHeatmap(r.samples, opts.metric), provenance: provenanceOf(r) };
}

export async function ventilation(opts: {
  sensorId: string;
  fromMs: number;
  toMs: number;
  outdoorPpm?: number;
}): Promise<{ events: DecayEvent[]; provenance: Provenance }> {
  // Forced fine: the decay detector minute-averages and then requires a
  // 20-minute falling run. At 5m granularity that is four points and the
  // detector becomes a noise amplifier. Clamped so the fine interval cannot
  // blow the point cap.
  const MAX_SPAN_MS = 13 * 86_400_000;
  const fromMs = Math.max(opts.fromMs, opts.toMs - MAX_SPAN_MS);
  const r = await fetchSamples({
    metrics: ["co2"],
    fromMs,
    toMs: opts.toMs,
    interval: "1m",
  });
  return {
    events: computeVentilation(r.samples, opts.outdoorPpm),
    provenance: {
      ...provenanceOf(r),
      ...(fromMs > opts.fromMs ? { truncated: true } : {}),
    },
  };
}

export async function exportCsv(opts: {
  sensorId: string;
  metrics: string[];
  fromMs: number;
  toMs: number;
}): Promise<{ csv: string; provenance: Provenance }> {
  const st = await station();
  // Raw: an export is the one place completeness beats economy.
  const r = await fetchSamples({
    metrics: opts.metrics,
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    interval: "raw",
  });
  return {
    // Blank rather than derived from our own thresholds. The local export's
    // status column holds the word the sensor reported; filling it with a
    // different vocabulary would make two exports look comparable when they
    // are not.
    csv: toCsv(r.samples, { sensorId: st.id, sensorName: st.name }, () => ""),
    provenance: { ...provenanceOf(r), statusUnavailable: true },
  };
}

/** What openaqi holds for this station. Used by `both` mode to prove that
 *  forwarding is landing, not merely switched on. */
export async function coverage(): Promise<{
  station: string;
  readings: number;
  lastReading: string | null;
}> {
  const st = await station();
  const data = await api<{
    coverage: { readings: number; last_reading: string | null };
  }>(`/api/v1/stations/${st.id}/latest`);
  return {
    station: st.name,
    readings: data.coverage.readings,
    lastReading: data.coverage.last_reading,
  };
}

export async function health(mode: StoreMode): Promise<StoreHealth> {
  try {
    const st = await station();
    const data = await api<{
      coverage: { readings: number; first_reading: string | null };
    }>(`/api/v1/stations/${st.id}/latest`);
    return {
      mode,
      backend: "openaqi",
      ok: true,
      rows: data.coverage.readings,
      station: { id: st.id, name: st.name, firstReading: data.coverage.first_reading },
    };
  } catch (e) {
    return {
      mode,
      backend: "openaqi",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
