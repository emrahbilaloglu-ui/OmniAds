/**
 * Narrow tests of the acceptance harness CORE. Pure fixtures only: run with an
 * unreachable DATABASE_URL; nothing here opens a connection.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { validateMetaNativeDecisionGenerationBundle } from "@/lib/meta/decisions-workspace-read-model";

import {
  ACCEPTANCE_CLAIMS,
  AcceptanceUsageError,
  D101_COVERAGE_AT_CUTOFFS_SQL,
  IDENTITY_AT_CUTOFF_SQL,
  SIMULATED_CALIBRATION_BATCH_ID_PREFIX,
  SYNTHETIC_ID_PREFIX,
  auditPresentationMode,
  auditServedAuthority,
  authorizationGroundingFailures,
  crossCheckHydration,
  deriveChain,
  describeBriefingVersusOs,
  describeHardAuthority,
  diffProvenanceSnapshots,
  evaluateHardAuthority,
  hardAuthorityBlockerCategories,
  evaluateRuntimeGuard,
  findLeakedCalibrationBatchIds,
  findLeakedIds,
  hydrationClaims,
  isHardRowEntry,
  isProductionModulePath,
  isProviderWriteAction,
  parseGitPorcelainZ,
  productionRunSlotCutoffs,
  reportedPriorSource,
  simulatedCalibrationBatchId,
  summarizeAccountDecisions,
  summarizeProvenance,
  toHardRowRecord,
  buildSimulatedGeneration,
  classifyAdSpend,
  classifyConfigTier,
  classifyCoverage,
  classifyFunnelStageRow,
  classifyLinkClickRow,
  classifyLinkClickWindow,
  classifyPurchaseRow,
  classifyRoleTrust,
  decideExitCode,
  describeResolverArming,
  evaluateAcceptanceInvariants,
  evaluateNegativeControl,
  evaluateReceiptGate,
  evaluateReleaseAcceptance,
  evaluateReleaseGates,
  locateHeldVerdicts,
  parseAcceptanceArgs,
  persistedInputEvidence,
  projectConfigAuthorityVerified,
  projectConfigEvidenceLineage,
  projectPredicateBlockers,
  simulatedJobRunId,
  summarizeHierarchyAtCutoff,
  summarizeReport,
  type BusinessAcceptanceReport,
  type DecisionAccountDayReport,
  type DecisionEntrySource,
  type HydrationCrossCheck,
  type HardRowRecord,
  type IndependentReading,
  type LedgerAccountReport,
  type LedgerLaneReport,
  type NegativeControlReport,
  type PresentationAccountReport,
  type PresentationModeReport,
  type SimulatedDecisionEntry,
  type SimulatedHydrationReceipt,
  type SimulatedPayload,
} from "./meta-decisions-creatives-acceptance-core";

const BIZ = "11111111-2222-4333-8444-555555555555";
const BIZ_B = "11111111-2222-4333-8444-666666666666";
const NOW = new Date("2026-09-23T12:00:00.000Z");

/* ============================================================ arguments */

describe("parseAcceptanceArgs", () => {
  it("requires an explicit --business list", () => {
    expect(() => parseAcceptanceArgs([], NOW)).toThrow(AcceptanceUsageError);
    expect(() => parseAcceptanceArgs(["--window", "2026-09-01:2026-09-10"], NOW)).toThrow(/--business/);
  });

  it("accepts at most four businesses, each a UUID, without duplicates", () => {
    const five = Array.from({ length: 5 }, (_, i) => `11111111-2222-4333-8444-55555555555${i}`).join(",");
    expect(() => parseAcceptanceArgs(["--business", five], NOW)).toThrow(/at most 4/);
    expect(() => parseAcceptanceArgs(["--business", "grandmix"], NOW)).toThrow(/UUID/);
    expect(() => parseAcceptanceArgs(["--business", `${BIZ},${BIZ}`], NOW)).toThrow(/twice/);
    expect(parseAcceptanceArgs(["--business", BIZ.toUpperCase()], NOW).businesses).toEqual([BIZ]);
  });

  it("keeps the negative control disjoint from the subjects, and names its campaign explicitly", () => {
    expect(() =>
      parseAcceptanceArgs(["--business", BIZ, "--negative-control", BIZ, "--negative-control-campaign", "120243489401800340"], NOW),
    ).toThrow(/must not also be listed/);
    const args = parseAcceptanceArgs(["--business", BIZ, "--negative-control", BIZ_B, "--negative-control-campaign", "120243489401800340"], NOW);
    expect(args.negativeControl).toBe(BIZ_B);
    expect(args.negativeControlCampaign).toBe("120243489401800340");
    // Nothing is hard-coded: the control needs its campaign, and a campaign needs its control.
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--negative-control", BIZ_B], NOW)).toThrow(/go together/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--negative-control-campaign", "120243489401800340"], NOW)).toThrow(/go together/);
    expect(() =>
      parseAcceptanceArgs(["--business", BIZ, "--negative-control", BIZ_B, "--negative-control-campaign", "colorfull"], NOW),
    ).toThrow(/numeric Meta campaign id/);
    // Optional: absent, it is null (the run labels it; the gate does not require it).
    const plain = parseAcceptanceArgs(["--business", BIZ], NOW);
    expect(plain.negativeControl).toBeNull();
    expect(plain.negativeControlCampaign).toBeNull();
    expect(plain.requireClean).toBe(false);
    expect(parseAcceptanceArgs(["--business", BIZ, "--require-clean"], NOW).requireClean).toBe(true);
  });

  it("--out: resolved absolute, never inside the repository, never over an existing file", () => {
    const options = { repoRoot: "/repo", cwd: "/work", pathExists: (file: string) => file === "/tmp/exists.json" };
    expect(parseAcceptanceArgs(["--business", BIZ, "--out", "out.json", "--write", "1"], NOW, options).outPath).toBe("/work/out.json");
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--out", "/repo/report.json"], NOW, options)).toThrow(/inside the repository/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--out", "/repo/scripts/x/report.json"], NOW, options)).toThrow(/inside the repository/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--out", "../repo/a.json"], NOW, { ...options, cwd: "/repo/scripts" })).toThrow(/inside the repository/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--out", "/tmp/exists.json"], NOW, options)).toThrow(/already exists/);
    expect(parseAcceptanceArgs(["--business", BIZ, "--out", "/repository-sibling/a.json"], NOW, options).outPath).toBe("/repository-sibling/a.json");
  });

  it("defaults the window, chain, cutoffs and limits", () => {
    const args = parseAcceptanceArgs(["--business", BIZ], NOW);
    expect(args.window).toEqual({ start: "2026-08-25", end: "2026-09-22" });
    expect(args.chain).toEqual([
      { asOf: "2026-09-21", cutoff: "2026-09-21T23:59:59.999Z" },
      { asOf: "2026-09-22", cutoff: "2026-09-22T23:59:59.999Z" },
    ]);
    expect(args.adLimits).toEqual([60, 300]);
    expect(args.write).toBe(false);
    expect(args.outPath).toBeNull();
    expect(args.skipDecisions).toBe(false);
    expect(args.mode).toBe("release");
    expect(args.gate).toBe("pre_deploy");
    expect(parseAcceptanceArgs(["--business", BIZ, "--gate", "post_deploy"], NOW).gate).toBe("post_deploy");
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--gate", "prod"], NOW)).toThrow(/--gate/);
  });

  it("labels --skip-decisions and --diagnostic runs as diagnostic", () => {
    expect(parseAcceptanceArgs(["--business", BIZ, "--skip-decisions"], NOW).mode).toBe("diagnostic");
    const diagnostic = parseAcceptanceArgs(["--business", BIZ, "--diagnostic"], NOW);
    expect(diagnostic.mode).toBe("diagnostic");
    expect(diagnostic.diagnostic).toBe(true);
    expect(diagnostic.skipDecisions).toBe(false);
  });

  it("validates the window: well-formed, ordered, ending on a past UTC day", () => {
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--window", "2026-09-01"], NOW)).toThrow(/YYYY-MM-DD:YYYY-MM-DD/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--window", "2026-09-10:2026-09-01"], NOW)).toThrow(/after its end/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--window", "2026-09-01:2026-09-23"], NOW)).toThrow(/past UTC day/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--window", "2026-02-01:2026-02-30"], NOW)).toThrow(/valid/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--window", "2026-06-01:2026-09-01"], NOW)).toThrow(/at most/);
  });

  it("bounds --chain and --ad-limits", () => {
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--chain", "4"], NOW)).toThrow(/--chain/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--chain", "0"], NOW)).toThrow(/--chain/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--ad-limits", "30"], NOW)).toThrow(/--ad-limits/);
    expect(parseAcceptanceArgs(["--business", BIZ, "--ad-limits", "300,60"], NOW).adLimits).toEqual([60, 300]);
    expect(parseAcceptanceArgs(["--business", BIZ, "--chain", "3"], NOW).chain.map((d) => d.asOf)).toEqual([
      "2026-09-20",
      "2026-09-21",
      "2026-09-22",
    ]);
  });

  it("writes only with --out AND --write 1, and refuses anything else", () => {
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--write", "1"], NOW)).toThrow(/requires --out/);
    const outOnly = parseAcceptanceArgs(["--business", BIZ, "--out", "/tmp/x.json"], NOW);
    expect(outOnly.write).toBe(false);
    const both = parseAcceptanceArgs(["--business", BIZ, "--out", "/tmp/x.json", "--write", "1"], NOW);
    expect(both.write).toBe(true);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--write", "yes", "--out", "/tmp/x"], NOW)).toThrow(/--write/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--all"], NOW)).toThrow(/Unknown argument/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--business", BIZ_B], NOW)).toThrow(/more than once/);
    expect(parseAcceptanceArgs(["--business", BIZ, "--skip-decisions"], NOW).skipDecisions).toBe(true);
  });
});

/* ========================================================== classifiers */

describe("classifiers keep missing apart from measured zero", () => {
  it("link clicks", () => {
    expect(classifyLinkClickRow({ authoritativeSign: "positive", actionsIsArray: true })).toBe("measured_positive");
    expect(classifyLinkClickRow({ authoritativeSign: "zero", actionsIsArray: true })).toBe("measured_zero_with_provenance");
    expect(classifyLinkClickRow({ authoritativeSign: "null", actionsIsArray: false })).toBe("missing_actions_absent");
    expect(classifyLinkClickRow({ authoritativeSign: "null", actionsIsArray: true })).toBe("missing_other");
    // A zero with no actions array is exactly the fabrication the contract refuses.
    expect(classifyLinkClickRow({ authoritativeSign: "zero", actionsIsArray: false })).toBe(
      "contradiction_zero_without_provenance",
    );
  });

  it("funnel stages", () => {
    expect(classifyFunnelStageRow({ state: "measured", valueSign: "zero", actionsIsArray: true })).toBe("measured_zero");
    expect(classifyFunnelStageRow({ state: "unmeasurable", valueSign: "null", actionsIsArray: false })).toBe(
      "missing_actions_absent",
    );
    expect(classifyFunnelStageRow({ state: "unreadable", valueSign: "null", actionsIsArray: true })).toBe(
      "missing_unreadable",
    );
    expect(classifyFunnelStageRow({ state: "measured", valueSign: "zero", actionsIsArray: false })).toBe(
      "contradiction_measured_without_actions",
    );
  });

  it("purchases: a zero with no actions key is its own bucket", () => {
    expect(classifyPurchaseRow({ conversionsSign: "zero", actionsIsArray: false })).toBe("zero_without_actions_key");
    expect(classifyPurchaseRow({ conversionsSign: "zero", actionsIsArray: true })).toBe("measured");
    expect(classifyPurchaseRow({ conversionsSign: "positive", actionsIsArray: true })).toBe("measured");
  });

  it("ad spend 0: a measured zero row versus no row in the window", () => {
    expect(classifyAdSpend({ spend: 0, sourceRowCount: 3 })).toBe("measured_zero_row");
    expect(classifyAdSpend({ spend: 0, sourceRowCount: 0 })).toBe("no_row_in_window");
    expect(classifyAdSpend({ spend: null, sourceRowCount: 0 })).toBe("no_row_in_window");
    expect(classifyAdSpend({ spend: 12, sourceRowCount: 0 })).toBe("contradiction_spend_without_rows");
    expect(classifyAdSpend({ spend: 12, sourceRowCount: 5 })).toBe("measured_positive");
  });

  it("28-day link-click windows", () => {
    expect(classifyLinkClickWindow(null)).toBe("missing_window_incomplete");
    expect(classifyLinkClickWindow(0)).toBe("measured_zero");
    expect(classifyLinkClickWindow(7)).toBe("measured_positive");
  });

  it("config tier readiness comes from the production ladder", () => {
    expect(classifyConfigTier("provider_receipt_day_bracketed").readiness).toBe("decision_authority");
    expect(classifyConfigTier("provider_receipt_legacy_bracketed").readiness).toBe("decision_authority");
    expect(classifyConfigTier("typed_contemporaneous").readiness).toBe("review_only");
    expect(classifyConfigTier("provider_receipt_pending_corroboration").readiness).toBe("review_only");
    expect(classifyConfigTier("unknown").readiness).toBe("none");
    expect(classifyConfigTier("observed_absent").readiness).toBe("none");
    expect(classifyConfigTier("made_up_tier")).toEqual({ tier: "made_up_tier", knownTier: false, readiness: "none" });
    expect(classifyConfigTier(null).readiness).toBe("none");
  });

  it("coverage, role trust and resolver arming", () => {
    expect(classifyCoverage({ expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-21" })).toEqual({ status: "complete", lagDays: 0 });
    expect(classifyCoverage({ expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-20" })).toEqual({ status: "partial", lagDays: 1 });
    expect(classifyCoverage({ expectedThroughDay: null, coverageThroughDay: "2026-09-20" }).status).toBe("unavailable");
    expect(classifyCoverage({ expectedThroughDay: "2026-09-21", coverageThroughDay: null }).status).toBe("unavailable");
    expect(classifyRoleTrust("high")).toBe("high");
    expect(classifyRoleTrust("conflict")).toBe("unknown");
    expect(classifyRoleTrust(undefined)).toBe("unknown");
    expect(describeResolverArming({ approvedVersion: null, requiredVersion: "v2" }).resolverArmed).toBe(false);
    expect(describeResolverArming({ approvedVersion: "v2", requiredVersion: "v2" }).resolverArmed).toBe(true);
  });
});

/* ============================================= in-memory generation build */

const ACCT = "act_100";
const REF = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ASOF = "2026-09-22";
const CUTOFF = "2026-09-22T23:59:59.999Z";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const JOB = simulatedJobRunId({ businessId: BIZ, providerAccountId: ACCT, cutoff: CUTOFF });

function payload(adId: string, overrides: Partial<SimulatedPayload> = {}): SimulatedPayload {
  return {
    provider_account_ref_id: REF,
    provider_account_id: ACCT,
    ad_id: adId,
    creative_id: `creative-${adId}`,
    as_of_date: ASOF,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: ACCT,
    label: "keep",
    raw_label: "keep",
    pre_authority_label: "keep",
    authority_blocker: null,
    confidence: 40,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 1,
    badges: [],
    reason: "fixture",
    spend: 10,
    purchases: 1,
    roas: 2,
    recent7d_roas: 2,
    label_transform: null,
    blocked_action_type: null,
    authorized_action: null,
    job_run_id: JOB,
    evaluation_id: `${SYNTHETIC_ID_PREFIX}evaluation:${sha(`decision-${adId}`)}`,
    input_hash: sha(`input-${adId}`),
    decision_hash: sha(`decision-${adId}`),
    computed_at: CUTOFF,
    ...overrides,
  };
}

function entry(adId: string, overrides: Partial<SimulatedPayload> = {}): SimulatedDecisionEntry {
  const p = payload(adId, overrides);
  return {
    payload: p,
    evaluation: {
      contractVersion: "engine-v3-canonical-ad-evaluation.v13",
      inputPayload: {
        creativeInput: { adId },
        configEvidence: {
          currentValueEvidence: { observed: true, refs: { objective: null }, refRefusals: {}, lineageSupplied: true },
          decisionEconomics: { fullyVerified: false, receiptManifest: null },
          currentConfigDay: ASOF,
        },
        metricContract: { version: "fixture" },
      },
      decisionPayload: { decision: { label: p.label, blockers: [{ predicate: "p", status: "failed" }] } },
      inputHash: p.input_hash,
      decisionHash: p.decision_hash,
    },
  };
}

const AD_IDS = ["ad-1", "ad-2", "ad-3"];
function receipt(overrides: Partial<SimulatedHydrationReceipt> = {}): SimulatedHydrationReceipt {
  const manifest = hashAdDecisionIdentityManifest({ businessId: BIZ, providerAccountId: ACCT, asOfDate: ASOF, adIds: AD_IDS });
  return {
    providerAccountRefId: REF,
    providerAccountId: ACCT,
    expectedAdCount: 3,
    hydratedAdCount: 3,
    expectedManifestHash: manifest,
    hydratedManifestHash: manifest,
    authoritativeForPrune: true,
    sourceComplete: true,
    hydrationComplete: true,
    reason: null,
    ...overrides,
  };
}

function entries(): SimulatedDecisionEntry[] {
  return [
    entry("ad-1"),
    entry("ad-2", { label: "test_more", raw_label: "test_more", pre_authority_label: "test_more" }),
    // A held Cut: the D101 gate kept its hard label and its held action.
    entry("ad-3", {
      label: "cut",
      raw_label: "cut",
      pre_authority_label: "cut",
      authority_blocker: "source_freshness",
      blocked_action_type: "cut",
    }),
  ];
}

describe("buildSimulatedGeneration", () => {
  it("refuses a receipt that fails the production gate and presents nothing", () => {
    for (const bad of [
      receipt({ authoritativeForPrune: false }),
      receipt({ hydratedAdCount: 2 }),
      receipt({ hydratedManifestHash: sha("other") }),
      receipt({ expectedManifestHash: "not-a-hash", hydratedManifestHash: "not-a-hash" }),
    ]) {
      const result = buildSimulatedGeneration({
        businessId: BIZ, asOf: ASOF, cutoff: CUTOFF, receipt: bad, entries: entries(),
        identityByAdId: new Map(), priorEpisodes: new Map(), hashIntegrityVerified: true,
      });
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toBe("receipt_unreconstructable");
        expect(result.receiptGate.pass).toBe(false);
      }
    }
    expect(evaluateReceiptGate(receipt()).pass).toBe(true);
  });

  it("builds one visibly synthetic job run, keeps the receipt's manifest hash, and passes the production validator", () => {
    const result = buildSimulatedGeneration({
      businessId: BIZ, asOf: ASOF, cutoff: CUTOFF, receipt: receipt(), entries: entries(),
      identityByAdId: new Map([["ad-1", { campaign_id: "c-1", ad_status: "ACTIVE", campaign_status: "ACTIVE", adset_status: "ACTIVE" }]]),
      priorEpisodes: new Map([[`${ACCT}\u0000ad-3`, { label: "cut", start: "2026-09-21" }], [`${ACCT}\u0000ad-1`, { label: "cut", start: "2026-09-20" }]]),
      hashIntegrityVerified: true,
    });
    expect(result.status).toBe("built");
    if (result.status !== "built") return;
    expect(result.generation.jobRunId).toBe(JOB);
    expect(result.generation.jobRunId.startsWith(SYNTHETIC_ID_PREFIX)).toBe(true);
    expect(result.generation.manifestHash).toBe(receipt().expectedManifestHash);
    expect(new Set(result.rows.map((row) => row.job_run_id))).toEqual(new Set([JOB]));
    for (const row of result.rows) {
      expect(row.snapshot_id.startsWith(SYNTHETIC_ID_PREFIX)).toBe(true);
      expect(row.evaluation_id.startsWith(SYNTHETIC_ID_PREFIX)).toBe(true);
      expect(row.lineage_valid).toBe(true);
    }
    // Episodes come from the simulated chain only: a same-label prior keeps its start.
    expect(result.rows.find((row) => row.ad_id === "ad-3")!.episode_started_at).toBe("2026-09-21");
    expect(result.rows.find((row) => row.ad_id === "ad-1")!.episode_started_at).toBe(ASOF);
    expect(result.rows.find((row) => row.ad_id === "ad-1")!.ad_status).toBe("ACTIVE");
    expect(result.rows.find((row) => row.ad_id === "ad-2")!.ad_status).toBeNull();
    expect(result.rows[0]!.config_authority_verified).toBe(false);
    expect(result.rows[0]!.predicate_blockers).toEqual([{ predicate: "p", status: "failed" }]);

    const validation = validateMetaNativeDecisionGenerationBundle({
      businessId: BIZ, providerAccountId: ACCT, generation: result.generation, snapshotRows: result.rows,
    });
    expect(validation.status).toBe("available");
  });

  it("never lets unverified hashes pass as lineage", () => {
    const result = buildSimulatedGeneration({
      businessId: BIZ, asOf: ASOF, cutoff: CUTOFF, receipt: receipt(), entries: entries(),
      identityByAdId: new Map(), priorEpisodes: new Map(), hashIntegrityVerified: false,
    });
    expect(result.status).toBe("built");
    if (result.status !== "built") return;
    expect(result.lineageValidRows).toBe(0);
    const validation = validateMetaNativeDecisionGenerationBundle({
      businessId: BIZ, providerAccountId: ACCT, generation: result.generation, snapshotRows: result.rows,
    });
    expect(validation.validationIssue).toBe("lineage_incomplete");
  });

  it("never recomputes the manifest to fit the rows", () => {
    const foreign = hashAdDecisionIdentityManifest({ businessId: BIZ, providerAccountId: ACCT, asOfDate: ASOF, adIds: ["ad-1", "ad-2", "ad-9"] });
    const result = buildSimulatedGeneration({
      businessId: BIZ, asOf: ASOF, cutoff: CUTOFF,
      receipt: receipt({ expectedManifestHash: foreign, hydratedManifestHash: foreign }),
      entries: entries(), identityByAdId: new Map(), priorEpisodes: new Map(), hashIntegrityVerified: true,
    });
    expect(result.status).toBe("built");
    if (result.status !== "built") return;
    expect(result.generation.manifestHash).toBe(foreign);
    expect(
      validateMetaNativeDecisionGenerationBundle({
        businessId: BIZ, providerAccountId: ACCT, generation: result.generation, snapshotRows: result.rows,
      }).validationIssue,
    ).toBe("manifest_hash_mismatch");
  });

  it("refuses a per-ad job run id and a non-synthetic evaluation id", () => {
    const perAd = buildSimulatedGeneration({
      businessId: BIZ, asOf: ASOF, cutoff: CUTOFF, receipt: receipt(),
      entries: [entry("ad-1", { job_run_id: `${SYNTHETIC_ID_PREFIX}${ASOF}:ad-1` })],
      identityByAdId: new Map(), priorEpisodes: new Map(), hashIntegrityVerified: true,
    });
    expect(perAd.status === "refused" && perAd.reason).toBe("job_run_mismatch");
    const uuidLooking = buildSimulatedGeneration({
      businessId: BIZ, asOf: ASOF, cutoff: CUTOFF, receipt: receipt(),
      entries: [entry("ad-1", { evaluation_id: "0b7c1f5e-1111-4222-8333-444444444444" })],
      identityByAdId: new Map(), priorEpisodes: new Map(), hashIntegrityVerified: true,
    });
    expect(uuidLooking.status === "refused" && uuidLooking.reason).toBe("non_synthetic_identifier");
  });
});

/* ========================================== read-model projection parity */

describe("config projection parity with the read-model SQL", () => {
  const repo = path.resolve(__dirname, "../..");
  const readModelSql = readFileSync(path.join(repo, "lib/meta/decisions-workspace-read-model.ts"), "utf8");
  const evaluationStore = readFileSync(path.join(repo, "lib/creative-decision-engine/evaluation-store.ts"), "utf8");

  it("pins the SQL this projection restates (the mapping is not exported)", () => {
    for (const fragment of [
      "WHEN input_evidence.input_evidence_json -> 'configEvidence' IS NULL",
      "OR jsonb_typeof(input_evidence.input_evidence_json -> 'configEvidence') <> 'object'",
      "(input_evidence.input_evidence_json #>> '{configEvidence,currentValueEvidence,observed}') = 'true'",
      "AND (input_evidence.input_evidence_json #>> '{configEvidence,decisionEconomics,fullyVerified}') = 'true',",
      "FALSE\n        )\n      END AS config_authority_verified",
      "WHEN jsonb_typeof(input_evidence.input_evidence_json -> 'configEvidence') = 'object'",
      "'contractVersion', evaluation.contract_version,",
      "'refs', input_evidence.input_evidence_json #> '{configEvidence,currentValueEvidence,refs}',",
      "'refRefusals', input_evidence.input_evidence_json #> '{configEvidence,currentValueEvidence,refRefusals}',",
      "'lineageSupplied', input_evidence.input_evidence_json #> '{configEvidence,currentValueEvidence,lineageSupplied}',",
      "'receiptManifest', input_evidence.input_evidence_json #> '{configEvidence,decisionEconomics,receiptManifest}',",
      "'currentConfigDay', input_evidence.input_evidence_json #> '{configEvidence,currentConfigDay}',",
      "'metricContract', input_evidence.input_evidence_json -> 'metricContract'",
      "evaluation.decision_output_json -> 'blockers' AS predicate_blockers",
    ]) {
      expect(readModelSql).toContain(fragment);
    }
    expect(evaluationStore).toContain("configEvidence: evaluation.inputPayload.configEvidence ?? null,");
    expect(evaluationStore).toContain("metricContract: evaluation.inputPayload.metricContract ?? null,");
    expect(evaluationStore).toContain("decision_output_json: evaluation.decisionPayload.decision,");
  });

  it("matches the CASE semantics on fixtures", () => {
    const verified = persistedInputEvidence({
      configEvidence: { currentValueEvidence: { observed: true }, decisionEconomics: { fullyVerified: true } },
      metricContract: { v: 1 },
    });
    expect(projectConfigAuthorityVerified(verified)).toBe(true);
    // Only one half true -> FALSE (COALESCE of NULL/FALSE), never NULL.
    expect(projectConfigAuthorityVerified(persistedInputEvidence({
      configEvidence: { currentValueEvidence: { observed: true }, decisionEconomics: { fullyVerified: false } },
    }))).toBe(false);
    expect(projectConfigAuthorityVerified(persistedInputEvidence({
      configEvidence: { currentValueEvidence: { observed: true } },
    }))).toBe(false);
    // #>> reads a JSON string "true" as 'true', exactly as the SQL does.
    expect(projectConfigAuthorityVerified({
      configEvidence: { currentValueEvidence: { observed: "true" }, decisionEconomics: { fullyVerified: "true" } },
    })).toBe(true);
    // Absent, JSON null, and non-object configEvidence -> NULL.
    expect(projectConfigAuthorityVerified(persistedInputEvidence({}))).toBeNull();
    expect(projectConfigAuthorityVerified({ metricContract: null })).toBeNull();
    expect(projectConfigAuthorityVerified({ configEvidence: [true] })).toBeNull();

    expect(projectConfigEvidenceLineage(persistedInputEvidence({}), "v13")).toBeNull();
    expect(
      projectConfigEvidenceLineage(
        persistedInputEvidence({
          configEvidence: {
            currentValueEvidence: { refs: { objective: { id: 1 } }, lineageSupplied: true },
            decisionEconomics: { receiptManifest: { hash: "h" } },
            currentConfigDay: "2026-09-22",
          },
          metricContract: { version: "m" },
        }),
        "v13",
      ),
    ).toEqual({
      contractVersion: "v13",
      refs: { objective: { id: 1 } },
      refRefusals: null,
      lineageSupplied: true,
      receiptManifest: { hash: "h" },
      currentConfigDay: "2026-09-22",
      metricContract: { version: "m" },
    });
    expect(projectPredicateBlockers({ decision: { label: "keep" } })).toBeNull();
    expect(projectPredicateBlockers({ decision: { blockers: [] } })).toEqual([]);
  });
});

/* ============================================================ invariants */

function hardRow(overrides: Partial<HardRowRecord> = {}): HardRowRecord {
  return {
    asOf: ASOF,
    providerAccountId: ACCT,
    adId: "ad-3",
    campaignId: "c-1",
    adsetId: "as-1",
    rawLabel: "cut",
    preAuthorityLabel: "cut",
    publishedLabel: "cut",
    hysteresisSuppressed: false,
    firstAuthorityBlocker: null,
    effectiveAuthorityBlocker: "source_freshness",
    blockedActionType: "cut",
    authorizedAction: null,
    confidence: 70,
    profileBlocker: null,
    hardActionEligibility: { scale: false, cut: true, refresh: false },
    config: { observed: false, fullyVerified: false, blockingField: "objective", weakestTier: "unknown", unverifiedEconomicDayCount: 11 },
    coverage: { status: "partial", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-20" },
    dataFreshnessHours: null,
    role: { trust: "medium", campaignRoleStatus: "resolved", resolverArmed: false },
    priorSource: "persisted_evaluation",
    failedPredicates: [],
    ...overrides,
  };
}

function accountDay(overrides: Partial<DecisionAccountDayReport> = {}): DecisionAccountDayReport {
  return {
    providerAccountId: ACCT,
    receipt: {
      sourceComplete: true, hydrationComplete: true, authoritativeForPrune: true,
      expectedAdCount: 3, hydratedAdCount: 3, reason: null, gate: { pass: true, failures: [] },
    },
    ads: 3,
    rawHard: { cut: 1 },
    preAuthorityHard: { cut: 1 },
    publishedHard: { cut: 1 },
    hysteresisSuppressed: 0,
    authorizedActions: { none: 3 },
    blockedActionType: { cut: 1, none: 2 },
    firstAuthorityBlocker: { none: 3 },
    effectiveAuthorityBlocker: { none: 2, source_freshness: 1 },
    config: { observed: 0, fullyVerified: 0, blockingField: { objective: 3 } },
    coverage: { partial: 3 },
    calibration: {},
    role: { trust: { medium: 3 }, resolverArmed: { false: 3 }, campaignRoleStatus: { resolved: 3 } },
    priorSource: { persisted_evaluation: 3 },
    metrics: { linkClicks28d: { missing_window_incomplete: 1, measured_positive: 2 }, spend: { measured_positive: 2, no_row_in_window: 1 }, linkClicksZeroWithoutRows: 0 },
    crossCheck: {
      hydrationFullyVerified: [],
      hydrationCoverage: { partial: 3 },
      independent: independentReading(),
    },
    ...overrides,
  };
}

function independentReading(overrides: Partial<IndependentReading> = {}): IndependentReading {
  return {
    cutoff: CUTOFF,
    scope: { start: "2026-07-25", end: ASOF },
    coverage: { status: "partial", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-20", accountTimezone: "UTC" },
    objectiveAuthorityCampaigns: [],
    objectiveEconomicCampaigns: 1,
    adsetGoalAuthorityAdsets: [],
    adsetGoalEconomicAdsets: 1,
    error: null,
    ...overrides,
  };
}

function ledgerAccount(overrides: Partial<LedgerAccountReport> = {}): LedgerAccountReport {
  return {
    providerAccountId: ACCT,
    providerAccountRefId: REF,
    selected: true,
    adDays: { adDays: 100, spendPositive: 90, currentVersionVisibleAfter72h: 12 },
    restatedAfterCutoff: [{ asOf: ASOF, cutoff: CUTOFF, hydrationWindow28d: { restatedRows: 7 } }],
    linkClicks: { measured_positive: 80, measured_zero_with_provenance: 10, missing_actions_absent: 10 },
    funnel: { landing_page_view: { measured_positive: 70, measured_zero: 20, missing_actions_absent: 10 } },
    purchasesOnSpendRows: { measured: 80, zero_without_actions_key: 10 },
    objective: {
      cutoff: CUTOFF,
      scopeRows: 20, byTier: { unknown: 12, typed_contemporaneous: 8 }, byReadiness: { none: 12, review_only: 8 },
      unknownTierStrings: 0, readinessDisagreements: 0, sqlGrantedBeyondLadder: 0, decisionAuthorityDays: [],
    },
    adsetGoal: null,
    configObservations: [
      { endpoint: "campaign_configs", utcDay: "2026-09-10", obs: 58, ok200: 0, complete200: 0, http400: 58 },
      { endpoint: "campaign_configs", utcDay: "2026-08-30", obs: 0, ok200: 0, complete200: 0, http400: 0 },
    ],
    coverageAtRunSlots: {
      counts: { partial: 2 },
      bySlot: {},
      slots: [
        { asOf: ASOF, slot: "03:05Z", cutoff: "", accountTimezone: "UTC", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-20", status: "partial", lagDays: 1 },
        { asOf: ASOF, slot: "15:05Z", cutoff: "", accountTimezone: "UTC", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-20", status: "partial", lagDays: 1 },
      ],
    },
    metaAov: { aovMean: 215.7, purchaseCount: 948 },
    targetAuthority: null,
    ...overrides,
  };
}

function ledger(accounts: LedgerAccountReport[] = [ledgerAccount()]): LedgerLaneReport {
  return {
    status: "computed",
    snapshot: { transactionStartedAt: "t", snapshotId: "s" },
    runtimeMs: 1,
    accounts: { selected: [ACCT], deselected: [] },
    perAccount: accounts,
    campaignContext: {
      resolverArmed: false, approvedVersion: null, requiredVersion: "v2", groups: [], byConfidenceClass: {},
      rowsMatchingRequiredResolver: 0, rows: 0, windowDaysWithoutRows: ["2026-08-25"],
    },
    restatedAfterCutoffBusiness90d: [],
  };
}

function auditOk() {
  return auditServedAuthority({
    rows: [{ ad_id: "ad-3", authorized_action: null, blocked_action_type: "cut" }],
    inventory: [{ adId: "ad-3", actionEligible: false, authorizedAction: null, heldAction: "cut", decisionState: "blocked" }],
  });
}

function mode(overrides: Partial<PresentationModeReport> = {}): PresentationModeReport {
  return {
    mode: "actual_governance",
    governance: {},
    pipeline: { verified: false, executionReady: false, basis: "fixture" },
    inventory: { items: 3 },
    sourceBacking: {
      basis: "metricEvidence.sourceRowCount_gt_0_in_decision_window",
      sourceBackedAds: 3, sourceBackedInventoryItems: 3, sourceBackedBriefingCards: 3,
      smallestAdLimit: 60, sourceBackedOsItemsAtSmallestLimit: 3, sourceBackedPresentedAds: 3,
    },
    briefing: { projectionNulls: 0, statusFilter: "active", lanes: { action: 0, watching: 3, healthy: 0 }, servedClassifications: 3, studioAdsIndexed: 3 },
    authorityAudit: auditOk(),
    workspace: [
      { limit: 60, status: "available", os: { items: 60 }, heldServed: locateHeldVerdicts({ heldAdIds: ["ad-3"], servedAdIds: [], archivedAdIds: [] }), eligiblePreCapCount: 80, exactAdapter: null, error: null },
      { limit: 300, status: "available", os: { items: 80 }, heldServed: locateHeldVerdicts({ heldAdIds: ["ad-3"], servedAdIds: ["ad-3"], archivedAdIds: [] }), eligiblePreCapCount: 80, exactAdapter: null, error: null },
    ],
    ...overrides,
  };
}

function presentationAccount(overrides: Partial<PresentationAccountReport> = {}): PresentationAccountReport {
  return {
    providerAccountId: ACCT, asOf: ASOF, cutoff: CUTOFF, status: "presented",
    receiptGate: { pass: true, failures: [] }, refusal: null, validation: { status: "available", issue: null },
    generation: { jobRunId: JOB, manifestHash: sha("m"), expectedAdCount: 3, rows: 3, lineageValidRows: 3 },
    identity: null,
    hierarchyAtCutoff: summarizeHierarchyAtCutoff([
      { ad_status: "ACTIVE", adset_status: "ACTIVE", campaign_status: "ACTIVE" },
      { ad_status: "ACTIVE", adset_status: "ACTIVE", campaign_status: "ACTIVE" },
      { ad_status: "PAUSED", adset_status: "ACTIVE", campaign_status: "ACTIVE" },
    ]),
    targetHardActionEligibility: null, modes: [mode()], error: null,
    ...overrides,
  };
}

function business(overrides: Partial<BusinessAcceptanceReport> = {}): BusinessAcceptanceReport {
  return {
    businessId: BIZ,
    role: "subject",
    ledger: ledger(),
    decisions: {
      status: "computed", reason: null, snapshot: { transactionStartedAt: "t", snapshotId: "s" }, runtimeMs: 1, policy: null,
      days: [{
        asOf: ASOF, cutoff: CUTOFF, status: "computed", reason: null, timingsMs: {}, hashIntegrity: null,
        hysteresis: null, pointInTime: null, perAccount: [accountDay()], hardRows: [hardRow()],
      }],
    },
    presentation: { status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF, accounts: [presentationAccount()] },
    persistedServed: {
      status: "computed", snapshot: { transactionStartedAt: "t", snapshotId: "s" }, runtimeMs: 1, servingInstant: "now",
      accounts: [{
        providerAccountId: ACCT,
        bundle: { status: "unavailable", unavailableReason: "native_latest_job_engine_mismatch", validationIssue: null, degraded: false },
        latestRow: {
          engine_version: "v3-ad-older", as_of_date: "2026-09-23", job_status: "success",
          expected_ad_count: 3, hydrated_ad_count: 3, manifest_matches: true, authoritative_for_prune: true,
        },
        headEngineVersion: NATIVE_AD_ENGINE_VERSION, latestEngineMatchesHead: false, latestGenerationCounts: null, workspace: null,
      }],
    },
    negativeControl: null,
    ...overrides,
  };
}

const codes = (findings: ReadonlyArray<{ code: string }>) => findings.map((finding) => finding.code);

/** A fixture control campaign; the harness takes it from --negative-control-campaign. */
const CONTROL_CAMPAIGN = "120243489401800340";
const TARGET_DAYS = ["2026-09-21", ASOF];

/** A source-backed, meaningful control: found, no objective authority on the target days, one held cut. */
function controlReport(overrides: Partial<NegativeControlReport> = {}): NegativeControlReport {
  return {
    campaignId: CONTROL_CAMPAIGN,
    from: "2026-08-25",
    to: ASOF,
    snapshot: { transactionStartedAt: "t", snapshotId: "s" },
    targetDays: TARGET_DAYS,
    campaignFound: true,
    campaignAccounts: [{ providerAccountId: ACCT, adDays: 40, spendPositiveAdDays: 30, targetDayAdDays: 4 }],
    objectiveByDay: TARGET_DAYS.map((day) => ({
      day, tier: "typed_contemporaneous", readiness: "review_only", value: "OUTCOME_SALES", pitClass: "as_of_known",
    })),
    objectiveAtTargetCutoffs: TARGET_DAYS.map((day) => ({
      day, cutoff: `${day}T23:59:59.999Z`, providerAccountId: ACCT, tier: "typed_contemporaneous", readiness: "review_only",
    })),
    decisionAuthorityDays: [],
    simulatedHardRows: [hardRow({ campaignId: CONTROL_CAMPAIGN })],
    simulatedAuthorizedActions: 0,
    persistedHardRows: [],
    ...overrides,
  };
}

describe("evaluateAcceptanceInvariants", () => {
  it("reports expected source gaps as observations, never as violations", () => {
    const result = evaluateAcceptanceInvariants({
      businesses: [business({
        presentation: {
          status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF,
          accounts: [
            presentationAccount(),
            presentationAccount({ providerAccountId: "act_200", status: "receipt_unreconstructable", receiptGate: { pass: false, failures: ["not_authoritative_for_prune"] }, generation: null, modes: [] }),
          ],
        },
      })],
    });
    expect(result.violations).toEqual([]);
    expect(result.laneFailures).toEqual([]);
    const observed = codes(result.observations);
    for (const code of [
      "role_resolver_unarmed",
      "role_context_rows_absent",
      "link_clicks_missing_actions_absent",
      "purchases_zero_without_actions_key",
      "objective_receipts_absent_or_review_only",
      "config_observations_absent",
      "config_observations_http_400_only",
      "coverage_partial_by_timing",
      "restated_after_cutoff",
      "ad_days_first_visible_after_72h",
      "spend_zero_no_row_in_window",
      "decision_coverage_not_complete",
      "decision_config_not_fully_verified",
      "cap_hides_held_verdicts",
      "presentation_withheld_receipt_unreconstructable",
      "persisted_served_engine_mismatch",
    ]) {
      expect(observed).toContain(code);
    }
  });

  it("flags an authorized action without verified config, complete coverage and a null blocker", () => {
    const row = hardRow({ authorizedAction: "cut", effectiveAuthorityBlocker: null, blockedActionType: null });
    const result = evaluateAcceptanceInvariants({
      businesses: [business({
        decisions: {
          status: "computed", reason: null, snapshot: null, runtimeMs: 1, policy: null,
          days: [{ asOf: ASOF, cutoff: CUTOFF, status: "computed", reason: null, timingsMs: {}, hashIntegrity: null, hysteresis: null, pointInTime: null,
            perAccount: [accountDay({ authorizedActions: { cut: 1, none: 2 } })], hardRows: [row] }],
        },
      })],
    });
    expect(codes(result.violations)).toContain("authorized_action_without_evidence");
    // A fully grounded one is not a violation.
    const grounded = hardRow({
      authorizedAction: "cut", effectiveAuthorityBlocker: null, blockedActionType: null,
      config: { observed: true, fullyVerified: true, blockingField: null, weakestTier: "provider_receipt_day_bracketed", unverifiedEconomicDayCount: 0 },
      coverage: { status: "complete", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-21" },
    });
    const clean = evaluateAcceptanceInvariants({
      businesses: [business({
        decisions: {
          status: "computed", reason: null, snapshot: null, runtimeMs: 1, policy: null,
          days: [{ asOf: ASOF, cutoff: CUTOFF, status: "computed", reason: null, timingsMs: {}, hashIntegrity: null, hysteresis: null, pointInTime: null,
            perAccount: [accountDay({ authorizedActions: { cut: 1, none: 2 } })], hardRows: [grounded] }],
        },
      })],
    });
    expect(codes(clean.violations)).not.toContain("authorized_action_without_evidence");
    expect(codes(clean.violations)).not.toContain("authorized_action_unaccounted");
  });

  it("flags served authority that the generation does not grant, and a held verdict missing from the inventory", () => {
    const audit = auditServedAuthority({
      rows: [
        { ad_id: "ad-1", authorized_action: null, blocked_action_type: null },
        { ad_id: "ad-3", authorized_action: null, blocked_action_type: "cut" },
      ],
      inventory: [{ adId: "ad-1", actionEligible: true, authorizedAction: "cut", heldAction: null, decisionState: "act" }],
      briefingActionAdIds: ["ad-1"],
      osItems: [{ adId: "ad-1", lane: "act", intent: "execute", providerMutation: "pause", heldAction: null }],
    });
    const result = evaluateAcceptanceInvariants({
      businesses: [business({
        presentation: { status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF, accounts: [presentationAccount({ modes: [mode({ authorityAudit: audit })] })] },
      })],
    });
    const violated = codes(result.violations);
    expect(violated).toContain("served_action_eligible_without_authorized_action");
    expect(violated).toContain("served_authorized_action_differs_from_generation");
    expect(violated).toContain("action_lane_card_without_authorized_action");
    expect(violated).toContain("executable_os_row_without_authorized_action");
    expect(violated).toContain("held_hard_verdict_absent_from_canonical_inventory");
  });

  it("does not treat a role-held manual Cut in the Act lane as executable", () => {
    const audit = auditServedAuthority({
      rows: [{ ad_id: "ad-3", authorized_action: null, blocked_action_type: "cut" }],
      inventory: [{ adId: "ad-3", actionEligible: false, authorizedAction: null, heldAction: "cut", decisionState: "blocked" }],
      osItems: [{ adId: "ad-3", lane: "act", intent: "manual", providerMutation: null, heldAction: "cut" }],
    });
    expect(audit.osExecutableWithoutAuthorized).toEqual([]);
  });

  it("flags a null briefing projection and a generation presented from a failing receipt", () => {
    const result = evaluateAcceptanceInvariants({
      businesses: [business({
        presentation: {
          status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF,
          accounts: [presentationAccount({
            receiptGate: { pass: false, failures: ["not_authoritative_for_prune"] },
            modes: [mode({ briefing: { projectionNulls: 2, statusFilter: "active", lanes: { action: 0, watching: 0, healthy: 0 }, servedClassifications: 0, studioAdsIndexed: 0 } })],
          })],
        },
      })],
    });
    expect(codes(result.violations)).toEqual(
      expect.arrayContaining(["briefing_projection_null", "generation_presented_from_non_authoritative_receipt"]),
    );
  });

  it("flags a missing metric counted as a measured zero", () => {
    const result = evaluateAcceptanceInvariants({
      businesses: [business({
        ledger: ledger([ledgerAccount({
          linkClicks: { measured_positive: 5, contradiction_zero_without_provenance: 2 },
          funnel: { add_to_cart: { contradiction_measured_without_actions: 1 } },
        })]),
      })],
    });
    expect(codes(result.violations).filter((code) => code === "missing_metric_counted_as_measured_zero")).toHaveLength(2);
    const decisionZero = evaluateAcceptanceInvariants({
      businesses: [business({
        decisions: {
          status: "computed", reason: null, snapshot: null, runtimeMs: 1, policy: null,
          days: [{ asOf: ASOF, cutoff: CUTOFF, status: "computed", reason: null, timingsMs: {}, hashIntegrity: null, hysteresis: null, pointInTime: null,
            perAccount: [accountDay({ metrics: { linkClicks28d: {}, spend: {}, linkClicksZeroWithoutRows: 1 } })], hardRows: [hardRow()] }],
        },
      })],
    });
    expect(codes(decisionZero.violations)).toContain("missing_metric_counted_as_measured_zero");
  });

  it("holds the negative control to no authority and no verified objective", () => {
    const control = business({
      businessId: BIZ_B,
      role: "negative_control",
      decisions: {
        status: "computed", reason: null, snapshot: null, runtimeMs: 1, policy: null,
        days: [{ asOf: ASOF, cutoff: CUTOFF, status: "computed", reason: null, timingsMs: {}, hashIntegrity: null, hysteresis: null, pointInTime: null,
          perAccount: [accountDay({ authorizedActions: { cut: 1, none: 2 } })],
          hardRows: [hardRow({
            authorizedAction: "cut", effectiveAuthorityBlocker: null, blockedActionType: null,
            config: { observed: true, fullyVerified: true, blockingField: null, weakestTier: null, unverifiedEconomicDayCount: 0 },
            coverage: { status: "complete", expectedThroughDay: "x", coverageThroughDay: "x" },
          })] }],
      },
      negativeControl: controlReport({
        objectiveByDay: [{ day: "2026-09-10", tier: "provider_receipt_day_bracketed", readiness: "decision_authority", value: "OUTCOME_SALES", pitClass: "as_of_known" }],
        decisionAuthorityDays: ["2026-09-10"], simulatedHardRows: [],
      }),
    });
    const result = evaluateAcceptanceInvariants({ businesses: [control] });
    expect(codes(result.violations)).toContain("negative_control_authorized_action");
    // A window-end objective reading is evidence about the control, not fail-open: a later receipt
    // can bracket an earlier day. The gate judges each target day at its own cutoff instead.
    expect(codes(result.violations)).not.toContain("negative_control_objective_verified");
    expect(codes(result.observations)).toContain("negative_control_objective_verified");
    const heldOnly = business({
      businessId: BIZ_B,
      role: "negative_control",
      negativeControl: controlReport({
        objectiveByDay: [{ day: "2026-09-10", tier: "typed_contemporaneous", readiness: "review_only", value: "OUTCOME_SALES", pitClass: "as_of_known" }],
        simulatedHardRows: [hardRow({ campaignId: CONTROL_CAMPAIGN })],
      }),
    });
    const clean = evaluateAcceptanceInvariants({ businesses: [heldOnly] });
    expect(clean.violations).toEqual([]);
    expect(codes(clean.observations)).toContain("negative_control_hard_verdicts_held");
  });

  it("reports a failed lane separately from violations, and summarizes", () => {
    const failed = business({ ledger: { status: "failed", error: "boom" } });
    const result = evaluateAcceptanceInvariants({ businesses: [failed] });
    expect(result.violations).toEqual([]);
    expect(codes(result.laneFailures)).toEqual(["lane_failed"]);
    const [row] = summarizeReport({ businesses: [business()] });
    expect(row!.business).toBe(BIZ.slice(0, 8));
    expect(row!.days).toContain("raw1/pre1/pub1/held1/auth0");
    expect(row!.persisted).toContain("native_latest_job_engine_mismatch");
  });
});

/* ==================================================== release acceptance */

function acceptedBusiness(): BusinessAcceptanceReport {
  const base = business();
  return {
    ...base,
    decisions: {
      status: "computed", reason: null, snapshot: null, runtimeMs: 1, policy: null,
      days: [
        { asOf: "2026-09-21", cutoff: "2026-09-21T23:59:59.999Z", status: "computed", reason: null, timingsMs: {},
          hashIntegrity: { canonicalHashesVerified: true }, hysteresis: null, pointInTime: null,
          perAccount: [accountDay()], hardRows: [hardRow()] },
        { asOf: ASOF, cutoff: CUTOFF, status: "computed", reason: null, timingsMs: {},
          hashIntegrity: { canonicalHashesVerified: true }, hysteresis: null, pointInTime: null,
          perAccount: [accountDay()], hardRows: [hardRow()] },
      ],
    },
    presentation: {
      status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF,
      accounts: [presentationAccount({ modes: [mode(), mode({ mode: "governance_verified_counterfactual" })] })],
    },
    persistedServed: {
      status: "computed", snapshot: { transactionStartedAt: "t", snapshotId: "s" }, runtimeMs: 1, servingInstant: "now",
      accounts: [{
        providerAccountId: ACCT,
        bundle: { status: "available", unavailableReason: null, validationIssue: null, degraded: false },
        latestRow: { engine_version: NATIVE_AD_ENGINE_VERSION, as_of_date: "2026-09-23" },
        headEngineVersion: NATIVE_AD_ENGINE_VERSION, latestEngineMatchesHead: true, latestGenerationCounts: null, workspace: null,
      }],
    },
  };
}

/** The POST_DEPLOY gate: the strict one the original release criteria describe. */
function releaseOf(
  businesses: BusinessAcceptanceReport[],
  runMode: "release" | "diagnostic" = "release",
  gate: "pre_deploy" | "post_deploy" = "post_deploy",
) {
  const report = { mode: runMode, businesses };
  const release = evaluateReleaseAcceptance(report, gate);
  return { release, exit: decideExitCode({ invariants: evaluateAcceptanceInvariants(report), release }) };
}

describe("evaluateReleaseAcceptance and the exit code", () => {
  it("passes only when every business has a successful day, a successful presentation and an available served generation", () => {
    const { release, exit } = releaseOf([acceptedBusiness()]);
    expect(release.accepted).toBe(true);
    expect(release.label).toBe("POST_DEPLOY GATE PASSED");
    expect(release.businesses[0]!.successfulDecisionDays).toEqual(["2026-09-21", ASOF]);
    expect(exit).toBe(0);
  });

  it("all decision days failed => not accepted", () => {
    const failedDays = acceptedBusiness();
    failedDays.decisions = {
      status: "computed", reason: null, snapshot: null, runtimeMs: 1, policy: null,
      days: ["2026-09-21", ASOF].map((asOf) => ({
        asOf, cutoff: `${asOf}T23:59:59.999Z`, status: "failed" as const, reason: "NativeAdProfileProvenanceError: boom",
        timingsMs: {}, hashIntegrity: null, hysteresis: null, pointInTime: null, perAccount: [], hardRows: [],
      })),
    };
    const { release, exit } = releaseOf([failedDays]);
    expect(release.accepted).toBe(false);
    expect(release.businesses[0]!.failedDecisionDays).toEqual(["2026-09-21", ASOF]);
    expect(release.failures.join("\n")).toMatch(/no simulated decision day succeeded/);
    expect(exit).toBe(3);
    // A failed day is a lane failure, never merely an observation.
    const invariants = evaluateAcceptanceInvariants({ businesses: [failedDays] });
    expect(invariants.laneFailures.map((f) => f.code)).toContain("decision_day_failed");
    expect(invariants.observations.map((f) => f.code)).not.toContain("decision_day_failed");
  });

  it("one failed day fails the release even when another day succeeded", () => {
    const oneFailed = acceptedBusiness();
    if (!("days" in oneFailed.decisions)) throw new Error("fixture");
    oneFailed.decisions.days[0] = { ...oneFailed.decisions.days[0]!, status: "failed", reason: "boom" };
    expect(releaseOf([oneFailed]).exit).toBe(3);
  });

  it("a day whose receipt fails the gate is not a successful day", () => {
    const unreconstructable = acceptedBusiness();
    if (!("days" in unreconstructable.decisions)) throw new Error("fixture");
    for (const day of unreconstructable.decisions.days) {
      day.perAccount = [accountDay({ receipt: { sourceComplete: false, hydrationComplete: false, authoritativeForPrune: false,
        expectedAdCount: 0, hydratedAdCount: 26, reason: "complete_source_run_missing", gate: { pass: false, failures: ["not_authoritative_for_prune"] } } })];
    }
    const { release, exit } = releaseOf([unreconstructable]);
    expect(release.businesses[0]!.successfulDecisionDays).toEqual([]);
    expect(exit).toBe(3);
  });

  it("all presentations failed => not accepted", () => {
    const failedPresentation = acceptedBusiness();
    failedPresentation.presentation = {
      status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF,
      accounts: [presentationAccount({ status: "failed", modes: [], generation: null, error: "TypeError: x is undefined" })],
    };
    const { release, exit } = releaseOf([failedPresentation]);
    expect(release.accepted).toBe(false);
    expect(release.businesses[0]!.failedPresentations).toEqual([ACCT]);
    expect(exit).toBe(3);
    expect(evaluateAcceptanceInvariants({ businesses: [failedPresentation] }).laneFailures.map((f) => f.code)).toContain("presentation_failed");

    const workspaceError = acceptedBusiness();
    workspaceError.presentation = {
      status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF,
      accounts: [presentationAccount({ modes: [mode({ workspace: [
        { limit: 60, status: "build_failed", os: null, heldServed: null, eligiblePreCapCount: null, exactAdapter: null, error: "Error: build" },
      ] })] })],
    };
    expect(releaseOf([workspaceError]).exit).toBe(3);

    const withheld = acceptedBusiness();
    withheld.presentation = {
      status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF,
      accounts: [presentationAccount({ status: "receipt_unreconstructable", receiptGate: { pass: false, failures: ["x"] }, modes: [], generation: null })],
    };
    const withheldResult = releaseOf([withheld]);
    expect(withheldResult.release.failures.join("\n")).toMatch(/no per-account presentation succeeded/);
    expect(withheldResult.exit).toBe(3);
  });

  it("persisted-served unavailable (engine mismatch) => post_deploy not accepted", () => {
    const mismatch = acceptedBusiness();
    mismatch.persistedServed = business().persistedServed;
    const { release, exit } = releaseOf([mismatch]);
    expect(release.accepted).toBe(false);
    expect(release.businesses[0]!.persistedServedUnavailable).toEqual([ACCT]);
    expect(release.failures.join("\n")).toMatch(/native_latest_job_engine_mismatch/);
    expect(exit).toBe(3);
  });

  it("--skip-decisions / --diagnostic is diagnostic and never release success", () => {
    const skipped = acceptedBusiness();
    skipped.decisions = { status: "skipped", reason: "--skip-decisions", snapshot: null, runtimeMs: 0, policy: null, days: [] };
    skipped.presentation = { status: "skipped", reason: "--skip-decisions", asOf: null, cutoff: null, accounts: [] };
    const diagnostic = releaseOf([skipped], "diagnostic");
    expect(diagnostic.release.mode).toBe("diagnostic");
    expect(diagnostic.release.accepted).toBe(false);
    expect(diagnostic.release.label).toBe("DIAGNOSTIC (never release success)");
    expect(diagnostic.exit).toBe(4);
    // Even a fully successful run is not release success in diagnostic mode.
    expect(releaseOf([acceptedBusiness()], "diagnostic").exit).toBe(4);
    // Skipped decisions cannot pass a release-mode verdict either.
    expect(releaseOf([skipped], "release").exit).toBe(3);
  });

  it("a violation outranks everything, and a failed lane is never release success", () => {
    const violating = acceptedBusiness();
    violating.presentation = {
      status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF,
      accounts: [presentationAccount({ modes: [mode({ briefing: { projectionNulls: 1, statusFilter: "active", lanes: { action: 0, watching: 0, healthy: 0 }, servedClassifications: 0, studioAdsIndexed: 0 } })] })],
    };
    expect(releaseOf([violating]).exit).toBe(1);
    expect(releaseOf([violating], "diagnostic").exit).toBe(1);
    const failedLane = acceptedBusiness();
    failedLane.ledger = { status: "failed", error: "boom" };
    expect(releaseOf([failedLane]).exit).toBe(3);
    expect(releaseOf([]).exit).toBe(3);
  });

  it("carries both gates from the same lanes; the exit code follows only the selected gate", () => {
    // Before a deploy: HEAD's epoch has never run, the served path says engine mismatch.
    const preDeploy = acceptedBusiness();
    preDeploy.persistedServed = business().persistedServed;
    const report = { mode: "release" as const, businesses: [preDeploy] };
    const invariants = evaluateAcceptanceInvariants(report);
    const gatesPre = evaluateReleaseGates(report, "pre_deploy");
    expect(gatesPre.selectedGate).toBe("pre_deploy");
    expect(gatesPre.gates.pre_deploy.accepted).toBe(true);
    expect(gatesPre.gates.pre_deploy.label).toBe("PRE_DEPLOY GATE PASSED");
    expect(gatesPre.gates.post_deploy.accepted).toBe(false);
    expect(gatesPre.gates.post_deploy.label).toBe("POST_DEPLOY GATE NOT MET");
    expect(decideExitCode({ invariants, release: gatesPre.gates[gatesPre.selectedGate] })).toBe(0);
    const gatesPost = evaluateReleaseGates(report, "post_deploy");
    expect(gatesPost.gates).toEqual(gatesPre.gates);
    expect(decideExitCode({ invariants, release: gatesPost.gates[gatesPost.selectedGate] })).toBe(3);
  });

  it("pre_deploy still fails on failed days, failed presentations and an unexplained served failure", () => {
    const failedDays = acceptedBusiness();
    if (!("days" in failedDays.decisions)) throw new Error("fixture");
    failedDays.decisions.days = failedDays.decisions.days.map((day) => ({ ...day, status: "failed" as const, reason: "boom" }));
    expect(releaseOf([failedDays], "release", "pre_deploy").exit).toBe(3);

    const failedPresentation = acceptedBusiness();
    failedPresentation.presentation = {
      status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF,
      accounts: [presentationAccount({ status: "failed", modes: [], generation: null, error: "boom" })],
    };
    expect(releaseOf([failedPresentation], "release", "pre_deploy").exit).toBe(3);

    const jobFailed = acceptedBusiness();
    jobFailed.persistedServed = business().persistedServed;
    if (!("accounts" in jobFailed.persistedServed)) throw new Error("fixture");
    jobFailed.persistedServed.accounts[0]!.bundle = {
      status: "unavailable", unavailableReason: "native_latest_job_failed", validationIssue: null, degraded: false,
    };
    const jobFailedResult = releaseOf([jobFailed], "release", "pre_deploy");
    expect(jobFailedResult.exit).toBe(3);
    expect(jobFailedResult.release.failures.join("\n")).toMatch(/a deploy does not explain: native_latest_job_failed/);

    const brokenLatest = acceptedBusiness();
    brokenLatest.persistedServed = business().persistedServed;
    if (!("accounts" in brokenLatest.persistedServed)) throw new Error("fixture");
    brokenLatest.persistedServed.accounts[0]!.latestRow = {
      ...brokenLatest.persistedServed.accounts[0]!.latestRow, hydrated_ad_count: 53, manifest_matches: false,
    };
    expect(releaseOf([brokenLatest], "release", "pre_deploy").exit).toBe(3);

    const diagnostic = releaseOf([acceptedBusiness()], "diagnostic", "pre_deploy");
    expect(diagnostic.release.label).toBe("DIAGNOSTIC (never release success)");
    expect(diagnostic.exit).toBe(4);
  });

  it("post_deploy refuses a degraded (retained last-success) served generation", () => {
    const degraded = acceptedBusiness();
    if (!("accounts" in degraded.persistedServed)) throw new Error("fixture");
    degraded.persistedServed.accounts[0]!.bundle = { ...degraded.persistedServed.accounts[0]!.bundle, degraded: true };
    expect(releaseOf([degraded], "release", "post_deploy").exit).toBe(3);
    expect(releaseOf([degraded], "release", "pre_deploy").exit).toBe(3);
  });
});

/* ============================================== negative control (P1-1) */

/** A control business whose decision days succeeded (verified hashes, passing receipts) on both target days. */
function controlBusiness(overrides: Partial<NegativeControlReport> = {}): BusinessAcceptanceReport {
  return { ...acceptedBusiness(), businessId: BIZ_B, role: "negative_control", negativeControl: controlReport(overrides) };
}

/** The default pre_deploy gate before a deploy: the served path still says engine mismatch. */
function preDeploySubject(): BusinessAcceptanceReport {
  const subject = acceptedBusiness();
  subject.persistedServed = business().persistedServed;
  return subject;
}

function gateWithControl(control: BusinessAcceptanceReport) {
  return releaseOf([preDeploySubject(), control], "release", "pre_deploy");
}

describe("negative control gate (P1-1)", () => {
  it("MET only when found, source-gapped on every target day, and held from real data", () => {
    const { release, exit } = gateWithControl(controlBusiness());
    expect(release.accepted).toBe(true);
    expect(release.negativeControl).toBe("MET");
    const control = release.businesses.find((entry) => entry.role === "negative_control")!.negativeControl!;
    expect(control.met).toBe(true);
    expect(control.campaignAdDays).toBe(40);
    expect(control.campaignAccountsSelected).toEqual([ACCT]);
    expect(control.objectiveOnTargetDays).toEqual(TARGET_DAYS.map((day) => ({ day, readiness: ["review_only"] })));
    expect(control.unauthorizedHardEvidence.simulated).toBe(1);
    expect(exit).toBe(0);
    // A persisted snapshot row on a target day is real data too.
    const persistedOnly = controlBusiness({
      simulatedHardRows: [],
      persistedHardRows: [{ as_of_date: ASOF, ad_id: "ad-9", raw_label: "cut", label: "keep", pre_authority_label: "cut", blocked_action_type: "cut", authorized_action: null }],
    });
    expect(gateWithControl(persistedOnly).exit).toBe(0);
  });

  it("control campaign missing => NOT MET, and the observation code feeds the gate", () => {
    const missing = controlBusiness({ campaignFound: false, campaignAccounts: [], objectiveByDay: [], simulatedHardRows: [] });
    const { release, exit } = gateWithControl(missing);
    expect(release.accepted).toBe(false);
    expect(release.label).toBe("PRE_DEPLOY GATE NOT MET");
    expect(release.negativeControl).toBe("NOT MET");
    expect(release.failures.join("\n")).toMatch(/negative control NOT MET: negative_control_campaign_not_found/);
    expect(exit).toBe(3);
    expect(codes(evaluateAcceptanceInvariants({ businesses: [missing] }).observations)).toContain("negative_control_campaign_not_found");
    // Found flag without a single ad-day row is still not found.
    const noRows = controlBusiness({ campaignAccounts: [{ providerAccountId: ACCT, adDays: 0, spendPositiveAdDays: 0, targetDayAdDays: 0 }] });
    expect(gateWithControl(noRows).release.failures.join("\n")).toMatch(/negative_control_campaign_not_found/);
    expect(gateWithControl(noRows).exit).toBe(3);
    // Found, but on an account no decision covers.
    const unselected = controlBusiness({ campaignAccounts: [{ providerAccountId: "act_999", adDays: 40, spendPositiveAdDays: 30, targetDayAdDays: 4 }] });
    expect(gateWithControl(unselected).release.failures.join("\n")).toMatch(/negative_control_campaign_account_not_selected/);
    expect(gateWithControl(unselected).exit).toBe(3);
    // The control business itself without ledger rows.
    const noLedger = controlBusiness();
    noLedger.ledger = ledger([ledgerAccount({ adDays: { adDays: 0, spendPositive: 0 } })]);
    expect(gateWithControl(noLedger).release.failures.join("\n")).toMatch(/negative_control_business_without_ledger_rows/);
    expect(gateWithControl(noLedger).exit).toBe(3);
  });

  it("control present but no source gap => NOT MET", () => {
    // Decision authority on a target day AT THAT DAY'S CUTOFF: the gap is not there.
    const authority = controlBusiness({
      objectiveAtTargetCutoffs: TARGET_DAYS.map((day) => ({
        day, cutoff: `${day}T23:59:59.999Z`, providerAccountId: ACCT, tier: "provider_receipt_day_bracketed",
        readiness: day === ASOF ? "decision_authority" : "review_only",
      })),
    });
    const withAuthority = gateWithControl(authority);
    expect(withAuthority.release.accepted).toBe(false);
    expect(withAuthority.release.negativeControl).toBe("NOT MET");
    expect(withAuthority.release.failures.join("\n")).toMatch(/negative_control_no_source_gap/);
    expect(withAuthority.exit).toBe(3);
    // Authority only at the WINDOW-END cutoff (a receipt that arrived later) does not erase the gap
    // the target day had at its own cutoff.
    const lateReceipt = controlBusiness({
      objectiveByDay: TARGET_DAYS.map((day) => ({
        day, tier: "provider_receipt_day_bracketed", readiness: "decision_authority", value: "OUTCOME_SALES", pitClass: "as_of_known",
      })),
      decisionAuthorityDays: TARGET_DAYS,
    });
    expect(gateWithControl(lateReceipt).release.negativeControl).toBe("MET");
    expect(gateWithControl(lateReceipt).exit).toBe(0);
    // A target day the objective was never read on at its own cutoff.
    const unevaluated = controlBusiness({ objectiveAtTargetCutoffs: [] });
    const withoutEvaluation = gateWithControl(unevaluated);
    expect(withoutEvaluation.release.accepted).toBe(false);
    expect(withoutEvaluation.release.failures.join("\n")).toMatch(/negative_control_target_day_unevaluated/);
    expect(withoutEvaluation.exit).toBe(3);
    // No target day at all proves nothing.
    expect(gateWithControl(controlBusiness({ targetDays: [] })).release.failures.join("\n")).toMatch(/negative_control_no_target_days/);
  });

  it("control present but no unauthorized hard evidence => NOT MET", () => {
    const none = gateWithControl(controlBusiness({ simulatedHardRows: [], persistedHardRows: [] }));
    expect(none.release.accepted).toBe(false);
    expect(none.release.failures.join("\n")).toMatch(/negative_control_no_unauthorized_hard_evidence/);
    expect(none.exit).toBe(3);
    // Held only on a day that is not a target day.
    expect(gateWithControl(controlBusiness({ simulatedHardRows: [hardRow({ campaignId: CONTROL_CAMPAIGN, asOf: "2026-09-15" })] })).exit).toBe(3);
    // Held on another campaign.
    expect(gateWithControl(controlBusiness({ simulatedHardRows: [hardRow({ campaignId: "c-other" })] })).exit).toBe(3);
    // Neither raw hard, pre-authority hard nor held.
    const soft = hardRow({ campaignId: CONTROL_CAMPAIGN, rawLabel: "keep", preAuthorityLabel: "keep", publishedLabel: "keep", blockedActionType: null });
    expect(gateWithControl(controlBusiness({ simulatedHardRows: [soft] })).exit).toBe(3);
    // Held on a target day whose simulated day did not succeed (receipt fails the gate): not real evidence.
    const failedDay = controlBusiness();
    if (!("days" in failedDay.decisions)) throw new Error("fixture");
    for (const day of failedDay.decisions.days) {
      day.perAccount = [accountDay({ receipt: { sourceComplete: false, hydrationComplete: false, authoritativeForPrune: false,
        expectedAdCount: 0, hydratedAdCount: 3, reason: "complete_source_run_missing", gate: { pass: false, failures: ["not_authoritative_for_prune"] } } })];
    }
    const failedDayResult = gateWithControl(failedDay);
    expect(failedDayResult.release.failures.join("\n")).toMatch(/negative_control_no_unauthorized_hard_evidence/);
    expect(failedDayResult.exit).toBe(3);
    // An authorized hard verdict on the control campaign never counts, even beside a held one.
    const authorized = gateWithControl(controlBusiness({
      persistedHardRows: [{ as_of_date: ASOF, ad_id: "ad-9", raw_label: "cut", label: "cut", pre_authority_label: "cut", blocked_action_type: null, authorized_action: "cut" }],
    }));
    expect(authorized.release.failures.join("\n")).toMatch(/negative_control_hard_verdict_authorized/);
    expect(authorized.exit).toBe(3);
  });

  it("a control that merely ran, failed, or never reported => NOT MET", () => {
    const ranOnly = { ...acceptedBusiness(), businessId: BIZ_B, role: "negative_control" as const, negativeControl: null };
    expect(gateWithControl(ranOnly).release.negativeControl).toBe("NOT MET");
    expect(gateWithControl(ranOnly).exit).toBe(3);
    const failed = { ...controlBusiness(), negativeControl: { status: "failed" as const, error: "boom" } };
    expect(gateWithControl(failed).exit).toBe(3);
    const requestedButAbsent = evaluateReleaseAcceptance(
      { mode: "release", businesses: [preDeploySubject()], args: { negativeControl: BIZ_B } },
      "pre_deploy",
    );
    expect(requestedButAbsent.accepted).toBe(false);
    expect(requestedButAbsent.negativeControl).toBe("NOT MET");
    expect(requestedButAbsent.failures.join("\n")).toMatch(/negative_control_not_run/);
    // Without --negative-control the gate does not ask for one.
    const unrequested = evaluateReleaseAcceptance({ mode: "release", businesses: [preDeploySubject()], args: { negativeControl: null } }, "pre_deploy");
    expect(unrequested.negativeControl).toBe("not_requested");
    expect(unrequested.accepted).toBe(true);
    expect(evaluateNegativeControl(ranOnly).findings.map((finding) => finding.code)).toEqual(["negative_control_not_run"]);
  });
});

/* ============================================ presence / empty pass (P1-2) */

function emptyMode(overrides: Partial<PresentationModeReport> = {}): PresentationModeReport {
  return mode({
    inventory: { items: 0 },
    sourceBacking: {
      basis: "metricEvidence.sourceRowCount_gt_0_in_decision_window",
      sourceBackedAds: 0, sourceBackedInventoryItems: 0, sourceBackedBriefingCards: 0,
      smallestAdLimit: 60, sourceBackedOsItemsAtSmallestLimit: 0, sourceBackedPresentedAds: 0,
    },
    briefing: { projectionNulls: 0, statusFilter: "active", lanes: { action: 0, watching: 0, healthy: 0 }, servedClassifications: 0, studioAdsIndexed: 0 },
    workspace: [
      { limit: 60, status: "available", os: { items: 0 }, heldServed: locateHeldVerdicts({ heldAdIds: [], servedAdIds: [], archivedAdIds: [] }), eligiblePreCapCount: 0, exactAdapter: null, error: null },
      { limit: 300, status: "available", os: { items: 0 }, heldServed: locateHeldVerdicts({ heldAdIds: [], servedAdIds: [], archivedAdIds: [] }), eligiblePreCapCount: 0, exactAdapter: null, error: null },
    ],
    ...overrides,
  });
}

function subjectWithModes(modes: PresentationModeReport[], account: Partial<PresentationAccountReport> = {}) {
  const subject = preDeploySubject();
  subject.presentation = {
    status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF,
    accounts: [presentationAccount({ modes, ...account })],
  };
  return subject;
}

describe("presence gate (P1-2)", () => {
  it("passes pre_deploy on a source-backed held/watching presentation with no authorized action", () => {
    const subject = preDeploySubject();
    if (!("days" in subject.decisions)) throw new Error("fixture");
    expect(subject.decisions.days.flatMap((day) => day.hardRows).every((row) => row.authorizedAction === null)).toBe(true);
    const { release, exit } = releaseOf([subject], "release", "pre_deploy");
    expect(release.accepted).toBe(true);
    const presence = release.businesses[0]!.presence!;
    expect(presence.decisionsOnSuccessfulDays).toBe(6);
    expect(presence.accountsWithPresence).toEqual([ACCT]);
    expect(presence.accounts[0]).toMatchObject({
      decisionRows: 3, ledgerAdDays: 100, inventoryItems: 3, sourceBackedInventoryItems: 3,
      briefingCards: 3, servedClassifications: 3, smallestAdLimit: 60, osItemsAtSmallestLimit: 60, sourceBackedPresentedAds: 3, missing: [],
    });
    expect(exit).toBe(0);
    // post_deploy is unchanged: still NOT MET only on the served epoch.
    const post = releaseOf([subject], "release", "post_deploy");
    expect(post.release.accepted).toBe(false);
    expect(post.release.failures.join("\n")).not.toMatch(/empty presentation|empty decisions/);
  });

  it("zero decision rows with a passing receipt and hash => NOT MET", () => {
    const empty = subjectWithModes([emptyMode(), emptyMode({ mode: "governance_verified_counterfactual" })], {
      generation: { jobRunId: JOB, manifestHash: sha("m"), expectedAdCount: 0, rows: 0, lineageValidRows: 0 },
    });
    if (!("days" in empty.decisions)) throw new Error("fixture");
    for (const day of empty.decisions.days) {
      day.perAccount = [accountDay({
        ads: 0, rawHard: {}, preAuthorityHard: {}, publishedHard: {}, authorizedActions: {}, blockedActionType: {},
        receipt: { sourceComplete: true, hydrationComplete: true, authoritativeForPrune: true, expectedAdCount: 0, hydratedAdCount: 0, reason: null, gate: { pass: true, failures: [] } },
      })];
      day.hardRows = [];
    }
    const { release, exit } = releaseOf([empty], "release", "pre_deploy");
    expect(release.businesses[0]!.successfulDecisionDays).toEqual(["2026-09-21", ASOF]);
    expect(release.accepted).toBe(false);
    expect(release.failures.join("\n")).toMatch(/empty decisions: the successful days .* over 0 ad decisions/);
    expect(release.failures.join("\n")).toMatch(/empty presentation: .*decision_rows/);
    expect(exit).toBe(3);
  });

  it("inventory without source backing => NOT MET", () => {
    const unbacked = subjectWithModes([mode({
      sourceBacking: {
        basis: "metricEvidence.sourceRowCount_gt_0_in_decision_window",
        sourceBackedAds: 0, sourceBackedInventoryItems: 0, sourceBackedBriefingCards: 0,
        smallestAdLimit: 60, sourceBackedOsItemsAtSmallestLimit: 0, sourceBackedPresentedAds: 0,
      },
    })]);
    const result = releaseOf([unbacked], "release", "pre_deploy");
    expect(result.release.failures.join("\n")).toMatch(/source_backed_inventory_items/);
    expect(result.exit).toBe(3);
    // Old reports without source backing never pass.
    expect(releaseOf([subjectWithModes([mode({ sourceBacking: null })])], "release", "pre_deploy").exit).toBe(3);
    // No ledger rows for the presented account.
    const noLedger = preDeploySubject();
    noLedger.ledger = ledger([ledgerAccount({ adDays: { adDays: 0, spendPositive: 0 } })]);
    const noLedgerResult = releaseOf([noLedger], "release", "pre_deploy");
    expect(noLedgerResult.release.failures.join("\n")).toMatch(/ledger_ad_days_in_window/);
    expect(noLedgerResult.exit).toBe(3);
  });

  it("empty Briefing (0 cards or 0 classifications) => NOT MET", () => {
    const noCards = subjectWithModes([mode({
      briefing: { projectionNulls: 0, statusFilter: "active", lanes: { action: 0, watching: 0, healthy: 0 }, servedClassifications: 3, studioAdsIndexed: 3 },
    })]);
    const noCardsResult = releaseOf([noCards], "release", "pre_deploy");
    expect(noCardsResult.release.failures.join("\n")).toMatch(/briefing_active_cards/);
    expect(noCardsResult.exit).toBe(3);
    const noClassifications = subjectWithModes([mode({
      briefing: { projectionNulls: 0, statusFilter: "active", lanes: { action: 0, watching: 3, healthy: 0 }, servedClassifications: 0, studioAdsIndexed: 0 },
    })]);
    const noClassificationsResult = releaseOf([noClassifications], "release", "pre_deploy");
    expect(noClassificationsResult.release.failures.join("\n")).toMatch(/served_classifications/);
    expect(noClassificationsResult.exit).toBe(3);
  });

  it("empty OS at the smallest limit => NOT MET even when a larger limit has rows", () => {
    const emptyAtSmallest = subjectWithModes([mode({
      workspace: [
        // Listed first on purpose: the smallest limit is chosen by value, not position.
        { limit: 300, status: "available", os: { items: 80 }, heldServed: locateHeldVerdicts({ heldAdIds: ["ad-3"], servedAdIds: ["ad-3"], archivedAdIds: [] }), eligiblePreCapCount: 80, exactAdapter: null, error: null },
        { limit: 60, status: "available", os: { items: 0 }, heldServed: locateHeldVerdicts({ heldAdIds: ["ad-3"], servedAdIds: [], archivedAdIds: [] }), eligiblePreCapCount: 80, exactAdapter: null, error: null },
      ],
    })]);
    const { release, exit } = releaseOf([emptyAtSmallest], "release", "pre_deploy");
    expect(release.businesses[0]!.presence!.accounts[0]!.smallestAdLimit).toBe(60);
    expect(release.failures.join("\n")).toMatch(/os_items_at_smallest_limit/);
    expect(exit).toBe(3);
  });

  it("reads presence from the actual-governance mode, and applies to post_deploy too", () => {
    const counterfactualOnly = subjectWithModes([emptyMode(), mode({ mode: "governance_verified_counterfactual" })]);
    expect(releaseOf([counterfactualOnly], "release", "pre_deploy").exit).toBe(3);
    const available = acceptedBusiness();
    available.presentation = counterfactualOnly.presentation;
    const post = releaseOf([available], "release", "post_deploy");
    expect(post.release.failures.join("\n")).toMatch(/empty presentation/);
    expect(post.exit).toBe(3);
  });
});

/* ================================= authorization grounding (P1-A) */

/** An authorized cut that meets every condition of the production authorization rule. */
function groundedRow(overrides: Partial<HardRowRecord> = {}): HardRowRecord {
  return hardRow({
    rawLabel: "cut", preAuthorityLabel: "cut", publishedLabel: "cut", hysteresisSuppressed: false,
    authorizedAction: "cut", blockedActionType: null, firstAuthorityBlocker: null, effectiveAuthorityBlocker: null,
    hardActionEligibility: { scale: false, cut: true, refresh: false },
    config: { observed: true, fullyVerified: true, blockingField: null, weakestTier: "provider_receipt_day_bracketed", unverifiedEconomicDayCount: 0 },
    coverage: { status: "complete", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-21" },
    ...overrides,
  });
}

function businessWithAuthorized(row: HardRowRecord, receiptPasses = true): BusinessAcceptanceReport {
  const receiptFields = accountDay().receipt!;
  return business({
    decisions: {
      status: "computed", reason: null, snapshot: null, runtimeMs: 1, policy: null,
      days: [{ asOf: ASOF, cutoff: CUTOFF, status: "computed", reason: null, timingsMs: {}, hashIntegrity: null, hysteresis: null, pointInTime: null,
        perAccount: [accountDay({
          authorizedActions: { cut: 1, none: 2 },
          receipt: receiptPasses ? receiptFields : { ...receiptFields, gate: { pass: false, failures: ["not_authoritative_for_prune"] } },
        })],
        hardRows: [row] }],
    },
  });
}

describe("authorization grounding mirrors production, one condition at a time (P1-A)", () => {
  it("a fully grounded authorized action is not a violation", () => {
    expect(authorizationGroundingFailures(groundedRow(), true)).toEqual([]);
    expect(codes(evaluateAcceptanceInvariants({ businesses: [businessWithAuthorized(groundedRow())] }).violations)).toEqual([]);
    // Nothing to ground when nothing is authorized.
    expect(authorizationGroundingFailures(hardRow({ authorizedAction: null, config: { ...hardRow().config, observed: false } }), false)).toEqual([]);
  });

  const cases: Array<[string, Partial<HardRowRecord>, boolean, string]> = [
    ["published label differs from the authorized action", { publishedLabel: "keep" }, true, "published_label_differs"],
    ["raw label differs from the authorized action", { rawLabel: "keep" }, true, "raw_label_differs"],
    ["hysteresis-suppressed", { hysteresisSuppressed: true }, true, "hysteresis_suppressed"],
    ["ineligible for that hard action", { hardActionEligibility: { scale: true, cut: false, refresh: true } }, true, "hard_action_ineligible"],
    ["on a day whose receipt fails the gate", {}, false, "receipt_gate_failed"],
    ["config not observed", { config: { ...groundedRow().config, observed: false } }, true, "config_not_observed"],
    ["config not fully verified", { config: { ...groundedRow().config, fullyVerified: false } }, true, "config_not_fully_verified"],
    ["coverage not complete (the D101 fail-open)", { coverage: { status: "partial", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-20" } }, true, "coverage_not_complete"],
    ["decision blocker set", { firstAuthorityBlocker: "source_freshness" }, true, "decision_blocker_set"],
    ["payload blocker set", { effectiveAuthorityBlocker: "source_freshness" }, true, "payload_blocker_set"],
    ["held beside the authorized action", { blockedActionType: "cut" }, true, "held_beside_authorized"],
  ];
  for (const [name, overrides, receiptPasses, code] of cases) {
    it(`flags an authorized action ${name}, and only for that reason`, () => {
      const row = groundedRow(overrides);
      expect(authorizationGroundingFailures(row, receiptPasses)).toEqual([code]);
      const result = evaluateAcceptanceInvariants({ businesses: [businessWithAuthorized(row, receiptPasses)] });
      const finding = result.violations.find((violation) => violation.code === "authorized_action_without_evidence");
      expect(finding?.detail).toContain(code);
    });
  }

  it("flags a non-hard authorized action", () => {
    const row = groundedRow({ authorizedAction: "keep", rawLabel: "keep", publishedLabel: "keep" });
    expect(authorizationGroundingFailures(row, true)).toEqual(["authorized_action_not_hard", "hard_action_ineligible"]);
  });

  it("reads the receipt of the row's own account", () => {
    const row = groundedRow({ providerAccountId: "act_200" });
    // act_200 has no receipt on that day: not grounded, although ACCT's receipt passed.
    expect(codes(evaluateAcceptanceInvariants({ businesses: [businessWithAuthorized(row)] }).violations)).toContain("authorized_action_without_evidence");
  });
});

/* ============================ hydration vs independent reading (P1-A) */

function crossCheckDay(crossCheck: HydrationCrossCheck | null, accountOverrides: Partial<DecisionAccountDayReport> = {}) {
  const subject = preDeploySubject();
  if (!("days" in subject.decisions)) throw new Error("fixture");
  for (const day of subject.decisions.days) day.perAccount = [accountDay({ crossCheck, ...accountOverrides })];
  return subject;
}

describe("hydration's verified/complete flags are cross-checked at the chain cutoffs (P1-A)", () => {
  const claim = { adId: "ad-1", campaignId: "c-1", adsetId: "as-1" };

  it("a fully-verified claim the ledger's tier SQL does not support is a violation", () => {
    for (const independent of [
      independentReading({ objectiveAuthorityCampaigns: [], adsetGoalAuthorityAdsets: ["as-1"] }),
      independentReading({ objectiveAuthorityCampaigns: ["c-1"], adsetGoalAuthorityAdsets: [] }),
    ]) {
      const subject = crossCheckDay({ hydrationFullyVerified: [claim], hydrationCoverage: { partial: 3 }, independent });
      const result = evaluateAcceptanceInvariants({ businesses: [subject] });
      expect(codes(result.violations)).toContain("hydration_config_verified_without_independent_receipt");
      expect(releaseOf([subject], "release", "pre_deploy").exit).toBe(1);
    }
    const supported = crossCheckDay({
      hydrationFullyVerified: [claim], hydrationCoverage: { partial: 3 },
      independent: independentReading({ objectiveAuthorityCampaigns: ["c-1"], adsetGoalAuthorityAdsets: ["as-1"] }),
    });
    expect(codes(evaluateAcceptanceInvariants({ businesses: [supported] }).violations)).toEqual([]);
    // A claim with no campaign can never be supported.
    expect(crossCheckHydration({
      hydrationFullyVerified: [{ ...claim, campaignId: null }], hydrationCoverage: {},
      independent: independentReading({ objectiveAuthorityCampaigns: ["c-1"], adsetGoalAuthorityAdsets: ["as-1"] }),
    }).configContradictions).toHaveLength(1);
  });

  it("complete coverage the D101 port does not read at the same cutoff is a violation", () => {
    const subject = crossCheckDay({ hydrationFullyVerified: [], hydrationCoverage: { complete: 3 }, independent: independentReading() });
    expect(codes(evaluateAcceptanceInvariants({ businesses: [subject] }).violations)).toContain("hydration_coverage_complete_without_d101");
    const agreeing = crossCheckDay({
      hydrationFullyVerified: [], hydrationCoverage: { complete: 3 },
      independent: independentReading({ coverage: { status: "complete", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-21", accountTimezone: "UTC" } }),
    });
    expect(codes(evaluateAcceptanceInvariants({ businesses: [agreeing] }).violations)).toEqual([]);
  });

  it("a fail-closed disagreement is an observation, not a violation", () => {
    const subject = crossCheckDay({
      hydrationFullyVerified: [], hydrationCoverage: { partial: 3 },
      independent: independentReading({ coverage: { status: "complete", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-21", accountTimezone: "UTC" } }),
    });
    const result = evaluateAcceptanceInvariants({ businesses: [subject] });
    expect(result.violations).toEqual([]);
    expect(codes(result.observations)).toContain("d101_port_disagrees_with_hydration");
    expect(releaseOf([subject], "release", "pre_deploy").exit).toBe(0);
  });

  it("claims with no independent reading fail the gate; no claims, no failure", () => {
    const failedReading = independentReading({ error: "boom", coverage: null });
    const unverifiable = crossCheckDay({ hydrationFullyVerified: [claim], hydrationCoverage: { partial: 3 }, independent: failedReading });
    const result = releaseOf([unverifiable], "release", "pre_deploy");
    expect(result.release.failures.join("\n")).toMatch(/no independent reading/);
    expect(result.exit).toBe(3);
    expect(codes(evaluateAcceptanceInvariants({ businesses: [unverifiable] }).laneFailures)).toContain("hydration_cross_check_unavailable");
    const noClaims = crossCheckDay({ hydrationFullyVerified: [], hydrationCoverage: { partial: 3 }, independent: failedReading });
    expect(releaseOf([noClaims], "release", "pre_deploy").exit).toBe(0);
    // A day recorded without any cross-check: its verified count is unverifiable.
    const missing = crossCheckDay(null, { config: { observed: 1, fullyVerified: 1, blockingField: {} } });
    expect(releaseOf([missing], "release", "pre_deploy").exit).toBe(3);
  });
});

/* ========================================================= provenance (P1-B) */

describe("provenance ties the verdict to the code it certifies (P1-B)", () => {
  const porcelainZ = [" M lib/meta/warehouse.ts", "?? scripts/creative-decision-center/probe.ts", "R  lib/new-name.ts", "lib/old-name.ts", " M docs/notes.md", ""].join("\0");

  it("parses porcelain -z, skipping rename sources", () => {
    const dirty = parseGitPorcelainZ(porcelainZ);
    expect([...dirty.entries()]).toEqual([
      ["lib/meta/warehouse.ts", " M"],
      ["scripts/creative-decision-center/probe.ts", "??"],
      ["lib/new-name.ts", "R "],
      ["docs/notes.md", " M"],
    ]);
    expect(isProductionModulePath("lib/meta/warehouse.ts")).toBe(true);
    expect(isProductionModulePath("scripts/creative-decision-center/probe.ts")).toBe(false);
    expect(isProductionModulePath("lib/meta/warehouse.test.ts")).toBe(false);
  });

  function provenance(requireClean: boolean, loaded: string[] | null) {
    const dirty = parseGitPorcelainZ(porcelainZ);
    return summarizeProvenance({
      gitHead: "11844cb3a", porcelainLines: [...dirty.entries()].map(([file, status]) => `${status} ${file}`), dirty,
      loadedModules: loaded, hashes: new Map([["lib/meta/warehouse.ts", sha("w")], ["scripts/creative-decision-center/probe.ts", sha("p")]]),
      requireClean,
    });
  }

  it("names the dirty loaded modules with their hashes and says the working tree, not HEAD, is certified", () => {
    const record = provenance(false, ["lib/meta/warehouse.ts", "lib/clean.ts", "scripts/creative-decision-center/probe.ts"]);
    expect(record.dirtyLoadedModules.map((module) => [module.path, module.production, module.sha256])).toEqual([
      ["lib/meta/warehouse.ts", true, sha("w")],
      ["scripts/creative-decision-center/probe.ts", false, sha("p")],
    ]);
    expect(record.dirtyProductionModules).toEqual(["lib/meta/warehouse.ts"]);
    expect(record.certifies).toBe("working tree (dirty: 2 loaded modules; 1 production modules) on HEAD 11844cb3a, not HEAD");
    // Loaded modules unknown: every dirty path counts as possibly loaded.
    expect(provenance(false, null).dirtyProductionModules).toEqual(["docs/notes.md", "lib/meta/warehouse.ts", "lib/new-name.ts"]);
    expect(provenance(false, null).dirtyLoadedModules).toHaveLength(4);
    // The script can change the verdict, so its untracked contents are part of the code identity.
    expect(provenance(false, ["scripts/creative-decision-center/probe.ts", "lib/clean.ts"]).certifies).toBe(
      "working tree (dirty: 1 loaded modules; 0 production modules) on HEAD 11844cb3a, not HEAD",
    );
    expect(provenance(false, ["lib/clean.ts"]).certifies).toBe("HEAD 11844cb3a");
  });

  it("lists only changes that could matter to what ran: HEAD and loaded modules", () => {
    const start = {
      gitHead: "a", porcelainLines: [], loadedModules: ["lib/x.ts", "lib/y.ts"],
      dirty: new Map([["lib/x.ts", " M"], ["docs/z.md", " M"]]),
      hashes: new Map<string, string | null>([["lib/x.ts", "h1"]]),
    };
    expect(diffProvenanceSnapshots(start, start)).toEqual([]);
    // An unloaded file changing mid-run is not a change to what ran.
    expect(diffProvenanceSnapshots(start, { ...start, dirty: new Map([...start.dirty, ["components/unloaded.test.tsx", " M"]]) })).toEqual([]);
    expect(diffProvenanceSnapshots(start, { ...start, hashes: new Map([["lib/x.ts", "h2"]]) })).toEqual(["lib/x.ts: content changed"]);
    expect(diffProvenanceSnapshots(start, { ...start, dirty: new Map([...start.dirty, ["lib/y.ts", " M"]]) })).toEqual(["lib/y.ts: clean -> M"]);
    expect(diffProvenanceSnapshots(start, { ...start, gitHead: "b" })).toEqual(["HEAD a -> b"]);
    expect(diffProvenanceSnapshots(start, {
      ...start, loadedModules: ["lib/x.ts", "lib/y.ts", "lib/lazy.ts"], dirty: new Map([...start.dirty, ["lib/lazy.ts", "??"]]),
    })).toEqual(["lib/lazy.ts: clean -> ??", "lib/lazy.ts: loaded during the run while dirty"]);
  });

  it("pre_deploy may pass on a dirty tree but says so; --require-clean makes it NOT MET", () => {
    const report = { mode: "release" as const, businesses: [preDeploySubject()] };
    const dirty = evaluateReleaseAcceptance({ ...report, provenance: provenance(false, ["lib/meta/warehouse.ts"]) }, "pre_deploy");
    expect(dirty.accepted).toBe(true);
    expect(dirty.certifies).toMatch(/^working tree \(dirty: 1 loaded modules; 1 production modules\)/);
    const strict = evaluateReleaseAcceptance({ ...report, provenance: provenance(true, ["lib/meta/warehouse.ts"]) }, "pre_deploy");
    expect(strict.accepted).toBe(false);
    expect(strict.failures.join("\n")).toMatch(/--require-clean: 1 loaded module\(s\) differ from HEAD: lib\/meta\/warehouse.ts/);
    expect(decideExitCode({ invariants: { violations: [] }, release: strict })).toBe(3);
    const dirtyScript = evaluateReleaseAcceptance({ ...report, provenance: provenance(true, ["scripts/creative-decision-center/probe.ts"]) }, "pre_deploy");
    expect(dirtyScript.accepted).toBe(false);
    expect(dirtyScript.certifies).toBe("working tree (dirty: 1 loaded modules; 0 production modules) on HEAD 11844cb3a, not HEAD");
    expect(dirtyScript.failures.join("\n")).toMatch(/--require-clean: 1 loaded module\(s\) differ from HEAD: scripts\/creative-decision-center\/probe.ts/);
    expect(decideExitCode({ invariants: { violations: [] }, release: dirtyScript })).toBe(3);
    const clean = evaluateReleaseAcceptance({ ...report, provenance: provenance(true, ["lib/clean.ts"]) }, "pre_deploy");
    expect(clean.accepted).toBe(true);
    expect(clean.certifies).toBe("HEAD 11844cb3a");
    // A tree that changed during the run cannot be certified cleanly.
    const changed = summarizeProvenance({
      gitHead: "11844cb3a", porcelainLines: [], dirty: new Map(), loadedModules: [], hashes: new Map(),
      changedDuringRun: ["+  M lib/meta/warehouse.ts"], requireClean: true,
    });
    expect(evaluateReleaseAcceptance({ ...report, provenance: changed }, "pre_deploy").accepted).toBe(false);
  });
});

/* ================================================== P2: generation and audit */

describe("an invalid generation after a passing receipt is a failed presentation (P2)", () => {
  it("fails both gates even when another account presents", () => {
    for (const status of ["generation_invalid", "refused"] as const) {
      const subject = preDeploySubject();
      subject.presentation = {
        status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF,
        accounts: [
          presentationAccount(),
          presentationAccount({ providerAccountId: "act_200", status, refusal: "canonical inventory unavailable: native_canonical_projection_incomplete", modes: [], generation: null }),
        ],
      };
      const pre = releaseOf([subject], "release", "pre_deploy");
      expect(pre.release.businesses[0]!.failedPresentations).toEqual(["act_200"]);
      expect(pre.release.failures.join("\n")).toMatch(/receipt passed but the simulated generation is/);
      expect(pre.exit).toBe(3);
    }
    // A generation refused because its receipt failed is withheld, not failed.
    const withheld = preDeploySubject();
    withheld.presentation = {
      status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF,
      accounts: [presentationAccount(), presentationAccount({ providerAccountId: "act_200", status: "refused", receiptGate: { pass: false, failures: ["x"] }, modes: [], generation: null })],
    };
    expect(releaseOf([withheld], "release", "pre_deploy").exit).toBe(0);
  });
});

describe("served-action audit covers every provider-write route (P2)", () => {
  it("launchpad, resume and apply_bid under any intent; pause only when executable", () => {
    expect(isProviderWriteAction({ intent: "execute", providerMutation: "pause" })).toBe(true);
    expect(isProviderWriteAction({ intent: "launchpad", providerMutation: null })).toBe(true);
    expect(isProviderWriteAction({ intent: "review", providerMutation: "resume" })).toBe(true);
    expect(isProviderWriteAction({ intent: "manual", providerMutation: "apply_bid" })).toBe(true);
    expect(isProviderWriteAction({ intent: "review", providerMutation: "pause" })).toBe(false);
    expect(isProviderWriteAction({ intent: "review", providerMutation: null })).toBe(false);
    expect(isProviderWriteAction({ intent: "execute", providerMutation: null })).toBe(false);
  });

  it("maps the production objects into the audit: briefing lanes, OS rows at every limit, exact-adapter rows", () => {
    const audit = auditPresentationMode({
      rows: [
        { ad_id: "ad-1", authorized_action: null, blocked_action_type: null },
        { ad_id: "ad-2", authorized_action: "cut", blocked_action_type: null },
      ],
      governed: [
        { parentChain: { ad: { id: "ad-1" } }, sourceAuthority: { actionEligible: true, authorizedAction: null }, classification: { heldAction: null, decisionState: "act" } },
        { parentChain: { ad: { id: "ad-2" } }, sourceAuthority: { actionEligible: true, authorizedAction: "cut" }, classification: { heldAction: null, decisionState: "act" } },
      ],
      briefingCards: [{ adId: "ad-1", lane: "action" }, { adId: "ad-2", lane: "action" }, { adId: "ad-1", lane: "watching" }],
      osItemsByLimit: [
        [
          { id: "os-1", adId: "ad-1", lane: "act", action: { intent: "launchpad", providerMutation: null } },
          { id: "os-2", adId: "ad-2", lane: "act", action: { intent: "execute", providerMutation: "pause" } },
        ],
        [{ id: "os-3", adId: "ad-1", lane: "monitor", action: { intent: "review", providerMutation: "resume" } }],
      ],
      exactAdapterRows: [
        { id: "os-2", actionTone: "negative" },
        { id: "os-3", actionTone: "positive" },
        { id: "os-1", actionTone: "automation" },
        { id: "not-served", actionTone: "neutral" },
      ],
    });
    expect(audit.actionEligibleWithoutAuthorized).toEqual(["ad-1"]);
    expect(audit.briefingActionWithoutAuthorized).toEqual(["ad-1"]);
    expect(audit.osExecutableWithoutAuthorized).toEqual(["ad-1", "ad-1"]);
    expect(audit.exactAdapterWriteWithoutAuthorized).toEqual(["ad-1", "ad-1"]);
    expect(audit.exactAdapterRowsWithoutOsItem).toEqual(["not-served"]);
    const result = evaluateAcceptanceInvariants({
      businesses: [business({ presentation: { status: "computed", reason: null, asOf: ASOF, cutoff: CUTOFF, accounts: [presentationAccount({ modes: [mode({ authorityAudit: audit })] })] } })],
    });
    expect(codes(result.violations)).toEqual(expect.arrayContaining([
      "executable_os_row_without_authorized_action",
      "action_lane_card_without_authorized_action",
      "exact_adapter_row_offers_write_without_authorized_action",
      "exact_adapter_row_without_os_item",
    ]));
  });
});

/* ======================================= P2: CLI-to-evaluator mapping in core */

function entrySource(overrides: {
  adId?: string;
  rawLabel?: string;
  preAuthorityLabel?: string | null;
  label?: string;
  authorized?: string | null;
  blocked?: string | null;
  fullyVerified?: boolean;
  prior?: Record<string, unknown>;
} = {}): DecisionEntrySource {
  return {
    computation: {
      input: {
        providerAccountId: ACCT, adId: overrides.adId ?? "ad-1", campaignId: "c-1", adsetId: "as-1",
        configAuthority: {
          currentValueEvidence: { observed: true, weakestTier: "typed_contemporaneous" },
          decisionEconomics: { fullyVerified: overrides.fullyVerified ?? false, unverifiedEconomicDayCount: 3 },
          latestDay: { blockingField: "objective" },
        },
        metricEvidence: { sourceRowCount: 5, sourceCoverage: { status: "partial", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-20" } },
        dataFreshnessHours: null, linkClicks: 10, spend: 12.5,
      },
      rawLabel: overrides.rawLabel ?? "keep",
      decision: {
        label: overrides.label ?? "keep", preAuthorityLabel: overrides.preAuthorityLabel ?? "keep", authorityBlocker: "source_freshness",
        confidence: 60, campaignRoleStatus: "resolved",
        blockers: [{ predicate: "p1", status: "passed" }, { predicate: "p2", status: "failed" }],
      },
      hysteresisSuppressed: false,
      campaignContext: { contextTrust: "medium" },
      priorHysteresis: overrides.prior ?? { source: "persisted_evaluation", sourceSnapshotId: `${SYNTHETIC_ID_PREFIX}snapshot:x` },
    },
    payload: { authority_blocker: "source_freshness", blocked_action_type: overrides.blocked ?? null, authorized_action: overrides.authorized ?? null },
    group: { blocker: null, profile: { hardActionEligibility: { scale: false, cut: true, refresh: false } } },
  };
}

describe("the decision-to-report mapping lives in core and is tested (P2)", () => {
  it("the hard-row filter keeps an authorized row even when every label is soft", () => {
    expect(isHardRowEntry(entrySource({ authorized: "cut" }))).toBe(true);
    expect(isHardRowEntry(entrySource({ blocked: "cut" }))).toBe(true);
    expect(isHardRowEntry(entrySource({ rawLabel: "cut" }))).toBe(true);
    expect(isHardRowEntry(entrySource({ preAuthorityLabel: "refresh" }))).toBe(true);
    expect(isHardRowEntry(entrySource())).toBe(false);
  });

  it("propagates the authorized action and the evidence chain into the hard row", () => {
    const row = toHardRowRecord({ asOf: ASOF, entry: entrySource({ authorized: "cut", rawLabel: "cut", label: "cut" }), campaignContextById: new Map([["c-1", { resolverAuthorityValidated: false }]]) });
    expect(row).toMatchObject({
      adId: "ad-1", campaignId: "c-1", adsetId: "as-1", rawLabel: "cut", publishedLabel: "cut",
      authorizedAction: "cut", blockedActionType: null, firstAuthorityBlocker: "source_freshness", effectiveAuthorityBlocker: "source_freshness",
      hardActionEligibility: { scale: false, cut: true, refresh: false },
      config: { observed: true, fullyVerified: false, blockingField: "objective", weakestTier: "typed_contemporaneous", unverifiedEconomicDayCount: 3 },
      coverage: { status: "partial", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-20" },
      role: { trust: "medium", campaignRoleStatus: "resolved", resolverArmed: false },
      priorSource: "simulated_prior_day",
      failedPredicates: ["p2:failed"],
    });
  });

  it("counts authorized and held actions per account", () => {
    const summary = summarizeAccountDecisions({
      entries: [entrySource({ adId: "a", authorized: "cut", rawLabel: "cut", label: "cut" }), entrySource({ adId: "b" }), entrySource({ adId: "c", blocked: "cut", rawLabel: "cut" })],
      campaignContextById: new Map(),
    });
    expect(summary.ads).toBe(3);
    expect(summary.authorizedActions).toEqual({ cut: 1, none: 2 });
    expect(summary.blockedActionType).toEqual({ none: 2, cut: 1 });
    expect(summary.rawHard).toEqual({ cut: 2 });
    expect(summary.publishedHard).toEqual({ cut: 1 });
    expect(summary.priorSource).toEqual({ simulated_prior_day: 3 });
    expect(summary.metrics.spend).toEqual({ measured_positive: 3 });
    expect(summary.coverage).toEqual({ partial: 3 });
  });

  it("labels a prior carried from a simulated day as simulated, never as persisted lineage", () => {
    expect(reportedPriorSource({ source: "persisted_evaluation", sourceSnapshotId: `${SYNTHETIC_ID_PREFIX}snapshot:x` })).toBe("simulated_prior_day");
    expect(reportedPriorSource({ source: "persisted_evaluation", sourceEvaluationId: `${SYNTHETIC_ID_PREFIX}evaluation:y` })).toBe("simulated_prior_day");
    expect(reportedPriorSource({ source: "persisted_evaluation", sourceSnapshotId: "5e3c1f7a-real" })).toBe("persisted_evaluation");
    expect(reportedPriorSource(null)).toBe("none");
  });

  it("collects hydration's verified claims for the cross-check", () => {
    expect(hydrationClaims([entrySource({ adId: "v", fullyVerified: true }), entrySource({ adId: "u" })])).toEqual({
      hydrationFullyVerified: [{ adId: "v", campaignId: "c-1", adsetId: "as-1" }],
      hydrationCoverage: { partial: 2 },
    });
  });

  it("the runtime guard refuses anything but a UTC, read-only session", () => {
    const ok = { tzEnv: "UTC", timezoneOffsetMinutes: 0, resolvedZone: "UTC", pgOptions: "-c default_transaction_read_only=on" };
    expect(evaluateRuntimeGuard(ok)).toBeNull();
    expect(evaluateRuntimeGuard({ ...ok, tzEnv: undefined })).toMatch(/TZ must resolve to UTC/);
    expect(evaluateRuntimeGuard({ ...ok, resolvedZone: "Europe/Istanbul", timezoneOffsetMinutes: -180 })).toMatch(/TZ must resolve to UTC/);
    expect(evaluateRuntimeGuard({ ...ok, pgOptions: undefined })).toMatch(/PGOPTIONS/);
    expect(evaluateRuntimeGuard({ ...ok, pgOptions: "-c default_transaction_read_only=off" })).toMatch(/PGOPTIONS/);
  });
});

/* ============================================ D101 port parity (P2) */

function normalizeSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}

/** The predicates of the pointer -> slice -> manifest LATERAL that starts after `marker`. */
function lateralPredicates(sql: string, marker: string): string[] {
  const text = normalizeSql(sql);
  const start = text.indexOf(normalizeSql(marker));
  expect(start).toBeGreaterThanOrEqual(0);
  const from = text.indexOf("FROM meta_authoritative_publication_pointers pointer", start);
  const to = text.indexOf("ORDER BY", from);
  expect(from).toBeGreaterThan(start);
  return text
    .slice(from, to)
    .split(/\s(?:AND|WHERE|ON|INNER JOIN|LEFT JOIN)\s/)
    .map((predicate) => predicate.trim())
    .filter((predicate) => /(<=|>=|<>|=|IS NOT NULL|IS NULL)/.test(predicate))
    .sort();
}

const replaceAll = (value: string, pairs: Array<[string, string]>) =>
  pairs.reduce((text, [from, to]) => text.split(from).join(to), value);

describe("the D101 port is pinned to production predicate by predicate (P2)", () => {
  const production = readFileSync(path.join(process.cwd(), "lib/creative-decision-engine/data-source.ts"), "utf8");

  it("manifest identity: every production predicate, and nothing else", () => {
    const prod = lateralPredicates(production, "source_coverage_manifest_identity AS (").map((predicate) =>
      replaceAll(predicate, [
        ["$11::timestamptz", "slots.cutoff"],
        ["selected.business_id", "$1::text"],
        ["assignment.provider_account_ref_id", "$3::uuid"],
        ["selected.provider_account_id", "$2"],
      ]),
    ).sort();
    const port = lateralPredicates(D101_COVERAGE_AT_CUTOFFS_SQL, "SELECT NULLIF(BTRIM(manifest.account_timezone), '') AS account_timezone");
    expect(prod.length).toBeGreaterThan(25);
    expect(port).toEqual(prod);
  });

  it("account coverage: every production predicate, including published-after-local-close", () => {
    const prod = lateralPredicates(production, "account_source_coverage AS (").map((predicate) =>
      replaceAll(predicate, [
        ["$11::timestamptz", "expected.cutoff"],
        ["scope.business_id", "$1::text"],
        ["scope.provider_account_ref_id", "$3::uuid"],
        ["scope.provider_account_id", "$2"],
        ["scope.expected_through_day", "expected.expected_through_day"],
        ["scope.account_timezone", "expected.account_timezone"],
      ]),
    ).sort();
    const port = lateralPredicates(D101_COVERAGE_AT_CUTOFFS_SQL, "SELECT pointer.day AS coverage_through_day");
    expect(prod).toContain("pointer.published_at >= ((pointer.day + 1)::timestamp AT TIME ZONE expected.account_timezone)");
    expect(prod).toContain("manifest.completed_at >= ((pointer.day + 1)::timestamp AT TIME ZONE expected.account_timezone)");
    expect(port).toEqual(prod);
  });

  it("account identity, the timezone conflict, the expected day, the ordering and the status", () => {
    const text = normalizeSql(production);
    const identityStart = text.indexOf("account_identity AS (");
    const where = text.slice(text.indexOf("WHERE d.business_id = $1::text", identityStart), text.indexOf("ORDER BY", identityStart));
    const prod = where.replace(/^WHERE /, "").split(" AND ").map((predicate) =>
      replaceAll(predicate.trim(), [["$11::timestamptz", "slots.cutoff"], ["$2::date", "slots.as_of"]]),
    );
    const port = normalizeSql(D101_COVERAGE_AT_CUTOFFS_SQL);
    for (const predicate of prod) expect(port).toContain(predicate);
    expect(port).toContain("AND d.provider_account_ref_id = $3::uuid AND d.provider_account_id = $2");
    expect(port).toContain("ORDER BY d.date DESC, d.updated_at DESC, d.id DESC LIMIT 1");
    expect(text).toContain("d.date DESC, d.updated_at DESC, d.id DESC");
    expect(port).toContain("account_identity_timezone <> manifest_identity_timezone THEN NULL");
    expect(text).toContain("account_identity.account_timezone <> manifest_identity.account_timezone THEN NULL");
    expect(port).toContain("((scoped.cutoff AT TIME ZONE scoped.account_timezone)::date - 1)");
    expect(port.split("ORDER BY pointer.day DESC, pointer.published_at DESC, slice.candidate_version DESC LIMIT 1").length - 1).toBe(2);
    expect(text).toContain("WHEN scope.expected_through_day IS NULL OR coverage.coverage_through_day IS NULL THEN 'unavailable' WHEN coverage.coverage_through_day = scope.expected_through_day THEN 'complete' ELSE 'partial'");
    expect(classifyCoverage({ expectedThroughDay: null, coverageThroughDay: "2026-09-20" }).status).toBe("unavailable");
    expect(classifyCoverage({ expectedThroughDay: "2026-09-21", coverageThroughDay: null }).status).toBe("unavailable");
    expect(classifyCoverage({ expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-21" }).status).toBe("complete");
    expect(classifyCoverage({ expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-20" }).status).toBe("partial");
  });

  it("run-slot cutoffs are the production slots of every window day", () => {
    expect(productionRunSlotCutoffs("2026-09-21", "2026-09-22")).toEqual([
      { asOf: "2026-09-21", slot: "03:05Z", cutoff: "2026-09-21T03:05:00.000Z" },
      { asOf: "2026-09-21", slot: "15:05Z", cutoff: "2026-09-21T15:05:00.000Z" },
      { asOf: "2026-09-22", slot: "03:05Z", cutoff: "2026-09-22T03:05:00.000Z" },
      { asOf: "2026-09-22", slot: "15:05Z", cutoff: "2026-09-22T15:05:00.000Z" },
    ]);
  });

  it("the identity statuses are bounded by the cutoff on all three levels", () => {
    const text = normalizeSql(IDENTITY_AT_CUTOFF_SQL);
    const bound = "AND st.observed_at <= $7::timestamptz AND st.captured_at <= $7::timestamptz AND st.created_at <= $7::timestamptz";
    expect(text.split(bound).length - 1).toBe(3);
    for (const level of ["campaign", "adset", "ad"]) expect(text).toContain(`AND st.entity_type = '${level}'`);
    expect(text).toContain("daily.date <= $5::date");
  });
});

/* =================================== the UUID-shaped batch id stays in memory */

describe("the in-memory calibration batch id never reaches rows or the report (P2)", () => {
  it("is UUID-shaped only because the production contract requires it", () => {
    expect(simulatedCalibrationBatchId(0)).toBe("00000000-0000-4000-8000-000000000001");
    expect(simulatedCalibrationBatchId(0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(simulatedCalibrationBatchId(0).startsWith(SIMULATED_CALIBRATION_BATCH_ID_PREFIX)).toBe(true);
  });

  it("is absent from a built generation and from a whole report, and the leak check finds it when present", () => {
    const built = buildSimulatedGeneration({
      businessId: BIZ, asOf: ASOF, cutoff: CUTOFF, receipt: receipt(), entries: entries(),
      identityByAdId: new Map(), priorEpisodes: new Map(), hashIntegrityVerified: true,
    });
    expect(findLeakedIds(JSON.stringify(built), [SIMULATED_CALIBRATION_BATCH_ID_PREFIX])).toEqual([]);
    const report = { mode: "release" as const, businesses: [acceptedBusiness()] };
    const serialized = JSON.stringify({ ...report, invariants: evaluateAcceptanceInvariants(report), releaseGates: evaluateReleaseGates(report, "pre_deploy") });
    expect(findLeakedIds(serialized, [SIMULATED_CALIBRATION_BATCH_ID_PREFIX])).toEqual([]);
    expect(findLeakedIds(`{"batchId":"${simulatedCalibrationBatchId(2)}"}`, [SIMULATED_CALIBRATION_BATCH_ID_PREFIX])).toEqual([SIMULATED_CALIBRATION_BATCH_ID_PREFIX]);
    // The runtime check matches only a COMPLETE id: the claims text names the prefix in prose
    // (a false positive in the first final run) and must not trip it.
    expect(JSON.stringify(ACCEPTANCE_CLAIMS)).toContain(SIMULATED_CALIBRATION_BATCH_ID_PREFIX);
    expect(findLeakedCalibrationBatchIds(JSON.stringify({ claims: ACCEPTANCE_CLAIMS, ...report }))).toEqual([]);
    expect(findLeakedCalibrationBatchIds(JSON.stringify(built))).toEqual([]);
    expect(findLeakedCalibrationBatchIds(`{"a":"${simulatedCalibrationBatchId(0)}","b":"${simulatedCalibrationBatchId(0)}","c":"${simulatedCalibrationBatchId(11)}"}`)).toEqual([
      simulatedCalibrationBatchId(0), simulatedCalibrationBatchId(11),
    ]);
  });
});

/* ========================================================== P3 fixes */

describe("P3: null counts, labelled absence of a control", () => {
  it("a latest persisted run with NULL receipt counts is not a complete success (never 0 == 0)", () => {
    const nullCounts = preDeploySubject();
    if (!("accounts" in nullCounts.persistedServed)) throw new Error("fixture");
    nullCounts.persistedServed.accounts[0]!.latestRow = {
      ...nullCounts.persistedServed.accounts[0]!.latestRow, expected_ad_count: null, hydrated_ad_count: null,
    };
    const result = releaseOf([nullCounts], "release", "pre_deploy");
    expect(result.release.failures.join("\n")).toMatch(/not a complete success/);
    expect(result.exit).toBe(3);
  });

  it("a run without --negative-control carries the labelled observation and still passes", () => {
    const report = { mode: "release" as const, businesses: [preDeploySubject()], args: { negativeControl: null } };
    const invariants = evaluateAcceptanceInvariants(report);
    expect(codes(invariants.observations)).toContain("negative_control_not_requested");
    expect(invariants.violations).toEqual([]);
    expect(evaluateReleaseAcceptance(report, "pre_deploy").accepted).toBe(true);
    expect(codes(evaluateAcceptanceInvariants({ ...report, args: { negativeControl: BIZ_B } }).observations)).not.toContain("negative_control_not_requested");
  });
});

/* =============================== presence explains an empty OS (Briefing > 0) */

describe("an empty OS explains itself with the hierarchy at the cutoff", () => {
  it("Briefing > 0 with OS = 0 reads as no ACTIVE parent hierarchy visible at the cutoff", () => {
    const hierarchy = summarizeHierarchyAtCutoff([
      ...Array.from({ length: 500 }, () => ({ ad_status: "PAUSED", adset_status: "ACTIVE", campaign_status: "PAUSED" })),
      ...Array.from({ length: 300 }, () => ({ ad_status: "ACTIVE", adset_status: "PAUSED", campaign_status: "ACTIVE" })),
      ...Array.from({ length: 116 }, () => ({ ad_status: null, adset_status: null, campaign_status: null })),
    ]);
    const subject = subjectWithModes(
      [mode({
        briefing: { projectionNulls: 0, statusFilter: "active", lanes: { action: 0, watching: 89, healthy: 0 }, servedClassifications: 89, studioAdsIndexed: 89 },
        workspace: [
          { limit: 60, status: "available", os: { items: 0 }, heldServed: locateHeldVerdicts({ heldAdIds: [], servedAdIds: [], archivedAdIds: [] }), eligiblePreCapCount: 0, exactAdapter: null, error: null },
          { limit: 300, status: "available", os: { items: 0 }, heldServed: locateHeldVerdicts({ heldAdIds: [], servedAdIds: [], archivedAdIds: [] }), eligiblePreCapCount: 0, exactAdapter: null, error: null },
        ],
      })],
      { hierarchyAtCutoff: hierarchy, generation: { jobRunId: JOB, manifestHash: sha("m"), expectedAdCount: 916, rows: 916, lineageValidRows: 916 } },
    );
    const { release, exit } = releaseOf([subject], "release", "pre_deploy");
    expect(exit).toBe(3);
    const detail = release.failures.join("\n");
    expect(detail).toMatch(/os_items_at_smallest_limit/);
    expect(detail).toContain("Briefing active-filter 89 cards vs OS@60 0 rows: no ACTIVE parent hierarchy visible at the cutoff");
    expect(detail).toContain("hierarchy at cutoff over 916 ads: ad 300 active/500 inactive/116 unknown; adset 500 active/300 inactive/116 unknown; campaign 300 active/500 inactive/116 unknown; all three ACTIVE 0");
    const record = release.businesses[0]!.presence!.accounts[0]!;
    expect(record.hierarchyAtCutoff).toEqual(hierarchy);
    expect(record.briefingCards).toBe(89);
    expect(record.osItemsAtSmallestLimit).toBe(0);
    expect(describeBriefingVersusOs(record)).toMatch(/^Briefing active-filter 89 cards vs OS@60 0 rows: no ACTIVE parent hierarchy/);
  });
});

/* ============================ hard authority is a separate outcome */

function subjectWithHardRows(rows: HardRowRecord[], accountOverrides: Partial<DecisionAccountDayReport> = {}) {
  const subject = preDeploySubject();
  if (!("days" in subject.decisions)) throw new Error("fixture");
  for (const day of subject.decisions.days) {
    day.hardRows = rows.map((row) => ({ ...row, asOf: day.asOf }));
    day.perAccount = [accountDay(accountOverrides)];
  }
  return subject;
}

describe("hardAuthorityOutcome: presence PASS is not a source-authorized hard action", () => {
  it("not_demonstrated: counts and a blocker breakdown; reported only, the exit code unaffected", () => {
    const subject = preDeploySubject();
    const outcome = evaluateHardAuthority(subject);
    expect(outcome.status).toBe("not_demonstrated");
    expect(outcome.days.map((day) => day.status)).toEqual(["not_demonstrated", "not_demonstrated"]);
    expect(outcome.totals).toMatchObject({ rawHard: 2, preAuthorityHard: 2, held: 2, authorized: 0, authorizedGrounded: 0 });
    expect(outcome.totals.blockers).toEqual({
      objective_config: 2, d101_coverage: 2, role_campaign_context: 0, hysteresis: 0,
      profile_calibration_eligibility: 0, receipt: 0, other: 0,
    });
    expect(outcome.totals.effectiveBlockers).toEqual({ source_freshness: 2 });
    expect(describeHardAuthority(outcome)).toMatch(/^NOT DEMONSTRATED \(raw hard 2, pre-authority hard 2, held 2, authorized 0, source-authorized 0; blockers: objective_config 2, d101_coverage 2;/);
    const report = { mode: "release" as const, businesses: [subject], args: { negativeControl: null } };
    const gates = evaluateReleaseGates(report, "pre_deploy");
    expect(gates.hardAuthorityOutcome.map((entry) => entry.status)).toEqual(["not_demonstrated"]);
    expect(gates.requireHardAuthority).toBe(false);
    expect(gates.gates.pre_deploy.accepted).toBe(true);
    expect(decideExitCode({ invariants: evaluateAcceptanceInvariants(report), release: gates.gates.pre_deploy })).toBe(0);
  });

  it("--require-hard-authority: not_demonstrated makes the selected gate NOT MET (exit 3)", () => {
    const report = { mode: "release" as const, businesses: [preDeploySubject()], args: { negativeControl: null, requireHardAuthority: true } };
    const gates = evaluateReleaseGates(report, "pre_deploy");
    expect(gates.requireHardAuthority).toBe(true);
    expect(gates.gates.pre_deploy.accepted).toBe(false);
    expect(gates.gates.pre_deploy.failures.join("\n")).toMatch(/--require-hard-authority: hard authority NOT DEMONSTRATED/);
    expect(decideExitCode({ invariants: evaluateAcceptanceInvariants(report), release: gates.gates.pre_deploy })).toBe(3);
  });

  it("demonstrated: a row passing the full production authorization rule on a successful day", () => {
    const subject = subjectWithHardRows([groundedRow({ adId: "ad-9" }), hardRow()], { authorizedActions: { cut: 1, none: 2 } });
    const outcome = evaluateHardAuthority(subject);
    expect(outcome.status).toBe("demonstrated");
    expect(outcome.days[0]).toMatchObject({ status: "demonstrated", authorized: 1, authorizedGrounded: 1, groundedSample: ["ad-9:cut"] });
    const report = { mode: "release" as const, businesses: [subject], args: { negativeControl: null, requireHardAuthority: true } };
    const gates = evaluateReleaseGates(report, "pre_deploy");
    expect(gates.gates.pre_deploy.accepted).toBe(true);
    expect(decideExitCode({ invariants: evaluateAcceptanceInvariants(report), release: gates.gates.pre_deploy })).toBe(0);
    // An authorized row failing any condition is not a demonstration.
    const ungrounded = subjectWithHardRows([groundedRow({ coverage: { status: "partial", expectedThroughDay: "2026-09-21", coverageThroughDay: "2026-09-20" } })], { authorizedActions: { cut: 1, none: 2 } });
    expect(evaluateHardAuthority(ungrounded).status).toBe("not_demonstrated");
    expect(evaluateHardAuthority(ungrounded).totals.blockers.d101_coverage).toBe(2);
    // A grounded row on a day whose receipt fails is not a demonstration either.
    const receiptFailed = subjectWithHardRows([groundedRow()], {
      authorizedActions: { cut: 1, none: 2 },
      receipt: { ...accountDay().receipt!, gate: { pass: false, failures: ["not_authoritative_for_prune"] } },
    });
    const failedOutcome = evaluateHardAuthority(receiptFailed);
    expect(failedOutcome.status).toBe("not_demonstrated");
    expect(failedOutcome.days.map((day) => day.status)).toEqual(["day_not_successful", "day_not_successful"]);
    expect(failedOutcome.totals.blockers.receipt).toBe(2);
  });

  it("categorizes every condition a held row fails", () => {
    const row = hardRow({
      hysteresisSuppressed: true, firstAuthorityBlocker: "campaign_context", effectiveAuthorityBlocker: "campaign_context",
      profileBlocker: "native_ad_profile_context_missing:objective", hardActionEligibility: { scale: false, cut: false, refresh: false },
    });
    expect(hardAuthorityBlockerCategories(row, true)).toEqual([
      "objective_config", "d101_coverage", "role_campaign_context", "hysteresis", "profile_calibration_eligibility",
    ]);
    expect(hardAuthorityBlockerCategories(hardRow({ effectiveAuthorityBlocker: "native_metrics_unavailable", config: groundedRow().config, coverage: groundedRow().coverage }), true)).toEqual(["other"]);
    expect(hardAuthorityBlockerCategories(hardRow({ effectiveAuthorityBlocker: "config_source_authority" }), false)).toEqual(["objective_config", "d101_coverage", "receipt"]);
  });
});

/* ====================================== natural production cutoffs */

describe("cutoff modes for the --chain days", () => {
  it("defaults to end of day and records the mode", () => {
    const args = parseAcceptanceArgs(["--business", BIZ], NOW);
    expect(args.cutoffMode).toBe("end-of-day");
    expect(args.chain.map((day) => day.cutoff)).toEqual(["2026-09-21T23:59:59.999Z", "2026-09-22T23:59:59.999Z"]);
    expect(args.requireHardAuthority).toBe(false);
    expect(parseAcceptanceArgs(["--business", BIZ, "--require-hard-authority"], NOW).requireHardAuthority).toBe(true);
  });

  it("natural slots are D T03:05Z and D T15:05Z, on any past window end", () => {
    const early = parseAcceptanceArgs(["--business", BIZ, "--cutoff-slot", "natural-0305"], NOW);
    expect(early.cutoffMode).toBe("natural-0305");
    expect(early.chain).toEqual([
      { asOf: "2026-09-21", cutoff: "2026-09-21T03:05:00.000Z" },
      { asOf: "2026-09-22", cutoff: "2026-09-22T03:05:00.000Z" },
    ]);
    // Before the default window start (Bilsem 2026-08-18) is fine.
    const bilsem = parseAcceptanceArgs(["--business", BIZ, "--window", "2026-07-20:2026-08-18", "--chain", "1", "--cutoff-slot", "natural-1505"], NOW);
    expect(bilsem.chain).toEqual([{ asOf: "2026-08-18", cutoff: "2026-08-18T15:05:00.000Z" }]);
    // Today works when the natural cutoff is already past; end of day today never is.
    const evening = new Date("2026-09-23T18:00:00.000Z");
    const today = parseAcceptanceArgs(["--business", BIZ, "--window", "2026-08-25:2026-09-23", "--cutoff-slot", "natural-1505"], evening);
    expect(today.chain.map((day) => day.cutoff)).toEqual(["2026-09-22T15:05:00.000Z", "2026-09-23T15:05:00.000Z"]);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--window", "2026-08-25:2026-09-23", "--cutoff-slot", "natural-1505"], NOW)).toThrow(/not in the past/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--window", "2026-08-25:2026-09-23"], evening)).toThrow(/past UTC day/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--window", "2026-08-25:2026-09-24", "--cutoff-slot", "natural-0305"], evening)).toThrow(/in the future/);
    expect(() => parseAcceptanceArgs(["--business", BIZ, "--cutoff-slot", "natural-0900"], NOW)).toThrow(/--cutoff-slot accepts only/);
  });

  it("explicit --cutoffs: ascending, one per consecutive UTC day, ending on the window end", () => {
    const args = parseAcceptanceArgs(["--business", BIZ, "--window", "2026-07-20:2026-08-18", "--cutoffs", "2026-08-17T15:05:00Z,2026-08-18T03:02:30.5Z"], NOW);
    expect(args.cutoffMode).toBe("explicit");
    expect(args.chainDays).toBe(2);
    expect(args.chain).toEqual([
      { asOf: "2026-08-17", cutoff: "2026-08-17T15:05:00.000Z" },
      { asOf: "2026-08-18", cutoff: "2026-08-18T03:02:30.500Z" },
    ]);
    const window = ["--business", BIZ, "--window", "2026-07-20:2026-08-18"];
    expect(() => parseAcceptanceArgs([...window, "--cutoffs", "2026-08-16T15:05:00Z,2026-08-18T15:05:00Z"], NOW)).toThrow(/consecutive/);
    expect(() => parseAcceptanceArgs([...window, "--cutoffs", "2026-08-18T15:05:00Z,2026-08-17T15:05:00Z"], NOW)).toThrow(/consecutive/);
    expect(() => parseAcceptanceArgs([...window, "--cutoffs", "2026-08-16T15:05:00Z,2026-08-17T15:05:00Z"], NOW)).toThrow(/end on the window end/);
    expect(() => parseAcceptanceArgs([...window, "--cutoffs", "2026-08-18 15:05"], NOW)).toThrow(/ISO UTC instant/);
    expect(() => parseAcceptanceArgs([...window, "--cutoffs", "2026-08-18T15:05:00Z", "--chain", "2"], NOW)).toThrow(/names 1 cutoffs but --chain is 2/);
    expect(() => parseAcceptanceArgs([...window, "--cutoffs", "2026-08-18T15:05:00Z", "--cutoff-slot", "natural-1505"], NOW)).toThrow(/alternatives/);
  });

  it("the chain stays inside the window", () => {
    expect(() => deriveChain({ window: { start: "2026-08-18", end: "2026-08-18" }, chainDays: 2, slot: "end-of-day", explicitCutoffs: null })).toThrow(/before the window start/);
    expect(() => deriveChain({ window: { start: "2026-08-18", end: "2026-08-18" }, chainDays: 2, slot: "end-of-day", explicitCutoffs: ["2026-08-17T15:05:00Z", "2026-08-18T15:05:00Z"] })).toThrow(/before the window start/);
    expect(deriveChain({ window: { start: "2026-08-01", end: "2026-08-18" }, chainDays: 3, slot: "natural-0305", explicitCutoffs: null }).map((day) => day.cutoff)).toEqual([
      "2026-08-16T03:05:00.000Z", "2026-08-17T03:05:00.000Z", "2026-08-18T03:05:00.000Z",
    ]);
  });

  it("a receipt unreconstructable at its cutoff is reported as such, never repaired, and fails the day", () => {
    const subject = preDeploySubject();
    if (!("days" in subject.decisions)) throw new Error("fixture");
    subject.decisions.days[0]!.cutoff = "2026-09-21T15:05:00.000Z";
    subject.decisions.days[0]!.perAccount = [accountDay({ receipt: {
      sourceComplete: false, hydrationComplete: false, authoritativeForPrune: false, expectedAdCount: 0, hydratedAdCount: 2517,
      reason: "complete_source_run_missing", gate: { pass: false, failures: ["hydrated_count_differs_from_expected", "not_authoritative_for_prune"] },
    } })];
    const { release, exit } = releaseOf([subject], "release", "pre_deploy");
    expect(release.businesses[0]!.failedDecisionDays).toEqual(["2026-09-21"]);
    expect(release.businesses[0]!.successfulDecisionDays).toEqual([ASOF]);
    expect(release.failures.join("\n")).toContain(`decision day 2026-09-21 (cutoff 2026-09-21T15:05:00.000Z): ${ACCT} receipt_unreconstructable_at_cutoff [hydrated_count_differs_from_expected, not_authoritative_for_prune; reason complete_source_run_missing]`);
    expect(exit).toBe(3);
    expect(codes(evaluateAcceptanceInvariants({ businesses: [subject] }).observations)).toContain("receipt_unreconstructable_at_cutoff");
    // No receipt at all is not a pass either.
    const absent = preDeploySubject();
    if (!("days" in absent.decisions)) throw new Error("fixture");
    absent.decisions.days[1]!.perAccount = [accountDay({ receipt: null })];
    expect(releaseOf([absent], "release", "pre_deploy").release.failures.join("\n")).toMatch(/act_100 absent/);
  });
});
