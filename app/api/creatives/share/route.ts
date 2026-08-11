import { NextRequest, NextResponse } from "next/server";
import {
  BUYER_FINANCIAL_WARNING,
  requireShareAcknowledgement,
} from "@/lib/zero-base/creative/share-acknowledgement";
import type { SharePayload } from "@/components/creatives/shareCreativeTypes";
import {
  createCreativeShareSnapshot,
  getCreativeShareLedgerCapability,
  listCreativeShareSnapshots,
  resolveCreativeShareAudience,
} from "@/lib/creative-share-store";
import { buildBuyerClientActions } from "@/lib/creatives/client-action-feed";
import { requireBusinessAccess } from "@/lib/access";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { resolveMetaCreativesAccountScope } from "@/lib/meta/creatives-warehouse";

type CreateShareRequest = Omit<SharePayload, "token" | "createdAt">;

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

function isValidPayload(payload: unknown): payload is CreateShareRequest {
  if (!payload || typeof payload !== "object") return false;
  const obj = payload as Partial<CreateShareRequest>;
  return (
    typeof obj.title === "string" &&
    typeof obj.dateRange === "string" &&
    typeof obj.expiresAt === "string" &&
    Array.isArray(obj.metrics) &&
    Array.isArray(obj.creatives) &&
    resolveCreativeShareAudience(obj.audience) !== null
  );
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const requestedProviderAccountId =
    request.nextUrl.searchParams.get("providerAccountId")?.trim() ?? "";
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  let assignedAccountIds: string[];
  try {
    assignedAccountIds = await fetchAssignedAccountIds(access.membership.businessId);
  } catch {
    return NextResponse.json(
      {
        error: "provider_accounts_unavailable",
        message: "Assigned Meta accounts could not be verified.",
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
  const accountScope = resolveMetaCreativesAccountScope({
    assignedAccountIds,
    requestedProviderAccountId,
  });
  if (!accountScope.ok) {
    return NextResponse.json(
      { error: accountScope.status, message: "An assigned providerAccountId is required." },
      {
        status: accountScope.status === "account_not_assigned" ? 403 : 400,
        headers: NO_STORE_HEADERS,
      },
    );
  }

  const capability = await getCreativeShareLedgerCapability();
  if (!capability.canReadLedger) {
    return NextResponse.json(
      {
        grants: [],
        capability,
        message: "Creator share ledger requires the pending database migration.",
      },
      { headers: NO_STORE_HEADERS },
    );
  }

  const grants = await listCreativeShareSnapshots({
    businessId: access.membership.businessId,
    providerAccountId: accountScope.providerAccountId,
  });
  return NextResponse.json({ grants, capability }, { headers: NO_STORE_HEADERS });
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
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;
  const reviewerBlocked = rejectIfReviewerReadOnly(access, "creative_share_create");
  if (reviewerBlocked) return reviewerBlocked;
  const capability = await getCreativeShareLedgerCapability();
  if (!capability.canWrite) {
    return NextResponse.json(
      {
        error: "creative_share_migration_required",
        message: "Creator share writes require the pending database migration.",
        capability,
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  let assignedAccountIds: string[];
  try {
    assignedAccountIds = await fetchAssignedAccountIds(access.membership.businessId);
  } catch {
    return NextResponse.json(
      {
        error: "provider_accounts_unavailable",
        message: "Assigned Meta accounts could not be verified.",
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
  const accountScope = resolveMetaCreativesAccountScope({
    assignedAccountIds,
    requestedProviderAccountId: body.providerAccountId,
  });
  if (!accountScope.ok) {
    return NextResponse.json(
      {
        error: accountScope.status,
        message:
          accountScope.status === "account_not_assigned"
            ? "providerAccountId is not assigned to this business."
            : accountScope.status === "provider_account_required"
              ? "providerAccountId is required when multiple Meta accounts are assigned."
              : "No Meta account is assigned to this business.",
      },
      {
        status: accountScope.status === "account_not_assigned" ? 403 : 400,
        headers: NO_STORE_HEADERS,
      },
    );
  }

  // Only buyer-audience shares carry the client-facing "What we did and why" feed. We build it
  // from the real Meta write ledger here (never derived from analysis.actionLabel). An empty
  // feed leaves clientActions undefined so PublicCreativeSharePage hides the section honestly.
  const audience = resolveCreativeShareAudience(body.audience);
  if (!audience) {
    return NextResponse.json(
      { error: "invalid_audience", message: "Share audience is invalid." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  // A buyer share sends provider-reported money outside the workspace on a link
  // that outlives the conversation. The sender must acknowledge the limitation
  // explicitly; without it there is no share, rather than a share whose warning
  // was quietly dropped.
  const acknowledged = requireShareAcknowledgement({
    audience,
    acknowledgement: (body as { acknowledgement?: unknown }).acknowledgement,
  });
  if (!acknowledged.ok) {
    return NextResponse.json(
      {
        error: acknowledged.error,
        message: acknowledged.message,
        warning: BUYER_FINANCIAL_WARNING,
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const payload: CreateShareRequest = {
    ...body,
    audience,
    businessId: access.membership.businessId,
    providerAccountId: accountScope.providerAccountId,
    clientActions: undefined,
  };
  if (audience === "buyer") {
    const clientActions = await buildBuyerClientActions({
      businessId: access.membership.businessId,
      providerAccountId: accountScope.providerAccountId,
    });
    payload.clientActions = clientActions.length > 0 ? clientActions : undefined;
  }

  const { token } = await createCreativeShareSnapshot(payload, {
    businessId: access.membership.businessId,
    providerAccountId: accountScope.providerAccountId,
    createdBy: access.session.user.id,
  });
  return NextResponse.json(
    {
      token,
      url: `/share/creative/${token}`,
    },
    { headers: NO_STORE_HEADERS },
  );
}
