import { NextRequest, NextResponse } from "next/server";

import { requireAuthedRequest, requireBusinessAccess } from "@/lib/access";
import {
  PRODUCT_INSTRUMENTATION_EVENT_NAMES,
  PRODUCT_INSTRUMENTATION_FAILURE_CODES,
  PRODUCT_INSTRUMENTATION_OUTCOMES,
  PRODUCT_INSTRUMENTATION_SURFACES,
  recordProductInstrumentationEvent,
  type ProductInstrumentationEvent,
} from "@/lib/product-instrumentation";

export const dynamic = "force-dynamic";

/**
 * Bounded, authenticated ingest for interactions that only exist in the client.
 *
 * Opening a client row, following a search result, applying a saved view,
 * printing a report — none of these touch a server route on their own, so
 * without an endpoint they simply cannot be measured. This is that endpoint,
 * and it is deliberately the narrowest thing that can work:
 *
 * - every field is drawn from a server-side allowlist, so the client cannot
 *   introduce a name, surface, outcome or failure code the contract does not
 *   already know. There is no free-text field to smuggle a query, an ad
 *   headline, a token or a person into;
 * - a business-scoped event requires membership of that business, checked
 *   server-side. A caller cannot attribute activity to a tenant they cannot
 *   see;
 * - counters are clamped, so a client cannot write an arbitrary number;
 * - the response carries no data back. This is a sink, not a read.
 */
const MAX_COUNTER = 100_000;

function clampCounter(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  if (rounded < 0) return null;
  return Math.min(rounded, MAX_COUNTER);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuthedRequest(request);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  const eventName = body?.eventName;
  const surface = body?.surface;
  const outcome = body?.outcome;
  const scope = body?.scope;
  const businessId =
    typeof body?.businessId === "string" ? body.businessId.trim() : null;

  // Allowlist every string before anything else happens. An unknown value is a
  // contract violation, not something to store and puzzle over later.
  if (
    !PRODUCT_INSTRUMENTATION_EVENT_NAMES.includes(
      eventName as (typeof PRODUCT_INSTRUMENTATION_EVENT_NAMES)[number],
    ) ||
    !PRODUCT_INSTRUMENTATION_SURFACES.includes(
      surface as (typeof PRODUCT_INSTRUMENTATION_SURFACES)[number],
    ) ||
    !PRODUCT_INSTRUMENTATION_OUTCOMES.includes(
      outcome as (typeof PRODUCT_INSTRUMENTATION_OUTCOMES)[number],
    ) ||
    (scope !== "business" && scope !== "portfolio")
  ) {
    return NextResponse.json(
      { error: "unknown_event_field" },
      { status: 400 },
    );
  }

  const failureCode = body?.failureCode;
  if (
    failureCode != null &&
    !PRODUCT_INSTRUMENTATION_FAILURE_CODES.includes(
      failureCode as (typeof PRODUCT_INSTRUMENTATION_FAILURE_CODES)[number],
    )
  ) {
    return NextResponse.json({ error: "unknown_failure_code" }, { status: 400 });
  }

  const provider = body?.provider;
  if (provider != null && provider !== "meta" && provider !== "google") {
    return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
  }

  // Tenancy is checked server-side, never trusted from the payload: a caller
  // must actually belong to the business they are attributing activity to.
  if (scope === "business") {
    const access = await requireBusinessAccess({
      request,
      businessId,
      minRole: "guest",
    });
    if ("error" in access) return access.error;
  } else if (businessId) {
    return NextResponse.json(
      { error: "portfolio_scope_forbids_business" },
      { status: 400 },
    );
  }

  const event: ProductInstrumentationEvent = {
    businessId: scope === "business" ? businessId : null,
    scope,
    eventName: eventName as ProductInstrumentationEvent["eventName"],
    surface: surface as ProductInstrumentationEvent["surface"],
    outcome: outcome as ProductInstrumentationEvent["outcome"],
    provider: (provider ?? null) as ProductInstrumentationEvent["provider"],
    itemCount: clampCounter(body?.itemCount),
    durationMs: clampCounter(body?.durationMs),
    failureCode:
      (failureCode ?? null) as ProductInstrumentationEvent["failureCode"],
    // Server-stamped. A client clock can be wrong, skewed, or chosen.
    occurredAt: new Date().toISOString(),
  };

  const result = await recordProductInstrumentationEvent(event);
  return NextResponse.json(result, { status: result.recorded ? 202 : 200 });
}
