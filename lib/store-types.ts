/**
 * How the dashboard decides where readings live, and what it tells you about
 * where a given answer came from.
 *
 * Deliberately free of `server-only` and of any database import, because client
 * components render these: the footer names the backend, the stat strip says
 * when numbers came from averages rather than raw readings, and a panel says
 * when a metric has no history to show. The row types themselves stay in
 * `lib/clickhouse.ts`, which is their single definition.
 */

/**
 * Where readings are kept.
 *
 *   clickhouse — a database you host. Nothing is forwarded.
 *   openaqi    — no local database at all; openaqi keeps the history for you.
 *   both       — written locally and forwarded; read locally.
 */
export type StoreMode = "clickhouse" | "openaqi" | "both";

export type Interval = "raw" | "1m" | "5m" | "15m" | "1h" | "3h" | "6h" | "1d";

/**
 * Where a set of numbers came from and what it cost to get them.
 *
 * Carried alongside every result rather than inferred from the mode, because
 * the interesting cases are per-request: a window the remote had to coarsen, a
 * metric it has no history for, an answer served from cache. Without this the UI
 * can only guess, and guessing is how a dashboard ends up quietly showing
 * something that is not true.
 */
export type Provenance = {
  backend: "clickhouse" | "openaqi";
  /** What the numbers were computed FROM. The local store is always `raw`. */
  basis: Interval;
  /** The window was capped; there is more data than is shown. */
  truncated?: boolean;
  /** Served from cache because the remote was rate-limiting. */
  stale?: boolean;
  /** Requested metrics this backend has no history for — `vape`, remotely. */
  unavailable?: string[];
  /** CSV only: the sensor's own status word could not be recovered. */
  statusUnavailable?: boolean;
};

export type StoreHealth = {
  mode: StoreMode;
  backend: "clickhouse" | "openaqi";
  ok: boolean;
  error?: string;
  /** ClickHouse only. */
  version?: string;
  tableExists?: boolean;
  /** Row count locally; `coverage.readings` remotely. */
  rows?: number;
  /** openaqi only. */
  station?: { id: string; name: string; firstReading?: string | null };
  /**
   * In `both` mode: proof that forwarding is actually landing, not merely
   * switched on. Enabled-but-never-arriving is exactly the failure that went
   * unnoticed in production for a day.
   */
  remote?: { station: string; readings: number; lastReading: string | null };
};
