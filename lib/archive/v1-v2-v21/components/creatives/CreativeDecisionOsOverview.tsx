"use client";

import { DecisionAuthorityPanel } from "@/components/decision-trust/DecisionAuthorityPanel";
import { DecisionPolicyExplanationPanel } from "@/components/decision-trust/DecisionPolicyExplanationPanel";
import {
  buildCreativeOperatorItem,
  buildCreativePreviewTruthSummary,
  buildCreativeTaxonomyCounts,
  creativeBenchmarkReliabilityLabel,
  creativeOperatorSegmentLabel,
  creativeOperatorSubToneLabel,
  resolveCreativeOperatorDecision,
  type CreativeQuickFilter,
  type CreativeQuickFilterKey,
} from "@/lib/creative-operator-surface";
import { cn } from "@/lib/utils";
import type {
  CreativeDecisionOsFamily,
  CreativeDecisionOsPattern,
  CreativeDecisionOsV1Response,
} from "@/lib/creative-decision-os";

function formatLifecycleLabel(value: string) {
  const labels: Record<string, string> = {
    incubating: "Test More",
    validating: "Test More",
    scale_ready: "Scale",
    scale_review: "Scale",
    stable_winner: "Protect",
    fatigued_winner: "Refresh",
    comeback_candidate: "Refresh",
    promote_to_scaling: "Scale",
    keep_in_test: "Test More",
    refresh_replace: "Refresh",
    block_deploy: "Diagnose",
    hold_no_touch: "Protect",
    protected_winner: "Protect",
    hold_monitor: "Test More",
    false_winner_low_evidence: "Diagnose",
    promising_under_sampled: "Test More",
    kill_candidate: "Cut",
    needs_new_variant: "Refresh",
    creative_learning_incomplete: "Diagnose",
    spend_waste: "Cut",
    investigate: "Diagnose",
    contextual_only: "Diagnose",
    blocked: "Diagnose",
  };
  if (labels[value]) return labels[value];
  return value.replaceAll("_", " ");
}

function pushReadinessLabel(value: string) {
  return value.replaceAll("_", " ");
}

function familyTone(family: CreativeDecisionOsFamily) {
  if (family.primaryAction === "promote_to_scaling") {
    return "border-emerald-200 bg-emerald-50";
  }
  if (family.primaryAction === "refresh_replace") {
    return "border-orange-200 bg-orange-50";
  }
  if (family.primaryAction === "block_deploy") {
    return "border-rose-200 bg-rose-50";
  }
  return "border-slate-200 bg-white";
}

function patternTone(pattern: CreativeDecisionOsPattern) {
  if (pattern.lifecycleState === "stable_winner" || pattern.lifecycleState === "scale_ready") {
    return "border-emerald-200 bg-emerald-50";
  }
  if (pattern.lifecycleState === "fatigued_winner") {
    return "border-orange-200 bg-orange-50";
  }
  if (pattern.lifecycleState === "blocked") {
    return "border-rose-200 bg-rose-50";
  }
  return "border-slate-200 bg-white";
}

function supplyTone(kind: CreativeDecisionOsV1Response["supplyPlan"][number]["kind"]) {
  if (kind === "refresh_existing_winner") return "border-orange-200 bg-orange-50";
  if (kind === "expand_angle_family") return "border-emerald-200 bg-emerald-50";
  if (kind === "revive_comeback") return "border-violet-200 bg-violet-50";
  return "border-sky-200 bg-sky-50";
}

function opportunityTone(verdict: string, kind: string) {
  if (verdict === "queue_ready") return "border-emerald-200 bg-emerald-50";
  if (verdict === "protected" || kind === "protected_winner") {
    return "border-blue-200 bg-blue-50";
  }
  if (verdict === "blocked") return "border-rose-200 bg-rose-50";
  return "border-slate-200 bg-slate-50";
}

function formatShareOfSpend(value: number) {
  return `${Math.round(value * 100)}%`;
}

function HistoricalBucketList({
  title,
  buckets,
  emptyCopy,
}: {
  title: string;
  buckets: CreativeDecisionOsV1Response["historicalAnalysis"]["winningFormats"];
  emptyCopy: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
        <span className="text-[11px] text-slate-500">selected period</span>
      </div>
      <div className="space-y-2">
        {buckets.map((bucket) => (
          <div
            key={`${title}-${bucket.label}`}
            className="rounded-xl border border-slate-200 bg-slate-50/70 p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-950">{bucket.label}</p>
                <p className="mt-1 text-xs text-slate-600">{bucket.summary}</p>
              </div>
              <div className="text-right text-xs text-slate-700">
                <p>{formatShareOfSpend(bucket.shareOfSpend)} spend share</p>
                <p>{bucket.creativeCount} creatives</p>
              </div>
            </div>
          </div>
        ))}
        {buckets.length === 0 ? (
          <p className="text-sm text-slate-500">{emptyCopy}</p>
        ) : null}
      </div>
    </div>
  );
}

export function CreativeDecisionOsOverview({
  decisionOs,
  quickFilters,
  isLoading,
  activeFamilyId,
  activeQuickFilterKey,
  onSelectFamily,
  onSelectQuickFilter,
  onClearFilters,
  showHeader = true,
  className,
}: {
  decisionOs: CreativeDecisionOsV1Response | null;
  quickFilters: CreativeQuickFilter[];
  isLoading: boolean;
  activeFamilyId: string | null;
  activeQuickFilterKey: CreativeQuickFilterKey | null;
  onSelectFamily: (familyId: string | null) => void;
  onSelectQuickFilter: (key: CreativeQuickFilterKey) => void;
  onClearFilters?: () => void;
  showHeader?: boolean;
  className?: string;
}) {
  if (isLoading) {
    return (
      <section
        className={cn("rounded-2xl border border-slate-200 bg-white p-5", className)}
        data-testid="creative-decision-os-overview"
      >
        <div className="h-5 w-40 animate-pulse rounded bg-slate-200" />
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-2xl border border-slate-100 bg-slate-50" />
          ))}
        </div>
      </section>
    );
  }

  if (!decisionOs) return null;

  const configuredSectionCount = Object.values(
    decisionOs.commercialTruthCoverage.configuredSections,
  ).filter(Boolean).length;
  const benchmarkScope = decisionOs.summary.benchmarkScope;
  const businessValidationMissing =
    decisionOs.commercialTruthCoverage.missingInputs.length > 0 ||
    decisionOs.authority?.truthState === "degraded_missing_truth";
  const readiness = decisionOs.summary.readiness ?? decisionOs.authority?.readiness ?? null;
  const previewTruthSummary = buildCreativePreviewTruthSummary(decisionOs);
  const taxonomyCounts = buildCreativeTaxonomyCounts(decisionOs, {
    quickFilters,
  });
  const policyCreatives = decisionOs.creatives
    .filter((creative) => creative.policy?.explanation)
    .slice(0, 4);
  const operatorPolicyCreatives = decisionOs.creatives
    .filter((creative) => creative.operatorPolicy)
    .slice(0, 6);
  const operatorPolicyCounts = decisionOs.creatives.reduce(
    (acc, creative) => {
      const state = creative.operatorPolicy?.state ?? "contextual_only";
      acc[state] = (acc[state] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <>
      <section
        className={cn(
          "space-y-4 rounded-2xl border border-slate-200 bg-[linear-gradient(180deg,#fcfdff_0%,#f8fbff_100%)] p-5 shadow-[0_10px_28px_rgba(15,23,42,0.05)]",
          className,
        )}
        data-testid="creative-decision-os-overview"
      >
      {showHeader ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Operator Console
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-950">
              Creative Operator Console
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              {decisionOs.summary.message}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
              <span
                className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700"
                data-testid="creative-decision-os-benchmark-scope"
              >
                Benchmark: {benchmarkScope.benchmarkScopeLabel}
              </span>
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700">
                Baseline: {creativeBenchmarkReliabilityLabel(benchmarkScope.benchmarkReliability)}
              </span>
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700">
                {businessValidationMissing ? "Business validation missing" : "Business validation configured"}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {businessValidationMissing
                ? "Relative winners stay visible in this scope, but missing business validation keeps scale-style moves in review only."
                : "Relative strength and business validation are both available in this scope."}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Decisions use live windows. Selected period affects analysis only.
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Decision as of {decisionOs.decisionAsOf} · primary window {decisionOs.decisionWindows.primary30d.startDate} to {decisionOs.decisionWindows.primary30d.endDate}
            </p>
          </div>
          <div className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600">
            Operating Mode:{" "}
            <span className="font-semibold text-slate-900">
              {decisionOs.summary.operatingMode ?? "Unavailable"}
            </span>
          </div>
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Primary Decision Counts
          </p>
          <p className="text-xs text-slate-500">
            Same resolver primary-decision mapping as the Creative filters.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          {taxonomyCounts.map((filter) => (
            <div
              key={filter.key}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
              data-testid={`creative-taxonomy-count-${filter.key}`}
            >
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{filter.label}</p>
              <p className="mt-1 text-2xl font-semibold text-slate-950">{filter.count}</p>
              {filter.key === "scale" ? (
                <p className="mt-1 text-[11px] text-slate-500">
                  {(filter.actionableCount ?? 0).toLocaleString()} direct ·{" "}
                  {((filter.reviewOnlyCount ?? 0) + (filter.mutedCount ?? 0)).toLocaleString()} review first
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Aggregate Health Counts
          </p>
          <p className="text-xs text-slate-500">
            Cross-segment aggregates, not primary segment labels.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-6">
          {[
            ["Total creatives", decisionOs.summary.totalCreatives],
            ["Action core aggregate", decisionOs.summary.surfaceSummary.actionCoreCount],
            ["Review-list aggregate", decisionOs.summary.surfaceSummary.watchlistCount],
            ["Archive aggregate", decisionOs.summary.surfaceSummary.archiveCount],
            ["Degraded aggregate", decisionOs.summary.surfaceSummary.degradedCount],
            ["Validation needed aggregate", decisionOs.summary.surfaceSummary.profitableTruthCappedCount ?? 0],
            ["Supply plan aggregate", decisionOs.summary.supplyPlanCount],
            ["Opportunity aggregate", decisionOs.summary.opportunitySummary.totalCount],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
              data-testid={`creative-aggregate-count-${String(label).toLowerCase().replaceAll(" ", "-")}`}
            >
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
              <p className="mt-1 text-2xl font-semibold text-slate-950">{value}</p>
            </div>
          ))}
        </div>
      </div>

      {operatorPolicyCreatives.length > 0 ? (
        <section
          className="rounded-2xl border border-slate-200 bg-white p-4"
          data-testid="creative-operator-policy-summary"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">Operator Instructions</h3>
              <p className="mt-1 text-xs text-slate-600">
                Deterministic Creative policy turns each segment into the next
                safe operator move before any queue handoff.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-[11px] text-slate-500">
              <span>Do now {operatorPolicyCounts.do_now ?? 0}</span>
              <span>Protect {operatorPolicyCounts.do_not_touch ?? 0}</span>
              <span>Review state {operatorPolicyCounts.watch ?? 0}</span>
              <span>Investigate {operatorPolicyCounts.investigate ?? 0}</span>
              <span>Ineligible/context {((operatorPolicyCounts.blocked ?? 0) + (operatorPolicyCounts.contextual_only ?? 0))}</span>
            </div>
          </div>
          <div className="mt-3 grid gap-3 xl:grid-cols-2">
            {operatorPolicyCreatives.map((creative) => {
              const operatorItem = buildCreativeOperatorItem(creative);
              const instruction = operatorItem.instruction;
              const decision = resolveCreativeOperatorDecision(creative);
              const subToneLabel = creativeOperatorSubToneLabel(decision.subTone);
              return (
                <div
                  key={`creative-operator-policy:${creative.creativeId}`}
                  className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{creative.name}</p>
                      <p className="mt-1 text-xs font-semibold text-slate-800">
                        {instruction?.primaryMove ?? creative.operatorPolicy.explanation}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        Why now: {instruction?.reasonSummary ?? creative.operatorPolicy.explanation}
                      </p>
                      {instruction ? (
                        <p className="mt-1 text-xs text-slate-600">
                          Target: {instruction.targetContext.label}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <span className="rounded-full bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                        {creativeOperatorSegmentLabel(creative)}
                      </span>
                      {subToneLabel ? (
                        <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                          {subToneLabel}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-600">
                    {(operatorItem.secondaryLabels ?? []).slice(0, 3).map((label) => (
                      <span key={`${creative.creativeId}:${label}`}>{label}</span>
                    ))}
                    {instruction ? <span>Urgency {instruction.urgency}</span> : null}
                    <span>{pushReadinessLabel(creative.operatorPolicy.pushReadiness)}</span>
                    <span>{creative.operatorPolicy.evidenceSource} evidence</span>
                    {instruction ? <span>{instruction.amountGuidance.label}</span> : null}
                  </div>
                  {instruction?.urgencyReason ? (
                    <p className="mt-2 text-xs text-slate-600">
                      Urgency basis: {instruction.urgencyReason}
                    </p>
                  ) : null}
                  {instruction?.nextObservation[0] ? (
                    <p className="mt-2 text-xs text-slate-600">
                      Next check: {instruction.nextObservation[0]}
                    </p>
                  ) : null}
                  {instruction?.invalidActions[0] ? (
                    <p className="mt-2 text-xs text-slate-600">
                      Do not: {instruction.invalidActions[0]}
                    </p>
                  ) : null}
                  {creative.operatorPolicy.missingEvidence.length > 0 ? (
                    <p className="mt-2 text-xs text-amber-700">
                      Missing: {creative.operatorPolicy.missingEvidence.slice(0, 3).join(", ")}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {readiness ? (
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Readiness</p>
            <p className="mt-1 text-2xl font-semibold text-slate-950">
              {readiness.daysReady}/{readiness.daysExpected}
            </p>
            <p className="mt-1 text-xs text-slate-500">days ready for operator review</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Suppressed actions</p>
            <p className="mt-1 text-sm font-semibold text-slate-950">
              {readiness.suppressedActionClasses.length > 0
                ? readiness.suppressedActionClasses.join(", ").replaceAll("_", " ")
                : "none"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {readiness.missingInputs.length > 0
                ? `Missing: ${readiness.missingInputs.join(", ")}`
                : "No missing inputs"}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Preview coverage</p>
            <p className="mt-1 text-sm font-semibold text-slate-950">
              {readiness.previewCoverage
                ? `ready ${readiness.previewCoverage.readyCount} · degraded ${readiness.previewCoverage.degradedCount} · missing ${readiness.previewCoverage.missingCount}`
                : "Unavailable"}
            </p>
          </div>
        </div>
      ) : null}

      {previewTruthSummary ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="creative-preview-truth-summary">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">Preview Truth</h3>
              <p className="mt-1 text-xs text-slate-600">{previewTruthSummary.headline}</p>
            </div>
            <span
              className={cn(
                "rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wide",
                previewTruthSummary.state === "ready"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : previewTruthSummary.state === "missing"
                    ? "border-rose-200 bg-rose-50 text-rose-800"
                    : "border-amber-200 bg-amber-50 text-amber-800",
              )}
            >
              {previewTruthSummary.state === "ready"
                ? "Ready"
                : previewTruthSummary.state === "missing"
                  ? "Missing"
                  : "Mixed / gated"}
            </span>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {[
              ["Ready", previewTruthSummary.readyCount],
              ["Degraded", previewTruthSummary.degradedCount],
              ["Missing", previewTruthSummary.missingCount],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
                <p className="mt-1 text-2xl font-semibold text-slate-950">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-600">{previewTruthSummary.summary}</p>
        </section>
      ) : null}

      <DecisionAuthorityPanel
        authority={decisionOs.authority}
        commercialSummary={decisionOs.commercialTruthCoverage.summary}
        title="Creative Authority"
      />

      {policyCreatives.length > 0 ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="creative-policy-review">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">Policy Review</h3>
              <p className="mt-1 text-xs text-slate-600">
                Shared ladder compares baseline and candidate actions before cutover.
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-3 xl:grid-cols-2">
            {policyCreatives.map((creative) => (
              <DecisionPolicyExplanationPanel
                key={`creative-policy:${creative.creativeId}`}
                explanation={creative.policy?.explanation}
                title={creative.name}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="creative-opportunity-board">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-950">Opportunity Board</h3>
            <p className="mt-1 text-xs text-slate-600">
              {decisionOs.summary.opportunitySummary.headline}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-slate-500">
            <span>Queue-ready {decisionOs.summary.opportunitySummary.queueEligibleCount}</span>
            <span>Protect {decisionOs.summary.opportunitySummary.protectedCount}</span>
            <span>Family scale {decisionOs.summary.opportunitySummary.familyScaleCount}</span>
          </div>
        </div>
        {decisionOs.opportunityBoard.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No opportunity-board item is available yet.</p>
        ) : (
          <div className="mt-3 grid gap-3 xl:grid-cols-2">
            {decisionOs.opportunityBoard.slice(0, 6).map((item) => {
              const verdict =
                item.eligibilityTrace?.verdict ??
                (item.queue.eligible
                  ? "queue_ready"
                  : item.kind === "protected_winner"
                    ? "protected"
                    : "board_only");
              return (
                <div
                  key={item.opportunityId}
                  className={cn(
                    "rounded-2xl border p-3",
                    opportunityTone(verdict, item.kind),
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{item.title}</p>
                      <p className="mt-1 text-xs text-slate-600">{item.summary}</p>
                    </div>
                    <span className="rounded-full bg-white/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                      {formatLifecycleLabel(item.kind)}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-600">
                    <span>{formatLifecycleLabel(item.recommendedAction)}</span>
                    <span>{Math.round(item.confidence * 100)}% confidence</span>
                    <span>{verdict.replaceAll("_", "-")}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.evidenceFloors.slice(0, 3).map((floor) => (
                      <span
                        key={`${item.opportunityId}:${floor.key}`}
                        className={cn(
                          "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                          floor.status === "met"
                            ? "bg-emerald-100 text-emerald-700"
                            : floor.status === "watch"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-slate-200 text-slate-700",
                        )}
                      >
                        {floor.label}: {floor.current}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {(decisionOs.summary.surfaceSummary.degradedCount > 0 ||
        decisionOs.commercialTruthCoverage.missingInputs.length > 0) ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Degraded commercial truth</p>
          <p className="mt-1">
            {decisionOs.summary.surfaceSummary.degradedCount} deterministic rows are
            trust-capped. Action-core queues exclude watchlist and archive lanes by
            default.
          </p>
          <p className="mt-2 text-xs text-amber-800">
            Configured sections: {configuredSectionCount}/4. Missing inputs:{" "}
            {decisionOs.commercialTruthCoverage.missingInputs.length > 0
              ? decisionOs.commercialTruthCoverage.missingInputs.join(", ")
              : "none"}
          </p>
        </div>
      ) : null}

      <div
        className="rounded-2xl border border-slate-200 bg-white p-4"
        data-testid="creative-lifecycle-board"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-950">Lifecycle Board</h3>
          <span className="text-[11px] text-slate-500">
            deterministic state only
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {decisionOs.lifecycleBoard.map((item) => (
            <div key={item.state} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                {formatLifecycleLabel(item.label)}
              </p>
              <p className="mt-1 text-xl font-semibold text-slate-950">{item.count}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <div
          className="rounded-2xl border border-slate-200 bg-white p-4"
          data-testid="creative-family-board"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-950">Concept Families</h3>
            <span className="text-[11px] text-slate-500">
              click to focus the table
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {decisionOs.families.slice(0, 6).map((family) => {
              const active = activeFamilyId === family.familyId;
              return (
                <button
                  key={family.familyId}
                  type="button"
                  onClick={() => onSelectFamily(active ? null : family.familyId)}
                  className={cn(
                    "rounded-2xl border p-3 text-left transition-colors",
                    familyTone(family),
                    active && "ring-2 ring-slate-300",
                  )}
                  data-testid={`creative-family-${family.familyId}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{family.familyLabel}</p>
                      <p className="mt-1 text-xs text-slate-600">
                        {family.metaFamilyLabel} • {family.familySource.replaceAll("_", " ")}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        Provenance {family.provenance.confidence} confidence • {family.provenance.overGroupingRisk} over-grouping risk
                      </p>
                    </div>
                    <span className="rounded-full border border-white/60 bg-white/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">
                      {family.lifecycleState.replaceAll("_", " ")}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                    <span>{family.creativeIds.length} creatives</span>
                    <span>${family.totalSpend.toFixed(0)} spend</span>
                    <span>{family.totalPurchases} purchases</span>
                  </div>
                  {family.provenance.evidence[0] ? (
                    <p className="mt-2 text-[11px] text-slate-600">{family.provenance.evidence[0]}</p>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div
          className="rounded-2xl border border-slate-200 bg-white p-4"
          data-testid="creative-pattern-board"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-950">Pattern Board</h3>
            <span className="text-[11px] text-slate-500">
              hook / angle / format
            </span>
          </div>
          <div className="space-y-2">
            {decisionOs.patterns.slice(0, 6).map((pattern) => (
              <div
                key={pattern.patternKey}
                className={cn("rounded-xl border p-3", patternTone(pattern))}
              >
                <p className="text-sm font-semibold text-slate-950">
                  {pattern.hook}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {pattern.angle} • {pattern.format}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-600">
                  <span>{pattern.creativeIds.length} creatives</span>
                  <span>${pattern.spend.toFixed(0)} spend</span>
                  <span>{pattern.roas.toFixed(2)}x ROAS</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.05fr_1fr]">
        <div
          className="rounded-2xl border border-slate-200 bg-white p-4"
          data-testid="creative-protected-winners"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-950">Protect</h3>
            <span className="text-[11px] text-slate-500">
              not queued for promotion
            </span>
          </div>
          <div className="space-y-2">
            {decisionOs.protectedWinners.slice(0, 6).map((winner) => (
              <div
                key={winner.creativeId}
                className="rounded-xl border border-emerald-200 bg-emerald-50 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-950">{winner.creativeName}</p>
                    <p className="mt-1 text-xs text-slate-600">{winner.familyLabel}</p>
                  </div>
                  <div className="text-right text-xs text-slate-700">
                    <p>{winner.roas.toFixed(2)}x ROAS</p>
                    <p>${winner.spend.toFixed(0)} spend</p>
                  </div>
                </div>
                {winner.reasons[0] ? (
                  <p className="mt-2 text-[11px] text-slate-600">{winner.reasons[0]}</p>
                ) : null}
              </div>
            ))}
            {decisionOs.protectedWinners.length === 0 ? (
              <p className="text-sm text-slate-500">No protected winners are active in the live decision window.</p>
            ) : null}
          </div>
        </div>

        <div
          className="rounded-2xl border border-slate-200 bg-white p-4"
          data-testid="creative-supply-plan"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-950">Supply Planning</h3>
            <span className="text-[11px] text-slate-500">
              deterministic backlog
            </span>
          </div>
          <div className="space-y-2">
            {decisionOs.supplyPlan.slice(0, 6).map((item) => (
              <div
                key={`${item.kind}-${item.familyId}`}
                className={cn("rounded-xl border p-3", supplyTone(item.kind))}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-950">{item.familyLabel}</p>
                    <p className="mt-1 text-xs text-slate-600">
                      {item.kind.replaceAll("_", " ")}
                    </p>
                  </div>
                  <span className="rounded-full border border-white/60 bg-white/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">
                    {item.priority}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-slate-700">{item.summary}</p>
                {item.reasons[0] ? (
                  <p className="mt-2 text-[11px] text-slate-600">{item.reasons[0]}</p>
                ) : null}
              </div>
            ))}
            {decisionOs.supplyPlan.length === 0 ? (
              <p className="text-sm text-slate-500">No supply-planning actions are currently queued.</p>
            ) : null}
          </div>
        </div>
      </div>
      </section>

      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_10px_28px_rgba(15,23,42,0.05)]"
        data-testid="creative-historical-analysis"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Historical Analysis
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-950">
              Selected-period format and family patterns
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              {decisionOs.historicalAnalysis.summary}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Selected period {decisionOs.historicalAnalysis.selectedWindow.startDate} to{" "}
              {decisionOs.historicalAnalysis.selectedWindow.endDate}.{" "}
              {decisionOs.historicalAnalysis.selectedWindow.note}
            </p>
          </div>
          <div className="grid gap-2 text-right text-xs text-slate-600">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Rows
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                {decisionOs.historicalAnalysis.selectedWindow.materialRowCount}/
                {decisionOs.historicalAnalysis.selectedWindow.rowCount}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1fr_1fr]">
          <HistoricalBucketList
            title="Winning formats"
            buckets={decisionOs.historicalAnalysis.winningFormats}
            emptyCopy="No material selected-period format trend is available."
          />
          <HistoricalBucketList
            title="Hook trends"
            buckets={decisionOs.historicalAnalysis.hookTrends}
            emptyCopy="No hook trend is visible in the selected period."
          />
          <HistoricalBucketList
            title="Angle trends"
            buckets={decisionOs.historicalAnalysis.angleTrends}
            emptyCopy="No messaging-angle trend is visible in the selected period."
          />
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-950">
              Family performance
            </h3>
            <span className="text-[11px] text-slate-500">
              descriptive, not decision-authoritative
            </span>
          </div>
          <div className="space-y-2">
            {decisionOs.historicalAnalysis.familyPerformance.map((family) => (
              <div
                key={family.familyId}
                className="rounded-xl border border-slate-200 bg-white p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-950">
                      {family.familyLabel}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">{family.summary}</p>
                  </div>
                  <div className="text-right text-xs text-slate-700">
                    <p>{family.dominantFormat} dominant</p>
                    <p>{family.creativeCount} creatives</p>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                  {family.topHook ? <span>Hook {family.topHook}</span> : null}
                  {family.topAngle ? <span>Angle {family.topAngle}</span> : null}
                  <span>{family.roas.toFixed(2)}x ROAS</span>
                  <span>{family.purchases} purchases</span>
                </div>
              </div>
            ))}
            {decisionOs.historicalAnalysis.familyPerformance.length === 0 ? (
              <p className="text-sm text-slate-500">
                No selected-period family trend is visible yet.
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}
