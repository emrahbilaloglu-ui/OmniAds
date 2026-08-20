import type {
  CreativeEvidenceWindowExactAdSet,
  CreativeEvidenceWindowExactAuditRow,
  CreativeEvidenceWindowExactCoverage,
  CreativeEvidenceWindowExactFact,
  CreativeEvidenceWindowExactFunnelStep,
  CreativeEvidenceWindowExactPlacement,
  CreativeEvidenceWindowExactReadNotice,
  CreativeEvidenceWindowExactTone,
  CreativeEvidenceWindowExactViewModel,
} from "@/components/creatives/CreativeEvidenceWindowExact";
import type {
  MetaCanonicalDecision,
  MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";
import type {
  MetaOsAdDecision,
  MetaOsDecisionAction,
} from "@/lib/meta/decisions-os-contract";

const EM_DASH = "—";

/**
 * A field the helper read has not answered yet, and a field the helper read
 * could not answer, are two different facts — and neither of them is "the
 * server served nothing here".
 *
 * Before this, `adRows`/`adSeries` arrived as `undefined` for all three cases
 * (loading, failed, genuinely empty) and every downstream cell printed the same
 * em-dash, so an operator could not tell an unreadable funnel from an absent
 * one. These two tokens keep the three cases distinguishable in the cell
 * itself; `readNotice` says which one it is in words.
 */
const PENDING_TOKEN = "…";
const UNREADABLE_TOKEN = "unreadable";

/**
 * What a CANONICAL-ONLY field prints on a row that was served without a
 * canonical decision snapshot.
 *
 * A row can reach this window with only the presentation decision behind it —
 * on Grandmix that is every one of the 60 served ads. Those rows carry real
 * engine evidence, so the window opens; what they do not carry is the audit
 * envelope, and the audit fields must say so.
 *
 * Three states have to stay apart, and a bare em-dash collapses two of them:
 *
 *   "—"                         the envelope IS here and this field is empty in it
 *   "unavailable · <reason>"    no envelope was served, so the field has no source
 *   a value                     the envelope served it
 *
 * The second is the only one that also means THE ROW HAS NO AUTHORITY. An
 * operator who cannot tell it from the first reads an unanswered question as an
 * answered one. Nothing here is ever filled in from the presentation decision:
 * eligibility, lineage, identity and write authority are properties of the
 * snapshot, and a decision that has no snapshot has none of them.
 */
const CANONICAL_ABSENT_VALUE =
  "unavailable · no canonical decision envelope was served for this row";

/**
 * Non-null exactly when a presentation decision was served and its canonical
 * envelope was not — never when nothing at all was served, because a window
 * built from nothing has no coverage claim to make and its dashes are honest.
 */
function canonicalAbsence(
  decision: MetaOsAdDecision | null,
  canonical: MetaCanonicalDecision | null,
): string | null {
  return decision && !canonical ? CANONICAL_ABSENT_VALUE : null;
}

/** Resolution state of one of the drawer's ad-grain helper reads. */
export type CreativeEvidenceWindowExactReadState =
  | "loading"
  | "error"
  /**
   * The read never happened — it is disabled, or the client paused it (react
   * -query pauses a fetch when the browser is offline). This used to collapse
   * into "loaded", so a read that had NOT run reported the same empty cells a
   * completed read reports, and an operator could not tell a missing metric
   * from one nobody asked for.
   */
  | "unread"
  | "loaded";

function pendingToken(
  state: CreativeEvidenceWindowExactReadState | undefined,
): string | null {
  if (state === "loading") return PENDING_TOKEN;
  // Both mean "this cell is not a measurement". They are kept apart in the
  // banner text — one could not be read, the other was never read — but the
  // cell itself must not look like an answer either way.
  if (state === "error" || state === "unread") return UNREADABLE_TOKEN;
  return null;
}

/**
 * Ad-grain evidence the decisions workspace contract does not carry. The
 * caller reads it from `/api/meta/creatives` (which keeps its own business
 * authorization) and narrows it to this shape so the adapter stays pure.
 */
export interface CreativeEvidenceWindowExactAdRow {
  id: string;
  adsetId: string | null;
  adsetName: string | null;
  spend: number | null;
  purchaseValue: number | null;
  roas: number | null;
  impressions: number | null;
  linkClicks: number | null;
  addToCart: number | null;
  purchases: number | null;
  thumbstop: number | null;
  launchDate: string | null;
}

/** One day of the per-ad trail, as `/api/meta/ads/series` serves it. */
export interface CreativeEvidenceWindowExactSeriesPoint {
  date: string;
  /**
   * Link CTR, percent. Served, but deliberately not the measure this card
   * draws: `meta_ad_daily.link_clicks` is 0 on every stored row, so a line
   * built from it is a flat zero for every creative
   * (app/api/meta/ads/series/route.ts states the same gap). Kept in the shape
   * so a later reader sees the choice was made rather than missed.
   */
  linkCtr: number | null;
  /**
   * All-clicks CTR, percent, as the provider stored it on `meta_ad_daily.ctr`.
   * The design captions this card plainly "CTR · 28d" (design file 3052), and
   * this is the measure that caption names — the same clicks-over-impressions
   * definition the engine's own `ctr_28d` uses (lib/meta/calibration.ts:353),
   * so this trail and the decision's own CTR speak about one number.
   */
  ctr: number | null;
  frequency: number | null;
}

export interface CreativeEvidenceWindowExactSeriesPayload {
  adCount: number;
  points: readonly CreativeEvidenceWindowExactSeriesPoint[];
}

export interface CreativeEvidenceWindowExactAdapterInput {
  /** Presentation decision — carries CTR, frequency, ad set identity, action. */
  decision?: MetaOsAdDecision | null;
  /** Canonical decision — carries media, confidence band, provenance, blockers. */
  canonical?: MetaCanonicalDecision | null;
  /** Ad-grain rows for this creative. Undefined means the read has not resolved. */
  adRows?: readonly CreativeEvidenceWindowExactAdRow[];
  /** Daily CTR / frequency trail. Undefined means the read has not resolved. */
  adSeries?: CreativeEvidenceWindowExactSeriesPayload | null;
  /**
   * Why `adRows` is undefined, when it is. Omitted behaves exactly as before
   * this field existed (absent === no data), so callers that cannot report a
   * read state lose nothing.
   */
  adRowsState?: CreativeEvidenceWindowExactReadState;
  /** Reason `adSeries` is empty. @see adRowsState */
  adSeriesState?: CreativeEvidenceWindowExactReadState;
  /** The message the failed helper read produced, shown verbatim. */
  adRowsErrorMessage?: string | null;
  adSeriesErrorMessage?: string | null;
  /**
   * Served capability states for the decision read model. These are the
   * server's own statements about what it can and cannot link; the drawer
   * reports them rather than inferring capability from empty fields.
   */
  capabilities?: MetaDecisionsWorkspaceReadModel["capabilities"] | null;
  /**
   * The generation this whole queue was read from, as the read model states it.
   *
   * `canonical.sourceAuthority` answers "what authority does THIS row carry";
   * this answers "what authority does the QUEUE carry" — the table the rows
   * came out of, the manifest they were validated against, and the reason the
   * server fell back when it did. On an account whose ads source degrades to
   * `legacy_creative`, every row keeps rendering and only this envelope says
   * so, which is why the window states it beside the row-grain authority
   * rather than leaving it to a banner that only appears on an empty queue.
   */
  source?: MetaDecisionsWorkspaceReadModel["source"] | null;
  /**
   * Whether the SERVER's own handoff law grants this decision a Launchpad
   * route, and the sentence it refuses with when it does not.
   *
   * The adapter does not decide this and must not: it renders the answer the
   * caller obtained from `authorizeLaunchpadHandoff`, the same function the
   * mint endpoint runs. Rendering it turns an inert primary control from a
   * button that mysteriously does nothing into a stated refusal.
   */
  launchpadRoute?: { offered: boolean; refusalReason: string | null } | null;
  /**
   * The authority verdict for the footer control actually being offered.
   * Launchpad remains separately visible above for audit; exact-Ad pause uses
   * this field so a refused Launchpad route cannot suppress a different,
   * server-authorized provider action.
   */
  primaryActionAuthority?: {
    kind: "launchpad_handoff" | "native_ad_pause";
    offered: boolean;
    refusalReason: string | null;
  } | null;
  fallbackCurrency?: string | null;
  hrefs?: {
    compareInStudio?: string | null;
    adsManager?: string | null;
    primary?: string | null;
  };
  callbacks?: {
    /**
     * The primary control's click, handed the SERVED action tuple by reference.
     *
     * Not a label, not a code, not a reconstruction: `decision.action` exactly
     * as the payload carried it, so the callback boundary sees the same
     * `{code, label, intent, targetLevel, providerMutation, scopeNote}` the
     * server wrote. The callback receives no action at all when the payload
     * served none, and the control is inert in that case — a missing action is
     * never filled in from the decision label.
     */
    onPrimary?: (action: MetaOsDecisionAction) => void;
  };
}

/** The design fixes six evidence slots; the fifth is decision-specific. */
const FACT_SLOTS = [
  "frequency",
  "first-time-reach",
  "thumbstop",
  "hold-15s",
  "decision-specific",
  "first-seen",
] as const;

const FUNNEL_SLOTS = [
  { id: "impressions", label: "Impressions" },
  // "Link clicks" is the exact name of the served metric; the design's
  // shorter "Clicks" would overstate what Meta reports here.
  { id: "link-clicks", label: "Link clicks" },
  { id: "add-to-cart", label: "Add to cart" },
  { id: "purchases", label: "Purchases" },
] as const;

function nonBlank(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function currencyCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function formatCount(value: number | null | undefined): string {
  const amount = finite(value);
  if (amount === null) return EM_DASH;
  return Math.round(amount).toLocaleString("en-US");
}

export function formatEvidenceMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  const amount = finite(value);
  const code = currencyCode(currency);
  if (amount === null || code === null) return EM_DASH;
  const symbol = code === "USD" ? "$" : code === "EUR" ? "€" : code === "TRY" ? "₺" : null;
  return symbol ? `${symbol}${formatNumber(amount)}` : `${code} ${formatNumber(amount)}`;
}

function formatRoas(value: number | null | undefined): string {
  const normalized = finite(value);
  return normalized === null ? EM_DASH : normalized.toFixed(2);
}

function formatPercent(value: number | null | undefined, digits = 1): string {
  const normalized = finite(value);
  return normalized === null ? EM_DASH : `${normalized.toFixed(digits)}%`;
}

function ratioPercent(
  numerator: number | null,
  denominator: number | null,
): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function decisionTone(label: string | null | undefined): CreativeEvidenceWindowExactTone {
  switch (label?.trim().toLowerCase()) {
    case "scale":
    case "protect":
    case "scale_winner":
      return "positive";
    case "cut":
    case "retire":
    case "pause":
      return "negative";
    case "refresh":
    case "watch":
      return "warning";
    default:
      return "neutral";
  }
}

function bandTone(
  band: MetaCanonicalDecision["sourceDecision"]["confidenceBand"] | null | undefined,
): CreativeEvidenceWindowExactTone {
  if (band === "high") return "positive";
  if (band === "medium") return "warning";
  if (band === "low") return "negative";
  return "neutral";
}

function bandLabel(
  band: MetaCanonicalDecision["sourceDecision"]["confidenceBand"] | null | undefined,
): string {
  if (band === "high") return "High confidence";
  if (band === "medium") return "Medium confidence";
  if (band === "low") return "Low confidence";
  return EM_DASH;
}

function roasTone(
  roas: number | null,
  target: number | null,
): CreativeEvidenceWindowExactTone {
  if (roas === null || target === null || target <= 0) return "neutral";
  const ratio = roas / target;
  if (ratio >= 1) return "positive";
  if (ratio >= 0.75) return "warning";
  return "negative";
}

function shortId(value: string | null | undefined): string | null {
  const normalized = nonBlank(value);
  if (!normalized) return null;
  return normalized.length <= 12
    ? normalized
    : `${normalized.slice(0, 4)}…${normalized.slice(-2)}`;
}

function isoDate(value: string | null | undefined): string | null {
  const normalized = nonBlank(value);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * The design's funnel bars are a log scale, not a literal share, and the scale
 * is recoverable from the design's own three funnels. Solving each authored
 * width for the decade span `D` in `1 + log10(v / top) / D` gives 4.09–4.35 on
 * seven of the nine sub-bars (design file 3610, 3624, 3638), so the design
 * draws a fixed window of decades below the funnel top. This uses that window.
 *
 * The two residuals are the `Clicks` bars of the Refresh and Retire funnels,
 * which the design draws shorter than its own scale (D 3.65 and 3.45); those
 * are recorded as DRAWERS-43 rather than fitted, because no single monotone
 * rule reproduces them alongside the other seven.
 *
 * A decade window is also the only form of this that is scale-free: it depends
 * on `v / top` alone, so two funnels of the same shape draw the same whatever
 * the account's volume. The previous `log10(v + 1) / log10(top + 1)` did not —
 * it grew toward 100% as raw counts grew, and drew this funnel's sub-bars at
 * 68 / 48 / 41 against the design's 46 / 27 / 15.
 *
 * The number printed beside each bar stays the literal served count.
 */
const FUNNEL_BAR_DECADES = 4.25;

function funnelShare(value: number | null, top: number | null): number | null {
  if (value === null || top === null || top <= 0 || value <= 0) return null;
  const share = 1 + Math.log10(value / top) / FUNNEL_BAR_DECADES;
  return Math.min(1, Math.max(0, share));
}

/**
 * The design's sparkline geometry: 28 points across a `0 0 100 22` viewBox with
 * a 2px inset top and bottom, one decimal per coordinate (design file 3187).
 */
const SPARK_HEIGHT = 22;
const SPARK_INSET = 2;

function sparklinePath(values: readonly number[]): string | null {
  if (values.length < 2) return null;
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min;
  const usable = SPARK_HEIGHT - SPARK_INSET * 2;
  const step = 100 / (values.length - 1);
  return values
    .map((value, index) => {
      const fraction = span === 0 ? 0.5 : (value - min) / span;
      const y = SPARK_HEIGHT - SPARK_INSET - fraction * usable;
      return `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Percent change of the trailing half of the window against the leading half —
 * the design's "vs 14d baseline" on a 28-day series, computed from the series
 * itself rather than from a second, unserved baseline.
 */
function halfWindowDelta(values: readonly number[]): { delta: number; days: number } | null {
  if (values.length < 4) return null;
  const half = Math.floor(values.length / 2);
  const prior = mean(values.slice(0, half));
  const recent = mean(values.slice(values.length - half));
  if (prior === null || recent === null || prior <= 0) return null;
  return { delta: ((recent - prior) / prior) * 100, days: half };
}

function signedPercent(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

function adCountSuffix(adCount: number): string {
  return adCount > 1 ? ` · ${adCount} ads` : "";
}

function buildSeriesPair(
  payload: CreativeEvidenceWindowExactSeriesPayload | null | undefined,
  unresolved: string | null,
): {
  ctr: { path: string | null; note: string };
  frequency: { path: string | null; note: string };
} {
  const empty = { path: null, note: unresolved ?? EM_DASH };
  if (!payload || payload.points.length === 0) {
    return { ctr: { ...empty }, frequency: { ...empty } };
  }
  const suffix = adCountSuffix(payload.adCount);

  // The card's caption is the generic "CTR · 28d", so it draws the generic
  // all-clicks CTR the route serves. Reading `linkCtr` under that caption drew
  // a flat zero for every creative, because link clicks are not ingested; and
  // relabelling the card "link CTR" is not available either — the caption is
  // drawn by the design. No fallback between the two: they are different
  // measures and one line must not silently switch between them.
  const ctrValues = payload.points
    .map((point) => finite(point.ctr))
    .filter((value): value is number => value !== null);
  const ctrDelta = halfWindowDelta(ctrValues);
  const ctrPath = sparklinePath(ctrValues);
  const ctrNote =
    ctrPath === null
      ? (unresolved ?? EM_DASH)
      : ctrDelta
        ? `${signedPercent(ctrDelta.delta)} vs prior ${ctrDelta.days}d${suffix}`
        : `${ctrValues.length} days served${suffix}`;

  const frequencyValues = payload.points
    .map((point) => finite(point.frequency))
    .filter((value): value is number => value !== null);
  const frequencyDelta = halfWindowDelta(frequencyValues);
  const frequencyPath = sparklinePath(frequencyValues);
  const latestFrequency = frequencyValues[frequencyValues.length - 1];
  const frequencyNote =
    frequencyPath === null
      ? (unresolved ?? EM_DASH)
      : frequencyDelta
        ? `${latestFrequency.toFixed(1)} · ${signedPercent(frequencyDelta.delta)} vs prior ${frequencyDelta.days}d${suffix}`
        : `${latestFrequency.toFixed(1)} · ${frequencyValues.length} days served${suffix}`;

  return {
    ctr: { path: ctrPath, note: ctrNote },
    frequency: { path: frequencyPath, note: frequencyNote },
  };
}

function sumRows(
  rows: readonly CreativeEvidenceWindowExactAdRow[],
  pick: (row: CreativeEvidenceWindowExactAdRow) => number | null,
): number | null {
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const value = finite(pick(row));
    if (value === null) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

/**
 * Provider rates are per-row percentages; rolling them up across the ads that
 * share a creative means weighting by that row's impressions.
 */
function impressionWeightedRate(
  rows: readonly CreativeEvidenceWindowExactAdRow[],
  pick: (row: CreativeEvidenceWindowExactAdRow) => number | null,
): number | null {
  let weighted = 0;
  let impressions = 0;
  let seen = false;
  for (const row of rows) {
    const rate = finite(pick(row));
    const rowImpressions = finite(row.impressions);
    if (rate === null || rowImpressions === null || rowImpressions <= 0) continue;
    seen = true;
    weighted += rate * rowImpressions;
    impressions += rowImpressions;
  }
  if (!seen || impressions <= 0) return null;
  return weighted / impressions;
}

function buildAdSets(input: {
  rows: readonly CreativeEvidenceWindowExactAdRow[] | undefined;
  decision: MetaOsAdDecision | null;
  canonical: MetaCanonicalDecision | null;
  currency: string | null;
  target: number | null;
  unresolved: string | null;
}): CreativeEvidenceWindowExactAdSet[] {
  const grouped = new Map<
    string,
    { label: string | null; spend: number | null; revenue: number | null }
  >();
  for (const row of input.rows ?? []) {
    const key = nonBlank(row.adsetId) ?? nonBlank(row.adsetName) ?? row.id;
    const current = grouped.get(key) ?? {
      label: nonBlank(row.adsetName),
      spend: null,
      revenue: null,
    };
    const spend = finite(row.spend);
    const revenue =
      finite(row.purchaseValue) ??
      (spend !== null && finite(row.roas) !== null ? spend * (finite(row.roas) as number) : null);
    grouped.set(key, {
      label: current.label ?? nonBlank(row.adsetName),
      spend: spend === null ? current.spend : (current.spend ?? 0) + spend,
      revenue: revenue === null ? current.revenue : (current.revenue ?? 0) + revenue,
    });
  }

  if (grouped.size === 0) {
    // No ad-grain read resolved. The decision itself names exactly one ad set,
    // and an ad's spend/ROAS inside that ad set is the decision's own metrics.
    const label =
      nonBlank(input.decision?.adsetName) ??
      nonBlank(input.canonical?.parentChain.adset?.name) ??
      nonBlank(input.canonical?.parentChain.adset?.id);
    if (!label) {
      // An in-flight or failed ad-grain read is not "this creative runs
      // nowhere"; the empty list would have said the second.
      if (!input.unresolved) return [];
      return [
        {
          id: "adset-unresolved",
          label: input.unresolved,
          spend: input.unresolved,
          roas: input.unresolved,
          roasTone: "neutral" as const,
        },
      ];
    }
    const spend = finite(input.decision?.metrics.spend ?? input.canonical?.metrics.spend);
    const roas = finite(input.decision?.metrics.roas ?? input.canonical?.metrics.roas);
    return [
      {
        id: nonBlank(input.canonical?.parentChain.adset?.id) ?? "adset-1",
        label,
        spend: formatEvidenceMoney(spend, input.currency),
        roas: formatRoas(roas),
        roasTone: roasTone(roas, input.target),
      },
    ];
  }

  return Array.from(grouped.entries())
    .map(([id, value]) => {
      const roas =
        value.spend !== null && value.spend > 0 && value.revenue !== null
          ? value.revenue / value.spend
          : null;
      return {
        id,
        label: value.label ?? EM_DASH,
        spend: formatEvidenceMoney(value.spend, input.currency),
        roas: formatRoas(roas),
        roasTone: roasTone(roas, input.target),
        sortSpend: value.spend ?? 0,
      };
    })
    .sort((left, right) => right.sortSpend - left.sortSpend)
    .map(({ sortSpend: _sortSpend, ...adSet }) => adSet);
}

function buildFunnel(input: {
  rows: readonly CreativeEvidenceWindowExactAdRow[] | undefined;
  decision: MetaOsAdDecision | null;
  canonical: MetaCanonicalDecision | null;
  unresolved: string | null;
}): CreativeEvidenceWindowExactFunnelStep[] {
  const rows = input.rows ?? [];
  const impressions = sumRows(rows, (row) => row.impressions);
  const linkClicks = sumRows(rows, (row) => row.linkClicks);
  const addToCart = sumRows(rows, (row) => row.addToCart);
  const purchases =
    sumRows(rows, (row) => row.purchases) ??
    finite(input.decision?.metrics.purchases ?? input.canonical?.metrics.purchases);
  const values = [impressions, linkClicks, addToCart, purchases];
  const subs = [
    "",
    formatPercent(ratioPercent(linkClicks, impressions), 2),
    formatPercent(ratioPercent(addToCart, linkClicks), 1),
    formatPercent(ratioPercent(purchases, linkClicks), 1),
  ];
  const prefixes = ["", "CTR ", "ATC ", "CVR "];
  // A count the helper read has not delivered prints the read state, not the
  // same em-dash a genuinely unserved count prints.
  const unread = (rendered: string) =>
    rendered === EM_DASH && input.unresolved ? input.unresolved : rendered;
  return FUNNEL_SLOTS.map((slot, index) => ({
    id: slot.id,
    label: slot.label,
    value: unread(formatCount(values[index])),
    sub:
      index === 0
        ? ""
        : subs[index] === EM_DASH
          ? unread(EM_DASH)
          : `${prefixes[index]}${subs[index]}`,
    share: funnelShare(values[index], impressions),
  }));
}

function buildPlacements(): CreativeEvidenceWindowExactPlacement[] {
  // `meta_breakdown_daily` does carry spend, revenue and roas per placement
  // (lib/migrations.ts:8021); what it has no column for is the entity. Its
  // unique key is (business_id, provider_account_id, date, breakdown_type,
  // breakdown_key) — no campaign, ad set or ad — and the sync writes it from
  // an account-level insights call (checkpoint scope
  // `breakdown:publisher_platform,platform_position,impression_device`,
  // lib/meta/warehouse.ts:436), so every placement row is account-wide. A
  // per-creative placement share cannot be computed from an account-grain row
  // at all, and its ROAS would be the account's, not this creative's. The card
  // keeps its geometry and states the absence.
  return [1, 2, 3].map((slot) => ({
    id: `placement-${slot}`,
    label: EM_DASH,
    share: EM_DASH,
    roas: EM_DASH,
    width: null,
  }));
}

/**
 * The design's fifth fact row is decision-specific: "Fatigue confirmed · 6
 * days" on the Refresh creative, "Better variants live · 2" on the Retire one,
 * "Days above target · 21" on the Scale one (design file 3613, 3627, 3641).
 * Exactly one of those three families is persisted — the engine's own fatigue
 * classification, served as `fatigueStatus` on both decision envelopes. It
 * lives on `engine_v3_creative_lifecycle_daily.fatigue_status` and reaches the
 * ad-grain payload by the lineage join the read model makes on
 * `snapshot.creative_evidence_lifecycle_row_id`; `engine_v3_decision_snapshots_daily`
 * carries no such column. The *duration* beside the design's label ("6 days")
 * is not persisted, so this row prints the served classification and does not
 * invent a day count for it.
 *
 * One grain caveat worth keeping in the record: this is CREATIVE-grain lifecycle
 * evidence, and the ad-grain engine deliberately declines to label from it
 * (`ad-decisions-job.ts` pins `fatigueStatus: null` until an ad-level lifecycle
 * contract exists). This is the creative evidence window, so the grain is right
 * and printing it is truthful — but it sits beside an ad-grain verdict that
 * provably did not consume it, and a reader should not infer otherwise.
 *
 * An absent field and a served `unknown` are different facts: the first means
 * the payload carries no decision-specific evidence and keeps the slot fully
 * dashed; the second means the engine looked and could not classify, and says
 * so.
 */
function fatigueFact(status: string | null | undefined): {
  label: string;
  value: string;
} {
  const normalized = nonBlank(status)?.toLowerCase() ?? null;
  if (!normalized) return { label: EM_DASH, value: EM_DASH };
  return {
    label: "Fatigue",
    value: normalized.charAt(0).toUpperCase() + normalized.slice(1),
  };
}

function buildFacts(input: {
  rows: readonly CreativeEvidenceWindowExactAdRow[] | undefined;
  decision: MetaOsAdDecision | null;
  canonical: MetaCanonicalDecision | null;
  unresolved: string | null;
}): CreativeEvidenceWindowExactFact[] {
  const rows = input.rows ?? [];
  const frequency = finite(input.decision?.metrics.frequency);
  const thumbstop = impressionWeightedRate(rows, (row) => row.thumbstop);
  const firstSeen = rows
    .map((row) => isoDate(row.launchDate))
    .filter((value): value is string => Boolean(value))
    .sort()[0];

  const values: Record<(typeof FACT_SLOTS)[number], { label: string; value: string }> = {
    frequency: {
      label: "Frequency",
      value: frequency === null ? EM_DASH : frequency.toFixed(1),
    },
    // Plain reach IS served per ad (`meta_ad_daily.reach`, surfaced as
    // `CreativeWarehouseCommonFields.reach`). First-time reach is not: it is
    // the share of that reach seeing the creative for the first time, and
    // nothing in the warehouse decomposes a day's reach into new and repeat
    // people. Printing plain reach — or 1/frequency — under this label would
    // be the same substitution DRAWERS-40 refuses for Hold 15s.
    "first-time-reach": { label: "First-time reach", value: EM_DASH },
    thumbstop: {
      label: "Thumbstop",
      value:
        thumbstop === null && input.unresolved
          ? input.unresolved
          : formatPercent(thumbstop, 1),
    },
    // ThruPlay is the nearest served fact and is not a 15s hold, so this stays
    // unserved rather than substituting a different metric under this label.
    "hold-15s": { label: "Hold 15s", value: EM_DASH },
    "decision-specific": fatigueFact(
      input.decision?.fatigueStatus ?? input.canonical?.fatigueStatus,
    ),
    "first-seen": {
      label: "First seen",
      value: firstSeen ?? input.unresolved ?? EM_DASH,
    },
  };

  return FACT_SLOTS.map((slot) => ({
    id: slot,
    label: values[slot].label,
    value: values[slot].value,
    tone: "neutral" as const,
  }));
}

function buildKind(input: {
  canonical: MetaCanonicalDecision | null;
  decision: MetaOsAdDecision | null;
  adSetCount: number;
}): string {
  const adId =
    nonBlank(input.canonical?.parentChain.ad?.id) ?? nonBlank(input.decision?.adId);
  const parts: string[] = [];
  const id = shortId(adId);
  if (id) parts.push(`id ${id}`);
  if (input.adSetCount > 0) {
    parts.push(`in ${input.adSetCount} ad set${input.adSetCount === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : EM_DASH;
}

function buildVerdictSub(input: {
  decision: MetaOsAdDecision | null;
  canonical: MetaCanonicalDecision | null;
}): string {
  const parts: string[] = [];
  const scopeNote = nonBlank(input.decision?.action.scopeNote);
  if (scopeNote) parts.push(`${scopeNote}.`);
  // Authority gates stay visible: the design has no Blockers section, so their
  // text rides the verdict sub-line rather than disappearing.
  //
  // The canonical list is preferred and the SERVED list is the fallback, not an
  // addition — they describe the same gates and concatenating them printed each
  // one twice. A row with no envelope has only the served list, and dropping it
  // was how the single most important sentence on a blocked row ("exact
  // Ad-grain decision evidence is unavailable") vanished from the window that
  // exists to explain it.
  const canonicalBlockers = input.canonical?.classification.blockers ?? [];
  const blockers =
    canonicalBlockers.length > 0
      ? canonicalBlockers
      : (input.decision?.blockers ?? []);
  for (const blocker of blockers) {
    const label = nonBlank(blocker.label);
    if (label) parts.push(label.endsWith(".") ? label : `${label}.`);
  }
  // Advisories stay on this line because it is where the operator already
  // reads them — `risk_tier_unclassified` rode it as a "blocker" on every row.
  // They are prefixed and carry their reason so the sentence says what it is:
  // a gap in this pipeline, not a gate this ad failed.
  for (const advisory of input.canonical?.classification?.advisories ?? []) {
    const label = nonBlank(advisory.label);
    if (!label) continue;
    const reason = nonBlank(advisory.reason);
    const sentence = reason
      ? `${label} — ${humanizeCode(reason)}`
      : label;
    parts.push(`Advisory: ${sentence.endsWith(".") ? sentence : `${sentence}.`}`);
  }
  // Who owes the next move, in the server's own words. Served on every decision
  // that has one and rendered nowhere before this.
  const nextStep = nonBlank(input.decision?.resolution?.nextStep);
  if (nextStep) parts.push(`Next: ${nextStep.endsWith(".") ? nextStep : `${nextStep}.`}`);
  return parts.length > 0 ? parts.join(" ") : EM_DASH;
}

function buildProvenance(input: {
  canonical: MetaCanonicalDecision | null;
  decision: MetaOsAdDecision | null;
}): string {
  const snapshot =
    isoDate(input.canonical?.sourceDecision.snapshotAsOf) ??
    isoDate(input.decision?.snapshotAsOf);
  const decisionId = shortId(
    input.canonical?.decisionId ?? input.decision?.decisionId ?? null,
  );
  const engine = nonBlank(
    input.canonical?.sourceDecision.engineVersion ?? input.decision?.engineVersion,
  );
  const parts = [
    `snapshot ${snapshot ?? EM_DASH}`,
    `decision ${decisionId ?? EM_DASH}`,
    `engine ${engine ?? EM_DASH}`,
  ];
  return `provenance: ${parts.join(" · ")}`;
}

/**
 * Where each served audit family is rendered, and why it is rendered there.
 *
 * The list row and the drawer head carry the DECISION SUMMARY — name, label,
 * confidence band, money, engine reasoning — because that is what an operator
 * scans. Everything below is the audit surface the payload already serves and
 * the drawer used to drop on the floor:
 *
 *  - `authority` — the questions "may this row be acted on, by whom, against
 *    what identity, and what happened last time" — is EVIDENCE. It sits in the
 *    drawer body beside the evidence it qualifies, because a review-only source
 *    or an ambiguous identity changes how every number above it should be read.
 *  - `diagnostics` — snapshot / evaluation / input / decision hashes, provider
 *    lineage ids, job run id, generation manifest + expected ad count, blocker
 *    codes, the source table — is a RECEIPT. It is never needed to decide, only
 *    to prove, so it lives in a closed disclosure at the bottom rather than
 *    competing with the decision.
 *
 * The families, and where each one landed:
 *
 *   queue-grain source authority ....... authority  (qualifies every row)
 *   row-grain source authority ......... authority
 *   action eligibility + served action . authority
 *   identity resolution ................ authority
 *   delivery scope ..................... authority
 *   risk tier / confirmation ceremony .. authority
 *   operator responses, provider writes  authority
 *   decision events, recorded outcomes . authority
 *   Launchpad route verdict ............ authority  (explains the footer)
 *   decision / episode / snapshot ids .. diagnostics
 *   input, decision, manifest hashes ... diagnostics
 *   provider + generation lineage ...... diagnostics
 *   blocker codes ...................... diagnostics (labels ride the verdict)
 *
 * Nothing here is added to the summary card: cramming a decision hash next to
 * the verdict would make the drawer less readable, not more honest. The list
 * row keeps the decision summary alone.
 */
function authorityRows(input: {
  decision: MetaOsAdDecision | null;
  canonical: MetaCanonicalDecision | null;
  capabilities: MetaDecisionsWorkspaceReadModel["capabilities"] | null;
  source: MetaDecisionsWorkspaceReadModel["source"] | null;
  launchpadRoute: { offered: boolean; refusalReason: string | null } | null;
  primaryActionAuthority: {
    kind: "launchpad_handoff" | "native_ad_pause";
    offered: boolean;
    refusalReason: string | null;
  } | null;
  servedAction: MetaOsDecisionAction | null;
}): CreativeEvidenceWindowExactAuditRow[] {
  const canonical = input.canonical;
  const decision = input.decision;
  const absent = canonicalAbsence(decision, canonical);
  const rows: CreativeEvidenceWindowExactAuditRow[] = [];
  const push = (
    id: string,
    label: string,
    value: string,
    tone?: CreativeEvidenceWindowExactTone,
  ) => {
    rows.push({ id, label, value, tone });
  };
  /**
   * The fallback for a field only the canonical envelope can answer.
   *
   * Empty-in-a-served-envelope stays an em-dash. No-envelope-at-all says so and
   * is toned as the gap it is, so it cannot be scanned past as "nothing here".
   */
  const canonicalOnly = (): { value: string; tone: CreativeEvidenceWindowExactTone } =>
    absent
      ? { value: absent, tone: "warning" }
      : { value: EM_DASH, tone: "neutral" };
  const pushCanonicalOnly = (
    id: string,
    label: string,
    served: string | null,
    tone: CreativeEvidenceWindowExactTone,
  ) => {
    if (served !== null) {
      push(id, label, served, tone);
      return;
    }
    const gap = canonicalOnly();
    push(id, label, gap.value, gap.tone);
  };

  // Queue grain first: it qualifies every row-grain answer under it. A
  // `legacy_creative` generation does not make the row below it wrong, it makes
  // it review-only, and an operator who cannot see that reads 60 low-authority
  // rows as 60 ordinary ones.
  const source = input.source ?? null;
  push(
    "queue-source-authority",
    "Queue source",
    source
      ? `${humanizeCode(source.authority)} · ${humanizeCode(source.status)}`
      : EM_DASH,
    source
      ? source.authority === "native_ad" && source.status === "available"
        ? "positive"
        : "warning"
      : "neutral",
  );
  if (source?.fallbackReason) {
    push(
      "queue-source-fallback",
      "Source fallback",
      humanizeCode(source.fallbackReason),
      "warning",
    );
  }

  /*
   * The SERVED half, stated before the canonical half it is not a substitute
   * for.
   *
   * Every row below comes off the presentation decision verbatim. They used to
   * be dropped entirely, which is what made an envelope-less row look empty:
   * the engine had said what lane it put the ad in, how sure it was, what it
   * was waiting on and who owed the next step, and none of it reached the
   * window. Each keeps the word "Served" in its label so it can never be read
   * as the canonical answer to the question underneath — most sharply for risk
   * tier and ceremony, which exist on both envelopes and mean different things:
   * a display projection here, a write gate there.
   */
  if (decision) {
    push("served-lane", "Served lane", humanizeCode(decision.lane) || EM_DASH,
      decision.lane === "act" ? "positive" : "warning");
    push(
      "served-availability",
      "Decision availability",
      humanizeCode(decision.decisionAvailability) || EM_DASH,
      decision.decisionAvailability === "available" ? "positive" : "warning",
    );
    // Read once, through `finite`, and print THAT value — never the raw field.
    // A MEASURED score of 0 is a score and prints "score 0.00"; a null score is
    // no score at all and prints nothing, so the synthesised
    // `await_ad_grain_evidence` row no longer reports a confidence it does not
    // have. The band beside it is served either way.
    const confidenceScore = finite(decision.confidenceScore);
    push(
      "served-confidence",
      "Served confidence",
      [
        nonBlank(decision.confidence),
        confidenceScore === null ? null : `score ${confidenceScore.toFixed(2)}`,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ") || EM_DASH,
    );
    push(
      "served-priority",
      "Served priority",
      [
        nonBlank(decision.priority?.band),
        finite(decision.priority?.rank) === null
          ? null
          : `rank ${decision.priority.rank}`,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ") || EM_DASH,
    );
    push(
      "served-risk-tier",
      "Served risk tier",
      nonBlank(decision.riskTier) ?? EM_DASH,
    );
    push(
      "served-ceremony",
      "Served ceremony",
      humanizeCode(decision.confirmationCeremony) || EM_DASH,
    );
    push(
      "served-campaign-role",
      "Served campaign role",
      [
        nonBlank(decision.lifecycleRole),
        nonBlank(decision.campaignRoleSource),
        nonBlank(decision.campaignRoleConfidence)
          ? `confidence ${decision.campaignRoleConfidence}`
          : null,
        decision.campaignRoleTrustedForAction
          ? "trusted for action"
          : "not trusted for action",
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ") || EM_DASH,
      decision.campaignRoleTrustedForAction ? "neutral" : "warning",
    );
    push(
      "served-resolution",
      "Served resolution",
      decision.resolution
        ? [
            nonBlank(decision.resolution.label),
            nonBlank(decision.resolution.owner)
              ? `owner ${decision.resolution.owner}`
              : null,
            // Owner and category are separate fields that often carry the same
            // word ("system"). Printing both then reads as two facts when it is
            // one, so the category is stated only when it adds something.
            nonBlank(decision.resolution.category) !==
            nonBlank(decision.resolution.owner)
              ? nonBlank(decision.resolution.category)
              : null,
          ]
            .filter((part): part is string => Boolean(part))
            .join(" · ") || EM_DASH
        : EM_DASH,
      decision.resolution ? "warning" : "neutral",
    );
    if (decision.authorityProvenance) {
      const provenance = decision.authorityProvenance;
      push(
        "served-authority-provenance",
        "Served label provenance",
        [
          humanizeCode(provenance.availability) || null,
          nonBlank(provenance.preAuthorityLabel)
            ? `pre-authority ${provenance.preAuthorityLabel}`
            : null,
          nonBlank(provenance.postAuthorityRawLabel)
            ? `post-authority ${provenance.postAuthorityRawLabel}`
            : null,
          nonBlank(provenance.publishedLabel)
            ? `published ${provenance.publishedLabel}`
            : null,
          provenance.firstBlocker
            ? `first blocker ${provenance.firstBlocker.label}`
            : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" · ") || EM_DASH,
        provenance.availability === "available" ? "neutral" : "warning",
      );
      /*
       * The sentence behind the first blocker's label.
       *
       * The line above names the gate ("Recent economic recovery cannot be
       * ruled out"); the label is a noun phrase and says nothing about what it
       * did to this verdict. The explanation is the server's own sentence for
       * that — "The Cut verdict is held until a sufficiently sampled recent
       * window confirms ROAS remains below break-even"
       * (decisions-os-presentation.ts, AUTHORITY_BLOCKER_PRESENTATION) — and on
       * a held row where `resolution` is null it is the ONLY served prose that
       * explains why the published label differs from the pre-authority one.
       * Printed as its own row rather than appended to the joined line above,
       * which is a token list and would become unreadable with a sentence in it.
       */
      if (provenance.firstBlocker) {
        push(
          "served-first-blocker-explanation",
          "Label held because",
          // A blocker served without its sentence is an em dash, not silence:
          // the gate was tripped and the row must still say so.
          nonBlank(provenance.firstBlocker.explanation) ?? EM_DASH,
          "warning",
        );
      }
    }
  }

  const authority = canonical?.sourceAuthority ?? null;
  pushCanonicalOnly(
    "source-authority",
    "Source authority",
    authority ? humanizeCode(authority.status) : null,
    authority?.status === "native_exact" ? "positive" : "warning",
  );
  /*
   * INVARIANT: eligibility is never inferred from the presentation decision.
   *
   * `decision.action` says what the engine WOULD call for; it says nothing
   * about whether this row may be acted on, and reading a served action label
   * as an eligibility answer is precisely the substitution this window exists
   * to refuse. With no envelope the question has no source and stays open, out
   * loud.
   */
  pushCanonicalOnly(
    "action-eligibility",
    "Action eligible",
    authority ? (authority.actionEligible ? "yes" : "no") : null,
    authority?.actionEligible ? "positive" : "warning",
  );
  if (authority?.reviewOnlyReason) {
    push(
      "review-only-reason",
      "Review-only because",
      humanizeCode(authority.reviewOnlyReason),
      "warning",
    );
  }
  pushCanonicalOnly(
    "authorized-action",
    "Authorized action",
    nonBlank(authority?.authorizedAction),
    "neutral",
  );
  pushCanonicalOnly(
    "decision-state",
    "Decision state",
    canonical?.classification?.decisionState
      ? humanizeCode(canonical.classification.decisionState)
      : null,
    canonical?.classification?.decisionState === "act" ? "positive" : "warning",
  );
  if (canonical?.classification?.heldAction) {
    push(
      "held-action",
      "Held action",
      canonical.classification.heldAction,
      "warning",
    );
  }

  const identity = canonical?.identityResolution ?? null;
  pushCanonicalOnly(
    "identity-basis",
    "Identity resolution",
    identity ? humanizeCode(identity.basis) : null,
    identity?.basis === "native_ad_exact" ? "positive" : "warning",
  );
  if (identity) {
    push(
      "identity-candidates",
      "Candidate ads",
      `${identity.candidateAdCount} · metrics ${
        identity.metricsEquivalent ? "equivalent" : "not equivalent"
      } · ad action ${identity.adActionEligible ? "eligible" : "ineligible"}`,
    );
  }

  const delivery = canonical?.deliveryScope ?? null;
  pushCanonicalOnly(
    "delivery-scope",
    "Delivery scope",
    delivery
      ? `${humanizeCode(delivery.state)} · campaign ${
          nonBlank(delivery.campaignStatus) ?? EM_DASH
        } · ad set ${nonBlank(delivery.adsetStatus) ?? EM_DASH} · ad ${
          nonBlank(delivery.adStatus) ?? EM_DASH
        }`
      : null,
    delivery?.state === "active" ? "positive" : "warning",
  );

  /*
   * Whether the creative's own media is readable at source — which is NOT the
   * question the preview answers.
   *
   * `media.thumbnail.state` gates the picture; `media.state` is computed from a
   * different pair of columns (`media_source_present` / `media_available`,
   * decisions-workspace-read-model.ts:950) and answers whether the creative
   * asset itself is there. They can disagree: a cached `thumbnail_url` beside
   * `media_available: false` renders a picture over a creative the source says
   * is missing, and the window would show the preview and say nothing. That
   * matters most on exactly the decisions this window is opened for — a Refresh
   * whose media cannot be located is a different task from a Refresh whose media
   * is fine — so the state is stated in words beside the evidence rather than
   * left to be inferred from whether an image appeared.
   */
  const media = canonical?.media ?? null;
  pushCanonicalOnly(
    "creative-media",
    "Creative media",
    media ? humanizeCode(media.state) : null,
    media?.state === "available" ? "positive" : "warning",
  );

  /*
   * Risk and ceremony are read off the CANONICAL envelope only, even though the
   * presentation decision carries fields of the same names. The ceremony is the
   * gate a write has to pass, so it must come from the record a write is
   * authorized against — the served copy is a projection made for display, and
   * treating it as the gate is how a display value quietly becomes a
   * permission. The served pair is stated below under its own labels instead.
   */
  pushCanonicalOnly(
    "risk-tier",
    "Risk tier",
    canonical?.riskTier
      ? canonical.riskTier
      : canonical?.riskTierProvenance?.reason
        ? `${EM_DASH} · ${humanizeCode(canonical.riskTierProvenance.reason)}`
        : null,
    "neutral",
  );
  pushCanonicalOnly(
    "confirmation-ceremony",
    "Confirmation ceremony",
    canonical?.confirmationCeremony
      ? humanizeCode(canonical.confirmationCeremony)
      : null,
    "neutral",
  );

  const responses = canonical?.history?.responses ?? null;
  const responseCapability = input.capabilities?.responseAttribution ?? null;
  pushCanonicalOnly(
    "operator-responses",
    "Operator responses",
    responses
      ? responses.status === "available"
        ? `${responses.items?.length ?? 0} recorded`
        : `unavailable · ${humanizeCode(responses.reason) || EM_DASH}`
      : responseCapability
        ? `unavailable · ${humanizeCode(responseCapability.reason)}`
        : null,
    responses?.status === "available" ? "neutral" : "warning",
  );

  const writes = canonical?.history?.providerWrites ?? null;
  const writeCapability = input.capabilities?.providerWriteLinkage ?? null;
  pushCanonicalOnly(
    "provider-write-outcome",
    "Provider write outcome",
    writes
      ? writes.status === "available"
        ? "linked"
        : `unavailable · ${humanizeCode(writes.reason) || EM_DASH}`
      : writeCapability
        ? `unavailable · ${humanizeCode(writeCapability.reason)}`
        : null,
    writes?.status === "available" ? "neutral" : "warning",
  );

  /*
   * The two journals behind "what happened last time".
   *
   * Both are served on every canonical decision as `{status, reason, items}`
   * and both were dropped, so a drawer that showed no history was
   * indistinguishable from a decision with no history. An unavailable journal
   * states its served reason; an available one states the count the server
   * actually returned, and a MEASURED zero stays 0 rather than becoming a dash.
   */
  const events = canonical?.history?.events ?? null;
  pushCanonicalOnly(
    "decision-events",
    "Decision events",
    events
      ? events.status === "available"
        ? `${events.items?.length ?? 0} recorded${
            typeof events.preCapCount === "number"
              ? ` of ${events.preCapCount} served`
              : ""
          }`
        : `unavailable · ${humanizeCode(events.reason) || EM_DASH}`
      : null,
    events?.status === "available" ? "neutral" : "warning",
  );

  const outcomes = canonical?.history?.outcomes ?? null;
  pushCanonicalOnly(
    "decision-outcomes",
    "Recorded outcomes",
    outcomes
      ? outcomes.status === "available"
        ? `${outcomes.items?.length ?? 0} recorded`
        : `unavailable · ${humanizeCode(outcomes.reason) || EM_DASH}`
      : null,
    outcomes?.status === "available" ? "neutral" : "warning",
  );

  /*
   * The footer's primary control, explained where the eligibility evidence is.
   *
   * The action is the server's own tuple, printed verbatim — `code`, `intent`
   * and the scope note the server wrote — so the row says what the button is
   * BEFORE it says whether it may be pressed. The route line then states the
   * server's law: offered, or refused under the server's own refusal name.
   * Neither line is derived from the other, and neither invents an action the
   * payload did not carry.
   */
  const servedAction = input.servedAction;
  push(
    "served-action",
    "Served action",
    servedAction
      ? `${servedAction.code} · intent ${servedAction.intent} · ${servedAction.targetLevel}${
          servedAction.providerMutation
            ? ` · provider ${servedAction.providerMutation}`
            : " · no provider mutation"
        }`
      : EM_DASH,
    servedAction?.providerMutation ? "warning" : "neutral",
  );
  const route = input.launchpadRoute;
  push(
    "launchpad-route",
    "Launchpad route",
    route
      ? route.offered
        ? "offered"
        : `refused · ${nonBlank(route.refusalReason) ?? EM_DASH}`
      : EM_DASH,
    route ? (route.offered ? "neutral" : "warning") : "neutral",
  );
  const primaryAuthority = input.primaryActionAuthority;
  push(
    "primary-action-authority",
    "Primary action authority",
    primaryAuthority
      ? `${humanizeCode(primaryAuthority.kind)} · ${
          primaryAuthority.offered
            ? "offered"
            : `refused · ${nonBlank(primaryAuthority.refusalReason) ?? EM_DASH}`
        }`
      : EM_DASH,
    primaryAuthority
      ? primaryAuthority.offered
        ? "neutral"
        : "warning"
      : "neutral",
  );

  return rows;
}

/** `native_ad_exact` -> `Native ad exact`. Server codes stay recognisable. */
function humanizeCode(value: string | null | undefined): string {
  const normalized = nonBlank(value);
  if (!normalized) return "";
  const spaced = normalized.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function diagnosticRows(input: {
  canonical: MetaCanonicalDecision | null;
  decision: MetaOsAdDecision | null;
  source: MetaDecisionsWorkspaceReadModel["source"] | null;
}): CreativeEvidenceWindowExactAuditRow[] {
  const canonical = input.canonical;
  const authority = canonical?.sourceAuthority ?? null;
  const source = input.source ?? null;
  const absent = canonicalAbsence(input.decision ?? null, canonical);
  const canonicalBlockerCodes = (canonical?.classification?.blockers ?? [])
    .map((blocker) => nonBlank(blocker.code))
    .filter((code): code is string => code !== null);
  // The served decision carries its own blocker list. It is the SAME kind of
  // receipt, so it fills this slot when no envelope was served rather than
  // leaving a real, printed blocker with no machine-readable half.
  const blockerCodes =
    canonicalBlockerCodes.length > 0
      ? canonicalBlockerCodes
      : (input.decision?.blockers ?? [])
          .map((blocker) => nonBlank(blocker.code))
          .filter((code): code is string => code !== null);
  // Advisories are served only on the canonical envelope; there is no served
  // fallback to borrow, so an ad with no envelope prints an em dash here rather
  // than a fabricated empty list.
  const advisoryCodes = (canonical?.classification?.advisories ?? [])
    .map((advisory) => nonBlank(advisory.code))
    .filter((code): code is string => code !== null);
  const entries: Array<[string, string, string | null]> = [
    [
      "decision-id",
      "decision id",
      canonical?.decisionId ?? input.decision?.decisionId ?? null,
    ],
    [
      "episode-id",
      "episode id",
      canonical?.episodeId ?? input.decision?.episodeId ?? null,
    ],
    ["episode-started", "episode started", canonical?.episodeStartedAt ?? null],
    [
      "snapshot-id",
      "snapshot id",
      canonical?.sourceSnapshotId ??
        authority?.snapshotId ??
        input.decision?.sourceSnapshotId ??
        null,
    ],
    ["evaluation-id", "evaluation id", authority?.evaluationId ?? null],
    ["input-hash", "input hash", authority?.inputHash ?? null],
    ["decision-hash", "decision hash", authority?.decisionHash ?? null],
    ["job-run-id", "job run id", authority?.jobRunId ?? null],
    [
      "provider-account",
      "provider account",
      canonical?.providerAccountId ?? input.decision?.providerAccountId ?? null,
    ],
    // The served parent chain. Its canonical twin rides `parentChain`; without
    // an envelope these ids are the only way to say WHICH ad this window is
    // about, and they were printed nowhere.
    [
      "served-row-id",
      "served row id",
      input.decision?.id ?? null,
    ],
    [
      "served-ad",
      "served ad",
      input.decision
        ? [input.decision.adId, nonBlank(input.decision.adName)]
            .filter((part): part is string => Boolean(part))
            .join(" · ")
        : null,
    ],
    [
      "served-adset",
      "served ad set",
      input.decision
        ? [input.decision.adsetId, nonBlank(input.decision.adsetName)]
            .filter((part): part is string => Boolean(part))
            .join(" · ") || null
        : null,
    ],
    [
      "served-campaign",
      "served campaign",
      input.decision
        ? [input.decision.campaignId, nonBlank(input.decision.campaignName)]
            .filter((part): part is string => Boolean(part))
            .join(" · ") || null
        : null,
    ],
    [
      "served-creative",
      "served creative",
      input.decision
        ? [input.decision.creativeId, nonBlank(input.decision.creativeName)]
            .filter((part): part is string => Boolean(part))
            .join(" · ") || null
        : null,
    ],
    [
      "served-raw-label",
      "served raw label",
      input.decision ? nonBlank(input.decision.rawLabel) : null,
    ],
    [
      "served-grain",
      "served grain",
      input.decision
        ? `${input.decision.sourceGrain} · metrics ${
            nonBlank(input.decision.metrics.grain) ?? EM_DASH
          } · ${nonBlank(input.decision.metrics.attribution) ?? EM_DASH}`
        : null,
    ],
    ["provider-account-ref", "provider account ref", authority?.providerAccountRefId ?? null],
    ["real-ad-id", "real ad id", authority?.realAdId ?? null],
    ["identity-grain", "identity grain", canonical?.identityGrain ?? null],
    [
      "engine-version",
      "engine version",
      authority?.engineVersion ??
        canonical?.sourceDecision?.engineVersion ??
        input.decision?.engineVersion ??
        null,
    ],
    [
      "truth-source",
      "truth source",
      canonical?.sourceDecision?.truthSource ?? null,
    ],
    [
      "pre-authority-label",
      "pre-authority label",
      canonical?.sourceDecision?.preAuthorityLabel ?? null,
    ],
    /*
     * The authority gate's machine-readable name, from whichever envelope
     * carried it.
     *
     * The served decision's `authorityProvenance.firstBlocker.code` is not a
     * second opinion: `authorityProvenanceForDecision` copies it verbatim off
     * `sourceDecision.authorityBlocker` (decisions-os-presentation.ts:70-85),
     * so the two are the same token. It matters because they do not arrive
     * together — the presentation decision is served for every row, while the
     * canonical envelope is served only for rows the section and candidate caps
     * kept. Reading the canonical field alone left an envelope-less row printing
     * "no envelope was served" for a gate the payload had named in full, which
     * is exactly the substitution the served blocker-code fallback above
     * already refuses.
     *
     * Because this fallback exists, the canonical snapshot is NOT this
     * receipt's only issuer, and the absence sentence this row prints is chosen
     * per row rather than by id — see `conditionalAbsence` below.
     */
    [
      "authority-blocker",
      "authority blocker",
      canonical?.sourceDecision?.authorityBlocker ??
        input.decision?.authorityProvenance?.firstBlocker?.code ??
        null,
    ],
    [
      "classification-provenance",
      "classification source",
      canonical?.classification?.provenance
        ? `${canonical.classification.provenance.source}.${canonical.classification.provenance.field}`
        : null,
    ],
    [
      "promotion-basis",
      "promotion basis",
      canonical?.promotionBasis
        ? `${canonical.promotionBasis.status} · ${canonical.promotionBasis.reason}`
        : null,
    ],
    // The blocker LABELS already ride the verdict sub-line, where an operator
    // reads them. The CODES are the machine-readable half of the same served
    // objects and belong with the receipts, not beside the verdict.
    [
      "blocker-codes",
      "blocker codes",
      blockerCodes.length > 0 ? blockerCodes.join(" · ") : null,
    ],
    // The machine-readable half of the advisories, under the same law as the
    // blocker codes above and deliberately in its own row: an advisory code
    // filed under "blocker codes" is how `risk_tier_unclassified` read as a
    // gate for as long as it was one.
    [
      "advisory-codes",
      "advisory codes",
      advisoryCodes.length > 0 ? advisoryCodes.join(" · ") : null,
    ],
    /*
     * The resolution's machine-readable half, under the same law.
     *
     * `resolution.label`, `owner` and `category` are read by the audit block's
     * "Served resolution" line and `resolution.nextStep` rides the verdict
     * sub-line, so the operator-facing halves of this object are already said.
     * `code` is what an operator quotes back when the resolution is wrong, and
     * it is a receipt, not a decision — so it sits here rather than beside the
     * verdict.
     */
    [
      "served-resolution-code",
      "served resolution code",
      input.decision?.resolution ? nonBlank(input.decision.resolution.code) : null,
    ],
    /*
     * Generation lineage: which table the queue was read from, which job wrote
     * it, and which manifest it was validated against. `expectedAdCount` is the
     * manifest's own count, and it is a MEASURED number — a served 0 prints 0.
     */
    ["source-table", "source table", source?.table ?? null],
    ["source-computed-at", "source computed at", source?.computedAt ?? null],
    ["source-snapshot-as-of", "source snapshot as of", source?.snapshotAsOf ?? null],
    [
      "generation-job-run-id",
      "generation job run id",
      source?.generation?.jobRunId ?? null,
    ],
    [
      "generation-provider-account-ref",
      "generation provider account ref",
      source?.generation?.providerAccountRefId ?? null,
    ],
    [
      "generation-manifest-hash",
      "generation manifest hash",
      source?.generation?.manifestHash ?? null,
    ],
    [
      "generation-expected-ad-count",
      "generation expected ad count",
      typeof source?.generation?.expectedAdCount === "number"
        ? String(source.generation.expectedAdCount)
        : null,
    ],
  ];
  /*
   * Receipts whose ISSUER is decided per row, not by the id alone.
   *
   * LAW: a MEASURED absence must never render as "we could not tell". The
   * inverse of the null-vs-zero rule is a rule.
   *
   * `authority-blocker` used to sit in CANONICAL_ONLY_DIAGNOSTICS, and that
   * membership stopped being true the moment the entry above gained its served
   * fallback — the served `authorityProvenance` is a second issuer of the same
   * token. Left in the set, a decision that SERVES `authorityProvenance` with
   * `firstBlocker: null` — the server positively stating that no authority gate
   * was tripped — printed "unavailable · no canonical decision envelope was
   * served for this row". An answer rendered as a missing source.
   *
   * So the id alone cannot decide, and this map answers per row:
   *
   *   canonical envelope served              the canonical field answers; empty
   *                                          means empty, so the em dash stands
   *   provenance served, availability
   *     "available", firstBlocker null       MEASURED: no gate was tripped, so
   *                                          the em dash an empty-in-a-served-
   *                                          envelope field prints is the honest
   *                                          render — there is no code to quote
   *   provenance served, availability
   *     "historical_unavailable"             NOT an answer: that value is set
   *                                          when `preAuthorityLabel` is null,
   *                                          i.e. the row predates the gate
   *                                          ledger, so its null blocker is
   *                                          unrecorded rather than untripped
   *   no provenance, no envelope             nothing carried the question at all
   *
   * Only the last two are unknowns, and only they keep the absence sentence.
   */
  const authorityProvenance = input.decision?.authorityProvenance ?? null;
  const authorityGateAnswered =
    Boolean(canonical) || authorityProvenance?.availability === "available";
  const conditionalAbsence: ReadonlyMap<string, string | null> = new Map<
    string,
    string | null
  >([["authority-blocker", authorityGateAnswered ? null : absent]]);
  return entries.map(([id, label, value]) => ({
    id,
    label,
    // Same three-state rule the authority block keeps: a receipt only the
    // snapshot can issue says it has no issuer when no snapshot was served,
    // rather than printing the em-dash an issued-but-empty receipt prints.
    value:
      nonBlank(value) ??
      (conditionalAbsence.has(id)
        ? (conditionalAbsence.get(id) ?? EM_DASH)
        : absent && CANONICAL_ONLY_DIAGNOSTICS.has(id)
          ? absent
          : EM_DASH),
  }));
}

/**
 * The receipts the canonical decision snapshot is the ONLY possible issuer of.
 *
 * Everything outside this set has a served source — the presentation decision
 * or the queue's own generation envelope — so its em-dash means "the source
 * that could answer this served nothing", which is a different and already
 * honest statement.
 *
 * Membership is a claim about ISSUERS, and it has to stay literally true. A
 * field that gains a served fallback leaves this set the same day: it now has
 * a second possible issuer, and printing "no envelope was served" over an
 * answer that issuer gave states an unknown where a measurement exists.
 * `authority-blocker` left for exactly that reason and its per-row absence is
 * decided by `conditionalAbsence` in `diagnosticRows`.
 */
const CANONICAL_ONLY_DIAGNOSTICS: ReadonlySet<string> = new Set([
  // Advisories are written onto the canonical envelope and nowhere else. The
  // served decision carries blockers but no advisory list, so there is no
  // second issuer to fall back to, and a row with no envelope must say the
  // issuer is missing rather than print the em dash an empty-but-issued
  // receipt prints.
  "advisory-codes",
  "episode-started",
  "evaluation-id",
  "input-hash",
  "decision-hash",
  "job-run-id",
  "provider-account-ref",
  "real-ad-id",
  "identity-grain",
  "truth-source",
  "pre-authority-label",
  "classification-provenance",
  "promotion-basis",
]);

/**
 * The one sentence that makes every dash below interpretable.
 *
 * Null when both helper reads resolved: a resolved read needs no caption, and a
 * permanent "loaded" banner would train the eye to ignore the strip.
 */
function readNotice(input: {
  adRowsState: CreativeEvidenceWindowExactReadState | undefined;
  adSeriesState: CreativeEvidenceWindowExactReadState | undefined;
  adRowsErrorMessage: string | null | undefined;
  adSeriesErrorMessage: string | null | undefined;
}): CreativeEvidenceWindowExactReadNotice | null {
  const failed: string[] = [];
  if (input.adRowsState === "error") {
    failed.push(
      `ad rows (${nonBlank(input.adRowsErrorMessage) ?? "no message served"})`,
    );
  }
  if (input.adSeriesState === "error") {
    failed.push(
      `daily trail (${nonBlank(input.adSeriesErrorMessage) ?? "no message served"})`,
    );
  }
  if (failed.length > 0) {
    return {
      tone: "negative",
      text: `Ad-grain evidence could not be read: ${failed.join("; ")}. Cells marked "${UNREADABLE_TOKEN}" are unread, not empty.`,
    };
  }
  if (input.adRowsState === "loading" || input.adSeriesState === "loading") {
    return {
      tone: "info",
      text: `Ad-grain evidence is still loading. Cells marked "${PENDING_TOKEN}" have not been read yet.`,
    };
  }
  // A read that never ran is not a read that found nothing. Named separately
  // from the failure above, because "could not be read" and "was not read"
  // send an operator to different places.
  const unread: string[] = [];
  if (input.adRowsState === "unread") unread.push("ad rows");
  if (input.adSeriesState === "unread") unread.push("daily trail");
  if (unread.length > 0) {
    return {
      tone: "negative",
      text: `Ad-grain evidence was not read (${unread.join("; ")}) — the request is paused or was never issued. Cells marked "${UNREADABLE_TOKEN}" are unread, not empty.`,
    };
  }
  return null;
}

/** What the presentation decision is the source of, named for the reader. */
const SERVED_EVIDENCE_FAMILIES = [
  "engine reasoning",
  "assessment",
  "blockers",
  "resolution",
  "lane",
  "decision availability",
  "priority",
  "confidence",
  "ad metrics",
  "served action tuple",
] as const;

/** What only the canonical decision snapshot is the source of. */
const CANONICAL_EVIDENCE_FAMILIES = [
  "decision hashes",
  "provider lineage",
  "identity resolution",
  "action eligibility",
  "authorized action",
  "operator responses",
  "provider-write outcome",
  "risk tier",
  "confirmation ceremony",
  "confidence band",
] as const;

/**
 * The window's own account of what it is holding.
 *
 * Written from the presence of the two envelopes and nothing else: it makes no
 * claim about the row that the row did not already make about itself. The
 * `served-only` case is the one this exists for — the row opened, the engine's
 * evidence is real and complete, and every audit answer below it is missing for
 * ONE reason, which is stated once here instead of sixteen times as a dash.
 */
function buildCoverage(input: {
  decision: MetaOsAdDecision | null;
  canonical: MetaCanonicalDecision | null;
}): CreativeEvidenceWindowExactCoverage | null {
  const { decision, canonical } = input;
  if (!decision && !canonical) return null;
  if (decision && canonical) {
    return {
      state: "served-and-canonical",
      tone: "info",
      headline:
        "Both halves of this row's evidence are here: the served engine decision and its canonical decision envelope.",
      servedLabel: "From the served decision",
      served: SERVED_EVIDENCE_FAMILIES,
      unavailableLabel: "From the canonical envelope",
      unavailable: CANONICAL_EVIDENCE_FAMILIES,
      note: "",
    };
  }
  if (decision) {
    return {
      state: "served-only",
      tone: "warning",
      headline:
        "Served evidence only. This row was served without a canonical decision envelope, so this window is read-only.",
      servedLabel: "Served for this row",
      served: SERVED_EVIDENCE_FAMILIES,
      unavailableLabel: "Canonical-only, unavailable",
      unavailable: CANONICAL_EVIDENCE_FAMILIES,
      note:
        "No canonical envelope means no action authority: eligibility, lineage and provider-write authority " +
        "have no source here and are NOT inferred from the served decision. No write control is offered on this row.",
    };
  }
  return {
    state: "canonical-only",
    tone: "warning",
    headline:
      "Canonical envelope only. The queue served no presentation decision for this row, so the engine's own reading is absent.",
    servedLabel: "From the canonical envelope",
    served: CANONICAL_EVIDENCE_FAMILIES,
    unavailableLabel: "Presentation-only, unavailable",
    unavailable: SERVED_EVIDENCE_FAMILIES,
    note:
      "Lane, availability, priority and the served action tuple come from the presentation decision, " +
      "which this row does not have; the footer therefore offers no action.",
  };
}

export function buildMetaAdsManagerHref(input: {
  providerAccountId: string | null | undefined;
  adId: string | null | undefined;
}): string | null {
  const accountId = input.providerAccountId?.replace(/^act_/, "").trim() || null;
  const adId = input.adId?.trim() || null;
  if (!accountId || !adId) return null;
  const params = new URLSearchParams({ act: accountId, selected_ad_ids: adId });
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?${params.toString()}`;
}

export function buildCreativeEvidenceWindowExactViewModel(
  input: CreativeEvidenceWindowExactAdapterInput,
): CreativeEvidenceWindowExactViewModel {
  const decision = input.decision ?? null;
  const canonical = input.canonical ?? null;
  const currency =
    currencyCode(decision?.metrics.currency) ??
    currencyCode(canonical?.metrics.currency) ??
    currencyCode(input.fallbackCurrency);
  const target = finite(
    decision?.metrics.effectiveTargetRoas ?? canonical?.metrics.effectiveTargetRoas,
  );
  const tone = decisionTone(
    canonical?.classification.buyerLabel ?? decision?.publishedLabel,
  );
  const spend = finite(decision?.metrics.spend ?? canonical?.metrics.spend);
  const roas = finite(decision?.metrics.roas ?? canonical?.metrics.roas);
  const rowsUnresolved =
    input.adRows === undefined ? pendingToken(input.adRowsState) : null;
  const seriesUnresolved =
    input.adSeries == null ? pendingToken(input.adSeriesState) : null;
  const series = buildSeriesPair(input.adSeries, seriesUnresolved);
  const adSets = buildAdSets({
    rows: input.adRows,
    decision,
    canonical,
    currency,
    target,
    unresolved: rowsUnresolved,
  });
  const spendDisplay = formatEvidenceMoney(spend, currency);
  const roasDisplay = formatRoas(roas);
  const verdictLabel =
    nonBlank(canonical?.classification.buyerLabel) ?? nonBlank(decision?.publishedLabel);
  const reason =
    nonBlank(canonical?.sourceDecision.reason) ?? nonBlank(decision?.whyNow);
  /*
   * The Engine reasoning card, from every reasoning field the payload served.
   *
   * `assessment` is the engine's standing read of the ad and `whyNow` is why it
   * is on the screen today; they are different sentences and the card used to
   * print only one of them. On a row with no envelope the difference is the
   * whole content: `reason` falls back to `whyNow`, so without this the
   * assessment the engine actually computed never appeared anywhere. Deduped
   * rather than concatenated blindly, so an account whose two fields agree does
   * not read the same line twice.
   */
  const assessment = nonBlank(decision?.assessment);
  const reasons = [
    ...new Set(
      [reason, assessment && assessment !== reason ? assessment : null].filter(
        (line): line is string => Boolean(line),
      ),
    ),
  ];
  /*
   * The served action tuple, or nothing.
   *
   * This used to read `nonBlank(decision?.action.label) ?? verdictLabel`, so a
   * payload that served no action still produced a captioned primary control
   * reading "Cut" or "Cut · Held" — a CLASSIFICATION rendered as an ACTION. The
   * label an operator reads off a button is a claim about what the server will
   * do, and the decision label is not that claim. With no served action there
   * is no action: the label is a dash and the control is inert.
   */
  const servedAction = decision?.action ?? null;
  const actionLabel = servedAction ? nonBlank(servedAction.label) : null;
  /*
   * FAIL-CLOSED, at this layer as well as at the caller's.
   *
   * The caller already withholds the callback when the server's own handoff law
   * refuses the route, and a row with no canonical envelope is always refused
   * because the law needs the envelope to read. This second gate makes the
   * refusal structural rather than conventional: a stated `offered: false` wins
   * over a callback that reached here anyway, so no future caller can wire a
   * live control onto a row the server has already refused. Route omitted
   * entirely is unchanged behaviour — the caller made no claim either way.
   */
  const primaryAuthority = input.primaryActionAuthority;
  const primaryOffered =
    primaryAuthority?.offered ?? input.launchpadRoute?.offered ?? null;
  const onPrimary =
    primaryOffered === false ? undefined : input.callbacks?.onPrimary;

  return {
    name:
      nonBlank(canonical?.parentChain.ad?.name) ??
      nonBlank(decision?.adName) ??
      nonBlank(canonical?.parentChain.ad?.id) ??
      EM_DASH,
    decisionLabel: verdictLabel ?? EM_DASH,
    decisionTone: tone,
    previewUrl:
      (canonical?.media.thumbnail.state === "available"
        ? nonBlank(canonical.media.thumbnail.url)
        : null) ?? nonBlank(decision?.thumbnailUrl),
    stripeA: null,
    stripeB: null,
    kind: buildKind({ canonical, decision, adSetCount: adSets.length }),
    band: bandLabel(canonical?.sourceDecision.confidenceBand),
    bandTone: bandTone(canonical?.sourceDecision.confidenceBand),
    verdict: verdictLabel ? `Server verdict: ${verdictLabel}.` : EM_DASH,
    verdictSub: buildVerdictSub({ decision, canonical }),
    money:
      spendDisplay === EM_DASH && roasDisplay === EM_DASH
        ? EM_DASH
        : `${spendDisplay} · ROAS ${roasDisplay}`,
    moneySub: target === null ? EM_DASH : `vs ${target.toFixed(2)} target`,
    reasons: reasons.length > 0 ? reasons : [EM_DASH],
    ctr: series.ctr,
    frequency: series.frequency,
    funnel: buildFunnel({
      rows: input.adRows,
      decision,
      canonical,
      unresolved: rowsUnresolved,
    }),
    placements: buildPlacements(),
    adSets,
    facts: buildFacts({
      rows: input.adRows,
      decision,
      canonical,
      unresolved: rowsUnresolved,
    }),
    readNotice: readNotice({
      adRowsState: input.adRowsState,
      adSeriesState: input.adSeriesState,
      adRowsErrorMessage: input.adRowsErrorMessage,
      adSeriesErrorMessage: input.adSeriesErrorMessage,
    }),
    coverage: buildCoverage({ decision, canonical }),
    authority: authorityRows({
      decision,
      canonical,
      capabilities: input.capabilities ?? null,
      source: input.source ?? null,
      launchpadRoute: input.launchpadRoute ?? null,
      primaryActionAuthority: input.primaryActionAuthority ?? null,
      servedAction,
    }),
    diagnostics: diagnosticRows({
      canonical,
      decision,
      source: input.source ?? null,
    }),
    provenance: buildProvenance({ canonical, decision }),
    primaryAction: {
      label: actionLabel ?? EM_DASH,
      href: input.hrefs?.primary ?? null,
      // The tuple travels by reference: no spread, no rebuilt object, no
      // normalised code. Whatever the server put on `decision.action` is what
      // the callback boundary receives.
      onClick:
        servedAction && onPrimary ? () => onPrimary(servedAction) : undefined,
      disabled: !actionLabel,
    },
    compareAction: {
      label: "Compare in Studio",
      href: input.hrefs?.compareInStudio ?? null,
    },
    adsManagerAction: {
      label: "Ads Manager ↗",
      href: input.hrefs?.adsManager ?? null,
      external: true,
    },
  };
}
