"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type {
  AccountDecisionProfile,
  DataHealth,
  DecisionLabel,
  DecisionOutput,
  EngineRiskPreset,
  EngineV3Flags,
  EngineMultiplierSet,
} from "@/lib/creative-decision-engine";
import { DecisionLabelChip } from "@/components/common/briefing/DecisionLabelChip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  DECISION_LABELS,
  LABEL_DISPLAY,
  TONE_CLASS,
} from "@/components/creatives/decision-label-display";

export const SOURCE_FRESHNESS_CONFIDENCE_COPY =
  "Confidence is capped because source freshness is stale or unknown. Refresh evidence before applying this action.";

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
  onPresetChange?: () => void;
}

const ENGINE_RISK_PRESETS = [
  "aggressive",
  "balanced",
  "conservative",
] as const satisfies readonly EngineRiskPreset[];

export async function updateEngineV3PresetOverride(input: {
  businessId: string;
  preset: EngineRiskPreset | null;
}): Promise<EngineV3Flags> {
  const response = await fetch("/api/admin/engine-v3/preset", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Failed to update preset: ${response.status}`);
  }
  return (await response.json()) as EngineV3Flags;
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
          <div className="basis-full space-y-2">
            <PresetOverrideControl
              businessId={props.businessId}
              profile={props.accountProfile}
              onPresetChange={props.onPresetChange}
            />
            <ScopeProfileDisclosure profile={props.accountProfile} />
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

function PresetOverrideControl({
  businessId,
  profile,
  onPresetChange,
}: {
  businessId: string | null;
  profile: AccountDecisionProfile;
  onPresetChange?: () => void;
}) {
  const [errorVisible, setErrorVisible] = useState(false);
  const mutation = useMutation({
    mutationFn: (preset: EngineRiskPreset | null) => {
      if (!businessId) {
        throw new Error("businessId is required");
      }
      return updateEngineV3PresetOverride({ businessId, preset });
    },
    onSuccess: () => {
      setErrorVisible(false);
      onPresetChange?.();
    },
    onError: () => {
      setErrorVisible(true);
    },
  });

  useEffect(() => {
    if (!errorVisible) return undefined;
    const timeout = window.setTimeout(() => setErrorVisible(false), 5_000);
    return () => window.clearTimeout(timeout);
  }, [errorVisible]);

  const hasOverride =
    profile.presetSource === "business_engine_v3_flags_override";

  return (
    <div className="flex flex-wrap items-start gap-2 rounded-md border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-700">
      <label className="flex items-center gap-2">
        <span className="font-semibold text-slate-700">Preset</span>
        <select
          className="h-7 rounded border border-slate-300 bg-white px-2 text-xs font-medium text-slate-900 shadow-sm outline-none focus:border-slate-500"
          value={profile.preset}
          disabled={mutation.isPending || !businessId}
          onChange={(event) => {
            const preset = event.currentTarget.value as EngineRiskPreset;
            if (preset === profile.preset) return;
            mutation.mutate(preset);
          }}
          aria-label="Engine v3 preset"
        >
          {ENGINE_RISK_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
        </select>
      </label>
      {hasOverride && (
        <button
          type="button"
          className="mt-1 text-[11px] font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline disabled:cursor-not-allowed disabled:text-slate-400"
          disabled={mutation.isPending || !businessId}
          onClick={() => mutation.mutate(null)}
        >
          Clear override
        </button>
      )}
      {mutation.isPending && (
        <span className="mt-1 text-[11px] text-slate-500">Saving...</span>
      )}
      {errorVisible && (
        <span className="mt-1 text-[11px] font-medium text-rose-600">
          Failed to update preset
        </span>
      )}
    </div>
  );
}

function ScopeProfileDisclosure({
  profile,
}: {
  profile: AccountDecisionProfile;
}) {
  const aovUsed =
    profile.spendUnitSource === "meta_derived_aov"
      ? profile.spendUnitEvidence.metaAttributedAovMean90d
      : profile.spendUnitEvidence.operatorAovAssumption;

  return (
    <details className="rounded-md border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-700">
      <summary className="cursor-pointer select-none font-semibold text-slate-800">
        Scope profile ({profile.scope.type})
      </summary>
      {profile.scope.fallbackReason && (
        <p className="mt-2 text-[11px] font-medium text-amber-700">
          Falling back to account scope: {formatScopeFallbackReason(profile.scope.fallbackReason)}
        </p>
      )}
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        <ProfileRow
          label="Resolved scope"
          value={`${profile.scope.type}:${profile.scope.id}`}
          detail={profile.scope.fallbackReason}
          mono
        />
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
  const confidenceCopy = confidenceCopyForDecision(decision);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-border/60 bg-background/60 px-2 py-1.5 text-xs">
      <DecisionLabelChip
        label={decision.label}
        appearance="unstyled"
        className={cn(
          "shrink-0 rounded border px-1.5 py-0.5 font-semibold",
          TONE_CLASS[display.tone],
        )}
      >
        {display.label}
      </DecisionLabelChip>
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
      {confidenceCopy && (
        <span
          className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
          data-confidence-copy="source_freshness_cap"
          title={confidenceCopy}
        >
          confidence capped
        </span>
      )}
      <span className="shrink-0 text-muted-foreground">
        {decision.truthSource}
      </span>
    </div>
  );
}

function confidenceCopyForDecision(decision: DecisionOutput): string | null {
  const badgeTypes = new Set(decision.badges.map((badge) => badge.type));
  if (
    badgeTypes.has("stale_evidence") ||
    badgeTypes.has("unknown_freshness")
  ) {
    return SOURCE_FRESHNESS_CONFIDENCE_COPY;
  }
  return null;
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

function formatScopeFallbackReason(reason: string): string {
  if (reason === "campaign_sample_below_threshold") {
    return "campaign sample size below 8 mature creatives";
  }
  if (reason === "campaign_calibration_missing") {
    return "campaign calibration is not available";
  }
  return reason;
}

function formatMultipliers(multipliers: EngineMultiplierSet): string {
  return (
    [
      "zeroConvBurner",
      "cutCandidate",
      "sustainedLoser",
      "lossBudget",
      "hardCut",
      "scalePurchase",
      "winnerMemory",
      "recentSample",
      "weakFunnelRate",
    ] satisfies Array<keyof EngineMultiplierSet>
  )
    .map((key) => `${key}=${formatNumber(multipliers[key])}`)
    .join(" / ");
}
