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

export type MetricStats = {
  metric: string;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  samples: number;
  /** Seconds spent above this metric's "elevated" threshold, duration-weighted. */
  seconds_above: number;
  /** Total seconds covered, so the caller can render a percentage. */
  seconds_total: number;
};

/**
 * Exact statistics over the raw rows — not the bucketed series.
 *
 * Time-above-threshold is duration-weighted rather than counted. The collector
 * only writes when a value changes, so a reading holds until the next one; a
 * plain count of rows would over-weight whichever metric happens to churn most.
 */
export async function stats(opts: {
  sensorId: string;
  fromMs: number;
  toMs: number;
  /** metric -> threshold. Metrics without one still get min/max/avg. */
  thresholds: Record<string, number>;
}): Promise<MetricStats[]> {
  const entries = Object.entries(opts.thresholds).filter(([m]) =>
    METRIC_KEYS.includes(m as never),
  );
  // Build a metric -> threshold expression; NULL means "no band to compare".
  const thresholdExpr = entries.length
    ? `multiIf(${entries.map(([m, v]) => `metric = '${m}', ${Number(v)}`).join(", ")}, NULL)`
    : "NULL";

  const rs = await ch().query({
    query: `
      WITH spans AS (
        SELECT
          metric,
          value,
          dateDiff(
            'second',
            ts,
            leadInFrame(ts, 1, fromUnixTimestamp64Milli({to:Int64}))
              OVER (PARTITION BY metric ORDER BY ts
                    ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING)
          ) AS held_for
        FROM ${TABLE}
        WHERE sensor_id = {sensor:String}
          AND ts >= fromUnixTimestamp64Milli({from:Int64})
          AND ts <= fromUnixTimestamp64Milli({to:Int64})
      )
      SELECT metric,
             min(value)                                   AS min,
             max(value)                                   AS max,
             avg(value)                                   AS avg,
             quantile(0.5)(value)                         AS p50,
             quantile(0.95)(value)                        AS p95,
             count()                                      AS samples,
             sumIf(held_for, value > ${thresholdExpr})    AS seconds_above,
             sum(held_for)                                AS seconds_total
      FROM spans
      GROUP BY metric`,
    query_params: { sensor: opts.sensorId, from: opts.fromMs, to: opts.toMs },
    format: "JSONEachRow",
  });

  return (await rs.json<Record<string, unknown>>()).map((r) => ({
    metric: String(r.metric),
    min: Number(r.min),
    max: Number(r.max),
    avg: Number(r.avg),
    p50: Number(r.p50),
    p95: Number(r.p95),
    samples: Number(r.samples),
    seconds_above: Number(r.seconds_above ?? 0),
    seconds_total: Number(r.seconds_total ?? 0),
  }));
}

export type HeatCell = { dow: number; hour: number; value: number | null; samples: number };

/**
 * Average by weekday × hour — the view that shows a room's daily rhythm, which
 * no amount of scrolling a line chart will reveal.
 */
export async function heatmap(opts: {
  sensorId: string;
  metric: string;
  fromMs: number;
  toMs: number;
}): Promise<HeatCell[]> {
  if (!METRIC_KEYS.includes(opts.metric as never)) return [];
  const rs = await ch().query({
    query: `
      SELECT toDayOfWeek(ts) - 1 AS dow,   -- 0 = Monday
             toHour(ts)          AS hour,
             avg(value)          AS value,
             count()             AS samples
      FROM ${TABLE}
      WHERE sensor_id = {sensor:String}
        AND metric = {metric:String}
        AND ts >= fromUnixTimestamp64Milli({from:Int64})
        AND ts <= fromUnixTimestamp64Milli({to:Int64})
      GROUP BY dow, hour
      ORDER BY dow, hour`,
    query_params: {
      sensor: opts.sensorId,
      metric: opts.metric,
      from: opts.fromMs,
      to: opts.toMs,
    },
    format: "JSONEachRow",
  });
  return (await rs.json<Record<string, unknown>>()).map((r) => ({
    dow: Number(r.dow),
    hour: Number(r.hour),
    value: r.value === null ? null : Number(r.value),
    samples: Number(r.samples),
  }));
}

export type DecayEvent = {
  start: string;
  end: string;
  from_ppm: number;
  to_ppm: number;
  minutes: number;
  /** Air changes per hour implied by this decay. */
  ach: number;
};

/**
 * Estimates ventilation from CO₂ decay.
 *
 * Once a room empties, CO₂ falls toward outdoor concentration exponentially:
 *   C(t) = C_out + (C_0 - C_out)·e^(-n·t)
 * so n — air changes per hour — is the slope of ln(C - C_out) against time.
 * We take sustained falling stretches and solve for n over each.
 *
 * This is an estimate: it assumes no occupants generating CO₂ during the decay
 * and a well-mixed room. Short or shallow declines are discarded because they
 * are dominated by sensor noise rather than air exchange.
 */
export async function ventilation(opts: {
  sensorId: string;
  fromMs: number;
  toMs: number;
  outdoorPpm?: number;
}): Promise<DecayEvent[]> {
  const outdoor = opts.outdoorPpm ?? 420;

  const rs = await ch().query({
    query: `
      WITH minutes AS (
        SELECT toStartOfMinute(ts) AS m, avg(value) AS co2
        FROM ${TABLE}
        WHERE sensor_id = {sensor:String} AND metric = 'co2'
          AND ts >= fromUnixTimestamp64Milli({from:Int64})
          AND ts <= fromUnixTimestamp64Milli({to:Int64})
        GROUP BY m
        ORDER BY m
      ),
      diffed AS (
        -- Mark the start of a new run wherever the series stops falling.
        SELECT m, co2,
               if(co2 <= lagInFrame(co2, 1, 1e9) OVER (ORDER BY m), 0, 1) AS is_break
        FROM minutes
      ),
      marked AS (
        -- Cumulative sum of those marks groups each falling stretch together.
        -- (ClickHouse forbids nesting one window function inside another's
        -- argument, hence the separate CTE.)
        SELECT m, co2,
               sum(is_break) OVER (ORDER BY m ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run
        FROM diffed
      )
      SELECT min(m)                                        AS start,
             max(m)                                        AS end,
             argMin(co2, m)                                AS from_ppm,
             argMax(co2, m)                                 AS to_ppm,
             dateDiff('minute', min(m), max(m))            AS minutes
      FROM marked
      GROUP BY run
      HAVING minutes >= 20
         AND from_ppm - to_ppm >= 40
         AND to_ppm > {outdoor:Float64} + 20
      ORDER BY start DESC
      LIMIT 20`,
    query_params: {
      sensor: opts.sensorId,
      from: opts.fromMs,
      to: opts.toMs,
      outdoor,
    },
    format: "JSONEachRow",
  });

  return (await rs.json<Record<string, unknown>>())
    .map((r) => {
      const from = Number(r.from_ppm);
      const to = Number(r.to_ppm);
      const minutes = Number(r.minutes);
      // n = ln((C0 - Cout) / (C1 - Cout)) / hours
      const ach = (Math.log((from - outdoor) / (to - outdoor)) / minutes) * 60;
      return {
        start: String(r.start),
        end: String(r.end),
        from_ppm: from,
        to_ppm: to,
        minutes,
        ach: Number(ach.toFixed(3)),
      };
    })
    .filter((e) => Number.isFinite(e.ach) && e.ach > 0);
}

/** Raw rows for the window, streamed out as CSV. */
export async function exportCsv(opts: {
  sensorId: string;
  metrics: string[];
  fromMs: number;
  toMs: number;
}): Promise<string> {
  const metrics = opts.metrics.filter((m) => METRIC_KEYS.includes(m as never));
  const rs = await ch().query({
    query: `
      SELECT ts, sensor_id, sensor_name, metric, value, status
      FROM ${TABLE}
      WHERE sensor_id = {sensor:String}
        AND ts >= fromUnixTimestamp64Milli({from:Int64})
        AND ts <= fromUnixTimestamp64Milli({to:Int64})
        ${metrics.length ? "AND metric IN {metrics:Array(String)}" : ""}
      ORDER BY ts`,
    query_params: {
      sensor: opts.sensorId,
      from: opts.fromMs,
      to: opts.toMs,
      ...(metrics.length ? { metrics } : {}),
    },
    format: "CSVWithNames",
  });
  return rs.text();
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
