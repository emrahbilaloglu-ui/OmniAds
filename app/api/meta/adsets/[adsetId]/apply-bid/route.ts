import { NextRequest } from "next/server";
import { handleMetaAdsetBidAction } from "@/lib/meta/entity-action-routes";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ adsetId: string }> },
) {
  return handleMetaAdsetBidAction(request, context);
}
