import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import type { CommandCenterActionMutation } from "@/lib/command-center";
import { isCommandCenterV1EnabledForBusiness } from "@/lib/command-center-config";
import { getCommandCenterSnapshot } from "@/lib/command-center-service";
import {
  applyCommandCenterActionMutation,
  getCommandCenterPermissions,
} from "@/lib/command-center-store";

function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

const BATCH_MUTATIONS = new Set<
  Extract<
    CommandCenterActionMutation,
    "approve" | "reject" | "reopen" | "complete_manual"
  >
>(["approve", "reject", "reopen", "complete_manual"]);

interface BatchBody {
  businessId?: string;
  startDate?: string;
  endDate?: string;
  actionFingerprints?: unknown;
  clientMutationId?: string;
  mutation?: CommandCenterActionMutation;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as BatchBody | null;
  const businessId =
    typeof body?.businessId === "string" ? body.businessId : null;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  if (!isCommandCenterV1EnabledForBusiness(businessId)) {
    return NextResponse.json(
      {
        error: "command_center_disabled",
        message: "Command Center is feature-gated for this workspace.",
      },
      { status: 404 },
    );
  }

  const permissions = getCommandCenterPermissions({
    businessId,
    email: access.session.user.email,
    role: access.membership.role,
  });
  if (!permissions.canEdit) {
    return NextResponse.json(
      { error: "forbidden", message: permissions.reason ?? "Read-only access." },
      { status: 403 },
    );
  }

  const clientMutationId =
    typeof body?.clientMutationId === "string" ? body.clientMutationId : null;
  const mutation =
    typeof body?.mutation === "string" && BATCH_MUTATIONS.has(body.mutation as never)
      ? (body.mutation as Extract<
          CommandCenterActionMutation,
          "approve" | "reject" | "reopen" | "complete_manual"
        >)
      : null;
  const actionFingerprints = Array.isArray(body?.actionFingerprints)
    ? Array.from(
        new Set(
          body.actionFingerprints.filter(
            (entry): entry is string =>
              typeof entry === "string" && entry.trim().length > 0,
          ),
        ),
      ).slice(0, 25)
    : [];

  if (!clientMutationId || !mutation || actionFingerprints.length === 0) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message:
          "clientMutationId, a supported batch mutation, and at least one actionFingerprint are required.",
      },
      { status: 400 },
    );
  }

  const startDate =
    typeof body?.startDate === "string" ? body.startDate : toISODate(daysAgo(29));
  const endDate =
    typeof body?.endDate === "string" ? body.endDate : toISODate(new Date());

  const snapshot = await getCommandCenterSnapshot({
    request,
    businessId,
    startDate,
    endDate,
    permissions,
  });
  const actionsByFingerprint = new Map(
    snapshot.actions.map((action) => [action.actionFingerprint, action]),
  );

  const results: Array<{
    actionFingerprint: string;
    ok: boolean;
    state?: unknown;
    error?: string;
  }> = [];

  for (const actionFingerprint of actionFingerprints) {
    const action = actionsByFingerprint.get(actionFingerprint);
    if (!action) {
      results.push({
        actionFingerprint,
        ok: false,
        error: "action_not_found",
      });
      continue;
    }
    if (!action.batchReviewEligible) {
      results.push({
        actionFingerprint,
        ok: false,
        error: "batch_review_ineligible",
      });
      continue;
    }

    try {
      const state = await applyCommandCenterActionMutation({
        businessId,
        action,
        actorUserId: access.session.user.id,
        actorName: access.session.user.name,
        actorEmail: access.session.user.email,
        clientMutationId: `${clientMutationId}:${mutation}:${actionFingerprint}`,
        mutation,
      });
      results.push({
        actionFingerprint,
        ok: true,
        state,
      });
    } catch (error) {
      results.push({
        actionFingerprint,
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Command Center batch mutation failed.",
      });
    }
  }

  return NextResponse.json({
    ok: results.every((result) => result.ok),
    mutation,
    requestedCount: actionFingerprints.length,
    successCount: results.filter((result) => result.ok).length,
    failureCount: results.filter((result) => !result.ok).length,
    results,
  });
}
