import { NextRequest, NextResponse } from "next/server";
import {
  BUYER_FINANCIAL_WARNING,
  requireShareAcknowledgement,
} from "@/lib/zero-base/creative/share-acknowledgement";
import {
  SHARE_METRIC_KEYS,
  type SharePayload,
} from "@/components/creatives/shareCreativeTypes";
import {
  createCreativeShareSnapshot,
  getCreativeShareLedgerCapability,
  listCreativeShareSnapshots,
  resolveCreativeShareAudience,
} from "@/lib/creative-share-store";
import { buildBuyerClientActions } from "@/lib/creatives/client-action-feed";
import { requireBusinessAccess } from "@/lib/access";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { rejectIfMetaOperatorDemoWrite } from "@/app/api/meta/demo-write-authority";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { resolveMetaCreativesAccountScope } from "@/lib/meta/creatives-warehouse";
import { creativeSharePath } from "@/lib/creative-share-link";
import { rejectIfMetaGateClosed } from "@/lib/meta/release-gate-guard";

type CreateShareRequest = Omit<SharePayload, "token" | "createdAt">;
const SHARE_METRIC_KEY_SET = new Set<string>(SHARE_METRIC_KEYS);
const SHARE_FORMAT_SET = new Set(["image", "video", "catalog"]);
const SHARE_RENDER_MODE_SET = new Set(["image", "video", "unavailable"]);

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isValidCreative(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.preview)) return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  if (typeof value.name !== "string" || !value.name.trim()) return false;
  if (typeof value.format !== "string" || !SHARE_FORMAT_SET.has(value.format)) {
    return false;
  }
  if (
    typeof value.preview.render_mode !== "string" ||
    !SHARE_RENDER_MODE_SET.has(value.preview.render_mode)
  ) {
    return false;
  }
  if (typeof value.launchDate !== "string") return false;
  for (const metric of SHARE_METRIC_KEYS) {
    const metricValue = value[metric];
    if (
      typeof metricValue !== "undefined" &&
      (typeof metricValue !== "number" || !Number.isFinite(metricValue))
    ) {
      return false;
    }
  }
  return true;
}

function isValidPayload(payload: unknown): payload is CreateShareRequest {
  if (!payload || typeof payload !== "object") return false;
  const obj = payload as Partial<CreateShareRequest>;
  const expiresAt = typeof obj.expiresAt === "string" ? Date.parse(obj.expiresAt) : Number.NaN;
  return (
    typeof obj.title === "string" && obj.title.trim().length > 0 &&
    typeof obj.dateRange === "string" && obj.dateRange.trim().length > 0 &&
    Number.isFinite(expiresAt) && expiresAt > Date.now() &&
    Array.isArray(obj.metrics) &&
    obj.metrics.every((metric) => typeof metric === "string" && SHARE_METRIC_KEY_SET.has(metric)) &&
    Array.isArray(obj.creatives) && obj.creatives.length > 0 &&
    obj.creatives.every(isValidCreative) &&
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
  /*
   * Demo authority, before a public token exists.
   *
   * WP11's acceptance names reviewer AND demo refusal for the Public Share
   * lifecycle, and this had only the reviewer half. A share token is the most
   * durable artifact this product mints: it leaves the workspace, it outlives
   * the conversation, and a buyer-audience share carries provider-reported
   * money. A demo workspace has zero authority to issue one. Fail-closed —
   * an unreadable flag refuses too.
   *
   * Placed with the other facts about the CALLER, above the release gate, so
   * someone who may not mint here is not told instead that minting is off
   * everywhere.
   */
  const demoBlocked = await rejectIfMetaOperatorDemoWrite(
    access.membership.businessId,
    "creative_share_create",
  );
  if (demoBlocked) return demoBlocked;
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


  /**
   * The mint gate, enforced on the server rather than trusted from the screen.
   *
   * `META_PUBLIC_SHARE_MINT` was declared as the gate for this capability and
   * read by nothing, so the one operation it names was the one operation it did
   * not govern. A stale tab, a replayed request or a script reached the mint
   * with the control greyed out on every screen.
   *
   * Ordered after everything that is true about the CALLER — role, reviewer
   * posture, and which accounts this business is assigned — and before the
   * capability's own work. Those refusals hold at every rollout state, so they
   * are returned first; a caller who may not mint HERE should not be told
   * instead that minting is off everywhere. Nothing is written either way.
   *
   * Rotation, revocation and deletion are deliberately NOT gated: this is about
   * issuing NEW public links, and withdrawing an existing one must never depend
   * on a rollout flag.
   */
  const mintGated = rejectIfMetaGateClosed("publicShareMint", "creative_share_create");
  if (mintGated) return mintGated;

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
  const path = creativeSharePath(token);
  if (!path) {
    return NextResponse.json(
      { error: "invalid_share_token", message: "The share was created with an invalid token." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
  return NextResponse.json(
    {
      token,
      path,
      // Compatibility alias. It is intentionally a path; the browser composes
      // the trusted current origin rather than accepting a Host-derived URL.
      url: path,
    },
    { headers: NO_STORE_HEADERS },
  );
}
