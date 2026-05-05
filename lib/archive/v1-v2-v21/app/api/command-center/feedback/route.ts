import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import type {
  CommandCenterFeedbackScope,
  CommandCenterFeedbackType,
  CommandCenterSourceSystem,
} from "@/lib/command-center";
import { buildCommandCenterFeedbackDefaults } from "@/lib/command-center";
import { isCommandCenterV1EnabledForBusiness } from "@/lib/command-center-config";
import { findCommandCenterActionForRange } from "@/lib/command-center-service";
import {
  createCommandCenterFeedback,
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

const FEEDBACK_TYPES = new Set<CommandCenterFeedbackType>([
  "false_positive",
  "bad_recommendation",
  "false_negative",
]);

const FEEDBACK_SCOPES = new Set<CommandCenterFeedbackScope>(["action", "queue_gap"]);
const SOURCE_SYSTEMS = new Set<CommandCenterSourceSystem>(["meta", "creative"]);

interface FeedbackBody {
  businessId?: string;
  startDate?: string;
  endDate?: string;
  clientMutationId?: string;
  feedbackType?: CommandCenterFeedbackType;
  scope?: CommandCenterFeedbackScope;
  actionFingerprint?: string;
  viewKey?: string | null;
  sourceSystem?: CommandCenterSourceSystem | null;
  note?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as FeedbackBody | null;
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
  const feedbackType =
    typeof body?.feedbackType === "string" && FEEDBACK_TYPES.has(body.feedbackType)
      ? body.feedbackType
      : null;
  const scope =
    typeof body?.scope === "string" && FEEDBACK_SCOPES.has(body.scope)
      ? body.scope
      : null;
  const note = typeof body?.note === "string" ? body.note.trim() : "";

  if (!clientMutationId || !feedbackType || !scope || !note) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message:
          "clientMutationId, feedbackType, scope, and a non-empty note are required.",
      },
      { status: 400 },
    );
  }

  if (scope === "action" && feedbackType === "false_negative") {
    return NextResponse.json(
      {
        error: "invalid_feedback_scope",
        message: "false_negative feedback must be reported as a queue_gap entry.",
      },
      { status: 400 },
    );
  }

  if (scope === "queue_gap" && typeof body?.actionFingerprint === "string") {
    return NextResponse.json(
      {
        error: "invalid_feedback_scope",
        message: "queue_gap feedback cannot be linked to an existing action.",
      },
      { status: 400 },
    );
  }

  if (scope === "action") {
    const actionFingerprint =
      typeof body?.actionFingerprint === "string" ? body.actionFingerprint : null;
    if (!actionFingerprint) {
      return NextResponse.json(
        {
          error: "invalid_payload",
          message: "actionFingerprint is required for action-scoped feedback.",
        },
        { status: 400 },
      );
    }

    const startDate =
      typeof body?.startDate === "string" ? body.startDate : toISODate(daysAgo(29));
    const endDate =
      typeof body?.endDate === "string" ? body.endDate : toISODate(new Date());
    const action = await findCommandCenterActionForRange({
      request,
      businessId,
      startDate,
      endDate,
      actionFingerprint,
      permissions,
    });

    if (!action) {
      return NextResponse.json(
        {
          error: "action_not_found",
          message:
            "Command Center action could not be resolved from the live decision snapshot.",
        },
        { status: 404 },
      );
    }

    const feedback = await createCommandCenterFeedback({
      businessId,
      clientMutationId,
      feedbackType,
      ...buildCommandCenterFeedbackDefaults({
        action,
        scope,
      }),
      scope,
      actionFingerprint: action.actionFingerprint,
      actionTitle: action.title,
      sourceSystem: action.sourceSystem,
      sourceType: action.sourceType,
      note,
      actorUserId: access.session.user.id,
      actorName: access.session.user.name,
      actorEmail: access.session.user.email,
    });

    return NextResponse.json({ ok: true, feedback });
  }

  const sourceSystem =
    typeof body?.sourceSystem === "string" && SOURCE_SYSTEMS.has(body.sourceSystem)
      ? body.sourceSystem
      : null;
  const viewKey =
    typeof body?.viewKey === "string" && body.viewKey.trim().length > 0
      ? body.viewKey.trim()
      : null;

  const feedback = await createCommandCenterFeedback({
    businessId,
    clientMutationId,
    feedbackType,
    ...buildCommandCenterFeedbackDefaults({
      scope,
    }),
    scope,
    sourceSystem,
    viewKey,
    note,
    actorUserId: access.session.user.id,
    actorName: access.session.user.name,
    actorEmail: access.session.user.email,
  });

  return NextResponse.json({ ok: true, feedback });
}
