import type {
  CopyDetailDrawerExactAlternate,
  CopyDetailDrawerExactStat,
  CopyDetailDrawerExactTone,
  CopyDetailDrawerExactViewModel,
} from "@/components/creatives/CopyDetailDrawerExact";

const EM_DASH = "—";

export interface CopyDetailDrawerExactRow {
  id: string;
  text: string | null;
  assetType: string | null;
  /** Server-supplied messaging angle. Null until the engine's tagging ships. */
  angle: string | null;
  /** Expansion rate of truncated primaries, as a percentage. */
  seeMore: number | null;
  /** Link CTR, as a percentage. */
  ctr: number | null;
  /** Reactions + comments + shares per impression, as a percentage. */
  engagement: number | null;
  roas: number | null;
  /** Other copy lines Meta served with the same creative. */
  variants: readonly string[];
}

export interface CopyDetailDrawerExactAdapterInput {
  row: CopyDetailDrawerExactRow;
  /** Every synced line in the same account and window; used for the medians. */
  peers?: readonly CopyDetailDrawerExactRow[];
  targetRoas?: number | null;
  draftHref?: string | null;
}

function nonBlank(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPercent(value: number | null, digits: number): string {
  return value === null ? EM_DASH : `${value.toFixed(digits)}%`;
}

function formatRatio(value: number | null): string {
  return value === null ? EM_DASH : value.toFixed(1);
}

function median(values: readonly (number | null)[]): number | null {
  const sorted = values
    .map((value) => finite(value))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Mirrors the ROAS band the copies table itself paints, so the drawer agrees
 * with the row the operator just clicked. */
export function copyRoasTone(value: number | null | undefined): CopyDetailDrawerExactTone {
  const roas = finite(value);
  if (roas === null) return "neutral";
  if (roas >= 3.8) return "positive";
  if (roas < 2.5) return "negative";
  if (roas < 3) return "warning";
  return "neutral";
}

export function copyAngleTone(value: string | null | undefined): CopyDetailDrawerExactTone {
  const normalized = nonBlank(value)?.toLowerCase();
  if (!normalized) return "neutral";
  if (normalized.includes("ugc")) return "positive";
  if (normalized.includes("proof") || normalized.includes("social")) return "info";
  if (normalized.includes("problem") || normalized.includes("solution")) return "automation";
  if (normalized.includes("discount") || normalized.includes("urgency")) return "negative";
  return "neutral";
}

function assetTypeLabel(value: string | null | undefined): string | null {
  const normalized = nonBlank(value);
  if (!normalized) return null;
  return normalized
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isHeadlineAsset(value: string | null | undefined): boolean {
  const normalized = nonBlank(value)?.toLowerCase() ?? "";
  return normalized === "headline" || normalized === "description";
}

function buildStats(input: CopyDetailDrawerExactAdapterInput): CopyDetailDrawerExactStat[] {
  const { row } = input;
  const peers = input.peers ?? [];
  const seeMoreMedian = median(peers.map((peer) => peer.seeMore));
  const ctrMedian = median(peers.map((peer) => peer.ctr));
  const engagementMedian = median(peers.map((peer) => peer.engagement));
  const target = finite(input.targetRoas);
  const roas = finite(row.roas);

  return [
    {
      id: "see-more",
      label: "See more",
      value: formatPercent(finite(row.seeMore), 1),
      sub: isHeadlineAsset(row.assetType)
        ? "headlines don’t truncate"
        : seeMoreMedian === null
          ? EM_DASH
          : `acct median ${seeMoreMedian.toFixed(1)}%`,
      tone: "neutral",
    },
    {
      id: "ctr",
      label: "CTR",
      value: formatPercent(finite(row.ctr), 2),
      sub: ctrMedian === null ? EM_DASH : `median ${ctrMedian.toFixed(2)}%`,
      tone: "neutral",
    },
    {
      id: "engage",
      label: "Engage",
      value: formatPercent(finite(row.engagement), 1),
      sub: engagementMedian === null ? EM_DASH : `median ${engagementMedian.toFixed(1)}%`,
      tone: "neutral",
    },
    {
      id: "roas",
      label: "ROAS",
      value: formatRatio(roas),
      sub: target === null ? `target ${EM_DASH}` : `target ${target.toFixed(2)}`,
      tone: copyRoasTone(roas),
    },
  ];
}

function buildAlternates(
  input: CopyDetailDrawerExactAdapterInput,
): CopyDetailDrawerExactAlternate[] {
  const own = nonBlank(input.row.text);
  const seen = new Set<string>();
  const alternates: CopyDetailDrawerExactAlternate[] = [];
  for (const variant of input.row.variants) {
    const normalized = nonBlank(variant);
    if (!normalized || normalized === own || seen.has(normalized)) continue;
    seen.add(normalized);
    alternates.push({
      id: `alt-${alternates.length + 1}`,
      // The engine does not tag an angle or a rationale per served variant.
      angle: EM_DASH,
      angleTone: "neutral",
      text: normalized,
      why: EM_DASH,
      draftHref: input.draftHref ?? null,
    });
  }
  return alternates;
}

export function buildCopyDetailDrawerExactViewModel(
  input: CopyDetailDrawerExactAdapterInput,
): CopyDetailDrawerExactViewModel {
  const { row } = input;
  const text = nonBlank(row.text);
  const chars = text?.length ?? 0;
  const assetType = assetTypeLabel(row.assetType);
  const alternates = buildAlternates(input);

  return {
    kind: assetType ? `${assetType} · ${chars} chars` : `${EM_DASH} · ${chars} chars`,
    text: text ?? EM_DASH,
    angle: nonBlank(row.angle) ?? EM_DASH,
    angleTone: copyAngleTone(row.angle),
    edgeTone: copyRoasTone(row.roas),
    // No engine surface produces a per-line read today.
    read: EM_DASH,
    stats: buildStats(input),
    // The design's seed note claims angle-shifted rewrites ranked by angle
    // ROAS. These are the other lines Meta served with the same creative.
    alternatesNote: "served with this creative · Meta-reported",
    alternates,
    footnote:
      "Alternates are the other lines Meta served with this creative. Drafting one opens a Launchpad draft with this line’s evidence attached. Nothing publishes from here.",
    draftAllLabel:
      alternates.length > 0
        ? `Draft all ${alternates.length} in Launchpad`
        : "Draft all in Launchpad",
    draftAllHref: alternates.length > 0 ? (input.draftHref ?? null) : null,
  };
}
