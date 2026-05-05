"use client";

import { useMemo } from "react";
import type {
  DataHealth,
  DecisionLabel,
  DecisionOutput,
  EngineV3Flags,
} from "@/lib/creative-decision-engine";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type LabelTone = "success" | "warning" | "danger" | "info" | "muted";

interface CreativeDecisionEngineV3SurfaceProps {
  businessId: string | null;
  asOf?: string;
  visibleCreativeIds?: string[];
  decisions: DecisionOutput[] | null;
  isLoading: boolean;
  isError: boolean;
  error?: Error | null;
  engineVersion: string | null;
  dataSource?: "warehouse" | "mock" | null;
  dataHealth: DataHealth | null;
  flags: EngineV3Flags | null;
}

const DECISION_LABELS: DecisionLabel[] = [
  "scale",
  "keep",
  "refresh",
  "cut",
  "test_more",
  "diagnose",
  "out_of_scope",
];

const LABEL_DISPLAY: Record<
  DecisionLabel,
  { label: string; tone: LabelTone }
> = {
  scale: { label: "Scale", tone: "success" },
  keep: { label: "Keep", tone: "info" },
  refresh: { label: "Refresh", tone: "warning" },
  cut: { label: "Cut", tone: "danger" },
  test_more: { label: "Test more", tone: "muted" },
  diagnose: { label: "Diagnose", tone: "warning" },
  out_of_scope: { label: "Out of scope", tone: "muted" },
};

const TONE_CLASS: Record<LabelTone, string> = {
  success: "border-emerald-200 bg-emerald-500/15 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-300",
  warning: "border-amber-200 bg-amber-500/15 text-amber-800 dark:border-amber-500/30 dark:text-amber-300",
  danger: "border-rose-200 bg-rose-500/15 text-rose-700 dark:border-rose-500/30 dark:text-rose-300",
  info: "border-sky-200 bg-sky-500/15 text-sky-700 dark:border-sky-500/30 dark:text-sky-300",
  muted: "border-border bg-muted text-muted-foreground",
};

export function CreativeDecisionEngineV3Surface(
  props: CreativeDecisionEngineV3SurfaceProps,
) {
  const distribution = useMemo(() => {
    if (!props.decisions) return null;
    return props.decisions.reduce<Partial<Record<DecisionLabel, number>>>(
      (map, decision) => ({
        ...map,
        [decision.label]: (map[decision.label] ?? 0) + 1,
      }),
      {},
    );
  }, [props.decisions]);

  const lastUpdated = useMemo(() => {
    if (props.decisions && props.decisions.length > 0) {
      const timestamps = props.decisions
        .map((decision) => Date.parse(decision.generatedAt))
        .filter(Number.isFinite);
      if (timestamps.length > 0) {
        return formatTimestamp(new Date(Math.max(...timestamps)).toISOString());
      }
    }
    return props.asOf ?? null;
  }, [props.asOf, props.decisions]);

  if (!props.businessId || !props.flags?.enabled || !props.flags.surfaceVisible) {
    return null;
  }

  return (
    <section className="mb-6 rounded-lg border border-amber-500/40 bg-amber-50/50 p-4 dark:bg-amber-950/10">
      <header className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="rounded-md border-amber-500 bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white hover:bg-amber-500">
            Engine v3 — in development
          </Badge>
          <span className="text-xs text-muted-foreground">
            {props.engineVersion ?? "..."}
          </span>
          {props.flags.shadowOnly && (
            <Badge className="rounded-md border-sky-500 bg-sky-500 px-2 py-0.5 text-xs font-semibold text-white hover:bg-sky-500">
              Shadow mode (advisory only)
            </Badge>
          )}
          {props.dataHealth && props.dataHealth.worstTier !== "none" && (
            <span
              className={cn(
                "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
                props.dataHealth.worstTier === "warning"
                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                  : "bg-rose-500/15 text-rose-700 dark:text-rose-400",
              )}
              data-health-tier={props.dataHealth.worstTier}
              title={`Data health: ${props.dataHealth.worstTier} (calibration ${props.dataHealth.calibration.staleTier}, lifecycle ${props.dataHealth.lifecycle.staleTier}, decisions ${props.dataHealth.decisions.staleTier})`}
            >
              {props.dataHealth.worstTier === "warning"
                ? "data: stale"
                : "data: degraded"}
            </span>
          )}
          {props.dataSource && (
            <span className="text-xs text-muted-foreground">
              data: {props.dataSource}
            </span>
          )}
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              Last updated {lastUpdated}
            </span>
          )}
        </div>
        {distribution && (
          <div className="flex flex-wrap gap-2 text-xs">
            {DECISION_LABELS.map((label) => {
              const count = distribution[label] ?? 0;
              if (count === 0) return null;
              return (
                <span key={label} className="rounded bg-muted px-1.5 py-0.5">
                  {LABEL_DISPLAY[label].label}: {count}
                </span>
              );
            })}
          </div>
        )}
      </header>

      {props.isLoading && (
        <div className="text-sm text-muted-foreground">
          Loading v3 decisions...
        </div>
      )}
      {props.isError && (
        <div className="text-sm text-destructive">
          Engine error: {props.error?.message ?? "unknown"}
        </div>
      )}

      {props.decisions && props.decisions.length === 0 && (
        <div className="text-sm text-muted-foreground">No creatives in scope.</div>
      )}

      {props.decisions && props.decisions.length > 0 && (
        <div className="space-y-1.5">
          {props.decisions.slice(0, 50).map((decision) => (
            <DecisionRow key={decision.creativeId} decision={decision} />
          ))}
          {props.decisions.length > 50 && (
            <div className="pt-1 text-xs text-muted-foreground">
              + {props.decisions.length - 50} more
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DecisionRow({ decision }: { decision: DecisionOutput }) {
  const display = LABEL_DISPLAY[decision.label];
  const creativeName = decision.creativeName?.trim() || null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-border/60 bg-background/60 px-2 py-1.5 text-xs">
      <span
        className={cn(
          "shrink-0 rounded border px-1.5 py-0.5 font-semibold",
          TONE_CLASS[display.tone],
        )}
      >
        {display.label}
      </span>
      <span className="max-w-[14rem] shrink-0 truncate font-medium">
        {creativeName ?? decision.creativeId}
      </span>
      {creativeName && (
        <span className="max-w-[10rem] shrink-0 truncate font-mono text-[10px] text-muted-foreground/70">
          {decision.creativeId}
        </span>
      )}
      <span className="min-w-[14rem] flex-1 truncate">{decision.reason}</span>
      {decision.badges.length > 0 && (
        <span className="flex shrink-0 flex-wrap gap-1">
          {decision.badges.map((badge, idx) => (
            <span
              key={`${badge.type}-${idx}`}
              className={cn(
                "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
                badge.severity === "warning"
                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                  : "bg-muted text-muted-foreground",
              )}
              data-badge-severity={badge.severity}
              data-badge-type={badge.type}
              title={badge.label}
            >
              {badge.type}
            </span>
          ))}
        </span>
      )}
      <span className="shrink-0 text-muted-foreground">
        conf {Math.round(decision.confidence)}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {decision.truthSource}
      </span>
    </div>
  );
}

function formatTimestamp(value: string): string {
  if (value.length >= 16 && value.includes("T")) {
    return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
  }
  return value;
}
