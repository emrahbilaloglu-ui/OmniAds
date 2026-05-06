import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";

export function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json(
    { ok: false, error: { code, message, ...(extra ?? {}) } },
    { status },
  );
}

export function sanitizeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

export async function readJsonBody<T = Record<string, unknown>>(
  request: NextRequest,
): Promise<T | null> {
  const body = (await request.json().catch(() => null)) as T | null;
  return body && typeof body === "object" ? body : null;
}

export async function requireLaunchpadBusinessAccess(input: {
  request: NextRequest;
  businessId: string | null | undefined;
}) {
  const businessId = input.businessId?.trim() ?? "";
  if (!businessId) {
    return {
      ok: false as const,
      response: jsonError(400, "missing_business_id", "businessId is required."),
    };
  }
  const access = await requireBusinessAccess({
    request: input.request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) {
    return { ok: false as const, response: access.error };
  }
  return {
    ok: true as const,
    businessId: access.membership.businessId,
    userId: access.session.user.id,
  };
}
