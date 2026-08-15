"use client";

import { TrendingUp, AlertTriangle, Info } from "lucide-react";
import type { GeoInsight } from "@/lib/geo-intelligence";

export function GeoInsightCallout({ insight }: { insight: GeoInsight }) {
  if (insight.type === "positive") {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-[var(--adc-auto-bd)] bg-[var(--adc-auto-bg)] px-3.5 py-2.5  ">
        <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-[var(--adc-auto-fg)] " />
        <p className="text-sm text-[var(--adc-auto-fg)] ">{insight.text}</p>
      </div>
    );
  }
  if (insight.type === "warning") {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] px-3.5 py-2.5  ">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--adc-caution-fg)] " />
        <p className="text-sm text-[var(--adc-caution-fg)] ">{insight.text}</p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2.5 rounded-lg border bg-muted/40 px-3.5 py-2.5">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{insight.text}</p>
    </div>
  );
}
