import { NextRequest, NextResponse } from "next/server";

import { readLaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";
import { rejectIfMetaOperatorDemoWrite } from "@/app/api/meta/demo-write-authority";
import { getBusinessCurrency } from "@/lib/account-store";
import { requireBusinessAccess } from "@/lib/access";
import {
  buildCostStructurePreview,
  type CostStructurePreviewSource,
} from "@/lib/business-commerce-cost-preview";
import {
  costStructureAbsentRevision,
  CostStructureRevisionConflictError,
  CostStructureSchemaUnavailableError,
  getStoredCostStructure,
  saveCostStructure,
  type StoredCostStructure,
} from "@/lib/business-commerce-cost-structure";
import { legacyStructureNeedsConfirmation } from "@/lib/commerce-cost/legacy";
import { DuplicateCostComponentIdError } from "@/lib/commerce-cost/reconcile";
import { parseCostStructurePayload } from "@/lib/commerce-cost/payload";
import { validateCostStructure } from "@/lib/commerce-cost/validate";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import type { CommerceCostStructure } from "@/src/types/commerce-cost";

/**
 * The operator's declared commerce cost structure.
 *
 * GET answers one of three source states and separately reports storage
 * readiness, so rollout state never changes the meaning of the costs:
 *  - `stored`         — an operator saved this. It has a revision.
 *  - `legacy_preview` — nothing is stored; this is what the legacy percentages
 *                       would look like. Read-only and unconfirmed until saved.
 *  - `empty`          — nothing is stored and there is nothing to preview.
 *
 * If the versioned tables are not migrated yet, GET still serves a read-only
 * legacy/empty preview with `storage.ready=false`. Missing costs remain
 * missing; the response never turns them into zero and never permits a save.
 * PUT remains fail-closed with 503 until storage exists.
 *
 * PUT requires the revision the caller's last GET returned, including the
 * explicit `null` for "I read that nothing was stored". A stale token is a 409
 * carrying the current revision, never a silent overwrite of someone else's
 * save.
 *
 * DELIBERATELY NOT WIRED: nothing here feeds Overview, the Google advisor or
 * the Meta decision engine. Those still read `business_cost_models` and the
 * target pack. Switching them over is a separate cutover with its own gate —
 * doing it implicitly here would change every profit figure in the product the
 * moment one operator pressed save.
 */

const STRICT_REVISION = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

type CostStructureSource = "stored" | CostStructurePreviewSource;

/**
 * What the screen may offer, restated from the same two authorities the write
 * path enforces — never a third opinion.
 *
 * Neither refuses a GET: a reviewer and a demo operator may both read a cost
 * structure, and telling them before the click is the point of this field.
 */
async function resolvePermissions(access: {
  membership: { businessId: string; role: string };
  session: { user: { email: string | null } };
}) {
  const reviewerReadOnly = Boolean(
    rejectIfReviewerReadOnly(
      access as Parameters<typeof rejectIfReviewerReadOnly>[0],
      "commerce_cost_structure_update",
    ),
  );
  const writeAuthority = await readLaunchpadWriteAuthority(access.membership.businessId);
  const readOnlyReason = reviewerReadOnly
    ? "Reviewer access is read-only; the cost structure cannot be edited."
    : writeAuthority === "demo"
      ? "Demo workspaces have zero write authority, so the cost structure is read-only here."
      : writeAuthority !== "live"
        ? "This workspace could not be confirmed as a live workspace, so the cost structure is held read-only."
        : null;

  return {
    canEdit: !readOnlyReason && access.membership.role !== "guest",
    reason: readOnlyReason,
    role: access.membership.role,
  };
}

/**
 * The one place that decides what a structure is allowed to claim.
 *
 * `activatable` means the decision runtime could cost with this: it is stored,
 * it has no blocking errors, and its owner has confirmed what the numbers
 * include. A legacy preview is never activatable however clean it validates —
 * imported percentages are an estimate nobody has vouched for yet.
 */
function describeStructure(structure: CommerceCostStructure, source: CostStructureSource) {
  const issues = validateCostStructure(structure);
  const needsConfirmation = legacyStructureNeedsConfirmation(structure);
  const hasActiveCost = structure.components.some((component) => component.status === "active");
  return {
    issues,
    needsConfirmation,
    activatable:
      source === "stored" &&
      hasActiveCost &&
      !needsConfirmation &&
      !issues.some((issue) => issue.severity === "error"),
  };
}

function storageUnavailableResponse(error: CostStructureSchemaUnavailableError) {
  return NextResponse.json(
    {
      error: "cost_structure_storage_unavailable",
      message:
        "The cost structure store is unavailable until request-external migrations are applied. No cost figure is implied by this.",
      source: "unavailable",
      structure: null,
      revision: null,
      missingTables: error.missingTables,
    },
    { status: 503 },
  );
}

function storedPayload(stored: StoredCostStructure) {
  return {
    structure: stored.structure,
    source: "stored" as const,
    revision: stored.revision,
    version: stored.version,
    recordedAt: stored.recordedAt,
    updatedByUserId: stored.updatedByUserId,
    ...describeStructure(stored.structure, "stored"),
  };
}

async function previewPayload(
  access: Parameters<typeof resolvePermissions>[0],
  storage: { ready: boolean; missingTables: readonly string[] } = {
    ready: true,
    missingTables: [],
  },
) {
  const now = new Date().toISOString();
  const preview = await buildCostStructurePreview({
    businessId: access.membership.businessId,
    reportingCurrency: (await getBusinessCurrency(access.membership.businessId)) ?? "",
    recordedAt: now,
    effectiveFrom: now,
  });
  const resolvedPermissions = await resolvePermissions(access);
  const permissions = storage.ready
    ? resolvedPermissions
    : {
        ...resolvedPermissions,
        canEdit: false,
        reason:
          "Versioned cost-model storage is not ready yet. This preview can be reviewed but cannot be saved.",
      };

  return {
    structure: preview.structure,
    source: preview.source,
    revision: costStructureAbsentRevision(access.membership.businessId),
    version: 0,
    recordedAt: null,
    updatedByUserId: null,
    ...describeStructure(preview.structure, preview.source),
    unreadableLegacySources: preview.unreadableSources,
    ambiguousLegacyZeros: preview.ambiguousLegacyZeros,
    storage,
    permissions,
  };
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId query parameter is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  let stored: StoredCostStructure | null;
  try {
    stored = await getStoredCostStructure(access.membership.businessId);
  } catch (error) {
    if (error instanceof CostStructureSchemaUnavailableError) {
      return NextResponse.json(
        await previewPayload(access, { ready: false, missingTables: error.missingTables }),
      );
    }
    throw error;
  }

  const permissions = await resolvePermissions(access);

  if (stored) {
    return NextResponse.json({ ...storedPayload(stored), permissions });
  }

  // Nothing stored. Build the read-only preview from the legacy percentages.
  return NextResponse.json(await previewPayload(access));
}

export async function PUT(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    businessId?: unknown;
    structure?: unknown;
    expectedRevision?: unknown;
  } | null;

  const businessId = typeof body?.businessId === "string" ? body.businessId : null;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "collaborator" });
  if ("error" in access) return access.error;

  // Both write authorities run before the payload is examined. A caller who may
  // not write should not be told what this endpoint thinks of their body — and
  // a refusal must not depend on the body being well-formed enough to check.
  const reviewerBlocked = rejectIfReviewerReadOnly(access, "commerce_cost_structure_update");
  if (reviewerBlocked) return reviewerBlocked;

  const demoBlocked = await rejectIfMetaOperatorDemoWrite(
    access.membership.businessId,
    "commerce_cost_structure_update",
  );
  if (demoBlocked) return demoBlocked;

  // Mandatory. GET always returns a 64-hex token, including
  // a business-scoped absent token for "nothing stored", so the normal case is
  // simply echoing it back. What is refused is an absent or null field:
  // "I did not read the current state" is not a claim this endpoint can check.
  const expectedRevisionRaw = body?.expectedRevision;
  const hasExpectedRevision = isPlainObject(body) && "expectedRevision" in body;
  const expectedRevision =
    typeof expectedRevisionRaw === "string" && STRICT_REVISION.test(expectedRevisionRaw)
      ? expectedRevisionRaw
      : undefined;
  if (!hasExpectedRevision || expectedRevision === undefined) {
    return NextResponse.json(
      {
        error: "invalid_expected_revision",
        message:
          "expectedRevision must be the business-scoped revision returned by the latest GET.",
        absentRevision: costStructureAbsentRevision(access.membership.businessId),
      },
      { status: 422 },
    );
  }

  if (!isPlainObject(body?.structure)) {
    return NextResponse.json(
      {
        error: "invalid_cost_structure",
        message: "structure must be an object.",
        issues: [{ path: "structure", code: "expected_object", detail: "structure must be an object." }],
      },
      { status: 422 },
    );
  }

  // One recordedAt for the whole write, so the structure and every component it
  // carries agree on when this version was recorded. The store stamps the same
  // value onto the row and assigns the version.
  const recordedAt = new Date().toISOString();
  const parsed = parseCostStructurePayload(body.structure, {
    businessId: access.membership.businessId,
    // Placeholder: the store assigns the real version under its lock, because
    // only the store knows what the current one is.
    version: 0,
    recordedAt,
  });
  if (!parsed.ok) {
    return NextResponse.json(
      {
        error: "invalid_cost_structure",
        message: "The cost structure could not be read.",
        issues: parsed.issues,
      },
      { status: 422 },
    );
  }

  // Domain validation is separate from payload sanitation: a well-typed body can
  // still describe an impossible structure, and that is a 422 too.
  const domainIssues = validateCostStructure(parsed.structure);
  const blocking = domainIssues.filter((issue) => issue.severity === "error");
  if (blocking.length > 0) {
    return NextResponse.json(
      {
        error: "invalid_cost_structure",
        message: "The cost structure is not internally consistent.",
        issues: blocking,
      },
      { status: 422 },
    );
  }

  try {
    const saved = await saveCostStructure({
      businessId: access.membership.businessId,
      structure: parsed.structure,
      expectedRevision,
      recordedAt,
      updatedByUserId: access.session.user.id,
    });

    return NextResponse.json({
      ...storedPayload(saved.stored),
      previousVersion: saved.previousVersion,
      /**
       * What this save did to each component, decided under the lock against
       * the row it superseded — so an operator can see that saving an untouched
       * structure touched nothing.
       */
      components: saved.components,
      permissions: await resolvePermissions(access),
    });
  } catch (error) {
    if (error instanceof CostStructureRevisionConflictError) {
      return NextResponse.json(
        {
          error: error.code,
          message:
            "The cost structure changed since it was read. Reload, check what changed, and save again.",
          currentRevision: error.currentRevision,
          currentVersion: error.currentVersion,
        },
        { status: 409 },
      );
    }
    if (error instanceof CostStructureSchemaUnavailableError) {
      return storageUnavailableResponse(error);
    }
    if (error instanceof DuplicateCostComponentIdError) {
      // The payload boundary already refuses this; reaching here means a
      // structure was assembled another way. Still the caller's error, not a 500.
      return NextResponse.json(
        {
          error: "invalid_cost_structure",
          message: error.message,
          issues: [
            {
              path: "structure.components",
              code: error.code,
              detail: error.message,
            },
          ],
        },
        { status: 422 },
      );
    }
    throw error;
  }
}
