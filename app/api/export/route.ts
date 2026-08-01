import { exportCsv } from "@/lib/clickhouse";
import { METRIC_KEYS } from "@/lib/metrics";

export const dynamic = "force-dynamic";

/** Raw readings for the current window, as a CSV download. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const sensor = q.get("sensor");
  if (!sensor) return new Response("sensor is required", { status: 400 });

  const toMs = Number(q.get("to")) || Date.now();
  const fromMs = Number(q.get("from")) || toMs - (Number(q.get("range")) || 60) * 60_000;
  const metrics = (q.get("metrics") ?? METRIC_KEYS.join(",")).split(",").filter(Boolean);

  try {
    const csv = await exportCsv({ sensorId: sensor, metrics, fromMs, toMs });
    const stamp = new Date(toMs).toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="air-quality-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}
