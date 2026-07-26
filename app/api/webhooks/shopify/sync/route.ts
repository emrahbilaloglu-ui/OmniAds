import { describeSyncSafetyRefusal } from "@/lib/sync/safety-refusal";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import { evaluateLaneAdmission } from "@/lib/sync/global-kill-switch";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { syncShopifyCommerceReports } from "@/lib/sync/shopify-sync";
import {
  buildShopifyOverviewCanaryKey,
  SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
} from "@/lib/shopify/serving";
import {
  buildShopifyWebhookPayloadHash,
  resolveShopifySyncWebhookRepairPolicy,
} from "@/lib/shopify/webhooks";
import { persistShopifyOverviewServingState } from "@/lib/shopify/overview-materializer";
import {
  getShopifyWebhookDelivery,
  upsertShopifyRepairIntent,
  getShopifyServingState,
  upsertShopifyWebhookDelivery,
} from "@/lib/shopify/warehouse";
import { verifyShopifyWebhook } from "@/lib/shopify/webhook-verification";
import { logRuntimeDebug } from "@/lib/runtime-logging";

const SHOPIFY_SYNC_WEBHOOK_REQUIRED_TABLES = [
  "provider_connections",
  "shopify_webhook_deliveries",
  "shopify_repair_intents",
  "shopify_serving_state",
  "shopify_sync_state",
  "shopify_raw_snapshots",
  "shopify_orders",
  "shopify_order_lines",
  "shopify_refunds",
  "shopify_order_transactions",
  "shopify_returns",
  "shopify_sales_events",
] as const;

function shiftIsoDate(date: string, dayDelta: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + dayDelta);
  return value.toISOString().slice(0, 10);
}

async function markRecentShopifyRangesPendingRepair(input: {
  businessId: string;
  providerAccountId: string;
  anchorDate: string;
  topic: string | null;
  receivedAt: string;
}) {
  const existingProductionMode = (value: unknown) =>
    value === "disabled" ||
    value === "auto" ||
    value === "force_live" ||
    value === "force_warehouse"
      ? value
      : null;
  const existingCoverageStatus = (value: unknown) =>
    value === "recent_ready" ||
    value === "recent_only" ||
    value === "historical_incomplete" ||
    value === "unknown"
      ? value
      : "unknown";

  const ranges = [
    { startDate: input.anchorDate, endDate: input.anchorDate },
    { startDate: shiftIsoDate(input.anchorDate, -6), endDate: input.anchorDate },
    { startDate: shiftIsoDate(input.anchorDate, -29), endDate: input.anchorDate },
  ];

  await Promise.all(
    ranges.map(async ({ startDate, endDate }) => {
      const canaryKey = buildShopifyOverviewCanaryKey({
        startDate,
        endDate,
        timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
      });
      const existing = await getShopifyServingState({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        canaryKey,
      }).catch(() => null);
      await persistShopifyOverviewServingState({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        canaryKey,
        startDate,
        endDate,
        timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
        assessedAt: input.receivedAt,
        statusState: existing?.statusState ?? "partial",
        preferredSource: "live",
        productionMode: existingProductionMode(existing?.productionMode),
        trustState: "pending_repair",
        fallbackReason: "pending_repair",
        coverageStatus: existingCoverageStatus(existing?.coverageStatus),
        pendingRepair: true,
        pendingRepairStartedAt: existing?.pendingRepairStartedAt ?? input.receivedAt,
        pendingRepairLastTopic: input.topic,
        pendingRepairLastReceivedAt: input.receivedAt,
        consecutiveCleanValidations: 0,
        canServeWarehouse: false,
        canaryEnabled: existing?.canaryEnabled ?? true,
        decisionReasons: ["pending_repair"],
        divergence: existing?.divergence ?? null,
        ordersRecentSyncedAt: existing?.ordersRecentSyncedAt ?? null,
        ordersRecentCursorTimestamp: existing?.ordersRecentCursorTimestamp ?? null,
        ordersRecentCursorValue: existing?.ordersRecentCursorValue ?? null,
        returnsRecentSyncedAt: existing?.returnsRecentSyncedAt ?? null,
        returnsRecentCursorTimestamp: existing?.returnsRecentCursorTimestamp ?? null,
        returnsRecentCursorValue: existing?.returnsRecentCursorValue ?? null,
        ordersHistoricalSyncedAt: existing?.ordersHistoricalSyncedAt ?? null,
        ordersHistoricalReadyThroughDate: existing?.ordersHistoricalReadyThroughDate ?? null,
        ordersHistoricalTargetEnd: existing?.ordersHistoricalTargetEnd ?? null,
        returnsHistoricalSyncedAt: existing?.returnsHistoricalSyncedAt ?? null,
        returnsHistoricalReadyThroughDate: existing?.returnsHistoricalReadyThroughDate ?? null,
        returnsHistoricalTargetEnd: existing?.returnsHistoricalTargetEnd ?? null,
      }).catch(() => null);
    })
  );
}

function resolveRepairIntent(input: { topic: string | null; payload: unknown }) {
  const record = input.payload && typeof input.payload === "object"
    ? (input.payload as Record<string, unknown>)
    : null;
  const rawId =
    record?.admin_graphql_api_id ??
    record?.id ??
    record?.refund_id ??
    record?.return_id ??
    null;
  const entityId = rawId == null ? null : String(rawId);
  if (!entityId) return null;
  if (input.topic?.startsWith("REFUNDS_")) {
    return { entityType: "refund" as const, entityId };
  }
  if (input.topic?.startsWith("RETURNS_")) {
    return { entityType: "return" as const, entityId };
  }
  return { entityType: "order" as const, entityId };
}

/**
 * POST /api/webhooks/shopify/sync
 *
 * Generic Shopify commerce sync webhook endpoint.
 * The first cut only verifies, logs, and acknowledges webhook delivery.
 * Incremental replay/reconciliation can later consume these events explicitly.
 */
export async function POST(request: NextRequest) {
  const result = await verifyShopifyWebhook(request);
  if (!result.valid) return result.response;

  const topic = request.headers.get("x-shopify-topic");
  const shopDomain = request.headers.get("x-shopify-shop-domain");
  const webhookId = request.headers.get("x-shopify-webhook-id");
  const payload = JSON.parse(result.body);
  const payloadHash = buildShopifyWebhookPayloadHash({
    topic: topic ?? "unknown",
    shopDomain: shopDomain ?? "unknown",
    body: result.body,
  });
  const receivedAt = new Date();
  const topicMeta = resolveShopifySyncWebhookRepairPolicy({
    topic,
    payload,
    receivedAt,
  });
  const readiness = await getDbSchemaReadiness({
    tables: [...SHOPIFY_SYNC_WEBHOOK_REQUIRED_TABLES],
  }).catch(() => null);
  if (!readiness?.ready) {
    console.error("[shopify-webhook] schema_not_ready", {
      topic,
      shopDomain,
      missingTables: readiness?.missingTables ?? [],
      checkedAt: readiness?.checkedAt ?? null,
    });
    return NextResponse.json(
      {
        received: false,
        error: "schema_not_ready",
        missingTables: readiness?.missingTables ?? [],
        checkedAt: readiness?.checkedAt ?? null,
      },
      { status: 503 },
    );
  }
  const existingDelivery = await getShopifyWebhookDelivery({
    shopDomain: shopDomain ?? "unknown",
    topic: topic ?? "unknown",
    payloadHash,
  }).catch(() => null);
  const retryAttempted = existingDelivery?.processingState === "failed";

  if (existingDelivery?.processingState === "processed") {
    return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
  }
  if (existingDelivery?.processingState === "ignored") {
    return NextResponse.json({ received: true, ignored: true, duplicate: true }, { status: 200 });
  }

  // Admission AFTER authentication and validation — the request has already
  // been proven to be a genuine Shopify webhook by this point — and BEFORE the
  // first persistence. upsertShopifyWebhookDelivery below is a durable write,
  // so admitting later would mean a disabled lane still mutated state.
  //
  // Retryable non-success, not 200: Shopify redelivers on a 5xx, so a refusal
  // loses nothing. Answering 200 would acknowledge a webhook that was never
  // processed, and the event would never come back.
  const shopifyAdmission = evaluateLaneAdmission({ lane: "shopify_sync" });
  if (!shopifyAdmission.enabled) {
    console.warn("[shopify-webhook] refused: lane disabled", {
      topic,
      shopDomain,
      reason: shopifyAdmission.reason,
    });
    return NextResponse.json(
      {
        received: false,
        error: "lane_disabled",
        lane: shopifyAdmission.lane,
        reason: shopifyAdmission.reason,
        retryable: true,
      },
      { status: 503 },
    );
  }
  // ANY failure of the guard refuses. Previously only a RECOGNISED refusal did:
  // `describeSyncSafetyRefusal` returns null for an unclassified error, so a
  // timeout, a connection reset, or a bug inside the fence produced `capacity =
  // null` and the handler carried on and persisted. A guard that permits on its
  // own failure is not a guard.
  const capacity = await assertSyncGrowthBoundary("shopify_webhook_delivery", {
    fresh: true,
  }).then(
    () => null,
    (error: unknown) => ({
      refusal: describeSyncSafetyRefusal(error),
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  if (capacity) {
    console.error("[shopify-webhook] refused: capacity", { topic, shopDomain, capacity });
    return NextResponse.json(
      {
        received: false,
        error: capacity.refusal?.kind ?? "capacity_check_failed",
        retryable: true,
        safetyRefusal: capacity.refusal,
        detail: capacity.message,
      },
      { status: 503 },
    );
  }

  const sql = getDb();
  const integrationRows = shopDomain
    ? ((await sql`
        SELECT business_id, provider_account_id
        FROM provider_connections
        WHERE provider = 'shopify'
          AND status = 'connected'
          AND provider_account_id = ${shopDomain}
        LIMIT 1
      `) as Array<{ business_id: string; provider_account_id: string }>)
    : [];
  const match = integrationRows[0] ?? null;

  await upsertShopifyWebhookDelivery({
    businessId: match?.business_id ?? null,
    providerAccountId: match?.provider_account_id ?? null,
    topic: topic ?? "unknown",
    shopDomain: shopDomain ?? "unknown",
    webhookId,
    payloadHash,
    payloadJson: payload,
    receivedAt: receivedAt.toISOString(),
    processingState: match ? "received" : "ignored",
    resultSummary: match
      ? {
          matchedBusiness: match.business_id,
          supportedTopic: topicMeta.supported,
          entity: topicMeta.entity,
          action: topicMeta.action,
          eventTimestamp: topicMeta.eventTimestamp,
          eventAgeDays: topicMeta.eventAgeDays,
          windowExpanded: topicMeta.windowExpanded,
        }
      : {
          ignored: true,
          supportedTopic: topicMeta.supported,
          entity: topicMeta.entity,
          eventTimestamp: topicMeta.eventTimestamp,
          eventAgeDays: topicMeta.eventAgeDays,
          windowExpanded: topicMeta.windowExpanded,
        },
  }).catch(() => null);

  logRuntimeDebug("shopify-webhook", "sync_received", {
    topic,
    shopDomain,
    orderId: payload.id ?? payload.admin_graphql_api_id ?? null,
  });

  if (!match) {
    return NextResponse.json({ received: true, ignored: true }, { status: 200 });
  }
  if (topicMeta.shouldTriggerSync) {
    const repairIntent = resolveRepairIntent({ topic, payload });
    const anchorDate = (topicMeta.eventTimestamp ?? receivedAt.toISOString()).slice(0, 10);
    if (repairIntent) {
      await upsertShopifyRepairIntent({
        businessId: match.business_id,
        providerAccountId: match.provider_account_id,
        entityType: repairIntent.entityType,
        entityId: repairIntent.entityId,
        topic: topic ?? "unknown",
        payloadHash,
        eventTimestamp: topicMeta.eventTimestamp,
        eventAgeDays: topicMeta.eventAgeDays,
        escalationLevel: topicMeta.windowExpanded ? 1 : 0,
        status: "pending",
        attemptCount: 0,
      }).catch(() => null);
    }
    await markRecentShopifyRangesPendingRepair({
      businessId: match.business_id,
      providerAccountId: match.provider_account_id,
      anchorDate,
      topic,
      receivedAt: receivedAt.toISOString(),
    }).catch(() => null);
  }
  if (!topicMeta.shouldTriggerSync) {
    await upsertShopifyWebhookDelivery({
      businessId: match.business_id,
      providerAccountId: match.provider_account_id,
      topic: topic ?? "unknown",
      shopDomain: shopDomain ?? "unknown",
      webhookId,
      payloadHash,
      payloadJson: payload,
      processedAt: new Date().toISOString(),
      processingState: "ignored",
      resultSummary: {
        ignored: true,
        reason: "unsupported_topic",
        entity: topicMeta.entity,
        action: topicMeta.action,
        repairPolicy: {
          recentWindowDays: topicMeta.recentWindowDays,
          eventTimestamp: topicMeta.eventTimestamp,
          eventAgeDays: topicMeta.eventAgeDays,
          windowExpanded: topicMeta.windowExpanded,
          recentTargets: topicMeta.recentTargets,
          allowHistorical: topicMeta.allowHistorical,
        },
      },
    }).catch(() => null);
    return NextResponse.json({ received: true, ignored: true }, { status: 200 });
  }

  try {
    const syncResult = await syncShopifyCommerceReports(match.business_id, {
      recentWindowDays: topicMeta.recentWindowDays,
      triggerReason: topicMeta.triggerReason ?? undefined,
      recentTargets: topicMeta.recentTargets,
      allowHistorical: topicMeta.allowHistorical,
      materializeOverviewState: false,
    });
    await upsertShopifyWebhookDelivery({
      businessId: match.business_id,
      providerAccountId: match.provider_account_id,
      topic: topic ?? "unknown",
      shopDomain: shopDomain ?? "unknown",
      webhookId,
      payloadHash,
      payloadJson: payload,
      processedAt: new Date().toISOString(),
      processingState: "processed",
      resultSummary:
        syncResult && typeof syncResult === "object"
          ? {
              topic,
              entity: topicMeta.entity,
              action: topicMeta.action,
              triggerReason: topicMeta.triggerReason,
              repairPolicy: {
                recentWindowDays: topicMeta.recentWindowDays,
                eventTimestamp: topicMeta.eventTimestamp,
                eventAgeDays: topicMeta.eventAgeDays,
                windowExpanded: topicMeta.windowExpanded,
                recentTargets: topicMeta.recentTargets,
                allowHistorical: topicMeta.allowHistorical,
              },
              retryAttempted,
              ...(syncResult as Record<string, unknown>),
            }
          : { ok: true, topic, entity: topicMeta.entity, action: topicMeta.action },
    }).catch(() => null);
    const repairIntent = resolveRepairIntent({ topic, payload });
    if (repairIntent) {
      await upsertShopifyRepairIntent({
        businessId: match.business_id,
        providerAccountId: match.provider_account_id,
        entityType: repairIntent.entityType,
        entityId: repairIntent.entityId,
        topic: topic ?? "unknown",
        payloadHash,
        eventTimestamp: topicMeta.eventTimestamp,
        eventAgeDays: topicMeta.eventAgeDays,
        escalationLevel: topicMeta.windowExpanded ? 1 : 0,
        status: "processed",
        attemptCount: retryAttempted ? 2 : 1,
        lastSyncResult:
          syncResult && typeof syncResult === "object"
            ? (syncResult as Record<string, unknown>)
            : { ok: true },
      }).catch(() => null);
    }
  } catch (error) {
    await upsertShopifyWebhookDelivery({
      businessId: match.business_id,
      providerAccountId: match.provider_account_id,
      topic: topic ?? "unknown",
      shopDomain: shopDomain ?? "unknown",
      webhookId,
      payloadHash,
      payloadJson: payload,
      processedAt: new Date().toISOString(),
      processingState: "failed",
      resultSummary: {
        topic,
        entity: topicMeta.entity,
        action: topicMeta.action,
        retryable: true,
        retryAttempted,
        repairPolicy: {
          recentWindowDays: topicMeta.recentWindowDays,
          eventTimestamp: topicMeta.eventTimestamp,
          eventAgeDays: topicMeta.eventAgeDays,
          windowExpanded: topicMeta.windowExpanded,
          recentTargets: topicMeta.recentTargets,
          allowHistorical: topicMeta.allowHistorical,
        },
      },
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch(() => null);
    const repairIntent = resolveRepairIntent({ topic, payload });
    if (repairIntent) {
      await upsertShopifyRepairIntent({
        businessId: match.business_id,
        providerAccountId: match.provider_account_id,
        entityType: repairIntent.entityType,
        entityId: repairIntent.entityId,
        topic: topic ?? "unknown",
        payloadHash,
        eventTimestamp: topicMeta.eventTimestamp,
        eventAgeDays: topicMeta.eventAgeDays,
        escalationLevel: topicMeta.windowExpanded ? 2 : 1,
        status: "failed",
        attemptCount: retryAttempted ? 2 : 1,
        lastError: error instanceof Error ? error.message : String(error),
      }).catch(() => null);
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
