export const META_CAMPAIGN_KINDS = ["main", "test", "mixed"] as const;
export type MetaCampaignKind = (typeof META_CAMPAIGN_KINDS)[number];

export const META_CAMPAIGN_TEST_DIMENSIONS = [
  "creative",
  "audience",
  "bid",
  "offer",
  "structure",
  "other",
] as const;
export type MetaCampaignTestDimension =
  (typeof META_CAMPAIGN_TEST_DIMENSIONS)[number];

/**
 * @deprecated D074: the manual campaign-label product is removed from live
 * runtime. These sources exist only to deserialize frozen historical rows and
 * to type the evaluation/seam lanes; no live producer writes them.
 */
export const META_CAMPAIGN_LABEL_SOURCES = [
  "user",
  "bulk_apply_confirmed",
] as const;
/** @deprecated D074: historical/evaluation deserialization only. */
export type MetaCampaignLabelSource =
  (typeof META_CAMPAIGN_LABEL_SOURCES)[number];

/**
 * @deprecated D074: frozen historical row shape (`meta_campaign_labels`).
 * Runtime campaign role is automatic account-scoped inference; live decision
 * consumers must not read or construct manual labels. Retained for old
 * snapshot deserialization, replay comparators, and seam harnesses.
 */
export interface MetaCampaignLabel {
  businessId: string;
  campaignId: string;
  kind: MetaCampaignKind;
  testDimension: MetaCampaignTestDimension | null;
  source: MetaCampaignLabelSource;
  providerAccountId: string | null;
  campaignName: string | null;
  labeledBy: string | null;
  labeledAt: string;
  updatedAt: string;
}

/** @deprecated D074: evaluation/seam input shape only; no live writer. */
export interface MetaCampaignLabelInput {
  campaignId: string;
  kind: MetaCampaignKind;
  testDimension?: MetaCampaignTestDimension | null;
  source?: MetaCampaignLabelSource | null;
  providerAccountId?: string | null;
  campaignName?: string | null;
}

export function isMetaCampaignKind(value: unknown): value is MetaCampaignKind {
  return META_CAMPAIGN_KINDS.includes(value as MetaCampaignKind);
}

export function isMetaCampaignTestDimension(
  value: unknown,
): value is MetaCampaignTestDimension {
  return META_CAMPAIGN_TEST_DIMENSIONS.includes(
    value as MetaCampaignTestDimension,
  );
}

export function isMetaCampaignLabelSource(
  value: unknown,
): value is MetaCampaignLabelSource {
  return META_CAMPAIGN_LABEL_SOURCES.includes(
    value as MetaCampaignLabelSource,
  );
}

export function labelKindDisplay(kind: MetaCampaignKind) {
  if (kind === "main") return "Main";
  if (kind === "test") return "Test";
  return "Mixed";
}

export function testDimensionDisplay(
  dimension: MetaCampaignTestDimension | null | undefined,
) {
  if (!dimension) return null;
  if (dimension === "bid") return "Bid";
  return dimension
    .replace(/_/g, " ")
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
