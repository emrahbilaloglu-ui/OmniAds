"use client";

import type { ReactNode } from "react";
import { DecisionAuthorityPanel } from "@/components/decision-trust/DecisionAuthorityPanel";
import { DecisionPolicyExplanationPanel } from "@/components/decision-trust/DecisionPolicyExplanationPanel";
import {
  buildMetaOperatorItemFromAdSet,
  buildMetaOperatorItemFromCampaign,
} from "@/lib/meta/operator-surface";
import { cn } from "@/lib/utils";
import type {
  MetaAdSetDecision,
  MetaCampaignDecision,
  MetaDecisionPolicy,
  MetaDecisionOsV1Response,
  MetaGeoDecision,
  MetaOpportunityBoardItem,
  MetaPlacementAnomaly,
  MetaWinnerScaleCandidate,
} from "@/lib/meta/decision-os";
import type { OperatorInstruction } from "@/src/types/operator-decision";

function formatActionLabel(value: string) {
  return value.replaceAll("_", " ");
}

function formatPolicyLabel(value: string) {
  return value.replaceAll("_", " ");
}

function formatTimestampLabel(value: string | null) {
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 16).replace("T", " ");
}

function confidenceTone(confidence: number) {
  if (confidence >= 0.82) return "text-emerald-700";
  if (confidence >= 0.68) return "text-amber-700";
  return "text-slate-600";
}

function actionTone(action: string) {
  if (action === "pause" || action === "cut") return "bg-red-500/10 text-red-700";
  if (action === "scale_budget" || action === "scale" || action === "recover" || action === "isolate") {
    return "bg-emerald-500/10 text-emerald-700";
  }
  if (action === "rebuild" || action === "exception_review") return "bg-amber-500/10 text-amber-700";
  return "bg-slate-500/10 text-slate-700";
}

function operatorStateTone(state: string | null | undefined) {
  if (state === "do_now") return "bg-emerald-500/10 text-emerald-700";
  if (state === "do_not_touch") return "bg-blue-500/10 text-blue-700";
  if (state === "blocked") return "bg-rose-500/10 text-rose-700";
  if (state === "investigate") return "bg-amber-500/10 text-amber-700";
  if (state === "watch") return "bg-sky-500/10 text-sky-700";
  return "bg-slate-500/10 text-slate-700";
}

function pushReadinessLabel(value: string | null | undefined) {
  if (!value) return "push readiness unavailable";
  return formatActionLabel(value);
}

function operatorPolicyActionLabel(
  policy: MetaAdSetDecision["operatorPolicy"] | MetaCampaignDecision["operatorPolicy"] | null,
  fallback: string,
) {
  if (!policy) return fallback;
  if (policy.state === "do_now") return fallback;
  if (policy.state === "do_not_touch") return "Do not touch";
  if (policy.state === "blocked") return "Blocked";
  if (policy.state === "investigate") return "Investigate";
  if (policy.state === "watch") return "Watch";
  return "Context";
}

function trustTone(
  disposition: MetaAdSetDecision["trust"]["operatorDisposition"],
) {
  if (disposition === "protected_watchlist") return "bg-blue-500/10 text-blue-700";
  if (disposition === "archive_only") return "bg-slate-500/10 text-slate-700";
  if (disposition === "degraded_no_scale") return "bg-orange-500/10 text-orange-700";
  if (disposition === "profitable_truth_capped") return "bg-fuchsia-500/10 text-fuchsia-700";
  if (disposition === "review_hold" || disposition === "review_reduce") {
    return "bg-amber-500/10 text-amber-700";
  }
  if (disposition === "monitor_low_truth") return "bg-sky-500/10 text-sky-700";
  return "bg-slate-500/10 text-slate-700";
}

function laneTone(lane: MetaAdSetDecision["trust"]["surfaceLane"]) {
  if (lane === "action_core") return "bg-emerald-500/10 text-emerald-700";
  if (lane === "watchlist") return "bg-blue-500/10 text-blue-700";
  return "bg-slate-500/10 text-slate-700";
}

function PolicyChips({
  policy,
}: {
  policy: MetaDecisionPolicy;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-wide">
      <span className="rounded-full bg-violet-500/10 px-2 py-1 text-violet-700">
        strategy {formatPolicyLabel(policy.strategyClass)}
      </span>
      <span className="rounded-full bg-slate-500/10 px-2 py-1 text-slate-700">
        objective {formatPolicyLabel(policy.objectiveFamily)}
      </span>
      <span className="rounded-full bg-slate-500/10 px-2 py-1 text-slate-700">
        bid {formatPolicyLabel(policy.bidRegime)}
      </span>
      <span className="rounded-full bg-amber-500/10 px-2 py-1 text-amber-700">
        driver {formatPolicyLabel(policy.primaryDriver)}
      </span>
    </div>
  );
}

function EvidenceChips({
  evidence,
}: {
  evidence: Array<{ label: string; value: string; impact?: string }>;
}) {
  if (evidence.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {evidence.slice(0, 4).map((item) => (
        <div
          key={`${item.label}:${item.value}`}
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 shadow-sm"
        >
          <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
            {item.label}
          </p>
          <p className="text-xs font-semibold text-slate-800">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

function DecisionListCard({
  title,
  testId,
  empty,
  children,
}: {
  title: string;
  testId: string;
  empty: string;
  children: ReactNode;
}) {
  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
      data-testid={testId}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        {title}
      </p>
      <div className="mt-3">{children ?? <p className="text-xs text-slate-500">{empty}</p>}</div>
    </div>
  );
}

function OperatorInstructionBlock({
  instruction,
}: {
  instruction: OperatorInstruction | null | undefined;
}) {
  if (!instruction) return null;
  return (
    <div className="mt-3 rounded-xl border border-slate-100 bg-white px-3 py-2 text-xs text-slate-600">
      <p className="font-semibold text-slate-900">{instruction.primaryMove}</p>
      <p className="mt-1">
        Why now: {instruction.reasonSummary}
      </p>
      <p className="mt-1 text-[11px] text-slate-500">
        Target: {instruction.targetContext.label}
      </p>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
        <span>Evidence {instruction.evidenceStrength}</span>
        <span>Urgency {instruction.urgency}</span>
        <span>{pushReadinessLabel(instruction.pushReadiness)}</span>
        <span>{instruction.amountGuidance.label}</span>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Urgency basis: {instruction.urgencyReason}
      </p>
      {instruction.nextObservation[0] ? (
        <p className="mt-2 text-[11px] text-slate-500">
          Watch next: {instruction.nextObservation[0]}
        </p>
      ) : null}
      {instruction.invalidActions[0] ? (
        <p className="mt-1 text-[11px] text-slate-500">
          Do not: {instruction.invalidActions[0]}
        </p>
      ) : null}
    </div>
  );
}

function AdSetDecisionRow({ decision }: { decision: MetaAdSetDecision }) {
  const operatorItem = buildMetaOperatorItemFromAdSet(decision);
  const policy = decision.operatorPolicy ?? null;

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{decision.adSetName}</p>
          <p className="mt-0.5 text-xs text-slate-500">{decision.campaignName}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              policy?.state === "blocked" ? operatorStateTone(policy.state) : actionTone(decision.actionType),
            )}
          >
            {operatorPolicyActionLabel(policy, operatorItem.primaryAction)}
          </span>
          {decision.noTouch ? (
            <span className="rounded-full bg-blue-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
              no-touch
            </span>
          ) : null}
          <span
            className={cn(
              "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              operatorStateTone(policy?.state),
            )}
          >
            {policy ? formatActionLabel(policy.state) : "policy missing"}
          </span>
          {decision.trust.operatorDisposition !== "standard" ? (
            <span
              className={cn(
                "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                trustTone(decision.trust.operatorDisposition),
              )}
            >
              {formatActionLabel(decision.trust.operatorDisposition)}
            </span>
          ) : null}
        </div>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">{operatorItem.reason}</p>
      <OperatorInstructionBlock instruction={operatorItem.instruction} />
      <PolicyChips policy={decision.policy} />
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-500">
        <span>ROAS {decision.supportingMetrics.roas.toFixed(2)}x</span>
        <span>Spend ${decision.supportingMetrics.spend.toFixed(0)}</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 capitalize",
            laneTone(decision.trust.surfaceLane),
          )}
        >
          {decision.trust.surfaceLane.replaceAll("_", " ")}
        </span>
        <span className={confidenceTone(decision.confidence)}>
          Confidence {(decision.confidence * 100).toFixed(0)}%
        </span>
      </div>
      {decision.guardrails.length > 0 ? (
        <p className="mt-2 text-[11px] text-slate-500">{decision.guardrails[0]}</p>
      ) : null}
      {operatorItem.blocker ? (
        <p className="mt-2 text-[11px] text-slate-500">Blocker: {operatorItem.blocker}</p>
      ) : null}
      {policy ? (
        <p className="mt-2 text-[11px] text-slate-500">
          Push readiness: {pushReadinessLabel(policy.pushReadiness)}
          {policy.blockers[0] ? ` · ${policy.blockers[0]}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function CampaignDecisionRow({
  decision,
}: {
  decision: MetaCampaignDecision;
}) {
  const operatorItem = buildMetaOperatorItemFromCampaign(decision);
  const policy = decision.operatorPolicy ?? null;

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{decision.campaignName}</p>
          <p className="mt-0.5 text-xs text-slate-500">{decision.role}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              policy?.state === "blocked" ? operatorStateTone(policy.state) : actionTone(decision.primaryAction),
            )}
          >
            {operatorPolicyActionLabel(policy, operatorItem.primaryAction)}
          </span>
          {decision.trust.operatorDisposition !== "standard" ? (
            <span
              className={cn(
                "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                trustTone(decision.trust.operatorDisposition),
              )}
            >
              {formatActionLabel(decision.trust.operatorDisposition)}
            </span>
          ) : null}
          <span
            className={cn(
              "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              operatorStateTone(policy?.state),
            )}
          >
            {policy ? formatActionLabel(policy.state) : "policy missing"}
          </span>
        </div>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">{operatorItem.reason}</p>
      <OperatorInstructionBlock instruction={operatorItem.instruction} />
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-500">
        <span className={confidenceTone(decision.confidence)}>
          Confidence {(decision.confidence * 100).toFixed(0)}%
        </span>
        <span>{decision.laneLabel ?? "No lane"}</span>
        {decision.missingCreativeAsk?.[0] ? <span>{decision.missingCreativeAsk[0]}</span> : null}
      </div>
      {decision.creativeCandidates?.count ? (
        <p className="mt-2 text-[11px] text-slate-500">{decision.creativeCandidates.summary}</p>
      ) : null}
      {operatorItem.blocker ? (
        <p className="mt-2 text-[11px] text-slate-500">Blocker: {operatorItem.blocker}</p>
      ) : null}
      {policy ? (
        <p className="mt-2 text-[11px] text-slate-500">
          Push readiness: {pushReadinessLabel(policy.pushReadiness)}
          {policy.blockers[0] ? ` · ${policy.blockers[0]}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function WinnerScaleCandidateRow({
  candidate,
}: {
  candidate: MetaWinnerScaleCandidate;
}) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{candidate.adSetName}</p>
          <p className="mt-0.5 text-xs text-slate-500">{candidate.campaignName}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Move band
          </p>
          <p className="text-sm font-semibold text-slate-900">{candidate.suggestedMoveBand}</p>
        </div>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">{candidate.why}</p>
      <PolicyChips policy={candidate.policy} />
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-500">
        <span>ROAS {candidate.supportingMetrics.roas.toFixed(2)}x</span>
        <span>Spend ${candidate.supportingMetrics.spend.toFixed(0)}</span>
        <span>Purchases {candidate.supportingMetrics.purchases}</span>
        <span className={confidenceTone(candidate.confidence)}>
          Confidence {(candidate.confidence * 100).toFixed(0)}%
        </span>
      </div>
      {candidate.guardrails.length > 0 ? (
        <p className="mt-2 text-[11px] text-slate-500">{candidate.guardrails[0]}</p>
      ) : null}
    </div>
  );
}

function OpportunityBoardRow({
  item,
}: {
  item: MetaOpportunityBoardItem;
}) {
  const blockedReason = item.eligibilityTrace?.blockedReasons?.[0] ?? item.queue.blockedReasons[0] ?? null;
  const watchReason = item.eligibilityTrace?.watchReasons?.[0] ?? item.queue.watchReasons[0] ?? null;
  const verdict = (
    item.eligibilityTrace?.verdict ??
    item.queueVerdict ??
    (item.queue.eligible
      ? "queue_ready"
      : item.kind === "protected_winner"
        ? "protected"
        : item.queue.blockedReasons.length > 0
          ? "blocked"
        : "board_only")
  ).replaceAll("_", "-");
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{item.title}</p>
          <p className="mt-1 text-xs text-slate-600">{item.summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              verdict === "queue-ready"
                ? "bg-emerald-500/10 text-emerald-700"
                : verdict === "protected"
                  ? "bg-blue-500/10 text-blue-700"
                  : verdict === "blocked"
                    ? "bg-rose-500/10 text-rose-700"
                    : "bg-slate-500/10 text-slate-700",
            )}
          >
            {verdict}
          </span>
          <span className="rounded-full bg-slate-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-700">
            {formatActionLabel(item.kind)}
          </span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
        <span>{formatActionLabel(item.recommendedAction)}</span>
        <span className={confidenceTone(item.confidence)}>
          Confidence {(item.confidence * 100).toFixed(0)}%
        </span>
        {blockedReason ? (
          <span>{blockedReason}</span>
        ) : watchReason ? (
          <span>{watchReason}</span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {item.evidenceFloors.slice(0, 3).map((floor) => (
          <span
            key={`${item.opportunityId}:${floor.key}`}
            className={cn(
              "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              floor.status === "met"
                ? "bg-emerald-500/10 text-emerald-700"
                : floor.status === "watch"
                  ? "bg-amber-500/10 text-amber-700"
                  : "bg-slate-500/10 text-slate-700",
            )}
          >
            {floor.label}: {floor.current}
          </span>
        ))}
      </div>
    </div>
  );
}

function GeoDecisionRow({ decision }: { decision: MetaGeoDecision }) {
  const supportingMetrics = decision.supportingMetrics ?? {
    roas: 0,
    spend: 0,
  };
  const commercialContext = decision.commercialContext ?? {
    serviceability: null,
    scaleOverride: null,
  };
  const freshness = decision.freshness ?? {
    dataState: "syncing",
    isPartial: false,
    lastSyncedAt: null,
  };
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">{decision.label}</p>
          <p className="text-xs text-slate-500">{decision.countryCode}</p>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
            actionTone(decision.action),
          )}
        >
          {decision.action}
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-600">{decision.why}</p>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
        <span>ROAS {supportingMetrics.roas.toFixed(2)}x</span>
        <span>Spend ${supportingMetrics.spend.toFixed(0)}</span>
        <span>
          {commercialContext.serviceability ?? "unknown"} / {commercialContext.scaleOverride ?? "default"}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 capitalize",
            laneTone(decision.trust.surfaceLane),
          )}
        >
          {decision.trust.surfaceLane.replaceAll("_", " ")}
        </span>
        {decision.trust.operatorDisposition !== "standard" ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 capitalize",
              trustTone(decision.trust.operatorDisposition),
            )}
          >
            {formatActionLabel(decision.trust.operatorDisposition)}
          </span>
        ) : null}
        Confidence {(decision.confidence * 100).toFixed(0)}%
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Source {freshness.dataState}
        {freshness.isPartial ? " · partial" : ""}
        {freshness.lastSyncedAt ? ` · updated ${formatTimestampLabel(freshness.lastSyncedAt)}` : ""}
      </p>
    </div>
  );
}

function GeoWatchlistClusterRow({ decision }: { decision: MetaGeoDecision }) {
  const commercialContext = decision.commercialContext ?? {
    priorityTier: null,
    serviceability: null,
  };
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">
            {decision.clusterLabel ?? decision.label}
          </p>
          <p className="mt-1 text-xs text-slate-600">{decision.why}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              actionTone(decision.action),
            )}
          >
            {formatActionLabel(decision.action)}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              trustTone(decision.trust.operatorDisposition),
            )}
          >
            {formatActionLabel(decision.trust.operatorDisposition)}
          </span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
        <span>{decision.groupMemberCount} GEOs</span>
        <span>{commercialContext.priorityTier ?? "unconfigured"}</span>
        <span>{commercialContext.serviceability ?? "unknown serviceability"}</span>
        <span className={confidenceTone(decision.confidence)}>
          Confidence {(decision.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Members {decision.groupMemberLabels.slice(0, 5).join(", ")}
        {decision.groupMemberLabels.length > 5
          ? ` +${decision.groupMemberLabels.length - 5} more`
          : ""}
      </p>
    </div>
  );
}

function PlacementAnomalyRow({ anomaly }: { anomaly: MetaPlacementAnomaly }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">{anomaly.label}</p>
        <span
          className={cn(
            "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
            actionTone(anomaly.action),
          )}
        >
          {formatActionLabel(anomaly.action)}
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-600">{anomaly.note}</p>
    </div>
  );
}

type MetaOverviewTrust =
  | MetaCampaignDecision["trust"]
  | MetaAdSetDecision["trust"]
  | MetaGeoDecision["trust"];

interface MetaOverviewWorkItem {
  id: string;
  entityType: "campaign" | "ad set" | "geo";
  title: string;
  subtitle: string | null;
  actionLabel: string;
  actionType: string;
  reason: string;
  confidence: number;
  trust: MetaOverviewTrust | null;
  noTouch: boolean;
  guardrails: string[];
  blocker: string | null;
  commandReady: boolean;
  priorityScore: number;
  operatorState: string | null;
  pushReadiness: string | null;
  instruction: OperatorInstruction | null;
}

function uniqueText(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function formatBooleanState(value: boolean) {
  return value ? "configured" : "missing";
}

function formatConfidence(value: number) {
  return `${(value * 100).toFixed(0)}%`;
}

function trustBlocker(
  trust: MetaOverviewTrust | null | undefined,
  guardrails: string[],
  fallback: Array<string | null | undefined> = [],
) {
  if (!trust) return "Decision OS trust metadata is not available for this row.";
  return uniqueText([
    ...(trust.evidence?.aggressiveActionBlockReasons ?? []),
    ...(trust.evidence?.suppressionReasons ?? []),
    ...guardrails,
    ...fallback,
  ])[0] ?? null;
}

function authorityAllowsPrimaryAction(
  decisionOs: MetaDecisionOsV1Response,
  actionType: string,
) {
  const authority = decisionOs.authority;
  if (!authority) return false;
  if (authority.truthState !== "live_confident") return false;
  if (authority.completeness !== "complete") return false;
  if (authority.freshness.status !== "fresh") return false;
  const readReliability = authority.readReliability ?? decisionOs.summary.readReliability ?? null;
  if (!readReliability || readReliability.status !== "stable") return false;
  if ((authority.readiness?.suppressedActionClasses ?? []).includes(actionType)) return false;
  return true;
}

function trustAllowsPrimaryAction(
  trust: MetaOverviewTrust | null | undefined,
  noTouch: boolean,
) {
  return (
    Boolean(trust) &&
    !noTouch &&
    trust?.surfaceLane === "action_core" &&
    trust?.truthState === "live_confident" &&
    trust?.operatorDisposition === "standard" &&
    trust?.evidence?.aggressiveActionBlocked !== true &&
    trust?.evidence?.suppressed !== true
  );
}

function adSetPriorityScore(priority: MetaAdSetDecision["priority"]) {
  if (priority === "critical") return 0;
  if (priority === "high") return 1;
  if (priority === "medium") return 2;
  return 3;
}

function buildOverviewWorkItems(decisionOs: MetaDecisionOsV1Response) {
  const campaignItems = decisionOs.campaigns.map((decision) => {
    const trust = decision.trust ?? null;
    const operatorItem = trust ? buildMetaOperatorItemFromCampaign(decision) : null;
    return {
      id: `campaign:${decision.campaignId}`,
      entityType: "campaign" as const,
      title: decision.campaignName,
      subtitle: decision.role,
      actionLabel: operatorItem?.primaryAction ?? formatActionLabel(decision.primaryAction),
      actionType: decision.primaryAction,
      reason: operatorItem?.reason ?? decision.why,
      confidence: decision.confidence,
      trust,
      noTouch: decision.noTouch,
      guardrails: decision.guardrails,
      blocker: operatorItem?.blocker ?? trustBlocker(trust, decision.guardrails, decision.whatWouldChangeThisDecision),
      commandReady:
        decision.operatorPolicy?.state === "do_now" &&
        (decision.operatorPolicy.pushReadiness === "safe_to_queue" ||
          decision.operatorPolicy.pushReadiness === "eligible_for_push_when_enabled") &&
        authorityAllowsPrimaryAction(decisionOs, decision.primaryAction) &&
        trustAllowsPrimaryAction(trust, decision.noTouch),
      priorityScore: 1,
      operatorState: decision.operatorPolicy?.state ?? null,
      pushReadiness: decision.operatorPolicy?.pushReadiness ?? null,
      instruction: operatorItem?.instruction ?? null,
    } satisfies MetaOverviewWorkItem;
  });
  const adSetItems = decisionOs.adSets.map((decision) => {
    const trust = decision.trust ?? null;
    const operatorItem = trust ? buildMetaOperatorItemFromAdSet(decision) : null;
    return {
      id: `adset:${decision.decisionId}`,
      entityType: "ad set" as const,
      title: decision.adSetName,
      subtitle: decision.campaignName,
      actionLabel: operatorItem?.primaryAction ?? formatActionLabel(decision.actionType),
      actionType: decision.actionType,
      reason: operatorItem?.reason ?? decision.reasons[0] ?? "Operator review required.",
      confidence: decision.confidence,
      trust,
      noTouch: decision.noTouch,
      guardrails: decision.guardrails,
      blocker: operatorItem?.blocker ?? trustBlocker(trust, decision.guardrails, decision.whatWouldChangeThisDecision),
      commandReady:
        decision.operatorPolicy?.state === "do_now" &&
        (decision.operatorPolicy.pushReadiness === "safe_to_queue" ||
          decision.operatorPolicy.pushReadiness === "eligible_for_push_when_enabled") &&
        authorityAllowsPrimaryAction(decisionOs, decision.actionType) &&
        trustAllowsPrimaryAction(trust, decision.noTouch),
      priorityScore: adSetPriorityScore(decision.priority),
      operatorState: decision.operatorPolicy?.state ?? null,
      pushReadiness: decision.operatorPolicy?.pushReadiness ?? null,
      instruction: operatorItem?.instruction ?? null,
    } satisfies MetaOverviewWorkItem;
  });
  const geoItems = decisionOs.geoDecisions.map((decision) => {
    const trust = decision.trust ?? null;
    return {
      id: `geo:${decision.geoKey}`,
      entityType: "geo" as const,
      title: decision.label,
      subtitle: decision.clusterLabel ?? decision.countryCode,
      actionLabel: formatActionLabel(decision.action),
      actionType: decision.action,
      reason: decision.why,
      confidence: decision.confidence,
      trust,
      noTouch: false,
      guardrails: decision.guardrails,
      blocker: trustBlocker(trust, decision.guardrails, decision.whatWouldChangeThisDecision),
      commandReady:
        authorityAllowsPrimaryAction(decisionOs, decision.action) &&
        trustAllowsPrimaryAction(trust, false),
      priorityScore: decision.queueEligible ? 1 : 3,
      operatorState: null,
      pushReadiness: null,
      instruction: null,
    } satisfies MetaOverviewWorkItem;
  });

  return [...campaignItems, ...adSetItems, ...geoItems];
}

function WorkItemRow({
  item,
  contextual = false,
}: {
  item: MetaOverviewWorkItem;
  contextual?: boolean;
}) {
  const showContextualSafetyCopy =
    contextual && item.instruction?.instructionKind === "do_now";
  const laneLabel = item.trust
    ? formatActionLabel(item.trust.surfaceLane)
    : "trust unavailable";
  const truthLabel = item.trust
    ? formatActionLabel(item.trust.truthState)
    : "unavailable";

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{item.title}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {item.entityType}
            {item.subtitle ? ` · ${item.subtitle}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            className={cn(
              "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              contextual ? "bg-slate-500/10 text-slate-700" : actionTone(item.actionType),
            )}
          >
            {contextual ? "context" : item.actionLabel}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              item.trust
                ? laneTone(item.trust.surfaceLane)
                : "bg-slate-500/10 text-slate-700",
            )}
          >
            {laneLabel}
          </span>
          {item.trust && item.trust.operatorDisposition !== "standard" ? (
            <span
              className={cn(
                "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                trustTone(item.trust.operatorDisposition),
              )}
            >
              {formatActionLabel(item.trust.operatorDisposition)}
            </span>
          ) : null}
          <span
            className={cn(
              "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
              operatorStateTone(item.operatorState),
            )}
          >
            {item.operatorState ? formatActionLabel(item.operatorState) : "policy context"}
          </span>
        </div>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">{item.reason}</p>
      {showContextualSafetyCopy ? (
        <div className="mt-3 rounded-xl border border-slate-100 bg-white px-3 py-2 text-xs text-slate-600">
          <p className="font-semibold text-slate-900">
            Review as context; this row is not command-ready.
          </p>
          <p className="mt-1">
            Do not execute the primary move until authority, trust, and policy
            readiness all allow it.
          </p>
        </div>
      ) : (
        <OperatorInstructionBlock instruction={item.instruction} />
      )}
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
        <span>Confidence {formatConfidence(item.confidence)}</span>
        <span>Truth {truthLabel}</span>
        <span>{pushReadinessLabel(item.pushReadiness)}</span>
        {item.noTouch ? <span>No-touch</span> : null}
      </div>
      {item.blocker ? (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          Blocker: {item.blocker}
        </p>
      ) : item.guardrails[0] ? (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          Guardrail: {item.guardrails[0]}
        </p>
      ) : null}
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | string;
  detail?: string | null;
}) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-slate-950">{value}</p>
      {detail ? <p className="mt-1 text-[11px] text-slate-500">{detail}</p> : null}
    </div>
  );
}

function opportunityVerdict(item: MetaOpportunityBoardItem) {
  return (
    item.eligibilityTrace?.verdict ??
    item.queueVerdict ??
    (item.queue.eligible
      ? "queue_ready"
      : item.kind === "protected_winner"
        ? "protected"
        : item.queue.blockedReasons.length > 0
          ? "blocked"
          : "board_only")
  );
}

function opportunityBlockers(item: MetaOpportunityBoardItem) {
  return uniqueText([
    ...item.queue.blockedReasons,
    ...item.queue.watchReasons,
    ...(item.eligibilityTrace?.blockedReasons ?? []),
    ...(item.eligibilityTrace?.watchReasons ?? []),
    ...(item.eligibilityTrace?.sharedTruthBlockers ?? []),
    ...(item.eligibilityTrace?.protectedReasons ?? []),
  ]);
}

function AuthorityReadinessSection({
  decisionOs,
}: {
  decisionOs: MetaDecisionOsV1Response;
}) {
  const authority = decisionOs.authority;
  const commercialTruth = decisionOs.commercialTruthCoverage;
  const readReliability = authority?.readReliability ?? decisionOs.summary.readReliability ?? null;
  const sourceHealth = authority?.sourceHealth ?? decisionOs.summary.sourceHealth ?? [];
  const suppressedActionClasses = authority?.readiness?.suppressedActionClasses ?? [];
  const readinessMissing = authority?.readiness?.missingInputs ?? [];
  const commercialMissing = uniqueText([
    ...(authority?.missingInputs ?? []),
    ...commercialTruth.missingInputs,
  ]);

  return (
    <section className="space-y-3" data-testid="meta-authority-readiness">
      <DecisionAuthorityPanel
        authority={authority}
        commercialSummary={commercialTruth.summary}
        title="Authority & readiness"
      />
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Commercial Truth Coverage
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-600">
            <span>Mode {formatActionLabel(commercialTruth.mode)}</span>
            <span>Targets {formatBooleanState(commercialTruth.targetPackConfigured)}</span>
            <span>Country economics {formatBooleanState(commercialTruth.countryEconomicsConfigured)}</span>
            <span>Promo calendar {formatBooleanState(commercialTruth.promoCalendarConfigured)}</span>
            <span>Operating constraints {formatBooleanState(commercialTruth.operatingConstraintsConfigured)}</span>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-600">
            {commercialMissing.length > 0
              ? `Missing truth: ${commercialMissing.join(", ")}`
              : "No commercial truth inputs are missing in the Decision OS response."}
          </p>
          {commercialTruth.notes[0] ? (
            <p className="mt-2 text-xs leading-relaxed text-slate-500">{commercialTruth.notes[0]}</p>
          ) : null}
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Readiness Guardrails
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-600">
            {readReliability
              ? `Read reliability ${formatActionLabel(readReliability.status)} · ${readReliability.determinism}. ${readReliability.detail}`
              : "Read reliability is not present in this response."}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-600">
            {suppressedActionClasses.length > 0
              ? `Suppressed action classes: ${suppressedActionClasses.map(formatActionLabel).join(", ")}`
              : "No suppressed action classes are present in readiness metadata."}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-600">
            {readinessMissing.length > 0
              ? `Readiness missing inputs: ${readinessMissing.join(", ")}`
              : "No readiness missing inputs are present."}
          </p>
          {sourceHealth.length > 0 ? (
            <div className="mt-3 space-y-2">
              {sourceHealth.slice(0, 2).map((entry) => (
                <p key={`${entry.source}:${entry.status}`} className="text-[11px] leading-relaxed text-slate-500">
                  {entry.source}: {formatActionLabel(entry.status)} · {entry.detail}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function MetaDecisionOsOverview({
  decisionOs,
  isLoading,
  compact = false,
}: {
  decisionOs: MetaDecisionOsV1Response | null | undefined;
  isLoading: boolean;
  compact?: boolean;
}) {
  if (isLoading) {
    return (
      <div className={cn(compact ? "space-y-3" : "space-y-4")} data-testid="meta-decision-os-loading">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Decision OS
          </p>
          <p className="mt-1 text-sm font-semibold text-slate-950">Loading Decision OS surface...</p>
        </div>
        {[0, 1].map((index) => (
          <div
            key={index}
            className={cn(
              "animate-pulse rounded-2xl bg-slate-100",
              compact ? "h-24" : "h-28",
            )}
          />
        ))}
      </div>
    );
  }

  if (!decisionOs) {
    return (
      <div
        className={cn(compact ? "space-y-3" : "space-y-4")}
        data-testid="meta-decision-os-empty"
      >
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Decision OS
          </p>
          <p className="mt-1 text-sm font-semibold text-slate-950">No Decision OS surface loaded.</p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            Run analysis to generate account-level authority, operator lanes, and policy evidence for this range.
          </p>
        </div>
      </div>
    );
  }

  const workItems = buildOverviewWorkItems(decisionOs);
  const topActionItems = workItems
    .filter((item) => item.commandReady)
    .sort((left, right) => left.priorityScore - right.priorityScore || right.confidence - left.confidence)
    .slice(0, 5);
  const watchItems = workItems
    .filter(
      (item) =>
        !item.commandReady &&
        (!item.trust ||
          item.trust.surfaceLane === "watchlist" ||
          item.trust.surfaceLane === "action_core" ||
          item.trust.operatorDisposition !== "standard" ||
          item.trust.truthState !== "live_confident" ||
          item.trust.evidence?.aggressiveActionBlocked === true ||
          item.trust.evidence?.suppressed === true),
    )
    .sort((left, right) => left.priorityScore - right.priorityScore || right.confidence - left.confidence)
    .slice(0, 6);
  const policyRows = [
    ...decisionOs.campaigns
      .filter((decision) => decision.policy.explanation)
      .map((decision) => ({
        key: `campaign:${decision.campaignId}`,
        title: decision.campaignName,
        explanation: decision.policy.explanation,
      })),
    ...decisionOs.adSets
      .filter((decision) => decision.policy.explanation)
      .map((decision) => ({
        key: `adset:${decision.decisionId}`,
        title: decision.adSetName,
        explanation: decision.policy.explanation,
      })),
  ].slice(0, 5);
  const opportunityRows = decisionOs.opportunityBoard.slice(0, 5);
  const opportunityCounts = {
    queueEligible: decisionOs.opportunityBoard.filter((item) => item.queue.eligible).length,
    blocked: decisionOs.opportunityBoard.filter((item) => opportunityVerdict(item) === "blocked").length,
    protected: decisionOs.opportunityBoard.filter((item) => opportunityVerdict(item) === "protected").length,
    boardOnly: decisionOs.opportunityBoard.filter((item) => opportunityVerdict(item) === "board_only").length,
  };
  const operatorPolicies = [
    ...decisionOs.campaigns.map((decision) => decision.operatorPolicy ?? null),
    ...decisionOs.adSets.map((decision) => decision.operatorPolicy ?? null),
  ].filter(
    (
      policy,
    ): policy is NonNullable<
      MetaCampaignDecision["operatorPolicy"] | MetaAdSetDecision["operatorPolicy"]
    > => Boolean(policy),
  );
  const operatorPolicyCounts = {
    doNow: operatorPolicies.filter((policy) => policy.state === "do_now").length,
    doNotTouch: operatorPolicies.filter((policy) => policy.state === "do_not_touch").length,
    watchInvestigate: operatorPolicies.filter(
      (policy) => policy.state === "watch" || policy.state === "investigate",
    ).length,
    blockedContextual: operatorPolicies.filter(
      (policy) => policy.state === "blocked" || policy.state === "contextual_only",
    ).length,
  };
  const mainOpportunityBlockers = uniqueText(
    decisionOs.opportunityBoard.flatMap((item) => opportunityBlockers(item)),
  ).slice(0, 4);
  const geoAnomalyLabel = `${decisionOs.summary.geoSummary.actionCoreCount} GEO action-core · ${decisionOs.summary.geoSummary.watchlistCount} watchlist`;

  return (
    <div className={cn(compact ? "space-y-3" : "space-y-4")} data-testid="meta-decision-os-overview">
      <AuthorityReadinessSection decisionOs={decisionOs} />

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" data-testid="meta-operator-plan-summary">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Operator Plan Summary
            </p>
            <h3 className="mt-1 text-base font-semibold text-slate-950">
              {decisionOs.summary.todayPlanHeadline}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Decision as of {decisionOs.decisionAsOf} · primary window {decisionOs.decisionWindows.primary30d.startDate} to {decisionOs.decisionWindows.primary30d.endDate}
            </p>
          </div>
          {decisionOs.summary.operatingMode ? (
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Operating Mode
              </p>
              <p className="text-sm font-semibold text-slate-900">
                {decisionOs.summary.operatingMode.recommendedMode}
              </p>
              <p className="text-[11px] text-slate-500">
                {formatConfidence(decisionOs.summary.operatingMode.confidence)} confidence
              </p>
            </div>
          ) : null}
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-3">
          <SummaryMetric label="Action core" value={decisionOs.summary.surfaceSummary.actionCoreCount} />
          <SummaryMetric label="Watchlist" value={decisionOs.summary.surfaceSummary.watchlistCount} />
          <SummaryMetric label="Archive / context" value={decisionOs.summary.surfaceSummary.archiveCount} />
          <SummaryMetric label="Opportunity board" value={decisionOs.summary.opportunitySummary.totalCount} detail={`${decisionOs.summary.opportunitySummary.queueEligibleCount} queue eligible`} />
          <SummaryMetric label="Protected / no-touch" value={decisionOs.noTouchList.length} detail={decisionOs.summary.noTouchSummary} />
          <SummaryMetric label="GEO / placement" value={decisionOs.placementAnomalies.length} detail={geoAnomalyLabel} />
          <SummaryMetric label="Do now" value={operatorPolicyCounts.doNow} detail="Policy-approved primary actions" />
          <SummaryMetric label="Watch / investigate" value={operatorPolicyCounts.watchInvestigate} detail="Review before action" />
          <SummaryMetric label="Blocked / context" value={operatorPolicyCounts.blockedContextual} detail={`${operatorPolicyCounts.doNotTouch} protected`} />
        </div>
      </section>

      <DecisionListCard
        title="Highlighted Action Core"
        testId="meta-top-action-core"
        empty="No command-ready Decision OS action core item is available."
      >
        {topActionItems.length === 0 ? (
          <p className="text-xs leading-relaxed text-slate-500">
            No command-ready Decision OS action core item is available. Review watchlist and protected context before making aggressive changes.
          </p>
        ) : (
          <div className="space-y-3">
            {topActionItems.map((item) => (
              <WorkItemRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </DecisionListCard>

      <DecisionListCard
        title="Watchlist / Degraded Reads"
        testId="meta-watchlist-degraded"
        empty="No watchlist or degraded Decision OS rows are active."
      >
        {watchItems.length === 0 ? (
          <p className="text-xs text-slate-500">No watchlist or degraded Decision OS rows are active.</p>
        ) : (
          <div className="space-y-3">
            {watchItems.map((item) => (
              <WorkItemRow key={item.id} item={item} contextual />
            ))}
          </div>
        )}
      </DecisionListCard>

      <DecisionListCard
        title="Protected / No-Touch"
        testId="meta-no-touch-list"
        empty="No protected winner path is active."
      >
        {decisionOs.noTouchList.length === 0 ? (
          <p className="text-xs text-slate-500">No protected winner path is active.</p>
        ) : (
          <div className="space-y-3">
            {decisionOs.noTouchList.slice(0, 6).map((item) => (
              <div key={`${item.entityType}:${item.entityId}`} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{item.label}</p>
                    <p className="text-xs text-slate-500">{item.entityType}</p>
                  </div>
                  <span className="rounded-full bg-blue-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
                    no-touch
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-slate-600">{item.reason}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                  <span>Confidence {formatConfidence(item.confidence)}</span>
                  {item.guardrails[0] ? <span>{item.guardrails[0]}</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </DecisionListCard>

      <DecisionListCard
        title="Opportunity Board"
        testId="meta-opportunity-board"
        empty="Opportunity board is empty."
      >
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
            <p className="text-xs leading-relaxed text-slate-600">
              {decisionOs.summary.opportunitySummary.headline}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
              <span>Queue eligible {opportunityCounts.queueEligible}</span>
              <span>Blocked {opportunityCounts.blocked}</span>
              <span>Protected {opportunityCounts.protected}</span>
              <span>Board-only {opportunityCounts.boardOnly}</span>
            </div>
            {mainOpportunityBlockers.length > 0 ? (
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                Main blockers: {mainOpportunityBlockers.join(" · ")}
              </p>
            ) : null}
          </div>
          {opportunityRows.length === 0 ? (
            <p className="text-xs text-slate-500">Opportunity board is empty.</p>
          ) : (
            <div className="space-y-3">
              {opportunityRows.map((item) => (
                <OpportunityBoardRow key={item.opportunityId} item={item} />
              ))}
            </div>
          )}
        </div>
      </DecisionListCard>

      <details className="rounded-2xl border border-slate-200 bg-white shadow-sm" data-testid="meta-policy-evidence-details">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-900">
          Policy and evidence details
        </summary>
        <div className="space-y-4 border-t border-slate-200 px-4 py-4">
          {policyRows.length === 0 ? (
            <p className="text-xs text-slate-500">No policy explanation is available in this Decision OS response.</p>
          ) : (
            policyRows.map((item) => (
              <DecisionPolicyExplanationPanel
                key={item.key}
                explanation={item.explanation}
                title={item.title}
              />
            ))
          )}
          {decisionOs.placementAnomalies.length > 0 ? (
            <DecisionListCard
              title="Placement Exception Evidence"
              testId="meta-placement-anomalies"
              empty="No placement anomaly needs exception review."
            >
              <div className="space-y-3">
                {decisionOs.placementAnomalies.slice(0, 3).map((anomaly) => (
                  <PlacementAnomalyRow key={anomaly.placementKey} anomaly={anomaly} />
                ))}
              </div>
            </DecisionListCard>
          ) : null}
        </div>
      </details>
    </div>
  );
}

export function MetaCampaignDecisionPanel({
  campaignDecision,
  adSetDecisions,
}: {
  campaignDecision: MetaCampaignDecision | null;
  adSetDecisions: MetaAdSetDecision[];
}) {
  if (!campaignDecision) return null;
  const operatorItem = buildMetaOperatorItemFromCampaign(campaignDecision);
  const operatorPolicy = campaignDecision.operatorPolicy ?? null;

  return (
    <div className="space-y-4" data-testid="meta-campaign-decision-panel">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Campaign Role
            </p>
            <h3 className="mt-1 text-lg font-semibold text-slate-950">{campaignDecision.role}</h3>
            <p className="mt-1 text-sm text-slate-600">{campaignDecision.why}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                operatorPolicy?.state === "blocked"
                  ? operatorStateTone(operatorPolicy.state)
                  : actionTone(campaignDecision.primaryAction),
              )}
            >
              {operatorPolicyActionLabel(operatorPolicy, operatorItem.primaryAction)}
            </span>
            {campaignDecision.noTouch ? (
              <span className="rounded-full bg-blue-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
                no-touch
              </span>
            ) : null}
            {campaignDecision.trust.operatorDisposition !== "standard" ? (
              <span
                className={cn(
                  "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                  trustTone(campaignDecision.trust.operatorDisposition),
                )}
              >
                {formatActionLabel(campaignDecision.trust.operatorDisposition)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="mt-3 text-[11px] text-slate-500">
          Confidence {(campaignDecision.confidence * 100).toFixed(0)}%
        </div>
        <OperatorInstructionBlock instruction={operatorItem.instruction} />
        {operatorItem.blocker ? (
          <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-xs text-slate-600">
            Blocker: {operatorItem.blocker}
          </div>
        ) : null}
        {operatorPolicy ? (
          <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-xs text-slate-600">
            Operator policy: {formatActionLabel(operatorPolicy.state)} · {pushReadinessLabel(operatorPolicy.pushReadiness)}
            {operatorPolicy.blockers[0] ? ` · ${operatorPolicy.blockers[0]}` : ""}
          </div>
        ) : null}
        <PolicyChips policy={campaignDecision.policy} />
        <EvidenceChips evidence={campaignDecision.evidence} />
        <DecisionPolicyExplanationPanel
          explanation={campaignDecision.policy.explanation}
          title="Campaign Policy Review"
          className="mt-3"
        />
        {campaignDecision.guardrails.length > 0 ? (
          <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-xs text-slate-600">
            {campaignDecision.guardrails[0]}
          </div>
        ) : null}
        {campaignDecision.creativeCandidates?.count ? (
          <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-xs text-slate-600">
            {campaignDecision.creativeCandidates.summary}
          </div>
        ) : campaignDecision.missingCreativeAsk?.[0] ? (
          <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-xs text-slate-600">
            {campaignDecision.missingCreativeAsk[0]}
          </div>
        ) : null}
      </div>

      <DecisionListCard
        title="Ad Set Actions"
        testId="meta-campaign-adset-actions"
        empty="No ad set actions are available for this campaign."
      >
        {adSetDecisions.length === 0 ? (
          <p className="text-xs text-slate-500">No ad set actions are available for this campaign.</p>
        ) : (
          <div className="space-y-3">
            {adSetDecisions.map((decision) => (
              <AdSetDecisionRow key={decision.decisionId} decision={decision} />
            ))}
          </div>
        )}
      </DecisionListCard>
    </div>
  );
}
