/**
 * ConfigFieldEvidenceRef: the SQL rule and the TypeScript rule give ONE answer.
 *
 * `configFieldEvidenceRefCoherentSql` gates readiness inside hydration and
 * calibration; `parseConfigFieldEvidenceRef` gates it again in TypeScript and
 * re-validates what the read model serves. A reference one accepts and the
 * other refuses would either grant a field in SQL that TypeScript then serves
 * as refused, or the reverse. Every shared fixture is therefore executed on
 * real PostgreSQL and compared with the parser, and the manifest line and hash
 * are recomputed in both languages.
 *
 * Runs only inside an ephemeral-database seam (ADSECUTE_EPHEMERAL_DB_SEAM=1),
 * because outside one DATABASE_URL in this repository points at PRODUCTION.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  configFieldEvidenceRefCoherentSql,
  configReceiptManifestHashSql,
  configReceiptManifestLine,
  configReceiptManifestLineSql,
  configReceiptNullObservationCountSql,
  hashConfigReceiptManifest,
  META_CONFIG_EVIDENCE_FIELDS,
  parseConfigFieldEvidenceRef,
} from "@/lib/meta/config-field-evidence-ref";
import { COHERENCE_FIXTURES, receiptRef } from "@/lib/meta/config-field-evidence-ref.fixtures";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

describe.runIf(SEAM)("ConfigFieldEvidenceRef SQL/TypeScript parity on real PostgreSQL", () => {
  let client: import("pg").Client;

  beforeAll(async () => {
    const { Client } = await import("pg");
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it("agrees with the parser on every shared fixture, both directions", async () => {
    for (const fixture of COHERENCE_FIXTURES) {
      const { rows } = await client.query<{ coherent: boolean }>(
        `SELECT ${configFieldEvidenceRefCoherentSql("fixture.ref", fixture.field)} AS coherent
           FROM (SELECT $1::jsonb AS ref) fixture`,
        [fixture.ref === null ? null : JSON.stringify(fixture.ref)],
      );
      expect(rows[0]?.coherent, fixture.name).toBe(fixture.coherent);
      expect(parseConfigFieldEvidenceRef(fixture.ref, fixture.field).ok, fixture.name).toBe(
        fixture.coherent,
      );
    }
  });

  it("builds the same manifest line and hash in both languages", async () => {
    const days = [
      { date: "2026-09-19", spend: 10, refs: { objective: receiptRef(), optimization_goal: null } },
      { date: "2026-09-20", spend: 0, refs: { objective: receiptRef({ observationId: "44444444-4444-4444-8444-444444444444" }) } },
      {
        date: "2026-09-21",
        spend: 5,
        refs: {
          objective: receiptRef({
            tier: "provider_receipt_legacy_single_page",
            readiness: "review_only",
            sourceClass: "legacy_snapshot_only",
            observationId: null,
            corroboratingSnapshotId: null,
            corroboratingObservationId: null,
            corroboratingObservedAt: null,
          }),
        },
      },
    ];
    const values = days.map((day) => [
      day.date,
      day.spend,
      ...META_CONFIG_EVIDENCE_FIELDS.map((field) => {
        const ref = (day.refs as Record<string, unknown>)[field];
        return ref === undefined || ref === null ? null : JSON.stringify(ref);
      }),
    ]);
    const refSql = {
      objective: "d.objective_ref",
      optimization_goal: "d.optimization_goal_ref",
      custom_event_type: "d.custom_event_type_ref",
      custom_conversion_id: "d.custom_conversion_id_ref",
    };
    const { rows } = await client.query<{ hash: string; lines: string; null_obs: number }>(
      `WITH d AS (
         SELECT (v->>0)::date AS date, (v->>1)::numeric AS spend,
                (v->>2)::jsonb AS objective_ref, (v->>3)::jsonb AS optimization_goal_ref,
                (v->>4)::jsonb AS custom_event_type_ref, (v->>5)::jsonb AS custom_conversion_id_ref
         FROM jsonb_array_elements($1::jsonb) AS v
       )
       SELECT
         ${configReceiptManifestHashSql({
           lineSql: configReceiptManifestLineSql({ dateSql: "d.date", refSql }),
           includeSql: "d.spend <> 0",
           orderSql: "d.date",
         })} AS hash,
         string_agg(${configReceiptManifestLineSql({ dateSql: "d.date", refSql })}, E'\\n' ORDER BY d.date)
           FILTER (WHERE d.spend <> 0) AS lines,
         SUM(${configReceiptNullObservationCountSql(refSql)}) FILTER (WHERE d.spend <> 0)::int AS null_obs
       FROM d`,
      [JSON.stringify(values)],
    );
    const economic = days.filter((day) => day.spend !== 0);
    const tsLines = economic.map((day) => configReceiptManifestLine(day.date, day.refs));
    expect(rows[0]?.lines).toBe(tsLines.join("\n"));
    expect(rows[0]?.hash).toBe(hashConfigReceiptManifest(tsLines));
    // One snapshot-only receipt on an economic day; the inert day is excluded.
    expect(rows[0]?.null_obs).toBe(1);
  });
});
