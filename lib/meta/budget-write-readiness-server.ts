/**
 * D088 C3 — the server read behind the budget write-readiness surface.
 *
 * `buildBudgetWriteReadiness` is pure and had no production caller: both
 * automation pages mounted the view with the default `null`, so the section
 * that carries the activation ceremony rendered "unavailable" forever and the
 * exact-account activation this correction persists would have been invisible.
 *
 * This is the one read that fills it. It is display-only and account-scoped:
 * it names the account automatic execution is actually enabled FOR, so an
 * operator on a second account can see that the activation they are looking at
 * is not theirs. A failed read yields `null` — the section renders that as
 * unavailable, never as ready.
 */
import { getDb } from "@/lib/db";
import {
  buildBudgetWriteReadiness,
  type BudgetWriteReadinessModel,
} from "@/lib/meta/budget-write-readiness";
import { readBudgetActivationServerRead }
  from "@/lib/meta/budget-activation-readiness-server";
import { readBudgetPreparation } from "@/lib/meta/budget-preparation-read";

export async function readBudgetWriteSurfaceReadiness(input: {
  businessId: string;
  providerAccountId: string | null;
}): Promise<BudgetWriteReadinessModel | null> {
  if (!input.businessId) return null;
  const accountId = input.providerAccountId ?? "";
  const [rows, activation, preparation] = await Promise.all([
    getDb().query(
      `SELECT auto_execution_enabled,
              auto_execution_provider_account_id,
              CASE WHEN EXISTS (
                SELECT 1 FROM memberships m
                 WHERE m.user_id = updated_by
                   AND m.business_id = meta_automation_business_controls.business_id
                   AND m.role = 'admin'
                   AND m.status = 'active'
              ) THEN updated_by::text ELSE NULL END AS enabling_admin_user_id
         FROM meta_automation_business_controls
        WHERE business_id = $1::uuid`,
      [input.businessId],
    ).catch(() => null) as Promise<Array<{
      auto_execution_enabled: boolean | null;
      auto_execution_provider_account_id: string | null;
      enabling_admin_user_id: string | null;
    }> | null>,
    readBudgetActivationServerRead({
      businessId: input.businessId,
      providerAccountId: accountId,
    }),
    /*
      PRE-DEPLOY AUDIT: what is already prepared, for the admin form that
      writes it. Read here rather than in the component so the values reach
      the surface as SERVER facts, and so a failed read arrives as `unknown`
      instead of as an empty form that looks like "nothing configured".
    */
    readBudgetPreparation({ businessId: input.businessId }),
  ]);
  if (rows === null) return null;

  const activatedProviderAccountId = rows[0]?.auto_execution_enabled === true
    ? rows[0]?.auto_execution_provider_account_id ?? null
    : null;
  const executionEnabled = activatedProviderAccountId !== null
    && activatedProviderAccountId === accountId;
  const activationReadyBlockers = [
    ...activation.verdict.blockers,
    ...(executionEnabled && !rows[0]?.enabling_admin_user_id
      ? ["enabling_actor_absent"]
      : []),
  ];

  return buildBudgetWriteReadiness({
    businessId: input.businessId,
    providerAccountId: accountId,
    /*
      No candidate request is offered here. A budget proposal is executed from
      its persisted row through the claim lifecycle, not from a surface-built
      request, so the section states why there is nothing to preview rather
      than assembling a request the executor would never see.
    */
    candidate: null,
    preflight: null,
    lastAttempt: null,
    preparation,
    runtime: {
      executionEnabled,
      proposalState: null,
      claimState: null,
      reconcileState: null,
      activationReadyBlockers,
      activatedProviderAccountId,
    },
  });
}
