import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDbSchemaReadiness, isMissingRelationError } from "@/lib/db-schema-readiness";
import type { IntegrationProviderType } from "@/lib/integrations";
import {
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
  upsertProviderAccountAssignments,
} from "@/lib/provider-account-assignments";
import {
  PROVIDER_ACCOUNT_SNAPSHOT_REQUIRED_TABLES,
  readProviderConnectionGenerationToken,
} from "@/lib/provider-account-snapshots";
import { ProviderAccountSelectionError } from "@/lib/provider-account-assignments";
import {
  MAX_SELECTED_ACCOUNTS,
  authorizeAssignmentMutation,
  resolveProviderConnectionAuthority,
  validateRequestedProviderAccounts,
  type AssignmentSelectionRefusal,
} from "@/lib/provider-assignment-authorization";
import { revokeAllProviderAccountSelection } from "@/lib/provider-selection-revocation";
import { describeSyncSafetyRefusal } from "@/lib/sync/safety-refusal";
import { withSchedulingAttempt } from "@/lib/sync/scheduling-attempt";

/**
 * One server-side service for provider account selection.
 *
 * The two handlers had drifted into two different security postures for one
 * operation. Meta checked that an integration row existed and accepted any
 * strings; Google checked a snapshot but ignored its staleness, its failure
 * state and the credential it was captured under. Neither authorised the caller
 * against the business at all.
 *
 * The order below is the contract, and each step is a precondition of the next:
 *
 *   1. tenant access on THIS business, at collaborator or above;
 *   2. a CURRENT connection: connected status, a usable credential, not expired;
 *   3. a bounded, well-formed, provider-shaped request;
 *   4. membership in a fresh successful discovery snapshot captured under THAT
 *      credential generation, resolved to the snapshot's CANONICAL ids;
 *   5. canonical mutation of exactly those ids, with an exact readback;
 *   6. a truthful response about what was saved and what was scheduled.
 *
 * Step 6 matters as much as the rest. Both handlers used to swallow the
 * post-commit scheduling failure and answer `{ success: true }`, so a disabled
 * lane, a capacity refusal or a broken enqueue all looked like a healthy,
 * fully-connected integration while nothing had been scheduled.
 */

export interface AssignmentSchedulingResult {
  /** Durably enqueued AND read back. Anything less is not `true`. */
  scheduled: boolean;
  detail: string;
  /** Structured refusal when a guard declined, rather than a flattened null. */
  refusal: ReturnType<typeof describeSyncSafetyRefusal> | null;
}

export interface AssignmentRouteConfig {
  provider: Extract<IntegrationProviderType, "meta" | "google">;
  label: string;
  requiredTables: readonly string[];
  snapshotFreshnessMs?: number;
  /**
   * Schedule the follow-up work and prove it landed. Must not throw: a
   * scheduling failure is a partial success to report, not an error that
   * discards a selection already committed.
   */
  schedule: (input: {
    businessId: string;
    accountIds: string[];
    /** The connection generation this selection was validated and written under. */
    connectionGeneration: string | null;
    /**
     * The immutable id of THIS scheduling attempt.
     *
     * Every partition this operation creates carries it, so the readback asks
     * "did I create this?" instead of "was something created for this account
     * after my clock said so?" — which a concurrent enqueue satisfies and clock
     * skew breaks.
     */
    schedulingAttemptId: string;
  }) => Promise<AssignmentSchedulingResult>;
}

function json(body: unknown, status: number) {
  return NextResponse.json(body as Record<string, unknown>, { status });
}

function describeSelectionRefusal(
  label: string,
  provider: string,
  refusal: AssignmentSelectionRefusal,
): NextResponse {
  switch (refusal.kind) {
    case "snapshot_missing":
      return json(
        {
          error: `${provider}_accounts_not_loaded`,
          message:
            "Accounts must be loaded before assignments can be saved. Refresh the account list and try again.",
          selectionSaved: false,
          syncScheduled: false,
        },
        409,
      );
    case "snapshot_not_fresh":
      return json(
        {
          error: "account_list_not_fresh",
          message:
            "The account list is out of date or failed to refresh. Refresh it and try again.",
          detail: refusal.detail,
          selectionSaved: false,
          syncScheduled: false,
        },
        409,
      );
    case "snapshot_connection_mismatch":
      return json(
        {
          error: "account_list_from_previous_connection",
          message:
            "This account list was loaded under a previous connection. Reconnect and refresh the account list before saving.",
          selectionSaved: false,
          syncScheduled: false,
        },
        409,
      );
    case "too_many_accounts":
      return json(
        {
          error: "too_many_accounts",
          message: `At most ${refusal.limit} accounts can be selected at once (received ${refusal.requested}).`,
          selectionSaved: false,
          syncScheduled: false,
        },
        400,
      );
    case "malformed_account_id":
      return json(
        {
          error: "invalid_account_id",
          message: "One or more account ids are not valid for this provider.",
          selectionSaved: false,
          syncScheduled: false,
        },
        400,
      );
    case "ambiguous_account_ids":
      console.warn(`[${label}] ambiguous selection`, { collisions: refusal.collisions });
      return json(
        {
          error: "ambiguous_account_selection",
          message:
            "The same account was selected under more than one spelling. Refresh the account list and select it once.",
          selectionSaved: false,
          syncScheduled: false,
        },
        400,
      );
    case "unknown_accounts":
      console.warn(`[${label}] rejected unknown account ids`, {
        invalidIds: refusal.invalidIds,
        snapshotCount: refusal.snapshotCount,
      });
      return json(
        {
          error: `invalid_${provider}_account_selection`,
          message:
            "One or more selected accounts are no longer available. Refresh the account list and try again.",
          selectionSaved: false,
          syncScheduled: false,
        },
        400,
      );
  }
}

export async function handleProviderAssignmentRequest(
  config: AssignmentRouteConfig,
  request: NextRequest,
  businessId: string,
): Promise<NextResponse> {
  if (!businessId) {
    return json(
      {
        error: "missing_business_id",
        message: "businessId path parameter is required.",
        selectionSaved: false,
        syncScheduled: false,
      },
      400,
    );
  }

  // 1. Tenant access FIRST — before the demo branch, before any credential
  //    read, before any database or provider call.
  const authorized = await authorizeAssignmentMutation({ request, businessId });
  if (!authorized.ok) return authorized.response;

  const body = (await request.json().catch(() => null)) as { account_ids?: unknown } | null;
  const accountIds = body?.account_ids;
  if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== "string")) {
    return json(
      {
        error: "invalid_payload",
        message: "account_ids must be an array of strings.",
        selectionSaved: false,
        syncScheduled: false,
      },
      400,
    );
  }
  if (accountIds.length > MAX_SELECTED_ACCOUNTS) {
    return json(
      {
        error: "too_many_accounts",
        message: `At most ${MAX_SELECTED_ACCOUNTS} accounts can be selected at once.`,
        selectionSaved: false,
        syncScheduled: false,
      },
      400,
    );
  }
  const requested = Array.from(
    new Set((accountIds as string[]).map((id) => id.trim()).filter(Boolean)),
  );

  if (await isDemoBusiness(businessId)) {
    return json({ success: true, assigned_accounts: requested, selectionSaved: true, syncScheduled: false }, 200);
  }

  // An EMPTY selection is a revocation, and revocation is a safety action.
  //
  // Sending it through the path below made "stop using my accounts" fail for
  // the same reasons a new selection should: a missing, disconnected or expired
  // integration, a stale discovery snapshot, a disabled lane. Every one of those
  // is a state in which the user is MORE likely to want to revoke, and refusing
  // leaves the product syncing accounts the owner asked it to stop touching.
  //
  // It is safe to exempt precisely because it can only reduce authority: no
  // binding is added, none is re-pointed, nothing is selected, no provider is
  // called and no work is enqueued. Tenant authorization above still applies.
  if (requested.length === 0) {
    try {
      const revocation = await revokeAllProviderAccountSelection({
        businessId,
        provider: config.provider,
      });
      console.warn(`[${config.label}] selection revoked`, {
        businessId,
        deselected: revocation.deselected.length,
        cancelledPartitions: revocation.cancelledPartitions,
      });
      return json(
        {
          success: true,
          assigned_accounts: [],
          selectionSaved: true,
          syncScheduled: false,
          revoked: true,
          deselectedAccounts: revocation.deselected,
          cancelledPartitions: revocation.cancelledPartitions,
          message:
            "Every account was deselected. No sync work remains queued for this business.",
        },
        200,
      );
    } catch (error) {
      console.error(`[${config.label}] revocation failed`, {
        businessId,
        message: error instanceof Error ? error.message : String(error),
      });
      return json(
        {
          error: "revocation_failed",
          message: "Could not deselect every account. Nothing was changed.",
          selectionSaved: false,
          syncScheduled: false,
        },
        500,
      );
    }
  }

  // 2. A CURRENT connection, not merely an integration row.
  const connection = await resolveProviderConnectionAuthority({
    businessId,
    provider: config.provider,
  });
  if (!connection.ok) {
    const status = connection.reason === "integration_not_found" ? 404 : 409;
    return json(
      {
        error: connection.reason,
        message:
          connection.reason === "integration_not_found"
            ? `${config.provider} integration not found for this business.`
            : "This integration is not currently usable. Reconnect it and try again.",
        selectionSaved: false,
        syncScheduled: false,
      },
      status,
    );
  }

  // 3 + 4. Bounded, well-formed, and present in a fresh snapshot taken under
  //        THIS credential generation. Returns the snapshot's canonical ids.
  let canonicalIds: string[] = [];
  if (requested.length > 0) {
    const validation = await validateRequestedProviderAccounts({
      businessId,
      provider: config.provider,
      requestedIds: requested,
      connectionFingerprint: connection.authority.connectionFingerprint,
      freshnessMs: config.snapshotFreshnessMs,
    });
    if (!validation.ok) {
      return describeSelectionRefusal(config.label, config.provider, validation.refusal);
    }
    // Persist what the PROVIDER calls these accounts, not what the caller typed.
    canonicalIds = validation.canonicalIds;
  }

  const readiness = await getDbSchemaReadiness({ tables: [...config.requiredTables] }).catch(
    () => null,
  );
  if (!readiness?.ready) {
    return json(
      {
        error: "schema_not_ready",
        message:
          "Account assignments are unavailable until request-external migrations are applied.",
        missingTables: readiness?.missingTables ?? [],
        checkedAt: readiness?.checkedAt ?? null,
        selectionSaved: false,
        syncScheduled: false,
      },
      503,
    );
  }

  // 5. Canonical mutation. `replaceProviderAccountSelection` holds the
  //    provider-global and business-provider advisory locks and reads the
  //    selection back inside the same transaction, so a partial selection can
  //    never be observed or reported as success.
  // The generation this selection was VALIDATED under, captured before the
  // write and enforced inside the write's own lock. A reconnect between
  // validation and write replaces the credential — and with it which accounts
  // are actually accessible — so committing anyway would persist a selection
  // nobody validated against the current connection.
  const validatedConnectionGeneration = await readProviderConnectionGenerationToken(
    businessId,
    config.provider,
  ).catch(() => null);

  let saved: string[];
  try {
    const row = await upsertProviderAccountAssignments({
      businessId,
      provider: config.provider,
      accountIds: canonicalIds,
      expectedConnectionGeneration: validatedConnectionGeneration,
    });
    saved = row.account_ids ?? [];
  } catch (error: unknown) {
    if (
      error instanceof ProviderAccountSelectionError &&
      error.code === "connection_generation_changed"
    ) {
      // Zero mutation, zero enqueue. The user reconnected mid-request; the
      // selection they were shown was validated against a connection that no
      // longer exists.
      return json(
        {
          error: "connection_changed",
          message: error.message,
          selectionSaved: false,
          syncScheduled: false,
        },
        409,
      );
    }
    const laneRefusal = describeSyncSafetyRefusal(error);
    if (laneRefusal) {
      // A lane or capacity refusal is not a server error and not a success.
      return json(
        {
          error: laneRefusal.kind,
          message: "Account selection is currently disabled.",
          refusal: laneRefusal,
          selectionSaved: false,
          syncScheduled: false,
        },
        503,
      );
    }
    if (isMissingRelationError(error, [...config.requiredTables])) {
      return json(
        {
          error: "schema_not_ready",
          message:
            "Account assignments are unavailable until request-external migrations are applied.",
          missingTables: [...config.requiredTables],
          checkedAt: new Date().toISOString(),
          selectionSaved: false,
          syncScheduled: false,
        },
        503,
      );
    }
    console.error(`[${config.label}] db write failed`, {
      businessId,
      message: error instanceof Error ? error.message : String(error),
    });
    return json(
      {
        error: "assignment_save_failed",
        message: "Could not save account assignments.",
        selectionSaved: false,
        syncScheduled: false,
      },
      500,
    );
  }

  // 6. Selection is durable. Scheduling is a SEPARATE outcome and is reported
  //    as one: a failure here leaves a saved selection with no work started,
  //    which is a 202, never a 200 with `success: true`.
  const { result: scheduling } = await withSchedulingAttempt((attemptId) =>
    config.schedule({
      businessId,
      accountIds: saved,
      connectionGeneration: validatedConnectionGeneration,
      schedulingAttemptId: attemptId,
    }),
  );
  if (!scheduling.scheduled) {
    console.warn(`[${config.label}] selection saved but scheduling did not complete`, {
      businessId,
      detail: scheduling.detail,
      refusal: scheduling.refusal,
    });
    return json(
      {
        success: false,
        assigned_accounts: saved,
        selectionSaved: true,
        syncScheduled: false,
        schedulingDetail: scheduling.detail,
        refusal: scheduling.refusal,
        message:
          "Your account selection was saved, but the first sync could not be scheduled. It will be retried; you can also retry from here.",
      },
      202,
    );
  }

  return json(
    {
      success: true,
      assigned_accounts: saved,
      selectionSaved: true,
      syncScheduled: true,
      schedulingDetail: scheduling.detail,
    },
    200,
  );
}

export const ASSIGNMENT_REQUIRED_TABLES = {
  meta: PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
  google: [
    ...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
    ...PROVIDER_ACCOUNT_SNAPSHOT_REQUIRED_TABLES,
  ],
} as const;
