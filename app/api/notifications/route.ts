import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import {
  countUnacknowledged,
  markNotificationsDelivered,
  readNotificationsForRecipient,
} from "@/lib/notification-store";

export const dynamic = "force-dynamic";

/**
 * What the bell reads.
 *
 * Fetching is what makes an attempted notification genuinely delivered: the
 * recipient's client now has it. That transition happens here rather than at
 * enqueue time, because marking our own queue as "delivered" would make the
 * delivery rate a measure of the queue instead of of anyone receiving anything.
 */
export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const recipientUserId = access.session.user.id;
  await markNotificationsDelivered({
    businessId: access.membership.businessId,
    recipientUserId,
  });

  const notifications = await readNotificationsForRecipient({
    businessId: access.membership.businessId,
    recipientUserId,
  });

  return NextResponse.json({
    notifications,
    unacknowledged: countUnacknowledged(notifications),
  });
}
