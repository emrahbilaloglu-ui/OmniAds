"use client";

import { Activity, ClipboardList, GitBranch, History, Layers, ShieldCheck } from "lucide-react";
import {
  EvidenceAccordion,
  type EvidenceAccordionSection,
} from "@/components/common/briefing/EvidenceAccordion";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { formatRoas } from "@/lib/briefing/utils";

interface MetaEvidenceAccordionProps {
  rec: MetaRecommendation;
}

function JsonBlock({ value }: { value: unknown }) {
  if (value == null) return <span className="text-slate-400">None</span>;
  return (
    <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 font-mono text-[11px] leading-relaxed text-slate-600">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function EvidenceList({ rec }: { rec: MetaRecommendation }) {
  if (rec.evidence.length === 0) return <span className="text-slate-400">No inputs persisted.</span>;
  return (
    <div className="grid gap-1.5">
      {rec.evidence.map((item) => (
        <div key={`${item.label}-${item.value}`} className="flex items-center justify-between gap-3 rounded-md bg-white px-2 py-1.5">
          <span className="text-slate-500">{item.label}</span>
          <span className="font-medium text-slate-900">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function TrendBlock({ rec }: { rec: MetaRecommendation }) {
  const history = rec.evidenceTrail?.roas_history ?? [];
  if (!Array.isArray(history) || history.length === 0) {
    return <span className="text-slate-400">No 28d ROAS history persisted.</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {history.slice(-14).map((value, index) => (
        <span
          key={`${index}-${String(value)}`}
          className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10.5px] text-slate-700"
        >
          {formatRoas(Number(value))}
        </span>
      ))}
    </div>
  );
}

export function buildMetaEvidenceSections(rec: MetaRecommendation): EvidenceAccordionSection[] {
  const trail = rec.evidenceTrail;
  return [
    {
      key: "decision",
      title: "Decision",
      icon: <ClipboardList className="inline-block shrink-0" size={13} aria-hidden="true" />,
      defaultOpen: true,
      content: (
        <div className="space-y-2">
          <div>{rec.why}</div>
          <div className="rounded-md bg-white px-2 py-1.5 text-slate-700">{rec.recommendedAction}</div>
        </div>
      ),
    },
    {
      key: "inputs",
      title: "Inputs",
      icon: <Layers className="inline-block shrink-0" size={13} aria-hidden="true" />,
      count: rec.evidence.length,
      content: <EvidenceList rec={rec} />,
    },
    {
      key: "trend",
      title: "Trend",
      icon: <Activity className="inline-block shrink-0" size={13} aria-hidden="true" />,
      count: Array.isArray(trail?.roas_history) ? trail?.roas_history.length : 0,
      content: <TrendBlock rec={rec} />,
    },
    {
      key: "engine",
      title: "Engine trail",
      icon: <GitBranch className="inline-block shrink-0" size={13} aria-hidden="true" />,
      content: (
        <JsonBlock
          value={{
            peer_comparison: trail?.peer_comparison ?? null,
            regime_stability: trail?.regime_stability ?? null,
            age_days: trail?.age_days ?? null,
            confidence_reason: rec.confidenceReason ?? null,
            engine_version: rec.engineVersion ?? null,
          }}
        />
      ),
    },
    {
      key: "operator",
      title: "Operator response",
      icon: <History className="inline-block shrink-0" size={13} aria-hidden="true" />,
      count: Array.isArray(trail?.recent_changes) ? trail?.recent_changes.length : 0,
      content: <JsonBlock value={trail?.recent_changes ?? []} />,
    },
    {
      key: "provenance",
      title: "Provenance",
      icon: <ShieldCheck className="inline-block shrink-0" size={13} aria-hidden="true" />,
      content: (
        <JsonBlock
          value={{
            id: rec.id,
            level: rec.level,
            type: rec.type,
            campaign_role: rec.campaignRole ?? null,
            bid_regime: rec.bidRegime ?? null,
          }}
        />
      ),
    },
  ];
}

export function MetaEvidenceAccordion({ rec }: MetaEvidenceAccordionProps) {
  return <EvidenceAccordion sections={buildMetaEvidenceSections(rec)} variant="meta" />;
}
