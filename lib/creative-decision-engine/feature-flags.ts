import { getDb } from "@/lib/db";
import type { Pool, PoolClient } from "pg";
import type { EngineRiskPreset } from "./types";

export type EngineV3FlagSource = "env" | "business_override";
export type EngineV3BusinessId = string | number;

export interface EngineV3Flags {
  businessId: EngineV3BusinessId;
  enabled: boolean;
  surfaceVisible: boolean;
  shadowOnly: boolean;
  presetOverride: EngineRiskPreset | null;
  source: {
    enabled: EngineV3FlagSource;
    surfaceVisible: EngineV3FlagSource;
    shadowOnly: EngineV3FlagSource;
    presetOverride: EngineV3FlagSource | null;
  };
  envDefaults: {
    enabled: boolean;
    surfaceVisible: boolean;
    shadowOnly: boolean;
  };
}

type Queryable = {
  query: (queryText: string, params?: unknown[]) => Promise<unknown>;
};

type FlagRow = Record<string, unknown> & {
  enabled: unknown;
  surface_visible: unknown;
  shadow_only: unknown;
  preset_override: unknown;
};

type BusinessIdRow = Record<string, unknown> & {
  business_id: unknown;
};

function parseEnvBoolean(
  value: string | undefined,
  missingDefault: boolean,
): boolean {
  if (value === undefined) return missingDefault;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return missingDefault;
}

function parseNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "t", "1"].includes(normalized)) return true;
    if (["false", "f", "0"].includes(normalized)) return false;
  }
  return null;
}

function parsePresetOverride(value: unknown): EngineRiskPreset | null {
  if (value === null || value === undefined) return null;
  if (
    value === "aggressive" ||
    value === "balanced" ||
    value === "conservative"
  ) {
    return value;
  }
  return null;
}

async function queryRows<TRow extends Record<string, unknown>>(
  client: Queryable,
  queryText: string,
  params?: unknown[],
): Promise<TRow[]> {
  const result = await client.query(queryText, params);
  if (Array.isArray(result)) return result as TRow[];
  return ((result as { rows?: TRow[] }).rows ?? []) as TRow[];
}

function resolveFlagValue(
  overrideValue: unknown,
  envDefault: boolean,
): { value: boolean; source: EngineV3FlagSource } {
  const parsedOverride = parseNullableBoolean(overrideValue);
  if (parsedOverride === null) {
    return { value: envDefault, source: "env" };
  }
  return { value: parsedOverride, source: "business_override" };
}

export function readEnvDefaults(): {
  enabled: boolean;
  surfaceVisible: boolean;
  shadowOnly: boolean;
} {
  return {
    enabled: parseEnvBoolean(process.env.DECISION_ENGINE_V3_ENABLED, true),
    surfaceVisible: parseEnvBoolean(
      process.env.DECISION_ENGINE_V3_SURFACE_VISIBLE,
      true,
    ),
    shadowOnly: parseEnvBoolean(
      process.env.DECISION_ENGINE_V3_SHADOW_ONLY,
      false,
    ),
  };
}

export async function resolveEngineV3Flags(
  businessId: EngineV3BusinessId,
  client?: PoolClient | Pool,
): Promise<EngineV3Flags> {
  const envDefaults = readEnvDefaults();
  const rows = await queryRows<FlagRow>(
    (client ?? getDb()) as Queryable,
    `
    SELECT enabled, surface_visible, shadow_only, preset_override
    FROM business_engine_v3_flags
    WHERE business_id = $1
    LIMIT 1
    `,
    [businessId],
  );
  const row = rows[0];
  const enabled = resolveFlagValue(row?.enabled, envDefaults.enabled);
  const surfaceVisible = resolveFlagValue(
    row?.surface_visible,
    envDefaults.surfaceVisible,
  );
  const shadowOnly = resolveFlagValue(
    row?.shadow_only,
    envDefaults.shadowOnly,
  );
  const presetOverride = parsePresetOverride(row?.preset_override);

  return {
    businessId,
    enabled: enabled.value,
    surfaceVisible: surfaceVisible.value,
    shadowOnly: shadowOnly.value,
    presetOverride,
    source: {
      enabled: enabled.source,
      surfaceVisible: surfaceVisible.source,
      shadowOnly: shadowOnly.source,
      presetOverride:
        presetOverride === null ? null : "business_override",
    },
    envDefaults,
  };
}

export async function listEnabledBusinessIds(
  client?: PoolClient | Pool,
): Promise<string[]> {
  const envDefaults = readEnvDefaults();
  const rows = await queryRows<BusinessIdRow>(
    (client ?? getDb()) as Queryable,
    `
    SELECT b.id::text AS business_id
    FROM businesses b
    LEFT JOIN business_engine_v3_flags flags
      ON flags.business_id = b.id
    WHERE COALESCE(flags.enabled, $1::boolean) = TRUE
    ORDER BY b.created_at ASC, b.id ASC
    `,
    [envDefaults.enabled],
  );

  return rows.flatMap((row) =>
    typeof row.business_id === "string" ? [row.business_id] : [],
  );
}
