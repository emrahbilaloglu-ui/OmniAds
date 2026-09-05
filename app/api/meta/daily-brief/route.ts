/**
 * The morning read, as one request.
 *
 * Home had a brief card with nothing behind it, so the only way to learn what
 * happened overnight was to open four screens and know which four. Every fact
 * here is already produced elsewhere; this route assembles them and says which
 * ones it could actually read, because "no alerts" and "the alert query did
 * not answer" look the same on a card and mean opposite things.
 */
import { NextRequest, NextResponse } from "next/server";

import { buildMetaDailyBrief } from "@/lib/meta/daily-brief";
import { requireBusinessAccess } from "@/lib/access";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  if (!businessId) {
    return NextResponse.json(
      { ok: false, error: { code: "business_id_required" } },
      { status: 400 },
    );
  }
  const access = await requireBusinessAccess({ request, businessId });
  if ("error" in access) return access.error;

  /*
    The account is resolved, never taken from the query string.

    A brief is a read, but it is a read of one business's assigned account; a
    caller-supplied account would let a member of one business ask about
    another's queue. Exactly one assignment counts — with several, the
    account-scoped sections report unavailable rather than guessing which.
  */
  const assignment = await getProviderAccountAssignments(businessId, "meta")
    .catch(() => null);
  const accounts = assignment?.account_ids ?? [];
  const providerAccountId = accounts.length === 1 ? accounts[0]! : null;

  const brief = await buildMetaDailyBrief({
    businessId,
    providerAccountId,
    asOf: request.nextUrl.searchParams.get("asOf")?.trim() || undefined,
  });

  return NextResponse.json({ ok: true, brief });
}
