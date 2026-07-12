import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { parseBriefingStatusFilter } from "@/lib/meta/briefing-filter";
import { readMetaAnomaliesForBusiness } from "@/lib/meta/anomalies";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { resolveMetaCreativesAccountScope } from "@/lib/meta/creatives-warehouse";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId");
  const requestedProviderAccountId =
    searchParams.get("providerAccountId")?.trim() || null;
  const activeOnly = searchParams.get("activeOnly") === "1";
  const endDate = searchParams.get("endDate")?.trim() || null;
  // Absent param = no status filtering (legacy callers keep full payloads);
  // parseBriefingStatusFilter would otherwise default to "active".
  const rawStatusFilter = searchParams.get("status_filter");
  const statusFilter = rawStatusFilter === null ? null : parseBriefingStatusFilter(rawStatusFilter);

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  if (!businessId) {
    return NextResponse.json(
      { error: "missing_params", message: "businessId is required." },
      { status: 400 },
    );
  }

  const accountScope = resolveMetaCreativesAccountScope({
    assignedAccountIds: await fetchAssignedAccountIds(
      access.membership.businessId,
    ),
    requestedProviderAccountId,
  });
  if (!accountScope.ok) {
    return NextResponse.json(
      {
        error: accountScope.status,
        message:
          accountScope.status === "account_not_assigned"
            ? "The requested Meta account is not assigned to this business."
            : "Select one assigned Meta account before reading anomalies.",
      },
      {
        status:
          accountScope.status === "account_not_assigned"
            ? 403
            : accountScope.status === "provider_account_required"
              ? 400
              : 200,
      },
    );
  }

  const result = await readMetaAnomaliesForBusiness({
    businessId: access.membership.businessId,
    providerAccountId: accountScope.providerAccountId,
    activeOnly,
    endDate,
    statusFilter,
  });

  return NextResponse.json(result);
}
