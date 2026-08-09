import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import {
  acknowledgeNotification,
  markNotificationOpened,
} from "@/lib/notification-store";

export const dynamic = "force-dynamic";

/**
 * Opening and acknowledging a notification.
 *
 * They are separate on purpose. Opening means someone looked; acknowledging
 * means someone took responsibility. Collapsing them would make every glance
 * count as ownership, and the acknowledgment rate would stop meaning anything.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ deliveryId: string }> },
) {
  const { deliveryId } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    businessId?: string;
    action?: string;
  } | null;

  const access = await requireBusinessAccess({
    request,
    businessId: body?.businessId ?? null,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  if (body?.action !== "open" && body?.action !== "acknowledge") {
    return NextResponse.json(
      { error: "unknown_action", message: "action must be open or acknowledge." },
      { status: 400 },
    );
  }

  const changed =
    body.action === "open"
      ? await markNotificationOpened({
          businessId: access.membership.businessId,
          deliveryId,
        })
      : await acknowledgeNotification({
          businessId: access.membership.businessId,
          deliveryId,
        });

  // A no-op is reported as one. Returning ok for a delivery that does not
  // belong to this business, or was already acknowledged, would let the caller
  // believe something happened.
  return NextResponse.json({ changed }, { status: changed ? 200 : 409 });
}
