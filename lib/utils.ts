import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Parses a timestamp from either store.
 *
 * The two backends spell the same instant differently. ClickHouse returns
 * `2026-08-02 10:00:00` — no separator, no zone, but UTC by declaration. The
 * in-process analytics return a real ISO string, `2026-08-02T10:00:00.000Z`.
 *
 * Call sites used to append `"Z"` unconditionally, which is correct for the
 * first and produces `…000ZZ` for the second — and `Date.parse` answers `NaN`
 * to that. Every point on a chart would be `NaN` and the chart would render
 * empty, which looks exactly like having no data rather than like a parsing
 * bug. So the zone is supplied only when the string does not already carry one.
 */
export function parseStoreTs(value: string): number {
  const s = String(value).trim();
  const normalised = s.includes("T") ? s : s.replace(" ", "T");
  // A trailing Z, or a ±hh:mm offset after the time, means the zone is stated.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalised);
  return Date.parse(hasZone ? normalised : normalised + "Z");
}
