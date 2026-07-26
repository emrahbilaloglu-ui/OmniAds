import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import { getIntegration, mergeIntegrationMetadata } from "@/lib/integrations";
import {
  readShopifyGrantAuthority,
  assertShopifyGrantUnchanged,
} from "@/lib/shopify/install-context";
import { hasShopifyScope, resolveShopifyAdminCredentials } from "@/lib/shopify/admin";
import { getShopifyOverviewReadCandidate } from "@/lib/shopify/read-adapter";
import {
  buildShopifyOverviewCanaryKey,
  SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
} from "@/lib/shopify/serving";
import {
  persistShopifyOverviewServingState,
  recordShopifyOverviewReconciliationRun,
} from "@/lib/shopify/overview-materializer";
import { syncShopifyOrdersWindow, syncShopifyReturnsWindow } from "@/lib/shopify/commerce-sync";
import { getShopifyRevenueLedgerAggregate } from "@/lib/shopify/revenue-ledger";
import { getShopifyStatus } from "@/lib/shopify/status";
import {
  registerShopifySyncWebhooks,
  verifyShopifySyncWebhooks,
  type ShopifySyncWebhookVerification,
} from "@/lib/shopify/webhooks";
import { getShopifyWarehouseOverviewAggregate } from "@/lib/shopify/warehouse-overview";
import { getShopifySyncState, upsertShopifySyncState } from "@/lib/shopify/sync-state";
import {
  shouldAutoWarmShopifyOverviewSnapshot,
} from "@/lib/sync/report-warmer-boundaries";
import type { RunnerLeaseGuard } from "@/lib/sync/worker-runtime";
import { warmShopifyOverviewReportCache } from "@/lib/user-facing-report-cache-owners";
import { logRuntimeInfo } from "@/lib/runtime-logging";

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFlag(name: string, fallback = false) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return fallback;
}

function orchestrationStamp(step: string, status: "running" | "succeeded" | "failed" | "skipped", summary?: Record<string, unknown>) {
  return {
    step,
    status,
    recordedAt: new Date().toISOString(),
    ...(summary ? { summary } : {}),
  };
}

function getTodayIsoForTimeZoneServer(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function classifyShopifySyncWindow(
  credentials: Awaited<ReturnType<typeof resolveShopifyAdminCredentials>>,
  input?: { recentWindowDays?: number }
) {
  const timeZone =
    typeof credentials?.metadata?.iana_timezone === "string"
      ? credentials.metadata.iana_timezone
      : "UTC";
  const today = getTodayIsoForTimeZoneServer(timeZone);
  const historyDays = input?.recentWindowDays ?? envNumber("SHOPIFY_COMMERCE_SYNC_DAYS", 7);
  const end = new Date(`${today}T00:00:00Z`);
  const start = addDays(end, -(historyDays - 1));
  return {
    startDate: toIsoDate(start),
    endDate: today,
    today,
    timeZone,
  };
}

function classifyShopifyHistoricalWindow(
  credentials: Awaited<ReturnType<typeof resolveShopifyAdminCredentials>>
) {
  const timeZone =
    typeof credentials?.metadata?.iana_timezone === "string"
      ? credentials.metadata.iana_timezone
      : "UTC";
  const today = getTodayIsoForTimeZoneServer(timeZone);
  const historyDays = envNumber("SHOPIFY_HISTORICAL_SYNC_DAYS", 365);
  const chunkDays = envNumber("SHOPIFY_HISTORICAL_SYNC_CHUNK_DAYS", 30);
  const yesterday = addDays(new Date(`${today}T00:00:00Z`), -1);
  const start = addDays(yesterday, -(historyDays - 1));
  return {
    targetStartDate: toIsoDate(start),
    targetEndDate: toIsoDate(yesterday),
    chunkDays,
    today,
    timeZone,
  };
}

function shopifyHistoricalChunksPerRun() {
  const parsed = Math.trunc(envNumber("SHOPIFY_HISTORICAL_SYNC_CHUNKS_PER_RUN", 3));
  return Math.max(1, Math.min(parsed, 6));
}

function addDaysToIsoDate(value: string, days: number) {
  return toIsoDate(addDays(new Date(`${value}T00:00:00Z`), days));
}

function minIsoDate(a: string, b: string) {
  return a <= b ? a : b;
}

function computeHistoricalChunk(input: {
  targetStartDate: string;
  targetEndDate: string;
  chunkDays: number;
  existingCursorValue?: string | null;
}) {
  const startDate = input.existingCursorValue
    ? addDaysToIsoDate(input.existingCursorValue, 1)
    : input.targetStartDate;
  if (startDate > input.targetEndDate) return null;
  const endDate = minIsoDate(addDaysToIsoDate(startDate, input.chunkDays - 1), input.targetEndDate);
  return { startDate, endDate };
}

function toSerializableRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

async function materializeShopifyOverviewAfterSync(input: {
  businessId: string;
  providerAccountId: string;
  startDate: string;
  endDate: string;
  runtimeValidationLog?: (phase: string, summary?: Record<string, unknown>) => void;
}) {
  const logRuntimeValidation = input.runtimeValidationLog ?? (() => {});
  const assessedAt = new Date().toISOString();
  const canaryKey = buildShopifyOverviewCanaryKey({
    startDate: input.startDate,
    endDate: input.endDate,
    timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
  });
  const candidate = await getShopifyOverviewReadCandidate({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
  });

  const previousValidations = candidate.status.serving?.consecutiveCleanValidations ?? 0;
  const consecutiveCleanValidations =
    candidate.servingMetadata.pendingRepair
      ? previousValidations
      : candidate.servingMetadata.trustState === "trusted"
        ? Math.max(
            1,
            previousValidations + (candidate.status.serving?.pendingRepair ? 1 : 0),
          )
        : 0;
  const divergenceSnapshot = {
    aggregateDivergence: candidate.divergence ?? null,
    ledgerConsistency: candidate.ledgerConsistency ?? null,
    withinThreshold: candidate.divergence?.withinThreshold === true,
    selectedRevenueTruthBasis: candidate.servingMetadata.selectedRevenueTruthBasis,
    basisSelectionReason: candidate.servingMetadata.basisSelectionReason,
    transactionCoverageOrderRate: candidate.servingMetadata.transactionCoverageOrderRate,
    transactionCoverageAmountRate: candidate.servingMetadata.transactionCoverageAmountRate,
    explainedAdjustmentRevenue: candidate.servingMetadata.explainedAdjustmentRevenue,
    unexplainedAdjustmentRevenue: candidate.servingMetadata.unexplainedAdjustmentRevenue,
  } satisfies Record<string, unknown>;

  logRuntimeValidation("post_recent_serving_state_started", {
    startDate: input.startDate,
    endDate: input.endDate,
    canaryKey,
  });
  await persistShopifyOverviewServingState({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    canaryKey,
    startDate: input.startDate,
    endDate: input.endDate,
    timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
    assessedAt,
    statusState: candidate.status.state,
    preferredSource: candidate.preferredSource,
    productionMode: candidate.servingMetadata.productionMode,
    trustState: candidate.servingMetadata.trustState,
    fallbackReason: candidate.servingMetadata.fallbackReason,
    coverageStatus: candidate.servingMetadata.coverageStatus,
    pendingRepair: candidate.servingMetadata.pendingRepair,
    pendingRepairStartedAt: candidate.servingMetadata.pendingRepairStartedAt,
    pendingRepairLastTopic: candidate.servingMetadata.pendingRepairLastTopic,
    pendingRepairLastReceivedAt: candidate.servingMetadata.pendingRepairLastReceivedAt,
    consecutiveCleanValidations,
    ordersRecentSyncedAt: candidate.status.sync?.ordersRecent?.latestSuccessfulSyncAt ?? null,
    ordersRecentCursorTimestamp: candidate.status.sync?.ordersRecent?.cursorTimestamp ?? null,
    ordersRecentCursorValue: candidate.status.sync?.ordersRecent?.cursorValue ?? null,
    returnsRecentSyncedAt: candidate.status.sync?.returnsRecent?.latestSuccessfulSyncAt ?? null,
    returnsRecentCursorTimestamp: candidate.status.sync?.returnsRecent?.cursorTimestamp ?? null,
    returnsRecentCursorValue: candidate.status.sync?.returnsRecent?.cursorValue ?? null,
    ordersHistoricalSyncedAt:
      candidate.status.sync?.ordersHistorical?.latestSuccessfulSyncAt ?? null,
    ordersHistoricalReadyThroughDate:
      candidate.status.sync?.ordersHistorical?.readyThroughDate ?? null,
    ordersHistoricalTargetEnd:
      candidate.status.sync?.ordersHistorical?.historicalTargetEnd ?? null,
    returnsHistoricalSyncedAt:
      candidate.status.sync?.returnsHistorical?.latestSuccessfulSyncAt ?? null,
    returnsHistoricalReadyThroughDate:
      candidate.status.sync?.returnsHistorical?.readyThroughDate ?? null,
    returnsHistoricalTargetEnd:
      candidate.status.sync?.returnsHistorical?.historicalTargetEnd ?? null,
    canServeWarehouse: candidate.canServeWarehouse,
    canaryEnabled: candidate.canaryEnabled,
    decisionReasons: candidate.decisionReasons,
    divergence: divergenceSnapshot,
  });

  logRuntimeValidation("post_recent_serving_state_succeeded", {
    startDate: input.startDate,
    endDate: input.endDate,
    canaryKey,
    assessedAt,
  });

  logRuntimeValidation("post_recent_reconciliation_started", {
    startDate: input.startDate,
    endDate: input.endDate,
    reconciliationKey: canaryKey,
  });
  await recordShopifyOverviewReconciliationRun({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    reconciliationKey: canaryKey,
    startDate: input.startDate,
    endDate: input.endDate,
    preferredSource: candidate.preferredSource,
    canServeWarehouse: candidate.canServeWarehouse,
    selectedRevenueTruthBasis: candidate.servingMetadata.selectedRevenueTruthBasis,
    basisSelectionReason: candidate.servingMetadata.basisSelectionReason,
    transactionCoverageOrderRate: candidate.servingMetadata.transactionCoverageOrderRate,
    transactionCoverageAmountRate: candidate.servingMetadata.transactionCoverageAmountRate,
    orderRevenueTruthDelta: candidate.ledgerConsistency?.orderRevenueTruthDelta ?? null,
    transactionRevenueDelta: candidate.ledgerConsistency?.transactionRevenueDelta ?? null,
    explainedAdjustmentRevenue: candidate.servingMetadata.explainedAdjustmentRevenue,
    unexplainedAdjustmentRevenue: candidate.servingMetadata.unexplainedAdjustmentRevenue,
    divergence: divergenceSnapshot,
    warehouseAggregate: toSerializableRecord(candidate.warehouse),
    ledgerAggregate: toSerializableRecord(candidate.ledger),
    liveAggregate: toSerializableRecord(candidate.live),
    recordedAt: assessedAt,
  });

  logRuntimeValidation("post_recent_reconciliation_succeeded", {
    startDate: input.startDate,
    endDate: input.endDate,
    reconciliationKey: canaryKey,
    assessedAt,
  });

  return {
    preferredSource: candidate.preferredSource,
    trustState: candidate.servingMetadata.trustState,
    fallbackReason: candidate.servingMetadata.fallbackReason,
    pendingRepair: candidate.servingMetadata.pendingRepair,
    canServeWarehouse: candidate.canServeWarehouse,
    recordedAt: assessedAt,
  };
}

export async function syncShopifyCommerceReports(
  businessId: string,
  input?: {
    runtimeLeaseGuard?: RunnerLeaseGuard;
    recentWindowDays?: number;
    triggerReason?: string;
    runtimeValidationRunId?: string;
    recentTargets?: {
      orders?: boolean;
      returns?: boolean;
    };
    allowHistorical?: boolean;
    materializeOverviewState?: boolean;
  }
) {
  // Admission BEFORE credentials, before any database read or write, before any
  // provider call. Shopify declared a kill-switch lane and had no call to it,
  // and it bypassed the growth fence entirely — its raw snapshot table is
  // 13.9 GB, the second-largest append surface in the database.
  assertSyncLaneEnabled("shopify_sync");
  await assertSyncGrowthBoundary("shopify_commerce_sync", { fresh: true });
  const logValidationPhase = (phase: string, summary?: Record<string, unknown>) => {
    if (input?.triggerReason !== "runtime_validation") {
      return;
    }
    logRuntimeInfo("shopify-sync", "runtime_validation_phase", {
      businessId,
      phase,
      ...(summary ? { summary } : {}),
    });
  };
  const runtimeValidationRunId =
    input?.triggerReason === "runtime_validation"
      ? input.runtimeValidationRunId ??
        `shopify_rtval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      : null;
  const credentials = await resolveShopifyAdminCredentials(businessId).catch(() => null);
  if (!credentials) {
    return {
      success: false,
      reason: "not_connected" as const,
      orders: 0,
      orderLines: 0,
      refunds: 0,
      transactions: 0,
      returns: 0,
      pages: 0,
      returnPages: 0,
    };
  }

  const window = classifyShopifySyncWindow(credentials, {
    recentWindowDays: input?.recentWindowDays,
  });
  const runOrdersRecent = input?.recentTargets?.orders !== false;
  const runReturnsRecent = input?.recentTargets?.returns !== false;
  const allowHistorical = input?.allowHistorical !== false;
  const shouldMaterializeOverviewState = shouldAutoWarmShopifyOverviewSnapshot(input);
  const historical = classifyShopifyHistoricalWindow(credentials);
  const existingOrdersState = await getShopifySyncState({
    businessId,
    providerAccountId: credentials.shopId,
    syncTarget: "commerce_orders_recent",
  }).catch(() => null);
  const existingReturnsState = await getShopifySyncState({
    businessId,
    providerAccountId: credentials.shopId,
    syncTarget: "commerce_returns_recent",
  }).catch(() => null);
  const existingHistoricalOrdersState = await getShopifySyncState({
    businessId,
    providerAccountId: credentials.shopId,
    syncTarget: "commerce_orders_historical",
  }).catch(() => null);
  const existingHistoricalReturnsState = await getShopifySyncState({
    businessId,
    providerAccountId: credentials.shopId,
    syncTarget: "commerce_returns_historical",
  }).catch(() => null);

  if (runOrdersRecent) {
    await upsertShopifySyncState({
      businessId,
      providerAccountId: credentials.shopId,
      syncTarget: "commerce_orders_recent",
      historicalTargetStart: existingOrdersState?.historicalTargetStart ?? window.startDate,
      historicalTargetEnd: existingOrdersState?.historicalTargetEnd ?? window.endDate,
      latestSyncStartedAt: new Date().toISOString(),
      latestSyncStatus: "running",
      latestSyncWindowStart: window.startDate,
      latestSyncWindowEnd: window.endDate,
      lastError: null,
    });
  }
  if (runReturnsRecent) {
    await upsertShopifySyncState({
      businessId,
      providerAccountId: credentials.shopId,
      syncTarget: "commerce_returns_recent",
      historicalTargetStart: existingReturnsState?.historicalTargetStart ?? window.startDate,
      historicalTargetEnd: existingReturnsState?.historicalTargetEnd ?? window.endDate,
      latestSyncStartedAt: new Date().toISOString(),
      latestSyncStatus: "running",
      latestSyncWindowStart: window.startDate,
      latestSyncWindowEnd: window.endDate,
      lastError: null,
    });
  }

  if (input?.runtimeLeaseGuard?.isLeaseLost()) {
    if (runOrdersRecent) {
      await upsertShopifySyncState({
        businessId,
        providerAccountId: credentials.shopId,
        syncTarget: "commerce_orders_recent",
        latestSyncStatus: "cancelled",
        latestSyncWindowStart: window.startDate,
        latestSyncWindowEnd: window.endDate,
        lastError: input.runtimeLeaseGuard.getLeaseLossReason(),
      });
    }
    if (runReturnsRecent) {
      await upsertShopifySyncState({
        businessId,
        providerAccountId: credentials.shopId,
        syncTarget: "commerce_returns_recent",
        latestSyncStatus: "cancelled",
        latestSyncWindowStart: window.startDate,
        latestSyncWindowEnd: window.endDate,
        lastError: input.runtimeLeaseGuard.getLeaseLossReason(),
      });
    }
    return {
      success: false,
      reason: "lease_lost" as const,
      orders: 0,
      orderLines: 0,
      refunds: 0,
      transactions: 0,
      returns: 0,
      pages: 0,
      returnPages: 0,
    };
  }

  try {
    if (runOrdersRecent) {
      logValidationPhase("recent_orders_phase_started", {
        startDate: window.startDate,
        endDate: window.endDate,
        queryField: "updated_at",
        runId: runtimeValidationRunId,
      });
    }
    const [ordersSettled, returnsSettled] = await Promise.allSettled([
      runOrdersRecent
        ? syncShopifyOrdersWindow({
            businessId,
            startDate: window.startDate,
            endDate: window.endDate,
            queryField: "updated_at",
            runtimeValidationLog: (phase, summary) => {
              logValidationPhase(phase, summary);
            },
            runtimeValidationRunId: runtimeValidationRunId ?? undefined,
          })
        : Promise.resolve({
            success: true as const,
            reason: "skipped" as const,
            orders: 0,
            orderLines: 0,
            refunds: 0,
            transactions: 0,
            pages: 0,
            maxUpdatedAt: null,
          }),
      runReturnsRecent
        ? syncShopifyReturnsWindow({
            businessId,
            startDate: window.startDate,
            endDate: window.endDate,
          })
        : Promise.resolve({
            success: true as const,
            reason: "skipped" as const,
            returns: 0,
            pages: 0,
            maxUpdatedAt: null,
          }),
    ]);
    const ordersResult =
      ordersSettled.status === "fulfilled"
        ? ordersSettled.value
        : {
            success: false as const,
            reason:
              ordersSettled.reason instanceof Error
                ? ordersSettled.reason.message
                : String(ordersSettled.reason),
            orders: 0,
            orderLines: 0,
            refunds: 0,
            transactions: 0,
            pages: 0,
            maxUpdatedAt: null,
          };
    const returnsResult =
      returnsSettled.status === "fulfilled"
        ? returnsSettled.value
        : {
            success: false as const,
            reason:
              returnsSettled.reason instanceof Error
                ? returnsSettled.reason.message
                : String(returnsSettled.reason),
            returns: 0,
            pages: 0,
            maxUpdatedAt: null,
          };
    if (!ordersResult.success) {
      if (runOrdersRecent) {
        logValidationPhase("recent_orders_phase_failed", {
          startDate: window.startDate,
          endDate: window.endDate,
          reason: ordersResult.reason,
        });
      }
      if (runOrdersRecent) {
        await upsertShopifySyncState({
          businessId,
          providerAccountId: credentials.shopId,
          syncTarget: "commerce_orders_recent",
          latestSyncStatus: ordersResult.reason,
          latestSyncWindowStart: window.startDate,
          latestSyncWindowEnd: window.endDate,
          lastError: ordersResult.reason,
        });
      }
      return ordersResult;
    }
    if (!returnsResult.success) {
      if (runReturnsRecent) {
        await upsertShopifySyncState({
          businessId,
          providerAccountId: credentials.shopId,
          syncTarget: "commerce_returns_recent",
          latestSyncStatus: returnsResult.reason,
          latestSyncWindowStart: window.startDate,
          latestSyncWindowEnd: window.endDate,
          lastError: returnsResult.reason,
        });
      }
    }

    logValidationPhase("transition_to_shadow_started", {
      startDate: window.startDate,
      endDate: window.endDate,
      shouldMaterializeOverviewState,
    });
    logValidationPhase("warehouse_shadow_started", {
      startDate: window.startDate,
      endDate: window.endDate,
    });
    const warehouseShadow = await getShopifyWarehouseOverviewAggregate({
      businessId,
      providerAccountId: credentials.shopId,
      startDate: window.startDate,
      endDate: window.endDate,
    }).catch(() => null);
    logValidationPhase("warehouse_shadow_succeeded", {
      startDate: window.startDate,
      endDate: window.endDate,
      found: warehouseShadow !== null,
    });
    logValidationPhase("ledger_shadow_started", {
      startDate: window.startDate,
      endDate: window.endDate,
    });
    const ledgerShadow = await getShopifyRevenueLedgerAggregate({
      businessId,
      providerAccountId: credentials.shopId,
      startDate: window.startDate,
      endDate: window.endDate,
    }).catch(() => null);
    logValidationPhase("ledger_shadow_succeeded", {
      startDate: window.startDate,
      endDate: window.endDate,
      found: ledgerShadow !== null,
    });

    const result = {
      success: true as const,
      reason: "ok" as const,
      orders: ordersResult.orders,
      orderLines: ordersResult.orderLines,
      refunds: ordersResult.refunds,
      transactions: ordersResult.transactions,
      returns: returnsResult.success ? returnsResult.returns : 0,
      pages: ordersResult.pages,
      returnPages: returnsResult.success ? returnsResult.pages : 0,
      reconciliation: {
        orderRows: ordersResult.orders,
        refundRows: ordersResult.refunds,
        transactionRows: ordersResult.transactions,
        returnRows: returnsResult.success ? returnsResult.returns : 0,
        orderPages: ordersResult.pages,
        returnPages: returnsResult.success ? returnsResult.pages : 0,
        warehouseShadow: warehouseShadow
          ? {
              revenue: warehouseShadow.revenue,
              grossRevenue: warehouseShadow.grossRevenue,
              refundedRevenue: warehouseShadow.refundedRevenue,
              purchases: warehouseShadow.purchases,
              returnEvents: warehouseShadow.returnEvents,
            }
          : null,
        ledgerShadow: ledgerShadow
          ? {
              revenue: ledgerShadow.revenue,
              grossRevenue: ledgerShadow.grossRevenue,
              refundedRevenue: ledgerShadow.refundedRevenue,
              purchases: ledgerShadow.purchases,
              returnEvents: ledgerShadow.returnEvents,
              ledgerRows: ledgerShadow.ledgerRows,
            }
          : null,
        triggerReason: input?.triggerReason ?? null,
        windowDays: input?.recentWindowDays ?? null,
        recentTargets: {
          orders: runOrdersRecent,
          returns: runReturnsRecent,
        },
        historicalTriggered: allowHistorical,
        returnsSyncReason: returnsResult.success ? null : returnsResult.reason,
      },
    };
    logValidationPhase("recent_sync_succeeded", {
      startDate: window.startDate,
      endDate: window.endDate,
      orders: result.orders,
      returns: result.returns,
      shouldMaterializeOverviewState,
    });

    let historicalResult: null | {
      orders: number;
      orderLines: number;
      refunds: number;
      transactions: number;
      returns: number;
      pages: number;
      returnPages: number;
      chunks: number;
      chunkStartDate: string;
      chunkEndDate: string;
    } = null;

    if (allowHistorical && envFlag("SHOPIFY_HISTORICAL_SYNC_ENABLED", true) && hasShopifyScope(credentials.scopes, "read_all_orders")) {
      const runHistoricalReturns = hasShopifyScope(credentials.scopes, "read_returns");
      let historicalOrdersCursorValue = existingHistoricalOrdersState?.cursorValue ?? null;
      let historicalReturnsCursorValue = existingHistoricalReturnsState?.cursorValue ?? null;
      const maxHistoricalChunksPerRun = shopifyHistoricalChunksPerRun();

      for (let chunkIndex = 0; chunkIndex < maxHistoricalChunksPerRun; chunkIndex += 1) {
        // Re-admitted per CHUNK. A historical backfill run walks many chunks,
        // each of which calls Shopify and writes orders, returns and cursor
        // state. Admitting once at the top means a lane disabled or a disk
        // filled during the run is not noticed until every remaining chunk has
        // already been fetched and written.
        assertSyncLaneEnabled("shopify_sync");
        await assertSyncGrowthBoundary("shopify_historical_chunk", { fresh: true });

        const ordersChunk = computeHistoricalChunk({
          targetStartDate: historical.targetStartDate,
          targetEndDate: historical.targetEndDate,
          chunkDays: historical.chunkDays,
          existingCursorValue: historicalOrdersCursorValue,
        });
        const returnsChunk = runHistoricalReturns
          ? computeHistoricalChunk({
              targetStartDate: historical.targetStartDate,
              targetEndDate: historical.targetEndDate,
              chunkDays: historical.chunkDays,
              existingCursorValue: historicalReturnsCursorValue,
            })
          : null;

        if (!ordersChunk && !returnsChunk) break;

        if (ordersChunk) {
          await upsertShopifySyncState({
            businessId,
            providerAccountId: credentials.shopId,
            syncTarget: "commerce_orders_historical",
            historicalTargetStart: historical.targetStartDate,
            historicalTargetEnd: historical.targetEndDate,
            latestSyncStartedAt: new Date().toISOString(),
            latestSyncStatus: "running",
            latestSyncWindowStart: ordersChunk.startDate,
            latestSyncWindowEnd: ordersChunk.endDate,
            lastError: null,
          });
        }
        if (returnsChunk) {
          await upsertShopifySyncState({
            businessId,
            providerAccountId: credentials.shopId,
            syncTarget: "commerce_returns_historical",
            historicalTargetStart: historical.targetStartDate,
            historicalTargetEnd: historical.targetEndDate,
            latestSyncStartedAt: new Date().toISOString(),
            latestSyncStatus: "running",
            latestSyncWindowStart: returnsChunk.startDate,
            latestSyncWindowEnd: returnsChunk.endDate,
            lastError: null,
          });
        }

        const [historicalOrdersResult, historicalReturnsResult] = await Promise.all([
          ordersChunk
            ? syncShopifyOrdersWindow({
                businessId,
                startDate: ordersChunk.startDate,
                endDate: ordersChunk.endDate,
                queryField: "created_at",
              })
            : Promise.resolve({
                success: true as const,
                reason: "skipped" as const,
                orders: 0,
                orderLines: 0,
                refunds: 0,
                transactions: 0,
                pages: 0,
                maxUpdatedAt: null,
              }),
          returnsChunk
            ? syncShopifyReturnsWindow({
                businessId,
                startDate: returnsChunk.startDate,
                endDate: returnsChunk.endDate,
              })
            : Promise.resolve({
                success: true as const,
                reason: "missing_read_returns_scope" as const,
                returns: 0,
                pages: 0,
                maxUpdatedAt: null,
              }),
        ]);

        if (historicalOrdersResult.success && historicalReturnsResult.success) {
          if (ordersChunk) {
            await upsertShopifySyncState({
              businessId,
              providerAccountId: credentials.shopId,
              syncTarget: "commerce_orders_historical",
              historicalTargetStart: historical.targetStartDate,
              historicalTargetEnd: historical.targetEndDate,
              readyThroughDate: ordersChunk.endDate,
              cursorTimestamp:
                historicalOrdersResult.maxUpdatedAt ?? `${ordersChunk.endDate}T23:59:59.000Z`,
              cursorValue: ordersChunk.endDate,
              latestSuccessfulSyncAt: new Date().toISOString(),
              latestSyncStatus:
                ordersChunk.endDate >= historical.targetEndDate ? "ready" : "succeeded",
              latestSyncWindowStart: ordersChunk.startDate,
              latestSyncWindowEnd: ordersChunk.endDate,
              lastError: null,
              lastResultSummary: {
                orderRows: historicalOrdersResult.orders,
                refundRows: historicalOrdersResult.refunds,
                transactionRows: historicalOrdersResult.transactions,
                pages: historicalOrdersResult.pages,
              },
            });
            historicalOrdersCursorValue = ordersChunk.endDate;
          }
          if (returnsChunk) {
            await upsertShopifySyncState({
              businessId,
              providerAccountId: credentials.shopId,
              syncTarget: "commerce_returns_historical",
              historicalTargetStart: historical.targetStartDate,
              historicalTargetEnd: historical.targetEndDate,
              readyThroughDate: returnsChunk.endDate,
              cursorTimestamp: historicalReturnsResult.maxUpdatedAt ?? `${returnsChunk.endDate}T23:59:59.000Z`,
              cursorValue: returnsChunk.endDate,
              latestSuccessfulSyncAt: new Date().toISOString(),
              latestSyncStatus:
                returnsChunk.endDate >= historical.targetEndDate ? "ready" : "succeeded",
              latestSyncWindowStart: returnsChunk.startDate,
              latestSyncWindowEnd: returnsChunk.endDate,
              lastError: null,
              lastResultSummary: {
                returnRows: historicalReturnsResult.returns,
                pages: historicalReturnsResult.pages,
              },
            });
            historicalReturnsCursorValue = returnsChunk.endDate;
          }

          const chunkStartDate = (ordersChunk ?? returnsChunk)!.startDate;
          const chunkEndDate = (ordersChunk ?? returnsChunk)!.endDate;
          historicalResult = historicalResult
            ? {
                orders: historicalResult.orders + historicalOrdersResult.orders,
                orderLines: historicalResult.orderLines + historicalOrdersResult.orderLines,
                refunds: historicalResult.refunds + historicalOrdersResult.refunds,
                transactions:
                  historicalResult.transactions + historicalOrdersResult.transactions,
                returns: historicalResult.returns + historicalReturnsResult.returns,
                pages: historicalResult.pages + historicalOrdersResult.pages,
                returnPages:
                  historicalResult.returnPages + historicalReturnsResult.pages,
                chunks: historicalResult.chunks + 1,
                chunkStartDate: historicalResult.chunkStartDate,
                chunkEndDate,
              }
            : {
                orders: historicalOrdersResult.orders,
                orderLines: historicalOrdersResult.orderLines,
                refunds: historicalOrdersResult.refunds,
                transactions: historicalOrdersResult.transactions,
                returns: historicalReturnsResult.returns,
                pages: historicalOrdersResult.pages,
                returnPages: historicalReturnsResult.pages,
                chunks: 1,
                chunkStartDate,
                chunkEndDate,
              };
        } else {
          if (ordersChunk && !historicalOrdersResult.success) {
            await upsertShopifySyncState({
              businessId,
              providerAccountId: credentials.shopId,
              syncTarget: "commerce_orders_historical",
              historicalTargetStart: historical.targetStartDate,
              historicalTargetEnd: historical.targetEndDate,
              latestSyncStatus: historicalOrdersResult.reason,
              latestSyncWindowStart: ordersChunk.startDate,
              latestSyncWindowEnd: ordersChunk.endDate,
              lastError: historicalOrdersResult.reason,
            });
          }
          if (returnsChunk && !historicalReturnsResult.success) {
            await upsertShopifySyncState({
              businessId,
              providerAccountId: credentials.shopId,
              syncTarget: "commerce_returns_historical",
              historicalTargetStart: historical.targetStartDate,
              historicalTargetEnd: historical.targetEndDate,
              latestSyncStatus: historicalReturnsResult.reason,
              latestSyncWindowStart: returnsChunk.startDate,
              latestSyncWindowEnd: returnsChunk.endDate,
              lastError: historicalReturnsResult.reason,
            });
          }
          break;
        }
      }
    }

    if (runOrdersRecent) {
      logValidationPhase("recent_orders_cursor_or_state_persist_started", {
        startDate: window.startDate,
        endDate: window.endDate,
        maxUpdatedAt: ordersResult.maxUpdatedAt ?? null,
      });
      logValidationPhase("recent_orders_cursor_persist_started", {
        startDate: window.startDate,
        endDate: window.endDate,
        cursorTimestamp: ordersResult.maxUpdatedAt ?? `${window.endDate}T23:59:59.000Z`,
        cursorValue: ordersResult.maxUpdatedAt ?? window.endDate,
      });
      logValidationPhase("recent_orders_state_persist_started", {
        startDate: window.startDate,
        endDate: window.endDate,
        syncTarget: "commerce_orders_recent",
        latestSyncStatus: "succeeded",
      });
      await upsertShopifySyncState({
        businessId,
        providerAccountId: credentials.shopId,
        syncTarget: "commerce_orders_recent",
        historicalTargetStart: existingOrdersState?.historicalTargetStart ?? window.startDate,
        historicalTargetEnd: existingOrdersState?.historicalTargetEnd ?? window.endDate,
        readyThroughDate: window.endDate,
        cursorTimestamp: ordersResult.maxUpdatedAt ?? `${window.endDate}T23:59:59.000Z`,
        cursorValue: ordersResult.maxUpdatedAt ?? window.endDate,
        latestSyncStartedAt: new Date().toISOString(),
        latestSuccessfulSyncAt: new Date().toISOString(),
        latestSyncStatus: "succeeded",
        latestSyncWindowStart: window.startDate,
        latestSyncWindowEnd: window.endDate,
        lastError: null,
        lastResultSummary: result.reconciliation,
      });
      logValidationPhase("recent_orders_cursor_or_state_persist_succeeded", {
        startDate: window.startDate,
        endDate: window.endDate,
        maxUpdatedAt: ordersResult.maxUpdatedAt ?? null,
      });
      logValidationPhase("recent_orders_cursor_persist_succeeded", {
        startDate: window.startDate,
        endDate: window.endDate,
        cursorTimestamp: ordersResult.maxUpdatedAt ?? `${window.endDate}T23:59:59.000Z`,
        cursorValue: ordersResult.maxUpdatedAt ?? window.endDate,
      });
      logValidationPhase("recent_orders_state_persist_succeeded", {
        startDate: window.startDate,
        endDate: window.endDate,
        syncTarget: "commerce_orders_recent",
        latestSyncStatus: "succeeded",
      });
      logValidationPhase("recent_orders_phase_completed", {
        startDate: window.startDate,
        endDate: window.endDate,
        orders: result.orders,
        orderLines: result.orderLines,
        refunds: result.refunds,
        transactions: result.transactions,
      });
    }
    if (runReturnsRecent) {
      await upsertShopifySyncState({
        businessId,
        providerAccountId: credentials.shopId,
        syncTarget: "commerce_returns_recent",
        historicalTargetStart: existingReturnsState?.historicalTargetStart ?? window.startDate,
        historicalTargetEnd: existingReturnsState?.historicalTargetEnd ?? window.endDate,
        readyThroughDate: window.endDate,
        cursorTimestamp:
          returnsResult.success
            ? returnsResult.maxUpdatedAt ?? `${window.endDate}T23:59:59.000Z`
            : existingReturnsState?.cursorTimestamp ?? null,
        cursorValue:
          returnsResult.success
            ? returnsResult.maxUpdatedAt ?? window.endDate
            : existingReturnsState?.cursorValue ?? null,
        latestSyncStartedAt: new Date().toISOString(),
        latestSuccessfulSyncAt:
          returnsResult.success ? new Date().toISOString() : existingReturnsState?.latestSuccessfulSyncAt ?? null,
        latestSyncStatus: returnsResult.success ? "succeeded" : "failed",
        latestSyncWindowStart: window.startDate,
        latestSyncWindowEnd: window.endDate,
        lastError: returnsResult.success ? null : returnsResult.reason,
        lastResultSummary: result.reconciliation,
      });
    }

    let materialization:
      | null
      | {
          preferredSource: string;
          trustState: string;
          fallbackReason: string | null;
          pendingRepair: boolean;
          canServeWarehouse: boolean;
          recordedAt: string;
          skipped?: boolean;
          reason?: string;
        } = null;
    logValidationPhase("transition_to_post_recent_path_started", {
      startDate: window.startDate,
      endDate: window.endDate,
      shouldMaterializeOverviewState,
    });
    if (shouldMaterializeOverviewState) {
      try {
        logValidationPhase("post_recent_overview_snapshot_started", {
          startDate: window.startDate,
          endDate: window.endDate,
        });
        logValidationPhase("overview_snapshot_warm_started", {
          startDate: window.startDate,
          endDate: window.endDate,
        });
        await warmShopifyOverviewReportCache({
          businessId,
          startDate: window.startDate,
          endDate: window.endDate,
          forceRefresh: true,
        });
        logValidationPhase("overview_snapshot_warm_succeeded", {
          startDate: window.startDate,
          endDate: window.endDate,
        });
        logValidationPhase("post_recent_overview_snapshot_succeeded", {
          startDate: window.startDate,
          endDate: window.endDate,
        });
        logValidationPhase("overview_materialization_started", {
          startDate: window.startDate,
          endDate: window.endDate,
        });
        materialization = await materializeShopifyOverviewAfterSync({
          businessId,
          providerAccountId: credentials.shopId,
          startDate: window.startDate,
          endDate: window.endDate,
          runtimeValidationLog: (phase, summary) => {
            logValidationPhase(phase, summary);
          },
        });
        logValidationPhase("overview_materialization_succeeded", {
          startDate: window.startDate,
          endDate: window.endDate,
          preferredSource: materialization.preferredSource,
          trustState: materialization.trustState,
          pendingRepair: materialization.pendingRepair,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[shopify-sync] overview_snapshot_or_materialization_failed", {
          businessId,
          providerAccountId: credentials.shopId,
          startDate: window.startDate,
          endDate: window.endDate,
          message,
        });
        materialization = {
          preferredSource: "none",
          trustState: "no_data",
          fallbackReason: "overview_snapshot_or_materialization_failed",
          pendingRepair: false,
          canServeWarehouse: false,
          recordedAt: new Date().toISOString(),
          reason: message,
        };
      }
    } else {
      materialization = {
        preferredSource: "none",
        trustState: "no_data",
        fallbackReason: null,
        pendingRepair: false,
        canServeWarehouse: false,
        recordedAt: new Date().toISOString(),
        skipped: true,
        reason: "disabled_for_call_site",
      };
    }

    return {
      ...result,
      historical: historicalResult,
      materialization,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runOrdersRecent) {
      await upsertShopifySyncState({
        businessId,
        providerAccountId: credentials.shopId,
        syncTarget: "commerce_orders_recent",
        latestSyncStatus: "failed",
        latestSyncWindowStart: window.startDate,
        latestSyncWindowEnd: window.endDate,
        lastError: message,
      });
    }
    if (runReturnsRecent) {
      await upsertShopifySyncState({
        businessId,
        providerAccountId: credentials.shopId,
        syncTarget: "commerce_returns_recent",
        latestSyncStatus: "failed",
        latestSyncWindowStart: window.startDate,
        latestSyncWindowEnd: window.endDate,
        lastError: message,
      });
    }
    throw error;
  }
}

export async function ensureShopifyProviderReady(input: {
  businessId: string;
  recentWindowDays?: number;
  preferredVisibleWindowDays?: number;
  runHistoricalBootstrap?: boolean;
  triggerReason?: string;
}) {
  // Readiness bootstraps a provider and writes progress metadata, so it is a
  // work unit in its own right rather than a read.
  assertSyncLaneEnabled("shopify_sync");
  await assertSyncGrowthBoundary("shopify_provider_readiness", { fresh: true });
  const startedAt = new Date().toISOString();
  const recentWindowDays = Math.max(1, input.recentWindowDays ?? 30);
  const visibleWindowDays = Math.max(
    recentWindowDays,
    input.preferredVisibleWindowDays ?? recentWindowDays
  );
  const writeProgress = async (patch: Record<string, unknown>) =>
    mergeIntegrationMetadata({
      businessId: input.businessId,
      provider: "shopify",
      metadata: {
        shopifyProviderReadiness: {
          startedAt,
          updatedAt: new Date().toISOString(),
          ...patch,
        },
      },
    }).catch(() => {});

  await writeProgress({
    status: "running",
    visibleWindowDays,
    recentWindowDays,
    triggerReason: input.triggerReason ?? null,
    steps: [orchestrationStamp("start", "running")],
  });

  const credentials = await resolveShopifyAdminCredentials(input.businessId).catch(() => null);
  if (!credentials) {
    await writeProgress({
      status: "failed",
      steps: [orchestrationStamp("auth", "failed", { reason: "not_connected" })],
      lastError: "not_connected",
    });
    return { success: false as const, reason: "not_connected" };
  }

  // The grant this pass is running under, captured at the SAME point the
  // credential was resolved. Captured here and not next to the webhook calls:
  // an authority read taken immediately before its own re-read agrees with
  // itself by construction and proves nothing. The window that matters is this
  // one — from credential resolution, through every provider round trip and
  // warehouse write below, to the webhook mutation.
  const grantAuthorityAtStart = await getIntegration(input.businessId, "shopify")
    .then((row) => (row ? readShopifyGrantAuthority(row) : null))
    .catch(() => null);

  const steps: Array<Record<string, unknown>> = [];
  steps.push(
    orchestrationStamp("auth", "succeeded", {
      shopId: credentials.shopId,
      hasReadAllOrders: hasShopifyScope(credentials.scopes, "read_all_orders"),
      hasReadReturns: hasShopifyScope(credentials.scopes, "read_returns"),
    })
  );

  // The grant guard, threaded into the webhook calls themselves.
  //
  // Checking once here and then handing the token to a multi-call sequence was
  // still a race: `registerShopifySyncWebhooks` lists, then issues one create
  // per missing topic, and a reconnect landing between call 1 and call 2 sent
  // every remaining create under a credential the user had already replaced.
  // The guard is now a REQUIRED input that runs immediately before each request,
  // so a drift mid-sequence stops the rest instead of finishing under a dead
  // grant.
  //
  // A refusal is not a hard failure of the whole readiness pass: the sync below
  // resolves its own credential and is safe to attempt. What must not happen is
  // a webhook MUTATION under a credential nothing verified.
  const assertGrantStillOurs = async () => {
    const still = grantAuthorityAtStart
      ? await assertShopifyGrantUnchanged({
          businessId: input.businessId,
          authority: grantAuthorityAtStart,
        })
      : ({
          ok: false,
          code: "shopify_authority_unknown",
          detail: "The Shopify connection could not be read before registering webhooks.",
        } as const);
    if (!still.ok) {
      throw new Error(`${still.code}: ${still.detail}`);
    }
  };

  const webhookVerification = await verifyShopifySyncWebhooks({
    shopId: credentials.shopId,
    accessToken: credentials.accessToken,
    assertStillAuthorized: assertGrantStillOurs,
  }).catch((error: unknown) => ({
    status: "failed" as const,
    error: error instanceof Error ? error.message : String(error),
  }));

  let webhookCoverage: ShopifySyncWebhookVerification | null = null;
  if (webhookVerification.status === "failed") {
    steps.push(
      orchestrationStamp("webhooks_verify", "failed", { error: webhookVerification.error }),
    );
  } else if (webhookVerification.status === "stopped") {
    // Named as a stop, not as a provider error: nothing went wrong at Shopify.
    steps.push(
      orchestrationStamp("webhooks_verify", "failed", {
        error: "shopify_grant_changed",
        stoppedBefore: webhookVerification.stoppedBefore,
        detail: webhookVerification.reason,
      }),
    );
  } else {
    webhookCoverage = webhookVerification;
    const registration = await registerShopifySyncWebhooks({
      shopId: credentials.shopId,
      accessToken: credentials.accessToken,
      assertStillAuthorized: assertGrantStillOurs,
    }).catch((error: unknown) => ({
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (registration.status === "failed") {
      steps.push(
        orchestrationStamp("webhooks_register", "failed", { error: registration.error }),
      );
    } else if (registration.status === "stopped") {
      // Partial work is recorded as partial: exactly what was created before the
      // grant moved, and exactly what was never attempted.
      steps.push(
        orchestrationStamp("webhooks_register", "failed", {
          error: "shopify_grant_changed",
          stoppedBefore: registration.stoppedBefore,
          detail: registration.reason,
          created: registration.created,
          notCreated: registration.notCreated,
        }),
      );
    } else {
      webhookCoverage = registration;
      steps.push(
        orchestrationStamp("webhooks_register", "succeeded", {
          ...registration,
        } as unknown as Record<string, unknown>),
      );
    }
  }

  const recentSync = await syncShopifyCommerceReports(input.businessId, {
    recentWindowDays,
    allowHistorical: input.runHistoricalBootstrap ?? true,
    triggerReason: input.triggerReason ?? "manual:ensure_provider_ready",
    recentTargets: { orders: true, returns: true },
  });
  steps.push(
    orchestrationStamp(
      "recent_bootstrap",
      recentSync.success ? "succeeded" : "failed",
      recentSync as unknown as Record<string, unknown>
    )
  );

  const today = getTodayIsoForTimeZoneServer(
    typeof credentials.metadata?.iana_timezone === "string"
      ? credentials.metadata.iana_timezone
      : "UTC"
  );
  const startDate = toIsoDate(addDays(new Date(`${today}T00:00:00Z`), -(visibleWindowDays - 1)));
  const servingCandidate = await getShopifyOverviewReadCandidate({
    businessId: input.businessId,
    startDate,
    endDate: today,
  }).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  steps.push(
    "error" in servingCandidate
      ? orchestrationStamp("serving_refresh", "failed", { error: servingCandidate.error })
      : orchestrationStamp("serving_refresh", "succeeded", {
          preferredSource: servingCandidate.preferredSource,
          trustState: servingCandidate.servingMetadata.trustState,
          fallbackReason: servingCandidate.servingMetadata.fallbackReason,
        })
  );

  const status = await getShopifyStatus({
    businessId: input.businessId,
    startDate,
    endDate: today,
  }).catch(() => null);

  await writeProgress({
    status: recentSync.success ? "succeeded" : "failed",
    visibleWindowDays,
    recentWindowDays,
    latestSummary: recentSync,
    servingWindow: { startDate, endDate: today },
    steps,
    healthState: status?.state ?? null,
    completedAt: new Date().toISOString(),
    historicalCoverageIncomplete:
      hasShopifyScope(credentials.scopes, "read_all_orders") &&
      status?.issues.some((issue) => issue.includes("Historical Shopify backfill")) === true,
  });

  return {
    success: recentSync.success,
    recentSync,
    status,
    servingWindow: { startDate, endDate: today },
    // Null when the sequence never produced a complete observation — a provider
    // failure, or a grant that moved mid-sequence. Reporting the plan from a
    // stopped run as coverage would describe subscriptions that do not exist.
    webhookCoverage: webhookCoverage
      ? {
          desiredTopics: webhookCoverage.desiredTopics,
          existingTopics: webhookCoverage.existingTopics,
          missingTopics: webhookCoverage.missingTopics,
          extraTopics: webhookCoverage.extraTopics,
        }
      : null,
  };
}
