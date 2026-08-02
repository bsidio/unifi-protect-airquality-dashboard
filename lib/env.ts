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
      url: str("CLICKHOUSE_URL", "http://127.0.0.1:8123"),
      database: str("CLICKHOUSE_DB", "unifi_aq"),
      username: str("CLICKHOUSE_USER", "default"),
      password: str("CLICKHOUSE_PASSWORD"),
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
      enabled: Boolean(key),
      server: str("OPENAQI_SERVER", "https://ingest.openaqi.net").replace(/\/+$/, ""),
      /** Log the exact payload and send nothing, for anyone who would rather
       *  see what leaves the machine than take our word for it. */
      dryRun: bool("OPENAQI_DRY_RUN", false),
    };
  },
};

/** Config problems worth showing the operator before anything else. */
export function configIssues(): string[] {
  const issues: string[] = [];
  const { unifi, clickhouse, auth } = env;
  if (!unifi.host) issues.push("UNIFI_HOST is not set");
  if (!unifi.user || !unifi.pass) issues.push("UNIFI_USER / UNIFI_PASS are not set");
  if (!clickhouse.url) issues.push("CLICKHOUSE_URL is not set");
  if (!clickhouse.password) issues.push("CLICKHOUSE_PASSWORD is not set");
  if (auth.enabled && !auth.password) issues.push("AUTH_ENABLED=true but AUTH_PASSWORD is empty");
  if (auth.enabled && !auth.secret) issues.push("AUTH_ENABLED=true but APP_SECRET is empty");
  return issues;
}
