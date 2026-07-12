import { NextRequest, NextResponse } from "next/server";
import { getMetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent-store";
import { getMetaLaunchIntentCapability } from "@/lib/launchpad/meta-launch-intent-capability";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
} from "@/lib/launchpad/meta-validation";
import {
  jsonError,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../../route-utils";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const requestedAccountId =
    request.nextUrl.searchParams.get("providerAccountId")?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: requestedAccountId,
  });
  if (!account.ok) {
    return jsonError(
      metaLaunchAccountBlockerHttpStatus(account.blocker.code),
      account.blocker.code,
      account.blocker.message,
    );
  }

  try {
    const capability = await getMetaLaunchIntentCapability();
    if (!capability.canRead) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "launch_intent_migration_required",
            message:
              "LaunchIntent storage is unavailable until the pending database migration is applied.",
          },
          capability,
        },
        { status: 503 },
      );
    }
    const { id } = await context.params;
    const intent = await getMetaLaunchIntent({
      businessId: access.businessId,
      id,
    });
    if (!intent || intent.providerAccountId !== account.providerAccountId) {
      return jsonError(
        404,
        "launch_intent_not_found",
        "The LaunchIntent was not found for this account.",
      );
    }
    return NextResponse.json({ ok: true, intent });
  } catch (error) {
    return jsonError(
      500,
      "launch_intent_failed",
      sanitizeErrorMessage(error),
    );
  }
}
