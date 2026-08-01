import { NextResponse } from "next/server";

import { stats } from "@/lib/clickhouse";
import { METRICS } from "@/lib/metrics";

export const dynamic = "force-dynamic";

/**
 * "Elevated" is the first level worth noticing, so time-above uses that band.
 * Metrics without published thresholds are simply absent from the map.
 */
function elevatedThresholds(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of METRICS) {
    const t = m.thresholds;
    if (!t) continue;
    if (t.kind === "rising") {
      const step = t.steps.find((s) => s.level === "moderate") ?? t.steps[0];
      if (step) out[m.key] = step.upTo;
    } else {
      out[m.key] = t.good[1]; // above the comfortable band
    }
  }
  return out;
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const sensor = q.get("sensor");
  if (!sensor) return NextResponse.json({ error: "sensor is required" }, { status: 400 });

  const toMs = Number(q.get("to")) || Date.now();
  const fromMs = Number(q.get("from")) || toMs - (Number(q.get("range")) || 60) * 60_000;

  try {
    const rows = await stats({ sensorId: sensor, fromMs, toMs, thresholds: elevatedThresholds() });
    return NextResponse.json({ from: fromMs, to: toMs, stats: rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
