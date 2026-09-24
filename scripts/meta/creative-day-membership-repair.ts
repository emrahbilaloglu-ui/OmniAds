/**
 * Repair one historical creative-day from finalized Ad-day facts. Dry run is the
 * default. A dated, completely paginated Meta Insights read must agree at Ad
 * grain for Ad scope. Meta may restate prior spend/impressions after the
 * finalized Ad-day fact was captured; each difference is recorded, never used
 * to overwrite that versioned fact. A pre-day/state-history bracket must prove
 * EVERY decision-bearing Ad's provider creative ID. Current Ad creative detail
 * is never projected backward. A day with an unresolved or switched Ad blocks.
 *
 * Usage: node --import tsx scripts/meta/creative-day-membership-repair.ts
 *   --business <id> --account act_<id> --day YYYY-MM-DD
 *   [--knowledge-cutoff ISOZ] [--manifest-out path]
 *   [--apply --expected-manifest-hash sha256]
 * Apply also requires ADSECUTE_CREATIVE_DAY_REPAIR_APPLY=1.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { getDb, runDbTransaction } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import {
  buildMetaCreativeDayMetricEvidence,
  META_CREATIVE_DAY_METRIC_EVIDENCE_KEY,
  mergeMetaCreativeDayMetricEvidence,
  readMetaCreativeDayStageValue,
} from "@/lib/meta/creative-day-metric-evidence";
import { fetchAccountInsights, fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import {
  META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION,
} from "@/lib/meta/creatives-types";
import { readProvableAdCreativeIdentityForDays } from "@/lib/meta/creatives-warehouse";
import { getMetaAdDailyRange, getMetaCreativeDailyRange } from "@/lib/meta/warehouse";
import type { MetaInsightRecord } from "@/lib/meta/creatives-types";
import type { MetaAdDailyRow, MetaCreativeDailyRow } from "@/lib/meta/warehouse-types";
import { configureOperationalScriptRuntime } from "../_operational-runtime";

const CONTRACT = "adsecute.meta-creative-day-membership-repair.v2";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONFIG_COLUMNS = [
  "objective", "attribution_setting", "quality_ranking",
  "engagement_rate_ranking", "conversion_rate_ranking", "bid_strategy",
  "optimization_goal", "campaign_daily_budget", "adset_daily_budget",
  "campaign_lifetime_budget", "adset_lifetime_budget",
] as const;
const CONFIG_PROPERTIES = [
  "objective", "attributionSetting", "qualityRanking",
  "engagementRateRanking", "conversionRateRanking", "bidStrategy",
  "optimizationGoal", "campaignDailyBudget", "adsetDailyBudget",
  "campaignLifetimeBudget", "adsetLifetimeBudget",
] as const;

type Options = {
  businessId: string;
  accountId: string;
  day: string;
  knowledgeCutoffAt: string;
  apply: boolean;
  expectedManifestHash: string | null;
  manifestOut: string | null;
};
type SelectedAccountRefs = {
  businessRefId: string;
  providerAccountRefId: string;
};
export type CreativeRepairSourceSnapshot = {
  id: string; businessId: string; providerAccountId: string;
  startDate: string; endDate: string; endpointName: string;
  status: string; payloadHash: string;
};

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--apply") { apply = true; continue; }
    if (!arg?.startsWith("--") || !args[i + 1] || args[i + 1]?.startsWith("--")) {
      throw new Error(`invalid_argument:${arg ?? "missing"}`);
    }
    if (values.has(arg)) throw new Error(`duplicate_argument:${arg}`);
    values.set(arg, args[++i]!);
  }
  const businessId = values.get("--business")?.trim();
  const accountId = values.get("--account")?.trim();
  const day = values.get("--day")?.trim();
  const knowledgeCutoffAt = values.get("--knowledge-cutoff") ?? new Date().toISOString();
  if (!businessId || !accountId || !day || !DATE.test(day) ||
      new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day ||
      !Number.isFinite(Date.parse(knowledgeCutoffAt))) {
    throw new Error("required_scope_invalid:business_account_real_day_and_cutoff_required");
  }
  for (const key of values.keys()) {
    if (!["--business", "--account", "--day", "--knowledge-cutoff",
      "--expected-manifest-hash", "--manifest-out"].includes(key)) {
      throw new Error(`unknown_argument:${key}`);
    }
  }
  const expectedManifestHash = values.get("--expected-manifest-hash") ?? null;
  if (apply && (!expectedManifestHash || !/^[a-f0-9]{64}$/.test(expectedManifestHash) ||
      process.env.ADSECUTE_CREATIVE_DAY_REPAIR_APPLY !== "1")) {
    throw new Error("apply_requires_opt_in_and_reviewed_manifest_hash");
  }
  return { businessId, accountId, day, knowledgeCutoffAt, apply,
    expectedManifestHash, manifestOut: values.get("--manifest-out") ?? null };
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function measuredNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function decisionBearing(row: {
  spend?: unknown; impressions?: unknown; clicks?: unknown;
  conversions?: unknown; revenue?: unknown;
}): boolean {
  return [row.spend, row.impressions, row.clicks, row.conversions, row.revenue]
    .some((value) => (measuredNumber(value) ?? 0) > 0);
}

function adSourceKey(row: MetaAdDailyRow) {
  return JSON.stringify([row.providerAccountId, row.date, row.adId]);
}

function isAdFactAdmissible(row: MetaAdDailyRow, cutoff: string) {
  return row.truthState === "finalized" && row.validationStatus === "passed" &&
    typeof row.sourceRunId === "string" && row.sourceRunId.length > 0 &&
    Number.isFinite(Date.parse(row.finalizedAt ?? "")) &&
    Date.parse(row.finalizedAt!) < Date.parse(cutoff) &&
    Number.isFinite(Date.parse(row.createdAt ?? "")) &&
    Number.isFinite(Date.parse(row.updatedAt ?? "")) &&
    Date.parse(row.createdAt!) < Date.parse(cutoff) &&
    Date.parse(row.updatedAt!) < Date.parse(cutoff);
}

type Group = {
  creativeId: string;
  members: MetaAdDailyRow[];
  old: MetaCreativeDailyRow | null;
  needsWrite: boolean;
  next: {
    businessRefId: string; providerAccountRefId: string;
    accountTimezone: string; accountCurrency: string;
    campaignId: string | null; adsetId: string | null; adId: string | null;
    spend: number; impressions: number; clicks: number; reach: number;
    frequency: number | null;
    conversions: number; revenue: number; roas: number; cpa: number | null;
    ctr: number | null; cpc: number | null; linkClicks: number | null;
    outboundClicks: number | null; payloadJson: Record<string, unknown>;
    parentComplete: boolean;
  };
};

export function buildCreativeDayRepairPlan(input: {
  businessId: string; accountId: string; day: string; cutoff: string;
  selectedRefs: SelectedAccountRefs;
  adRows: MetaAdDailyRow[]; oldRows: MetaCreativeDailyRow[];
  providerRows: MetaInsightRecord[]; identityByAdDay: Map<string, string>;
  sourceLineageBySnapshot: Map<string, CreativeRepairSourceSnapshot>;
}) {
  const blockers: string[] = [];
  const providerRestatements: Array<{ reason: "provider_report_restatement_observed";
    adId: string; warehouse: {
    spend: number; impressions: number; clicks: number;
  }; provider: { spend: number | null; impressions: number | null;
    clicks: number | null } }> = [];
  const ads = input.adRows.filter((row) => row.providerAccountId === input.accountId && row.date === input.day);
  const oldRows = input.oldRows.filter((row) => row.providerAccountId === input.accountId && row.date === input.day);
  // Rebuilding membership invalidates any earlier config certification. Do
  // not silently erase a receipt-backed proof; that day needs a separate D098
  // review and recertification before a repair can be applied.
  for (const row of oldRows) {
    const payload = record(row.payloadJson);
    if (payload.historical_config_proof != null ||
        payload.historical_config_provenance === "provider_receipt_day_bracketed" ||
        payload.historical_config_provenance === "provider_receipt_legacy_bracketed") {
      blockers.push(`certified_config_requires_separate_revalidation:${row.creativeId}`);
    }
  }
  const provider = input.providerRows;
  const paidAds = ads.filter(decisionBearing);
  const providerPaid = provider.filter(decisionBearing);
  const providerById = new Map<string, MetaInsightRecord>();
  for (const row of provider) {
    const id = row.ad_id?.trim();
    if (!id || providerById.has(id) || row.date_start !== input.day) {
      blockers.push(`provider_row_scope_or_identity_invalid:${id ?? "missing"}`);
      continue;
    }
    providerById.set(id, row);
  }
  const paidIds = new Set(paidAds.map((row) => row.adId));
  const providerPaidIds = new Set(providerPaid.map((row) => row.ad_id?.trim()));
  if (paidIds.size !== paidAds.length || providerPaidIds.size !== providerPaid.length ||
      paidIds.size !== providerPaidIds.size ||
      [...paidIds].some((id) => !providerPaidIds.has(id))) {
    blockers.push("decision_bearing_ad_scope_mismatch");
  }
  for (const ad of paidAds) {
    if (!isAdFactAdmissible(ad, input.cutoff)) blockers.push(`ad_fact_not_finalized_at_cutoff:${ad.adId}`);
    const snapshot = ad.sourceSnapshotId
      ? input.sourceLineageBySnapshot.get(ad.sourceSnapshotId) : null;
    if (!snapshot || snapshot.businessId !== input.businessId ||
        snapshot.providerAccountId !== input.accountId ||
        snapshot.status !== "fetched" ||
        !snapshot.endpointName.startsWith("ad_insights") ||
        snapshot.startDate > input.day || snapshot.endDate < input.day ||
        !snapshot.payloadHash) {
      blockers.push(`ad_fact_source_snapshot_lineage_incomplete:${ad.adId}`);
    }
    if (!input.identityByAdDay.has(adSourceKey(ad))) blockers.push(`historical_creative_identity_unprovable:${ad.adId}`);
    const source = providerById.get(ad.adId);
    if (!source) { blockers.push(`provider_ad_missing:${ad.adId}`); continue; }
    const sourceSpend = measuredNumber(source.spend);
    const sourceImpressions = measuredNumber(source.impressions);
    const sourceClicks = measuredNumber(source.clicks);
    if (sourceSpend === null || sourceImpressions === null || sourceClicks === null) {
      blockers.push(`provider_ad_metric_invalid:${ad.adId}`);
    } else if (sourceSpend !== ad.spend ||
        sourceImpressions !== ad.impressions || sourceClicks !== ad.clicks) {
      providerRestatements.push({ reason: "provider_report_restatement_observed", adId: ad.adId,
        warehouse: { spend: ad.spend, impressions: ad.impressions, clicks: ad.clicks },
        provider: { spend: sourceSpend, impressions: sourceImpressions, clicks: sourceClicks } });
    }
  }
  if (paidAds.length === 0) blockers.push("no_decision_bearing_ad_days");
  if (ads.length > 2_000 || oldRows.length > 2_000 || provider.length > 2_000) {
    blockers.push("account_day_row_ceiling_exceeded");
  }
  const currencies = new Set(paidAds.map((row) => row.accountCurrency));
  const timezones = new Set(paidAds.map((row) => row.accountTimezone));
  if (currencies.size !== 1 || timezones.size !== 1 ||
      ![...currencies][0]?.trim() || ![...timezones][0]?.trim()) {
    blockers.push("account_context_missing_or_mixed");
  }
  if (blockers.length) return { status: "blocked" as const, blockers: [...new Set(blockers)].sort(),
    providerRestatements,
    scope: { businessId: input.businessId, accountId: input.accountId, day: input.day },
    counts: { adRows: ads.length, decisionBearingAdRows: paidAds.length,
      providerRows: provider.length, providerDecisionBearingRows: providerPaid.length,
      zeroOnlyAdRows: ads.length - paidAds.length, oldCreativeRows: oldRows.length } };

  const groupsById = new Map<string, MetaAdDailyRow[]>();
  for (const ad of paidAds) {
    const creativeId = input.identityByAdDay.get(adSourceKey(ad))!;
    const members = groupsById.get(creativeId) ?? [];
    members.push(ad);
    groupsById.set(creativeId, members);
  }
  const oldById = new Map(oldRows.map((row) => [row.creativeId, row]));
  const groups: Group[] = [...groupsById.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([creativeId, members]) => {
    members.sort((a, b) => a.adId.localeCompare(b.adId));
    const old = oldById.get(creativeId) ?? null;
    const campaigns = [...new Set(members.map((row) => row.campaignId).filter(Boolean))] as string[];
    const adsets = [...new Set(members.map((row) => row.adsetId).filter(Boolean))] as string[];
    const parentComplete = campaigns.length === 1 && adsets.length === 1 &&
      members.every((row) => row.campaignId === campaigns[0] && row.adsetId === adsets[0]);
    const sum = (get: (row: MetaAdDailyRow) => number) => members.reduce((n, row) => n + get(row), 0);
    const spend = sum((row) => row.spend), impressions = sum((row) => row.impressions);
    const clicks = sum((row) => row.clicks), reach = sum((row) => row.reach);
    // Ad reach cannot be deduplicated across Ads. Only a single Ad can carry
    // its measured frequency into a creative-day without inventing fatigue.
    const adFrequency = members.length === 1 ? members[0]!.frequency : null;
    const frequency = adFrequency != null && Number.isFinite(adFrequency) && adFrequency >= 0
      ? adFrequency : null;
    const conversions = sum((row) => row.conversions), revenue = sum((row) => row.revenue);
    const linkClicks = members.every((row) => row.linkClicks != null)
      ? sum((row) => row.linkClicks!) : null;
    const outboundClicks = members.every((row) => row.outboundClicks != null)
      ? sum((row) => row.outboundClicks!) : null;
    const evidences = members.map((row) => buildMetaCreativeDayMetricEvidence(record(row.payloadJson)));
    const metricEvidence = evidences.slice(1).reduce(
      (merged, evidence) => mergeMetaCreativeDayMetricEvidence(merged, evidence), evidences[0]!,
    );
    const stage = (key: "link_click" | "landing_page_view" | "add_to_cart" |
      "initiate_checkout" | "outbound_click") => readMetaCreativeDayStageValue(
        { [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: metricEvidence }, key,
      );
    const purchasesObserved = members.every((row) =>
      Array.isArray(record(row.payloadJson).actions));
    const { historical_config_proof: _staleConfigProof,
      ...oldPayloadWithoutConfigProof } = record(old?.payloadJson);
    const payload: Record<string, unknown> = { ...oldPayloadWithoutConfigProof,
      // Current Ad detail is not a historical status observation. In
      // particular, retaining a legacy ACTIVE value could authorize a
      // repaired day after its membership becomes source-certified.
      effective_status: null,
      source_ad_ids: members.map((row) => row.adId), source_ad_ids_complete: true,
      source_membership_scope: "decision_bearing_ad_days",
      source_creative_ids: [creativeId], associated_ads_count: members.length,
      source_identity_version: META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION,
      source_parent_grain_complete: parentComplete,
      source_campaign_ids: campaigns, source_adset_ids: adsets,
      historical_config_provenance: "unverified",
      reach_aggregation: members.length === 1
        ? "single_ad_provider_reach" : "sum_of_ad_reach_not_deduplicated",
      [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: metricEvidence,
      spend, impressions, clicks, reach, frequency, purchases: conversions,
      purchase_value: revenue,
      roas: spend > 0 ? revenue / spend : 0,
      cpa: conversions > 0 ? spend / conversions : null,
      ctr_all: impressions > 0 ? clicks / impressions * 100 : null,
      cpc_link: linkClicks != null && linkClicks > 0 ? spend / linkClicks : null,
      metric_presence: {
        ...record(record(old?.payloadJson).metric_presence),
        spend: true, impressions: true, clicks: true,
        frequency: frequency != null,
        purchases: purchasesObserved, purchase_value: purchasesObserved,
        roas: purchasesObserved && spend > 0,
        cpa: purchasesObserved && conversions > 0,
        link_clicks: linkClicks != null,
        landing_page_views: stage("landing_page_view") != null,
        add_to_cart: stage("add_to_cart") != null,
        initiate_checkout: stage("initiate_checkout") != null,
      },
      link_clicks: linkClicks, outbound_clicks: outboundClicks,
      landing_page_views: stage("landing_page_view"),
      add_to_cart: stage("add_to_cart"),
      initiate_checkout: stage("initiate_checkout"),
    };
    if (!parentComplete) {
      for (const key of ["campaign_id", "campaign_name", "adset_id", "adset_name",
        "objective", "effective_status", "attribution_setting", "bid_strategy",
        "optimization_goal", "campaign_daily_budget", "adset_daily_budget",
        "campaign_lifetime_budget", "adset_lifetime_budget"]) payload[key] = null;
    }
    const next = {
      businessRefId: input.selectedRefs.businessRefId,
      providerAccountRefId: input.selectedRefs.providerAccountRefId,
      accountTimezone: members[0]!.accountTimezone,
      accountCurrency: members[0]!.accountCurrency,
      campaignId: parentComplete ? campaigns[0]! : null,
      adsetId: parentComplete ? adsets[0]! : null,
      adId: members.length === 1 ? members[0]!.adId : null,
      spend, impressions, clicks, reach, frequency, conversions, revenue,
      roas: spend > 0 ? revenue / spend : 0,
      cpa: conversions > 0 ? spend / conversions : null,
      ctr: impressions > 0 ? clicks / impressions * 100 : null,
      cpc: linkClicks != null && linkClicks > 0 ? spend / linkClicks : null,
      linkClicks, outboundClicks, payloadJson: payload, parentComplete,
      effectiveStatus: null,
    };
    const comparableOld = old && {
      businessRefId: old.businessRefId ?? null,
      providerAccountRefId: old.providerAccountRefId ?? null,
      accountTimezone: old.accountTimezone,
      accountCurrency: old.accountCurrency,
      campaignId: old.campaignId, adsetId: old.adsetId, adId: old.adId,
      spend: old.spend, impressions: old.impressions, clicks: old.clicks,
      reach: old.reach, frequency: old.frequency,
      conversions: old.conversions, revenue: old.revenue,
      roas: old.roas, cpa: old.cpa, ctr: old.ctr, cpc: old.cpc,
      linkClicks: old.linkClicks ?? null, outboundClicks: old.outboundClicks ?? null,
      payloadJson: old.payloadJson,
      parentComplete: record(old.payloadJson).source_parent_grain_complete === true,
      effectiveStatus: old.effectiveStatus,
    };
    const configNeedsClear = !parentComplete && Boolean(old) && [
      old!.objective, old!.attributionSetting,
      old!.qualityRanking, old!.engagementRateRanking, old!.conversionRateRanking,
      old!.bidStrategy, old!.optimizationGoal, old!.campaignDailyBudget,
      old!.adsetDailyBudget, old!.campaignLifetimeBudget, old!.adsetLifetimeBudget,
    ].some((value) => value != null);
    return { creativeId, members, old, next,
      needsWrite: !old || configNeedsClear || old.effectiveStatus != null ||
        hash(comparableOld) !== hash(next) };
  });
  const stale = oldRows.filter((row) => !groupsById.has(row.creativeId) &&
    decisionBearing(row)).sort((a, b) => a.creativeId.localeCompare(b.creativeId));
  const snapshot = {
    ad: paidAds.map((row) => [row.adId, row.updatedAt, row.sourceSnapshotId,
      row.accountTimezone, row.accountCurrency, row.spend, row.impressions,
      row.clicks, row.frequency, row.conversions, row.revenue, hash(row.payloadJson)]),
    creative: oldRows.map((row) => [row.creativeId, row.updatedAt,
      row.businessRefId ?? null, row.providerAccountRefId ?? null,
      row.accountTimezone, row.accountCurrency, row.spend,
      row.impressions, row.clicks, row.frequency, hash(row.payloadJson)]),
  };
  const sourceLineage = [...new Set(paidAds.map((row) => row.sourceSnapshotId!))]
    .sort().map((id) => input.sourceLineageBySnapshot.get(id)!);
  const manifest = {
    contract: CONTRACT, scope: { businessId: input.businessId, accountId: input.accountId,
      day: input.day, knowledgeCutoffAt: input.cutoff },
    selectedRefs: input.selectedRefs,
    source: "finalized_meta_ad_daily_payload_plus_complete_dated_insights_and_provable_state_history",
    economicsAuthority: "stored_finalized_ad_day_source_snapshot",
    sourceLineage,
    providerRestatements,
    counts: { adRows: ads.length, decisionBearingAdRows: paidAds.length,
      providerRows: provider.length, providerDecisionBearingRows: providerPaid.length,
      zeroOnlyAdRows: ads.length - paidAds.length, oldCreativeRows: oldRows.length,
      newCreativeRows: groups.length, stalePositiveRows: stale.length },
    changes: [
      ...groups.filter((group) => group.needsWrite).map((group) => ({
        kind: group.old ? "update" : "insert",
        creativeId: group.creativeId, memberAdIds: group.members.map((row) => row.adId),
        crossParent: !group.next.parentComplete,
        reason: "finalized_ad_day_economics_with_complete_dated_provider_ad_scope_and_day_bracketed_identity",
        old: group.old,
        next: { ...(group.old ?? {}), ...group.next,
          ...(!group.next.parentComplete ? Object.fromEntries(CONFIG_PROPERTIES.map((column) =>
            [column, null])) : {}) } })),
      ...stale.map((row) => ({ kind: "delete", creativeId: row.creativeId,
        memberAdIds: [], crossParent: false,
        reason: "no_decision_bearing_ad_member_with_proven_provider_creative_identity",
        old: row, next: null })),
    ],
    preimageHash: hash(snapshot),
  };
  return { status: "ready" as const, manifest, manifestHash: hash(manifest),
    groups, stale, snapshot };
}

export function assertCreativeDayRepairReadback(rows: MetaCreativeDailyRow[], plan: Extract<
  ReturnType<typeof buildCreativeDayRepairPlan>, { status: "ready" }
>) {
  const byId = new Map(rows.map((row) => [row.creativeId, row]));
  const matchesNullableNumber = (actual: number | null, expected: number | null) =>
    actual === expected || (actual != null && expected != null &&
      Math.abs(actual - expected) <= 1e-8);
  const plannedIds = new Set(plan.groups.map((group) => group.creativeId));
  const unexpectedPositive = rows.find((row) => decisionBearing(row) && !plannedIds.has(row.creativeId));
  if (unexpectedPositive) {
    throw new Error(`creative_day_repair_unexpected_positive_row:${unexpectedPositive.creativeId}`);
  }
  for (const group of plan.groups) {
    const actual = byId.get(group.creativeId);
    const next = group.next;
    if (!actual || actual.businessRefId !== next.businessRefId ||
      actual.providerAccountRefId !== next.providerAccountRefId ||
      actual.accountTimezone !== next.accountTimezone ||
      actual.accountCurrency !== next.accountCurrency ||
      actual.campaignId !== next.campaignId ||
      actual.adsetId !== next.adsetId || actual.adId !== next.adId ||
      Math.abs(actual.spend - next.spend) > 1e-8 ||
      actual.impressions !== next.impressions || actual.clicks !== next.clicks ||
      actual.reach !== next.reach || actual.frequency !== next.frequency ||
      actual.conversions !== next.conversions ||
      Math.abs(actual.revenue - next.revenue) > 1e-8 ||
      Math.abs(actual.roas - next.roas) > 1e-8 ||
      !matchesNullableNumber(actual.cpa, next.cpa) ||
      !matchesNullableNumber(actual.ctr, next.ctr) ||
      !matchesNullableNumber(actual.cpc, next.cpc) ||
      actual.linkClicks !== next.linkClicks ||
      actual.outboundClicks !== next.outboundClicks ||
      actual.effectiveStatus != null ||
      (!next.parentComplete && CONFIG_PROPERTIES.some((property) => actual[property] != null)) ||
      hash(actual.payloadJson) !== hash(next.payloadJson)) {
      throw new Error(`creative_day_repair_readback_mismatch:${group.creativeId}`);
    }
  }
  for (const stale of plan.stale) {
    if (byId.has(stale.creativeId)) {
      throw new Error(`creative_day_repair_stale_readback_mismatch:${stale.creativeId}`);
    }
  }
  return { rowCount: rows.length, groupCount: plan.groups.length,
    remainingZeroOnlyLegacyRows: rows.filter((row) =>
      !plan.groups.some((group) => group.creativeId === row.creativeId)).length,
    readbackHash: hash(rows.map((row) => [row.creativeId, row.spend,
      row.impressions, row.clicks, row.payloadJson])) };
}

async function readSelectedMetaAccountRefs(
  businessId: string, accountId: string, lock: boolean,
): Promise<SelectedAccountRefs> {
  const rows = await getDb().query<{
    business_ref_id: string; provider_account_ref_id: string;
  }>(`SELECT b.id::text AS business_ref_id,
        p.id::text AS provider_account_ref_id
      FROM businesses b
      JOIN provider_accounts p ON p.provider='meta'
        AND p.external_account_id=$2
      JOIN business_provider_accounts binding
        ON binding.business_id=b.id::text AND binding.provider='meta'
        AND binding.provider_account_ref_id=p.id
        AND binding.provider_account_id=$2 AND binding.is_selected=TRUE
      WHERE b.id=$1::uuid${lock ? " FOR SHARE OF b, p, binding" : ""}`,
    [businessId, accountId]);
  if (rows.length !== 1) {
    throw new Error("creative_day_repair_normalized_reference_missing");
  }
  return {
    businessRefId: rows[0]!.business_ref_id,
    providerAccountRefId: rows[0]!.provider_account_ref_id,
  };
}

async function applyPlan(input: {
  options: Options;
  plan: Extract<ReturnType<typeof buildCreativeDayRepairPlan>, { status: "ready" }>;
}) {
  const { options, plan } = input;
  await runDbTransaction(async () => {
    const sql = getDb();
    // The receipt certifier takes this same account/day advisory lock before
    // acquiring a creative-row write lock. Match its order to avoid a lock
    // cycle if certification and a reviewed historical repair overlap.
    await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `meta_creative_daily:${options.businessId}:${options.accountId}:${options.day}`,
    ]);
    // The normal sync writer does not take this script's advisory lock. Briefly
    // block Ad/creative inserts while checking the preimage and replacing this
    // one day, so a new positive row cannot appear behind the range readback.
    await sql.query("LOCK TABLE meta_ad_daily, meta_creative_daily IN SHARE ROW EXCLUSIVE MODE");
    await sql.query(
      `SELECT ad_id FROM meta_ad_daily WHERE business_id=$1 AND provider_account_id=$2 AND date=$3::date FOR UPDATE`,
      [options.businessId, options.accountId, options.day],
    );
    await sql.query(
      `SELECT creative_id FROM meta_creative_daily WHERE business_id=$1 AND provider_account_id=$2 AND date=$3::date FOR UPDATE`,
      [options.businessId, options.accountId, options.day],
    );
    const sourceRows = await sql.query<{
      id: string; business_id: string; provider_account_id: string;
      start_date: string; end_date: string; endpoint_name: string;
      status: string; payload_hash: string;
    }>(`SELECT id::text AS id, business_id, provider_account_id,
        start_date::text AS start_date, end_date::text AS end_date,
        endpoint_name, status, payload_hash
      FROM meta_raw_snapshots WHERE id = ANY($1::uuid[]) FOR SHARE`,
      [plan.manifest.sourceLineage.map((row) => row.id)]);
    const sourceLineageNow = sourceRows.map((row) => ({
      id: row.id, businessId: row.business_id,
      providerAccountId: row.provider_account_id,
      startDate: row.start_date, endDate: row.end_date,
      endpointName: row.endpoint_name, status: row.status,
      payloadHash: row.payload_hash,
    })).sort((a, b) => a.id.localeCompare(b.id));
    if (hash(sourceLineageNow) !== hash(plan.manifest.sourceLineage)) {
      throw new Error("creative_day_repair_source_snapshot_lineage_drift");
    }
    // Both reads use the transaction-scoped client; do not issue concurrent
    // queries on one pg connection while holding the write locks.
    const ads = await getMetaAdDailyRange({
      businessId: options.businessId, providerAccountIds: [options.accountId],
      startDate: options.day, endDate: options.day,
    });
    const old = await getMetaCreativeDailyRange({
      businessId: options.businessId, providerAccountIds: [options.accountId],
      startDate: options.day, endDate: options.day,
    });
    const before = {
      ad: ads.filter(decisionBearing).map((row) => [row.adId, row.updatedAt,
        row.sourceSnapshotId, row.accountTimezone, row.accountCurrency,
        row.spend, row.impressions, row.clicks, row.frequency,
        row.conversions, row.revenue, hash(row.payloadJson)]),
      creative: old.map((row) => [row.creativeId, row.updatedAt,
        row.businessRefId ?? null, row.providerAccountRefId ?? null,
        row.accountTimezone, row.accountCurrency, row.spend,
        row.impressions, row.clicks, row.frequency, hash(row.payloadJson)]),
    };
    if (hash(before) !== plan.manifest.preimageHash) {
      throw new Error("creative_day_repair_preimage_drift");
    }
    // The normal warehouse writer binds both normalized references. A repair
    // insert that writes only the legacy text IDs is invisible to D101 and
    // lifecycle readers, even though a legacy range read appears correct.
    const refs = await readSelectedMetaAccountRefs(options.businessId,
      options.accountId, true);
    if (hash(refs) !== hash(plan.manifest.selectedRefs)) {
      throw new Error("creative_day_repair_selected_reference_drift");
    }
    for (const group of plan.groups.filter((group) => group.needsWrite)) {
      const next = group.next;
      if (group.old) {
        const clearedConfig = !next.parentComplete
          ? `, ${CONFIG_COLUMNS.map((column) => `${column}=NULL`).join(", ")}` : "";
        const rows = await sql.query<{ creative_id: string }>(
          `UPDATE meta_creative_daily SET business_ref_id=$24::uuid,
             provider_account_ref_id=$25::uuid,
             campaign_id=$5, adset_id=$6, ad_id=$7,
             spend=$8, impressions=$9, clicks=$10, reach=$11, conversions=$12,
             revenue=$13, roas=$14, cpa=$15, ctr=$16, cpc=$17,
             link_clicks=$18, outbound_clicks=$19, payload_json=$20::jsonb,
             account_timezone=$21, account_currency=$22, frequency=$23,
             effective_status=NULL, updated_at=now() ${clearedConfig}
           WHERE business_id=$1 AND provider_account_id=$2 AND date=$3::date
             AND creative_id=$4 RETURNING creative_id`,
          [options.businessId, options.accountId, options.day, group.creativeId,
            next.campaignId, next.adsetId, next.adId, next.spend, next.impressions,
            next.clicks, next.reach, next.conversions, next.revenue, next.roas,
            next.cpa, next.ctr, next.cpc, next.linkClicks, next.outboundClicks,
            JSON.stringify(next.payloadJson), next.accountTimezone,
            next.accountCurrency, next.frequency, refs.businessRefId,
            refs.providerAccountRefId],
        );
        if (rows.length !== 1) throw new Error(`creative_day_repair_update_mismatch:${group.creativeId}`);
      } else {
        const rows = await sql.query<{ creative_id: string }>(
          `INSERT INTO meta_creative_daily
           (business_id, business_ref_id, provider_account_id,
            provider_account_ref_id, date, creative_id, account_timezone,
            account_currency, campaign_id, adset_id, ad_id, spend, impressions,
            clicks, reach, conversions, revenue, roas, cpa, ctr, cpc, link_clicks,
            outbound_clicks, payload_json, frequency)
           VALUES ($1,$24::uuid,$2,$25::uuid,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23)
           ON CONFLICT DO NOTHING RETURNING creative_id`,
          [options.businessId, options.accountId, options.day, group.creativeId,
            next.accountTimezone, next.accountCurrency,
            next.campaignId, next.adsetId, next.adId, next.spend, next.impressions,
            next.clicks, next.reach, next.conversions, next.revenue, next.roas,
            next.cpa, next.ctr, next.cpc, next.linkClicks, next.outboundClicks,
            JSON.stringify(next.payloadJson), next.frequency,
            refs.businessRefId, refs.providerAccountRefId],
        );
        if (rows.length !== 1) throw new Error(`creative_day_repair_insert_conflict:${group.creativeId}`);
      }
    }
    for (const row of plan.stale) {
      const deleted = await sql.query<{ creative_id: string }>(
        `DELETE FROM meta_creative_daily WHERE business_id=$1 AND provider_account_id=$2
         AND date=$3::date AND creative_id=$4 RETURNING creative_id`,
        [options.businessId, options.accountId, options.day, row.creativeId],
      );
      if (deleted.length !== 1) throw new Error(`creative_day_repair_stale_delete_mismatch:${row.creativeId}`);
    }
    const inTransactionRows = await getMetaCreativeDailyRange({
      businessId: options.businessId, providerAccountIds: [options.accountId],
      startDate: options.day, endDate: options.day,
    });
    assertCreativeDayRepairReadback(inTransactionRows, plan);
    const normalized = await sql.query<{
      creative_id: string; business_ref_id: string | null;
      provider_account_ref_id: string | null; effective_status: string | null;
    }>(`SELECT creative_id, business_ref_id::text AS business_ref_id,
          provider_account_ref_id::text AS provider_account_ref_id,
          effective_status
        FROM meta_creative_daily
        WHERE business_id=$1 AND provider_account_id=$2 AND date=$3::date
          AND creative_id=ANY($4::text[])`,
      [options.businessId, options.accountId, options.day,
        plan.groups.map((group) => group.creativeId)]);
    if (normalized.length !== plan.groups.length || normalized.some((row) =>
      row.business_ref_id !== refs.businessRefId ||
      row.provider_account_ref_id !== refs.providerAccountRefId ||
      row.effective_status != null)) {
      throw new Error("creative_day_repair_reference_or_status_readback_mismatch");
    }
  });
  const publishedRows = await getMetaCreativeDailyRange({
    businessId: options.businessId, providerAccountIds: [options.accountId],
    startDate: options.day, endDate: options.day,
  });
  return assertCreativeDayRepairReadback(publishedRows, plan);
}

async function main() {
  configureOperationalScriptRuntime({ lane: "owner_maintenance" });
  const options = parseArgs(process.argv.slice(2));
  const integration = await getIntegration(options.businessId, "meta");
  if (integration?.status !== "connected" || !integration.access_token) {
    throw new Error("meta_integration_unavailable");
  }
  const assigned = await fetchAssignedAccountIds(options.businessId);
  if (!assigned.includes(options.accountId)) throw new Error("account_not_assigned_to_business");
  const [adRows, oldRows, providerRows, identityByAdDay, selectedRefs] = await Promise.all([
    getMetaAdDailyRange({ businessId: options.businessId, providerAccountIds: [options.accountId],
      startDate: options.day, endDate: options.day }),
    getMetaCreativeDailyRange({ businessId: options.businessId, providerAccountIds: [options.accountId],
      startDate: options.day, endDate: options.day }),
    fetchAccountInsights(options.accountId, integration.access_token, options.day, options.day,
      { strictComplete: true, includeRichFields: false }),
    readProvableAdCreativeIdentityForDays({ businessId: options.businessId,
      providerAccountId: options.accountId, start: options.day, end: options.day,
      knowledgeCutoffAt: options.knowledgeCutoffAt }),
    readSelectedMetaAccountRefs(options.businessId, options.accountId, false),
  ]);
  const snapshotIds = [...new Set(adRows.map((row) => row.sourceSnapshotId).filter(
    (id): id is string => typeof id === "string" && id.length > 0))];
  const sourceRows = snapshotIds.length
    ? await getDb().query<{
        id: string; business_id: string; provider_account_id: string;
        start_date: string; end_date: string; endpoint_name: string;
        status: string; payload_hash: string;
      }>(`SELECT id::text AS id, business_id, provider_account_id,
          start_date::text AS start_date, end_date::text AS end_date,
          endpoint_name, status, payload_hash
        FROM meta_raw_snapshots WHERE id = ANY($1::uuid[])`, [snapshotIds])
    : [];
  const sourceLineageBySnapshot = new Map(sourceRows.map((row) => [row.id, {
    id: row.id, businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    startDate: row.start_date, endDate: row.end_date,
    endpointName: row.endpoint_name, status: row.status,
    payloadHash: row.payload_hash,
  }]));
  const plan = buildCreativeDayRepairPlan({ businessId: options.businessId,
    accountId: options.accountId, day: options.day, cutoff: options.knowledgeCutoffAt,
    selectedRefs, adRows, oldRows, providerRows, identityByAdDay,
    sourceLineageBySnapshot });
  const report = plan.status === "ready"
    ? { status: plan.status, manifestHash: plan.manifestHash, manifest: plan.manifest }
    : plan;
  if (options.manifestOut) writeFileSync(options.manifestOut, `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" });
  let readback: ReturnType<typeof assertCreativeDayRepairReadback> | null = null;
  if (options.apply) {
    if (plan.status !== "ready") throw new Error(`creative_day_repair_blocked:${plan.blockers.join(",")}`);
    if (options.expectedManifestHash !== plan.manifestHash) {
      throw new Error("creative_day_repair_manifest_hash_mismatch");
    }
    readback = await applyPlan({ options, plan });
  }
  console.log(JSON.stringify({ ...report, applied: options.apply, readback }, null, 2));
}

if (process.argv[1]?.endsWith("creative-day-membership-repair.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
