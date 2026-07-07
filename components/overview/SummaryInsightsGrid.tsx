"use client";

import type { OverviewInsightCard } from "@/src/types/models";
import { AlertTriangle, Info, TrendingUp } from "lucide-react";

export function SummaryInsightsGrid({ insights }: { insights: OverviewInsightCard[] }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {insights.map((insight) => {
        const Icon =
          insight.severity === "high"
            ? AlertTriangle
            : insight.severity === "medium"
            ? TrendingUp
            : Info;
        return (
          <article
            key={insight.id}
            className="rounded-xl border border-neutral-200 bg-white p-4"
          >
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500">
                <Icon className="h-5 w-5" />
              </span>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-neutral-950">{insight.title}</h3>
                  <span className="rounded-full bg-neutral-100 px-2 py-1 text-[11px] font-medium capitalize text-neutral-600">
                    {insight.severity}
                  </span>
                </div>
                <p className="text-sm text-neutral-600">{insight.description}</p>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
