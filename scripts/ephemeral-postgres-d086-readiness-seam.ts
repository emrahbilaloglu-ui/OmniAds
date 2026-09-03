#!/usr/bin/env node
/**
 * D086 — the local PostgreSQL readiness seam.
 *
 * Correction 7 rejected this module's previous body outright: it built every
 * case from hand-written INSERTs against a minimal hand-written schema, so its
 * "evidence" reconciled the read model against rows no deploy would ever
 * produce, seeded only full manifests, never touched `meta_entity_tombstones`,
 * and performed its "reversed insertion" in the same physical order as the
 * forward one.
 *
 * There is now ONE evidence producer, and it starts where a real sync starts:
 * `scripts/d086-capture-to-readiness-e2e.ts` boots a cluster, applies the REAL
 * migration registry, maps raw Meta responses with the REAL mappers, writes
 * them with the REAL persistence functions, and only then reads readiness. This
 * module is the seam's stable entry point over that run, so the artifact and
 * the tests keep one name for the local verification while the mechanics stay
 * in a single place.
 */
import {
  D086_E2E_EVIDENCE_PATH,
  D086_E2E_REQUIRED_CASES,
  runD086CaptureToReadinessE2e,
} from "@/scripts/d086-capture-to-readiness-e2e";

/** The seam's exact contract: every case bound to the verdict it must produce. */
export const REQUIRED_SEAM_CASES: ReadonlyArray<{
  name: string; status: string; blocker: string | null;
}> = D086_E2E_REQUIRED_CASES.map(({ name, status, blocker }) => ({ name, status, blocker }));

/** Where the generated evidence document is written, for the artifact to pin. */
export const D086_SEAM_EVIDENCE_PATH = D086_E2E_EVIDENCE_PATH;

export interface D086SeamReport {
  ok: boolean;
  serverVersion: string;
  populatedReads: Array<{
    name: string; status: string; blocker: string | null; mechanics: string;
  }>;
  indexes: Array<{ name: string; definition: string; carriesFullRank: boolean }>;
  capabilityProbe: Record<string, unknown>;
  failures: string[];
}

/**
 * The exact fragments each required index must contain to serve the order the
 * query actually writes. Correction 8 removed the heartbeat-effective
 * expression index along with the mutable predicate it served: a historical
 * cutoff now reads the immutable payload clocks.
 */
const INDEX_FULL_RANK_FRAGMENTS: Record<string, readonly string[]> = {
  idx_meta_entity_observation_runs_d086_payload: [
    "business_id", "provider_account_id", "entity_type", "endpoint",
    "captured_at DESC", "observed_at DESC", "id DESC",
  ],
  idx_meta_entity_state_history_d086_latest: [
    "business_id", "provider_account_id", "entity_type", "entity_id",
    "captured_at DESC", "created_at DESC", "id DESC",
  ],
  meta_entity_observation_receipts_occurrence: [
    "partition_id", "entity_type", "endpoint", "captured_at",
  ],
  idx_meta_entity_observation_receipts_cohort: [
    "partition_id", "captured_at DESC", "id DESC",
  ],
  idx_meta_entity_observation_receipts_freshness: [
    "entity_type", "endpoint", "captured_at DESC", "id DESC",
  ],
  idx_meta_entity_tombstones_d086_latest: [
    "entity_id", "captured_at DESC", "id DESC",
  ],
};

export async function runD086PostgresSeam(): Promise<D086SeamReport> {
  const report = await runD086CaptureToReadinessE2e();
  const indexes = report.indexCatalog.map((row) => {
    const flattened = row.indexdef.replace(/\s+/g, " ");
    const fragments = INDEX_FULL_RANK_FRAGMENTS[row.indexname] ?? [];
    return {
      name: row.indexname,
      definition: row.indexdef,
      carriesFullRank:
        fragments.length > 0
        && fragments.every((fragment) => flattened.includes(fragment.replace(/\s+/g, " "))),
    };
  });
  return {
    ok: report.ok,
    serverVersion: report.postgresVersion,
    populatedReads: report.cases.map(({ name, status, blocker, mechanics }) =>
      ({ name, status, blocker, mechanics })),
    indexes,
    capabilityProbe: report.capabilityProbe,
    failures: report.failures,
  };
}

if (process.argv[1] && process.argv[1].endsWith("ephemeral-postgres-d086-readiness-seam.ts")) {
  runD086PostgresSeam().then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  });
}
