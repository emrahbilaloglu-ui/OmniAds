"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  EvidenceAccordion as SharedEvidenceAccordion,
  type EvidenceAccordionSection,
} from "@/components/common/briefing/EvidenceAccordion";
import type {
  DecisionEngineV3EvidenceResponse,
  NativeAdDecisionEvidenceResponse,
} from "@/app/api/creatives/decision-engine-v3/evidence/route";

interface CreativeEngineV3EvidenceSectionProps {
  businessId: string;
  providerAccountId: string | null;
  adId: string | null;
  creativeId?: string | null;
  open: boolean;
}

export function CreativeEngineV3EvidenceSection({
  businessId,
  providerAccountId,
  adId,
  creativeId,
  open,
}: CreativeEngineV3EvidenceSectionProps) {
  const exactIdentityReady = Boolean(
    businessId.trim() && providerAccountId?.trim() && adId?.trim(),
  );
  const evidenceQuery = useQuery({
    queryKey: [
      "engine-v3-native-ad-evidence",
      businessId,
      providerAccountId,
      adId,
    ],
    enabled: open && exactIdentityReady,
    staleTime: 60_000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () =>
      fetchEngineV3Evidence({
        businessId,
        providerAccountId: providerAccountId!,
        adId: adId!,
      }),
  });

  if (!open) return null;

  if (!exactIdentityReady) {
    return (
      <EvidenceShell>
        <p className="text-sm text-[var(--adc-danger-fg)]">
          Exact Ad evidence unavailable: provider account or real Ad identity
          is missing.
        </p>
      </EvidenceShell>
    );
  }

  if (evidenceQuery.isLoading || evidenceQuery.isFetching) {
    return (
      <EvidenceShell>
        <p className="text-sm text-neutral-500">
          Loading persisted exact-Ad evidence...
        </p>
      </EvidenceShell>
    );
  }

  if (evidenceQuery.isError) {
    return (
      <EvidenceShell>
        <p className="text-sm text-[var(--adc-danger-fg)]">
          Persisted exact-Ad evidence is unavailable or failed lineage
          validation.
        </p>
      </EvidenceShell>
    );
  }

  const payload = evidenceQuery.data;
  if (!payload) return null;

  if (payload.status === "disabled") {
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
      title: "Persisted input",
      content: <JsonEvidence value={payload.persistedEvidence.creativeInput} />,
    },
    {
      key: "context",
      title: "Campaign and evaluation context",
      content: (
        <div className="space-y-3">
          <JsonEvidence value={payload.persistedEvidence.campaignContext} />
          <JsonEvidence value={payload.persistedEvidence.evaluationContext} />
        </div>
      ),
    },
    {
      key: "engine",
      title: "Persisted engine trail",
      content: <EngineTrailEvidence payload={payload} />,
    },
    {
      key: "operator",
      title: "Operator response",
      content: <OperatorResponseEvidence payload={payload} />,
    },
    {
      key: "provenance",
      title: "Provenance",
      content: (
        <ProvenanceEvidence payload={payload} requestedCreativeId={creativeId} />
      ),
    },
  ];

  return (
    <EvidenceShell>
      <SharedEvidenceAccordion sections={sections} variant="legacy" />
    </EvidenceShell>
  );
}

async function fetchEngineV3Evidence(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
}): Promise<DecisionEngineV3EvidenceResponse> {
  const url = new URL(
    "/api/creatives/decision-engine-v3/evidence",
    window.location.origin,
  );
  url.searchParams.set("businessId", input.businessId);
  url.searchParams.set("providerAccountId", input.providerAccountId);
  url.searchParams.set("adId", input.adId);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `engine v3 native evidence fetch failed: ${response.status} ${text}`,
    );
  }
  return (await response.json()) as DecisionEngineV3EvidenceResponse;
}

function EvidenceShell({ children }: { children: ReactNode }) {
  return (
    <section
      className="rounded-xl border border-neutral-200 bg-white p-4"
      data-testid="engine-v3-evidence"
    >
      <h4 className="text-sm font-semibold text-neutral-900">
        Engine v3 exact-Ad evidence
      </h4>
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

function DecisionEvidence({
  payload,
}: {
  payload: NativeAdDecisionEvidenceResponse;
}) {
  const decision = payload.decision;
  const authority = decision.sourceAuthority!;
  return (
    <div className="space-y-3 text-sm text-neutral-700">
      <div className="flex flex-wrap items-center gap-2">
        <MetricPill label="persisted label" value={decision.sourceDecision.label} />
        <MetricPill
          label="served action"
          value={decision.classification.buyerLabel}
        />
        <MetricPill
          label="confidence"
          value={`${formatConfidence(decision.sourceDecision.confidence)}%`}
        />
      </div>
      <p className="leading-relaxed text-neutral-800">
        {decision.sourceDecision.reason}
      </p>
      <KeyValueGrid
        rows={[
          ["adId", payload.adId],
          ["creativeId (grouping only)", payload.creativeId],
          ["decisionState", decision.classification.decisionState],
          ["heldAction", decision.classification.heldAction],
          ["authorizedAction", authority.authorizedAction],
          ["decisionAuthorized (persisted)", authority.actionEligible],
          ["reviewOnlyReason", authority.reviewOnlyReason],
          ["truthSource", decision.sourceDecision.truthSource],
          ["effectiveTargetRoas", decision.metrics.effectiveTargetRoas],
          ["ratioToTarget", decision.metrics.ratioToTarget],
        ]}
      />
    </div>
  );
}

function EngineTrailEvidence({
  payload,
}: {
  payload: NativeAdDecisionEvidenceResponse;
}) {
  const decision = payload.decision;
  return (
    <div className="space-y-3 text-sm text-neutral-700">
      <KeyValueGrid
        rows={[
          ["engineVersion", payload.engineVersion],
          ["generation.jobRunId", payload.generation.jobRunId],
          ["generation.manifestHash", payload.generation.manifestHash],
          ["generation.expectedAdCount", payload.generation.expectedAdCount],
          ["rawLabel", decision.sourceDecision.rawLabel],
          ["preAuthorityLabel", decision.sourceDecision.preAuthorityLabel],
          ["authorityBlocker", decision.sourceDecision.authorityBlocker],
          ["badges", decision.sourceDecision.badges.join(", ")],
        ]}
      />
      <p className="text-xs font-semibold text-neutral-500">
        Persisted decision output
      </p>
      <JsonEvidence value={payload.persistedEvidence.decisionOutput} />
      <p className="text-xs font-semibold text-neutral-500">
        Persisted account profile and data health
      </p>
      <JsonEvidence
        value={{
          accountProfile: payload.persistedEvidence.accountProfile,
          dataHealth: payload.persistedEvidence.dataHealth,
          flags: payload.persistedEvidence.flags,
          priorHysteresis: payload.persistedEvidence.priorHysteresis,
        }}
      />
    </div>
  );
}

function OperatorResponseEvidence({
  payload,
}: {
  payload: NativeAdDecisionEvidenceResponse;
}) {
  const responses = payload.decision.history.responses;
  const providerWrites = payload.decision.history.providerWrites;
  return (
    <div className="space-y-3 text-sm text-neutral-700">
      <KeyValueGrid
        rows={[
          ["responseStatus", responses.status],
          ["responseReason", responses.reason],
          ["providerWriteStatus", providerWrites.status],
          ["providerWriteReason", providerWrites.reason],
        ]}
      />
      <JsonEvidence value={responses.items ?? []} />
    </div>
  );
}

function ProvenanceEvidence({
  payload,
  requestedCreativeId,
}: {
  payload: NativeAdDecisionEvidenceResponse;
  requestedCreativeId?: string | null;
}) {
  return (
    <div className="space-y-3 text-sm text-neutral-700">
      <KeyValueGrid
        rows={[
          ["lineageStatus", payload.lineage.status],
          ["businessId", payload.businessId],
          ["providerAccountId", payload.providerAccountId],
          ["providerAccountRefId", payload.lineage.providerAccountRefId],
          ["requestedCreativeId (grouping only)", requestedCreativeId],
          ["snapshotId", payload.lineage.snapshot.id],
          ["evaluationId", payload.lineage.evaluation.id],
          ["contextId", payload.lineage.context.id],
          ["inputHash", payload.lineage.snapshot.inputHash],
          ["decisionHash", payload.lineage.snapshot.decisionHash],
          ["contextHash", payload.lineage.context.contextHash],
          ["scope", `${payload.lineage.scope.type}:${payload.lineage.scope.id}`],
          ["asOf", payload.asOf],
        ]}
      />
    </div>
  );
}

function JsonEvidence({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-[11px] leading-relaxed text-neutral-800">
      {JSON.stringify(value, null, 2)}
    </pre>
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
