"use client";

import { useCallback, useEffect, useState } from "react";

const PREFIX = "aq.";

/**
 * useState that mirrors into localStorage.
 *
 * The initial render always uses `fallback` so the server-rendered markup and
 * the first client render agree; the stored value is applied in an effect
 * immediately afterwards. That avoids a hydration mismatch while still
 * restoring the user's layout on load.
 */
export function usePersistentState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(fallback);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PREFIX + key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* corrupt or unavailable storage — keep the fallback */
    }
    setHydrated(true);
  }, [key]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* private mode / quota — preferences just will not persist */
    }
  }, [key, value, hydrated]);

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
    setValue(fallback);
  }, [key, fallback]);

  return [value, setValue, { hydrated, reset }] as const;
}
