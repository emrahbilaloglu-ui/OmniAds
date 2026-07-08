"use client";

import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildGoogleAdsOperatorActionCard } from "@/lib/google-ads/advisor-action-contract";
import { cn } from "@/lib/utils";
import type {
  GoogleAdvisorResponse,
  GoogleAdvisorRecommendation,
} from "@/src/services/google";

type QueueLane = "review" | "test" | "watch" | "suppressed";

function labelize(value: string) {
  return value.replace(/_/g, " ");
}

function familyLabel(family: GoogleAdvisorRecommendation["decisionFamily"]) {
  switch (family) {
    case "waste_control":
      return "Waste Control";
    case "brand_governance":
      return "Brand Governance";
    case "growth_unlock":
      return "Growth Unlock";
    case "structure_repair":
      return "Structure Repair";
    case "commercial_constraint":
      return "Commercial Constraint";
    default:
      return "Experimentation";
  }
}

function laneLabel(lane: QueueLane) {
  switch (lane) {
    case "review":
      return "Review";
    case "test":
      return "Test";
    case "watch":
      return "Watch";
    case "suppressed":
      return "Suppressed";
  }
}

function laneDescription(lane: QueueLane) {
  switch (lane) {
    case "review":
      return "Operator-reviewed decisions that are complete enough to act on manually now.";
    case "test":
      return "Decisions that need a constrained test or prerequisite check before wider action.";
    case "watch":
      return "Signals worth monitoring, but not strong enough for immediate change.";
    case "suppressed":
      return "Decisions the engine is deliberately holding back, with explicit reasons.";
  }
}

function laneTone(lane: QueueLane) {
  switch (lane) {
    case "review":
      return "border-emerald-200 bg-emerald-50/40 text-emerald-800";
    case "test":
      return "border-amber-200 bg-amber-50/40 text-amber-800";
    case "watch":
      return "border-slate-200 bg-slate-50/60 text-slate-700";
    case "suppressed":
      return "border-rose-200 bg-rose-50/40 text-rose-800";
  }
}

function riskTone(level?: GoogleAdvisorRecommendation["decision"]["riskLevel"]) {
  if (level === "high") return "text-rose-700";
  if (level === "medium") return "text-amber-700";
  return "text-emerald-700";
}

function blastRadiusTone(radius?: GoogleAdvisorRecommendation["decision"]["blastRadius"]) {
  if (radius === "account") return "text-rose-700";
  if (radius === "campaign") return "text-amber-700";
  return "text-emerald-700";
}

function confidencePct(confidence?: number | null) {
  if (typeof confidence !== "number") return null;
  return `${Math.round(confidence * 100)}%`;
}

function formatCompactDateTime(value?: string | null) {
  if (!value) return "None";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace(".000Z", "Z");
}

function memoryStatusLabel(status?: GoogleAdvisorRecommendation["currentStatus"] | null) {
  switch (status) {
    case "new":
      return "New";
    case "persistent":
      return "Persistent";
    case "escalated":
      return "Escalated";
    case "downgraded":
      return "Downgraded";
    case "resolved":
      return "Resolved";
    case "suppressed":
      return "Suppressed";
    default:
      return "Untracked";
  }
}

function outcomeLabel(verdict?: GoogleAdvisorRecommendation["outcomeVerdict"] | null) {
  switch (verdict) {
    case "improved":
      return "Improved";
    case "neutral":
      return "Neutral";
    case "degraded":
      return "Degraded";
    case "unknown":
      return "Unknown";
    default:
      return "Pending";
  }
}

function clusterBucketLabel(bucket: GoogleAdvisorResponse["clusters"][number]["clusterBucket"]) {
  switch (bucket) {
    case "now":
      return "Ready now";
    case "next":
      return "Needs staging";
    case "blocked":
      return "Blocked";
  }
}

function clusterStatusLabel(status: GoogleAdvisorResponse["clusters"][number]["clusterStatus"]) {
  return labelize(status);
}

function clusterReadinessLabel(
  readiness: GoogleAdvisorResponse["clusters"][number]["clusterReadiness"]
) {
  return labelize(readiness);
}

function clusterTone(bucket: GoogleAdvisorResponse["clusters"][number]["clusterBucket"]) {
  switch (bucket) {
    case "now":
      return "border-emerald-200 bg-emerald-50/40 text-emerald-800";
    case "next":
      return "border-amber-200 bg-amber-50/40 text-amber-800";
    case "blocked":
      return "border-rose-200 bg-rose-50/40 text-rose-800";
  }
}

function clusterHoldLabel(cluster: GoogleAdvisorResponse["clusters"][number]) {
  const holdValues = cluster.steps
    .flatMap((step) => [step.stabilizationHoldUntil ?? null])
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => left.localeCompare(right));
  return holdValues[0] ? formatCompactDateTime(holdValues[0]) : "No active hold";
}

function deriveQueueLane(recommendation: GoogleAdvisorRecommendation): QueueLane {
  const lane = recommendation.decision?.lane;
  if (lane === "review" || lane === "test" || lane === "watch" || lane === "suppressed") {
    return lane;
  }
  if (recommendation.integrityState === "suppressed") return "suppressed";
  if (recommendation.decisionState === "test" || recommendation.doBucket === "do_next") return "test";
  if (recommendation.decisionState === "watch" || recommendation.doBucket === "do_later") return "watch";
  return "review";
}

function buildWindowLabelMap(advisor: GoogleAdvisorResponse) {
  const metadata = advisor.metadata;
  const map = new Map<string, string>();
  if (!metadata) return map;
  for (const window of metadata.analysisWindows.healthAlarmWindows) {
    map.set(window.key, window.label);
  }
  map.set(metadata.analysisWindows.operationalWindow.key, metadata.analysisWindows.operationalWindow.label);
  map.set(metadata.analysisWindows.queryGovernanceWindow.key, metadata.analysisWindows.queryGovernanceWindow.label);
  map.set(metadata.analysisWindows.baselineWindow.key, metadata.analysisWindows.baselineWindow.label);
  return map;
}

function renderWindowLabel(key: string | undefined, labelMap: Map<string, string>) {
  if (!key) return null;
  return labelMap.get(key) ?? labelize(key);
}

function fallbackNarrative(recommendation: GoogleAdvisorRecommendation) {
  return {
    whatHappened: recommendation.decisionNarrative?.whatHappened ?? recommendation.summary,
    whyItHappened: recommendation.decisionNarrative?.whyItHappened ?? recommendation.why,
    whatToDo: recommendation.decisionNarrative?.whatToDo ?? recommendation.recommendedAction,
    risk:
      recommendation.decisionNarrative?.risk ??
      recommendation.blockers?.join(" ") ??
      "No explicit decision narrative is available for this payload. Keep this in operator review.",
    howToValidate:
      recommendation.decisionNarrative?.howToValidate ??
      recommendation.validationChecklist ??
      [],
    howToRollBack:
      recommendation.decisionNarrative?.howToRollBack ??
      recommendation.rollbackGuidance ??
      "No verified write-back rollback exists in V1. Reverse manually in Google Ads if needed.",
  };
}

function isValidationDue(recommendation: GoogleAdvisorRecommendation) {
  if (!recommendation.outcomeCheckAt) return false;
  if (recommendation.currentStatus === "suppressed" || recommendation.currentStatus === "resolved") {
    return false;
  }
  if (recommendation.outcomeVerdict && recommendation.outcomeVerdict !== "unknown") return false;
  const dueAtMs = new Date(recommendation.outcomeCheckAt).getTime();
  return Number.isFinite(dueAtMs) && dueAtMs <= Date.now();
}

function recommendationActionCard(
  advisor: GoogleAdvisorResponse,
  recommendation: GoogleAdvisorRecommendation
) {
  const source =
    advisor.metadata?.actionContract?.source === "native" ? "native" : "compatibility_derived";
  return recommendation.operatorActionCard ?? buildGoogleAdsOperatorActionCard(recommendation, source);
}

function buildWorkflowCounts(recommendations: GoogleAdvisorRecommendation[]) {
  return {
    newCount: recommendations.filter((entry) => entry.currentStatus === "new").length,
    persistentCount: recommendations.filter((entry) => entry.currentStatus === "persistent").length,
    escalatedCount: recommendations.filter((entry) => entry.currentStatus === "escalated").length,
    resolvedCount: recommendations.filter((entry) => entry.currentStatus === "resolved").length,
    suppressedCount: recommendations.filter((entry) => entry.currentStatus === "suppressed").length,
    appliedCount: recommendations.filter(
      (entry) => entry.executionStatus === "applied" || entry.executionStatus === "partially_applied"
    ).length,
  };
}

function formatOutcomeSummary(recommendation: GoogleAdvisorRecommendation) {
  const parts = [
    outcomeLabel(recommendation.outcomeVerdict),
    recommendation.outcomeMetric ? `metric: ${recommendation.outcomeMetric}` : null,
    typeof recommendation.outcomeDelta === "number" ? `delta: ${recommendation.outcomeDelta}` : null,
    recommendation.outcomeCheckAt ? `checked: ${formatCompactDateTime(recommendation.outcomeCheckAt)}` : null,
  ].filter((value): value is string => Boolean(value));
  return parts.join(" · ");
}

function DetailList({
  title,
  items,
  emptyLabel,
  tone = "default",
}: {
  title: string;
  items?: string[];
  emptyLabel: string;
  tone?: "default" | "primary" | "danger" | "muted";
}) {
  const values = (items ?? []).filter(Boolean);
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        tone === "danger"
          ? "border-rose-200 bg-rose-50/50"
          : tone === "primary"
            ? "border-emerald-200 bg-emerald-50/60"
          : tone === "muted"
            ? "border-dashed bg-muted/10"
            : "bg-muted/15"
      )}
    >
      <div
        className={cn(
          "text-[10px] uppercase tracking-wide",
          tone === "danger"
            ? "text-rose-700"
            : tone === "primary"
              ? "text-emerald-700"
              : "text-muted-foreground"
        )}
      >
        {title}
      </div>
      {values.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm text-slate-800">
          {values.map((item, index) => (
            <li key={`${title}-${index}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  );
}

function SurfaceBlock({
  title,
  children,
  tone = "default",
}: {
  title: string;
  children: ReactNode;
  tone?: "default" | "primary" | "danger";
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        tone === "primary"
          ? "border-emerald-200 bg-emerald-50/60"
          : tone === "danger"
            ? "border-rose-200 bg-rose-50/50"
            : "bg-muted/15"
      )}
    >
      <div
        className={cn(
          "text-[10px] uppercase tracking-wide",
          tone === "primary"
            ? "text-emerald-700"
            : tone === "danger"
              ? "text-rose-700"
              : "text-muted-foreground"
        )}
      >
        {title}
      </div>
      <div className="mt-2 text-sm text-slate-800">{children}</div>
    </div>
  );
}

function WorkflowSection({
  advisor,
}: {
  advisor: GoogleAdvisorResponse;
}) {
  const recommendations = advisor.recommendations;
  const workflowCounts = buildWorkflowCounts(recommendations);
  const validationDue = recommendations
    .filter((recommendation) => isValidationDue(recommendation))
    .sort((left, right) => (left.outcomeCheckAt ?? "").localeCompare(right.outcomeCheckAt ?? ""));
  const recentOutcomes = recommendations
    .filter(
      (recommendation) =>
        recommendation.outcomeVerdict &&
        recommendation.outcomeVerdict !== "unknown" &&
        recommendation.currentStatus !== "suppressed"
    )
    .sort((left, right) =>
      (right.outcomeCheckAt ?? right.appliedAt ?? "").localeCompare(left.outcomeCheckAt ?? left.appliedAt ?? "")
    )
    .slice(0, 5);

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Manual Workflow</p>
        <h2 className="text-lg font-semibold">Lifecycle, validation, and outcomes</h2>
        <p className="text-sm text-muted-foreground">
          Manual-plan-first remains the source of truth. These views track what the operator applied,
          what needs validation next, and which outcomes have already been logged.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SurfaceBlock title="Lifecycle counts">
          <div className="space-y-1">
            <div>New: {workflowCounts.newCount}</div>
            <div>Persistent: {workflowCounts.persistentCount}</div>
            <div>Escalated: {workflowCounts.escalatedCount}</div>
            <div>Suppressed: {workflowCounts.suppressedCount}</div>
            <div>Resolved: {workflowCounts.resolvedCount}</div>
          </div>
        </SurfaceBlock>
        <SurfaceBlock title="Manual apply state">
          <div className="space-y-1">
            <div>Applied or partially applied: {workflowCounts.appliedCount}</div>
            <div>Validation due now: {validationDue.length}</div>
            <div className="text-xs text-muted-foreground">
              Due items stay manual. This queue does not imply autonomous re-checks or write-back.
            </div>
          </div>
        </SurfaceBlock>
        <SurfaceBlock title="Recent outcomes">
          <div className="space-y-1">
            <div>Improved: {recentOutcomes.filter((entry) => entry.outcomeVerdict === "improved").length}</div>
            <div>Neutral: {recentOutcomes.filter((entry) => entry.outcomeVerdict === "neutral").length}</div>
            <div>Degraded: {recentOutcomes.filter((entry) => entry.outcomeVerdict === "degraded").length}</div>
            <div className="text-xs text-muted-foreground">
              Logged outcomes are operator-entered validations, not automated causal proof.
            </div>
          </div>
        </SurfaceBlock>
        <SurfaceBlock title="Workflow posture">
          <div className="space-y-1 text-xs text-muted-foreground">
            <div>Recommendation memory survives snapshot refresh.</div>
            <div>Validation windows stay attached to the applied recommendation.</div>
            <div>Rollback guidance remains manual until verified write-back exists.</div>
          </div>
        </SurfaceBlock>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-3 rounded-lg border bg-muted/10 p-4">
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Validation due</p>
            <h3 className="text-base font-semibold">Recommendations waiting for operator outcome checks</h3>
          </div>
          {validationDue.length > 0 ? (
            <div className="space-y-3">
              {validationDue.map((recommendation) => {
                const actionCard = recommendationActionCard(advisor, recommendation);
                return (
                  <div key={`validation-due-${recommendation.id}`} className="rounded-lg border bg-background/80 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-slate-900">{recommendation.title}</div>
                        <p className="mt-1 text-sm text-slate-800">{actionCard.primaryAction}</p>
                      </div>
                      <Badge variant="outline">Due {formatCompactDateTime(recommendation.outcomeCheckAt)}</Badge>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Validation window:{" "}
                      {typeof recommendation.outcomeCheckWindowDays === "number"
                        ? `${recommendation.outcomeCheckWindowDays}d`
                        : "Not set"}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed bg-background/60 p-4 text-sm text-muted-foreground">
              No recommendation is currently due for manual outcome validation.
            </div>
          )}
        </div>
        <div className="space-y-3 rounded-lg border bg-muted/10 p-4">
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Recent outcomes</p>
            <h3 className="text-base font-semibold">Most recent logged operator validations</h3>
          </div>
          {recentOutcomes.length > 0 ? (
            <div className="space-y-3">
              {recentOutcomes.map((recommendation) => (
                <div key={`recent-outcome-${recommendation.id}`} className="rounded-lg border bg-background/80 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-slate-900">{recommendation.title}</div>
                      <p className="mt-1 text-sm text-slate-800">
                        {recommendationActionCard(advisor, recommendation).primaryAction}
                      </p>
                    </div>
                    <Badge variant="outline">{outcomeLabel(recommendation.outcomeVerdict)}</Badge>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {formatOutcomeSummary(recommendation)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed bg-background/60 p-4 text-sm text-muted-foreground">
              No operator outcomes have been logged yet for this snapshot.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function RecommendationCard({
  advisor,
  recommendation,
  onFocusEntity,
  businessId,
  accountId,
  onRefreshAdvisor,
}: {
  advisor: GoogleAdvisorResponse;
  recommendation: GoogleAdvisorRecommendation;
  onFocusEntity?: (recommendation: GoogleAdvisorRecommendation) => void;
  businessId?: string;
  accountId?: string | null;
  onRefreshAdvisor?: () => void;
}) {
  const lane = deriveQueueLane(recommendation);
  const labelMap = buildWindowLabelMap(advisor);
  const windowsUsed = recommendation.decision?.windowsUsed;
  const validationPlan = recommendation.decision?.validationPlan ?? recommendation.validationChecklist ?? [];
  const rollbackPlan = recommendation.decision?.rollbackPlan ?? [];
  const evidencePoints = recommendation.decision?.evidencePoints ?? recommendation.evidence ?? [];
  const executionSurface = advisor.metadata?.executionSurface;
  const narrative = fallbackNarrative(recommendation);
  const actionContractSource = advisor.metadata?.actionContract?.source ?? "compatibility_derived";
  const actionCard =
    recommendation.operatorActionCard ?? buildGoogleAdsOperatorActionCard(recommendation, actionContractSource);
  const compatibilityDerived = actionCard.contractSource === "compatibility_derived";
  const aiStructuredAssist = actionCard.assistMode === "ai_structured_assist";
  const exactChanges = actionCard.exactChanges.filter(
    (block) => block.items.length > 0 || Boolean(block.emptyLabel)
  );
  const effectTone = actionCard.expectedEffect.estimationMode === "blocked" ? "danger" : "default";
  const activeAccountId = accountId ?? "all";
  const canPersistOperatorState = Boolean(businessId);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [outcomeVerdict, setOutcomeVerdict] = useState<
    Exclude<GoogleAdvisorRecommendation["outcomeVerdict"], null | undefined | "unknown">
  >(
    recommendation.outcomeVerdict === "neutral" || recommendation.outcomeVerdict === "degraded"
      ? recommendation.outcomeVerdict
      : "improved"
  );
  const [outcomeConfidence, setOutcomeConfidence] = useState<
    Exclude<GoogleAdvisorRecommendation["outcomeConfidence"], null | undefined>
  >(recommendation.outcomeConfidence ?? "medium");

  async function postOperatorAction(
    label: string,
    body: Record<string, unknown>,
    successMessage: string
  ) {
    if (!businessId) return;
    setActionPending(label);
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await fetch("/api/google-ads/advisor-memory", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          businessId,
          accountId: activeAccountId,
          recommendationFingerprint: recommendation.recommendationFingerprint,
          ...body,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string" ? payload.error : `${label} failed.`
        );
      }
      setActionMessage(successMessage);
      onRefreshAdvisor?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `${label} failed.`);
    } finally {
      setActionPending(null);
    }
  }

  return (
    <article className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Badge className={cn("border", laneTone(lane))} variant="outline">
            {laneLabel(lane)}
          </Badge>
          <Badge variant="outline">{familyLabel(recommendation.decisionFamily)}</Badge>
          <Badge variant="outline">{labelize(recommendation.strategyLayer)}</Badge>
          {executionSurface?.writebackEnabled ? null : <Badge variant="outline">Manual plan only</Badge>}
          {aiStructuredAssist ? <Badge variant="outline">AI-structured assist</Badge> : null}
          {compatibilityDerived ? <Badge variant="outline">Legacy snapshot compatibility</Badge> : null}
        </div>
        <div className="grid gap-1 text-right text-xs">
          <div>
            <span className="text-muted-foreground">Confidence:</span>{" "}
            <span className="font-medium">
              {confidencePct(recommendation.decision?.confidence) ?? labelize(recommendation.confidence)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Risk:</span>{" "}
            <span className={cn("font-medium", riskTone(recommendation.decision?.riskLevel))}>
              {labelize(recommendation.decision?.riskLevel ?? "unknown")}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Blast radius:</span>{" "}
            <span className={cn("font-medium", blastRadiusTone(recommendation.decision?.blastRadius))}>
              {labelize(recommendation.decision?.blastRadius ?? "unknown")}
            </span>
          </div>
        </div>
      </div>

      <div
        className={cn(
          "rounded-xl border p-4",
          actionCard.blockedBecause.length > 0
            ? "border-rose-200 bg-rose-50/40"
            : "border-emerald-200 bg-emerald-50/40"
        )}
      >
        <div
          className={cn(
            "text-[10px] uppercase tracking-wide",
            actionCard.blockedBecause.length > 0 ? "text-rose-700" : "text-emerald-700"
          )}
        >
          Primary action
        </div>
        <h3 className="mt-2 text-lg font-semibold leading-tight text-slate-900">
          {actionCard.primaryAction}
        </h3>
        <p className="mt-2 text-xs text-muted-foreground">
          Recommendation label: {recommendation.title}
          {" · "}
          {recommendation.level === "account"
            ? "Account-level decision"
            : recommendation.entityName ?? labelize(recommendation.level)}
        </p>
        {aiStructuredAssist ? (
          <p className="mt-2 text-xs text-muted-foreground">
            This structured card was synthesized from existing recommendation evidence at snapshot time. Apply the exact
            items manually in Google Ads.
          </p>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <SurfaceBlock title="Scope">
          <p>{actionCard.scope.label}</p>
        </SurfaceBlock>
        <SurfaceBlock title="Expected effect" tone={effectTone}>
          <p>{actionCard.expectedEffect.summary}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {actionCard.expectedEffect.estimateLabel ?? "Not confidently estimable"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{actionCard.expectedEffect.note}</p>
        </SurfaceBlock>
        <SurfaceBlock title="Why this now">
          <p>{actionCard.whyThisNow}</p>
        </SurfaceBlock>
      </div>

      <div className="space-y-3">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Exact changes</div>
        <div className="grid gap-3 md:grid-cols-2">
          {exactChanges.map((block) => (
            <DetailList
              key={block.label}
              title={block.label}
              items={block.items}
              emptyLabel={block.emptyLabel ?? "No items attached."}
              tone={block.tone}
            />
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <DetailList
          title="Evidence"
          items={evidencePoints.map((item) => `${item.label}: ${item.value}`)}
          emptyLabel="No structured evidence is attached."
        />
        <DetailList
          title="Validation"
          items={actionCard.validation.length > 0 ? actionCard.validation : validationPlan}
          emptyLabel="No explicit validation plan is available."
        />
        <DetailList
          title="Rollback"
          items={actionCard.rollback.length > 0 ? actionCard.rollback : rollbackPlan}
          emptyLabel="No verified write-back rollback exists in V1. Reverse manually in Google Ads if needed."
        />
        {actionCard.blockedBecause.length > 0 ? (
          <DetailList
            title="Blocked because"
            items={actionCard.blockedBecause}
            emptyLabel="No explicit blocker is attached."
            tone="danger"
          />
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SurfaceBlock title="Lifecycle">
          <div className="space-y-1">
            <div>Status: {memoryStatusLabel(recommendation.currentStatus)}</div>
            <div>User action: {labelize(recommendation.userAction ?? "none")}</div>
            <div>Seen count: {recommendation.seenCount ?? 0}</div>
          </div>
        </SurfaceBlock>
        <SurfaceBlock title="Execution state">
          <div className="space-y-1">
            <div>{labelize(recommendation.executionStatus ?? "not_started")}</div>
            <div className="text-xs text-muted-foreground">
              {recommendation.rollbackAvailable
                ? "Rollback preview is available."
                : "No verified write-back rollback is available in V1."}
            </div>
          </div>
        </SurfaceBlock>
        <SurfaceBlock title="Outcome">
          <div className="space-y-1">
            <div>{outcomeLabel(recommendation.outcomeVerdict)}</div>
            <div className="text-xs text-muted-foreground">
              Validation window:{" "}
              {typeof recommendation.outcomeCheckWindowDays === "number"
                ? `${recommendation.outcomeCheckWindowDays}d`
                : "Not set"}
            </div>
            <div className="text-xs text-muted-foreground">
              Check due: {recommendation.outcomeCheckAt ?? "Not scheduled"}
            </div>
          </div>
        </SurfaceBlock>
        <SurfaceBlock title="Manual workflow">
          <div className="space-y-1 text-xs text-muted-foreground">
            <div>Operator actions persist through advisor-memory.</div>
            <div>Snapshot refresh keeps the structured recommendation but overlays live lifecycle state.</div>
          </div>
        </SurfaceBlock>
      </div>

      {canPersistOperatorState ? (
        <div className="rounded-lg border bg-muted/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Operator actions</div>
              <p className="mt-1 text-sm text-slate-800">
                Manual-plan-first workflow. These controls record operator intent and validation only.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={actionPending !== null}
                onClick={() =>
                  postOperatorAction(
                    "mark applied",
                    { action: "applied" },
                    "Marked as manually applied."
                  )
                }
              >
                {actionPending === "mark applied" ? "Saving..." : "Mark applied"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={actionPending !== null}
                onClick={() =>
                  postOperatorAction(
                    recommendation.currentStatus === "suppressed" ? "unsuppress" : "suppress",
                    recommendation.currentStatus === "suppressed"
                      ? { action: "unsuppress" }
                      : { action: "dismissed" },
                    recommendation.currentStatus === "suppressed"
                      ? "Returned to the active queue."
                      : "Suppressed for operator follow-up."
                  )
                }
              >
                {actionPending === "suppress" || actionPending === "unsuppress"
                  ? "Saving..."
                  : recommendation.currentStatus === "suppressed"
                    ? "Unsuppress"
                    : "Suppress 7d"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={actionPending !== null}
                onClick={() => {
                  const completedStepIds =
                    recommendation.coreStepIds && recommendation.coreStepIds.length > 0
                      ? recommendation.coreStepIds
                      : ["manual_apply"];
                  void postOperatorAction(
                    "mark completion",
                    {
                      executionAction: "mark_completion",
                      completionMode: "full",
                      completedStepCount: completedStepIds.length,
                      totalStepCount: completedStepIds.length,
                      completedStepIds,
                      skippedStepIds: [],
                      coreStepIds: completedStepIds,
                    },
                    "Manual completion recorded."
                  );
                }}
              >
                {actionPending === "mark completion" ? "Saving..." : "Mark complete"}
              </Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Outcome</span>
              <select
                className="rounded-md border bg-background px-2 py-1 text-sm"
                value={outcomeVerdict}
                onChange={(event) =>
                  setOutcomeVerdict(
                    event.target.value as Exclude<
                      GoogleAdvisorRecommendation["outcomeVerdict"],
                      null | undefined | "unknown"
                    >
                  )
                }
              >
                <option value="improved">Improved</option>
                <option value="neutral">Neutral</option>
                <option value="degraded">Degraded</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Confidence</span>
              <select
                className="rounded-md border bg-background px-2 py-1 text-sm"
                value={outcomeConfidence}
                onChange={(event) =>
                  setOutcomeConfidence(
                    event.target.value as Exclude<
                      GoogleAdvisorRecommendation["outcomeConfidence"],
                      null | undefined
                    >
                  )
                }
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <Button
              variant="secondary"
              size="sm"
              disabled={actionPending !== null}
              onClick={() =>
                postOperatorAction(
                  "record outcome",
                  {
                    executionAction: "record_outcome",
                    outcomeVerdict: outcomeVerdict,
                    outcomeMetric: "manual_validation",
                    outcomeConfidence: outcomeConfidence,
                    outcomeCheckWindowDays: recommendation.outcomeCheckWindowDays ?? 7,
                    outcomeSummary: `Operator recorded a ${outcomeVerdict} manual validation outcome.`,
                  },
                  "Manual outcome recorded."
                )
              }
            >
              {actionPending === "record outcome" ? "Saving..." : "Log outcome"}
            </Button>
          </div>
          {actionError ? <p className="mt-2 text-sm text-rose-700">{actionError}</p> : null}
          {actionMessage ? <p className="mt-2 text-sm text-emerald-700">{actionMessage}</p> : null}
        </div>
      ) : null}

      <details className="rounded-lg border bg-muted/10 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-800">
          Narrative context and legacy details
        </summary>
        <div className="mt-3 space-y-3">
          {compatibilityDerived ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm text-slate-800">
              This snapshot was normalized from legacy fields. Refresh Decision Snapshot to replace the
              compatibility-derived card with a native action-contract payload.
            </div>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <SurfaceBlock title="What happened">
              <p>{narrative.whatHappened}</p>
            </SurfaceBlock>
            <SurfaceBlock title="Why it happened">
              <p>{narrative.whyItHappened}</p>
            </SurfaceBlock>
            <SurfaceBlock title="What to do">
              <p>{narrative.whatToDo}</p>
            </SurfaceBlock>
            <SurfaceBlock title="Risk">
              <p>{narrative.risk}</p>
            </SurfaceBlock>
          </div>

          {actionCard.coachNote ? (
            <SurfaceBlock title="AI note">
              <p>{actionCard.coachNote}</p>
            </SurfaceBlock>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <SurfaceBlock title="Windows used">
              <div className="space-y-1">
                <div>Health: {renderWindowLabel(windowsUsed?.healthWindow, labelMap) ?? "Unavailable"}</div>
                <div>Primary: {renderWindowLabel(windowsUsed?.primaryWindow, labelMap) ?? "Unavailable"}</div>
                <div>Query: {renderWindowLabel(windowsUsed?.queryWindow, labelMap) ?? "Not used"}</div>
                <div>Baseline: {renderWindowLabel(windowsUsed?.baselineWindow, labelMap) ?? "Unavailable"}</div>
                <div className="text-xs text-muted-foreground">
                  Maturity cutoff: {typeof windowsUsed?.maturityCutoffDays === "number" ? `${windowsUsed.maturityCutoffDays}d` : "Unavailable"}
                </div>
              </div>
            </SurfaceBlock>
            <SurfaceBlock title="Evidence summary">
              <p>{recommendation.decision?.evidenceSummary ?? recommendation.summary}</p>
            </SurfaceBlock>
            <SurfaceBlock title="Operator mode">
              <p>{executionSurface?.summary ?? "Operator-first manual plan surface."}</p>
            </SurfaceBlock>
            <SurfaceBlock title="Write-back">
              <p>{executionSurface?.writebackEnabled ? "Enabled" : "Disabled. Manual plan only."}</p>
            </SurfaceBlock>
          </div>
        </div>
      </details>

      {recommendation.deepLinkUrl || (onFocusEntity && recommendation.entityId) ? (
        <div className="flex flex-wrap justify-end gap-2">
          {recommendation.deepLinkUrl ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(recommendation.deepLinkUrl ?? "", "_blank", "noopener,noreferrer")}
            >
              Open in Google Ads
            </Button>
          ) : null}
          {onFocusEntity && recommendation.entityId ? (
            <Button variant="outline" size="sm" onClick={() => onFocusEntity(recommendation)}>
              Jump to entity
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function QueueSection({
  advisor,
  lane,
  recommendations,
  onFocusEntity,
  businessId,
  accountId,
  onRefreshAdvisor,
}: {
  advisor: GoogleAdvisorResponse;
  lane: QueueLane;
  recommendations: GoogleAdvisorRecommendation[];
  onFocusEntity?: (recommendation: GoogleAdvisorRecommendation) => void;
  businessId?: string;
  accountId?: string | null;
  onRefreshAdvisor?: () => void;
}) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {laneLabel(lane)}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{laneDescription(lane)}</p>
        </div>
        <Badge className={cn("border", laneTone(lane))} variant="outline">
          {recommendations.length}
        </Badge>
      </div>
      {recommendations.length > 0 ? (
        <div className="space-y-4">
          {recommendations.map((recommendation) => (
            <RecommendationCard
              key={recommendation.id}
              advisor={advisor}
              recommendation={recommendation}
              onFocusEntity={onFocusEntity}
              businessId={businessId}
              accountId={accountId}
              onRefreshAdvisor={onRefreshAdvisor}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed bg-muted/10 p-4 text-sm text-muted-foreground">
          No decisions in this lane right now.
        </div>
      )}
    </section>
  );
}

function ActionPackSection({
  advisor,
  recommendationsById,
}: {
  advisor: GoogleAdvisorResponse;
  recommendationsById: Map<string, GoogleAdvisorRecommendation>;
}) {
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Manual Action Packs</p>
        <h2 className="text-lg font-semibold">Bundled operator moves</h2>
        <p className="text-sm text-muted-foreground">
          These packs group related steps for human approval. They do not imply autonomous execution.
        </p>
      </div>
      {advisor.clusters.length > 0 ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {advisor.clusters.map((cluster) => (
            <article key={cluster.clusterId} className="space-y-3 rounded-xl border bg-muted/10 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex flex-wrap gap-2">
                    <Badge className={cn("border", clusterTone(cluster.clusterBucket))} variant="outline">
                      {clusterBucketLabel(cluster.clusterBucket)}
                    </Badge>
                    <Badge variant="outline">{clusterReadinessLabel(cluster.clusterReadiness)}</Badge>
                    <Badge variant="outline">{clusterStatusLabel(cluster.clusterStatus)}</Badge>
                  </div>
                  <h3 className="text-base font-semibold leading-tight">{cluster.clusterObjective}</h3>
                  <p className="text-xs text-muted-foreground">
                    {cluster.steps.length} steps · {cluster.memberRecommendationIds.length} linked recommendations
                  </p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <div>Approval: required</div>
                  <div>Cooldown: {clusterHoldLabel(cluster)}</div>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <DetailList
                  title="Step order"
                  items={cluster.steps.map((step) => step.title)}
                  emptyLabel="No step sequence was attached."
                />
                <DetailList
                  title="Exact member changes"
                  items={cluster.memberRecommendationIds
                    .map((recommendationId) => recommendationsById.get(recommendationId))
                    .filter((recommendation): recommendation is GoogleAdvisorRecommendation => Boolean(recommendation))
                    .map((recommendation) => recommendationActionCard(advisor, recommendation).primaryAction)}
                  emptyLabel="No linked recommendation changes were attached."
                  tone="primary"
                />
                <DetailList
                  title="Dependencies and unlocks"
                  items={[
                    ...cluster.dependsOnClusterIds.map((clusterId) => `Depends on cluster ${clusterId}`),
                    ...cluster.unlocksClusterIds.map((clusterId) => `Unlocks cluster ${clusterId}`),
                    ...cluster.conflictsWithClusterIds.map((clusterId) => `Conflicts with cluster ${clusterId}`),
                  ]}
                  emptyLabel="No cluster dependency or unlock relationships are attached."
                />
                <DetailList
                  title="Validation"
                  items={cluster.validationPlan}
                  emptyLabel="No explicit validation plan is attached."
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <SurfaceBlock title="Execution state">
                  <div className="space-y-1">
                    <div>{labelize(cluster.executionSummary.clusterExecutionStatus)}</div>
                    <div>Current step: {cluster.executionSummary.currentStepId ?? "None"}</div>
                    <div>Waiting on: {cluster.executionSummary.waitingChildStepId ?? "None"}</div>
                    <div>Next eligible: {cluster.executionSummary.nextEligibleAt ? formatCompactDateTime(cluster.executionSummary.nextEligibleAt) : "Now"}</div>
                  </div>
                </SurfaceBlock>
                <SurfaceBlock title="Cluster outcome">
                  <div className="space-y-1">
                    <div>{labelize(cluster.outcomeState.verdict)}</div>
                    <div className="text-xs text-muted-foreground">
                      Reason: {cluster.outcomeState.reason ?? cluster.clusterMoveValidityReason}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Last validation: {cluster.outcomeState.lastValidationCheckAt ? formatCompactDateTime(cluster.outcomeState.lastValidationCheckAt) : "Not checked"}
                    </div>
                  </div>
                </SurfaceBlock>
              </div>
              {cluster.executionSummary.manualRecoveryInstructions?.length ? (
                <DetailList
                  title="Manual recovery"
                  items={cluster.executionSummary.manualRecoveryInstructions}
                  emptyLabel="No manual recovery instructions are attached."
                  tone="muted"
                />
              ) : null}
              <div className="rounded-lg border bg-muted/15 p-3 text-sm text-slate-800">
                Prepare this pack for manual approval only. Write-back remains disabled by default, and any future automation still depends on allowlists, kill switch posture, and explicit verification.
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed bg-muted/10 p-4 text-sm text-muted-foreground">
          No bundled action packs are attached to this snapshot.
        </div>
      )}
    </section>
  );
}

export function GoogleAdvisorPanel({
  advisor,
  onFocusEntity,
  businessId,
  accountId,
  onRefreshAdvisor,
}: {
  advisor: GoogleAdvisorResponse;
  onFocusEntity?: (recommendation: GoogleAdvisorRecommendation) => void;
  businessId?: string;
  accountId?: string | null;
  onRefreshAdvisor?: () => void;
}) {
  const selectedRangeContext =
    advisor.metadata?.selectedRangeContext &&
    advisor.metadata.selectedRangeContext.eligible &&
    advisor.metadata.selectedRangeContext.state !== "hidden"
      ? advisor.metadata.selectedRangeContext
      : null;

  const queueByLane: Record<QueueLane, GoogleAdvisorRecommendation[]> = {
    review: [],
    test: [],
    watch: [],
    suppressed: [],
  };
  const compatibilityDerived = (advisor.metadata?.actionContract?.source ?? "compatibility_derived") === "compatibility_derived";
  const aggregateIntelligence = advisor.metadata?.aggregateIntelligence ?? null;
  const recommendationsById = new Map(
    advisor.recommendations.map((recommendation) => [recommendation.id, recommendation] as const)
  );
  for (const recommendation of advisor.recommendations) {
    queueByLane[deriveQueueLane(recommendation)].push(recommendation);
  }
  const validationDueCount = advisor.recommendations.filter((recommendation) => isValidationDue(recommendation)).length;

  return (
    <div className="space-y-4">
      <section className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <div className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Account decisions</p>
              <h2 className="text-lg font-semibold">{advisor.summary.headline}</h2>
              <p className="text-sm text-muted-foreground">{advisor.summary.operatorNote}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{advisor.summary.accountOperatingMode}</Badge>
              {advisor.metadata?.executionSurface?.writebackEnabled ? null : (
                <Badge variant="outline">Write-back disabled</Badge>
              )}
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border bg-muted/15 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Top constraint</div>
              <div className="mt-1 text-sm">{advisor.summary.topConstraint}</div>
            </div>
            <div className="rounded-lg border bg-muted/15 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Top growth lever</div>
              <div className="mt-1 text-sm">{advisor.summary.topGrowthLever}</div>
            </div>
            <div className="rounded-lg border bg-muted/15 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Recommended focus</div>
              <div className="mt-1 text-sm">{advisor.summary.recommendedFocusToday}</div>
            </div>
            <div className="rounded-lg border bg-muted/15 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Queue load</div>
              <div className="mt-1 text-sm">
                {advisor.recommendations.length} decisions · {queueByLane.review.length} review · {validationDueCount} validation due
              </div>
            </div>
          </div>
          <div className="mt-3 rounded-lg border bg-muted/15 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Watchouts</div>
            <p className="mt-1 text-sm text-slate-800">
              {advisor.summary.watchouts.length > 0
                ? advisor.summary.watchouts.join(" · ")
                : "No active watchouts recorded."}
            </p>
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Decision Snapshot</p>
            <h2 className="text-lg font-semibold">Multi-window analysis</h2>
            <p className="text-sm text-muted-foreground">
              The selected range is context only. Decision priority comes from the anchored decision snapshot.
            </p>
          </div>
          <div className="mt-4 grid gap-3">
            <div className="rounded-lg border bg-muted/15 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Primary decision window</div>
              <div className="mt-1 text-sm">
                {advisor.metadata?.analysisWindows.operationalWindow.label ?? "Unavailable"}
              </div>
            </div>
            <div className="rounded-lg border bg-muted/15 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Query governance window</div>
              <div className="mt-1 text-sm">
                {advisor.metadata?.analysisWindows.queryGovernanceWindow.label ?? "Unavailable"}
              </div>
            </div>
            <div className="rounded-lg border bg-muted/15 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Baseline window</div>
              <div className="mt-1 text-sm">
                {advisor.metadata?.analysisWindows.baselineWindow.label ?? "Unavailable"}
              </div>
            </div>
            {selectedRangeContext ? (
              <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-3">
                <div className="text-[10px] uppercase tracking-wide text-sky-700">Selected-range context</div>
                <p className="mt-1 text-sm text-slate-800">{selectedRangeContext.summary}</p>
                <p className="mt-1 text-xs text-sky-800/80">
                  Selected range stays contextual and does not replace the decision snapshot.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed bg-muted/10 p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Selected-range context</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  No contextual selected-range note is available for this snapshot.
                </p>
              </div>
            )}
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
              <div className="text-[10px] uppercase tracking-wide text-amber-700">Operator-first mode</div>
              <p className="mt-1 text-sm text-slate-800">
                {advisor.metadata?.executionSurface?.summary ?? "Adsecute V1 remains operator-first."}
              </p>
            </div>
            <div className="rounded-lg border bg-muted/15 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Aggregate support</div>
              <p className="mt-1 text-sm text-slate-800">
                {aggregateIntelligence?.note ?? "No aggregate-intelligence note is attached to this snapshot."}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Weekly query rows: {aggregateIntelligence?.queryWeeklyRows ?? 0} · Daily cluster rows:{" "}
                {aggregateIntelligence?.clusterDailyRows ?? 0}
              </p>
            </div>
          </div>
        </div>
      </section>

      <WorkflowSection advisor={advisor} />

      <ActionPackSection advisor={advisor} recommendationsById={recommendationsById} />

      <section className="space-y-4 rounded-xl border bg-card p-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Opportunity Queue</p>
          <h2 className="text-lg font-semibold">Decision lanes</h2>
          <p className="text-sm text-muted-foreground">
            Recommendations are grouped by operator lane, not by the selected date range.
          </p>
        </div>
        {compatibilityDerived ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm text-slate-800">
            This payload is in legacy snapshot compatibility mode. The action-first cards are derived from
            older recommendation fields, so refresh the decision snapshot to load the native action contract.
          </div>
        ) : null}
        <div className="space-y-4">
          <QueueSection
            advisor={advisor}
            lane="review"
            recommendations={queueByLane.review}
            onFocusEntity={onFocusEntity}
            businessId={businessId}
            accountId={accountId}
            onRefreshAdvisor={onRefreshAdvisor}
          />
          <QueueSection
            advisor={advisor}
            lane="test"
            recommendations={queueByLane.test}
            onFocusEntity={onFocusEntity}
            businessId={businessId}
            accountId={accountId}
            onRefreshAdvisor={onRefreshAdvisor}
          />
          <QueueSection
            advisor={advisor}
            lane="watch"
            recommendations={queueByLane.watch}
            onFocusEntity={onFocusEntity}
            businessId={businessId}
            accountId={accountId}
            onRefreshAdvisor={onRefreshAdvisor}
          />
          <QueueSection
            advisor={advisor}
            lane="suppressed"
            recommendations={queueByLane.suppressed}
            onFocusEntity={onFocusEntity}
            businessId={businessId}
            accountId={accountId}
            onRefreshAdvisor={onRefreshAdvisor}
          />
        </div>
      </section>
    </div>
  );
}
