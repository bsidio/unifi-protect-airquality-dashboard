import { NextResponse } from "next/server";

import { listDevices, type DeviceRow, type Provenance } from "@/lib/store";
import { latestReadings } from "@/lib/collector";

export const dynamic = "force-dynamic";

/** Devices known to ClickHouse, merged with anything the live collector sees. */
export async function GET() {
  // Already degraded gracefully before the store existed, and still does: a
  // sensor that is streaming right now is worth showing even when the store
  // behind it is unreachable.
  let stored: DeviceRow[] = [];
  let provenance: Provenance | null = null;
  try {
    const res = await listDevices();
    stored = res.devices;
    provenance = res.provenance;
  } catch {
    stored = [];
  }

  const merged = new Map(stored.map((d) => [d.sensor_id, { ...d, live: false }]));
  for (const r of latestReadings()) {
    const existing = merged.get(r.sensorId);
    // The live name wins. Locally it is the same value; remotely it replaces
    // openaqi’s station name with the one the sensor actually reports.
    if (existing) {
      existing.live = true;
      existing.sensor_name = r.sensorName;
    }
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

  return NextResponse.json({ devices: [...merged.values()], provenance });
}
