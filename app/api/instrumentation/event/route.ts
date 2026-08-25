import { NextRequest, NextResponse } from "next/server";
import { ANONYMOUS_TELEMETRY_POLICY, consumeToken } from "@/lib/auth-throttle";
import { getTrustedClientIp } from "@/lib/request-client-ip";

import { requireAuthedRequest, requireBusinessAccess } from "@/lib/access";
import { getSessionFromRequest } from "@/lib/auth";
import { recordZeroBaseScreenView } from "@/lib/zero-base/instrumentation-sink";
import {
  validateInstrumentationEvent,
  widthBucketFor,
} from "@/lib/zero-base/instrumentation-contract";
import type { ActorRole } from "@/lib/zero-base/instrumentation-schema";
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
  const rawBody = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  // The v2 branch is selected by an explicit discriminator, so every existing
  // v1 caller keeps its exact behaviour — including requiring a session before
  // the body is even read.
  if (rawBody?.contract === "zero-base.v2") {
    return handleZeroBaseEvent(request, rawBody);
  }

  const auth = await requireAuthedRequest(request);
  if ("error" in auth) return auth.error;

  const body = rawBody;

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

/**
 * Zero-base v2 ingest.
 *
 * Differs from v1 in three ways that matter: the 15 pre-auth public surfaces
 * may be emitted without a session, `actor_role` and `width_bucket` are
 * derived here rather than taken from the client, and a repeated `eventId` is
 * accepted as a no-op so an offline retry cannot double-count.
 *
 * Failure never propagates. A telemetry sink that can break navigation is
 * worse than no telemetry, so every path returns 202-or-better and the caller
 * is told nothing it could use to probe the system.
 */
async function handleZeroBaseEvent(
  request: NextRequest,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);

  /*
   * A caller with no session is rate limited before anything touches the
   * database.
   *
   * This is the only write path an unauthenticated visitor can reach, and it
   * became reachable when the public share leaves were corrected to
   * `anonymous: true`. Without a bound, a stranger with a share URL controls
   * how often we INSERT — and telemetry is not worth a write amplifier.
   *
   * Ordered first, above the session-scoped work, so a refused caller costs a
   * bucket lookup and nothing else. An authenticated caller is untouched: they
   * are already bounded by having an account.
   */
  if (!session) {
    const clientIp = getTrustedClientIp(request);
    const gate = consumeToken(
      clientIp ? `instrumentation:ip:${clientIp}` : "instrumentation:ip:unknown",
      ANONYMOUS_TELEMETRY_POLICY,
      Date.now(),
    );
    if (!gate.allowed) {
      // 429 with nothing else. The caller learns it was too fast and nothing
      // about whether the surface, the event or the link was real.
      return NextResponse.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
      );
    }
  }

  // Server-derived. A client that could name its own role could relabel its
  // own telemetry, so nothing here is read from the body.
  let actorRole: ActorRole = session ? "authenticated" : "anonymous";
  const businessId = typeof body.businessId === "string" ? body.businessId : null;
  if (session && businessId) {
    const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
    if ("error" in access) return access.error;
    actorRole = access.membership.role;
  }

  const widthRaw = typeof body.width === "number" ? body.width : 1280;
  const result = validateInstrumentationEvent(
    {
      surface: String(body.surface ?? ""),
      event: String(body.event ?? ""),
      eventId: typeof body.eventId === "string" ? body.eventId : null,
      properties:
        body.properties && typeof body.properties === "object"
          ? (body.properties as Record<string, unknown>)
          : null,
      businessId,
      accountId: typeof body.accountId === "string" ? body.accountId : null,
    },
    {
      authenticated: Boolean(session),
      actorRole,
      widthBucket: widthBucketFor(widthRaw),
    },
  );

  if (!result.ok) {
    return NextResponse.json(
      { error: result.rejection.code, message: result.rejection.message },
      { status: result.rejection.status },
    );
  }

  await recordZeroBaseScreenView(result.event);
  return NextResponse.json({ status: "accepted" }, { status: 202 });
}
