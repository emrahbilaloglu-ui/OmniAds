import { NextRequest } from "next/server";
import { handleMetaEntityResumeAction } from "@/lib/meta/entity-action-routes";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ adsetId: string }> },
) {
  return handleMetaEntityResumeAction(request, context, {
    scopeType: "adset",
    paramName: "adsetId",
  });
}
