"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Save, Send, ShieldCheck } from "lucide-react";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import type {
  LaunchpadIssue,
  MetaAddToExistingPayload,
  MetaLaunchPayload,
} from "@/lib/launchpad/meta";
import { hasBelowBreakeven } from "@/components/launchpad/LaunchpadCreativeSelection";

export interface LaunchpadValidationState {
  ok: boolean;
  blockers: LaunchpadIssue[];
  warnings: LaunchpadIssue[];
}

export function buildEngineAggregate(input: {
  selectedCreatives: MetaCreativeRow[];
  decisionByCreativeId: Map<string, DecisionOutput>;
}) {
  let scale = 0;
  let cut = 0;
  let diagnose = 0;
  let belowBreakeven = 0;
  let weightedRoasNumerator = 0;
  let weightedSpend = 0;

  input.selectedCreatives.forEach((creative) => {
    const decision = input.decisionByCreativeId.get(creative.creativeId);
    if (decision?.label === "scale") scale += 1;
    if (decision?.label === "cut") cut += 1;
    if (decision?.label === "diagnose") diagnose += 1;
    if (hasBelowBreakeven(decision)) belowBreakeven += 1;
    const spend = decision?.metrics.spend ?? creative.spend;
    const roas = decision?.metrics.roas ?? creative.roas;
    if (Number.isFinite(spend) && spend > 0 && Number.isFinite(roas)) {
      weightedSpend += spend;
      weightedRoasNumerator += spend * (roas ?? 0);
    }
  });

  return {
    total: input.selectedCreatives.length,
    scale,
    cut,
    diagnose,
    belowBreakeven,
    flagged: scale + cut + diagnose + belowBreakeven,
    averageRoas: weightedSpend > 0 ? weightedRoasNumerator / weightedSpend : null,
    severe: cut > 0 || diagnose > 0,
  };
}

export function LaunchpadReview({
  mode = "new_campaign",
  businessId,
  payload,
  selectedCreatives,
  decisionByCreativeId,
  targetSummary,
  onValidation,
  onSaveTemplate,
  onSaveDraft,
  onLaunch,
}: {
  mode?: "new_campaign" | "add_to_existing";
  businessId: string;
  payload: MetaLaunchPayload | MetaAddToExistingPayload;
  selectedCreatives: MetaCreativeRow[];
  decisionByCreativeId: Map<string, DecisionOutput>;
  targetSummary?: {
    campaignName: string | null;
    adsetName: string | null;
    campaignCount?: number | null;
    targetCount?: number | null;
    currentAdCount?: number | null;
  } | null;
  onValidation?: (state: LaunchpadValidationState) => void;
  onSaveTemplate?: () => void;
  onSaveDraft?: () => void;
  onLaunch: () => void;
}) {
  const [validation, setValidation] = useState<LaunchpadValidationState | null>(null);
  const [validating, setValidating] = useState(false);
  const aggregate = useMemo(
    () => buildEngineAggregate({ selectedCreatives, decisionByCreativeId }),
    [decisionByCreativeId, selectedCreatives],
  );

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    setValidating(true);
    fetch("/api/launchpad/meta/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, payload }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | LaunchpadValidationState
          | null;
        if (cancelled) return;
        const next = {
          ok: Boolean(body?.ok),
          blockers: Array.isArray(body?.blockers) ? body.blockers : [],
          warnings: Array.isArray(body?.warnings) ? body.warnings : [],
        };
        setValidation(next);
        onValidation?.(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const next = {
          ok: false,
          blockers: [
            {
              code: "validation_request_failed",
              message: error instanceof Error ? error.message : "Validation failed.",
            },
          ],
          warnings: [],
        };
        setValidation(next);
        onValidation?.(next);
      })
      .finally(() => {
        if (!cancelled) setValidating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, onValidation, payload]);

  const launchBlocked = validating || !validation?.ok;
  const targetCount = Math.max(1, targetSummary?.targetCount ?? 1);
  const campaignCount = Math.max(1, targetSummary?.campaignCount ?? 1);
  const addToExistingCopyMode =
    mode === "add_to_existing" && "copyMode" in payload
      ? payload.copyMode
      : null;
  const afterLaunchCount =
    targetSummary?.currentAdCount == null
      ? null
      : targetSummary.currentAdCount + selectedCreatives.length * targetCount;

  const newCampaignAdSetCount =
    mode === "new_campaign" && "adSets" in payload ? payload.adSets.length : 0;
  const newCampaignAdCount = newCampaignAdSetCount * selectedCreatives.length;
  const blockerCount = validation?.blockers.length ?? 0;

  return (
    <section className="space-y-5" data-testid="launchpad-review">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Review</h2>
        <p className="text-[13px] text-[var(--muted)]">
          {mode === "add_to_existing"
            ? "Ads will be added to the existing ad set and start paused"
            : "Campaign and ads will start paused"}
        </p>
      </div>

      {mode === "add_to_existing" ? (
        <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4" data-testid="launchpad-mode-b-review-copy">
          <p className="text-[13px] font-semibold text-[var(--ink)]">
            {targetCount > 1
              ? `${selectedCreatives.length} creatives -> ${targetCount} existing ad sets across ${campaignCount} campaigns`
              : `${selectedCreatives.length} creatives -> existing ad set ${
                  targetSummary?.adsetName ?? "selected ad set"
                } under campaign ${targetSummary?.campaignName ?? "selected campaign"}`}
          </p>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            {targetCount > 1 ? "Selected ad sets" : "The ad set"} will inherit pixel, attribution, targeting, and budget settings.
            {targetSummary?.currentAdCount != null && afterLaunchCount != null
              ? ` Current ads: ${targetSummary.currentAdCount}; after launch: ${afterLaunchCount}.`
              : ""}
            {addToExistingCopyMode
              ? ` Creative copy: ${addToExistingCopyMode === "reuse_creative" ? "duplicate" : "recreate exact ad"}.`
              : ""}
          </p>
        </div>
      ) : null}

      <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4" data-testid="launchpad-review-checklist">
        <p className="text-[13px] font-semibold text-[var(--ink)]">Human-readable checklist — first, always</p>
        {mode === "new_campaign" ? (
          <div className="mt-3 grid grid-cols-3 gap-3">
            <div>
              <p className="text-[11.5px] text-[var(--muted)]">Campaigns</p>
              <p className="mt-0.5 text-[26px] font-[650] leading-none tracking-[-0.02em] tabular-nums text-[var(--ink)]">1</p>
            </div>
            <div>
              <p className="text-[11.5px] text-[var(--muted)]">Ad sets</p>
              <p className="mt-0.5 text-[26px] font-[650] leading-none tracking-[-0.02em] tabular-nums text-[var(--ink)]">{newCampaignAdSetCount}</p>
            </div>
            <div>
              <p className="text-[11.5px] text-[var(--muted)]">Ads</p>
              <p className="mt-0.5 text-[26px] font-[650] leading-none tracking-[-0.02em] tabular-nums text-[var(--ink)]">{newCampaignAdCount}</p>
            </div>
          </div>
        ) : null}
        <div className="mt-3 flex flex-col gap-1.5 text-[12.5px]">
          <div>
            <span className="text-[var(--ok)]">Will create:</span>{" "}
            <span className="text-[var(--ink-2)]">
              {mode === "new_campaign"
                ? `1 campaign · ${newCampaignAdSetCount} ad set${newCampaignAdSetCount === 1 ? "" : "s"} · ${newCampaignAdCount} ad${newCampaignAdCount === 1 ? "" : "s"} (${selectedCreatives.length} creative${selectedCreatives.length === 1 ? "" : "s"} × ${newCampaignAdSetCount} ad set${newCampaignAdSetCount === 1 ? "" : "s"})`
                : `${selectedCreatives.length} ad${selectedCreatives.length === 1 ? "" : "s"} across ${targetCount} existing ad set${targetCount === 1 ? "" : "s"}`}
            </span>
          </div>
          <div>
            <span className="text-[var(--muted)]">Will not change:</span>{" "}
            <span className="text-[var(--ink-2)]">any existing campaign, budget, or bid</span>
          </div>
          <div>
            <span className={blockerCount > 0 ? "text-[var(--danger)]" : "text-[var(--muted)]"}>Blocked:</span>{" "}
            <span className="text-[var(--ink-2)]">{blockerCount > 0 ? `${blockerCount}` : "none"}</span>
          </div>
          <div>
            <span className="text-[var(--warn)]">Warnings:</span>{" "}
            <span className="text-[var(--ink-2)]">
              {aggregate.flagged} of {aggregate.total} selected creatives are engine-flagged · weighted ROAS{" "}
              {aggregate.averageRoas == null ? "n/a" : `${aggregate.averageRoas.toFixed(1)}x`}
            </span>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] px-3 py-2 text-[12px] text-[var(--warn)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Everything launches PAUSED and must be activated manually in Meta.
        </div>
      </div>

      <div
        className={`rounded-[10px] border p-4 ${
          aggregate.severe ? "border-[var(--danger-bd)] bg-[var(--danger-bg)]" : "border-[var(--border)] bg-[var(--surface)]"
        }`}
        data-testid="launchpad-engine-aggregate"
      >
        <div className="flex flex-wrap items-center gap-2">
          {aggregate.severe ? <AlertTriangle className="h-4 w-4 text-[var(--danger)]" /> : null}
          <p className="text-[13px] font-semibold text-[var(--ink)]">
            {aggregate.flagged} of {aggregate.total} selected creatives are engine-flagged
          </p>
          <span className="chip">{aggregate.scale} scale</span>
          <span className="chip">{aggregate.cut} cut</span>
          <span className="chip">{aggregate.belowBreakeven} below breakeven</span>
        </div>
        <p className="mt-2 text-[13px] text-[var(--muted)]">
          Weighted ROAS {aggregate.averageRoas == null ? "n/a" : aggregate.averageRoas.toFixed(2)}
        </p>
      </div>

      <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[var(--muted)]" />
          <p className="text-[13px] font-semibold text-[var(--ink)]">Validation</p>
          {validating ? <span className="chip">Checking</span> : null}
          {validation?.ok ? <span className="chip chip--healthy"><span className="dot" />OK</span> : null}
        </div>
        {validation?.blockers.length ? (
          <div className="space-y-2">
            {validation.blockers.map((blocker) => (
              <p key={`${blocker.code}-${blocker.message}`} className="mono text-[12px] text-[var(--danger)]">
                {blocker.code} — {blocker.message}
              </p>
            ))}
          </div>
        ) : null}
        {validation?.warnings.length ? (
          <div className="mt-3 space-y-2">
            {validation.warnings.map((warning) => (
              <p key={`${warning.code}-${warning.message}`} className="text-[12px] text-[var(--warn)]">
                {warning.message}
              </p>
            ))}
          </div>
        ) : null}
        {!validation && !validating ? (
          <p className="text-[13px] text-[var(--muted)]">Validation pending.</p>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
        <div className="border-b border-[var(--border)] px-4 py-3 text-[13px] font-semibold text-[var(--ink)]">Payload preview</div>
        <pre className="mono max-h-[420px] overflow-auto p-4 text-[11px] leading-relaxed text-[var(--ink-2)]">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[11.5px] text-[var(--muted)]">No auto-retry, no auto-rollback — never implied.</span>
        {mode === "new_campaign" && onSaveTemplate ? (
          <button type="button" className="btn" onClick={onSaveTemplate}>
            <Save className="h-4 w-4" />
            Save as template
          </button>
        ) : null}
        {onSaveDraft ? (
          <button type="button" className="btn" onClick={onSaveDraft}>
            <Save className="h-4 w-4" />
            Save draft
          </button>
        ) : null}
        <button type="button" className="btn btn--primary" disabled={launchBlocked} onClick={onLaunch}>
          <Send className="h-4 w-4" />
          Launch (paused)
        </button>
      </div>
    </section>
  );
}
