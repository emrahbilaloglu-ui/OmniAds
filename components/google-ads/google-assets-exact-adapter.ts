import type {
  AssetGroupRow,
  AssetRow,
  AudienceRow,
} from "@/components/google-ads/google-ads-dashboard-support";

import {
  googleSearchRoasTone,
  type GoogleSearchExactChipTone,
} from "@/components/google-ads/google-search-exact-adapter";

/**
 * Pure view model for the canonical `Google Ads · Assets & Audiences` screen
 * (reference markup lines 1525-1624, model lines 3852-3874).
 *
 * The screen is one pill row and exactly one of three surfaces. Every column
 * below reads a served field; a fact no Google read in this product supplies
 * keeps its cell and prints the em dash rather than being answered with a
 * different question.
 */

const DASH = "—";

export type GoogleAssetsExactTab = "groups" | "assets" | "audiences";

export interface GoogleAssetsExactIdentity {
  accountId?: string | null;
  currencyCode?: string | null;
  windowLabel?: string | null;
  syncLabel?: string | null;
}

export interface GoogleAssetsExactTabViewModel {
  key: GoogleAssetsExactTab;
  label: string;
  active: boolean;
}

export interface GoogleAssetsExactGroupRowViewModel {
  key: string;
  name: string;
  campaign: string;
  spend: string;
  value: string;
  roas: string;
  roasTone: GoogleSearchExactChipTone;
  strength: string;
  strengthTone: GoogleSearchExactChipTone;
}

export interface GoogleAssetsExactTextRowViewModel {
  key: string;
  text: string;
  kind: string;
  impressions: string;
  performance: string;
  performanceTone: GoogleSearchExactChipTone;
}

export interface GoogleAssetsExactImageViewModel {
  key: string;
  /** Served image URL, or null when the asset carries none. */
  imageUrl: string | null;
  /** 0-3 — the reference's own placeholder stripe pair. */
  swatch: 0 | 1 | 2 | 3;
  share: string;
  label: string;
}

export interface GoogleAssetsExactAudienceRowViewModel {
  key: string;
  name: string;
  type: string;
  size: string;
  conversions: string;
  cpa: string;
  roas: string;
  roasTone: GoogleSearchExactChipTone;
}

export interface GoogleAssetsExactViewModel {
  eyebrow: string;
  syncLabel: string;
  tab: GoogleAssetsExactTab;
  tabs: GoogleAssetsExactTabViewModel[];
  groupRows: GoogleAssetsExactGroupRowViewModel[];
  /** The advisor's queued restructures, or the em dash when it names none. */
  groupNote: string;
  textRows: GoogleAssetsExactTextRowViewModel[];
  imageRows: GoogleAssetsExactImageViewModel[];
  audienceRows: GoogleAssetsExactAudienceRowViewModel[];
}

export interface GoogleAssetsExactInput {
  identity?: GoogleAssetsExactIdentity;
  tab: GoogleAssetsExactTab;
  /** Null means the report has not been read, not that it is empty. */
  assetGroups: AssetGroupRow[] | null;
  assets: AssetRow[] | null;
  audiences: AudienceRow[] | null;
  roasTarget: number | null;
  roasBreakEven?: number | null;
  /**
   * Asset-group restructures the advisor already has queued, by name. The
   * reference closes the table on this sentence; with nothing queued the
   * sentence has no subject and the line prints the em dash.
   */
  queuedRestructures?: string[] | null;
}

/** The reference's tab set and captions, in its own order (model line 3852). */
export const GOOGLE_ASSETS_EXACT_TABS: ReadonlyArray<{
  key: GoogleAssetsExactTab;
  label: string;
}> = [
  { key: "groups", label: "Asset groups" },
  { key: "assets", label: "Text & image assets" },
  { key: "audiences", label: "Audiences" },
];

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clean(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : DASH;
}

function currency(
  value: number | null,
  currencyCode: string | null | undefined,
  digits: 0 | 2,
): string {
  const code = currencyCode?.trim();
  if (value === null || !code) return DASH;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return DASH;
  }
}

function count(value: number | null): string {
  return value === null
    ? DASH
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

/**
 * Google's own asset-group ad strength, in the reference's tone language.
 *
 * `asset_group.ad_strength` is a Google verdict, never a recomputation:
 * EXCELLENT is the design's green, GOOD its blue, the pending/learning states
 * its purple and POOR/NO_ADS its amber. Red is deliberately unused on this
 * chip, exactly as the reference model leaves it unused.
 */
export function googleAssetStrengthTone(
  strength: string,
): GoogleSearchExactChipTone {
  const value = strength.toLowerCase();
  if (value.includes("excellent") || value.includes("best")) return "positive";
  if (value.includes("good")) return "info";
  if (
    value.includes("learning") ||
    value.includes("pending") ||
    value.includes("average")
  ) {
    return "auto";
  }
  if (value.includes("poor") || value.includes("low") || value.includes("no ads")) {
    return "warning";
  }
  return "neutral";
}

/**
 * The reference's four text-asset performance chips (model lines 3859-3865):
 * Best is green, Good blue, Low amber, Learning purple.
 *
 * The card's caption says the rating is Google-served, so this reads Google's
 * own `asset_group_asset.performance_label` and nothing else. It deliberately
 * does NOT understand this product's derived vocabulary — `top`, `average`,
 * `underperforming`, from a local ROAS/CTR/interaction comparison — because a
 * derived verdict rendered here would make the caption a lie. An asset Google
 * has not labelled keeps its chip slot and prints the em dash.
 */
export function googleAssetPerformanceView(
  label: string | null | undefined,
): { label: string; tone: GoogleSearchExactChipTone } {
  const value = (label ?? "").toLowerCase().trim();
  if (value === "best") return { label: "Best", tone: "positive" };
  if (value === "good") return { label: "Good", tone: "info" };
  if (value === "low") return { label: "Low", tone: "warning" };
  if (value === "learning" || value === "pending") {
    return { label: "Learning", tone: "auto" };
  }
  return { label: DASH, tone: "unserved" };
}

/** An asset's own served text, never a substituted one. */
function assetLabel(row: AssetRow): string {
  const text = row.assetText?.trim();
  if (text) return text;
  const name = row.assetName?.trim();
  if (name) return name;
  const preview = row.preview?.trim();
  return preview ? preview : DASH;
}

/**
 * An audience's served identity. `ad_group_audience_view` returns the criterion
 * id and its type and no display name, so the id is the audience's own name
 * here rather than the ad group it sits in — which names a different thing.
 */
function audienceLabel(row: AudienceRow): string {
  const name = row.name?.trim();
  if (name && name !== "Unknown audience") return name;
  const criterionId = row.criterionId?.trim();
  return criterionId ? criterionId : DASH;
}

function eyebrowText(identity: GoogleAssetsExactIdentity) {
  return `Google Ads · ${clean(identity.accountId)} · ${clean(
    identity.currencyCode,
  )} · ${clean(identity.windowLabel)} window`;
}

/**
 * The reference writes this count as a word — "The advisor has one restructure
 * queued…" (markup line 1564) — so the sentence spells small counts the way the
 * design does and only falls back to a numeral past the words it would need.
 */
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

export function googleCountWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

/**
 * The advisor recommendations whose subject this sentence may name: queued
 * asset-group restructures only. A step the server says is already applied, or
 * one the operator dismissed (which the memory writes as `userAction:
 * "dismissed"` and `currentStatus: "suppressed"`), is no longer queued and
 * cannot be asserted as such.
 */
export function googleAssetGroupRestructureSubjects(
  recommendations:
    | ReadonlyArray<{
        type?: string | null;
        weakAssetGroups?: string[] | null;
        executionStatus?: string | null;
        userAction?: string | null;
        currentStatus?: string | null;
      }>
    | null
    | undefined,
): string[] {
  return (recommendations ?? [])
    .filter((item) => item.type === "asset_group_structure")
    .filter(
      (item) =>
        item.executionStatus !== "applied" &&
        item.userAction !== "dismissed" &&
        item.currentStatus !== "suppressed",
    )
    .flatMap((item) => item.weakAssetGroups ?? [])
    .filter(
      (name): name is string => typeof name === "string" && name.trim() !== "",
    );
}

/**
 * The reference's closing sentence under the asset-group table, built from the
 * advisor's own queued restructures. With none queued the sentence has no
 * subject, so the line keeps its geometry and prints the em dash.
 */
export function googleAssetGroupQueueNote(names: string[]): string {
  if (names.length === 0) return DASH;
  const quoted = names.map((name) => `“${name}”`);
  const subject =
    quoted.length === 1
      ? quoted[0]
      : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return `The advisor has ${googleCountWord(names.length)} restructure${
    names.length === 1 ? "" : "s"
  } queued for ${subject} — see Advisor · Do next.`;
}

export function buildGoogleAssetsExactViewModel(
  input: GoogleAssetsExactInput,
): GoogleAssetsExactViewModel {
  const identity = input.identity ?? {};
  const currencyCode = identity.currencyCode ?? null;
  const target = input.roasTarget;
  const breakEven = input.roasBreakEven ?? null;

  const assetGroups = input.assetGroups ?? [];
  const assets = input.assets ?? [];
  const audiences = input.audiences ?? [];

  const groupRows: GoogleAssetsExactGroupRowViewModel[] = assetGroups.map(
    (row, index) => {
      const roas = finite(row.roas);
      const strength = row.adStrength?.trim() || null;
      return {
        key: row.id ?? `asset-group-${index}`,
        name: clean(row.name),
        campaign: clean(row.campaign),
        spend: currency(finite(row.spend), currencyCode, 0),
        value: currency(finite(row.revenue), currencyCode, 0),
        roas: roas === null || roas <= 0 ? DASH : roas.toFixed(2),
        roasTone: googleSearchRoasTone(roas, target, breakEven),
        strength: strength ?? DASH,
        strengthTone: strength ? googleAssetStrengthTone(strength) : "unserved",
      };
    },
  );

  // The reference's Text assets card carries headlines and descriptions; image
  // assets are the card beside it and video assets belong to neither.
  const textRows: GoogleAssetsExactTextRowViewModel[] = assets
    .filter((row) => row.type === "Headline" || row.type === "Description")
    .map((row, index) => {
      const impressions = finite(row.impressions);
      // Google's served label, never the derived one: the card's caption claims
      // the provider's provenance and the chip has to be able to honour it.
      const performance = googleAssetPerformanceView(row.servedPerformanceLabel);
      return {
        key: row.id ?? `asset-${index}`,
        text: assetLabel(row),
        kind: clean(row.type),
        impressions: impressions === null ? DASH : `${count(impressions)} impr`,
        performance: performance.label,
        performanceTone: performance.tone,
      };
    });

  const images = assets.filter((row) => row.type === "Image");
  const imageImpressionTotal = images.reduce(
    (sum, row) => sum + (finite(row.impressions) ?? 0),
    0,
  );
  const imageRows: GoogleAssetsExactImageViewModel[] = images.map(
    (row, index) => {
      const impressions = finite(row.impressions);
      const share =
        impressions === null || imageImpressionTotal <= 0
          ? DASH
          : `${Math.round((impressions / imageImpressionTotal) * 100)}%`;
      const url = row.preview?.startsWith("http") ? row.preview : null;
      return {
        key: row.id ?? `image-${index}`,
        imageUrl: url,
        swatch: (index % 4) as 0 | 1 | 2 | 3,
        share,
        label: assetLabel(row),
      };
    },
  );

  const audienceRows: GoogleAssetsExactAudienceRowViewModel[] = audiences.map(
    (row, index) => {
      const roas = finite(row.roas);
      const conversions = finite(row.conversions);
      const spend = finite(row.spend);
      const servedCpa = finite(row.cpa);
      const cpa =
        servedCpa !== null && servedCpa > 0
          ? servedCpa
          : conversions !== null && conversions > 0 && spend !== null
            ? spend / conversions
            : null;
      return {
        key: row.criterionId ?? `audience-${index}`,
        name: audienceLabel(row),
        type: clean(row.type),
        // List size lives on the `user_list` resource, which no query family in
        // this product reads; the column keeps its cell and prints the dash.
        size: DASH,
        conversions: count(conversions),
        cpa: currency(cpa, currencyCode, 2),
        roas: roas === null || roas <= 0 ? DASH : roas.toFixed(2),
        roasTone: googleSearchRoasTone(roas, target, breakEven),
      };
    },
  );

  return {
    eyebrow: eyebrowText(identity),
    syncLabel: clean(identity.syncLabel),
    tab: input.tab,
    tabs: GOOGLE_ASSETS_EXACT_TABS.map((tab) => ({
      key: tab.key,
      label: tab.label,
      active: tab.key === input.tab,
    })),
    groupRows,
    groupNote: googleAssetGroupQueueNote(
      (input.queuedRestructures ?? []).filter(
        (name): name is string => typeof name === "string" && name.trim() !== "",
      ),
    ),
    textRows,
    imageRows,
    audienceRows,
  };
}
