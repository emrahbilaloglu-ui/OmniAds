/**
 * Saved views.
 *
 * A buyer who has narrowed a surface to the account, lane, window and columns
 * they actually work from has to rebuild that arrangement on every visit. A
 * saved view is that arrangement, named, so returning to it is one click.
 *
 * Views are scoped to a surface and a business: a "Prospecting" view on one
 * client must never appear on another, and must never silently reapply another
 * client's account filter.
 */

export interface SavedViewConfig {
  providerAccountId?: string | null;
  lane?: string | null;
  status?: string | null;
  layer?: string | null;
  rangePreset?: string | null;
  comparisonPreset?: string | null;
  columns?: string[];
  filters?: Record<string, string | null>;
}

export interface SavedView {
  id: string;
  name: string;
  surface: string;
  businessId: string;
  config: SavedViewConfig;
  createdAt: string;
}

/** Views live under one key per surface and business, so scopes cannot bleed. */
export function savedViewScopeKey(surface: string, businessId: string): string {
  return `${surface}::${businessId}`;
}

export const MAX_SAVED_VIEW_NAME = 60;

export type SavedViewError = "empty_name" | "duplicate_name" | "name_too_long";

export function validateSavedViewName(
  name: string,
  existing: SavedView[],
): SavedViewError | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty_name";
  if (trimmed.length > MAX_SAVED_VIEW_NAME) return "name_too_long";
  if (existing.some((view) => view.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    return "duplicate_name";
  }
  return null;
}

export function describeSavedViewError(error: SavedViewError): string {
  switch (error) {
    case "empty_name":
      return "Give the view a name so it can be found again.";
    case "duplicate_name":
      return "A view with that name already exists on this surface.";
    case "name_too_long":
      return `Keep the name under ${MAX_SAVED_VIEW_NAME} characters.`;
  }
}

export function buildSavedView(input: {
  id: string;
  name: string;
  surface: string;
  businessId: string;
  config: SavedViewConfig;
  createdAt: string;
}): SavedView {
  return {
    id: input.id,
    name: input.name.trim(),
    surface: input.surface,
    businessId: input.businessId,
    config: input.config,
    createdAt: input.createdAt,
  };
}

/**
 * Views applicable to the current scope.
 *
 * A view saved against another business is not merely hidden, it is excluded:
 * applying one would silently move the operator's account filter to a client
 * they are not looking at.
 */
export function selectSavedViews(
  views: SavedView[],
  surface: string,
  businessId: string,
): SavedView[] {
  return views
    .filter((view) => view.surface === surface && view.businessId === businessId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether a saved view can still be applied.
 *
 * A view pinned to a provider account that is no longer assigned would restore
 * a scope the operator can no longer see, so it reports as unavailable rather
 * than applying a stale filter.
 */
export function isSavedViewApplicable(
  view: SavedView,
  availableAccountIds: string[],
): { applicable: boolean; reason: string | null } {
  const pinned = view.config.providerAccountId;
  if (!pinned) return { applicable: true, reason: null };
  if (availableAccountIds.includes(pinned)) return { applicable: true, reason: null };
  return {
    applicable: false,
    reason: "This view is pinned to an account that is no longer assigned.",
  };
}
