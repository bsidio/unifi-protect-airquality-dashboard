import { NextResponse } from "next/server";

import { listDevices } from "@/lib/clickhouse";
import { latestReadings } from "@/lib/collector";

export const dynamic = "force-dynamic";

/** Devices known to ClickHouse, merged with anything the live collector sees. */
export async function GET() {
  let stored: Awaited<ReturnType<typeof listDevices>> = [];
  try {
    stored = await listDevices();
  } catch {
    stored = [];
  }

  const merged = new Map(stored.map((d) => [d.sensor_id, { ...d, live: false }]));
  for (const r of latestReadings()) {
    const existing = merged.get(r.sensorId);
    if (existing) existing.live = true;
    else
      merged.set(r.sensorId, {
        sensor_id: r.sensorId,
        sensor_name: r.sensorName,
        last_seen: new Date(r.ts).toISOString(),
        first_seen: new Date(r.ts).toISOString(),
        points: 0,
        live: true,
      });
  }

  return NextResponse.json({ devices: [...merged.values()] });
}
