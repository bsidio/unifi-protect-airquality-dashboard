import "server-only";

import { env } from "./env";
import type { Reading } from "./protect";

/**
 * Optional: contribute this sensor's readings to openaqi.net.
 *
 * openaqi is a public, crowdsourced air quality map. Official monitoring is
 * sparse — often one station for a whole city — while a sensor like this one is
 * already measuring the air where somebody actually lives, and that reading
 * normally goes nowhere. Turning this on puts it on a public map.
 *
 * Three things this deliberately does NOT do:
 *
 *   - It does not send your coordinates. openaqi resolves location from the
 *     station you register there, server-side, to an area of about 5 km². The
 *     payload here contains timestamps, metric names and numbers, and nothing
 *     else. Set OPENAQI_DRY_RUN=true and read the logs if you would rather
 *     check than take that on trust.
 *   - It does not send your sensor's name. The dashboard knows it as "Bedroom";
 *     openaqi never learns that.
 *   - It does not interfere with local collection. Readings go to your own
 *     ClickHouse first and are forwarded from a separate buffer, so openaqi
 *     being down, slow or misconfigured cannot cost you a local reading.
 */

export type ForwarderStatus = {
  enabled: boolean;
  dryRun: boolean;
  pending: number;
  sent: number;
  rejected: number;
  lastSentAt: number | null;
  lastError: string | null;
  /** Set when the key is refused. Nothing is sent again until it changes. */
  halted: string | null;
};

type Point = { ts: string; metric: string; value: number };

type ForwarderState = {
  status: ForwarderStatus;
  buffer: Point[];
  timer: NodeJS.Timeout | null;
  failures: number;
  sending: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __openaqi: ForwarderState | undefined;
}

/**
 * Metrics openaqi will not accept.
 *
 * Its catalogue dropped `vape` — it is a UniFi-specific index with no published
 * health meaning and no equivalent on other hardware. Sending it would earn a
 * rejection on every single batch, forever, so it is filtered here where the
 * reason can be written down.
 *
 * Everything else the console reports uses the same key names openaqi does,
 * which is not a coincidence: its catalogue took those names from this sensor.
 */
const NOT_ACCEPTED = new Set(["vape"]);

/** Above this, the oldest readings are dropped. A day of one sensor is a few
 *  thousand points, so this is roughly a week of backlog. */
const MAX_BUFFER = 25_000;

/** How often to send. Fixed rather than configurable: readings change every
 *  few seconds at most, openaqi aggregates by the minute, and a knob here would
 *  only ever be turned to a worse value. */
const FLUSH_MS = 60_000;

function state(): ForwarderState {
  if (!globalThis.__openaqi) {
    globalThis.__openaqi = {
      status: {
        enabled: false, dryRun: false,
        pending: 0, sent: 0, rejected: 0,
        lastSentAt: null, lastError: null, halted: null,
      },
      buffer: [],
      timer: null,
      failures: 0,
      sending: false,
    };
  }
  return globalThis.__openaqi;
}

export function forwarderStatus(): ForwarderStatus {
  const s = state();
  const cfg = env.openaqi;
  return {
    ...s.status,
    enabled: cfg.enabled,
    dryRun: cfg.dryRun,
    pending: s.buffer.length,
  };
}

/**
 * Queues a reading for openaqi.
 *
 * Called from the collector on the same readings it writes locally. Cheap and
 * synchronous: it appends to an array and returns, so a slow or unreachable
 * openaqi can never add latency to local collection.
 */
export function forward(reading: Reading): void {
  const cfg = env.openaqi;
  if (!cfg.enabled) return;
  const s = state();
  if (s.status.halted) return;

  // openaqi wants an absolute instant. The reading carries when it was TAKEN,
  // which is what makes buffering safe — a batch delivered three days late is
  // still recorded against the moment it happened.
  const ts = new Date(reading.ts).toISOString();

  for (const [metric, sample] of Object.entries(reading.metrics)) {
    if (NOT_ACCEPTED.has(metric)) continue;
    if (sample.value === null || !Number.isFinite(sample.value)) continue;
    s.buffer.push({ ts, metric, value: sample.value });
  }

  if (s.buffer.length > MAX_BUFFER) {
    // Oldest first: after a long outage a recent picture is worth more than a
    // stale one, and openaqi rejects anything older than its own age limit
    // anyway, so the oldest rows are the least likely to be accepted.
    s.buffer.splice(0, s.buffer.length - MAX_BUFFER);
  }
}

/** Sends whatever is queued. Safe to call concurrently — it returns early if a
 *  send is already in flight rather than sending the same batch twice. */
export async function flushToOpenaqi(): Promise<void> {
  const s = state();
  const cfg = env.openaqi;

  if (!cfg.enabled || s.status.halted || s.sending) return;
  if (s.buffer.length === 0) return;

  if (cfg.dryRun) {
    const batch = s.buffer.splice(0, s.buffer.length);
    console.info(
      `[openaqi] dry run — would send ${batch.length} readings to ${cfg.server}/v1/readings\n` +
        JSON.stringify({ readings: batch.slice(0, 5) }, null, 2) +
        (batch.length > 5 ? `\n… and ${batch.length - 5} more` : "") +
        "\n[openaqi] nothing above contains a coordinate or your sensor's name.",
    );
    s.status.sent += batch.length;
    s.status.lastSentAt = Date.now();
    return;
  }

  s.sending = true;
  // Peeked rather than removed: a batch taken off the buffer before a failed
  // send is a batch that no longer exists.
  const batch = s.buffer.slice(0, 10_000);

  try {
    const res = await fetch(`${cfg.server}/v1/readings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.key}`,
        "user-agent": "unifi-airquality-dashboard",
      },
      body: JSON.stringify({ readings: batch }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 401 || res.status === 403) {
      // Will not fix itself. Halting beats retrying every five seconds and
      // burying the message that says what is wrong.
      s.status.halted =
        "openaqi rejected the API key. Check OPENAQI_KEY, or issue a new one at https://openaqi.net/account";
      s.status.lastError = s.status.halted;
      return;
    }

    if (res.status >= 500 || res.status === 429) {
      // Theirs, or too fast. Keep the readings.
      throw new Error(`openaqi returned HTTP ${res.status}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      s.status.lastError = `openaqi rejected the batch: HTTP ${res.status} ${body.slice(0, 200)}`;
      // A malformed batch will be malformed next time too, so it is dropped
      // rather than retried forever.
      s.buffer.splice(0, batch.length);
      return;
    }

    const result = (await res.json().catch(() => null)) as
      | { accepted?: number; rejected?: number; reasons?: { metric: string; reason: string }[] }
      | null;

    s.buffer.splice(0, batch.length);
    s.status.sent += result?.accepted ?? batch.length;
    s.status.rejected += result?.rejected ?? 0;
    s.status.lastSentAt = Date.now();
    s.status.lastError = null;
    s.failures = 0;

    // Surfaced rather than swallowed: a metric failing validation on every
    // batch is exactly the kind of thing nobody notices for six months.
    for (const r of result?.reasons?.slice(0, 3) ?? []) {
      console.warn(`[openaqi] rejected ${r.metric}: ${r.reason}`);
    }
  } catch (err) {
    s.failures += 1;
    s.status.lastError = err instanceof Error ? err.message : String(err);
    // The buffer is untouched, so the next tick tries again.
  } finally {
    s.sending = false;
  }
}

/**
 * Starts the flush timer.
 *
 * The interval grows after repeated failures so a long openaqi outage settles
 * into an occasional retry rather than a request every few seconds against a
 * service that is already unhappy.
 */
export function startForwarder(): void {
  const s = state();
  const cfg = env.openaqi;
  if (!cfg.enabled || s.timer) return;

  const tick = async () => {
    await flushToOpenaqi();
    const backoff = Math.min(2 ** Math.min(s.failures, 5), 30) * FLUSH_MS;
    s.timer = setTimeout(() => void tick(), s.failures > 0 ? backoff : FLUSH_MS);
  };

  s.timer = setTimeout(() => void tick(), FLUSH_MS);
  console.info(
    `[openaqi] forwarding enabled → ${cfg.server}` + (cfg.dryRun ? " (DRY RUN — nothing is sent)" : ""),
  );
}

export function stopForwarder(): void {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
}
