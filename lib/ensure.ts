import "server-only";

import { startCollector } from "./collector";

let started = false;

/**
 * Starts the Protect collector on the first server-side request.
 *
 * This lives here rather than in instrumentation.ts because Next compiles
 * instrumentation for the Edge runtime as well, and the ClickHouse and ws
 * clients are Node-only.
 */
export function ensureCollector(): void {
  if (started) return;
  started = true;
  void startCollector();
}
