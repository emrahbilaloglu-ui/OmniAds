import { NextRequest } from "next/server";
import { handleMetaAdActionsHistory } from "@/lib/meta/ads-action-routes";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ adId: string }> },
) {
  return handleMetaAdActionsHistory(request, context);
}
