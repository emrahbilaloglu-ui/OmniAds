import type {
  DataHealth,
  DataLayerHealth,
  FallbackMode,
  StaleTier,
} from "./types";
import {
  STALE_TIER_NONE_MAX_HOURS,
  STALE_TIER_WARNING_MAX_HOURS,
} from "./config-values";

export {
  STALE_TIER_NONE_MAX_HOURS,
  STALE_TIER_WARNING_MAX_HOURS,
} from "./config-values";

/** Threshold (hours) below which data is considered fresh. */
/** Threshold (hours) above which data is considered too stale to use. */

/**
 * Classify a layer's freshness based on hours since source max updated.
 * - <= 36h -> "none"
 * - <= 72h -> "warning"
 * - > 72h -> "disabled"
 * - null -> "unknown"
 */
export function classifyStaleTier(
  sourceFreshnessHours: number | null,
): StaleTier {
  if (sourceFreshnessHours == null) return "unknown";
  if (sourceFreshnessHours <= STALE_TIER_NONE_MAX_HOURS) return "none";
  if (sourceFreshnessHours <= STALE_TIER_WARNING_MAX_HOURS) return "warning";
  return "disabled";
}

/** Worst tier across layers. Severity order: none < warning < unknown < disabled. */
export function worstStaleTier(tiers: StaleTier[]): StaleTier {
  if (tiers.includes("disabled")) return "disabled";
  if (tiers.includes("unknown")) return "unknown";
  if (tiers.includes("warning")) return "warning";
  return "none";
}

export type StaleTierDisplay = Exclude<StaleTier, "unknown">;

/** Unknown freshness is visually warning-equivalent without changing its contract tier. */
export function staleTierForDisplay(tier: StaleTier): StaleTierDisplay {
  return tier === "unknown" ? "warning" : tier;
}

/** Compose a DataHealth from per-layer inputs. */
export function composeDataHealth(input: {
  calibration: DataLayerHealth;
  lifecycle: DataLayerHealth;
  decisions: DataLayerHealth;
}): DataHealth {
  const worstTier = worstStaleTier([
    input.calibration.staleTier,
    input.lifecycle.staleTier,
    input.decisions.staleTier,
  ]);

  return {
    calibration: input.calibration,
    lifecycle: input.lifecycle,
    decisions: input.decisions,
    worstTier,
    degraded: worstTier === "disabled",
  };
}

/** Contract-facing alias for composing DataHealth from layer health inputs. */
export function computeDataHealth(input: {
  calibration: DataLayerHealth;
  lifecycle: DataLayerHealth;
  decisions: DataLayerHealth;
}): DataHealth {
  return composeDataHealth(input);
}

/** Build a DataLayerHealth from raw watermark inputs. */
export function buildDataLayerHealth(input: {
  asOfDate: string | null;
  computedAt: string | null;
  sourceMaxUpdatedAt: string | null;
  now?: Date;
  fallbackMode: FallbackMode;
  note?: string | null;
}): DataLayerHealth {
  const now = input.now ?? new Date();
  const sourceFreshnessHours =
    input.sourceMaxUpdatedAt != null
      ? freshnessHours(input.sourceMaxUpdatedAt, now)
      : null;
  const staleTier = classifyStaleTier(sourceFreshnessHours);

  return {
    asOfDate: input.asOfDate,
    computedAt: input.computedAt,
    sourceFreshnessHours,
    staleTier,
    fallbackMode: input.fallbackMode,
    note: input.note ?? null,
  };
}

/** Explicit fresh fixture used by MockDataSource; never use for unknown watermarks. */
export function freshDataLayerHealth(asOfDate: string): DataLayerHealth {
  return {
    asOfDate,
    computedAt: new Date().toISOString(),
    sourceFreshnessHours: 0,
    staleTier: "none",
    fallbackMode: "runtime_sql",
    note: null,
  };
}

function freshnessHours(sourceMaxUpdatedAt: string, now: Date): number | null {
  const sourceTime = new Date(sourceMaxUpdatedAt).getTime();
  if (!Number.isFinite(sourceTime)) return null;
  return Math.max(0, Math.floor((now.getTime() - sourceTime) / 3_600_000));
}
