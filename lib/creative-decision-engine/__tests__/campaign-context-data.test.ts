import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: mocks.query }),
}));

import {
  readCampaignContextCampaignMeta,
  lastCampaignContextCreativeDayCoverage,
  readCampaignContextCreativeDays,
} from "../campaign-context/data";

describe("campaign context warehouse account scope", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("computes first-spend lineage separately inside each provider account", async () => {
    mocks.query.mockResolvedValue([
      {
        provider_account_id: "act_1",
        campaign_id: "cmp_1",
        adset_id: "adset_1",
        creative_id: "creative_1",
        date: "2026-08-28",
        spend: 12,
        first_spend_date: "2026-08-01",
      },
    ]);

    const rows = await readCampaignContextCreativeDays(
      "biz_1",
      "2026-08-01",
      "2026-08-28",
    );
    const [sql, params] = mocks.query.mock.calls[0] ?? [];

    expect(sql).toContain(
      "GROUP BY provider_account_id, creative_id",
    );
    // First-spend lineage stays per provider account; only the alias moved when
    // the reader switched from the collapsed creative-day table to ad grain.
    expect(sql).toContain(
      "fs.provider_account_id = r.provider_account_id",
    );

    /*
      THE REPAIR ITSELF.

      The reader used to select from meta_creative_daily, which is keyed
      (business, account, date, creative) with no campaign in the key: two
      ad-days of one creative in two campaigns on one day collapse into a single
      row whose campaign is whichever the writer saw first. Measured on
      production over 90 days, 1,298 creative-days collapsed that way — and the
      resolver being fed those rows exists to classify a campaign.

      meta_ad_daily keeps the relationship, and the ad-to-creative map is read
      AS OF the day from meta_entity_state_history (creative_id present on all
      2.38M ad rows) rather than from meta_ad_dimensions, which holds only the
      current state and is null for 41% of ads.
    */
    expect(sql).toContain("FROM meta_ad_daily d");
    expect(sql).not.toContain("FROM meta_creative_daily");
    expect(sql).toContain("FROM meta_entity_state_history h");

    // The as-of boundary is the account's own midnight. A bare (date + 1)
    // casts through the session zone and picks the wrong one in both
    // directions.
    expect(sql).toContain(
      "AT TIME ZONE COALESCE(NULLIF(BTRIM(a.account_timezone), ''), 'UTC')",
    );

    // Index-friendly: the usable index leads with business_id, and an
    // `OR business_ref_id::text` beside it made this a full scan. Measured:
    // >180s (statement timeout) before, ~1.0s after.
    expect(sql).toContain("h.business_id = $1");
    expect(sql).not.toMatch(/h\.business_ref_id::text = \$1/);
    expect(params).toEqual(["biz_1", "2026-08-01", "2026-08-28"]);
    expect(rows[0]?.providerAccountId).toBe("act_1");
  });

  it("resolves the newest OBSERVATION, which is what makes A -> B -> A correct", async () => {
    /*
      The reader briefly collapsed history to one row per (ad, creative) keyed
      on MIN(observed_at) and then took the group with the newest FIRST-seen.
      That answers "which creative did this ad most recently START running?",
      which gets a return to an earlier creative wrong. Demonstrated against
      real PostgreSQL with A first seen 2026-01-10, B 2026-02-10, A restored
      2026-03-10:

          day          newest-first-seen   newest-observation
          2026-01-20   A                   A
          2026-02-20   B                   B
          2026-04-20   B  (wrong)          A  (correct)

      Live impact when the fix landed: ZERO ads in production had ever returned
      to an earlier creative, so this was a latent logic error rather than a
      visible one. It is pinned because the next re-used creative would have
      been silently mis-attributed from its second run onward.
    */
    mocks.query.mockResolvedValue([]);
    await readCampaignContextCreativeDays("biz_1", "2026-08-01", "2026-08-28");
    const [sql] = mocks.query.mock.calls[0] ?? [];

    // Newest observation, not an aggregate over the ad's history.
    expect(sql).toContain("ORDER BY h.observed_at DESC");
    expect(sql).toContain("LIMIT 1");
    expect(sql).not.toContain("MIN(h.observed_at)");
    expect(sql).not.toContain("first_observed_at");
  });

  it("refuses a creative carried by ABSENCE evidence, and does not reach past it", async () => {
    /*
      `creative_id IS NOT NULL` was the gate here and it excluded nothing:
      creative_id is non-null on all 2,383,235 production ad rows. What it
      missed is the row shape that matters. 107 ads carry
      presence = absent_unconfirmed as their NEWEST state; those rows still
      carry a creative_id but have no creativeId entry in field_coverage_json,
      so nothing observed it. 19 of those ads have spend in the trailing 90
      days, so the gap was live rather than theoretical.

      D075: "an absent_unconfirmed winner is absence EVIDENCE, never a provider
      state." Demonstrated against real PostgreSQL with A observed
      2026-01-10 (present) and an unconfirmed absence 2026-03-10:

          2026-02-20 -> A       (before the absence, still confirmed)
          2026-04-20 -> NULL    (after it: unresolved, NOT a fallback to A)

      Reaching back to A would assert the ad was still running that creative on
      a day the provider declined to confirm the ad at all.

      Live impact when the gate landed: 336 spending ad-days belong to those 19
      ads and ALL 336 still resolve, because each absence is newer than the
      spending days. The correction is latent today and pinned so it stays
      correct when it is not.
    */
    mocks.query.mockResolvedValue([]);
    await readCampaignContextCreativeDays("biz_1", "2026-08-01", "2026-08-28");
    const [sql] = mocks.query.mock.calls[0] ?? [];

    expect(sql).toContain("h.presence = 'present'");
    expect(sql).toContain("h.field_coverage_json->>'creativeId' = 'true'");
    // The newest row is judged, not filtered out of the ordering -- filtering
    // would silently reach back to an older confirmed creative.
    expect(sql).not.toContain("AND h.creative_id IS NOT NULL");
  });

  it("keeps the SQL free of backticks, which would terminate the template literal", () => {
    // This file's query is a JS template literal. A backtick inside an
    // explanatory SQL comment closes the string and makes the module
    // unparseable -- it has happened while editing these comments.
    const source = readFileSync(
      "lib/creative-decision-engine/campaign-context/data.ts",
      "utf8",
    );
    const start = source.indexOf("    WITH ad_days AS (");
    const end = source.indexOf("    `,", start);
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, end)).not.toContain("`");
  });

  it("reports the ad-days it could not resolve instead of hiding them", async () => {
    /*
      An ad-day with no state-history observation on or before its own date has
      no creative this reader may invent. Measured on production, 1,260 of
      38,326 spending ad-days over 90 days are in that state. Dropping them
      silently would make the gap look like it did not exist; the coverage
      counter is how a caller sees its size.
    */
    mocks.query.mockResolvedValue([
      {
        provider_account_id: "act_1",
        campaign_id: "cmp_1",
        adset_id: "adset_1",
        creative_id: "creative_1",
        date: "2026-08-28",
        spend: 12,
        first_spend_date: "2026-08-01",
        total_ad_days: 100,
        unresolved_ad_days: 7,
      },
    ]);

    await readCampaignContextCreativeDays("biz_1", "2026-08-01", "2026-08-28");

    expect(lastCampaignContextCreativeDayCoverage()).toEqual({
      spendingAdDays: 100,
      resolvedAdDays: 93,
      unresolvedAdDays: 7,
    });
  });

  it("keeps unresolved coverage when no spending ad-day has a confirmed creative", async () => {
    mocks.query.mockResolvedValue([{
      provider_account_id: null,
      campaign_id: null,
      adset_id: null,
      creative_id: null,
      date: null,
      spend: null,
      first_spend_date: null,
      total_ad_days: 7,
      unresolved_ad_days: 7,
    }]);

    const rows = await readCampaignContextCreativeDays(
      "biz_1", "2026-08-01", "2026-08-28",
    );
    const [sql] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain("UNION ALL");
    expect(rows).toEqual([]);
    expect(lastCampaignContextCreativeDayCoverage()).toEqual({
      spendingAdDays: 7,
      resolvedAdDays: 0,
      unresolvedAdDays: 7,
    });
  });

  it("reads campaign names and first-seen dates inside one exact provider account", async () => {
    mocks.query.mockResolvedValue([
      {
        provider_account_id: "act_2",
        campaign_id: "cmp_2",
        campaign_name: "Main evergreen",
        first_seen_date: "2026-07-01",
      },
    ]);

    const rows = await readCampaignContextCampaignMeta(
      "biz_1",
      "2026-08-28",
      "act_2",
    );
    const [sql, params] = mocks.query.mock.calls[0] ?? [];

    expect(sql).toContain(
      "SELECT DISTINCT ON (provider_account_id, campaign_id)",
    );
    expect(sql).toContain("provider_account_id = $3");
    expect(params).toEqual(["biz_1", "2026-08-28", "act_2"]);
    expect(rows.get("cmp_2")).toMatchObject({
      providerAccountId: "act_2",
      campaignName: "Main evergreen",
      firstSeenDate: "2026-07-01",
    });
  });
});
