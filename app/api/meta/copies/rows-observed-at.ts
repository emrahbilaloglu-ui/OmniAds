/**
 * Which clock describes the rows the Copies upstream actually served.
 *
 * WHY THIS IS NOT IN `route.ts`. Next.js validates the export surface of a
 * route module and accepts only the HTTP verbs and a fixed set of config
 * fields; anything else fails the production build with "is not a valid Route
 * export field". This function was exported from the route so the mapping could
 * be asserted directly instead of inferred from a rendered string — a good
 * reason with the wrong home. It lives here, and the route and its test both
 * import it, so the assertion stays direct and the build stays legal.
 *
 * The `warehouse` arm is the ONLY one allowed to hand back the `meta_ad_daily`
 * instant. Every live arm returns null, because there is no write behind a live
 * read and the request time is not an observation.
 */
export function resolveCopiesRowsObservedAt(input: {
  readSource: string | null | undefined;
  warehouseObservedAt: string | null;
}): {
  rowsObservedAt: string | null;
  rowsObservedAtSource: "warehouse" | "live" | "unknown";
} {
  if (input.readSource === "warehouse") {
    return {
      rowsObservedAt: input.warehouseObservedAt,
      rowsObservedAtSource: "warehouse",
    };
  }
  if (
    input.readSource === "live_fallback" ||
    input.readSource === "current_day_live"
  ) {
    return { rowsObservedAt: null, rowsObservedAtSource: "live" };
  }
  return { rowsObservedAt: null, rowsObservedAtSource: "unknown" };
}
