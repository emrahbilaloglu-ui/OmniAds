import { buildLegacyCostStructure } from "@/lib/commerce-cost/legacy";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness, isMissingRelationError } from "@/lib/db-schema-readiness";
import type { CommerceCostStructure } from "@/src/types/commerce-cost";

/**
 * The read-only preview a business sees before it has stored anything.
 *
 * It is built from the two places the product already keeps cost assumptions —
 * `business_cost_models` (what Overview and the Google advisor cost with) and
 * `business_target_packs.cost_*` (what Commercial Truth displays) — so an
 * operator opening the screen sees their own numbers rather than a blank form.
 *
 * It is a PREVIEW, never a stored structure. Nothing writes it, nothing
 * confirms it, and `buildLegacyCostStructure` marks every component as an
 * operator estimate with `confirmed: false`. The caller labels it
 * `legacy_preview` and it becomes real only when an operator saves it.
 *
 * THE TWO LEGACY SOURCES DO NOT MEAN THE SAME THING BY ZERO, and this module
 * exists mainly to keep them apart:
 *
 *  - `business_cost_models.cogs_percent`, `shipping_percent`, `fee_percent`,
 *    `fixed_monthly_cost` and `fixed_cost` are all `DOUBLE PRECISION NOT NULL
 *    DEFAULT 0` (lib/migrations.ts). The column can never be null, so a 0 there
 *    is indistinguishable from a row nobody ever filled in — every business with
 *    a cost-model row starts at zero on every field. A zero from this table is
 *    therefore AMBIGUOUS and is treated as unstated, not as "this costs
 *    nothing". Previewing it as an explicit zero component would tell a brand
 *    new business that its product, shipping and payment costs are all free,
 *    and a free cost is pure profit.
 *  - `business_target_packs.cost_*` are nullable with no default, so a 0 there
 *    really was typed by an operator and is preserved as an explicit zero.
 *
 * The dropped zeros are reported in `ambiguousLegacyZeros` rather than silently
 * discarded: "we could not tell whether you meant zero" is a thing the operator
 * should be asked about, and a family left unstated shows up as a gap instead of
 * as a confident zero.
 *
 * This also does not reuse `getBusinessCostModel`: that reader is correct for
 * the legacy runtime it feeds, but it collapses the same distinction with
 * `Number(row.cogs_percent ?? 0)`.
 */

/**
 * Columns whose zero cannot be trusted, because the column defaults to zero.
 *
 * Named per column so the response can say exactly which figure was unreadable
 * as a decision, rather than offering a general disclaimer.
 */
export const AMBIGUOUS_ZERO_COLUMNS = [
  "business_cost_models.cogs_percent",
  "business_cost_models.shipping_percent",
  "business_cost_models.fee_percent",
  "business_cost_models.fixed_monthly_cost",
] as const;

export interface LegacyCostSourceRead {
  costModel: {
    cogsPercent: number | null;
    shippingPercent: number | null;
    feePercent: number | null;
    fixedCost: number | null;
    updatedAt: string | null;
  } | null;
  targetPackCosts: {
    cogsPercent: number | null;
    shippingPercent: number | null;
    fulfillmentPercent: number | null;
    paymentProcessingPercent: number | null;
    updatedAt: string | null;
  } | null;
  /**
   * Legacy tables that could not be read at all.
   *
   * Reported, not silently treated as "this business has no cost model": the
   * preview is honestly thinner when a source is unreadable, and the caller can
   * say so instead of showing a confident empty draft.
   */
  unreadableSources: string[];
  /**
   * Columns that held 0 in a table where 0 is also the default, so the preview
   * left them unstated. Not an error, and not a zero.
   */
  ambiguousLegacyZeros: string[];
}

/** A NUMERIC can arrive as a string; a numeric string is the same fact. */
function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return null;
  return numeric;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * A stated figure from `business_cost_models`, or null when it cannot be one.
 *
 * Zero is rejected because the column defaults to zero: see the file header.
 */
function statedNonDefaultOrNull(
  value: unknown,
  column: string,
  ambiguous: string[],
): number | null {
  const numeric = numericOrNull(value);
  if (numeric === null) return null;
  if (numeric === 0) {
    ambiguous.push(column);
    return null;
  }
  return numeric;
}

async function readCostModelRow(businessId: string): Promise<{
  row: LegacyCostSourceRead["costModel"];
  unreadable: boolean;
  ambiguousLegacyZeros: string[];
}> {
  const ambiguousLegacyZeros: string[] = [];
  const readiness = await getDbSchemaReadiness({ tables: ["business_cost_models"] }).catch(
    () => null,
  );
  if (!readiness?.ready) return { row: null, unreadable: true, ambiguousLegacyZeros };

  try {
    const sql = getDb();
    const rows = await sql<{
      cogs_percent: unknown;
      shipping_percent: unknown;
      fee_percent: unknown;
      fixed_monthly_cost: unknown;
      updated_at: unknown;
    }>`
      /* commerce-cost-legacy-preview-cost-model */
      SELECT cogs_percent,
             shipping_percent,
             fee_percent,
             -- Both columns are NOT NULL DEFAULT 0 and a migration keeps them in
             -- step, so the larger of the two is the one somebody set.
             GREATEST(fixed_monthly_cost, fixed_cost) AS fixed_monthly_cost,
             to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
      FROM business_cost_models
      WHERE business_id = ${businessId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { row: null, unreadable: false, ambiguousLegacyZeros };
    return {
      row: {
        cogsPercent: statedNonDefaultOrNull(
          row.cogs_percent,
          "business_cost_models.cogs_percent",
          ambiguousLegacyZeros,
        ),
        shippingPercent: statedNonDefaultOrNull(
          row.shipping_percent,
          "business_cost_models.shipping_percent",
          ambiguousLegacyZeros,
        ),
        feePercent: statedNonDefaultOrNull(
          row.fee_percent,
          "business_cost_models.fee_percent",
          ambiguousLegacyZeros,
        ),
        fixedCost: statedNonDefaultOrNull(
          row.fixed_monthly_cost,
          "business_cost_models.fixed_monthly_cost",
          ambiguousLegacyZeros,
        ),
        updatedAt: textOrNull(row.updated_at),
      },
      unreadable: false,
      ambiguousLegacyZeros,
    };
  } catch (error) {
    if (isMissingRelationError(error, ["business_cost_models"])) {
      return { row: null, unreadable: true, ambiguousLegacyZeros };
    }
    throw error;
  }
}

async function readTargetPackCostRow(businessId: string): Promise<{
  row: LegacyCostSourceRead["targetPackCosts"];
  unreadable: boolean;
}> {
  const readiness = await getDbSchemaReadiness({ tables: ["business_target_packs"] }).catch(
    () => null,
  );
  if (!readiness?.ready) return { row: null, unreadable: true };

  try {
    const sql = getDb();
    const rows = await sql<{
      cost_cogs_percent: unknown;
      cost_shipping_percent: unknown;
      cost_fulfillment_percent: unknown;
      cost_payment_processing_percent: unknown;
      updated_at: unknown;
    }>`
      /* commerce-cost-legacy-preview-target-pack */
      SELECT cost_cogs_percent,
             cost_shipping_percent,
             cost_fulfillment_percent,
             cost_payment_processing_percent,
             to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
      FROM business_target_packs
      WHERE business_id = ${businessId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { row: null, unreadable: false };
    return {
      row: {
        cogsPercent: numericOrNull(row.cost_cogs_percent),
        shippingPercent: numericOrNull(row.cost_shipping_percent),
        fulfillmentPercent: numericOrNull(row.cost_fulfillment_percent),
        paymentProcessingPercent: numericOrNull(row.cost_payment_processing_percent),
        updatedAt: textOrNull(row.updated_at),
      },
      unreadable: false,
    };
  } catch (error) {
    if (isMissingRelationError(error, ["business_target_packs"])) {
      return { row: null, unreadable: true };
    }
    throw error;
  }
}

/** Both legacy sources, with unstated and untrustworthy figures left absent. */
export async function readLegacyCostSources(businessId: string): Promise<LegacyCostSourceRead> {
  const [costModel, targetPack] = await Promise.all([
    readCostModelRow(businessId),
    readTargetPackCostRow(businessId),
  ]);

  const unreadableSources: string[] = [];
  if (costModel.unreadable) unreadableSources.push("business_cost_models");
  if (targetPack.unreadable) unreadableSources.push("business_target_packs");

  return {
    costModel: costModel.row,
    targetPackCosts: targetPack.row,
    unreadableSources,
    ambiguousLegacyZeros: costModel.ambiguousLegacyZeros,
  };
}

function hasAnyPercentage(sources: LegacyCostSourceRead): boolean {
  const values = [
    sources.costModel?.cogsPercent,
    sources.costModel?.shippingPercent,
    sources.costModel?.feePercent,
    sources.costModel?.fixedCost,
    sources.targetPackCosts?.cogsPercent,
    sources.targetPackCosts?.shippingPercent,
    sources.targetPackCosts?.fulfillmentPercent,
    sources.targetPackCosts?.paymentProcessingPercent,
  ];
  // A target-pack 0 counts: that column is nullable, so somebody stated it.
  // A cost-model 0 has already been dropped to null by the reader, so it does
  // not make an untouched default row look like a preview worth showing.
  return values.some((value) => typeof value === "number");
}

/** An honest blank draft: no components, and nothing claimed about them. */
export function buildEmptyCostStructure(input: {
  businessId: string;
  reportingCurrency: string;
  recordedAt: string;
  effectiveFrom: string;
}): CommerceCostStructure {
  return {
    businessId: input.businessId,
    version: 0,
    origin: "operator",
    confirmed: false,
    reportingCurrency: input.reportingCurrency,
    effectiveFrom: input.effectiveFrom,
    recordedAt: input.recordedAt,
    components: [],
  };
}

export type CostStructurePreviewSource = "legacy_preview" | "empty";

export interface CostStructurePreview {
  structure: CommerceCostStructure;
  source: CostStructurePreviewSource;
  unreadableSources: string[];
  ambiguousLegacyZeros: string[];
}

/**
 * What to show a business that has stored nothing yet.
 *
 * `legacy_preview` when the legacy tables hold at least one stated figure,
 * `empty` otherwise. Both carry `version: 0` and `confirmed: false`, so a
 * caller that mistook one for a stored structure would still not be able to
 * claim it was confirmed.
 */
export async function buildCostStructurePreview(input: {
  businessId: string;
  reportingCurrency: string;
  recordedAt: string;
  effectiveFrom: string;
}): Promise<CostStructurePreview> {
  const sources = await readLegacyCostSources(input.businessId);

  if (!hasAnyPercentage(sources)) {
    return {
      structure: buildEmptyCostStructure(input),
      source: "empty",
      unreadableSources: sources.unreadableSources,
      ambiguousLegacyZeros: sources.ambiguousLegacyZeros,
    };
  }

  return {
    structure: buildLegacyCostStructure({
      businessId: input.businessId,
      reportingCurrency: input.reportingCurrency,
      recordedAt: input.recordedAt,
      effectiveFrom: input.effectiveFrom,
      costModel: sources.costModel,
      targetPackCosts: sources.targetPackCosts,
      // Not a stored version. A preview has never been saved, and the first
      // save assigns version 1.
      structureVersion: 0,
    }),
    source: "legacy_preview",
    unreadableSources: sources.unreadableSources,
    ambiguousLegacyZeros: sources.ambiguousLegacyZeros,
  };
}
