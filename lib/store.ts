import "server-only";

import * as local from "./clickhouse";
import { env } from "./env";
import type {
  ChHealth,
  DecayEvent,
  DeviceRow,
  HeatCell,
  LatestRow,
  MetricStats,
  Row,
  SeriesPoint,
} from "./clickhouse";
import type { Provenance, StoreHealth, StoreMode } from "./store-types";

/**
 * The one place that knows where readings live.
 *
 * Every route handler asks this module, not a database. That is what allows the
 * dashboard to run with no database at all: in `openaqi` mode the same
 * questions are answered from the readings this sensor already contributed,
 * fetched back over HTTP and reduced in process by `lib/analytics.ts`.
 *
 * Results come back wrapped with a `Provenance` rather than bare. The wrapper
 * exists because the interesting differences are per-request, not per-mode — a
 * window the remote had to coarsen, a metric it has no history for, an answer
 * served from cache. Without it the UI could only infer from the mode, and
 * inferring is how a dashboard ends up quietly presenting something untrue.
 */

export type { ChHealth, DecayEvent, DeviceRow, HeatCell, LatestRow, MetricStats, Row, SeriesPoint };
export type { Provenance, StoreHealth, StoreMode };

export function storeMode(): StoreMode {
  return env.store.mode;
}
export function readsLocally(): boolean {
  return env.store.readsLocally;
}
export function writesLocally(): boolean {
  return env.store.writesLocally;
}
export function forwardsRemotely(): boolean {
  return env.store.forwardsRemotely;
}

/** Provenance for an answer that came from the local database: always raw. */
const LOCAL: Provenance = { backend: "clickhouse", basis: "raw" };

/* ── writes ────────────────────────────────────────────────────────────────── */

/**
 * Both are no-ops without a local database — there is no table to create and
 * nothing to insert into. The collector also skips *building* the rows in that
 * case, so this is a backstop rather than the primary guard: a silently
 * discarded batch would leave `written` climbing while nothing was stored.
 */
export async function insertReadings(rows: Row[]): Promise<void> {
  if (!writesLocally()) return;
  await local.insertReadings(rows);
}

export async function ensureSchema(): Promise<void> {
  if (!writesLocally()) return;
  await local.ensureSchema();
}

/* ── reads ─────────────────────────────────────────────────────────────────── */

export async function listDevices(): Promise<{ devices: DeviceRow[]; provenance: Provenance }> {
  if (readsLocally()) return { devices: await local.listDevices(), provenance: LOCAL };
  return remote().listDevices();
}

export async function latestReadings(
  sensorId: string,
): Promise<{ rows: LatestRow[]; provenance: Provenance }> {
  if (readsLocally()) return { rows: await local.latestReadings(sensorId), provenance: LOCAL };
  return remote().latestReadings(sensorId);
}

export async function series(opts: {
  sensorId: string;
  metrics: string[];
  fromMs: number;
  toMs: number;
  points?: number;
}): Promise<{ points: SeriesPoint[]; provenance: Provenance }> {
  if (readsLocally()) return { points: await local.series(opts), provenance: LOCAL };
  return remote().series(opts);
}

export async function stats(opts: {
  sensorId: string;
  fromMs: number;
  toMs: number;
  thresholds: Record<string, number>;
}): Promise<{ stats: MetricStats[]; provenance: Provenance }> {
  if (readsLocally()) return { stats: await local.stats(opts), provenance: LOCAL };
  return remote().stats(opts);
}

export async function heatmap(opts: {
  sensorId: string;
  metric: string;
  fromMs: number;
  toMs: number;
}): Promise<{ cells: HeatCell[]; provenance: Provenance }> {
  if (readsLocally()) return { cells: await local.heatmap(opts), provenance: LOCAL };
  return remote().heatmap(opts);
}

export async function ventilation(opts: {
  sensorId: string;
  fromMs: number;
  toMs: number;
  outdoorPpm?: number;
}): Promise<{ events: DecayEvent[]; provenance: Provenance }> {
  if (readsLocally()) return { events: await local.ventilation(opts), provenance: LOCAL };
  return remote().ventilation(opts);
}

export async function exportCsv(opts: {
  sensorId: string;
  metrics: string[];
  fromMs: number;
  toMs: number;
}): Promise<{ csv: string; provenance: Provenance }> {
  if (readsLocally()) return { csv: await local.exportCsv(opts), provenance: LOCAL };
  return remote().exportCsv(opts);
}

/**
 * Whether the store is usable, in the terms of whichever store it is.
 *
 * In `both` mode this also reports what openaqi has actually received, not just
 * that forwarding is switched on. Enabled-but-never-arriving is precisely the
 * failure that sat unnoticed in production, and a health endpoint that could
 * not tell the two apart is what let it.
 */
export async function health(): Promise<StoreHealth> {
  const mode = storeMode();
  if (!readsLocally()) return remote().health(mode);

  const ch = await local.health();
  const base: StoreHealth = {
    mode,
    backend: "clickhouse",
    ok: ch.ok,
    error: ch.error,
    version: ch.version,
    rows: ch.rows,
    tableExists: ch.tableExists,
  };
  if (mode !== "both") return base;

  // Best effort: a failure to describe the remote must never make the local
  // store look unhealthy.
  try {
    base.remote = await remote().coverage();
  } catch {
    /* left undefined — the UI treats absence as "not known yet". */
  }
  return base;
}

/**
 * Loaded on demand so that a `clickhouse`-only install never even evaluates the
 * remote client, and so a mistake in it cannot break the local path at import
 * time. `require` rather than a dynamic `import()` because every caller here is
 * already async-free at the point of dispatch.
 */
function remote(): typeof import("./store-openaqi") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./store-openaqi") as typeof import("./store-openaqi");
}
