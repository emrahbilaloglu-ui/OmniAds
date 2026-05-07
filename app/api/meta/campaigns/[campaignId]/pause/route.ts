import { NextRequest } from "next/server";
import { handleMetaEntityPauseAction } from "@/lib/meta/entity-action-routes";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ campaignId: string }> },
) {
  return handleMetaEntityPauseAction(request, context, {
    scopeType: "campaign",
    paramName: "campaignId",
  });
}
