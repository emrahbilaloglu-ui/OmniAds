import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { rejectIfMetaOperatorDemoWrite } from "@/app/api/meta/demo-write-authority";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import {
  appendEntityRoleDeclarations,
  listEntityRoleDeclarations,
  type EntityRoleDeclarationRequest,
} from "@/lib/creative-decision-engine/campaign-context/entity-role";

/**
 * D118 — explicit, account-scoped campaign and ad set role declarations.
 *
 * GET lists one account's declaration history. POST appends a batch of
 * declare/revoke events, one per named entity: declaring a campaign says
 * nothing about its ad sets, and an ad set is declared in its own right.
 * The retired manual campaign-label route stays a tombstone; this route
 * writes a different record under a different contract.
 */

function jsonError(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: { code, message, ...extra } }, { status });
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function accountIsAssigned(businessId: string, providerAccountId: string) {
  const assignments = await getProviderAccountAssignments(businessId, "meta");
  return Boolean(assignments?.account_ids.includes(providerAccountId));
}

export async function GET(request: NextRequest) {
  const businessId = stringValue(request.nextUrl.searchParams.get("businessId"));
  const providerAccountId = stringValue(
    request.nextUrl.searchParams.get("providerAccountId"),
  );
  if (!businessId || !providerAccountId) {
    return jsonError(400, "missing_params", "businessId and providerAccountId are required.");
  }
  const access = await requireBusinessAccess({ request, businessId });
  if ("error" in access) return access.error;
  if (!(await accountIsAssigned(businessId, providerAccountId))) {
    return jsonError(403, "provider_account_not_assigned", "The requested Meta account is not assigned to this business.");
  }
  const declarations = await listEntityRoleDeclarations({ businessId, providerAccountId });
  return NextResponse.json({ ok: true, declarations });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { businessId?: unknown; providerAccountId?: unknown; declarations?: unknown }
    | null;
  if (!body || typeof body !== "object") {
    return jsonError(400, "invalid_body", "A JSON body is required.");
  }
  const businessId = stringValue(body.businessId);
  const providerAccountId = stringValue(body.providerAccountId);
  if (!businessId || !providerAccountId) {
    return jsonError(400, "missing_params", "businessId and providerAccountId are required.");
  }
  if (!Array.isArray(body.declarations) || body.declarations.length === 0 || body.declarations.length > 200) {
    return jsonError(400, "invalid_declarations", "declarations must be a non-empty array of at most 200 entries.");
  }
  const access = await requireBusinessAccess({ request, businessId, minRole: "collaborator" });
  if ("error" in access) return access.error;
  const reviewerBlocked = rejectIfReviewerReadOnly(access, "entity_role_declaration");
  if (reviewerBlocked) return reviewerBlocked;
  const demoBlocked = await rejectIfMetaOperatorDemoWrite(businessId, "entity_role_declaration");
  if (demoBlocked) return demoBlocked;
  if (!(await accountIsAssigned(businessId, providerAccountId))) {
    return jsonError(403, "provider_account_not_assigned", "The requested Meta account is not assigned to this business.");
  }

  const requests: EntityRoleDeclarationRequest[] = body.declarations.map((raw) => {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      entityType: stringValue(item.entityType),
      entityId: stringValue(item.entityId),
      event: stringValue(item.event),
      role: item.role == null ? null : stringValue(item.role),
      effectiveFrom: stringValue(item.effectiveFrom),
      reason: item.reason == null ? null : String(item.reason),
    };
  });
  const result = await appendEntityRoleDeclarations({
    businessId,
    providerAccountId,
    declaredBy: access.session.user.id,
    requests,
  });
  if (!result.ok) {
    return jsonError(
      result.refusal === "entity_not_observed_in_account" ? 404 : 422,
      result.refusal,
      "The declaration was refused; nothing was recorded.",
      { index: result.index, entityId: result.entityId },
    );
  }
  return NextResponse.json({ ok: true, declarations: result.events });
}
