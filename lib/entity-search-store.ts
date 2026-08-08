import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import type { EntitySearchCandidate } from "@/lib/entity-search";

/**
 * Candidate lookup for global search.
 *
 * Scoping is applied in SQL against the businesses the caller may see, so a
 * name from another tenant can never enter the result set and be filtered out
 * later. The union is capped per entity type; ranking then happens over the
 * candidates rather than over an already-truncated single list.
 */

interface CandidateRow {
  entity_type: string;
  entity_id: string;
  name: string | null;
  business_id: string;
  provider_account_id: string | null;
  status: string | null;
  updated_at: string | null;
}

const SEARCH_TABLES = [
  "meta_campaign_dimensions",
  "meta_adset_dimensions",
  "meta_ad_dimensions",
] as const;

export async function findEntitySearchCandidates(input: {
  /** Businesses the caller is permitted to see. Never widened downstream. */
  businessIds: string[];
  query: string;
  perTypeLimit?: number;
}): Promise<EntitySearchCandidate[]> {
  if (input.businessIds.length === 0) return [];
  const query = input.query.trim();
  if (!query) return [];

  const readiness = await getDbSchemaReadiness({
    tables: [...SEARCH_TABLES],
  }).catch(() => null);
  if (!readiness?.ready) return [];

  const limit = Math.min(Math.max(input.perTypeLimit ?? 25, 1), 100);
  const pattern = `%${query.toLowerCase()}%`;

  const rows = (await getDb().query<CandidateRow>(
    `
      (
        SELECT 'campaign' AS entity_type,
               campaign_id AS entity_id,
               campaign_name_current AS name,
               business_id,
               provider_account_id,
               campaign_status AS status,
               source_updated_at::text AS updated_at
        FROM meta_campaign_dimensions
        WHERE business_id = ANY($1::text[])
          AND (lower(campaign_name_current) LIKE $2 OR lower(campaign_id) LIKE $2)
        ORDER BY source_updated_at DESC NULLS LAST
        LIMIT $3
      )
      UNION ALL
      (
        SELECT 'adset', adset_id, adset_name_current, business_id, provider_account_id,
               adset_status, source_updated_at::text
        FROM meta_adset_dimensions
        WHERE business_id = ANY($1::text[])
          AND (lower(adset_name_current) LIKE $2 OR lower(adset_id) LIKE $2)
        ORDER BY source_updated_at DESC NULLS LAST
        LIMIT $3
      )
      UNION ALL
      (
        SELECT 'ad', ad_id, ad_name_current, business_id, provider_account_id,
               ad_status, source_updated_at::text
        FROM meta_ad_dimensions
        WHERE business_id = ANY($1::text[])
          AND (lower(ad_name_current) LIKE $2 OR lower(ad_id) LIKE $2)
        ORDER BY source_updated_at DESC NULLS LAST
        LIMIT $3
      )
    `,
    [input.businessIds, pattern, limit],
  )) as CandidateRow[];

  return rows.map((row) => ({
    entityType: row.entity_type as EntitySearchCandidate["entityType"],
    entityId: row.entity_id,
    name: row.name,
    businessId: row.business_id,
    provider: "meta",
    providerAccountId: row.provider_account_id,
    status: row.status,
    updatedAt: row.updated_at,
  }));
}
