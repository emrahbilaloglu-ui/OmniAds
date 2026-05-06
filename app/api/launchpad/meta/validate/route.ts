import { NextRequest, NextResponse } from "next/server";
import { validateMetaLaunchRequest } from "@/lib/launchpad/meta-validation";
import {
  jsonError,
  readJsonBody,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";

type ValidateBody = {
  businessId?: string;
  payload?: unknown;
};

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await readJsonBody<ValidateBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  try {
    const result = await validateMetaLaunchRequest({
      businessId: access.businessId,
      payload: body?.payload,
    });
    return NextResponse.json({
      ok: result.ok,
      blockers: result.blockers,
      warnings: result.warnings,
      pixels: result.pixels,
    });
  } catch (error) {
    return jsonError(500, "validation_failed", sanitizeErrorMessage(error));
  }
}
