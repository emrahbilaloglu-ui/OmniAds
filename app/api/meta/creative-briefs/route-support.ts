import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import type { MembershipRole } from "@/lib/auth";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import {
  MetaCreativeBriefValidationError,
  type MetaCreativeBriefCapability,
  type MetaCreativeBriefStatus,
} from "@/lib/meta/creative-brief-contract";
import {
  MetaCreativeBriefIdempotencyConflictError,
  MetaCreativeBriefNotFoundError,
  MetaCreativeBriefSourceNotFoundError,
  MetaCreativeBriefVersionConflictError,
} from "@/lib/meta/creative-brief-store";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const META_CREATIVE_BRIEF_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
} as const;

export async function getMetaCreativeBriefCapability(): Promise<MetaCreativeBriefCapability> {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_creative_briefs"],
  });
  const ready = readiness.ready;
  return {
    status: ready ? "ready" : "migration_required",
    canRead: ready,
    canWrite: ready,
    missingTables: readiness.missingTables,
    checkedAt: readiness.checkedAt,
  };
}

export function creativeBriefStorageUnavailable(
  capability: MetaCreativeBriefCapability,
) {
  return creativeBriefJsonError(
    503,
    "creative_brief_migration_required",
    "Creative Brief storage is not available until the pending database migration is applied.",
    { capability },
  );
}

export function creativeBriefJsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json(
    { error: { code, message, ...(extra ?? {}) } },
    { status, headers: META_CREATIVE_BRIEF_NO_STORE_HEADERS },
  );
}

export function parseCreativeBriefStatusFilter(
  value: string | null,
): MetaCreativeBriefStatus | null {
  if (!value) return null;
  if (value === "draft" || value === "reviewed") return value;
  throw new MetaCreativeBriefValidationError(
    "invalid_status",
    "status must be draft or reviewed.",
  );
}

export function parseCreativeBriefId(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(normalized)) {
    throw new MetaCreativeBriefValidationError(
      "invalid_brief_id",
      "Creative brief id must be a UUID.",
    );
  }
  return normalized;
}

export async function requireMetaCreativeBriefScope(input: {
  request: NextRequest;
  businessId: string | null | undefined;
  providerAccountId: string | null | undefined;
  minRole: MembershipRole;
}) {
  const businessId = input.businessId?.trim() ?? "";
  const providerAccountId = input.providerAccountId?.trim() ?? "";
  if (!businessId) {
    return {
      ok: false as const,
      response: creativeBriefJsonError(
        400,
        "missing_business_id",
        "businessId is required.",
      ),
    };
  }
  if (!providerAccountId) {
    return {
      ok: false as const,
      response: creativeBriefJsonError(
        400,
        "missing_provider_account_id",
        "providerAccountId is required.",
      ),
    };
  }

  const access = await requireBusinessAccess({
    request: input.request,
    businessId,
    minRole: input.minRole,
  });
  if ("error" in access) return { ok: false as const, response: access.error };

  let assignments;
  try {
    assignments = await getProviderAccountAssignments(
      access.membership.businessId,
      "meta",
    );
  } catch {
    return {
      ok: false as const,
      response: creativeBriefJsonError(
        503,
        "provider_account_scope_unavailable",
        "The Meta account assignment source is unavailable.",
      ),
    };
  }
  if (!assignments?.account_ids.includes(providerAccountId)) {
    return {
      ok: false as const,
      response: creativeBriefJsonError(
        404,
        "provider_account_not_assigned",
        "providerAccountId is not assigned to this business.",
      ),
    };
  }

  return {
    ok: true as const,
    access,
    businessId: access.membership.businessId,
    providerAccountId,
    userId: access.session.user.id,
  };
}

export function creativeBriefDomainError(error: unknown) {
  if (error instanceof MetaCreativeBriefValidationError) {
    return creativeBriefJsonError(400, error.code, error.message);
  }
  if (error instanceof MetaCreativeBriefIdempotencyConflictError) {
    return creativeBriefJsonError(
      409,
      "idempotency_key_conflict",
      error.message,
    );
  }
  if (error instanceof MetaCreativeBriefSourceNotFoundError) {
    return creativeBriefJsonError(
      422,
      "source_decision_not_found",
      error.message,
    );
  }
  if (error instanceof MetaCreativeBriefVersionConflictError) {
    return creativeBriefJsonError(409, "version_conflict", error.message, {
      expectedVersion: error.expectedVersion,
      currentVersion: error.currentVersion,
    });
  }
  if (error instanceof MetaCreativeBriefNotFoundError) {
    return creativeBriefJsonError(404, "creative_brief_not_found", error.message);
  }
  return null;
}
