import { NextResponse } from "next/server";

import { latestReadings as storedLatest } from "@/lib/store";
import { latestReadings as liveLatest } from "@/lib/collector";
import { parseStoreTs } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sensor = new URL(req.url).searchParams.get("sensor");
  if (!sensor) return NextResponse.json({ error: "sensor is required" }, { status: 400 });

  // Prefer the in-process reading; it is fresher than anything flushed to disk.
  const live = liveLatest().find((r) => r.sensorId === sensor);
  if (live) {
    return NextResponse.json({
      source: "live",
      ts: live.ts,
      name: live.sensorName,
      metrics: live.metrics,
    });
  }

  try {
    const { rows, provenance } = await storedLatest(sensor);
    const metrics = Object.fromEntries(
      rows.map((r) => [r.metric, { value: Number(r.value), status: r.status }]),
    );
    const ts = rows.reduce((acc, r) => Math.max(acc, parseStoreTs(r.ts)), 0);
    return NextResponse.json({ source: provenance.backend, ts, name: null, metrics, provenance });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
