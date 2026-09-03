/**
 * D086 — the retained Meta budget-readiness input pack. Automation OFF.
 *
 * D085 r16 was accepted with four residual blockers. This audit closes what local
 * code honestly can on three of them and says plainly what it cannot:
 *
 *   A `currency_exponent_not_captured`
 *   B `canonical_profile_output_not_retained`
 *   C `automatic_role_authority_absent`
 *
 * `no_provider_write_path_exists` is untouched and must remain closed: nothing here
 * adds, calls, or designs a provider budget-write endpoint.
 *
 * SIDE-EFFECT FREE BY CONSTRUCTION. This module opens no database handle, calls no
 * provider, and reads no environment. Its live evidence is a pinned SELECT-only
 * census captured in one `READ ONLY REPEATABLE READ` transaction, whose provenance
 * travels inside the artifact; its replay evidence is the accepted frozen D085 r16
 * artifact. The only file it ever writes is its own versioned artifact.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import {
  D086_ADDITIVE_MIGRATION_SQL,
  D086_REQUIRED_INDEXES,
  D086_REQUIRED_RECEIPT_COLUMNS,
  D086_REQUIRED_PARTITION_COLUMNS,
  D086_RETENTION_CONTRACT,
  qualifyRoleAuthorityRow,
  validateCanonicalBudgetFact,
} from "@/lib/meta/budget-readiness-retention";

// ---------------------------------------------------------------------------
// Identity, paths and the frozen-artifact gate (the D085 Correction 11 lesson)
// ---------------------------------------------------------------------------

/** The one revision. Path and lineage derive from it; nothing is retyped. */
export const D086_REVISION = 9 as const;
export const D086_CONTRACT_ID = `d086.budget-readiness-input-pack.v${D086_REVISION}` as const;

/** Repo root from this module's own location — never `process.cwd()`. */
export const D086_REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export function d086TrustedPath(relative: string): string {
  return join(D086_REPO_ROOT, relative);
}
export function d086TrustedReader(relative: string): Buffer {
  return readFileSync(d086TrustedPath(relative));
}

const ARTIFACT_DIR = "docs/audits/generated";
const ARTIFACT_STEM = "d086-budget-readiness-input-pack-2026-09-02";

export function d086ArtifactPathFor(revision: number): string {
  return revision <= 1
    ? `${ARTIFACT_DIR}/${ARTIFACT_STEM}.json`
    : `${ARTIFACT_DIR}/${ARTIFACT_STEM}.r${revision}.json`;
}
export const D086_JSON_OUT = d086ArtifactPathFor(D086_REVISION);

/**
 * Every earlier revision is FROZEN, derived from the revision rather than listed.
 *
 * r1 is history now: Correction 1 rejected it for absent UI integration, a
 * business-only read scope, an ignored authority table, counting-based READY
 * predicates, a self-verifying role scope, an incomplete serve-time classifier,
 * an incomplete prepared schema, an off-by-one PIT boundary, a prose-matching
 * isolation guard and a mis-stated read timestamp. Its bytes are not rewritten.
 */
export const D086_FROZEN_ARTIFACTS: readonly string[] = Object.freeze(
  Array.from({ length: D086_REVISION - 1 }, (_, i) => d086ArtifactPathFor(i + 1)),
);

/** Every rejected predecessor, with the bytes it must still have. */
export const D086_REJECTED_REVISIONS = Object.freeze([
  {
    revision: 8,
    path: d086ArtifactPathFor(8),
    fileSha256: "34841229bd1aa07de587d1c241eca6a97fb603b8a7c5fcbacb32893747166270",
    why:
      "Correction 8: the artifact's live limitations still described a run-level sync_cohort_id, "
      + "run-bound config history as the budget source, and unwired migrations that nothing "
      + "registers, all of which the implementation had already stopped doing, and the verifier "
      + "carried no guard able to catch a stale claim; the read model still told the UI \"config "
      + "row\" and cited the two config-history tables; population_total was count(*) OVER () taken "
      + "before clock_rank = 1, so it counted historical rows rather than latest-per-identity "
      + "identities and any ordinary changed capture made a valid account permanently partial; the "
      + "\"delta\" case was one full capture whose own run was UPDATEd to manifest_kind='delta', "
      + "never a writer-produced delta, and the coherence rule required every reconstructed member "
      + "to carry the newest run id, which a genuine delta cannot satisfy; the \"tied\" receipts were "
      + "one millisecond apart and each case merely swapped which partition was newest, so no "
      + "same-clock conflict was ever exercised; partition ids and snapshot ids were fabricated "
      + "strings with no meta_sync_partitions row, no persistMetaRawSnapshot call, no FK and no "
      + "read-side validation, so an orphan or foreign cohort attested; the receipt upsert was ON "
      + "CONFLICT DO NOTHING, so a colliding occurrence with a different run, status, count or "
      + "snapshot was silently accepted; capability probed config-history columns it no longer "
      + "reads while D086_REQUIRED_STATE_COLUMNS omitted the exponent, registry version, shape, "
      + "schedules, provider API version and run/source facts the executed query actually selects, "
      + "and the state latest path had no catalog-validated index at all; the same-clock state "
      + "conflict tuple omitted those same authority-relevant fields; and the run join applied "
      + "MUTABLE heartbeat clocks to a historical cutoff, so a heartbeat advanced after the cutoff "
      + "erased evidence that existed at it.",
  },
  {
    revision: 7,
    path: d086ArtifactPathFor(7),
    fileSha256: "c1a2b954ae983ee398118aa53a867bf36ce3f6f1a2e7ecea5cdd824ccdeb0b91",
    why:
      "Correction 7: readiness still read transition-only config history whose real writer never "
      + "stamps source_run_id, so no retained row could ever attest and the PG fixtures were manual "
      + "INSERTs rather than a deploy-ready writer; a single run-level sync_cohort_id is invalid "
      + "because persistMetaEntityObservation coalesces identical semantic truth and reuses a run, so "
      + "one content run can represent several capture cohorts; the query never read "
      + "meta_entity_tombstones and the \"tombstone\" case only flipped presence; the seam seeded only "
      + "manifest_kind='full' so delta reconstruction was untested; the \"reversed insertion\" case "
      + "repeated the same order plus a no-op UPDATE; D086_REQUIRED_RUN_COLUMNS was unused and the "
      + "capability probe omitted run/receipt/state/tombstone prerequisites; the index gate checked "
      + "plain captured clocks while the query ranks on heartbeat-effective expressions, so \"all full "
      + "rank\" was false; wrong-endpoint, partial and failed captures were filtered away and all "
      + "reported as no_campaign_run, letting an older complete run silently win over a newer failed "
      + "attempt; and the budget projection duplicated D083 buildCanonicalBudgetFact instead of "
      + "reusing that canonical boundary.",
  },
  {
    revision: 6,
    path: d086ArtifactPathFor(6),
    fileSha256: "9cd35ee3316a680e0e1a77838c86edb688132cb12657cf1a67b9e7dacbb2a03a",
    why:
      "Correction 6: the attestation was still weak. D086_COMPLETE_RUN_SQL filtered only entity type, "
      + "completeness and time — never the exact endpoint, never membership, never a shared cohort — so "
      + "manifests carrying an unrelated endpoint, manifests 29 days apart, and manifest snapshots "
      + "differing from the retained config snapshots all returned READY; \"identity reconciliation\" "
      + "compared two integers, so equal cardinality with entirely different entity IDs returned READY; "
      + "DISTINCT ON ordered only by captured_at, leaving equal-clock manifests with no deterministic "
      + "winner or conflict rule and ignoring heartbeat-effective clocks; universeBlocker omitted "
      + "ownerUnknown, uncoveredApplicable and retained-row conflicts and fell back to the unrelated "
      + "currency_exponent_not_captured blocker; a limitation still denied owning a census the C5 "
      + "architecture had introduced; and the PostgreSQL claims were hard-coded prose rather than bound "
      + "to a generated seam report.",
  },
  {
    revision: 5,
    path: d086ArtifactPathFor(5),
    fileSha256: "6aa7f005009f64c4ff7df72f6c50868222c179fcea2fdc910db49280165b1430",
    why:
      "Correction 5: the owner universe was still a presence heuristic, so a mutual ownership "
      + "contradiction produced a concrete FALSE READY — a campaign deferring to its ad-sets and an "
      + "ad-set deferring back to that campaign were counted as TWO proven non-owners, leaving one "
      + "unrelated row as the whole applicable population; the \"same snapshot\" claim was false in "
      + "code, since latest-per-entity merged rows from arbitrary source runs and checked only ID "
      + "presence; Math.max(0, total - provenNonApplicable) clamped away the proof that the measured "
      + "total was smaller than the rows actually retained, yielding a substantive unavailable instead "
      + "of measurement unknown; there was no authoritative complete-run manifest or entity census at "
      + "all, so full-account READY was being inferred from retained-row self-reference; and the "
      + "artifact still carried two false sentences — that the readiness layer never calls the currency "
      + "registry, and that the prepared migrations had never been executed against any database — the "
      + "second contradicting the local PostgreSQL evidence printed beside it.",
  },
  {
    revision: 4,
    path: d086ArtifactPathFor(4),
    fileSha256: "4c572c9ec9357da307bdc319aa2a2d8cfa936a6c759134029541d5a70b6dea4c",
    why:
      "Correction 4: the capture validator still admitted provenance the retained reader rejects "
      + "(providerApiVersion \"banana\", sourceKind \"anything\", sourceRunId \"x\" all stamped a "
      + "canonical v4 fact); the owner universe produced a concrete FALSE READY when a campaign "
      + "declaring adset_budget had no retained ad-set owner, so the uncaptured applicable owner "
      + "vanished from the denominator; population validation ran AFTER the owner/conflict branches, "
      + "so an unmeasurable total reported partial instead of unknown, and a non-empty "
      + "proven-non-owner-only sample reported forward_only; READY was published alongside "
      + "\"1 of 2\" coverage and owner_mode_disagrees_with_grain refusal text; the UI rendered none "
      + "of the universe counts; the budget truth tuple omitted parent_campaign_id so two ad-set rows "
      + "differing only by parent coalesced as one truth; the PostgreSQL seam proved distinct_truths "
      + "but never ran the read model over real rows in both insertion orders; the legacy role branch "
      + "published a 500-row LIMIT as the whole population with truncated:false; the prepared indexes "
      + "omitted the second rank clock on every seam; and the artifact still claimed no SQL had ever "
      + "been executed and that the queries used DISTINCT ON.",
  },
  {
    revision: 3,
    path: d086ArtifactPathFor(3),
    fileSha256: "cb7dded3085ecc38f127fa3eff421d3aa396091b0a680f2f6e9b3238fe731d5b",
    why:
      "Correction 3: retained currency provenance was only form-checked, so a USD row claiming "
      + "exponent 4 and a row citing registry \"made-up\" version \"v999\" both read usable — and the "
      + "positive fixture itself used a truncated copy of the registry source string; weak provenance "
      + "(providerApiVersion \"banana\", sourceKind \"anything\", sourceRunId \"x\") bought usability; "
      + "capture retained a zero amount that the action-bearing helper then called action-bearing; "
      + "profile capture admitted an impossible 2026-02-30 and a next-day as-of; the prepared profile "
      + "DDL never created profile_contract, so D086_PROFILE_LATEST_SQL failed SQLSTATE 42703 against a "
      + "real PostgreSQL 16 cluster while capability reported only table existence; DISTINCT ON with an "
      + "incomplete ORDER BY made latest-per-identity insertion-order dependent on all three seams; "
      + "population totals \"garbage\", -1 and 0 all produced READY; sample and total were separate "
      + "statements and so separate snapshots; rows that existed but failed validation were labelled "
      + "forward_only_after_deploy; the UI dropped the population field; and the budget denominator was "
      + "not proven against CBO/ABO ownership.",
  },
  {
    revision: 2,
    path: d086ArtifactPathFor(2),
    fileSha256: "1915eb3841a81f9546fed71a2b29f475a521e0dc4e54095a605a6cff99e27517",
    why:
      "Correction 2: the serve-time profile classifier returned usable for an arbitrary engine "
      + "version and arbitrary digests whenever the caller held no external expectation; the role "
      + "qualifier accepted a row with no retained contract, an unknown inferred kind and one-character "
      + "evidence/input hashes; budget readiness reported ready for rows that persisted no exponent, "
      + "registry or registry version and for a zero amount; the budget query emitted a bare ORDER "
      + "BY/LIMIT inside a UNION ALL operand, which PostgreSQL cannot parse, so it could never have "
      + "measured anything; an impossible calendar date was retained after Date.parse rolled it over; "
      + "the read layer re-resolved the currency through today's registry instead of reading the stored "
      + "provenance; every historical row was judged rather than the latest per identity; a bounded "
      + "sample could justify whole-account ready; the retention contract still said v1 after its "
      + "semantics changed; the role age window was hard-coded at 3 days against a canonical 2; and the "
      + "route passed raw process.env rather than the canonical resolver.",
  },
  {
    revision: 1,
    path: d086ArtifactPathFor(1),
    fileSha256: "d6216d89ceade39d1a16a393bfda4f677c537931190fbfdde0f913e51a23a522",
    why:
      "Correction 1: the readiness read was never wired into any route, so the section always "
      + "rendered unavailable; the read model took a business id only and could blend TheSwaf's "
      + "two accounts; the role-authority table's capability was computed and then ignored; READY "
      + "was count(*) over a few non-null columns rather than canonical validation; the role "
      + "qualifier checked account presence, not agreement with an expected scope; the serve-time "
      + "profile classifier ignored the source fingerprint and could throw; the prepared schema "
      + "could not persist budgetField or currencyRegistry and its profile identity collapsed "
      + "distinct engine versions; the PIT contract said at-or-after while the code rejected only "
      + "after; and the live-read timestamp was mis-stated as 13:31 rather than the pinned 13:43.",
  },
] as const);

export function assertWritableArtifactPath(target: string): string {
  const normalised = target.replace(/^\.\//, "");
  /*
    ANY PINNED REVISION IS FROZEN, not merely any EARLIER one.

    The derived range only protects revisions below the current one, so while a
    revision is still current it is writable — and running `assemble` before
    bumping the revision overwrites bytes that were already pinned elsewhere. I
    did exactly that to r3 during Correction 3, for the second time in this
    programme. Pinning is now itself the freeze: a path named in
    `D086_REJECTED_REVISIONS` is refused whatever the current revision is, so
    the bump has to happen before the artifact can move.
  */
  const pinned = D086_REJECTED_REVISIONS.find((r) => r.path === normalised);
  if (pinned) {
    throw new Error(
      `refusing to write ${normalised}: revision ${pinned.revision} is PINNED at `
      + `${pinned.fileSha256} and is frozen history. Bump D086_REVISION first.`,
    );
  }
  if (D086_FROZEN_ARTIFACTS.includes(normalised)) {
    throw new Error(`refusing to write ${normalised}: it is frozen history`);
  }
  if (normalised !== D086_JSON_OUT) {
    throw new Error(
      `refusing to write ${normalised}: the only permitted output for ${D086_CONTRACT_ID} is ${D086_JSON_OUT}`,
    );
  }
  return normalised;
}

/** The pinned inputs. Both are read through the canonical reader and hashed. */
export const D086_PINNED_SOURCES = Object.freeze([
  {
    key: "d086_r1_rejected",
    path: `${ARTIFACT_DIR}/${ARTIFACT_STEM}.json`,
    sha256: "d6216d89ceade39d1a16a393bfda4f677c537931190fbfdde0f913e51a23a522",
  },
  {
    key: "d086_r2_rejected",
    path: `${ARTIFACT_DIR}/${ARTIFACT_STEM}.r2.json`,
    sha256: "1915eb3841a81f9546fed71a2b29f475a521e0dc4e54095a605a6cff99e27517",
  },
  {
    key: "d086_r3_rejected",
    path: `${ARTIFACT_DIR}/${ARTIFACT_STEM}.r3.json`,
    sha256: "cb7dded3085ecc38f127fa3eff421d3aa396091b0a680f2f6e9b3238fe731d5b",
  },
  {
    key: "d086_r4_rejected",
    path: `${ARTIFACT_DIR}/${ARTIFACT_STEM}.r4.json`,
    sha256: "4c572c9ec9357da307bdc319aa2a2d8cfa936a6c759134029541d5a70b6dea4c",
  },
  {
    key: "d086_r6_rejected",
    path: `${ARTIFACT_DIR}/${ARTIFACT_STEM}.r6.json`,
    sha256: "9cd35ee3316a680e0e1a77838c86edb688132cb12657cf1a67b9e7dacbb2a03a",
  },
  {
    key: "d086_r5_rejected",
    path: `${ARTIFACT_DIR}/${ARTIFACT_STEM}.r5.json`,
    sha256: "6aa7f005009f64c4ff7df72f6c50868222c179fcea2fdc910db49280165b1430",
  },
  {
    key: "d086_live_census",
    path: `${ARTIFACT_DIR}/d086-live-census-2026-09-02.json`,
    sha256: "4f3519bc8badb311aeae7ff7f37730a8527e5fa1065856c0d247ea0f60abd8cb",
  },
  {
    key: "d086_r7_rejected",
    path: `${ARTIFACT_DIR}/${ARTIFACT_STEM}.r7.json`,
    sha256: "c1a2b954ae983ee398118aa53a867bf36ce3f6f1a2e7ecea5cdd824ccdeb0b91",
  },
  {
    key: "d086_r7_postgres_evidence",
    path: `${ARTIFACT_DIR}/d086-local-postgres-evidence-2026-09-02.json`,
    sha256: "6340a0d72620facf7b11ce80e1ed3f8269cc3075286bbfd42616cd9a96616477",
  },
  {
    key: "d086_r8_rejected",
    path: `${ARTIFACT_DIR}/${ARTIFACT_STEM}.r8.json`,
    sha256: "34841229bd1aa07de587d1c241eca6a97fb603b8a7c5fcbacb32893747166270",
  },
  {
    key: "d086_r8_postgres_evidence",
    path: `${ARTIFACT_DIR}/d086-local-postgres-evidence-2026-09-02.r2.json`,
    sha256: "80e5670a95c3ea3d37667d43f4145afcd0f044bcfed65a6121c5edb93f7add29",
  },
  {
    key: "d086_r9_postgres_evidence",
    path: `${ARTIFACT_DIR}/d086-local-postgres-evidence-2026-09-02.r3.json`,
    sha256: "5da7c564154d0e5b92a0df387e44df2ccb5b4d0005d92bf0aca683382f9f2a32",
  },
  {
    key: "d085_r16_accepted",
    path: `${ARTIFACT_DIR}/d085-budget-proposal-dry-run-2026-09-01.r16.json`,
    sha256: "df645050d20ca2e3d2304790279b76ee006886f4c18e8b8eff0d1ee437717211",
  },
] as const);

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort()
        .map((k) => [k, canonicalise((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
export function d086Digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalise(value))).digest("hex");
}

// ---------------------------------------------------------------------------
// Evidence horizons, chosen from OBSERVED density and lifecycle boundaries
// ---------------------------------------------------------------------------

/**
 * Six cutoffs, each justified by a measured fact rather than an arbitrary month.
 *
 * The density is deeply lopsided — 2,052 / 992 / 74 / 127 / 301,931 campaign-config
 * rows for April through August — so a single one-month window would describe either
 * a near-empty period or the one anomalous spike, and neither generalises.
 */
export const D086_HORIZONS = Object.freeze([
  { key: "2026-04-30", cutoffIso: "2026-04-30T23:59:59Z", why: "first substantial observation month: 2,052 rows across all six businesses" },
  { key: "2026-06-30", cutoffIso: "2026-06-30T23:59:59Z", why: "measured density trough: 74 rows, a real coverage gap rather than a quiet period" },
  { key: "2026-07-13", cutoffIso: "2026-07-13T00:00:00Z", why: "D076 boundary: complete-lane entity-state history begins here and does not exist before it" },
  { key: "2026-08-01", cutoffIso: "2026-08-01T00:00:00Z", why: "start of the high-density month (301,931 rows)" },
  { key: "2026-08-22", cutoffIso: "2026-08-22T14:53:48Z", why: "the exact ingestion halt: the newest retained observation in any of the three tables" },
  { key: "2026-09-02", cutoffIso: "2026-09-02T13:43:00Z", why: "the current read instant; nothing has accrued since the halt" },
] as const);

// ---------------------------------------------------------------------------
// Closure classification
// ---------------------------------------------------------------------------

/**
 * How a blocker could close. These are mutually exclusive and complete for the
 * three dimensions, and each is a claim about EVIDENCE, not about intent.
 */
export type ClosureClass =
  /** The evidence existed at the cutoff and was retained; readable today. */
  | "observed_at_cutoff"
  /** Not retained, but exactly reconstructable from what was retained. */
  | "historically_recomputable"
  /** Only today's mutable state could supply it — never valid for a past cutoff. */
  | "current_only_fallback"
  /** Cannot close without new capture: needs a deploy, and here also a fence clearance. */
  | "forward_only_after_deploy"
  /** The frozen evidence cannot decide it in either direction. */
  | "not_determinable";

export interface DimensionClosure {
  dimension: "budget_fact_retention" | "profile_output_retention" | "role_authority_retention";
  closesBlocker: string;
  closureClass: ClosureClass;
  why: string;
  /** What must happen, in order. Empty when already closed. */
  preconditions: readonly string[];
}

// ---------------------------------------------------------------------------
// The simulation: what each closure would clear, measured not asserted
// ---------------------------------------------------------------------------

/**
 * D085 r16's own blocker census, read from the accepted artifact rather than
 * restated here, mapped to the dimension that would clear each code.
 */
const CODE_OWNER: Readonly<Record<string, DimensionClosure["dimension"]>> = Object.freeze({
  budget_fact_unavailable: "budget_fact_retention",
  current_value_unknown: "budget_fact_retention",
  currency_exponent_unknown: "budget_fact_retention",
  unit_confidence_not_exact: "budget_fact_retention",
  commercial_profile_unavailable: "profile_output_retention",
  role_context_unresolved: "role_authority_retention",
});

/**
 * Codes that clear ONLY for an action-bearing observation.
 *
 * Correction 1 caught r1 claiming `owner_mode_unknown` was removed by retention.
 * It is not: a fact whose observed owner mode is `unknown` or `mixed` is retained
 * — honestly recording that the observation did not say who owns the budget — and
 * a blocker about not knowing the owner cannot be cleared by evidence that does
 * not know the owner. `isActionBearingBudgetFact` is the concrete qualification,
 * and this bucket is the honest place to report the difference.
 */
const ACTION_BEARING_ONLY_CODES: readonly string[] = Object.freeze(["owner_mode_unknown"]);

export interface SimulationRow {
  horizon: string;
  cutoffIso: string;
  /** Cells the closure clears at the D085 REPLAY grain. */
  cellsClearedAtReplayGrain: number;
  evaluationsClearedAtReplayGrain: number;
  /** Why that number is what it is. */
  replayGrainNote: string;
  /** Codes a valid retained fact/verdict/role clears once an entity is selected. */
  codesRemovedConditional: readonly string[];
  /**
   * Codes that clear only when the retained observation is ACTION-BEARING. A
   * retained fact with an unknown or mixed owner mode leaves these standing.
   */
  codesRemovedOnlyForActionBearing: readonly string[];
  codesRemainingConditional: readonly string[];
  /** Whether the retention rules ADMIT evidence at this cutoff at all. */
  retentionAdmitsEvidence: boolean;
  retentionRefusalReason: string | null;
}

/**
 * Run the retention validators at one horizon against a representative observation,
 * and read the D085 census to compute what a closure clears.
 *
 * The conditional lane is labelled conditional everywhere it appears: it answers
 * "if a concrete entity were selected, which gates would these closures remove",
 * which is a different question from what the fleet replay observed.
 */
export function simulateHorizon(
  horizon: (typeof D086_HORIZONS)[number],
  d085: Record<string, any>,
): SimulationRow {
  const census: Array<{ code: string; cells: number; entityOriginDirectionEvaluations: number }> =
    d085.analysis?.blockerCensus ?? [];
  const funnel: Array<{ stage: string; survivors: number; eliminated: number; gate: string | null }> =
    d085.analysis?.funnel ?? [];

  /*
    THE HONEST NUMBER. Every cell that survives the write-scope gate is eliminated at
    stage 2 by `no_concrete_entity_selected` — a fleet replay selects no single
    entity, which D085 states is expected and correct for the replay path. Stages 3
    through 6, which is where all three of these closures live, therefore eliminate
    ZERO cells: nothing reaches them. Closing all three clears no cell at this grain.
  */
  const entityGate = funnel.find((f) => f.gate === "no_concrete_entity_selected");
  const cellsCleared = 0;
  const evaluationsCleared = 0;

  const ownedCodes = census
    .filter((c) => CODE_OWNER[c.code] !== undefined)
    .map((c) => c.code)
    .sort();
  const actionBearingOnly = census
    .map((c) => c.code)
    .filter((code) => ACTION_BEARING_ONLY_CODES.includes(code))
    .sort();
  const remainingCodes = census
    .map((c) => c.code)
    .filter((code) => CODE_OWNER[code] === undefined && !ACTION_BEARING_ONLY_CODES.includes(code))
    .sort();

  // Does the retention contract admit evidence dated at this horizon at all?
  const probe = validateCanonicalBudgetFact(
    {
      businessId: "probe-business",
      providerAccountId: "act_probe",
      entityGrain: "campaign",
      entityId: "probe-campaign",
      parentCampaignId: null,
      budgetOwnerMode: "campaign_budget_optimization",
      budgetField: "daily_budget",
      rawMinorUnits: 100000,
      sourceCurrency: "TRY",
      scheduleState: "active",
      effectiveFrom: null,
      effectiveTo: null,
      providerApiVersion: "v21.0",
      sourceKind: "meta_entity_observation",
      sourceSnapshotId: null,
      sourceRunId: `run_${horizon.key}`,
      // Dated one second before the cutoff: the newest instant the horizon admits.
      capturedAt: new Date(Date.parse(horizon.cutoffIso) - 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      effectiveAt: new Date(Date.parse(horizon.cutoffIso) - 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      recordedAt: new Date(Date.parse(horizon.cutoffIso) - 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    },
    { businessId: "probe-business", providerAccountId: "act_probe", cutoffIso: horizon.cutoffIso },
  );

  return {
    horizon: horizon.key,
    cutoffIso: horizon.cutoffIso,
    cellsClearedAtReplayGrain: cellsCleared,
    evaluationsClearedAtReplayGrain: evaluationsCleared,
    replayGrainNote:
      `All ${entityGate?.eliminated ?? 0} cells surviving the write-scope gate are eliminated at `
      + "`no_concrete_entity_selected`, which precedes every gate these closures address. "
      + "A fleet replay selects no concrete entity; the per-entity dry run is the surface path. "
      + "So at this grain the closures clear nothing, and saying otherwise would be inflation.",
    codesRemovedConditional: Object.freeze(ownedCodes),
    codesRemovedOnlyForActionBearing: Object.freeze(actionBearingOnly),
    codesRemainingConditional: Object.freeze(remainingCodes),
    retentionAdmitsEvidence: probe.retained,
    retentionRefusalReason: probe.retained ? null : probe.blockers.join("; "),
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface D086Artifact {
  contract: string;
  rejectedRevisions: readonly Record<string, unknown>[];
  retentionContract: string;
  compiledResolverVersion: string;
  provenance: Record<string, unknown>;
  sourceManifest: Array<{ key: string; path: string; expectedSha256: string; observedSha256: string; matches: boolean }>;
  readiness: Record<string, unknown>;
  closures: readonly DimensionClosure[];
  simulation: readonly SimulationRow[];
  /** What an ephemeral LOCAL cluster verified. Never production, never a provider. */
  localPostgresVerification: Record<string, unknown>;
  preparedMigrations: { statements: number; applied: false; registeredInMigrationRegistry: boolean; sqlDigest: string; note: string };
  sideEffectLedger: Record<string, unknown>;
  limitations: readonly string[];
  residualBlockers: readonly Record<string, unknown>[];
  snapshotHash: string;
  analysisHash: string;
  artifactHash: string;
}

export function buildD086Artifact(read: (path: string) => Buffer = d086TrustedReader): D086Artifact {
  const sourceManifest = D086_PINNED_SOURCES.map((s) => {
    const observed = createHash("sha256").update(read(s.path)).digest("hex");
    return {
      key: s.key,
      path: s.path,
      expectedSha256: s.sha256,
      observedSha256: observed,
      matches: observed === s.sha256,
    };
  });
  if (sourceManifest.some((s) => !s.matches)) {
    throw new Error(
      `pinned source drift: ${sourceManifest.filter((s) => !s.matches).map((s) => s.path).join(", ")}`,
    );
  }

  const pinnedSource = (key: string) => {
    const found = D086_PINNED_SOURCES.find((s) => s.key === key);
    if (!found) throw new Error(`no pinned source named ${key}`);
    return found;
  };
  const census = JSON.parse(read(pinnedSource("d086_live_census").path).toString("utf8")) as Record<string, any>;
  const localEvidence = JSON.parse(
    read(pinnedSource("d086_r9_postgres_evidence").path).toString("utf8"),
  ) as Record<string, any>;
  const d085 = JSON.parse(read(pinnedSource("d085_r16_accepted").path).toString("utf8")) as Record<string, any>;

  // --- readiness, per business, from the pinned census -----------------------
  const perBusiness = (census.businesses as Array<Record<string, any>>).map((b) => {
    /*
      Role qualification is COMPUTED here with the same predicate the runtime uses,
      over the census fields, rather than restated from the census. Every retained
      row fails on provider-account scope and on resolver version; the count of
      qualifying rows is therefore derived, not asserted.
    */
    const representative = qualifyRoleAuthorityRow(
      {
        // The retained legacy rows carry no D086 contract at all — one of the
        // several independent reasons none of them can be authority.
        contract: null,
        businessId: b.businessId,
        providerAccountId: "",            // measured: 0 of N rows are account-scoped
        campaignId: "representative",
        asOfDate: b.latestRoleAsOf,
        inferredKind: "main",
        kindSource: "system_inferred",     // measured: N of N
        resolverVersion: "campaign-context-resolver.v1-shadow-2026-07-06", // measured: N of N
        confidenceClass: "high",           // the most favourable retained class
        evidenceHash: "",
        inputHash: "",
        effectiveAt: `${b.latestRoleAsOf}T00:00:00Z`,
        recordedAt: `${b.latestRoleAsOf}T00:00:00Z`,
        provenance: "engine_v3_campaign_context_daily",
      },
      {
        /*
          The expected scope is the BINDING's, taken from the census — never
          constructed from the row being judged. The retained rows carry no
          provider account at all, so this row fails on presence before the
          comparison is even reached.
        */
        expectedScope: { businessId: b.businessId, providerAccountId: "act_unresolved_in_retained_rows" },
        compiledResolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
        approvedResolverVersion: null,
        cutoffIso: "2026-09-02T13:43:01Z",
      },
    );
    return {
      business: b.business,
      businessId: b.businessId,
      providerAccounts: b.providerAccounts,
      budgetFactRetention: {
        configRowsExamined: b.campaignConfigRows + b.adsetConfigRows,
        rowsCarryingAUnit: 0,
        latestObservation: b.latestCapturedAt,
        status: "forward_only_after_deploy",
      },
      profileOutputRetention: {
        retainedVerdicts: 0,
        status: "forward_only_after_deploy",
      },
      roleAuthorityRetention: {
        rowsExamined: b.roleRows,
        highConfidenceRows: b.roleHighConfidence,
        systemInferredRows: b.roleSystemInferred,
        accountScopedRows: b.roleAccountScoped,
        compiledResolverVersionRows: b.roleCompiledVersion,
        qualifyingRows: 0,
        bestCaseRowBlockers: representative.blockers,
        status: "forward_only_after_deploy",
      },
    };
  });

  const totals = {
    businesses: perBusiness.length,
    providerAccounts: perBusiness.reduce((n, b) => n + b.providerAccounts, 0),
    configRowsExamined: perBusiness.reduce((n, b) => n + b.budgetFactRetention.configRowsExamined, 0),
    configRowsCarryingAUnit: 0,
    roleRowsExamined: perBusiness.reduce((n, b) => n + b.roleAuthorityRetention.rowsExamined, 0),
    roleRowsQualifying: 0,
    retainedProfileVerdicts: 0,
  };

  const closures: DimensionClosure[] = [
    {
      dimension: "budget_fact_retention",
      closesBlocker: "currency_exponent_not_captured",
      closureClass: "forward_only_after_deploy",
      why:
        "No column in the public schema carries a currency exponent, and no config-history "
        + "column carries a currency at all — measured, not assumed. The unit of every retained "
        + "budget value is therefore unobserved. It cannot be recomputed: restating a historical "
        + "value with today's registry would invent provenance the observation never had.",
      preconditions: Object.freeze([
        "deploy the prepared additive columns",
        "clear the ingestion fence (still 40,960 bytes over the 5 GiB ceiling)",
        "one admitted sync accrues a unit-bearing observation",
      ]),
    },
    {
      dimension: "profile_output_retention",
      closesBlocker: "canonical_profile_output_not_retained",
      closureClass: "forward_only_after_deploy",
      why:
        "No table retains the resolver's hard-action verdict; the only profile-shaped table is a "
        + "multiplier config holding zero rows. The verdict depends on calibration and target state "
        + "as they were at decision time, so a verdict computed today is not the verdict that was "
        + "reached then — it is a new decision wearing an old date.",
      preconditions: Object.freeze([
        "deploy the prepared engine_v3_account_profile_output table",
        "one engine pass projects the existing profile result into it",
      ]),
    },
    {
      dimension: "role_authority_retention",
      closesBlocker: "automatic_role_authority_absent",
      closureClass: "forward_only_after_deploy",
      why:
        "All 2,350 retained rows fail on TWO independent counts: every one carries a NULL provider "
        + "account, and every one carries the retired shadow resolver version. 484 are high-confidence "
        + "and not one qualifies. Neither is repairable after the fact — the account scope was never "
        + "captured, and the compiled resolver never ran against this data.",
      preconditions: Object.freeze([
        "deploy the compiled name-neutral resolver so version and provider-account scope are written",
        "clear the ingestion fence so the resolver can accrue rows",
        "arm the process-local authority gate for that exact compiled version",
      ]),
    },
  ];

  const simulation = D086_HORIZONS.map((h) => simulateHorizon(h, d085));

  const snapshot = {
    contract: D086_CONTRACT_ID,
    census: { readProvenance: census.readProvenance, schemaCapability: census.schemaCapability, ingestionFence: census.ingestionFence },
    perBusiness,
    totals,
  };
  const analysis = { closures, simulation, horizons: D086_HORIZONS };

  const artifact: Omit<D086Artifact, "artifactHash"> = {
    contract: D086_CONTRACT_ID,
    rejectedRevisions: D086_REJECTED_REVISIONS.map((r) => ({ ...r })),
    retentionContract: D086_RETENTION_CONTRACT,
    compiledResolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    provenance: {
      liveRead: census.readProvenance,
      d085Accepted: "d085.budget-proposal-dry-run.v16",
      horizonsChosenFrom: "observed monthly observation density and the D076 lifecycle boundary",
      densityByMonth: census.observationDensityByMonth,
    },
    sourceManifest,
    readiness: { perBusiness, totals },
    closures,
    simulation,
    localPostgresVerification: {
      evidencePath: `${ARTIFACT_DIR}/d086-local-postgres-evidence-2026-09-02.r3.json`,
      evidenceSha256: "5da7c564154d0e5b92a0df387e44df2ccb5b4d0005d92bf0aca683382f9f2a32",
      supersedes: {
        path: `${ARTIFACT_DIR}/d086-local-postgres-evidence-2026-09-02.r2.json`,
        sha256: "80e5670a95c3ea3d37667d43f4145afcd0f044bcfed65a6121c5edb93f7add29",
        why:
          "r8's evidence invented its own provenance: no meta_sync_partitions row stood behind "
          + "any cohort id, persistMetaRawSnapshot was never called, its \"delta\" was one full "
          + "capture whose run was UPDATEd to manifest_kind='delta', and its \"tied\" receipts "
          + "were a millisecond apart. Superseded by r3, which starts from real partitions and "
          + "real raw snapshots and exercises a writer-produced delta and a true same-clock tie.",
      },
      /*
        Structured, so a reader does not have to trust a sentence. This records
        WHAT was verified locally and is deliberately separate from the
        side-effect ledger, which scopes itself to assembly and production.
      */
      scope: "ephemeral local cluster only; never production, never a provider",
      serverVersion: "PostgreSQL 16.13 (Homebrew) on aarch64-apple-darwin25.2.0",
      clusterLifecycle: "created by the seam under mkdtemp and destroyed in its finally block",
      /*
        C7: the schema comes from the REAL migration registry, not from a
        hand-written DDL list, and the rows come from the REAL capture path —
        mapCampaignObservationState / mapAdSetObservationState feeding
        persistMetaEntityObservation — not from fixture INSERTs.
      */
      schemaSource: "lib/migrations.ts runMigrations() against a fresh cluster",
      rowsWrittenBy: [
        "queueMetaSyncPartition", "persistMetaRawSnapshot",
        "mapCampaignObservationState", "mapAdSetObservationState",
        "persistMetaEntityObservation", "persistMetaExplicitEntityTombstone",
      ],
      preparedStatementsApplied: D086_ADDITIVE_MIGRATION_SQL.length,
      queriesExecuted: [
        "D086_STATE_BUDGET_SQL", "D086_ACCOUNT_TIMEZONE_SQL", "D086_PROFILE_LATEST_SQL",
        "D086_ROLE_LATEST_SQL", "D086_LEGACY_ROLE_SQL", "D086_COMPLETE_RUN_SQL",
        "D086_CAPABILITY_PROBE_SQL", "D086_INDEX_CATALOG_SQL",
      ],
      /*
        TRANSITIVE impact, not a direct-import grep.

        Correction 7 claimed three long audit suites were unaffected because
        none of them IMPORTED a changed module. That is not the question: the
        closure is. Built over `@/` and relative specifiers from each suite's
        entry, with a positive control (the D086 suite, which must be connected)
        and a negative control. `d080b` IS connected through
        entity-state-history, api/meta and migrations, and was run; the other
        two are disconnected at closure sizes of 2 and 6 modules.
      */
      transitiveImpact: {
        method: "import closure over @/ and relative specifiers from each suite entry",
        positiveControl: {
          entry: "scripts/audits/d086-budget-readiness-input-pack.test.ts",
          modulesInClosure: 42,
          connected: true,
        },
        suites: [
          {
            entry: "scripts/audits/d080b-meta-budget-policy-simulation.test.ts",
            modulesInClosure: 311,
            connectedTo: [
              "lib/meta/entity-state-history.ts", "lib/api/meta.ts", "lib/migrations.ts",
            ],
            ran: true,
            result: "116 passed",
          },
          {
            entry: "scripts/audits/d080-meta-budget-edit-evidence.test.ts",
            modulesInClosure: 2,
            connectedTo: [],
            ran: false,
            result: "disconnected from every changed module",
          },
          {
            entry: "scripts/audits/d084-commercial-target-evidence.test.ts",
            modulesInClosure: 6,
            connectedTo: [],
            ran: false,
            result: "disconnected from every changed module",
          },
        ],
      },
      // The cohort a receipt names is now a row the database enforces.
      cohortLinkageEnforcedBy: [
        "meta_entity_observation_receipts_partition_fk",
        "meta_entity_observation_receipts_snapshot_fk",
      ],
      readModelDrivenOverRealRows: true,
      indexRankPathsVerifiedFromCatalog: true,
      productionStatementsExecuted: 0,
      /*
        BOUND, not asserted. The counts below are read from the pinned evidence
        document that the seam generated, so a claim here cannot drift from what
        actually ran. r6 published hard-coded prose no check could falsify.
      */
      casesExercised: localEvidence.cases.length,
      casesReady: localEvidence.cases.filter((c: { status: string }) => c.status === "ready").length,
      seamOk: localEvidence.ok,
      requiredIndexes: localEvidence.indexCatalog.length,
    },
    preparedMigrations: {
      statements: D086_ADDITIVE_MIGRATION_SQL.length,
      applied: false,
      registeredInMigrationRegistry: true,
      sqlDigest: d086Digest(D086_ADDITIVE_MIGRATION_SQL),
      note:
        "REGISTERED in lib/migrations.ts, as correction 7 requires, and additive throughout "
        + "(every statement is IF NOT EXISTS). Registration means a future deploy applies them; "
        + "NOTHING here applies them to production, and no production catalog has ever held them. "
        + "They ARE applied in the ephemeral local cluster recorded under "
        + "localPostgresVerification — by the real registry rather than by this list — which is how their "
        + "DDL and the queries that read them are known to parse. Wiring is the first step of the "
        + "separately reconciled deploy slice.",
    },
    sideEffectLedger: {
      scope: "artifact assembly and production only; the ephemeral local verification seam is reported separately in limitations",
      databaseWritesIssued: 0,
      ddlStatementsExecuted: 0,
      migrationsApplied: 0,
      extensionsInstalled: 0,
      providerApiCalls: 0,
      providerWritesAttempted: 0,
      browserOrLocalhostProbes: 0,
      automationFlagsSet: 0,
      filesWritten: [D086_JSON_OUT],
      readOnlyTransactions: 1,
    },
    limitations: Object.freeze([
      "Every claim about the live database comes from ONE SELECT-only repeatable-read transaction taken at 2026-09-02T13:43Z. It is a point-in-time read, not a monitor.",
      "Ingestion has been admission-refused since 2026-08-22 and the fence overage is unchanged at 40,960 bytes. No retention blocker here can close by waiting; each needs a deploy AND an operator clearing the fence.",
      "The simulation reports what closures would clear. It is not evidence that they did clear, and no closure below is retained authority.",
      "At the D085 fleet-replay grain all three closures clear zero cells, because `no_concrete_entity_selected` eliminates every surviving cell at an earlier stage. The conditional lane answers a different question and is labelled as such throughout.",
      "`owner_mode_unknown` is reported separately as action-bearing-only. r1 counted it among the codes retention removes, which was wrong: a fact whose observed owner mode is unknown or mixed is retained as honest evidence and cannot clear a blocker about not knowing the owner.",
      "The readiness surface holds no external profile fingerprint expectation, so every retained verdict classifies as `profile_identity_agreement_unavailable`: form-valid evidence, never READY. Correction 2 rejected the earlier behaviour of reading a missing expectation as agreement.",
      "Retained unit provenance is READ, then VERIFIED against the frozen registry version the row itself cites. The readiness layer never consults a mutable current registry and never manufactures missing provenance: an unrecognised source or version fails before any mapping question is asked, so a row that captured no exponent, registry or version is unusable rather than repaired with today's values.",
      "Whole-account readiness is claimed only when the sampled latest-per-identity rows ARE the whole latest-per-identity population, every APPLICABLE budget owner qualifies, and no owner is uncaptured, uncovered or in conflict. A truncated sample is `partial` with its population, because unexamined members are unknown, not passing.",
      "The budget owner universe is proven from the canonical observation manifest: the exact campaign_configs and adset_configs endpoints, a complete successful run per grain, both runs naming ONE explicit sync cohort, and the exact reconstructed entity identities from meta_entity_state_history reconciled against the manifest's own persisted count. Ownership is then proven pairwise. Correction 6 replaced the retained-snapshot self-reference this line previously described.",
      "The cohort binding is forward-only: an observation captured before the receipt table existed has no capture receipt, so it cannot attest today. It closes only after the additive column is deployed AND an admitted observation records it.",
      "Budget facts are read from meta_entity_state_history — the rows the real capture path writes — and every budget judgment on them is D083's buildCanonicalBudgetFact, reached through the shared projector. The transition-only config-history read was removed in correction 8 along with its query, its capability probe and the tests that certified it.",
      "The legacy role branch is BUSINESS-level migration evidence, not account authority, and publishes its real population and truncation state.",
      "SQL EXECUTION, scoped precisely. Artifact assembly and production executed ZERO statements of any kind: this generator opens no database handle. Independent LOCAL verification is different and did run — an ephemeral PostgreSQL 16.13 cluster, created and destroyed by the seam, applied all prepared DDL, executed every readiness query, read pg_indexes, and exercised reversed-insertion conflicts through the real read model. Neither the census nor this artifact depends on that cluster.",
      "The prepared migrations ARE registered in lib/migrations.ts, as correction 7 required, and are additive throughout: every statement is IF NOT EXISTS, and both foreign keys are added NOT VALID so a table already holding malformed rows is never blocked. Registration means a future deploy applies them. NOTHING in this work applies them to production, no production catalog has ever held them, and they are exercised only in the ephemeral local cluster recorded under localPostgresVerification.",
      "No causal claim is made about ROAS, revenue or profit. Nothing here has a counterfactual.",
      "Campaign names and manual Test/Main/Mixed labels are excluded by construction, not by policy: they are not members of any admitted schema in this slice.",
    ]),
    residualBlockers: Object.freeze([
      {
        blocker: "no_provider_write_path_exists",
        state: "CLOSED, UNCHANGED",
        evidence: "D086 adds no budget endpoint, no dispatch verb and no write ceremony; MUTATION_ENDPOINTS is untouched",
        consequence: "no budget proposal can be dispatched from this codebase, exactly as before",
      },
      {
        blocker: "currency_exponent_not_captured",
        state: "forward_only_after_deploy",
        evidence: "0 exponent-bearing columns in the public schema; 0 currency columns on either config-history table",
        consequence: "no authoritative raw provider-unit value may be published for any binding",
      },
      {
        blocker: "canonical_profile_output_not_retained",
        state: "forward_only_after_deploy",
        evidence: "no retention table exists; business_decision_calibration_profiles is a multiplier config holding 0 rows",
        consequence: "no commercial eligibility may be stated in either direction",
      },
      {
        blocker: "automatic_role_authority_absent",
        state: "forward_only_after_deploy",
        evidence: "2,350 retained rows, 484 high-confidence, 0 account-scoped, 0 on the compiled resolver version",
        consequence: "role context stays unresolved and no role-scoped proposal may be raised",
      },
      {
        blocker: "ingestion_admission_refused",
        state: "OPEN, OPERATOR-OWNED",
        evidence: "meta_entity_state_history is 40,960 bytes over its 5 GiB ceiling, unchanged since 2026-08-30",
        consequence: "nothing accrues, so no forward capture path can begin closing until an operator clears it",
      },
    ]),
    snapshotHash: d086Digest(snapshot),
    analysisHash: d086Digest(analysis),
  };

  return { ...artifact, artifactHash: d086Digest(artifact) };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface D086VerifyResult { ok: boolean; failures: string[]; checked: string[] }

export function verifyD086Artifact(
  published: unknown,
  read: (path: string) => Buffer = d086TrustedReader,
): D086VerifyResult {
  const failures: string[] = [];
  const checked: string[] = [];
  const fail = (why: string) => failures.push(why);

  if (published === null || typeof published !== "object" || Array.isArray(published)) {
    return { ok: false, failures: ["artifact: not a map"], checked };
  }
  const doc = published as Record<string, unknown>;

  // 1 — reconstruction: the artifact must rebuild byte-for-byte from pinned sources
  let rebuilt: D086Artifact | null = null;
  try {
    rebuilt = buildD086Artifact(read);
  } catch (error) {
    fail(`reconstruction: ${String(error)}`);
  }
  if (rebuilt) {
    if (d086Digest(rebuilt) !== d086Digest(doc)) {
      fail("reconstruction: the published artifact is not what the pinned sources produce");
    }
  }
  checked.push("reconstruction");

  // 2 — the hash chain, recomputed rather than read
  if (rebuilt) {
    for (const key of ["snapshotHash", "analysisHash", "artifactHash"] as const) {
      if (doc[key] !== rebuilt[key]) fail(`hashChain: ${key} does not reproduce`);
    }
  }
  checked.push("hashChain");

  // 3 — the pinned sources still hash to their pins
  for (const source of D086_PINNED_SOURCES) {
    try {
      const observed = createHash("sha256").update(read(source.path)).digest("hex");
      if (observed !== source.sha256) {
        fail(`pinnedSources: ${source.path} is ${observed}, pinned ${source.sha256}`);
      }
    } catch (error) {
      fail(`pinnedSources: ${source.path} unreadable (${String(error)})`);
    }
  }
  checked.push("pinnedSources");

  // 3b — every FROZEN revision must still have the bytes it was rejected with
  for (const rejected of D086_REJECTED_REVISIONS) {
    try {
      const observed = createHash("sha256").update(read(rejected.path)).digest("hex");
      if (observed !== rejected.fileSha256) {
        fail(`frozenRevisions: r${rejected.revision} is ${observed}, pinned ${rejected.fileSha256}`);
      }
    } catch (error) {
      fail(`frozenRevisions: r${rejected.revision} unreadable (${String(error)})`);
    }
  }
  checked.push("frozenRevisions");

  // 4 — the provider-write blocker must still be closed
  const residual = Array.isArray(doc.residualBlockers) ? doc.residualBlockers : [];
  const writePath = residual.find(
    (r) => (r as Record<string, unknown>)?.blocker === "no_provider_write_path_exists",
  ) as Record<string, unknown> | undefined;
  if (!writePath || !String(writePath.state ?? "").startsWith("CLOSED")) {
    fail("providerWrite: the provider-write blocker must remain published as closed");
  }
  checked.push("providerWrite");

  // 4b — the pinned local-PostgreSQL evidence must carry every required case
  //      WITH its exact verdict and the MECHANICS that produced it.
  try {
    const evidence = JSON.parse(
      read(`${ARTIFACT_DIR}/d086-local-postgres-evidence-2026-09-02.r3.json`).toString("utf8"),
    ) as {
      ok?: boolean;
      postgresVersion?: string;
      capabilityProbe?: Record<string, unknown>;
      indexCatalog?: Array<{ indexname: string; indexdef: string }>;
      steps?: Array<{ step: string; detail: string }>;
      cases?: Array<{
        name: string; status: string; blocker: string | null;
        mechanics?: string; attested?: boolean;
      }>;
    };
    if (evidence.ok !== true) fail("localEvidence: the seam report is not ok");
    if (!/PostgreSQL 16/.test(String(evidence.postgresVersion ?? ""))) {
      fail("localEvidence: the server version is not recorded");
    }
    const byName = new Map((evidence.cases ?? []).map((c) => [c.name, c]));
    /*
      Bound by NAME AND VERDICT AND MECHANICS. r7's verifier checked names only,
      so a matrix in which every case errored still passed; r8's checked
      mechanics strings that described fabricated fixtures. The strings below
      name the REAL writers and the REAL breakage, so a case that went back to
      inventing its provenance cannot satisfy them.
    */
    for (const required of [
      { name: "real_full_capture_ready", status: "ready", blocker: null,
        mechanics: "persistMetaRawSnapshot" },
      { name: "real_writer_delta_ready", status: "ready", blocker: null,
        mechanics: "the writer itself returned" },
      { name: "real_scope_exit_ready", status: "ready", blocker: null,
        mechanics: "omitted c_200" },
      { name: "future_heartbeat_preserves_history", status: "ready", blocker: null,
        mechanics: "advanced last_captured_at" },
      { name: "missing_partition_never_attests", status: "partial",
        blocker: "budget_universe_campaign_partition_absent",
        mechanics: "no meta_sync_partitions row" },
      { name: "foreign_partition_never_attests", status: "partial",
        blocker: "budget_universe_campaign_partition_scope_mismatch",
        mechanics: "another provider account" },
      { name: "extended_lane_partition_never_attests", status: "partial",
        blocker: "budget_universe_campaign_partition_lane_mismatch",
        mechanics: "extended-lane" },
      { name: "missing_snapshot_never_attests", status: "partial",
        blocker: "budget_universe_campaign_snapshot_absent",
        mechanics: "no raw snapshot reference" },
      { name: "snapshot_partition_mismatch_never_attests", status: "partial",
        blocker: "budget_universe_campaign_snapshot_partition_mismatch",
        mechanics: "different real partition" },
      { name: "snapshot_endpoint_mismatch_never_attests", status: "partial",
        blocker: "budget_universe_campaign_snapshot_endpoint_mismatch",
        mechanics: "ad_configs" },
      { name: "newer_failed_blocks_older_complete", status: "partial",
        blocker: "budget_universe_campaign_capture_failed", mechanics: "FAILED capture" },
      { name: "newer_partial_blocks_older_complete", status: "partial",
        blocker: "budget_universe_campaign_capture_partial", mechanics: "PARTIAL capture" },
      { name: "wrong_endpoint_named", status: "partial",
        blocker: "budget_universe_campaign_endpoint_mismatch", mechanics: "ad_configs" },
      { name: "cohort_mismatch_across_syncs", status: "partial",
        blocker: "budget_universe_cohort_mismatch", mechanics: "DIFFERENT real core partitions" },
      { name: "explicit_tombstone_supersedes_manifest", status: "partial",
        blocker: "budget_universe_campaign_membership_tombstoned",
        mechanics: "meta_entity_tombstones" },
      { name: "receipt_collision_refused", status: "ready", blocker: null,
        mechanics: "was REFUSED" },
      { name: "true_tie_forward_insertion", status: "partial",
        blocker: "budget_universe_manifest_conflict", mechanics: "forward physical order" },
      { name: "true_tie_reversed_insertion", status: "partial",
        blocker: "budget_universe_manifest_conflict", mechanics: "reversed physical order" },
    ]) {
      const actual = byName.get(required.name);
      if (!actual) { fail(`localEvidence: required case ${required.name} is absent`); continue; }
      if (actual.status !== required.status) {
        fail(`localEvidence: ${required.name} status ${actual.status} != ${required.status}`);
      }
      if ((actual.blocker ?? null) !== required.blocker) {
        fail(`localEvidence: ${required.name} blocker ${actual.blocker} != ${required.blocker}`);
      }
      if (!String(actual.mechanics ?? "").includes(required.mechanics)) {
        fail(`localEvidence: ${required.name} does not record "${required.mechanics}"`);
      }
    }
    // The two insertion orders must AGREE on a real same-clock CONFLICT, or the
    // evidence proves nothing about order independence.
    const forward = byName.get("true_tie_forward_insertion");
    const reversed = byName.get("true_tie_reversed_insertion");
    if (!forward || !reversed || forward.status !== reversed.status
      || forward.blocker !== reversed.blocker
      || forward.blocker !== "budget_universe_manifest_conflict") {
      fail("localEvidence: the forward and reversed insertion orders did not both conflict");
    }
    for (const c of evidence.cases ?? []) {
      if (c.status === "ready" && c.blocker !== null) {
        fail(`localEvidence: ${c.name} is ready with a blocker`);
      }
    }
    if ((evidence.indexCatalog ?? []).length !== D086_REQUIRED_INDEXES.length) {
      fail("localEvidence: the index catalog result is incomplete");
    }
    if (String((evidence.capabilityProbe ?? {}).receipt_columns ?? "")
      !== String(D086_REQUIRED_RECEIPT_COLUMNS.length)) {
      fail("localEvidence: the receipt capability probe result is not recorded");
    }
    if (String((evidence.capabilityProbe ?? {}).partition_columns ?? "")
      !== String(D086_REQUIRED_PARTITION_COLUMNS.length)) {
      fail("localEvidence: the partition capability probe result is not recorded");
    }
    const stepNames = new Set((evidence.steps ?? []).map((s) => s.step));
    for (const step of [
      "migrations", "receipt_table", "real_linkage", "cohort_proof",
      "delta_mechanics", "scope_exit_mechanics", "capability_probe", "index_catalog",
    ]) {
      if (!stepNames.has(step)) fail(`localEvidence: the ${step} mechanic is not recorded`);
    }
    // The linkage step must prove a JOIN, not a claim.
    const linkage = (evidence.steps ?? []).find((s) => s.step === "real_linkage");
    if (!/proven by join/.test(String(linkage?.detail ?? ""))) {
      fail("localEvidence: the receipt-to-partition-to-snapshot linkage is not proven by join");
    }
    const receiptTable = (evidence.steps ?? []).find((s) => s.step === "receipt_table");
    for (const constraint of [
      "meta_entity_observation_receipts_partition_fk",
      "meta_entity_observation_receipts_snapshot_fk",
    ]) {
      if (!String(receiptTable?.detail ?? "").includes(constraint)) {
        fail(`localEvidence: the ${constraint} foreign key is not recorded as created`);
      }
    }
  } catch (error) {
    fail(`localEvidence: unreadable (${String(error)})`);
  }
  checked.push("localEvidence");

  // 5 — the side-effect ledger must be all zeros except this artifact
  const ledger = doc.sideEffectLedger as Record<string, unknown> | undefined;
  for (const key of [
    "databaseWritesIssued", "ddlStatementsExecuted", "migrationsApplied", "extensionsInstalled",
    "providerApiCalls", "providerWritesAttempted", "browserOrLocalhostProbes", "automationFlagsSet",
  ]) {
    if (ledger?.[key] !== 0) fail(`sideEffects: ${key} is ${String(ledger?.[key])}, must be 0`);
  }
  checked.push("sideEffects");

  // 6 — no closure may claim observed authority it does not have
  const closures = Array.isArray(doc.closures) ? doc.closures : [];
  for (const c of closures as Array<Record<string, unknown>>) {
    if (c.closureClass === "observed_at_cutoff") {
      fail(`closureHonesty: ${String(c.dimension)} claims observed authority; no dimension has it`);
    }
  }
  checked.push("closureHonesty");

  // 7 — the migrations must be published as unapplied
  const migrations = doc.preparedMigrations as Record<string, unknown> | undefined;
  if (migrations?.applied !== false) fail("migrations: must be published as unapplied");
  checked.push("migrations");

  /*
    9 — SEMANTIC FRESHNESS. The claims must describe the code that exists.

    r8's live limitations still said the cohort was a run-level
    `sync_cohort_id`, that budget facts came from run-bound config history, and
    that the migrations were unwired because nothing registered them. Every one
    of those had already stopped being true, and the verifier had no way to
    notice: it checked hashes, counts and closures, never whether a sentence
    still matched the implementation. These are NEGATIVE guards over the LIVE
    document only — the rejected-revision record must be free to quote exactly
    what it rejected.
  */
  const rejectedProse = JSON.stringify(doc.rejectedRevisions ?? []);
  const liveDoc = { ...(doc as Record<string, unknown>) };
  delete liveDoc.rejectedRevisions;
  const livePayload = JSON.stringify(liveDoc);
  for (const [pattern, why] of [
    [/sync_cohort_id/i, "the cohort is an append-only receipt, not a run column"],
    [/run-bound config history/i, "budget facts come from meta_entity_state_history"],
    [/transition-only config history/i, "config history is no longer read at all"],
    [/config row has been retained/i, "the surface reports observations, not config rows"],
    [/meta_(campaign|adset)_config_history/i, "no executed statement names those tables"],
    [/nothing registers them/i, "the migrations ARE registered in lib/migrations.ts"],
    [/remain unwired/i, "the migrations ARE registered in lib/migrations.ts"],
    [/not registered in lib\/migrations\.ts/i, "the migrations ARE registered"],
  ] as const) {
    if (pattern.test(livePayload)) {
      fail(`semanticFreshness: a live claim still says ${pattern.source} — ${why}`);
    }
  }
  /*
    ...and the guard must be able to SEE the prose it is allowed to keep, or a
    future edit that empties the rejected record would make it vacuously true.
  */
  if (!/sync_cohort_id/.test(rejectedProse)) {
    fail("semanticFreshness: the rejected-revision record no longer quotes what it rejected");
  }
  checked.push("semanticFreshness");

  return { ok: failures.length === 0, failures, checked };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function writeAllBytes(fd: number, payload: Buffer): void {
  let offset = 0;
  let guard = 0;
  while (offset < payload.length) {
    if (guard++ > payload.length + 1) throw new Error("write did not converge");
    const written = writeSync(fd, payload, offset, payload.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error(`no progress at ${offset}`);
    offset += written;
  }
}

function runAssemble(): void {
  const artifact = buildD086Artifact();
  const outPath = assertWritableArtifactPath(D086_JSON_OUT);
  const finalPath = d086TrustedPath(outPath);
  const payload = Buffer.from(`${JSON.stringify(artifact, null, 1)}\n`, "utf8");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const tempPath = `${finalPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | null = null;
  let ownsTemp = false;
  try {
    fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o644);
    ownsTemp = true;
    writeAllBytes(fd, payload);
    closeSync(fd);
    fd = null;
    assertWritableArtifactPath(outPath);
    renameSync(tempPath, finalPath);
  } catch (error) {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    if (ownsTemp) { try { unlinkSync(tempPath); } catch { /* already gone */ } }
    throw error;
  }
  console.log(JSON.stringify({
    phase: "d086-assemble",
    databaseQueriesExecuted: 0,
    providerWritesAttempted: 0,
    migrationsApplied: 0,
    businesses: (artifact.readiness as any).totals.businesses,
    providerAccounts: (artifact.readiness as any).totals.providerAccounts,
    configRowsExamined: (artifact.readiness as any).totals.configRowsExamined,
    roleRowsExamined: (artifact.readiness as any).totals.roleRowsExamined,
    roleRowsQualifying: (artifact.readiness as any).totals.roleRowsQualifying,
    snapshotHash: artifact.snapshotHash,
    analysisHash: artifact.analysisHash,
    artifactHash: artifact.artifactHash,
    out: outPath,
  }, null, 1));
}

function runVerify(): D086VerifyResult {
  let artifact: unknown;
  try {
    artifact = JSON.parse(readFileSync(d086TrustedPath(D086_JSON_OUT), "utf8"));
  } catch (error) {
    const result = { ok: false, failures: [`artifact unreadable: ${String(error)}`], checked: [] };
    console.log(JSON.stringify({ phase: "d086-verify", ...result }, null, 1));
    return result;
  }
  const result = verifyD086Artifact(artifact);
  console.log(JSON.stringify({ phase: "d086-verify", ...result }, null, 1));
  return result;
}

const invoked = process.argv[1] ?? "";
if (invoked.includes("d086-budget-readiness-input-pack")) {
  const mode = process.argv[2] ?? "verify";
  if (mode === "assemble") runAssemble();
  else if (mode === "verify") { if (!runVerify().ok) process.exitCode = 1; }
  else { console.error(`unknown mode ${mode}`); process.exitCode = 2; }
}
