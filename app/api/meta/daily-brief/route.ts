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

/**
 * `asOf` is a real calendar day or the request is refused.
 *
 * The value went from the query string into the builder's date arithmetic
 * unchecked, and a value that is not a date makes `new Date(...)
 * .toISOString()` throw `RangeError: Invalid time value` out of the builder —
 * so `?asOf=abc` returned a 500 and no brief at all, and `?asOf=2026-02-30`
 * silently became 2026-03-02. Refusing names the problem to the caller;
 * falling back to today would answer a question nobody asked under a date the
 * caller did not request, which is the class of defect this brief keeps
 * having. The round-trip is the check: a well-formed day that the calendar
 * does not contain comes back as a different day.
 */
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed)
    && new Date(parsed).toISOString().slice(0, 10) === value;
}

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

  const asOf = request.nextUrl.searchParams.get("asOf")?.trim() || null;
  if (asOf !== null && !isCalendarDay(asOf)) {
    return NextResponse.json(
      { ok: false, error: { code: "as_of_invalid" } },
      { status: 400 },
    );
  }

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
    asOf: asOf ?? undefined,
  });

  return NextResponse.json({ ok: true, brief });
}
