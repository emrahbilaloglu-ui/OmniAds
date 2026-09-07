"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { launchpadIssueRemedies } from "@/components/launchpad/LaunchpadReview";

interface LaunchpadHaltedReason {
  code?: string;
  message?: string;
  reconciliationRequired?: boolean;
  retryAllowed?: boolean | null;
}

export interface LaunchpadProgressResult {
  ok: boolean;
  launchIntentId?: string | null;
  launchIntentStatus?: string | null;
  action?: "pause" | "resume";
  campaignId?: string | null;
  targetCampaignId?: string | null;
  targetAdsetId?: string | null;
  targets?: Array<{
    targetCampaignId: string;
    targetAdsetId: string;
    targetCampaignName?: string | null;
    targetAdsetName?: string | null;
  }>;
  adsetIds?: string[];
  adIds?: string[];
  successCount?: number;
  failedCount?: number;
  failedAt?: string;
  halted?: boolean;
  haltedReason?: LaunchpadHaltedReason | null;
  reconciliationRequired?: boolean;
  retryAllowed?: boolean | null;
  error?: { code: string; message: string };
  blockers?: Array<{ code: string; message: string }>;
  warnings?: Array<{ code: string; message: string }>;
  steps?: Array<{
    kind: "campaign" | "adset" | "ad";
    index: number;
    name: string;
    status: "pending" | "success" | "failure" | "silent_failure";
    id?: string;
    creativeId?: string;
    adsManagerUrl?: string;
    error?: { code: string; message: string };
  }>;
}

export function LaunchpadProgress({
  mode = "new_campaign",
  loading,
  result,
  activation,
  onDone,
}: {
  mode?: "new_campaign" | "add_to_existing" | "manage_existing";
  loading: boolean;
  result: LaunchpadProgressResult | null;
  /**
   * The activation control, for a receipt that can actually be activated.
   *
   * Supplied by the mount rather than built here: this component knows what
   * the route answered, and only the page knows the business, the viewer and
   * the intent's standing approval. When the receipt is not activatable the
   * slot is ignored and the flat sentence below stands, because for that
   * receipt the sentence is still true.
   */
  activation?: ReactNode;
  onDone: () => void;
}) {
  const steps = result?.steps ?? [];
  const hasSilentFailure = Boolean(
    result?.error?.code === "silent_failure" ||
    steps.some(
      (step) =>
        step.status === "silent_failure" ||
        step.error?.code === "silent_failure",
    ),
  );
  const inFlight =
    result?.error?.code === "launch_in_flight" ||
    result?.error?.code === "action_in_flight";
  const validationBlocked = result?.error?.code === "validation_blocked";
  const reconciliationRequired = Boolean(
    result?.reconciliationRequired === true ||
    result?.retryAllowed === false ||
    result?.haltedReason?.reconciliationRequired === true ||
    result?.haltedReason?.retryAllowed === false,
  );
  const hasCreatedEvidence = Boolean(
    result?.campaignId ||
    result?.adsetIds?.length ||
    result?.adIds?.length ||
    steps.some((step) => step.status === "success" && step.id),
  );
  /**
   * Did the response actually carry object evidence?
   *
   * A transport failure after the POST reached the server, and a countless
   * server refusal, both arrive here with no counts and no id arrays. Printing
   * `0` for them asserts that nothing was created at the exact moment the
   * client cannot know — and an operator who reads "0 ad sets · 0 ads" may
   * resubmit and duplicate whatever really landed. An unsupplied count renders
   * as an em-dash instead.
   */
  const reportedCounts =
    result?.successCount != null ||
    result?.failedCount != null ||
    result?.adsetIds != null ||
    result?.adIds != null;
  const partialHalt = Boolean(
    result &&
    !result.ok &&
    mode === "new_campaign" &&
    !inFlight &&
    !validationBlocked &&
    hasCreatedEvidence,
  );
  /**
   * Can this receipt be activated at all?
   *
   * Only a launch that recorded an intent and finished with entities in the
   * account can be turned on — `activateLaunchIntent` refuses anything else
   * with `intent_not_succeeded`. A silent failure did not prove that anything
   * exists, so the flat sentence below is still the truth for it, and swapping
   * in a control there would offer to activate an outcome nobody can name.
   */
  const activatable = Boolean(
    activation &&
    result?.launchIntentId &&
    (result.launchIntentStatus === "succeeded" ||
      result.launchIntentStatus === "partially_succeeded"),
  );
  const countSummary = (() => {
    if (inFlight && !hasCreatedEvidence) {
      return "The final item count is pending.";
    }
    if (validationBlocked && !hasCreatedEvidence) {
      return "No items were created.";
    }
    if (!reportedCounts && !hasCreatedEvidence) {
      return "The final item count is unavailable.";
    }

    const parts: string[] = [];
    if (mode === "manage_existing") {
      if (result?.successCount != null)
        parts.push(`${result.successCount} updated`);
      if (result?.failedCount != null)
        parts.push(`${result.failedCount} failed`);
    } else if (mode === "add_to_existing") {
      const created = result?.successCount ?? result?.adIds?.length;
      if (created != null) parts.push(`${created} ads created`);
      if (result?.failedCount != null)
        parts.push(`${result.failedCount} failed`);
    } else {
      if (result?.adsetIds) parts.push(`${result.adsetIds.length} ad sets`);
      if (result?.adIds) parts.push(`${result.adIds.length} ads`);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  })();

  return (
    <section className="space-y-5" data-testid="launchpad-progress">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
          Launch result
        </h2>
      </div>

      {loading ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px] text-[var(--ink-2)]">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--muted)]" />
          {mode === "manage_existing"
            ? "Updating selected ads..."
            : mode === "add_to_existing"
              ? "Creating paused ads..."
              : "Creating a paused campaign..."}
        </div>
      ) : null}

      {result ? (
        <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
          <div className="border-b border-[var(--border)] px-4 py-3">
            {result.ok &&
            result.launchIntentStatus !== "partially_succeeded" ? (
              <p className="text-[14px] font-semibold text-[var(--ok)]">
                {mode === "manage_existing"
                  ? "Update complete"
                  : "Created and paused"}
              </p>
            ) : result.launchIntentStatus === "partially_succeeded" ? (
              <p className="text-[14px] font-semibold text-[var(--warn)]">
                Partially created
              </p>
            ) : (
              <p className="text-[14px] font-semibold text-[var(--danger)]">
                {inFlight
                  ? "Another change is still running"
                  : validationBlocked
                    ? "Launch could not start"
                    : mode === "manage_existing"
                      ? "Some ads could not be updated"
                      : mode === "add_to_existing"
                        ? "Some ads could not be created"
                        : "Launch stopped before completion"}
              </p>
            )}
            {countSummary ? (
              <p className="mt-1 text-[12px] text-[var(--muted)] tabular-nums">
                {countSummary}
              </p>
            ) : null}
          </div>
          <div className="divide-y divide-[var(--border)]">
            {steps.map((step) => (
              <div
                key={`${step.kind}-${step.index}-${step.id ?? step.name}`}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      step.status === "success"
                        ? "bg-[var(--ok)]"
                        : step.status === "pending"
                          ? "animate-pulse bg-[var(--warn)]"
                          : step.status === "silent_failure"
                            ? "bg-[var(--danger)]"
                            : "bg-[var(--danger)]",
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-[var(--ink)]">
                      {step.kind === "adset" ? "Ad set" : step.kind} ·{" "}
                      {step.name}
                    </p>
                    {step.error ? (
                      <p className="text-[11px] text-[var(--danger)]">
                        This item could not be completed.
                      </p>
                    ) : (
                      <p className="text-[11px] text-[var(--muted)]">
                        {step.status === "success" ? "Complete" : "Pending"}
                      </p>
                    )}
                  </div>
                </div>
                {step.adsManagerUrl ? (
                  <a
                    href={step.adsManagerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-[220px] shrink-0 items-center gap-1 text-right text-[11px] leading-tight text-[var(--info)] hover:underline"
                  >
                    Open in Ads Manager ↗
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!loading && result?.blockers?.length ? (
        <div className="rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3">
          <p className="text-[12px] font-semibold text-[var(--danger)]">
            Launch could not start
          </p>
          <ul className="mt-2 space-y-1 text-[11px] text-[var(--danger)]">
            {launchpadIssueRemedies(result.blockers).map((remedy) => (
              <li key={remedy}>{remedy}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!loading && result && reconciliationRequired ? (
        <div className="rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-3 text-[13px] text-[var(--warn)]">
          <b className="font-semibold">Confirm the result before continuing.</b>{" "}
          Check History and Meta Ads. Do not retry this change.
        </div>
      ) : null}

      {!loading &&
      result &&
      !result.ok &&
      result.error &&
      !inFlight &&
      !validationBlocked &&
      !reconciliationRequired &&
      !hasSilentFailure ? (
        <div className="rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3 text-[12px] text-[var(--danger)]">
          The change could not be completed. Review the campaign and try again.
        </div>
      ) : null}

      {!loading && partialHalt && !reconciliationRequired ? (
        <div className="rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-3 text-[13px] text-[var(--warn)]">
          <b className="font-semibold">
            Some items were created before the launch stopped.
          </b>{" "}
          Review them in Ads Manager before trying again.
        </div>
      ) : null}

      {!loading && result && hasSilentFailure && !reconciliationRequired ? (
        <div className="rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3 text-[13px] text-[var(--danger)]">
          <b className="font-semibold">Meta did not confirm the final state.</b>{" "}
          Check Ads Manager before trying again.
        </div>
      ) : null}

      {!loading && result && inFlight ? (
        <div className="rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-3 text-[13px] text-[var(--warn)]">
          <b className="font-semibold">Another change is still running.</b> Wait
          for it to finish before trying again.
        </div>
      ) : null}

      {activatable ? (
        activation
      ) : hasCreatedEvidence ? (
        <div className="border-y border-[var(--warn-bd)] bg-[var(--warn-bg)] px-3 py-3 text-[11.5px] leading-relaxed text-[var(--muted)]">
          <span className="font-semibold text-[var(--warn)]">
            Created items remain paused.
          </span>
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          type="button"
          className="btn btn--primary"
          onClick={onDone}
          disabled={loading}
        >
          Done
        </button>
      </div>
    </section>
  );
}
