"use client";

import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface LaunchpadProgressResult {
  ok: boolean;
  campaignId?: string | null;
  targetCampaignId?: string | null;
  targetAdsetId?: string | null;
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
  mode?: "new_campaign" | "add_to_existing";
  loading: boolean;
  result: LaunchpadProgressResult | null;
  onDone: () => void;
}) {
  const steps = result?.steps ?? [];

  return (
    <section className="space-y-5" data-testid="launchpad-progress">
      <div>
        <h2 className="text-lg font-semibold">Launch progress</h2>
        <p className="text-sm text-muted-foreground">Meta entities start paused</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 rounded-md border p-4 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {mode === "add_to_existing"
            ? "Creating ads in the existing ad set..."
            : "Creating campaign, ad sets, and ads..."}
        </div>
      ) : null}

      {result ? (
        <div className="rounded-md border">
          <div className="border-b px-4 py-3">
            {result.ok ? (
              <p className="font-semibold text-emerald-700">Launch created</p>
            ) : (
              <p className="font-semibold text-rose-700">
                {mode === "add_to_existing"
                  ? "Partial add-to-existing launch completed with failures"
                  : `Partial launch stopped at ${result.failedAt ?? "unknown step"}`}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {mode === "add_to_existing"
                ? `${result.successCount ?? result.adIds?.length ?? 0} ads created / ${result.failedCount ?? 0} failed`
                : `${result.adsetIds?.length ?? 0} ad sets / ${result.adIds?.length ?? 0} ads`}
            </p>
          </div>
          <div className="divide-y">
            {steps.map((step) => (
              <div key={`${step.kind}-${step.index}-${step.id ?? step.name}`} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  {step.status === "success" ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <XCircle className="h-4 w-4 text-rose-600" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {step.kind} - {step.name}
                    </p>
                    {step.error ? (
                      <p className="text-xs text-rose-700">{step.error.message}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">{step.id ?? "pending"}</p>
                    )}
                  </div>
                </div>
                {step.adsManagerUrl ? (
                  <a
                    href={step.adsManagerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary"
                  >
                    Meta
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!loading && result && !result.ok ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Delete partial is deferred. Review or remove the created items in Meta Ads Manager.
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button type="button" onClick={onDone} disabled={loading}>
          Done
        </Button>
      </div>
    </section>
  );
}
