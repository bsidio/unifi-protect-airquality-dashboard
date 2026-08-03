import type { StoreMode } from "./store-types";

/**
 * All configuration comes from .env — nothing is stored in the database.
 * Read lazily so a missing value surfaces on the onboarding screen rather
 * than crashing the server at import time.
 */

function str(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function bool(name: string, fallback = false): boolean {
  const v = str(name).toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function num(name: string, fallback: number): number {
  const v = Number(str(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const env = {
  /** Site name shown in the header and browser tab. */
  get appName() {
    return str("APP_NAME", "Air Quality");
  },
  get unifi() {
    return {
      host: str("UNIFI_HOST", "192.168.1.1"),
      user: str("UNIFI_USER"),
      pass: str("UNIFI_PASS"),
      verifySsl: bool("UNIFI_VERIFY_SSL", false),
    };
  },
  get clickhouse() {
    return {
      // `||` rather than a `str` fallback: a variable that is *set but empty* —
      // which is what `CLICKHOUSE_URL=${CLICKHOUSE_URL}` in the compose file
      // produces when the secret is absent — is not nullish, so the default
      // would not apply and `createClient({url: ""})` throws synchronously.
      url: str("CLICKHOUSE_URL") || "http://127.0.0.1:8123",
      database: str("CLICKHOUSE_DB") || "unifi_aq",
      username: str("CLICKHOUSE_USER") || "default",
      password: str("CLICKHOUSE_PASSWORD"),
    };
  },
  /**
   * Where readings are kept.
   *
   * Three modes, chosen with STORE:
   *
   *   clickhouse — a database you host. Nothing is forwarded.
   *   openaqi    — no local database; openaqi keeps your history for you.
   *   both       — written locally and forwarded. Read locally.
   *
   * Unset resolves to what the install is already doing, so upgrading changes
   * nothing: a key present means it was forwarding, which is `both`; no key
   * means `clickhouse`. Anything else would silently switch off contribution
   * for every existing contributor on the next deploy.
   */
  get store() {
    const raw = str("STORE").toLowerCase();
    const hasKey = Boolean(str("OPENAQI_KEY"));
    const mode: StoreMode =
      raw === "clickhouse" || raw === "openaqi" || raw === "both"
        ? raw
        : hasKey
          ? "both"
          : "clickhouse";
    return {
      raw,
      mode,
      /** Answers come from the local database. */
      readsLocally: mode === "clickhouse" || mode === "both",
      /** Readings are written to the local database. */
      writesLocally: mode === "clickhouse" || mode === "both",
      /** Readings are sent to openaqi. */
      forwardsRemotely: mode === "openaqi" || mode === "both",
    };
  },
  get auth() {
    return {
      enabled: bool("AUTH_ENABLED", false),
      user: str("AUTH_USER", "admin"),
      password: str("AUTH_PASSWORD"),
      secret: str("APP_SECRET"),
    };
  },
  get collector() {
    return {
      enabled: bool("COLLECTOR_ENABLED", true),
      flushMs: num("COLLECTOR_FLUSH_MS", 5000),
      dedupe: bool("COLLECTOR_DEDUPE", true),
    };
  },
  /**
   * Optional contribution of this sensor's readings to openaqi.net, the public
   * crowdsourced air quality map.
   *
   * One switch: set OPENAQI_KEY and readings are forwarded. There is no
   * separate enable flag, because a key and a flag is two things to get right
   * and the second one only exists to be forgotten.
   *
   * Off unless a key is present, deliberately — sending somebody's readings to
   * a third party is not a sensible default, however public the destination.
   */
  get openaqi() {
    const key = str("OPENAQI_KEY");
    return {
      key,
      // A key is necessary but no longer sufficient: STORE=clickhouse is how
      // somebody switches forwarding off without deleting a key they may want
      // back. One line here makes forward(), startForwarder() and
      // forwarderStatus() mode-aware without touching lib/openaqi.ts.
      enabled: Boolean(key) && env.store.forwardsRemotely,
      /** Where readings are SENT. */
      server: (str("OPENAQI_SERVER") || "https://ingest.openaqi.net").replace(/\/+$/, ""),
      /**
       * Where readings are READ BACK — a different service from the one above.
       * Ingest is its own deployment; the read API lives on the site. Reusing
       * one variable for both would 404 on every read.
       */
      api: (str("OPENAQI_API") || "https://openaqi.net").replace(/\/+$/, ""),
      /** Optional. Normally discovered from the key, which resolves to exactly
       *  one station for an ingest key. */
      stationId: str("OPENAQI_STATION"),
      /** Log the exact payload and send nothing, for anyone who would rather
       *  see what leaves the machine than take our word for it. */
      dryRun: bool("OPENAQI_DRY_RUN", false),
    };
  },
};

/** Config problems worth showing the operator before anything else. */
export function configIssues(): string[] {
  const issues: string[] = [];
  const { unifi, auth, store, openaqi } = env;
  if (!unifi.host) issues.push("UNIFI_HOST is not set");
  if (!unifi.user || !unifi.pass) issues.push("UNIFI_USER / UNIFI_PASS are not set");

  if (store.raw && store.raw !== store.mode) {
    issues.push(`STORE="${store.raw}" is not valid — use clickhouse, openaqi or both`);
  }

  // Only demanded when there is actually a local database in play. This is the
  // check that used to make a ClickHouse-less install impossible: it sent the
  // dashboard to onboarding, which meant the collector was never started.
  if (store.writesLocally || store.readsLocally) {
    if (!process.env.CLICKHOUSE_PASSWORD) issues.push("CLICKHOUSE_PASSWORD is not set");
  }
  if (store.forwardsRemotely && !openaqi.key) {
    issues.push(`STORE=${store.mode} but OPENAQI_KEY is not set`);
  }

  if (auth.enabled && !auth.password) issues.push("AUTH_ENABLED=true but AUTH_PASSWORD is empty");
  if (auth.enabled && !auth.secret) issues.push("AUTH_ENABLED=true but APP_SECRET is empty");
  return issues;
}
