"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  EvidenceAccordion as SharedEvidenceAccordion,
  type EvidenceAccordionSection,
} from "@/components/common/briefing/EvidenceAccordion";
import { DecisionLabelChip } from "@/components/common/briefing/DecisionLabelChip";
import type {
  AccountDecisionProfile,
  CreativeInput,
  DecisionEvidenceResponse,
  EngineV3Flags,
  FunnelDiagnosis,
  OperatorResponseResult,
} from "@/lib/creative-decision-engine";
import { cn } from "@/lib/utils";
import {
  LABEL_DISPLAY,
  TONE_CLASS,
} from "@/components/creatives/decision-label-display";

interface CreativeEngineV3EvidenceSectionProps {
  businessId: string;
  creativeId: string;
  campaignId?: string | null;
  open: boolean;
}

type EvidenceDisabledResponse = {
  status: "disabled";
  reason: "engine_v3_disabled_for_business";
  flags: EngineV3Flags;
};

type EvidenceResponse = DecisionEvidenceResponse | EvidenceDisabledResponse;

export function CreativeEngineV3EvidenceSection({
  businessId,
  creativeId,
  campaignId,
  open,
}: CreativeEngineV3EvidenceSectionProps) {
  const enabled = open && Boolean(businessId) && Boolean(creativeId);
  const evidenceQuery = useQuery({
    queryKey: ["engine-v3-evidence", businessId, creativeId, campaignId ?? null],
    enabled,
    staleTime: 60_000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () => fetchEngineV3Evidence({ businessId, creativeId, campaignId }),
  });

  if (!open) return null;

  if (evidenceQuery.isLoading || evidenceQuery.isFetching) {
    return (
      <EvidenceShell>
        <p className="text-sm text-neutral-500">Loading Engine v3 evidence...</p>
      </EvidenceShell>
    );
  }

  if (evidenceQuery.isError) {
    return (
      <EvidenceShell>
        <p className="text-sm text-rose-600">
          Engine v3 evidence unavailable.
        </p>
      </EvidenceShell>
    );
  }

  const payload = evidenceQuery.data;
  if (!payload) return null;

  if (isDisabledEvidence(payload)) {
    return (
      <EvidenceShell>
        <p className="text-sm text-neutral-500">
          Engine v3 not enabled for this business
        </p>
      </EvidenceShell>
    );
  }

  const sections: EvidenceAccordionSection[] = [
    {
      key: "decision",
      title: "Decision",
      content: <DecisionEvidence payload={payload} />,
    },
    {
      key: "inputs",
      title: "Inputs",
      content: <InputEvidence input={payload.input} />,
    },
    {
      key: "funnel",
      title: "Funnel",
      content: <FunnelEvidence diagnosis={payload.funnelDiagnosis} />,
    },
    {
      key: "engine",
      title: "Engine trail",
      content: <EngineTrailEvidence accountProfile={payload.accountProfile} payload={payload} />,
    },
    {
      key: "operator",
      title: "Operator response",
      content: <OperatorResponseEvidence operatorResponse={payload.operatorResponse} />,
    },
    {
      key: "provenance",
      title: "Provenance",
      content: <ProvenanceEvidence payload={payload} />,
    },
  ];

  return (
    <EvidenceShell>
      <SharedEvidenceAccordion sections={sections} variant="legacy" />
    </EvidenceShell>
  );
}

function isDisabledEvidence(payload: EvidenceResponse): payload is EvidenceDisabledResponse {
  return "status" in payload && payload.status === "disabled";
}

async function fetchEngineV3Evidence(input: {
  businessId: string;
  creativeId: string;
  campaignId?: string | null;
}): Promise<EvidenceResponse> {
  const url = new URL(
    "/api/creatives/decision-engine-v3/evidence",
    window.location.origin,
  );
  url.searchParams.set("businessId", input.businessId);
  url.searchParams.set("creativeId", input.creativeId);
  if (input.campaignId) url.searchParams.set("campaignId", input.campaignId);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`engine v3 evidence fetch failed: ${response.status} ${text}`);
  }
  return (await response.json()) as EvidenceResponse;
}

function EvidenceShell({ children }: { children: ReactNode }) {
  return (
    <section
      className="rounded-xl border border-neutral-200 bg-white p-4"
      data-testid="engine-v3-evidence"
    >
      <h4 className="text-sm font-semibold text-neutral-900">Engine v3 evidence</h4>
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

function DecisionEvidence({ payload }: { payload: DecisionEvidenceResponse }) {
  const display = LABEL_DISPLAY[payload.decision.label];

  return (
    <div className="space-y-3 text-sm text-neutral-700">
      <div className="flex flex-wrap items-center gap-2">
        <DecisionLabelChip
          label={payload.decision.label}
          appearance="unstyled"
          className={cn(
            "rounded border px-2 py-0.5 text-xs font-semibold",
            TONE_CLASS[display.tone],
          )}
        >
          {display.label}
        </DecisionLabelChip>
        <MetricPill
          label="confidence"
          value={`${formatConfidence(payload.decision.confidence)}%`}
        />
        <MetricPill label="truth" value={payload.decision.truthSource} />
      </div>
      <p className="leading-relaxed text-neutral-800">{payload.decision.reason}</p>
      <KeyValueGrid
        rows={[
          ["effectiveTargetRoas", payload.decision.effectiveTargetRoas],
          ["ratioToTarget", payload.decision.ratioToTarget],
          ["campaignLabelStatus", payload.decision.campaignLabelStatus],
          ["campaignKind", payload.decision.campaignKind],
          ["campaignTestDimension", payload.decision.campaignTestDimension],
          ["blockedActionType", payload.decision.blockedActionType],
        ]}
      />
    </div>
  );
}

function InputEvidence({ input }: { input: CreativeInput }) {
  const groups: Array<{ title: string; rows: Array<[string, unknown]> }> = [
    {
      title: "Identity / scope",
      rows: [
        ["creativeId", input.creativeId],
        ["creativeName", input.creativeName],
        ["businessId", input.businessId],
        ["campaignId", input.campaignId],
        ["objective", input.objective],
      ],
    },
    {
      title: "Performance",
      rows: [
        ["spend", input.spend],
        ["purchases", input.purchases],
        ["purchaseValue", input.purchaseValue],
        ["impressions", input.impressions],
        ["linkClicks", input.linkClicks],
        ["roas", input.roas],
        ["cpa", input.cpa],
        ["ctr", input.ctr],
        ["frequency", input.frequency],
        ["recent7dSpend", input.recent7dSpend],
        ["recent7dPurchases", input.recent7dPurchases],
        ["recent7dRoas", input.recent7dRoas],
        ["recent7dImpressions", input.recent7dImpressions],
      ],
    },
    {
      title: "Creative health",
      rows: [
        ["effectiveStatus", input.effectiveStatus],
        ["ageDays", input.ageDays],
        ["lastSpendAt", input.lastSpendAt],
        ["policyReason", input.policyReason],
        ["dataFreshnessHours", input.dataFreshnessHours],
        ["fatigueStatus", input.fatigueStatus],
        ["targetRoas", input.targetRoas],
        ["breakevenRoas", input.breakevenRoas],
      ],
    },
    {
      title: "Lifecycle",
      rows: [
        ["lifecyclePosition", input.lifecyclePosition],
        ["daysSincePeak", input.daysSincePeak],
        ["peakRoas30d", input.peakRoas30d],
        ["peakConfidence", input.peakConfidence],
        ["spendTrajectory30d", input.spendTrajectory30d],
        ["spendSlope7d", input.spendSlope7d],
        ["spendSlope30d", input.spendSlope30d],
        ["roasSlope7d", input.roasSlope7d],
        ["roasSlope30d", input.roasSlope30d],
      ],
    },
    {
      title: "Funnel signals",
      rows: [
        ["cpm", input.cpm],
        ["outboundClicks", input.outboundClicks],
        ["landingPageViews", input.landingPageViews],
        ["addToCart", input.addToCart],
        ["initiateCheckout", input.initiateCheckout],
        ["thumbstop", input.thumbstop],
        ["video25Rate", input.video25Rate],
        ["video50Rate", input.video50Rate],
        ["video75Rate", input.video75Rate],
        ["video100Rate", input.video100Rate],
        ["qualityRanking", input.qualityRanking],
        ["engagementRateRanking", input.engagementRateRanking],
        ["conversionRateRanking", input.conversionRateRanking],
        ["creativeFormat", input.creativeFormat],
      ],
    },
  ];

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.title}>
          <p className="mb-1 text-xs font-semibold text-neutral-500">
            {group.title}
          </p>
          <KeyValueGrid rows={group.rows} />
        </div>
      ))}
    </div>
  );
}

function FunnelEvidence({
  diagnosis,
}: {
  diagnosis: FunnelDiagnosis | null;
}) {
  if (!diagnosis) {
    return (
      <p className="text-sm text-neutral-500">
        Funnel diagnosis not available for this creative.
      </p>
    );
  }

  return (
    <div className="space-y-3 text-sm text-neutral-700">
      <KeyValueGrid
        rows={[
          ["primaryWeakStage", diagnosis.primaryWeakStage],
          ["creativeResponsible", diagnosis.creativeResponsible],
          ["confidence", `${formatConfidence(diagnosis.confidence)}%`],
        ]}
      />
      <table className="w-full border-collapse text-xs">
        <tbody>
          {Object.entries(diagnosis.rates).map(([key, value]) => (
            <tr key={key} className="border-b border-neutral-100 last:border-b-0">
              <td className="py-1 pr-2 text-neutral-500">{key}</td>
              <td className="py-1 text-right font-mono text-neutral-900">
                {formatValue(value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <EvidenceList items={diagnosis.evidence} emptyText="No funnel evidence." />
    </div>
  );
}

function EngineTrailEvidence({
  accountProfile,
  payload,
}: {
  accountProfile: AccountDecisionProfile;
  payload: DecisionEvidenceResponse;
}) {
  return (
    <div className="space-y-3 text-sm text-neutral-700">
      {payload.decision.badges.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {payload.decision.badges.map((badge) => (
            <span
              key={`${badge.type}-${badge.label}`}
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] font-medium",
                badge.severity === "warning"
                  ? "bg-amber-500/15 text-amber-800"
                  : "bg-neutral-100 text-neutral-600",
              )}
            >
              {badge.type} / {badge.label} / {badge.severity}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-neutral-500">No badges.</p>
      )}
      <KeyValueGrid
        rows={[
          ["scope", `${accountProfile.scope.type}:${accountProfile.scope.id}`],
          ["scopeFallbackReason", accountProfile.scope.fallbackReason],
          ["commercialTruthReady", accountProfile.quality.commercialTruthReady],
          ["calibrationReady", accountProfile.quality.calibrationReady],
          ["metaAovQuality", accountProfile.quality.metaAovQuality],
          ["thresholdQuality", accountProfile.quality.thresholdQuality],
          ["hardActionScale", accountProfile.hardActionEligibility.scale],
          ["hardActionCut", accountProfile.hardActionEligibility.cut],
          ["hardActionRefresh", accountProfile.hardActionEligibility.refresh],
          ["hardActionReason", accountProfile.hardActionEligibility.reason],
        ]}
      />
    </div>
  );
}

function OperatorResponseEvidence({
  operatorResponse,
}: {
  operatorResponse: OperatorResponseResult | null;
}) {
  if (!operatorResponse) {
    return (
      <p className="text-sm text-neutral-500">
        No operator response detected in the recent window.
      </p>
    );
  }

  return (
    <div className="space-y-3 text-sm text-neutral-700">
      <KeyValueGrid
        rows={[
          ["responseType", operatorResponse.responseType],
          ["confidence", `${formatConfidence(operatorResponse.confidence)}%`],
          ["decisionRecommendedAt", operatorResponse.decisionRecommendedAt],
          [
            "operatorResponseDetectedAt",
            operatorResponse.operatorResponseDetectedAt,
          ],
          ["promoteLifecyclePosition", operatorResponse.promoteLifecyclePosition],
        ]}
      />
      <div>
        <p className="mb-1 text-xs font-semibold text-neutral-500">
          Trigger signals
        </p>
        <KeyValueGrid
          rows={[
            ["spendSlope7d", operatorResponse.signals.spendSlope7d],
            ["budgetChangeAmount", operatorResponse.signals.budgetChangeAmount],
            [
              "actionJournalReceiptCount",
              operatorResponse.signals.actionJournalReceiptCount,
            ],
            ["statusChanged", operatorResponse.signals.statusChanged],
            ["roasDecayPct", operatorResponse.signals.roasDecayPct],
            ["frequencyRosePct", operatorResponse.signals.frequencyRosePct],
          ]}
        />
      </div>
      <EvidenceList items={operatorResponse.evidence} emptyText="No evidence." />
    </div>
  );
}

function ProvenanceEvidence({ payload }: { payload: DecisionEvidenceResponse }) {
  const health = payload.dataHealth;
  return (
    <div className="space-y-3 text-sm text-neutral-700">
      <KeyValueGrid
        rows={[
          ["engineVersion", payload.engineVersion],
          ["scope", `${payload.scope.type}:${payload.scope.id}`],
          ["scopeFallbackReason", payload.scope.fallbackReason],
          ["decision.generatedAt", payload.decision.generatedAt],
          ["asOf", payload.asOf],
          ["worstTier", health.worstTier],
          ["degraded", health.degraded],
        ]}
      />
      <KeyValueGrid
        rows={[
          ["calibration.staleTier", health.calibration.staleTier],
          ["lifecycle.staleTier", health.lifecycle.staleTier],
          ["decisions.staleTier", health.decisions.staleTier],
        ]}
      />
    </div>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
      {label}: <span className="font-mono text-neutral-900">{value}</span>
    </span>
  );
}

function KeyValueGrid({ rows }: { rows: Array<[string, unknown]> }) {
  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-neutral-200 text-xs sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="border-b border-neutral-100 px-2.5 py-2 last:border-b-0"
        >
          <div className="text-neutral-500">{label}</div>
          <div className="mt-0.5 break-words font-mono text-neutral-900">
            {formatValue(value)}
          </div>
        </div>
      ))}
    </div>
  );
}

function EvidenceList({
  items,
  emptyText,
}: {
  items: string[];
  emptyText: string;
}) {
  if (items.length === 0) return <p className="text-sm text-neutral-500">{emptyText}</p>;
  return (
    <ul className="list-disc space-y-1 pl-4 text-sm text-neutral-700">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function formatConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "n/a";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "n/a";
    return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
  }
  return String(value);
}
