import { createHash, timingSafeEqual } from "node:crypto";
import { describeSyncSafetyRefusal } from "@/lib/sync/safety-refusal";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import { evaluateLaneAdmission } from "@/lib/sync/global-kill-switch";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { upsertShopifyCustomerEvents } from "@/lib/shopify/warehouse";

const SHOPIFY_CUSTOMER_EVENTS_REQUIRED_TABLES = [
  "provider_connections",
  "shopify_customer_events",
] as const;

function toStringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildEventRows(input: {
  businessId: string;
  providerAccountId: string;
  payload: Record<string, unknown>;
}) {
  const events = Array.isArray(input.payload.events)
    ? input.payload.events
    : [input.payload];

  return events
    .map((event) => {
      const row = event as Record<string, unknown>;
      const eventId =
        toStringOrNull(row.eventId) ??
        toStringOrNull(row.id) ??
        toStringOrNull(row.event_id);
      const eventType =
        toStringOrNull(row.eventType) ??
        toStringOrNull(row.type) ??
        toStringOrNull(row.event_name);
      const occurredAt =
        toStringOrNull(row.occurredAt) ??
        toStringOrNull(row.timestamp) ??
        new Date().toISOString();
      if (!eventId || !eventType) return null;
      return {
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        shopId: input.providerAccountId,
        eventId,
        eventType,
        occurredAt,
        customerId: toStringOrNull(row.customerId),
        sessionId: toStringOrNull(row.sessionId),
        pageType: toStringOrNull(row.pageType),
        pageUrl: toStringOrNull(row.pageUrl),
        consentState: toStringOrNull(row.consentState),
        payloadJson: row,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

/**
 * Constant-time secret comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * secret's length, so both sides are hashed to a fixed width first.
 */
function secretMatches(provided: string, configured: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(configured).digest();
  return timingSafeEqual(left, right);
}

export async function POST(request: NextRequest) {
  try {
    const providedSecret = request.headers.get("x-shopify-customer-events-secret")?.trim();
    const configuredSecret = process.env.SHOPIFY_CUSTOMER_EVENTS_SECRET?.trim();

    // Fail closed when unconfigured. This used to read
    // `if (configuredSecret && providedSecret !== configuredSecret)`, so an
    // unset SHOPIFY_CUSTOMER_EVENTS_SECRET did not weaken the check — it
    // removed it. The route is allow-listed as public in proxy.ts, so with no
    // secret set anyone on the internet could POST arbitrary rows into
    // shopify_customer_events for any shop domain they named. The variable
    // appears in no env template, so that was the deployed state.
    if (!configuredSecret) {
      return NextResponse.json(
        {
          error: "webhook_secret_not_configured",
          message:
            "SHOPIFY_CUSTOMER_EVENTS_SECRET is not configured, so this webhook cannot authenticate callers.",
        },
        { status: 503 },
      );
    }
    if (!providedSecret || !secretMatches(providedSecret, configuredSecret)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const shopDomain =
      request.headers.get("x-shopify-shop-domain")?.trim() ||
      request.nextUrl.searchParams.get("shop")?.trim() ||
      "";
    if (!shopDomain) {
      return NextResponse.json({ error: "shop_domain_required" }, { status: 400 });
    }

    const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload) {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }

    const readiness = await getDbSchemaReadiness({
      tables: [...SHOPIFY_CUSTOMER_EVENTS_REQUIRED_TABLES],
    }).catch(() => null);
    if (!readiness?.ready) {
      console.error("[shopify-customer-events] schema_not_ready", {
        shopDomain,
        missingTables: readiness?.missingTables ?? [],
        checkedAt: readiness?.checkedAt ?? null,
      });
      return NextResponse.json(
        {
          error: "schema_not_ready",
          received: false,
          missingTables: readiness?.missingTables ?? [],
          checkedAt: readiness?.checkedAt ?? null,
        },
        { status: 503 },
      );
    }
    // Admission after authentication and schema readiness, before the
    // customer-event write below. Retryable non-success so Shopify redelivers;
    // a 202 here would acknowledge an event that was never stored.
    const shopifyAdmission = evaluateLaneAdmission({ lane: "shopify_sync" });
    if (!shopifyAdmission.enabled) {
      console.warn("[shopify-customer-events] refused: lane disabled", {
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
    // ANY failure of the guard refuses. Previously only a RECOGNISED refusal
    // did: `describeSyncSafetyRefusal` returns null for an unclassified error,
    // so a timeout, a connection reset, or a bug inside the fence produced
    // `capacity = null` and the handler carried on and persisted. A guard that
    // permits on its own failure is not a guard.
    const capacity = await assertSyncGrowthBoundary("shopify_customer_events", {
      fresh: true,
    }).then(
      () => null,
      (error: unknown) => ({
        refusal: describeSyncSafetyRefusal(error),
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    if (capacity) {
      console.error("[shopify-customer-events] refused: capacity", {
        shopDomain,
        capacity,
      });
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
    const integrationRows = (await sql`
      SELECT business_id, provider_account_id
      FROM provider_connections
      WHERE provider = 'shopify'
        AND status = 'connected'
        AND provider_account_id = ${shopDomain}
      LIMIT 1
    `) as Array<{ business_id: string; provider_account_id: string }>;
    const match = integrationRows[0] ?? null;
    if (!match) {
      return NextResponse.json({ received: true, ignored: true }, { status: 202 });
    }

    const rows = buildEventRows({
      businessId: match.business_id,
      providerAccountId: match.provider_account_id,
      payload,
    });
    const written = await upsertShopifyCustomerEvents(rows);

    return NextResponse.json({ received: true, written }, { status: 202 });
  } catch (err) {
    console.error("[shopify-customer-events] ingest failed", err);
    return NextResponse.json(
      { error: "internal_error", message: String(err) },
      { status: 500 }
    );
  }
}
