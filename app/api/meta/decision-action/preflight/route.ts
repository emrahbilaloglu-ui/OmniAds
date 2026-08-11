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
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import {
  isMutationUiEnabled,
  stripClientExpectations,
} from "@/lib/zero-base/meta/mutation-ceremony";
import {
  buildDispatchDescriptor,
  endpointFor,
  type MutationAction,
} from "@/lib/zero-base/meta/dispatch-contract";
import {
  getMetaAccountContext,
  normalizeMetaCurrencyCode,
} from "@/lib/meta/account-context";
import {
  FORBIDDEN_BODY_FIELDS,
  ZERO_BASE_DECISION_CONTRACT,
  GRAIN_SOURCE,
  REFUSAL_MESSAGE,
  parseDecisionKey,
  type DecisionBoundRefusal,
  type ResolvedDecisionTarget,
} from "@/lib/zero-base/meta/decision-bound-target";

export const dynamic = "force-dynamic";

function refuse(code: DecisionBoundRefusal, status: number) {
  return NextResponse.json(
    { error: code, message: REFUSAL_MESSAGE[code] },
    { status },
  );
}

/**
 * Decision-bound preflight for campaign, ad-set and ad grains.
 *
 * Input is a served decision key plus an allowlisted action — nothing else.
 * The server re-resolves that decision inside the authorized business, proves
 * the provider account is assigned, derives the exact target and its expected
 * state from persisted provider state, and returns a receipt with the typed
 * endpoint that action would use.
 *
 * It never contacts Meta, and it never claims to have. Each action endpoint
 * still runs its own fresh preflight; this one narrows what may be attempted,
 * it does not replace what the endpoint checks at write time.
 */
async function decisionBoundPreflight(
  request: NextRequest,
  body: { businessId?: string; decisionKey?: string; action?: string },
) {
  const businessId = body?.businessId;
  const decisionKey = (body?.decisionKey ?? "").trim();
  const action = body?.action as MutationAction | undefined;

  if (!businessId || !decisionKey || !action) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: "businessId, decisionKey and action are required.",
      },
      { status: 400 },
    );
  }

  // Any attempt to name the target or its expected state is refused before any
  // read, so a caller can never learn whether its override would have worked.
  const supplied = FORBIDDEN_BODY_FIELDS.filter(
    (field) => (body as Record<string, unknown>)[field] !== undefined,
  );
  if (supplied.length > 0) {
    return NextResponse.json(
      {
        error: "client_target_rejected",
        message:
          "In the decision-bound contract the server derives the target and its expected state. Remove: " +
          supplied.join(", "),
        rejected: supplied,
      },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "collaborator" });
  if ("error" in access) return access.error;

  const parsed = parseDecisionKey(decisionKey);
  if (!parsed) return refuse("decision_not_actionable", 422);

  // The action must exist at this grain. An action with no typed endpoint
  // cannot be prepared, let alone dispatched.
  const endpoint = endpointFor(parsed.grain, action);
  if (!endpoint) return refuse("unsupported_action", 422);

  const readiness = await getDbSchemaReadiness({
    tables: [GRAIN_SOURCE[parsed.grain].table],
  }).catch(() => null);
  if (!readiness?.ready) return refuse("warehouse_unavailable", 503);

  const source = GRAIN_SOURCE[parsed.grain];
  const rows = (await getDb().query<{
    entity_id: string;
    provider_account_id: string;
    status: string | null;
    creative_id: string | null;
    parent_id: string | null;
    match_count: string;
  }>(
    `
      SELECT ${source.idColumn} AS entity_id,
             provider_account_id,
             ${source.statusColumn} AS status,
             ${parsed.grain === "ad" ? "creative_id" : "NULL::text AS creative_id"},
             ${source.parentColumn ? `${source.parentColumn} AS parent_id` : "NULL::text AS parent_id"},
             COUNT(*) OVER ()::text AS match_count
      FROM ${source.table}
      WHERE business_id = $1
        AND ${source.idColumn} = $2
      ORDER BY updated_at DESC
      LIMIT 2
    `,
    [businessId, parsed.entityId],
  )) as Array<{
    entity_id: string;
    provider_account_id: string;
    status: string | null;
    creative_id: string | null;
    parent_id: string | null;
    match_count: string;
  }>;

  if (rows.length === 0) return refuse("decision_not_in_served_universe", 404);

  const matchCount = Number(rows[0].match_count) || rows.length;
  // Two rows for one identity means the exact target is not proven. Picking the
  // newest would be a guess, and the guess would be a provider write.
  if (matchCount > 1) return refuse("target_ambiguous", 409);

  // The account behind the decision must be assigned to this business. Without
  // this, a warehouse row that survived an unassignment would still resolve.
  const assigned = await fetchAssignedAccountIds(businessId).catch(() => null);
  if (!assigned || !assigned.includes(rows[0].provider_account_id)) {
    return refuse("provider_account_not_assigned", 403);
  }

  const resolved: ResolvedDecisionTarget = {
    grain: parsed.grain,
    entityId: rows[0].entity_id,
    providerAccountId: rows[0].provider_account_id,
    status: rows[0].status,
    creativeId: rows[0].creative_id,
    parentId: rows[0].parent_id,
    matchCount,
  };

  const receipt = runGuardedActionPreflight({
    target: {
      entityType: resolved.grain,
      entityId: resolved.entityId,
      providerAccountId: resolved.providerAccountId,
      // Derived from what the server just read, never from the request.
      expectedStatus: resolved.status,
      expectedCreativeId: resolved.creativeId,
      expectedParentId: resolved.parentId,
    },
    observed: {
      entityId: resolved.entityId,
      providerAccountId: resolved.providerAccountId,
      status: resolved.status,
      creativeId: resolved.creativeId,
      parentId: resolved.parentId,
      matchCount: resolved.matchCount,
    },
    killSwitchEngaged: false,
    checkedAt: new Date().toISOString(),
  });

  // A bid needs the account's own currency: the handler refuses without a
  // verified one, and an operator cannot enter a minor amount without knowing
  // its unit. Read here so the action is withheld rather than offered blind.
  const accountCurrency =
    action === "bid"
      ? await getMetaAccountContext(businessId)
          .then((context) =>
            normalizeMetaCurrencyCode(
              context.accountProfiles[resolved.providerAccountId]?.currency,
            ),
          )
          .catch(() => null)
      : null;

  // The exact body the real handler requires, built server-side. The browser
  // supplies none of it — only the operator choices the descriptor declares.
  const dispatch = buildDispatchDescriptor({
    businessId,
    target: {
      grain: resolved.grain,
      entityId: resolved.entityId,
      providerAccountId: resolved.providerAccountId,
      creativeId: resolved.creativeId,
      parentId: resolved.parentId,
    },
    action,
    accountCurrency,
    issuedAt: receipt.checkedAt,
  });

  await recordProductInstrumentationEvent({
    businessId,
    scope: "business",
    eventName: "guarded_action_preflight",
    surface: "meta_decision_inspector",
    outcome: "ok",
    provider: "meta",
    occurredAt: new Date().toISOString(),
  });

  if (!dispatch.ok) {
    // Withheld with a reason rather than offered as a control that could only
    // fail at the handler.
    return NextResponse.json(
      {
        contract: ZERO_BASE_DECISION_CONTRACT,
        receipt,
        decisionKey,
        action,
        target: resolved,
        withheld: { reason: dispatch.reason, message: dispatch.message },
        mutationUiEnabled: isMutationUiEnabled(),
        providerContacted: false,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({
    contract: ZERO_BASE_DECISION_CONTRACT,
    receipt,
    decisionKey,
    action,
    target: resolved,
    // The endpoint that action WOULD use, and the exact body it requires.
    // Naming them is not permission to call: the mutation UI flag gates the
    // control, and the handler re-resolves and re-checks everything before it
    // writes — a tampered descriptor fails closed there.
    endpoint,
    dispatch: dispatch.descriptor,
    mutationUiEnabled: isMutationUiEnabled(),
    // Persisted state only. Saying otherwise would claim a live check nobody ran.
    providerContacted: false,
    note:
      "Derived from persisted provider state. Meta was not contacted, and each action endpoint re-checks before it writes.",
  });
}

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
    contract?: string;
    decisionKey?: string;
    action?: string;
  } | null;

  // The decision-bound mode is a third branch on this one route. A second
  // preflight route would be a second answer to "is this safe to write", and
  // only one of them could be right.
  if (body?.contract === ZERO_BASE_DECISION_CONTRACT) {
    return decisionBoundPreflight(request, body);
  }

  // Canonical callers opt in explicitly, so every existing caller keeps its
  // exact behaviour. This adds a mode to the one preflight route rather than a
  // second route: two preflights would be two different answers to "is this
  // safe to write", and only one of them could be right.
  const zeroBase = body?.contract === "zero-base.v1";
  const rejectedExpectations = zeroBase
    ? stripClientExpectations(body as unknown as Record<string, unknown>).rejected
    : [];

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

  // Refused rather than silently ignored: a caller that believed its expected
  // state was honoured would otherwise get a pass it did not earn.
  if (rejectedExpectations.length > 0) {
    return NextResponse.json(
      {
        error: "client_expectations_rejected",
        message:
          "In zero-base.v1 the server derives the expected state. Remove: " +
          rejectedExpectations.join(", "),
        rejected: rejectedExpectations,
      },
      { status: 400 },
    );
  }

  const target: PreflightTarget = {
    entityType,
    entityId,
    providerAccountId,
    // In the canonical mode the server derives the expected state; a client
    // that can name what it expects can also name something that makes a stale
    // write look fresh. Legacy callers keep the existing behaviour.
    expectedStatus: zeroBase ? null : (body?.expectedStatus ?? null),
    expectedCreativeId: zeroBase ? null : (body?.expectedCreativeId ?? null),
    expectedParentId: zeroBase ? null : (body?.expectedParentId ?? null),
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
