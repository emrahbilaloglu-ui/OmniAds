import type { NextRequest } from "next/server";
import type { CommandCenterPermissions, CommandCenterResponse } from "@/lib/command-center";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import {
  COMMAND_CENTER_CONTRACT_VERSION,
  applyCommandCenterQueueSelection,
  aggregateCommandCenterActions,
  buildCommandCenterOpportunities,
  buildCommandCenterDefaultQueueSummary,
  buildCommandCenterFiltersFromViewKey,
  buildCommandCenterOwnerWorkload,
  buildCommandCenterQueueSections,
  buildCommandCenterShiftDigest,
  buildCommandCenterViewStacks,
  compareCommandCenterActions,
  decorateCommandCenterActionsWithThroughput,
  filterCommandCenterActionsByView,
  summarizeCommandCenterOpportunities,
  summarizeCommandCenterFeedback,
  summarizeCommandCenterActions,
} from "@/lib/command-center";
import {
  listAssignableCommandCenterUsers,
  listCommandCenterActionStates,
  listCommandCenterFeedback,
  listCommandCenterHandoffs,
  listCommandCenterJournal,
  listCommandCenterSavedViews,
} from "@/lib/command-center-store";
import { buildCommandCenterHistoricalIntelligence } from "@/lib/command-center-historical-intelligence";
import { buildDecisionFreshness } from "@/lib/decision-trust/kernel";
import { buildDecisionSurfaceAuthority } from "@/lib/decision-trust/surface";
import { getCreativeDecisionOsForRange } from "@/lib/creative-decision-os-source";
import { isCreativeDecisionOsV1EnabledForBusiness } from "@/lib/creative-decision-os-config";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import { getMetaDecisionWindowContext } from "@/lib/meta/operator-decision-source";
import { getMetaDecisionOsForRange } from "@/lib/meta/decision-os-source";
import { isMetaDecisionOsV1EnabledForBusiness } from "@/lib/meta/decision-os-config";

export async function getCommandCenterSnapshot(input: {
  request: NextRequest;
  businessId: string;
  startDate: string;
  endDate: string;
  activeViewKey?: string | null;
  permissions: CommandCenterPermissions;
}): Promise<CommandCenterResponse> {
  const [
    commercialTruth,
    decisionContext,
    metaDecisionOs,
    creativeDecisionOs,
    actionStates,
    savedViews,
    journal,
    handoffs,
    feedback,
    assignableUsers,
    selectedPeriodCampaigns,
  ] = await Promise.all([
    getBusinessCommercialTruthSnapshot(input.businessId).catch(() => null),
    getMetaDecisionWindowContext({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
    }),
    isMetaDecisionOsV1EnabledForBusiness(input.businessId)
      ? getMetaDecisionOsForRange({
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
        })
      : Promise.resolve(null),
    isCreativeDecisionOsV1EnabledForBusiness(input.businessId)
      ? getCreativeDecisionOsForRange({
          request: input.request,
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
        })
      : Promise.resolve(null),
    listCommandCenterActionStates(input.businessId),
    listCommandCenterSavedViews(input.businessId),
    listCommandCenterJournal({ businessId: input.businessId, limit: 60 }),
    listCommandCenterHandoffs({ businessId: input.businessId, limit: 20 }),
    listCommandCenterFeedback({ businessId: input.businessId, limit: 50 }),
    listAssignableCommandCenterUsers(input.businessId),
    getMetaCampaignsForRange({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch(() => ({
      status: "not_connected" as const,
      rows: [],
      isPartial: true,
      notReadyReason: "Selected-period Meta campaign analysis is unavailable.",
    })),
  ]);

  const aggregatedActions = aggregateCommandCenterActions({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    metaDecisionOs,
    creativeDecisionOs,
    stateByFingerprint: actionStates,
    calibrationProfiles: commercialTruth?.calibrationProfiles,
  });
  const opportunities = buildCommandCenterOpportunities({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    metaDecisionOs,
    creativeDecisionOs,
  });
  const opportunitySummary = summarizeCommandCenterOpportunities(opportunities);
  const throughputDecoratedActions = decorateCommandCenterActionsWithThroughput({
    actions: aggregatedActions,
    decisionAsOf: decisionContext.decisionAsOf,
  }).sort(compareCommandCenterActions);
  const throughput = buildCommandCenterDefaultQueueSummary(
    throughputDecoratedActions,
  );
  const allActions = applyCommandCenterQueueSelection({
    actions: throughputDecoratedActions,
    throughput,
  }).sort(compareCommandCenterActions);
  const queueSections = buildCommandCenterQueueSections(allActions);
  const ownerWorkload = buildCommandCenterOwnerWorkload({
    actions: allActions,
    throughput,
  });
  const feedbackSummary = summarizeCommandCenterFeedback(feedback);
  const shiftDigest = buildCommandCenterShiftDigest({
    throughput,
    actions: allActions,
    ownerWorkload,
    feedbackSummary,
  });
  const historicalIntelligence = buildCommandCenterHistoricalIntelligence({
    startDate: input.startDate,
    endDate: input.endDate,
    selectedPeriodCampaigns: selectedPeriodCampaigns.rows ?? [],
    actions: allActions,
    throughput,
    feedbackSummary,
    feedback,
    metaDecisionOs,
    creativeDecisionOs,
  });
  const missingInputs = Array.from(
    new Set([
      ...(metaDecisionOs?.commercialTruthCoverage.missingInputs ?? []),
      ...(creativeDecisionOs?.commercialTruthCoverage.missingInputs ?? []),
    ]),
  );
  const degradedReasons = Array.from(
    new Set([
      ...(metaDecisionOs?.commercialTruthCoverage.notes ?? []),
      ...(creativeDecisionOs?.commercialTruthCoverage.guardrails ?? []),
    ]),
  );
  const hasMissingTruth = missingInputs.length > 0;
  const baseSummary = summarizeCommandCenterActions(allActions);
  const sourceHealth = [
    ...(metaDecisionOs?.summary.sourceHealth ?? []),
    ...(creativeDecisionOs?.summary.sourceHealth ?? []),
  ];
  const readReliability =
    metaDecisionOs?.summary.readReliability?.status === "degraded" ||
    creativeDecisionOs?.summary.readReliability?.status === "degraded"
      ? {
          status: "degraded" as const,
          determinism: "unstable" as const,
          detail:
            "One or more upstream decision surfaces are degraded, so Command Center stays explicitly fallback-aware.",
        }
      : metaDecisionOs?.summary.readReliability?.status === "fallback" ||
          creativeDecisionOs?.summary.readReliability?.status === "fallback"
        ? {
            status: "fallback" as const,
            determinism: "watch" as const,
            detail:
              "At least one upstream decision surface is running on labeled fallback context.",
          }
        : {
            status: "stable" as const,
            determinism: "stable" as const,
            detail:
              "Command Center is reading stable upstream decision surfaces.",
          };
  const authority = buildDecisionSurfaceAuthority({
    scope: "Command Center",
    truthState: hasMissingTruth ? "degraded_missing_truth" : "live_confident",
    completeness:
      !hasMissingTruth
        ? "complete"
        : missingInputs.length >= 3
          ? "missing"
          : "partial",
    freshness: buildDecisionFreshness(),
    missingInputs,
    reasons: degradedReasons,
    actionCoreCount: baseSummary.actionCoreCount,
    watchlistCount: baseSummary.watchlistCount,
    archiveCount: baseSummary.archiveCount,
    suppressedCount: baseSummary.watchlistCount + baseSummary.archiveCount,
    note:
      hasMissingTruth
        ? "Command Center is compiling from upstream surfaces with active trust caps."
        : throughput.overflowCount > 0
          ? "Command Center is healthy; excess actionable rows stay in overflow backlog until queue capacity opens."
          : "Command Center is compiling action-core, watchlist, and archive lanes from the shared trust kernel.",
    sourceHealth,
    readReliability,
  });
  const viewStacks = buildCommandCenterViewStacks(savedViews);

  const viewDefinition = buildCommandCenterFiltersFromViewKey(
    input.businessId,
    input.activeViewKey,
    savedViews,
  );
  const visibleActions = viewDefinition
    ? filterCommandCenterActionsByView(allActions, viewDefinition)
    : allActions;

  return {
    contractVersion: COMMAND_CENTER_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    analyticsWindow: decisionContext.analyticsWindow,
    decisionWindows: decisionContext.decisionWindows,
    historicalMemory: decisionContext.historicalMemory,
    decisionAsOf: decisionContext.decisionAsOf,
    activeViewKey: input.activeViewKey ?? null,
    permissions: input.permissions,
    commercialSummary: commercialTruth?.coverage,
    authority,
    summary: {
      ...baseSummary,
      sourceHealth,
      readReliability,
    },
    opportunitySummary,
    throughput,
    queueSections,
    ownerWorkload,
    shiftDigest,
    viewStacks,
    feedbackSummary,
    historicalIntelligence,
    actions: visibleActions,
    opportunities,
    savedViews,
    journal,
    handoffs,
    feedback,
    assignableUsers,
  };
}

export async function findCommandCenterActionForRange(input: {
  request: NextRequest;
  businessId: string;
  startDate: string;
  endDate: string;
  actionFingerprint: string;
  permissions: CommandCenterPermissions;
}) {
  const [commercialTruth, decisionContext, metaDecisionOs, creativeDecisionOs, actionStates] =
    await Promise.all([
      getBusinessCommercialTruthSnapshot(input.businessId).catch(() => null),
      getMetaDecisionWindowContext({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
      }),
      isMetaDecisionOsV1EnabledForBusiness(input.businessId)
        ? getMetaDecisionOsForRange({
            businessId: input.businessId,
            startDate: input.startDate,
            endDate: input.endDate,
          })
        : Promise.resolve(null),
      isCreativeDecisionOsV1EnabledForBusiness(input.businessId)
        ? getCreativeDecisionOsForRange({
            request: input.request,
            businessId: input.businessId,
            startDate: input.startDate,
            endDate: input.endDate,
          })
        : Promise.resolve(null),
      listCommandCenterActionStates(input.businessId),
    ]);
  const aggregatedActions = aggregateCommandCenterActions({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    metaDecisionOs,
    creativeDecisionOs,
    stateByFingerprint: actionStates,
    calibrationProfiles: commercialTruth?.calibrationProfiles,
  });
  const throughputDecoratedActions = decorateCommandCenterActionsWithThroughput({
    actions: aggregatedActions,
    decisionAsOf: decisionContext.decisionAsOf,
  }).sort(compareCommandCenterActions);
  const throughput = buildCommandCenterDefaultQueueSummary(
    throughputDecoratedActions,
  );
  const allActions = applyCommandCenterQueueSelection({
    actions: throughputDecoratedActions,
    throughput,
  }).sort(compareCommandCenterActions);

  return (
    allActions.find((action) => action.actionFingerprint === input.actionFingerprint) ??
    null
  );
}
