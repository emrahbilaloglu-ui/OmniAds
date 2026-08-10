"use client";

import { PauseCircle, ShieldCheck } from "lucide-react";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { resolveLaunchpadAdActionId } from "@/lib/launchpad/recent-ad-actions";

function normalizeMetaAdStatus(value: string | null | undefined) {
  const status = value?.trim().toUpperCase();
  return status && status.length > 0 ? status : "UNKNOWN";
}

export function LaunchpadManageExistingReview({
  selectedCreatives,
  onRun,
}: {
  selectedCreatives: MetaCreativeRow[];
  onRun: (action: "pause", rows: MetaCreativeRow[]) => void;
}) {
  const activeRows = selectedCreatives.filter(
    (creative) => normalizeMetaAdStatus(creative.effectiveStatus) === "ACTIVE",
  );
  const pausedRows = selectedCreatives.filter(
    (creative) => normalizeMetaAdStatus(creative.effectiveStatus) === "PAUSED",
  );
  const unknownRows = selectedCreatives.filter((creative) => {
    const status = normalizeMetaAdStatus(creative.effectiveStatus);
    return status !== "ACTIVE" && status !== "PAUSED";
  });
  const missingActionIds = selectedCreatives.filter((creative) => !resolveLaunchpadAdActionId(creative));

  return (
    <section className="space-y-5" data-testid="launchpad-manage-existing-review">
      <div>
        <h2 className="text-[15px] font-semibold text-[var(--ink)]">Manage existing ads</h2>
        <p className="text-[13px] text-[var(--muted)]">
          Current authority is limited to pausing active ads. ACTIVE transitions are not exposed.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] md:grid-cols-4">
        <SummaryTile label="Selected" value={`${selectedCreatives.length}`} />
        <SummaryTile label="Active" value={`${activeRows.length}`} />
        <SummaryTile label="Paused" value={`${pausedRows.length}`} />
        <SummaryTile label="Other" value={`${unknownRows.length}`} />
      </div>

      {missingActionIds.length > 0 ? (
        <div className="rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3 text-[13px] text-[var(--danger)]">
          {missingActionIds.length} selected row cannot be mapped to a Meta ad id.
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] bg-[var(--warn-bg)] text-[var(--warn)]">
              <PauseCircle className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-[var(--ink)]">Pause selected active ads</p>
              <p className="mt-1 text-[13px] text-[var(--muted)]">
                {activeRows.length} active ad{activeRows.length === 1 ? "" : "s"} will be set to PAUSED.
              </p>
              <button
                type="button"
                className="btn btn--primary mt-4"
                disabled={activeRows.length === 0 || missingActionIds.length > 0}
                onClick={() => onRun("pause", activeRows)}
              >
                <PauseCircle className="h-4 w-4" />
                Pause selected ({activeRows.length})
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-4">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] border border-[var(--warn-bd)] bg-[var(--surface)] text-[var(--warn)]">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[14px] font-semibold text-[var(--ink)]">Resume / Publish ACTIVE</p>
                <span className="chip chip--warn">Proposed/contract required</span>
              </div>
              <p className="mt-1 text-[13px] text-[var(--muted)]">
                {pausedRows.length} paused ad{pausedRows.length === 1 ? "" : "s"} selected. Activation is unavailable in the current Launchpad UI contract.
              </p>
              <p className="mt-3 text-[12px] leading-relaxed text-[var(--warn)]">
                Required contract: fresh activation preflight, exposure summary, verified child activation, campaign-last activation, and halt on drift or ambiguous outcome. No one-click control is rendered.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden border border-[var(--border)] bg-[var(--surface)]">
        <div className="border-b border-[var(--border)] px-4 py-3 text-[13px] font-semibold text-[var(--ink)]">Selected ads</div>
        <div className="max-h-[360px] divide-y divide-[var(--border)] overflow-auto">
          {selectedCreatives.map((creative) => (
            <div key={creative.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-[var(--ink)]">{creative.name}</p>
                <p className="mono text-[12px] text-[var(--muted)]">
                  {resolveLaunchpadAdActionId(creative) || "Meta ad id unavailable"} · {creative.campaignName ?? "No campaign"}
                </p>
              </div>
              <span className="chip">{normalizeMetaAdStatus(creative.effectiveStatus)}</span>
            </div>
          ))}
          {selectedCreatives.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--muted)]">No ads selected.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--surface)] px-4 py-3">
      <p className="text-[12px] text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-[24px] font-[650] leading-none tabular-nums text-[var(--ink)]">{value}</p>
    </div>
  );
}
