import { NextRequest, NextResponse } from "next/server";
import {
  META_CREATIVE_BRIEF_CONTRACT_VERSION,
  MetaCreativeBriefValidationError,
  parseCreateMetaCreativeBriefRequest,
} from "@/lib/meta/creative-brief-contract";
import {
  createMetaCreativeBrief,
  listMetaCreativeBriefs,
} from "@/lib/meta/creative-brief-store";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import {
  META_CREATIVE_BRIEF_NO_STORE_HEADERS,
  creativeBriefDomainError,
  creativeBriefJsonError,
  creativeBriefStorageUnavailable,
  getMetaCreativeBriefCapability,
  parseCreativeBriefStatusFilter,
  requireMetaCreativeBriefScope,
} from "./route-support";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let status;
  try {
    status = parseCreativeBriefStatusFilter(
      request.nextUrl.searchParams.get("status"),
    );
  } catch (error) {
    return creativeBriefDomainError(error) ?? creativeBriefJsonError(
      400,
      "invalid_query",
      "The Creative Brief query is invalid.",
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
      return NextResponse.json(
        {
          contractVersion: META_CREATIVE_BRIEF_CONTRACT_VERSION,
          scope: {
            businessId: scope.businessId,
            providerAccountId: scope.providerAccountId,
          },
          capability,
          briefs: [],
        },
        { headers: META_CREATIVE_BRIEF_NO_STORE_HEADERS },
      );
    }
    const briefs = await listMetaCreativeBriefs({
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
      status,
    });
    return NextResponse.json(
      {
        contractVersion: META_CREATIVE_BRIEF_CONTRACT_VERSION,
        scope: {
          businessId: scope.businessId,
          providerAccountId: scope.providerAccountId,
        },
        capability,
        briefs,
      },
      { headers: META_CREATIVE_BRIEF_NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[meta-creative-briefs] list failed", {
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return creativeBriefJsonError(
      500,
      "creative_briefs_unavailable",
      "Creative briefs are unavailable right now.",
    );
  }
}

export async function POST(request: NextRequest) {
  let parsed;
  try {
    parsed = parseCreateMetaCreativeBriefRequest(
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
    businessId: parsed.businessId,
    providerAccountId: parsed.providerAccountId,
    minRole: "collaborator",
  });
  if (!scope.ok) return scope.response;
  const reviewerBlocked = rejectIfReviewerReadOnly(
    scope.access,
    "meta_creative_brief_create",
  );
  if (reviewerBlocked) return reviewerBlocked;

  try {
    const capability = await getMetaCreativeBriefCapability();
    if (!capability.canWrite) {
      return creativeBriefStorageUnavailable(capability);
    }
    const result = await createMetaCreativeBrief({
      request: {
        ...parsed,
        businessId: scope.businessId,
        providerAccountId: scope.providerAccountId,
      },
      createdBy: scope.userId,
    });
    return NextResponse.json(
      {
        brief: result.brief,
        idempotentReplay: !result.created,
      },
      {
        status: result.created ? 201 : 200,
        headers: META_CREATIVE_BRIEF_NO_STORE_HEADERS,
      },
    );
  } catch (error) {
    const domainResponse = creativeBriefDomainError(error);
    if (domainResponse) return domainResponse;
    console.error("[meta-creative-briefs] create failed", {
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return creativeBriefJsonError(
      500,
      "creative_brief_create_failed",
      "The creative brief could not be created.",
    );
  }
}
