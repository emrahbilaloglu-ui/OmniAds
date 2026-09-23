/**
 * The rule that decides whether a stored config field may speak for a past day.
 *
 * Every case here is a way the old readers admitted a value they should not
 * have, or a guard that was paid for with a live measurement. If one of these
 * fails, one of the two readers has drifted from the other again.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  META_CONFIG_CONTRACT_ADSET_FIELDS,
  META_CONFIG_CONTRACT_CAMPAIGN_FIELDS,
  buildMetaAdsetConfigFieldSourceSql,
  META_CONFIG_FIELD_SOURCE_CONTRACT_VERSION,
  PROVIDER_CONFIG_RECEIPT_SOURCE_KIND,
  TYPED_CONTEMPORANEOUS_SOURCE_KIND,
  buildMetaConfigFieldSourceSql,
  readinessForConfigFieldTier,
  META_CONFIG_FIELD_TIERS,
  accountNarrowingSql,
  CORROBORATION_HORIZON_DAYS,
  META_CONFIG_FIELD_BRACKETED_TIERS,
  META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION,
  META_CONFIG_FIELD_RECEIPT_BACKED_TIERS,
  META_CONFIG_FIELD_SOURCE_NORMALIZATION_VERSION,
  RESOLUTION_TIE_BREAK_SQL,
  readinessCaseSql,
  receiptFieldScopeHashSql,
} from "@/lib/meta/config-field-source-contract";
import {
  META_CONFIG_EVIDENCE_BRACKETED_TIERS,
  META_CONFIG_EVIDENCE_RECEIPT_TIERS,
} from "@/lib/meta/config-field-evidence-ref";

const sql = buildMetaConfigFieldSourceSql({
  dayExpression: "d.date",
  timezoneExpression: "d.account_timezone",
  businessParam: "$1",
  scopeStartParam: "$2",
  scopeEndParam: "$3",
  evaluationCutoffParam: "$4",
  accountExpression: "d.provider_account_id",
  campaignExpression: "d.campaign_id",
  campaignScopeSql: "SELECT DISTINCT campaign_id FROM scope",
  scopeRelationSql:
    "SELECT provider_account_id, campaign_id, date, account_timezone FROM scope",
  /* As above: this instance exercises the diagnostic resolution as well. */
  includeRestated: true,
});
/** Everything the contract emits, as one string, for shape assertions. */
const emitted = [sql.withSql, sql.lateralSql, sql.tierSql("objective")].join("\n");

describe("what the tiers are allowed to do", () => {
  it("gives execution authority only to a receipt that proves the WHOLE day", () => {
    expect(readinessForConfigFieldTier("provider_receipt_day_bracketed")).toBe(
      "decision_authority",
    );
  });

  it("holds a point-in-day receipt to review only", () => {
    // It proves the config at an instant, not across the day whose metrics the
    // 28-day cell aggregates; a write later that day cannot be ruled out.
    expect(readinessForConfigFieldTier("provider_receipt_point_in_day")).toBe(
      "review_only",
    );
  });

  it("holds the typed witness to review only, because it cites no receipt", () => {
    // creatives-warehouse.ts:1193 hard-codes sourceSnapshotId: null, and the
    // payload it would cite is a projection of the column itself.
    expect(readinessForConfigFieldTier("typed_contemporaneous")).toBe("review_only");
  });

  it("does not claim a policy the plan does not state", () => {
    /*
      A helper here once asserted that a weak objective never withholds a Cut. The
      approved plan says that about ROLE uncertainty only; objective selects the
      cohort and therefore the target, so there is no economic Cut to release when
      it is missing. The absence of the helper is the point.
    */
    const source = readFileSync("lib/meta/config-field-source-contract.ts", "utf8");
    expect(source).not.toContain("MayWithholdCut(");
    expect(source).toContain("not an application of D097");
  });

  it("gives an unknown tier nothing", () => {
    expect(readinessForConfigFieldTier("unknown")).toBe("none");
  });
});

describe("the source is the raw observation, never typed history", () => {
  it("never reads meta_campaign_config_history at all", () => {
    /*
      That table is a TRANSITION log: when a later observation finds the config
      unchanged it writes nothing. A same-day history lookup therefore reports
      unknown from the second day onward however many successful fetches
      happened — the history is silent precisely because nothing changed.
    */
    expect(emitted).not.toContain("meta_campaign_config_history");
    expect(sql.withSql).toContain("FROM meta_raw_snapshot_observations obs");
    expect(sql.withSql).toContain("JOIN meta_raw_snapshots snap");
  });

  it("takes the value out of the retained payload, not a derived column", () => {
    expect(sql.withSql).toContain("entity.payload->>'objective'");
    // The expansion is scoped to the campaigns the caller needs.
    expect(sql.withSql).toContain("SELECT DISTINCT campaign_id FROM scope");
  });

  it("admits only an observation that completed AND asked for the field", () => {
    // The outage was a 200 for a reduced field list standing beside a 400 for
    // the full one, and canonical raw content is shared between observations.
    for (const clause of [
      "obs.status = 'fetched'",
      "obs.provider_http_status = 200",
      "'complete' = 'true'",
      "'termination' = 'natural_end'",
      "LIKE '%,objective,%'",
    ]) {
      expect(sql.withSql, clause).toContain(clause);
    }
  });

  it("dates the row by ITS OWN page clock, never the aggregate", () => {
    /*
      A receipt stores a merged multi-page payload, so the observation's
      observed_at and the snapshot's fetched_at describe the aggregation. On a
      two-page account that can put a row on the wrong side of a day boundary.
    */
    expect(sql.withSql).toContain("rowObservedAtByEntityId");
    // snap.fetched_at is admissible ONLY for the snapshot-only legacy branch.
    expect(sql.withSql).toContain("snap.fetched_at AS observed_at");
    /*
      The aggregate clock appears ONLY as a scan prune, never as the admission
      test: it is always paired with the interval slack, and the bare
      day-boundary comparisons are all on the per-entity clock.
    */
    // Collapse whitespace first: these prunes span lines.
    const flat = sql.withSql.replace(/\s+/g, " ");
    for (const aggregate of flat.match(/obs\.observed_at [<>]=? [^)]*?(?=AND |ORDER )/g) ?? []) {
      expect(aggregate, aggregate).toContain("INTERVAL");
    }
    expect(flat).toContain("obs.observed_at >=");
  });

  it("refuses a modern receipt missing THIS entity's page clock, rather than guessing", () => {
    // Falling back to the aggregate clock for one missing entity would date a row
    // by the merge instant and still call it modern.
    expect(sql.withSql).toContain("WHEN q.is_modern");
    expect(sql.withSql).toContain("WHEN q.is_single_page THEN q.observed_at");
    expect(sql.withSql).toContain("ELSE NULL");
  });

  it("admits a snapshot-only legacy receipt ONLY when no observation exists", () => {
    expect(sql.withSql).toContain("FROM meta_raw_snapshots snap");
    expect(sql.withSql).toContain("NOT EXISTS (");
    expect(sql.withSql).toContain("WHERE o.snapshot_id = snap.id");
  });

  it("bounds authority by the evaluation cutoff, so a replay cannot see forward", () => {
    const tier = sql.tierSql("objective");
    expect(tier).toContain("$4::timestamptz");
    expect(sql.pitClassSql("objective")).toContain("as_of_known");
    expect(sql.pitClassSql("objective")).toContain("restated");
  });
});

describe("what proves a DAY rather than an instant", () => {

  it("requires the provider clock to predate the day before calling it bracketed", () => {
    const tier = sql.tierSql("objective");
    // The clock is cast through the strict instant guard, then compared.
    expect(tier).toContain("cfgsrc_receipt.entity_updated_time");
    expect(tier).toContain("pg_input_is_valid");
    expect(tier).toContain("<= (d.date::timestamp AT TIME ZONE");
    expect(tier).toContain("cfgsrc_corrob.row_observed_at IS NOT NULL");
    expect(tier).toContain("'provider_receipt_day_bracketed'");
  });

  it("falls back to point_in_day rather than claiming the day", () => {
    expect(sql.tierSql("objective")).toContain("'provider_receipt_point_in_day'");
  });
});

/*
  ── THE MULTI-PAGE INTERVAL, MEASURED RATHER THAN ASSUMED ────────────────────

  A legacy multi-page receipt has one clock for a merged response, so nothing in
  it says which page carried which row. The tier above it refuses authority for
  that reason — but the hazard being refused is specific: a fetch that STRADDLED
  a provider-local midnight. When the writer records the first request and the
  last response, that hazard is testable, and a fetch proven to sit inside one
  local day dates every row it returned to that day.

  Why this matters and is not a loosening: on the live warehouse two accounts
  never once return a single page, and they carry 18.0% of the 28-day spend.
  Without a way to prove the interval they are held forever by page count rather
  than by evidence. The tests below pin both halves — the proof is read, and it
  is read strictly.
*/
describe("a multi-page receipt can PROVE its interval, or stay uncertain", () => {
  const bothGrains = [
    ["campaign", sql] as const,
    ["ad-set", adset] as const,
  ];

  it.each(bothGrains)(
    "%s: reads the recorded first request and last response",
    (_grain, built) => {
      expect(built.withSql).toContain("'pagination'->>'startedAt'");
      expect(built.withSql).toContain("'pagination'->>'completedAt'");
    },
  );

  it.each(bothGrains)(
    "%s: compares them as INSTANTS, so a bare date cannot answer the day",
    (_grain, built) => {
      /*
        A bare '2026-09-15' passes pg_input_is_valid and becomes local midnight,
        which would make the same-day test true by construction. The strict
        shape guard is what stops a truncated timing from proving anything.
      */
      const proof = built.withSql.slice(
        built.withSql.indexOf("'pagination'->>'startedAt'"),
      );
      expect(proof).toContain("pg_input_is_valid");
      expect(proof).toContain("[0-9]{2}:[0-9]{2}:[0-9]{2}");
    },
  );

  it.each(bothGrains)(
    "%s: requires start, end AND the row's own clock on one LOCAL date",
    (_grain, built) => {
      /*
        Three dates, not two. The pagination block belongs to the observation
        row, so a timing pair that disagrees with the clock printed beside it is
        not evidence about this sighting and is refused rather than reconciled.
      */
      const proof = built.withSql.slice(
        built.withSql.indexOf("'pagination'->>'startedAt'"),
      );
      expect(proof).toContain("AT TIME ZONE COALESCE(NULLIF(BTRIM(tz.account_timezone");
      expect(proof).toContain("q.observed_at AT TIME ZONE");
    },
  );

  it.each(bothGrains)(
    "%s: refuses to infer a provider-local day when the account zone is missing",
    (_grain, built) => {
      expect(built.withSql).toContain(
        "NULLIF(BTRIM(tz.account_timezone), '') IS NOT NULL",
      );
    },
  );

  it("withholds every config authority tier when the account zone is missing", () => {
    for (const tier of [
      sql.tierSql("objective"),
      adset.tierSql("optimization_goal"),
    ]) {
      expect(tier).toContain(
        "WHEN NULLIF(BTRIM(d.account_timezone), '') IS NULL THEN 'unknown'",
      );
    }
  });

  it.each(bothGrains)(
    "%s: keeps the uncertainty unless the proof holds, and defaults to FALSE",
    (_grain, built) => {
      /*
        Fail-closed in both directions. COALESCE(..., FALSE) means a receipt
        written before these timings existed is unproven rather than NULL, and
        the uncertainty flag still requires legacy AND not-proven-single-page
        before the new proof is even consulted.
      */
      expect(built.withSql).toContain("), FALSE)");
      expect(built.withSql).toContain(
        "(NOT q.is_modern AND q.is_single_page IS NOT TRUE\n        AND NOT q.is_paged_within_day) AS is_interval_uncertain",
      );
    },
  );

  it("names the proven multi-page receipt apart from the single-page one", () => {
    /*
      A proven receipt must not be reported as one page when there were nine.
      Both ladders carry the arm, and it sits BELOW the point observation: the
      day is proven, the instant inside it is not.
    */
    for (const tier of [sql.tierSql("objective"), adset.tierSql("optimization_goal")]) {
      expect(tier).toContain("'provider_receipt_legacy_paged_within_day'");
      expect(tier.indexOf("'provider_receipt_point_in_day'")).toBeLessThan(
        tier.indexOf("'provider_receipt_legacy_paged_within_day'"),
      );
      expect(tier.indexOf("'provider_receipt_legacy_paged_within_day'")).toBeLessThan(
        tier.indexOf("'provider_receipt_legacy_single_page'"),
      );
    }
  });

  it("holds the proven receipt to review only, never to execution authority", () => {
    expect(
      readinessForConfigFieldTier("provider_receipt_legacy_paged_within_day"),
    ).toBe("review_only");
  });

  it("carries the proof through resolution, or the tier could never read it", () => {
    /* The flag is computed in the receipts CTE and consumed in the ladder, so
       every projection between the two has to name it. */
    expect(sql.withSql).toContain("r.is_paged_within_day");
    expect(adset.withSql).toContain("r.is_paged_within_day");
  });
});

describe("the typed witness carries all four guards", () => {
  it("requires BOTH clocks inside the provider-local day", () => {
    /*
      The upsert does objective = COALESCE(EXCLUDED.objective, existing) while
      advancing updated_at unconditionally, so same-day updated_at alone proves
      nothing; created_at inside the day means every write it received was
      inside the day.
    */
    expect(sql.withSql).toContain("cre.created_at >= (cre.date::timestamp AT TIME ZONE");
    expect(sql.withSql).toContain("cre.updated_at < ((cre.date + 1)::timestamp AT TIME ZONE");
  });

  it("requires a single ad and a real provider ad id anchored at ad grain", () => {
    // meta_creative_daily.ad_id is a creative hash, and the writer coalesces the
    // campaign relation on merge, so the row's own campaign_id is not evidence.
    expect(sql.withSql).toContain("associated_ads_count");
    expect(sql.withSql).toContain("anchor.ad_id = cre.payload_json->>'real_ad_id'");
    expect(sql.withSql).toContain("anchor.campaign_id = cre.campaign_id");
  });

  it("refuses a day that carries two different values rather than picking one", () => {
    expect(sql.withSql).toContain("COUNT(DISTINCT BTRIM(cre.objective))");
    expect(sql.lateralSql).toContain("w.distinct_values = 1");
  });

  it("keeps the witness scoped to objective only", () => {
    // The nested edge also supplies optimization_goal, but that is an AD-SET
    // fact: one campaign can hold ad sets with different goals, so carrying it
    // campaign-wide would be wrong for all but one of them.
    const witnessBlock = sql.withSql.slice(sql.withSql.indexOf("meta_creative_daily cre"));
    expect(witnessBlock).not.toContain("optimization_goal");
    expect(sql.valueSql("objective")).toContain("cfgsrc_witness.objective");
  });
});

describe("the emitted expressions", () => {
  it("prefers the receipt over the witness, and yields NULL when neither holds", () => {
    const value = sql.valueSql("objective");
    expect(value.indexOf("cfgsrc_receipt")).toBeLessThan(value.indexOf("cfgsrc_witness"));
    // Never coalesced into a confident value.
    expect(value).toContain("ELSE NULL");
  });

  it("always yields a tier and a readiness, never NULL", () => {
    expect(sql.tierSql("objective")).toContain("ELSE 'unknown'");
    expect(sql.readinessSql("objective")).toContain("ELSE 'none'");
  });

  it("keeps EVERY emitted SQL string free of backticks", () => {
    /*
      A prose backtick inside one of these template literals has broken parsing
      six times. Checking the emitted strings catches it wherever it is written.
    */
    for (const emitted of [
      sql.withSql, sql.lateralSql, sql.tierSql("objective"),
      adset.withSql, adset.lateralSql, adset.tierSql("optimization_goal"),
    ]) {
      expect(emitted.includes("`")).toBe(false);
    }
  });

  it("keeps the SQL free of backticks, which would end the template literal", () => {
    expect(emitted.includes("`")).toBe(false);
    expect(sql.valueSql("objective").includes("`")).toBe(false);
    expect(sql.tierSql("objective").includes("`")).toBe(false);
  });

  it("isolates instances by alias prefix so one query can carry several", () => {
    const other = buildMetaConfigFieldSourceSql({
      dayExpression: "x.date",
      timezoneExpression: "x.tz",
      businessParam: "$3",
      scopeStartParam: "$5",
      scopeEndParam: "$6",
      evaluationCutoffParam: "$7",
      accountExpression: "x.acct",
      campaignExpression: "x.camp",
      campaignScopeSql: "SELECT 1",
      scopeRelationSql: "SELECT 1, 2, 3, 4",
      aliasPrefix: "second",
    });
    expect(other.lateralSql).toContain("second_receipt");
    expect(other.lateralSql).toContain("second_corrob");
    expect(other.lateralSql).not.toContain("cfgsrc_receipt");
    expect(other.valueSql("objective")).toContain("second_witness");
  });
});

describe("versioning", () => {
  it("names the rule, so a stored decision can say which one it used", () => {
    expect(META_CONFIG_FIELD_SOURCE_CONTRACT_VERSION).toBe("meta-config-field-source.v1");
    expect(sql.contractVersion).toBe(META_CONFIG_FIELD_SOURCE_CONTRACT_VERSION);
  });

  it("reserves a distinct source_kind for a derived value, unused by any writer", () => {
    expect(TYPED_CONTEMPORANEOUS_SOURCE_KIND).not.toBe(PROVIDER_CONFIG_RECEIPT_SOURCE_KIND);
  });
});


const adset = buildMetaAdsetConfigFieldSourceSql({
  dayExpression: "d.date",
  timezoneExpression: "d.account_timezone",
  businessParam: "$1",
  scopeStartParam: "$2",
  scopeEndParam: "$3",
  evaluationCutoffParam: "$4",
  accountExpression: "d.provider_account_id",
  adsetExpression: "d.adset_id",
  adsetScopeSql: "SELECT DISTINCT adset_id FROM scope",
  scopeRelationSql:
    "SELECT provider_account_id, adset_id, date, account_timezone FROM scope",
  /* The shape assertions below cover the diagnostic resolution too, so this
     instance asks for it. Production does not: see the default-off cases. */
  includeRestated: true,
});

describe("the clock the bracket reads must have been requested", () => {
  it("guards BOTH ends in the campaign contract, not just the ad-set one", () => {
    /*
      Canonical payload reuse means an objective-only observation can inherit an
      older payload's updated_time. Comparing a clock nobody asked for would
      bracket a day on an artefact.
    */
    const tier = sql.tierSql("objective");
    expect(tier).toContain("cfgsrc_receipt.requested_updated_time");
    expect(tier).toContain("cfgsrc_corrob.requested_updated_time");
    expect(sql.withSql).toContain("AS requested_updated_time");
  });

  it("guards BOTH ends in the ad-set contract", () => {
    const tier = adset.tierSql("optimization_goal");
    expect(tier).toContain("_day.requested_updated_time");
    expect(tier).toContain("_next.requested_updated_time");
  });
});

describe("the effective selector subtracts what a degraded response dropped", () => {
  it("routes EVERY selector check through the one guard, with no raw path", () => {
    /*
      This has silently regressed twice: a branch kept a hand-written
      `fields LIKE '%,token,%'` while its sibling used the guard, so a degraded
      HTTP 200 whose droppedFields contained the field could still authorise the
      value sitting in the shared canonical payload. Asserting on the emitted SQL
      is not enough — the check is that the module has exactly ONE place where a
      selector is parsed at all.
    */
    const source = readFileSync("lib/meta/config-field-source-contract.ts", "utf8");
    const helperStart = source.indexOf("function effectiveSelectorHasToken(");
    const helperEnd = source.indexOf("\n}", helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    // EVERY selector parse must live inside the one helper.
    let at = source.indexOf("regexp_replace(");
    let count = 0;
    while (at !== -1) {
      expect(at, `regexp_replace at offset ${at} is outside the helper`).toBeGreaterThan(helperStart);
      expect(at).toBeLessThan(helperEnd);
      count += 1;
      at = source.indexOf("regexp_replace(", at + 1);
    }
    expect(count).toBeGreaterThan(0);
    // And no branch may hand-roll a comma-list comparison of its own.
    const outside = source.slice(0, helperStart) + source.slice(helperEnd);
    expect(outside).not.toContain("LIKE '%,");
  });

  it("reads droppedFields as an array or a comma string, and fails closed", () => {
    for (const emitted of [sql.withSql, adset.withSql]) {
      expect(emitted).toContain("'droppedFields'");
      expect(emitted).toContain("WHEN 'array' THEN");
      expect(emitted).toContain("WHEN 'string'");
      // Recovered, with no readable list of what it dropped: refuse the field.
      expect(emitted).toContain("'recovered', 'false') = 'true'");
    }
  });
});

describe("the ad-set contract keeps its own grain and its own selectors", () => {
  it("authorises custom_event_type by its CONTAINER token, not its own name", () => {
    // The field lives inside promoted_object; requiring the literal field name
    // would reject every response that legitimately carries it.
    expect(adset.withSql).toContain("'%,promoted_object,%'");
    expect(adset.withSql).toContain("payload->'promoted_object'->>'custom_event_type'");
    expect(META_CONFIG_CONTRACT_ADSET_FIELDS).toEqual([
      "optimization_goal",
      "custom_event_type",
      "custom_conversion_id",
    ]);
  });

  it("gates each field by its OWN selector flag, per field", () => {
    /*
      A field is gated by a selector flag for ITS OWN token. Fields that share a
      token — `custom_event_type` and `custom_conversion_id`, both keys of one
      `promoted_object` — share one resolution and therefore one flag, which is
      the same predicate written once; the builder refuses a group whose members
      disagree on the token.
    */
    for (const field of META_CONFIG_CONTRACT_ADSET_FIELDS) {
      const gate =
        field === "custom_conversion_id" ? "custom_event_type" : field;
      expect(adset.withSql, field).toContain(`r.requested_${gate}`);
      /*
        Field-specific ranking, but NO value filter: a receipt that requested the
        field and came back without it is an observed absence and must be able to
        win, or a stale value survives the receipt that disproves it. That applies
        to the diagnostic pick too.
      */
      expect(adset.withSql, field).not.toContain(`r.${field} IS NOT NULL`);
      expect(adset.withSql, field).toContain(`${gate}_day AS MATERIALIZED`);
      expect(adset.withSql, field).toContain(`${gate}_next AS MATERIALIZED`);
      expect(adset.withSql, field).toContain(`${gate}_restated AS MATERIALIZED`);
      /* Each member keeps its OWN value column, so a shared receipt cannot lend
         one field's bracket agreement to another's. */
      expect(adset.withSql, field).toContain(`AS value_${field}`);
      expect(adset.valueSql(field), field).toContain(`.value_${field}`);
      expect(adset.tierSql(field), field).toContain(`.value_${field}`);
    }
    /*
      Three fields, two resolutions: the group saved a whole CTE triple. Counted
      on the RESOLUTION aliases by name — a bare "_day AS MATERIALIZED" also
      matches the post-expansion entity-day compression, which is a different
      thing and would make this count the wrong quantity.
    */
    expect(
      (adset.withSql.match(/_(optimization_goal|custom_event_type)_day AS MATERIALIZED/g) ?? [])
        .length,
    ).toBe(2);
    /* And the second compression layer is present exactly once. */
    expect(
      (adset.withSql.match(/_entity_day AS MATERIALIZED/g) ?? []).length,
    ).toBe(1);
  });

  it("matches the ACCOUNT when attaching a payload to an observation", () => {
    // A snapshot id alone would let one account's metadata authorise another's
    // payload, because canonical content is deduplicated.
    expect(adset.withSql).toContain("snap.provider_account_id = d.provider_account_id");
    expect(adset.withSql).toContain("e.provider_account_id = q.provider_account_id");
  });

  it("names its scope input for what it carries, not what it was inherited as", () => {
    /*
      A caller obeying the name `campaignScopeSql` would pass campaign ids, which
      join against nothing in an adset_configs payload and return no entities at
      all — a total, quiet loss that reads as "no evidence exists". The type now
      refuses that call, and this pins the emitted join to the ad-set scope.
    */
    expect(adset.withSql).toContain("wanted(adset_id)");
    expect(adset.withSql).toContain("SELECT DISTINCT adset_id FROM scope");
  });

  it("never lets an ad-set goal be sourced campaign-wide", () => {
    // Resolution is keyed on the ad-set id, and the CTE only ever reads the
    // adset_configs endpoint at adset scope.
    expect(adset.lateralSql).toContain(".adset_id = d.adset_id");
    expect(adset.withSql).toContain("r.adset_id = s.adset_id");
    expect(adset.withSql).toContain("obs.endpoint_name = 'adset_configs'");
    expect(adset.withSql).toContain("obs.entity_scope = 'adset'");
    expect(adset.withSql).not.toContain("campaign_configs");
  });
});

/*
  ── THE SCOPE JOIN IS COMPUTED ONCE ─────────────────────────────────────────

  Every resolution used to carry its own copy of the same join, scope against the
  entity-day relation. The entity-day relation is a CTE, so it has no index and
  the planner estimates it at one row, which makes a nested loop look free; the
  planner then re-read the WHOLE relation once per scope row, per resolution.

  Measured read-only on production (TheSwaf, 1,394 scope rows, 5,488 entity-day
  rows): 1,394 x 5,488 = 7.65M row touches per resolution, six resolutions,
  45.9M touches and 5.8 s of a 10.0 s query. The cost was exactly linear in the
  number of resolutions (1 -> 1.47 s, 3 -> 3.52 s, 6 -> 6.28 s), which is how it
  was identified, and EXPLAIN showed 8,364 loops over that one CTE.

  After the hoist, the same EXPLAIN shows 6 loops and 12,256 touches, and the
  six resolution CTEs build in 3-6 ms each instead of 1.5-2.4 s. Row output is
  bit-identical (sha256 over the full result set, both accounts, every run).

  These tests pin the SHAPE that produces that. A regression here is not a
  correctness bug, so nothing else would catch it.
*/
describe("the scope join is hoisted, not repeated per resolution", () => {
  const grains = [
    ["campaign", sql, "cfgsrc_scoped", "campaign_id"] as const,
    ["ad-set", adset, "adsetcfg_scoped", "adset_id"] as const,
  ];

  it.each(grains)("%s: emits exactly one scope-join relation", (_g, built, scoped) => {
    expect(built.withSql).toContain(`${scoped} AS MATERIALIZED (`);
    // Defined once...
    expect(built.withSql.split(`${scoped} AS MATERIALIZED (`)).toHaveLength(2);
  });

  it.each(grains)("%s: every resolution reads it and joins nothing else", (_g, built, scoped, entity) => {
    /*
      The join to the entity-day relation must appear exactly ONCE, inside the
      hoisted relation. If a resolution grows its own copy again, this fails.
    */
    const joins = built.withSql.split(`r.${entity} = s.${entity}`).length - 1;
    expect(joins).toBe(1);
    // And each resolution's FROM is the hoisted relation.
    expect(built.withSql).toContain(`FROM ${scoped} r`);
  });

  it.each(grains)("%s: bounds the hoist by the UNION of every window", (_g, built, scoped) => {
    /*
      The safety of the hoist is entirely this bound. same-day and restated use
      [dayStart, dayEnd); corroboration uses [dayEnd, dayEnd + horizon). The
      hoist must admit [dayStart, dayEnd + horizon) so no resolution loses a
      candidate, and the horizon must come from the same constant the
      corroboration window uses, or the two can drift apart.
    */
    const block = built.withSql.slice(
      built.withSql.indexOf(`${scoped} AS MATERIALIZED (`),
    );
    const hoist = block.slice(0, block.indexOf("\n  )"));
    expect(hoist).toContain("r.row_observed_at >= (s.date::timestamp AT TIME ZONE");
    expect(hoist).toContain(
      `+ INTERVAL '${CORROBORATION_HORIZON_DAYS} days'`,
    );
    // No value filter and no per-field selector filter: those stay downstream.
    expect(hoist).not.toContain("requested_");
    expect(hoist).not.toContain("IS NOT NULL");
  });

  it.each(grains)("%s: keeps the timezone equality that keys the bucket", (_g, built, scoped) => {
    const block = built.withSql.slice(
      built.withSql.indexOf(`${scoped} AS MATERIALIZED (`),
    );
    const hoist = block.slice(0, block.indexOf("\n  )"));
    expect(hoist).toContain(
      "r.resolved_account_timezone = COALESCE(NULLIF(BTRIM(s.account_timezone), ''), 'UTC')",
    );
  });

  it.each(grains)("%s: resolutions read the day and zone off the hoisted row", (_g, built) => {
    /*
      Inside the hoisted relation the scope day is r.date and the account zone is
      r.resolved_account_timezone, which the join proved equal to the coalesced
      scope zone. A resolution that still said s.date would not compile, so this
      pins the intent rather than the syntax: no resolution may reintroduce its
      own scope alias.
    */
    const afterHoist = built.withSql.slice(
      built.withSql.indexOf("_scoped AS MATERIALIZED ("),
    );
    const resolutions = afterHoist.slice(afterHoist.indexOf("\n  )") + 4);
    expect(resolutions).not.toContain("s.date");
    expect(resolutions).not.toContain("s.account_timezone");
    expect(resolutions).toContain("r.date::timestamp AT TIME ZONE r.resolved_account_timezone");
  });

  it("de-duplicates the scope to the grain the resolutions key on", () => {
    /*
      One campaign carries many ad sets, so the campaign contract's scope rows
      repeat the same (account, campaign, date) once per ad set - 1,394 rows for
      482 distinct campaign-days on the account measured. DISTINCT ON collapsed
      them already, so this changes no answer; it removes the repeat before the
      join rather than after it.
    */
    for (const [, built, scoped, entity] of grains) {
      const block = built.withSql.slice(
        built.withSql.indexOf(`${scoped} AS MATERIALIZED (`),
      );
      expect(block).toContain(
        `SELECT DISTINCT provider_account_id, ${entity}, date, account_timezone`,
      );
    }
  });
});

/*
  ── A RELATION NOTHING READS IS A RELATION NOTHING NEEDS ────────────────────

  The restated resolution is a diagnostic: what today's warehouse says, as
  opposed to what the run could have known. It was emitted unconditionally and
  LEFT JOINed at every grain, and then, at ad-set grain, never read by anything.

  Repo-wide, `restatedValueSql` has exactly one production caller —
  ad-calibration-job.ts reads the CAMPAIGN objective as `objective_restated`.
  data-source.ts, the decision loader, reads no restated value at any grain.

  Measured read-only on production (Bilsem, 9,117 output rows, four interleaved
  rounds): stripping just the two dead AD-SET joins from the emitted SQL took the
  median from 9,441 ms to 8,267 ms and left the full result set bit-identical
  (sha256 285fcd90e7b178bf, the same hash every other run of that account
  produced). In the plan those two joins were 11.1M of the 44.1M row touches the
  final join performs.

  So the resolution is opt-in. These cases pin that the default emits nothing,
  that asking still works, and that asking for the VALUE without asking for the
  RELATION fails loudly at build time rather than emitting SQL that names a CTE
  the query does not contain.
*/
describe("the restated diagnostic is emitted only when it is read", () => {
  const campaignWithout = buildMetaConfigFieldSourceSql({
    dayExpression: "d.date",
    timezoneExpression: "d.account_timezone",
    businessParam: "$1",
    scopeStartParam: "$2",
    scopeEndParam: "$3",
    evaluationCutoffParam: "$4",
    accountExpression: "d.provider_account_id",
    campaignExpression: "d.campaign_id",
    campaignScopeSql: "SELECT DISTINCT campaign_id FROM scope",
    scopeRelationSql:
      "SELECT provider_account_id, campaign_id, date, account_timezone FROM scope",
  });
  const adsetWithout = buildMetaAdsetConfigFieldSourceSql({
    dayExpression: "d.date",
    timezoneExpression: "d.account_timezone",
    businessParam: "$1",
    scopeStartParam: "$2",
    scopeEndParam: "$3",
    evaluationCutoffParam: "$4",
    accountExpression: "d.provider_account_id",
    adsetExpression: "d.adset_id",
    adsetScopeSql: "SELECT DISTINCT adset_id FROM scope",
    scopeRelationSql:
      "SELECT provider_account_id, adset_id, date, account_timezone FROM scope",
  });

  it("defaults to OFF, so a caller pays for it only on request", () => {
    expect(adsetWithout.withSql).not.toContain("_restated AS MATERIALIZED");
    expect(adsetWithout.lateralSql).not.toContain("_restated");
    expect(campaignWithout.withSql).not.toContain("_restated AS MATERIALIZED");
    expect(campaignWithout.lateralSql).not.toContain("_restated");
  });

  it("still emits it, relation and join, when the caller asks", () => {
    expect(adset.withSql).toContain("_restated AS MATERIALIZED");
    expect(adset.lateralSql).toContain("FROM adsetcfg_optimization_goal_restated hit");
    expect(adset.lateralSql).toContain(") adsetcfg_optimization_goal_restated ON TRUE");
    expect(sql.withSql).toContain("_restated AS MATERIALIZED");
    expect(sql.lateralSql).toContain("FROM cfgsrc_restated hit");
  });

  it("refuses the VALUE when the RELATION was not emitted", () => {
    /*
      The failure this prevents is a query that parses in the builder and then
      dies in PostgreSQL naming a missing relation, which is a much worse place
      to find out.
    */
    expect(() => adsetWithout.restatedValueSql("optimization_goal")).toThrow(
      /includeRestated/,
    );
    expect(() => campaignWithout.restatedValueSql("objective")).toThrow(
      /includeRestated/,
    );
  });

  it("leaves every other emitted expression untouched by the flag", () => {
    /*
      Turning the diagnostic off must remove the diagnostic and nothing else, or
      this is not a dead-work removal. Compare the as-of expressions directly.
    */
    for (const field of META_CONFIG_CONTRACT_ADSET_FIELDS) {
      expect(adsetWithout.valueSql(field)).toBe(adset.valueSql(field));
      expect(adsetWithout.tierSql(field)).toBe(adset.tierSql(field));
      expect(adsetWithout.readinessSql(field)).toBe(adset.readinessSql(field));
      expect(adsetWithout.sourceClassSql(field)).toBe(adset.sourceClassSql(field));
      expect(adsetWithout.pitClassSql(field)).toBe(adset.pitClassSql(field));
    }
    expect(campaignWithout.valueSql("objective")).toBe(sql.valueSql("objective"));
    expect(campaignWithout.tierSql("objective")).toBe(sql.tierSql("objective"));
    expect(campaignWithout.readinessSql("objective")).toBe(
      sql.readinessSql("objective"),
    );
  });

  it("keeps the as-of resolutions, which are the ones decisions read", () => {
    /* The saving must come from the diagnostic only: both as-of picks stay. */
    expect(adsetWithout.withSql).toContain("_optimization_goal_day AS MATERIALIZED");
    expect(adsetWithout.withSql).toContain("_optimization_goal_next AS MATERIALIZED");
    expect(adsetWithout.withSql).toContain("_custom_event_type_day AS MATERIALIZED");
    expect(adsetWithout.withSql).toContain("_custom_event_type_next AS MATERIALIZED");
    expect(campaignWithout.withSql).toContain("cfgsrc_receipt AS MATERIALIZED");
    expect(campaignWithout.withSql).toContain("cfgsrc_corrob AS MATERIALIZED");
  });
});

describe("the withdrawn timeline compression stays withdrawn", () => {
  it("resolves the ANSWER set-based, and never re-derives it per row", () => {
    /*
      What was withdrawn is re-derivation: a lateral that ranked the whole
      receipt table once per ad-day. That is still gone, and this is the test
      that keeps it gone — the ranking happens ONCE per resolution, set-based,
      over the reduced relation, and the per-row work is a lookup of a row that
      was already decided.

      The lookup itself IS a lateral now, deliberately: each resolution is
      DISTINCT ON its join key so at most one row can match, and LIMIT 1 lets
      the scan stop at it instead of reading the whole relation once per output
      row. Paired read-only runs made that 8/8 rounds faster on both measured
      accounts, bit-identical. So the assertion is not "no lateral" - it is that
      no lateral may touch the receipt or entity-day relations.
    */
    expect(adset.withSql).toContain(
      "SELECT DISTINCT ON (r.provider_account_id, r.adset_id, r.date)",
    );
    for (const lateralSql of [adset.lateralSql, sql.lateralSql]) {
      for (const [, relation] of lateralSql.matchAll(/SELECT \* FROM ([a-z_]+) hit/g)) {
        expect(relation, relation).toMatch(/_(day|next|restated|receipt|corrob)$/);
        expect(relation, relation).not.toContain("_receipts");
        expect(relation, relation).not.toContain("_entity_day");
        expect(relation, relation).not.toContain("_scoped");
      }
    }
    /* And the ranking is never inside a lateral. */
    expect(adset.lateralSql).not.toContain("DISTINCT ON");
    expect(sql.lateralSql).not.toContain("DISTINCT ON");
  });

  it("looks a resolution up by its full key, and takes at most one row", () => {
    /*
      The parity of the lateral form rests on exactly two things: the three
      equalities that make the key complete, and the relation being unique on
      that key. Drop an equality and LIMIT 1 starts choosing arbitrarily.
    */
    for (const [lateralSql, entity] of [
      [adset.lateralSql, "adset_id"],
      [sql.lateralSql, "campaign_id"],
    ] as const) {
      const lookups = [...lateralSql.matchAll(/SELECT \* FROM [a-z_]+ hit[\s\S]*?LIMIT 1/g)];
      expect(lookups.length).toBeGreaterThan(0);
      for (const [lookup] of lookups) {
        expect(lookup).toContain("hit.provider_account_id =");
        expect(lookup).toContain(`hit.${entity} =`);
        expect(lookup).toContain("hit.date =");
        expect(lookup).toContain("LIMIT 1");
      }
    }
  });

  it("does not bucket observations by day, which lost fields three ways", () => {
    /*
      Compressing to the earliest and latest sighting per local day dropped the
      selector of any inner observation, mixed modern and legacy clock semantics,
      and mis-bucketed a per-entity clock that fell on a different local day than
      its observation's aggregate clock.
    */
    expect(adset.withSql).not.toContain("local_days");
    expect(adset.withSql).not.toContain("edges");
    expect(adset.withSql).not.toContain("latest_in_day");
    // Each distinct snapshot is still expanded once, which is exact.
    expect(adset.withSql).toContain("SELECT DISTINCT snapshot_id, provider_account_id");
  });
});

describe("the typed witness does not claim a receipt", () => {
  it("reports typed_unlinked, not legacy_observed", () => {
    // creatives-warehouse.ts:1193 hard-codes sourceSnapshotId: null.
    expect(sql.sourceClassSql("objective")).toContain("typed_unlinked");
    expect(sql.sourceClassSql("objective")).not.toContain("legacy_observed");
  });
});

const adsetLadderSql = buildMetaAdsetConfigFieldSourceSql({
  dayExpression: "d.date",
  timezoneExpression: "d.account_timezone",
  businessParam: "$1",
  scopeStartParam: "$2",
  scopeEndParam: "$3",
  evaluationCutoffParam: "$4",
  accountExpression: "d.provider_account_id",
  adsetExpression: "d.adset_id",
  adsetScopeSql: "SELECT DISTINCT adset_id FROM scope",
  scopeRelationSql:
    "SELECT provider_account_id, adset_id, date, account_timezone FROM scope",
});

describe("the readiness ladder is generated, not restated", () => {
  /*
    THE BUG THIS PINS. Two hand-written CASE ladders drifted from
    `readinessForConfigFieldTier` and from each other: the campaign ladder had no
    arm for `provider_receipt_pending_corroboration` and the ad-set ladder none
    for `typed_contemporaneous`, so each fell through to `ELSE 'none'`.

    The campaign omission is the one that cost something. That tier is what the
    freshest day of every run carries — a receipt whose corroboration window has
    not elapsed — so the CURRENT DAY's objective came back as "no provenance at
    all" rather than "not corroborated yet", and a consumer that distinguishes
    the two (every consumer of this contract does) drew the wrong conclusion.
  */
  it("gives every tier its own arm in BOTH grains", () => {
    const campaign = sql.readinessSql("objective");
    const adset = adsetLadderSql.readinessSql("optimization_goal");
    for (const tier of META_CONFIG_FIELD_TIERS) {
      const arm = `WHEN '${tier}' THEN '${readinessForConfigFieldTier(tier)}'`;
      expect(campaign).toContain(arm);
      expect(adset).toContain(arm);
    }
  });

  it("maps the pending tier to review_only in the CAMPAIGN ladder", () => {
    expect(sql.readinessSql("objective")).toContain(
      "WHEN 'provider_receipt_pending_corroboration' THEN 'review_only'",
    );
  });

  it("maps the typed witness to review_only in the AD-SET ladder", () => {
    expect(adsetLadderSql.readinessSql("optimization_goal")).toContain(
      "WHEN 'typed_contemporaneous' THEN 'review_only'",
    );
  });

  it("keeps ELSE for a non-tier, so an absent join is still none", () => {
    expect(sql.readinessSql("objective")).toContain(
      "ELSE 'none'",
    );
  });

  /* A tier added to the union but not to the list would emit no arm at all. */
  it("lists every tier the readiness function accepts", () => {
    expect(new Set(META_CONFIG_FIELD_TIERS).size).toBe(
      META_CONFIG_FIELD_TIERS.length,
    );
    expect(
      META_CONFIG_FIELD_TIERS.filter(
        (tier) => readinessForConfigFieldTier(tier) === "decision_authority",
      ),
    ).toEqual([
      "provider_receipt_day_bracketed",
      "provider_receipt_legacy_bracketed",
    ]);
  });
});

describe("the scans are narrowed to the scope, and that is parity-safe by shape", () => {
  /*
    ── WHY THIS IS A TEST AND NOT A COMMENT ───────────────────────────────────

    The creative-witness CTE was 151,034 of a 172,430-cost statement on the
    largest live account — 87.6% of it — because it scanned meta_creative_daily
    by business and date only and then ran a correlated EXISTS for every row it
    found. Narrowing it to the scope took the statement to 25,923.

    The narrowing is safe for a structural reason, not an empirical one: the
    GROUP BY key IS the set of columns being narrowed, so no surviving group can
    lose a row and `distinct_values` — the only cross-row aggregate — cannot
    change. A group that disappears is one the lateral could never have selected,
    because it matches on those same columns. If someone later adds a column to
    the narrowing that is NOT in the group key, or removes one from the key, that
    argument silently stops holding. This asserts the shape the argument needs.
  */
  /* The file's shared fixture has no account scope; this one does. */
  const scoped = buildMetaConfigFieldSourceSql({
    dayExpression: "d.date",
    timezoneExpression: "d.account_timezone",
    businessParam: "$1",
    scopeStartParam: "$2",
    scopeEndParam: "$3",
    evaluationCutoffParam: "$4",
    accountExpression: "d.provider_account_id",
    campaignExpression: "d.campaign_id",
    campaignScopeSql: "SELECT DISTINCT campaign_id FROM scope",
    scopeRelationSql:
      "SELECT provider_account_id, campaign_id, date, account_timezone FROM scope",
    accountScopeSql: "SELECT $5::text",
  });

  it("narrows the witness by exactly the columns it groups by", () => {
    const withSql = scoped.withSql;
    expect(withSql).toContain("AND cre.provider_account_id = $5::text");
    expect(withSql).toContain("AND cre.campaign_id IN (");
    /* The group key, and the lateral that consumes it, use the same three. */
    expect(withSql).toContain("GROUP BY 1, 2, 3");
    const witnessSelect = withSql.slice(
      withSql.indexOf("_witness_scope AS MATERIALIZED ("),
    );
    expect(witnessSelect.indexOf("cre.provider_account_id")).toBeLessThan(
      witnessSelect.indexOf("cre.campaign_id"),
    );
    expect(scoped.lateralSql).toContain("w.provider_account_id =");
    expect(scoped.lateralSql).toContain("w.campaign_id =");
    expect(scoped.lateralSql).toContain("w.date =");
  });

  it("omits the account narrowing entirely when no scope was given", () => {
    const unscoped = buildMetaConfigFieldSourceSql({
      dayExpression: "d.date",
      timezoneExpression: "d.account_timezone",
      businessParam: "$1",
      scopeStartParam: "$2",
      scopeEndParam: "$3",
      evaluationCutoffParam: "$4",
      accountExpression: "d.provider_account_id",
      campaignExpression: "d.campaign_id",
      campaignScopeSql: "SELECT DISTINCT campaign_id FROM scope",
      scopeRelationSql:
        "SELECT provider_account_id, campaign_id, date, account_timezone FROM scope",
    });
    expect(unscoped.withSql).not.toContain("AND obs.provider_account_id =");
    expect(unscoped.withSql).not.toContain("AND cre.provider_account_id =");
    /* The campaign narrowing does not depend on the optional account scope. */
    expect(unscoped.withSql).toContain("AND cre.campaign_id IN (");
  });
});

describe("the account narrowing is written so an index can use it", () => {
  /*
    `provider_account_id IN (SELECT ...)` is a subquery, and PostgreSQL will not
    fold a subquery into an index condition — so the predicate filtered rows
    without narrowing the SCAN. A caller whose scope is one account (every
    calibration batch) gets an equality instead.

    The detection is deliberately narrow. A pattern that guessed wider could
    rewrite a genuinely multi-row scope into an equality and silently drop
    accounts, which is the one failure that would not look like a failure.
  */
  it("rewrites a single scalar scope to an equality", () => {
    expect(accountNarrowingSql("obs", "SELECT $4::text")).toContain(
      "obs.provider_account_id = $4::text",
    );
    expect(accountNarrowingSql("obs", "  SELECT $7  ")).toContain(
      "obs.provider_account_id = $7",
    );
  });

  it("keeps IN for anything that could yield more than one row", () => {
    for (const scope of [
      "SELECT DISTINCT provider_account_id FROM config_scope",
      "SELECT $4::text UNION SELECT $5::text",
      "SELECT unnest($4::text[])",
      "SELECT $4::text FROM accounts",
    ]) {
      expect(accountNarrowingSql("obs", scope), scope).toContain(
        `obs.provider_account_id IN (${scope})`,
      );
    }
  });

  it("emits nothing at all when there is no scope", () => {
    expect(accountNarrowingSql("obs", undefined)).toBe("");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * RECEIPT LINEAGE
 *
 * The contract used to resolve a field to a value, a tier and a readiness and
 * drop WHICH receipt earned them. These pin the shape of what it now carries
 * and emits; `config-field-source-contract.db.test.ts` executes it and holds it
 * to the parser and the SQL coherence rule in `config-field-evidence-ref.ts`.
 * ──────────────────────────────────────────────────────────────────────────── */
describe("receipt lineage: the identity is carried, not re-derived", () => {
  it("reads the observation id off the receipt row, and a NULL off a snapshot-only row", () => {
    for (const emittedSql of [sql.withSql, adset.withSql]) {
      expect(emittedSql).toContain("obs.id AS observation_id");
      expect(emittedSql).toContain(receiptFieldScopeHashSql("obs"));
      expect(emittedSql).toContain(receiptFieldScopeHashSql("snap"));
    }
    /* Campaign names the column; the ad-set arm is positional. */
    expect(sql.withSql).toContain("NULL::uuid AS observation_id");
    expect(adset.withSql).toMatch(/FALSE,\s*\/\*[^*]*\*\/\s*NULL::uuid,/);
    /* Never inferred from the snapshot: no arm reads snap.id as an observation. */
    expect(sql.withSql).not.toMatch(/snap\.id AS observation_id/);
  });

  it("threads the identity through BOTH legacy compression arms", () => {
    /* The modern arm is q.*; the legacy arm lists columns and must list them too,
       in the same position, or UNION ALL would pair them with the wrong column. */
    expect(sql.withSql).toMatch(
      /requested_updated_time,\s*observation_id, field_scope_hash,\s*is_paged_within_day/,
    );
    expect(adset.withSql).toMatch(
      /has_observation, observation_id, field_scope_hash,\s*is_paged_within_day/,
    );
    expect(sql.withSql).toMatch(/q\.snapshot_id,[\s\S]*?q\.observation_id,\s*q\.field_scope_hash,/);
    expect(adset.withSql).toMatch(/q\.snapshot_id,[\s\S]*?q\.observation_id,\s*q\.field_scope_hash,/);
  });

  it("projects the chosen row's identity out of every resolution", () => {
    for (const alias of ["cfgsrc_receipt", "cfgsrc_corrob", "cfgsrc_restated"]) {
      const cte = sql.withSql.slice(sql.withSql.indexOf(`${alias} AS MATERIALIZED`));
      expect(cte, alias).toMatch(
        /^[^;]*?r\.snapshot_id, r\.observation_id, r\.field_scope_hash\s*FROM/,
      );
    }
    for (const lead of ["optimization_goal", "custom_event_type"]) {
      for (const kind of ["day", "next", "restated"]) {
        const alias = `adsetcfg_${lead}_${kind}`;
        const cte = adset.withSql.slice(adset.withSql.indexOf(`${alias} AS MATERIALIZED`));
        expect(cte, alias).toMatch(
          /^[^;]*?r\.snapshot_id,\s*r\.observation_id,\s*r\.field_scope_hash[\s\S]*?FROM/,
        );
      }
    }
  });

  it("ends every resolution ordering on the observation id", () => {
    expect(RESOLUTION_TIE_BREAK_SQL).toBe(
      "r.is_modern DESC, r.is_interval_uncertain ASC, r.snapshot_id, r.observation_id NULLS LAST",
    );
    /* uuid order, not text order: byte-wise and collation-free. */
    expect(RESOLUTION_TIE_BREAK_SQL).not.toContain("::text");
    const orderings = (text: string) => text.match(/ORDER BY r\.provider_account_id/g) ?? [];
    const tails = (text: string) => text.split(RESOLUTION_TIE_BREAK_SQL).length - 1;
    expect(orderings(sql.withSql).length).toBeGreaterThan(0);
    expect(tails(sql.withSql)).toBe(orderings(sql.withSql).length);
    expect(tails(adset.withSql)).toBe(orderings(adset.withSql).length);
  });

  it("hashes the field scope with the builtin sha256, never an extension", () => {
    const hash = receiptFieldScopeHashSql("obs");
    expect(hash).toContain("encode(sha256(convert_to(");
    expect(hash).toContain("obs.request_context->>'fields'");
    expect(hash).toContain("obs.request_context->'pagination'->>'fieldDegradation'");
    /* The unit separator is an SQL escape, not a raw control character. */
    expect(hash).toContain("E'\\x1f'");
    expect(hash).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
    expect(hash).not.toContain("digest(");
  });
});

describe("receipt lineage: the reference the contract emits", () => {
  const REF_KEYS = [
    "refContractVersion",
    "field",
    "sourceContractVersion",
    "normalizationVersion",
    "tier",
    "readiness",
    "sourceClass",
    "pitClass",
    "sourceSnapshotId",
    "observationId",
    "observedAt",
    "fieldScopeHash",
    "corroboratingSnapshotId",
    "corroboratingObservationId",
    "corroboratingObservedAt",
  ];
  const refs = [
    { label: "campaign objective", text: sql.evidenceRefSql("objective"), tier: sql.tierSql("objective"), alias: "cfgsrc_evref", day: "cfgsrc_receipt", next: "cfgsrc_corrob" },
    ...META_CONFIG_CONTRACT_ADSET_FIELDS.map((field) => {
      const lead = field === "custom_conversion_id" ? "custom_event_type" : field;
      return {
        label: `ad-set ${field}`,
        text: adset.evidenceRefSql(field),
        tier: adset.tierSql(field),
        alias: `adsetcfg_${field}_evref`,
        day: `adsetcfg_${lead}_day`,
        next: `adsetcfg_${lead}_next`,
      };
    }),
  ];

  it.each(refs)("$label builds exactly the ConfigFieldEvidenceRef keys, in one object", ({ text }) => {
    const keys = [...text.matchAll(/^\s*'([A-Za-z]+)',/gm)].map((match) => match[1]);
    expect(keys).toEqual(REF_KEYS);
    expect(text.match(/jsonb_build_object\(/g)).toHaveLength(1);
    expect(text.includes("`")).toBe(false);
  });

  it.each(refs)("$label names its contract versions as literals", ({ text }) => {
    expect(text).toContain(`'${META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION}'::text`);
    expect(text).toContain(`'${META_CONFIG_FIELD_SOURCE_CONTRACT_VERSION}'::text`);
    expect(text).toContain(`THEN ${META_CONFIG_FIELD_SOURCE_NORMALIZATION_VERSION} END`);
  });

  it.each(refs)("$label evaluates the tier ladder ONCE and reads it by name", ({ text, tier, alias }) => {
    expect(text.split(tier).length - 1).toBe(1);
    /*
      OFFSET 0 fences the ladder: without it PostgreSQL flattens the FROM
      subquery and substitutes the whole ladder for every read of the tier
      (measured read-only on production: TheSwaf hydration 8.5 s -> 5.6-6.2 s
      with the inner fence added).
    */
    expect(text).toContain(`FROM (SELECT ${tier} AS tier OFFSET 0) ${alias})`);
    /* Readiness is the CONTRACT readiness for the tier, never a caller's gate. */
    expect(text).toContain(readinessCaseSql(`${alias}.tier`));
  });

  it.each(refs)("$label cites the same-day row, and the corroboration only for a bracket", ({ text, alias, day, next }) => {
    const receipt = `CASE WHEN ${alias}.tier IN (${META_CONFIG_FIELD_RECEIPT_BACKED_TIERS.map((t) => `'${t}'`).join(", ")})`;
    const bracket = `CASE WHEN ${alias}.tier IN ('provider_receipt_day_bracketed', 'provider_receipt_legacy_bracketed')`;
    expect(text).toContain(`${receipt} THEN ${day}.snapshot_id::text END`);
    expect(text).toContain(`${receipt} THEN ${day}.observation_id::text END`);
    expect(text).toContain(`${receipt} THEN ${day}.field_scope_hash END`);
    expect(text).toContain(`${bracket} THEN ${next}.snapshot_id::text END`);
    expect(text).toContain(`${bracket} THEN ${next}.observation_id::text END`);
    /* The instant format the parser accepts: UTC, milliseconds, a literal Z. */
    expect(text).toContain(
      `to_char(${day}.row_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    );
    /* An unknown tier claims no receipt, whatever the resolution row holds. */
    expect(text).toContain(`CASE WHEN ${alias}.tier = 'unknown' THEN 'none'::text ELSE`);
  });

  it("keeps its receipt-tier lists equal to the parser's", () => {
    expect([...META_CONFIG_FIELD_RECEIPT_BACKED_TIERS]).toEqual([
      ...META_CONFIG_EVIDENCE_RECEIPT_TIERS,
    ]);
    expect([...META_CONFIG_FIELD_BRACKETED_TIERS]).toEqual([
      ...META_CONFIG_EVIDENCE_BRACKETED_TIERS,
    ]);
  });

  it("isolates the reference's subquery alias per instance and per ad-set field", () => {
    const aliases = refs.map(({ alias }) => alias);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("keys the AD-SET pit class on the receipt, exactly as the campaign one does", () => {
    for (const field of META_CONFIG_CONTRACT_ADSET_FIELDS) {
      const pit = adset.pitClassSql(field);
      const lead = field === "custom_conversion_id" ? "custom_event_type" : field;
      expect(pit).toContain(`adsetcfg_${lead}_day.row_observed_at IS NOT NULL`);
      /* Not on the VALUE: an observed absence is as known as a present value. */
      expect(pit).not.toContain("value_");
    }
    expect(sql.pitClassSql("objective")).toContain(
      "cfgsrc_receipt.row_observed_at IS NOT NULL",
    );
  });

  it("leaves every pre-existing emitted expression alone", () => {
    /* The reference is additive: it is not spliced into value, tier or readiness. */
    for (const text of [
      sql.valueSql("objective"),
      sql.tierSql("objective"),
      sql.readinessSql("objective"),
      adset.valueSql("optimization_goal"),
      adset.tierSql("optimization_goal"),
      adset.readinessSql("optimization_goal"),
    ]) {
      expect(text).not.toContain("jsonb_build_object");
      expect(text).not.toContain("observation_id");
    }
  });
});
