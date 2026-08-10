"use client";

import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import { resolveGoogleIntegrationProgress } from "@/lib/google-ads/integration-progress";
import type { MetaUiLanguage } from "@/lib/meta/ui-status";
import { cn } from "@/lib/utils";

export function GoogleIntegrationProgress({
  status,
  language = "en",
  className,
}: {
  status: GoogleAdsStatusResponse | undefined | null;
  language?: MetaUiLanguage;
  className?: string;
}) {
  const progress = resolveGoogleIntegrationProgress(status, language);
  if (!progress) return null;

  return (
    <div
      className={cn(
        "mt-2 rounded-lg border border-neutral-200/70 bg-white/70 px-2.5 py-2",
        className,
      )}
      data-testid="google-integration-progress"
    >
      <div className="space-y-2">
        {progress.stages.map((stage, index) => (
          <div
            key={stage.key}
            className={cn(
              "space-y-1.5",
              index > 0 && "border-t border-neutral-200/70 pt-2",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {stage.title}
                </p>
                <p className="mt-1 text-[12px] font-medium leading-4 text-foreground">
                  {stage.detail}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {typeof stage.percent === "number" ? (
                  <span className="text-[12px] font-semibold tabular-nums text-muted-foreground">
                    {stage.percent}%
                  </span>
                ) : null}
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[12px] font-semibold capitalize",
                    stage.state === "ready" &&
                      "border-emerald-200 bg-emerald-50 text-emerald-700",
                    stage.state === "working" &&
                      "border-sky-200 bg-sky-50 text-sky-700",
                    stage.state === "waiting" &&
                      "border-neutral-200 bg-neutral-50 text-neutral-700",
                    stage.state === "blocked" &&
                      "border-amber-200 bg-amber-50 text-amber-800",
                  )}
                >
                  {stage.label}
                </span>
              </div>
            </div>
            {stage.evidence ? (
              <p className="text-[12px] leading-4 text-muted-foreground">
                {stage.evidence}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
