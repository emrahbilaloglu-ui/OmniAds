"use client";

import type { MetaStatusResponse } from "@/lib/meta/status-types";
import { resolveMetaIntegrationProgress } from "@/lib/meta/integration-progress";
import type { MetaUiLanguage } from "@/lib/meta/ui-status";
import type { ProviderSecondaryReadiness } from "@/lib/sync/provider-status-truth";
import { cn } from "@/lib/utils";

function getSecondaryReadinessTitle(
  item: ProviderSecondaryReadiness,
  language: MetaUiLanguage
) {
  if (item.key === "creatives_preview") {
    return language === "tr" ? "Kreatif önizlemeler" : "Creative previews";
  }
  return item.key.replace(/_/g, " ");
}

function getSecondaryReadinessLabel(
  item: ProviderSecondaryReadiness,
  language: MetaUiLanguage
) {
  if (item.state === "ready") return language === "tr" ? "hazır" : "ready";
  if (item.state === "blocked") return language === "tr" ? "bloklu" : "blocked";
  return language === "tr" ? "kısmi" : "partial";
}

export function MetaIntegrationProgress({
  status,
  language = "en",
  className,
}: {
  status: MetaStatusResponse | undefined | null;
  language?: MetaUiLanguage;
  className?: string;
}) {
  const progress = resolveMetaIntegrationProgress(status, language);
  if (!progress) return null;
  const secondaryReadiness =
    status?.operations?.secondaryReadiness?.filter((item) => item.state !== "ready") ?? [];

  return (
    <div
      className={cn(
        "mt-2 rounded-lg border border-neutral-200/70 bg-white/70 px-2.5 py-2",
        className
      )}
      data-testid="meta-integration-progress"
    >
      <div className="space-y-2">
        {progress.stages.map((stage, index) => (
          <div
            key={stage.key}
            className={cn(
              "space-y-1.5",
              index > 0 && "border-t border-neutral-200/70 pt-2"
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {stage.title}
                </p>
                <p className="mt-1 text-[11px] font-medium leading-4 text-foreground">
                  {stage.detail}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {typeof stage.percent === "number" ? (
                  <span className="text-[10px] font-semibold tabular-nums text-muted-foreground">
                    {stage.percent}%
                  </span>
                ) : null}
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize",
                    stage.state === "ready" &&
                      "border-emerald-200 bg-emerald-50 text-emerald-700",
                    stage.state === "working" &&
                      "border-sky-200 bg-sky-50 text-sky-700",
                    stage.state === "waiting" &&
                      "border-neutral-200 bg-neutral-50 text-neutral-700",
                    stage.state === "blocked" &&
                      "border-amber-200 bg-amber-50 text-amber-800"
                  )}
                >
                  {stage.label}
                </span>
              </div>
            </div>
            {stage.evidence ? (
              <p className="text-[10px] leading-4 text-muted-foreground">
                {stage.evidence}
              </p>
            ) : null}
          </div>
        ))}
        {secondaryReadiness.map((item, index) => (
          <div
            key={`secondary-${item.key}`}
            className={cn(
              "space-y-1.5",
              (progress.stages.length > 0 || index > 0) &&
                "border-t border-neutral-200/70 pt-2"
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {getSecondaryReadinessTitle(item, language)}
                </p>
                <p className="mt-1 text-[11px] font-medium leading-4 text-foreground">
                  {item.detail}
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize",
                  item.state === "blocked"
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : "border-sky-200 bg-sky-50 text-sky-700"
                )}
              >
                {getSecondaryReadinessLabel(item, language)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
