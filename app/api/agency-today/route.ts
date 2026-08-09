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

  const now = new Date();
  const clients: AgencyTodayClientInput[] = businesses.map((business) => {
    const clientTotals = totals.get(business.id) ?? null;
    const freshness = resolveClientFreshness(clientTotals?.lastSourceUpdatedAt, now);
    // Health beyond freshness needs the provider health read model per client;
    // until Agency Today carries it, this states what it knows and no more.
    const dataHealth: ClientDataHealth = clientTotals ? "healthy" : "unknown";

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

  // Section 9 outcome metric: was the cross-client morning view actually
  // opened, and did it have anything to show. Tenant-scoped, fire-and-forget,
  // and never allowed to fail the response.
  void recordProductInstrumentationEvent({
    businessId: businesses[0]?.id ?? "unknown",
    eventName: "agency_today_viewed",
    surface: "overview",
    outcome: "ok",
    itemCount: clients.length,
    occurredAt: new Date().toISOString(),
  });

  return NextResponse.json({ startDate, endDate, model });
}
