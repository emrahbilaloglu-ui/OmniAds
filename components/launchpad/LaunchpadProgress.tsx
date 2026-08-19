"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

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
  onDone,
}: {
  mode?: "new_campaign" | "add_to_existing" | "manage_existing";
  loading: boolean;
  result: LaunchpadProgressResult | null;
  onDone: () => void;
}) {
  const steps = result?.steps ?? [];
  const hasSilentFailure = Boolean(
    result?.error?.code === "silent_failure" ||
      steps.some((step) => step.status === "silent_failure" || step.error?.code === "silent_failure"),
  );
  const inFlight =
    result?.error?.code === "launch_in_flight" ||
    result?.error?.code === "action_in_flight";
  const validationBlocked = result?.error?.code === "validation_blocked";
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
    result && !result.ok && mode === "new_campaign" && !inFlight && !validationBlocked && hasCreatedEvidence,
  );
  const hasProviderLinks = steps.some((step) => Boolean(step.adsManagerUrl));

  return (
    <section className="space-y-5" data-testid="launchpad-progress">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Launch progress</h2>
        <p className="text-[13px] text-[var(--muted)]">Completed route response · provider objects remain PAUSED</p>
      </div>

      {loading ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px] text-[var(--ink-2)]">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--muted)]" />
          {mode === "manage_existing"
            ? "Submitting the guarded pause request..."
            : mode === "add_to_existing"
              ? "Submitting PAUSED ad creation to the selected ad sets..."
              : "Submitting PAUSED campaign, ad set, and ad creation..."}
          <span className="text-[11px] text-[var(--muted)]">No simulated per-object progress is available.</span>
        </div>
      ) : null}

      {result ? (
        <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
          <div className="border-b border-[var(--border)] px-4 py-3">
            {result.ok ? (
              <p className="text-[14px] font-semibold text-[var(--ok)]">
                {mode === "manage_existing" ? "Pause update verified" : "PAUSED create verified"}
              </p>
            ) : (
              <p className="text-[14px] font-semibold text-[var(--danger)]">
                {inFlight
                  ? "Write not started"
                  : validationBlocked
                    ? "Write blocked by validation"
                    : mode === "manage_existing"
                  ? "Bulk ad update completed with failures"
                  : mode === "add_to_existing"
                  ? "Partial add-to-existing launch completed with failures"
                  : `Partial launch stopped at ${result.failedAt ?? "unknown step"}`}
              </p>
            )}
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[12px] text-[var(--muted)] tabular-nums">
              {(inFlight || validationBlocked) && !hasCreatedEvidence ? (
                // The server said the write never started, so "none" is a fact.
                <span>No provider objects reported.</span>
              ) : !reportedCounts && !hasCreatedEvidence ? (
                // Nothing came back to count. The outcome is unknown, not zero.
                <span>Provider objects not reported.</span>
              ) : mode === "manage_existing" ? (
                <>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.successCount ?? "—"}</strong> updated
                  <span className="text-[var(--muted-2)]">·</span>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.failedCount ?? "—"}</strong> failed
                </>
              ) : mode === "add_to_existing" ? (
                <>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.successCount ?? result.adIds?.length ?? "—"}</strong> ads created
                  <span className="text-[var(--muted-2)]">·</span>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.failedCount ?? "—"}</strong> failed
                </>
              ) : (
                <>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.adsetIds?.length ?? "—"}</strong> ad sets
                  <span className="text-[var(--muted-2)]">·</span>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.adIds?.length ?? "—"}</strong> ads
                </>
              )}
            </p>
            {result.launchIntentId ? (
              <div
                className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-[var(--muted)]"
                data-testid="launchpad-intent-receipt"
              >
                <span>Launch record</span>
                <strong className="font-semibold text-[var(--ink)]">
                  {result.launchIntentId}
                </strong>
                <span>status {result.launchIntentStatus ?? "unavailable"}</span>
              </div>
            ) : (
              <p className="mt-2 text-[10.5px] text-[var(--warn)]">
                Launch record unavailable for this response.
              </p>
            )}
          </div>
          <div className="divide-y divide-[var(--border)]">
            {steps.map((step) => (
              <div key={`${step.kind}-${step.index}-${step.id ?? step.name}`} className="flex items-center justify-between gap-3 px-4 py-3">
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
                      {step.kind} · {step.name}
                    </p>
                    {step.error ? (
                      <p className="mono text-[11px] text-[var(--danger)]">{step.error.code} — {step.error.message}</p>
                    ) : (
                      <p className="mono text-[11px] text-[var(--muted)]">{step.id ?? "pending"}</p>
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
                    Open Ads Manager · link built from provider-returned ID ↗
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!loading && result?.blockers?.length ? (
        <div className="rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3">
          <p className="text-[12px] font-semibold text-[var(--danger)]">Write-time validation blocked the request</p>
          <div className="mt-2 space-y-1.5">
            {result.blockers.map((blocker) => (
              <p key={`${blocker.code}-${blocker.message}`} className="mono text-[11px] text-[var(--danger)]">
                {blocker.code} — {blocker.message}
              </p>
            ))}
          </div>
        </div>
      ) : null}

      {!loading && result && !result.ok && result.error ? (
        <div className="rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3 text-[12px] text-[var(--danger)]">
          <span className="mono font-semibold">{result.error.code}</span> — {result.error.message}
        </div>
      ) : null}

      {!loading && partialHalt ? (
        <div className="rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-3 text-[13px] text-[var(--warn)]">
          <b className="font-semibold">Partial launch stopped at {result?.failedAt ?? "the failed step"}.</b>{" "}
          New-campaign mode halts on the first failed object. No automatic rollback or delete-partial contract exists; reconcile the provider-returned IDs before any new submission.
        </div>
      ) : null}

      {!loading && result && hasSilentFailure ? (
        <div className="rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3 text-[13px] text-[var(--danger)]">
          <b className="font-semibold">silent_failure:</b> the provider call returned success, but verification could not confirm the entity. The outcome is unknown. No retry control is available; reconcile in Meta and Audit Trail first.
        </div>
      ) : null}

      {!loading && result && inFlight ? (
        <div className="rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-3 text-[13px] text-[var(--warn)]">
          <b className="font-semibold">Launch already in flight (409).</b> Another write for this account or entity is running, so this request was not started. No retry action is rendered while the outcome is unresolved.
        </div>
      ) : null}

      {hasProviderLinks ? (
        <p className="text-[11.5px] text-[var(--muted)]">
          Ads Manager navigation links are built from provider-returned IDs. They are not represented as verified permalinks.
        </p>
      ) : null}

      <div className="border-y border-[var(--warn-bd)] bg-[var(--warn-bg)] px-3 py-3 text-[11.5px] leading-relaxed text-[var(--muted)]">
        <span className="font-semibold text-[var(--warn)]">Publish ACTIVE · Proposed/contract required.</span>{" "}
        Everything created above remains PAUSED. No activation, undo, rollback, or retry control is available in this receipt.
      </div>

      <div className="flex justify-end">
        <button type="button" className="btn btn--primary" onClick={onDone} disabled={loading}>
          Done
        </button>
      </div>
    </section>
  );
}
