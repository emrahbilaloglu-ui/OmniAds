import { NextRequest, NextResponse } from "next/server";
import {
  listMetaLaunchDrafts,
  upsertMetaLaunchDraft,
} from "@/lib/launchpad/meta-store";
import {
  jsonError,
  readJsonBody,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";

export const dynamic = "force-dynamic";

type DraftBody = {
  id?: string | null;
  businessId?: string;
  name?: string;
  payload?: unknown;
};

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  try {
    const drafts = await listMetaLaunchDrafts({ businessId: access.businessId });
    return NextResponse.json({ ok: true, drafts });
  } catch (error) {
    return jsonError(500, "drafts_failed", sanitizeErrorMessage(error));
  }
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody<DraftBody>(request);
  const businessId =
    body?.businessId ?? request.nextUrl.searchParams.get("businessId") ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(access, "launchpad_draft_save");
  if (reviewerBlocked) return reviewerBlocked;

  const name = body?.name?.trim() ?? "";
  if (!name) {
    return jsonError(400, "draft_name_required", "Draft name is required.");
  }
  if (!body || !("payload" in body)) {
    return jsonError(400, "draft_payload_required", "Draft payload is required.");
  }

  try {
    const draft = await upsertMetaLaunchDraft({
      businessId: access.businessId,
      id: body.id ?? null,
      name,
      payload: body.payload,
      createdBy: access.userId,
    });
    return NextResponse.json({ ok: true, draft });
  } catch (error) {
    return jsonError(500, "draft_save_failed", sanitizeErrorMessage(error));
  }
}
