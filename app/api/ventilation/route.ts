import { NextResponse } from "next/server";

import { ventilation } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const sensor = q.get("sensor");
  if (!sensor) return NextResponse.json({ error: "sensor is required" }, { status: 400 });

  const days = Math.min(Math.max(Number(q.get("days")) || 7, 1), 90);
  const toMs = Date.now();
  const fromMs = toMs - days * 86_400_000;
  const outdoorPpm = Number(q.get("outdoor")) || 420;

  try {
    const { events, provenance } = await ventilation({ sensorId: sensor, fromMs, toMs, outdoorPpm });
    const achs = events.map((e) => e.ach).sort((a, b) => a - b);
    const median = achs.length ? achs[Math.floor(achs.length / 2)] : null;
    return NextResponse.json({ days, outdoorPpm, medianAch: median, events, provenance });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
