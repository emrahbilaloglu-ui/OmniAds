"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LaunchpadProgressResult {
  ok: boolean;
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
  const partialHalt = Boolean(result && !result.ok && mode === "new_campaign" && !inFlight);

  return (
    <section className="space-y-5" data-testid="launchpad-progress">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Launch progress</h2>
        <p className="text-[13px] text-[var(--muted)]">Meta entities start paused</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px] text-[var(--ink-2)]">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--muted)]" />
          {mode === "manage_existing"
            ? "Updating selected Meta ads..."
            : mode === "add_to_existing"
              ? "Creating ads in the selected existing ad sets..."
              : "Creating campaign, ad sets, and ads..."}
        </div>
      ) : null}

      {result ? (
        <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
          <div className="border-b border-[var(--border)] px-4 py-3">
            {result.ok ? (
              <p className="text-[14px] font-semibold text-[var(--ok)]">
                {mode === "manage_existing" ? "Ads updated" : "Launch created"}
              </p>
            ) : (
              <p className="text-[14px] font-semibold text-[var(--danger)]">
                {mode === "manage_existing"
                  ? "Bulk ad update completed with failures"
                  : mode === "add_to_existing"
                  ? "Partial add-to-existing launch completed with failures"
                  : `Partial launch stopped at ${result.failedAt ?? "unknown step"}`}
              </p>
            )}
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[12px] text-[var(--muted)] tabular-nums">
              {mode === "manage_existing" ? (
                <>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.successCount ?? 0}</strong> updated
                  <span className="text-[var(--muted-2)]">·</span>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.failedCount ?? 0}</strong> failed
                </>
              ) : mode === "add_to_existing" ? (
                <>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.successCount ?? result.adIds?.length ?? 0}</strong> ads created
                  <span className="text-[var(--muted-2)]">·</span>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.failedCount ?? 0}</strong> failed
                </>
              ) : (
                <>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.adsetIds?.length ?? 0}</strong> ad sets
                  <span className="text-[var(--muted-2)]">·</span>
                  <strong className="text-[16px] font-[650] text-[var(--ink)]">{result.adIds?.length ?? 0}</strong> ads
                </>
              )}
            </p>
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
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--info)] hover:underline"
                  >
                    Ads Manager ↗
                  </a>
                ) : null}
              </div>
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
          Delete partial is deferred — review created items in Meta. New-campaign mode HALTS on failure; add-to-existing and manage continue per item.
        </div>
      ) : null}

      {!loading && result && hasSilentFailure ? (
        <div className="rounded-[8px] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-3 text-[13px] text-[var(--danger)]">
          <b className="font-semibold">silent_failure:</b> the create/update call claimed success, but Meta verification could not find or confirm the entity. Logged to Audit Trail; verify manually before retrying.
        </div>
      ) : null}

      {!loading && result && inFlight ? (
        <div className="rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-3 text-[13px] text-[var(--warn)]">
          <b className="font-semibold">Launch already in flight (409).</b> Another write for this account or entity is running — this one was not started. In-flight guard, not an error to retry blindly.
        </div>
      ) : null}

      <p className="text-[11.5px] text-[var(--muted)]">
        Everything created above is PAUSED. Activate deliberately in Meta Ads Manager.
      </p>

      <div className="flex justify-end">
        <button type="button" className="btn btn--primary" onClick={onDone} disabled={loading}>
          Done
        </button>
      </div>
    </section>
  );
}
