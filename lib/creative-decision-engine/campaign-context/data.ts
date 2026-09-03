// Feature IO for the Automatic Campaign Context Resolver (D033).
//
// Read-only queries over meta_creative_daily / meta_campaign_daily plus the
// deterministic feature aggregation shared by the daily producer job and the
// shadow evaluation script. No writes happen in this module.
import { getDb } from "@/lib/db";
import {
  FEATURE_WINDOW_DAYS,
  type CampaignFeatures,
} from "./resolver";

type Row = Record<string, unknown>;

export interface CreativeDayRow {
  /**
   * Physical Meta ad-account scope. Optional only for frozen/offline fixtures
   * created before the account-scoped resolver contract; live warehouse reads
   * always populate it.
   */
  providerAccountId?: string | null;
  campaignId: string;
  adsetId: string | null;
  creativeId: string;
  date: string;
  spend: number;
  firstSpendDate: string;
}

export interface CampaignMetaRow {
  providerAccountId?: string | null;
  campaignId: string;
  campaignName: string | null;
  firstSeenDate: string | null;
}

export interface LineageStats {
  donorByCampaign: Map<string, number>;
  receiverByCampaign: Map<string, number>;
  sharedByCampaign: Map<string, number>;
  multiCampaignCreatives: number;
  totalCreatives: number;
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value === null || value === undefined) return null;
  return String(value);
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toDateOnly(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return toText(value)?.slice(0, 10) ?? null;
}

function dateToMs(date: string) {
  return Date.parse(`${date}T00:00:00.000Z`);
}

export function addDaysUtc(date: string, days: number) {
  const parsed = new Date(dateToMs(date));
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function diffDaysUtc(left: string, right: string) {
  return Math.round((dateToMs(left) - dateToMs(right)) / 86_400_000);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

export async function readCampaignContextCreativeDays(
  businessId: string,
  rangeStart: string,
  rangeEnd: string,
): Promise<CreativeDayRow[]> {
  const rows = await getDb().query<Row>(
    `
    WITH first_spend AS (
      SELECT provider_account_id, creative_id, MIN(date) AS first_spend_date
      FROM meta_creative_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND spend > 0
        AND date <= $3::date
      GROUP BY provider_account_id, creative_id
    )
    SELECT
      d.provider_account_id,
      d.campaign_id,
      d.adset_id,
      d.creative_id,
      d.date::text AS date,
      d.spend,
      fs.first_spend_date::text AS first_spend_date
    FROM meta_creative_daily d
    JOIN first_spend fs
      ON fs.provider_account_id = d.provider_account_id
     AND fs.creative_id = d.creative_id
    WHERE (d.business_ref_id::text = $1 OR d.business_id = $1)
      AND d.spend > 0
      AND d.campaign_id IS NOT NULL
      AND d.date BETWEEN $2::date AND $3::date
    `,
    [businessId, rangeStart, rangeEnd],
  );
  return rows
    .map((row) => ({
      providerAccountId: toText(row.provider_account_id),
      campaignId: toText(row.campaign_id) ?? "",
      adsetId: toText(row.adset_id),
      creativeId: toText(row.creative_id) ?? "",
      date: toDateOnly(row.date) ?? "",
      spend: toNumber(row.spend),
      firstSpendDate: toDateOnly(row.first_spend_date) ?? "",
    }))
    .filter((row) => row.campaignId && row.creativeId && row.date);
}

export async function readCampaignContextCampaignMeta(
  businessId: string,
  ceiling: string,
  providerAccountId?: string | null,
): Promise<Map<string, CampaignMetaRow>> {
  const rows = await getDb().query<Row>(
    `
    WITH names AS (
      SELECT DISTINCT ON (provider_account_id, campaign_id)
        provider_account_id,
        campaign_id,
        COALESCE(campaign_name_current, campaign_name_historical) AS campaign_name
      FROM meta_campaign_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND date <= $2::date
        AND ($3::text IS NULL OR provider_account_id = $3)
      ORDER BY provider_account_id, campaign_id, date DESC
    ),
    first_seen AS (
      SELECT provider_account_id, campaign_id, MIN(date) AS first_date
      FROM meta_campaign_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND date <= $2::date
        AND ($3::text IS NULL OR provider_account_id = $3)
      GROUP BY provider_account_id, campaign_id
    )
    SELECT
      n.provider_account_id,
      n.campaign_id,
      n.campaign_name,
      fs.first_date::text AS first_seen_date
    FROM names n
    LEFT JOIN first_seen fs
      ON fs.provider_account_id = n.provider_account_id
     AND fs.campaign_id = n.campaign_id
    `,
    [businessId, ceiling, providerAccountId ?? null],
  );
  const map = new Map<string, CampaignMetaRow>();
  for (const row of rows) {
    const campaignId = toText(row.campaign_id);
    if (!campaignId) continue;
    map.set(campaignId, {
      providerAccountId: toText(row.provider_account_id),
      campaignId,
      campaignName: toText(row.campaign_name),
      firstSeenDate: toDateOnly(row.first_seen_date),
    });
  }
  return map;
}

export function computeCampaignLineage(rows: CreativeDayRow[]): LineageStats {
  interface CreativeCampaignAgg {
    firstDate: string;
    spend: number;
  }
  const byCreative = new Map<string, Map<string, CreativeCampaignAgg>>();
  for (const row of rows) {
    let campaigns = byCreative.get(row.creativeId);
    if (!campaigns) {
      campaigns = new Map();
      byCreative.set(row.creativeId, campaigns);
    }
    const agg = campaigns.get(row.campaignId);
    if (!agg) {
      campaigns.set(row.campaignId, { firstDate: row.date, spend: row.spend });
    } else {
      agg.spend += row.spend;
      if (row.date < agg.firstDate) agg.firstDate = row.date;
    }
  }

  const donorByCampaign = new Map<string, number>();
  const receiverByCampaign = new Map<string, number>();
  const sharedByCampaign = new Map<string, number>();
  let multiCampaignCreatives = 0;

  for (const campaigns of byCreative.values()) {
    if (campaigns.size < 2) continue;
    multiCampaignCreatives += 1;
    const entries = [...campaigns.entries()].sort((a, b) =>
      a[1].firstDate.localeCompare(b[1].firstDate),
    );
    for (const [campaignId] of entries) {
      sharedByCampaign.set(campaignId, (sharedByCampaign.get(campaignId) ?? 0) + 1);
    }
    const [earliestId, earliest] = entries[0];
    for (let index = 1; index < entries.length; index += 1) {
      const [laterId, later] = entries[index];
      if (later.spend > earliest.spend) {
        donorByCampaign.set(earliestId, (donorByCampaign.get(earliestId) ?? 0) + 1);
        receiverByCampaign.set(laterId, (receiverByCampaign.get(laterId) ?? 0) + 1);
      }
    }
  }

  return {
    donorByCampaign,
    receiverByCampaign,
    sharedByCampaign,
    multiCampaignCreatives,
    totalCreatives: byCreative.size,
  };
}

export function buildCampaignContextFeatures(input: {
  rows: CreativeDayRow[];
  meta: Map<string, CampaignMetaRow>;
  lineage: LineageStats;
  asOf: string;
}): CampaignFeatures[] {
  const windowStart = addDaysUtc(input.asOf, -(FEATURE_WINDOW_DAYS - 1));
  const inWindow = input.rows.filter(
    (row) => row.date >= windowStart && row.date <= input.asOf,
  );

  interface Agg {
    spendByCreative: Map<string, number>;
    firstSpendByCreative: Map<string, string>;
    adsets: Set<string>;
    days: Set<string>;
  }
  const byCampaign = new Map<string, Agg>();
  for (const row of inWindow) {
    let agg = byCampaign.get(row.campaignId);
    if (!agg) {
      agg = {
        spendByCreative: new Map(),
        firstSpendByCreative: new Map(),
        adsets: new Set(),
        days: new Set(),
      };
      byCampaign.set(row.campaignId, agg);
    }
    agg.spendByCreative.set(
      row.creativeId,
      (agg.spendByCreative.get(row.creativeId) ?? 0) + row.spend,
    );
    agg.firstSpendByCreative.set(row.creativeId, row.firstSpendDate);
    if (row.adsetId) agg.adsets.add(row.adsetId);
    agg.days.add(row.date);
  }

  const businessSpend = [...byCampaign.values()].reduce(
    (total, agg) =>
      total + [...agg.spendByCreative.values()].reduce((sum, v) => sum + v, 0),
    0,
  );
  const allCreativeSpends = [...byCampaign.values()].flatMap((agg) => [
    ...agg.spendByCreative.values(),
  ]);
  const accountMedianCreativeSpend = median(allCreativeSpends);

  const features: CampaignFeatures[] = [];
  for (const [campaignId, agg] of byCampaign) {
    const creativeSpends = [...agg.spendByCreative.values()];
    const spend28 = creativeSpends.reduce((sum, v) => sum + v, 0);
    const sorted = [...creativeSpends].sort((a, b) => b - a);
    const top3 = sorted.slice(0, 3).reduce((sum, v) => sum + v, 0);
    const hhi =
      spend28 > 0
        ? creativeSpends.reduce((sum, v) => sum + (v / spend28) ** 2, 0)
        : null;
    const ages = [...agg.firstSpendByCreative.values()].map((first) =>
      Math.max(0, diffDaysUtc(input.asOf, first)),
    );
    const newCreatives = [...agg.firstSpendByCreative.values()].filter(
      (first) => first >= windowStart,
    ).length;
    const metaRow = input.meta.get(campaignId);
    features.push({
      campaignId,
      campaignName: metaRow?.campaignName ?? null,
      spend28,
      activeCreatives: agg.spendByCreative.size,
      newCreatives,
      medianCreativeAgeDays: median(ages),
      top3SpendShare: spend28 > 0 ? round4(top3 / spend28) : null,
      spendHhi: hhi === null ? null : round4(hhi),
      adsetCount: agg.adsets.size,
      activeDays: agg.days.size,
      campaignAgeDays: metaRow?.firstSeenDate
        ? Math.max(0, diffDaysUtc(input.asOf, metaRow.firstSeenDate))
        : null,
      spendShareOfBusiness: businessSpend > 0 ? round4(spend28 / businessSpend) : 0,
      medianCreativeSpend: median(creativeSpends),
      accountMedianCreativeSpend,
      lineageDonorCount: input.lineage.donorByCampaign.get(campaignId) ?? 0,
      lineageReceiverCount: input.lineage.receiverByCampaign.get(campaignId) ?? 0,
      lineageSharedCount: input.lineage.sharedByCampaign.get(campaignId) ?? 0,
    });
  }
  return features.sort((a, b) => b.spend28 - a.spend28);
}
