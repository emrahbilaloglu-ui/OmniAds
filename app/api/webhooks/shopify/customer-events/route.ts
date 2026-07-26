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

export async function POST(request: NextRequest) {
  try {
    const providedSecret = request.headers.get("x-shopify-customer-events-secret")?.trim();
    const configuredSecret = process.env.SHOPIFY_CUSTOMER_EVENTS_SECRET?.trim();
    if (configuredSecret && providedSecret !== configuredSecret) {
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
    const capacity = await assertSyncGrowthBoundary("shopify_customer_events", {
      fresh: true,
    }).then(
      () => null,
      (error: unknown) => describeSyncSafetyRefusal(error),
    );
    if (capacity) {
      console.error("[shopify-customer-events] refused: capacity", {
        shopDomain,
        capacity,
      });
      return NextResponse.json(
        {
          received: false,
          error: capacity.kind,
          retryable: true,
          safetyRefusal: capacity,
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
