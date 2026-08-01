import { NextResponse } from "next/server";

import { series } from "@/lib/clickhouse";
import { DEFAULT_METRICS } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const sensor = q.get("sensor");
  if (!sensor) return NextResponse.json({ error: "sensor is required" }, { status: 400 });

  const metrics = (q.get("metrics") ?? DEFAULT_METRICS.join(",")).split(",").filter(Boolean);
  const toMs = Number(q.get("to")) || Date.now();
  const rangeMin = Number(q.get("range")) || 60;
  const fromMs = Number(q.get("from")) || toMs - rangeMin * 60_000;
  const points = Number(q.get("points")) || 400;

  try {
    const rows = await series({ sensorId: sensor, metrics, fromMs, toMs, points });
    return NextResponse.json({
      from: fromMs,
      to: toMs,
      metrics,
      points: rows.map((r) => ({
        ...r,
        t: Date.parse(String(r.t).replace(" ", "T") + "Z"),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
