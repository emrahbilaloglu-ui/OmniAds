import { NextRequest, NextResponse } from "next/server";
import type { SharePayload } from "@/components/creatives/shareCreativeTypes";
import { createCreativeShareSnapshot } from "@/lib/creative-share-store";
import { buildBuyerClientActions } from "@/lib/creatives/client-action-feed";
import { requireBusinessAccess } from "@/lib/access";

type CreateShareRequest = Omit<SharePayload, "token" | "createdAt">;

function isValidPayload(payload: unknown): payload is CreateShareRequest {
  if (!payload || typeof payload !== "object") return false;
  const obj = payload as Partial<CreateShareRequest>;
  return (
    typeof obj.title === "string" &&
    typeof obj.dateRange === "string" &&
    typeof obj.expiresAt === "string" &&
    Array.isArray(obj.metrics) &&
    Array.isArray(obj.creatives)
  );
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!isValidPayload(body)) {
    return NextResponse.json(
      { error: "invalid_payload", message: "Share payload is invalid." },
      { status: 400 }
    );
  }
  const businessId = (body as Partial<CreateShareRequest>).businessId ?? null;
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  // Only buyer-audience shares carry the client-facing "What we did and why" feed. We build it
  // from the real Meta write ledger here (never derived from analysis.actionLabel). An empty
  // feed leaves clientActions undefined so PublicCreativeSharePage hides the section honestly.
  const payload: CreateShareRequest = body;
  if (businessId && payload.audience === "buyer") {
    const clientActions = await buildBuyerClientActions({ businessId });
    payload.clientActions = clientActions.length > 0 ? clientActions : undefined;
  }

  const { token } = await createCreativeShareSnapshot(payload);
  return NextResponse.json({
    token,
    url: `/share/creative/${token}`,
  });
}
