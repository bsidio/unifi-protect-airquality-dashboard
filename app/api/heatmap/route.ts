import { NextResponse } from "next/server";

import { heatmap } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const sensor = q.get("sensor");
  if (!sensor) return NextResponse.json({ error: "sensor is required" }, { status: 400 });

  const metric = q.get("metric") ?? "co2";
  const days = Math.min(Math.max(Number(q.get("days")) || 14, 1), 365);
  const toMs = Date.now();
  const fromMs = toMs - days * 86_400_000;

  try {
    const cells = await heatmap({ sensorId: sensor, metric, fromMs, toMs });
    return NextResponse.json({ metric, days, cells });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
