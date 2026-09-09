/**
 * ONE ATTESTATION, USED BY THE AUTHORITY AND BY THE THING THAT HEALS IT.
 *
 * ── ROUND 16 ────────────────────────────────────────────────────────────────
 * `readMetaAuthorityBootstrapProbe` decided an endpoint was "linked" from three
 * facts: `capture_status = 'complete'`, a non-null `sync_run_id`, and that
 * run's `status = 'succeeded'`, over a rolling 36-hour `captured_at` window.
 *
 * The authority it exists to heal demands far more than that. It also requires
 * no `error_json`; the attempt matching this exact partition, business and
 * account; a partition that was not dead-lettered; the attempt finishing
 * strictly before the provider-local knowledge bound and its lifecycle
 * containing the receipt occurrence; the receipt clocks inside that bound;
 * freshness measured from `observedAt`; and an observation run whose scope,
 * completeness and reconstructed manifest counts actually agree.
 *
 * So the probe could call an endpoint healthy on a receipt the authority
 * refuses — a stale replay, a cross-account link, an errored capture, a
 * truncated manifest — and SUPPRESS the one-shot repair while every
 * purchase-budget hard action stayed on HOLD. A weaker predicate guarding a
 * stronger one is a blackout with extra steps.
 *
 * This module is that one predicate. The authority calls it and then filters
 * the entities it cares about; the bootstrap calls it and asks only whether it
 * passed. Neither owns a second copy, so they cannot drift apart again.
 *
 * SELECTION IS STATUS-BLIND. The newest receipt at or before the bound is
 * chosen first and judged afterwards, so a newer failure is never stepped over
 * to reach an older success — in the authority or in the bootstrap.
 */
import { getDb } from "@/lib/db";
import { classifyStaleTier } from "@/lib/creative-decision-engine/data-health";
import {
  META_CONFIG_OBSERVATION_ENDPOINT,
  readMetaCompleteManifestMembershipForReceipt,
  readMetaLatestObservationReceiptAsOf,
  type MetaEntityType,
  type MetaManifestMembership,
  type MetaObservationReceiptPointer,
} from "@/lib/meta/entity-state-history";
import type { MetaRecentEditAuthorityReason } from "@/lib/meta/recent-edit-authority";

export type MetaConfigObservationAttestation =
  | {
      ok: true;
      receipt: MetaObservationReceiptPointer;
      membership: MetaManifestMembership;
    }
  | {
      ok: false;
      reason: MetaRecentEditAuthorityReason;
      detail: string | null;
      /**
       * True when the refusal came from a READ that could not be performed at
       * all, rather than from evidence that was read and found wanting. The
       * bootstrap treats this as "unknown" and conservatively allows its
       * bounded repair attempt; the authority still holds either way.
       */
      unavailable: boolean;
    };

/**
 * Attest one account/entity-type's current-config observation at one bound.
 *
 * `entityIds` narrows only the returned membership set. Every validity check
 * above it is endpoint-level and identical whether one entity was requested or
 * none, which is what lets the bootstrap ask the same question the authority
 * asks without inventing an entity to ask about.
 */
export async function attestMetaConfigObservation(input: {
  businessId: string;
  providerAccountId: string;
  entityType: Extract<MetaEntityType, "campaign" | "adset">;
  /** min(evaluationNow, provider-local day end). Strict upper bound. */
  knowledgeEndExclusive: Date;
  entityIds: readonly string[];
}): Promise<MetaConfigObservationAttestation> {
  const endpoint = META_CONFIG_OBSERVATION_ENDPOINT[input.entityType];
  const refuse = (
    reason: MetaRecentEditAuthorityReason,
    detail: string | null = null,
    unavailable = false,
  ): MetaConfigObservationAttestation => ({
    ok: false,
    reason,
    detail,
    unavailable,
  });

  const receipt = await readMetaLatestObservationReceiptAsOf({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    entityType: input.entityType,
    endpoint,
    cutoff: input.knowledgeEndExclusive,
  }).catch(() => undefined);

  if (receipt === undefined) {
    return refuse("config_history_read_failed", null, true);
  }
  if (receipt === null) return refuse("observation_receipt_missing");
  // THE NEWEST ATTEMPT GOVERNS, WHATEVER ITS OUTCOME.
  if (receipt.captureStatus !== "complete" || receipt.hasError) {
    return refuse("observation_capture_not_complete", receipt.captureStatus);
  }

  // ── The selected receipt's own clocks, before anything downstream. ────────
  const knowledgeMs = input.knowledgeEndExclusive.getTime();
  const observedMs = new Date(receipt.observedAt).getTime();
  const capturedMs = new Date(receipt.capturedAt).getTime();
  if (
    !Number.isFinite(observedMs) ||
    !Number.isFinite(capturedMs) ||
    observedMs >= knowledgeMs ||
    capturedMs >= knowledgeMs
  ) {
    return refuse("receipt_clock_invalid");
  }

  // ── The exact sync attempt. ───────────────────────────────────────────────
  if (!receipt.syncRunId) return refuse("sync_run_unlinked");
  if (!receipt.syncRun) return refuse("sync_run_missing");
  if (
    receipt.syncRun.partitionId !== receipt.partitionId ||
    receipt.syncRun.businessId !== input.businessId ||
    receipt.syncRun.providerAccountId !== input.providerAccountId
  ) {
    return refuse("sync_run_mismatched");
  }
  if (receipt.syncRun.status !== "succeeded") {
    return refuse("sync_run_not_succeeded", receipt.syncRun.status);
  }
  if (!receipt.syncRun.finishedAt) return refuse("sync_run_unfinished");
  if (receipt.partitionStatus === "dead_letter") {
    return refuse("sync_partition_dead_letter");
  }
  const runStartedMs = receipt.syncRun.startedAt
    ? new Date(receipt.syncRun.startedAt).getTime()
    : Number.NaN;
  const runFinishedMs = new Date(receipt.syncRun.finishedAt).getTime();
  if (!Number.isFinite(runStartedMs) || !Number.isFinite(runFinishedMs)) {
    return refuse("sync_run_lifecycle_mismatch");
  }
  if (runFinishedMs >= knowledgeMs) {
    return refuse("sync_run_finished_after_knowledge");
  }
  if (capturedMs < runStartedMs || capturedMs > runFinishedMs) {
    return refuse("sync_run_lifecycle_mismatch");
  }

  // ── Freshness, from the PROVIDER-RESPONSE clock. ──────────────────────────
  const ageHours = (knowledgeMs - observedMs) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours < 0) {
    return refuse("receipt_clock_invalid");
  }
  if (classifyStaleTier(ageHours) !== "none") {
    return refuse("observation_receipt_stale");
  }

  // ── The manifest this receipt points at. ──────────────────────────────────
  const membership = await readMetaCompleteManifestMembershipForReceipt({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    entityType: input.entityType,
    endpoint,
    observationRunId: receipt.runId,
    expectedProviderRowCount: receipt.providerRowCount,
    receiptCapturedAt: receipt.capturedAt,
    knowledgeEndExclusive: input.knowledgeEndExclusive,
    entityIds: input.entityIds,
  }).catch(() => null);
  if (membership === null) {
    return refuse("config_history_read_failed", null, true);
  }
  if (!membership.ok) {
    return refuse("observation_manifest_unusable", membership.refusal);
  }
  return { ok: true, receipt, membership };
}

/**
 * ── ROUND 16: THE BOOTSTRAP PROBE, ON THE SAME CONTRACT ─────────────────────
 *
 * Round 15's probe asked a weaker question than the authority — complete
 * status, a non-null link, a succeeded run, over a rolling 36-hour
 * `captured_at` window it called "today". Each of those gaps is a way for a
 * receipt the authority REFUSES to suppress the repair that would replace it:
 * an errored capture, a cross-account link, an attempt that finished after the
 * cutoff, a stale replay, a truncated manifest.
 *
 * It now runs the identical attestation, at the real provider-local bound, for
 * both endpoints the authority reads.
 *
 * CONSERVATIVE ON UNKNOWN. A refusal that came from a read which could not be
 * performed is not evidence that the account is healthy, so it does NOT
 * suppress the bounded repair. The authority holds in that case either way, so
 * allowing one scoped refetch is the safe direction.
 */
export async function readMetaAuthorityBootstrapProbe(input: {
  businessId: string;
  providerAccountId: string;
  /** The provider-local current-day bound: min(evaluationNow, day end). */
  knowledgeEndExclusive: Date;
}): Promise<{
  campaignReceiptLinked: boolean;
  adsetReceiptLinked: boolean;
}> {
  const [campaign, adset] = await Promise.all(
    (["campaign", "adset"] as const).map((entityType) =>
      attestMetaConfigObservation({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        entityType,
        knowledgeEndExclusive: input.knowledgeEndExclusive,
        // Endpoint-level question: no entity is being asked about, and every
        // validity check above membership is identical either way.
        entityIds: [],
      }),
    ),
  );
  /*
    `unavailable` means the read failed, not that the evidence was bad. Treating
    it as "linked" would suppress recovery on exactly the accounts whose
    provenance cannot be established.
  */
  const healthy = (attestation: MetaConfigObservationAttestation) =>
    attestation.ok === true;

  return {
    campaignReceiptLinked: healthy(campaign),
    adsetReceiptLinked: healthy(adset),
  };
}


/**
 * ── ROUND 18, ITEM A1: ONE ATOMIC, BOUNDED CLAIM ────────────────────────────
 *
 * Round 17 read the count, compared it to the bound, and then inserted
 * `MAX(attempt_no) + 1` — three statements with two gaps. Two workers reaching
 * the gap together both read 2, both decided they were under the bound, and
 * both proceeded: the ledger ended at 4 and two provider calls were made on a
 * budget of three.
 *
 * This is one statement. The bound lives in the `HAVING`, the slot is taken by
 * the unique constraint, and the caller may proceed ONLY if a row comes back
 * from `RETURNING`. Nothing returns means one of two things — the budget is
 * spent, or another worker took this slot — and both are "do not call the
 * provider", so they do not need to be told apart.
 *
 * THROWS on a read/write failure, which the caller treats as "do not call":
 * an unrecorded attempt is how a bounded retry becomes a loop.
 */
export async function claimMetaAuthorityBootstrapAttempt(input: {
  businessId: string;
  providerAccountId: string;
  /** `YYYY-MM-DD` in the account's own calendar. */
  providerLocalDay: string;
  maxAttempts: number;
}): Promise<{ claimed: boolean; attemptNo: number | null }> {
  const sql = getDb();
  const rows = await sql<{ attempt_no: number }>`
    INSERT INTO meta_authority_bootstrap_attempts (
      business_id, provider_account_id, provider_local_day, attempt_no
    )
    SELECT ${input.businessId}, ${input.providerAccountId},
           ${input.providerLocalDay}::date,
           COALESCE(MAX(existing.attempt_no), 0) + 1
      FROM meta_authority_bootstrap_attempts existing
     WHERE existing.business_id = ${input.businessId}
       AND existing.provider_account_id = ${input.providerAccountId}
       AND existing.provider_local_day = ${input.providerLocalDay}::date
    HAVING COALESCE(MAX(existing.attempt_no), 0) < ${input.maxAttempts}
    ON CONFLICT (business_id, provider_account_id, provider_local_day, attempt_no)
      DO NOTHING
    RETURNING attempt_no
  `;
  const attemptNo = rows[0]?.attempt_no ?? null;
  return { claimed: typeof attemptNo === "number", attemptNo };
}

/**
 * How many bootstrap attempts this exact account has already spent today.
 *
 * Reads the ledger and nothing else. Throws on failure so the caller fails
 * closed: a counter that cannot be read is not a counter that reads zero.
 */
export async function readMetaAuthorityBootstrapAttemptCount(input: {
  businessId: string;
  providerAccountId: string;
  providerLocalDay: string;
}): Promise<number> {
  const sql = getDb();
  const rows = await sql<{ attempts: string }>`
    SELECT COALESCE(MAX(attempt_no), 0)::text AS attempts
      FROM meta_authority_bootstrap_attempts
     WHERE business_id = ${input.businessId}
       AND provider_account_id = ${input.providerAccountId}
       AND provider_local_day = ${input.providerLocalDay}::date
  `;
  const attempts = Number(rows[0]?.attempts ?? Number.NaN);
  if (!Number.isFinite(attempts)) {
    throw new Error("meta_authority_bootstrap_attempt_count_unreadable");
  }
  return attempts;
}
