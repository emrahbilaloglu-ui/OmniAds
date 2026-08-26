import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireLaunchpadBusinessAccess } from "../route-utils";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
} from "@/lib/launchpad/meta-validation";
import {
  clampRecentAdActionBounds,
  readRecentLaunchpadAdActions,
} from "@/lib/launchpad/meta-recent-ad-actions";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: request.nextUrl.searchParams.get("providerAccountId"),
  });
  if (!account.ok) {
    return jsonError(
      metaLaunchAccountBlockerHttpStatus(account.blocker.code),
      account.blocker.code,
      account.blocker.message,
    );
  }

  /*
   * The query moved to `lib/launchpad/meta-recent-ad-actions.ts` so the
   * composed Launchpad workspace read can run it too. The bounds are clamped by
   * the same function, so a caller cannot widen the window by calling the other
   * one.
   */
  const bounds = clampRecentAdActionBounds({
    sinceDays: request.nextUrl.searchParams.get("sinceDays"),
    limit: request.nextUrl.searchParams.get("limit"),
  });

  return NextResponse.json(
    {
      providerAccountId: account.providerAccountId,
      actions: await readRecentLaunchpadAdActions({
        businessId: access.businessId,
        providerAccountId: account.providerAccountId,
        ...bounds,
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
