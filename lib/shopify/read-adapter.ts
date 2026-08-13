import { getIntegrationMetadata } from "@/lib/integrations";
import { getShopifyOverviewAggregate } from "@/lib/shopify/overview";
import { compareShopifyAggregates, compareShopifyWarehouseAndLedger } from "@/lib/shopify/divergence";
import {
  buildShopifyOverviewCanaryKey,
  buildShopifyOverviewOverrideKey,
  SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
} from "@/lib/shopify/serving";
import { getShopifyStatus } from "@/lib/shopify/status";
import { getShopifyRevenueLedgerAggregate } from "@/lib/shopify/revenue-ledger";
import { getShopifyWarehouseOverviewAggregate } from "@/lib/shopify/warehouse-overview";
import {
  getShopifyServingState,
  getShopifyServingOverride,
  listShopifyReconciliationRuns,
} from "@/lib/shopify/warehouse";
import type { ShopifyOverviewAggregate } from "@/lib/shopify/overview";
import type { ShopifyRevenueLedgerAggregate } from "@/lib/shopify/revenue-ledger";
import type { ShopifyWarehouseOverviewAggregate } from "@/lib/shopify/warehouse-overview";
import type { ShopifyServingOverrideRecord } from "@/lib/shopify/warehouse-types";

export type ShopifyProductionServingMode = "disabled" | "auto" | "force_live" | "force_warehouse";
export type ShopifyPreferredOverviewSource =
  | "ledger"
  | "warehouse"
  | "live"
  | "warehouse_shadow"
  | "none";
export type ShopifyServingTrustState =
  | "trusted"
  | "live_fallback"
  | "pending_repair"
  | "disabled"
  | "no_data";
export type ShopifyServingCoverageStatus =
  | "recent_ready"
  | "recent_only"
  | "historical_incomplete"
  | "unknown";

export interface ShopifyOverviewServingMetadata {
  source: "ledger" | "warehouse" | "live" | "none";
  provider: "shopify";
  trustState: ShopifyServingTrustState;
  fallbackReason: string | null;
  lastSyncedAt: string | null;
  coverageStatus: ShopifyServingCoverageStatus;
  productionMode: ShopifyProductionServingMode;
  pendingRepair: boolean;
  pendingRepairStartedAt: string | null;
  pendingRepairLastTopic: string | null;
  pendingRepairLastReceivedAt: string | null;
  selectedRevenueTruthBasis: string | null;
  basisSelectionReason: string | null;
  transactionCoverageOrderRate: number | null;
  transactionCoverageAmountRate: number | null;
  explainedAdjustmentRevenue: number | null;
  unexplainedAdjustmentRevenue: number | null;
}

export interface ShopifyOverviewReadCandidate {
  status: Awaited<ReturnType<typeof getShopifyStatus>>;
  live: ShopifyOverviewAggregate | null;
  warehouse: ShopifyWarehouseOverviewAggregate | null;
  ledger: ShopifyRevenueLedgerAggregate | null;
  override: ShopifyServingOverrideRecord | null;
  divergence: ReturnType<typeof compareShopifyAggregates> | null;
  ledgerConsistency: ReturnType<typeof compareShopifyWarehouseAndLedger> | null;
  decisionReasons: string[];
  canaryEnabled: boolean;
  preferredSource: ShopifyPreferredOverviewSource;
  canServeWarehouse: boolean;
  servingMetadata: ShopifyOverviewServingMetadata;
}

function resolveProductionMode(raw: unknown): ShopifyProductionServingMode {
  if (
    raw === "disabled" ||
    raw === "auto" ||
    raw === "force_live" ||
    raw === "force_warehouse"
  ) {
    return raw;
  }
  return "disabled";
}

function pickFallbackReason(reasons: string[]) {
  return reasons[0] ?? null;
}

function pickLatestTimestamp(values: Array<string | null | undefined>) {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = new Date(value).getTime();
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = value;
      latestMs = ms;
    }
  }
  return latest;
}

function resolveCoverageStatus(status: Awaited<ReturnType<typeof getShopifyStatus>>): ShopifyServingCoverageStatus {
  if (!status.sync) return "unknown";
  const ordersHistoricalReady = Boolean(status.sync.ordersHistorical?.readyThroughDate);
  const ordersRecentReady = Boolean(status.sync.ordersRecent?.latestSuccessfulSyncAt);
  const returnsHistoricalUnavailable =
    status.sync.returnsHistorical?.lastError === "returns_api_unavailable";
  const returnsRecentUnavailable =
    status.sync.returnsRecent?.lastError === "returns_api_unavailable";
  const returnsHistoricalReady =
    returnsHistoricalUnavailable || Boolean(status.sync.returnsHistorical?.readyThroughDate);
  const returnsRecentReady =
    returnsRecentUnavailable || Boolean(status.sync.returnsRecent?.latestSuccessfulSyncAt);

  if (ordersHistoricalReady && returnsHistoricalReady) return "recent_ready";
  if (ordersRecentReady && returnsRecentReady) return "historical_incomplete";
  if (ordersRecentReady || returnsRecentReady) return "recent_only";
  return "unknown";
}

function warehouseReadCanaryEnabled() {
  const raw = process.env.SHOPIFY_WAREHOUSE_READ_CANARY?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function isPreviewCanaryBusiness(businessId: string) {
  const raw = process.env.SHOPIFY_WAREHOUSE_PREVIEW_CANARY_BUSINESSES?.trim();
  if (!raw) return true;
  const set = new Set(
    raw
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return set.has(businessId);
}

function defaultCutoverEnabled() {
  const raw = process.env.SHOPIFY_WAREHOUSE_DEFAULT_CUTOVER?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function shopifyCanaryTrustTtlMinutes() {
  const parsed = Number(process.env.SHOPIFY_CANARY_TRUST_TTL_MINUTES ?? "30");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

function isFreshTimestampMinutes(value: string | null | undefined, maxAgeMinutes: number) {
  if (!value) return false;
  const ageMs = Date.now() - new Date(value).getTime();
  return Number.isFinite(ageMs) && ageMs <= maxAgeMinutes * 60_000;
}

function pickLatestTrustedReconciliationRun(
  runs: Array<{
    recordedAt?: string | null;
    canServeWarehouse?: boolean;
    preferredSource?: string | null;
    divergence?: Record<string, unknown> | null;
  }>,
) {
  return (
    runs.find((run) => {
      const preferredSource =
        run.preferredSource === "ledger"
          ? "ledger"
          : run.preferredSource === "warehouse"
            ? "warehouse"
            : null;
      const divergenceWithin = run.divergence?.withinThreshold === true;
      const ledgerWithin =
        run.divergence?.ledgerConsistency == null ||
        (
          typeof run.divergence.ledgerConsistency === "object" &&
          (run.divergence.ledgerConsistency as Record<string, unknown>).withinThreshold ===
            true
        );
      return (
        run.canServeWarehouse === true &&
        preferredSource !== null &&
        divergenceWithin &&
        ledgerWithin &&
        isFreshTimestampMinutes(run.recordedAt ?? null, shopifyCanaryTrustTtlMinutes())
      );
    }) ?? null
  );
}

function hasWarehouseOverviewData(warehouse: ShopifyWarehouseOverviewAggregate | null) {
  if (!warehouse) return false;
  return (
    warehouse.daily.length > 0 ||
    warehouse.purchases > 0 ||
    warehouse.revenue !== 0 ||
    warehouse.grossRevenue !== 0 ||
    warehouse.refundedRevenue !== 0 ||
    warehouse.returnEvents > 0
  );
}

function buildServingMetadata(input: {
  persistedServing: Awaited<ReturnType<typeof getShopifyServingState>> | null;
  preferredSource: ShopifyPreferredOverviewSource;
  productionMode?: ShopifyProductionServingMode;
  fallbackReason?: string | null;
  trustState?: ShopifyServingTrustState;
  lastSyncedAt?: string | null;
  coverageStatus?: ShopifyServingCoverageStatus;
  divergence?: Record<string, unknown> | null;
}) {
  const persistedServing = input.persistedServing;
  const divergence =
    (input.divergence && typeof input.divergence === "object"
      ? input.divergence
      : persistedServing?.divergence) ?? null;
  return {
    source:
      input.preferredSource === "ledger"
        ? "ledger"
        : input.preferredSource === "warehouse" || input.preferredSource === "warehouse_shadow"
          ? "warehouse"
          : input.preferredSource === "none"
            ? "none"
            : "live",
    provider: "shopify" as const,
    trustState:
      input.trustState ??
      persistedServing?.trustState ??
      (input.preferredSource === "none" ? "no_data" : "live_fallback"),
    fallbackReason: input.fallbackReason ?? persistedServing?.fallbackReason ?? null,
    lastSyncedAt:
      input.lastSyncedAt ??
      persistedServing?.assessedAt ??
      null,
    coverageStatus: input.coverageStatus ?? persistedServing?.coverageStatus ?? "unknown",
    productionMode: input.productionMode ?? persistedServing?.productionMode ?? "disabled",
    pendingRepair: persistedServing?.pendingRepair === true,
    pendingRepairStartedAt: persistedServing?.pendingRepairStartedAt ?? null,
    pendingRepairLastTopic: persistedServing?.pendingRepairLastTopic ?? null,
    pendingRepairLastReceivedAt: persistedServing?.pendingRepairLastReceivedAt ?? null,
    selectedRevenueTruthBasis:
      typeof divergence?.selectedRevenueTruthBasis === "string"
        ? divergence.selectedRevenueTruthBasis
        : null,
    basisSelectionReason:
      typeof divergence?.basisSelectionReason === "string"
        ? divergence.basisSelectionReason
        : null,
    transactionCoverageOrderRate:
      typeof divergence?.transactionCoverageOrderRate === "number"
        ? divergence.transactionCoverageOrderRate
        : null,
    transactionCoverageAmountRate:
      typeof divergence?.transactionCoverageAmountRate === "number"
        ? divergence.transactionCoverageAmountRate
        : null,
    explainedAdjustmentRevenue:
      typeof divergence?.explainedAdjustmentRevenue === "number"
        ? divergence.explainedAdjustmentRevenue
        : null,
    unexplainedAdjustmentRevenue:
      typeof divergence?.unexplainedAdjustmentRevenue === "number"
        ? divergence.unexplainedAdjustmentRevenue
        : null,
  } satisfies ShopifyOverviewServingMetadata;
}

function buildServingMetadataFromPersisted(input: {
  persistedServing: Awaited<ReturnType<typeof getShopifyServingState>> | null;
  preferredSource: ShopifyPreferredOverviewSource;
  productionMode?: ShopifyProductionServingMode;
  fallbackReason?: string | null;
}) {
  return buildServingMetadata({
    persistedServing: input.persistedServing,
    preferredSource: input.preferredSource,
    productionMode: input.productionMode,
    fallbackReason: input.fallbackReason,
  });
}

export async function getShopifyOverviewSummaryReadCandidate(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<ShopifyOverviewReadCandidate> {
  const integration = await getIntegrationMetadata(input.businessId, "shopify").catch(() => null);
  const providerAccountId =
    integration?.status === "connected" && integration.provider_account_id
      ? integration.provider_account_id
      : null;
  const canaryKey = providerAccountId
    ? buildShopifyOverviewCanaryKey({
        startDate: input.startDate,
        endDate: input.endDate,
        timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
      })
    : null;
  const persistedServing =
    providerAccountId && canaryKey
      ? await getShopifyServingState({
          businessId: input.businessId,
          providerAccountId,
          canaryKey,
        }).catch(() => null)
      : null;
  const reconciliationRuns =
    providerAccountId && canaryKey
      ? await listShopifyReconciliationRuns({
          businessId: input.businessId,
          providerAccountId,
          reconciliationKey: canaryKey,
          startDate: input.startDate,
          endDate: input.endDate,
          limit: 5,
        }).catch(() => [])
      : [];
  // A trusted reconciliation for a wider window also proves the projection
  // semantics for a contained range. Without this bounded fallback, changing
  // Home from the trusted 30-day window to 7/14/28 days makes Shopify revenue
  // disappear even though every requested day is inside the reconciled range.
  const containingReconciliationRuns =
    providerAccountId && reconciliationRuns.length === 0
      ? await listShopifyReconciliationRuns({
          businessId: input.businessId,
          providerAccountId,
          limit: 20,
        })
          .then((runs) =>
            runs.filter(
              (run) =>
                Boolean(run.startDate) &&
                Boolean(run.endDate) &&
                run.startDate! <= input.startDate &&
                run.endDate! >= input.endDate,
            ),
          )
          .catch(() => [])
      : [];

  let live = null;
  let warehouse = null;
  let ledger = null;
  let preferredSource: ShopifyPreferredOverviewSource = "none";
  const productionMode = resolveProductionMode(
    integration?.metadata?.shopifyProductionServingMode,
  );

  const persistedPreferredSource =
    persistedServing?.preferredSource === "ledger" || persistedServing?.preferredSource === "warehouse"
      ? (persistedServing.preferredSource as ShopifyPreferredOverviewSource)
      : "live";
  const persistedTrusted = persistedServing?.trustState === "trusted";
  const trustedReconciliationRun = pickLatestTrustedReconciliationRun([
    ...reconciliationRuns,
    ...containingReconciliationRuns,
  ]);
  const trustedProjectionSource =
    persistedTrusted && persistedPreferredSource !== "live"
      ? persistedPreferredSource
      : trustedReconciliationRun?.preferredSource === "ledger" ||
          trustedReconciliationRun?.preferredSource === "warehouse"
        ? (trustedReconciliationRun.preferredSource as ShopifyPreferredOverviewSource)
        : null;

  if (trustedProjectionSource === "ledger") {
    ledger = await getShopifyRevenueLedgerAggregate({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch(() => null);
    if (ledger) preferredSource = "ledger";
  }

  if (preferredSource === "none" && trustedProjectionSource === "warehouse") {
    warehouse = await getShopifyWarehouseOverviewAggregate({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch(() => null);
    if (warehouse) preferredSource = "warehouse";
  }

  if (preferredSource === "none") {
    const persistedExplicitLiveFallback =
      persistedServing?.preferredSource === "live" ||
      persistedServing?.trustState === "live_fallback" ||
      persistedServing?.trustState === "pending_repair" ||
      persistedServing?.trustState === "disabled";
    if (persistedExplicitLiveFallback) {
      preferredSource = "live";
    } else if (!warehouse && (persistedPreferredSource === "warehouse" || productionMode !== "disabled")) {
      warehouse = await getShopifyWarehouseOverviewAggregate({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
      }).catch(() => null);
      preferredSource = hasWarehouseOverviewData(warehouse) ? "warehouse_shadow" : "none";
    } else {
      preferredSource = "none";
    }
  }

  return {
    status: {
      state:
        integration?.status === "connected"
          ? preferredSource === "none"
            ? "partial"
            : "ready"
          : "not_connected",
      connected: integration?.status === "connected",
      shopId: providerAccountId,
      warehouse: null,
      sync: null,
      serving: persistedServing,
      reconciliation: null,
      issues: [],
    },
    live,
    warehouse,
    ledger,
    override: null,
    divergence: null,
    ledgerConsistency: null,
    decisionReasons: persistedServing?.decisionReasons ?? [],
    canaryEnabled:
      persistedServing?.canaryEnabled === true || trustedReconciliationRun != null,
    preferredSource,
    canServeWarehouse: preferredSource === "ledger" || preferredSource === "warehouse",
    servingMetadata:
      trustedReconciliationRun && !persistedTrusted && preferredSource !== "live"
        ? buildServingMetadata({
            persistedServing,
            preferredSource,
            productionMode,
            trustState: preferredSource === "none" ? "no_data" : "trusted",
            fallbackReason: null,
            lastSyncedAt: trustedReconciliationRun.recordedAt ?? null,
            coverageStatus: persistedServing?.coverageStatus ?? "unknown",
            divergence: trustedReconciliationRun.divergence ?? null,
          })
        : buildServingMetadataFromPersisted({
            persistedServing,
            preferredSource,
            productionMode,
            fallbackReason:
              preferredSource === "warehouse_shadow" && !persistedServing
                ? "range_serving_state_unavailable"
                : null,
          }),
  } as const;
}

export async function getShopifyOverviewReadCandidate(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<ShopifyOverviewReadCandidate> {
  const [integration, status, live, warehouse, ledger] = await Promise.all([
    getIntegrationMetadata(input.businessId, "shopify").catch(() => null),
    getShopifyStatus({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      ignoreServingTrust: true,
    }),
    getShopifyOverviewAggregate(input),
    getShopifyWarehouseOverviewAggregate({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch(() => null),
    getShopifyRevenueLedgerAggregate({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch(() => null),
  ]);
  const override =
    status.shopId
      ? await getShopifyServingOverride({
          businessId: input.businessId,
          providerAccountId: status.shopId,
          overrideKey: buildShopifyOverviewOverrideKey({
            startDate: input.startDate,
            endDate: input.endDate,
            timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
          }),
        }).catch(() => null)
      : null;

  const divergence =
    live && warehouse
      ? compareShopifyAggregates({
          live,
          warehouse,
          ledger,
        })
      : null;
  const ledgerConsistency =
    warehouse && ledger
      ? compareShopifyWarehouseAndLedger({
          warehouse,
          ledger,
        })
      : null;
  const persistedServing = status.serving;
  const productionMode = resolveProductionMode(
    integration?.metadata?.shopifyProductionServingMode
  );

  const decisionReasons: string[] = [];
  const canaryEnabled = warehouseReadCanaryEnabled();
  const previewAllowed = isPreviewCanaryBusiness(input.businessId);
  const defaultCutoverEligible = status.reconciliation?.defaultCutoverEligible === true;

  if (status.state !== "ready") {
    decisionReasons.push(`status_${status.state}`);
  }
  if (!warehouse) {
    decisionReasons.push("warehouse_aggregate_unavailable");
  }
  if (!live) {
    decisionReasons.push("live_aggregate_unavailable");
  }
  if (live && warehouse && divergence?.withinThreshold !== true) {
    decisionReasons.push("divergence_above_threshold");
  }
  if (warehouse && ledger && ledgerConsistency?.withinThreshold !== true) {
    decisionReasons.push("ledger_semantics_above_threshold");
    if (ledgerConsistency?.failureReasons?.length) {
      decisionReasons.push(
        ...ledgerConsistency.failureReasons.map((reason) => `ledger_${reason}`)
      );
    }
  }

  const forcedLive = override?.mode === "force_live";
  const forcedWarehouse = override?.mode === "force_warehouse";
  const shopForcedLive = productionMode === "force_live";
  const shopForcedWarehouse = productionMode === "force_warehouse";
  const shopDisabled = productionMode === "disabled";
  if (forcedLive) {
    decisionReasons.push("override_force_live");
  }
  if (forcedWarehouse) {
    decisionReasons.push("override_force_warehouse");
  }
  if (shopForcedLive) {
    decisionReasons.push("shop_force_live");
  }
  if (shopForcedWarehouse) {
    decisionReasons.push("shop_force_warehouse");
  }
  if (shopDisabled) {
    decisionReasons.push("shop_production_serving_disabled");
  }

  const baseTrustedReadEligible =
    !forcedLive &&
    !shopForcedLive &&
    !shopDisabled &&
    status.state === "ready" &&
    divergence?.withinThreshold === true;
  const ledgerTrusted =
    forcedWarehouse || shopForcedWarehouse
      ? Boolean(ledger && ledger.ledgerRows > 0)
      : baseTrustedReadEligible &&
        Boolean(ledger && ledger.ledgerRows > 0) &&
        ledgerConsistency?.withinThreshold === true;
  const warehouseTrusted =
    forcedWarehouse || shopForcedWarehouse
      ? Boolean(warehouse)
      : baseTrustedReadEligible &&
        canaryEnabled &&
        (previewAllowed || defaultCutoverEligible) &&
        Boolean(warehouse) &&
        (ledgerConsistency === null || ledgerConsistency.withinThreshold === true);

  if (!ledgerTrusted) {
    if (!canaryEnabled) {
      decisionReasons.push("warehouse_read_canary_disabled");
    }
    if (!previewAllowed && !defaultCutoverEligible) {
      decisionReasons.push("preview_canary_not_allowed_for_business");
    }
    if (defaultCutoverEnabled() && !defaultCutoverEligible && !previewAllowed) {
      decisionReasons.push("default_cutover_gate_not_met");
    }
  }

  const pendingRepair = persistedServing?.pendingRepair === true;
  const rawCanServeTrustedShopify = ledgerTrusted || warehouseTrusted;
  const canRecoverFromPendingRepair = rawCanServeTrustedShopify;
  const nextConsecutiveCleanValidations =
    pendingRepair && canRecoverFromPendingRepair
      ? (persistedServing?.consecutiveCleanValidations ?? 0) + 1
      : rawCanServeTrustedShopify
        ? Math.max(1, persistedServing?.consecutiveCleanValidations ?? 0)
        : 0;
  const recoveryUnlocked =
    pendingRepair && canRecoverFromPendingRepair && nextConsecutiveCleanValidations >= 2;
  const shouldHoldLiveForPendingRepair = pendingRepair && !recoveryUnlocked;
  if (shouldHoldLiveForPendingRepair) {
    decisionReasons.push("pending_repair");
  }

  const canServeTrustedShopify = rawCanServeTrustedShopify && !shouldHoldLiveForPendingRepair;
  const preferredSource: ShopifyPreferredOverviewSource = canServeTrustedShopify
    ? ledgerTrusted
      ? "ledger"
      : "warehouse"
    : forcedLive || shopForcedLive || shopDisabled
      ? live
        ? "live"
        : warehouse
          ? "warehouse_shadow"
          : "none"
      : live
      ? "live"
      : warehouse
        ? "warehouse_shadow"
        : "none";

  const selectedRevenueTruthBasis = ledgerConsistency?.preferredOrderRevenueBasis ?? null;
  const ledgerAdjustmentRevenue =
    typeof ledgerConsistency?.ledgerAdjustmentRevenue === "number"
      ? ledgerConsistency.ledgerAdjustmentRevenue
      : 0;
  const explainedAdjustmentRevenue =
    ledgerAdjustmentRevenue < 0
      ? Math.abs(ledgerAdjustmentRevenue)
      : 0;
  const unexplainedAdjustmentRevenue =
    ledgerAdjustmentRevenue > 0
      ? ledgerAdjustmentRevenue
      : 0;
  const transactionCoverageAmountRate = ledgerConsistency?.transactionCoverageAmountRate ?? null;
  const fallbackReason =
    canServeTrustedShopify
      ? null
      : shopDisabled
        ? "production_serving_disabled"
        : shouldHoldLiveForPendingRepair
          ? "pending_repair"
          : pickFallbackReason(decisionReasons);
  const trustState: ShopifyServingTrustState =
    canServeTrustedShopify
      ? "trusted"
      : preferredSource === "none"
        ? "no_data"
        : shouldHoldLiveForPendingRepair
          ? "pending_repair"
          : shopDisabled
            ? "disabled"
            : "live_fallback";
  const coverageStatus = resolveCoverageStatus(status);
  const lastSyncedAt = pickLatestTimestamp([
    status.sync?.ordersRecent?.latestSuccessfulSyncAt ?? null,
    status.sync?.returnsRecent?.latestSuccessfulSyncAt ?? null,
    status.sync?.ordersHistorical?.latestSuccessfulSyncAt ?? null,
    status.sync?.returnsHistorical?.latestSuccessfulSyncAt ?? null,
  ]);

  return {
    status,
    live,
    warehouse,
    ledger,
    override,
    divergence,
    ledgerConsistency,
    decisionReasons,
    canaryEnabled,
    preferredSource,
    canServeWarehouse: canServeTrustedShopify,
    servingMetadata: {
      source:
        preferredSource === "ledger"
          ? "ledger"
          : preferredSource === "warehouse" || preferredSource === "warehouse_shadow"
            ? "warehouse"
            : preferredSource === "none"
              ? "none"
              : "live",
      provider: "shopify",
      trustState,
      fallbackReason,
      lastSyncedAt,
      coverageStatus,
      productionMode,
      pendingRepair: shouldHoldLiveForPendingRepair,
      pendingRepairStartedAt:
        shouldHoldLiveForPendingRepair
          ? persistedServing?.pendingRepairStartedAt ?? lastSyncedAt
          : null,
      pendingRepairLastTopic:
        shouldHoldLiveForPendingRepair ? persistedServing?.pendingRepairLastTopic ?? null : null,
      pendingRepairLastReceivedAt:
        shouldHoldLiveForPendingRepair ? persistedServing?.pendingRepairLastReceivedAt ?? null : null,
      selectedRevenueTruthBasis,
      basisSelectionReason:
        selectedRevenueTruthBasis === "current_total_price"
          ? "closest_current_order_revenue"
          : selectedRevenueTruthBasis === "gross_minus_total_refunded"
            ? "closest_gross_minus_refunds_revenue"
            : null,
      transactionCoverageOrderRate: ledgerConsistency?.transactionCoverageRate ?? null,
      transactionCoverageAmountRate,
      explainedAdjustmentRevenue,
      unexplainedAdjustmentRevenue,
    },
  } as const;
}
