/**
 * Pure mapping from what the server serves to the Commercial Truth view model.
 *
 * The design seeds this screen with a prototype workspace (Aurora Supply Co.,
 * a ten-row campaign table, a $12,000 fixed base). None of that survives here:
 * every number is read from the target pack, the cost model, the campaign
 * readers and the pack history, and a fact nothing supplies becomes the em dash.
 *
 * The banding ladder is the design's own — Above target / Near target / Above
 * breakeven / Below breakeven with mid = min(T, max(B, T × 0.85)) — but it only
 * runs when the pack actually carries both anchors. Without them nothing is
 * labeled, because a verdict computed against a guessed target is a lie.
 */
import type {
  CommercialTruthBandModel,
  CommercialTruthConsumerModel,
  CommercialTruthExactModel,
  CommercialTruthFieldModel,
  CommercialTruthLogEntryModel,
  CommercialTruthScenarioBasisModel,
  CommercialTruthSegmentModel,
  CommercialTruthSpendRowModel,
  CommercialTruthTotalsModel,
} from "@/components/commercial-truth/commercial-truth-exact-model";
import { TRUTH_DASH } from "@/components/commercial-truth/commercial-truth-exact-model";

/** The design's semantic palette (data-model.js:3237). */
const TONE = {
  pos: ["#E7F6F0", "#0b7954"],
  neg: ["#FDECF0", "#E11D48"],
  warn: ["#FBF3E1", "#B45309"],
  info: ["#EAF0FF", "#2a5fe2"],
  neutral: ["#F1F4F9", "#555d6d"],
} as const;

const BAND_META = [
  { name: "Above target", tone: "#0b7954", bg: TONE.pos[0], fg: TONE.pos[1], verdict: "Scale" },
  { name: "Near target", tone: "#2a5fe2", bg: TONE.info[0], fg: TONE.info[1], verdict: "Hold" },
  {
    name: "Above breakeven",
    tone: "#B45309",
    bg: TONE.warn[0],
    fg: TONE.warn[1],
    verdict: "Watch / Trim",
  },
  { name: "Below breakeven", tone: "#E11D48", bg: TONE.neg[0], fg: TONE.neg[1], verdict: "Cut" },
  {
    name: "Unlabeled",
    tone: "#68707f",
    bg: TONE.neutral[0],
    fg: TONE.neutral[1],
    verdict: "Fix setup",
  },
] as const;

/** data-model.js:4298 — five segments, in this order, with these colours. */
const SEGMENT_TONES = {
  cogs: "#41506B",
  shipping: "#B45309",
  fees: "#6C41BE",
  ads: "#2a5fe2",
  contribution: "#0b7954",
} as const;

/**
 * The surfaces that actually resolve their thresholds from this pack.
 *
 * These are the app's own consumers, not the prototype's. `last` stays the em
 * dash because nothing logs a per-surface read timestamp — the design's
 * "read 12m ago" is seed data and inventing it would be a fabricated audit line.
 */
export const TRUTH_CONSUMERS: CommercialTruthConsumerModel[] = [
  {
    dot: "#2a5fe2",
    name: "Meta Decision Center",
    note: "Labels Scale / Cut against the ROAS anchors.",
    reads: "Target ROAS · break-even ROAS",
    last: TRUTH_DASH,
  },
  {
    dot: "#6C41BE",
    name: "Automation guardrails",
    note: "Pause floor and write validation before any action.",
    reads: "Break-even ROAS · Target CPA",
    last: TRUTH_DASH,
  },
  {
    dot: "#0b7954",
    name: "Creative Studio",
    note: "Winner threshold on the heat table and board.",
    reads: "Target ROAS · AOV assumption",
    last: TRUTH_DASH,
  },
  {
    dot: "#B45309",
    name: "Overview · Expenses",
    note: "Net profit and contribution margin math.",
    reads: "Margins · Fixed costs",
    last: TRUTH_DASH,
  },
];

export interface CommercialTruthCampaignSource {
  id: string;
  name: string;
  platform: "Meta" | "Google";
  level: string;
  spend: number | null;
  revenue: number | null;
  roas: number | null;
}

export interface CommercialTruthTargetPackSource {
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
  aovAssumption: number | null;
  costStructure: {
    cogsPercent: number | null;
    shippingPercent: number | null;
    paymentProcessingPercent: number | null;
  } | null;
  updatedAt: string | null;
}

export interface CommercialTruthCostModelSource {
  cogsPercent: number | null;
  shippingPercent: number | null;
  feePercent: number | null;
  fixedCost: number | null;
}

export interface CommercialTruthHistorySource {
  id: string;
  at: string;
  changes: string[];
  sourceLabel: string | null;
  actor: string | null;
}

export interface CommercialTruthAdapterInput {
  business: {
    name: string | null;
    currency: string | null;
    timezone: string | null;
  };
  targetPack: CommercialTruthTargetPackSource | null;
  costModel: CommercialTruthCostModelSource | null;
  /** Window totals used for the blended MER segment of the revenue split. */
  window: {
    spend: number | null;
    revenue: number | null;
  };
  campaigns: CommercialTruthCampaignSource[];
  history: CommercialTruthHistorySource[];
  pack: {
    canEdit: boolean;
    saving: boolean;
    dirty: boolean;
    error: string | null;
    lastUpdatedActor: string | null;
  };
  /** Live draft values, so a keystroke re-labels the preview like the design. */
  draft?: Partial<Record<"targetRoas" | "breakevenRoas", number | null>>;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function currencyFormatter(
  currencyCode: string | null,
): (value: number) => string {
  // A business with no configured currency must not be shown dollars. The
  // amount is still real, so it is printed plainly; the workspace stat already
  // shows the currency itself as unknown.
  if (currencyCode === null) {
    return (value) => Math.round(value).toLocaleString("en-US");
  }
  try {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    return (value) => formatter.format(value);
  } catch {
    return (value) => Math.round(value).toLocaleString("en-US");
  }
}

/**
 * The symbol the same formatter prints, so the chip and the cells agree.
 *
 * Falls back to the code only when the runtime cannot format the currency at
 * all — which is the same case in which `currencyFormatter` gives up on the
 * currency style too.
 */
function currencySymbolOf(currencyCode: string | null): string {
  if (currencyCode === null) return "";
  try {
    const parts = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).formatToParts(0);
    return parts.find((part) => part.type === "currency")?.value ?? currencyCode;
  } catch {
    return currencyCode;
  }
}

function percentLabel(ratio: number | null): string {
  if (ratio === null) return TRUTH_DASH;
  return `${(ratio * 100).toFixed(ratio * 100 % 1 === 0 ? 0 : 1)}%`;
}

function formatDay(value: string | null): string {
  if (!value) return TRUTH_DASH;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return TRUTH_DASH;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Pack override first, live cost model second — the operator's word wins. */
function pick(packValue: number | null | undefined, modelValue: number | null | undefined) {
  const fromPack = finite(packValue);
  if (fromPack !== null) return fromPack;
  return finite(modelValue);
}

export function buildCommercialTruthExactModel(
  input: CommercialTruthAdapterInput,
): CommercialTruthExactModel {
  // Null when the business has no configured currency: never defaulted, so no
  // surface can imply dollars the operator never chose.
  const currencyCode = input.business.currency?.trim().toUpperCase() || null;
  // The two money anchors say which unit they are in, so an operator cannot
  // enter a figure in the wrong currency without noticing.
  const AOV_UNIT = currencyCode
    ? ` (${currencyCode})`
    : " (currency not set)";
  const money = currencyFormatter(currencyCode);
  const pack = input.targetPack;
  const costModel = input.costModel;

  const cogs = pick(pack?.costStructure?.cogsPercent, costModel?.cogsPercent);
  const shipping = pick(pack?.costStructure?.shippingPercent, costModel?.shippingPercent);
  const fees = pick(pack?.costStructure?.paymentProcessingPercent, costModel?.feePercent);
  const fixedCost = finite(costModel?.fixedCost);

  const targetRoas =
    input.draft?.targetRoas !== undefined ? input.draft.targetRoas : finite(pack?.targetRoas);
  const breakevenRoas =
    input.draft?.breakevenRoas !== undefined
      ? input.draft.breakevenRoas
      : finite(pack?.breakEvenRoas);

  /* ---------------------------------------------------------------- fields */

  const grossMargin = cogs === null ? null : 1 - cogs;
  const fields: CommercialTruthFieldModel[] = [
    {
      id: "targetRoas",
      label: "Target ROAS",
      value: targetRoas === null ? TRUTH_DASH : targetRoas.toFixed(2),
      hint: "Required for Scale. Pairs with the AOV assumption to set the spend unit.",
      accent: true,
      editable: input.pack.canEdit,
    },
    {
      id: "breakevenRoas",
      label: "Breakeven ROAS",
      value: breakevenRoas === null ? TRUTH_DASH : breakevenRoas.toFixed(2),
      hint: "Required for Cut. Scale and Refresh do not use it.",
      accent: true,
      editable: input.pack.canEdit,
    },
    {
      id: "grossMargin",
      label: "Gross margin",
      value: percentLabel(grossMargin),
      hint: "After COGS",
      accent: false,
      editable: input.pack.canEdit,
    },
    {
      id: "aovFloor",
      label: `AOV assumption${AOV_UNIT}`,
      value: finite(pack?.aovAssumption) === null ? TRUTH_DASH : money(pack!.aovAssumption!),
      hint: "Average order value you operate against. Spend unit = AOV ÷ Target ROAS. Leave empty if you set a Target CPA instead.",
      accent: false,
      editable: input.pack.canEdit,
    },
    {
      id: "shippingCost",
      label: "Shipping cost",
      value: percentLabel(shipping),
      hint: "Of revenue",
      accent: false,
      editable: input.pack.canEdit,
    },
    {
      id: "paymentFees",
      label: "Payment fees",
      value: percentLabel(fees),
      hint: "Of revenue",
      accent: false,
      editable: input.pack.canEdit,
    },
    {
      id: "cpaCeiling",
      label: `Target CPA${AOV_UNIT}`,
      value: finite(pack?.targetCpa) === null ? TRUTH_DASH : money(pack!.targetCpa!),
      hint: "Cost per purchase you operate against. Used directly as the spend unit; the strongest anchor. Unlocks the threshold only — freshness, campaign role, calibration and governance still gate every action.",
      accent: false,
      editable: input.pack.canEdit,
    },
    {
      id: "fixedCosts",
      label: "Fixed costs / mo",
      value: fixedCost === null ? TRUTH_DASH : money(fixedCost),
      hint: "Feeds net profit + contribution",
      accent: false,
      editable: input.pack.canEdit,
    },
  ];

  /* ------------------------------------------------------- revenue split */

  const windowSpend = finite(input.window.spend);
  const windowRevenue = finite(input.window.revenue);
  const adShare =
    windowSpend !== null && windowRevenue !== null && windowRevenue > 0
      ? windowSpend / windowRevenue
      : null;

  const splitParts: Array<{ key: string; share: number | null; background: string }> = [
    { key: "COGS", share: cogs, background: SEGMENT_TONES.cogs },
    { key: "Shipping", share: shipping, background: SEGMENT_TONES.shipping },
    { key: "Fees", share: fees, background: SEGMENT_TONES.fees },
    { key: "Ad spend", share: adShare, background: SEGMENT_TONES.ads },
  ];
  const knownShare = splitParts.reduce((sum, part) => sum + (part.share ?? 0), 0);
  const everyPartKnown = splitParts.every((part) => part.share !== null);
  const contribution = everyPartKnown ? Math.max(0, 1 - knownShare) : null;
  const dollars = (share: number | null) =>
    share === null ? TRUTH_DASH : `$${Math.round(share * 100)}`;

  const segments: CommercialTruthSegmentModel[] = [
    ...splitParts,
    { key: "Contribution", share: contribution, background: SEGMENT_TONES.contribution },
  ].map((part) => ({
    key: part.key,
    value: dollars(part.share),
    width: `${((part.share ?? 0) * 100).toFixed(2)}%`,
    background: part.background,
  }));

  const splitNote =
    adShare !== null && contribution !== null && breakevenRoas !== null
      ? `At the current blended MER, ${dollars(adShare)} of every $100 goes to ads and ${dollars(
          contribution,
        )} remains as contribution — that funds the ${
          fixedCost === null ? TRUTH_DASH : `${money(fixedCost)}/mo`
        } fixed base before profit. Breakeven ROAS ${breakevenRoas.toFixed(
          2,
        )} is derived from these numbers, not chosen.`
      : "This split resolves once the pack carries COGS, shipping and fees and the window reports both spend and revenue.";

  /* ------------------------------------------------------------- scenario */

  const variableCostRatio = everyVariableKnown(cogs, shipping, fees)
    ? (cogs ?? 0) + (shipping ?? 0) + (fees ?? 0)
    : null;
  const scenario: CommercialTruthScenarioBasisModel = {
    variableCostRatio,
    fixedCost,
    targetRoas,
    variableCostSubLabel:
      variableCostRatio === null
        ? TRUTH_DASH
        : `COGS ${percentLabel(cogs)} + shipping ${percentLabel(shipping)} + fees ${percentLabel(
            fees,
          )}`,
    contributionSubLabel:
      variableCostRatio === null ? TRUTH_DASH : `${percentLabel(1 - variableCostRatio)} of revenue`,
    defaultSpends: ["10,000", "20,000", "30,000", "50,000", "100,000"],
  };

  /* ----------------------------------------------------- spend vs targets */

  const rows = input.campaigns.filter((row) => (finite(row.spend) ?? 0) > 0);
  const allSpend = rows.reduce((sum, row) => sum + (finite(row.spend) ?? 0), 0);
  const maxSpend = rows.reduce((peak, row) => Math.max(peak, finite(row.spend) ?? 0), 0);
  const canBand = targetRoas !== null && breakevenRoas !== null;
  const mid = canBand ? Math.min(targetRoas, Math.max(breakevenRoas, targetRoas * 0.85)) : null;

  const bandIndexFor = (roas: number | null): number => {
    if (roas === null || !canBand || mid === null) return 4;
    if (roas >= targetRoas) return 0;
    if (roas >= mid) return 1;
    if (roas >= breakevenRoas) return 2;
    return 3;
  };

  const roasOf = (row: CommercialTruthCampaignSource): number | null => {
    const direct = finite(row.roas);
    if (direct !== null) return direct;
    const spend = finite(row.spend);
    const revenue = finite(row.revenue);
    if (spend === null || revenue === null || spend <= 0) return null;
    return revenue / spend;
  };

  const labeled = rows.filter((row) => roasOf(row) !== null);
  const labeledSpend = labeled.reduce((sum, row) => sum + (finite(row.spend) ?? 0), 0);

  const bands: CommercialTruthBandModel[] = BAND_META.slice(0, 4).map((meta, index) => {
    const members = canBand ? labeled.filter((row) => bandIndexFor(roasOf(row)) === index) : [];
    const spend = members.reduce((sum, row) => sum + (finite(row.spend) ?? 0), 0);
    const range = !canBand
      ? TRUTH_DASH
      : index === 0
        ? `ROAS ≥ ${targetRoas.toFixed(2)}`
        : index === 1
          ? `${mid!.toFixed(2)} – ${targetRoas.toFixed(2)}`
          : index === 2
            ? `${breakevenRoas.toFixed(2)} – ${mid!.toFixed(2)}`
            : `ROAS < ${breakevenRoas.toFixed(2)}`;
    return {
      name: meta.name,
      tone: meta.tone,
      verdict: meta.verdict,
      count: members.length,
      range,
      spend: canBand ? money(spend) : TRUTH_DASH,
      share: canBand && labeledSpend > 0 ? `${((spend / labeledSpend) * 100).toFixed(1)}%` : "0.0%",
    };
  });

  const spendRows: CommercialTruthSpendRowModel[] = rows.map((row) => {
    const roas = roasOf(row);
    const meta = BAND_META[bandIndexFor(roas)];
    const spend = finite(row.spend) ?? 0;
    const delta = roas === null || targetRoas === null ? null : roas - targetRoas;
    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      level: row.level,
      logo: row.platform === "Google" ? "/platform-logos/googleAds.svg" : "/platform-logos/Meta.png",
      spend: money(spend),
      share: allSpend > 0 ? `${Math.round((spend / allSpend) * 100)}%` : TRUTH_DASH,
      shareWidth: maxSpend > 0 ? `${((spend / maxSpend) * 100).toFixed(0)}%` : "0%",
      tone: meta.tone,
      revenue: finite(row.revenue) === null ? TRUTH_DASH : money(row.revenue!),
      roas: roas === null ? TRUTH_DASH : roas.toFixed(2),
      roasBackground: meta.bg,
      roasForeground: meta.fg,
      delta: delta === null ? TRUTH_DASH : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)}`,
      deltaForeground: delta === null ? "#68707f" : delta >= 0 ? "#0b7954" : "#E11D48",
      verdict: canBand ? meta.verdict : TRUTH_DASH,
      verdictBackground: canBand ? meta.bg : TONE.neutral[0],
      verdictForeground: canBand ? meta.fg : TONE.neutral[1],
    };
  });

  const totalRevenue = labeled.reduce((sum, row) => {
    const spend = finite(row.spend) ?? 0;
    const roas = roasOf(row) ?? 0;
    const revenue = finite(row.revenue);
    return sum + (revenue ?? spend * roas);
  }, 0);
  const blended = labeledSpend > 0 ? totalRevenue / labeledSpend : null;
  const blendedDelta = blended === null || targetRoas === null ? null : blended - targetRoas;
  const blendedMeta = BAND_META[bandIndexFor(blended)];

  const totals: CommercialTruthTotalsModel = {
    spend: labeled.length > 0 ? money(labeledSpend) : TRUTH_DASH,
    revenue: labeled.length > 0 ? money(totalRevenue) : TRUTH_DASH,
    roas: blended === null ? TRUTH_DASH : blended.toFixed(2),
    roasBackground: blended === null ? TONE.neutral[0] : blendedMeta.bg,
    roasForeground: blended === null ? TONE.neutral[1] : blendedMeta.fg,
    delta:
      blendedDelta === null
        ? TRUTH_DASH
        : `${blendedDelta >= 0 ? "+" : "−"}${Math.abs(blendedDelta).toFixed(2)}`,
    deltaForeground:
      blendedDelta === null ? "#68707f" : blendedDelta >= 0 ? "#0b7954" : "#E11D48",
    targetRoas: targetRoas === null ? TRUTH_DASH : targetRoas.toFixed(2),
  };

  const coverage =
    allSpend > 0
      ? `labeled coverage ${((labeledSpend / allSpend) * 100).toFixed(0)}% — the rest is unlabeled`
      : `labeled coverage ${TRUTH_DASH}`;

  /* ------------------------------------------------------- change history */

  const log: CommercialTruthLogEntryModel[] = input.history.map((entry) => ({
    id: entry.id,
    time: formatDay(entry.at),
    change: entry.changes.join(" · ") || TRUTH_DASH,
    why: entry.sourceLabel ?? "manual save",
    actor: entry.actor ?? TRUTH_DASH,
  }));

  const packUpdatedDay = formatDay(pack?.updatedAt ?? null);
  const packActor = input.pack.lastUpdatedActor?.trim();
  const lastUpdated =
    packUpdatedDay === TRUTH_DASH
      ? TRUTH_DASH
      : `last updated ${packUpdatedDay} by ${packActor || TRUTH_DASH}`;

  return {
    eyebrow: "Targets & economics",
    title: "Commercial Truth",
    lede:
      "The single economic ground truth every decision surface reads. Meta Decisions, Creative Studio and Automation guardrails anchor to these numbers deterministically.",
    bandNote:
      "One target pack per workspace. Surfaces read it deterministically — nothing recomputed locally, nothing overridden per screen.",
    stats: [
      { key: "Workspace", value: input.business.name?.trim() || TRUTH_DASH },
      { key: "Currency", value: input.business.currency?.trim() || TRUTH_DASH },
      { key: "Timezone", value: input.business.timezone?.trim() || TRUTH_DASH },
    ],
    fields,
    pack: {
      lastUpdated,
      canEdit: input.pack.canEdit,
      saving: input.pack.saving,
      dirty: input.pack.dirty,
      error: input.pack.error,
    },
    segments,
    splitNote,
    consumers: TRUTH_CONSUMERS,
    log,
    scenario,
    bands,
    coverage,
    spendRows,
    totals,
    unlabeledSpend: allSpend > 0 ? money(allSpend - labeledSpend) : TRUTH_DASH,
    currencyCode,
    currencySymbol: currencySymbolOf(currencyCode),
  };
}

function everyVariableKnown(
  cogs: number | null,
  shipping: number | null,
  fees: number | null,
): boolean {
  return cogs !== null && shipping !== null && fees !== null;
}
