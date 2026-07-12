import { NextRequest, NextResponse } from "next/server";
import {
  MetaCreativeBriefValidationError,
  parsePatchMetaCreativeBriefRequest,
} from "@/lib/meta/creative-brief-contract";
import {
  patchMetaCreativeBrief,
  readMetaCreativeBrief,
} from "@/lib/meta/creative-brief-store";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import {
  META_CREATIVE_BRIEF_NO_STORE_HEADERS,
  creativeBriefDomainError,
  creativeBriefJsonError,
  creativeBriefStorageUnavailable,
  getMetaCreativeBriefCapability,
  parseCreativeBriefId,
  requireMetaCreativeBriefScope,
} from "../route-support";

type RouteContext = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

async function routeBriefId(context: RouteContext) {
  const { id } = await context.params;
  return parseCreativeBriefId(id);
}

export async function GET(request: NextRequest, context: RouteContext) {
  let id;
  try {
    id = await routeBriefId(context);
  } catch (error) {
    return creativeBriefDomainError(error) ?? creativeBriefJsonError(
      400,
      "invalid_brief_id",
      "Creative brief id is invalid.",
    );
  }
  const scope = await requireMetaCreativeBriefScope({
    request,
    businessId: request.nextUrl.searchParams.get("businessId"),
    providerAccountId: request.nextUrl.searchParams.get("providerAccountId"),
    minRole: "guest",
  });
  if (!scope.ok) return scope.response;

  try {
    const capability = await getMetaCreativeBriefCapability();
    if (!capability.canRead) {
      return creativeBriefStorageUnavailable(capability);
    }
    const brief = await readMetaCreativeBrief({
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
      id,
    });
    if (!brief) {
      return creativeBriefJsonError(
        404,
        "creative_brief_not_found",
        "Creative brief not found.",
      );
    }
    return NextResponse.json(
      { brief },
      { headers: META_CREATIVE_BRIEF_NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[meta-creative-briefs] detail read failed", {
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return creativeBriefJsonError(
      500,
      "creative_brief_unavailable",
      "The creative brief is unavailable right now.",
    );
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  let id;
  let patch;
  try {
    id = await routeBriefId(context);
    patch = parsePatchMetaCreativeBriefRequest(
      await request.json().catch(() => null),
    );
  } catch (error) {
    if (error instanceof MetaCreativeBriefValidationError) {
      return (
        creativeBriefDomainError(error) ??
        creativeBriefJsonError(400, "invalid_body", error.message)
      );
    }
    throw error;
  }

  const scope = await requireMetaCreativeBriefScope({
    request,
    businessId: request.nextUrl.searchParams.get("businessId"),
    providerAccountId: request.nextUrl.searchParams.get("providerAccountId"),
    minRole: "collaborator",
  });
  if (!scope.ok) return scope.response;
  const reviewerBlocked = rejectIfReviewerReadOnly(
    scope.access,
    "meta_creative_brief_update",
  );
  if (reviewerBlocked) return reviewerBlocked;

  try {
    const capability = await getMetaCreativeBriefCapability();
    if (!capability.canWrite) {
      return creativeBriefStorageUnavailable(capability);
    }
    const brief = await patchMetaCreativeBrief({
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
      id,
      patch,
      updatedBy: scope.userId,
    });
    return NextResponse.json(
      { brief },
      { headers: META_CREATIVE_BRIEF_NO_STORE_HEADERS },
    );
  } catch (error) {
    const domainResponse = creativeBriefDomainError(error);
    if (domainResponse) return domainResponse;
    console.error("[meta-creative-briefs] update failed", {
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return creativeBriefJsonError(
      500,
      "creative_brief_update_failed",
      "The creative brief could not be updated.",
    );
  }
}
