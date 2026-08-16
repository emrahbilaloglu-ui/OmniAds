"use client";

import { useCallback, useEffect, useState } from "react";
import { usePreferencesStore } from "@/store/preferences-store";

/**
 * Reports whether the persisted preferences snapshot has been applied.
 *
 * Read through zustand's own persist API rather than a store field: the server
 * render and the first client render must both see the in-code defaults, or
 * React throws the hydrated tree away. Surfaces that would otherwise flash a
 * default date range gate on this.
 */
export function usePreferencesHydrated(): boolean {
  const [hydrated, setHydrated] = useState(
    () => usePreferencesStore.persist?.hasHydrated?.() ?? true,
  );

  useEffect(() => {
    if (hydrated) return;
    const unsubscribe = usePreferencesStore.persist.onFinishHydration(() =>
      setHydrated(true),
    );
    void usePreferencesStore.persist.rehydrate();
    return unsubscribe;
  }, [hydrated]);

  return hydrated;
}

export function usePersistentPreferenceValue<T>(
  stored: T | null,
  setStored: (value: T) => void,
  fallback: T
): [T, (value: T) => void] {
  const value = stored ?? fallback;
  const setValue = useCallback(
    (next: T) => setStored(next),
    [setStored]
  );

  return [value, setValue];
}
