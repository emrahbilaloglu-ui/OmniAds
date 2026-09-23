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

/**
 * Counts, for the window just read, how many spending ad-days could not be
 * given a creative. Exported so a caller can report the gap instead of
 * inferring it from a shorter array.
 */
export interface CampaignContextCreativeDayCoverage {
  spendingAdDays: number;
  resolvedAdDays: number;
  unresolvedAdDays: number;
}

let lastCreativeDayCoverage: CampaignContextCreativeDayCoverage | null = null;

export function lastCampaignContextCreativeDayCoverage() {
  return lastCreativeDayCoverage;
}

/**
 * Creative-days for the campaign-role resolver, read AT AD GRAIN.
 *
 * ── Why not meta_creative_daily ──────────────────────────────────────────────
 * That table is keyed (business, account, date, creative) with NO campaign
 * column in the key, so two ad-days of one creative running in two campaigns on
 * one day collapse into a single row: the spends are summed and the campaign is
 * whichever one the writer saw first. Measured read-only on production over 90
 * days, 1,375 creative-days ran in more than one campaign and 1,298 of them
 * collapsed that way. A resolver whose whole job is to classify a CAMPAIGN was
 * being fed rows whose campaign attribution had already been decided by input
 * order.
 *
 * meta_ad_daily keeps the relationship: an ad belongs to exactly one campaign,
 * so two ads of one creative in two campaigns stay two rows.
 *
 * ── Where the creative comes from ───────────────────────────────────────────
 * meta_ad_daily carries no creative_id, so the ad-to-creative map is joined in.
 * meta_ad_dimensions holds only the CURRENT state and is null for 41% of ads;
 * meta_entity_state_history carries creative_id on every one of its 2.38M ad
 * rows with an observed_at, so it can be read AS OF the day being classified.
 * Measured over the same 90 days and 38,326 spending ad-days:
 *
 *     via meta_ad_dimensions only          31,396   (81.9%)
 *     via as-of state history              37,066   (96.7%)
 *     recovered beyond dimensions           6,918
 *     WHERE THE TWO DISAGREE                  517
 *     unresolvable at any date              1,260   (3.3%)
 *
 * The 517 are the point: the as-of map is not merely wider, it contradicts the
 * current-state map on days when the ad carried a different creative. 98.4% of
 * ads only ever carry one creative, so this is a small, real correction.
 *
 * The 1,260 unresolvable ad-days are REPORTED, not filled. An ad-day with no
 * observation on or before its own date has no creative this reader is entitled
 * to invent, and the coverage counter above is how a caller sees the size of
 * that gap rather than guessing from a shorter array.
 */
export async function readCampaignContextCreativeDays(
  businessId: string,
  rangeStart: string,
  rangeEnd: string,
): Promise<CreativeDayRow[]> {
  const rows = await getDb().query<Row & { unresolved_ad_days?: unknown; total_ad_days?: unknown }>(
    `
    WITH ad_days AS (
      SELECT
        d.provider_account_id,
        d.campaign_id,
        d.adset_id,
        d.ad_id,
        d.date,
        d.account_timezone,
        d.spend
      FROM meta_ad_daily d
      WHERE (d.business_ref_id::text = $1 OR d.business_id = $1)
        AND d.spend > 0
        AND d.campaign_id IS NOT NULL
        AND d.date <= $3::date
    ),
    /*
      One row per (account, ad, creative) with the instant that pairing was
      first observed. 98.4% of ads produce exactly one row here, so this stays
      small even though the source table is large.
    */
    /*
      Scoped to the ads this window actually has, and filtered on business_id
      ALONE. The usable index here is
      (business_id, provider_account_id, entity_type, entity_id, observed_at DESC);
      an OR business_ref_id::text = $1 beside it makes the leading column
      unusable and turns this into a scan of every ad row ever recorded.
      Measured on production the two columns hold identical values, so the OR
      bought nothing and cost the index.
    */
    /*
      THE LATEST OBSERVATION AT OR BEFORE THE DAY -- not the latest creative to
      have ever STARTED before it.

      This previously collapsed history to one row per (ad, creative) keyed on
      MIN(observed_at), then picked the group with the newest first-seen. That
      answers "which creative did this ad most recently START running?", which
      is a different question and gets an A -> B -> A return wrong: A first-seen
      in January, B in February, A restored in March. For every day after March
      the newest FIRST-seen is still B, so B wins forever and the restoration is
      invisible. Any creative that is ever re-used on an ad is mis-attributed
      from its second run onward.

      Reading the newest OBSERVATION instead is both correct and cheaper: the
      index (business_id, provider_account_id, entity_type, entity_id,
      observed_at DESC) makes this one seek per ad-day rather than an aggregate
      over the ad's whole history.

      AS OF THE PROVIDER-LOCAL DAY: d.date is a provider-local reporting day, so
      the exclusive end is midnight in the account's own zone. A bare (date + 1)
      would cast through the session zone and pick the wrong midnight in both
      directions.
    */
    resolved AS (
      SELECT
        a.provider_account_id,
        a.campaign_id,
        a.adset_id,
        a.ad_id,
        a.date,
        a.spend,
        asof.creative_id
      FROM ad_days a
      LEFT JOIN LATERAL (
        /*
          The newest row is taken UNCONDITIONALLY and then judged, rather than
          filtering the unwanted ones out of the ordering.

          creative_id IS NOT NULL was the filter here and it never excluded
          anything: measured on production, creative_id is non-null on all
          2,383,235 ad rows. What it failed to exclude is the row shape that
          actually matters. 107 ads carry presence = 'absent_unconfirmed' as
          their NEWEST state, and those rows have no creativeId entry in
          field_coverage_json -- they still carry a creative_id value, but
          nothing observed it. 19 of those ads have spend in the trailing 90
          days, so this was live, not theoretical.

          D075: "an absent_unconfirmed winner is absence EVIDENCE, never a
          provider state." Skipping such a row to reach an older present one
          would assert that the ad was still running that creative on a day
          when the provider declined to confirm the ad at all. Nulling it
          reports the day as unresolved instead, which is what the coverage
          counter exists to surface. decisions-workspace-read-model.ts makes
          the same choice for status and for the same reason.
        */
        SELECT
          CASE
            WHEN h.presence = 'present'
             AND h.field_coverage_json->>'creativeId' = 'true'
            THEN h.creative_id
          END AS creative_id
        FROM meta_entity_state_history h
        WHERE h.business_id = $1
          AND h.provider_account_id = a.provider_account_id
          AND h.entity_type = 'ad'
          AND h.observed_at < (
            (a.date + 1)::timestamp
            AT TIME ZONE COALESCE(NULLIF(BTRIM(a.account_timezone), ''), 'UTC')
          )
          AND h.entity_id = a.ad_id
        ORDER BY h.observed_at DESC, h.captured_at DESC, h.id DESC
        LIMIT 1
      ) asof ON TRUE
    ),
    first_spend AS (
      SELECT provider_account_id, creative_id, MIN(date) AS first_spend_date
      FROM resolved
      WHERE creative_id IS NOT NULL
      GROUP BY provider_account_id, creative_id
    ),
    coverage AS (
      SELECT
        COUNT(*) AS total_ad_days,
        COUNT(*) FILTER (WHERE creative_id IS NULL) AS unresolved_ad_days
      FROM resolved
      WHERE date BETWEEN $2::date AND $3::date
    )
    SELECT
      r.provider_account_id,
      r.campaign_id,
      r.adset_id,
      r.creative_id,
      r.date::text AS date,
      SUM(r.spend) AS spend,
      fs.first_spend_date::text AS first_spend_date,
      MAX(coverage.total_ad_days) AS total_ad_days,
      MAX(coverage.unresolved_ad_days) AS unresolved_ad_days
    FROM resolved r
    JOIN first_spend fs
      ON fs.provider_account_id = r.provider_account_id
     AND fs.creative_id = r.creative_id
    CROSS JOIN coverage
    WHERE r.creative_id IS NOT NULL
      AND r.date BETWEEN $2::date AND $3::date
    GROUP BY r.provider_account_id, r.campaign_id, r.adset_id, r.creative_id,
             r.date, fs.first_spend_date
    UNION ALL
    /* Keep the coverage row when every spending ad-day lacks a confirmed
       creative. The returned sentinel is filtered from role inputs below. */
    SELECT NULL::text, NULL::text, NULL::text, NULL::text,
           NULL::text, NULL::numeric, NULL::text,
           coverage.total_ad_days, coverage.unresolved_ad_days
    FROM coverage
    WHERE coverage.total_ad_days > 0
      AND NOT EXISTS (
        SELECT 1 FROM resolved r
        WHERE r.creative_id IS NOT NULL
          AND r.date BETWEEN $2::date AND $3::date
      )
    `,
    [businessId, rangeStart, rangeEnd],
  );

  const total = toNumber(rows[0]?.total_ad_days);
  const unresolved = toNumber(rows[0]?.unresolved_ad_days);
  lastCreativeDayCoverage = {
    spendingAdDays: total,
    resolvedAdDays: Math.max(0, total - unresolved),
    unresolvedAdDays: unresolved,
  };

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
