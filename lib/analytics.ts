import type { DecayEvent, HeatCell, MetricStats, SeriesPoint } from "./clickhouse";

/**
 * The analytics ClickHouse does in SQL, done over rows instead.
 *
 * These exist so the dashboard can run without a database of its own. When
 * readings live in openaqi rather than locally there is no query engine to push
 * work into, so the same questions get answered here — from the raw rows the
 * remote store hands back.
 *
 * Every function is deliberately a straight translation of the SQL in
 * `clickhouse.ts` rather than an improvement on it. Where the SQL has a quirk,
 * so does this: two backends that disagree about what "average CO₂ this week"
 * means would be worse than one backend that is slightly wrong, because the
 * disagreement would show up as a number changing when someone switched.
 */

/** Long-form: one metric reading at one instant, exactly as it was recorded. */
export type Sample = { ts: number; metric: string; value: number };

/**
 * Buckets into a fixed number of points and carries values across gaps.
 *
 * Mirrors `series()` + `forwardFill()`. The forward fill is not cosmetic: the
 * collector writes a row only when a value changes, so an empty bucket means
 * "unchanged", not "no reading". Leaving them null would render the charts as
 * dotted fragments and bias any average toward whichever metric churns most.
 */
export function bucketSeries(
  samples: Sample[],
  metrics: string[],
  fromMs: number,
  toMs: number,
  points = 400,
): SeriesPoint[] {
  if (!metrics.length) return [];
  const n = Math.min(Math.max(points, 20), 2000);
  const spanSec = Math.max(1, Math.round((toMs - fromMs) / 1000));
  const bucketMs = Math.max(1, Math.ceil(spanSec / n)) * 1000;

  // Sum and count per bucket per metric, so the bucket value is a mean rather
  // than a last-write-wins sample.
  const buckets = new Map<number, Map<string, { sum: number; n: number }>>();
  for (const s of samples) {
    if (!metrics.includes(s.metric)) continue;
    const b = Math.floor(s.ts / bucketMs) * bucketMs;
    let row = buckets.get(b);
    if (!row) buckets.set(b, (row = new Map()));
    const cell = row.get(s.metric) ?? { sum: 0, n: 0 };
    cell.sum += s.value;
    cell.n += 1;
    row.set(s.metric, cell);
  }

  const last: Record<string, number | null> = {};
  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((b) => {
      const row = buckets.get(b)!;
      const out: SeriesPoint = { t: new Date(b).toISOString() };
      for (const m of metrics) {
        const cell = row.get(m);
        if (cell && cell.n > 0) {
          last[m] = cell.sum / cell.n;
          out[m] = last[m];
        } else {
          // Leading gaps stay null — there is genuinely nothing to carry yet.
          out[m] = last[m] ?? null;
        }
      }
      return out;
    });
}

/**
 * Exact statistics over raw rows, with time-above-threshold duration-weighted.
 *
 * Mirrors the `spans` CTE: each reading is held until the next one for the same
 * metric, and the final reading is held until the end of the window. Counting
 * rows instead would over-weight whichever metric happens to change most often.
 */
export function computeStats(
  samples: Sample[],
  thresholds: Record<string, number>,
  toMs: number,
): MetricStats[] {
  const byMetric = new Map<string, Sample[]>();
  for (const s of samples) {
    const arr = byMetric.get(s.metric);
    if (arr) arr.push(s);
    else byMetric.set(s.metric, [s]);
  }

  const out: MetricStats[] = [];
  for (const [metric, rows] of byMetric) {
    rows.sort((a, b) => a.ts - b.ts);
    const values = rows.map((r) => r.value);
    const sorted = [...values].sort((a, b) => a - b);
    const threshold = thresholds[metric];

    let secondsAbove = 0;
    let secondsTotal = 0;
    for (let i = 0; i < rows.length; i++) {
      const held = ((i + 1 < rows.length ? rows[i + 1].ts : toMs) - rows[i].ts) / 1000;
      if (held <= 0) continue;
      secondsTotal += held;
      if (threshold !== undefined && rows[i].value > threshold) secondsAbove += held;
    }

    out.push({
      metric,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      samples: rows.length,
      seconds_above: Math.round(secondsAbove),
      seconds_total: Math.round(secondsTotal),
    });
  }
  return out;
}

/**
 * ClickHouse's `quantile` is an approximation; over the row counts a single
 * sensor produces, exact linear interpolation lands in the same place and is
 * easier to reason about than reproducing its reservoir sampling.
 */
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Average by weekday × hour.
 *
 * In UTC, because `toDayOfWeek(ts)` and `toHour(ts)` in the SQL run against a
 * column declared `DateTime64(3, 'UTC')` and therefore do the same. That is
 * arguably wrong — a daily rhythm means little in a timezone nobody lives in —
 * but it is wrong identically in both backends, which is the property worth
 * having until it is fixed in one place.
 */
export function computeHeatmap(samples: Sample[], metric: string): HeatCell[] {
  const cells = new Map<string, { sum: number; n: number }>();
  for (const s of samples) {
    if (s.metric !== metric) continue;
    const d = new Date(s.ts);
    // getUTCDay() is 0 = Sunday; the SQL's toDayOfWeek() is 1 = Monday and is
    // then shifted to 0 = Monday. Same convention, arrived at differently.
    const dow = (d.getUTCDay() + 6) % 7;
    const hour = d.getUTCHours();
    const k = `${dow}:${hour}`;
    const cell = cells.get(k) ?? { sum: 0, n: 0 };
    cell.sum += s.value;
    cell.n += 1;
    cells.set(k, cell);
  }

  return [...cells.entries()]
    .map(([k, c]) => {
      const [dow, hour] = k.split(":").map(Number);
      return { dow, hour, value: c.n ? c.sum / c.n : null, samples: c.n };
    })
    .sort((a, b) => a.dow - b.dow || a.hour - b.hour);
}

/**
 * Estimates ventilation from CO₂ decay.
 *
 * Same model as the SQL: once a room empties, CO₂ falls toward outdoor
 * concentration exponentially, so air changes per hour is the slope of
 * ln(C − C_out) over time. Minute-averaged first, then split into falling runs,
 * then the same three filters — long enough, deep enough, and not already at
 * outdoor level — because short or shallow declines are sensor noise rather
 * than air exchange.
 */
export function computeVentilation(samples: Sample[], outdoorPpm = 420): DecayEvent[] {
  const minutes = new Map<number, { sum: number; n: number }>();
  for (const s of samples) {
    if (s.metric !== "co2") continue;
    const m = Math.floor(s.ts / 60_000) * 60_000;
    const cell = minutes.get(m) ?? { sum: 0, n: 0 };
    cell.sum += s.value;
    cell.n += 1;
    minutes.set(m, cell);
  }

  const series = [...minutes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([m, c]) => ({ m, co2: c.sum / c.n }));

  // Split wherever the series stops falling: the SQL's is_break / running sum.
  const runs: { m: number; co2: number }[][] = [];
  let run: { m: number; co2: number }[] = [];
  for (let i = 0; i < series.length; i++) {
    const falling = i > 0 && series[i].co2 <= series[i - 1].co2;
    if (!falling) {
      if (run.length) runs.push(run);
      run = [series[i]];
    } else {
      run.push(series[i]);
    }
  }
  if (run.length) runs.push(run);

  return runs
    .map((r) => {
      const first = r[0];
      const last = r[r.length - 1];
      const mins = Math.round((last.m - first.m) / 60_000);
      return { first, last, mins };
    })
    .filter(
      ({ first, last, mins }) =>
        mins >= 20 && first.co2 - last.co2 >= 40 && last.co2 > outdoorPpm + 20,
    )
    .map(({ first, last, mins }) => {
      const ach = (Math.log((first.co2 - outdoorPpm) / (last.co2 - outdoorPpm)) / mins) * 60;
      return {
        start: new Date(first.m).toISOString(),
        end: new Date(last.m).toISOString(),
        from_ppm: first.co2,
        to_ppm: last.co2,
        minutes: mins,
        ach: Number(ach.toFixed(3)),
      };
    })
    .filter((e) => Number.isFinite(e.ach) && e.ach > 0)
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
    .slice(0, 20);
}

/** Raw rows as CSV, in the same column order the ClickHouse export produces. */
export function toCsv(
  samples: Sample[],
  meta: { sensorId: string; sensorName: string },
  statusOf: (metric: string, value: number) => string,
): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ["ts,sensor_id,sensor_name,metric,value,status"];
  for (const s of [...samples].sort((a, b) => a.ts - b.ts)) {
    lines.push(
      [
        new Date(s.ts).toISOString(),
        esc(meta.sensorId),
        esc(meta.sensorName),
        esc(s.metric),
        String(s.value),
        esc(statusOf(s.metric, s.value)),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
