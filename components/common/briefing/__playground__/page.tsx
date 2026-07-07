"use client";

import {
  BulkToolbar,
  CompareDrawer,
  ConfidencePill,
  DecisionLabelChip,
  DeferChip,
  EvidenceAccordion,
  LaneHeader,
  LaunchpadOverlay,
  LevelChip,
  PulseStrip,
  TrackingBlockerBanner,
  TrackingConfirmModal,
} from "@/components/common/briefing";
import { DECISION_LABELS } from "@/components/common/briefing/decision-label-palette";
import type { DecisionLevel, LaneKey } from "@/components/common/briefing/types";

const levels: DecisionLevel[] = ["account", "campaign", "adset", "creative"];
const lanes: LaneKey[] = ["action", "watching", "healthy", "audience"];

const evidenceSections = [
  "Decision",
  "Inputs",
  "Funnel",
  "Engine trail",
  "Operator response",
  "Provenance",
].map((title, index) => ({
  key: title.toLowerCase().replaceAll(" ", "-"),
  title,
  content: <p>{title} evidence placeholder.</p>,
  count: index === 3 ? "v3.4.1" : undefined,
  defaultOpen: index === 0,
}));

const compareItems = [
  {
    id: "cr-1",
    name: "Aphrodite Necklace Hook v3",
    brand: "TheSwaf",
    label: "scale" as const,
    spend: 4210,
    roas: 3.42,
    ctr: 1.84,
    cpa: 14.2,
    purchases: 297,
    frequency: 1.6,
    sparkline: [2.1, 2.4, 2.9, 3.2, 3.42],
  },
  {
    id: "cr-2",
    name: "TowelRack Demo 15s",
    brand: "IwaStore",
    label: "cut" as const,
    spend: 9963,
    roas: 0.62,
    ctr: 0.71,
    cpa: 48.1,
    purchases: 41,
    frequency: 4.2,
    sparkline: [1.4, 1.1, 0.88, 0.74, 0.62],
  },
];

export default function BriefingPlaygroundPage() {
  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900">
      <PulseStrip
        left={<button className="px-2 py-1 rounded-md border border-neutral-200 bg-neutral-50 text-neutral-700">Scope: Account</button>}
        center={<span className="font-mono tabular-nums text-[12px]">Spend today $1,824 / $2,400</span>}
        right={<span className="text-[12px] text-neutral-500">Sync 2m ago</span>}
        jumpNav={<><a href="#chips">Chips</a><a href="#accordions">Accordions</a><a href="#overlays">Overlays</a></>}
      />

      <div className="mx-auto max-w-[1440px] space-y-8 px-6 py-8">
        <section id="chips" className="space-y-3">
          <h1 className="text-[18px] font-semibold">Briefing components</h1>
          <div className="flex flex-wrap gap-2">
            {levels.map((level) => <LevelChip key={level} level={level} />)}
          </div>
          <div className="flex flex-wrap gap-2">
            {DECISION_LABELS.map((label) => <DecisionLabelChip key={label} label={label} />)}
          </div>
          <div className="flex flex-wrap gap-2">
            {DECISION_LABELS.map((label) => <DecisionLabelChip key={label} label={label} surface="meta" size="sm" />)}
          </div>
          <div className="flex flex-wrap gap-2">
            <ConfidencePill confidence={88} />
            <ConfidencePill confidence={56} />
            <ConfidencePill confidence={31} size="sm" />
            <DeferChip id="defer-edge" />
          </div>
        </section>

        <section className="space-y-3">
          {lanes.map((lane) => (
            <LaneHeader
              key={lane}
              laneKey={lane}
              title={lane === "action" ? "Action now" : lane}
              count={lane === "audience" ? 0 : 4}
              subtitle={lane === "audience" ? "Reserved slot" : "Shared lane header"}
              collapsed={lane === "audience"}
            />
          ))}
          <LaneHeader laneKey="watching" title="Watching" count={6} subtitle="Meta variant" variant="meta" />
        </section>

        <section id="accordions" className="grid gap-4 lg:grid-cols-3">
          <EvidenceAccordion sections={evidenceSections} />
          <EvidenceAccordion sections={evidenceSections} variant="meta" />
          <EvidenceAccordion sections={evidenceSections} variant="legacy" />
        </section>

        <section className="space-y-3">
          <TrackingBlockerBanner onViewDetails={() => undefined} onDismiss={() => undefined} />
          <BulkToolbar selectedCount={3} onAction={() => undefined} onClear={() => undefined} />
          <BulkToolbar selectedCount={2} variant="meta" trackingBlocked onAction={() => undefined} onClear={() => undefined} />
        </section>

        <section id="overlays" className="space-y-3">
          <CompareDrawer open items={compareItems} />
          <TrackingConfirmModal open primaryLabel="Confirm cut 3" onClose={() => undefined} onConfirm={() => undefined} />
          {(["promote", "demote", "fresh_test", "rebuild", "duplicate", "apply_bid"] as const).map((mode) => (
            <LaunchpadOverlay
              key={mode}
              open
              mode={mode}
              presentation="panel"
              item={{ id: mode, name: "Aphrodite Necklace Hook v3", brand: "TheSwaf", campaign: "ASC | Worldwide", label: "scale" }}
              onClose={() => undefined}
              onConfirm={() => undefined}
            />
          ))}
        </section>

        <section className="hidden">
          <BulkToolbar selectedCount={0} />
          <DeferChip id="hidden-defer" deferred={false} />
          <TrackingBlockerBanner visible={false} />
        </section>
      </div>
    </main>
  );
}
