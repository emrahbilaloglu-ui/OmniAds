/**
 * meta-native-manual-cut-advisory.v1 on named real ads — capture once, replay
 * offline.
 *
 * CAPTURE (one bounded read, one business, one pinned read-only snapshot):
 *   PGOPTIONS="-c default_transaction_read_only=on" npx tsx \
 *     scripts/creative-decision-center/native-manual-cut-advisory-replay.ts \
 *     --capture --business <uuid> --account <act_id> --asOf <YYYY-MM-DD> \
 *     --ads <id,id> --out <file.json>
 *
 * It runs the production functions exactly as `runAdDecisionsJob` does —
 * hydration of the whole provider account (the frequency-pressure percentile
 * is account-relative), the persisted calibration profile, campaign context,
 * ad set roles, previous published labels, data health, the ready/soft-only
 * decision branch and `toNativeSnapshotPayload` — at ONE cutoff (the snapshot's
 * own transaction start), then `buildNativeManualCutAdvisory`. Nothing is
 * persisted and no provider is contacted. Only the named ads' complete inputs
 * and results are written.
 *
 * REPLAY (no database):
 *   npx tsx scripts/creative-decision-center/native-manual-cut-advisory-replay.ts \
 *     --replay <file.json>
 *
 * Recomputes every named ad from the saved inputs, profile, data health, role
 * context, previous label and frequency threshold with the same production
 * functions, and exits non-zero unless the computation, payload and advisory
 * match the capture exactly.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { WarehouseNativeAdAccountProfileDataSource } from "@/lib/creative-decision-engine/ad-account-decision-profile-store";
import {
  resolveCampaignContextMode,
  type CampaignContextMap,
} from "@/lib/creative-decision-engine/campaign-context/source";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import {
  readPreviousPublishedAdLabels,
  type PreviousAdPublishedLabel,
} from "@/lib/creative-decision-engine/decision-stability";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import {
  assertEmptyNativeAdHydrationIsAuthoritative,
  buildNativeAdDataHealth,
  buildNativeManualCutAdvisory,
  computeReadyNativeAdDecisions,
  computeSoftOnlyNativeAdDecisions,
  groupNativeProfileInputsByScope,
  mergeUniqueMap,
  readAdAdsetRoles,
  readAdCampaignContext,
  resolveNativeAdDecisionProfileGroups,
  resolveNativeAdFrequencyPressureThresholdsByAccount,
  toNativeSnapshotPayload,
  type AdDecisionComputation,
  type NativeAdDecisionProfileGroup,
} from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import type { DataHealth } from "@/lib/creative-decision-engine/types";
import { getDb, runDbTransaction } from "@/lib/db";

import { configureOperationalScriptRuntime } from "../_operational-runtime";
import { pinReadOnlySnapshot } from "./read-only-snapshot";

const CAPTURE_MODE = "read_only_native_manual_cut_advisory_capture";

export interface CapturedAd {
  adId: string;
  group: {
    key: string;
    blocker: string | null;
    calibrationRowId: string | null;
    calibrationCell: unknown;
    profile: NativeAdDecisionProfileGroup["profile"];
    memberCount: number;
  };
  dataHealth: DataHealth;
  previousLabel: [string, PreviousAdPublishedLabel] | null;
  computation: AdDecisionComputation;
  payload: ReturnType<typeof toNativeSnapshotPayload>;
  advisory: ReturnType<typeof buildNativeManualCutAdvisory>;
}

export interface Capture {
  mode: typeof CAPTURE_MODE;
  engineVersion: string;
  businessId: string;
  providerAccountId: string;
  asOf: string;
  cutoff: string;
  snapshot: Awaited<ReturnType<typeof pinReadOnlySnapshot>>;
  campaignContextMode: ReturnType<typeof resolveCampaignContextMode>;
  hydration: {
    accountInputCount: number;
    receipts: unknown;
  };
  frequencyPressureThresholdByAccount: Array<[string, number | null]>;
  campaignContextById: Array<[string, unknown]>;
  adsetRoleByKey: Array<[string, unknown]>;
  ads: CapturedAd[];
}

function arg(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

function required(argv: string[], name: string): string {
  const value = arg(argv, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

/** The same branch the job takes, for the named ads only. */
function computeGroup(input: {
  businessId: string;
  group: NativeAdDecisionProfileGroup;
  adInputs: NativeAdDecisionProfileGroup["adInputs"];
  dataHealth: DataHealth;
  campaignContextMode: ReturnType<typeof resolveCampaignContextMode>;
  campaignContextById: CampaignContextMap;
  adsetRoleByKey: CampaignContextMap;
  previousLabels: Map<string, PreviousAdPublishedLabel>;
  frequencyPressureThresholdByAccount: ReadonlyMap<string, number | null>;
  evaluatedAt: string;
}): AdDecisionComputation[] {
  const group = { ...input.group, adInputs: input.adInputs };
  return group.blocker === null
    ? computeReadyNativeAdDecisions({
        group,
        businessId: input.businessId,
        dataHealth: input.dataHealth,
        campaignContextMode: input.campaignContextMode,
        campaignContextById: input.campaignContextById,
        adsetRoleByKey: input.adsetRoleByKey,
        previousLabels: input.previousLabels,
        frequencyPressureThresholdByAccount: input.frequencyPressureThresholdByAccount,
      })
    : computeSoftOnlyNativeAdDecisions({
        businessId: input.businessId,
        blocker: group.blocker,
        profile: group.profile,
        adInputs: group.adInputs,
        campaignContextMode: input.campaignContextMode,
        campaignContextById: input.campaignContextById,
        adsetRoleByKey: input.adsetRoleByKey,
        previousLabels: input.previousLabels,
        evaluatedAt: input.evaluatedAt,
      });
}

function payloadFor(input: {
  businessId: string;
  asOf: string;
  cutoff: string;
  group: NativeAdDecisionProfileGroup;
  computation: AdDecisionComputation;
}) {
  return toNativeSnapshotPayload({
    businessId: input.businessId,
    asOf: input.asOf,
    jobRunId: `read-only-advisory-replay:${input.asOf}:${input.computation.input.adId}`,
    scope: input.group.profile.scope,
    computation: input.computation,
    // Not persisted: placeholders the payload only copies through.
    stored: {
      evaluationId: "00000000-0000-4000-8000-000000000000",
      providerAccountRefId: input.computation.input.providerAccountRefId,
      providerAccountId: input.computation.input.providerAccountId,
      decisionEntityId: input.computation.input.decisionEntityId,
      inputHash: "0".repeat(64),
      decisionHash: "0".repeat(64),
    },
    calibrationRowId: input.group.calibrationRowId,
    hardActionEligibility: input.group.profile.hardActionEligibility,
    computedAt: input.cutoff,
  });
}

async function capture(argv: string[]): Promise<Capture> {
  const businessId = required(argv, "--business");
  const providerAccountId = required(argv, "--account");
  const asOf = required(argv, "--asOf");
  const adIds = required(argv, "--ads").split(",").map((id) => id.trim()).filter(Boolean);
  return runDbTransaction(
    async () => {
      const db = getDb();
      const snapshot = await pinReadOnlySnapshot(
        (text, values) => db.query<Record<string, unknown>>(text, values as unknown[]),
      );
      const cutoff = snapshot.transactionStartedAt;
      const flags = await resolveEngineV3Flags(businessId);
      if (!flags.enabled) throw new Error("engine v3 is disabled for this business");

      const hydration = await new WarehouseDataSource().hydrateAdDecisionInputs({
        businessId,
        asOf,
        decisionCutoff: cutoff,
        providerAccountIds: [providerAccountId],
      });
      assertEmptyNativeAdHydrationIsAuthoritative(hydration);
      const targets = hydration.inputs.filter((ad) => adIds.includes(ad.adId));
      if (targets.length !== adIds.length) {
        throw new Error(
          `hydrated ${targets.length} of ${adIds.length} named ads: ${targets.map((ad) => ad.adId).join(",")}`,
        );
      }
      const groups = await resolveNativeAdDecisionProfileGroups({
        businessId,
        asOf,
        adInputs: hydration.inputs,
        flags,
        dataSource: new WarehouseNativeAdAccountProfileDataSource(db),
      });
      const campaignContextMode = resolveCampaignContextMode();
      const campaignContextById = await readAdCampaignContext({
        businessId,
        asOf,
        adInputs: targets,
        mode: campaignContextMode,
        visibleAtCutoff: cutoff,
      });
      const adsetRoleByKey = await readAdAdsetRoles({
        businessId,
        asOf,
        adInputs: targets,
        mode: campaignContextMode,
        campaignContextById,
        visibleAtCutoff: cutoff,
      });
      const targetGroups = groups
        .map((group) => ({
          group,
          members: group.adInputs.filter((ad) => adIds.includes(ad.adId)),
        }))
        .filter((entry) => entry.members.length > 0);
      const previousLabels = new Map<string, PreviousAdPublishedLabel>();
      for (const scopeGroup of groupNativeProfileInputsByScope(
        targetGroups.map((entry) => ({ ...entry.group, adInputs: entry.members })),
      )) {
        const rows = await readPreviousPublishedAdLabels(
          {
            businessId,
            asOf,
            identities: scopeGroup.adInputs.map((ad) => ({
              providerAccountRefId: ad.providerAccountRefId,
              providerAccountId: ad.providerAccountId,
              decisionEntityType: "ad" as const,
              decisionEntityId: ad.decisionEntityId,
            })),
            scopeType: scopeGroup.scope.type,
            scopeId: scopeGroup.scope.id,
            visibleAtCutoff: cutoff,
          },
          db,
        );
        mergeUniqueMap(previousLabels, rows, "hysteresis lineage");
      }
      // Account-relative: over every hydrated ad, exactly as the job builds it.
      const frequencyPressureThresholdByAccount =
        resolveNativeAdFrequencyPressureThresholdsByAccount(hydration.inputs);

      const ads: CapturedAd[] = [];
      for (const { group, members } of targetGroups) {
        const dataHealth = buildNativeAdDataHealth({
          calibrationCell: group.calibrationCell,
          blocker: group.blocker,
          adInputs: group.adInputs,
          previousLabels,
          scope: group.profile.scope,
          evaluatedAt: cutoff,
        });
        const computations = computeGroup({
          businessId,
          group,
          adInputs: members,
          dataHealth,
          campaignContextMode,
          campaignContextById,
          adsetRoleByKey,
          previousLabels,
          frequencyPressureThresholdByAccount,
          evaluatedAt: cutoff,
        });
        for (const computation of computations) {
          const previousLabel =
            [...previousLabels.entries()].find(
              ([, label]) => label.decisionEntityId === computation.input.decisionEntityId,
            ) ?? null;
          ads.push({
            adId: computation.input.adId,
            group: {
              key: group.key,
              blocker: group.blocker,
              calibrationRowId: group.calibrationRowId,
              calibrationCell: group.calibrationCell,
              profile: group.profile,
              memberCount: group.adInputs.length,
            },
            dataHealth,
            previousLabel,
            computation,
            payload: payloadFor({ businessId, asOf, cutoff, group, computation }),
            advisory: buildNativeManualCutAdvisory(computation, asOf, cutoff),
          });
        }
      }
      return {
        mode: CAPTURE_MODE,
        engineVersion: NATIVE_AD_ENGINE_VERSION,
        businessId,
        providerAccountId,
        asOf,
        cutoff,
        snapshot,
        campaignContextMode,
        hydration: { accountInputCount: hydration.inputs.length, receipts: hydration.receipts },
        frequencyPressureThresholdByAccount: [...frequencyPressureThresholdByAccount.entries()],
        campaignContextById: [...campaignContextById.entries()],
        adsetRoleByKey: [...adsetRoleByKey.entries()],
        ads,
      };
    },
    { timeoutMs: 300_000 },
  );
}

/** The first JSON path at which two values differ, or null. */
function firstDifference(left: unknown, right: unknown, path = "$"): string | null {
  const l = JSON.parse(JSON.stringify(left ?? null)) as unknown;
  const r = JSON.parse(JSON.stringify(right ?? null)) as unknown;
  if (typeof l !== "object" || typeof r !== "object" || l === null || r === null) {
    return Object.is(l, r) ? null : `${path}: ${JSON.stringify(l)} != ${JSON.stringify(r)}`;
  }
  if (Array.isArray(l) !== Array.isArray(r)) return `${path}: array/object mismatch`;
  const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
  for (const key of keys) {
    const diff = firstDifference(
      (l as Record<string, unknown>)[key],
      (r as Record<string, unknown>)[key],
      `${path}.${key}`,
    );
    if (diff) return diff;
  }
  return null;
}

/** Recompute retained inputs under current code without rewriting the capture. */
export function recomputeCapturedAds(captured: Capture): CapturedAd[] {
  const campaignContextById = new Map(captured.campaignContextById) as CampaignContextMap;
  const adsetRoleByKey = new Map(captured.adsetRoleByKey) as CampaignContextMap;
  const frequencyPressureThresholdByAccount = new Map(captured.frequencyPressureThresholdByAccount);
  return captured.ads.map((ad) => {
    const previousLabels = new Map<string, PreviousAdPublishedLabel>(
      ad.previousLabel ? [ad.previousLabel] : [],
    );
    const group = {
      key: ad.group.key,
      blocker: ad.group.blocker,
      calibrationRowId: ad.group.calibrationRowId,
      calibrationCell: ad.group.calibrationCell,
      profile: ad.group.profile,
      adInputs: [ad.computation.input],
    } as unknown as NativeAdDecisionProfileGroup;
    const [computation] = computeGroup({
      businessId: captured.businessId,
      group,
      adInputs: [ad.computation.input],
      dataHealth: ad.dataHealth,
      campaignContextMode: captured.campaignContextMode,
      campaignContextById,
      adsetRoleByKey,
      previousLabels,
      frequencyPressureThresholdByAccount,
      evaluatedAt: captured.cutoff,
    });
    if (!computation) throw new Error(`replay produced no computation for ${ad.adId}`);
    const payload = payloadFor({
      businessId: captured.businessId,
      asOf: captured.asOf,
      cutoff: captured.cutoff,
      group,
      computation,
    });
    const advisory = buildNativeManualCutAdvisory(computation, captured.asOf, captured.cutoff);
    return { ...ad, computation, payload, advisory };
  });
}

/** Replays every captured ad offline and reports whether it reproduces. */
export function replayCapture(captured: Capture): Array<{
  adId: string;
  computationMatches: boolean;
  payloadMatches: boolean;
  advisoryMatches: boolean;
  firstDifference: string | null;
}> {
  const same = (left: unknown, right: unknown) => firstDifference(left, right) === null;
  const comparable = (value: AdDecisionComputation) => ({
    ...value, decision: { ...value.decision, generatedAt: null },
  });
  return recomputeCapturedAds(captured).map((current, i) => {
    const original = captured.ads[i]!;
    return {
      adId: current.adId,
      computationMatches: same(comparable(current.computation), comparable(original.computation)),
      payloadMatches: same(current.payload, original.payload),
      advisoryMatches: same(current.advisory, original.advisory),
      firstDifference:
        firstDifference(comparable(current.computation), comparable(original.computation)) ??
        firstDifference(current.payload, original.payload) ??
        firstDifference(current.advisory, original.advisory),
    };
  });
}

function summary(captured: Capture) {
  return captured.ads.map((ad) => {
    const sensitivity = ad.computation.manualCutSensitivity;
    return {
      adId: ad.adId,
      group: { blocker: ad.group.blocker, calibrationRowId: ad.group.calibrationRowId },
      decision: {
        rawLabel: ad.computation.rawLabel,
        label: ad.computation.decision.label,
        authorityBlocker: ad.computation.decision.authorityBlocker ?? null,
        hysteresisSuppressed: ad.computation.hysteresisSuppressed,
        truthSource: ad.computation.decision.truthSource,
        effectiveTargetRoas: ad.computation.decision.effectiveTargetRoas,
        ratioToTarget: ad.computation.decision.ratioToTarget,
        reason: ad.computation.decision.reason,
      },
      metrics: {
        spend: ad.computation.input.spend,
        purchaseValue: ad.computation.input.purchaseValue,
        roas: ad.computation.input.roas,
        recent7dSpend: ad.computation.input.recent7dSpend,
        recent7dRoas: ad.computation.input.recent7dRoas,
        decisionWindow: ad.computation.input.decisionWindow ?? null,
      },
      configAuthority: {
        currentObserved: ad.computation.input.configAuthority.currentValueEvidence.observed,
        lineageSupplied: ad.computation.input.configAuthority.currentValueEvidence.lineageSupplied,
        refRefusals: ad.computation.input.configAuthority.currentValueEvidence.refRefusals,
        decisionEconomics: ad.computation.input.configAuthority.decisionEconomics,
        purchaseIntentWindow: ad.computation.input.configAuthority.purchaseIntentWindow ?? null,
        receiptDisagreements: ad.computation.input.configAuthority.receiptDisagreements,
      },
      sensitivity: sensitivity ?? null,
      payload: {
        label: ad.payload.label,
        raw_label: ad.payload.raw_label,
        authority_blocker: ad.payload.authority_blocker,
        blocked_action_type: ad.payload.blocked_action_type,
        authorized_action: ad.payload.authorized_action,
      },
      advisory: ad.advisory,
    };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const replayPath = arg(argv, "--replay");
  if (replayPath) {
    const captured = JSON.parse(readFileSync(replayPath, "utf8")) as Capture;
    const results = replayCapture(captured);
    console.log(JSON.stringify({ replay: results, summary: summary(captured) }, null, 2));
    if (!results.every((r) => r.computationMatches && r.payloadMatches && r.advisoryMatches)) {
      process.exit(2);
    }
    return;
  }
  if (!argv.includes("--capture")) throw new Error("pass --capture or --replay <file>");
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const out = required(argv, "--out");
  const captured = await capture(argv);
  writeFileSync(out, `${JSON.stringify(captured, null, 2)}\n`, "utf8");
  // A capture that cannot reproduce itself offline is not evidence.
  const roundTrip = JSON.parse(JSON.stringify(captured)) as Capture;
  console.log(
    JSON.stringify(
      { out, cutoff: captured.cutoff, replay: replayCapture(roundTrip), summary: summary(captured) },
      null,
      2,
    ),
  );
  console.error(
    "READ-ONLY: one pinned REPEATABLE READ READ ONLY snapshot; nothing persisted, no provider contacted.",
  );
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("native-manual-cut-advisory-replay.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
