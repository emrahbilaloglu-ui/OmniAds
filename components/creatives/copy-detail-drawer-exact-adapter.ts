import type {
  CopyDetailDrawerExactAlternate,
  CopyDetailDrawerExactStat,
  CopyDetailDrawerExactTone,
  CopyDetailDrawerExactViewModel,
} from "@/components/creatives/CopyDetailDrawerExact";

const EM_DASH = "—";

export interface CopyDetailDrawerExactRow {
  id: string;
  /**
   * The provider creative this line was served with.
   *
   * Required for the Launchpad handoff: `POST /api/meta/launchpad-handoff/copy`
   * names a CREATIVE, a window and one alternate, and re-reads the served copy
   * for that creative before it will mint anything. The copies row id is a
   * synthetic bucket key (`copy_<account>:<currency>:<normalized key>`) and
   * names no provider object, so it cannot stand in for this.
   */
  creativeId: string | null;
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
  /**
   * There is still deliberately no `draftHref`, and there never will be.
   *
   * The drawer used to take one generic Launchpad URL and put it on the "Draft"
   * control of every alternate and on "Draft all", under a footnote claiming
   * "a Launchpad draft with this line's evidence attached". Nothing was
   * attached: the href carried only `businessId` and `providerAccountId`. No
   * copy id, no alternate text, no evidence window, no lineage travelled, and a
   * URL parameter could not have minted any of it anyway.
   *
   * What replaces it is a POST, not a link. `POST
   * /api/meta/launchpad-handoff/copy` names the creative, the window and the
   * alternate; the SERVER re-reads the served copy for that creative in that
   * window and refuses a line Meta never served, then persists an
   * account-scoped, single-use record carrying the copy identity, the alternate
   * text, the source line, the frozen evidence window and the creative/ad/
   * campaign selection. `app/c/[businessId]/meta/launchpad/page.tsx` re-verifies
   * and consumes it server-side.
   *
   * That record is explicitly NOT a decision: it is minted with
   * `origin: "copy"`, `sourceAuthorityStatus: "warehouse_discovery"`,
   * `authorizedAction: null` and `actionEligible: false`, because a copies row
   * is a warehouse aggregate and the canonical contract classes those as
   * discovery evidence only. No decision id is invented for it anywhere.
   *
   * WHAT IS STILL NOT TRUE, stated rather than implied by an enabled control:
   * `MetaLaunchPayload` and `MetaAddToExistingPayload` (lib/launchpad/meta.ts)
   * have no primary-text, headline or description field at any level, so
   * Launchpad has nothing to put the alternate INTO. The line travels in the
   * draft record and the wizard says so; it does not become ad copy.
   */
  draftHref?: never;
  /**
   * Whether the host can actually prepare a draft for these alternates.
   *
   * False (the default) keeps the control disabled and the footnote saying
   * drafting is unavailable. It is false whenever the business, the account or
   * the window is not established, because a handoff cannot be minted without
   * all three and offering the control would promise a refusal.
   */
  draftingAvailable?: boolean;
  /**
   * The last thing the draft POST actually said, verbatim.
   *
   * Refusals come back from the server with their own sentence
   * (`describeLaunchpadHandoffRefusal`); this restates it rather than
   * inventing one, and a null means nothing has been attempted.
   */
  draftStatusMessage?: string | null;
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
export function copyRoasTone(
  value: number | null | undefined,
): CopyDetailDrawerExactTone {
  const roas = finite(value);
  if (roas === null) return "neutral";
  if (roas >= 3.8) return "positive";
  if (roas < 2.5) return "negative";
  if (roas < 3) return "warning";
  return "neutral";
}

export function copyAngleTone(
  value: string | null | undefined,
): CopyDetailDrawerExactTone {
  const normalized = nonBlank(value)?.toLowerCase();
  if (!normalized) return "neutral";
  if (normalized.includes("ugc")) return "positive";
  if (normalized.includes("proof") || normalized.includes("social"))
    return "info";
  if (normalized.includes("problem") || normalized.includes("solution"))
    return "automation";
  if (normalized.includes("discount") || normalized.includes("urgency"))
    return "negative";
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

function buildStats(
  input: CopyDetailDrawerExactAdapterInput,
): CopyDetailDrawerExactStat[] {
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
      sub:
        engagementMedian === null
          ? EM_DASH
          : `median ${engagementMedian.toFixed(1)}%`,
      tone: "neutral",
    },
    {
      id: "roas",
      label: "ROAS",
      value: formatRatio(roas),
      sub:
        target === null ? `target ${EM_DASH}` : `target ${target.toFixed(2)}`,
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
      // Always null. Drafting is a POST the server has to answer, so the drawer
      // renders a BUTTON and the host mints the handoff; an href here could
      // only carry claims. See `draftHref` on the adapter input.
      draftHref: null,
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
  // Drafting needs a real creative to bind the line to. A row whose creative is
  // unknown cannot be named to the handoff endpoint, so it is not offered.
  const draftable =
    input.draftingAvailable === true && Boolean(nonBlank(row.creativeId));
  const draftStatus = nonBlank(input.draftStatusMessage ?? null);

  return {
    kind: assetType
      ? `${assetType} · ${chars} chars`
      : `${EM_DASH} · ${chars} chars`,
    text: text ?? EM_DASH,
    angle: nonBlank(row.angle) ?? EM_DASH,
    angleTone: copyAngleTone(row.angle),
    stats: buildStats(input),
    alternatesNote: "Used with this creative",
    alternates,
    footnote: draftable
      ? [
          "These are other lines used with this creative.",
          "Draft opens Launchpad with the selected line for reference; it does not publish or change ad copy.",
          draftStatus
            ? "The Launchpad draft could not be prepared. Try again."
            : null,
        ]
          .filter(Boolean)
          .join(" ")
      : "These are other lines used with this creative.",
  };
}
