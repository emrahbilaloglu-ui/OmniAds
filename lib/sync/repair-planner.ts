import { getDb } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import {
  getLatestSyncGateRecords,
  type SyncBlockerClass,
  type SyncGateRecord,
} from "@/lib/sync/release-gates";
import { reconcileSyncIncidentsFromRepairPlan } from "@/lib/sync/incidents";
import { resolveSyncControlPlaneKey } from "@/lib/sync/control-plane-key";
import { getRuntimeRegistryStatus } from "@/lib/sync/runtime-contract";

export type SyncRepairPlanMode = "dry_run" | "auto_execute" | "escalated_manual";
export type SyncRepairActionKind =
  | "stale_lease_reclaim"
  | "refresh_state"
  | "reschedule"
  | "replay_dead_letter"
  | "integrity_repair_enqueue";
export type SyncRepairSafetyClassification =
  | "safe_idempotent"
  | "safe_guarded"
  | "blocked";

export interface SyncRepairRecommendation {
  businessId: string;
  businessName: string | null;
  blockerClass: SyncBlockerClass | null;
  recommendedAction: SyncRepairActionKind;
  reason: string;
  beforeEvidence: Record<string, unknown>;
  expectedOutcome: string;
  safetyClassification: SyncRepairSafetyClassification;
}

export interface SyncRepairPlanRecord {
  id?: string | null;
  buildId: string;
  environment: string;
  providerScope: string;
  planMode: SyncRepairPlanMode;
  eligible: boolean;
  blockedReason: string | null;
  breakGlass: boolean;
  summary: string;
  recommendations: SyncRepairRecommendation[];
  emittedAt: string;
}

type ReleaseGateCanaryEvidence = {
  businessId: string;
  businessName: string | null;
  pass: boolean;
  blockerClass: SyncBlockerClass | null;
  evidence: {
    activityState?: string | null;
    progressState?: string | null;
    workerOnline?: boolean;
    queueDepth?: number;
    leasedPartitions?: number;
    retryableFailedPartitions?: number;
    deadLetterPartitions?: number;
    actionRequiredDeadLetterPartitions?: number;
    replayableDeadLetterPartitions?: number;
    unknownDeadLetterPartitions?: number;
    staleLeasePartitions?: number;
    reclaimCandidateCount?: number;
    staleRunCount24h?: number;
    repairBacklog?: number;
    validationFailures24h?: number;
    d1FinalizeNonTerminalCount?: number;
    stallFingerprints?: string[];
    recentTruthState?: string | null;
    priorityTruthState?: string | null;
    truthReady?: boolean;
  };
};

function nowIso() {
  return new Date().toISOString();
}

async function assertRepairPlanTablesReady(context: string) {
  await assertDbSchemaReady({
    tables: ["sync_repair_plans"],
    context,
  });
}

function toText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toInt(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasMeaningfulRecentProgress(row: ReleaseGateCanaryEvidence) {
  const progressState = row.evidence.progressState;
  const stallFingerprints = row.evidence.stallFingerprints ?? [];
  return (
    progressState === "partial_progressing" &&
    stallFingerprints.length === 0
  );
}

function normalizeCanaryRows(releaseGate: SyncGateRecord | null): ReleaseGateCanaryEvidence[] {
  const raw = Array.isArray(releaseGate?.evidence?.canaries) ? releaseGate?.evidence?.canaries : [];
  const rows: Array<ReleaseGateCanaryEvidence | null> = raw
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const candidate = row as Record<string, unknown>;
      const evidence =
        candidate.evidence && typeof candidate.evidence === "object"
          ? (candidate.evidence as Record<string, unknown>)
          : {};
      return {
        businessId: String(candidate.businessId ?? "").trim(),
        businessName: toText(candidate.businessName),
        pass: Boolean(candidate.pass),
        blockerClass:
          typeof candidate.blockerClass === "string"
            ? (candidate.blockerClass as SyncBlockerClass)
            : null,
        evidence: {
          activityState: toText(evidence.activityState),
          progressState: toText(evidence.progressState),
          workerOnline: typeof evidence.workerOnline === "boolean" ? evidence.workerOnline : undefined,
          queueDepth: toInt(evidence.queueDepth),
          leasedPartitions: toInt(evidence.leasedPartitions),
          retryableFailedPartitions: toInt(evidence.retryableFailedPartitions),
          deadLetterPartitions: toInt(evidence.deadLetterPartitions),
          actionRequiredDeadLetterPartitions: toInt(
            evidence.actionRequiredDeadLetterPartitions,
          ),
          replayableDeadLetterPartitions: toInt(
            evidence.replayableDeadLetterPartitions,
          ),
          unknownDeadLetterPartitions: toInt(evidence.unknownDeadLetterPartitions),
          staleLeasePartitions: toInt(evidence.staleLeasePartitions),
          reclaimCandidateCount: toInt(evidence.reclaimCandidateCount),
          staleRunCount24h: toInt(evidence.staleRunCount24h),
          repairBacklog: toInt(evidence.repairBacklog),
          validationFailures24h: toInt(evidence.validationFailures24h),
          d1FinalizeNonTerminalCount: toInt(evidence.d1FinalizeNonTerminalCount),
          stallFingerprints: Array.isArray(evidence.stallFingerprints)
            ? evidence.stallFingerprints.map((entry) => String(entry))
            : [],
          recentTruthState: toText(evidence.recentTruthState),
          priorityTruthState: toText(evidence.priorityTruthState),
          truthReady: typeof evidence.truthReady === "boolean" ? evidence.truthReady : undefined,
        },
      } satisfies ReleaseGateCanaryEvidence;
    });
  return rows.filter((row): row is ReleaseGateCanaryEvidence => Boolean(row?.businessId));
}

function buildRecommendation(
  row: ReleaseGateCanaryEvidence,
  providerLabel: string,
): SyncRepairRecommendation | null {
  const beforeEvidence = {
    activityState: row.evidence.activityState ?? null,
    progressState: row.evidence.progressState ?? null,
    queueDepth: row.evidence.queueDepth ?? 0,
    leasedPartitions: row.evidence.leasedPartitions ?? 0,
    retryableFailedPartitions: row.evidence.retryableFailedPartitions ?? 0,
    deadLetterPartitions: row.evidence.deadLetterPartitions ?? 0,
    actionRequiredDeadLetterPartitions:
      row.evidence.actionRequiredDeadLetterPartitions ?? 0,
    replayableDeadLetterPartitions: row.evidence.replayableDeadLetterPartitions ?? 0,
    unknownDeadLetterPartitions: row.evidence.unknownDeadLetterPartitions ?? 0,
    staleLeasePartitions: row.evidence.staleLeasePartitions ?? 0,
    reclaimCandidateCount: row.evidence.reclaimCandidateCount ?? 0,
    staleRunCount24h: row.evidence.staleRunCount24h ?? 0,
    repairBacklog: row.evidence.repairBacklog ?? 0,
    validationFailures24h: row.evidence.validationFailures24h ?? 0,
    d1FinalizeNonTerminalCount: row.evidence.d1FinalizeNonTerminalCount ?? 0,
    truthReady: row.evidence.truthReady ?? null,
    stallFingerprints: row.evidence.stallFingerprints ?? [],
  };

  if ((row.evidence.deadLetterPartitions ?? 0) > 0) {
    return {
      businessId: row.businessId,
      businessName: row.businessName,
      blockerClass: row.blockerClass,
      recommendedAction: "replay_dead_letter",
      reason: `Dead-lettered ${providerLabel} partitions are blocking release readiness for this canary.`,
      beforeEvidence,
      expectedOutcome: `Dead-letter partitions are replayed into the normal ${providerLabel} queue so publish eligibility can be re-evaluated.`,
      safetyClassification: "safe_guarded",
    };
  }

  if (
    (row.evidence.staleLeasePartitions ?? 0) > 0 ||
    (row.evidence.reclaimCandidateCount ?? 0) > 0
  ) {
    return {
      businessId: row.businessId,
      businessName: row.businessName,
      blockerClass: row.blockerClass,
      recommendedAction: "stale_lease_reclaim",
      reason:
        (row.evidence.staleLeasePartitions ?? 0) > 0
          ? `Stale ${providerLabel} leases are present and should be reclaimed before more work is admitted.`
          : `Active ${providerLabel} reclaim candidates are blocking fresh admission and should be cleaned up first.`,
      beforeEvidence,
      expectedOutcome:
        `Expired or reclaimable ${providerLabel} work is cleaned up so queued partitions become eligible for fresh admission.`,
      safetyClassification: "safe_guarded",
    };
  }

  if (
    (row.evidence.validationFailures24h ?? 0) > 0 ||
    (row.evidence.d1FinalizeNonTerminalCount ?? 0) > 0 ||
    (row.evidence.repairBacklog ?? 0) > 0
  ) {
    return {
      businessId: row.businessId,
      businessName: row.businessName,
      blockerClass: row.blockerClass,
      recommendedAction: "integrity_repair_enqueue",
      reason: "Authoritative validation or D-1 finalization backlog requires an integrity repair pass.",
      beforeEvidence,
      expectedOutcome: "A repair queue item is enqueued so authoritative checkpoints and publication pointers can converge.",
      safetyClassification: "safe_guarded",
    };
  }

  if (
    (row.evidence.queueDepth ?? 0) > 0 &&
    (row.evidence.leasedPartitions ?? 0) === 0 &&
    !hasMeaningfulRecentProgress(row)
  ) {
    return {
      businessId: row.businessId,
      businessName: row.businessName,
      blockerClass: row.blockerClass,
      recommendedAction: "reschedule",
      reason: `Queued ${providerLabel} work exists but no active leases are attached to the canary snapshot.`,
      beforeEvidence,
      expectedOutcome: `Queued ${providerLabel} work is re-admitted into the lease planner on the next worker cycle without changing deploy posture.`,
      safetyClassification: "safe_idempotent",
    };
  }

  if (
    !hasMeaningfulRecentProgress(row) &&
    (row.blockerClass === "stalled" ||
      row.blockerClass === "queue_blocked" ||
      row.evidence.truthReady === false)
  ) {
    return {
      businessId: row.businessId,
      businessName: row.businessName,
      blockerClass: row.blockerClass,
      recommendedAction: "refresh_state",
      reason: "Release readiness is blocked without a narrower queue mutation candidate.",
      beforeEvidence,
      expectedOutcome: "Business sync state is recomputed so the next evaluation uses fresh queue, checkpoint, and truth evidence.",
      safetyClassification: "safe_idempotent",
    };
  }

  return null;
}

function summarizePlan(input: {
  eligible: boolean;
  blockedReason: string | null;
  recommendations: SyncRepairRecommendation[];
}) {
  if (!input.eligible) {
    return `Sync repair dry-run blocked: ${input.blockedReason ?? "unknown"}.`;
  }
  if (input.recommendations.length === 0) {
    return "Sync repair dry-run found no safe recommendations for the current build.";
  }
  return `Sync repair dry-run proposed ${input.recommendations.length} recommendation(s).`;
}

export async function upsertSyncRepairPlanRecord(input: SyncRepairPlanRecord) {
  await assertRepairPlanTablesReady("sync_repair_plans:upsert");
  const sql = getDb();
  const rows = await sql`
    INSERT INTO sync_repair_plans (
      build_id,
      environment,
      provider_scope,
      plan_mode,
      eligible,
      blocked_reason,
      break_glass,
      summary,
      payload_json,
      emitted_at,
      updated_at
    )
    VALUES (
      ${input.buildId},
      ${input.environment},
      ${input.providerScope},
      ${input.planMode},
      ${input.eligible},
      ${input.blockedReason ?? null},
      ${input.breakGlass},
      ${input.summary},
      ${JSON.stringify({
        recommendations: input.recommendations,
      })}::jsonb,
      ${input.emittedAt},
      now()
    )
    ON CONFLICT (build_id, environment, provider_scope, plan_mode)
    DO UPDATE SET
      eligible = EXCLUDED.eligible,
      blocked_reason = EXCLUDED.blocked_reason,
      break_glass = EXCLUDED.break_glass,
      summary = EXCLUDED.summary,
      payload_json = EXCLUDED.payload_json,
      emitted_at = EXCLUDED.emitted_at,
      updated_at = now()
    RETURNING id
  ` as Array<{ id: string }>;
  return {
    ...input,
    id: rows[0]?.id ?? input.id ?? null,
  };
}

export async function getLatestSyncRepairPlan(input?: {
  buildId?: string;
  environment?: string;
  providerScope?: string;
}) : Promise<SyncRepairPlanRecord | null> {
  await assertRepairPlanTablesReady("sync_repair_plans:get_latest");
  const sql = getDb();
  const { buildId, environment, providerScope } = resolveSyncControlPlaneKey(input);
  const rows = await sql`
    SELECT
      id,
      build_id,
      environment,
      provider_scope,
      plan_mode,
      eligible,
      blocked_reason,
      break_glass,
      summary,
      payload_json,
      emitted_at
    FROM sync_repair_plans
    WHERE build_id = ${buildId}
      AND environment = ${environment}
      AND provider_scope = ${providerScope}
    ORDER BY emitted_at DESC
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  const payload =
    row.payload_json && typeof row.payload_json === "object"
      ? (row.payload_json as Record<string, unknown>)
      : {};
  return {
    id: row.id ? String(row.id) : null,
    buildId: String(row.build_id),
    environment: String(row.environment),
    providerScope: String(row.provider_scope),
    planMode:
      row.plan_mode === "auto_execute"
        ? "auto_execute"
        : row.plan_mode === "escalated_manual"
          ? "escalated_manual"
          : "dry_run",
    eligible: Boolean(row.eligible),
    blockedReason: toText(row.blocked_reason),
    breakGlass: Boolean(row.break_glass),
    summary: String(row.summary ?? ""),
    recommendations: Array.isArray(payload.recommendations)
      ? payload.recommendations as SyncRepairRecommendation[]
      : [],
    emittedAt:
      typeof row.emitted_at === "string"
        ? row.emitted_at
        : row.emitted_at instanceof Date
          ? row.emitted_at.toISOString()
          : nowIso(),
  };
}

export async function getSyncRepairPlanById(input: {
  id: string;
}): Promise<SyncRepairPlanRecord | null> {
  await assertRepairPlanTablesReady("sync_repair_plans:get_by_id");
  const sql = getDb();
  const rows = await sql`
    SELECT
      id,
      build_id,
      environment,
      provider_scope,
      plan_mode,
      eligible,
      blocked_reason,
      break_glass,
      summary,
      payload_json,
      emitted_at
    FROM sync_repair_plans
    WHERE id = ${input.id}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  const payload =
    row.payload_json && typeof row.payload_json === "object"
      ? (row.payload_json as Record<string, unknown>)
      : {};
  return {
    id: String(row.id),
    buildId: String(row.build_id),
    environment: String(row.environment),
    providerScope: String(row.provider_scope),
    planMode:
      row.plan_mode === "auto_execute"
        ? "auto_execute"
        : row.plan_mode === "escalated_manual"
          ? "escalated_manual"
          : "dry_run",
    eligible: Boolean(row.eligible),
    blockedReason: toText(row.blocked_reason),
    breakGlass: Boolean(row.break_glass),
    summary: String(row.summary ?? ""),
    recommendations: Array.isArray(payload.recommendations)
      ? (payload.recommendations as SyncRepairRecommendation[])
      : [],
    emittedAt:
      typeof row.emitted_at === "string"
        ? row.emitted_at
        : row.emitted_at instanceof Date
          ? row.emitted_at.toISOString()
          : nowIso(),
  };
}

export async function evaluateAndPersistSyncRepairPlan(input?: {
  buildId?: string;
  environment?: string;
  providerScope?: string;
  planMode?: SyncRepairPlanMode;
  persist?: boolean;
  releaseGate?: SyncGateRecord | null;
  runtimeRegistry?: Awaited<ReturnType<typeof getRuntimeRegistryStatus>> | null;
}) : Promise<SyncRepairPlanRecord> {
  const { buildId, environment, providerScope } = resolveSyncControlPlaneKey(input);
  const runtimeRegistry =
    input?.runtimeRegistry ??
    (await getRuntimeRegistryStatus({ buildId }).catch(() => null));
  const gateRecords =
    input?.releaseGate !== undefined
      ? {
          deployGate: null,
          releaseGate: input.releaseGate,
        }
      : // WITH the provider scope. Omitting it defaulted the read to `meta`, so
        // Google repair planning read META's release gate and planned Google
        // repairs from a verdict about a different provider — while the Google
        // gate it should have read sat unexamined.
        await getLatestSyncGateRecords({ buildId, environment, providerScope }).catch(
          () => ({
            deployGate: null,
            releaseGate: null,
          }),
        );
  const releaseGate = input?.releaseGate ?? gateRecords.releaseGate;
  const canaries = normalizeCanaryRows(releaseGate);
  const hasGoogleAdsAccountActionRequired =
    providerScope === "google_ads" &&
    canaries.some(
      (row) =>
        !row.pass && (row.evidence.actionRequiredDeadLetterPartitions ?? 0) > 0,
    );
  // A gate that carries NO canary evidence has told us nothing — it has not
  // told us everything is well.
  //
  // `canaries` is written into gate evidence in exactly one place
  // (lib/google-ads/control-plane-runtime.ts), and "Decouple release gate from
  // sync canaries" removed it from the Meta gate without updating this planner,
  // which still sources its entire work-list from that key. So for Meta the
  // list is permanently empty: no recommendation can ever be produced, no
  // repair runs through the plan path, and — because clearInactiveSyncIncidents
  // only runs when the plan is eligible — no incident is ever created OR
  // cleared. The Meta status surface then reports operationalSyncState
  // "healthy" with openIncidents 0 by construction, which is the most
  // dangerous shape a health signal can take: green because it is
  // disconnected, not because anything was checked.
  //
  // Treating that as "blocked, cannot evaluate" rather than "eligible, nothing
  // wrong" changes no repair behaviour — zero recommendations already meant
  // zero repairs — but it stops the silence being reported as health, and it
  // stops absence-of-evidence from clearing open incidents.
  const releaseGateCanaryEvidenceMissing =
    Boolean(releaseGate) && !Array.isArray(releaseGate?.evidence?.canaries);

  const blockedReason =
    !runtimeRegistry?.contractValid ||
    runtimeRegistry?.dbFingerprintMatch === false ||
    runtimeRegistry?.configFingerprintMatch === false
      ? "runtime_contract_invalid"
      : releaseGate?.verdict === "misconfigured" || releaseGate?.baseResult === "misconfigured"
        ? "release_gate_misconfigured"
        : releaseGate?.breakGlass
          ? "break_glass_active"
          : !releaseGate
            ? "release_gate_missing"
            : releaseGateCanaryEvidenceMissing
              ? "release_gate_canary_evidence_missing"
              : hasGoogleAdsAccountActionRequired
                ? "account_action_required"
                : null;
  const eligible = blockedReason == null;
  const providerLabel = providerScope === "google_ads" ? "Google Ads" : "Meta";
  const recommendations = eligible
    ? canaries
        .filter((row) => !row.pass)
        .map((row) => buildRecommendation(row, providerLabel))
        .filter((row): row is SyncRepairRecommendation => Boolean(row))
    : [];
  const record: SyncRepairPlanRecord = {
    id: null,
    buildId,
    environment,
    providerScope,
    planMode: input?.planMode ?? "dry_run",
    eligible,
    blockedReason,
    breakGlass: Boolean(releaseGate?.breakGlass),
    summary: summarizePlan({
      eligible,
      blockedReason,
      recommendations,
    }),
    recommendations,
    emittedAt: nowIso(),
  };
  if (input?.persist ?? true) {
    const persisted = await upsertSyncRepairPlanRecord(record);
    if (persisted.eligible) {
      await reconcileSyncIncidentsFromRepairPlan({
        buildId,
        environment,
        providerScope,
        repairPlan: persisted,
        releaseGate,
      }).catch(() => null);
    }
    return persisted;
  }
  return record;
}
