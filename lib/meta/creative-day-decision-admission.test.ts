import { describe, expect, it } from "vitest";
import {
  creativeDayCompleteWindowSql,
  creativeDayConfigDecisionAdmissionSql,
  creativeDayDecisionAdmissionSql,
  creativeDaySourceCoverageSql,
} from "./creative-day-decision-admission";
import {
  META_CREATIVE_DAY_PARENT_GRAIN_CONTRACT_VERSION,
  META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION,
} from "./creatives-types";
import { COMPUTE_LIFECYCLE_ROWS_QUERY } from "@/lib/creative-decision-engine/jobs/lifecycle-job";
import { NATIVE_AD_METRIC_CONTRACT } from "@/lib/creative-decision-engine/evaluation-store";

describe("creative-day decision admission", () => {
  it("requires both exact member identity and one verified campaign/adset parent", () => {
    const sql = creativeDayDecisionAdmissionSql("d");
    expect(sql).toContain(`d.payload_json->>'source_identity_version' = '${META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION}'`);
    expect(sql).toContain("d.payload_json->>'source_ad_ids_complete' = 'true'");
    expect(sql).toContain("jsonb_array_length(d.payload_json->'source_creative_ids') = 1");
    expect(sql).toContain("d.payload_json->'source_creative_ids'->>0 = d.creative_id");
    expect(sql).toContain("associated_ads_count");
    expect(creativeDayDecisionAdmissionSql()).toContain("payload_json->>'source_parent_grain_complete' = 'true'");
    expect(() => creativeDayDecisionAdmissionSql("d; DROP TABLE x")).toThrow("Invalid creative-day SQL alias");
  });

  it("requires separate full-day receipt authority before a creative row can feed legacy decisions", () => {
    const sql = creativeDayConfigDecisionAdmissionSql("d", "$2");
    expect(sql).toContain("source_identity_version");
    expect(sql).toContain("source_parent_grain_complete");
    expect(sql).toContain("historical_config_provenance' IN ('provider_receipt_day_bracketed', 'provider_receipt_legacy_bracketed')");
    expect(sql).not.toContain("'unverified'");
    expect(sql).toContain("historical_config_proof,knowledge_cutoff_at");
    expect(sql).toContain("historical_config_proof,last_receipt_observed_at");
    expect(sql).toContain("LEAST(now(), (($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC'))");
    expect(sql).toContain("IS NOT DISTINCT FROM");
    expect(sql).toContain("historical_config_proof,custom_conversion_id");
    expect(sql).toContain("d.created_at <= LEAST(now()");
    expect(sql).toContain("d.updated_at <= LEAST(now()");
    expect(() => creativeDayConfigDecisionAdmissionSql("d", "now()"))
      .toThrow("requires an as-of date parameter");
  });

  it("applies the admission to every lifecycle creative-day scan and hashes both contracts for native evaluation", () => {
    expect(COMPUTE_LIFECYCLE_ROWS_QUERY.match(/FROM meta_creative_daily d/g)).toHaveLength(6);
    expect(COMPUTE_LIFECYCLE_ROWS_QUERY.match(/source_parent_grain_complete/g)).toHaveLength(7);
    expect(COMPUTE_LIFECYCLE_ROWS_QUERY.match(/historical_config_provenance/g)).toHaveLength(7);
    expect(COMPUTE_LIFECYCLE_ROWS_QUERY).toContain("unverified_creative_day");
    expect(NATIVE_AD_METRIC_CONTRACT.creativeDayMembership).toBe(META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION);
    expect(NATIVE_AD_METRIC_CONTRACT.creativeDayParentGrain).toBe(META_CREATIVE_DAY_PARENT_GRAIN_CONTRACT_VERSION);
  });

  it("excludes an entire creative window when any delivered day fails admission", () => {
    const sql = creativeDayCompleteWindowSql("d", "$2", 90);
    expect(sql).toContain("unverified_creative_day.creative_id = d.creative_id");
    expect(sql).toContain("unverified_creative_day.conversions <> 0");
    expect(sql).toContain("unverified_creative_day.impressions <> 0");
    expect(sql).toContain("AND NOT COALESCE(");
    expect(sql).toContain("meta_authoritative_publication_pointers");
    expect(sql).toContain("unnest(source_day.source_ad_ids)");
    expect(() => creativeDayCompleteWindowSql("d", "$2", 0)).toThrow("Invalid creative-day decision window");
  });

  it("compares source Ad membership and account-day totals under the cutoff", () => {
    const sql = creativeDaySourceCoverageSql("d", "$2", 90, "$8");
    expect(sql).toContain("source_ad.business_id = d.business_ref_id::text");
    expect(sql).toContain("creative_source_account.provider_account_id = d.provider_account_id");
    expect(sql).toContain("covered_creative_day.updated_at <= LEAST(now()");
    expect(sql).toContain("pointer.published_by_run_id = source_day.source_run_id");
    expect(sql).toContain("creative_totals.spend");
    expect(sql).toContain("source_day.source_ad_ids");
  });
});
