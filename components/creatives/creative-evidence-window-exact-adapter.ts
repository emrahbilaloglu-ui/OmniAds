import type {
  CreativeEvidenceWindowExactAdSet,
  CreativeEvidenceWindowExactFact,
  CreativeEvidenceWindowExactFunnelStep,
  CreativeEvidenceWindowExactPlacement,
  CreativeEvidenceWindowExactTone,
  CreativeEvidenceWindowExactViewModel,
} from "@/components/creatives/CreativeEvidenceWindowExact";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { MetaOsAdDecision } from "@/lib/meta/decisions-os-contract";

const EM_DASH = "—";

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

export interface CreativeEvidenceWindowExactAdapterInput {
  /** Presentation decision — carries CTR, frequency, ad set identity, action. */
  decision?: MetaOsAdDecision | null;
  /** Canonical decision — carries media, confidence band, provenance, blockers. */
  canonical?: MetaCanonicalDecision | null;
  /** Ad-grain rows for this creative. Undefined means the read has not resolved. */
  adRows?: readonly CreativeEvidenceWindowExactAdRow[];
  fallbackCurrency?: string | null;
  hrefs?: {
    compareInStudio?: string | null;
    adsManager?: string | null;
    primary?: string | null;
  };
  callbacks?: {
    onPrimary?: () => void;
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
 * The design's funnel bars are a visual scale, not a literal share: 1.42M
 * impressions and 318 purchases are drawn at 100% and 15%. The printed value
 * beside each bar stays literal; only the bar length is compressed.
 */
function funnelShare(value: number | null, top: number | null): number | null {
  if (value === null || top === null || top <= 0 || value <= 0) return null;
  return Math.log10(value + 1) / Math.log10(top + 1);
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
    if (!label) return [];
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
  return FUNNEL_SLOTS.map((slot, index) => ({
    id: slot.id,
    label: slot.label,
    value: formatCount(values[index]),
    sub:
      index === 0
        ? ""
        : subs[index] === EM_DASH
          ? EM_DASH
          : `${prefixes[index]}${subs[index]}`,
    share: funnelShare(values[index], impressions),
  }));
}

function buildPlacements(): CreativeEvidenceWindowExactPlacement[] {
  // `meta_breakdown_daily` carries no campaign/ad set key and no purchase
  // value, so no served source can produce per-creative placement share and
  // ROAS. The card keeps its geometry and states the absence.
  return [1, 2, 3].map((slot) => ({
    id: `placement-${slot}`,
    label: EM_DASH,
    share: EM_DASH,
    roas: EM_DASH,
    width: null,
  }));
}

function buildFacts(input: {
  rows: readonly CreativeEvidenceWindowExactAdRow[] | undefined;
  decision: MetaOsAdDecision | null;
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
    // Meta's reach breakdown is not persisted per ad in this warehouse.
    "first-time-reach": { label: "First-time reach", value: EM_DASH },
    thumbstop: { label: "Thumbstop", value: formatPercent(thumbstop, 1) },
    // ThruPlay is the nearest served fact and is not a 15s hold, so this stays
    // unserved rather than substituting a different metric under this label.
    "hold-15s": { label: "Hold 15s", value: EM_DASH },
    // The design's fifth row is decision-specific (fatigue-confirmed days /
    // better variants live / days above target). None is persisted.
    "decision-specific": { label: EM_DASH, value: EM_DASH },
    "first-seen": { label: "First seen", value: firstSeen ?? EM_DASH },
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
  const blockers = input.canonical?.classification.blockers ?? [];
  for (const blocker of blockers) {
    const label = nonBlank(blocker.label);
    if (label) parts.push(label.endsWith(".") ? label : `${label}.`);
  }
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
  const adSets = buildAdSets({
    rows: input.adRows,
    decision,
    canonical,
    currency,
    target,
  });
  const spendDisplay = formatEvidenceMoney(spend, currency);
  const roasDisplay = formatRoas(roas);
  const verdictLabel =
    nonBlank(canonical?.classification.buyerLabel) ?? nonBlank(decision?.publishedLabel);
  const reason =
    nonBlank(canonical?.sourceDecision.reason) ?? nonBlank(decision?.whyNow);
  const actionLabel = nonBlank(decision?.action.label) ?? verdictLabel;

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
    reasons: [reason ?? EM_DASH],
    // No route serves a per-ad daily CTR series.
    ctr: { path: null, note: EM_DASH },
    // No route serves a per-ad daily frequency series.
    frequency: { path: null, note: EM_DASH },
    funnel: buildFunnel({ rows: input.adRows, decision, canonical }),
    placements: buildPlacements(),
    adSets,
    facts: buildFacts({ rows: input.adRows, decision }),
    provenance: buildProvenance({ canonical, decision }),
    primaryAction: {
      label: actionLabel ?? EM_DASH,
      href: input.hrefs?.primary ?? null,
      onClick: input.callbacks?.onPrimary,
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
