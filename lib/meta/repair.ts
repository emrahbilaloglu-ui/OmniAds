import { createHash } from "node:crypto";
import type { MetaConfigSnapshotObservation } from "@/lib/meta/config-snapshots";
import {
  applyMetaConfigRepairChanges,
  verifyPreviouslyAppliedMetaConfigRepair,
} from "@/lib/meta/config-repair-write";
import { CORROBORATION_HORIZON_DAYS } from "@/lib/meta/config-field-source-contract";
import { providerLocalCalendarDate, providerLocalDayEndExclusive, providerLocalDayStartInclusive } from "@/lib/meta/provider-local-day";
import {
  repairAdSetRowsFromSnapshots,
  repairCampaignRowsFromSnapshots,
} from "@/lib/meta/serving";
import {
  getMetaAdSetDailyRange,
  getMetaCampaignDailyRange,
} from "@/lib/meta/warehouse";
import type {
  MetaAdSetDailyRow,
  MetaCampaignDailyRow,
} from "@/lib/meta/warehouse-types";

function changedCampaignRow(next: MetaCampaignDailyRow, prev?: MetaCampaignDailyRow) {
  return (
    !prev ||
    next.objective !== prev.objective ||
    next.optimizationGoal !== prev.optimizationGoal ||
    next.customEventType !== prev.customEventType ||
    next.bidStrategyType !== prev.bidStrategyType ||
    next.bidValue !== prev.bidValue ||
    next.bidValueFormat !== prev.bidValueFormat ||
    next.dailyBudget !== prev.dailyBudget ||
    next.lifetimeBudget !== prev.lifetimeBudget ||
    next.isBudgetMixed !== prev.isBudgetMixed ||
    next.isConfigMixed !== prev.isConfigMixed ||
    next.isOptimizationGoalMixed !== prev.isOptimizationGoalMixed ||
    next.isCustomEventTypeMixed !== prev.isCustomEventTypeMixed ||
    next.isBidStrategyMixed !== prev.isBidStrategyMixed ||
    next.isBidValueMixed !== prev.isBidValueMixed
  );
}

function changedAdSetRow(next: MetaAdSetDailyRow, prev?: MetaAdSetDailyRow) {
  return (
    !prev ||
    next.optimizationGoal !== prev.optimizationGoal ||
    next.customEventType !== prev.customEventType ||
    next.pixelId !== prev.pixelId ||
    next.customConversionId !== prev.customConversionId ||
    JSON.stringify(next.promotedObjectJson ?? null) !== JSON.stringify(prev.promotedObjectJson ?? null) ||
    next.bidStrategyType !== prev.bidStrategyType ||
    next.bidValue !== prev.bidValue ||
    next.bidValueFormat !== prev.bidValueFormat ||
    next.dailyBudget !== prev.dailyBudget ||
    next.lifetimeBudget !== prev.lifetimeBudget ||
    next.isBudgetMixed !== prev.isBudgetMixed ||
    next.isConfigMixed !== prev.isConfigMixed ||
    next.isOptimizationGoalMixed !== prev.isOptimizationGoalMixed ||
    next.isBidStrategyMixed !== prev.isBidStrategyMixed ||
    next.isBidValueMixed !== prev.isBidValueMixed
  );
}

function sourceProvesWholeProviderDay(
  source: MetaConfigSnapshotObservation | undefined,
  row: { date: string; accountTimezone: string },
): boolean {
  const observation = source?.providerObservation;
  if (observation?.kind !== "provider_config_receipt" ||
      source?.accountTimezone !== row.accountTimezone ||
      observation.normalizationVersion !== 2 || !observation.sourceSnapshotId ||
      !observation.corroboratingSourceSnapshotId ||
      /*
        The day-closing witness must be a different RECEIPT, which is not the
        same thing as a different snapshot.

        `meta_raw_snapshots` deduplicates payloads, so two genuine GETs of
        unchanged configuration share `sourceSnapshotId`; receipt identity lives
        in `meta_raw_snapshot_observations`, whose unique key includes
        `observed_at` so that every distinct observation instant is its own row
        (lib/migrations.ts). Comparing snapshot ids therefore rejected real
        second witnesses: Silveristic ad set `120251869715690343`, 2026-09-11,
        is corroborated by observation `c86e1e4b…` against source `e5511bab…`,
        two separate fetched/HTTP 200 rows 6.5 minutes apart on one canonical
        snapshot that carries 211 observations in all.

        So the check is on RECEIPT ids when both are known. A legacy
        snapshot-only receipt has no observation row and therefore no receipt
        id; two such receipts on one canonical snapshot cannot be shown to be
        distinct, so an unknown identity falls back to the content id and is
        refused. The reader applies the same rule when selecting a witness;
        this restates it where the day proof is consumed, so a manifest built
        elsewhere cannot be applied through this path either.
      */
      isSameProviderReceipt(observation) ||
      !observation.corroboratingObservedAt ||
      !observation.fieldScope.includes("updated_time") ||
      !observation.observedFieldScope?.includes("updated_time") ||
      !observation.entityUpdatedAt || !source?.capturedAt) return false;
  const dayStart = providerLocalDayStartInclusive({ day: row.date, timeZone: row.accountTimezone });
  const dayEnd = providerLocalDayEndExclusive({ day: row.date, timeZone: row.accountTimezone });
  const entityUpdateTime = Date.parse(observation.entityUpdatedAt);
  const observedTime = Date.parse(observation.observedAt);
  const corroboratedTime = Date.parse(observation.corroboratingObservedAt);
  return Boolean(dayStart && Number.isFinite(entityUpdateTime) &&
    dayEnd && Number.isFinite(observedTime) && Number.isFinite(corroboratedTime) &&
    corroboratedTime >= dayEnd.getTime() && entityUpdateTime <= dayStart.getTime() &&
    corroboratedTime < dayEnd.getTime() + CORROBORATION_HORIZON_DAYS * 86_400_000 &&
    entityUpdateTime <= observedTime &&
    providerLocalCalendarDate({ instant: observation.observedAt, timeZone: row.accountTimezone }) === row.date &&
    providerLocalCalendarDate({ instant: source.capturedAt, timeZone: row.accountTimezone }) === row.date);
}

/**
 * Are these two receipts the SAME provider GET?
 *
 * `meta_raw_snapshots` deduplicates payloads, so two genuine reads of unchanged
 * configuration share a content id; receipt identity lives in
 * `meta_raw_snapshot_observations`, whose unique key includes `observed_at` so
 * that every distinct observation instant is its own row (lib/migrations.ts).
 * A same-instant replay heartbeats rather than appending, so equal observation
 * ids really do mean one receipt.
 *
 * Comparing CONTENT ids instead threw away real second witnesses — measured on
 * production for Silveristic ad set `120251869715690343`, 2026-09-11, whose
 * source and day-closing witness are observations `e5511bab…` and `c86e1e4b…`,
 * 6.5 minutes apart on one canonical snapshot carrying 211 observations.
 *
 * A legacy snapshot-only receipt has no observation row and so no receipt id.
 * Two of them on one canonical snapshot cannot be shown to be distinct reads,
 * so an unknown identity falls back to the content id and is treated as the
 * same receipt.
 */
export function isSameProviderReceipt(input: {
  sourceSnapshotId?: string | null;
  sourceObservationId?: string | null;
  corroboratingSourceSnapshotId?: string | null;
  corroboratingObservationId?: string | null;
}): boolean {
  return input.sourceObservationId && input.corroboratingObservationId
    ? input.corroboratingObservationId === input.sourceObservationId
    : input.corroboratingSourceSnapshotId === input.sourceSnapshotId;
}

/**
 * Why a field the source could otherwise fill was left out of the manifest.
 *
 * These are FIELD-level refusals on purpose. The day proof
 * (`sourceProvesWholeProviderDay`) is a property of the entity-day; whether a
 * particular column may be dated to that day is a property of the column, and
 * the two were previously collapsed. Collapsing them meant one unsupportable
 * column either poisoned the whole receipt or, as actually happened, rode into
 * the manifest on the strength of a proof that did not cover it.
 */
export type MetaRepairFieldRefusal =
  | "bid_strategy_not_observed"
  | "budget_day_opening_unobserved";

/** A field the source could have filled, and the rule that refused it. */
export interface MetaRepairWithheldField {
  scope: "campaign_daily" | "adset_daily";
  providerAccountId: string;
  date: string;
  entityId: string;
  field: string;
  /** What would have been written. Kept so a reviewer can judge the refusal. */
  proposedValue: unknown;
  refusal: MetaRepairFieldRefusal;
}

/** Fields that exist only because a `bid_strategy` was read, or inferred. */
const BID_STRATEGY_DEPENDENT_FIELDS = new Set([
  "bidStrategyType", "bidValue", "bidValueFormat",
  "isBidStrategyMixed", "isBidValueMixed",
]);

/**
 * Fields whose provider mutation clock is documented NOT to advance.
 *
 * The whole-day proof rests on `updated_time <= dayStart`: the provider's own
 * clock says the entity was not edited after the day began, so a value read
 * inside the day held for the day. Meta's Campaign reference documents
 * `updated_time` only BY EXCLUSION, and the three write classes it names as not
 * advancing it are `spend_cap`, daily budget and lifetime budget — the same
 * point `lib/meta/config-field-source-contract.ts` records in its header.
 *
 * So for exactly these columns the clock is silent: a budget could have been
 * changed, or changed and reverted, inside the day without moving it. Nothing
 * else this path collects covers that gap either — measured across the four
 * non-empty dry-run manifests, 2,749 of 2,766 entries had their two witnesses
 * less than an hour apart, both straddling local midnight (median 7.5 minutes
 * on TheSwaf), which dates a budget to the end of the day and to nothing else.
 */
const BUDGET_FIELDS = new Set(["dailyBudget", "lifetimeBudget", "isBudgetMixed"]);

/**
 * May this source date THIS field to THIS provider-local day?
 *
 * Returns the refusal, or null when the field is admitted. Exported so the rule
 * can be tested directly rather than only through a manifest.
 */
export function metaRepairFieldAdmission(input: {
  field: string;
  source: MetaConfigSnapshotObservation | undefined;
  row: { date: string; accountTimezone: string };
}): MetaRepairFieldRefusal | null {
  const observation = input.source?.providerObservation;
  if (BID_STRATEGY_DEPENDENT_FIELDS.has(input.field)) {
    /*
      A bid strategy may be WRITTEN only when the provider STATED one. When it
      did not, `normalizeBidStrategy` infers `manual_bid` from a bare
      `bid_amount` (lib/meta/configuration.ts:127) — correct when reading a live
      entity, unsound as history, because an unobserved field and an absent one
      are the same `null` by the time it runs. The reader now drops the triple
      at source; this is the same rule at the manifest boundary, so a receipt
      that reaches here by any other route still cannot carry an inferred
      strategy. Both the selector and the observed set must name it: requested
      but absent is an observed absence, not a licence to infer.
    */
    const requested = observation?.fieldScope?.some(
      (field) => field.split(/[({]/, 1)[0] === "bid_strategy",
    );
    const observed = observation?.observedFieldScope?.some(
      (field) => field.split(/[({]/, 1)[0] === "bid_strategy",
    );
    if (!requested || !observed) return "bid_strategy_not_observed";
  }
  if (BUDGET_FIELDS.has(input.field)) {
    /*
      See BUDGET_FIELDS. What would satisfy this rule is an observation of the
      same value at or before the day's OPENING, which together with the
      day-closing corroborator would bracket the day without relying on a clock
      Meta does not advance for budgets. This reader selects its source from
      INSIDE the day, so it cannot supply that today and every budget field is
      refused — deliberately, and visibly, rather than written on a proof that
      does not reach it. The condition is written as a condition, not a ban, so
      a reader that later selects a day-opening receipt satisfies it without
      touching this rule.
    */
    const dayStart = providerLocalDayStartInclusive({
      day: input.row.date, timeZone: input.row.accountTimezone,
    });
    const observedTime = Date.parse(observation?.observedAt ?? "");
    if (!dayStart || !Number.isFinite(observedTime) ||
        observedTime > dayStart.getTime()) {
      return "budget_day_opening_unobserved";
    }
  }
  return null;
}

const CAMPAIGN_REPAIR_FIELDS = [
  "objective", "optimizationGoal", "customEventType", "bidStrategyType",
  "bidValue", "bidValueFormat", "dailyBudget", "lifetimeBudget",
  "isBudgetMixed", "isConfigMixed", "isOptimizationGoalMixed", "isCustomEventTypeMixed",
  "isBidStrategyMixed", "isBidValueMixed",
] as const;
const ADSET_REPAIR_FIELDS = [
  "optimizationGoal", "customEventType", "pixelId", "customConversionId", "promotedObjectJson",
  "bidStrategyType",
  "bidValue", "bidValueFormat", "dailyBudget", "lifetimeBudget",
  "isBudgetMixed", "isConfigMixed", "isOptimizationGoalMixed", "isBidStrategyMixed", "isBidValueMixed",
] as const;
export interface MetaRepairManifestChange {
  scope: "campaign_daily" | "adset_daily";
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
  entityId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  source: {
    kind: "meta_config_snapshots" | "meta_raw_snapshots";
    id: string | null;
    observedAt: string | null;
    sourceSnapshotId?: string | null;
    /** The RECEIPT this value came from; see MetaConfigSnapshotPayload. */
    sourceObservationId?: string | null;
    entityUpdatedAt?: string | null;
    corroboratingSourceSnapshotId?: string | null;
    /** The RECEIPT that closed the day. Must differ from sourceObservationId. */
    corroboratingObservationId?: string | null;
    corroboratingObservedAt?: string | null;
    normalizationVersion?: number | null;
    observedFieldScope?: string[] | null;
  };
  reason: "missing_config_from_dated_raw_receipt";
}

function appendFieldChanges<T extends {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
}>(input: {
  changes: MetaRepairManifestChange[];
  /** Refused fields, reported beside the manifest rather than dropped silently. */
  withheld: MetaRepairWithheldField[];
  fields: readonly (keyof T & string)[];
  scope: MetaRepairManifestChange["scope"];
  entityId: string;
  oldRow: T | undefined;
  newRow: T;
  observation: MetaConfigSnapshotObservation | undefined;
  source: MetaRepairManifestChange["source"];
  reason: MetaRepairManifestChange["reason"];
}) {
  for (const field of input.fields) {
    const oldValue = input.oldRow?.[field] ?? null;
    const newValue = input.newRow[field] ?? null;
    if (Object.is(oldValue, newValue) ||
      (typeof oldValue === "object" && typeof newValue === "object" &&
        JSON.stringify(oldValue) === JSON.stringify(newValue))) continue;
    /*
      Per FIELD, not per receipt. A column this source may not date to this day
      is withheld and named; the rest of the entity-day still goes through. That
      is what keeps one unsupportable column from holding a whole business, and
      what stops it riding in on a proof that does not cover it.
    */
    const refusal = metaRepairFieldAdmission({
      field, source: input.observation, row: input.newRow,
    });
    if (refusal) {
      input.withheld.push({
        scope: input.scope,
        providerAccountId: input.newRow.providerAccountId,
        date: input.newRow.date,
        entityId: input.entityId,
        field,
        proposedValue: newValue,
        refusal,
      });
      continue;
    }
    input.changes.push({
      scope: input.scope,
      businessId: input.newRow.businessId,
      providerAccountId: input.newRow.providerAccountId,
      date: input.newRow.date,
      accountTimezone: input.newRow.accountTimezone,
      entityId: input.entityId,
      field,
      oldValue,
      newValue,
      source: input.source,
      reason: input.reason,
    });
  }
}

export async function repairMetaWarehouseTruthRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
  dryRun?: boolean;
  /** Required by the CLI apply path to bind the write to its reviewed manifest. */
  expectedManifestHash?: string;
}) {
  const [campaignRows, adsetRows] = await Promise.all([
    getMetaCampaignDailyRange(input),
    getMetaAdSetDailyRange(input),
  ]);
  const campaignSources = new Map<string, MetaConfigSnapshotObservation>();
  const adsetSources = new Map<string, MetaConfigSnapshotObservation>();
  const [candidateCampaignRows, candidateAdSetRows] = await Promise.all([
    repairCampaignRowsFromSnapshots({
      businessId: input.businessId,
      rows: campaignRows,
      onObservation: (key, source) => campaignSources.set(key, source),
    }),
    repairAdSetRowsFromSnapshots({
      businessId: input.businessId,
      rows: adsetRows,
      onObservation: (key, source) => adsetSources.set(key, source),
    }),
  ]);
  // A prior snapshot only proves what was observed on its capture day. It does
  // not prove the config remained unchanged on every later reporting day.
  const repairedCampaignRows = candidateCampaignRows.map((row, index) => {
    const source = campaignSources.get(`${row.providerAccountId}:${row.date}:${row.campaignId}`);
    return sourceProvesWholeProviderDay(source, row)
      ? row
      : campaignRows[index]!;
  });
  const repairedAdSetRows = candidateAdSetRows.map((row, index) => {
    const source = adsetSources.get(`${row.providerAccountId}:${row.date}:${row.adsetId}`);
    return sourceProvesWholeProviderDay(source, row)
      ? row
      : adsetRows[index]!;
  });
  const manifest: MetaRepairManifestChange[] = [];
  const withheld: MetaRepairWithheldField[] = [];
  for (const [index, row] of repairedCampaignRows.entries()) {
    const previous = campaignRows[index];
    if (!changedCampaignRow(row, previous)) continue;
    const source = campaignSources.get(`${row.providerAccountId}:${row.date}:${row.campaignId}`);
    appendFieldChanges({
      changes: manifest,
      withheld,
      fields: CAMPAIGN_REPAIR_FIELDS,
      scope: "campaign_daily",
      entityId: row.campaignId,
      oldRow: previous,
      newRow: row,
      observation: source,
      source: {
        kind: source?.sourceKind ?? "meta_config_snapshots",
        id: source?.id ?? null,
        observedAt: source?.providerObservation?.observedAt ?? null,
        sourceSnapshotId: source?.providerObservation?.sourceSnapshotId ?? null,
        sourceObservationId: source?.providerObservation?.sourceObservationId ?? null,
        entityUpdatedAt: source?.providerObservation?.entityUpdatedAt ?? null,
        corroboratingSourceSnapshotId: source?.providerObservation?.corroboratingSourceSnapshotId ?? null,
        corroboratingObservationId: source?.providerObservation?.corroboratingObservationId ?? null,
        corroboratingObservedAt: source?.providerObservation?.corroboratingObservedAt ?? null,
        normalizationVersion: source?.providerObservation?.normalizationVersion ?? null,
        observedFieldScope: source?.providerObservation?.observedFieldScope ?? null,
      },
      reason: "missing_config_from_dated_raw_receipt",
    });
  }
  for (const [index, row] of repairedAdSetRows.entries()) {
    const previous = adsetRows[index];
    if (!changedAdSetRow(row, previous)) continue;
    const source = adsetSources.get(`${row.providerAccountId}:${row.date}:${row.adsetId}`);
    appendFieldChanges({
      changes: manifest,
      withheld,
      fields: ADSET_REPAIR_FIELDS,
      scope: "adset_daily",
      entityId: row.adsetId,
      oldRow: previous,
      newRow: row,
      observation: source,
      source: {
        kind: source?.sourceKind ?? "meta_config_snapshots",
        id: source?.id ?? null,
        observedAt: source?.providerObservation?.observedAt ?? null,
        sourceSnapshotId: source?.providerObservation?.sourceSnapshotId ?? null,
        sourceObservationId: source?.providerObservation?.sourceObservationId ?? null,
        entityUpdatedAt: source?.providerObservation?.entityUpdatedAt ?? null,
        corroboratingSourceSnapshotId: source?.providerObservation?.corroboratingSourceSnapshotId ?? null,
        corroboratingObservationId: source?.providerObservation?.corroboratingObservationId ?? null,
        corroboratingObservedAt: source?.providerObservation?.corroboratingObservedAt ?? null,
        normalizationVersion: source?.providerObservation?.normalizationVersion ?? null,
        observedFieldScope: source?.providerObservation?.observedFieldScope ?? null,
      },
      reason: "missing_config_from_dated_raw_receipt",
    });
  }
  manifest.sort((a, b) =>
    [a.scope, a.businessId, a.providerAccountId, a.date, a.entityId, a.field].join(":")
      .localeCompare([b.scope, b.businessId, b.providerAccountId, b.date, b.entityId, b.field].join(":"))
  );
  withheld.sort((a, b) =>
    [a.scope, a.providerAccountId, a.date, a.entityId, a.field].join(":")
      .localeCompare([b.scope, b.providerAccountId, b.date, b.entityId, b.field].join(":"))
  );
  /*
    The hash still covers the MANIFEST alone. `withheld` is a report about what
    was not written, so folding it in would make the apply binding depend on
    fields the apply never touches, and every refusal would invalidate a
    reviewed hash.
  */
  const manifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  /*
    Counted from the MANIFEST, not from the candidate rows. A row all of whose
    changes were withheld contributes nothing to apply, and reporting it as
    "changed" was how a refusal could look like a write.
  */
  const changedEntityKeys = (scope: MetaRepairManifestChange["scope"]) =>
    new Set(manifest.filter((change) => change.scope === scope)
      .map((change) => [change.providerAccountId, change.date, change.entityId].join("\u0000"))).size;
  const withheldByReason: Record<string, number> = {};
  for (const entry of withheld) {
    withheldByReason[entry.refusal] = (withheldByReason[entry.refusal] ?? 0) + 1;
  }
  const summary = {
    accountRowsScanned: 0,
    campaignRowsScanned: campaignRows.length,
    adsetRowsScanned: adsetRows.length,
    accountRowsChanged: 0,
    campaignRowsChanged: changedEntityKeys("campaign_daily"),
    adsetRowsChanged: changedEntityKeys("adset_daily"),
    manifestHash,
    manifest,
    /** Source-backed fields this run refused to date, with the rule that refused them. */
    withheldFields: withheld,
    withheldByReason,
  };
  if (input.dryRun) return summary;
  if (input.expectedManifestHash && input.expectedManifestHash !== manifestHash &&
      manifest.length === 0) {
    const previous = await verifyPreviouslyAppliedMetaConfigRepair({
      manifestHash: input.expectedManifestHash,
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    if (previous) return { ...summary, ...previous };
  }
  if (!input.expectedManifestHash || input.expectedManifestHash !== manifestHash) {
    throw new Error("meta_repair_manifest_changed");
  }
  if (manifest.length === 0) {
    return { ...summary, rowsUpdated: 0, alreadyApplied: false };
  }
  if (manifest.some((change) =>
    (change.source.kind === "meta_config_snapshots" || change.source.kind === "meta_raw_snapshots") &&
    (!change.source.id || !change.source.sourceSnapshotId ||
      !change.source.corroboratingSourceSnapshotId || !change.source.corroboratingObservedAt ||
      change.source.normalizationVersion !== 2)
  )) {
    throw new Error("meta_repair_source_identity_missing");
  }
  /*
    The two RECEIPTS must be distinct on the apply path as well.
    `sourceProvesWholeProviderDay` already refuses such a day when the manifest
    is re-derived here, but this reads the manifest that is about to be written
    rather than the observation it was derived from, so a row that arrived with
    one receipt standing as both of its own witnesses cannot be applied even if
    it reached this function by some other route. Content ids may legitimately
    match — payload deduplication shares them across re-reads — so only the
    receipt ids are compared, and an unknown receipt id falls back to the
    content id rather than passing unchecked.
  */
  if (manifest.some((change) => isSameProviderReceipt(change.source))) {
    throw new Error("meta_repair_corroborator_is_the_source_receipt");
  }

  await applyMetaConfigRepairChanges(manifest, {
    manifestHash,
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
  });

  return summary;
}
