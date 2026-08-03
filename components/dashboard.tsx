"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, CalendarRange, Download, GripVertical, Loader2, LogOut,
  RefreshCw, RotateCcw, Table2, Wind,
} from "lucide-react";

import {
  MetricChart,
  PM_METRICS,
  PREV_SUFFIX,
  StackedParticulateChart,
  particulateTotal,
  type SeriesPoint,
} from "@/components/metric-chart";
import {
  DEFAULT_METRICS,
  GROUP_LABEL,
  METRICS,
  METRIC_BY_KEY,
  formatValue,
  gradeReading,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  toneOfSeverity,
  OPENAQI_UNSUPPORTED,
  type MetricGroup,
  type MetricKey,
} from "@/lib/metrics";
import { Heatmap, VentilationCard } from "@/components/insights";
import { usePersistentState } from "@/lib/use-persistent-state";
import { cn } from "@/lib/utils";
import type { StoreMode } from "@/lib/store-types";

type Device = {
  sensor_id: string;
  sensor_name: string;
  last_seen: string;
  points: number;
  live?: boolean;
};

type MetricStat = {
  metric: string;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  seconds_above: number;
  seconds_total: number;
};

type Reading = {
  ts: number;
  sensorId: string;
  sensorName: string;
  metrics: Record<string, { value: number | null; status: string }>;
};

const RANGES = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
  { label: "7d", minutes: 10080 },
  { label: "30d", minutes: 43200 },
];

/**
 * Overlay presets. `null` offset means "the window immediately before this one",
 * which is derived from the range rather than fixed.
 */
const COMPARE = [
  { id: "off", label: "Off", offsetMs: 0 },
  { id: "prev", label: "Previous period", offsetMs: null },
  { id: "day", label: "Yesterday", offsetMs: 86_400_000 },
  { id: "week", label: "Last week", offsetMs: 604_800_000 },
] as const;

type CompareId = (typeof COMPARE)[number]["id"];

/** Headline figures, in reading order. */
const HERO: MetricKey[] = ["aqi", "co2", "pm2p5", "voc"];

/** Non-metric widgets are ordinary draggable cards with reserved ids. */
const STACK_ID = "__stack";
const HEATMAP_ID = "__heatmap";
const VENT_ID = "__ventilation";
const DEFAULT_ORDER: string[] = [STACK_ID, HEATMAP_ID, VENT_ID, ...DEFAULT_METRICS];

const TONE_CLASS: Record<string, string> = {
  good: "text-(--status-good)",
  neutral: "text-foreground",
  warning: "text-(--status-warning)",
  serious: "text-(--status-serious)",
  critical: "text-(--status-critical)",
};
const TONE_DOT: Record<string, string> = {
  good: "bg-(--status-good)",
  neutral: "bg-muted-foreground",
  warning: "bg-(--status-warning)",
  serious: "bg-(--status-serious)",
  critical: "bg-(--status-critical)",
};

export function Dashboard({
  appName,
  authEnabled,
  storeMode,
}: {
  appName: string;
  authEnabled: boolean;
  storeMode: StoreMode;
}) {
  // openaqi has no `vape` — it is a UniFi-specific index with no published
  // health meaning, so it is never forwarded and has no history to chart. The
  // live value still arrives over the stream.
  const liveOnly = storeMode === "openaqi" ? OPENAQI_UNSUPPORTED : [];
  const [devices, setDevices] = useState<Device[]>([]);
  const [reading, setReading] = useState<Reading | null>(null);
  const [connected, setConnected] = useState(false);
  const [collectorError, setCollectorError] = useState<string | null>(null);

  // Everything the user chooses is remembered in localStorage.
  const [sensor, setSensor] = usePersistentState<string | null>("sensor", null);
  const [rangeMin, setRangeMin] = usePersistentState<number>("range", 60);
  // "relative" follows a rolling window; "custom" pins an absolute calendar range.
  const [mode, setMode] = usePersistentState<"relative" | "custom">("rangeMode", "relative");
  const [customFrom, setCustomFrom] = usePersistentState<string>("from", "");
  const [customTo, setCustomTo] = usePersistentState<string>("to", "");
  const [selected, setSelected] = usePersistentState<MetricKey[]>("metrics", DEFAULT_METRICS);
  const [showStack, setShowStack] = usePersistentState<boolean>("stack", true);
  const [showHeatmap, setShowHeatmap] = usePersistentState<boolean>("heatmap", true);
  const [showVent, setShowVent] = usePersistentState<boolean>("vent", true);
  const [showTable, setShowTable] = usePersistentState<boolean>("table", false);
  const [compare, setCompare] = usePersistentState<CompareId>("compare", "off");
  const [order, setOrder, orderMeta] = usePersistentState<string[]>("order", DEFAULT_ORDER);

  const [points, setPoints] = useState<SeriesPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, MetricStat>>({});
  // What the statistics were computed FROM. Raw locally; remotely the API
  // may have had to bucket a wide window, and averages flatten the tail — a
  // p95 off 15-minute means is understated, and saying so costs one chip.
  const [basis, setBasis] = useState<string>("raw");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const sensorRef = useRef<string | null>(null);
  sensorRef.current = sensor;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/devices", { cache: "no-store" });
        const json = await res.json();
        if (!alive) return;
        const list: Device[] = json.devices ?? [];
        setDevices(list);
        // Keep the stored device only while it still exists.
        setSensor((cur) =>
          cur && list.some((d) => d.sensor_id === cur) ? cur : (list[0]?.sensor_id ?? null),
        );
      } catch {
        /* onboarding surfaces the real problem */
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setSensor]);

  useEffect(() => {
    const es = new EventSource("/api/live");
    es.addEventListener("reading", (e) => {
      const r: Reading = JSON.parse((e as MessageEvent).data);
      if (!sensorRef.current || r.sensorId === sensorRef.current) setReading(r);
    });
    es.addEventListener("status", (e) => {
      const s = JSON.parse((e as MessageEvent).data);
      setConnected(Boolean(s.connected));
      setCollectorError(s.error ?? s.lastWriteError ?? null);
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  const loadSeries = useCallback(async () => {
    if (!sensor) {
      setPoints([]);
      setLoading(false);
      return;
    }
    // Particulates are always fetched — the stacked band chart needs all four.
    const wanted = [...new Set<string>([...selected, ...PM_METRICS])];
    try {
      const q = new URLSearchParams({ sensor, metrics: wanted.join(",") });
      const custom = mode === "custom" ? absoluteRange(customFrom, customTo) : null;
      if (custom) {
        q.set("from", String(custom.from));
        q.set("to", String(custom.to));
      } else {
        q.set("range", String(rangeMin));
      }
      const res = await fetch(`/api/series?${q}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      let merged: SeriesPoint[] = json.points ?? [];

      // Overlay: refetch the same window shifted back, then fold it onto the
      // primary timeline so both series share one x-axis.
      const preset = COMPARE.find((c) => c.id === compare);
      if (preset && preset.id !== "off") {
        const from = Number(json.from);
        const to = Number(json.to);
        const offset = preset.offsetMs ?? to - from;
        const pq = new URLSearchParams({
          sensor,
          metrics: wanted.join(","),
          from: String(from - offset),
          to: String(to - offset),
        });
        const pres = await fetch(`/api/series?${pq}`, { cache: "no-store" });
        const pjson = await pres.json();
        if (pres.ok) merged = overlay(merged, pjson.points ?? [], offset, wanted);
      }

      setPoints(merged);
      setSeriesError(null);

      // Exact statistics come from the raw rows, not these buckets — an average
      // of averages would be wrong, and p95 doubly so.
      const sq = new URLSearchParams({ sensor });
      const win = mode === "custom" ? absoluteRange(customFrom, customTo) : null;
      if (win) {
        sq.set("from", String(win.from));
        sq.set("to", String(win.to));
      } else {
        sq.set("range", String(rangeMin));
      }
      fetch(`/api/stats?${sq}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => {
          setStats(
            Object.fromEntries(((j.stats ?? []) as MetricStat[]).map((x) => [x.metric, x])),
          );
          setBasis(j.provenance?.basis ?? "raw");
        })
        .catch(() => {
          setStats({});
          setBasis("raw");
        });
    } catch (e) {
      setSeriesError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sensor, selected, rangeMin, mode, customFrom, customTo, compare]);

  useEffect(() => {
    setLoading(true);
    void loadSeries();
    const id = setInterval(loadSeries, 20_000);
    return () => clearInterval(id);
  }, [loadSeries]);

  const grouped = useMemo(() => {
    const out = new Map<MetricGroup, typeof METRICS>();
    for (const m of METRICS) {
      if (!out.has(m.group)) out.set(m.group, []);
      out.get(m.group)!.push(m);
    }
    return [...out.entries()];
  }, []);

  /** Visible widgets, in the user's saved order; anything new lands at the end. */
  const widgets = useMemo(() => {
    const visible = new Set<string>([
      ...selected,
      ...(showStack ? [STACK_ID] : []),
      ...(showHeatmap ? [HEATMAP_ID] : []),
      ...(showVent ? [VENT_ID] : []),
    ]);
    const ordered = order.filter((id) => visible.has(id));
    const missing = [...visible].filter((id) => !order.includes(id));
    return [...ordered, ...missing];
  }, [order, selected, showStack, showHeatmap, showVent]);

  function reorder(from: string, to: string) {
    if (from === to) return;
    const base = widgets.slice();
    const fromIdx = base.indexOf(from);
    const toIdx = base.indexOf(to);
    if (fromIdx < 0 || toIdx < 0) return;
    base.splice(toIdx, 0, ...base.splice(fromIdx, 1));
    // Preserve hidden widgets' relative order by appending them back.
    const hidden = order.filter((id) => !base.includes(id));
    setOrder([...base, ...hidden]);
  }

  /** Downloads the raw rows behind the current window, not the bucketed series. */
  function exportCsv() {
    if (!sensor) return;
    const q = new URLSearchParams({ sensor, metrics: [...selected, ...PM_METRICS].join(",") });
    const win = mode === "custom" ? absoluteRange(customFrom, customTo) : null;
    if (win) {
      q.set("from", String(win.from));
      q.set("to", String(win.to));
    } else {
      q.set("range", String(rangeMin));
    }
    window.location.href = `/api/export?${q}`;
  }

  const device = devices.find((d) => d.sensor_id === sensor);
  const at = reading?.ts ? new Date(reading.ts) : null;
  const pmTotal = particulateTotal(points);
  const compareLabel =
    compare === "off" ? null : (COMPARE.find((c) => c.id === compare)?.label ?? null);
  const layoutDirty = orderMeta.hydrated && order.join() !== DEFAULT_ORDER.join();

  return (
    <div className="min-h-screen bg-(--surface-plane)">
      <header className="sticky top-0 z-20 border-b border-(--hairline) bg-(--surface-plane)/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-6 py-3">
          <Wind className="size-5 text-(--status-good)" />
          <div className="mr-auto">
            <h1 className="text-[13px] font-semibold leading-tight tracking-tight">{appName}</h1>
            <p className="micro text-muted-foreground">UniFi Protect · UP-AirQuality</p>
          </div>

          <label className="flex items-center gap-2">
            <span className="micro text-muted-foreground">Device</span>
            <select
              value={sensor ?? ""}
              onChange={(e) => setSensor(e.target.value)}
              className="h-8 min-w-[190px] rounded-md border border-(--hairline) bg-(--surface-panel) px-2 text-xs outline-none focus:border-white/25"
              aria-label="Device"
            >
              {devices.length === 0 && <option value="">No devices yet</option>}
              {devices.map((d) => (
                <option key={d.sensor_id} value={d.sensor_id}>
                  {d.sensor_name}
                  {d.live ? " · live" : ""}
                </option>
              ))}
            </select>
          </label>

          <span
            className="inline-flex items-center gap-2 rounded-full border border-(--hairline) px-2.5 py-1 text-[11px]"
            title={at ? `Last reading ${at.toLocaleString()}` : undefined}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                connected ? "animate-pulse bg-(--status-good)" : "bg-(--status-warning)",
              )}
            />
            {connected ? "Live" : "Reconnecting"}
            {at && <span className="figure text-muted-foreground">{at.toLocaleTimeString()}</span>}
          </span>

          <button
            onClick={() => void loadSeries()}
            className="inline-flex size-8 items-center justify-center rounded-md border border-(--hairline) hover:bg-white/5"
            title="Refresh history"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>

          {authEnabled && (
            <button
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                window.location.href = "/login";
              }}
              className="inline-flex size-8 items-center justify-center rounded-md border border-(--hairline) hover:bg-white/5"
              title="Sign out"
            >
              <LogOut className="size-3.5" />
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] space-y-4 px-6 py-5">
        {collectorError && (
          <div className="flex items-start gap-2 rounded-lg border border-(--status-warning)/40 bg-(--status-warning)/10 px-4 py-2.5 text-xs">
            <AlertTriangle className="mt-px size-3.5 shrink-0 text-(--status-warning)" />
            <span className="text-muted-foreground">{collectorError}</span>
          </div>
        )}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Current readings">
          {HERO.map((key) => {
            const m = METRIC_BY_KEY[key];
            const s = reading?.metrics?.[key];
            const grade = gradeReading(m, s?.value, s?.status);
            const tone = grade.tone;
            return (
              <div key={key} className="panel p-4">
                <div className="flex items-center justify-between">
                  <span className="micro text-muted-foreground">{m.label}</span>
                  <span
                    className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
                    title={
                      grade.sourced === "thresholds"
                        ? `${m.label} level from: ${m.source}`
                        : "Status reported by the sensor (no published bands for this metric)"
                    }
                  >
                    <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
                    {grade.label}
                  </span>
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className={cn("figure text-[38px] font-semibold leading-none", TONE_CLASS[tone])}>
                    {formatValue(s?.value ?? null, m)}
                  </span>
                  <span className="text-xs text-muted-foreground">{m.unit}</span>
                </div>
                <p className="mt-2 text-[11px] leading-snug text-muted-foreground/70">
                  {m.description}
                </p>
              </div>
            );
          })}
        </section>

        <section className="panel flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="micro text-muted-foreground">Range</span>
            <div className="flex gap-0.5 rounded-md border border-(--hairline) p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.label}
                  onClick={() => {
                    setMode("relative");
                    setRangeMin(r.minutes);
                  }}
                  className={cn(
                    "rounded px-2 py-1 text-[11px] font-medium transition",
                    mode === "relative" && rangeMin === r.minutes
                      ? "bg-white/10 text-foreground"
                      : "text-muted-foreground hover:bg-white/5",
                  )}
                >
                  {r.label}
                </button>
              ))}
              <button
                onClick={() => {
                  // Seed the pickers from the window currently on screen.
                  if (!customFrom || !customTo) {
                    const now = new Date();
                    setCustomTo(toLocalInput(now));
                    setCustomFrom(toLocalInput(new Date(now.getTime() - rangeMin * 60_000)));
                  }
                  setMode("custom");
                }}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition",
                  mode === "custom"
                    ? "bg-white/10 text-foreground"
                    : "text-muted-foreground hover:bg-white/5",
                )}
              >
                <CalendarRange className="size-3.5" /> Custom
              </button>
            </div>

            {mode === "custom" && (
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  type="datetime-local"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  aria-label="Start of range"
                  className="figure h-8 rounded-md border border-(--hairline) bg-(--surface-panel) px-2 text-[11px] outline-none focus:border-white/25"
                />
                <span className="text-[11px] text-muted-foreground">to</span>
                <input
                  type="datetime-local"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  aria-label="End of range"
                  className="figure h-8 rounded-md border border-(--hairline) bg-(--surface-panel) px-2 text-[11px] outline-none focus:border-white/25"
                />
                {!absoluteRange(customFrom, customTo) && (
                  <span className="text-[11px] text-(--status-warning)">Pick a valid range</span>
                )}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2">
            <span className="micro text-muted-foreground">Compare</span>
            <select
              value={compare}
              onChange={(e) => setCompare(e.target.value as CompareId)}
              className="h-8 rounded-md border border-(--hairline) bg-(--surface-panel) px-2 text-[11px] outline-none focus:border-white/25"
              aria-label="Overlay an earlier window"
              title="Overlay the same window from an earlier period"
            >
              {COMPARE.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="micro text-muted-foreground">Charts</span>
            {grouped.map(([group, list]) => (
              <div key={group} className="flex items-center gap-1.5">
                <span className="micro text-muted-foreground/50">{GROUP_LABEL[group]}</span>
                {group === "particulate" ? (
                  <Chip
                    on={showStack}
                    onClick={() => setShowStack(!showStack)}
                    title="Particulates as one stacked chart of size bands"
                  >
                    Stacked
                  </Chip>
                ) : (
                  list.map((m) => {
                    // Selectable, and deliberately not auto-deselected: the
                    // choice is the user's and is remembered between visits.
                    // Marking it beats silently dropping it, and the live value
                    // still arrives over the stream — only the history is gone.
                    const noHistory = liveOnly.includes(m.key);
                    return (
                      <Chip
                        key={m.key}
                        on={selected.includes(m.key)}
                        onClick={() =>
                          setSelected(
                            selected.includes(m.key)
                              ? selected.filter((k) => k !== m.key)
                              : [...selected, m.key],
                          )
                        }
                        title={
                          noHistory
                            ? `${m.label} — live only. openaqi does not store this metric, so there is no history to chart.`
                            : m.description
                        }
                      >
                        {m.label}
                        {noHistory && (
                          <span className="ml-1 text-muted-foreground/60">· live only</span>
                        )}
                      </Chip>
                    );
                  })
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="micro text-muted-foreground/50">Insights</span>
            <Chip on={showHeatmap} onClick={() => setShowHeatmap(!showHeatmap)}
              title="Average by hour and weekday">
              Rhythm
            </Chip>
            <Chip on={showVent} onClick={() => setShowVent(!showVent)}
              title="Air changes per hour, inferred from CO₂ decay">
              Ventilation
            </Chip>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={exportCsv}
              className="inline-flex items-center gap-1.5 rounded-md border border-(--hairline) px-2.5 py-1.5 text-[11px] text-muted-foreground transition hover:bg-white/5 hover:text-foreground"
              title="Download the raw readings for this window"
            >
              <Download className="size-3.5" /> CSV
            </button>
            {layoutDirty && (
              <button
                onClick={orderMeta.reset}
                className="inline-flex items-center gap-1.5 rounded-md border border-(--hairline) px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-white/5"
                title="Restore the default widget order"
              >
                <RotateCcw className="size-3.5" /> Reset layout
              </button>
            )}
            <Chip on={showTable} onClick={() => setShowTable(!showTable)}>
              <Table2 className="mr-1 inline size-3.5 align-[-2px]" /> Table
            </Chip>
          </div>
        </section>

        {seriesError && (
          <p className="rounded-lg border border-(--status-critical)/40 bg-(--status-critical)/10 px-4 py-2.5 text-xs">
            Could not load history: {seriesError}
          </p>
        )}

        {loading && points.length === 0 ? (
          <div className="panel flex items-center justify-center gap-2 py-20 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading history…
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <p className="micro text-muted-foreground/50">
                Drag any chart by its handle to rearrange — the layout is saved on this device
              </p>
              <SeverityLegend />
            </div>

            <section className="grid gap-3 xl:grid-cols-2">
              {widgets.map((id) => {
                const isStack = id === STACK_ID;
                const isInsight = id === HEATMAP_ID || id === VENT_ID;
                const m = isStack || isInsight ? null : METRIC_BY_KEY[id];
                if (!isStack && !isInsight && !m) return null;
                const s = m ? reading?.metrics?.[m.key] : undefined;

                // The insight cards render their own panel, so they only need
                // the drag wrapper around them.
                if (isInsight) {
                  return (
                    <div
                      key={id}
                      draggable
                      onDragStart={(e) => {
                        setDragging(id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", id);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setDragOver(null);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (dragOver !== id) setDragOver(id);
                      }}
                      onDragLeave={() => setDragOver((cur) => (cur === id ? null : cur))}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = e.dataTransfer.getData("text/plain") || dragging;
                        if (from) reorder(from, id);
                        setDragging(null);
                        setDragOver(null);
                      }}
                      className={cn(
                        "min-w-0 transition",
                        id === HEATMAP_ID && "xl:col-span-2",
                        dragging === id && "opacity-40",
                        dragOver === id && dragging !== id && "rounded-xl ring-1 ring-white/20",
                      )}
                    >
                      {id === HEATMAP_ID ? (
                        <Heatmap sensor={sensor} />
                      ) : (
                        <VentilationCard sensor={sensor} />
                      )}
                    </div>
                  );
                }

                return (
                  <figure
                    key={id}
                    draggable
                    onDragStart={(e) => {
                      setDragging(id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDragOver(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragOver !== id) setDragOver(id);
                    }}
                    onDragLeave={() => setDragOver((cur) => (cur === id ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = e.dataTransfer.getData("text/plain") || dragging;
                      if (from) reorder(from, id);
                      setDragging(null);
                      setDragOver(null);
                    }}
                    className={cn(
                      // min-w-0: without it this grid item cannot shrink below
                      // the chart canvas's own width and the page scrolls
                      // sideways on a phone.
                      "panel group min-w-0 p-4 transition",
                      isStack && "xl:col-span-2",
                      dragging === id && "opacity-40",
                      dragOver === id && dragging !== id && "border-white/30 ring-1 ring-white/20",
                    )}
                  >
                    <figcaption className="mb-2 flex items-baseline justify-between gap-3">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <GripVertical className="size-4 shrink-0 cursor-grab self-center text-muted-foreground/40 transition group-hover:text-muted-foreground active:cursor-grabbing" />
                        <div className="min-w-0">
                          <h2 className="truncate text-[13px] font-semibold">
                            {isStack ? "Particulate matter by size band" : m!.label}
                          </h2>
                          {isStack && (
                            <p className="text-[11px] text-muted-foreground">
                              Stacked as non-overlapping size ranges, so the total equals PM10
                              rather than counting the same particles four times.
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-baseline gap-2 text-right">
                        {!isStack && (() => {
                          const g = gradeReading(m!, s?.value, s?.status);
                          return (
                            <span
                              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
                              title={
                                g.sourced === "thresholds"
                                  ? `Level from: ${m!.source}`
                                  : "Level reported by the sensor (no published bands for this metric)"
                              }
                            >
                              <span className={cn("size-1.5 rounded-full", TONE_DOT[g.tone])} />
                              {g.label}
                            </span>
                          );
                        })()}
                        <span
                          className={cn(
                            "figure font-semibold",
                            isStack ? "text-2xl" : "text-lg",
                            !isStack && TONE_CLASS[gradeReading(m!, s?.value, s?.status).tone],
                          )}
                        >
                          {isStack
                            ? pmTotal === null
                              ? "—"
                              : pmTotal.toFixed(2)
                            : formatValue(s?.value ?? null, m!)}
                        </span>
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          {isStack ? "µg/m³ total" : m!.unit}
                        </span>
                      </div>
                    </figcaption>

                    {!isStack && stats[m!.key] && (
                      <StatStrip stat={stats[m!.key]} metricKey={m!.key} basis={basis} />
                    )}

                    {isStack ? (
                      <StackedParticulateChart points={points} />
                    ) : (
                      <MetricChart
                        metric={m!}
                        points={points}
                        tone={gradeReading(m!, s?.value, s?.status).tone}
                        compareLabel={compareLabel}
                      />
                    )}
                  </figure>
                );
              })}
            </section>

            {widgets.length === 0 && (
              <p className="panel px-4 py-12 text-center text-xs text-muted-foreground">
                No charts selected — pick a metric above.
              </p>
            )}

            {showTable && <TableView points={points} />}
          </>
        )}

        <footer className="flex items-center gap-2 pb-6 pt-2 text-[11px] text-muted-foreground/60">
          <Activity className="size-3" />
          {device
            ? storeMode === "openaqi"
              ? `${Number(device.points).toLocaleString()} readings stored in openaqi · no local database`
              : storeMode === "both"
                ? `${Number(device.points).toLocaleString()} rows stored in ClickHouse · forwarding to openaqi`
                : `${Number(device.points).toLocaleString()} rows stored in ClickHouse`
            : "Streaming from UniFi Protect"}
        </footer>
      </main>
    </div>
  );
}

/**
 * Folds an earlier window onto the current timeline.
 *
 * Each historical point is shifted forward by `offset` and snapped to the
 * nearest current bucket, so "10:15 yesterday" lines up with "10:15 today"
 * even though the two queries bucket independently. Anything further than half
 * a bucket away is dropped rather than smeared onto the wrong slot.
 */
function overlay(
  current: SeriesPoint[],
  previous: SeriesPoint[],
  offset: number,
  metrics: string[],
): SeriesPoint[] {
  if (current.length === 0 || previous.length === 0) return current;

  // Walk both series in step, carrying the most recent historical value
  // forward. Matching exact bucket slots instead would miss most buckets — the
  // two queries bucket independently, so their boundaries rarely coincide — and
  // every miss renders as a drop to zero rather than a gap.
  const sorted = [...previous].sort((a, b) => a.t - b.t);

  // Seed with each metric's earliest historical value. Bucket boundaries rarely
  // line up exactly, so the first bucket or two of the current window have no
  // history behind them yet — and the chart draws a missing value as zero, not
  // as a gap, which reads as a dramatic spike from the axis. Carrying the first
  // known value backwards over those one or two buckets keeps the reference
  // line honest and removes the artifact.
  const last: Record<string, number> = {};
  for (const m of metrics) {
    const first = sorted.find((p) => {
      const v = p[m];
      return v !== null && v !== undefined && Number.isFinite(Number(v));
    });
    if (first) last[m] = Number(first[m]);
  }

  let j = 0;
  return current.map((p) => {
    const target = p.t - offset;
    while (j < sorted.length && sorted[j].t <= target) {
      for (const m of metrics) {
        const v = sorted[j][m];
        if (v !== null && v !== undefined && Number.isFinite(Number(v))) last[m] = Number(v);
      }
      j++;
    }
    if (Object.keys(last).length === 0) return p;

    const row: SeriesPoint = { ...p };
    for (const m of metrics) {
      if (m in last) row[`${m}${PREV_SUFFIX}`] = last[m];
    }
    return row;
  });
}

/** Formats a Date for <input type="datetime-local"> in the viewer's own zone. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parses the two pickers into epoch ms, or null when the range is unusable. */
function absoluteRange(from: string, to: string): { from: number; to: number } | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return { from: a, to: b };
}

/**
 * Key for the severity colours. Colour encodes the level, so it needs naming —
 * every swatch is rendered with its word, never colour alone.
 */
function SeverityLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="micro text-muted-foreground/50">Level</span>
      {SEVERITY_ORDER.map((sev) => (
        <span key={sev} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", TONE_DOT[toneOfSeverity(sev)])} />
          {SEVERITY_LABEL[sev]}
        </span>
      ))}
    </div>
  );
}

function Chip({
  on, onClick, title, children,
}: {
  on: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] transition",
        on
          ? "border-white/25 bg-white/10 text-foreground"
          : "border-(--hairline) text-muted-foreground hover:bg-white/5",
      )}
    >
      {children}
    </button>
  );
}

/** Accessible fallback for the charts — same numbers, no colour required. */
const PAGE_SIZES = [25, 50, 100, 250];

/**
 * The numbers behind the charts: sortable, paginated, and colour-free — this is
 * also the accessible route to the same data.
 */
function TableView({ points }: { points: SeriesPoint[] }) {
  const [sortKey, setSortKey] = useState<string>("t");
  const [asc, setAsc] = useState(false); // newest first by default
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const rows = [...points];
    rows.sort((a, b) => {
      const av = sortKey === "t" ? a.t : a[sortKey];
      const bv = sortKey === "t" ? b.t : b[sortKey];
      // Missing readings sort last regardless of direction.
      const an = av === null || av === undefined ? null : Number(av);
      const bn = bv === null || bv === undefined ? null : Number(bv);
      if (an === null && bn === null) return 0;
      if (an === null) return 1;
      if (bn === null) return -1;
      return asc ? an - bn : bn - an;
    });
    return rows;
  }, [points, sortKey, asc]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  // Clamp rather than store a page that no longer exists after a filter change.
  const current = Math.min(page, pageCount - 1);
  const start = current * pageSize;
  const rows = sorted.slice(start, start + pageSize);

  function sortBy(key: string) {
    if (key === sortKey) setAsc(!asc);
    else {
      setSortKey(key);
      setAsc(false);
    }
    setPage(0);
  }

  const arrow = (key: string) => (sortKey === key ? (asc ? "↑" : "↓") : "");

  return (
    <div className="panel">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-(--hairline) text-left">
            <tr>
              <th className="sticky left-0 bg-(--surface-panel) px-3 py-2 font-medium">
                <button
                  onClick={() => sortBy("t")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  Time <span className="text-foreground">{arrow("t")}</span>
                </button>
              </th>
              {METRICS.map((m) => (
                <th key={m.key} className="px-3 py-2 text-right font-medium">
                  <button
                    onClick={() => sortBy(m.key)}
                    className="text-muted-foreground hover:text-foreground"
                    title={`Sort by ${m.label}`}
                  >
                    {m.label} <span className="text-foreground">{arrow(m.key)}</span>
                  </button>
                  {m.unit && (
                    <span className="ml-1 font-normal text-muted-foreground/60">{m.unit}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.t} className="border-b border-(--hairline)/50 hover:bg-white/[0.02]">
                <td className="figure sticky left-0 whitespace-nowrap bg-(--surface-panel) px-3 py-1.5 text-muted-foreground">
                  {new Date(p.t).toLocaleString()}
                </td>
                {METRICS.map((m) => (
                  <td key={m.key} className="figure px-3 py-1.5 text-right">
                    {p[m.key] === null || p[m.key] === undefined
                      ? "—"
                      : formatValue(Number(p[m.key]), m)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sorted.length === 0 ? (
        <p className="px-3 py-10 text-center text-xs text-muted-foreground">
          No data in this window
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-(--hairline) px-3 py-2">
          <span className="figure text-[11px] text-muted-foreground">
            {(start + 1).toLocaleString()}–{Math.min(start + pageSize, sorted.length).toLocaleString()}{" "}
            of {sorted.length.toLocaleString()}
          </span>

          <label className="flex items-center gap-1.5">
            <span className="micro text-muted-foreground/60">Rows</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
              className="h-7 rounded-md border border-(--hairline) bg-(--surface-panel) px-1.5 text-[11px] outline-none focus:border-white/25"
              aria-label="Rows per page"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <div className="ml-auto flex items-center gap-1">
            <PageButton onClick={() => setPage(0)} disabled={current === 0} label="First">
              «
            </PageButton>
            <PageButton
              onClick={() => setPage(current - 1)}
              disabled={current === 0}
              label="Previous"
            >
              ‹
            </PageButton>
            <span className="figure px-2 text-[11px] text-muted-foreground">
              {current + 1} / {pageCount}
            </span>
            <PageButton
              onClick={() => setPage(current + 1)}
              disabled={current >= pageCount - 1}
              label="Next"
            >
              ›
            </PageButton>
            <PageButton
              onClick={() => setPage(pageCount - 1)}
              disabled={current >= pageCount - 1}
              label="Last"
            >
              »
            </PageButton>
          </div>
        </div>
      )}
    </div>
  );
}

/** Exact window statistics, computed on raw rows rather than chart buckets. */
function StatStrip({
  stat,
  metricKey,
  basis,
}: {
  stat: MetricStat;
  metricKey: string;
  basis: string;
}) {
  const m = METRIC_BY_KEY[metricKey];
  const pct = stat.seconds_total > 0 ? (100 * stat.seconds_above) / stat.seconds_total : 0;
  const cell = (label: string, value: number) => (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground/50">{label}</span>{" "}
      <span className="figure text-muted-foreground">{formatValue(value, m)}</span>
    </span>
  );
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-(--hairline)/50 py-1.5 text-[10px]">
      {cell("min", stat.min)}
      {cell("avg", stat.avg)}
      {cell("p95", stat.p95)}
      {cell("max", stat.max)}
      {/* Averaging kills the tail, so a p95 taken from bucketed data is lower
          than the truth. Labelled rather than hidden: the figure is still the
          best available and suppressing it would cost more than the caveat. */}
      {basis !== "raw" && (
        <span
          className="whitespace-nowrap rounded bg-muted px-1 text-muted-foreground/70"
          title={`Computed from ${basis} averages rather than raw readings — p95 and time-above are understated.`}
        >
          {basis} avg
        </span>
      )}
      {m.thresholds && (
        <span
          className="ml-auto whitespace-nowrap"
          title="Share of the window spent above this metric's first elevated band, weighted by how long each reading held"
        >
          <span className="text-muted-foreground/50">elevated</span>{" "}
          <span className={cn("figure", pct > 0 ? "text-(--status-warning)" : "text-muted-foreground")}>
            {pct < 0.05 ? "0" : pct.toFixed(1)}%
          </span>
        </span>
      )}
    </div>
  );
}

function PageButton({
  onClick, disabled, label, children,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex size-7 items-center justify-center rounded-md border border-(--hairline) text-muted-foreground transition hover:bg-white/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
