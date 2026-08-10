import { getDb } from "@/lib/db";
import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/access";
import {
  buildAgencyTodayReadModel,
  type AgencyTodayClientInput,
  type ClientDataHealth,
} from "@/lib/agency-today-read-model";
import { readAgencyTodayTotals, resolveClientFreshness } from "@/lib/agency-today-store";

export const dynamic = "force-dynamic";

function isIsoDate(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function shiftIsoDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Cross-client morning triage.
 *
 * Every client the signed-in user can see is answered from one grouped read,
 * and severity and ordering come from the shared read model rather than being
 * recomputed per surface.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json(
      { error: "auth_error", message: "Authentication required." },
      { status: 401 },
    );
  }

  const params = request.nextUrl.searchParams;
  const endDate = isIsoDate(params.get("endDate"))
    ? (params.get("endDate") as string)
    : shiftIsoDate(new Date().toISOString().slice(0, 10), -1);
  const startDate = isIsoDate(params.get("startDate"))
    ? (params.get("startDate") as string)
    : shiftIsoDate(endDate, -6);

  const businesses = (await listUserBusinesses(session.user.id)).filter(
    (business) => business.membershipStatus === "active",
  );

  if (businesses.length === 0) {
    return NextResponse.json({
      startDate,
      endDate,
      model: buildAgencyTodayReadModel([]),
    });
  }

  let totals: Awaited<ReturnType<typeof readAgencyTodayTotals>>;
  try {
    totals = await readAgencyTodayTotals({
      businessIds: businesses.map((business) => business.id),
      startDate,
      endDate,
    });
  } catch (error: unknown) {
    // A failed read is reported as a failure. Returning an empty model here
    // would render as "every client is quiet", which is the most dangerous
    // possible lie on a triage surface.
    return NextResponse.json(
      {
        error: "agency_today_unavailable",
        message:
          error instanceof Error ? error.message : "Could not read cross-client totals.",
      },
      { status: 503 },
    );
  }

  // One read for every client's canonical connection state, plus whether an
  // account is actually selected.
  //
  // Connection status alone was not enough. A client can be perfectly
  // connected and have no account selected, in which case nothing can produce
  // data for it -- and this surface reported it as healthy or merely degraded
  // while Integrations showed action required for the same client at the same
  // moment. That is finding G0-F5 (an unassigned account is indistinguishable
  // from an empty one) reappearing on the triage surface, where it is worse:
  // the whole point of Agency Today is deciding who to look at.
  const connectionRows = (await getDb().query(
    `SELECT pc.business_id::text AS business_id,
            pc.status,
            COALESCE(assignment.selected_count, 0) AS selected_count
     FROM provider_connections pc
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS selected_count
       FROM business_provider_accounts binding
       WHERE binding.business_id = pc.business_id::text
         AND binding.provider = 'meta'
         AND binding.is_selected
     ) assignment ON TRUE
     WHERE pc.business_id = ANY($1::text[]) AND pc.provider = 'meta'`,
    [businesses.map((business) => business.id)],
  ).catch(() => [])) as unknown as Array<{
    business_id: string;
    status: string;
    selected_count: number;
  }>;
  const connectionByBusiness = new Map(
    connectionRows.map((row) => [row.business_id, row]),
  );

  const now = new Date();
  const clients: AgencyTodayClientInput[] = businesses.map((business) => {
    const clientTotals = totals.get(business.id) ?? null;
    const freshness = resolveClientFreshness(clientTotals?.lastSourceUpdatedAt, now);
    // Health joined to the canonical provider connection state, not inferred
    // from whether totals happen to exist. A client with a revoked token but
    // yesterday's cached numbers used to read "healthy" here while Integrations
    // showed action required for the same client at the same moment.
    const connection = connectionByBusiness.get(business.id);
    const dataHealth: ClientDataHealth = !connection
      ? "disconnected"
      : connection.status === "revoked" ||
          connection.status === "expired" ||
          connection.status === "error"
        ? "action_required"
        : connection.status !== "connected"
          ? "unknown"
          : // Connected but nothing selected: no account can produce data, and
            // it needs a person, so it is action_required rather than merely
            // degraded. Integrations says the same thing about the same client.
            Number(connection.selected_count ?? 0) === 0
            ? "action_required"
            : clientTotals
              ? "healthy"
              : "degraded";

    return {
      businessId: business.id,
      businessName: business.name,
      currency: business.currency ?? null,
      spend: clientTotals?.spend ?? null,
      revenue: clientTotals?.revenue ?? null,
      purchases: clientTotals?.purchases ?? null,
      dataHealth,
      lastSyncAt: clientTotals?.lastSourceUpdatedAt ?? null,
      freshness,
    };
  });

  const model = buildAgencyTodayReadModel(clients);

  // Section 9: Agency Today spans every assigned client, so it is a portfolio
  // event. Attributing it to one business would make per-client metrics wrong
  // in a way nobody would notice. Awaited, because a detached write can be
  // terminated with the request.
  await recordProductInstrumentationEvent({
    businessId: null,
    scope: "portfolio",
    eventName: "agency_today_viewed",
    surface: "overview",
    outcome: "ok",
    itemCount: clients.length,
    occurredAt: new Date().toISOString(),
  });

  return NextResponse.json({ startDate, endDate, model });
}
