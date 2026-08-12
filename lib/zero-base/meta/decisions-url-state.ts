/**
 * Decisions URL state.
 *
 * Every filter and the selected row live in the URL so a daily operator surface
 * is linkable, reloadable and restorable — an operator who finds something and
 * pastes the link to a colleague must land them on the same row, not the top of
 * an unfiltered list.
 *
 * Parsing is total and fail-safe: an unknown lane, level or malformed value
 * falls back to the default rather than throwing, because a hand-edited URL is
 * an ordinary event and a decisions surface that 500s on one is worse than one
 * that ignores it. Nothing here grants access; the served universe is decided
 * by the server, and a selected id that is not in it is treated as absent.
 */

export const DECISION_LANES = ["act", "test", "watch"] as const;
export type DecisionLane = (typeof DECISION_LANES)[number];

export const DECISION_LEVELS = ["account", "campaign", "adset"] as const;
export type DecisionLevel = (typeof DECISION_LEVELS)[number];

export const DEFAULT_LANE: DecisionLane = "act";

export interface DecisionsUrlState {
  lane: DecisionLane;
  /** Empty means every level; the surface does not default to one. */
  levels: DecisionLevel[];
  search: string;
  /** Decision id from the URL, or null. Never trusted to exist. */
  selected: string | null;
}

export const DECISIONS_PARAM = {
  lane: "lane",
  levels: "levels",
  search: "q",
  selected: "row",
} as const;

const MAX_SEARCH_LENGTH = 128;

function parseLane(raw: string | null): DecisionLane {
  const value = raw?.trim().toLowerCase();
  return DECISION_LANES.find((lane) => lane === value) ?? DEFAULT_LANE;
}

function parseLevels(raw: string | null): DecisionLevel[] {
  if (!raw) return [];
  const requested = raw
    .split(",")
    .map((level) => level.trim().toLowerCase())
    .filter(Boolean);
  // Preserve the canonical order rather than the URL's, so two links that
  // select the same levels produce the same state.
  return DECISION_LEVELS.filter((level) => requested.includes(level));
}

function parseSearch(raw: string | null): string {
  const value = (raw ?? "").trim();
  // Bounded: an unbounded term is not a search, and it would ride into the
  // return state of every row link.
  return value.slice(0, MAX_SEARCH_LENGTH);
}

function parseSelected(raw: string | null): string | null {
  const value = (raw ?? "").trim();
  if (!value || value.length > 128) return null;
  // Opaque id shape only. Anything else cannot be one of ours.
  return /^[A-Za-z0-9_:.-]+$/.test(value) ? value : null;
}

export function parseDecisionsUrlState(params: URLSearchParams): DecisionsUrlState {
  return {
    lane: parseLane(params.get(DECISIONS_PARAM.lane)),
    levels: parseLevels(params.get(DECISIONS_PARAM.levels)),
    search: parseSearch(params.get(DECISIONS_PARAM.search)),
    selected: parseSelected(params.get(DECISIONS_PARAM.selected)),
  };
}

/**
 * Serialises state back to a query string.
 *
 * Default values are omitted so the common URL stays short and two equivalent
 * states produce the same string — otherwise "same view" links differ and
 * cache/telemetry treat them as distinct.
 */
export function serializeDecisionsUrlState(state: DecisionsUrlState): string {
  const params = new URLSearchParams();
  if (state.lane !== DEFAULT_LANE) params.set(DECISIONS_PARAM.lane, state.lane);
  if (state.levels.length > 0) {
    params.set(
      DECISIONS_PARAM.levels,
      DECISION_LEVELS.filter((level) => state.levels.includes(level)).join(","),
    );
  }
  if (state.search) params.set(DECISIONS_PARAM.search, state.search);
  if (state.selected) params.set(DECISIONS_PARAM.selected, state.selected);
  return params.toString();
}

export function decisionsHref(businessId: string, state: DecisionsUrlState): string {
  const query = serializeDecisionsUrlState(state);
  return `/app/meta/decisions${query ? `?${query}` : ""}`;
}

/**
 * Switching scope drops everything that named a specific record.
 *
 * Lane and level are properties of the view and survive; the search term and
 * the selected row are properties of the *previous* client's data and cannot
 * transfer — a selected decision id from another business would resolve to
 * nothing and read as a broken link.
 */
export function resetForContextChange(state: DecisionsUrlState): DecisionsUrlState {
  return { lane: state.lane, levels: state.levels, search: "", selected: null };
}

/** True when the URL selection names a row the server actually served. */
export function isSelectionServed(
  selected: string | null,
  servedIds: readonly string[],
): boolean {
  return selected !== null && servedIds.includes(selected);
}
