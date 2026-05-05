"use client";

import { useMemo } from "react";
import type {
  AccountDecisionProfile,
  DataHealth,
  DecisionLabel,
  DecisionOutput,
  EngineV3Flags,
  EngineMultiplierSet,
} from "@/lib/creative-decision-engine";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  DECISION_LABELS,
  LABEL_DISPLAY,
  TONE_CLASS,
} from "@/components/creatives/decision-label-display";

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
  accountProfile: AccountDecisionProfile | null;
  flags: EngineV3Flags | null;
}

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
        {props.accountProfile && (
          <AccountProfileDisclosure profile={props.accountProfile} />
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

function AccountProfileDisclosure({
  profile,
}: {
  profile: AccountDecisionProfile;
}) {
  const aovUsed =
    profile.spendUnitSource === "meta_derived_aov"
      ? profile.spendUnitEvidence.metaAttributedAovMean90d
      : profile.spendUnitEvidence.operatorAovAssumption;

  return (
    <details className="basis-full rounded-md border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-700">
      <summary className="cursor-pointer select-none font-semibold text-slate-800">
        Account profile
      </summary>
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        <ProfileRow
          label="Preset"
          value={profile.preset}
          detail={profile.presetSource}
        />
        <ProfileRow
          label="Spend unit"
          value={formatNumber(profile.spendUnit)}
          detail={`${profile.spendUnitSource} / ${profile.spendUnitConfidence}`}
          mono
        />
        <ProfileRow
          label="Target ROAS / break-even"
          value={`${formatNumber(
            profile.spendUnitEvidence.targetRoas,
          )} / ${formatNumber(profile.spendUnitEvidence.breakEvenRoas)}`}
          mono
        />
        <ProfileRow
          label="AOV used"
          value={formatNumber(aovUsed)}
          detail={
            profile.spendUnitSource === "meta_derived_aov"
              ? "meta_attributed_aov_mean_90d"
              : "operatorAovAssumption"
          }
          mono
        />
        <ProfileRow
          label="Mature creatives"
          value={formatInteger(profile.accountBaselines.matureCreativeCount)}
          mono
        />
        <ProfileRow
          label="Quality"
          value={[
            `commercialTruthReady=${formatBoolean(
              profile.quality.commercialTruthReady,
            )}`,
            `calibrationReady=${formatBoolean(profile.quality.calibrationReady)}`,
            `metaAovQuality=${profile.quality.metaAovQuality}`,
            `thresholdQuality=${profile.quality.thresholdQuality}`,
          ].join(" / ")}
        />
        <ProfileRow
          label="Hard-action eligibility"
          value={[
            `scale=${formatBoolean(profile.hardActionEligibility.scale)}`,
            `cut=${formatBoolean(profile.hardActionEligibility.cut)}`,
            `refresh=${formatBoolean(profile.hardActionEligibility.refresh)}`,
          ].join(" / ")}
          detail={profile.hardActionEligibility.reason ?? undefined}
        />
        <div className="md:col-span-2 xl:col-span-3">
          <div className="rounded border border-slate-200 bg-white px-2.5 py-2">
            <span className="font-medium text-slate-500">Multipliers</span>
            <span className="ml-2 font-mono text-[11px] text-slate-800">
              {formatMultipliers(profile.multipliers)}
            </span>
          </div>
        </div>
      </div>
    </details>
  );
}

function ProfileRow({
  label,
  value,
  detail,
  mono = false,
}: {
  label: string;
  value: string;
  detail?: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded border border-slate-200 bg-white px-2.5 py-2">
      <div className="font-medium text-slate-500">{label}</div>
      <div className={cn("mt-0.5 break-words text-slate-900", mono && "font-mono")}>
        {value}
      </div>
      {detail && <div className="mt-0.5 text-[11px] text-slate-500">{detail}</div>}
    </div>
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

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function formatInteger(value: number): string {
  return Math.round(Number.isFinite(value) ? value : 0).toLocaleString();
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function formatMultipliers(multipliers: EngineMultiplierSet): string {
  return (
    [
      "zeroConvBurner",
      "cutCandidate",
      "sustainedLoser",
      "hardCut",
      "scaleEvidence",
      "scalePurchase",
      "winnerMemory",
      "recentSample",
      "weakFunnelRate",
    ] satisfies Array<keyof EngineMultiplierSet>
  )
    .map((key) => `${key}=${formatNumber(multipliers[key])}`)
    .join(" / ");
}
