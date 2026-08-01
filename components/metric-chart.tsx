"use client";

import { useMemo } from "react";

import { EChartsAreaChart } from "@/components/evilcharts/charts/echarts-area-chart";
import type { ChartConfig } from "@/components/evilcharts/ui/echarts-chart";
import { METRIC_BY_KEY, type MetricDef, type StatusTone } from "@/lib/metrics";

export type SeriesPoint = { t: number } & Record<string, number | null>;

/**
 * The series takes the colour of the level the sensor is currently reporting,
 * so a chart reads as "how bad is this right now" at a glance. These are the
 * reserved status steps — legitimate here because the hue *is* encoding status
 * rather than identity — and the status word is always rendered beside the
 * figure, so colour never carries the meaning alone.
 */
export const TONE_RAMP: Record<StatusTone, { light: string[]; dark: string[] }> = {
  good: { light: ["#0ca30c", "#7fd07f"], dark: ["#0ca30c", "#0a5f0a"] },
  neutral: { light: ["#2a78d6", "#86b6ef"], dark: ["#3987e5", "#1c5cab"] },
  warning: { light: ["#fab219", "#fcd786"], dark: ["#fab219", "#8a6100"] },
  serious: { light: ["#ec835a", "#f4bda6"], dark: ["#ec835a", "#8c4526"] },
  critical: { light: ["#d03b3b", "#e79191"], dark: ["#d03b3b", "#7a2020"] },
};

/** Kept for the stacked chart's fallback and any non-status series. */
export const SERIES_COLORS = TONE_RAMP.neutral;

/**
 * Fixed categorical order for the stacked particulate bands — assigned in slot
 * order and never cycled, so a band keeps its colour when others are filtered.
 */
export const BAND_COLORS: Record<string, { light: string[]; dark: string[] }> = {
  band_1p0: { light: ["#2a78d6"], dark: ["#3987e5"] },
  band_2p5: { light: ["#eb6834"], dark: ["#d95926"] },
  band_4p0: { light: ["#1baf7a"], dark: ["#199e70"] },
  band_10: { light: ["#eda100"], dark: ["#c98500"] },
};

/** The x-axis is a category axis, so points carry a preformatted label. */
function withLabels<T extends { t: number }>(rows: T[], span: number) {
  const fmt: Intl.DateTimeFormatOptions =
    span > 3 * 24 * 3600_000
      ? { month: "short", day: "numeric" }
      : span > 6 * 3600_000
        ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
        : { hour: "2-digit", minute: "2-digit" };
  return rows.map((r) => ({ ...r, label: new Date(r.t).toLocaleString([], fmt) }));
}

function spanOf(points: SeriesPoint[]): number {
  return points.length > 1 ? points[points.length - 1].t - points[0].t : 0;
}

/** Thins x tick labels so they never collide on a dense window. */
function tickEvery(count: number): number {
  return Math.max(1, Math.ceil(count / 8));
}

// ─────────────────────────────────────────────────────────────────────────────

/** One metric, one chart, one axis. */
export function MetricChart({
  metric,
  points,
  tone = "neutral",
}: {
  metric: MetricDef;
  points: SeriesPoint[];
  /** Status level of the latest reading — drives the series colour. */
  tone?: StatusTone;
}) {
  const data = useMemo(() => {
    const rows = points
      .filter((p) => p[metric.key] !== null && p[metric.key] !== undefined)
      .map((p) => ({ t: p.t, [metric.key]: Number(p[metric.key]) }));
    return withLabels(rows, spanOf(points));
  }, [points, metric.key]);

  const config = useMemo<ChartConfig>(
    () => ({ [metric.key]: { label: metric.label, colors: TONE_RAMP[tone] } }),
    [metric.key, metric.label, tone],
  );

  if (data.length === 0) return <EmptyChart />;

  const step = tickEvery(data.length);

  return (
    <EChartsAreaChart
      data={data}
      config={config}
      xDataKey="label"
      curveType="linear"
      className="h-[190px] w-full"
    >
      <EChartsAreaChart.Grid />
      <EChartsAreaChart.XAxis
        dataKey="label"
        hideDots
        tickFormatter={(v, i) => (i % step === 0 ? v : "")}
      />
      <EChartsAreaChart.YAxis
        hideDots
        tickFormatter={(v) => compact(v, metric.decimals)}
      />
      <EChartsAreaChart.Tooltip position="fixed" />
      <EChartsAreaChart.Area
        dataKey={metric.key}
        variant="gradient"
        // EvilCharts defaults strokeVariant to "dashed" — these are continuous
        // sensor traces, so they want a solid stroke.
        strokeVariant="solid"
        strokeWidth={2}
        connectNulls
      />
    </EChartsAreaChart>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const BANDS = [
  { key: "band_1p0", label: "≤ 1.0 µm", from: null, to: "pm1p0" },
  { key: "band_2p5", label: "1.0 – 2.5 µm", from: "pm1p0", to: "pm2p5" },
  { key: "band_4p0", label: "2.5 – 4.0 µm", from: "pm2p5", to: "pm4p0" },
  { key: "band_10", label: "4.0 – 10 µm", from: "pm4p0", to: "pm10p0" },
] as const;

/**
 * Particulates as one stacked chart.
 *
 * PM readings are cumulative — PM10 already contains PM2.5, which already
 * contains PM1.0 — so stacking the raw values would count the same particles up
 * to four times and produce a total far above PM10. Instead each series is the
 * size band between two adjacent cuts, which makes the stack total exactly PM10
 * and every band an honest "mass in this size range".
 */
export function StackedParticulateChart({ points }: { points: SeriesPoint[] }) {
  const data = useMemo(() => {
    const rows = points
      .filter((p) => p.pm10p0 !== null && p.pm10p0 !== undefined)
      .map((p) => {
        const at = (k: string) => {
          const v = p[k];
          return v === null || v === undefined ? 0 : Number(v);
        };
        const row: Record<string, number> = { t: p.t };
        for (const b of BANDS) {
          const value = b.from === null ? at(b.to) : at(b.to) - at(b.from);
          row[b.key] = Math.max(0, Number(value.toFixed(3)));
        }
        return row;
      });
    return withLabels(rows as ({ t: number } & Record<string, number>)[], spanOf(points));
  }, [points]);

  const config = useMemo<ChartConfig>(
    () =>
      Object.fromEntries(
        BANDS.map((b) => [b.key, { label: b.label, colors: BAND_COLORS[b.key] }]),
      ),
    [],
  );

  if (data.length === 0) return <EmptyChart />;

  const step = tickEvery(data.length);

  return (
    <EChartsAreaChart
      data={data}
      config={config}
      xDataKey="label"
      curveType="linear"
      stackType="stacked"
      enableHoverHighlight
      className="h-[260px] w-full"
    >
      <EChartsAreaChart.Grid />
      <EChartsAreaChart.XAxis
        dataKey="label"
        hideDots
        tickFormatter={(v, i) => (i % step === 0 ? v : "")}
      />
      <EChartsAreaChart.YAxis hideDots tickFormatter={(v) => compact(v, 1)} />
      <EChartsAreaChart.Tooltip position="fixed" />
      <EChartsAreaChart.Legend align="left" verticalAlign="top" isClickable />
      {BANDS.map((b) => (
        <EChartsAreaChart.Area
          key={b.key}
          dataKey={b.key}
          variant="gradient"
          strokeVariant="solid"
          strokeWidth={1.5}
          connectNulls
        />
      ))}
    </EChartsAreaChart>
  );
}

/** Total particulate mass (= PM10) for the header figure. */
export function particulateTotal(points: SeriesPoint[]): number | null {
  const last = [...points].reverse().find((p) => p.pm10p0 !== null && p.pm10p0 !== undefined);
  return last ? Number(last.pm10p0) : null;
}

export const PM_METRICS = ["pm1p0", "pm2p5", "pm4p0", "pm10p0"] as const;
export const PM_LABEL = METRIC_BY_KEY.pm10p0.unit;

// ─────────────────────────────────────────────────────────────────────────────

function EmptyChart() {
  return (
    <div className="flex h-[190px] items-center justify-center rounded-md border border-dashed border-white/10 text-xs text-muted-foreground">
      No data in this window
    </div>
  );
}

function compact(v: number, decimals: number): string {
  if (Math.abs(v) >= 1000) return `${Math.round(v / 100) / 10}k`;
  return v.toFixed(Math.min(decimals, 1)).replace(/\.0$/, "");
}
