import { createHash } from "node:crypto";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { getCurrentSchedulingAttemptId } from "@/lib/sync/scheduling-attempt";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import { getDb, getDbWithTimeout } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import {
  ensureProviderAccountReferenceIds,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";
import { refreshOverviewSummaryMaterializationFromGoogleAccountRows } from "@/lib/overview-summary-materializer";
import { clearAllProviderAccountAssignmentsForProvider } from "@/lib/provider-account-assignments";
import { clearAllProviderAccountSnapshotsForProvider } from "@/lib/provider-account-snapshots";
import { recordSyncReclaimEvents } from "@/lib/sync/worker-health";
import { disconnectAllIntegrationsForProvider } from "@/lib/integrations";
import type {
  ProviderReclaimDecision,
  ProviderReclaimDisposition,
} from "@/lib/sync/provider-orchestration";
import type {
  GoogleAdsPartitionStatus,
  GoogleAdsRawSnapshotRecord,
  GoogleAdsWarehouseIntegrityIncident,
  GoogleAdsRunnerLeaseRecord,
  GoogleAdsSyncLane,
  GoogleAdsSyncCheckpointRecord,
  GoogleAdsSyncJobRecord,
  GoogleAdsSyncPartitionRecord,
  GoogleAdsSyncRunRecord,
  GoogleAdsSyncStateRecord,
  GoogleAdsWarehouseDailyRow,
  GoogleAdsWarehouseDataState,
  GoogleAdsWarehouseFreshness,
  GoogleAdsWarehouseMetricSet,
  GoogleAdsWarehouseScope,
} from "@/lib/google-ads/warehouse-types";
import {
  applyCanonicalGoogleAdsProductFields,
  resolveCanonicalGoogleAdsProductTitle,
} from "@/lib/google-ads/product-name";
import { mergeGoogleAdsSyncStateWrite } from "@/lib/google-ads/sync-state-write";
import { computeCheckpointLagMinutes } from "@/lib/provider-readiness";
import {
  classifyGoogleAdsSyncFailure,
  type GoogleAdsDeadLetterRecoveryKind,
} from "@/lib/sync/google-ads-error-classification";
import {
  readGoogleAdsAdDimensions,
  readGoogleAdsAdGroupDimensions,
  readGoogleAdsAssetGroupDimensions,
  readGoogleAdsCampaignDimensions,
  readGoogleAdsKeywordDimensions,
  readGoogleAdsProductDimensions,
  type GoogleAdsAdDimensionRecord,
  type GoogleAdsAdGroupDimensionRecord,
  type GoogleAdsAssetGroupDimensionRecord,
  type GoogleAdsCampaignDimensionRecord,
  type GoogleAdsKeywordDimensionRecord,
  type GoogleAdsProductDimensionRecord,
} from "@/lib/google-ads/request-model-store";

type GoogleAdsClosedCheckpointGroup = {
  checkpointScope: string;
  previousPhase: string;
  count: number;
};

type GoogleAdsReclaimCandidateRow = {
  id: string;
  scope: string;
  lane: string;
  status: string;
  attempt_count: number;
  partition_lease_epoch: number;
  lease_owner: string | null;
  updated_at: string | null;
  started_at: string | null;
  lease_expires_at: string | null;
  checkpoint_scope: string | null;
  phase: string | null;
  page_index: number | null;
  checkpoint_attempt_count: number | null;
  checkpoint_status: string | null;
  progress_updated_at: string | null;
  checkpoint_lease_epoch: number;
  poisoned_at: string | null;
  poison_reason: string | null;
  same_phase_failures: number;
  has_active_runner_lease: boolean;
};

export type GoogleAdsPartitionAttemptCompletionResult =
  | {
      ok: true;
      runUpdated: boolean;
      closedRunningRunCount: number;
      callerRunIdWasClosed: boolean | null;
      closedRunningRunIds: string[];
      closedCheckpointGroups: GoogleAdsClosedCheckpointGroup[];
    }
  | {
      ok: false;
      reason: "lease_conflict";
    };

export type GoogleAdsCompletionDenialClassification =
  | "owner_mismatch"
  | "epoch_mismatch"
  | "lease_expired"
  | "already_terminal"
  | "unknown_denial";

export interface GoogleAdsPartitionCompletionDenialSnapshot {
  currentPartitionStatus: string | null;
  currentLeaseOwner: string | null;
  currentLeaseEpoch: number | null;
  currentLeaseExpiresAt: string | null;
  ownerMatchesCaller: boolean | null;
  epochMatchesCaller: boolean | null;
  leaseExpiredAtObservation: boolean | null;
  currentPartitionFinishedAt: string | null;
  latestCheckpointScope: string | null;
  latestCheckpointPhase: string | null;
  latestCheckpointUpdatedAt: string | null;
  latestRunningRunId: string | null;
  runningRunCount: number;
  denialClassification: GoogleAdsCompletionDenialClassification;
}

const GOOGLE_SCOPE_TABLES: Record<GoogleAdsWarehouseScope, string> = {
  account_daily: "google_ads_account_daily",
  campaign_daily: "google_ads_campaign_daily",
  ad_group_daily: "google_ads_ad_group_daily",
  ad_daily: "google_ads_ad_daily",
  keyword_daily: "google_ads_keyword_daily",
  search_term_daily: "google_ads_search_term_daily",
  asset_group_daily: "google_ads_asset_group_daily",
  asset_daily: "google_ads_asset_daily",
  audience_daily: "google_ads_audience_daily",
  geo_daily: "google_ads_geo_daily",
  device_daily: "google_ads_device_daily",
  product_daily: "google_ads_product_daily",
};

const GOOGLE_ADS_MUTATION_TABLES = [
  "google_ads_sync_jobs",
  "google_ads_sync_partitions",
  "google_ads_sync_runs",
  "google_ads_sync_checkpoints",
  "google_ads_sync_state",
  "google_ads_raw_snapshots",
  "google_ads_account_daily",
  "google_ads_campaign_daily",
  "google_ads_ad_group_daily",
  "google_ads_ad_daily",
  "google_ads_keyword_daily",
  "google_ads_search_term_daily",
  "google_ads_asset_group_daily",
  "google_ads_asset_daily",
  "google_ads_audience_daily",
  "google_ads_geo_daily",
  "google_ads_device_daily",
  "google_ads_product_daily",
  "google_ads_campaign_dimensions",
  "google_ads_campaign_state_history",
  "google_ads_ad_group_dimensions",
  "google_ads_ad_group_state_history",
  "google_ads_ad_dimensions",
  "google_ads_keyword_dimensions",
  "google_ads_asset_group_dimensions",
  "google_ads_product_dimensions",
] as const;

async function resolveGoogleAdsControlPlaneReferenceIds(input: {
  businessId: string;
  providerAccountId: string;
  accountName?: string | null;
  accountCurrency?: string | null;
  accountTimezone?: string | null;
}) {
  const [businessRefIds, providerAccountRefIds] = await Promise.all([
    resolveBusinessReferenceIds([input.businessId]),
    ensureProviderAccountReferenceIds({
      provider: "google",
      accounts: [
        {
          externalAccountId: input.providerAccountId,
          accountName: input.accountName ?? null,
          currency: input.accountCurrency ?? null,
          timezone: input.accountTimezone ?? null,
        },
      ],
    }),
  ]);

  return {
    businessRefId: businessRefIds.get(input.businessId) ?? null,
    providerAccountRefId:
      providerAccountRefIds.get(input.providerAccountId) ?? null,
  };
}

function normalizeDate(value: unknown) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
    const parsed = new Date(trimmed);
    if (Number.isFinite(parsed.getTime())) {
      const year = parsed.getFullYear();
      const month = String(parsed.getMonth() + 1).padStart(2, "0");
      const day = String(parsed.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    return trimmed.slice(0, 10);
  }
  const parsed = new Date(String(value ?? ""));
  if (Number.isFinite(parsed.getTime())) {
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value ?? "").slice(0, 10);
}

function normalizeTimestamp(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString();
  }
  return text;
}

function tableNameForScope(scope: GoogleAdsWarehouseScope) {
  return GOOGLE_SCOPE_TABLES[scope];
}

async function assertGoogleAdsRequestReadTablesReady(
  tables: string[],
  context: string,
) {
  await assertDbSchemaReady({
    tables,
    context,
  });
}

async function assertGoogleAdsMutationTablesReady(context: string) {
  await assertDbSchemaReady({
    tables: [...GOOGLE_ADS_MUTATION_TABLES],
    context,
  });
}

function buildGoogleAdsScopeLeasePrioritySql() {
  return `
    CASE scope
      WHEN 'search_term_daily' THEN 100
      WHEN 'product_daily' THEN 95
      WHEN 'asset_group_daily' THEN 90
      WHEN 'asset_daily' THEN 85
      WHEN 'geo_daily' THEN 80
      WHEN 'device_daily' THEN 75
      WHEN 'audience_daily' THEN 70
      WHEN 'ad_daily' THEN 40
      WHEN 'ad_group_daily' THEN 35
      WHEN 'keyword_daily' THEN 30
      WHEN 'campaign_daily' THEN 20
      WHEN 'account_daily' THEN 10
      ELSE 0
    END
  `;
}

function buildGoogleAdsSourceLeasePrioritySql() {
  return `
    CASE source
      WHEN 'selected_range' THEN 120
      WHEN 'finalize_day' THEN 118
      WHEN 'today' THEN 115
      WHEN 'recent' THEN 110
      WHEN 'core_success' THEN 105
      WHEN 'recent_recovery' THEN 100
      -- Below genuinely-missing recent work, above backfill: a stale-but-present
      -- date matters less than a gap, and more than history.
      WHEN 'freshness_refresh' THEN 60
      WHEN 'historical' THEN 20
      WHEN 'core_historical_recovery' THEN 18
      WHEN 'historical_recovery' THEN 15
      ELSE 0
    END
  `;
}

function toNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseNullableBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function parseStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        typeof entry === "string" ? entry : String(entry ?? "").trim(),
      )
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    try {
      return parseStringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function parseGoogleAdsClosedCheckpointGroups(
  raw: unknown,
): GoogleAdsClosedCheckpointGroup[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        return {
          checkpointScope: String(
            record.checkpointScope ?? record.checkpoint_scope ?? "",
          ),
          previousPhase: String(
            record.previousPhase ?? record.previous_phase ?? "",
          ),
          count: toNumber(record.count ?? record.row_count),
        } satisfies GoogleAdsClosedCheckpointGroup;
      })
      .filter((entry): entry is GoogleAdsClosedCheckpointGroup =>
        Boolean(entry?.checkpointScope),
      );
  }
  if (typeof raw === "string") {
    try {
      return parseGoogleAdsClosedCheckpointGroups(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

function withinGoogleAdsIntegrityTolerance(expected: number, actual: number) {
  const tolerance = Math.max(0.01, Math.abs(expected) * 0.001);
  return Math.abs(expected - actual) <= tolerance;
}

function buildGoogleAdsIntegrityDelta(input: {
  account: number | null;
  campaign: number | null;
}) {
  return {
    account: input.account,
    campaign: input.campaign,
    delta:
      input.account == null || input.campaign == null
        ? null
        : Number((input.account - input.campaign).toFixed(2)),
  };
}

type GoogleAdsDimensionScope =
  | "campaign_daily"
  | "ad_group_daily"
  | "ad_daily"
  | "keyword_daily"
  | "asset_group_daily"
  | "product_daily";

type GoogleAdsEntityRowBase = {
  entityKey: string;
  entityLabel: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adGroupId: string | null;
  adGroupName: string | null;
  status: string | null;
  channel: string | null;
  classification: string | null;
  payloadJson?: unknown;
};

type GoogleAdsDimensionReferenceContext = {
  campaigns: Map<string, GoogleAdsCampaignDimensionRecord>;
  adGroups: Map<string, GoogleAdsAdGroupDimensionRecord>;
  ads: Map<string, GoogleAdsAdDimensionRecord>;
  keywords: Map<string, GoogleAdsKeywordDimensionRecord>;
  assetGroups: Map<string, GoogleAdsAssetGroupDimensionRecord>;
  products: Map<string, GoogleAdsProductDimensionRecord>;
};

function normalizeGoogleAdsProjectionJson(
  row: Pick<
    GoogleAdsWarehouseDailyRow,
    | "entityKey"
    | "entityLabel"
    | "campaignId"
    | "campaignName"
    | "adGroupId"
    | "adGroupName"
    | "status"
    | "channel"
    | "classification"
    | "payloadJson"
  >,
) {
  const payload = asObject(row.payloadJson);
  const projection: Record<string, unknown> = {
    ...payload,
    id: payload.id ?? row.entityKey,
    name: payload.name ?? row.entityLabel ?? row.entityKey,
    campaignId: payload.campaignId ?? row.campaignId ?? null,
    campaignName: payload.campaignName ?? row.campaignName ?? null,
    adGroupId: payload.adGroupId ?? row.adGroupId ?? null,
    adGroupName: payload.adGroupName ?? row.adGroupName ?? null,
    status: payload.status ?? row.status ?? null,
    channel: payload.channel ?? row.channel ?? null,
    classification: payload.classification ?? row.classification ?? null,
  };
  return projection;
}

function buildGoogleAdsHistoryCapturedAt(row: {
  date: string;
  updatedAt?: string | null;
}) {
  return normalizeTimestamp(row.updatedAt) ?? `${normalizeDate(row.date)}T00:00:00.000Z`;
}

function buildGoogleAdsStateFingerprint(input: {
  name: string | null;
  normalizedStatus: string | null;
  channel?: string | null;
  projectionJson: unknown;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: input.name ?? null,
        normalizedStatus: input.normalizedStatus ?? null,
        channel: input.channel ?? null,
        projectionJson: asObject(input.projectionJson),
      }),
    )
    .digest("hex");
}

function isGoogleAdsDimensionScope(
  scope: GoogleAdsWarehouseScope,
): scope is GoogleAdsDimensionScope {
  return (
    scope === "campaign_daily" ||
    scope === "ad_group_daily" ||
    scope === "ad_daily" ||
    scope === "keyword_daily" ||
    scope === "asset_group_daily" ||
    scope === "product_daily"
  );
}

function scopeEntityId(scope: GoogleAdsDimensionScope, row: GoogleAdsEntityRowBase) {
  switch (scope) {
    case "campaign_daily":
      return row.campaignId ?? row.entityKey;
    case "ad_group_daily":
      return row.adGroupId ?? row.entityKey;
    case "ad_daily":
    case "keyword_daily":
    case "asset_group_daily":
    case "product_daily":
      return row.entityKey;
  }
}

async function loadGoogleAdsDimensionReferenceContext(input: {
  scope: GoogleAdsDimensionScope;
  businessId: string;
  rows: GoogleAdsEntityRowBase[];
}): Promise<GoogleAdsDimensionReferenceContext> {
  const campaigns = new Map<string, GoogleAdsCampaignDimensionRecord>();
  const adGroups = new Map<string, GoogleAdsAdGroupDimensionRecord>();
  const ads = new Map<string, GoogleAdsAdDimensionRecord>();
  const keywords = new Map<string, GoogleAdsKeywordDimensionRecord>();
  const assetGroups = new Map<string, GoogleAdsAssetGroupDimensionRecord>();
  const products = new Map<string, GoogleAdsProductDimensionRecord>();

  const entityIds = Array.from(
    new Set(input.rows.map((row) => scopeEntityId(input.scope, row)).filter(Boolean)),
  );
  const initialCampaignIds = new Set(
    input.rows.map((row) => row.campaignId).filter((value): value is string => Boolean(value)),
  );
  const initialAdGroupIds = new Set(
    input.rows.map((row) => row.adGroupId).filter((value): value is string => Boolean(value)),
  );

  if (input.scope === "campaign_daily") {
    for (const row of await readGoogleAdsCampaignDimensions({
      businessId: input.businessId,
      campaignIds: entityIds,
    })) {
      campaigns.set(row.campaignId, row);
    }
  }

  if (input.scope === "ad_group_daily") {
    for (const row of await readGoogleAdsAdGroupDimensions({
      businessId: input.businessId,
      adGroupIds: entityIds,
    })) {
      adGroups.set(row.adGroupId, row);
      if (row.campaignId) initialCampaignIds.add(row.campaignId);
    }
  }

  if (input.scope === "ad_daily") {
    for (const row of await readGoogleAdsAdDimensions({
      businessId: input.businessId,
      adIds: entityIds,
    })) {
      ads.set(row.adId, row);
      if (row.campaignId) initialCampaignIds.add(row.campaignId);
      if (row.adGroupId) initialAdGroupIds.add(row.adGroupId);
    }
  }

  if (input.scope === "keyword_daily") {
    for (const row of await readGoogleAdsKeywordDimensions({
      businessId: input.businessId,
      keywordIds: entityIds,
    })) {
      keywords.set(row.keywordId, row);
      if (row.campaignId) initialCampaignIds.add(row.campaignId);
      if (row.adGroupId) initialAdGroupIds.add(row.adGroupId);
    }
  }

  if (input.scope === "asset_group_daily") {
    for (const row of await readGoogleAdsAssetGroupDimensions({
      businessId: input.businessId,
      assetGroupIds: entityIds,
    })) {
      assetGroups.set(row.assetGroupId, row);
      if (row.campaignId) initialCampaignIds.add(row.campaignId);
    }
  }

  if (input.scope === "product_daily") {
    for (const row of await readGoogleAdsProductDimensions({
      businessId: input.businessId,
      productKeys: entityIds,
    })) {
      products.set(row.productKey, row);
      if (row.campaignId) initialCampaignIds.add(row.campaignId);
    }
  }

  if (initialAdGroupIds.size > 0 && adGroups.size === 0 && input.scope !== "ad_group_daily") {
    for (const row of await readGoogleAdsAdGroupDimensions({
      businessId: input.businessId,
      adGroupIds: Array.from(initialAdGroupIds),
    })) {
      adGroups.set(row.adGroupId, row);
      if (row.campaignId) initialCampaignIds.add(row.campaignId);
    }
  }

  if (initialCampaignIds.size > 0 && campaigns.size === 0 && input.scope !== "campaign_daily") {
    for (const row of await readGoogleAdsCampaignDimensions({
      businessId: input.businessId,
      campaignIds: Array.from(initialCampaignIds),
    })) {
      campaigns.set(row.campaignId, row);
    }
  }

  return {
    campaigns,
    adGroups,
    ads,
    keywords,
    assetGroups,
    products,
  };
}

function applyGoogleAdsDimensionOverlay(
  scope: GoogleAdsDimensionScope,
  row: GoogleAdsEntityRowBase,
  context: GoogleAdsDimensionReferenceContext,
) {
  const basePayload = asObject(row.payloadJson);
  const campaign =
    row.campaignId && context.campaigns.has(row.campaignId)
      ? context.campaigns.get(row.campaignId)!
      : null;
  const adGroup =
    row.adGroupId && context.adGroups.has(row.adGroupId)
      ? context.adGroups.get(row.adGroupId)!
      : null;

  if (scope === "campaign_daily") {
    const dimension = context.campaigns.get(scopeEntityId(scope, row));
    return {
      ...row,
      entityLabel: dimension?.campaignName ?? row.entityLabel,
      campaignId: dimension?.campaignId ?? row.campaignId ?? row.entityKey,
      campaignName: dimension?.campaignName ?? row.campaignName,
      status: dimension?.normalizedStatus ?? row.status,
      channel: dimension?.channel ?? row.channel,
      payloadJson:
        dimension?.projectionJson && Object.keys(asObject(dimension.projectionJson)).length > 0
          ? dimension.projectionJson
          : basePayload,
    };
  }

  if (scope === "ad_group_daily") {
    const dimension = context.adGroups.get(scopeEntityId(scope, row));
    return {
      ...row,
      entityLabel: dimension?.adGroupName ?? row.entityLabel,
      campaignId: dimension?.campaignId ?? row.campaignId,
      campaignName:
        (dimension?.campaignId ? context.campaigns.get(dimension.campaignId)?.campaignName : null) ??
        campaign?.campaignName ??
        row.campaignName,
      adGroupId: dimension?.adGroupId ?? row.adGroupId ?? row.entityKey,
      adGroupName: dimension?.adGroupName ?? row.adGroupName,
      status: dimension?.normalizedStatus ?? row.status,
      payloadJson:
        dimension?.projectionJson && Object.keys(asObject(dimension.projectionJson)).length > 0
          ? dimension.projectionJson
          : basePayload,
    };
  }

  if (scope === "ad_daily") {
    const dimension = context.ads.get(scopeEntityId(scope, row));
    const dimensionAdGroup =
      dimension?.adGroupId ? context.adGroups.get(dimension.adGroupId) ?? adGroup : adGroup;
    const dimensionCampaign =
      dimension?.campaignId ? context.campaigns.get(dimension.campaignId) ?? campaign : campaign;
    return {
      ...row,
      entityLabel: dimension?.adName ?? row.entityLabel,
      campaignId: dimension?.campaignId ?? row.campaignId,
      campaignName: dimensionCampaign?.campaignName ?? row.campaignName,
      adGroupId: dimension?.adGroupId ?? row.adGroupId,
      adGroupName: dimensionAdGroup?.adGroupName ?? row.adGroupName,
      status: dimension?.normalizedStatus ?? row.status,
      payloadJson:
        dimension?.projectionJson && Object.keys(asObject(dimension.projectionJson)).length > 0
          ? dimension.projectionJson
          : basePayload,
    };
  }

  if (scope === "keyword_daily") {
    const dimension = context.keywords.get(scopeEntityId(scope, row));
    const dimensionAdGroup =
      dimension?.adGroupId ? context.adGroups.get(dimension.adGroupId) ?? adGroup : adGroup;
    const dimensionCampaign =
      dimension?.campaignId ? context.campaigns.get(dimension.campaignId) ?? campaign : campaign;
    return {
      ...row,
      entityLabel: dimension?.keywordText ?? row.entityLabel,
      campaignId: dimension?.campaignId ?? row.campaignId,
      campaignName: dimensionCampaign?.campaignName ?? row.campaignName,
      adGroupId: dimension?.adGroupId ?? row.adGroupId,
      adGroupName: dimensionAdGroup?.adGroupName ?? row.adGroupName,
      status: dimension?.normalizedStatus ?? row.status,
      payloadJson:
        dimension?.projectionJson && Object.keys(asObject(dimension.projectionJson)).length > 0
          ? dimension.projectionJson
          : basePayload,
    };
  }

  if (scope === "asset_group_daily") {
    const dimension = context.assetGroups.get(scopeEntityId(scope, row));
    const dimensionCampaign =
      dimension?.campaignId ? context.campaigns.get(dimension.campaignId) ?? campaign : campaign;
    return {
      ...row,
      entityLabel: dimension?.assetGroupName ?? row.entityLabel,
      campaignId: dimension?.campaignId ?? row.campaignId,
      campaignName: dimensionCampaign?.campaignName ?? row.campaignName,
      status: dimension?.normalizedStatus ?? row.status,
      payloadJson:
        dimension?.projectionJson && Object.keys(asObject(dimension.projectionJson)).length > 0
          ? dimension.projectionJson
          : basePayload,
    };
  }

  const dimension = context.products.get(scopeEntityId(scope, row));
  const dimensionCampaign =
    dimension?.campaignId ? context.campaigns.get(dimension.campaignId) ?? campaign : campaign;
  const productPayload =
    dimension?.projectionJson && Object.keys(asObject(dimension.projectionJson)).length > 0
      ? dimension.projectionJson
      : basePayload;
  const canonicalProductTitle = resolveCanonicalGoogleAdsProductTitle({
    dimensionProductTitle: dimension?.productTitle ?? null,
    payload: productPayload,
    entityLabel: row.entityLabel,
    entityKey: row.entityKey,
  });
  return {
    ...row,
    entityLabel: canonicalProductTitle || row.entityLabel,
    campaignId: dimension?.campaignId ?? row.campaignId,
    campaignName: dimensionCampaign?.campaignName ?? row.campaignName,
    status: dimension?.normalizedStatus ?? row.status,
    payloadJson: applyCanonicalGoogleAdsProductFields({
      row: asObject(productPayload),
      dimensionProductTitle: dimension?.productTitle ?? null,
      payload: productPayload,
      entityLabel: row.entityLabel,
      entityKey: row.entityKey,
    }),
  };
}

async function overlayGoogleAdsDimensionRows<T extends GoogleAdsEntityRowBase>(input: {
  scope: GoogleAdsWarehouseScope;
  businessId: string;
  rows: T[];
}) {
  const scope = input.scope;
  if (!isGoogleAdsDimensionScope(scope) || input.rows.length === 0) {
    return input.rows;
  }

  const context = await loadGoogleAdsDimensionReferenceContext({
    scope,
    businessId: input.businessId,
    rows: input.rows,
  });

  return input.rows.map((row) =>
    applyGoogleAdsDimensionOverlay(scope, row, context),
  ) as T[];
}

function classifyGoogleAdsReclaimCandidate(input: {
  row: GoogleAdsReclaimCandidateRow;
  nowMs: number;
  staleThresholdMs: number;
}): ProviderReclaimDecision | null {
  const { row, nowMs, staleThresholdMs } = input;
  const progressMs = parseTimestampMs(row.progress_updated_at);
  const leaseMs = parseTimestampMs(
    row.lease_expires_at ?? row.started_at ?? row.updated_at,
  );
  const startedMs = parseTimestampMs(row.started_at ?? row.updated_at);
  const updatedMs = parseTimestampMs(row.updated_at);
  const orphanedLeaseGraceMs = Math.min(staleThresholdMs, 90_000);
  const hasRecentProgress =
    progressMs != null && nowMs - progressMs <= staleThresholdMs;
  const hasActiveRunnerLease = Boolean(row.has_active_runner_lease);
  const samePhaseFailures = toNumber(row.same_phase_failures);
  const checkpointAttempts = toNumber(row.checkpoint_attempt_count);
  const checkpointScope =
    row.checkpoint_scope != null ? String(row.checkpoint_scope) : null;
  const partitionLeaseEpoch = toNumber(row.partition_lease_epoch);
  const checkpointLeaseEpoch = toNumber(row.checkpoint_lease_epoch);
  const checkpointEpochMatches =
    checkpointScope == null || checkpointLeaseEpoch === partitionLeaseEpoch;
  const leaseExpired = leaseMs != null && nowMs - leaseMs > 0;
  const leaseNotExpired = leaseMs != null && leaseMs > nowMs;
  const updatedStale = updatedMs != null && nowMs - updatedMs > 60_000;
  const partitionAgeMs = startedMs == null ? null : nowMs - startedMs;
  const leaseWithoutWorkerAgeMs =
    startedMs != null
      ? nowMs - startedMs
      : updatedMs != null
        ? nowMs - updatedMs
        : null;
  const orphanedLiveLease =
    checkpointEpochMatches &&
    leaseNotExpired &&
    !hasRecentProgress &&
    !hasActiveRunnerLease &&
    leaseWithoutWorkerAgeMs != null &&
    leaseWithoutWorkerAgeMs > orphanedLeaseGraceMs;

  if (row.poisoned_at) {
    return {
      disposition: "poison_candidate",
      reasonCode: "poison_checkpoint_detected",
      detail: row.poison_reason
        ? String(row.poison_reason)
        : "Checkpoint already marked as poison candidate.",
    };
  }
  if (
    checkpointEpochMatches &&
    !hasRecentProgress &&
    (samePhaseFailures >= 3 || checkpointAttempts >= 3)
  ) {
    return {
      disposition: "poison_candidate",
      reasonCode: "same_phase_reentry_limit",
      detail: `Checkpoint phase ${String(row.phase ?? "unknown")} repeatedly failed without progress.`,
    };
  }
  if (checkpointEpochMatches && hasRecentProgress) {
    return {
      disposition: "alive_slow",
      reasonCode: "progress_recently_advanced",
      detail: "Recent checkpoint progress detected; keeping partition leased.",
    };
  }
  if (checkpointEpochMatches && hasActiveRunnerLease) {
    return {
      disposition: "alive_slow",
      reasonCode: "active_worker_lease_present",
      detail: "Runner lease is still active for this lane.",
    };
  }
  if (orphanedLiveLease) {
    return {
      disposition: "stalled_reclaimable",
      reasonCode: "runner_lease_missing_no_progress",
      detail:
        "Partition lease remained active without a matching runner lease or checkpoint progress.",
    };
  }
  if (leaseExpired && updatedStale) {
    return {
      disposition: "stalled_reclaimable",
      reasonCode: "worker_offline_no_progress",
      detail: "Lease expired and no recent runner/progress heartbeat remained.",
    };
  }
  if (leaseExpired) {
    return {
      disposition: "stalled_reclaimable",
      reasonCode: "lease_expired_no_progress",
      detail: "Partition lease expired without recent checkpoint progress.",
    };
  }
  return null;
}

async function readGoogleAdsReclaimCandidates(input: { businessId: string }) {
  const sql = getDb();
  return (await sql`
    SELECT
      partition.id,
      partition.scope,
      partition.lane,
      partition.status,
      partition.attempt_count,
      COALESCE(partition.lease_epoch, 0) AS partition_lease_epoch,
      partition.lease_owner,
      partition.updated_at,
      partition.started_at,
      partition.lease_expires_at,
      checkpoint.checkpoint_scope,
      checkpoint.phase,
      checkpoint.page_index,
      checkpoint.attempt_count AS checkpoint_attempt_count,
      checkpoint.status AS checkpoint_status,
      COALESCE(checkpoint.progress_heartbeat_at, checkpoint.updated_at) AS progress_updated_at,
      COALESCE(checkpoint.lease_epoch, 0) AS checkpoint_lease_epoch,
      checkpoint.poisoned_at,
      checkpoint.poison_reason,
      COALESCE(failures.same_phase_failures, 0) AS same_phase_failures,
      EXISTS (
        SELECT 1
        FROM sync_runner_leases lease
        WHERE lease.business_id = partition.business_id
          AND lease.provider_scope = 'google_ads'
          AND lease.lease_owner = partition.lease_owner
          AND lease.lease_expires_at > now()
      ) OR EXISTS (
        SELECT 1
        FROM google_ads_runner_leases lease
        WHERE lease.business_id = partition.business_id
          AND lease.lane = partition.lane
          AND lease.lease_owner = partition.lease_owner
          AND lease.lease_expires_at > now()
      ) AS has_active_runner_lease
    FROM google_ads_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT *
      FROM google_ads_sync_checkpoints checkpoint
      WHERE checkpoint.partition_id = partition.id
      ORDER BY checkpoint.updated_at DESC
      LIMIT 1
    ) checkpoint ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS same_phase_failures
      FROM google_ads_sync_checkpoints failed
      WHERE failed.partition_id = partition.id
        AND failed.phase = checkpoint.phase
        AND failed.status = 'failed'
    ) failures ON TRUE
    WHERE partition.business_id = ${input.businessId}
      AND partition.status IN ('leased', 'running')
  `) as GoogleAdsReclaimCandidateRow[];
}

export async function getGoogleAdsReclaimClassificationSummary(input: {
  businessId: string;
  staleLeaseMinutes?: number;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const staleThresholdMs = Math.max(1, input.staleLeaseMinutes ?? 8) * 60_000;
  const candidates = await readGoogleAdsReclaimCandidates({
    businessId: input.businessId,
  });
  const counts: Record<ProviderReclaimDisposition, number> = {
    alive_slow: 0,
    stalled_reclaimable: 0,
    poison_candidate: 0,
  };
  const nowMs = Date.now();
  for (const row of candidates) {
    const decision = classifyGoogleAdsReclaimCandidate({
      row,
      nowMs,
      staleThresholdMs,
    });
    if (!decision) continue;
    tallyDisposition(counts, decision.disposition);
  }
  return {
    candidateCount: candidates.length,
    aliveSlowCount: counts.alive_slow,
    reclaimCandidateCount: counts.stalled_reclaimable,
    poisonCandidateCount: counts.poison_candidate,
  };
}

function parseTimestampMs(value: unknown) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) return null;
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function tallyDisposition(
  counts: Record<ProviderReclaimDisposition, number>,
  disposition: ProviderReclaimDisposition,
) {
  counts[disposition] = (counts[disposition] ?? 0) + 1;
}

export function buildGoogleAdsRawSnapshotHash(input: {
  businessId: string;
  providerAccountId: string;
  endpointName: string;
  startDate: string;
  endDate: string;
  payload: unknown;
}) {
  return createHash("sha1")
    .update(
      JSON.stringify({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        endpointName: input.endpointName,
        startDate: normalizeDate(input.startDate),
        endDate: normalizeDate(input.endDate),
        payload: input.payload,
      }),
    )
    .digest("hex");
}

export function buildGoogleAdsSyncCheckpointHash(input: {
  partitionId: string;
  checkpointScope: string;
  phase: string;
  pageIndex: number;
  nextPageToken?: string | null;
  providerCursor?: string | null;
}) {
  return createHash("sha1")
    .update(
      JSON.stringify({
        partitionId: input.partitionId,
        checkpointScope: input.checkpointScope,
        phase: input.phase,
        pageIndex: input.pageIndex,
        nextPageToken: input.nextPageToken ?? null,
        providerCursor: input.providerCursor ?? null,
      }),
    )
    .digest("hex");
}

export function emptyGoogleAdsWarehouseMetrics(): GoogleAdsWarehouseMetricSet {
  return {
    spend: 0,
    revenue: 0,
    conversions: 0,
    impressions: 0,
    clicks: 0,
    ctr: null,
    cpc: null,
    cpa: null,
    roas: 0,
    conversionRate: null,
    interactionRate: null,
  };
}

export function createGoogleAdsWarehouseFreshness(
  input: Partial<GoogleAdsWarehouseFreshness> = {},
): GoogleAdsWarehouseFreshness {
  return {
    dataState: input.dataState ?? "syncing",
    lastSyncedAt: input.lastSyncedAt ?? null,
    liveRefreshedAt: input.liveRefreshedAt ?? null,
    isPartial: input.isPartial ?? false,
    missingWindows: input.missingWindows ?? [],
    warnings: input.warnings ?? [],
  };
}

export function mergeGoogleAdsWarehouseState(
  current: GoogleAdsWarehouseDataState,
  next: GoogleAdsWarehouseDataState,
): GoogleAdsWarehouseDataState {
  const priority: Record<GoogleAdsWarehouseDataState, number> = {
    not_connected: 0,
    connected_no_assignment: 1,
    action_required: 2,
    syncing: 3,
    stale: 4,
    partial: 5,
    advisor_not_ready: 6,
    ready: 7,
  };
  return priority[next] > priority[current] ? next : current;
}

export async function createGoogleAdsSyncJob(input: GoogleAdsSyncJobRecord) {
  // Legacy-only: retained for reset/debug visibility. Queue/status truth must not depend on this table.
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const { businessRefId, providerAccountRefId } =
    await resolveGoogleAdsControlPlaneReferenceIds({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
    });
  const staleRepairSupersededMessage = input.triggerSource.startsWith(
    "manual_targeted_repair:",
  )
    ? "manual targeted repair superseded a stale running job"
    : "recent repair superseded a stale running job";
  if (
    input.triggerSource.startsWith("manual_targeted_repair:") ||
    input.triggerSource.startsWith("repair_recent_")
  ) {
    await sql`
      UPDATE google_ads_sync_jobs
      SET
        business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
        provider_account_ref_id = COALESCE(provider_account_ref_id, ${providerAccountRefId}),
        status = 'cancelled',
        last_error = COALESCE(last_error, ${staleRepairSupersededMessage}),
        finished_at = now(),
        updated_at = now()
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND sync_type = ${input.syncType}
        AND scope = ${input.scope}
        AND start_date = ${normalizeDate(input.startDate)}
        AND end_date = ${normalizeDate(input.endDate)}
        AND trigger_source = ${input.triggerSource}
        AND status = 'running'
    `;
  }
  const insertedRows = (await sql`
    INSERT INTO google_ads_sync_jobs (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      sync_type,
      scope,
      start_date,
      end_date,
      status,
      progress_percent,
      trigger_source,
      retry_count,
      last_error,
      triggered_at,
      started_at,
      finished_at,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${businessRefId},
      ${input.providerAccountId},
      ${providerAccountRefId},
      ${input.syncType},
      ${input.scope},
      ${normalizeDate(input.startDate)},
      ${normalizeDate(input.endDate)},
      ${input.status},
      ${input.progressPercent},
      ${input.triggerSource},
      ${input.retryCount},
      ${input.lastError},
      COALESCE(${input.triggeredAt ?? null}, now()),
      ${input.startedAt ?? null},
      ${input.finishedAt ?? null},
      now()
    )
    ON CONFLICT (
      business_id,
      provider_account_id,
      sync_type,
      scope,
      start_date,
      end_date,
      trigger_source
    ) WHERE status = 'running'
    DO NOTHING
    RETURNING id
  `) as Array<{ id: string }>;
  if (insertedRows[0]?.id) {
    return {
      id: insertedRows[0].id,
      created: true,
    };
  }

  const existingRows = (await sql`
    SELECT id
    FROM google_ads_sync_jobs
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND sync_type = ${input.syncType}
      AND scope = ${input.scope}
      AND start_date = ${normalizeDate(input.startDate)}
      AND end_date = ${normalizeDate(input.endDate)}
      AND trigger_source = ${input.triggerSource}
      AND status = 'running'
    ORDER BY triggered_at DESC
    LIMIT 1
  `) as Array<{ id: string }>;
  return {
    id: existingRows[0]?.id ?? null,
    created: false,
  };
}

export async function updateGoogleAdsSyncJob(input: {
  id: string;
  status: GoogleAdsSyncJobRecord["status"];
  progressPercent?: number;
  lastError?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}) {
  // Legacy-only: retained for reset/debug visibility. Queue/status truth must not depend on this table.
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  await sql`
    UPDATE google_ads_sync_jobs
    SET
      status = ${input.status},
      progress_percent = COALESCE(${input.progressPercent ?? null}, progress_percent),
      last_error = COALESCE(${input.lastError ?? null}, last_error),
      started_at = COALESCE(${input.startedAt ?? null}, started_at),
      finished_at = COALESCE(${input.finishedAt ?? null}, finished_at),
      updated_at = now()
    WHERE id = ${input.id}
  `;
}

export async function expireStaleGoogleAdsRunnerLeases(input?: {
  businessId?: string;
  lane?: GoogleAdsSyncLane;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  await sql`
    DELETE FROM google_ads_runner_leases
    WHERE lease_expires_at <= now()
      AND (${input?.businessId ?? null}::text IS NULL OR business_id = ${input?.businessId ?? null})
      AND (${input?.lane ?? null}::text IS NULL OR lane = ${input?.lane ?? null})
  `;
}

export async function acquireGoogleAdsRunnerLease(input: {
  businessId: string;
  lane: GoogleAdsSyncLane;
  leaseOwner: string;
  leaseMinutes?: number;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const businessRefIds = await resolveBusinessReferenceIds([input.businessId]);
  const sql = getDb();
  await expireStaleGoogleAdsRunnerLeases({
    businessId: input.businessId,
    lane: input.lane,
  }).catch(() => null);
  const rows = (await sql`
    INSERT INTO google_ads_runner_leases (
      business_id,
      business_ref_id,
      lane,
      lease_owner,
      lease_expires_at,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${businessRefIds.get(input.businessId) ?? null},
      ${input.lane},
      ${input.leaseOwner},
      now() + (${input.leaseMinutes ?? 5} || ' minutes')::interval,
      now()
    )
    ON CONFLICT (business_id, lane)
    DO UPDATE SET
      business_ref_id = COALESCE(
        google_ads_runner_leases.business_ref_id,
        EXCLUDED.business_ref_id
      ),
      lease_owner = CASE
        WHEN google_ads_runner_leases.lease_expires_at <= now() THEN EXCLUDED.lease_owner
        ELSE google_ads_runner_leases.lease_owner
      END,
      lease_expires_at = CASE
        WHEN google_ads_runner_leases.lease_expires_at <= now()
          THEN EXCLUDED.lease_expires_at
        ELSE google_ads_runner_leases.lease_expires_at
      END,
      updated_at = CASE
        WHEN google_ads_runner_leases.lease_expires_at <= now()
          THEN now()
        ELSE google_ads_runner_leases.updated_at
      END
    RETURNING
      business_id,
      lane,
      lease_owner,
      lease_expires_at,
      created_at,
      updated_at
  `) as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row) return null;
  if (String(row.lease_owner) !== input.leaseOwner) {
    return null;
  }
  return {
    businessId: String(row.business_id),
    lane: String(row.lane) as GoogleAdsSyncLane,
    leaseOwner: String(row.lease_owner),
    leaseExpiresAt:
      normalizeTimestamp(row.lease_expires_at) ?? new Date().toISOString(),
    createdAt: normalizeTimestamp(row.created_at) ?? undefined,
    updatedAt: normalizeTimestamp(row.updated_at) ?? undefined,
  } satisfies GoogleAdsRunnerLeaseRecord;
}

export async function releaseGoogleAdsRunnerLease(input: {
  businessId: string;
  lane: GoogleAdsSyncLane;
  leaseOwner?: string | null;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  await sql`
    DELETE FROM google_ads_runner_leases
    WHERE business_id = ${input.businessId}
      AND lane = ${input.lane}
      AND (${input.leaseOwner ?? null}::text IS NULL OR lease_owner = ${input.leaseOwner ?? null})
  `;
}

export async function getGoogleAdsRunnerLeaseHealth(input: {
  businessId: string;
  lanes?: GoogleAdsSyncLane[];
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const lanes =
    input.lanes?.map((lane) => String(lane).trim()).filter(Boolean) ?? [];
  const rows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE lease_expires_at > now())::int AS active_leases,
      MAX(lease_expires_at) AS latest_lease_expires_at,
      MAX(updated_at) AS latest_lease_updated_at,
      BOOL_OR(lease_expires_at > now()) AS has_active_lease
    FROM google_ads_runner_leases
    WHERE business_id = ${input.businessId}
      AND (
        COALESCE(array_length(${lanes}::text[], 1), 0) = 0
        OR lane = ANY(${lanes}::text[])
      )
  `) as Array<Record<string, unknown>>;
  const row = rows[0] ?? {};
  return {
    activeLeases: toNumber(row.active_leases),
    hasActiveLease: Boolean(row.has_active_lease),
    latestLeaseExpiresAt: normalizeTimestamp(row.latest_lease_expires_at),
    latestLeaseUpdatedAt: normalizeTimestamp(row.latest_lease_updated_at),
  };
}

export async function queueGoogleAdsSyncPartition(
  input: GoogleAdsSyncPartitionRecord,
) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const { businessRefId, providerAccountRefId } =
    await resolveGoogleAdsControlPlaneReferenceIds({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
    });
  const priorityResetSources = [
    "selected_range",
    "finalize_day",
    "recent",
    "today",
    "recent_recovery",
    "core_historical_recovery",
    "historical_recovery",
    "core_success",
    // Without this entry the upsert leaves an already-succeeded partition at
    // 'succeeded' and the rolling reread is silently inert.
    "freshness_refresh",
  ];
  const rows = (await sql`
    INSERT INTO google_ads_sync_partitions (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      lane,
      scope,
      partition_date,
      status,
      priority,
      source,
      lease_owner,
      lease_expires_at,
      attempt_count,
      next_retry_at,
      last_error,
      started_at,
      finished_at,
      -- Which scheduling operation created this row, if any. Null for work the
      -- worker or a cron tick planned for itself, which belongs to no
      -- user-facing request.
      scheduling_attempt_id,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${businessRefId},
      ${input.providerAccountId},
      ${providerAccountRefId},
      ${input.lane},
      ${input.scope},
      ${normalizeDate(input.partitionDate)},
      ${input.status},
      ${input.priority},
      ${input.source},
      ${input.leaseOwner ?? null},
      ${input.leaseExpiresAt ?? null},
      ${input.attemptCount},
      ${input.nextRetryAt ?? null},
      ${input.lastError ?? null},
      ${input.startedAt ?? null},
      ${input.finishedAt ?? null},
      ${getCurrentSchedulingAttemptId()},
      now()
    )
    ON CONFLICT (business_id, provider_account_id, lane, scope, partition_date)
    DO UPDATE SET
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_sync_partitions.business_ref_id),
      provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_sync_partitions.provider_account_ref_id),
      priority = GREATEST(google_ads_sync_partitions.priority, EXCLUDED.priority),
      source = CASE
        WHEN google_ads_sync_partitions.source = 'selected_range' THEN google_ads_sync_partitions.source
        WHEN EXCLUDED.source = 'selected_range' THEN EXCLUDED.source
        WHEN EXCLUDED.source = ANY(${priorityResetSources}::text[]) THEN EXCLUDED.source
        ELSE google_ads_sync_partitions.source
      END,
      status = CASE
        WHEN EXCLUDED.source = ANY(${priorityResetSources}::text[])
          AND google_ads_sync_partitions.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
          THEN 'queued'
        ELSE google_ads_sync_partitions.status
      END,
      lease_owner = CASE
        WHEN EXCLUDED.source = ANY(${priorityResetSources}::text[])
          AND google_ads_sync_partitions.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
          THEN NULL
        ELSE google_ads_sync_partitions.lease_owner
      END,
      lease_expires_at = CASE
        WHEN EXCLUDED.source = ANY(${priorityResetSources}::text[])
          AND google_ads_sync_partitions.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
          THEN NULL
        ELSE google_ads_sync_partitions.lease_expires_at
      END,
      last_error = CASE
        WHEN EXCLUDED.source = ANY(${priorityResetSources}::text[])
          AND google_ads_sync_partitions.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
          THEN NULL
        ELSE google_ads_sync_partitions.last_error
      END,
      next_retry_at = CASE
        WHEN EXCLUDED.source = ANY(${priorityResetSources}::text[])
          AND google_ads_sync_partitions.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
          THEN now()
        WHEN google_ads_sync_partitions.status IN ('succeeded', 'running', 'leased')
          THEN google_ads_sync_partitions.next_retry_at
        ELSE LEAST(COALESCE(google_ads_sync_partitions.next_retry_at, now()), COALESCE(EXCLUDED.next_retry_at, now()))
      END,
      updated_at = now()
    WHERE NOT (
      google_ads_sync_partitions.status = 'dead_letter'
      AND (
        COALESCE(google_ads_sync_partitions.last_error, '') ILIKE ANY (ARRAY[
          '%google_ads_scope_action_required%',
          '%invalid_grant%',
          '%token has been expired or revoked%',
          '%refresh token%',
          '%login required%',
          '%reauth%',
          '%UNAUTHENTICATED%',
          '%AUTHENTICATION_ERROR%',
          '%PERMISSION_DENIED%',
          '%permission denied%',
          '%does not have permission%',
          '%provider_request_failed:permission%',
          '%permission:status_403%',
          '%customer_not_enabled%',
          '%customer not enabled%',
          '%customer not found%',
          '%account suspended%',
          '%account cancelled%',
          '%account canceled%'
        ])
        OR EXISTS (
          SELECT 1
          FROM google_ads_sync_runs terminal_run
          WHERE terminal_run.partition_id = google_ads_sync_partitions.id
            AND terminal_run.error_class IN (
              'account_action_required',
              'auth_action_required',
              'permission_action_required',
              'provider_action_required',
              'scope_action_required'
            )
        )
      )
    )
    RETURNING id, status
  `) as Array<{ id: string; status: GoogleAdsPartitionStatus }>;
  const queued = rows[0] ?? null;

  // Requeueing a terminal partition MUST invalidate its checkpoint, or the
  // requeue is theatre.
  //
  // resolvePhaseAwareReplayDecision returns startChunkIndex = totalChunks for a
  // checkpoint in finalize/succeeded, so the write loop runs zero iterations:
  // Google is called and billed, and its answer is discarded, while the
  // partition re-succeeds on the stale rows. The partition upsert above resets
  // status but has never touched google_ads_sync_checkpoints, whose key is
  // (partition_id, checkpoint_scope) and whose partition id is stable across
  // the upsert — so the stale checkpoint always survived.
  //
  // Scoped to rows that are NOT currently leased by a live worker, so this can
  // never yank a checkpoint out from under an in-flight attempt; that worker's
  // own lease-epoch guard remains the authority.
  if (queued && queued.status === "queued") {
    await sql`
      UPDATE google_ads_sync_checkpoints AS checkpoint
      SET
        status = 'queued',
        phase = 'fetch_raw',
        page_index = 0,
        next_page_token = NULL,
        provider_cursor = NULL,
        raw_snapshot_ids = '[]'::jsonb,
        rows_fetched = 0,
        rows_written = 0,
        finished_at = NULL,
        updated_at = now()
      FROM google_ads_sync_partitions AS partition
      WHERE checkpoint.partition_id = partition.id
        AND partition.id = ${queued.id}::uuid
        AND partition.status = 'queued'
        AND partition.lease_owner IS NULL
        AND checkpoint.status = 'succeeded'
    `.catch(() => undefined);
  }
  return queued;
}

export async function leaseGoogleAdsSyncPartitions(input: {
  businessId: string;
  lane?: GoogleAdsSyncLane;
  workerId: string;
  limit: number;
  leaseMinutes?: number;
  sourceFilter?: "all" | "recent_only" | "historical_only";
  scopeFilter?: GoogleAdsWarehouseScope[];
  excludedScopeFilter?: GoogleAdsWarehouseScope[];
  startDate?: string | null;
  endDate?: string | null;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const scopePrioritySql = buildGoogleAdsScopeLeasePrioritySql();
  const sourcePrioritySql = buildGoogleAdsSourceLeasePrioritySql();
  const rows = (await sql.query(
    `
      WITH candidates AS (
        SELECT id
        FROM google_ads_sync_partitions
        WHERE business_id = $1
          AND EXISTS (
            SELECT 1
            FROM provider_connections connection
            JOIN integration_credentials credential
              ON credential.provider_connection_id = connection.id
             AND credential.access_token IS NOT NULL
            JOIN business_provider_accounts assignment
              ON assignment.business_id = google_ads_sync_partitions.business_id
             AND assignment.provider = 'google'
             AND assignment.provider_account_id = google_ads_sync_partitions.provider_account_id
             -- This EXISTS is the authoritative lease predicate: it decides
             -- whether a partition may be claimed at all. Without the
             -- selection filter a deselected Google account stays leaseable,
             -- and the per-work-unit revalidation downstream would then be the
             -- only thing standing between it and provider work.
             AND assignment.is_selected
            WHERE connection.business_id = google_ads_sync_partitions.business_id
              AND connection.provider = 'google'
              AND connection.status = 'connected'
          )
          AND EXISTS (
            SELECT 1
            FROM sync_runner_leases lease
            WHERE lease.business_id = $1
              AND lease.provider_scope = 'google_ads'
              AND lease.lease_owner = $4
              AND lease.lease_expires_at > now()
          )
          AND ($2::text IS NULL OR lane = $2)
          AND (
            COALESCE(array_length($7::text[], 1), 0) = 0
            OR scope = ANY($7::text[])
          )
          AND (
            COALESCE(array_length($10::text[], 1), 0) = 0
            OR NOT (scope = ANY($10::text[]))
          )
          AND NOT EXISTS (
            SELECT 1
            FROM google_ads_sync_partitions action_partition
            LEFT JOIN LATERAL (
              SELECT run.error_class, run.error_message
              FROM google_ads_sync_runs run
              WHERE run.partition_id = action_partition.id
              ORDER BY run.updated_at DESC
              LIMIT 1
            ) latest_action_run ON true
            WHERE action_partition.business_id = google_ads_sync_partitions.business_id
              AND action_partition.provider_account_id = google_ads_sync_partitions.provider_account_id
              -- Account-wide (no scope match): a 403/auth failure is an account
              -- credential problem, so one broken scope must block leasing for
              -- every scope on that account instead of letting fresh queued
              -- partitions in other scopes keep hammering the broken account.
              AND action_partition.status = 'dead_letter'
              AND action_partition.updated_at >= now() - interval '24 hours'
              AND (
                COALESCE(latest_action_run.error_class, '') IN (
                  'account_action_required',
                  'auth_action_required',
                  'permission_action_required',
                  'provider_action_required'
                )
                OR concat_ws(
                  ' ',
                  action_partition.last_error,
                  latest_action_run.error_message,
                  latest_action_run.error_class
                ) ILIKE ANY (ARRAY[
                  '%invalid_grant%',
                  '%token has been expired or revoked%',
                  '%refresh token%',
                  '%login required%',
                  '%reauth%',
                  '%UNAUTHENTICATED%',
                  '%AUTHENTICATION_ERROR%',
                  '%PERMISSION_DENIED%',
                  '%permission denied%',
                  '%does not have permission%',
                  '%provider_request_failed:permission%',
                  '%permission:status_403%',
                  '%customer_not_enabled%',
                  '%customer not enabled%',
                  '%customer not found%',
                  '%account suspended%',
                  '%account cancelled%',
                  '%account canceled%'
                ])
              )
          )
          AND (
            $6::text IS NULL
            OR $6::text = 'all'
            OR (
              $6::text = 'recent_only'
              AND (
                source IN ('selected_range', 'finalize_day', 'today', 'recent', 'recent_recovery')
                OR (
                  source = 'core_success'
                  AND partition_date >= CURRENT_DATE - interval '13 days'
                )
              )
            )
            OR (
              $6::text = 'historical_only'
              AND (
                source IN ('historical', 'historical_recovery')
                OR (
                  source = 'core_success'
                  AND partition_date < CURRENT_DATE - interval '13 days'
                )
              )
            )
          )
          AND ($8::date IS NULL OR partition_date >= $8::date)
          AND ($9::date IS NULL OR partition_date <= $9::date)
          AND (
            status = 'queued'
            OR (status = 'failed' AND COALESCE(next_retry_at, now()) <= now())
            OR (status = 'leased' AND COALESCE(lease_expires_at, now()) <= now())
          )
        -- Platform sync policy: always prepare the newest user-visible dates first.
        -- Recent and historical/backfill queues both run newest-first so a newly
        -- connected workspace becomes useful on current dates before older history fills in.
        ORDER BY priority DESC, ${sourcePrioritySql} DESC, ${scopePrioritySql} DESC, partition_date DESC, updated_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      UPDATE google_ads_sync_partitions partition
      SET
        status = 'leased',
        lease_epoch = COALESCE(partition.lease_epoch, 0) + 1,
        lease_owner = $4,
        lease_expires_at = now() + ($5 || ' minutes')::interval,
        updated_at = now()
      FROM candidates
      WHERE partition.id = candidates.id
      RETURNING
        partition.id,
        partition.business_id,
        partition.provider_account_id,
        partition.lane,
        partition.scope,
        partition.partition_date,
        partition.status,
        partition.priority,
        partition.source,
        partition.lease_epoch,
        partition.lease_owner,
        partition.lease_expires_at,
        partition.attempt_count,
        partition.next_retry_at,
        partition.last_error,
        partition.created_at,
        partition.started_at,
        partition.finished_at,
        partition.updated_at
    `,
    [
      input.businessId,
      input.lane ?? null,
      Math.max(1, input.limit),
      input.workerId,
      String(input.leaseMinutes ?? 5),
      input.sourceFilter ?? "all",
      input.scopeFilter ?? [],
      input.startDate ? normalizeDate(input.startDate) : null,
      input.endDate ? normalizeDate(input.endDate) : null,
      input.excludedScopeFilter ?? [],
    ],
  )) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    lane: String(row.lane) as GoogleAdsSyncLane,
    scope: String(row.scope) as GoogleAdsWarehouseScope,
    partitionDate: normalizeDate(row.partition_date),
    status: String(row.status) as GoogleAdsPartitionStatus,
    priority: toNumber(row.priority),
    source: String(row.source),
    leaseEpoch: toNumber(row.lease_epoch),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseExpiresAt: normalizeTimestamp(row.lease_expires_at),
    attemptCount: toNumber(row.attempt_count),
    nextRetryAt: normalizeTimestamp(row.next_retry_at),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: normalizeTimestamp(row.created_at) ?? undefined,
    startedAt: normalizeTimestamp(row.started_at),
    finishedAt: normalizeTimestamp(row.finished_at),
    updatedAt: normalizeTimestamp(row.updated_at) ?? undefined,
  })) as GoogleAdsSyncPartitionRecord[];
}

export async function markGoogleAdsPartitionRunning(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  leaseMinutes?: number;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    UPDATE google_ads_sync_partitions partition
    SET
      status = 'running',
      lease_owner = ${input.workerId},
      started_at = COALESCE(started_at, now()),
      lease_expires_at = now() + (${input.leaseMinutes ?? 15} || ' minutes')::interval,
      attempt_count = attempt_count + 1,
      updated_at = now()
    WHERE partition.id = ${input.partitionId}
      AND partition.lease_owner = ${input.workerId}
      AND partition.lease_epoch = ${input.leaseEpoch}
      AND COALESCE(partition.lease_expires_at, now()) > now()
      AND EXISTS (
        SELECT 1
        FROM sync_runner_leases lease
        WHERE lease.business_id = partition.business_id
          AND lease.provider_scope = 'google_ads'
          AND lease.lease_owner = ${input.workerId}
          AND lease.lease_expires_at > now()
      )
    RETURNING partition.id AS id
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

export async function getGoogleAdsPartitionCompletionDenialSnapshot(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
}) {
  const sql = getDb();
  try {
    const [row] = (await sql`
      WITH input_values AS (
        SELECT
          ${input.partitionId}::uuid AS partition_id,
          ${input.workerId}::text AS worker_id,
          ${input.leaseEpoch}::bigint AS lease_epoch
      ),
      current_partition AS (
        SELECT
          partition.status::text AS current_partition_status,
          partition.lease_owner::text AS current_lease_owner,
          partition.lease_epoch AS current_lease_epoch,
          partition.lease_expires_at AS current_lease_expires_at,
          (partition.lease_owner = input_values.worker_id) AS owner_matches_caller,
          (COALESCE(partition.lease_epoch, 0) = input_values.lease_epoch) AS epoch_matches_caller,
          (COALESCE(partition.lease_expires_at, now() - interval '1 second') <= now())
            AS lease_expired_at_observation,
          partition.finished_at AS current_partition_finished_at
        FROM google_ads_sync_partitions partition
        CROSS JOIN input_values
        WHERE partition.id = input_values.partition_id
      ),
      latest_checkpoint AS (
        SELECT
          checkpoint.checkpoint_scope::text AS latest_checkpoint_scope,
          checkpoint.phase::text AS latest_checkpoint_phase,
          checkpoint.updated_at AS latest_checkpoint_updated_at
        FROM google_ads_sync_checkpoints checkpoint
        CROSS JOIN input_values
        WHERE checkpoint.partition_id = input_values.partition_id
        ORDER BY checkpoint.updated_at DESC
        LIMIT 1
      ),
      latest_running_run AS (
        SELECT run.id::text AS latest_running_run_id
        FROM google_ads_sync_runs run
        CROSS JOIN input_values
        WHERE run.partition_id = input_values.partition_id
          AND run.status = 'running'
        ORDER BY run.created_at DESC
        LIMIT 1
      ),
      running_run_count AS (
        SELECT COUNT(*)::int AS running_run_count
        FROM google_ads_sync_runs run
        CROSS JOIN input_values
        WHERE run.partition_id = input_values.partition_id
          AND run.status = 'running'
      )
      SELECT
        current_partition.current_partition_status,
        current_partition.current_lease_owner,
        current_partition.current_lease_epoch,
        current_partition.current_lease_expires_at,
        current_partition.owner_matches_caller,
        current_partition.epoch_matches_caller,
        current_partition.lease_expired_at_observation,
        current_partition.current_partition_finished_at,
        latest_checkpoint.latest_checkpoint_scope,
        latest_checkpoint.latest_checkpoint_phase,
        latest_checkpoint.latest_checkpoint_updated_at,
        latest_running_run.latest_running_run_id,
        running_run_count.running_run_count,
        CASE
          WHEN current_partition.current_partition_status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
            THEN 'already_terminal'
          WHEN current_partition.owner_matches_caller IS FALSE
            THEN 'owner_mismatch'
          WHEN current_partition.epoch_matches_caller IS FALSE
            THEN 'epoch_mismatch'
          WHEN current_partition.lease_expired_at_observation IS TRUE
            THEN 'lease_expired'
          ELSE 'unknown_denial'
        END AS denial_classification
      FROM current_partition
      LEFT JOIN latest_checkpoint ON TRUE
      LEFT JOIN latest_running_run ON TRUE
      LEFT JOIN running_run_count ON TRUE
    `) as Array<Record<string, unknown>>;

    if (!row) return null;

    return {
      currentPartitionStatus:
        typeof row.current_partition_status === "string"
          ? row.current_partition_status
          : null,
      currentLeaseOwner:
        typeof row.current_lease_owner === "string"
          ? row.current_lease_owner
          : null,
      currentLeaseEpoch:
        typeof row.current_lease_epoch === "number"
          ? row.current_lease_epoch
          : toNumber(row.current_lease_epoch),
      currentLeaseExpiresAt: normalizeTimestamp(row.current_lease_expires_at),
      ownerMatchesCaller: parseNullableBoolean(row.owner_matches_caller),
      epochMatchesCaller: parseNullableBoolean(row.epoch_matches_caller),
      leaseExpiredAtObservation: parseNullableBoolean(
        row.lease_expired_at_observation,
      ),
      currentPartitionFinishedAt: normalizeTimestamp(
        row.current_partition_finished_at,
      ),
      latestCheckpointScope:
        typeof row.latest_checkpoint_scope === "string"
          ? row.latest_checkpoint_scope
          : null,
      latestCheckpointPhase:
        typeof row.latest_checkpoint_phase === "string"
          ? row.latest_checkpoint_phase
          : null,
      latestCheckpointUpdatedAt: normalizeTimestamp(
        row.latest_checkpoint_updated_at,
      ),
      latestRunningRunId:
        typeof row.latest_running_run_id === "string"
          ? row.latest_running_run_id
          : null,
      runningRunCount: toNumber(row.running_run_count),
      denialClassification:
        typeof row.denial_classification === "string"
          ? (row.denial_classification as GoogleAdsCompletionDenialClassification)
          : "unknown_denial",
    } satisfies GoogleAdsPartitionCompletionDenialSnapshot;
  } catch (error) {
    console.warn(
      "[google-ads-sync] partition_completion_denial_observability_failed",
      {
        partitionId: input.partitionId,
        workerId: input.workerId,
        message: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}

export async function backfillGoogleAdsRunningRunsForTerminalPartition(input: {
  partitionId: string;
  runId?: string | null;
  recoveredRunId?: string | null;
}) {
  const sql = getDb();
  const runBatchSize = 25;
  let partitionStatus: string | null = null;
  let closedRunningRunCount = 0;
  let callerRunIdWasClosed: boolean | null =
    input.runId ?? input.recoveredRunId ?? null ? false : null;
  const closedRunningRunIds: string[] = [];

  while (true) {
    const [row] = (await sql`
      WITH input_values AS (
        SELECT
          ${input.partitionId}::uuid AS partition_id,
          ${input.runId ?? input.recoveredRunId ?? null}::uuid AS effective_run_id
      ),
      terminal_partition AS (
        SELECT
          partition.status::text AS partition_status,
          partition.last_error::text AS partition_last_error,
          partition.finished_at AS partition_finished_at
        FROM google_ads_sync_partitions partition
        CROSS JOIN input_values
        WHERE partition.id = input_values.partition_id
          AND partition.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
      ),
      candidate_runs AS (
        SELECT run.id
        FROM google_ads_sync_runs run
        CROSS JOIN input_values
        JOIN terminal_partition ON TRUE
        WHERE run.partition_id = input_values.partition_id
          AND run.status = 'running'
        ORDER BY run.id
        LIMIT ${runBatchSize}
      ),
      updated_runs AS (
        UPDATE google_ads_sync_runs run
        SET
          status = CASE
            WHEN terminal_partition.partition_status = 'succeeded' THEN 'succeeded'
            WHEN terminal_partition.partition_status = 'cancelled' THEN 'cancelled'
            ELSE 'failed'
          END,
          error_class = CASE
            WHEN terminal_partition.partition_status IN ('succeeded', 'cancelled') THEN NULL
            WHEN terminal_partition.partition_status = 'dead_letter'
              THEN COALESCE(run.error_class, 'dead_letter')
            ELSE COALESCE(run.error_class, 'failed')
          END,
          error_message = CASE
            WHEN terminal_partition.partition_status IN ('succeeded', 'cancelled') THEN NULL
            WHEN terminal_partition.partition_status = 'dead_letter'
              THEN COALESCE(
                terminal_partition.partition_last_error,
                run.error_message,
                'partition already dead_letter'
              )
            ELSE COALESCE(
              terminal_partition.partition_last_error,
              run.error_message,
              'partition already failed'
            )
          END,
          finished_at = COALESCE(run.finished_at, terminal_partition.partition_finished_at, now()),
          duration_ms = COALESCE(
            run.duration_ms,
            GREATEST(
              0,
              FLOOR(
                EXTRACT(
                  EPOCH FROM (
                    COALESCE(terminal_partition.partition_finished_at, now()) -
                    COALESCE(run.started_at, run.created_at)
                  )
                ) * 1000
              )::int
            )
          ),
          meta_json = COALESCE(run.meta_json, '{}'::jsonb) || jsonb_build_object(
            'decisionCaller', 'backfillGoogleAdsRunningRunsForTerminalPartition',
            'closureReason', CASE
              WHEN terminal_partition.partition_status = 'succeeded' THEN 'partition_already_succeeded'
              WHEN terminal_partition.partition_status = 'failed' THEN 'partition_already_failed'
              WHEN terminal_partition.partition_status = 'dead_letter' THEN 'partition_already_dead_letter'
              ELSE 'partition_already_cancelled'
            END
          ),
          updated_at = now()
        FROM terminal_partition
        WHERE run.id IN (SELECT id FROM candidate_runs)
        RETURNING
          run.id AS run_id_uuid,
          run.id::text AS run_id,
          terminal_partition.partition_status
      ),
      updated_summary AS (
        SELECT
          COALESCE(MAX(partition_status), (SELECT partition_status FROM terminal_partition LIMIT 1)) AS partition_status,
          COUNT(*)::int AS closed_running_run_count,
          CASE
            WHEN (SELECT effective_run_id FROM input_values) IS NULL THEN NULL
            ELSE BOOL_OR(run_id_uuid = (SELECT effective_run_id FROM input_values))
          END AS caller_run_id_was_closed
        FROM updated_runs
      ),
      capped_run_ids AS (
        SELECT run_id
        FROM updated_runs
        ORDER BY run_id
        LIMIT 10
      )
      SELECT
        (SELECT partition_status FROM updated_summary) AS partition_status,
        COALESCE((SELECT closed_running_run_count FROM updated_summary), 0) AS closed_running_run_count,
        (SELECT caller_run_id_was_closed FROM updated_summary) AS caller_run_id_was_closed,
        COALESCE((SELECT json_agg(run_id ORDER BY run_id) FROM capped_run_ids), '[]'::json) AS closed_running_run_ids
    `) as Array<Record<string, unknown>>;

    const batchPartitionStatus =
      typeof row?.partition_status === "string" ? row.partition_status : null;
    const batchClosedRunningRunCount = toNumber(row?.closed_running_run_count);
    const batchCallerRunIdWasClosed = parseNullableBoolean(
      row?.caller_run_id_was_closed,
    );
    const batchClosedRunningRunIds = parseStringArray(row?.closed_running_run_ids);

    if (partitionStatus === null) {
      partitionStatus = batchPartitionStatus;
    }
    closedRunningRunCount += batchClosedRunningRunCount;
    if (batchCallerRunIdWasClosed === true) {
      callerRunIdWasClosed = true;
    }
    for (const runId of batchClosedRunningRunIds) {
      if (closedRunningRunIds.length >= 10) {
        break;
      }
      if (!closedRunningRunIds.includes(runId)) {
        closedRunningRunIds.push(runId);
      }
    }

    if (batchClosedRunningRunCount < runBatchSize) {
      break;
    }
  }

  return {
    partitionStatus,
    closedRunningRunCount,
    callerRunIdWasClosed,
    closedRunningRunIds,
  };
}

export async function backfillGoogleAdsRunningCheckpointsForTerminalPartition(input: {
  partitionId: string;
}) {
  const sql = getDb();
  const [row] = (await sql`
    WITH input_values AS (
      SELECT ${input.partitionId}::uuid AS partition_id
    ),
    terminal_partition AS (
      SELECT
        partition.status::text AS partition_status,
        partition.finished_at AS partition_finished_at
      FROM google_ads_sync_partitions partition
      CROSS JOIN input_values
      WHERE partition.id = input_values.partition_id
        AND partition.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
    ),
    candidate_checkpoints AS (
      SELECT
        checkpoint.id,
        checkpoint.checkpoint_scope,
        checkpoint.phase AS previous_phase
      FROM google_ads_sync_checkpoints checkpoint
      CROSS JOIN input_values
      JOIN terminal_partition ON TRUE
      WHERE checkpoint.partition_id = input_values.partition_id
        AND checkpoint.status = 'running'
    ),
    updated_checkpoints AS (
      UPDATE google_ads_sync_checkpoints checkpoint
      SET
        -- A running checkpoint is NEVER promoted to succeeded from the parent's
        -- status. The bulk_upsert checkpoint is written BEFORE its chunk's fact
        -- rows, so inferring child success from parent success can mark a chunk
        -- complete whose rows were never committed — and it would launder any
        -- freshness gate placed in the write path. Terminal-but-unproven closes
        -- as 'failed', which is retryable and honest.
        status = CASE
          WHEN terminal_partition.partition_status = 'cancelled' THEN 'cancelled'
          ELSE 'failed'
        END,
        phase = checkpoint.phase,
        next_page_token = CASE
          WHEN terminal_partition.partition_status = 'succeeded' THEN NULL
          ELSE checkpoint.next_page_token
        END,
        provider_cursor = CASE
          WHEN terminal_partition.partition_status = 'succeeded' THEN NULL
          ELSE checkpoint.provider_cursor
        END,
        finished_at = COALESCE(checkpoint.finished_at, terminal_partition.partition_finished_at, now()),
        updated_at = now()
      FROM candidate_checkpoints candidate
      CROSS JOIN terminal_partition
      WHERE checkpoint.id = candidate.id
      RETURNING candidate.checkpoint_scope, candidate.previous_phase
    ),
    grouped_closed_checkpoints AS (
      SELECT
        checkpoint_scope,
        previous_phase,
        COUNT(*)::int AS row_count
      FROM updated_checkpoints
      GROUP BY checkpoint_scope, previous_phase
    )
    SELECT COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'checkpointScope', checkpoint_scope,
            'previousPhase', previous_phase,
            'count', row_count
          )
          ORDER BY checkpoint_scope, previous_phase
        )
        FROM grouped_closed_checkpoints
      ),
      '[]'::json
    ) AS closed_checkpoint_groups
  `) as Array<Record<string, unknown>>;

  const closedCheckpointGroups = parseGoogleAdsClosedCheckpointGroups(
    row?.closed_checkpoint_groups,
  );
  return {
    closedCheckpointGroups,
    closedRunningCheckpointCount: closedCheckpointGroups.reduce(
      (sum, group) => sum + group.count,
      0,
    ),
  };
}

export async function completeGoogleAdsPartitionAttempt(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  partitionStatus: Extract<
    GoogleAdsPartitionStatus,
    "succeeded" | "failed" | "dead_letter" | "cancelled"
  >;
  runId?: string | null;
  recoveredRunId?: string | null;
  runStatus?: GoogleAdsSyncRunRecord["status"];
  durationMs?: number | null;
  errorClass?: string | null;
  errorMessage?: string | null;
  finishedAt?: string | null;
  lastError?: string | null;
  retryDelayMinutes?: number;
}): Promise<GoogleAdsPartitionAttemptCompletionResult> {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const runStatus =
    input.runStatus ??
    (input.partitionStatus === "succeeded"
      ? "succeeded"
      : input.partitionStatus === "cancelled"
        ? "cancelled"
        : "failed");
  const rows = (await sql`
    WITH input_values AS (
      SELECT
        ${input.partitionStatus}::text AS partition_status,
        ${input.retryDelayMinutes ?? 5}::int AS retry_delay_minutes,
        ${input.lastError ?? null}::text AS last_error,
        ${input.finishedAt ?? null}::timestamptz AS finished_at,
        ${input.partitionId}::uuid AS partition_id,
        ${input.workerId}::text AS worker_id,
        ${input.leaseEpoch}::bigint AS lease_epoch,
        ${input.runId ?? null}::uuid AS run_id,
        ${input.runId ?? input.recoveredRunId ?? null}::uuid AS effective_run_id,
        ${runStatus}::text AS run_status,
        ${input.durationMs ?? null}::int AS duration_ms,
        ${input.errorClass ?? null}::text AS error_class,
        ${input.errorMessage ?? null}::text AS error_message
    ),
    completed_partition AS (
      UPDATE google_ads_sync_partitions partition
      SET
        status = input_values.partition_status,
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_retry_at = CASE
          WHEN input_values.partition_status = 'failed'
            THEN now() + (input_values.retry_delay_minutes || ' minutes')::interval
          ELSE NULL
        END,
        last_error = input_values.last_error,
        finished_at = CASE
          WHEN input_values.partition_status IN ('succeeded', 'dead_letter', 'cancelled')
            THEN COALESCE(input_values.finished_at, now())
          ELSE partition.finished_at
        END,
        updated_at = now()
      FROM input_values
      WHERE partition.id = input_values.partition_id
        AND partition.lease_owner = input_values.worker_id
        AND COALESCE(partition.lease_epoch, 0) = input_values.lease_epoch
        AND COALESCE(partition.lease_expires_at, now()) > now()
      RETURNING partition.id
    ),
    candidate_checkpoints AS (
      SELECT
        checkpoint.id,
        checkpoint.checkpoint_scope,
        checkpoint.phase AS previous_phase
      FROM google_ads_sync_checkpoints checkpoint
      JOIN completed_partition partition
        ON partition.id = checkpoint.partition_id
      WHERE checkpoint.status = 'running'
    ),
    closed_checkpoints AS (
      UPDATE google_ads_sync_checkpoints checkpoint
      SET
        -- Same rule as the sibling backfill: parent success is not evidence of
        -- child success, because the running checkpoint predates its own fact
        -- write.
        status = CASE
          WHEN input_values.partition_status = 'cancelled' THEN 'cancelled'
          ELSE 'failed'
        END,
        phase = checkpoint.phase,
        next_page_token = CASE
          WHEN input_values.partition_status = 'succeeded' THEN NULL
          ELSE checkpoint.next_page_token
        END,
        provider_cursor = CASE
          WHEN input_values.partition_status = 'succeeded' THEN NULL
          ELSE checkpoint.provider_cursor
        END,
        finished_at = COALESCE(checkpoint.finished_at, input_values.finished_at, now()),
        updated_at = now()
      FROM candidate_checkpoints candidate
      CROSS JOIN input_values
      WHERE checkpoint.id = candidate.id
      RETURNING
        candidate.checkpoint_scope,
        candidate.previous_phase
    ),
    grouped_closed_checkpoints AS (
      SELECT
        checkpoint_scope,
        previous_phase,
        COUNT(*)::int AS row_count
      FROM closed_checkpoints
      GROUP BY checkpoint_scope, previous_phase
    ),
    updated_runs AS (
      UPDATE google_ads_sync_runs run
      SET
        status = input_values.run_status,
        duration_ms = COALESCE(input_values.duration_ms, run.duration_ms),
        error_class = CASE
          WHEN input_values.run_status IN ('succeeded', 'cancelled') THEN NULL
          ELSE COALESCE(input_values.error_class, run.error_class)
        END,
        error_message = CASE
          WHEN input_values.run_status IN ('succeeded', 'cancelled') THEN NULL
          ELSE COALESCE(input_values.error_message, run.error_message)
        END,
        finished_at = COALESCE(input_values.finished_at, now()),
        updated_at = now()
      FROM completed_partition partition
      CROSS JOIN input_values
      WHERE run.partition_id = partition.id
        AND run.status = 'running'
      RETURNING
        run.id AS run_id_uuid,
        run.id::text AS run_id
    ),
    updated_run_summary AS (
      SELECT
        COUNT(*)::int AS closed_running_run_count,
        CASE
          WHEN (SELECT effective_run_id FROM input_values) IS NULL THEN NULL
          ELSE BOOL_OR(run_id_uuid = (SELECT effective_run_id FROM input_values))
        END AS caller_run_id_was_closed
      FROM updated_runs
    ),
    capped_updated_run_ids AS (
      SELECT run_id
      FROM updated_runs
      ORDER BY run_id
      LIMIT 10
    )
    SELECT
      EXISTS(SELECT 1 FROM completed_partition) AS completed,
      EXISTS(SELECT 1 FROM updated_runs) AS run_updated,
      COALESCE((SELECT closed_running_run_count FROM updated_run_summary), 0) AS closed_running_run_count,
      (SELECT caller_run_id_was_closed FROM updated_run_summary) AS caller_run_id_was_closed,
      COALESCE((SELECT json_agg(run_id ORDER BY run_id) FROM capped_updated_run_ids), '[]'::json)
        AS closed_running_run_ids,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'checkpointScope', checkpoint_scope,
              'previousPhase', previous_phase,
              'count', row_count
            )
            ORDER BY checkpoint_scope, previous_phase
          )
          FROM grouped_closed_checkpoints
        ),
        '[]'::json
      ) AS closed_checkpoint_groups
  `) as Array<Record<string, unknown>>;

  const row = rows[0] ?? {};
  if (!Boolean(row.completed)) {
    return {
      ok: false,
      reason: "lease_conflict",
    };
  }

  return {
    ok: true,
    runUpdated: Boolean(row.run_updated),
    closedRunningRunCount: toNumber(row.closed_running_run_count),
    callerRunIdWasClosed: parseNullableBoolean(row.caller_run_id_was_closed),
    closedRunningRunIds: parseStringArray(row.closed_running_run_ids),
    closedCheckpointGroups: parseGoogleAdsClosedCheckpointGroups(
      row.closed_checkpoint_groups,
    ),
  };
}

export async function completeGoogleAdsPartition(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  status: Extract<
    GoogleAdsPartitionStatus,
    "succeeded" | "failed" | "dead_letter" | "cancelled"
  >;
  lastError?: string | null;
  retryDelayMinutes?: number;
}) {
  const result = await completeGoogleAdsPartitionAttempt({
    partitionId: input.partitionId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    partitionStatus: input.status,
    lastError: input.lastError ?? null,
    retryDelayMinutes: input.retryDelayMinutes,
  });
  return result.ok;
}

export async function cancelGoogleAdsPartitionsBySource(input: {
  businessId: string;
  lane?: GoogleAdsSyncLane | null;
  sources: string[];
  statuses: Array<
    Extract<GoogleAdsPartitionStatus, "queued" | "leased" | "running">
  >;
  scopeFilter?: GoogleAdsWarehouseScope[];
  lastError?: string | null;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    UPDATE google_ads_sync_partitions
    SET
      status = 'cancelled',
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = NULL,
      last_error = ${input.lastError ?? "cancelled while recent-90 advisor frontier is still incomplete"},
      finished_at = now(),
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND (${input.lane ?? null}::text IS NULL OR lane = ${input.lane ?? null})
      AND source = ANY(${input.sources}::text[])
      AND status = ANY(${input.statuses}::text[])
      AND (
        COALESCE(array_length(${input.scopeFilter ?? []}::text[], 1), 0) = 0
        OR scope = ANY(${input.scopeFilter ?? []}::text[])
      )
    RETURNING id
  `) as Array<{ id: string }>;

  return rows.length;
}

export async function heartbeatGoogleAdsPartitionLease(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  leaseMinutes?: number;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    UPDATE google_ads_sync_partitions partition
    SET
      lease_owner = ${input.workerId},
      lease_expires_at = now() + (${input.leaseMinutes ?? 5} || ' minutes')::interval,
      updated_at = now()
    WHERE partition.id = ${input.partitionId}
      AND partition.lease_owner = ${input.workerId}
      AND partition.lease_epoch = ${input.leaseEpoch}
      AND COALESCE(partition.lease_expires_at, now()) > now()
      AND EXISTS (
        SELECT 1
        FROM sync_runner_leases lease
        WHERE lease.business_id = partition.business_id
          AND lease.provider_scope = 'google_ads'
          AND lease.lease_owner = ${input.workerId}
          AND lease.lease_expires_at > now()
      )
    RETURNING partition.id AS id
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

export async function releaseGoogleAdsLeasedPartitionsForWorker(input: {
  businessId: string;
  workerId: string;
  retryDelayMinutes?: number;
  lastError?: string | null;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    UPDATE google_ads_sync_partitions partition
    SET
      status = 'failed',
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = now() + (${input.retryDelayMinutes ?? 3} || ' minutes')::interval,
      last_error = COALESCE(
        ${input.lastError ?? null}::text,
        partition.last_error,
        'leased partition released automatically after worker exit'
      ),
      updated_at = now()
    WHERE partition.business_id = ${input.businessId}
      AND partition.lease_owner = ${input.workerId}
      AND partition.status = 'leased'
    RETURNING partition.id AS id
  `) as Array<{ id: string }>;
  return rows.length;
}

export async function cleanupGoogleAdsPartitionOrchestration(input: {
  businessId: string;
  staleLeaseMinutes?: number;
  staleRunMinutes?: number;
  staleRunMinutesByLane?: Partial<Record<GoogleAdsSyncLane, number>>;
  runProgressGraceMinutes?: number;
  staleLegacyMinutes?: number;
}) {
    // Admission BEFORE the first orchestration write.
  //
  // Cleanup reclaims leases, cancels runs and rewrites partition status. That is
  // a mutation of the exact state a closed lane or an exhausted capacity budget
  // is trying to hold still, and it runs on the worker, on cron and from the
  // admin recovery endpoint alike. Admitting at the callers only would leave
  // whichever caller was added next unguarded.
  assertSyncLaneEnabled("google_sync");
  await assertSyncGrowthBoundary("google_partition_cleanup", { fresh: true });
await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const staleThresholdMs = Math.max(1, input.staleLeaseMinutes ?? 8) * 60_000;
  const terminalCleanupBatchSize = 100;
  const terminalChildPartitionRows = (await sql`
    WITH candidate_terminal_partitions AS (
      SELECT partition.id, partition.finished_at
      FROM google_ads_sync_partitions partition
      WHERE partition.business_id = ${input.businessId}
        AND partition.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
        AND (
          EXISTS (
            SELECT 1
            FROM google_ads_sync_runs run
            WHERE run.partition_id = partition.id
              AND run.status = 'running'
          )
          OR EXISTS (
            SELECT 1
            FROM google_ads_sync_checkpoints checkpoint
            WHERE checkpoint.partition_id = partition.id
              AND checkpoint.status = 'running'
          )
        )
      ORDER BY COALESCE(partition.finished_at, partition.updated_at, partition.created_at) ASC, partition.id ASC
      LIMIT ${terminalCleanupBatchSize}
    )
    SELECT id::text AS id
    FROM candidate_terminal_partitions
  `) as Array<Record<string, unknown>>;
  let closedTerminalRunningRunCount = 0;
  let closedTerminalRunningCheckpointCount = 0;
  for (const row of terminalChildPartitionRows) {
    const partitionId = String(row.id);
    const [runResult, checkpointResult] = await Promise.all([
      backfillGoogleAdsRunningRunsForTerminalPartition({
        partitionId,
      }),
      backfillGoogleAdsRunningCheckpointsForTerminalPartition({
        partitionId,
      }),
    ]);
    closedTerminalRunningRunCount += runResult.closedRunningRunCount;
    closedTerminalRunningCheckpointCount +=
      checkpointResult.closedRunningCheckpointCount;
  }

  const candidates = await readGoogleAdsReclaimCandidates({
    businessId: input.businessId,
  });

  const now = Date.now();
  const dispositionCounts: Record<ProviderReclaimDisposition, number> = {
    alive_slow: 0,
    stalled_reclaimable: 0,
    poison_candidate: 0,
  };
  const stalledDecisions: Array<
    ProviderReclaimDecision & { partitionId: string }
  > = [];
  const poisonDecisions: Array<
    ProviderReclaimDecision & {
      partitionId: string;
      checkpointScope: string | null;
    }
  > = [];

  for (const row of candidates) {
    const partitionId = String(row.id);
    const checkpointScope =
      row.checkpoint_scope != null ? String(row.checkpoint_scope) : null;
    const decision = classifyGoogleAdsReclaimCandidate({
      row,
      nowMs: now,
      staleThresholdMs,
    });
    if (!decision) continue;

    tallyDisposition(dispositionCounts, decision.disposition);
    if (decision.disposition === "stalled_reclaimable") {
      stalledDecisions.push({ partitionId, ...decision });
    }
    if (decision.disposition === "poison_candidate") {
      poisonDecisions.push({ partitionId, checkpointScope, ...decision });
    }
  }

  const stalePartitionIds = stalledDecisions.map((row) => row.partitionId);
  let reclaimedCheckpointCount = 0;
  if (stalePartitionIds.length > 0) {
    await sql`
      UPDATE google_ads_sync_partitions
      SET
        status = 'failed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_retry_at = now() + interval '3 minutes',
        last_error = COALESCE(last_error, 'stalled partition reclaimed automatically'),
        updated_at = now()
      WHERE id = ANY(${stalePartitionIds}::uuid[])
    `;
    const reconciledCheckpoints = (await sql`
      UPDATE google_ads_sync_checkpoints checkpoint
      SET
        status = 'failed',
        finished_at = COALESCE(checkpoint.finished_at, now()),
        updated_at = now()
      WHERE checkpoint.partition_id = ANY(${stalePartitionIds}::uuid[])
        AND checkpoint.status = 'running'
      RETURNING checkpoint.id
    `) as Array<Record<string, unknown>>;
    reclaimedCheckpointCount = reconciledCheckpoints.length;
    for (const decision of stalledDecisions) {
      await recordSyncReclaimEvents({
        providerScope: "google_ads",
        businessId: input.businessId,
        partitionIds: [decision.partitionId],
        eventType: "reclaimed",
        disposition: decision.disposition,
        reasonCode: decision.reasonCode,
        detail: decision.detail,
      }).catch(() => null);
    }
  }

  const poisonPartitionIds = poisonDecisions.map((row) => row.partitionId);
  let poisonedCheckpointCount = 0;
  if (poisonPartitionIds.length > 0) {
    await sql`
      UPDATE google_ads_sync_partitions
      SET
        status = 'dead_letter',
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_retry_at = NULL,
        last_error = COALESCE(last_error, 'poison checkpoint quarantined for manual recovery'),
        updated_at = now()
      WHERE id = ANY(${poisonPartitionIds}::uuid[])
    `;
    const poisonedCheckpoints = (await sql`
      UPDATE google_ads_sync_checkpoints checkpoint
      SET
        status = 'failed',
        finished_at = COALESCE(checkpoint.finished_at, now()),
        updated_at = now()
      WHERE checkpoint.partition_id = ANY(${poisonPartitionIds}::uuid[])
        AND checkpoint.status = 'running'
      RETURNING checkpoint.id
    `) as Array<Record<string, unknown>>;
    poisonedCheckpointCount = poisonedCheckpoints.length;
    for (const decision of poisonDecisions) {
      await recordSyncReclaimEvents({
        providerScope: "google_ads",
        businessId: input.businessId,
        partitionIds: [decision.partitionId],
        checkpointScope: decision.checkpointScope,
        eventType: "poisoned",
        disposition: decision.disposition,
        reasonCode: decision.reasonCode,
        detail: decision.detail,
      }).catch(() => null);
    }
  }

  const duplicateLegacyIds = (await sql`
    SELECT id
    FROM (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY business_id, provider_account_id, sync_type, scope, start_date, end_date, trigger_source
          ORDER BY updated_at DESC, triggered_at DESC, id DESC
        ) AS row_number
      FROM google_ads_sync_jobs
      WHERE business_id = ${input.businessId}
        AND status = 'running'
    ) ranked
    WHERE ranked.row_number > 1
    LIMIT 200
  `) as Array<Record<string, unknown>>;
  let duplicateLegacyCount = 0;
  if (duplicateLegacyIds.length > 0) {
    const rows = (await sql`
      UPDATE google_ads_sync_jobs
      SET
        status = 'cancelled',
        last_error = COALESCE(last_error, 'legacy google ads sync job superseded by partition queue'),
        finished_at = now(),
        updated_at = now()
      WHERE id = ANY(${duplicateLegacyIds.map((row) => String(row.id))}::uuid[])
      RETURNING id
    `) as Array<Record<string, unknown>>;
    duplicateLegacyCount = rows.length;
  }

  const staleLegacyRows = (await sql`
    UPDATE google_ads_sync_jobs
    SET
      status = 'failed',
      last_error = COALESCE(last_error, 'legacy google ads sync job expired automatically'),
      finished_at = now(),
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND status = 'running'
      AND started_at < now() - (${input.staleLegacyMinutes ?? 15} || ' minutes')::interval
    RETURNING id
  `) as Array<Record<string, unknown>>;

  const staleRunMinutesCore = Math.max(
    1,
    input.staleRunMinutesByLane?.core ?? input.staleRunMinutes ?? 12,
  );
  const staleRunMinutesMaintenance = Math.max(
    1,
    input.staleRunMinutesByLane?.maintenance ??
      Math.max(staleRunMinutesCore, 15),
  );
  const staleRunMinutesExtended = Math.max(
    1,
    input.staleRunMinutesByLane?.extended ??
      Math.max(staleRunMinutesMaintenance, 25),
  );
  const runProgressGraceMinutes = Math.max(
    1,
    input.runProgressGraceMinutes ?? 3,
  );
  const staleRunRows = (await sql`
    WITH stale_candidates AS (
      SELECT
        run.id,
        run.partition_id,
        run.worker_id,
        run.lane,
        COALESCE(run.started_at, run.created_at) AS started_at,
        partition.status AS partition_status,
        partition.last_error AS partition_last_error,
        partition.finished_at AS partition_finished_at,
        COALESCE(checkpoint.progress_heartbeat_at, checkpoint.updated_at) AS progress_updated_at,
        checkpoint.phase AS checkpoint_phase,
        lease.lease_owner AS active_lease_owner,
        lease.updated_at AS lease_updated_at,
        lease.lease_expires_at AS lease_expires_at,
        COALESCE(partition.lease_epoch, 0) AS partition_lease_epoch,
        checkpoint.checkpoint_lease_epoch,
        CASE
          WHEN run.lane = 'core' THEN ${staleRunMinutesCore}::int
          WHEN run.lane = 'maintenance' THEN ${staleRunMinutesMaintenance}::int
          ELSE ${staleRunMinutesExtended}::int
        END AS stale_threshold_minutes,
        EXISTS (
          SELECT 1
          FROM google_ads_sync_partitions partition
          WHERE partition.id = run.partition_id
            AND partition.status NOT IN ('leased', 'running')
        ) AS partition_state_invalid
      FROM google_ads_sync_runs run
      LEFT JOIN google_ads_sync_partitions partition
        ON partition.id = run.partition_id
      LEFT JOIN LATERAL (
        SELECT
          checkpoint.phase,
          checkpoint.progress_heartbeat_at,
          checkpoint.updated_at,
          COALESCE(checkpoint.lease_epoch, 0) AS checkpoint_lease_epoch
        FROM google_ads_sync_checkpoints checkpoint
        WHERE checkpoint.partition_id = run.partition_id
          AND COALESCE(checkpoint.lease_epoch, 0) = COALESCE(partition.lease_epoch, 0)
        ORDER BY checkpoint.updated_at DESC
        LIMIT 1
      ) checkpoint ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          lease.lease_owner,
          lease.updated_at,
          lease.lease_expires_at
        FROM sync_runner_leases lease
        WHERE lease.business_id = run.business_id
          AND lease.provider_scope = 'google_ads'
        ORDER BY lease.updated_at DESC
        LIMIT 1
      ) lease ON TRUE
      WHERE run.business_id = ${input.businessId}
        AND run.status = 'running'
    )
    UPDATE google_ads_sync_runs run
    SET
      status = CASE
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'succeeded'
          THEN 'succeeded'
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'cancelled'
          THEN 'cancelled'
        ELSE 'failed'
      END,
      error_class = CASE
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status IN ('succeeded', 'cancelled')
          THEN NULL
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'dead_letter'
          THEN COALESCE(error_class, 'dead_letter')
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'failed'
          THEN COALESCE(error_class, 'failed')
        ELSE COALESCE(error_class, 'stale_run')
      END,
      error_message = CASE
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status IN ('succeeded', 'cancelled')
          THEN NULL
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'dead_letter'
          THEN COALESCE(
            stale_candidates.partition_last_error,
            error_message,
            'partition already dead_letter'
          )
        WHEN stale_candidates.partition_state_invalid
          AND stale_candidates.partition_status = 'failed'
          THEN COALESCE(
            stale_candidates.partition_last_error,
            error_message,
            'partition already failed'
          )
        ELSE COALESCE(error_message, 'stale partition run closed automatically')
      END,
      finished_at = COALESCE(finished_at, stale_candidates.partition_finished_at, now()),
      duration_ms = COALESCE(
        duration_ms,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(run.started_at, run.created_at))) * 1000))::int
      ),
      meta_json = COALESCE(run.meta_json, '{}'::jsonb) || jsonb_build_object(
        'decisionCaller', 'cleanupGoogleAdsPartitionOrchestration',
        'checkpointPhase', stale_candidates.checkpoint_phase,
        'partitionLeaseEpoch', stale_candidates.partition_lease_epoch,
        'checkpointLeaseEpoch', stale_candidates.checkpoint_lease_epoch,
        'staleThresholdMs', stale_candidates.stale_threshold_minutes * 60000,
        'runAgeMs', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - stale_candidates.started_at)) * 1000))::int,
        'leaseAgeMs', CASE
          WHEN stale_candidates.lease_updated_at IS NULL THEN NULL
          ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - stale_candidates.lease_updated_at)) * 1000))::int
        END,
        'heartbeatAgeMs', CASE
          WHEN stale_candidates.progress_updated_at IS NULL THEN NULL
          ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - stale_candidates.progress_updated_at)) * 1000))::int
        END,
        'runnerLeaseSeen', COALESCE(stale_candidates.lease_expires_at > now(), false),
        'closureReason', CASE
          WHEN stale_candidates.partition_state_invalid
            AND stale_candidates.partition_status = 'succeeded'
            THEN 'partition_already_succeeded'
          WHEN stale_candidates.partition_state_invalid
            AND stale_candidates.partition_status = 'failed'
            THEN 'partition_already_failed'
          WHEN stale_candidates.partition_state_invalid
            AND stale_candidates.partition_status = 'dead_letter'
            THEN 'partition_already_dead_letter'
          WHEN stale_candidates.partition_state_invalid
            AND stale_candidates.partition_status = 'cancelled'
            THEN 'partition_already_cancelled'
          ELSE 'lane_stale_threshold_exceeded'
        END
      ),
      updated_at = now()
    FROM stale_candidates
    WHERE run.id = stale_candidates.id
      AND (
        COALESCE(run.started_at, run.created_at) <
          now() - ((stale_candidates.stale_threshold_minutes)::text || ' minutes')::interval
        OR stale_candidates.partition_state_invalid
      )
      AND NOT (
        stale_candidates.active_lease_owner IS NOT NULL
        AND stale_candidates.active_lease_owner = run.worker_id
        AND stale_candidates.lease_expires_at > now()
      )
      AND NOT (
        stale_candidates.progress_updated_at IS NOT NULL
        AND stale_candidates.progress_updated_at >
          now() - (${String(runProgressGraceMinutes)} || ' minutes')::interval
      )
    RETURNING run.id
  `) as Array<Record<string, unknown>>;

  return {
    candidateCount: candidates.length,
    closedTerminalRunningRunCount,
    closedTerminalRunningCheckpointCount,
    stalePartitionCount: stalePartitionIds.length,
    aliveSlowCount: dispositionCounts.alive_slow,
    poisonCandidateCount: poisonPartitionIds.length,
    duplicatePartitionCount: 0,
    staleRunCount: staleRunRows.length,
    duplicateLegacyCount,
    staleLegacyCount: staleLegacyRows.length,
    reclaimedCheckpointCount,
    poisonedCheckpointCount,
    reclaimReasons: {
      stalledReclaimable: stalledDecisions.map((row) => row.reasonCode),
      poisonCandidate: poisonDecisions.map((row) => row.reasonCode),
    },
  };
}

export async function getGoogleAdsPartitionDates(input: {
  businessId: string;
  providerAccountId?: string | null;
  lane?: GoogleAdsSyncLane | null;
  scope: GoogleAdsWarehouseScope;
  startDate: string;
  endDate: string;
  statuses?: GoogleAdsPartitionStatus[];
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    SELECT DISTINCT partition_date
    FROM google_ads_sync_partitions
    WHERE business_id = ${input.businessId}
      AND scope = ${input.scope}
      AND partition_date >= ${normalizeDate(input.startDate)}
      AND partition_date <= ${normalizeDate(input.endDate)}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      AND (${input.lane ?? null}::text IS NULL OR lane = ${input.lane ?? null})
      AND (
        COALESCE(array_length(${input.statuses ?? []}::text[], 1), 0) = 0
        OR status = ANY(${input.statuses ?? []}::text[])
      )
    ORDER BY partition_date DESC
  `) as Array<Record<string, unknown>>;

  return rows
    .map((row) =>
      row.partition_date ? normalizeDate(row.partition_date) : null,
    )
    .filter((value): value is string => Boolean(value));
}

export async function createGoogleAdsSyncRun(input: GoogleAdsSyncRunRecord) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const { businessRefId, providerAccountRefId } =
    await resolveGoogleAdsControlPlaneReferenceIds({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
    });
  await sql`
    UPDATE google_ads_sync_runs
    SET
      business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
      provider_account_ref_id = COALESCE(provider_account_ref_id, ${providerAccountRefId}),
      status = 'cancelled',
      error_class = COALESCE(error_class, 'superseded_attempt'),
      error_message = COALESCE(error_message, 'partition attempt was superseded by a newer worker'),
      finished_at = COALESCE(finished_at, now()),
      duration_ms = COALESCE(
        duration_ms,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(started_at, created_at))) * 1000))::int
      ),
      updated_at = now()
    WHERE partition_id = ${input.partitionId}
      AND status = 'running'
  `;
  const rows = (await sql`
    INSERT INTO google_ads_sync_runs (
      partition_id,
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      lane,
      scope,
      partition_date,
      status,
      worker_id,
      attempt_count,
      row_count,
      duration_ms,
      error_class,
      error_message,
      meta_json,
      started_at,
      finished_at,
      updated_at
    )
    VALUES (
      ${input.partitionId},
      ${input.businessId},
      ${businessRefId},
      ${input.providerAccountId},
      ${providerAccountRefId},
      ${input.lane},
      ${input.scope},
      ${normalizeDate(input.partitionDate)},
      ${input.status},
      ${input.workerId ?? null},
      ${input.attemptCount},
      ${input.rowCount ?? null},
      ${input.durationMs ?? null},
      ${input.errorClass ?? null},
      ${input.errorMessage ?? null},
      ${JSON.stringify(input.metaJson ?? {})}::jsonb,
      COALESCE(${input.startedAt ?? null}, now()),
      ${input.finishedAt ?? null},
      now()
    )
    RETURNING id
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function updateGoogleAdsSyncRun(input: {
  id: string;
  status: GoogleAdsSyncRunRecord["status"];
  rowCount?: number | null;
  durationMs?: number | null;
  errorClass?: string | null;
  errorMessage?: string | null;
  metaJson?: Record<string, unknown>;
  finishedAt?: string | null;
  onlyIfCurrentStatus?: GoogleAdsSyncRunRecord["status"] | null;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  await sql`
    UPDATE google_ads_sync_runs
    SET
      status = ${input.status},
      row_count = COALESCE(${input.rowCount ?? null}, row_count),
      duration_ms = COALESCE(${input.durationMs ?? null}, duration_ms),
      error_class = CASE
        WHEN ${input.status} = 'succeeded' THEN NULL
        ELSE COALESCE(${input.errorClass ?? null}, error_class)
      END,
      error_message = CASE
        WHEN ${input.status} = 'succeeded' THEN NULL
        ELSE COALESCE(${input.errorMessage ?? null}, error_message)
      END,
      meta_json = COALESCE(${input.metaJson ? JSON.stringify(input.metaJson) : null}::jsonb, meta_json),
      finished_at = COALESCE(${input.finishedAt ?? null}, finished_at),
      updated_at = now()
    WHERE id = ${input.id}
      AND (${input.onlyIfCurrentStatus ?? null}::text IS NULL OR status = ${input.onlyIfCurrentStatus ?? null})
  `;
}

export async function getLatestRunningGoogleAdsSyncRunIdForPartition(input: {
  partitionId: string;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    SELECT id
    FROM google_ads_sync_runs
    WHERE partition_id = ${input.partitionId}
      AND status = 'running'
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function upsertGoogleAdsSyncState(
  input: GoogleAdsSyncStateRecord,
) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const { businessRefId, providerAccountRefId } =
    await resolveGoogleAdsControlPlaneReferenceIds({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
    });
  const existing =
    (
      await getGoogleAdsSyncState({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        scope: input.scope,
      })
    )[0] ?? null;
  const next = mergeGoogleAdsSyncStateWrite({
    existing,
    next: input,
  });
  await sql`
    INSERT INTO google_ads_sync_state (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      scope,
      historical_target_start,
      historical_target_end,
      effective_target_start,
      effective_target_end,
      ready_through_date,
      last_successful_partition_date,
      latest_background_activity_at,
      latest_successful_sync_at,
      completed_days,
      dead_letter_count,
      updated_at
    )
    VALUES (
      ${next.businessId},
      ${businessRefId},
      ${next.providerAccountId},
      ${providerAccountRefId},
      ${next.scope},
      ${normalizeDate(next.historicalTargetStart)},
      ${normalizeDate(next.historicalTargetEnd)},
      ${normalizeDate(next.effectiveTargetStart)},
      ${normalizeDate(next.effectiveTargetEnd)},
      ${next.readyThroughDate ? normalizeDate(next.readyThroughDate) : null},
      ${next.lastSuccessfulPartitionDate ? normalizeDate(next.lastSuccessfulPartitionDate) : null},
      ${next.latestBackgroundActivityAt ?? null},
      ${next.latestSuccessfulSyncAt ?? null},
      ${next.completedDays},
      ${next.deadLetterCount},
      now()
    )
    ON CONFLICT (business_id, provider_account_id, scope)
    DO UPDATE SET
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_sync_state.business_ref_id),
      provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_sync_state.provider_account_ref_id),
      historical_target_start = EXCLUDED.historical_target_start,
      historical_target_end = EXCLUDED.historical_target_end,
      effective_target_start = EXCLUDED.effective_target_start,
      effective_target_end = EXCLUDED.effective_target_end,
      ready_through_date = EXCLUDED.ready_through_date,
      last_successful_partition_date = EXCLUDED.last_successful_partition_date,
      latest_background_activity_at = EXCLUDED.latest_background_activity_at,
      latest_successful_sync_at = EXCLUDED.latest_successful_sync_at,
      completed_days = EXCLUDED.completed_days,
      dead_letter_count = EXCLUDED.dead_letter_count,
      updated_at = now()
  `;
}

export async function persistGoogleAdsRawSnapshot(
  input: GoogleAdsRawSnapshotRecord,
) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const { businessRefId, providerAccountRefId } =
    await resolveGoogleAdsControlPlaneReferenceIds({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      accountCurrency: input.accountCurrency ?? null,
      accountTimezone: input.accountTimezone ?? null,
    });
  const rows = (await sql`
    INSERT INTO google_ads_raw_snapshots (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      partition_id,
      checkpoint_id,
      endpoint_name,
      entity_scope,
      page_index,
      provider_cursor,
      start_date,
      end_date,
      account_timezone,
      account_currency,
      payload_json,
      payload_hash,
      request_context,
      response_headers,
      provider_http_status,
      status,
      fetched_at,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${businessRefId},
      ${input.providerAccountId},
      ${providerAccountRefId},
      ${input.partitionId ?? null},
      ${input.checkpointId ?? null},
      ${input.endpointName},
      ${input.entityScope},
      ${input.pageIndex ?? null},
      ${input.providerCursor ?? null},
      ${normalizeDate(input.startDate)},
      ${normalizeDate(input.endDate)},
      ${input.accountTimezone},
      ${input.accountCurrency},
      ${JSON.stringify(input.payloadJson)}::jsonb,
      ${input.payloadHash},
      ${JSON.stringify(input.requestContext ?? {})}::jsonb,
      ${JSON.stringify(input.responseHeaders ?? {})}::jsonb,
      ${input.providerHttpStatus},
      ${input.status},
      COALESCE(${input.fetchedAt ?? null}, now()),
      now()
    )
    RETURNING id
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function upsertGoogleAdsSyncCheckpoint(
  input: GoogleAdsSyncCheckpointRecord,
) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const { businessRefId, providerAccountRefId } =
    await resolveGoogleAdsControlPlaneReferenceIds({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
    });
  const checkpointHash =
    input.checkpointHash ??
    buildGoogleAdsSyncCheckpointHash({
      partitionId: input.partitionId,
      checkpointScope: input.checkpointScope,
      phase: input.phase,
      pageIndex: input.pageIndex,
      nextPageToken: input.nextPageToken ?? null,
      providerCursor: input.providerCursor ?? null,
    });
  const rows = (await sql`
    WITH owner_guard AS (
      SELECT id
      FROM google_ads_sync_partitions
      WHERE id = ${input.partitionId}
        AND (
          ${input.leaseOwner ?? null}::text IS NULL
          OR (
            lease_owner = ${input.leaseOwner ?? null}
            AND ${input.leaseEpoch ?? null}::bigint IS NOT NULL
            AND COALESCE(lease_epoch, 0) = ${input.leaseEpoch ?? null}::bigint
            AND COALESCE(lease_expires_at, now() - interval '1 second') > now()
          )
        )
    )
    INSERT INTO google_ads_sync_checkpoints (
      partition_id,
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      checkpoint_scope,
      is_paginated,
      phase,
      status,
      page_index,
      next_page_token,
      provider_cursor,
      raw_snapshot_ids,
      rows_fetched,
      rows_written,
      last_successful_entity_key,
      last_response_headers,
      checkpoint_hash,
      attempt_count,
      progress_heartbeat_at,
      retry_after_at,
      lease_epoch,
      lease_owner,
      lease_expires_at,
      poisoned_at,
      poison_reason,
      replay_reason_code,
      replay_detail,
      started_at,
      finished_at,
      updated_at
    )
    SELECT
      ${input.partitionId},
      ${input.businessId},
      ${businessRefId},
      ${input.providerAccountId},
      ${providerAccountRefId},
      ${input.checkpointScope},
      ${input.isPaginated ?? false},
      ${input.phase},
      ${input.status},
      ${input.pageIndex},
      ${input.nextPageToken ?? null},
      ${input.providerCursor ?? null},
      ${JSON.stringify(input.rawSnapshotIds ?? [])}::jsonb,
      ${input.rowsFetched ?? 0},
      ${input.rowsWritten ?? 0},
      ${input.lastSuccessfulEntityKey ?? null},
      ${JSON.stringify(input.lastResponseHeaders ?? {})}::jsonb,
      ${checkpointHash},
      ${input.attemptCount},
      COALESCE(${input.progressHeartbeatAt ?? null}, now()),
      ${input.retryAfterAt ?? null},
      ${input.leaseEpoch ?? null},
      ${input.leaseOwner ?? null},
      ${input.leaseExpiresAt ?? null},
      ${input.poisonedAt ?? null},
      ${input.poisonReason ?? null},
      ${input.replayReasonCode ?? null},
      ${input.replayDetail ?? null},
      ${input.startedAt ?? null},
      ${input.finishedAt ?? null},
      now()
    FROM owner_guard
    ON CONFLICT (partition_id, checkpoint_scope)
    DO UPDATE SET
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_sync_checkpoints.business_ref_id),
      provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_sync_checkpoints.provider_account_ref_id),
      is_paginated = EXCLUDED.is_paginated,
      phase = EXCLUDED.phase,
      status = EXCLUDED.status,
      page_index = EXCLUDED.page_index,
      next_page_token = EXCLUDED.next_page_token,
      provider_cursor = EXCLUDED.provider_cursor,
      raw_snapshot_ids = EXCLUDED.raw_snapshot_ids,
      rows_fetched = EXCLUDED.rows_fetched,
      rows_written = EXCLUDED.rows_written,
      last_successful_entity_key = EXCLUDED.last_successful_entity_key,
      last_response_headers = EXCLUDED.last_response_headers,
      checkpoint_hash = EXCLUDED.checkpoint_hash,
      attempt_count = EXCLUDED.attempt_count,
      progress_heartbeat_at = COALESCE(EXCLUDED.progress_heartbeat_at, now()),
      retry_after_at = EXCLUDED.retry_after_at,
      lease_epoch = EXCLUDED.lease_epoch,
      lease_owner = EXCLUDED.lease_owner,
      lease_expires_at = EXCLUDED.lease_expires_at,
      poisoned_at = CASE
        WHEN EXCLUDED.status = 'succeeded' AND EXCLUDED.poisoned_at IS NULL
          THEN NULL
        ELSE COALESCE(EXCLUDED.poisoned_at, google_ads_sync_checkpoints.poisoned_at)
      END,
      poison_reason = CASE
        WHEN EXCLUDED.status = 'succeeded' AND EXCLUDED.poisoned_at IS NULL
          THEN NULL
        ELSE COALESCE(EXCLUDED.poison_reason, google_ads_sync_checkpoints.poison_reason)
      END,
      replay_reason_code = COALESCE(EXCLUDED.replay_reason_code, google_ads_sync_checkpoints.replay_reason_code),
      replay_detail = COALESCE(EXCLUDED.replay_detail, google_ads_sync_checkpoints.replay_detail),
      started_at = COALESCE(google_ads_sync_checkpoints.started_at, EXCLUDED.started_at, now()),
      finished_at = EXCLUDED.finished_at,
      updated_at = now()
    WHERE EXISTS (SELECT 1 FROM owner_guard)
    RETURNING id
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function getGoogleAdsSyncCheckpoint(input: {
  partitionId: string;
  checkpointScope: string;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM google_ads_sync_checkpoints
    WHERE partition_id = ${input.partitionId}
      AND checkpoint_scope = ${input.checkpointScope}
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    partitionId: String(row.partition_id),
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    checkpointScope: String(row.checkpoint_scope),
    isPaginated: Boolean(row.is_paginated),
    phase: String(row.phase) as GoogleAdsSyncCheckpointRecord["phase"],
    status: String(row.status) as GoogleAdsSyncCheckpointRecord["status"],
    pageIndex: toNumber(row.page_index),
    nextPageToken: row.next_page_token ? String(row.next_page_token) : null,
    providerCursor: row.provider_cursor ? String(row.provider_cursor) : null,
    rawSnapshotIds: Array.isArray(row.raw_snapshot_ids)
      ? row.raw_snapshot_ids.map((value) => String(value))
      : [],
    rowsFetched: toNumber(row.rows_fetched),
    rowsWritten: toNumber(row.rows_written),
    lastSuccessfulEntityKey: row.last_successful_entity_key
      ? String(row.last_successful_entity_key)
      : null,
    lastResponseHeaders:
      row.last_response_headers && typeof row.last_response_headers === "object"
        ? (row.last_response_headers as Record<string, unknown>)
        : {},
    checkpointHash: row.checkpoint_hash ? String(row.checkpoint_hash) : null,
    attemptCount: toNumber(row.attempt_count),
    progressHeartbeatAt: normalizeTimestamp(row.progress_heartbeat_at),
    retryAfterAt: normalizeTimestamp(row.retry_after_at),
    leaseEpoch:
      row.lease_epoch == null ? null : toNumber(row.lease_epoch),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseExpiresAt: normalizeTimestamp(row.lease_expires_at),
    poisonedAt: normalizeTimestamp(row.poisoned_at),
    poisonReason: row.poison_reason ? String(row.poison_reason) : null,
    replayReasonCode: row.replay_reason_code
      ? String(row.replay_reason_code)
      : null,
    replayDetail: row.replay_detail ? String(row.replay_detail) : null,
    startedAt: normalizeTimestamp(row.started_at),
    finishedAt: normalizeTimestamp(row.finished_at),
    createdAt: normalizeTimestamp(row.created_at) ?? undefined,
    updatedAt: normalizeTimestamp(row.updated_at) ?? undefined,
  } satisfies GoogleAdsSyncCheckpointRecord;
}

export async function getLatestGoogleAdsCheckpointForPartition(input: {
  partitionId: string;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM google_ads_sync_checkpoints
    WHERE partition_id = ${input.partitionId}
    ORDER BY updated_at DESC
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    partitionId: String(row.partition_id),
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    checkpointScope: String(row.checkpoint_scope),
    isPaginated: Boolean(row.is_paginated),
    phase: String(row.phase) as GoogleAdsSyncCheckpointRecord["phase"],
    status: String(row.status) as GoogleAdsSyncCheckpointRecord["status"],
    pageIndex: toNumber(row.page_index),
    nextPageToken: row.next_page_token ? String(row.next_page_token) : null,
    providerCursor: row.provider_cursor ? String(row.provider_cursor) : null,
    rawSnapshotIds: Array.isArray(row.raw_snapshot_ids)
      ? row.raw_snapshot_ids.map((value) => String(value))
      : [],
    rowsFetched: toNumber(row.rows_fetched),
    rowsWritten: toNumber(row.rows_written),
    lastSuccessfulEntityKey: row.last_successful_entity_key
      ? String(row.last_successful_entity_key)
      : null,
    lastResponseHeaders:
      row.last_response_headers && typeof row.last_response_headers === "object"
        ? (row.last_response_headers as Record<string, unknown>)
        : {},
    checkpointHash: row.checkpoint_hash ? String(row.checkpoint_hash) : null,
    attemptCount: toNumber(row.attempt_count),
    progressHeartbeatAt: normalizeTimestamp(row.progress_heartbeat_at),
    retryAfterAt: normalizeTimestamp(row.retry_after_at),
    leaseEpoch:
      row.lease_epoch == null ? null : toNumber(row.lease_epoch),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseExpiresAt: normalizeTimestamp(row.lease_expires_at),
    poisonedAt: normalizeTimestamp(row.poisoned_at),
    poisonReason: row.poison_reason ? String(row.poison_reason) : null,
    replayReasonCode: row.replay_reason_code
      ? String(row.replay_reason_code)
      : null,
    replayDetail: row.replay_detail ? String(row.replay_detail) : null,
    startedAt: normalizeTimestamp(row.started_at),
    finishedAt: normalizeTimestamp(row.finished_at),
    createdAt: normalizeTimestamp(row.created_at) ?? undefined,
    updatedAt: normalizeTimestamp(row.updated_at) ?? undefined,
  } satisfies GoogleAdsSyncCheckpointRecord;
}

export async function listGoogleAdsRawSnapshotsForPartition(input: {
  partitionId: string;
  endpointName: string;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  return sql`
    SELECT
      id,
      checkpoint_id,
      page_index,
      payload_json,
      response_headers,
      provider_cursor,
      request_context,
      provider_http_status,
      status,
      fetched_at
    FROM google_ads_raw_snapshots
    WHERE partition_id = ${input.partitionId}
      AND endpoint_name = ${input.endpointName}
    ORDER BY COALESCE(page_index, 0) ASC, fetched_at ASC
  ` as unknown as Array<{
    id: string;
    checkpoint_id: string | null;
    page_index: number | null;
    payload_json: unknown;
    response_headers: Record<string, unknown> | null;
    provider_cursor: string | null;
    request_context: Record<string, unknown> | null;
    provider_http_status: number | null;
    status: string;
    fetched_at: string | null;
  }>;
}

export function dedupeGoogleAdsWarehouseRows(
  rows: GoogleAdsWarehouseDailyRow[],
) {
  const dedupedRows: GoogleAdsWarehouseDailyRow[] = [];
  const seenKeys = new Set<string>();
  const duplicateExamples: string[] = [];
  let duplicateCount = 0;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const key = [
      row.businessId,
      row.providerAccountId,
      normalizeDate(row.date),
      row.entityKey,
    ].join("::");
    if (seenKeys.has(key)) {
      duplicateCount += 1;
      if (duplicateExamples.length < 5) duplicateExamples.push(key);
      continue;
    }
    seenKeys.add(key);
    dedupedRows.push(row);
  }

  dedupedRows.reverse();
  return {
    rows: dedupedRows,
    duplicateCount,
    duplicateExamples,
  };
}

function googleAdsWarehouseEnvNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getGoogleAdsWarehouseUpsertBatchSize(scope: GoogleAdsWarehouseScope) {
  if (scope === "product_daily") {
    return googleAdsWarehouseEnvNumber(
      "GOOGLE_ADS_PRODUCT_WAREHOUSE_UPSERT_BATCH_SIZE",
      1_000,
    );
  }
  return 250;
}

function serializeGoogleAdsProductDailyRow(
  row: GoogleAdsWarehouseDailyRow,
  businessRefIds: Map<string, string>,
  providerAccountRefIds: Map<string, string>,
) {
  const projection = normalizeGoogleAdsProjectionJson(row);
  const date = normalizeDate(row.date);
  return {
    business_id: row.businessId,
    business_ref_id: businessRefIds.get(row.businessId) ?? null,
    provider_account_id: row.providerAccountId,
    provider_account_ref_id:
      providerAccountRefIds.get(row.providerAccountId) ?? null,
    date,
    account_timezone: row.accountTimezone,
    account_currency: row.accountCurrency,
    entity_key: row.entityKey,
    entity_label: row.entityLabel,
    campaign_id: row.campaignId,
    campaign_name: row.campaignName,
    ad_group_id: row.adGroupId,
    ad_group_name: row.adGroupName,
    status: row.status,
    channel: row.channel,
    classification: row.classification,
    payload_json: row.payloadJson ?? {},
    spend: row.spend,
    revenue: row.revenue,
    conversions: row.conversions,
    impressions: row.impressions,
    clicks: row.clicks,
    ctr: row.ctr,
    cpc: row.cpc,
    cpa: row.cpa,
    roas: row.roas,
    conversion_rate: row.conversionRate,
    interaction_rate: row.interactionRate,
    source_snapshot_id: row.sourceSnapshotId,
    product_key: row.entityKey,
    product_title: String(
      projection["productTitle"] ??
        projection["title"] ??
        row.entityLabel ??
        row.entityKey,
    ),
    normalized_status: row.status,
    projection_json: projection,
    first_seen_at: `${date}T00:00:00.000Z`,
    last_seen_at: `${date}T00:00:00.000Z`,
    source_updated_at: buildGoogleAdsHistoryCapturedAt(row),
  };
}

async function upsertGoogleAdsProductDailyRowsFromJson(input: {
  rows: GoogleAdsWarehouseDailyRow[];
  businessRefIds: Map<string, string>;
  providerAccountRefIds: Map<string, string>;
}) {
  if (input.rows.length === 0) return;
  const sql = getDb();
  const payload = JSON.stringify(
    input.rows.map((row) =>
      serializeGoogleAdsProductDailyRow(
        row,
        input.businessRefIds,
        input.providerAccountRefIds,
      ),
    ),
  );

  await sql.query(
    `
      WITH input_rows AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS row (
          business_id text,
          business_ref_id text,
          provider_account_id text,
          provider_account_ref_id text,
          date text,
          account_timezone text,
          account_currency text,
          entity_key text,
          entity_label text,
          campaign_id text,
          campaign_name text,
          ad_group_id text,
          ad_group_name text,
          status text,
          channel text,
          classification text,
          payload_json jsonb,
          spend numeric,
          revenue numeric,
          conversions numeric,
          impressions bigint,
          clicks bigint,
          ctr numeric,
          cpc numeric,
          cpa numeric,
          roas numeric,
          conversion_rate numeric,
          interaction_rate numeric,
          source_snapshot_id text,
          product_key text,
          product_title text,
          normalized_status text,
          projection_json jsonb,
          first_seen_at text,
          last_seen_at text,
          source_updated_at text
        )
      ),
      daily_upsert AS (
        INSERT INTO google_ads_product_daily (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          date,
          account_timezone,
          account_currency,
          entity_key,
          entity_label,
          campaign_id,
          campaign_name,
          ad_group_id,
          ad_group_name,
          status,
          channel,
          classification,
          payload_json,
          spend,
          revenue,
          conversions,
          impressions,
          clicks,
          ctr,
          cpc,
          cpa,
          roas,
          conversion_rate,
          interaction_rate,
          source_snapshot_id,
          updated_at
        )
        SELECT
          business_id,
          NULLIF(business_ref_id, '')::uuid,
          provider_account_id,
          NULLIF(provider_account_ref_id, '')::uuid,
          date::date,
          account_timezone,
          account_currency,
          entity_key,
          entity_label,
          campaign_id,
          campaign_name,
          ad_group_id,
          ad_group_name,
          status,
          channel,
          classification,
          COALESCE(payload_json, '{}'::jsonb),
          COALESCE(spend, 0),
          COALESCE(revenue, 0),
          COALESCE(conversions, 0),
          COALESCE(impressions, 0),
          COALESCE(clicks, 0),
          ctr,
          cpc,
          cpa,
          COALESCE(roas, 0),
          conversion_rate,
          interaction_rate,
          NULLIF(source_snapshot_id, '')::uuid,
          now()
        FROM input_rows
        ON CONFLICT (business_id, provider_account_id, date, entity_key) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_product_daily.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_product_daily.provider_account_ref_id),
          entity_label = EXCLUDED.entity_label,
          campaign_id = EXCLUDED.campaign_id,
          campaign_name = EXCLUDED.campaign_name,
          ad_group_id = EXCLUDED.ad_group_id,
          ad_group_name = EXCLUDED.ad_group_name,
          status = EXCLUDED.status,
          channel = EXCLUDED.channel,
          classification = EXCLUDED.classification,
          payload_json = EXCLUDED.payload_json,
          spend = EXCLUDED.spend,
          revenue = EXCLUDED.revenue,
          conversions = EXCLUDED.conversions,
          impressions = EXCLUDED.impressions,
          clicks = EXCLUDED.clicks,
          ctr = EXCLUDED.ctr,
          cpc = EXCLUDED.cpc,
          cpa = EXCLUDED.cpa,
          roas = EXCLUDED.roas,
          conversion_rate = EXCLUDED.conversion_rate,
          interaction_rate = EXCLUDED.interaction_rate,
          source_snapshot_id = EXCLUDED.source_snapshot_id,
          updated_at = now()
        RETURNING 1
      ),
      dimension_upsert AS (
        INSERT INTO google_ads_product_dimensions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          product_key,
          product_title,
          normalized_status,
          projection_json,
          first_seen_at,
          last_seen_at,
          source_updated_at,
          created_at,
          updated_at
        )
        SELECT
          business_id,
          NULLIF(business_ref_id, '')::uuid,
          provider_account_id,
          NULLIF(provider_account_ref_id, '')::uuid,
          campaign_id,
          product_key,
          product_title,
          normalized_status,
          COALESCE(projection_json, '{}'::jsonb),
          first_seen_at::timestamptz,
          last_seen_at::timestamptz,
          source_updated_at::timestamptz,
          now(),
          now()
        FROM input_rows
        ON CONFLICT (business_id, provider_account_id, product_key) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_product_dimensions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_product_dimensions.provider_account_ref_id),
          campaign_id = EXCLUDED.campaign_id,
          product_title = EXCLUDED.product_title,
          normalized_status = EXCLUDED.normalized_status,
          projection_json = EXCLUDED.projection_json,
          first_seen_at = LEAST(COALESCE(google_ads_product_dimensions.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(COALESCE(google_ads_product_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
          source_updated_at = GREATEST(COALESCE(google_ads_product_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
          updated_at = now()
        RETURNING 1
      )
      SELECT
        (SELECT COUNT(*) FROM daily_upsert) AS daily_count,
        (SELECT COUNT(*) FROM dimension_upsert) AS dimension_count
    `,
    [payload],
  );
}

async function upsertGoogleAdsScopeDimensionRows(input: {
  scope: GoogleAdsWarehouseScope;
  rows: GoogleAdsWarehouseDailyRow[];
  businessRefIds: Map<string, string>;
  providerAccountRefIds: Map<string, string>;
}) {
  if (!isGoogleAdsDimensionScope(input.scope) || input.rows.length === 0) return;
  const sql = getDb();
  const values: unknown[] = [];

  if (input.scope === "campaign_daily") {
    const tuples = input.rows.map((row, index) => {
      const offset = index * 12;
      values.push(
        row.businessId,
        input.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        input.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId ?? row.entityKey,
        row.campaignName ?? row.entityLabel ?? row.entityKey,
        row.status,
        row.channel,
        JSON.stringify(normalizeGoogleAdsProjectionJson(row)),
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        buildGoogleAdsHistoryCapturedAt(row),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9}::jsonb,$${offset + 10}::timestamptz,$${offset + 11}::timestamptz,$${offset + 12}::timestamptz,now(),now())`;
    }).join(", ");

    await sql.query(
      `
        INSERT INTO google_ads_campaign_dimensions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          campaign_name,
          normalized_status,
          channel,
          projection_json,
          first_seen_at,
          last_seen_at,
          source_updated_at,
          created_at,
          updated_at
        )
        VALUES ${tuples}
        ON CONFLICT (business_id, provider_account_id, campaign_id) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_campaign_dimensions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_campaign_dimensions.provider_account_ref_id),
          campaign_name = EXCLUDED.campaign_name,
          normalized_status = EXCLUDED.normalized_status,
          channel = EXCLUDED.channel,
          projection_json = EXCLUDED.projection_json,
          first_seen_at = LEAST(COALESCE(google_ads_campaign_dimensions.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(COALESCE(google_ads_campaign_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
          source_updated_at = GREATEST(COALESCE(google_ads_campaign_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
          updated_at = now()
      `,
      values,
    );
    return;
  }

  if (input.scope === "ad_group_daily") {
    const tuples = input.rows.map((row, index) => {
      const offset = index * 12;
      values.push(
        row.businessId,
        input.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        input.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId,
        row.adGroupId ?? row.entityKey,
        row.adGroupName ?? row.entityLabel ?? row.entityKey,
        row.status,
        JSON.stringify(normalizeGoogleAdsProjectionJson(row)),
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        buildGoogleAdsHistoryCapturedAt(row),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9}::jsonb,$${offset + 10}::timestamptz,$${offset + 11}::timestamptz,$${offset + 12}::timestamptz,now(),now())`;
    }).join(", ");

    await sql.query(
      `
        INSERT INTO google_ads_ad_group_dimensions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          ad_group_id,
          ad_group_name,
          normalized_status,
          projection_json,
          first_seen_at,
          last_seen_at,
          source_updated_at,
          created_at,
          updated_at
        )
        VALUES ${tuples}
        ON CONFLICT (business_id, provider_account_id, ad_group_id) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_ad_group_dimensions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_ad_group_dimensions.provider_account_ref_id),
          campaign_id = EXCLUDED.campaign_id,
          ad_group_name = EXCLUDED.ad_group_name,
          normalized_status = EXCLUDED.normalized_status,
          projection_json = EXCLUDED.projection_json,
          first_seen_at = LEAST(COALESCE(google_ads_ad_group_dimensions.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(COALESCE(google_ads_ad_group_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
          source_updated_at = GREATEST(COALESCE(google_ads_ad_group_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
          updated_at = now()
      `,
      values,
    );
    return;
  }

  if (input.scope === "ad_daily") {
    const tuples = input.rows.map((row, index) => {
      const offset = index * 13;
      values.push(
        row.businessId,
        input.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        input.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId,
        row.adGroupId,
        row.entityKey,
        row.entityLabel ?? row.entityKey,
        row.status,
        JSON.stringify(normalizeGoogleAdsProjectionJson(row)),
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        buildGoogleAdsHistoryCapturedAt(row),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10}::jsonb,$${offset + 11}::timestamptz,$${offset + 12}::timestamptz,$${offset + 13}::timestamptz,now(),now())`;
    }).join(", ");

    await sql.query(
      `
        INSERT INTO google_ads_ad_dimensions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          ad_group_id,
          ad_id,
          ad_name,
          normalized_status,
          projection_json,
          first_seen_at,
          last_seen_at,
          source_updated_at,
          created_at,
          updated_at
        )
        VALUES ${tuples}
        ON CONFLICT (business_id, provider_account_id, ad_id) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_ad_dimensions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_ad_dimensions.provider_account_ref_id),
          campaign_id = EXCLUDED.campaign_id,
          ad_group_id = EXCLUDED.ad_group_id,
          ad_name = EXCLUDED.ad_name,
          normalized_status = EXCLUDED.normalized_status,
          projection_json = EXCLUDED.projection_json,
          first_seen_at = LEAST(COALESCE(google_ads_ad_dimensions.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(COALESCE(google_ads_ad_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
          source_updated_at = GREATEST(COALESCE(google_ads_ad_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
          updated_at = now()
      `,
      values,
    );
    return;
  }

  if (input.scope === "keyword_daily") {
    const tuples = input.rows.map((row, index) => {
      const offset = index * 13;
      const projection = normalizeGoogleAdsProjectionJson(row);
      values.push(
        row.businessId,
        input.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        input.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId,
        row.adGroupId,
        row.entityKey,
        String(projection["keywordText"] ?? projection["keyword"] ?? row.entityLabel ?? row.entityKey),
        row.status,
        JSON.stringify(projection),
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        buildGoogleAdsHistoryCapturedAt(row),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10}::jsonb,$${offset + 11}::timestamptz,$${offset + 12}::timestamptz,$${offset + 13}::timestamptz,now(),now())`;
    }).join(", ");

    await sql.query(
      `
        INSERT INTO google_ads_keyword_dimensions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          ad_group_id,
          keyword_id,
          keyword_text,
          normalized_status,
          projection_json,
          first_seen_at,
          last_seen_at,
          source_updated_at,
          created_at,
          updated_at
        )
        VALUES ${tuples}
        ON CONFLICT (business_id, provider_account_id, keyword_id) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_keyword_dimensions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_keyword_dimensions.provider_account_ref_id),
          campaign_id = EXCLUDED.campaign_id,
          ad_group_id = EXCLUDED.ad_group_id,
          keyword_text = EXCLUDED.keyword_text,
          normalized_status = EXCLUDED.normalized_status,
          projection_json = EXCLUDED.projection_json,
          first_seen_at = LEAST(COALESCE(google_ads_keyword_dimensions.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(COALESCE(google_ads_keyword_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
          source_updated_at = GREATEST(COALESCE(google_ads_keyword_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
          updated_at = now()
      `,
      values,
    );
    return;
  }

  if (input.scope === "asset_group_daily") {
    const tuples = input.rows.map((row, index) => {
      const offset = index * 12;
      const projection = normalizeGoogleAdsProjectionJson(row);
      values.push(
        row.businessId,
        input.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        input.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId,
        row.entityKey,
        String(projection["assetGroupName"] ?? projection["assetGroup"] ?? row.entityLabel ?? row.entityKey),
        row.status,
        JSON.stringify(projection),
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        `${normalizeDate(row.date)}T00:00:00.000Z`,
        buildGoogleAdsHistoryCapturedAt(row),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9}::jsonb,$${offset + 10}::timestamptz,$${offset + 11}::timestamptz,$${offset + 12}::timestamptz,now(),now())`;
    }).join(", ");

    await sql.query(
      `
        INSERT INTO google_ads_asset_group_dimensions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          asset_group_id,
          asset_group_name,
          normalized_status,
          projection_json,
          first_seen_at,
          last_seen_at,
          source_updated_at,
          created_at,
          updated_at
        )
        VALUES ${tuples}
        ON CONFLICT (business_id, provider_account_id, asset_group_id) DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_asset_group_dimensions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_asset_group_dimensions.provider_account_ref_id),
          campaign_id = EXCLUDED.campaign_id,
          asset_group_name = EXCLUDED.asset_group_name,
          normalized_status = EXCLUDED.normalized_status,
          projection_json = EXCLUDED.projection_json,
          first_seen_at = LEAST(COALESCE(google_ads_asset_group_dimensions.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(COALESCE(google_ads_asset_group_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
          source_updated_at = GREATEST(COALESCE(google_ads_asset_group_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
          updated_at = now()
      `,
      values,
    );
    return;
  }

  const tuples = input.rows.map((row, index) => {
    const offset = index * 12;
    const projection = normalizeGoogleAdsProjectionJson(row);
    values.push(
      row.businessId,
      input.businessRefIds.get(row.businessId) ?? null,
      row.providerAccountId,
      input.providerAccountRefIds.get(row.providerAccountId) ?? null,
      row.campaignId,
      row.entityKey,
      String(projection["productTitle"] ?? projection["title"] ?? row.entityLabel ?? row.entityKey),
      row.status,
      JSON.stringify(projection),
      `${normalizeDate(row.date)}T00:00:00.000Z`,
      `${normalizeDate(row.date)}T00:00:00.000Z`,
      buildGoogleAdsHistoryCapturedAt(row),
    );
    return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9}::jsonb,$${offset + 10}::timestamptz,$${offset + 11}::timestamptz,$${offset + 12}::timestamptz,now(),now())`;
  }).join(", ");

  await sql.query(
    `
      INSERT INTO google_ads_product_dimensions (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        campaign_id,
        product_key,
        product_title,
        normalized_status,
        projection_json,
        first_seen_at,
        last_seen_at,
        source_updated_at,
        created_at,
        updated_at
      )
      VALUES ${tuples}
      ON CONFLICT (business_id, provider_account_id, product_key) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_product_dimensions.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_product_dimensions.provider_account_ref_id),
        campaign_id = EXCLUDED.campaign_id,
        product_title = EXCLUDED.product_title,
        normalized_status = EXCLUDED.normalized_status,
        projection_json = EXCLUDED.projection_json,
        first_seen_at = LEAST(COALESCE(google_ads_product_dimensions.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(COALESCE(google_ads_product_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
        source_updated_at = GREATEST(COALESCE(google_ads_product_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
        updated_at = now()
    `,
    values,
  );
}

async function appendGoogleAdsStateHistoryRows(input: {
  scope: GoogleAdsWarehouseScope;
  rows: GoogleAdsWarehouseDailyRow[];
  businessRefIds: Map<string, string>;
  providerAccountRefIds: Map<string, string>;
}) {
  if (input.rows.length === 0) return;
  const sql = getDb();

  if (input.scope === "campaign_daily") {
    const values: unknown[] = [];
    const tuples = input.rows.map((row, index) => {
      const offset = index * 14;
      const projection = normalizeGoogleAdsProjectionJson(row);
      values.push(
        row.businessId,
        input.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        input.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId ?? row.entityKey,
        buildGoogleAdsStateFingerprint({
          name: row.campaignName ?? row.entityLabel ?? row.entityKey,
          normalizedStatus: row.status,
          channel: row.channel,
          projectionJson: projection,
        }),
        row.campaignName ?? row.entityLabel ?? row.entityKey,
        row.status,
        row.channel,
        JSON.stringify(projection),
        row.sourceSnapshotId,
        buildGoogleAdsHistoryCapturedAt(row),
        normalizeDate(row.date),
        normalizeDate(row.date),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10}::jsonb,'warehouse_daily',$${offset + 11},$${offset + 12}::timestamptz,$${offset + 13}::date,$${offset + 14}::date,now())`;
    }).join(", ");
    await sql.query(
      `
        INSERT INTO google_ads_campaign_state_history (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          state_fingerprint,
          campaign_name,
          normalized_status,
          channel,
          projection_json,
          source_kind,
          source_snapshot_id,
          captured_at,
          effective_from,
          effective_to,
          created_at
        )
        VALUES ${tuples}
        ON CONFLICT (business_id, provider_account_id, campaign_id, state_fingerprint, captured_at) DO NOTHING
      `,
      values,
    );
    return;
  }

  if (input.scope === "ad_group_daily") {
    const values: unknown[] = [];
    const tuples = input.rows.map((row, index) => {
      const offset = index * 14;
      const projection = normalizeGoogleAdsProjectionJson(row);
      values.push(
        row.businessId,
        input.businessRefIds.get(row.businessId) ?? null,
        row.providerAccountId,
        input.providerAccountRefIds.get(row.providerAccountId) ?? null,
        row.campaignId,
        row.adGroupId ?? row.entityKey,
        buildGoogleAdsStateFingerprint({
          name: row.adGroupName ?? row.entityLabel ?? row.entityKey,
          normalizedStatus: row.status,
          projectionJson: projection,
        }),
        row.adGroupName ?? row.entityLabel ?? row.entityKey,
        row.status,
        JSON.stringify(projection),
        row.sourceSnapshotId,
        buildGoogleAdsHistoryCapturedAt(row),
        normalizeDate(row.date),
        normalizeDate(row.date),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10}::jsonb,'warehouse_daily',$${offset + 11},$${offset + 12}::timestamptz,$${offset + 13}::date,$${offset + 14}::date,now())`;
    }).join(", ");
    await sql.query(
      `
        INSERT INTO google_ads_ad_group_state_history (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          campaign_id,
          ad_group_id,
          state_fingerprint,
          ad_group_name,
          normalized_status,
          projection_json,
          source_kind,
          source_snapshot_id,
          captured_at,
          effective_from,
          effective_to,
          created_at
        )
        VALUES ${tuples}
        ON CONFLICT (business_id, provider_account_id, ad_group_id, state_fingerprint, captured_at) DO NOTHING
      `,
      values,
    );
  }
}

export async function upsertGoogleAdsDailyRows(
  scope: GoogleAdsWarehouseScope,
  rows: GoogleAdsWarehouseDailyRow[],
) {
  if (rows.length === 0) return;
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const table = tableNameForScope(scope);
  const batchSize = getGoogleAdsWarehouseUpsertBatchSize(scope);
  const {
    rows: dedupedRows,
    duplicateCount,
    duplicateExamples,
  } = dedupeGoogleAdsWarehouseRows(rows);

  if (duplicateCount > 0) {
    console.warn("[google-ads-warehouse] deduped-conflicting-input-rows", {
      scope,
      inputSize: rows.length,
      dedupedSize: dedupedRows.length,
      duplicateCount,
      duplicateExamples,
    });
  }

  for (
    let batchStart = 0;
    batchStart < dedupedRows.length;
    batchStart += batchSize
  ) {
    const dedupedBatch = dedupedRows.slice(batchStart, batchStart + batchSize);
    const businessRefIds = await resolveBusinessReferenceIds(
      dedupedBatch.map((row) => row.businessId),
    );
    const providerAccountRefIds = await ensureProviderAccountReferenceIds({
      provider: "google",
      accounts: dedupedBatch.map((row) => ({
        externalAccountId: row.providerAccountId,
        accountName: scope === "account_daily" ? row.entityLabel ?? null : null,
        currency: row.accountCurrency,
        timezone: row.accountTimezone,
      })),
    });
    if (scope === "product_daily") {
      await upsertGoogleAdsProductDailyRowsFromJson({
        rows: dedupedBatch,
        businessRefIds,
        providerAccountRefIds,
      });
    } else {
      const values: unknown[] = [];
      const tuples = dedupedBatch.map((row, index) => {
        const offset = index * 29;
        values.push(
          row.businessId,
          businessRefIds.get(row.businessId) ?? null,
          row.providerAccountId,
          providerAccountRefIds.get(row.providerAccountId) ?? null,
          normalizeDate(row.date),
          row.accountTimezone,
          row.accountCurrency,
          row.entityKey,
          row.entityLabel,
          row.campaignId,
          row.campaignName,
          row.adGroupId,
          row.adGroupName,
          row.status,
          row.channel,
          row.classification,
          JSON.stringify(row.payloadJson ?? {}),
          row.spend,
          row.revenue,
          row.conversions,
          row.impressions,
          row.clicks,
          row.ctr,
          row.cpc,
          row.cpa,
          row.roas,
          row.conversionRate,
          row.interactionRate,
          row.sourceSnapshotId,
        );
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12},$${offset + 13},$${offset + 14},$${offset + 15},$${offset + 16},$${offset + 17}::jsonb,$${offset + 18},$${offset + 19},$${offset + 20},$${offset + 21},$${offset + 22},$${offset + 23},$${offset + 24},$${offset + 25},$${offset + 26},$${offset + 27},$${offset + 28},$${offset + 29},now())`;
      });

      await sql.query(
        `
          INSERT INTO ${table} (
            business_id,
            business_ref_id,
            provider_account_id,
            provider_account_ref_id,
            date,
            account_timezone,
            account_currency,
            entity_key,
            entity_label,
            campaign_id,
            campaign_name,
            ad_group_id,
            ad_group_name,
            status,
            channel,
            classification,
            payload_json,
            spend,
            revenue,
            conversions,
            impressions,
            clicks,
            ctr,
            cpc,
            cpa,
            roas,
            conversion_rate,
            interaction_rate,
            source_snapshot_id,
            updated_at
          )
          VALUES ${tuples.join(",")}
          ON CONFLICT (business_id, provider_account_id, date, entity_key) DO UPDATE SET
            business_ref_id = COALESCE(EXCLUDED.business_ref_id, ${table}.business_ref_id),
            provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, ${table}.provider_account_ref_id),
            entity_label = EXCLUDED.entity_label,
            campaign_id = EXCLUDED.campaign_id,
            campaign_name = EXCLUDED.campaign_name,
            ad_group_id = EXCLUDED.ad_group_id,
            ad_group_name = EXCLUDED.ad_group_name,
            status = EXCLUDED.status,
            channel = EXCLUDED.channel,
            classification = EXCLUDED.classification,
            payload_json = EXCLUDED.payload_json,
            spend = EXCLUDED.spend,
            revenue = EXCLUDED.revenue,
            conversions = EXCLUDED.conversions,
            impressions = EXCLUDED.impressions,
            clicks = EXCLUDED.clicks,
            ctr = EXCLUDED.ctr,
            cpc = EXCLUDED.cpc,
            cpa = EXCLUDED.cpa,
            roas = EXCLUDED.roas,
            conversion_rate = EXCLUDED.conversion_rate,
            interaction_rate = EXCLUDED.interaction_rate,
            source_snapshot_id = EXCLUDED.source_snapshot_id,
            updated_at = now()
        `,
        values,
      );

      await upsertGoogleAdsScopeDimensionRows({
        scope,
        rows: dedupedBatch,
        businessRefIds,
        providerAccountRefIds,
      });
    }
    await appendGoogleAdsStateHistoryRows({
      scope,
      rows: dedupedBatch,
      businessRefIds,
      providerAccountRefIds,
    });
  }
  if (scope === "account_daily") {
    await refreshOverviewSummaryMaterializationFromGoogleAccountRows(rows).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[google-ads-warehouse] overview summary refresh failed", {
        businessId: rows[0]?.businessId ?? null,
        message,
      });
    });
  }
}

export async function readGoogleAdsDailyRange(input: {
  scope: GoogleAdsWarehouseScope;
  businessId: string;
  providerAccountIds?: string[] | null;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
  disableDimensionOverlay?: boolean;
}): Promise<GoogleAdsWarehouseDailyRow[]> {
  await assertGoogleAdsRequestReadTablesReady(
    [tableNameForScope(input.scope)],
    "google_ads_daily_range",
  );
  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  const table = tableNameForScope(input.scope);
  const rows = (await sql.query(
    `
      SELECT
        business_id,
        provider_account_id,
        date::text AS date,
        account_timezone,
        account_currency,
        entity_key,
        entity_label,
        campaign_id,
        campaign_name,
        ad_group_id,
        ad_group_name,
        status,
        channel,
        classification,
        payload_json,
        spend,
        revenue,
        conversions,
        impressions,
        clicks,
        ctr,
        cpc,
        cpa,
        roas,
        conversion_rate,
        interaction_rate,
        source_snapshot_id,
        created_at,
        updated_at
      FROM ${table}
      WHERE business_id = $1
        AND date >= $2
        AND date <= $3
        AND ($4::text[] IS NULL OR provider_account_id = ANY($4::text[]))
      ORDER BY date ASC, updated_at DESC
    `,
    [
      input.businessId,
      normalizeDate(input.startDate),
      normalizeDate(input.endDate),
      input.providerAccountIds?.length ? input.providerAccountIds : null,
    ],
  )) as Array<Record<string, unknown>>;

  const mappedRows = rows.map((row) => ({
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    date: normalizeDate(row.date),
    accountTimezone: String(row.account_timezone ?? "UTC"),
    accountCurrency: String(row.account_currency ?? "USD"),
    entityKey: String(row.entity_key),
    entityLabel: row.entity_label ? String(row.entity_label) : null,
    campaignId: row.campaign_id ? String(row.campaign_id) : null,
    campaignName: row.campaign_name ? String(row.campaign_name) : null,
    adGroupId: row.ad_group_id ? String(row.ad_group_id) : null,
    adGroupName: row.ad_group_name ? String(row.ad_group_name) : null,
    status: row.status ? String(row.status) : null,
    channel: row.channel ? String(row.channel) : null,
    classification: row.classification ? String(row.classification) : null,
    payloadJson: row.payload_json ?? {},
    spend: toNumber(row.spend),
    revenue: toNumber(row.revenue),
    conversions: toNumber(row.conversions),
    impressions: toNumber(row.impressions),
    clicks: toNumber(row.clicks),
    ctr: row.ctr == null ? null : toNumber(row.ctr),
    cpc: row.cpc == null ? null : toNumber(row.cpc),
    cpa: row.cpa == null ? null : toNumber(row.cpa),
    roas: toNumber(row.roas),
    conversionRate:
      row.conversion_rate == null ? null : toNumber(row.conversion_rate),
    interactionRate:
      row.interaction_rate == null ? null : toNumber(row.interaction_rate),
    sourceSnapshotId: row.source_snapshot_id
      ? String(row.source_snapshot_id)
      : null,
    createdAt: normalizeTimestamp(row.created_at) ?? undefined,
    updatedAt: normalizeTimestamp(row.updated_at) ?? undefined,
  })) as GoogleAdsWarehouseDailyRow[];

  if (input.disableDimensionOverlay) {
    return mappedRows;
  }

  return overlayGoogleAdsDimensionRows({
    scope: input.scope,
    businessId: input.businessId,
    rows: mappedRows,
  });
}

export async function getGoogleAdsWarehouseIntegrityIncidents(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    WITH account_rows AS (
      SELECT
        business_id,
        provider_account_id,
        date::text AS date,
        SUM(spend)::numeric AS account_spend,
        SUM(impressions)::numeric AS account_impressions,
        SUM(clicks)::numeric AS account_clicks,
        COUNT(*)::int AS account_row_count
      FROM google_ads_account_daily
      WHERE business_id = ${input.businessId}
        AND date BETWEEN ${input.startDate}::date AND ${input.endDate}::date
        AND (${input.providerAccountIds ?? null}::text[] IS NULL OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[]))
      GROUP BY business_id, provider_account_id, date::text
    ),
    campaign_rows AS (
      SELECT
        business_id,
        provider_account_id,
        date::text AS date,
        SUM(spend)::numeric AS campaign_spend,
        SUM(impressions)::numeric AS campaign_impressions,
        SUM(clicks)::numeric AS campaign_clicks,
        COUNT(*)::int AS campaign_row_count
      FROM google_ads_campaign_daily
      WHERE business_id = ${input.businessId}
        AND date BETWEEN ${input.startDate}::date AND ${input.endDate}::date
        AND (${input.providerAccountIds ?? null}::text[] IS NULL OR provider_account_id = ANY(${input.providerAccountIds ?? null}::text[]))
      GROUP BY business_id, provider_account_id, date::text
    )
    SELECT
      COALESCE(account_rows.business_id, campaign_rows.business_id) AS business_id,
      COALESCE(account_rows.provider_account_id, campaign_rows.provider_account_id) AS provider_account_id,
      COALESCE(account_rows.date, campaign_rows.date) AS date,
      account_rows.account_spend,
      account_rows.account_impressions,
      account_rows.account_clicks,
      account_rows.account_row_count,
      campaign_rows.campaign_spend,
      campaign_rows.campaign_impressions,
      campaign_rows.campaign_clicks,
      campaign_rows.campaign_row_count
    FROM account_rows
    FULL OUTER JOIN campaign_rows
      ON campaign_rows.business_id = account_rows.business_id
      AND campaign_rows.provider_account_id = account_rows.provider_account_id
      AND campaign_rows.date = account_rows.date
    ORDER BY COALESCE(account_rows.date, campaign_rows.date) ASC
  `) as Array<Record<string, unknown>>;

  const incidents: GoogleAdsWarehouseIntegrityIncident[] = [];
  for (const row of rows) {
    const accountRowCount = toNumber(row.account_row_count);
    const campaignRowCount = toNumber(row.campaign_row_count);
    if (accountRowCount <= 0 && campaignRowCount <= 0) continue;

    const accountSpend =
      row.account_spend == null ? null : toNumber(row.account_spend);
    const accountImpressions =
      row.account_impressions == null ? null : toNumber(row.account_impressions);
    const accountClicks =
      row.account_clicks == null ? null : toNumber(row.account_clicks);
    const campaignSpend =
      row.campaign_spend == null ? null : toNumber(row.campaign_spend);
    const campaignImpressions =
      row.campaign_impressions == null
        ? null
        : toNumber(row.campaign_impressions);
    const campaignClicks =
      row.campaign_clicks == null ? null : toNumber(row.campaign_clicks);

    const delta: GoogleAdsWarehouseIntegrityIncident["delta"] = {};
    const metricsCompared: string[] = [];
    const compareMetric = (
      metric: "spend" | "impressions" | "clicks",
      account: number | null,
      campaign: number | null,
    ) => {
      if (account == null && campaign == null) return;
      if (account == null || campaign == null) {
        delta[metric] = buildGoogleAdsIntegrityDelta({ account, campaign });
        metricsCompared.push(metric);
        return;
      }
      if (!withinGoogleAdsIntegrityTolerance(account, campaign)) {
        delta[metric] = buildGoogleAdsIntegrityDelta({ account, campaign });
        metricsCompared.push(metric);
      }
    };

    compareMetric("spend", accountSpend, campaignSpend);
    compareMetric("impressions", accountImpressions, campaignImpressions);
    compareMetric("clicks", accountClicks, campaignClicks);

    if (metricsCompared.length === 0) continue;

    let suspectedCause: GoogleAdsWarehouseIntegrityIncident["suspectedCause"] =
      "account_campaign_drift";
    if (accountRowCount <= 0 && campaignRowCount > 0) {
      suspectedCause = "missing_account_rollup";
    } else if (campaignRowCount <= 0 && accountRowCount > 0) {
      suspectedCause = "missing_campaign_rollup";
    }

    incidents.push({
      businessId: String(row.business_id),
      providerAccountId: String(row.provider_account_id),
      date: normalizeDate(row.date),
      scope: "system",
      severity: "error",
      metricsCompared,
      delta,
      repairRecommended: true,
      repairStatus: "pending",
      suspectedCause,
      details: {
        rowCounts: {
          account: accountRowCount,
          campaign: campaignRowCount,
        },
      },
    });
  }

  return incidents;
}

export async function readGoogleAdsAggregatedRange(input: {
  scope: GoogleAdsWarehouseScope;
  businessId: string;
  providerAccountIds?: string[] | null;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
  disableDimensionOverlay?: boolean;
}): Promise<Array<Record<string, unknown>>> {
  await assertGoogleAdsRequestReadTablesReady(
    [tableNameForScope(input.scope)],
    "google_ads_aggregated_range",
  );
  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  const table = tableNameForScope(input.scope);
  const payloadProjection = payloadProjectionSqlForScope(input.scope);
  const aggregateRows = (await sql.query(
    `
      SELECT
        entity_key,
        SUM(spend) AS spend,
        SUM(revenue) AS revenue,
        SUM(conversions) AS conversions,
        SUM(impressions) AS impressions,
        SUM(clicks) AS clicks,
        MAX(updated_at) AS updated_at
      FROM ${table}
      WHERE business_id = $1
        AND date >= $2
        AND date <= $3
        AND ($4::text[] IS NULL OR provider_account_id = ANY($4::text[]))
      GROUP BY entity_key
      ORDER BY SUM(spend) DESC, MAX(updated_at) DESC
    `,
    [
      input.businessId,
      normalizeDate(input.startDate),
      normalizeDate(input.endDate),
      input.providerAccountIds?.length ? input.providerAccountIds : null,
    ],
  )) as Array<Record<string, unknown>>;

  const latestRows = (await sql.query(
    `
      SELECT DISTINCT ON (entity_key)
        entity_key,
        entity_label,
        campaign_id,
        campaign_name,
        ad_group_id,
        ad_group_name,
        status,
        channel,
        classification,
        ${payloadProjection} AS payload_json,
        updated_at
      FROM ${table}
      WHERE business_id = $1
        AND date >= $2
        AND date <= $3
        AND ($4::text[] IS NULL OR provider_account_id = ANY($4::text[]))
      ORDER BY entity_key, updated_at DESC
    `,
    [
      input.businessId,
      normalizeDate(input.startDate),
      normalizeDate(input.endDate),
      input.providerAccountIds?.length ? input.providerAccountIds : null,
    ],
  )) as Array<Record<string, unknown>>;

  const latestByEntityKey = new Map(
    latestRows.map((row) => [String(row.entity_key), row] as const),
  );

  const aggregateBaseRows = aggregateRows.map((row) => {
    const latest = latestByEntityKey.get(String(row.entity_key)) ?? {};
    const payload =
      latest.payload_json && typeof latest.payload_json === "object"
        ? (latest.payload_json as Record<string, unknown>)
        : {};
    return {
      entityKey: String(row.entity_key),
      entityLabel: latest.entity_label ? String(latest.entity_label) : null,
      campaignId: latest.campaign_id ? String(latest.campaign_id) : null,
      campaignName: latest.campaign_name ? String(latest.campaign_name) : null,
      adGroupId: latest.ad_group_id ? String(latest.ad_group_id) : null,
      adGroupName: latest.ad_group_name ? String(latest.ad_group_name) : null,
      status: latest.status ? String(latest.status) : null,
      channel: latest.channel ? String(latest.channel) : null,
      classification: latest.classification
        ? String(latest.classification)
        : null,
      payloadJson: payload,
      spend: toNumber(row.spend),
      revenue: toNumber(row.revenue),
      conversions: toNumber(row.conversions),
      impressions: toNumber(row.impressions),
      clicks: toNumber(row.clicks),
      updatedAt: normalizeTimestamp(row.updated_at),
    };
  });

  const aggregateDimensionRows = input.disableDimensionOverlay
    ? aggregateBaseRows
    : await overlayGoogleAdsDimensionRows({
        scope: input.scope,
        businessId: input.businessId,
        rows: aggregateBaseRows,
      });

  return aggregateDimensionRows.map((row) => {
    const latest = latestByEntityKey.get(String(row.entityKey)) ?? {};
    const spend = toNumber(row.spend);
    const revenue = toNumber(row.revenue);
    const conversions = toNumber(row.conversions);
    const impressions = toNumber(row.impressions);
    const clicks = toNumber(row.clicks);
    const payload =
      row.payloadJson && typeof row.payloadJson === "object"
        ? (row.payloadJson as Record<string, unknown>)
        : latest.payload_json && typeof latest.payload_json === "object"
          ? (latest.payload_json as Record<string, unknown>)
          : {};
    const baseRow = {
      ...payload,
      id: String(payload.id ?? row.entityKey),
      name: String(payload.name ?? row.entityLabel ?? row.entityKey),
      entityKey: row.entityKey,
      entityLabel: row.entityLabel,
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      adGroupId: row.adGroupId,
      adGroupName: row.adGroupName,
      status: row.status,
      channel: row.channel,
      classification: row.classification,
      spend,
      revenue,
      conversions,
      impressions,
      clicks,
      roas: spend > 0 ? Number((revenue / spend).toFixed(2)) : 0,
      cpa: conversions > 0 ? Number((spend / conversions).toFixed(2)) : 0,
      ctr:
        impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
      cpc: clicks > 0 ? Number((spend / clicks).toFixed(2)) : null,
      conversionRate:
        clicks > 0 ? Number(((conversions / clicks) * 100).toFixed(2)) : null,
      updatedAt: row.updatedAt,
    } as Record<string, unknown>;

    if (input.scope === "product_daily") {
      return applyCanonicalGoogleAdsProductFields({
        row: baseRow,
        payload,
        entityLabel: row.entityLabel,
        entityKey: row.entityKey,
      });
    }

    return baseRow;
  });
}

function payloadProjectionSqlForScope(scope: GoogleAdsWarehouseScope) {
  switch (scope) {
    case "campaign_daily":
      return `
        jsonb_strip_nulls(jsonb_build_object(
          'id', payload_json -> 'id',
          'name', payload_json -> 'name',
          'status', payload_json -> 'status',
          'channel', payload_json -> 'channel',
          'servingStatus', payload_json -> 'servingStatus',
          'dailyBudget', payload_json -> 'dailyBudget',
          'campaignBudgetResourceName', payload_json -> 'campaignBudgetResourceName',
          'budgetDeliveryMethod', payload_json -> 'budgetDeliveryMethod',
          'budgetExplicitlyShared', payload_json -> 'budgetExplicitlyShared',
          'portfolioBidStrategyType', payload_json -> 'portfolioBidStrategyType',
          'portfolioBidStrategyResourceName', payload_json -> 'portfolioBidStrategyResourceName',
          'portfolioBidStrategyStatus', payload_json -> 'portfolioBidStrategyStatus',
          'portfolioTargetType', payload_json -> 'portfolioTargetType',
          'portfolioTargetValue', payload_json -> 'portfolioTargetValue',
          'impressionShare', payload_json -> 'impressionShare',
          'lostIsBudget', payload_json -> 'lostIsBudget',
          'lostIsRank', payload_json -> 'lostIsRank',
          'searchTopImpressionShare', payload_json -> 'searchTopImpressionShare',
          'searchAbsoluteTopImpressionShare', payload_json -> 'searchAbsoluteTopImpressionShare',
          'topImpressionPercentage', payload_json -> 'topImpressionPercentage',
          'absoluteTopImpressionPercentage', payload_json -> 'absoluteTopImpressionPercentage'
        ))
      `;
    case "search_term_daily":
      return `
        jsonb_strip_nulls(jsonb_build_object(
          'key', payload_json -> 'key',
          'searchTerm', payload_json -> 'searchTerm',
          'status', payload_json -> 'status',
          'campaignId', payload_json -> 'campaignId',
          'campaign', payload_json -> 'campaign',
          'campaignName', payload_json -> 'campaignName',
          'adGroupId', payload_json -> 'adGroupId',
          'adGroup', payload_json -> 'adGroup',
          'adGroupName', payload_json -> 'adGroupName',
          'intent', payload_json -> 'intent',
          'intentClass', payload_json -> 'intentClass',
          'isKeyword', payload_json -> 'isKeyword',
          'wasteFlag', payload_json -> 'wasteFlag',
          'keywordOpportunityFlag', payload_json -> 'keywordOpportunityFlag',
          'negativeKeywordFlag', payload_json -> 'negativeKeywordFlag',
          'clusterId', payload_json -> 'clusterId'
        ))
      `;
    case "product_daily":
      return `
        jsonb_strip_nulls(jsonb_build_object(
          'productId', payload_json -> 'productId',
          'productItemId', payload_json -> 'productItemId',
          'productTitle', payload_json -> 'productTitle',
          'itemId', payload_json -> 'itemId',
          'title', payload_json -> 'title',
          'merchantCenterId', payload_json -> 'merchantCenterId',
          'feedPrice', payload_json -> 'feedPrice',
          'campaignIds', payload_json -> 'campaignIds',
          'campaignNames', payload_json -> 'campaignNames',
          'contributionProxy', payload_json -> 'contributionProxy',
          'scaleState', payload_json -> 'scaleState',
          'underperformingState', payload_json -> 'underperformingState',
          'hiddenWinnerState', payload_json -> 'hiddenWinnerState',
          'statusLabel', payload_json -> 'statusLabel',
          'orders', payload_json -> 'orders'
        ))
      `;
    case "asset_daily":
      return `
        jsonb_strip_nulls(jsonb_build_object(
          'id', payload_json -> 'id',
          'assetId', payload_json -> 'assetId',
          'assetGroupId', payload_json -> 'assetGroupId',
          'assetGroupIdString', payload_json -> 'assetGroupIdString',
          'assetGroup', payload_json -> 'assetGroup',
          'assetGroupName', payload_json -> 'assetGroupName',
          'campaignId', payload_json -> 'campaignId',
          'campaign', payload_json -> 'campaign',
          'campaignName', payload_json -> 'campaignName',
          'fieldType', payload_json -> 'fieldType',
          'type', payload_json -> 'type',
          'assetType', payload_json -> 'assetType',
          'rawAssetType', payload_json -> 'rawAssetType',
          'name', payload_json -> 'name',
          'assetName', payload_json -> 'assetName',
          'text', payload_json -> 'text',
          'assetText', payload_json -> 'assetText',
          'imageUrl', payload_json -> 'imageUrl',
          'preview', payload_json -> 'preview',
          'videoId', payload_json -> 'videoId',
          'performanceLabel', payload_json -> 'performanceLabel',
          'hint', payload_json -> 'hint',
          'assetState', payload_json -> 'assetState',
          'wasteFlag', payload_json -> 'wasteFlag',
          'expandFlag', payload_json -> 'expandFlag'
        ))
      `;
    case "asset_group_daily":
      return `
        jsonb_strip_nulls(jsonb_build_object(
          'id', payload_json -> 'id',
          'assetGroupId', payload_json -> 'assetGroupId',
          'assetGroupName', payload_json -> 'assetGroupName',
          'campaignId', payload_json -> 'campaignId',
          'campaignName', payload_json -> 'campaignName',
          'status', payload_json -> 'status',
          'adStrength', payload_json -> 'adStrength',
          'finalUrls', payload_json -> 'finalUrls',
          'assetCountByType', payload_json -> 'assetCountByType',
          'missingAssetTypes', payload_json -> 'missingAssetTypes',
          'audienceSignals', payload_json -> 'audienceSignals',
          'searchThemesConfigured', payload_json -> 'searchThemesConfigured',
          'spendShare', payload_json -> 'spendShare',
          'revenueShare', payload_json -> 'revenueShare',
          'scaleState', payload_json -> 'scaleState',
          'weakState', payload_json -> 'weakState',
          'coverageRisk', payload_json -> 'coverageRisk',
          'messagingAlignmentScore', payload_json -> 'messagingAlignmentScore',
          'coverageScore', payload_json -> 'coverageScore',
          'assetCount', payload_json -> 'assetCount'
        ))
      `;
    case "geo_daily":
      return `
        jsonb_strip_nulls(jsonb_build_object(
          'geoId', payload_json -> 'geoId',
          'geoName', payload_json -> 'geoName',
          'geoState', payload_json -> 'geoState',
          'scaleFlag', payload_json -> 'scaleFlag',
          'reduceFlag', payload_json -> 'reduceFlag'
        ))
      `;
    case "device_daily":
      return `
        jsonb_strip_nulls(jsonb_build_object(
          'device', payload_json -> 'device',
          'deviceState', payload_json -> 'deviceState',
          'scaleFlag', payload_json -> 'scaleFlag',
          'weakFlag', payload_json -> 'weakFlag'
        ))
      `;
    case "audience_daily":
      return `
        jsonb_strip_nulls(jsonb_build_object(
          'audienceKey', payload_json -> 'audienceKey',
          'audienceNameBestEffort', payload_json -> 'audienceNameBestEffort',
          'audienceType', payload_json -> 'audienceType',
          'campaignId', payload_json -> 'campaignId',
          'campaignName', payload_json -> 'campaignName',
          'adGroupId', payload_json -> 'adGroupId',
          'adGroupName', payload_json -> 'adGroupName',
          'audienceState', payload_json -> 'audienceState',
          'weakSegmentFlag', payload_json -> 'weakSegmentFlag',
          'strongSegmentFlag', payload_json -> 'strongSegmentFlag'
        ))
      `;
    default:
      return "payload_json";
  }
}

export async function getGoogleAdsDailyCoverage(input: {
  scope: GoogleAdsWarehouseScope;
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
  includeMetadata?: boolean;
}) {
  await assertGoogleAdsRequestReadTablesReady(
    [tableNameForScope(input.scope), "google_ads_sync_partitions"],
    "google_ads_daily_coverage",
  );
  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  const table = tableNameForScope(input.scope);
  const normalizedStartDate = normalizeDate(input.startDate);
  const normalizedEndDate = normalizeDate(input.endDate);
  const providerAccountId = input.providerAccountId ?? null;
  const [coverageRows, metadataRows, partitionMetadataRows] =
    await Promise.all([
      (providerAccountId == null
        ? sql.query(
            `
            WITH covered_dates AS (
              SELECT DISTINCT date::date AS date
              FROM ${table}
              WHERE business_id = $1
                AND date >= $2
                AND date <= $3
              UNION
              SELECT DISTINCT partition_date::date AS date
              FROM google_ads_sync_partitions
              WHERE business_id = $1
                AND scope = $4
                AND partition_date >= $2
                AND partition_date <= $3
                AND status = 'succeeded'
            )
            SELECT
              COUNT(*) AS completed_days,
              COALESCE(MAX(date), NULL) AS ready_through_date
            FROM covered_dates
          `,
            [
              input.businessId,
              normalizedStartDate,
              normalizedEndDate,
              input.scope,
            ],
          )
        : sql.query(
            `
            WITH covered_dates AS (
              SELECT DISTINCT date::date AS date
              FROM ${table}
              WHERE business_id = $1
                AND provider_account_id = $2
                AND date >= $3
                AND date <= $4
              UNION
              SELECT DISTINCT partition_date::date AS date
              FROM google_ads_sync_partitions
              WHERE business_id = $1
                AND provider_account_id = $2
                AND scope = $5
                AND partition_date >= $3
                AND partition_date <= $4
                AND status = 'succeeded'
            )
            SELECT
              COUNT(*) AS completed_days,
              COALESCE(MAX(date), NULL) AS ready_through_date
            FROM covered_dates
          `,
            [
              input.businessId,
              providerAccountId,
              normalizedStartDate,
              normalizedEndDate,
              input.scope,
            ],
          )) as Promise<Array<Record<string, unknown>>>,
      input.includeMetadata
        ? ((providerAccountId == null
            ? sql.query(
                `
                SELECT
                  COUNT(*) AS total_rows
                FROM ${table}
                WHERE business_id = $1
                  AND date >= $2
                  AND date <= $3
              `,
                [input.businessId, normalizedStartDate, normalizedEndDate],
              )
            : sql.query(
                `
                SELECT
                  COUNT(*) AS total_rows
                FROM ${table}
                WHERE business_id = $1
                  AND provider_account_id = $2
                  AND date >= $3
                  AND date <= $4
              `,
                [
                  input.businessId,
                  providerAccountId,
                  normalizedStartDate,
                  normalizedEndDate,
                ],
              )) as Promise<Array<Record<string, unknown>>>)
        : Promise.resolve([] as Array<Record<string, unknown>>),
      input.includeMetadata
        ? ((providerAccountId == null
            ? sql.query(
                `
                SELECT
                  COALESCE(MAX(updated_at), NULL) AS latest_updated_at
                FROM google_ads_sync_partitions
                WHERE business_id = $1
                  AND scope = $2
                  AND partition_date >= $3
                  AND partition_date <= $4
                  AND status = 'succeeded'
              `,
                [
                  input.businessId,
                  input.scope,
                  normalizedStartDate,
                  normalizedEndDate,
                ],
              )
            : sql.query(
                `
                SELECT
                  COALESCE(MAX(updated_at), NULL) AS latest_updated_at
                FROM google_ads_sync_partitions
                WHERE business_id = $1
                  AND scope = $2
                  AND provider_account_id = $3
                  AND partition_date >= $4
                  AND partition_date <= $5
                  AND status = 'succeeded'
              `,
                [
                  input.businessId,
                  input.scope,
                  providerAccountId,
                  normalizedStartDate,
                  normalizedEndDate,
                ],
              )) as Promise<Array<Record<string, unknown>>>)
        : Promise.resolve([] as Array<Record<string, unknown>>),
    ]);
  const coverageRow = coverageRows[0] ?? {};
  const metadataRow = metadataRows[0] ?? {};
  const partitionMetadataRow = partitionMetadataRows[0] ?? {};
  return {
    completed_days: toNumber(coverageRow.completed_days),
    ready_through_date: coverageRow.ready_through_date
      ? normalizeDate(coverageRow.ready_through_date)
      : null,
    latest_updated_at: partitionMetadataRow.latest_updated_at
      ? normalizeTimestamp(partitionMetadataRow.latest_updated_at)
      : null,
    total_rows: toNumber(metadataRow.total_rows),
  };
}

export async function getGoogleAdsCoveredDates(input: {
  scope: GoogleAdsWarehouseScope;
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
}) {
  await assertGoogleAdsRequestReadTablesReady(
    [tableNameForScope(input.scope), "google_ads_sync_partitions"],
    "google_ads_covered_dates",
  );
  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  const table = tableNameForScope(input.scope);
  const normalizedStartDate = normalizeDate(input.startDate);
  const normalizedEndDate = normalizeDate(input.endDate);
  const providerAccountId = input.providerAccountId ?? null;
  const [rows, partitionRows] = await Promise.all([
    (providerAccountId == null
      ? sql.query(
          `
            SELECT DISTINCT date
            FROM ${table}
            WHERE business_id = $1
              AND date >= $2
              AND date <= $3
            ORDER BY date DESC
          `,
          [input.businessId, normalizedStartDate, normalizedEndDate],
        )
      : sql.query(
          `
            SELECT DISTINCT date
            FROM ${table}
            WHERE business_id = $1
              AND provider_account_id = $2
              AND date >= $3
              AND date <= $4
            ORDER BY date DESC
          `,
          [
            input.businessId,
            providerAccountId,
            normalizedStartDate,
            normalizedEndDate,
          ],
        )) as Promise<Array<Record<string, unknown>>>,
    (providerAccountId == null
      ? sql.query(
          `
            SELECT DISTINCT partition_date AS date
            FROM google_ads_sync_partitions
            WHERE business_id = $1
              AND scope = $2
              AND partition_date >= $3
              AND partition_date <= $4
              AND status = 'succeeded'
          `,
          [
            input.businessId,
            input.scope,
            normalizedStartDate,
            normalizedEndDate,
          ],
        )
      : sql.query(
          `
            SELECT DISTINCT partition_date AS date
            FROM google_ads_sync_partitions
            WHERE business_id = $1
              AND scope = $2
              AND provider_account_id = $3
              AND partition_date >= $4
              AND partition_date <= $5
              AND status = 'succeeded'
          `,
          [
            input.businessId,
            input.scope,
            providerAccountId,
            normalizedStartDate,
            normalizedEndDate,
          ],
        )) as Promise<Array<Record<string, unknown>>>,
  ]);

  return [...rows, ...partitionRows]
    .map((row) => (row.date ? normalizeDate(row.date) : null))
    .filter((value): value is string => Boolean(value));
}

export async function getGoogleAdsQueueHealth(input: { businessId: string }) {
  await assertGoogleAdsRequestReadTablesReady(
    ["google_ads_sync_partitions", "google_ads_sync_checkpoints"],
    "google_ads_queue_health",
  );
  const sql = getDb();
  const [rows, deadLetterRows] = await Promise.all([
    (sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued') AS queue_depth,
      COUNT(*) FILTER (WHERE status IN ('leased', 'running')) AS leased_partitions,
      COUNT(*) FILTER (WHERE lane = 'core' AND status = 'queued') AS core_queue_depth,
      COUNT(*) FILTER (WHERE lane = 'core' AND status IN ('leased', 'running')) AS core_leased_partitions,
      COUNT(*) FILTER (WHERE lane = 'extended' AND status = 'queued') AS extended_queue_depth,
      COUNT(*) FILTER (WHERE lane = 'extended' AND status IN ('leased', 'running')) AS extended_leased_partitions,
      COUNT(*) FILTER (
        WHERE lane = 'extended'
          AND (
            source IN ('selected_range', 'finalize_day', 'today', 'recent', 'recent_recovery')
            OR (
              source = 'core_success'
              AND partition_date >= CURRENT_DATE - interval '13 days'
            )
          )
          AND status = 'queued'
      ) AS extended_recent_queue_depth,
      COUNT(*) FILTER (
        WHERE lane = 'extended'
          AND (
            source IN ('selected_range', 'finalize_day', 'today', 'recent', 'recent_recovery')
            OR (
              source = 'core_success'
              AND partition_date >= CURRENT_DATE - interval '13 days'
            )
          )
          AND status IN ('leased', 'running')
      ) AS extended_recent_leased_partitions,
      COUNT(*) FILTER (
        WHERE lane = 'extended'
          AND (
            source IN ('historical', 'historical_recovery')
            OR (
              source = 'core_success'
              AND partition_date < CURRENT_DATE - interval '13 days'
            )
          )
          AND status = 'queued'
      ) AS extended_historical_queue_depth,
      COUNT(*) FILTER (
        WHERE lane = 'extended'
          AND (
            source IN ('historical', 'historical_recovery')
            OR (
              source = 'core_success'
              AND partition_date < CURRENT_DATE - interval '13 days'
            )
          )
          AND status IN ('leased', 'running')
      ) AS extended_historical_leased_partitions,
      COUNT(*) FILTER (WHERE lane = 'maintenance' AND status = 'queued') AS maintenance_queue_depth,
      COUNT(*) FILTER (WHERE lane = 'maintenance' AND status IN ('leased', 'running')) AS maintenance_leased_partitions,
      COUNT(*) FILTER (
        WHERE status = 'failed'
          AND COALESCE(next_retry_at, now()) <= now()
      ) AS retryable_failed_partitions,
      COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_partitions,
      COUNT(*) FILTER (
        WHERE status = 'dead_letter'
          AND NOT (
            lane = 'extended'
            AND (
              source IN ('historical', 'historical_recovery')
              OR (
                source = 'core_success'
                AND partition_date < CURRENT_DATE - interval '13 days'
              )
            )
            AND EXISTS (
              SELECT 1
              FROM google_ads_sync_checkpoints checkpoint
              WHERE checkpoint.partition_id = google_ads_sync_partitions.id
                AND checkpoint.poisoned_at IS NOT NULL
            )
          )
      ) AS blocking_dead_letter_partitions,
      COUNT(*) FILTER (
        WHERE status = 'dead_letter'
          AND lane = 'extended'
          AND (
            source IN ('historical', 'historical_recovery')
            OR (
              source = 'core_success'
              AND partition_date < CURRENT_DATE - interval '13 days'
            )
          )
          AND EXISTS (
            SELECT 1
            FROM google_ads_sync_checkpoints checkpoint
            WHERE checkpoint.partition_id = google_ads_sync_partitions.id
              AND checkpoint.poisoned_at IS NOT NULL
          )
      ) AS quarantined_historical_dead_letter_partitions,
      MIN(partition_date) FILTER (WHERE status = 'queued') AS oldest_queued_partition,
      MAX(updated_at) FILTER (WHERE lane = 'core') AS latest_core_activity_at,
      MAX(updated_at) FILTER (WHERE lane = 'extended') AS latest_extended_activity_at,
      MAX(updated_at) FILTER (WHERE lane = 'maintenance') AS latest_maintenance_activity_at
    FROM google_ads_sync_partitions
    WHERE business_id = ${input.businessId}
  `) as Promise<Array<Record<string, unknown>>>,
    (sql`
    SELECT
      partition.id,
      partition.lane,
      partition.scope,
      partition.source,
      partition.partition_date,
      partition.last_error,
      latest_run.error_class,
      latest_run.error_message,
      (
        partition.lane = 'extended'
        AND (
          partition.source IN ('historical', 'historical_recovery')
          OR (
            partition.source = 'core_success'
            AND partition.partition_date < CURRENT_DATE - interval '13 days'
          )
        )
        AND EXISTS (
          SELECT 1
          FROM google_ads_sync_checkpoints checkpoint
          WHERE checkpoint.partition_id = partition.id
            AND checkpoint.poisoned_at IS NOT NULL
        )
      ) AS is_historical_quarantined
    FROM google_ads_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT run.error_class, run.error_message
      FROM google_ads_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.updated_at DESC
      LIMIT 1
    ) latest_run ON true
    WHERE partition.business_id = ${input.businessId}
      AND partition.status = 'dead_letter'
  `) as Promise<GoogleAdsDeadLetterHealthRow[]>,
  ]);
  const classifiedDeadLetters = deadLetterRows.map((deadLetter) => ({
    row: deadLetter,
    classification: classifyGoogleAdsDeadLetterCandidate(deadLetter),
  }));
  const actionRequiredDeadLetterPartitions = classifiedDeadLetters.filter(
    ({ classification }) =>
      classification.recoveryKind === "terminal_action_required",
  ).length;
  const actionRequiredBlockingDeadLetterPartitions = classifiedDeadLetters.filter(
    ({ row: deadLetter, classification }) =>
      classification.recoveryKind === "terminal_action_required" &&
      !deadLetter.is_historical_quarantined,
  ).length;
  const replayableDeadLetterPartitions = classifiedDeadLetters.filter(
    ({ classification }) => classification.recoveryKind === "replayable_transient",
  ).length;
  const replayableBlockingDeadLetterPartitions = classifiedDeadLetters.filter(
    ({ row: deadLetter, classification }) =>
      classification.recoveryKind === "replayable_transient" &&
      !deadLetter.is_historical_quarantined,
  ).length;
  const unknownDeadLetterPartitions = classifiedDeadLetters.filter(
    ({ classification }) => classification.recoveryKind === "unknown",
  ).length;
  const unknownBlockingDeadLetterPartitions = classifiedDeadLetters.filter(
    ({ row: deadLetter, classification }) =>
      classification.recoveryKind === "unknown" &&
      !deadLetter.is_historical_quarantined,
  ).length;
  const coreBlockingDeadLetterPartitions = classifiedDeadLetters.filter(
    ({ row: deadLetter }) =>
      !deadLetter.is_historical_quarantined &&
      isGoogleAdsCoreReleaseScope(deadLetter.scope),
  ).length;
  const coreActionRequiredBlockingDeadLetterPartitions =
    classifiedDeadLetters.filter(
      ({ row: deadLetter, classification }) =>
        classification.recoveryKind === "terminal_action_required" &&
        !deadLetter.is_historical_quarantined &&
        isGoogleAdsCoreReleaseScope(deadLetter.scope),
    ).length;
  const actionRequiredDeadLetterScopes = sortedGoogleAdsScopes(
    classifiedDeadLetters
      .filter(
        ({ classification }) =>
          classification.recoveryKind === "terminal_action_required",
      )
      .map(({ row: deadLetter }) => deadLetter.scope),
  );
  const actionRequiredBlockingDeadLetterScopes = sortedGoogleAdsScopes(
    classifiedDeadLetters
      .filter(
        ({ row: deadLetter, classification }) =>
          classification.recoveryKind === "terminal_action_required" &&
          !deadLetter.is_historical_quarantined,
      )
      .map(({ row: deadLetter }) => deadLetter.scope),
  );
  const row = rows[0] ?? {};
  return {
    queueDepth: toNumber(row.queue_depth),
    leasedPartitions: toNumber(row.leased_partitions),
    coreQueueDepth: toNumber(row.core_queue_depth),
    coreLeasedPartitions: toNumber(row.core_leased_partitions),
    extendedQueueDepth: toNumber(row.extended_queue_depth),
    extendedLeasedPartitions: toNumber(row.extended_leased_partitions),
    extendedRecentQueueDepth: toNumber(row.extended_recent_queue_depth),
    extendedRecentLeasedPartitions: toNumber(
      row.extended_recent_leased_partitions,
    ),
    extendedHistoricalQueueDepth: toNumber(row.extended_historical_queue_depth),
    extendedHistoricalLeasedPartitions: toNumber(
      row.extended_historical_leased_partitions,
    ),
    maintenanceQueueDepth: toNumber(row.maintenance_queue_depth),
    maintenanceLeasedPartitions: toNumber(row.maintenance_leased_partitions),
    retryableFailedPartitions: toNumber(row.retryable_failed_partitions),
    deadLetterPartitions: toNumber(row.dead_letter_partitions),
    blockingDeadLetterPartitions: toNumber(row.blocking_dead_letter_partitions),
    quarantinedHistoricalDeadLetterPartitions: toNumber(
      row.quarantined_historical_dead_letter_partitions,
    ),
    actionRequiredDeadLetterPartitions,
    actionRequiredBlockingDeadLetterPartitions,
    actionRequiredDeadLetterScopes,
    actionRequiredBlockingDeadLetterScopes,
    coreBlockingDeadLetterPartitions,
    coreActionRequiredBlockingDeadLetterPartitions,
    replayableDeadLetterPartitions,
    replayableBlockingDeadLetterPartitions,
    unknownDeadLetterPartitions,
    unknownBlockingDeadLetterPartitions,
    oldestQueuedPartition: row.oldest_queued_partition
      ? normalizeDate(row.oldest_queued_partition)
      : null,
    latestCoreActivityAt: normalizeTimestamp(row.latest_core_activity_at),
    latestExtendedActivityAt: normalizeTimestamp(
      row.latest_extended_activity_at,
    ),
    latestMaintenanceActivityAt: normalizeTimestamp(
      row.latest_maintenance_activity_at,
    ),
  };
}

type GoogleAdsQueueHealthSnapshot = Awaited<ReturnType<typeof getGoogleAdsQueueHealth>>;

function hasGoogleAdsClassifiedBlockingDeadLetterCounts(
  queueHealth: GoogleAdsQueueHealthSnapshot | null | undefined,
) {
  return (
    queueHealth?.coreBlockingDeadLetterPartitions != null &&
    queueHealth.replayableBlockingDeadLetterPartitions != null &&
    queueHealth.unknownBlockingDeadLetterPartitions != null
  );
}

export function hasGoogleAdsThroughputBlockingDeadLetters(
  queueHealth: GoogleAdsQueueHealthSnapshot | null | undefined,
) {
  if (!queueHealth) return false;
  if (!hasGoogleAdsClassifiedBlockingDeadLetterCounts(queueHealth)) {
    return (queueHealth.deadLetterPartitions ?? 0) > 0;
  }
  return (
    (queueHealth.coreBlockingDeadLetterPartitions ?? 0) > 0 ||
    (queueHealth.replayableBlockingDeadLetterPartitions ?? 0) > 0 ||
    (queueHealth.unknownBlockingDeadLetterPartitions ?? 0) > 0
  );
}

export function hasGoogleAdsRepairableBlockingDeadLetters(
  queueHealth: GoogleAdsQueueHealthSnapshot | null | undefined,
) {
  if (!queueHealth) return false;
  if (!hasGoogleAdsClassifiedBlockingDeadLetterCounts(queueHealth)) {
    return (queueHealth.deadLetterPartitions ?? 0) > 0;
  }
  return (
    (queueHealth.replayableBlockingDeadLetterPartitions ?? 0) > 0 ||
    (queueHealth.unknownBlockingDeadLetterPartitions ?? 0) > 0
  );
}

export function getGoogleAdsWorkerDeadLetterBlockedReasonCodes(
  queueHealth: GoogleAdsQueueHealthSnapshot | null | undefined,
) {
  if (!queueHealth) return [];
  if (hasGoogleAdsThroughputBlockingDeadLetters(queueHealth)) {
    return ["required_dead_letter_partitions"];
  }
  if ((queueHealth.actionRequiredBlockingDeadLetterPartitions ?? 0) > 0) {
    return ["action_required_extended_dead_letter"];
  }
  return [];
}

export async function getGoogleAdsAdvisorQueueHealth(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  await assertGoogleAdsRequestReadTablesReady(
    ["google_ads_sync_partitions"],
    "google_ads_advisor_queue_health",
  );
  const sql = getDb();
  const rows = (await sql`
    SELECT
      COUNT(*) FILTER (
        WHERE scope IN ('campaign_daily', 'search_term_daily', 'product_daily')
          AND partition_date BETWEEN ${input.startDate}::date AND ${input.endDate}::date
          AND status = 'dead_letter'
      ) AS advisor_relevant_dead_letter_partitions,
      COUNT(*) FILTER (
        WHERE scope IN ('campaign_daily', 'search_term_daily', 'product_daily')
          AND partition_date BETWEEN ${input.startDate}::date AND ${input.endDate}::date
          AND status = 'failed'
      ) AS advisor_relevant_failed_partitions,
      COUNT(*) FILTER (
        WHERE scope IN ('campaign_daily', 'search_term_daily', 'product_daily')
          AND partition_date BETWEEN ${input.startDate}::date AND ${input.endDate}::date
          AND status IN ('leased', 'running')
      ) AS advisor_relevant_leased_partitions,
      COUNT(*) FILTER (
        WHERE status = 'dead_letter'
          AND (
            scope NOT IN ('campaign_daily', 'search_term_daily', 'product_daily')
            OR partition_date < ${input.startDate}::date
            OR partition_date > ${input.endDate}::date
          )
      ) AS historical_dead_letter_partitions
    FROM google_ads_sync_partitions
    WHERE business_id = ${input.businessId}
  `) as Array<Record<string, unknown>>;
  const row = rows[0] ?? {};
  return {
    advisorRelevantDeadLetterPartitions: toNumber(
      row.advisor_relevant_dead_letter_partitions,
    ),
    advisorRelevantFailedPartitions: toNumber(
      row.advisor_relevant_failed_partitions,
    ),
    advisorRelevantLeasedPartitions: toNumber(
      row.advisor_relevant_leased_partitions,
    ),
    historicalDeadLetterPartitions: toNumber(
      row.historical_dead_letter_partitions,
    ),
  };
}

export interface GoogleAdsAdvisorSurfacePartitionState {
  surface: GoogleAdsWarehouseScope;
  totalPartitions: number;
  queuedPartitions: number;
  leasedPartitions: number;
  runningPartitions: number;
  succeededPartitions: number;
  failedPartitions: number;
  deadLetterPartitions: number;
  cancelledPartitions: number;
  succeededEmptyPartitions: number;
  latestUpdatedAt: string | null;
  latestError: string | null;
}

export async function getGoogleAdsAdvisorSurfacePartitionStates(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
}): Promise<GoogleAdsAdvisorSurfacePartitionState[]> {
  await assertGoogleAdsRequestReadTablesReady(
    [
      "google_ads_sync_partitions",
      "google_ads_campaign_daily",
      "google_ads_product_daily",
      "google_ads_search_query_hot_daily",
      "google_ads_search_cluster_daily",
    ],
    "google_ads_advisor_surface_partition_states",
  );
  const sql = getDb();
  const providerAccountId = input.providerAccountId ?? null;
  const rows = (await sql`
    WITH advisor_surfaces(scope) AS (
      VALUES
        ('campaign_daily'::text),
        ('search_term_daily'::text),
        ('product_daily'::text)
    ),
    coverage_dates AS (
      SELECT 'campaign_daily'::text AS scope, date::date AS date
      FROM google_ads_campaign_daily
      WHERE business_id = ${input.businessId}
        AND (${providerAccountId}::text IS NULL OR provider_account_id = ${providerAccountId})
        AND date >= ${normalizeDate(input.startDate)}
        AND date <= ${normalizeDate(input.endDate)}
      UNION
      SELECT 'product_daily'::text AS scope, date::date AS date
      FROM google_ads_product_daily
      WHERE business_id = ${input.businessId}
        AND (${providerAccountId}::text IS NULL OR provider_account_id = ${providerAccountId})
        AND date >= ${normalizeDate(input.startDate)}
        AND date <= ${normalizeDate(input.endDate)}
      UNION
      SELECT 'search_term_daily'::text AS scope, date::date AS date
      FROM google_ads_search_query_hot_daily
      WHERE business_id = ${input.businessId}
        AND (${providerAccountId}::text IS NULL OR provider_account_id = ${providerAccountId})
        AND date >= ${normalizeDate(input.startDate)}
        AND date <= ${normalizeDate(input.endDate)}
      UNION
      SELECT 'search_term_daily'::text AS scope, date::date AS date
      FROM google_ads_search_cluster_daily
      WHERE business_id = ${input.businessId}
        AND (${providerAccountId}::text IS NULL OR provider_account_id = ${providerAccountId})
        AND date >= ${normalizeDate(input.startDate)}
        AND date <= ${normalizeDate(input.endDate)}
    ),
    partitions AS (
      SELECT
        scope,
        status,
        partition_date::date AS partition_date,
        updated_at,
        last_error
      FROM google_ads_sync_partitions
      WHERE business_id = ${input.businessId}
        AND (${providerAccountId}::text IS NULL OR provider_account_id = ${providerAccountId})
        AND scope IN ('campaign_daily', 'search_term_daily', 'product_daily')
        AND partition_date >= ${normalizeDate(input.startDate)}
        AND partition_date <= ${normalizeDate(input.endDate)}
    )
    SELECT
      advisor_surfaces.scope,
      COUNT(partitions.*)::int AS total_partitions,
      COUNT(partitions.*) FILTER (WHERE partitions.status = 'queued')::int AS queued_partitions,
      COUNT(partitions.*) FILTER (WHERE partitions.status = 'leased')::int AS leased_partitions,
      COUNT(partitions.*) FILTER (WHERE partitions.status = 'running')::int AS running_partitions,
      COUNT(partitions.*) FILTER (WHERE partitions.status = 'succeeded')::int AS succeeded_partitions,
      COUNT(partitions.*) FILTER (WHERE partitions.status = 'failed')::int AS failed_partitions,
      COUNT(partitions.*) FILTER (WHERE partitions.status = 'dead_letter')::int AS dead_letter_partitions,
      COUNT(partitions.*) FILTER (WHERE partitions.status = 'cancelled')::int AS cancelled_partitions,
      COUNT(partitions.*) FILTER (
        WHERE partitions.status = 'succeeded'
          AND NOT EXISTS (
            SELECT 1
            FROM coverage_dates
            WHERE coverage_dates.scope = partitions.scope
              AND coverage_dates.date = partitions.partition_date
          )
      )::int AS succeeded_empty_partitions,
      MAX(partitions.updated_at)::text AS latest_updated_at,
      (ARRAY_AGG(partitions.last_error ORDER BY partitions.updated_at DESC)
        FILTER (WHERE partitions.last_error IS NOT NULL))[1] AS latest_error
    FROM advisor_surfaces
    LEFT JOIN partitions ON partitions.scope = advisor_surfaces.scope
    GROUP BY advisor_surfaces.scope
    ORDER BY advisor_surfaces.scope
  `) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    surface: String(row.scope) as GoogleAdsWarehouseScope,
    totalPartitions: toNumber(row.total_partitions),
    queuedPartitions: toNumber(row.queued_partitions),
    leasedPartitions: toNumber(row.leased_partitions),
    runningPartitions: toNumber(row.running_partitions),
    succeededPartitions: toNumber(row.succeeded_partitions),
    failedPartitions: toNumber(row.failed_partitions),
    deadLetterPartitions: toNumber(row.dead_letter_partitions),
    cancelledPartitions: toNumber(row.cancelled_partitions),
    succeededEmptyPartitions: toNumber(row.succeeded_empty_partitions),
    latestUpdatedAt: normalizeTimestamp(row.latest_updated_at),
    latestError: row.latest_error ? String(row.latest_error) : null,
  }));
}

export async function getGoogleAdsPartitionHealth(input: {
  businessId: string;
  providerAccountId?: string | null;
  scope?: GoogleAdsWarehouseScope | null;
  lane?: GoogleAdsSyncLane | null;
}) {
  await assertGoogleAdsRequestReadTablesReady(
    ["google_ads_sync_partitions"],
    "google_ads_partition_health",
  );
  const sql = getDb();
  const rows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued') AS queue_depth,
      COUNT(*) FILTER (WHERE status IN ('leased', 'running')) AS leased_partitions,
      COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_partitions,
      MIN(partition_date) FILTER (WHERE status = 'queued') AS oldest_queued_partition,
      MAX(updated_at) FILTER (WHERE status IN ('queued', 'leased', 'running', 'dead_letter')) AS latest_activity_at
    FROM google_ads_sync_partitions
    WHERE business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      AND (${input.scope ?? null}::text IS NULL OR scope = ${input.scope ?? null})
      AND (${input.lane ?? null}::text IS NULL OR lane = ${input.lane ?? null})
  `) as Array<Record<string, unknown>>;
  const row = rows[0] ?? {};
  return {
    queueDepth: toNumber(row.queue_depth),
    leasedPartitions: toNumber(row.leased_partitions),
    deadLetterPartitions: toNumber(row.dead_letter_partitions),
    oldestQueuedPartition: row.oldest_queued_partition
      ? normalizeDate(row.oldest_queued_partition)
      : null,
    latestActivityAt: normalizeTimestamp(row.latest_activity_at),
  };
}

export async function getGoogleAdsCheckpointHealth(input: {
  businessId: string;
  providerAccountId?: string | null;
}) {
  await assertGoogleAdsRequestReadTablesReady(
    ["google_ads_sync_partitions", "google_ads_sync_checkpoints"],
    "google_ads_checkpoint_health",
  );
  const sql = getDb();
  const rows = (await sql`
    WITH active_partitions AS (
      SELECT id
      FROM google_ads_sync_partitions
      WHERE business_id = ${input.businessId}
        AND status IN ('queued', 'leased', 'running', 'dead_letter')
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
    ),
    latest_checkpoint AS (
      SELECT DISTINCT ON (checkpoint.partition_id)
        checkpoint.partition_id,
        checkpoint.checkpoint_scope,
        checkpoint.is_paginated,
        checkpoint.phase,
        checkpoint.status,
        checkpoint.page_index,
        COALESCE(checkpoint.progress_heartbeat_at, checkpoint.updated_at) AS progress_updated_at,
        checkpoint.poisoned_at,
        checkpoint.poison_reason,
        checkpoint.updated_at
      FROM google_ads_sync_checkpoints checkpoint
      JOIN active_partitions partition ON partition.id = checkpoint.partition_id
      ORDER BY checkpoint.partition_id, checkpoint.updated_at DESC
    )
    SELECT
      checkpoint_scope,
      is_paginated,
      phase,
      status,
      page_index,
      progress_updated_at,
      poisoned_at,
      poison_reason,
      COUNT(*) FILTER (WHERE status = 'failed') OVER ()::int AS checkpoint_failures
    FROM latest_checkpoint
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) {
    return {
      latestCheckpointScope: null,
      latestCheckpointPhase: null,
      latestCheckpointStatus: null,
      latestCheckpointUpdatedAt: null,
      checkpointLagMinutes: null,
      lastSuccessfulPageIndex: null,
      resumeCapable: false,
      checkpointFailures: 0,
    };
  }
  const updatedAt = normalizeTimestamp(row.progress_updated_at);
  return {
    latestCheckpointScope: row.checkpoint_scope
      ? String(row.checkpoint_scope)
      : null,
    latestCheckpointPhase: row.phase ? String(row.phase) : null,
    latestCheckpointStatus: row.status ? String(row.status) : null,
    latestCheckpointUpdatedAt: updatedAt,
    checkpointLagMinutes: computeCheckpointLagMinutes(updatedAt),
    lastSuccessfulPageIndex: toNumber(row.page_index),
    resumeCapable:
      !row.poisoned_at &&
      row.status != null &&
      ["pending", "running", "failed"].includes(String(row.status)),
    checkpointFailures: toNumber(row.checkpoint_failures),
  };
}

export type GoogleAdsRecoveryOutcome =
  | "replayed"
  | "quarantine_released"
  | "manual_replay_queued"
  | "skipped_active_lease"
  | "no_matching_partitions";

export interface GoogleAdsRecoveryActionResult {
  outcome: GoogleAdsRecoveryOutcome;
  partitions: Array<{
    id: string;
    lane: string;
    scope: string;
    partitionDate: string;
  }>;
  matchedCount: number;
  changedCount: number;
  skippedActiveLeaseCount: number;
  replayableMatchedCount?: number;
  terminalActionRequiredCount?: number;
  unknownMatchedCount?: number;
  actionRequiredPartitions?: Array<{
    id: string;
    scope: string;
    source: string | null;
    partitionDate: string;
    lastError: string | null;
    errorClass: string | null;
    reasonCode: string;
  }>;
}

type GoogleAdsDeadLetterCandidateRow = {
  id: string;
  lane: string;
  scope: string;
  source: string | null;
  partition_date: string | Date;
  last_error: string | null;
  error_class: string | null;
  error_message: string | null;
};

type GoogleAdsDeadLetterHealthRow = GoogleAdsDeadLetterCandidateRow & {
  is_historical_quarantined: boolean | null;
};

export interface GoogleAdsTerminalActionRequiredQuarantineResult {
  candidateCount: number;
  terminalMatchedCount: number;
  changedCount: number;
  partitions: Array<{
    id: string;
    lane: string;
    scope: string;
    source: string | null;
    partitionDate: string;
    reasonCode: string;
  }>;
}

const GOOGLE_ADS_CORE_RELEASE_SCOPES = new Set<GoogleAdsWarehouseScope>([
  "account_daily",
  "campaign_daily",
]);
const GOOGLE_ADS_ACTION_REQUIRED_SCOPE_RETRY_COOLDOWN_HOURS = 6;

function isGoogleAdsCoreReleaseScope(scope: unknown) {
  return GOOGLE_ADS_CORE_RELEASE_SCOPES.has(
    String(scope ?? "") as GoogleAdsWarehouseScope,
  );
}

function sortedGoogleAdsScopes(scopes: Iterable<unknown>) {
  return Array.from(
    new Set(
      Array.from(scopes)
        .map((scope) => String(scope ?? "").trim())
        .filter(Boolean),
    ),
  ).sort() as GoogleAdsWarehouseScope[];
}

function classifyGoogleAdsDeadLetterCandidate(
  row: Pick<
    GoogleAdsDeadLetterCandidateRow,
    "last_error" | "error_class" | "error_message"
  >,
) {
  return classifyGoogleAdsSyncFailure({
    errorClass: row.error_class,
    message: row.last_error ?? row.error_message ?? null,
  });
}

export async function hasRecentGoogleAdsTerminalActionRequiredDeadLetter(input: {
  businessId: string;
  providerAccountId: string;
  scope: GoogleAdsWarehouseScope;
  cooldownHours?: number;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    SELECT
      partition.last_error,
      latest_run.error_class,
      latest_run.error_message
    FROM google_ads_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT run.error_class, run.error_message
      FROM google_ads_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.updated_at DESC
      LIMIT 1
    ) latest_run ON true
    WHERE partition.business_id = ${input.businessId}
      AND partition.provider_account_id = ${input.providerAccountId}
      AND partition.scope = ${input.scope}
      AND partition.status = 'dead_letter'
      AND partition.updated_at >= now() - (${input.cooldownHours ?? GOOGLE_ADS_ACTION_REQUIRED_SCOPE_RETRY_COOLDOWN_HOURS} || ' hours')::interval
    ORDER BY partition.updated_at DESC
    LIMIT 20
  `) as GoogleAdsDeadLetterCandidateRow[];

  return rows.some(
    (row) =>
      classifyGoogleAdsDeadLetterCandidate(row).recoveryKind ===
      "terminal_action_required",
  );
}

const GOOGLE_ADS_ACCOUNT_ACTION_REQUIRED_COOLDOWN_HOURS = 24;
const GOOGLE_ADS_ACCOUNT_ACTION_REQUIRED_TRIP_THRESHOLD = 2;

// Account-wide (cross-scope) variant of the action-required check. Trips once an
// account has accumulated several terminal (auth/permission/account) dead-letter
// partitions, so the enqueue path can stop creating fresh work for an account
// whose credentials are broken (e.g. repeated 403 PERMISSION_DENIED) instead of
// burning the daily request budget and starving healthy businesses.
export async function hasRecentGoogleAdsTerminalActionRequiredDeadLetterForAccount(input: {
  businessId: string;
  providerAccountId: string;
  cooldownHours?: number;
  threshold?: number;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    SELECT
      partition.last_error,
      latest_run.error_class,
      latest_run.error_message
    FROM google_ads_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT run.error_class, run.error_message
      FROM google_ads_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.updated_at DESC
      LIMIT 1
    ) latest_run ON true
    WHERE partition.business_id = ${input.businessId}
      AND partition.provider_account_id = ${input.providerAccountId}
      AND partition.status = 'dead_letter'
      AND partition.updated_at >= now() - (${input.cooldownHours ?? GOOGLE_ADS_ACCOUNT_ACTION_REQUIRED_COOLDOWN_HOURS} || ' hours')::interval
    ORDER BY partition.updated_at DESC
    LIMIT 50
  `) as GoogleAdsDeadLetterCandidateRow[];

  const terminalCount = rows.filter(
    (row) =>
      classifyGoogleAdsDeadLetterCandidate(row).recoveryKind ===
      "terminal_action_required",
  ).length;

  return (
    terminalCount >=
    (input.threshold ?? GOOGLE_ADS_ACCOUNT_ACTION_REQUIRED_TRIP_THRESHOLD)
  );
}

export async function quarantineGoogleAdsTerminalActionRequiredPartitions(input: {
  businessId: string;
  scope?: GoogleAdsWarehouseScope | null;
  limit?: number;
}): Promise<GoogleAdsTerminalActionRequiredQuarantineResult> {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const candidateRows = (await sql`
    SELECT
      partition.id,
      partition.lane,
      partition.scope,
      partition.source,
      partition.partition_date,
      partition.last_error,
      latest_run.error_class,
      latest_run.error_message
    FROM google_ads_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT run.error_class, run.error_message
      FROM google_ads_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.updated_at DESC
      LIMIT 1
    ) latest_run ON true
    WHERE partition.business_id = ${input.businessId}
      AND partition.status IN ('queued', 'failed')
      AND COALESCE(partition.lease_expires_at, now() - interval '1 second') <= now()
      AND (${input.scope ?? null}::text IS NULL OR partition.scope = ${input.scope ?? null})
      AND (
        COALESCE(latest_run.error_class, '') IN (
          'account_action_required',
          'auth_action_required',
          'permission_action_required',
          'provider_action_required',
          'scope_action_required'
        )
        OR concat_ws(
          ' ',
          partition.last_error,
          latest_run.error_message,
          latest_run.error_class
        ) ILIKE ANY (ARRAY[
          '%google_ads_scope_action_required%',
          '%invalid_grant%',
          '%token has been expired or revoked%',
          '%refresh token%',
          '%login required%',
          '%reauth%',
          '%UNAUTHENTICATED%',
          '%AUTHENTICATION_ERROR%',
          '%PERMISSION_DENIED%',
          '%permission denied%',
          '%does not have permission%',
          '%provider_request_failed:permission%',
          '%permission:status_403%',
          '%customer_not_enabled%',
          '%customer not enabled%',
          '%customer not found%',
          '%account suspended%',
          '%account cancelled%',
          '%account canceled%'
        ])
      )
    ORDER BY partition.updated_at ASC
    LIMIT ${Math.max(1, Math.min(input.limit ?? 500, 1000))}
  `) as GoogleAdsDeadLetterCandidateRow[];
  const classifiedRows = candidateRows.map((row) => ({
    row,
    classification: classifyGoogleAdsDeadLetterCandidate(row),
  }));
  const terminalRows = classifiedRows.filter(
    ({ classification }) =>
      classification.recoveryKind === "terminal_action_required",
  );
  const terminalIds = terminalRows.map(({ row }) => row.id);
  const terminalMessages = terminalRows.map(({ row, classification }) =>
    row.last_error ??
    row.error_message ??
    classification.reasonCode ??
    "Google Ads account, OAuth, or customer-access action required.",
  );
  const terminalClasses = terminalRows.map(
    ({ classification }) => classification.errorClass,
  );
  const updatedRows =
    terminalIds.length > 0
      ? ((await sql`
        WITH terminal(id, error_message, error_class) AS (
          SELECT * FROM unnest(
            ${terminalIds}::uuid[],
            ${terminalMessages}::text[],
            ${terminalClasses}::text[]
          )
        )
        UPDATE google_ads_sync_partitions partition
        SET
          status = 'dead_letter',
          lease_owner = NULL,
          lease_expires_at = NULL,
          next_retry_at = NULL,
          last_error = COALESCE(
            NULLIF(terminal.error_message, ''),
            NULLIF(partition.last_error, ''),
            'Google Ads account, OAuth, or customer-access action required.'
          ),
          finished_at = COALESCE(partition.finished_at, now()),
          updated_at = now()
        FROM terminal
        WHERE partition.id = terminal.id
          AND partition.business_id = ${input.businessId}
          AND partition.status IN ('queued', 'failed')
          AND COALESCE(partition.lease_expires_at, now() - interval '1 second') <= now()
        RETURNING
          partition.id,
          partition.lane,
          partition.scope,
          partition.source,
          partition.partition_date,
          terminal.error_class
      `) as Array<Record<string, unknown>>)
      : [];
  return {
    candidateCount: candidateRows.length,
    terminalMatchedCount: terminalRows.length,
    changedCount: updatedRows.length,
    partitions: updatedRows.map((row) => ({
      id: String(row.id),
      lane: String(row.lane),
      scope: String(row.scope),
      source: row.source == null ? null : String(row.source),
      partitionDate: normalizeDate(row.partition_date),
      reasonCode: classifyGoogleAdsSyncFailure({
        errorClass: row.error_class == null ? null : String(row.error_class),
      }).reasonCode,
    })),
  };
}

/**
 * Cancel queued work for a scope this account has provably never been able to read.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-05, one connected Google Ads account (TheSwaf) held four scopes —
 * ad_daily, audience_daily, device_daily, keyword_daily — with 793 partitions
 * each and ZERO successes, ever. They had returned PERMISSION_DENIED in May,
 * and the scheduler went on manufacturing more: 40 new partitions in June, 31
 * in July, 5 in August. ~2,700 partitions that can never complete, growing
 * monotonically, keeping the queue permanently "unhealthy" and burying the one
 * fact an operator needed: this account cannot read those four surfaces.
 *
 * The scheduler has no notion of a scope being unavailable for an account, so
 * nothing ever stopped. This gives it one, derived from evidence rather than
 * configuration.
 *
 * WHY ALL FOUR CONDITIONS
 *
 * "Never succeeded" alone would cut off a freshly connected account before its
 * first run, so it is never sufficient on its own:
 *
 *   1. zero successful partitions EVER for this business+account+scope;
 *   2. at least one dead letter on that scope carrying a terminal access
 *      failure — the account's own refusal, not our inference;
 *   3. the scope has been scheduled for at least `minimumAgeDays`, so a new or
 *      still-warming account is never affected;
 *   4. there is queued work to cancel.
 *
 * Cancelled, never deleted: the rows keep their history and carry the reason,
 * so the decision is auditable and reversible. And it is self-correcting — the
 * moment one partition for that scope succeeds, condition 1 fails and this
 * stops touching it, so restored access needs no intervention here.
 */
export async function cancelGoogleAdsUnreadableScopeBacklog(input: {
  businessId: string;
  minimumAgeDays?: number;
  limit?: number;
}): Promise<{
  scopes: Array<{ providerAccountId: string; scope: string; cancelled: number }>;
  cancelledTotal: number;
}> {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const minimumAgeDays = Math.max(7, input.minimumAgeDays ?? 30);
  const limit = Math.max(1, Math.min(input.limit ?? 2000, 5000));
  const rows = (await sql`
    WITH unreadable AS (
      SELECT
        partition.provider_account_id,
        partition.scope
      FROM google_ads_sync_partitions partition
      WHERE partition.business_id = ${input.businessId}
      GROUP BY partition.provider_account_id, partition.scope
      HAVING
        -- (1) never once succeeded
        count(*) FILTER (WHERE partition.status = 'succeeded') = 0
        -- (3) and has been scheduled long enough that a warming account is safe
        AND min(partition.created_at) <= now() - (${minimumAgeDays} || ' days')::interval
        -- (4) and there is something to cancel
        AND count(*) FILTER (WHERE partition.status = 'queued') > 0
        -- (2) and the account itself refused this surface terminally
        AND count(*) FILTER (
          WHERE partition.status = 'dead_letter'
            AND partition.last_error ILIKE ANY (ARRAY[
              '%PERMISSION_DENIED%',
              '%permission denied%',
              '%does not have permission%',
              '%provider_request_failed:permission%',
              '%permission:status_403%',
              '%google_ads_scope_action_required%'
            ])
        ) > 0
    ),
    doomed AS (
      SELECT partition.id, partition.provider_account_id, partition.scope
      FROM google_ads_sync_partitions partition
      JOIN unreadable
        ON unreadable.provider_account_id = partition.provider_account_id
       AND unreadable.scope = partition.scope
      WHERE partition.business_id = ${input.businessId}
        AND partition.status = 'queued'
      ORDER BY partition.partition_date ASC
      LIMIT ${limit}
    )
    UPDATE google_ads_sync_partitions partition
    SET
      status = 'cancelled',
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = NULL,
      last_error = concat(
        'google_ads_scope_unreadable: this Google Ads account has never returned data for ',
        doomed.scope,
        ' and refused it with a terminal access error. Queued work was cancelled; grant access to this surface to resume it.'
      ),
      finished_at = COALESCE(partition.finished_at, now()),
      updated_at = now()
    FROM doomed
    WHERE partition.id = doomed.id
    RETURNING partition.provider_account_id, partition.scope
  `) as Array<{ provider_account_id: string; scope: string }>;

  const tally = new Map<string, { providerAccountId: string; scope: string; cancelled: number }>();
  for (const row of rows) {
    const key = `${row.provider_account_id}::${row.scope}`;
    const entry = tally.get(key) ?? {
      providerAccountId: String(row.provider_account_id),
      scope: String(row.scope),
      cancelled: 0,
    };
    entry.cancelled += 1;
    tally.set(key, entry);
  }
  return {
    scopes: Array.from(tally.values()).sort((a, b) => b.cancelled - a.cancelled),
    cancelledTotal: rows.length,
  };
}

export async function requeueGoogleAdsRetryableFailedPartitions(input: {
  businessId: string;
  limit?: number;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const candidateRows = (await sql`
    SELECT
      partition.id,
      partition.lane,
      partition.scope,
      partition.source,
      partition.partition_date,
      partition.last_error,
      latest_run.error_class,
      latest_run.error_message
    FROM google_ads_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT run.error_class, run.error_message
      FROM google_ads_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.updated_at DESC
      LIMIT 1
    ) latest_run ON true
    WHERE partition.business_id = ${input.businessId}
      AND partition.status = 'failed'
      AND COALESCE(partition.next_retry_at, now()) <= now()
      AND COALESCE(partition.lease_expires_at, now() - interval '1 second') <= now()
    ORDER BY
      CASE partition.source
        WHEN 'selected_range' THEN 800
        WHEN 'finalize_day' THEN 725
        WHEN 'today' THEN 650
        WHEN 'recent' THEN 600
        WHEN 'recent_recovery' THEN 550
        WHEN 'core_success' THEN 500
        WHEN 'core_historical_recovery' THEN 225
        WHEN 'historical_recovery' THEN 200
        WHEN 'historical' THEN 150
        ELSE 100
      END DESC,
      partition.partition_date DESC,
      partition.updated_at ASC
    LIMIT ${Math.max(1, Math.min(input.limit ?? 500, 1000))}
  `) as GoogleAdsDeadLetterCandidateRow[];
  const retryableIds = candidateRows
    .filter(
      (row) =>
        classifyGoogleAdsDeadLetterCandidate(row).recoveryKind ===
        "replayable_transient",
    )
    .map((row) => row.id);
  const rows =
    retryableIds.length > 0
      ? ((await sql`
        UPDATE google_ads_sync_partitions partition
        SET
          status = 'queued',
          lease_owner = NULL,
          lease_expires_at = NULL,
          next_retry_at = now(),
          updated_at = now()
        WHERE partition.id = ANY(${retryableIds}::uuid[])
          AND partition.business_id = ${input.businessId}
          AND partition.status = 'failed'
          AND COALESCE(partition.lease_expires_at, now() - interval '1 second') <= now()
        RETURNING partition.id
      `) as Array<{ id: string }>)
      : [];
  return rows.map((row) => row.id);
}

function normalizeGoogleAdsRecoveryKinds(
  kinds: GoogleAdsDeadLetterRecoveryKind[] | null | undefined,
) {
  return kinds && kinds.length > 0
    ? new Set<GoogleAdsDeadLetterRecoveryKind>(kinds)
    : new Set<GoogleAdsDeadLetterRecoveryKind>(["replayable_transient"]);
}

export async function replayGoogleAdsDeadLetterPartitions(input: {
  businessId: string;
  scope?: GoogleAdsWarehouseScope | null;
  startDate?: string | null;
  endDate?: string | null;
  recoveryKinds?: GoogleAdsDeadLetterRecoveryKind[] | null;
}): Promise<GoogleAdsRecoveryActionResult> {
  // Same contract as the Meta replay: moving a dead letter back to queued is a
  // new-work transition, so it needs the lane, fresh capacity, and current
  // selection. Without them a revoked account's dead letters could be revived.
  assertSyncLaneEnabled("google_sync");
  await assertSyncGrowthBoundary("google_dead_letter_replay", { fresh: true });
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const matchedRows = (await sql`
    SELECT
      partition.id,
      partition.lane,
      partition.scope,
      partition.source,
      partition.partition_date,
      partition.last_error,
      latest_run.error_class,
      latest_run.error_message
    FROM google_ads_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT run.error_class, run.error_message
      FROM google_ads_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.updated_at DESC
      LIMIT 1
    ) latest_run ON true
    WHERE partition.business_id = ${input.businessId}
      AND partition.status = 'dead_letter'
      AND EXISTS (
        SELECT 1 FROM business_provider_accounts binding
        WHERE binding.business_id = partition.business_id
          AND binding.provider = 'google'
          AND binding.provider_account_id = partition.provider_account_id
          AND binding.is_selected
      )
      AND (${input.scope ?? null}::text IS NULL OR partition.scope = ${input.scope ?? null})
      AND (${input.startDate ?? null}::date IS NULL OR partition.partition_date >= ${input.startDate ?? null}::date)
      AND (${input.endDate ?? null}::date IS NULL OR partition.partition_date <= ${input.endDate ?? null}::date)
  `) as GoogleAdsDeadLetterCandidateRow[];
  const allowedKinds = normalizeGoogleAdsRecoveryKinds(input.recoveryKinds);
  const classifiedRows = matchedRows.map((row) => ({
    row,
    classification: classifyGoogleAdsDeadLetterCandidate(row),
  }));
  const eligibleRows = classifiedRows
    .filter(({ classification }) => allowedKinds.has(classification.recoveryKind))
    .map(({ row }) => row);
  const eligibleIds = eligibleRows.map((row) => row.id);
  const skippedActiveLeaseRows = eligibleIds.length > 0
    ? ((await sql`
    SELECT id
    FROM google_ads_sync_partitions
    WHERE id = ANY(${eligibleIds}::uuid[])
      AND business_id = ${input.businessId}
      AND status = 'dead_letter'
      AND COALESCE(lease_expires_at, now() - interval '1 second') > now()
  `) as Array<{ id: string }>)
    : [];
  const rows = eligibleIds.length > 0
    ? ((await sql`
    UPDATE google_ads_sync_partitions
    SET
      status = 'queued',
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = NULL,
      last_error = NULL,
      updated_at = now()
    WHERE id = ANY(${eligibleIds}::uuid[])
      AND business_id = ${input.businessId}
      AND status = 'dead_letter'
      AND COALESCE(lease_expires_at, now() - interval '1 second') <= now()
      -- Selection is re-checked BY THE UPDATE, not before it.
      --
      -- The candidate SELECT and this UPDATE were separate statements, so a
      -- revocation landing between them requeued work for an account the user
      -- had just deselected — the SELECT saw it selected, the UPDATE never
      -- looked again. Making the predicate part of the write closes the window
      -- entirely: a deselected partition simply does not match.
      AND EXISTS (
        SELECT 1 FROM business_provider_accounts binding
        WHERE binding.business_id = google_ads_sync_partitions.business_id
          AND binding.provider = 'google'
          AND binding.provider_account_id = google_ads_sync_partitions.provider_account_id
          AND binding.is_selected
      )
    RETURNING id, lane, scope, partition_date
  `) as Array<Record<string, unknown>>)
    : [];
  const partitions = rows.map((row) => ({
    id: String(row.id),
    lane: String(row.lane),
    scope: String(row.scope),
    partitionDate: normalizeDate(row.partition_date),
  }));
  if (skippedActiveLeaseRows.length > 0) {
    await recordSyncReclaimEvents({
      providerScope: "google_ads",
      businessId: input.businessId,
      partitionIds: skippedActiveLeaseRows.map((row) => row.id),
      eventType: "skipped_active_lease",
      detail: "Replay skipped because the partition still has an active lease.",
    }).catch(() => null);
  }
  return {
    outcome:
      partitions.length > 0
        ? "replayed"
        : skippedActiveLeaseRows.length > 0
          ? "skipped_active_lease"
          : "no_matching_partitions",
    partitions,
    matchedCount: matchedRows.length,
    changedCount: partitions.length,
    skippedActiveLeaseCount: skippedActiveLeaseRows.length,
    replayableMatchedCount: classifiedRows.filter(
      ({ classification }) =>
        classification.recoveryKind === "replayable_transient",
    ).length,
    terminalActionRequiredCount: classifiedRows.filter(
      ({ classification }) =>
        classification.recoveryKind === "terminal_action_required",
    ).length,
    unknownMatchedCount: classifiedRows.filter(
      ({ classification }) => classification.recoveryKind === "unknown",
    ).length,
    actionRequiredPartitions: classifiedRows
      .filter(
        ({ classification }) =>
          classification.recoveryKind === "terminal_action_required",
      )
      .map(({ row, classification }) => ({
        id: row.id,
        scope: row.scope,
        source: row.source,
        partitionDate: normalizeDate(row.partition_date),
        lastError: row.last_error,
        errorClass: row.error_class,
        reasonCode: classification.reasonCode,
      })),
  };
}

export async function releaseGoogleAdsPoisonedPartitions(input: {
  businessId: string;
  scope?: GoogleAdsWarehouseScope | null;
}): Promise<GoogleAdsRecoveryActionResult> {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const matchedRows = (await sql`
    SELECT partition.id
    FROM google_ads_sync_partitions partition
    JOIN google_ads_sync_checkpoints checkpoint ON checkpoint.partition_id = partition.id
    WHERE partition.business_id = ${input.businessId}
      AND partition.status = 'dead_letter'
      AND checkpoint.poisoned_at IS NOT NULL
      AND (${input.scope ?? null}::text IS NULL OR partition.scope = ${input.scope ?? null})
  `) as Array<{ id: string }>;
  const skippedActiveLeaseRows = (await sql`
    SELECT partition.id
    FROM google_ads_sync_partitions partition
    JOIN google_ads_sync_checkpoints checkpoint ON checkpoint.partition_id = partition.id
    WHERE partition.business_id = ${input.businessId}
      AND partition.status = 'dead_letter'
      AND checkpoint.poisoned_at IS NOT NULL
      AND COALESCE(partition.lease_expires_at, now() - interval '1 second') > now()
      AND (${input.scope ?? null}::text IS NULL OR partition.scope = ${input.scope ?? null})
  `) as Array<{ id: string }>;
  const partitions = (await sql`
    WITH released_checkpoints AS (
      UPDATE google_ads_sync_checkpoints checkpoint
      SET
        poisoned_at = NULL,
        poison_reason = NULL,
        replay_reason_code = 'quarantine_release',
        replay_detail = 'Quarantine released by admin action.',
        updated_at = now()
      FROM google_ads_sync_partitions partition
      WHERE checkpoint.partition_id = partition.id
        AND partition.business_id = ${input.businessId}
        AND partition.status = 'dead_letter'
        AND COALESCE(partition.lease_expires_at, now() - interval '1 second') <= now()
        AND checkpoint.poisoned_at IS NOT NULL
        AND (${input.scope ?? null}::text IS NULL OR partition.scope = ${input.scope ?? null})
      RETURNING checkpoint.partition_id
    )
    UPDATE google_ads_sync_partitions partition
    SET
      status = 'failed',
      source = CASE
        WHEN partition.lane = 'extended' THEN 'historical_recovery'
        ELSE partition.source
      END,
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = NULL,
      last_error = COALESCE(partition.last_error, 'poison quarantine released; awaiting replay'),
      updated_at = now()
    WHERE partition.id IN (SELECT partition_id FROM released_checkpoints)
    RETURNING partition.id, partition.lane, partition.scope, partition.partition_date
  `) as Array<Record<string, unknown>>;

  const changedPartitions = partitions.map((row) => ({
    id: String(row.id),
    lane: String(row.lane),
    scope: String(row.scope),
    partitionDate: normalizeDate(row.partition_date),
  }));
  if (skippedActiveLeaseRows.length > 0) {
    await recordSyncReclaimEvents({
      providerScope: "google_ads",
      businessId: input.businessId,
      partitionIds: skippedActiveLeaseRows.map((row) => row.id),
      eventType: "skipped_active_lease",
      detail:
        "Quarantine release skipped because the partition still has an active lease.",
    }).catch(() => null);
  }
  return {
    outcome:
      changedPartitions.length > 0
        ? "quarantine_released"
        : matchedRows.length > 0
          ? "skipped_active_lease"
          : "no_matching_partitions",
    partitions: changedPartitions,
    matchedCount: matchedRows.length,
    changedCount: changedPartitions.length,
    skippedActiveLeaseCount: skippedActiveLeaseRows.length,
  };
}

export async function forceReplayGoogleAdsPoisonedPartitions(input: {
  businessId: string;
  scope?: GoogleAdsWarehouseScope | null;
  startDate?: string | null;
  endDate?: string | null;
  recoveryKinds?: GoogleAdsDeadLetterRecoveryKind[] | null;
}): Promise<GoogleAdsRecoveryActionResult> {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const matchedRows = (await sql`
    SELECT
      partition.id,
      partition.lane,
      partition.scope,
      partition.source,
      partition.partition_date,
      partition.last_error,
      latest_run.error_class,
      COALESCE(latest_run.error_message, checkpoint.poison_reason) AS error_message
    FROM google_ads_sync_partitions partition
    JOIN google_ads_sync_checkpoints checkpoint ON checkpoint.partition_id = partition.id
    LEFT JOIN LATERAL (
      SELECT run.error_class, run.error_message
      FROM google_ads_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.updated_at DESC
      LIMIT 1
    ) latest_run ON true
    WHERE partition.business_id = ${input.businessId}
      AND partition.status = 'dead_letter'
      AND checkpoint.poisoned_at IS NOT NULL
      AND (${input.scope ?? null}::text IS NULL OR partition.scope = ${input.scope ?? null})
      AND (${input.startDate ?? null}::date IS NULL OR partition.partition_date >= ${input.startDate ?? null}::date)
      AND (${input.endDate ?? null}::date IS NULL OR partition.partition_date <= ${input.endDate ?? null}::date)
  `) as GoogleAdsDeadLetterCandidateRow[];
  const allowedKinds = normalizeGoogleAdsRecoveryKinds(
    input.recoveryKinds ?? ["replayable_transient", "unknown"],
  );
  const classifiedRows = matchedRows.map((row) => ({
    row,
    classification: classifyGoogleAdsDeadLetterCandidate(row),
  }));
  const eligibleRows = classifiedRows
    .filter(({ classification }) => allowedKinds.has(classification.recoveryKind))
    .map(({ row }) => row);
  const eligibleIds = eligibleRows.map((row) => row.id);
  const skippedActiveLeaseRows = eligibleIds.length > 0
    ? ((await sql`
    SELECT partition.id
    FROM google_ads_sync_partitions partition
    JOIN google_ads_sync_checkpoints checkpoint ON checkpoint.partition_id = partition.id
    WHERE partition.id = ANY(${eligibleIds}::uuid[])
      AND partition.business_id = ${input.businessId}
      AND partition.status = 'dead_letter'
      AND checkpoint.poisoned_at IS NOT NULL
      AND COALESCE(partition.lease_expires_at, now() - interval '1 second') > now()
  `) as Array<{ id: string }>)
    : [];
  const partitions = eligibleIds.length > 0
    ? ((await sql`
    WITH released_checkpoints AS (
      UPDATE google_ads_sync_checkpoints checkpoint
      SET
        poisoned_at = NULL,
        poison_reason = NULL,
        replay_reason_code = 'manual_replay',
        replay_detail = 'Manual replay requested from admin sync health.',
        updated_at = now()
      FROM google_ads_sync_partitions partition
      WHERE checkpoint.partition_id = partition.id
        AND partition.id = ANY(${eligibleIds}::uuid[])
        AND partition.business_id = ${input.businessId}
        AND partition.status = 'dead_letter'
        AND COALESCE(partition.lease_expires_at, now() - interval '1 second') <= now()
        AND checkpoint.poisoned_at IS NOT NULL
      RETURNING checkpoint.partition_id
    )
    UPDATE google_ads_sync_partitions partition
    SET
      status = 'queued',
      source = CASE
        WHEN partition.lane = 'extended' THEN 'historical_recovery'
        ELSE partition.source
      END,
      lease_owner = NULL,
      lease_expires_at = NULL,
      next_retry_at = NULL,
      last_error = NULL,
      updated_at = now()
    WHERE partition.id IN (SELECT partition_id FROM released_checkpoints)
    RETURNING partition.id, partition.lane, partition.scope, partition.partition_date
  `) as Array<Record<string, unknown>>)
    : [];

  const changedPartitions = partitions.map((row) => ({
    id: String(row.id),
    lane: String(row.lane),
    scope: String(row.scope),
    partitionDate: normalizeDate(row.partition_date),
  }));
  if (skippedActiveLeaseRows.length > 0) {
    await recordSyncReclaimEvents({
      providerScope: "google_ads",
      businessId: input.businessId,
      partitionIds: skippedActiveLeaseRows.map((row) => row.id),
      eventType: "skipped_active_lease",
      detail:
        "Manual replay skipped because the partition still has an active lease.",
    }).catch(() => null);
  }
  return {
    outcome:
      changedPartitions.length > 0
        ? "manual_replay_queued"
        : skippedActiveLeaseRows.length > 0
          ? "skipped_active_lease"
          : "no_matching_partitions",
    partitions: changedPartitions,
    matchedCount: matchedRows.length,
    changedCount: changedPartitions.length,
    skippedActiveLeaseCount: skippedActiveLeaseRows.length,
    replayableMatchedCount: classifiedRows.filter(
      ({ classification }) =>
        classification.recoveryKind === "replayable_transient",
    ).length,
    terminalActionRequiredCount: classifiedRows.filter(
      ({ classification }) =>
        classification.recoveryKind === "terminal_action_required",
    ).length,
    unknownMatchedCount: classifiedRows.filter(
      ({ classification }) => classification.recoveryKind === "unknown",
    ).length,
    actionRequiredPartitions: classifiedRows
      .filter(
        ({ classification }) =>
          classification.recoveryKind === "terminal_action_required",
      )
      .map(({ row, classification }) => ({
        id: row.id,
        scope: row.scope,
        source: row.source,
        partitionDate: normalizeDate(row.partition_date),
        lastError: row.last_error,
        errorClass: row.error_class,
        reasonCode: classification.reasonCode,
      })),
  };
}

export async function getGoogleAdsSyncState(input: {
  businessId: string;
  providerAccountId?: string | null;
  scope: GoogleAdsWarehouseScope;
}) {
  await assertGoogleAdsRequestReadTablesReady(
    ["google_ads_sync_state"],
    "google_ads_sync_state",
  );
  const sql = getDb();
  const rows = (await sql`
    SELECT
      business_id,
      provider_account_id,
      scope,
      historical_target_start,
      historical_target_end,
      effective_target_start,
      effective_target_end,
      ready_through_date,
      last_successful_partition_date,
      latest_background_activity_at,
      latest_successful_sync_at,
      completed_days,
      dead_letter_count,
      updated_at
    FROM google_ads_sync_state
    WHERE business_id = ${input.businessId}
      AND scope = ${input.scope}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
    ORDER BY updated_at DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    scope: String(row.scope) as GoogleAdsWarehouseScope,
    historicalTargetStart: normalizeDate(row.historical_target_start),
    historicalTargetEnd: normalizeDate(row.historical_target_end),
    effectiveTargetStart: normalizeDate(row.effective_target_start),
    effectiveTargetEnd: normalizeDate(row.effective_target_end),
    readyThroughDate: row.ready_through_date
      ? normalizeDate(row.ready_through_date)
      : null,
    lastSuccessfulPartitionDate: row.last_successful_partition_date
      ? normalizeDate(row.last_successful_partition_date)
      : null,
    latestBackgroundActivityAt: normalizeTimestamp(
      row.latest_background_activity_at,
    ),
    latestSuccessfulSyncAt: normalizeTimestamp(row.latest_successful_sync_at),
    completedDays: toNumber(row.completed_days),
    deadLetterCount: toNumber(row.dead_letter_count),
    updatedAt: normalizeTimestamp(row.updated_at) ?? undefined,
  })) as GoogleAdsSyncStateRecord[];
}

export async function getLatestGoogleAdsSyncHealth(input: {
  businessId: string;
  providerAccountId?: string | null;
}) {
  const sql = getDb();
  const [runRows, partitionRows] = await Promise.all([
    sql`
      SELECT
        run.id,
        run.provider_account_id,
        CASE
          WHEN run.lane = 'maintenance' AND COALESCE(NULLIF(run.meta_json ->> 'source', ''), 'background_partition') = 'finalize_day' THEN 'repair_window'
          WHEN run.lane = 'maintenance' AND COALESCE(NULLIF(run.meta_json ->> 'source', ''), 'background_partition') = 'today' THEN 'today_refresh'
          WHEN run.lane = 'maintenance' THEN 'incremental_recent'
          ELSE 'initial_backfill'
        END AS sync_type,
        run.scope,
        run.partition_date AS start_date,
        run.partition_date AS end_date,
        COALESCE(NULLIF(run.meta_json ->> 'source', ''), 'background_partition') AS trigger_source,
        run.created_at AS triggered_at,
        run.status,
        run.error_message AS last_error,
        NULL::double precision AS progress_percent,
        run.finished_at,
        run.started_at,
        run.updated_at
      FROM google_ads_sync_runs run
      WHERE run.business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR run.provider_account_id = ${input.providerAccountId ?? null})
      ORDER BY run.updated_at DESC
      LIMIT 1
    `.catch(() => []) as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT
        id,
        provider_account_id,
        CASE
          WHEN lane = 'maintenance' AND source = 'finalize_day' THEN 'repair_window'
          WHEN lane = 'maintenance' AND source = 'today' THEN 'today_refresh'
          WHEN lane = 'maintenance' THEN 'incremental_recent'
          ELSE 'initial_backfill'
        END AS sync_type,
        scope,
        partition_date AS start_date,
        partition_date AS end_date,
        source AS trigger_source,
        created_at AS triggered_at,
        status,
        last_error,
        NULL::double precision AS progress_percent,
        finished_at,
        started_at,
        updated_at
      FROM google_ads_sync_partitions
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      ORDER BY updated_at DESC
      LIMIT 1
    `.catch(() => []) as Promise<Array<Record<string, unknown>>>,
  ]);
  return runRows[0] ?? partitionRows[0] ?? null;
}

export async function expireStaleGoogleAdsSyncJobs(input: {
  businessId: string;
  timeoutMinutes?: number;
}) {
  // Legacy-only: retained to neutralize pre-partition job records during migration.
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  await sql`
    UPDATE google_ads_sync_jobs
    SET
      status = 'failed',
      last_error = COALESCE(last_error, 'stale sync job expired automatically'),
      finished_at = now(),
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND status = 'running'
      AND started_at < now() - (${input.timeoutMinutes ?? 90} || ' minutes')::interval
  `;

  await sql`
    UPDATE google_ads_sync_jobs
    SET
      status = 'failed',
      last_error = COALESCE(last_error, 'stale recent repair job expired automatically'),
      finished_at = now(),
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND status = 'running'
      AND trigger_source LIKE 'repair_recent_%'
      AND started_at < now() - interval '5 minutes'
  `;
}

export async function cleanupGoogleAdsObsoleteSyncJobs(input: {
  businessId: string;
  stalePriorityMinutes?: number;
  staleBackgroundMinutes?: number;
}) {
  // Legacy-only: retained for cleanup/debug visibility. Queue/status truth must not depend on this table.
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    WITH cancelled_runtime AS (
      UPDATE google_ads_sync_jobs
      SET
        status = 'cancelled',
        last_error = COALESCE(last_error, 'legacy runtime sync was retired automatically'),
        finished_at = now(),
        updated_at = now()
      WHERE business_id = ${input.businessId}
        AND status = 'running'
        AND trigger_source = 'request_runtime'
      RETURNING id
    ),
    cancelled_unsupported_priority AS (
      UPDATE google_ads_sync_jobs
      SET
        status = 'cancelled',
        last_error = COALESCE(last_error, 'selected date preparation was limited to core scopes automatically'),
        finished_at = now(),
        updated_at = now()
      WHERE business_id = ${input.businessId}
        AND status = 'running'
        AND trigger_source = 'selected_range_priority'
        AND scope NOT IN ('campaign_daily', 'account_daily')
      RETURNING id
    ),
    cancelled_unsupported_background_initial AS (
      UPDATE google_ads_sync_jobs
      SET
        status = 'cancelled',
        last_error = COALESCE(last_error, 'historical backfill was limited to core scopes automatically'),
        finished_at = now(),
        updated_at = now()
      WHERE business_id = ${input.businessId}
        AND status = 'running'
        AND trigger_source = 'background_initial'
        AND scope NOT IN ('campaign_daily', 'account_daily')
      RETURNING id
    ),
    cancelled_priority_during_historical AS (
      UPDATE google_ads_sync_jobs
      SET
        status = 'cancelled',
        last_error = COALESCE(last_error, 'selected date preparation yielded to historical backfill automatically'),
        finished_at = now(),
        updated_at = now()
      WHERE business_id = ${input.businessId}
        AND status = 'running'
        AND trigger_source = 'selected_range_priority'
        AND EXISTS (
          SELECT 1
          FROM google_ads_sync_jobs blocker
          WHERE blocker.business_id = ${input.businessId}
            AND blocker.status = 'running'
            AND blocker.trigger_source IN ('background_initial', 'background_recent', 'background_repair', 'background_today')
        )
      RETURNING id
    ),
    failed_stale_priority AS (
      UPDATE google_ads_sync_jobs
      SET
        status = 'failed',
        last_error = COALESCE(last_error, 'selected date preparation expired automatically'),
        finished_at = now(),
        updated_at = now()
      WHERE business_id = ${input.businessId}
        AND status = 'running'
        AND trigger_source = 'selected_range_priority'
        AND started_at < now() - (${input.stalePriorityMinutes ?? 10} || ' minutes')::interval
      RETURNING id
    ),
    failed_stale_background AS (
      UPDATE google_ads_sync_jobs
      SET
        status = 'failed',
        last_error = COALESCE(last_error, 'background sync expired automatically'),
        finished_at = now(),
        updated_at = now()
      WHERE business_id = ${input.businessId}
        AND status = 'running'
        AND (
          trigger_source IN ('background_initial', 'background_recent', 'background_repair', 'background_today')
          OR trigger_source LIKE 'repair_recent_%'
        )
        AND started_at < now() - (${input.staleBackgroundMinutes ?? 5} || ' minutes')::interval
      RETURNING id
    ),
    deduped_running AS (
      UPDATE google_ads_sync_jobs job
      SET
        status = 'failed',
        last_error = COALESCE(job.last_error, 'duplicate running sync job cleaned up automatically'),
        finished_at = now(),
        updated_at = now()
      FROM (
        SELECT id
        FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY business_id, provider_account_id, sync_type, scope, start_date, end_date, trigger_source
              ORDER BY updated_at DESC, triggered_at DESC, id DESC
            ) AS row_number
          FROM google_ads_sync_jobs
          WHERE business_id = ${input.businessId}
            AND status = 'running'
        ) ranked
        WHERE ranked.row_number > 1
      ) duplicates
      WHERE job.id = duplicates.id
      RETURNING job.id
    )
    SELECT
      (SELECT COUNT(*) FROM cancelled_runtime) AS cancelled_runtime_count,
      (SELECT COUNT(*) FROM cancelled_unsupported_priority) AS cancelled_unsupported_priority_count,
      (SELECT COUNT(*) FROM cancelled_unsupported_background_initial) AS cancelled_unsupported_background_initial_count,
      (SELECT COUNT(*) FROM cancelled_priority_during_historical) AS cancelled_priority_during_historical_count,
      (SELECT COUNT(*) FROM failed_stale_priority) AS failed_stale_priority_count,
      (SELECT COUNT(*) FROM failed_stale_background) AS failed_stale_background_count,
      (SELECT COUNT(*) FROM deduped_running) AS deduped_running_count
  `) as Array<{
    cancelled_runtime_count?: string | number | null;
    cancelled_unsupported_priority_count?: string | number | null;
    cancelled_unsupported_background_initial_count?: string | number | null;
    cancelled_priority_during_historical_count?: string | number | null;
    failed_stale_priority_count?: string | number | null;
    failed_stale_background_count?: string | number | null;
    deduped_running_count?: string | number | null;
  }>;

  return {
    cancelledRuntimeCount: toNumber(rows[0]?.cancelled_runtime_count ?? 0),
    cancelledUnsupportedPriorityCount: toNumber(
      rows[0]?.cancelled_unsupported_priority_count ?? 0,
    ),
    cancelledUnsupportedBackgroundInitialCount: toNumber(
      rows[0]?.cancelled_unsupported_background_initial_count ?? 0,
    ),
    cancelledPriorityDuringHistoricalCount: toNumber(
      rows[0]?.cancelled_priority_during_historical_count ?? 0,
    ),
    failedStalePriorityCount: toNumber(
      rows[0]?.failed_stale_priority_count ?? 0,
    ),
    failedStaleBackgroundCount: toNumber(
      rows[0]?.failed_stale_background_count ?? 0,
    ),
    dedupedRunningCount: toNumber(rows[0]?.deduped_running_count ?? 0),
  };
}

export async function compactGoogleAdsExtendedBacklog(input: {
  businessId: string;
  reason: string;
  keepLatestPerScope?: number;
}) {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const keepLatestPerScope = Math.max(0, input.keepLatestPerScope ?? 0);
  const rows = (await sql`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY provider_account_id, scope
          ORDER BY partition_date DESC, updated_at DESC, id DESC
        ) AS row_number
      FROM google_ads_sync_partitions
      WHERE business_id = ${input.businessId}
        AND lane = 'extended'
        AND status IN ('queued', 'failed', 'leased', 'running')
    ),
    compacted AS (
      UPDATE google_ads_sync_partitions partition
      SET
        status = 'cancelled',
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_retry_at = NULL,
        last_error = ${input.reason},
        finished_at = now(),
        updated_at = now()
      FROM ranked
      WHERE partition.id = ranked.id
        AND ranked.row_number > ${keepLatestPerScope}
      RETURNING partition.id
    )
    SELECT COUNT(*)::int AS compacted_count
    FROM compacted
  `) as Array<{ compacted_count?: number | string | null }>;

  return {
    compactedCount: toNumber(rows[0]?.compacted_count ?? 0),
  };
}

export async function getGoogleAdsBlockedSyncDates(input: {
  businessId: string;
  scope: GoogleAdsWarehouseScope;
  triggerSources: string[];
  runningLookbackMinutes?: number;
  failedCooldownMinutes?: number;
}) {
  // Legacy-only helper for older sync job semantics.
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    SELECT DISTINCT start_date
    FROM google_ads_sync_jobs
    WHERE business_id = ${input.businessId}
      AND scope = ${input.scope}
      AND trigger_source = ANY(${input.triggerSources}::text[])
      AND (
        (status = 'running' AND started_at > now() - (${input.runningLookbackMinutes ?? 30} || ' minutes')::interval)
        OR
        (status = 'failed' AND updated_at > now() - (${input.failedCooldownMinutes ?? 10} || ' minutes')::interval)
      )
    ORDER BY start_date DESC
  `) as Array<{ start_date?: string | null }>;

  return rows
    .map((row) => (row.start_date ? String(row.start_date).slice(0, 10) : null))
    .filter((value): value is string => Boolean(value));
}

export async function hasBlockingGoogleAdsSyncJob(input: {
  businessId: string;
  syncTypes: string[];
  excludeTriggerSources?: string[];
  lookbackMinutes?: number;
}) {
  // Legacy-only helper for older manual/debug sync entrypoints.
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  const rows = (await sql`
    SELECT id
    FROM google_ads_sync_jobs
    WHERE business_id = ${input.businessId}
      AND status = 'running'
      AND sync_type = ANY(${input.syncTypes})
      AND (COALESCE(array_length(${input.excludeTriggerSources ?? []}::text[], 1), 0) = 0
        OR trigger_source <> ALL(${input.excludeTriggerSources ?? []}::text[]))
      AND started_at > now() - (${input.lookbackMinutes ?? 90} || ' minutes')::interval
    LIMIT 1
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

export async function resetGoogleAdsState() {
  await assertGoogleAdsMutationTablesReady("google_ads_warehouse");
  const sql = getDb();
  await sql`DELETE FROM provider_reporting_snapshots WHERE provider = 'google_ads' OR provider = 'google_ads_gaql'`;
  await sql`DELETE FROM provider_sync_jobs WHERE provider = 'google_ads'`;
  await clearAllProviderAccountAssignmentsForProvider("google");
  await clearAllProviderAccountSnapshotsForProvider("google");
  await sql`DELETE FROM google_ads_product_daily`;
  await sql`DELETE FROM google_ads_device_daily`;
  await sql`DELETE FROM google_ads_geo_daily`;
  await sql`DELETE FROM google_ads_audience_daily`;
  await sql`DELETE FROM google_ads_asset_daily`;
  await sql`DELETE FROM google_ads_asset_group_daily`;
  await sql`DELETE FROM google_ads_search_term_daily`;
  await sql`DELETE FROM google_ads_keyword_daily`;
  await sql`DELETE FROM google_ads_ad_daily`;
  await sql`DELETE FROM google_ads_ad_group_daily`;
  await sql`DELETE FROM google_ads_campaign_daily`;
  await sql`DELETE FROM google_ads_account_daily`;
  await sql`DELETE FROM google_ads_raw_snapshots`;
  await sql`DELETE FROM google_ads_sync_runs`;
  await sql`DELETE FROM google_ads_sync_state`;
  await sql`DELETE FROM google_ads_sync_partitions`;
  await sql`DELETE FROM google_ads_runner_leases`;
  await sql`DELETE FROM google_ads_sync_jobs`;
  await disconnectAllIntegrationsForProvider("google");
}
