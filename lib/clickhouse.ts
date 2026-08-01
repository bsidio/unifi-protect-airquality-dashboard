import "server-only";

import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { env } from "./env";
import { METRIC_KEYS } from "./metrics";

const TABLE = "readings";

declare global {
  // eslint-disable-next-line no-var
  var __ch: ClickHouseClient | undefined;
}

export function ch(): ClickHouseClient {
  if (!globalThis.__ch) {
    const c = env.clickhouse;
    globalThis.__ch = createClient({
      url: c.url,
      database: c.database,
      username: c.username,
      password: c.password,
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 0 },
    });
  }
  return globalThis.__ch;
}

export type Row = {
  ts: string;
  console: string;
  sensor_id: string;
  sensor_name: string;
  metric: string;
  value: number;
  status: string;
};

export async function insertReadings(rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  await ch().insert({ table: TABLE, values: rows, format: "JSONEachRow" });
}

export type DeviceRow = {
  sensor_id: string;
  sensor_name: string;
  last_seen: string;
  first_seen: string;
  points: number;
};

/** Devices are derived from the readings themselves — no separate registry. */
export async function listDevices(): Promise<DeviceRow[]> {
  const rs = await ch().query({
    query: `
      SELECT sensor_id,
             argMax(sensor_name, ts) AS sensor_name,
             max(ts)                 AS last_seen,
             min(ts)                 AS first_seen,
             count()                 AS points
      FROM ${TABLE}
      GROUP BY sensor_id
      ORDER BY last_seen DESC`,
    format: "JSONEachRow",
  });
  return rs.json<DeviceRow>();
}

export type LatestRow = { metric: string; value: number; status: string; ts: string };

export async function latestReadings(sensorId: string): Promise<LatestRow[]> {
  const rs = await ch().query({
    query: `
      SELECT metric,
             argMax(value, ts)  AS value,
             argMax(status, ts) AS status,
             max(ts)            AS ts
      FROM ${TABLE}
      WHERE sensor_id = {sensor:String}
      GROUP BY metric`,
    query_params: { sensor: sensorId },
    format: "JSONEachRow",
  });
  return rs.json<LatestRow>();
}

export type SeriesPoint = { t: string } & Record<string, number | string | null>;

/**
 * Bucketed history for a device. The bucket width is derived from the window so
 * a chart never pulls more than roughly `points` rows per metric.
 */
export async function series(opts: {
  sensorId: string;
  metrics: string[];
  fromMs: number;
  toMs: number;
  points?: number;
}): Promise<SeriesPoint[]> {
  const metrics = opts.metrics.filter((m) => METRIC_KEYS.includes(m as never));
  if (metrics.length === 0) return [];

  const points = Math.min(Math.max(opts.points ?? 400, 20), 2000);
  const spanSec = Math.max(1, Math.round((opts.toMs - opts.fromMs) / 1000));
  const bucketSec = Math.max(1, Math.ceil(spanSec / points));

  const cols = metrics
    .map((m) => `avgIf(value, metric = '${m}') AS \`${m}\``)
    .join(",\n             ");

  const rs = await ch().query({
    query: `
      SELECT toStartOfInterval(ts, INTERVAL {bucket:UInt32} SECOND) AS t,
             ${cols}
      FROM ${TABLE}
      WHERE sensor_id = {sensor:String}
        AND ts >= fromUnixTimestamp64Milli({from:Int64})
        AND ts <= fromUnixTimestamp64Milli({to:Int64})
        AND metric IN {metrics:Array(String)}
      GROUP BY t
      ORDER BY t`,
    query_params: {
      sensor: opts.sensorId,
      from: opts.fromMs,
      to: opts.toMs,
      metrics,
      bucket: bucketSec,
    },
    format: "JSONEachRow",
  });

  return forwardFill(await rs.json<SeriesPoint>(), metrics);
}

/**
 * Carries the last known value forward across empty buckets.
 *
 * The collector only writes a row when a metric actually changes, so a bucket
 * with no row does not mean "no reading" — it means "unchanged". Without this
 * the charts render as dotted fragments, one island per write, and any average
 * over the window would be biased toward whichever metric happens to churn
 * most. Leading gaps stay null: there is genuinely nothing to carry yet.
 */
function forwardFill(rows: SeriesPoint[], metrics: string[]): SeriesPoint[] {
  const last: Record<string, number | null> = {};
  for (const row of rows) {
    for (const m of metrics) {
      const v = row[m];
      // ClickHouse sends NaN for avgIf over an empty set, which JSON-encodes as null.
      if (v === null || v === undefined || !Number.isFinite(Number(v))) {
        row[m] = last[m] ?? null;
      } else {
        last[m] = Number(v);
        row[m] = last[m];
      }
    }
  }
  return rows;
}

export type ChHealth = {
  ok: boolean;
  error?: string;
  version?: string;
  rows?: number;
  tableExists?: boolean;
};

export async function health(): Promise<ChHealth> {
  try {
    const v = await ch().query({ query: "SELECT version() AS v", format: "JSONEachRow" });
    const version = (await v.json<{ v: string }>())[0]?.v;

    const t = await ch().query({
      query: `SELECT count() AS n FROM system.tables
              WHERE database = {db:String} AND name = {t:String}`,
      query_params: { db: env.clickhouse.database, t: TABLE },
      format: "JSONEachRow",
    });
    const tableExists = Number((await t.json<{ n: string }>())[0]?.n ?? 0) > 0;
    if (!tableExists) return { ok: false, version, tableExists: false, error: `table ${TABLE} is missing` };

    const c = await ch().query({ query: `SELECT count() AS n FROM ${TABLE}`, format: "JSONEachRow" });
    const rows = Number((await c.json<{ n: string }>())[0]?.n ?? 0);
    return { ok: true, version, rows, tableExists };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Creates the readings table if it does not exist yet (idempotent). */
export async function ensureSchema(): Promise<void> {
  await ch().command({
    query: `
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        ts           DateTime64(3, 'UTC'),
        console      LowCardinality(String),
        sensor_id    LowCardinality(String),
        sensor_name  LowCardinality(String),
        metric       LowCardinality(String),
        value        Float64,
        status       LowCardinality(String)
      ) ENGINE = MergeTree
      PARTITION BY toYYYYMM(ts)
      ORDER BY (sensor_id, metric, ts)
      TTL toDateTime(ts) + INTERVAL 24 MONTH`,
  });
}
