import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";

export const dynamic = "force-dynamic";

/**
 * Server-owned Google account scope.
 *
 * The Google read endpoints serve report bodies, not account identity — so the
 * canonical surfaces had no honest way to state whose numbers they were
 * showing. Rather than inventing accounts in the browser, this composes the
 * existing assignment and account authorities on the server and serves exactly
 * what they know: id, name, currency and timezone, each nullable, each from a
 * real read.
 *
 * It performs no provider call and no write.
 */
export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  const assignment = await getProviderAccountAssignments(
    access.membership.businessId,
    "google",
  ).catch(() => null);
  const assigned = assignment?.account_ids ?? [];

  // Persisted profile only. `fetchGoogleAdsAccounts` would contact Google, and
  // this programme performs no provider call.
  const readiness = await getDbSchemaReadiness({ tables: ["provider_accounts"] }).catch(() => null);
  const rows = readiness?.ready && assigned.length > 0
    ? ((await getDb().query<{
        external_account_id: string;
        account_name: string | null;
        currency: string | null;
        timezone: string | null;
      }>(
        `SELECT external_account_id, account_name, currency, timezone
           FROM provider_accounts
          WHERE provider = 'google'
            AND external_account_id = ANY($1::text[])`,
        [assigned],
      )) as Array<{
        external_account_id: string;
        account_name: string | null;
        currency: string | null;
        timezone: string | null;
      }>)
    : [];

  const byId = new Map(rows.map((row) => [row.external_account_id, row]));

  const accounts = assigned.map((id) => {
    const detail = byId.get(id);
    return {
      id,
      name: detail?.account_name ?? null,
      // Nullable on purpose: an unserved currency must reach the surface as
      // unserved, not as a guessed default.
      currency: detail?.currency ?? null,
      timezone: detail?.timezone ?? null,
    };
  });

  return NextResponse.json(
    { accounts, assignedCount: assigned.length },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
