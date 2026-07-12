import { NextRequest, NextResponse } from "next/server";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
  validateMetaAddToExistingRequest,
  validateMetaLaunchRequest,
} from "@/lib/launchpad/meta-validation";
import {
  jsonError,
  readJsonBody,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";

type ValidateBody = {
  businessId?: string;
  providerAccountId?: string;
  payload?: unknown;
};

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await readJsonBody<ValidateBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
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

  try {
    const payloadMode =
      body?.payload &&
      typeof body.payload === "object" &&
      !Array.isArray(body.payload) &&
      "mode" in body.payload
        ? String((body.payload as Record<string, unknown>).mode)
        : "new_campaign";
    const result =
      payloadMode === "add_to_existing"
          ? await validateMetaAddToExistingRequest({
              businessId: access.businessId,
              providerAccountId: account.providerAccountId,
              payload: body?.payload,
            })
          : await validateMetaLaunchRequest({
              businessId: access.businessId,
              providerAccountId: account.providerAccountId,
              payload: body?.payload,
          });
    return NextResponse.json({
      ok: result.ok,
      blockers: result.blockers,
      warnings: result.warnings,
      pixels: "pixels" in result ? result.pixels : [],
      target: "target" in result ? result.target : null,
      targets: "targets" in result ? result.targets : [],
    });
  } catch (error) {
    return jsonError(500, "validation_failed", sanitizeErrorMessage(error));
  }
}
