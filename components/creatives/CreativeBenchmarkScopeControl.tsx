"use client";

import { cn } from "@/lib/utils";
import type {
  CreativeBenchmarkCampaignContext,
  CreativeBenchmarkScopeMode,
} from "@/components/creatives/creatives-top-section-support";

export function CreativeBenchmarkScopeControl({
  value,
  campaignContext,
  onChange,
  className,
}: {
  value: CreativeBenchmarkScopeMode;
  campaignContext: CreativeBenchmarkCampaignContext | null;
  onChange: (next: CreativeBenchmarkScopeMode) => void;
  className?: string;
}) {
  const activeLabel =
    value === "campaign" && campaignContext
      ? campaignContext.campaignName
      : "Account-wide";
  const canToggle = Boolean(campaignContext);

  return (
    <div
      className={cn(
        "inline-flex h-11 items-center gap-2 rounded-full border border-neutral-200 bg-white pl-3.5 pr-1.5",
        className,
      )}
      data-testid="creative-benchmark-scope-control"
    >
      <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-neutral-400">
        Benchmark
      </span>
      <button
        type="button"
        aria-pressed={value === "account"}
        data-testid="creative-benchmark-scope-account"
        onClick={() => {
          if (value === "account" && canToggle) {
            onChange("campaign");
          } else if (value !== "account") {
            onChange("account");
          }
        }}
        title={canToggle ? "Toggle benchmark scope" : undefined}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 text-[12px] font-medium text-neutral-900 hover:bg-neutral-50"
      >
        <span
          data-testid="creative-benchmark-scope-active"
          className="max-w-[180px] truncate"
          title={activeLabel}
        >
          {activeLabel}
        </span>
        {canToggle && (
          <svg
            width="9"
            height="9"
            viewBox="0 0 9 9"
            fill="none"
            className="text-neutral-400"
            aria-hidden="true"
          >
            <path
              d="M2 3.5l2.5 2.5L7 3.5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
      {campaignContext ? (
        <button
          type="button"
          aria-pressed={value === "campaign"}
          data-testid="creative-benchmark-scope-campaign"
          onClick={() => onChange("campaign")}
          title={campaignContext.campaignName}
          className="sr-only"
        >
          Within campaign · {campaignContext.campaignName}
        </button>
      ) : null}
    </div>
  );
}
