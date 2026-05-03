import type { MetaWarehouseScope } from "@/lib/meta/warehouse-types";

export const META_PRODUCT_CORE_COVERAGE_SCOPES = [
  "account_daily",
  "campaign_daily",
] as const satisfies readonly MetaWarehouseScope[];

export const META_PRODUCT_CORE_PARTITION_SCOPE =
  "account_daily" as const satisfies MetaWarehouseScope;

export const META_CORE_PARTITION_SCOPES = [
  META_PRODUCT_CORE_PARTITION_SCOPE,
] as const satisfies readonly MetaWarehouseScope[];

export const META_SECONDARY_REPORTING_SCOPES = [
  "adset_daily",
] as const satisfies readonly MetaWarehouseScope[];

export const META_EXTENDED_SCOPES = [
  "creative_daily",
  "ad_daily",
] as const satisfies readonly MetaWarehouseScope[];

export const META_RUNTIME_STATE_SCOPES = [
  ...META_PRODUCT_CORE_COVERAGE_SCOPES,
  ...META_SECONDARY_REPORTING_SCOPES,
  ...META_EXTENDED_SCOPES,
] as const satisfies readonly MetaWarehouseScope[];

const PRODUCT_CORE_SCOPE_SET = new Set<string>(META_PRODUCT_CORE_COVERAGE_SCOPES);

export function isMetaProductCoreCoverageScope(
  scope: MetaWarehouseScope | string | null | undefined
): boolean {
  return PRODUCT_CORE_SCOPE_SET.has(String(scope ?? ""));
}
