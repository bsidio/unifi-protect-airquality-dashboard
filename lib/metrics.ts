/** The metric catalogue, keyed by UniFi's own airQuality field names. */

export type MetricKey =
  | "aqi" | "vape" | "co2" | "voc" | "tvoc"
  | "pm1p0" | "pm2p5" | "pm4p0" | "pm10p0"
  | "temperature" | "humidity";

export type MetricGroup = "index" | "gas" | "particulate" | "ambient";

/** Severity of a reading, worst-last. */
export type Severity = "good" | "moderate" | "warning" | "serious" | "critical";

export const SEVERITY_LABEL: Record<Severity, string> = {
  good: "Good",
  moderate: "Fair",
  warning: "Elevated",
  serious: "Poor",
  critical: "Severe",
};

export const SEVERITY_ORDER: Severity[] = ["good", "moderate", "warning", "serious", "critical"];

/**
 * Thresholds for turning a raw number into a severity.
 *
 * "rising" — more is worse; the first step whose `upTo` the value does not
 * exceed wins, and anything past the last step is critical.
 * "comfort" — a two-sided band where both too-low and too-high are worse
 * (temperature, humidity).
 */
export type Thresholds =
  | { kind: "rising"; steps: { upTo: number; level: Severity }[] }
  | { kind: "comfort"; good: [number, number]; fair: [number, number] };

export type MetricDef = {
  key: MetricKey;
  label: string;
  unit: string;
  group: MetricGroup;
  /** Sensible fixed axis floor; null lets the chart auto-scale. */
  min: number | null;
  decimals: number;
  description: string;
  /** Omitted when no defensible public threshold exists. */
  thresholds?: Thresholds;
  /** Where the numbers come from, shown in the UI. */
  source?: string;
};

export const METRICS: MetricDef[] = [
  {
    key: "aqi", label: "AQI", unit: "", group: "index", min: 0, decimals: 0,
    description: "Overall air quality index reported by the sensor.",
    source: "UniFi spec: AQI 0–500 on the US EPA scale",
    thresholds: { kind: "rising", steps: [
      { upTo: 50, level: "good" },        // Good
      { upTo: 100, level: "moderate" },   // Moderate
      { upTo: 150, level: "warning" },    // Unhealthy for sensitive groups
      { upTo: 200, level: "serious" },    // Unhealthy
    ] },
  },
  {
    key: "vape", label: "Vape", unit: "", group: "index", min: 0, decimals: 0,
    description: "Vape detection index, 0–100. 0 means nothing detected.",
    // The device ships vapeSettings { lowThreshold: 0, highThreshold: 50 },
    // so 50 is Ubiquiti's own alert point rather than a guess.
    source: "UniFi spec: Vape Index 0–100; device alert threshold 50",
    thresholds: { kind: "rising", steps: [
      { upTo: 0, level: "good" },
      { upTo: 25, level: "moderate" },
      { upTo: 49, level: "warning" },
      { upTo: 75, level: "serious" },
    ] },
  },
  {
    key: "co2", label: "CO₂", unit: "ppm", group: "gas", min: 0, decimals: 0,
    description: "Carbon dioxide. Above ~1000 ppm indicates poor ventilation.",
    source: "ASHRAE / common IAQ guidance (sensor range 0–40,000 ppm)",
    thresholds: { kind: "rising", steps: [
      { upTo: 800, level: "good" },       // well ventilated
      { upTo: 1000, level: "moderate" },  // acceptable
      { upTo: 1400, level: "warning" },   // stuffy, drowsiness reported
      { upTo: 2000, level: "serious" },   // clearly under-ventilated
    ] },
  },
  {
    key: "voc", label: "VOC", unit: "idx", group: "gas", min: 0, decimals: 0,
    description: "VOC Index, 1–500. 100 is the running typical baseline for the room.",
    source: "UniFi spec: VOC Index 1–500 (Sensirion scale)",
    thresholds: { kind: "rising", steps: [
      { upTo: 150, level: "good" },
      { upTo: 250, level: "moderate" },
      { upTo: 400, level: "warning" },
      { upTo: 450, level: "serious" },
    ] },
  },
  {
    // UniFi reports TVOC as an index (idx), not ppb, and publishes no band
    // definitions for it. Rather than invent thresholds against the wrong unit,
    // this metric falls back to the status word the sensor itself reports.
    key: "tvoc", label: "TVOC", unit: "idx", group: "gas", min: 0, decimals: 2,
    description: "Total VOC index as reported by the sensor. No published bands — uses UniFi's own status.",
    source: "UniFi reports TVOC as an index; no public thresholds",
  },
  {
    key: "pm1p0", label: "PM1.0", unit: "µg/m³", group: "particulate", min: 0, decimals: 2,
    description: "Particulates under 1.0 µm.",
    // No published PM1 standard exists; PM2.5 bands are the closest defensible proxy.
    source: "No PM1 standard — PM2.5 bands used as a proxy",
    thresholds: { kind: "rising", steps: [
      { upTo: 12, level: "good" },
      { upTo: 35.4, level: "moderate" },
      { upTo: 55.4, level: "warning" },
      { upTo: 150.4, level: "serious" },
    ] },
  },
  {
    key: "pm2p5", label: "PM2.5", unit: "µg/m³", group: "particulate", min: 0, decimals: 2,
    description: "Particulates under 2.5 µm — the standard health benchmark.",
    source: "US EPA 24-hour PM2.5 breakpoints",
    thresholds: { kind: "rising", steps: [
      { upTo: 12, level: "good" },
      { upTo: 35.4, level: "moderate" },
      { upTo: 55.4, level: "warning" },
      { upTo: 150.4, level: "serious" },
    ] },
  },
  {
    key: "pm4p0", label: "PM4.0", unit: "µg/m³", group: "particulate", min: 0, decimals: 2,
    description: "Particulates under 4.0 µm.",
    source: "No PM4 standard — PM10 bands used as a proxy",
    thresholds: { kind: "rising", steps: [
      { upTo: 54, level: "good" },
      { upTo: 154, level: "moderate" },
      { upTo: 254, level: "warning" },
      { upTo: 354, level: "serious" },
    ] },
  },
  {
    key: "pm10p0", label: "PM10", unit: "µg/m³", group: "particulate", min: 0, decimals: 2,
    description: "Particulates under 10 µm.",
    source: "US EPA 24-hour PM10 breakpoints",
    thresholds: { kind: "rising", steps: [
      { upTo: 54, level: "good" },
      { upTo: 154, level: "moderate" },
      { upTo: 254, level: "warning" },
      { upTo: 354, level: "serious" },
    ] },
  },
  {
    // Temperature is a comfort preference, not an air-quality verdict: 25 °C is
    // pleasant to one person and warm to another, and nothing about it makes the
    // air less safe to breathe. Grading it would put a "Fair" badge on a
    // perfectly normal room, so it defers to the sensor's own status word.
    key: "temperature", label: "Temperature", unit: "°C", group: "ambient", min: null, decimals: 2,
    description: "Ambient temperature. Not graded — comfort is a preference, not an air-quality level.",
    source: "Not graded — reports UniFi's own status",
  },
  {
    key: "humidity", label: "Humidity", unit: "%", group: "ambient", min: 0, decimals: 2,
    description: "Relative humidity. Mould risk climbs above 60%.",
    source: "EPA / ASHRAE indoor humidity guidance",
    thresholds: { kind: "comfort", good: [40, 60], fair: [30, 70] },
  },
];

/**
 * Grades a reading against its metric's thresholds.
 *
 * Returns null when the metric has no published bands, so callers can fall back
 * to UniFi's own status word rather than inventing a verdict.
 */
export function severityOf(m: MetricDef, value: number | null | undefined): Severity | null {
  if (value === null || value === undefined || !Number.isFinite(value) || !m.thresholds) return null;
  const t = m.thresholds;

  if (t.kind === "rising") {
    for (const step of t.steps) if (value <= step.upTo) return step.level;
    return "critical";
  }

  const [goodLo, goodHi] = t.good;
  const [fairLo, fairHi] = t.fair;
  if (value >= goodLo && value <= goodHi) return "good";
  if (value >= fairLo && value <= fairHi) return "moderate";
  // Distance past the fair band decides how bad it is.
  const overshoot = value < fairLo ? fairLo - value : value - fairHi;
  return overshoot > 10 ? "serious" : "warning";
}

export const METRIC_BY_KEY: Record<string, MetricDef> = Object.fromEntries(
  METRICS.map((m) => [m.key, m]),
);

export const METRIC_KEYS = METRICS.map((m) => m.key);

export const GROUP_LABEL: Record<MetricGroup, string> = {
  index: "Indices",
  gas: "Gases",
  particulate: "Particulates",
  ambient: "Ambient",
};

/**
 * Default small-multiple selection. Particulates are deliberately absent —
 * they get their own stacked size-band chart.
 */
export const DEFAULT_METRICS: MetricKey[] = ["aqi", "co2", "voc", "tvoc", "temperature", "humidity"];

/**
 * UniFi reports its own status word per reading ("neutral", "safe", "warning"…).
 * We render that verbatim rather than inventing thresholds, mapping it onto a
 * fixed four-step status palette. Colour never carries meaning alone — every
 * use is paired with the status word as a visible label.
 */
export type StatusTone = "good" | "neutral" | "warning" | "serious" | "critical";

export function statusTone(status: string | undefined): StatusTone {
  switch ((status ?? "").toLowerCase()) {
    case "safe":
    case "good":
      return "good";
    case "warning":
    case "moderate":
      return "warning";
    case "serious":
    case "unhealthy":
      return "serious";
    case "critical":
    case "hazardous":
      return "critical";
    default:
      return "neutral";
  }
}

export function formatValue(value: number | null | undefined, m: MetricDef): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(m.decimals).replace(/\.0+$/, "");
}

/** Severity maps onto the fixed status palette used everywhere in the UI. */
export function toneOfSeverity(sev: Severity): StatusTone {
  return sev === "moderate" ? "neutral" : sev;
}

/**
 * The single grading entry point for the UI.
 *
 * Prefers our threshold bands (they react to the actual value); falls back to
 * whatever status word the sensor reported when a metric has no published
 * bands. `sourced` says which of the two produced the verdict, so the UI can
 * be honest about where the judgement came from.
 */
export function gradeReading(
  m: MetricDef,
  value: number | null | undefined,
  unifiStatus?: string,
): { tone: StatusTone; label: string; sourced: "thresholds" | "unifi" } {
  const sev = severityOf(m, value);
  if (sev) return { tone: toneOfSeverity(sev), label: SEVERITY_LABEL[sev], sourced: "thresholds" };
  return {
    tone: statusTone(unifiStatus),
    label: unifiStatus ? unifiStatus[0].toUpperCase() + unifiStatus.slice(1) : "—",
    sourced: "unifi",
  };
}
