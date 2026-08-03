import { NextResponse } from "next/server";

import { collectorStatus, latestReadings, startCollector } from "@/lib/collector";
import { health as storeHealth } from "@/lib/store";
import { configIssues, env } from "@/lib/env";
import { forwarderStatus } from "@/lib/openaqi";
import { ProtectClient } from "@/lib/protect";

export const dynamic = "force-dynamic";

type ProtectHealth = {
  ok: boolean;
  error?: string;
  sensors?: { id: string; name: string; firmware: string }[];
};

/** Cached so the onboarding poll cannot hammer the console. */
let cached: { at: number; value: ProtectHealth } | null = null;
const CACHE_MS = 60_000;

/**
 * Reports whether Protect is reachable.
 *
 * A fresh login per request gets rate-limited (Protect answers HTTP 429), and
 * onboarding polls this every few seconds — which made the page report the
 * console as unreachable while the collector was happily streaming from it.
 * So: trust the collector's live socket when it has one, and otherwise fall
 * back to a real login that is cached for a minute.
 */
async function checkProtect(): Promise<ProtectHealth> {
  const status = collectorStatus();
  if (status.connected) {
    const live = latestReadings();
    const sensors = live.map((r) => ({ id: r.sensorId, name: r.sensorName, firmware: "" }));
    // Keep the richer cached sensor list (it carries firmware) when we have one.
    if (cached?.value.ok && cached.value.sensors?.length) return cached.value;
    if (sensors.length) return { ok: true, sensors };
    return { ok: true };
  }

  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  let value: ProtectHealth;
  try {
    const { host, user, pass, verifySsl } = env.unifi;
    if (!host || !user || !pass) throw new Error("UniFi credentials are not configured");
    const client = new ProtectClient({ host, username: user, password: pass, verifySsl });
    const sensors = await client.sensors();
    value = {
      ok: true,
      sensors: sensors.map((s: any) => ({
        id: s.id,
        name: s.name ?? "sensor",
        firmware: s.firmwareVersion ?? "",
      })),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    value = {
      ok: false,
      error: message.includes("429")
        ? "Console is rate-limiting logins — retrying shortly"
        : message,
    };
  }
  cached = { at: Date.now(), value };
  return value;
}

/** Powers the onboarding screen: one call, every dependency checked. */
export async function GET() {
  const issues = configIssues();
  const store = await storeHealth();

  const protect = await checkProtect();

  // A page load is a fine moment to make sure the collector is alive.
  //
  // Gated on Protect alone. It used to also require the local database, which
  // made a store-less install impossible to start — and was already
  // inconsistent with the two other places that start the collector, neither
  // of which checks a store at all. startCollector() is idempotent, and a
  // failing write is buffered and retried rather than lost.
  if (protect.ok) void startCollector();

  // This route is reachable WITHOUT auth when AUTH_ENABLED=false, so it must
  // never return internal topology: no console address, no database URL, no
  // account names. Booleans and counts only — enough to diagnose a broken
  // install, useless to someone probing the network.
  return NextResponse.json({
    issues,
    store,
    // Kept under its old name so an existing scrape or bookmark does not
    // break; `store` is the one to read.
    clickhouse: {
      ok: store.backend === "clickhouse" ? store.ok : false,
      error: store.backend === "clickhouse" ? store.error : "not in use (STORE=openaqi)",
      version: store.version,
      rows: store.rows,
      tableExists: store.tableExists,
    },
    protect,
    collector: collectorStatus(),
    // Counters and the last error only — never the key, and never a reading.
    openaqi: forwarderStatus(),
    auth: { enabled: env.auth.enabled },
  });
}
