/**
 * The config-field source contract, executed by real PostgreSQL.
 *
 * Shape assertions are not enough here, and that is not a theoretical worry: the
 * first version of this builder emitted
 * `CROSS JOIN LATERAL (SELECT el ...) AS entity` and then `entity->>'objective'`,
 * which binds `entity` to a RECORD and fails with
 * "operator does not exist: record ->> unknown". Every string-matching test
 * passed while the query could not run at all. So the contract's SQL is executed
 * against a live server, over fixtures built to be admitted or refused for one
 * named reason each.
 *
 * Runs only inside an ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`);
 * `describe.skipIf(!SEAM)` otherwise, so a normal run does not report a green
 * suite for checks that never executed.
 */
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import {
  buildMetaAdsetConfigFieldSourceSql,
  buildMetaConfigFieldSourceSql,
  effectiveSelectorHasToken,
  META_CONFIG_FIELD_TIERS,
  readinessForConfigFieldTier,
} from "@/lib/meta/config-field-source-contract";
import {
  configFieldEvidenceRefCoherentSql,
  configFieldEvidenceRefIdentityText,
  configFieldEvidenceRefIdentityTextSql,
  parseConfigFieldEvidenceRef,
  type ConfigFieldEvidenceRef,
  type MetaConfigEvidenceField,
} from "@/lib/meta/config-field-evidence-ref";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

const TZ = "Europe/Istanbul";
const DAY = "2026-09-15";
const CAMPAIGN = "c1";

/**
 * The contract's own laterals, run over fixture rows supplied as CTEs rather
 * than over the live tables, so a case can be constructed for each refusal.
 * The expressions under test are the emitted ones, verbatim.
 */
const contract = buildMetaConfigFieldSourceSql({
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
  /* These cases assert the restated diagnostic itself. */
  includeRestated: true,
});

const adsetContract = buildMetaAdsetConfigFieldSourceSql({
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
  /* These cases assert the restated diagnostic itself. */
  includeRestated: true,
});

describe.skipIf(!SEAM)("meta config-field source contract (real PostgreSQL)", () => {
  beforeAll(async () => {
    await getDb().query("SELECT 1");
  });

  it("plans against the real schema, so the emitted SQL is executable", async () => {
    /*
      The regression that motivated this file. PREPARE parses and plans without
      executing, which is exactly the check the record-alias bug failed.
    */
    const sql = `WITH scope AS (
        SELECT DISTINCT campaign_id, date, provider_account_id, account_timezone
        FROM meta_ad_daily
        WHERE business_id = $1 AND date BETWEEN $2::date AND $3::date AND spend > 0
      ),
      ${contract.withSql}
      SELECT d.campaign_id,
        ${contract.valueSql("objective")} AS objective,
        ${contract.restatedValueSql("objective")} AS restated_objective,
        ${contract.tierSql("objective")} AS tier,
        ${contract.readinessSql("objective")} AS readiness,
        ${contract.sourceClassSql("objective")} AS source_class,
        ${contract.pitClassSql("objective")} AS pit_class
      FROM scope d${contract.lateralSql}`;
    await expect(
      getDb().query(
        `PREPARE contract_probe(text, text, text, timestamptz) AS ${sql}`,
      ),
    ).resolves.toBeDefined();
    await getDb().query("DEALLOCATE contract_probe");
  });

  it("names the requested field by TOP-LEVEL token, not substring", async () => {
    // A field that merely contains the word, or appears only inside a
    // parent{child} expansion, was not requested.
    const rows = (await getDb().query(
      `WITH cases(label, fields, expected) AS (VALUES
         ('exact', 'id,name,objective,status', true),
         ('production list', 'id,name,objective,status,bid_constraints{roas_average_floor}', true),
         ('first', 'objective,id', true),
         ('last', 'id,objective', true),
         ('substring', 'id,promoted_objective,status', false),
         ('nested only', 'id,promoted_object{objective}', false),
         ('absent', 'id,name,status', false))
       SELECT label,
         ((',' || regexp_replace(fields, '\\{[^}]*\\}', '', 'g') || ',')
           LIKE '%,objective,%') AS matched,
         expected
       FROM cases`,
    )) as { label: string; matched: boolean; expected: boolean }[];
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.matched, row.label).toBe(row.expected);
  });

  it("extracts the right campaign from the payload, and survives a non-array", async () => {
    const rows = (await getDb().query(
      `WITH day AS (SELECT $1::date AS date, $2::text AS tz, $3::text AS campaign_id),
       fixture(label, payload) AS (VALUES
         ('array with our campaign',
          '[{"id":"c1","objective":"OUTCOME_SALES"},{"id":"c2","objective":"OUTCOME_TRAFFIC"}]'::jsonb),
         ('array without our campaign', '[{"id":"c2","objective":"OUTCOME_TRAFFIC"}]'::jsonb),
         ('object, not an array', '{"id":"c1","objective":"OUTCOME_SALES"}'::jsonb),
         ('json null', 'null'::jsonb))
       SELECT f.label, entity.payload->>'objective' AS objective
       FROM fixture f CROSS JOIN day
       LEFT JOIN LATERAL (
         SELECT el AS payload
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(f.payload) = 'array' THEN f.payload ELSE '[]'::jsonb END
         ) AS el
         WHERE el->>'id' = day.campaign_id
         LIMIT 1
       ) entity ON TRUE
       ORDER BY f.label`,
      [DAY, TZ, CAMPAIGN],
    )) as { label: string; objective: string | null }[];
    const byLabel = new Map(rows.map((r) => [r.label, r.objective]));
    expect(byLabel.get("array with our campaign")).toBe("OUTCOME_SALES");
    // A non-array must not raise: jsonb_array_elements does, on a bare object.
    expect(byLabel.get("array without our campaign")).toBeNull();
    expect(byLabel.get("object, not an array")).toBeNull();
    expect(byLabel.get("json null")).toBeNull();
  });

  it("accepts only a real INSTANT as a clock, not anything PostgreSQL will cast", async () => {
    /*
      pg_input_is_valid is necessary and not sufficient: '2026-09-15' passes it
      and becomes local midnight, which would file a row on the wrong side of a
      provider-local day boundary. Both guarded values are machine-written full
      timestamps, so requiring the shape costs nothing.
    */
    const rows = (await getDb().query(
      `WITH c(label, raw, expected) AS (VALUES
         ('our writer toISOString', '2026-09-15T10:00:00.123Z', true),
         ('graph updated_time +0000', '2026-09-01T00:00:00+0000', true),
         ('offset with colon', '2026-09-15T10:00:00+03:00', true),
         ('date only', '2026-09-15', false),
         ('no zone', '2026-09-15T10:00:00', false),
         ('garbage', 'not-a-time', false),
         ('empty', '', false))
       SELECT label, expected,
         ((CASE WHEN raw ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
            AND pg_input_is_valid(raw, 'timestamp with time zone')
            THEN raw::timestamptz ELSE NULL END) IS NOT NULL) AS guarded,
         pg_input_is_valid(raw, 'timestamp with time zone') AS pg_alone
       FROM c ORDER BY label`,
    )) as { label: string; expected: boolean; guarded: boolean; pg_alone: boolean }[];
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.guarded, row.label).toBe(row.expected);
    // The two cases that prove the regex earns its place.
    const dateOnly = rows.find((r) => r.label === "date only");
    const noZone = rows.find((r) => r.label === "no zone");
    expect(dateOnly?.pg_alone).toBe(true);
    expect(dateOnly?.guarded).toBe(false);
    expect(noZone?.pg_alone).toBe(true);
    expect(noZone?.guarded).toBe(false);
  });

  it("dates a row by its own page clock, inside the provider-local day", async () => {
    /*
      A receipt stores a merged multi-page payload, so the aggregate clock can
      put a row on the wrong side of the boundary. A missing per-entity clock is
      refused rather than approximated.
    */
    const rows = (await getDb().query(
      `WITH day AS (SELECT $1::date AS date, $2::text AS tz, $3::text AS campaign_id),
       fixture(label, req, expected) AS (VALUES
         ('inside the day',
          '{"rowObservedAtByEntityId":{"c1":"2026-09-15T10:00:00+03:00"}}'::jsonb, true),
         ('first instant of the day',
          '{"rowObservedAtByEntityId":{"c1":"2026-09-15T00:00:00+03:00"}}'::jsonb, true),
         ('last instant of the day',
          '{"rowObservedAtByEntityId":{"c1":"2026-09-15T23:59:59+03:00"}}'::jsonb, true),
         ('midnight of the NEXT day is out',
          '{"rowObservedAtByEntityId":{"c1":"2026-09-16T00:00:00+03:00"}}'::jsonb, false),
         ('day before is out',
          '{"rowObservedAtByEntityId":{"c1":"2026-09-14T23:59:59+03:00"}}'::jsonb, false),
         ('a different campaign clock does not count',
          '{"rowObservedAtByEntityId":{"c2":"2026-09-15T10:00:00+03:00"}}'::jsonb, false),
         ('legacy: no per-entity clock at all', '{}'::jsonb, false))
       SELECT f.label, f.expected,
         ((f.req->'rowObservedAtByEntityId'->>day.campaign_id)::timestamptz IS NOT NULL
          AND (f.req->'rowObservedAtByEntityId'->>day.campaign_id)::timestamptz
              >= (day.date::timestamp AT TIME ZONE day.tz)
          AND (f.req->'rowObservedAtByEntityId'->>day.campaign_id)::timestamptz
              < ((day.date + 1)::timestamp AT TIME ZONE day.tz)) AS admitted
       FROM fixture f CROSS JOIN day ORDER BY f.label`,
      [DAY, TZ, CAMPAIGN],
    )) as { label: string; expected: boolean; admitted: boolean }[];
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.admitted, row.label).toBe(row.expected);
  });

  it("withholds a value whose evidence postdates the evaluation cutoff", async () => {
    /*
      A future value must not reach a decision with a flag attached: hydration
      would take it for objective and cohort and the flag would sit unread.
    */
    const rows = (await getDb().query(
      `WITH f(label, evidence_at, cutoff) AS (VALUES
         ('before cutoff', '2026-09-15T10:00:00Z'::timestamptz, '2026-09-16T00:00:00Z'::timestamptz),
         ('after cutoff',  '2026-09-17T10:00:00Z'::timestamptz, '2026-09-16T00:00:00Z'::timestamptz))
       SELECT label, (evidence_at <= cutoff) AS available,
         CASE WHEN evidence_at <= cutoff THEN 'as_of_known' ELSE 'restated' END AS pit_class
       FROM f ORDER BY label`,
    )) as { label: string; available: boolean; pit_class: string }[];
    const byLabel = new Map(rows.map((r) => [r.label, r]));
    expect(byLabel.get("before cutoff")?.available).toBe(true);
    expect(byLabel.get("before cutoff")?.pit_class).toBe("as_of_known");
    expect(byLabel.get("after cutoff")?.available).toBe(false);
    expect(byLabel.get("after cutoff")?.pit_class).toBe("restated");
  });

  it("keeps a field whose selector appears on only ONE observation of a snapshot", async () => {
    /*
      The same canonical snapshot can be re-observed under a different
      request_context. If only the inner observation asked for promoted_object,
      that field's authority must survive — an earlier version of this contract
      compressed the timeline to the earliest and latest sighting and lost it.
    */
    const rows = (await getDb().query(
      `WITH obs(label, observed_at, fields) AS (VALUES
         ('earliest', '2026-09-15T06:00:00Z'::timestamptz, 'id,objective,updated_time'),
         ('inner', '2026-09-15T12:00:00Z'::timestamptz, 'id,optimization_goal,promoted_object,updated_time'),
         ('latest', '2026-09-15T18:00:00Z'::timestamptz, 'id,objective,updated_time'))
       SELECT label,
         ((',' || regexp_replace(fields, '\{[^}]*\}', '', 'g') || ',')
           LIKE '%,promoted_object,%') AS authorises
       FROM obs ORDER BY observed_at`,
    )) as { label: string; authorises: boolean }[];
    expect(rows.filter((r) => r.authorises)).toHaveLength(1);
    expect(rows[1]?.label).toBe("inner");
  });

  it("dates a row by its per-entity clock even across a midnight page boundary", async () => {
    /*
      A merged multi-page receipt can carry an entity whose page response landed
      on a DIFFERENT provider-local day than the observation's aggregate clock.
      In both directions the per-entity clock is right and the aggregate is wrong.
    */
    const rows = (await getDb().query(
      `WITH c(label, aggregate_at, per_entity_at, target_day) AS (VALUES
         ('page before midnight, aggregate after',
          '2026-09-16T00:30:00+03:00'::timestamptz, '2026-09-15T23:50:00+03:00'::timestamptz, '2026-09-15'::date),
         ('page after midnight, aggregate before',
          '2026-09-15T23:50:00+03:00'::timestamptz, '2026-09-16T00:30:00+03:00'::timestamptz, '2026-09-16'::date))
       SELECT label,
         (per_entity_at >= (target_day::timestamp AT TIME ZONE 'Europe/Istanbul')
          AND per_entity_at < ((target_day + 1)::timestamp AT TIME ZONE 'Europe/Istanbul')) AS per_entity_ok,
         (aggregate_at >= (target_day::timestamp AT TIME ZONE 'Europe/Istanbul')
          AND aggregate_at < ((target_day + 1)::timestamp AT TIME ZONE 'Europe/Istanbul')) AS aggregate_ok
       FROM c ORDER BY label`,
    )) as { label: string; per_entity_ok: boolean; aggregate_ok: boolean }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.per_entity_ok, row.label).toBe(true);
      expect(row.aggregate_ok, row.label).toBe(false);
    }
  });

  it("subtracts a degraded response's dropped fields, whitespace and all", async () => {
    /*
      Drives the CONTRACT's own predicate over fixture rows aliased as `obs`,
      rather than restating it. The restatement drifted exactly once, and
      instructively: `\s` inside a JavaScript template literal collapses to `s`,
      so the copy matched the letter instead of whitespace and this test failed
      while the shipped SQL was right.

      Whitespace matters because it is significant to a LIKE and not to the
      provider: "optimization_goal, promoted_object" leaves the second token as
      ", promoted_object,", and an unnormalised test would read a DROPPED field
      as authorised.
    */
    const predicate = effectiveSelectorHasToken("obs", "promoted_object");
    const rows = (await getDb().query(
      `WITH obs(label, request_context, expected) AS (VALUES
         ('intact',
          '{"fields":"id,optimization_goal,promoted_object"}'::jsonb, true),
         ('spaced fields list',
          '{"fields":"id, optimization_goal, promoted_object"}'::jsonb, true),
         ('spaced dropped string, second token',
          '{"fields":"id,optimization_goal,promoted_object","pagination":{"fieldDegradation":{"recovered":true,"droppedFields":"optimization_goal, promoted_object"}}}'::jsonb,
          false),
         ('array element padded with spaces',
          '{"fields":"id,promoted_object","pagination":{"fieldDegradation":{"recovered":true,"droppedFields":[" promoted_object "]}}}'::jsonb,
          false),
         ('dropped a DIFFERENT field',
          '{"fields":"id,promoted_object","pagination":{"fieldDegradation":{"recovered":true,"droppedFields":["bid_amount"]}}}'::jsonb,
          true),
         ('recovered, list unreadable',
          '{"fields":"id,promoted_object","pagination":{"fieldDegradation":{"recovered":true}}}'::jsonb,
          false),
         ('recorded but not recovered',
          '{"fields":"id,promoted_object","pagination":{"fieldDegradation":{"recovered":false}}}'::jsonb,
          true),
         ('nested only does not count',
          '{"fields":"id,parent{promoted_object}"}'::jsonb, false),
         ('substring only',
          '{"fields":"id,my_promoted_object_x"}'::jsonb, false))
       SELECT label, expected, ${predicate} AS effective
       FROM obs ORDER BY label`,
    )) as { label: string; expected: boolean; effective: boolean }[];
    expect(rows).toHaveLength(9);
    for (const row of rows) expect(row.effective, row.label).toBe(row.expected);
  });

  it("keeps a pre-cutoff value when a NEWER post-cutoff row exists the same day", async () => {
    /*
      The defect this locks out: ranking in-day candidates without the cutoff
      picks B (after the cutoff), the post-hoc cutoff test then rejects it, and A
      — which the run could and should have used — never appears at all. Ranking
      only over rows the cutoff admits makes A the winner.
    */
    const rows = (await getDb().query(
      `WITH r(label, observed_at, value) AS (VALUES
         ('A before cutoff', '2026-09-15T08:00:00Z'::timestamptz, 'OUTCOME_SALES'),
         ('B after cutoff',  '2026-09-15T20:00:00Z'::timestamptz, 'OUTCOME_TRAFFIC')),
       cut(at) AS (VALUES ('2026-09-15T12:00:00Z'::timestamptz))
       SELECT
         (SELECT value FROM r, cut WHERE observed_at <= cut.at
          ORDER BY observed_at DESC LIMIT 1) AS as_of_value,
         (SELECT value FROM r ORDER BY observed_at DESC LIMIT 1) AS restated_value,
         (SELECT value FROM (
            SELECT value, observed_at FROM r ORDER BY observed_at DESC LIMIT 1
          ) picked, cut WHERE picked.observed_at <= cut.at) AS filter_after_pick`,
    )) as {
      as_of_value: string | null;
      restated_value: string | null;
      filter_after_pick: string | null;
    }[];
    const row = rows[0];
    // Correct: the pre-cutoff value survives.
    expect(row?.as_of_value).toBe("OUTCOME_SALES");
    // The diagnostic still shows what today's warehouse says.
    expect(row?.restated_value).toBe("OUTCOME_TRAFFIC");
    // And the old shape, filtering after the pick, loses it entirely.
    expect(row?.filter_after_pick).toBeNull();
  });

  it("handles a flip and revert without inventing a bracket", async () => {
    /*
      A changes to B and back to A inside the corroboration horizon. The first
      later sighting is B, which disagrees, so the day must NOT bracket — even
      though a later sighting agrees again. Selecting the first later row and
      testing agreement afterwards is what makes that true; filtering on
      agreement first would skip B and reach the reverted A.
    */
    const rows = (await getDb().query(
      `WITH r(observed_at, value) AS (VALUES
         ('2026-09-16T02:00:00Z'::timestamptz, 'B'),
         ('2026-09-17T02:00:00Z'::timestamptz, 'A')),
       same_day(value) AS (VALUES ('A'))
       SELECT
         (SELECT value FROM r ORDER BY observed_at ASC LIMIT 1) AS first_later,
         ((SELECT value FROM r ORDER BY observed_at ASC LIMIT 1)
            = (SELECT value FROM same_day)) AS brackets_correctly,
         ((SELECT value FROM r WHERE value = (SELECT value FROM same_day)
            ORDER BY observed_at ASC LIMIT 1) IS NOT NULL) AS brackets_if_filtered_first`,
    )) as {
      first_later: string;
      brackets_correctly: boolean;
      brackets_if_filtered_first: boolean;
    }[];
    expect(rows[0]?.first_later).toBe("B");
    expect(rows[0]?.brackets_correctly).toBe(false);
    // The shape we rejected would have bracketed a day that flipped and reverted.
    expect(rows[0]?.brackets_if_filtered_first).toBe(true);
  });

  it("admits nothing when the response dropped the very field it is cited for", async () => {
    /*
      The inverse of the outage that started this: a degraded-but-recovered HTTP
      200 reports success while having dropped the field from its request, and the
      canonical payload it shares still carries a value. Admitting it would
      authorise a value the response never asked for.
    */
    const rows = (await getDb().query(
      `WITH obs(label, fields, degradation, payload) AS (VALUES
         ('intact request', 'id,objective,updated_time', 'null'::jsonb,
          '[{"id":"c1","objective":"OUTCOME_SALES","updated_time":"2026-09-01T00:00:00+0000"}]'::jsonb),
         ('degraded: objective dropped, value still in payload',
          'id,objective,updated_time',
          '{"recovered": true, "droppedFields": ["objective"]}'::jsonb,
          '[{"id":"c1","objective":"OUTCOME_SALES","updated_time":"2026-09-01T00:00:00+0000"}]'::jsonb))
       SELECT o.label,
         (((',' || regexp_replace(o.fields, '\{[^}]*\}', '', 'g') || ',') LIKE '%,objective,%')
          AND NOT (CASE jsonb_typeof(o.degradation->'droppedFields')
            WHEN 'array' THEN o.degradation->'droppedFields' ? 'objective'
            WHEN 'string'
              THEN (',' || (o.degradation->>'droppedFields') || ',') LIKE '%,objective,%'
            ELSE COALESCE(o.degradation->>'recovered', 'false') = 'true'
          END)) AS effective_selector,
         entity.payload->>'objective' AS payload_value
       FROM obs o
       CROSS JOIN LATERAL (
         SELECT el AS payload FROM jsonb_array_elements(o.payload) AS el
         WHERE el->>'id' = 'c1' LIMIT 1
       ) entity
       ORDER BY o.label`,
    )) as { label: string; effective_selector: boolean; payload_value: string }[];
    const byLabel = new Map(rows.map((r) => [r.label, r]));
    const intact = byLabel.get("intact request");
    const degraded = byLabel.get("degraded: objective dropped, value still in payload");
    expect(intact?.effective_selector).toBe(true);
    // The value IS in the payload...
    expect(degraded?.payload_value).toBe("OUTCOME_SALES");
    // ...and the effective selector still refuses it, so no tier admits it.
    expect(degraded?.effective_selector).toBe(false);
  });

  it("calls a day bracketed only with a pre-day clock AND corroboration past the end", async () => {
    const rows = (await getDb().query(
      `WITH day AS (SELECT $1::date AS date, $2::text AS tz),
       fixture(label, entity_updated_time, corroborated, expected) AS (VALUES
         ('clock predates the day, corroborated', '2026-09-01T00:00:00+0000', true,  'bracketed'),
         ('clock predates, NOT corroborated',     '2026-09-01T00:00:00+0000', false, 'point_in_day'),
         ('clock INSIDE the day, corroborated',   '2026-09-15T12:00:00+0000', true,  'point_in_day'),
         ('clock after the day, corroborated',    '2026-09-20T12:00:00+0000', true,  'point_in_day'))
       SELECT f.label, f.expected,
         CASE WHEN f.entity_updated_time::timestamptz <= (day.date::timestamp AT TIME ZONE day.tz)
                   AND f.corroborated
              THEN 'bracketed' ELSE 'point_in_day' END AS tier
       FROM fixture f CROSS JOIN day ORDER BY f.label`,
      [DAY, TZ],
    )) as { label: string; expected: string; tier: string }[];
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.tier, row.label).toBe(row.expected);
  });

  it("resolves EVERY tier to the same readiness PostgreSQL that TypeScript does", async () => {
    /*
      THE REGRESSION. Both readiness ladders were hand-written CASE expressions
      maintained beside `readinessForConfigFieldTier` rather than generated from
      it, and both had drifted: the campaign ladder had no arm for
      `provider_receipt_pending_corroboration`, the ad-set ladder none for
      `typed_contemporaneous`, and each fell through to `ELSE 'none'`.

      The campaign omission is the one with a price. That tier is what the
      CURRENT DAY carries on every run — a receipt whose corroboration window has
      not elapsed yet — so today's objective was reported as having no provenance
      at all instead of as awaiting corroboration, and the two are treated very
      differently downstream.

      This runs the EMITTED ladders, both grains, over every tier in the union,
      and compares each answer to the TypeScript rule. A ladder that silently
      drops an arm fails here rather than in a consumer.
    */
    const values = META_CONFIG_FIELD_TIERS.map(
      (tier) => `('${tier}')`,
    ).join(", ");
    const rows = (await getDb().query(
      `WITH t(tier) AS (VALUES ${values})
       SELECT tier,
         ${contract.readinessSql("objective")} AS campaign_readiness,
         ${adsetContract.readinessSql("optimization_goal")} AS adset_readiness
       FROM t ORDER BY tier`.replaceAll(
        /* Both builders read their tier from a join alias; here the tier IS the
           row, so the emitted expression is pointed at the fixture column. */
        contract.tierSql("objective"),
        "t.tier",
      ).replaceAll(adsetContract.tierSql("optimization_goal"), "t.tier"),
    )) as {
      tier: string;
      campaign_readiness: string;
      adset_readiness: string;
    }[];

    expect(rows).toHaveLength(META_CONFIG_FIELD_TIERS.length);
    for (const row of rows) {
      const expected = readinessForConfigFieldTier(
        row.tier as (typeof META_CONFIG_FIELD_TIERS)[number],
      );
      expect(row.campaign_readiness, `campaign ${row.tier}`).toBe(expected);
      expect(row.adset_readiness, `adset ${row.tier}`).toBe(expected);
    }
    /* Named explicitly, because these are the two arms that were missing. */
    const pending = rows.find(
      (r) => r.tier === "provider_receipt_pending_corroboration",
    );
    expect(pending?.campaign_readiness).toBe("review_only");
    const typed = rows.find((r) => r.tier === "typed_contemporaneous");
    expect(typed?.adset_readiness).toBe("review_only");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * RECEIPT LINEAGE — `evidenceRefSql`, executed over SEEDED receipts.
 *
 * The raw receipt model always knew which provider GET proved a value; the
 * contract resolved it to a value, a tier and a readiness and dropped the
 * identity. These cases run the emitted reference over real rows in the
 * freshly migrated schema and hold it to the orchestrator's acceptance test:
 * `parseConfigFieldEvidenceRef` in TypeScript and
 * `configFieldEvidenceRefCoherentSql` in SQL must both accept every reference
 * the builder emits, and refuse every corruption of one.
 * ──────────────────────────────────────────────────────────────────────────── */

const LINEAGE_ACCOUNT = "act_config_lineage_seam";
const LINEAGE_OWNER_EMAIL = "config-field-lineage@seam.local";
const LINEAGE_DAY = "2026-09-15";
const LINEAGE_NEXT_DAY = "2026-09-16";
const LINEAGE_CAMPAIGN_FIELDS = "id,objective,updated_time";
const LINEAGE_ADSET_FIELDS = "id,optimization_goal,promoted_object,updated_time";
const LINEAGE_UPDATED_TIME = "2026-09-01T00:00:00+0000";
const LINEAGE_PAGINATION = { complete: true, termination: "natural_end", pageCount: 1 };
const MODERN_CAMPAIGN = "cmp_lineage_modern";
const SNAPSHOT_ONLY_CAMPAIGN = "cmp_lineage_snapshot_only";
const TYPED_CAMPAIGN = "cmp_lineage_typed";
const UNKNOWN_CAMPAIGN = "cmp_lineage_unknown";
const NO_TZ_CAMPAIGN = "cmp_lineage_no_tz";
const SAME_SNAPSHOT_ADSET = "as_lineage_same_snapshot";
const TIE_ADSET = "as_lineage_tie";
/* Fixed ids so the tie case can name its winner. Inserted HIGH first. */
const TIE_OBSERVATION_LOW = "00000000-0000-4000-8000-00000000b001";
const TIE_OBSERVATION_HIGH = "00000000-0000-4000-8000-00000000b002";

let lineageBusinessId = "";
let lineageAccountRefId = "";
let lineagePayloadCounter = 0;
const seeded = {
  modernSnapshot: "",
  modernDayObservation: "",
  modernNextObservation: "",
  snapshotOnly: "",
  sameSnapshot: "",
  sameSnapshotDayObservation: "",
  sameSnapshotNextObservation: "",
  noTzSnapshot: "",
};

async function insertLineageSnapshot(input: {
  endpoint: "campaign_configs" | "adset_configs";
  context: Record<string, unknown>;
  payload: unknown;
  fetchedAt: string;
}): Promise<string> {
  const sql = getDb();
  const scope = input.endpoint === "adset_configs" ? "adset" : "campaign";
  lineagePayloadCounter += 1;
  const [snapshot] = await sql<{ id: string }>`
    INSERT INTO meta_raw_snapshots (
      business_id, business_ref_id, provider_account_id, provider_account_ref_id,
      endpoint_name, entity_scope, status, provider_http_status,
      start_date, end_date, payload_hash, request_context, payload_json, fetched_at
    ) VALUES (
      ${lineageBusinessId}, ${lineageBusinessId}::uuid, ${LINEAGE_ACCOUNT},
      ${lineageAccountRefId}::uuid, ${input.endpoint}, ${scope}, 'fetched', 200,
      ${LINEAGE_DAY}::date, ${LINEAGE_DAY}::date,
      ${`lineage-seam-${lineagePayloadCounter}`},
      ${JSON.stringify(input.context)}::jsonb, ${JSON.stringify(input.payload)}::jsonb,
      ${input.fetchedAt}::timestamptz
    ) RETURNING id
  `;
  if (!snapshot?.id) throw new Error("Could not create a lineage seam snapshot.");
  return snapshot.id;
}

async function insertLineageObservation(input: {
  snapshotId: string;
  endpoint: "campaign_configs" | "adset_configs";
  context: Record<string, unknown>;
  observedAt: string;
  runId?: string | null;
  id?: string;
  /* A distinct receipt coordinate; see the tie fixture. */
  checkpointId?: string | null;
}): Promise<string> {
  const sql = getDb();
  const scope = input.endpoint === "adset_configs" ? "adset" : "campaign";
  const [observation] = input.id
    ? await sql<{ id: string }>`
        INSERT INTO meta_raw_snapshot_observations (
          id, snapshot_id, business_id, provider_account_id, endpoint_name,
          entity_scope, status, provider_http_status, request_context,
          observed_at, run_id, checkpoint_id
        ) VALUES (
          ${input.id}::uuid, ${input.snapshotId}::uuid, ${lineageBusinessId},
          ${LINEAGE_ACCOUNT}, ${input.endpoint}, ${scope}, 'fetched', 200,
          ${JSON.stringify(input.context)}::jsonb, ${input.observedAt}::timestamptz,
          ${input.runId ?? null}, ${input.checkpointId ?? null}::uuid
        ) RETURNING id
      `
    : await sql<{ id: string }>`
        INSERT INTO meta_raw_snapshot_observations (
          snapshot_id, business_id, provider_account_id, endpoint_name,
          entity_scope, status, provider_http_status, request_context,
          observed_at, run_id
        ) VALUES (
          ${input.snapshotId}::uuid, ${lineageBusinessId}, ${LINEAGE_ACCOUNT},
          ${input.endpoint}, ${scope}, 'fetched', 200,
          ${JSON.stringify(input.context)}::jsonb, ${input.observedAt}::timestamptz,
          ${input.runId ?? null}
        ) RETURNING id
      `;
  if (!observation?.id) throw new Error("Could not create a lineage seam observation.");
  return observation.id;
}

async function seedLineage(): Promise<void> {
  const sql = getDb();
  const [owner] = await sql<{ id: string }>`
    INSERT INTO users (name, email, password_hash)
    VALUES ('Config field lineage seam', ${LINEAGE_OWNER_EMAIL}, 'unused')
    RETURNING id
  `;
  if (!owner?.id) throw new Error("Could not create the lineage seam owner.");
  const [business] = await sql<{ id: string }>`
    INSERT INTO businesses (name, owner_id)
    VALUES ('Config field lineage seam', ${owner.id})
    RETURNING id
  `;
  if (!business?.id) throw new Error("Could not create the lineage seam business.");
  lineageBusinessId = business.id;
  const [account] = await sql<{ id: string }>`
    INSERT INTO provider_accounts (provider, external_account_id, account_name)
    VALUES ('meta', ${LINEAGE_ACCOUNT}, 'Config field lineage seam')
    RETURNING id
  `;
  if (!account?.id) throw new Error("Could not create the lineage seam account.");
  lineageAccountRefId = account.id;
  await sql`
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (${lineageBusinessId}, 'meta', ${account.id}, ${LINEAGE_ACCOUNT})
  `;

  /*
    MODERN, one canonical snapshot observed twice: inside the day, and the next
    morning. Same content, so the day brackets on it — and the reference must
    cite the two OBSERVATIONS, because the snapshot id alone is the same at both
    ends and could not say which sighting proved which end.
  */
  const modernPayload = [
    { id: MODERN_CAMPAIGN, objective: "OUTCOME_SALES", updated_time: LINEAGE_UPDATED_TIME },
  ];
  const modernContext = (at: string) => ({
    fields: LINEAGE_CAMPAIGN_FIELDS,
    pagination: { ...LINEAGE_PAGINATION, pageCount: 2 },
    rowObservedAtByEntityId: { [MODERN_CAMPAIGN]: at },
  });
  seeded.modernSnapshot = await insertLineageSnapshot({
    endpoint: "campaign_configs",
    context: modernContext(`${LINEAGE_DAY}T10:00:00.000Z`),
    payload: modernPayload,
    fetchedAt: `${LINEAGE_DAY}T10:00:00Z`,
  });
  seeded.modernDayObservation = await insertLineageObservation({
    snapshotId: seeded.modernSnapshot,
    endpoint: "campaign_configs",
    context: modernContext(`${LINEAGE_DAY}T10:00:00.000Z`),
    observedAt: `${LINEAGE_DAY}T10:00:00Z`,
    runId: "00000000-0000-4000-8000-0000000a0001",
  });
  seeded.modernNextObservation = await insertLineageObservation({
    snapshotId: seeded.modernSnapshot,
    endpoint: "campaign_configs",
    context: modernContext(`${LINEAGE_NEXT_DAY}T04:00:00.000Z`),
    observedAt: `${LINEAGE_NEXT_DAY}T04:00:00Z`,
    runId: "00000000-0000-4000-8000-0000000a0002",
  });

  /* SNAPSHOT-ONLY: a retained single-page 200 that never got an observation. */
  seeded.snapshotOnly = await insertLineageSnapshot({
    endpoint: "campaign_configs",
    context: { fields: LINEAGE_CAMPAIGN_FIELDS, pagination: LINEAGE_PAGINATION },
    payload: [
      {
        id: SNAPSHOT_ONLY_CAMPAIGN,
        objective: "OUTCOME_TRAFFIC",
        updated_time: LINEAGE_UPDATED_TIME,
      },
    ],
    fetchedAt: `${LINEAGE_DAY}T09:00:00Z`,
  });

  /* A legacy receipt read under an account with NO timezone. */
  const noTzContext = { fields: LINEAGE_CAMPAIGN_FIELDS, pagination: LINEAGE_PAGINATION };
  seeded.noTzSnapshot = await insertLineageSnapshot({
    endpoint: "campaign_configs",
    context: noTzContext,
    payload: [
      { id: NO_TZ_CAMPAIGN, objective: "OUTCOME_SALES", updated_time: LINEAGE_UPDATED_TIME },
    ],
    fetchedAt: `${LINEAGE_DAY}T10:00:00Z`,
  });
  await insertLineageObservation({
    snapshotId: seeded.noTzSnapshot,
    endpoint: "campaign_configs",
    context: noTzContext,
    observedAt: `${LINEAGE_DAY}T10:00:00Z`,
  });

  /*
    ONE ad-set snapshot, re-observed on two days. Each day's pick is a different
    observation of the same content, and the two references must differ.
  */
  const adsetContext = { fields: LINEAGE_ADSET_FIELDS, pagination: LINEAGE_PAGINATION };
  seeded.sameSnapshot = await insertLineageSnapshot({
    endpoint: "adset_configs",
    context: adsetContext,
    payload: [
      {
        id: SAME_SNAPSHOT_ADSET,
        optimization_goal: "OFFSITE_CONVERSIONS",
        updated_time: LINEAGE_UPDATED_TIME,
        promoted_object: { custom_event_type: "PURCHASE" },
      },
    ],
    fetchedAt: `${LINEAGE_DAY}T10:00:00Z`,
  });
  seeded.sameSnapshotDayObservation = await insertLineageObservation({
    snapshotId: seeded.sameSnapshot,
    endpoint: "adset_configs",
    context: adsetContext,
    observedAt: `${LINEAGE_DAY}T10:00:00Z`,
  });
  seeded.sameSnapshotNextObservation = await insertLineageObservation({
    snapshotId: seeded.sameSnapshot,
    endpoint: "adset_configs",
    context: adsetContext,
    observedAt: `${LINEAGE_NEXT_DAY}T10:00:00Z`,
  });

  /*
    THE TIE: one snapshot observed twice at the SAME instant. Before the
    tie-break reached the observation id, DISTINCT ON broke this by plan order.
    The higher id goes in first, so heap order does not happen to agree.

    The two receipts differ in their sync checkpoint, which is what makes them
    two receipts at all: the migrated identity index refuses two observations
    that agree on every receipt coordinate, so a tie in production always has
    one such difference, and none of them is something the contract ranks on.
  */
  const tieSnapshot = await insertLineageSnapshot({
    endpoint: "adset_configs",
    context: adsetContext,
    payload: [
      {
        id: TIE_ADSET,
        optimization_goal: "OFFSITE_CONVERSIONS",
        updated_time: LINEAGE_UPDATED_TIME,
      },
    ],
    fetchedAt: `${LINEAGE_DAY}T10:00:00Z`,
  });
  for (const [id, checkpointId] of [
    [TIE_OBSERVATION_HIGH, "00000000-0000-4000-8000-00000000c002"],
    [TIE_OBSERVATION_LOW, "00000000-0000-4000-8000-00000000c001"],
  ] as const) {
    await insertLineageObservation({
      snapshotId: tieSnapshot,
      endpoint: "adset_configs",
      context: adsetContext,
      observedAt: `${LINEAGE_DAY}T10:00:00Z`,
      id,
      checkpointId,
    });
  }

  /*
    THE TYPED WITNESS: a creative-day written and last touched inside the day,
    one ad behind it, anchored at ad grain. It cites no receipt.
  */
  await sql`
    INSERT INTO meta_ad_daily (
      business_id, business_ref_id, provider_account_id, provider_account_ref_id,
      date, ad_id, campaign_id, adset_id, account_timezone, account_currency,
      spend, truth_state, validation_status
    ) VALUES (
      ${lineageBusinessId}, ${lineageBusinessId}::uuid, ${LINEAGE_ACCOUNT},
      ${lineageAccountRefId}::uuid, ${LINEAGE_DAY}::date, 'ad_lineage_typed',
      ${TYPED_CAMPAIGN}, 'as_lineage_typed', 'UTC', 'USD', 10, 'finalized', 'passed'
    )
  `;
  await sql`
    INSERT INTO meta_creative_daily (
      business_id, provider_account_id, campaign_id, date, creative_id,
      objective, spend, created_at, updated_at, account_timezone, account_currency,
      payload_json
    ) VALUES (
      ${lineageBusinessId}, ${LINEAGE_ACCOUNT}, ${TYPED_CAMPAIGN}, ${LINEAGE_DAY}::date,
      'cr_lineage_typed', 'OUTCOME_LEADS', 5, ${`${LINEAGE_DAY}T09:00:00Z`}::timestamptz,
      ${`${LINEAGE_DAY}T09:30:00Z`}::timestamptz, 'UTC', 'USD',
      ${JSON.stringify({ real_ad_id: "ad_lineage_typed", associated_ads_count: 1 })}::jsonb
    )
  `;
}

const lineageCampaign = buildMetaConfigFieldSourceSql({
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
  aliasPrefix: "lin_c",
});

const lineageAdset = buildMetaAdsetConfigFieldSourceSql({
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
  aliasPrefix: "lin_a",
});

type ScopeRow = { entity: string; date: string; tz: string | null };

function scopeValues(rows: readonly ScopeRow[]): string {
  return rows
    .map(
      (row) =>
        `('${LINEAGE_ACCOUNT}'::text, '${row.entity}'::text, '${row.date}'::date, ${
          row.tz === null ? "NULL::text" : `'${row.tz}'::text`
        })`,
    )
    .join(",\n    ");
}

const ADSET_REF_COLUMNS: Record<Exclude<MetaConfigEvidenceField, "objective">, string> = {
  optimization_goal: "goal_ref",
  custom_event_type: "event_ref",
  custom_conversion_id: "conversion_ref",
};

interface LineageRow {
  entity_id: string;
  day: string;
  tier: string;
  readiness: string;
  source_class: string;
  ref: unknown;
  coherent: boolean;
  identity_text: string;
  [key: string]: unknown;
}

function asJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function readCampaignRefs(rows: readonly ScopeRow[], cutoff: string) {
  const query = `SELECT x.*,
      ${configFieldEvidenceRefCoherentSql("x.ref", "objective")} AS coherent,
      ${configFieldEvidenceRefIdentityTextSql("x.ref")} AS identity_text
    FROM (
      WITH scope(provider_account_id, campaign_id, date, account_timezone) AS (
        VALUES ${scopeValues(rows)}
      ),
      ${lineageCampaign.withSql}
      SELECT d.campaign_id AS entity_id, d.date::text AS day,
        ${lineageCampaign.tierSql("objective")} AS tier,
        ${lineageCampaign.readinessSql("objective")} AS readiness,
        ${lineageCampaign.sourceClassSql("objective")} AS source_class,
        ${lineageCampaign.evidenceRefSql("objective")} AS ref
      FROM scope d${lineageCampaign.lateralSql}
    ) x
    ORDER BY x.entity_id, x.day`;
  const result = (await getDb().query(query, [
    lineageBusinessId,
    LINEAGE_DAY,
    LINEAGE_NEXT_DAY,
    cutoff,
  ])) as LineageRow[];
  return result.map((row) => ({ ...row, ref: asJson(row.ref) }));
}

async function readAdsetRefs(rows: readonly ScopeRow[], cutoff: string) {
  const coherent = Object.entries(ADSET_REF_COLUMNS)
    .map(
      ([field, column]) =>
        `${configFieldEvidenceRefCoherentSql(`x.${column}`, field as MetaConfigEvidenceField)} AS ${column}_coherent,
      ${configFieldEvidenceRefIdentityTextSql(`x.${column}`)} AS ${column}_identity`,
    )
    .join(",\n      ");
  const refs = Object.entries(ADSET_REF_COLUMNS)
    .map(
      ([field, column]) =>
        `${lineageAdset.tierSql(field as keyof typeof ADSET_REF_COLUMNS)} AS ${column}_tier,
        ${lineageAdset.evidenceRefSql(field as keyof typeof ADSET_REF_COLUMNS)} AS ${column}`,
    )
    .join(",\n        ");
  const query = `SELECT x.*,
      ${coherent}
    FROM (
      WITH scope(provider_account_id, adset_id, date, account_timezone) AS (
        VALUES ${scopeValues(rows)}
      ),
      ${lineageAdset.withSql}
      SELECT d.adset_id AS entity_id, d.date::text AS day,
        ${refs}
      FROM scope d${lineageAdset.lateralSql}
    ) x
    ORDER BY x.entity_id, x.day`;
  const result = (await getDb().query(query, [
    lineageBusinessId,
    LINEAGE_DAY,
    LINEAGE_NEXT_DAY,
    cutoff,
  ])) as Record<string, unknown>[];
  return result.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const column of Object.values(ADSET_REF_COLUMNS)) {
      out[column] = asJson(row[column]);
    }
    return out;
  });
}

function parsed(raw: unknown, field: MetaConfigEvidenceField): ConfigFieldEvidenceRef {
  const result = parseConfigFieldEvidenceRef(raw, field);
  if (!result.ok) {
    throw new Error(`reference refused (${result.refusal}): ${JSON.stringify(raw)}`);
  }
  return result.ref;
}

const scopeHashOf = (fields: string) =>
  createHash("sha256").update(`${fields}\u001f`, "utf8").digest("hex");

const NO_IDENTITY = {
  sourceSnapshotId: null,
  observationId: null,
  observedAt: null,
  fieldScopeHash: null,
  corroboratingSnapshotId: null,
  corroboratingObservationId: null,
  corroboratingObservedAt: null,
};

describe.skipIf(!SEAM)("config-field receipt lineage (real PostgreSQL)", () => {
  beforeAll(async () => {
    await seedLineage();
  });

  it("cites BOTH observations of a modern bracket, and only a bracket's corroboration", async () => {
    const [bracketed] = await readCampaignRefs(
      [{ entity: MODERN_CAMPAIGN, date: LINEAGE_DAY, tz: "UTC" }],
      "2026-09-20T00:00:00Z",
    );
    expect(bracketed?.tier).toBe("provider_receipt_day_bracketed");
    expect(bracketed?.coherent).toBe(true);
    expect(bracketed?.ref).toEqual({
      refContractVersion: "meta-config-field-evidence-ref.v1",
      field: "objective",
      sourceContractVersion: "meta-config-field-source.v1",
      normalizationVersion: 1,
      tier: "provider_receipt_day_bracketed",
      readiness: "decision_authority",
      sourceClass: "modern",
      pitClass: "as_of_known",
      sourceSnapshotId: seeded.modernSnapshot,
      observationId: seeded.modernDayObservation,
      observedAt: `${LINEAGE_DAY}T10:00:00.000Z`,
      fieldScopeHash: scopeHashOf(LINEAGE_CAMPAIGN_FIELDS),
      corroboratingSnapshotId: seeded.modernSnapshot,
      corroboratingObservationId: seeded.modernNextObservation,
      corroboratingObservedAt: `${LINEAGE_NEXT_DAY}T04:00:00.000Z`,
    });
    /* The two ends share one snapshot; only the observation ids tell them apart. */
    expect(seeded.modernDayObservation).not.toBe(seeded.modernNextObservation);
    const ref = parsed(bracketed?.ref, "objective");
    expect(ref.readiness).toBe(bracketed?.readiness);
    expect(bracketed?.identity_text).toBe(configFieldEvidenceRefIdentityText(ref));

    /*
      Before the next morning's sighting is visible, the same day is a pending
      receipt: the later observation proved nothing yet, so it is not cited.
    */
    const [pending] = await readCampaignRefs(
      [{ entity: MODERN_CAMPAIGN, date: LINEAGE_DAY, tz: "UTC" }],
      `${LINEAGE_DAY}T12:00:00Z`,
    );
    expect(pending?.tier).toBe("provider_receipt_pending_corroboration");
    expect(pending?.coherent).toBe(true);
    const pendingRef = parsed(pending?.ref, "objective");
    expect(pendingRef.observationId).toBe(seeded.modernDayObservation);
    expect(pendingRef.corroboratingSnapshotId).toBeNull();
    expect(pendingRef.corroboratingObservationId).toBeNull();
    expect(pendingRef.corroboratingObservedAt).toBeNull();
  });

  it("gives two observations of ONE snapshot, picked on different days, different identities", async () => {
    const rows = await readAdsetRefs(
      [
        { entity: SAME_SNAPSHOT_ADSET, date: LINEAGE_DAY, tz: "UTC" },
        { entity: SAME_SNAPSHOT_ADSET, date: LINEAGE_NEXT_DAY, tz: "UTC" },
      ],
      `${LINEAGE_NEXT_DAY}T12:00:00Z`,
    );
    expect(rows).toHaveLength(2);
    const [day, next] = rows;
    expect(day?.goal_ref_tier).toBe("provider_receipt_legacy_bracketed");
    expect(next?.goal_ref_tier).toBe("provider_receipt_pending_corroboration");
    for (const row of rows) {
      for (const column of Object.values(ADSET_REF_COLUMNS)) {
        expect(row[`${column}_coherent`], `${row.day} ${column}`).toBe(true);
      }
    }
    const dayRef = parsed(day?.goal_ref, "optimization_goal");
    const nextRef = parsed(next?.goal_ref, "optimization_goal");
    // Same canonical content at both picks...
    expect(dayRef.sourceSnapshotId).toBe(seeded.sameSnapshot);
    expect(nextRef.sourceSnapshotId).toBe(seeded.sameSnapshot);
    // ...but a different receipt, so a different identity.
    expect(dayRef.observationId).toBe(seeded.sameSnapshotDayObservation);
    expect(nextRef.observationId).toBe(seeded.sameSnapshotNextObservation);
    expect(day?.goal_ref_identity).not.toBe(next?.goal_ref_identity);
    expect(configFieldEvidenceRefIdentityText(dayRef)).not.toBe(
      configFieldEvidenceRefIdentityText(nextRef),
    );
    // The bracket's closing end is the next day's observation of the SAME snapshot.
    expect(dayRef.corroboratingSnapshotId).toBe(seeded.sameSnapshot);
    expect(dayRef.corroboratingObservationId).toBe(seeded.sameSnapshotNextObservation);
    expect(dayRef.sourceClass).toBe("legacy_observed");

    /*
      An OBSERVED ABSENCE is as known at the cutoff as a receipt that carried a
      value. The ad-set pit class used to key on the value and call it
      restated, which the campaign contract never did.
    */
    const absence = parsed(day?.conversion_ref, "custom_conversion_id");
    expect(absence.tier).toBe("observed_absent");
    expect(absence.readiness).toBe("none");
    expect(absence.pitClass).toBe("as_of_known");
    expect(absence.observationId).toBe(seeded.sameSnapshotDayObservation);
    /* The shared promoted_object resolution: one receipt for both fields. */
    const event = parsed(day?.event_ref, "custom_event_type");
    expect(event.tier).toBe("provider_receipt_legacy_bracketed");
    expect(event.observationId).toBe(absence.observationId);
  });

  it("carries an explicit NULL observation id for a snapshot-only legacy receipt, and stays coherent", async () => {
    const [row] = await readCampaignRefs(
      [{ entity: SNAPSHOT_ONLY_CAMPAIGN, date: LINEAGE_DAY, tz: "UTC" }],
      "2026-09-20T00:00:00Z",
    );
    expect(row?.tier).toBe("provider_receipt_legacy_single_page");
    expect(row?.source_class).toBe("legacy_snapshot_only");
    expect(row?.coherent).toBe(true);
    const ref = parsed(row?.ref, "objective");
    expect(ref).toMatchObject({
      sourceClass: "legacy_snapshot_only",
      readiness: "review_only",
      pitClass: "as_of_known",
      normalizationVersion: 1,
      sourceSnapshotId: seeded.snapshotOnly,
      observationId: null,
      observedAt: `${LINEAGE_DAY}T09:00:00.000Z`,
      fieldScopeHash: scopeHashOf(LINEAGE_CAMPAIGN_FIELDS),
      corroboratingSnapshotId: null,
    });
    /* The JSON carries the key with a null, not an absent key. */
    expect(Object.prototype.hasOwnProperty.call(row?.ref, "observationId")).toBe(true);
  });

  it("gives typed and unknown tiers no identity at all, even when the tier refused a receipt", async () => {
    const rows = await readCampaignRefs(
      [
        { entity: TYPED_CAMPAIGN, date: LINEAGE_DAY, tz: "UTC" },
        { entity: UNKNOWN_CAMPAIGN, date: LINEAGE_DAY, tz: "UTC" },
      ],
      "2026-09-20T00:00:00Z",
    );
    const byEntity = new Map(rows.map((row) => [row.entity_id, row]));
    const typed = byEntity.get(TYPED_CAMPAIGN);
    expect(typed?.tier).toBe("typed_contemporaneous");
    expect(typed?.coherent).toBe(true);
    expect(parsed(typed?.ref, "objective")).toMatchObject({
      sourceClass: "typed_unlinked",
      readiness: "review_only",
      normalizationVersion: null,
      pitClass: null,
      ...NO_IDENTITY,
    });
    const unknown = byEntity.get(UNKNOWN_CAMPAIGN);
    expect(unknown?.tier).toBe("unknown");
    expect(unknown?.coherent).toBe(true);
    expect(parsed(unknown?.ref, "objective")).toMatchObject({
      sourceClass: "none",
      readiness: "none",
      normalizationVersion: null,
      pitClass: null,
      ...NO_IDENTITY,
    });

    /*
      A receipt exists, but the account has no timezone, so the tier cannot date
      it and says unknown. The reference follows the TIER: it must not cite a
      receipt the tier refused, and it must still be coherent — an unknown zone
      is a legitimate state, not a corrupted reference.
    */
    const [noTz] = await readCampaignRefs(
      [{ entity: NO_TZ_CAMPAIGN, date: LINEAGE_DAY, tz: null }],
      "2026-09-20T00:00:00Z",
    );
    expect(noTz?.tier).toBe("unknown");
    expect(noTz?.source_class).toBe("legacy_observed");
    expect(noTz?.coherent).toBe(true);
    expect(parsed(noTz?.ref, "objective")).toMatchObject({
      sourceClass: "none",
      readiness: "none",
      ...NO_IDENTITY,
    });
  });

  it("fails closed on every hand-corrupted reference, in SQL and in TypeScript alike", async () => {
    const [modern] = await readCampaignRefs(
      [{ entity: MODERN_CAMPAIGN, date: LINEAGE_DAY, tz: "UTC" }],
      "2026-09-20T00:00:00Z",
    );
    const [snapshotOnly] = await readCampaignRefs(
      [{ entity: SNAPSHOT_ONLY_CAMPAIGN, date: LINEAGE_DAY, tz: "UTC" }],
      "2026-09-20T00:00:00Z",
    );
    const cases = (await getDb().query(
      `SELECT c.label, c.ref,
         ${configFieldEvidenceRefCoherentSql("c.ref", "objective")} AS coherent
       FROM (VALUES
         ('untouched', $1::jsonb),
         ('modern receipt without its observation id',
           jsonb_set($1::jsonb, '{observationId}', 'null'::jsonb)),
         ('observation id that is not a uuid',
           jsonb_set($1::jsonb, '{observationId}', '"not-a-uuid"'::jsonb)),
         ('field scope key removed', $1::jsonb - 'fieldScopeHash'),
         ('bracket without its corroboration',
           jsonb_set($1::jsonb, '{corroboratingSnapshotId}', 'null'::jsonb)),
         ('readiness no longer the tier''s',
           jsonb_set($1::jsonb, '{tier}', '"provider_receipt_point_in_day"'::jsonb)),
         ('unknown reference contract',
           jsonb_set($1::jsonb, '{refContractVersion}', '"meta-config-field-evidence-ref.v0"'::jsonb)),
         ('another field''s reference',
           jsonb_set($1::jsonb, '{field}', '"optimization_goal"'::jsonb)),
         ('clock without milliseconds',
           jsonb_set($1::jsonb, '{observedAt}', '"2026-09-15T10:00:00Z"'::jsonb)),
         ('snapshot-only receipt claiming an observation',
           jsonb_set($2::jsonb, '{observationId}', to_jsonb($3::text))),
         ('not an object', '[]'::jsonb)
       ) c(label, ref)
       ORDER BY c.label`,
      [
        JSON.stringify(modern?.ref),
        JSON.stringify(snapshotOnly?.ref),
        seeded.modernDayObservation,
      ],
    )) as { label: string; ref: unknown; coherent: boolean }[];
    expect(cases).toHaveLength(11);
    for (const row of cases) {
      const expected = row.label === "untouched";
      expect(row.coherent, `sql: ${row.label}`).toBe(expected);
      expect(
        parseConfigFieldEvidenceRef(asJson(row.ref), "objective").ok,
        `ts: ${row.label}`,
      ).toBe(expected);
    }
  });

  it("breaks a same-snapshot, same-instant tie on the observation id, every time", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [row] = await readAdsetRefs(
        [{ entity: TIE_ADSET, date: LINEAGE_DAY, tz: "UTC" }],
        "2026-09-20T00:00:00Z",
      );
      expect(row?.goal_ref_tier).toBe("provider_receipt_legacy_single_page");
      expect(row?.goal_ref_coherent).toBe(true);
      expect(parsed(row?.goal_ref, "optimization_goal").observationId).toBe(
        TIE_OBSERVATION_LOW,
      );
    }
  });
});
