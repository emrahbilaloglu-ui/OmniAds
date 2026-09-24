import { parseMetaActionCountValue } from "@/lib/meta/action-count-parse";

/** Row-local provider proof for the purchase scalar written by Meta ingestion. */
export const META_AD_DAY_PURCHASE_CONTRACT_VERSION = "meta-ad-day-purchase.v1";

const PURCHASE_ACTION_TYPES = new Set([
  "purchase",
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
  "offsite_conversion_fb_pixel_purchase",
]);

/**
 * Aliases describe the same event and must agree; they are never added. A
 * missing actions array proves zero only when the caller has separately proved
 * a complete provider request that asked for actions. A malformed value never
 * gains that privilege.
 */
export function parseMetaPurchaseActions(
  actions: unknown,
  options: { absentActions?: "provider_zero" | "unknown" } = {},
): number | null {
  if (actions === undefined) {
    return options.absentActions === "provider_zero" ? 0 : null;
  }
  if (!Array.isArray(actions)) return null;
  const observed = new Map<string, number>();
  for (const action of actions) {
    if (
      typeof action !== "object" || action === null ||
      typeof (action as { action_type?: unknown }).action_type !== "string"
    ) return null;
    const type = (action as { action_type: string }).action_type;
    if (!PURCHASE_ACTION_TYPES.has(type)) continue;
    if (observed.has(type)) return null;
    const parsed = parseMetaActionCountValue((action as { value?: unknown }).value);
    if (!parsed.ok) return null;
    observed.set(type, parsed.value);
  }
  if (observed.size === 0) return 0;
  const values = new Set(observed.values());
  return values.size === 1 ? [...values][0]! : null;
}

export function resolveAdDayAuthoritativePurchases(input: {
  storedConversions: unknown;
  payloadJson: unknown;
  providerZeroReceiptVerified?: boolean;
}): number | null {
  const stored = input.storedConversions;
  if (typeof stored !== "number" || !Number.isSafeInteger(stored) || stored < 0) {
    return null;
  }
  const payloadIsObject =
    typeof input.payloadJson === "object" && input.payloadJson !== null &&
    !Array.isArray(input.payloadJson);
  const actions = payloadIsObject
    ? (input.payloadJson as { actions?: unknown }).actions
    : null;
  const observed = parseMetaPurchaseActions(actions, {
    absentActions: input.providerZeroReceiptVerified && payloadIsObject &&
      !Object.hasOwn(input.payloadJson as object, "actions")
      ? "provider_zero"
      : "unknown",
  });
  return observed !== null && observed === stored ? stored : null;
}

const SQL_QUALIFIER = /^[a-z_][a-z0-9_]*$/;
const SQL_PROOF_COLUMN = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/** SQL twin of resolveAdDayAuthoritativePurchases, safe on malformed JSON. */
export function buildAdDayAuthoritativePurchasesSql(
  options: { qualifier?: string; providerZeroProofSql?: string } = {},
): string {
  const qualifier = options.qualifier ?? "";
  if (qualifier !== "" && !SQL_QUALIFIER.test(qualifier)) {
    throw new Error(`ad_day_purchases_sql_qualifier_invalid:${qualifier}`);
  }
  const q = qualifier ? `${qualifier}.` : "";
  const providerZeroProofSql = options.providerZeroProofSql ?? "FALSE";
  if (providerZeroProofSql !== "FALSE" &&
      !SQL_PROOF_COLUMN.test(providerZeroProofSql)) {
    throw new Error("ad_day_purchases_sql_provider_zero_proof_invalid");
  }
  const typeSql = "action->>'action_type' IN ('purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'offsite_conversion_fb_pixel_purchase')";
  const normalizedCountSql = "COALESCE(NULLIF(LTRIM(action->>'value', '0'), ''), '0')";
  const countSql = `(CASE
      WHEN jsonb_typeof(action->'value') = 'string'
        AND action->>'value' ~ '^[0-9]+$'
        AND LENGTH(LTRIM(action->>'value', '0')) <= 16
      THEN CASE WHEN ${normalizedCountSql}::numeric <= 9007199254740991
        THEN ${normalizedCountSql}::numeric END
    END)`;
  return `(CASE WHEN ${q}conversions >= 0
      AND jsonb_typeof(${q}payload_json->'actions') = 'array'
    THEN (
      SELECT CASE
        WHEN COALESCE(BOOL_OR(jsonb_typeof(action) <> 'object'
          OR jsonb_typeof(action->'action_type') IS DISTINCT FROM 'string'), FALSE)
          THEN NULL
        WHEN COUNT(*) FILTER (WHERE ${typeSql}) = 0
          THEN CASE WHEN ${q}conversions = 0 THEN 0 ELSE NULL END
        WHEN COUNT(*) FILTER (WHERE ${typeSql}) <>
          COUNT(DISTINCT action->>'action_type') FILTER (WHERE ${typeSql})
          THEN NULL
        WHEN COUNT(*) FILTER (WHERE ${typeSql} AND ${countSql} IS NULL) > 0
          THEN NULL
        WHEN MIN(${countSql}) FILTER (WHERE ${typeSql}) <>
          MAX(${countSql}) FILTER (WHERE ${typeSql})
          THEN NULL
        WHEN MIN(${countSql}) FILTER (WHERE ${typeSql}) = ${q}conversions
          THEN ${q}conversions
        ELSE NULL
      END
      FROM jsonb_array_elements(${q}payload_json->'actions') AS action
    )
    WHEN ${q}conversions = 0
      AND jsonb_typeof(${q}payload_json) = 'object'
      AND NOT (${q}payload_json ? 'actions')
      AND COALESCE(${providerZeroProofSql}, FALSE)
      THEN 0
    ELSE NULL END)`;
}
