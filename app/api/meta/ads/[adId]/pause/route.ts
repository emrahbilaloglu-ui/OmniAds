import { NextRequest } from "next/server";
import { handleMetaAdStatusAction } from "@/lib/meta/ads-action-routes";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ adId: string }> },
) {
  return handleMetaAdStatusAction(request, context, "pause");
}
