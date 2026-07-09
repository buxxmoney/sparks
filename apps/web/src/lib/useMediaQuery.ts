import { useSyncExternalStore } from "react";

/**
 * Reactive `window.matchMedia` — re-renders when the query flips.
 * Returns `false` during SSR/hydration so the first client render matches the
 * server, then corrects itself once mounted.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
