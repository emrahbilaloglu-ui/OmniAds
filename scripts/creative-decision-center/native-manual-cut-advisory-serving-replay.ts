/**
 * Offline, selected-Ad producer -> hash/store projection -> server -> UI replay.
 *
 * --capture <retained capture.json> --identities <cutoff identity read.json>
 * --out <report.json>. No DB calls, provider calls, persistence or clock shift.
 *
 * The two-Ad presentation generation is explicitly synthetic and scoped to
 * the captured subset. It does NOT prove full-account generation admission or
 * live deployment. D101 and core decisions still use the original, complete
 * account hydration inputs; the retained source receipt is never rewritten.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { assertAdCanonicalEvaluationProvenance } from "@/lib/creative-decision-engine/evaluation-store";
import type { EngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { toNativeSnapshotPayload } from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { buildNativeMetaDecisionsWorkspaceReadModel } from "@/lib/meta/decisions-workspace-read-model";
import { buildMetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-presentation";
import {
  buyerFacingCreativeReason, buyerFacingCreativeResolution, heldCreativeVerdict,
} from "@/components/meta/decision-center/meta-decision-center-exact-adapter";
import {
  buildSimulatedGeneration, simulatedJobRunId, type SimulatedIdentity,
} from "./meta-decisions-creatives-acceptance-core";
import { buildSimulationEvaluation } from "./native-ad-current-code-historical-simulation";
import { recomputeCapturedAds, type Capture } from "./native-manual-cut-advisory-replay";

interface IdentityCapture {
  cutoff: string;
  asOf: string;
  rows: Array<SimulatedIdentity & { ad_id: string }>;
}

export function replayManualCutServing(capture: Capture, identity: IdentityCapture) {
  if (identity.cutoff !== capture.cutoff || identity.asOf !== capture.asOf) {
    throw new Error("Identity evidence uses a different report date or cutoff");
  }
  const ads = recomputeCapturedAds(capture);
  const identities = new Map(identity.rows.map((row) => [row.ad_id, row]));
  const flags: EngineV3Flags = {
    businessId: capture.businessId, enabled: true, surfaceVisible: true, shadowOnly: false,
    presetOverride: null,
    source: { enabled: "env", surfaceVisible: "env", shadowOnly: "env", presetOverride: null },
    envDefaults: { enabled: true, surfaceVisible: true, shadowOnly: false },
  };
  const jobRunId = simulatedJobRunId({
    businessId: capture.businessId, providerAccountId: capture.providerAccountId, cutoff: capture.cutoff,
  });
  const entries = ads.map((ad) => {
    const dimension = identities.get(ad.adId);
    if (!dimension || dimension.campaign_id !== ad.computation.input.campaignId ||
      dimension.adset_id !== ad.computation.input.adsetId) throw new Error("Identity mismatch");
    const evaluation = buildSimulationEvaluation({
      computation: ad.computation, profile: ad.group.profile,
      dataHealth: ad.dataHealth, flags, evaluatedAt: capture.cutoff,
    });
    assertAdCanonicalEvaluationProvenance(evaluation);
    const payload = toNativeSnapshotPayload({
      businessId: capture.businessId, asOf: capture.asOf, jobRunId,
      scope: ad.group.profile.scope, computation: ad.computation,
      calibrationRowId: ad.group.calibrationRowId,
      hardActionEligibility: ad.group.profile.hardActionEligibility, computedAt: capture.cutoff,
      stored: {
        evaluationId: `read-only-simulation:evaluation:${evaluation.decisionHash}`,
        providerAccountRefId: ad.computation.input.providerAccountRefId,
        providerAccountId: capture.providerAccountId, decisionEntityId: ad.adId,
        inputHash: evaluation.inputHash, decisionHash: evaluation.decisionHash,
      },
    });
    // A new evaluation envelope cannot change the original economic verdict.
    for (const key of ["label", "raw_label", "authority_blocker", "blocked_action_type", "authorized_action", "spend", "roas", "purchases"] as const) {
      if (payload[key] !== ad.payload[key]) throw new Error(`Payload drift: ${ad.adId} ${key}`);
    }
    return { evaluation, payload };
  });
  const manifestHash = hashAdDecisionIdentityManifest({
    businessId: capture.businessId, providerAccountId: capture.providerAccountId,
    asOfDate: capture.asOf, adIds: ads.map((ad) => ad.adId),
  });
  const projection = buildSimulatedGeneration({
    businessId: capture.businessId, asOf: capture.asOf, cutoff: capture.cutoff,
    // Synthetic SUBSET receipt, never the retained full-account receipt.
    receipt: {
      providerAccountRefId: ads[0]!.computation.input.providerAccountRefId,
      providerAccountId: capture.providerAccountId,
      expectedAdCount: ads.length, hydratedAdCount: ads.length,
      expectedManifestHash: manifestHash, hydratedManifestHash: manifestHash,
      authoritativeForPrune: true, sourceComplete: true, hydrationComplete: true,
      reason: "synthetic_selected_ad_presentation_only",
    },
    entries, identityByAdId: identities, priorEpisodes: new Map(), hashIntegrityVerified: true,
  });
  if (projection.status !== "built") throw new Error(projection.reason);
  const model = buildNativeMetaDecisionsWorkspaceReadModel({
    businessId: capture.businessId, providerAccountId: capture.providerAccountId,
    generation: projection.generation, snapshotRows: projection.rows,
    generatedAt: capture.cutoff, adCandidateLimit: 200,
  });
  const os = buildMetaOsDecisionsPresentation({
    actionNow: [], watching: [], nonSales: [], decisionReadModel: model,
    currency: identity.rows[0]?.currency ?? null, currentAdsComplete: false,
    targetHardActionEligibility: { scale: true, cut: true, refresh: true },
    generatedAt: capture.cutoff,
  });
  const results = ads.map((ad) => {
    const canonical = model.queue.adCandidates?.items.find((item) => item.parentChain.ad?.id === ad.adId);
    const presented = os.ads.items.find((item) => item.adId === ad.adId);
    if (!canonical || !presented) throw new Error(`Missing presented ad ${ad.adId}`);
    const advised = ad.advisory.status === "advised";
    const manualInUi = presented.action.code === "apply_purchase_cut_manually" && presented.lane === "act";
    if (manualInUi !== advised || Boolean(canonical.manualCutAdvisory) !== advised) {
      throw new Error(`Producer/server/UI advice mismatch ${ad.adId}`);
    }
    if (canonical.sourceAuthority?.actionEligible || canonical.sourceAuthority?.authorizedAction || presented.action.providerMutation) {
      throw new Error("Manual advice gained provider-write authority");
    }
    return {
      adId: ad.adId, advisory: ad.advisory, hierarchy: canonical.deliveryScope,
      inputHash: entries.find((entry) => entry.payload.ad_id === ad.adId)!.evaluation.inputHash,
      lane: presented.lane, action: presented.action,
      confidence: canonical.sourceDecision.confidence,
      authority: canonical.sourceAuthority, configVerified: canonical.configEvidence?.verified,
      buyerVerdict: heldCreativeVerdict(presented, canonical),
      buyerReason: buyerFacingCreativeReason(presented),
      buyerNextStep: buyerFacingCreativeResolution(presented, canonical),
    };
  });
  return {
    mode: "offline_selected_ad_serving_replay" as const, fullAccountAdmissionProven: false,
    persistedOrLive: false, asOf: capture.asOf, cutoff: capture.cutoff,
    sourceAccountInputCount: capture.hydration.accountInputCount,
    selectedAdCount: ads.length, evaluationContract: entries[0]?.evaluation.contractVersion,
    // Runtime controls are explicit presentation assumptions, not DB evidence.
    projectionFlags: flags, manualRecommendations: results.filter((row) => row.advisory.status === "advised").length,
    refusedRecommendations: results.filter((row) => row.advisory.status === "refused").length,
    results,
  };
}

function main() {
  const arg = (name: string) => {
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
    return process.argv[index + 1]!;
  };
  const source = readFileSync(arg("--capture"), "utf8");
  const identities = readFileSync(arg("--identities"), "utf8");
  const report = replayManualCutServing(JSON.parse(source), JSON.parse(identities));
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  writeFileSync(arg("--out"), JSON.stringify({ ...report, captureHash: sha(source), identitiesHash: sha(identities) }, null, 2));
  console.log(JSON.stringify({ mode: report.mode, manualRecommendations: report.manualRecommendations,
    refusedRecommendations: report.refusedRecommendations, rows: report.results.map((row) => ({
      adId: row.adId, lane: row.lane, action: row.action.code, verdict: row.buyerVerdict?.label,
    })) }, null, 2));
  if (!report.manualRecommendations || !report.refusedRecommendations) process.exitCode = 2;
}

if ((process.argv[1] ?? "").endsWith("native-manual-cut-advisory-serving-replay.ts")) main();
