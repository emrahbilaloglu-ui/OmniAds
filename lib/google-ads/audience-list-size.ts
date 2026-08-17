/**
 * The one place that decides what the design's audience `Size` column means.
 *
 * Google serves membership size per network, never as a single number:
 * `user_list.size_for_display` counts the members reachable on the Display
 * Network and `user_list.size_for_search` the members reachable on google.com.
 * The design has one `Size` cell (markup line 1600), so this module fixes a
 * single, stated precedence — Display first, Search when Display is not served
 * — and both the reporting layer and the view read it from here so the number
 * behind the caption can never diverge between them.
 *
 * Nothing is combined, averaged or estimated: the rendered value is always one
 * of the two numbers Google returned. A list Google has not sized on either
 * network, and an audience that is not a user list at all, resolve to null and
 * keep the em dash.
 */

const DASH = "—";

export interface GoogleAdsUserListSizeInput {
  sizeForDisplay?: number | null;
  sizeForSearch?: number | null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The served size for one user list, or null when Google served neither
 * network's count. Negative counts are not a size Google reports; they are
 * treated as an absence rather than rendered.
 */
export function resolveGoogleAdsUserListSize(
  input: GoogleAdsUserListSizeInput | null | undefined,
): number | null {
  if (!input) return null;
  const display = finite(input.sizeForDisplay);
  if (display !== null && display >= 0) return display;
  const search = finite(input.sizeForSearch);
  if (search !== null && search >= 0) return search;
  return null;
}

/**
 * The reference's own size notation (model line 3870): `48k`, `210k`, `1.2M`.
 * Counts below a thousand print whole, thousands print as a rounded `k`, and a
 * million and above print with one decimal and an `M`. An unsized list prints
 * the em dash rather than a zero, because "not served" and "no members" are
 * different answers.
 */
export function formatGoogleAdsAudienceSize(
  value: number | null | undefined,
): string {
  const size = finite(value);
  if (size === null || size < 0) return DASH;
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)}M`;
  if (size >= 1_000) return `${Math.round(size / 1_000)}k`;
  return String(Math.round(size));
}
