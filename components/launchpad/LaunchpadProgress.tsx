"use client";

import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";

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
                  {step.status === "success" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--ok)]" />
                  ) : (
                    <XCircle className="h-4 w-4 shrink-0 text-[var(--danger)]" />
                  )}
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
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--brand)] hover:underline"
                  >
                    Ads Manager
                    <ExternalLink className="h-3 w-3" />
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

      {!loading && result && !result.ok && mode !== "manage_existing" ? (
        <div className="rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-3 text-[13px] text-[var(--warn)]">
          Delete partial is deferred — review or remove the created items in Meta Ads Manager. No auto-retry, no auto-rollback.
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
