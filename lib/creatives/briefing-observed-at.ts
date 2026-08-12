/**
 * Tier-0 as-of authority for the canonical creatives briefing.
 *
 * `asOfDate` is a calendar label for the generation; it is NOT an instant and
 * must never be parsed as one. The observed-at timestamp a Tier-0 surface reads
 * is the latest canonical *computation* timestamp across the served inventory.
 * When no item carries one, the surface has no measured age and must say so
 * rather than inventing one from the calendar date.
 */
export function latestCanonicalComputedAt(
  items: ReadonlyArray<{ sourceDecision: { computedAt: string | null } }>,
): string | null {
  return (
    items
      .map((decision) => decision.sourceDecision.computedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
  );
}
