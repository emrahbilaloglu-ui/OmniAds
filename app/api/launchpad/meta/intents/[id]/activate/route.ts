import { NextRequest } from "next/server";
import { handleMetaLaunchIntentActivateAction } from "@/lib/meta/launch-activation-route-handlers";

export const dynamic = "force-dynamic";

/*
  The segment is `[id]`, not `[intentId]`.

  Next refuses two different slug names on one dynamic path, and
  `intents/[id]/route.ts` already owned this position — so the app would not
  boot at all with a second name here. A route that cannot be mounted is not a
  route, whatever an import graph says about it.
*/
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return handleMetaLaunchIntentActivateAction(request, context);
}
