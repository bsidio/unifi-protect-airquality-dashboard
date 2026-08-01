"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, CalendarRange, GripVertical, Loader2, LogOut, RefreshCw, RotateCcw,
  Table2, Wind,
} from "lucide-react";

import {
  MetricChart,
  PM_METRICS,
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
  type MetricGroup,
  type MetricKey,
} from "@/lib/metrics";
import { usePersistentState } from "@/lib/use-persistent-state";
import { cn } from "@/lib/utils";

type Device = {
  sensor_id: string;
  sensor_name: string;
  last_seen: string;
  points: number;
  live?: boolean;
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

/** Headline figures, in reading order. */
const HERO: MetricKey[] = ["aqi", "co2", "pm2p5", "voc"];

/** The particulate stack is a widget like any other, with a reserved id. */
const STACK_ID = "__stack";
const DEFAULT_ORDER: string[] = [STACK_ID, ...DEFAULT_METRICS];

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

export function Dashboard({ appName, authEnabled }: { appName: string; authEnabled: boolean }) {
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
  const [showTable, setShowTable] = usePersistentState<boolean>("table", false);
  const [order, setOrder, orderMeta] = usePersistentState<string[]>("order", DEFAULT_ORDER);

  const [points, setPoints] = useState<SeriesPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [seriesError, setSeriesError] = useState<string | null>(null);
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
      setPoints(json.points ?? []);
      setSeriesError(null);
    } catch (e) {
      setSeriesError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sensor, selected, rangeMin, mode, customFrom, customTo]);

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
    const visible = new Set<string>([...selected, ...(showStack ? [STACK_ID] : [])]);
    const ordered = order.filter((id) => visible.has(id));
    const missing = [...visible].filter((id) => !order.includes(id));
    return [...ordered, ...missing];
  }, [order, selected, showStack]);

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

  const device = devices.find((d) => d.sensor_id === sensor);
  const at = reading?.ts ? new Date(reading.ts) : null;
  const pmTotal = particulateTotal(points);
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
                  list.map((m) => (
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
                      title={m.description}
                    >
                      {m.label}
                    </Chip>
                  ))
                )}
              </div>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
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
                const m = isStack ? null : METRIC_BY_KEY[id];
                if (!isStack && !m) return null;
                const s = m ? reading?.metrics?.[m.key] : undefined;

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
                      "panel group p-4 transition",
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

                    {isStack ? (
                      <StackedParticulateChart points={points} />
                    ) : (
                      <MetricChart metric={m!} points={points} tone={gradeReading(m!, s?.value, s?.status).tone} />
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
            ? `${Number(device.points).toLocaleString()} rows stored in ClickHouse`
            : "Streaming from UniFi Protect"}
        </footer>
      </main>
    </div>
  );
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
function TableView({ points }: { points: SeriesPoint[] }) {
  const rows = [...points].reverse().slice(0, 500);
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="border-b border-(--hairline) text-left">
          <tr>
            <th className="px-3 py-2 font-medium text-muted-foreground">Time</th>
            {METRICS.map((m) => (
              <th key={m.key} className="px-3 py-2 text-right font-medium text-muted-foreground">
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.t} className="border-b border-(--hairline)/50">
              <td className="figure whitespace-nowrap px-3 py-1.5 text-muted-foreground">
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
      {rows.length === 0 && (
        <p className="px-3 py-10 text-center text-xs text-muted-foreground">
          No data in this window
        </p>
      )}
    </div>
  );
}
