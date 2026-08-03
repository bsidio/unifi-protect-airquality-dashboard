"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Wind } from "lucide-react";

import {
  METRICS, METRIC_BY_KEY, formatValue, type MetricDef, type MetricKey,
} from "@/lib/metrics";
import { cn, parseStoreTs } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Heatmap
// ─────────────────────────────────────────────────────────────────────────────

type HeatCell = { dow: number; hour: number; value: number | null; samples: number };

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Green → red, following the EPA AQI convention (good / moderate / unhealthy).
 *
 * Caveat worth knowing: red-green is the single worst pairing for colour-vision
 * deficiency. It is used here because it is the domain's own standard and reads
 * instantly to most people — but colour is never the only channel. Every cell
 * carries its value on hover, the scale is labelled at both ends, and the table
 * view shows the same numbers with no colour at all.
 */
const RAMP = ["#1a7f37", "#4caf50", "#a3c644", "#f7c948", "#f59e0b", "#ef6c3a", "#d03b3b"];

/** Shown when a metric has no published bands to anchor against. */
const NEUTRAL_RAMP = ["#12233b", "#164070", "#1c5cab", "#2a78d6", "#5598e7", "#86b6ef", "#cde2fb"];

function pick(ramp: string[], t: number): string {
  const i = Math.min(ramp.length - 1, Math.max(0, Math.round(t * (ramp.length - 1))));
  return ramp[i];
}

/**
 * Maps a reading onto the ramp using the metric's own thresholds rather than
 * the window's min and max.
 *
 * This matters once colour carries meaning. Scaling to the observed range would
 * paint the busiest hour red even on a day when every reading was comfortably
 * Good — the map would look alarming and mean nothing. Anchoring to the
 * published bands keeps green as "actually fine" and reserves red for readings
 * that have genuinely earned it.
 *
 * Returns null when the metric has no bands, so the caller can fall back to a
 * neutral ramp instead of implying a verdict it cannot support.
 */
function absoluteT(value: number, m: MetricDef): number | null {
  const t = m.thresholds;
  if (!t) return null;

  if (t.kind === "rising") {
    // Anchor points: a sensible floor, then each band edge.
    const anchors = [m.min ?? 0, ...t.steps.map((s) => s.upTo)];
    if (value <= anchors[0]) return 0;
    for (let i = 1; i < anchors.length; i++) {
      if (value <= anchors[i]) {
        const within = (value - anchors[i - 1]) / (anchors[i] - anchors[i - 1] || 1);
        return Math.min(1, (i - 1 + within) / anchors.length);
      }
    }
    return 1;
  }

  // Comfort band: green inside it, warming with distance in either direction.
  const [goodLo, goodHi] = t.good;
  const [fairLo, fairHi] = t.fair;
  if (value >= goodLo && value <= goodHi) return 0.08;
  const over = value > goodHi ? value - goodHi : goodLo - value;
  const slack = value > goodHi ? Math.max(1, fairHi - goodHi) : Math.max(1, goodLo - fairLo);
  return Math.min(1, 0.3 + (over / slack) * 0.45);
}

export function Heatmap({ sensor }: { sensor: string | null }) {
  const [metric, setMetric] = useState<MetricKey>("co2");
  const [days, setDays] = useState(14);
  // Absolute answers "was the air bad?"; relative answers "when does it peak?".
  // They are different questions and one scale cannot serve both.
  const [scale, setScale] = useState<"absolute" | "relative">("absolute");
  const [cells, setCells] = useState<HeatCell[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sensor) return;
    let alive = true;
    setLoading(true);
    fetch(`/api/heatmap?sensor=${sensor}&metric=${metric}&days=${days}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => alive && setCells(j.cells ?? []))
      .catch(() => alive && setCells([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [sensor, metric, days]);

  const { byKey, lo, hi } = useMemo(() => {
    const map = new Map<string, HeatCell>();
    let min = Infinity;
    let max = -Infinity;
    for (const c of cells) {
      if (c.value === null) continue;
      map.set(`${c.dow}:${c.hour}`, c);
      min = Math.min(min, c.value);
      max = Math.max(max, c.value);
    }
    return { byKey: map, lo: min, hi: max };
  }, [cells]);

  const def = METRIC_BY_KEY[metric];
  const span = hi - lo || 1;
  // Colour only carries a verdict when the metric has bands AND we asked for one.
  const graded = Boolean(def.thresholds) && scale === "absolute";

  return (
    <figure className="panel min-w-0 p-4">
      <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold">Daily rhythm</h2>
          <p className="text-[11px] text-muted-foreground">
            Average {def.label} by hour and weekday — where a line chart hides the pattern.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as MetricKey)}
            className="h-7 rounded-md border border-(--hairline) bg-(--surface-panel) px-1.5 text-[11px] outline-none focus:border-white/25"
            aria-label="Heatmap metric"
          >
            {METRICS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <select
            value={scale}
            onChange={(e) => setScale(e.target.value as "absolute" | "relative")}
            className="h-7 rounded-md border border-(--hairline) bg-(--surface-panel) px-1.5 text-[11px] outline-none focus:border-white/25"
            aria-label="Colour scale"
            title="Absolute grades against health thresholds; relative stretches colour across this window to expose the pattern"
          >
            <option value="absolute">Absolute</option>
            <option value="relative">Relative</option>
          </select>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="h-7 rounded-md border border-(--hairline) bg-(--surface-panel) px-1.5 text-[11px] outline-none focus:border-white/25"
            aria-label="Heatmap window"
          >
            {[7, 14, 30, 90].map((d) => (
              <option key={d} value={d}>
                {d}d
              </option>
            ))}
          </select>
        </div>
      </figcaption>

      {loading ? (
        <div className="flex h-[190px] items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : byKey.size === 0 ? (
        <div className="flex h-[190px] items-center justify-center rounded-md border border-dashed border-white/10 text-xs text-muted-foreground">
          Not enough history yet
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            {/* hour ruler */}
            <div className="mb-1 flex gap-px pl-9">
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="flex-1 text-center text-[9px] text-muted-foreground/50">
                  {h % 3 === 0 ? h : ""}
                </div>
              ))}
            </div>
            {DAYS.map((label, dow) => (
              <div key={label} className="mb-px flex items-center gap-px">
                <div className="w-9 pr-1 text-right text-[10px] text-muted-foreground/60">
                  {label}
                </div>
                {Array.from({ length: 24 }, (_, hour) => {
                  const cell = byKey.get(`${dow}:${hour}`);
                  const v = cell?.value ?? null;
                  return (
                    <div
                      key={hour}
                      title={
                        v === null
                          ? `${label} ${hour}:00 — no data`
                          : `${label} ${hour}:00 — ${formatValue(v, def)}${def.unit ? " " + def.unit : ""} (${cell!.samples} readings)`
                      }
                      className="h-5 flex-1 rounded-[2px]"
                      style={{
                        background:
                          v === null
                            ? "rgba(255,255,255,0.03)"
                            : graded
                              ? pick(RAMP, absoluteT(v, def)!)
                              : pick(NEUTRAL_RAMP, (v - lo) / span),
                      }}
                    />
                  );
                })}
              </div>
            ))}

            {/* scale */}
            <div className="mt-3 flex items-center gap-2 pl-9">
              <span className="text-[10px] text-muted-foreground">
                {graded ? "Good" : formatValue(lo, def)}
              </span>
              <div className="flex h-2 flex-1 overflow-hidden rounded-sm">
                {(graded ? RAMP : NEUTRAL_RAMP).map((c) => (
                  <div key={c} className="flex-1" style={{ background: c }} />
                ))}
              </div>
              <span className="text-[10px] text-muted-foreground">
                {graded ? "Severe" : `${formatValue(hi, def)} ${def.unit}`}
              </span>
            </div>
            <p className="mt-1.5 pl-9 text-[10px] text-muted-foreground/60">
              {graded ? (
                <>
                  Graded against {def.source} — an all-green map means the air really was fine.
                  Observed {formatValue(lo, def)}–{formatValue(hi, def)} {def.unit}. Switch to
                  Relative to stretch the colour across this range and see the pattern.
                </>
              ) : def.thresholds ? (
                <>
                  Stretched across {formatValue(lo, def)}–{formatValue(hi, def)} {def.unit} to show
                  the pattern. Colour is relative intensity here, not a health verdict.
                </>
              ) : (
                <>No published bands for {def.label}, so colour shows relative range only.</>
              )}
            </p>
          </div>
        </div>
      )}
    </figure>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ventilation
// ─────────────────────────────────────────────────────────────────────────────

type DecayEvent = {
  start: string;
  end: string;
  from_ppm: number;
  to_ppm: number;
  minutes: number;
  ach: number;
};

/** Rule-of-thumb bands for residential air exchange. */
function achVerdict(ach: number): { label: string; tone: string } {
  if (ach < 0.35) return { label: "Poor", tone: "text-(--status-serious)" };
  if (ach < 0.6) return { label: "Low", tone: "text-(--status-warning)" };
  if (ach <= 2) return { label: "Healthy", tone: "text-(--status-good)" };
  return { label: "Very high", tone: "text-(--status-warning)" };
}

/**
 * Air changes per hour, derived from how fast CO₂ falls once a room empties.
 *
 * This is inference, not measurement — the header says so, because an
 * unqualified "1.5 ACH" would read as a spec sheet number rather than an
 * estimate from a decay curve.
 */
export function VentilationCard({ sensor }: { sensor: string | null }) {
  const [data, setData] = useState<{ medianAch: number | null; events: DecayEvent[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sensor) return;
    let alive = true;
    setLoading(true);
    fetch(`/api/ventilation?sensor=${sensor}&days=7`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => alive && setData({ medianAch: j.medianAch ?? null, events: j.events ?? [] }))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [sensor]);

  const ach = data?.medianAch ?? null;
  const verdict = ach === null ? null : achVerdict(ach);

  return (
    <figure className="panel min-w-0 p-4">
      <figcaption className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Wind className="size-3.5 text-muted-foreground" /> Ventilation estimate
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Inferred from CO₂ decay over the last 7 days, not measured directly.
          </p>
        </div>
        {ach !== null && (
          <div className="shrink-0 text-right">
            <span className={cn("figure text-2xl font-semibold", verdict?.tone)}>
              {ach.toFixed(2)}
            </span>
            <span className="ml-1 text-[11px] text-muted-foreground">ACH</span>
          </div>
        )}
      </figcaption>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Analysing…
        </div>
      ) : ach === null ? (
        <p className="py-6 text-xs text-muted-foreground">
          No clean decay yet. This needs CO₂ to rise and then fall by at least 40 ppm over 20+
          minutes with nobody in the room — usually overnight or after a room empties.
        </p>
      ) : (
        <>
          <p className="mb-3 text-[11px] leading-snug text-muted-foreground">
            <span className={cn("font-medium", verdict?.tone)}>{verdict?.label}.</span>{" "}
            {ach < 0.35
              ? "Air is barely being replaced; CO₂ and VOCs will accumulate overnight."
              : ach <= 2
                ? "The room exchanges its air roughly " +
                  (ach < 1 ? "every " + Math.round(60 / ach) + " minutes" : ach.toFixed(1) + "× per hour") +
                  ", which is in the healthy range for a bedroom."
                : "Very rapid exchange — likely a window or door left open."}
          </p>
          <ul className="space-y-1">
            {data!.events.slice(0, 4).map((e) => (
              <li
                key={e.start}
                className="flex items-center justify-between gap-3 border-t border-(--hairline)/50 pt-1 text-[11px]"
              >
                <span className="figure text-muted-foreground">
                  {new Date(parseStoreTs(e.start)).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="figure text-muted-foreground">
                  {Math.round(e.from_ppm)} → {Math.round(e.to_ppm)} ppm / {e.minutes}m
                </span>
                <span className="figure font-medium">{e.ach.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </figure>
  );
}
