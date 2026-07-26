import { NextRequest, NextResponse } from "next/server";
import {
  readShopifyGrantAuthority,
  assertShopifyGrantUnchanged,
} from "@/lib/shopify/install-context";

import { requireAdmin } from "@/lib/admin-auth";
import { getIntegration, mergeIntegrationMetadata } from "@/lib/integrations";
import {
  SHOPIFY_ADMIN_API_VERSION,
  hasShopifyScope,
  validateShopifyAdminCredentials,
} from "@/lib/shopify/admin";
import {
  buildShopifyOverviewCanaryKey,
  buildShopifyOverviewOverrideKey,
  SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
} from "@/lib/shopify/serving";
import {
  getShopifyStatus,
  isShopifyDefaultCutoverEvidenceReady,
} from "@/lib/shopify/status";
import {
  getShopifyServingOverride,
  getShopifyServingState,
  listShopifyRepairIntents,
  listShopifyWebhookDeliveries,
  listShopifyReconciliationRuns,
  listShopifyServingStateHistory,
  upsertShopifyServingOverride,
} from "@/lib/shopify/warehouse";
import { getShopifyRevenueLedgerAggregate } from "@/lib/shopify/revenue-ledger";
import { compareShopifyWarehouseAndLedger } from "@/lib/shopify/divergence";
import { getShopifyCustomerEventsAggregate } from "@/lib/shopify/customer-events-analytics";
import { getShopifyWarehouseOverviewAggregate } from "@/lib/shopify/warehouse-overview";
import { ensureShopifyProviderReady, syncShopifyCommerceReports } from "@/lib/sync/shopify-sync";
import { registerShopifySyncWebhooks, verifyShopifySyncWebhooks } from "@/lib/shopify/webhooks";

function buildRolloutSummary(input: {
  status: Awaited<ReturnType<typeof getShopifyStatus>>;
  ledgerConsistency: ReturnType<typeof compareShopifyWarehouseAndLedger> | null;
  override: Awaited<ReturnType<typeof getShopifyServingOverride>> | null;
  serving: Awaited<ReturnType<typeof getShopifyServingState>> | null;
  history: Array<{ decisionReasons?: string[] | null }>;
  reconciliationHistory: Array<{
    recordedAt?: string | null;
    canServeWarehouse?: boolean;
    preferredSource?: string | null;
    divergence?: Record<string, unknown> | null;
  }>;
  webhookDeliveries: Array<{
    processingState: string;
    topic?: string | null;
    processedAt?: string | null;
    errorMessage?: string | null;
  }>;
}) {
  const blockers = [...input.status.issues];
  const hasRecentWebhookFailures = input.webhookDeliveries.some(
    (delivery) => delivery.processingState === "failed"
  );
  if (input.ledgerConsistency && input.ledgerConsistency.withinThreshold !== true) {
    blockers.push("Shopify ledger semantic consistency is above serving threshold.");
    for (const reason of input.ledgerConsistency.failureReasons ?? []) {
      blockers.push(`Ledger semantic blocker: ${reason}.`);
    }
  }
  if (hasRecentWebhookFailures) {
    blockers.push("Recent Shopify webhook deliveries include failed refresh attempts.");
  }
  if (input.override?.mode === "force_live") {
    blockers.push("Serving is currently forced to live by override.");
  }

  const defaultCutoverReady = isShopifyDefaultCutoverEvidenceReady(input.status.reconciliation);
  const previewCanaryReady =
    input.status.state === "ready" &&
    (input.ledgerConsistency === null || input.ledgerConsistency.withinThreshold === true);
  const broaderLocalServingReady =
    previewCanaryReady || input.override?.mode === "force_warehouse";
  const latestTrustedRecordedAt =
    input.reconciliationHistory.find((row) => {
      const divergenceWithin = row.divergence?.withinThreshold === true;
      const ledgerWithin =
        row.divergence?.ledgerConsistency == null ||
        (
          typeof row.divergence.ledgerConsistency === "object" &&
          (row.divergence.ledgerConsistency as Record<string, unknown>).withinThreshold === true
        );
      return row.canServeWarehouse === true && divergenceWithin && ledgerWithin;
    })?.recordedAt ?? null;
  const lastDecisionReasons =
    input.serving?.decisionReasons ??
    input.history[0]?.decisionReasons ??
    [];
  const recentWebhookFailures = input.webhookDeliveries
    .filter((delivery) => delivery.processingState === "failed")
    .slice(0, 3)
    .map((delivery) => ({
      topic:
        typeof delivery.topic === "string" ? delivery.topic : null,
      errorMessage: delivery.errorMessage ?? null,
      processedAt:
        typeof delivery.processedAt === "string" ? delivery.processedAt : null,
    }));

  return {
    broaderLocalServingReady,
    previewCanaryReady,
    defaultCutoverReady,
    recommendedSource:
      input.override?.mode === "force_live"
        ? "live"
        : input.override?.mode === "force_warehouse"
          ? "warehouse"
          : input.ledgerConsistency?.withinThreshold === true
            ? "ledger_candidate"
            : "live",
    blockers: [...new Set(blockers)],
    lastDecisionReasons,
    stableWarehouseRunCount: input.status.reconciliation?.stableWarehouseRunCount ?? 0,
    stableLedgerRunCount: input.status.reconciliation?.stableLedgerRunCount ?? 0,
    latestTrustedRecordedAt,
    hasRecentWebhookFailures,
    recentWebhookFailures,
    cutoverExplanation: {
      statusState: input.status.state,
      ledgerConsistencyWithinThreshold:
        input.ledgerConsistency?.withinThreshold ?? null,
      ledgerConsistencyScore: input.ledgerConsistency?.consistencyScore ?? null,
      reconciliationStable:
        input.status.reconciliation?.defaultCutoverEligible === true,
      overrideMode: input.override?.mode ?? "auto",
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const businessId = request.nextUrl.searchParams.get("businessId")?.trim();
    const startDate = request.nextUrl.searchParams.get("startDate")?.trim();
    const endDate = request.nextUrl.searchParams.get("endDate")?.trim();

    if (!businessId) {
      return NextResponse.json(
        { error: "businessId is required." },
        { status: 400 }
      );
    }

    const integration = await getIntegration(businessId, "shopify").catch(() => null);
    const authHealth =
      integration &&
      integration.status === "connected" &&
      integration.provider_account_id &&
      integration.access_token
        ? await validateShopifyAdminCredentials({
            shopId: integration.provider_account_id,
            accessToken: integration.access_token,
          })
        : { valid: false as const, error: integration ? "missing_token" : "not_connected" };
    const grantedScopes = (integration?.scopes ?? "")
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const missingScopes = ["read_orders", "read_all_orders", "read_returns"].filter(
      (scope) => !hasShopifyScope(integration?.scopes, scope)
    );
    const missingRequiredScopes = ["read_orders", "read_all_orders"].filter(
      (scope) => !hasShopifyScope(integration?.scopes, scope)
    );
    const missingOptionalScopes = ["read_returns"].filter(
      (scope) => !hasShopifyScope(integration?.scopes, scope)
    );

    const status = await getShopifyStatus({
      businessId,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    });

    const serving =
      status.shopId && startDate && endDate
        ? await getShopifyServingState({
            businessId,
            providerAccountId: status.shopId,
            canaryKey: buildShopifyOverviewCanaryKey({
              startDate,
              endDate,
              timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
            }),
          }).catch(() => null)
        : null;
    const override =
      status.shopId && startDate && endDate
        ? await getShopifyServingOverride({
            businessId,
            providerAccountId: status.shopId,
            overrideKey: buildShopifyOverviewOverrideKey({
              startDate,
              endDate,
              timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
            }),
          }).catch(() => null)
        : null;
    const history =
      status.shopId && startDate && endDate
        ? await listShopifyServingStateHistory({
            businessId,
            providerAccountId: status.shopId,
            canaryKey: buildShopifyOverviewCanaryKey({
              startDate,
              endDate,
              timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
            }),
            startDate,
            endDate,
            limit: 5,
          }).catch(() => [])
        : [];
    const reconciliationHistory =
      status.shopId && startDate && endDate
        ? await listShopifyReconciliationRuns({
            businessId,
            providerAccountId: status.shopId,
            reconciliationKey: buildShopifyOverviewCanaryKey({
              startDate,
              endDate,
              timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
            }),
            startDate,
            endDate,
            limit: 10,
          }).catch(() => [])
        : [];
    const [warehouseAggregate, ledgerAggregate, customerEventsAggregate, webhookDeliveries, repairIntents] =
      status.shopId && startDate && endDate
        ? await Promise.all([
            getShopifyWarehouseOverviewAggregate({
              businessId,
              providerAccountId: status.shopId,
              startDate,
              endDate,
            }).catch(() => null),
            getShopifyRevenueLedgerAggregate({
              businessId,
              providerAccountId: status.shopId,
              startDate,
              endDate,
            }).catch(() => null),
            getShopifyCustomerEventsAggregate({
              businessId,
              providerAccountId: status.shopId,
              startDate,
              endDate,
            }).catch(() => null),
            listShopifyWebhookDeliveries({
              businessId,
              providerAccountId: status.shopId,
              limit: 10,
            }).catch(() => []),
            listShopifyRepairIntents({
              businessId,
              providerAccountId: status.shopId,
              limit: 10,
            }).catch(() => []),
          ])
        : [null, null, null, [], []];
    const ledgerConsistency =
      warehouseAggregate && ledgerAggregate
        ? compareShopifyWarehouseAndLedger({
            warehouse: warehouseAggregate,
            ledger: ledgerAggregate,
          })
        : null;
    const rollout = buildRolloutSummary({
      status,
      ledgerConsistency,
      override,
      serving,
      history,
      reconciliationHistory,
      webhookDeliveries,
    });

    return NextResponse.json({
      businessId,
      startDate: startDate ?? null,
      endDate: endDate ?? null,
      canaryKey:
        startDate && endDate
          ? buildShopifyOverviewCanaryKey({
              startDate,
              endDate,
              timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
            })
          : null,
      status,
      auth: {
        shopDomain: integration?.provider_account_id ?? null,
        tokenPresent: Boolean(integration?.access_token),
        tokenValid: authHealth.valid,
        tokenValidationError: authHealth.error,
        grantedScopes,
        missingScopes,
        missingRequiredScopes,
        missingOptionalScopes,
        apiVersion: SHOPIFY_ADMIN_API_VERSION,
        productionMode:
          integration?.metadata?.shopifyProductionServingMode ?? "disabled",
        historicalCoverageBlockedByMissingReadAllOrders: missingRequiredScopes.includes("read_all_orders"),
        returnsRepairBlockedByMissingReadReturns: missingOptionalScopes.includes("read_returns"),
        orchestration: integration?.metadata?.shopifyProviderReadiness ?? null,
      },
      serving,
      override,
      history,
      reconciliationHistory,
      warehouseAggregate,
      ledgerAggregate,
      ledgerConsistency,
      customerEventsAggregate,
      webhookDeliveries,
      webhookCoverage:
        integration &&
        integration.provider_account_id &&
        integration.access_token
          ? await verifyShopifySyncWebhooks({
              shopId: integration.provider_account_id,
              accessToken: integration.access_token,
            }).catch(() => null)
          : null,
      repairIntents,
      rollout,
    });
  } catch (err) {
    console.error("[admin/integrations/health/shopify GET]", err);
    return NextResponse.json(
      { error: "internal_error", message: String(err) },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const body = await request.json().catch(() => ({}));
    const businessId = typeof body?.businessId === "string" ? body.businessId.trim() : "";
    const providerAccountId =
      typeof body?.providerAccountId === "string" ? body.providerAccountId.trim() : "";
    const startDate = typeof body?.startDate === "string" ? body.startDate.trim() : "";
    const endDate = typeof body?.endDate === "string" ? body.endDate.trim() : "";
    const mode = typeof body?.mode === "string" ? body.mode.trim() : "";
    const productionMode =
      typeof body?.productionMode === "string" ? body.productionMode.trim() : "";
    const action = typeof body?.action === "string" ? body.action.trim() : "";
    const reason = typeof body?.reason === "string" ? body.reason.trim() : null;

    if (!businessId) {
      return NextResponse.json({ error: "businessId is required." }, { status: 400 });
    }

    // The grant this request will act under, captured BEFORE the metadata and
    // override writes below.
    //
    // Captured here rather than next to the provider call, because an authority
    // read taken immediately before its own re-read agrees with itself by
    // construction and proves nothing. The window worth defending is the whole
    // request: an operator opens the panel, a reconnect lands, and the action
    // then registers webhooks under a credential nobody looked at — pointing a
    // different shop's order events at this business.
    const grantAuthorityAtStart = action
      ? await getIntegration(businessId, "shopify")
          .then((row) => (row ? readShopifyGrantAuthority(row) : null))
          .catch(() => null)
      : null;

    if (productionMode) {
      if (!["disabled", "auto", "force_live", "force_warehouse"].includes(productionMode)) {
        return NextResponse.json(
          { error: "productionMode must be one of disabled, auto, force_live, force_warehouse." },
          { status: 400 }
        );
      }
      await mergeIntegrationMetadata({
        businessId,
        provider: "shopify",
        metadata: {
          shopifyProductionServingMode: productionMode,
          shopifyProductionServingUpdatedAt: new Date().toISOString(),
          ...(reason ? { shopifyProductionServingReason: reason } : {}),
        },
      });
    }

    if (mode) {
      if (!providerAccountId || !startDate || !endDate) {
        return NextResponse.json(
          { error: "providerAccountId, startDate, endDate are required when updating override mode." },
          { status: 400 }
        );
      }
      if (!["auto", "force_live", "force_warehouse"].includes(mode)) {
        return NextResponse.json(
          { error: "mode must be one of auto, force_live, force_warehouse." },
          { status: 400 }
        );
      }

      await upsertShopifyServingOverride({
        businessId,
        providerAccountId,
        overrideKey: buildShopifyOverviewOverrideKey({
          startDate,
          endDate,
          timeZoneBasis: SHOPIFY_OVERVIEW_CANARY_TIMEZONE_BASIS,
        }),
        startDate,
        endDate,
        mode: mode as "auto" | "force_live" | "force_warehouse",
        reason,
        updatedBy: auth.session?.user?.id ?? null,
      });
    }

    let actionResult: unknown = null;
    if (action) {
      const integration = await getIntegration(businessId, "shopify").catch(() => null);
      if (
        !integration ||
        integration.status !== "connected" ||
        !integration.provider_account_id ||
        !integration.access_token
      ) {
        return NextResponse.json({ error: "shopify_not_connected" }, { status: 400 });
      }
      // The grant captured at the top of the request must still be the current
      // one. Not caught to a falsy value: "I could not tell" is retryable, and
      // treating it as "unchanged" would disable the check exactly when the
      // database is the thing misbehaving.
      const stillOurs = grantAuthorityAtStart
        ? await assertShopifyGrantUnchanged({
            businessId,
            authority: grantAuthorityAtStart,
          })
        : ({
            ok: false,
            code: "shopify_authority_unknown",
            detail:
              "The Shopify connection could not be read when this request started.",
          } as const);
      if (!stillOurs.ok) {
        return NextResponse.json(
          {
            error: stillOurs.code,
            message:
              "The Shopify connection changed while this action was starting. Nothing was sent to Shopify.",
            detail: stillOurs.detail,
          },
          // "I could not tell" is retryable; "it moved" is a conflict.
          { status: stillOurs.code === "shopify_authority_unknown" ? 503 : 409 },
        );
      }

      switch (action) {
        case "register_webhooks":
          actionResult = await registerShopifySyncWebhooks({
            shopId: integration.provider_account_id,
            accessToken: integration.access_token,
          });
          break;
        case "verify_webhooks":
          actionResult = await verifyShopifySyncWebhooks({
            shopId: integration.provider_account_id,
            accessToken: integration.access_token,
          });
          break;
        case "run_recent_sync":
          actionResult = await syncShopifyCommerceReports(businessId, {
            recentWindowDays: 30,
            allowHistorical: false,
            triggerReason: "admin:run_recent_sync",
          });
          break;
        case "run_recent_bootstrap":
          actionResult = await ensureShopifyProviderReady({
            businessId,
            recentWindowDays: 30,
            preferredVisibleWindowDays: 90,
            runHistoricalBootstrap: false,
            triggerReason: "admin:run_recent_bootstrap",
          });
          break;
        case "run_historical_bootstrap":
          actionResult = await ensureShopifyProviderReady({
            businessId,
            recentWindowDays: 30,
            preferredVisibleWindowDays: 90,
            runHistoricalBootstrap: true,
            triggerReason: "admin:run_historical_bootstrap",
          });
          break;
        case "rerun_reconciliation":
        case "reevaluate_serving":
        case "recompute_aggregates":
          if (!startDate || !endDate) {
            return NextResponse.json(
              { error: "startDate and endDate are required for this action." },
              { status: 400 }
            );
          }
          actionResult = await ensureShopifyProviderReady({
            businessId,
            recentWindowDays: Math.max(30, Math.ceil((new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000) + 1),
            preferredVisibleWindowDays: 90,
            runHistoricalBootstrap: action === "recompute_aggregates",
            triggerReason: `admin:${action}`,
          });
          break;
        default:
          return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
      }
    }

    return NextResponse.json({
      ok: true,
      productionMode: productionMode || null,
      mode: mode || null,
      action: action || null,
      actionResult,
    });
  } catch (err) {
    console.error("[admin/integrations/health/shopify PATCH]", err);
    return NextResponse.json(
      { error: "internal_error", message: String(err) },
      { status: 500 }
    );
  }
}
