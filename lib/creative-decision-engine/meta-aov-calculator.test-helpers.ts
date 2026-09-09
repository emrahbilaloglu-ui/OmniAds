import type { DbClient } from "@/lib/db";
import { META_CANONICAL_METRIC_SCHEMA_VERSION } from "@/lib/meta/canonical-metrics";
import type {
  MetaAdDailyRow,
  MetaCreativeDailyRow,
} from "@/lib/meta/warehouse-types";

type AuthoritativeAdDailyWriter = (
  rows: MetaAdDailyRow[],
  options: { writeMode: "authoritative_fact" },
) => Promise<void>;

/**
 * Mirror creative fixture metrics into the authoritative Ad-day fact store.
 *
 * The strict Meta AOV reader accepts only current-schema, finalized, validated
 * facts whose complete timestamp chain is inside the requested day cutoff.
 * The shipped writer supplies the canonical account bindings and schema; the
 * fixture-only update moves its wall-clock insert timestamps back to the same
 * T02 finalization instant so yesterday-based tests remain cutoff-safe.
 */
export async function seedCanonicalMetaAdDailyFacts(input: {
  sql: DbClient;
  rows: MetaCreativeDailyRow[];
  write: AuthoritativeAdDailyWriter;
}) {
  if (input.rows.length === 0) return;

  const fixtureKeys = new Set<string>();
  const facts = input.rows.map((row): MetaAdDailyRow => {
    if (!row.adId) {
      throw new Error("Canonical Meta Ad-day fixtures require an ad id.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      throw new Error(`Canonical Meta Ad-day fixture date is invalid: ${row.date}`);
    }
    const fixtureKey = [
      row.businessId,
      row.providerAccountId,
      row.date,
      row.adId,
    ].join("\u0000");
    if (fixtureKeys.has(fixtureKey)) {
      throw new Error(`Duplicate canonical Meta Ad-day fixture: ${fixtureKey}`);
    }
    fixtureKeys.add(fixtureKey);
    return {
      businessId: row.businessId,
      providerAccountId: row.providerAccountId,
      date: row.date,
      campaignId: row.campaignId,
      adsetId: row.adsetId,
      adId: row.adId,
      adNameCurrent: row.creativeName,
      adNameHistorical: row.creativeName,
      adStatus: row.effectiveStatus ?? null,
      accountTimezone: row.accountTimezone,
      accountCurrency: row.accountCurrency,
      sourceSnapshotId: row.sourceSnapshotId,
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      reach: row.reach,
      frequency: row.frequency,
      conversions: row.conversions,
      revenue: row.revenue,
      roas: row.roas,
      cpa: row.cpa,
      ctr: row.ctr,
      cpc: row.cpc,
      linkClicks: row.linkClicks ?? null,
      truthState: "finalized",
      validationStatus: "passed",
      finalizedAt: `${row.date}T02:00:00.000Z`,
      metricSchemaVersion: META_CANONICAL_METRIC_SCHEMA_VERSION,
    };
  });

  await input.write(facts, { writeMode: "authoritative_fact" });

  const partitions = new Map<string, MetaAdDailyRow[]>();
  for (const fact of facts) {
    const key = `${fact.businessId}\u0000${fact.providerAccountId}\u0000${fact.date}`;
    const partition = partitions.get(key) ?? [];
    partition.push(fact);
    partitions.set(key, partition);
  }

  for (const partition of partitions.values()) {
    const first = partition[0]!;
    const cutoffSafeAt = `${first.date}T02:00:00.000Z`;
    const updated = await input.sql.query<{ ad_id: string }>(
      `UPDATE meta_ad_daily
          SET created_at = $4::timestamptz,
              updated_at = $4::timestamptz,
              finalized_at = $4::timestamptz
        WHERE business_id = $1::text
          AND provider_account_id = $2
          AND date = $3::date
          AND ad_id = ANY($5::text[])
        RETURNING ad_id`,
      [
        first.businessId,
        first.providerAccountId,
        first.date,
        cutoffSafeAt,
        partition.map((row) => row.adId),
      ],
    );
    if (updated.length !== partition.length) {
      throw new Error(
        `Canonical Meta Ad-day fixture write mismatch for ${first.businessId}`
        + `/${first.providerAccountId}/${first.date}: expected ${partition.length}, updated ${updated.length}`,
      );
    }
  }
}
