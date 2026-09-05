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
import { formatMoney } from "@/components/meta/redesign/meta-card-utils";
import {
  META_LAUNCHPAD_EXECUTION_LIMITS,
  evaluateMetaLaunchpadExecutionBounds,
} from "@/lib/launchpad/meta-execution-bounds";
import {
  META_LAUNCHPAD_MANUAL_AUTHORITY,
  type MetaLaunchpadManualAuthority,
} from "@/lib/launchpad/meta-manual-authority";

export interface LaunchpadValidationState {
  ok: boolean;
  blockers: LaunchpadIssue[];
  warnings: LaunchpadIssue[];
}

export interface LaunchpadTargetBudgetLine {
  label: string;
  amountMinor: number | null;
  schedule: "daily" | "lifetime" | null;
  source: "campaign" | "ad set" | null;
}

export function buildLaunchpadValidationRequest(input: {
  businessId: string;
  providerAccountId: string;
  payload: MetaLaunchPayload | MetaAddToExistingPayload;
}) {
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    payload: input.payload,
  };
}

export function buildLaunchpadBudgetReview(
  payload: MetaLaunchPayload | MetaAddToExistingPayload,
  currencyCode: string | null,
) {
  if (payload.mode === "add_to_existing" || !("budget" in payload)) {
    return {
      amount: "Inherited",
      detail: "Existing target budget is not changed",
      complete: true,
    };
  }

  if (payload.budget.mode === "CBO") {
    const amountMinor = payload.budget.amountMinor;
    return {
      amount:
        amountMinor == null
          ? "Unavailable"
          : `${formatMoney(amountMinor / 100, currencyCode)}/${payload.budget.schedule === "lifetime" ? "lifetime" : "day"}`,
      detail: `CBO · ${payload.budget.bidStrategy ?? "bid strategy unavailable"}`,
      complete: amountMinor != null && Boolean(currencyCode),
    };
  }

  const amounts = payload.adSets.map(
    (adSet) => adSet.budget?.amountMinor ?? null,
  );
  const complete =
    amounts.length > 0 &&
    amounts.every((amount) => amount != null) &&
    Boolean(currencyCode);
  const totalMinor = amounts.every((amount) => amount != null)
    ? amounts.reduce((sum, amount) => sum + (amount ?? 0), 0)
    : null;
  return {
    amount:
      totalMinor == null
        ? "Unavailable"
        : `${formatMoney(totalMinor / 100, currencyCode)}/day`,
    detail: `ABO total across ${payload.adSets.length} ad set${payload.adSets.length === 1 ? "" : "s"}`,
    complete,
  };
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
    // A creative with no identity has no decision to count; skipping it keeps
    // the tallies about creatives we can actually name.
    const decision = creative.creativeId
      ? input.decisionByCreativeId.get(creative.creativeId)
      : undefined;
    if (decision?.label === "scale") scale += 1;
    if (decision?.label === "cut") cut += 1;
    if (decision?.label === "diagnose") diagnose += 1;
    if (hasBelowBreakeven(decision)) belowBreakeven += 1;
    const spend =
      creative.metricsAvailability === "unavailable"
        ? null
        : (decision?.metrics.spend ?? creative.spend);
    const roas =
      creative.metricsAvailability === "unavailable"
        ? null
        : (decision?.metrics.roas ?? creative.roas);
    if (
      typeof spend === "number" &&
      Number.isFinite(spend) &&
      spend > 0 &&
      typeof roas === "number" &&
      Number.isFinite(roas)
    ) {
      weightedSpend += spend;
      weightedRoasNumerator += spend * roas;
    }
  });

  return {
    total: input.selectedCreatives.length,
    scale,
    cut,
    diagnose,
    belowBreakeven,
    flagged: scale + cut + diagnose + belowBreakeven,
    averageRoas:
      weightedSpend > 0 ? weightedRoasNumerator / weightedSpend : null,
    severe: cut > 0 || diagnose > 0,
  };
}

export function LaunchpadReview({
  mode = "new_campaign",
  businessId,
  providerAccountId,
  payload,
  currencyCode,
  selectedCreatives,
  decisionByCreativeId,
  targetSummary,
  onValidation,
  onSaveTemplate,
  onSaveDraft,
  onLaunch,
  executionBlockedReason = null,
  viewerWriteRefusalReason = null,
}: {
  mode?: "new_campaign" | "add_to_existing";
  businessId: string;
  providerAccountId: string;
  payload: MetaLaunchPayload | MetaAddToExistingPayload;
  currencyCode: string | null;
  selectedCreatives: MetaCreativeRow[];
  decisionByCreativeId: Map<string, DecisionOutput>;
  targetSummary?: {
    campaignName: string | null;
    adsetName: string | null;
    campaignCount?: number | null;
    targetCount?: number | null;
    currentAdCount?: number | null;
    budgetLines?: LaunchpadTargetBudgetLine[];
  } | null;
  onValidation?: (state: LaunchpadValidationState) => void;
  onSaveTemplate?: () => void;
  onSaveDraft?: () => void;
  onLaunch: (authority: MetaLaunchpadManualAuthority) => void;
  executionBlockedReason?: string | null;
  /**
   * Why the *viewer* may not write, decided on the server (reviewer, demo
   * workspace, sub-collaborator role). Distinct from a missing storage
   * capability: when it is set, Save-as-template and Save-draft stay on screen
   * and go disabled with the reason attached, instead of disappearing. A
   * control that vanishes teaches nothing; one that is present and refuses
   * says who may do this and why you may not.
   */
  viewerWriteRefusalReason?: string | null;
}) {
  const [validation, setValidation] = useState<LaunchpadValidationState | null>(
    null,
  );
  const [validating, setValidating] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const aggregate = useMemo(
    () => buildEngineAggregate({ selectedCreatives, decisionByCreativeId }),
    [decisionByCreativeId, selectedCreatives],
  );

  useEffect(() => {
    // Confirmation belongs to the exact payload currently on screen. Changing
    // the business, mode, creatives, targets, or launch settings requires a
    // fresh acknowledgement before a provider write can be requested.
    setAck(false);
  }, [businessId, mode, payload, providerAccountId]);

  useEffect(() => {
    if (!businessId || !providerAccountId) return;
    let cancelled = false;
    setValidating(true);
    fetch("/api/launchpad/meta/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        buildLaunchpadValidationRequest({
          businessId,
          providerAccountId,
          payload,
        }),
      ),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | (LaunchpadValidationState & {
              error?: { code?: string; message?: string };
            })
          | null;
        if (cancelled) return;
        const blockers = Array.isArray(body?.blockers) ? body.blockers : [];
        if ((!response.ok || !body) && blockers.length === 0) {
          blockers.push({
            code: body?.error?.code ?? "validation_unavailable",
            message:
              body?.error?.message ??
              `Validation response unavailable${response.status ? ` (${response.status})` : ""}.`,
          });
        }
        const next = {
          ok: response.ok && Boolean(body?.ok) && blockers.length === 0,
          blockers,
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
              message:
                error instanceof Error ? error.message : "Validation failed.",
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
  }, [businessId, onValidation, payload, providerAccountId]);

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
  const budgetReview = buildLaunchpadBudgetReview(payload, currencyCode);
  const currencyBlocker = mode === "new_campaign" && !currencyCode;
  // The same bounds function both write routes run, evaluated here so the
  // ceiling is visible before the click instead of arriving as a 413 after it.
  const executionBounds = evaluateMetaLaunchpadExecutionBounds(
    mode === "add_to_existing"
      ? {
          operation: "add_to_existing",
          creativeCount: selectedCreatives.length,
          adSetOrTargetCount: targetCount,
          copyMode: addToExistingCopyMode ?? undefined,
        }
      : {
          operation: "new_campaign",
          creativeCount: selectedCreatives.length,
          adSetOrTargetCount: newCampaignAdSetCount,
        },
  );
  const blockerCount =
    (validation?.blockers.length ?? 0) +
    (currencyBlocker ? 1 : 0) +
    (executionBlockedReason ? 1 : 0) +
    executionBounds.blockers.length;
  const reviewBlocked =
    launchBlocked ||
    currencyBlocker ||
    Boolean(executionBlockedReason) ||
    !executionBounds.ok;
  // Split from `reviewBlocked` because the acknowledgement is the operator's
  // own step, while everything in `reviewBlocked` is the product refusing. Both
  // stop the click; only the second gets a sentence.
  const blockedFromLaunch = reviewBlocked || !ack;
  const executionBlockedReasonId = "launchpad-execution-blocked-reason";
  const selectedSpend = selectedCreatives.every(
    (creative) =>
      creative.metricsAvailability !== "unavailable" &&
      Number.isFinite(creative.spend),
  )
    ? selectedCreatives.reduce((sum, creative) => sum + creative.spend, 0)
    : null;

  return (
    <section className="space-y-5" data-testid="launchpad-review">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
          Review
        </h2>
        <p className="text-[13px] text-[var(--muted)]">
          {mode === "add_to_existing"
            ? "Ads will be added to the existing ad set and start paused"
            : "Campaign, ad sets, and ads will be created PAUSED"}
        </p>
      </div>

      {mode === "add_to_existing" ? (
        <div
          className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4"
          data-testid="launchpad-mode-b-review-copy"
        >
          <p className="text-[13px] font-semibold text-[var(--ink)]">
            {targetCount > 1
              ? `${selectedCreatives.length} creatives -> ${targetCount} existing ad sets across ${campaignCount} campaigns`
              : `${selectedCreatives.length} creatives -> existing ad set ${
                  targetSummary?.adsetName ?? "selected ad set"
                } under campaign ${targetSummary?.campaignName ?? "selected campaign"}`}
          </p>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            {targetCount > 1 ? "Selected ad sets" : "The ad set"} will inherit
            pixel, attribution, targeting, and budget settings.
            {targetSummary?.currentAdCount != null && afterLaunchCount != null
              ? ` Current ads: ${targetSummary.currentAdCount}; after launch: ${afterLaunchCount}.`
              : ""}
            {addToExistingCopyMode
              ? ` Creative copy: ${addToExistingCopyMode === "reuse_creative" ? "duplicate" : "recreate exact ad"}.`
              : ""}
          </p>
        </div>
      ) : null}

      <div
        className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4"
        data-testid="launchpad-review-checklist"
      >
        <p className="text-[13px] font-semibold text-[var(--ink)]">
          Human-readable checklist — first, always
        </p>
        {mode === "new_campaign" ? (
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <p className="text-[11.5px] text-[var(--muted)]">Campaigns</p>
              <p className="mt-0.5 text-[26px] font-[650] leading-none tracking-[-0.02em] tabular-nums text-[var(--ink)]">
                1
              </p>
            </div>
            <div>
              <p className="text-[11.5px] text-[var(--muted)]">Ad sets</p>
              <p className="mt-0.5 text-[26px] font-[650] leading-none tracking-[-0.02em] tabular-nums text-[var(--ink)]">
                {newCampaignAdSetCount}
              </p>
            </div>
            <div>
              <p className="text-[11.5px] text-[var(--muted)]">Ads</p>
              <p className="mt-0.5 text-[26px] font-[650] leading-none tracking-[-0.02em] tabular-nums text-[var(--ink)]">
                {newCampaignAdCount}
              </p>
            </div>
            <div>
              <p className="text-[11.5px] text-[var(--muted)]">Budget</p>
              <p className="mt-0.5 text-[15px] font-[650] leading-tight tabular-nums text-[var(--ink)]">
                {budgetReview.amount}
              </p>
              <p className="mt-1 text-[10.5px] text-[var(--muted)]">
                {budgetReview.detail}
              </p>
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
            <span className="text-[var(--ink-2)]">
              any existing campaign, budget, or bid
            </span>
          </div>
          <div>
            <span
              className={
                blockerCount > 0
                  ? "text-[var(--danger)]"
                  : "text-[var(--muted)]"
              }
            >
              Blocked:
            </span>{" "}
            <span className="text-[var(--ink-2)]">
              {blockerCount > 0 ? `${blockerCount}` : "none"}
            </span>
          </div>
          <div>
            <span className="text-[var(--warn)]">Warnings:</span>{" "}
            <span className="text-[var(--ink-2)]">
              {aggregate.flagged} of {aggregate.total} selected creatives are
              engine-flagged · selected spend{" "}
              {formatMoney(selectedSpend, currencyCode)} · weighted ROAS{" "}
              {aggregate.averageRoas == null
                ? "unavailable"
                : `${aggregate.averageRoas.toFixed(1)}x`}
            </span>
          </div>
        </div>
        <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] px-3 py-2 text-[12px] text-[var(--warn)]">
          <input
            type="checkbox"
            checked={ack}
            onChange={(event) => setAck(event.target.checked)}
            className="h-3.5 w-3.5 shrink-0"
          />
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Create PAUSED changes Meta provider state and cannot begin delivery.
          Publishing is a separate step you take afterwards, from the receipt.
        </label>
      </div>

      {mode === "add_to_existing" ? (
        <div
          className="border-y border-[var(--border)] bg-[var(--surface)] py-3"
          data-testid="launchpad-existing-budget-review"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] font-semibold text-[var(--ink)]">
              Existing budget · read-only
            </p>
            <span className="chip chip--ghost">Will not change</span>
          </div>
          {targetSummary?.budgetLines?.length ? (
            <div className="mt-2 divide-y divide-[var(--border)]">
              {targetSummary.budgetLines.map((line) => (
                <div
                  key={line.label}
                  className="flex items-start justify-between gap-4 py-2 text-[11.5px]"
                >
                  <span className="min-w-0 truncate text-[var(--muted)]">
                    {line.label}
                  </span>
                  <strong className="shrink-0 text-right font-semibold text-[var(--ink)]">
                    {line.amountMinor == null
                      ? "Amount unavailable"
                      : `${formatMoney(line.amountMinor / 100, currencyCode)}/${
                          line.schedule === "daily"
                            ? "day"
                            : line.schedule === "lifetime"
                              ? "lifetime"
                              : "schedule unavailable"
                        }`}
                    <span className="ml-1 font-normal text-[var(--muted)]">
                      · {line.source ?? "source unavailable"}
                    </span>
                  </strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[11.5px] text-[var(--muted)]">
              Budget amount unavailable in the selected-target read contract.
            </p>
          )}
        </div>
      ) : null}

      <div
        className={`rounded-[10px] border p-4 ${
          aggregate.severe
            ? "border-[var(--danger-bd)] bg-[var(--danger-bg)]"
            : "border-[var(--border)] bg-[var(--surface)]"
        }`}
        data-testid="launchpad-engine-aggregate"
      >
        <div className="flex flex-wrap items-center gap-2">
          {aggregate.severe ? (
            <AlertTriangle className="h-4 w-4 text-[var(--danger)]" />
          ) : null}
          <p className="text-[13px] font-semibold text-[var(--ink)]">
            {aggregate.flagged} of {aggregate.total} selected creatives are
            engine-flagged
          </p>
          <span className="chip">{aggregate.scale} scale</span>
          <span className="chip">{aggregate.cut} cut</span>
          <span className="chip">
            {aggregate.belowBreakeven} below breakeven
          </span>
        </div>
        <p className="mt-2 text-[13px] text-[var(--muted)]">
          Weighted ROAS{" "}
          {aggregate.averageRoas == null
            ? "n/a"
            : aggregate.averageRoas.toFixed(2)}
        </p>
      </div>

      <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[var(--muted)]" />
          <p className="text-[13px] font-semibold text-[var(--ink)]">
            Validation
          </p>
          {validating ? <span className="chip">Checking</span> : null}
          {validation?.ok && !currencyBlocker ? (
            <span className="chip chip--healthy">
              <span className="dot" />
              OK
            </span>
          ) : null}
          {currencyBlocker ? (
            <span className="chip chip--action">
              <span className="dot" />
              Blocked
            </span>
          ) : null}
        </div>
        {currencyBlocker ? (
          <p className="mono mb-2 text-[12px] text-[var(--danger)]">
            currency_unavailable — Account currency is unavailable, so real
            budget math cannot be confirmed.
          </p>
        ) : null}
        {validation?.blockers.length ? (
          <div className="space-y-2">
            {validation.blockers.map((blocker) => (
              <p
                key={`${blocker.code}-${blocker.message}`}
                className="mono text-[12px] text-[var(--danger)]"
              >
                {blocker.code} — {blocker.message}
              </p>
            ))}
          </div>
        ) : null}
        {validation?.warnings.length ? (
          <div className="mt-3 space-y-2">
            {validation.warnings.map((warning) => (
              <p
                key={`${warning.code}-${warning.message}`}
                className="text-[12px] text-[var(--warn)]"
              >
                {warning.message}
              </p>
            ))}
          </div>
        ) : null}
        {!validation && !validating ? (
          <p className="text-[13px] text-[var(--muted)]">
            Validation unavailable until the server returns a result.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <button
          type="button"
          className="btn btn--sm mono"
          onClick={() => setJsonOpen((open) => !open)}
          aria-expanded={jsonOpen}
        >
          {jsonOpen ? "▾" : "▸"} raw launch JSON
        </button>
        {jsonOpen ? (
          <pre className="mono max-h-[420px] overflow-auto rounded-[8px] border border-[var(--border)] bg-[var(--bg)] p-3 text-[11px] leading-relaxed text-[var(--ink-2)]">
            {JSON.stringify(payload, null, 2)}
          </pre>
        ) : null}
      </div>

      {/*
        Activation, described as the separate step it is.

        This panel used to say no activation executor was wired and list the
        contract one "would" need — create paused, verify every child, run a
        fresh preflight, order the writes. That executor exists now, and it
        does those things, so the honest sentence is where the step happens
        rather than that it cannot.

        It is deliberately NOT a button here. This panel is shown before the
        launch, and nothing exists to activate yet: activating belongs to the
        receipt, once there are real identities to read back.
      */}
      <div className="border-y border-[var(--border)] bg-[var(--surface)] px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-semibold text-[var(--ink)]">
            Everything is created paused
          </span>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--muted)]">
          Publishing is a separate, deliberate step you take from the receipt
          once this launch has real identities to check. It activates the
          campaign, then the ad set, then the ad, reading each one back before
          the next — and stops at the first step that does not come back
          active rather than reporting an ad as live under a paused parent.
        </p>
      </div>

      {/*
        The fan-out one confirmed click would produce, and the ceiling it is
        measured against, stated before the click rather than discovered as a
        413 after it. `evaluateMetaLaunchpadExecutionBounds` is the same
        function both write routes run, so this is the server's arithmetic
        restated — not a second copy of the rule that could drift from it.
      */}
      <div
        className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
        data-testid="launchpad-execution-bounds"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] font-semibold text-[var(--ink)]">
            Execution size
          </span>
          <span
            className="text-[11.5px] text-[var(--muted)]"
            data-field="planned-provider-creates"
          >
            {executionBounds.counts.plannedProviderCreates} of{" "}
            {META_LAUNCHPAD_EXECUTION_LIMITS.maxPlannedProviderCreates} planned
            provider creates
          </span>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--muted)]">
          {executionBounds.counts.creatives} of{" "}
          {META_LAUNCHPAD_EXECUTION_LIMITS.maxCreatives} creatives ·{" "}
          {executionBounds.counts.adSetsOrTargets} of{" "}
          {mode === "add_to_existing"
            ? `${META_LAUNCHPAD_EXECUTION_LIMITS.maxTargets} targets`
            : `${META_LAUNCHPAD_EXECUTION_LIMITS.maxAdSets} ad sets`}
        </p>
        {executionBounds.blockers.map((blocker) => (
          <p
            key={blocker.code}
            className="mt-1 text-[11.5px] font-medium text-[var(--danger)]"
            data-field={`bound-${blocker.code}`}
          >
            {blocker.message}
          </p>
        ))}
      </div>

      {executionBlockedReason ? (
        <div
          id={executionBlockedReasonId}
          className="rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] px-3 py-2 text-[12px] text-[var(--danger)]"
          role="alert"
        >
          {executionBlockedReason}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[11.5px] text-[var(--muted)]">
          No undo, rollback, or retry control is available.
        </span>
        {mode === "new_campaign" && (onSaveTemplate || viewerWriteRefusalReason) ? (
          <button
            type="button"
            className="btn"
            disabled={Boolean(viewerWriteRefusalReason) || !onSaveTemplate}
            title={viewerWriteRefusalReason ?? undefined}
            onClick={onSaveTemplate}
          >
            <Save className="h-4 w-4" />
            Save as template
          </button>
        ) : null}
        {onSaveDraft || viewerWriteRefusalReason ? (
          <button
            type="button"
            className="btn"
            disabled={Boolean(viewerWriteRefusalReason) || !onSaveDraft}
            title={viewerWriteRefusalReason ?? undefined}
            onClick={onSaveDraft}
          >
            <Save className="h-4 w-4" />
            Save draft
          </button>
        ) : null}
        {/*
          `aria-disabled`, not `disabled`.

          A `disabled` button is removed from the tab order, so a keyboard or
          screen-reader user reaches the end of the wizard and finds nothing
          there — the control and its reason are both unreachable, which is
          indistinguishable from the feature not existing. `aria-disabled` keeps
          it focusable and announced as unavailable, `aria-describedby` ties it
          to the sentence saying why, and the click handler refuses on the same
          condition so the control is inert in fact and not only in appearance.
        */}
        <button
          type="button"
          className="btn btn--primary"
          aria-disabled={blockedFromLaunch}
          aria-describedby={
            executionBlockedReason ? executionBlockedReasonId : undefined
          }
          data-testid="launchpad-create-paused"
          data-blocked={blockedFromLaunch ? "true" : "false"}
          title={executionBlockedReason ?? undefined}
          onClick={() => {
            if (blockedFromLaunch) return;
            onLaunch({ ...META_LAUNCHPAD_MANUAL_AUTHORITY });
          }}
        >
          <Send className="h-4 w-4" />
          Create PAUSED
        </button>
      </div>
    </section>
  );
}
