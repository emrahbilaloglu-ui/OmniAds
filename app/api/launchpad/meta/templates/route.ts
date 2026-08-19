import { NextRequest, NextResponse } from "next/server";
import {
  createManualMetaLaunchTemplate,
  listManualMetaLaunchTemplates,
} from "@/lib/launchpad/meta-store";
import {
  jsonError,
  readJsonBody,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";
import { rejectIfLaunchpadDemoWrite } from "../demo-write-authority";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
} from "@/lib/launchpad/meta-validation";
import { getMetaLaunchStoreCapability } from "@/lib/launchpad/meta-store-capability";

export const dynamic = "force-dynamic";

type TemplateBody = {
  businessId?: string;
  providerAccountId?: string;
  name?: string;
  description?: string | null;
  payload?: unknown;
};

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: request.nextUrl.searchParams.get("providerAccountId"),
  });
  if (!account.ok) {
    return jsonError(
      metaLaunchAccountBlockerHttpStatus(account.blocker.code),
      account.blocker.code,
      account.blocker.message,
    );
  }
  const capability = await getMetaLaunchStoreCapability("templates");
  if (!capability.canRead) {
    return NextResponse.json({ ok: true, templates: [], capability });
  }

  try {
    const templates = await listManualMetaLaunchTemplates({
      businessId: access.businessId,
      providerAccountId: account.providerAccountId,
    });
    return NextResponse.json({ ok: true, templates, capability });
  } catch (error) {
    return jsonError(500, "templates_failed", sanitizeErrorMessage(error));
  }
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody<TemplateBody>(request);
  const businessId =
    body?.businessId ?? request.nextUrl.searchParams.get("businessId") ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(access, "launchpad_template_create");
  if (reviewerBlocked) return reviewerBlocked;
  // Canonical invariant: "Demo businesses have zero Meta write authority even
  // if a presentation defect supplies an action." The reviewer gate above does
  // not cover this — `/api/auth/demo-login` opens a session as an ADMIN of the
  // demo business under a non-reviewer email, so it passes both the role check
  // and the reviewer check. The refusal has to live on the server or it does
  // not exist.
  const demoBlocked = await rejectIfLaunchpadDemoWrite(
    access.businessId,
    "launchpad_template_create",
  );
  if (demoBlocked) return demoBlocked;
  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: body?.providerAccountId,
  });
  if (!account.ok) {
    return jsonError(
      metaLaunchAccountBlockerHttpStatus(account.blocker.code),
      account.blocker.code,
      account.blocker.message,
    );
  }
  const capability = await getMetaLaunchStoreCapability("templates");
  if (!capability.canWrite) {
    return jsonError(
      503,
      "launch_template_migration_required",
      "Saved template storage requires the pending account-scope database migration.",
    );
  }

  const name = body?.name?.trim() ?? "";
  if (!name) {
    return jsonError(400, "template_name_required", "Template name is required.");
  }
  if (!body || !("payload" in body)) {
    return jsonError(400, "template_payload_required", "Template payload is required.");
  }

  try {
    const template = await createManualMetaLaunchTemplate({
      businessId: access.businessId,
      providerAccountId: account.providerAccountId,
      name,
      description: body.description ?? null,
      payload: body.payload,
      createdBy: access.userId,
    });
    return NextResponse.json({ ok: true, template });
  } catch (error) {
    return jsonError(500, "template_create_failed", sanitizeErrorMessage(error));
  }
}
