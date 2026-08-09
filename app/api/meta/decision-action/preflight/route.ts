import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import {
  runGuardedActionPreflight,
  type ObservedTarget,
  type PreflightTarget,
} from "@/lib/meta/guarded-action-preflight";
import { isGuardedExecutionEnabled } from "@/lib/meta/guarded-action-capability";

export const dynamic = "force-dynamic";

/**
 * Verify that a guarded action still points at exactly what its decision named.
 *
 * This route reads persisted provider state and returns a receipt. It has no
 * execution path at all — not a disabled one, not a flagged one. Executing is a
 * separate contract that does not exist in this branch, so there is nothing
 * here that a mis-set flag or a crafted request could push over the boundary.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    businessId?: string;
    providerAccountId?: string;
    entityType?: PreflightTarget["entityType"];
    entityId?: string;
    expectedStatus?: string | null;
    expectedCreativeId?: string | null;
    expectedParentId?: string | null;
    killSwitchEngaged?: boolean;
  } | null;

  const businessId = body?.businessId;
  const providerAccountId = body?.providerAccountId;
  const entityId = body?.entityId;
  const entityType = body?.entityType;

  if (!businessId || !providerAccountId || !entityId || entityType !== "ad") {

    return NextResponse.json(
      {
        error: "invalid_request",
        message: "businessId, providerAccountId and an ad entityId are required.",
      },
      { status: 400 },
    );
  }

  // Preparing an action is not a read-only browse; it needs write access even
  // though nothing is written, so a viewer cannot probe write readiness.
  const access = await requireBusinessAccess({ request, businessId, minRole: "collaborator" });
  if ("error" in access) return access.error;

  const target: PreflightTarget = {
    entityType,
    entityId,
    providerAccountId,
    expectedStatus: body?.expectedStatus ?? null,
    expectedCreativeId: body?.expectedCreativeId ?? null,
    expectedParentId: body?.expectedParentId ?? null,
  };

  let observed: ObservedTarget | null = null;
  const readiness = await getDbSchemaReadiness({ tables: ["meta_ad_dimensions"] }).catch(
    () => null,
  );
  if (readiness?.ready) {
    const rows = (await getDb().query<{
      ad_id: string;
      provider_account_id: string;
      ad_status: string | null;
      creative_id: string | null;
      adset_id: string | null;
      match_count: string;
    }>(
      `
        SELECT ad_id,
               provider_account_id,
               ad_status,
               creative_id,
               adset_id,
               COUNT(*) OVER ()::text AS match_count
        FROM meta_ad_dimensions
        WHERE business_id = $1
          AND ad_id = $2
        ORDER BY updated_at DESC
        LIMIT 2
      `,
      [businessId, entityId],
    )) as Array<{
      ad_id: string;
      provider_account_id: string;
      ad_status: string | null;
      creative_id: string | null;
      adset_id: string | null;
      match_count: string;
    }>;

    if (rows.length > 0) {
      observed = {
        entityId: rows[0].ad_id,
        providerAccountId: rows[0].provider_account_id,
        status: rows[0].ad_status,
        creativeId: rows[0].creative_id,
        parentId: rows[0].adset_id,
        matchCount: Number(rows[0].match_count) || rows.length,
      };
    }
  }

  const receipt = runGuardedActionPreflight({
    target,
    observed,
    killSwitchEngaged: body?.killSwitchEngaged === true,
    checkedAt: new Date().toISOString(),
  });

  // Section 9: the guarded-action lifecycle, recorded from the verdict the
  // preflight actually reached rather than as a flat "a check happened".
  //
  // This build has no execution path, so the honest lifecycle stages available
  // here are the check itself, the dry run it amounts to, and the terminal
  // states the verdict can reach. `blocked` is a refusal, not a failure of the
  // system, so it is recorded as withheld; `ambiguous` and `drifted` are the
  // states worth counting because they are where an operator is left unsure.
  const lifecycleEvent =
    receipt.verdict === "ambiguous"
      ? ("guarded_action_ambiguous" as const)
      : receipt.verdict === "blocked"
        ? ("guarded_action_failed" as const)
        : receipt.verdict === "ready"
          ? ("guarded_action_verified" as const)
          : ("guarded_action_dry_run" as const);
  const lifecycleOutcome =
    receipt.verdict === "ready"
      ? ("ok" as const)
      : receipt.verdict === "blocked"
        ? ("withheld" as const)
        : ("failed" as const);

  await recordProductInstrumentationEvent({
    businessId,
    scope: "business",
    eventName: "guarded_action_preflight",
    surface: "meta_decision_inspector",
    outcome: "ok",
    provider: "meta",
    occurredAt: new Date().toISOString(),
  });
  await recordProductInstrumentationEvent({
    businessId,
    scope: "business",
    eventName: lifecycleEvent,
    surface: "meta_decision_inspector",
    outcome: lifecycleOutcome,
    provider: "meta",
    failureCode: lifecycleOutcome === "failed" ? "contract_violation" : null,
    occurredAt: new Date().toISOString(),
  });

  return NextResponse.json({
    receipt,
    // Stated explicitly so a caller cannot infer that a ready verdict means the
    // action will run: execution is a separate contract, absent from this build.
    executionAvailable: false,
    executionEnabledFlag: isGuardedExecutionEnabled(),
    executionNote:
      "Preflight only. This build has no provider execution path; a ready verdict means the target was verified, not that anything ran.",
  });
}
