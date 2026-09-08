/**
 * D083 Correction 3 — schedule timestamps, against a real PostgreSQL.
 *
 * WHAT WAS BROKEN. `campaign_start_time`, `campaign_end_time`,
 * `adset_start_time` and `adset_end_time` are `timestamptz` columns and the
 * value reaching them was a raw provider string. The campaign and ad-set
 * mappers in `lib/api/meta.ts` build them with
 * `optionalString(input.row.start_time)` — trim, reject blanks, validate
 * nothing else — and both INSERT sites in
 * `lib/meta/entity-state-history.ts` cast the result with `::timestamptz`.
 * PostgreSQL was therefore the FIRST thing that looked at the value, and it
 * looks at it inside `runDbTransaction`, so ONE unusable string aborted the
 * whole observation: every entity in the payload, not just the bad row. That
 * is the defect this file is about, and `does not let an invalid value abort
 * the observation` measures it directly: it asks this database to cast the
 * same string, watches it error, and then persists a three-campaign payload
 * containing it and finds all three rows durable.
 *
 * EVERY CASE HERE FAILS WITHOUT THE FIX. The PostgreSQL measurements are
 * deliberately folded INTO the cases they justify rather than standing as
 * cases of their own, because a case that passes with the normalizer removed
 * proves nothing about the normalizer.
 *
 * WHY REAL POSTGRES, and not a template-SQL mock. Every claim here is a claim
 * about what PostgreSQL does:
 *
 *   - that `'not-a-date'::timestamptz` and `''::timestamptz` are ERRORS rather
 *     than nulls, which is the whole reason validation has to happen before
 *     the write;
 *   - that `'99999-01-01'::timestamptz` is ACCEPTED while its own canonical
 *     expanded-year ISO rendering is REFUSED — the trap that makes an
 *     out-of-range date an explicit unknown instead of something to normalize;
 *   - that the carry-forward lateral inside `stateSelect` restores a prior
 *     schedule for a `degraded_not_observed` row and does NOT restore one for
 *     an `invalid_not_retained` row. That lateral is SQL. It is executed here,
 *     never restated;
 *   - and that the row and its own `state_hash` agree, which is only checkable
 *     by reading the columns back out of the table the writer wrote.
 *
 * THE THREE NULLS ARE TESTED AS THREE. A null schedule column can mean a
 * measured absence, a field the request had to drop, or a value the provider
 * answered with that could not be written. `keeps the three nulls apart in one
 * timeline` is the case that fails if they are ever collapsed, and it is the
 * one to read first.
 *
 * Runs only inside an ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`),
 * because outside one `DATABASE_URL` in this repository points at PRODUCTION.
 * Under a plain `npx vitest run` the default include still COLLECTS this file
 * and `describe.skipIf(!SEAM)` reports every case as skipped, which reads
 * green — so the file is registered as a stage of
 * `scripts/ephemeral-postgres-migrations-check.ts`, whose `runChildVitest`
 * fails the gate on a skipped or short run. Adding or removing a case here
 * means updating the expected passing count in that registration.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import {
  META_FIELD_COVERAGE_SCHEDULE_INVALID,
  buildMetaEntityStateHash,
  persistMetaEntityObservation,
  readMetaEntityStatesAsOf,
  type MetaEntityObservationStateInput,
} from "@/lib/meta/entity-state-history";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

/** Ids chosen not to collide with any other stage of the seam gate. */
const OWNER_EMAIL = "schedule-timestamp-normalization@example.invalid";
const ACCOUNT_ID = "act_schedule_norm_8101";
const VALID_ENDPOINT = "campaign_configs_schedule_valid";
const INVALID_ENDPOINT = "campaign_configs_schedule_invalid";
const BLANK_ENDPOINT = "campaign_configs_schedule_blank";
const ABSENT_ENDPOINT = "campaign_configs_schedule_absent";
const RANGE_ENDPOINT = "campaign_configs_schedule_out_of_range";
const TRANSITION_ENDPOINT = "adset_configs_schedule_transition";
const THREE_NULLS_ENDPOINT = "campaign_configs_schedule_three_nulls";
const HASH_ENDPOINT = "campaign_configs_schedule_hash_agreement";
const CAPTURE_CUTOFF_ENDPOINT = "configs_schedule_capture_cutoff";

let businessId = "";

async function seed() {
  const sql = getDb();
  const [owner] = await sql<{ id: string }>`
    INSERT INTO users (name, email, password_hash)
    VALUES ('Schedule normalization seam', ${OWNER_EMAIL}, 'unused')
    RETURNING id
  `;
  if (!owner?.id) throw new Error("Could not create the seam owner.");
  const [business] = await sql<{ id: string }>`
    INSERT INTO businesses (name, owner_id)
    VALUES ('Schedule normalization seam', ${owner.id})
    RETURNING id
  `;
  if (!business?.id) throw new Error("Could not create the seam business.");
  businessId = business.id;
  const [account] = await sql<{ id: string }>`
    INSERT INTO provider_accounts (provider, external_account_id, account_name)
    VALUES ('meta', ${ACCOUNT_ID}, 'Schedule normalization seam')
    RETURNING id
  `;
  if (!account?.id) throw new Error("Could not create the seam account.");
  await sql`
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (${businessId}, 'meta', ${account.id}, ${ACCOUNT_ID})
  `;
}

function campaignState(input: {
  entityId: string;
  observedAt: string;
  startTime?: unknown;
  endTime?: unknown;
  coverage?: Record<string, unknown>;
}): MetaEntityObservationStateInput {
  return {
    businessId,
    providerAccountId: ACCOUNT_ID,
    entityType: "campaign",
    entityId: input.entityId,
    campaignId: input.entityId,
    adsetId: null,
    adId: null,
    creativeId: null,
    entityName: input.entityId,
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
    learningSource: "not_observed",
    budgetOrigin: "campaign",
    campaignLifetimeBudgetRaw: "500000",
    budgetCurrency: "USD",
    campaignStartTime: (input.startTime ?? null) as string | null,
    campaignEndTime: (input.endTime ?? null) as string | null,
    presence: "present",
    fieldCoverage: input.coverage ?? {
      campaignStartTime: true,
      campaignEndTime: true,
    },
    providerUpdatedAt: "2026-08-10T00:00:00.000Z",
    observedAt: input.observedAt,
  };
}

function adsetState(input: {
  entityId: string;
  observedAt: string;
  startTime?: unknown;
  endTime?: unknown;
  coverage?: Record<string, unknown>;
}): MetaEntityObservationStateInput {
  return {
    businessId,
    providerAccountId: ACCOUNT_ID,
    entityType: "adset",
    entityId: input.entityId,
    campaignId: "campaign_schedule_transition",
    adsetId: input.entityId,
    adId: null,
    creativeId: null,
    entityName: input.entityId,
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
    learningSource: "not_observed",
    budgetOrigin: "adset",
    adsetLifetimeBudgetRaw: "250000",
    budgetCurrency: "USD",
    adsetStartTime: (input.startTime ?? null) as string | null,
    adsetEndTime: (input.endTime ?? null) as string | null,
    presence: "present",
    fieldCoverage: input.coverage ?? { adsetStartTime: true },
    providerUpdatedAt: "2026-08-10T00:00:00.000Z",
    observedAt: input.observedAt,
  };
}

function completeObservation(input: {
  entityType: "campaign" | "adset";
  endpoint: string;
  observedAt: string;
  capturedAt?: string;
  states: MetaEntityObservationStateInput[];
}) {
  return {
    businessId,
    providerAccountId: ACCOUNT_ID,
    entityType: input.entityType,
    endpoint: input.endpoint,
    observedAt: input.observedAt,
    capturedAt: input.capturedAt ?? input.observedAt,
    completeness: "complete" as const,
    pageCount: 1,
    providerRowCount: input.states.length,
    states: input.states,
  };
}

/** The stored row, read as the writer left it. */
async function storedRow(runId: string, entityId: string) {
  const sql = getDb();
  const [row] = await sql<{
    campaign_start_time: string | null;
    campaign_end_time: string | null;
    adset_start_time: string | null;
    field_coverage_json: Record<string, unknown>;
    state_hash: string;
  }>`
    SELECT
      campaign_start_time::text AS campaign_start_time,
      campaign_end_time::text AS campaign_end_time,
      adset_start_time::text AS adset_start_time,
      field_coverage_json,
      state_hash
    FROM meta_entity_state_history
    WHERE run_id = ${runId}::uuid AND entity_id = ${entityId}
  `;
  if (!row) throw new Error(`No stored row for ${entityId}.`);
  return row;
}

async function readCampaign(entityId: string, cutoff: string) {
  const rows = await readMetaEntityStatesAsOf({
    businessId,
    providerAccountId: ACCOUNT_ID,
    entityType: "campaign",
    entityIds: [entityId],
    cutoff,
  });
  return rows[0] ?? null;
}

async function readAdset(entityId: string, cutoff: string) {
  const rows = await readMetaEntityStatesAsOf({
    businessId,
    providerAccountId: ACCOUNT_ID,
    entityType: "adset",
    entityIds: [entityId],
    cutoff,
  });
  return rows[0] ?? null;
}

describe.skipIf(!SEAM)(
  "Meta schedule timestamp normalization against real PostgreSQL",
  () => {
    beforeAll(async () => {
      await seed();
    });

    it("stores a valid schedule as the instant it names", async () => {
      const result = await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: VALID_ENDPOINT,
          observedAt: "2026-09-01T00:00:00.000Z",
          states: [
            campaignState({
              entityId: "campaign_valid",
              observedAt: "2026-09-01T00:00:00.000Z",
              // Meta's own spelling: an offset, not a Z.
              startTime: "2026-09-07T10:00:00+0300",
              endTime: "2026-10-01T00:00:00+0000",
            }),
          ],
        }),
      );
      expect(result.stateCount).toBe(1);

      const stored = await storedRow(result.runId, "campaign_valid");
      // The column holds the INSTANT. Offset spelling is not information a
      // timestamptz column can keep, so nothing was lost by canonicalizing it.
      expect(new Date(stored.campaign_start_time!).toISOString()).toBe(
        "2026-09-07T07:00:00.000Z",
      );
      expect(new Date(stored.campaign_end_time!).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      // A measured value keeps the mapper's own coverage.
      expect(stored.field_coverage_json.campaignStartTime).toBe(true);

      const read = await readCampaign("campaign_valid", "2026-09-02T00:00:00.000Z");
      expect(new Date(read!.campaignStartTime!).toISOString()).toBe(
        "2026-09-07T07:00:00.000Z",
      );

      // ...and the hash beside it is the hash of the CANONICAL spelling. The
      // column stores an instant, so the offset form and the Z form are the
      // same stored value — the hash is where the difference would show, and
      // where an un-normalized writer would put the row and its own hash out
      // of agreement. Same instant, one hash, one row.
      expect(stored.state_hash).toBe(
        buildMetaEntityStateHash(
          campaignState({
            entityId: "campaign_valid",
            observedAt: "2026-09-01T00:00:00.000Z",
            startTime: "2026-09-07T07:00:00.000Z",
            endTime: "2026-10-01T00:00:00.000Z",
          }),
        ),
      );
    });

    it("does not let an invalid value abort the observation", async () => {
      const sql = getDb();
      // The counterfactual, measured rather than argued. This is the exact
      // cast both INSERT sites perform, and they perform it inside the
      // observation transaction — so this error took every entity in the
      // payload down with it.
      await expect(
        sql`SELECT ${"not-a-date"}::timestamptz AS value`,
      ).rejects.toThrow(
        /invalid input syntax for type timestamp with time zone/,
      );

      // Three campaigns, one poisoned. Before the fix this whole call threw
      // and none of the three rows existed.
      const result = await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: INVALID_ENDPOINT,
          observedAt: "2026-09-01T00:00:00.000Z",
          states: [
            campaignState({
              entityId: "campaign_good_a",
              observedAt: "2026-09-01T00:00:00.000Z",
              startTime: "2026-09-07T07:00:00.000Z",
            }),
            campaignState({
              entityId: "campaign_broken",
              observedAt: "2026-09-01T00:00:00.000Z",
              startTime: "not-a-date",
            }),
            campaignState({
              entityId: "campaign_good_b",
              observedAt: "2026-09-01T00:00:00.000Z",
              startTime: "2026-09-08T07:00:00.000Z",
            }),
          ],
        }),
      );
      expect(result.stateCount).toBe(3);

      const broken = await storedRow(result.runId, "campaign_broken");
      expect(broken.campaign_start_time).toBeNull();
      // EXPLICIT unknown: the null is labelled, so no reader has to guess
      // whether the provider answered.
      expect(broken.field_coverage_json.campaignStartTime).toBe(
        META_FIELD_COVERAGE_SCHEDULE_INVALID,
      );
      // The rest of the payload is untouched — that is the point.
      const goodA = await storedRow(result.runId, "campaign_good_a");
      const goodB = await storedRow(result.runId, "campaign_good_b");
      expect(new Date(goodA.campaign_start_time!).toISOString()).toBe(
        "2026-09-07T07:00:00.000Z",
      );
      expect(new Date(goodB.campaign_start_time!).toISOString()).toBe(
        "2026-09-08T07:00:00.000Z",
      );
    });

    it("treats an empty string as an explicit unknown, not a measured absence", async () => {
      const sql = getDb();
      // A blank is an ERROR to this database, not a null. That is the whole
      // reason it cannot be read as a measured absence.
      await expect(
        sql`SELECT ${""}::timestamptz AS value`,
      ).rejects.toThrow(
        /invalid input syntax for type timestamp with time zone/,
      );

      const result = await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: BLANK_ENDPOINT,
          observedAt: "2026-09-01T00:00:00.000Z",
          states: [
            campaignState({
              entityId: "campaign_blank",
              observedAt: "2026-09-01T00:00:00.000Z",
              startTime: "",
            }),
          ],
        }),
      );
      const stored = await storedRow(result.runId, "campaign_blank");
      expect(stored.campaign_start_time).toBeNull();
      // Not `false`. A blank string is an error to this database, not a null,
      // so nothing about it says the provider meant "no schedule".
      expect(stored.field_coverage_json.campaignStartTime).toBe(
        META_FIELD_COVERAGE_SCHEDULE_INVALID,
      );
    });

    it("makes an out-of-range date an explicit unknown", async () => {
      const sql = getDb();
      // The trap, measured on this cluster: PostgreSQL takes the RAW
      // year-99999 string...
      const [raw] = await sql<{ value: string }>`
        SELECT ${"99999-01-01"}::timestamptz::text AS value
      `;
      expect(raw?.value).toContain("99999-01-01");
      // ...and refuses the canonical expanded-year rendering of that very
      // same value, which is what any normalizer would have produced. A
      // date-only string is interpreted in the process timezone, so the exact
      // instant differs between UTC CI and a local non-UTC workstation; the
      // expanded-year shape and PostgreSQL refusal are the stable contract.
      const expandedIso = new Date("99999-01-01").toISOString();
      expect(expandedIso).toMatch(/^\+\d{6}-\d{2}-\d{2}T/);
      await expect(
        sql`SELECT ${expandedIso}::timestamptz AS value`,
      ).rejects.toThrow(/time zone displacement out of range/);

      const result = await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: RANGE_ENDPOINT,
          observedAt: "2026-09-01T00:00:00.000Z",
          states: [
            campaignState({
              entityId: "campaign_year_99999",
              observedAt: "2026-09-01T00:00:00.000Z",
              startTime: "99999-01-01",
            }),
          ],
        }),
      );
      const stored = await storedRow(result.runId, "campaign_year_99999");
      // NOT the year-99999 timestamp this database would happily have stored.
      // A schedule in the year 99999 is not a schedule, and its canonical
      // rendering is one this database refuses — so it is unknown, explicitly.
      expect(stored.campaign_start_time).toBeNull();
      expect(stored.field_coverage_json.campaignStartTime).toBe(
        META_FIELD_COVERAGE_SCHEDULE_INVALID,
      );
    });

    it("keeps the three nulls apart in one timeline", async () => {
      /*
        The discriminator, run as one campaign observed three times.

        t1: a real schedule.
        t2: the campaigns edge refused the schedule fields, so the row's null
            carries `degraded_not_observed` — nobody asked. The carry-forward
            lateral in `stateSelect` MUST restore t1's value.
        t3: the edge answered, and the answer was unusable. The row's null
            carries `invalid_not_retained`. The same lateral MUST NOT restore
            anything: the old value has been contradicted, not left standing.

        Same column, same null, opposite answers, decided by the marker alone.
      */
      // Case 1 first, on its own entity: a null the request DID ask about.
      // Overwriting its `false` with the invalid marker would report a
      // provider answer that never came, so this is the over-correction guard
      // for everything below.
      const absentRun = await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: ABSENT_ENDPOINT,
          observedAt: "2026-09-01T00:00:00.000Z",
          states: [
            campaignState({
              entityId: "campaign_absent",
              observedAt: "2026-09-01T00:00:00.000Z",
              startTime: null,
              coverage: { campaignStartTime: false, campaignEndTime: false },
            }),
          ],
        }),
      );
      const absent = await storedRow(absentRun.runId, "campaign_absent");
      expect(absent.campaign_start_time).toBeNull();
      expect(absent.field_coverage_json.campaignStartTime).toBe(false);

      await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: THREE_NULLS_ENDPOINT,
          observedAt: "2026-09-01T00:00:00.000Z",
          states: [
            campaignState({
              entityId: "campaign_three_nulls",
              observedAt: "2026-09-01T00:00:00.000Z",
              startTime: "2026-09-07T07:00:00.000Z",
            }),
          ],
        }),
      );
      await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: THREE_NULLS_ENDPOINT,
          observedAt: "2026-09-02T00:00:00.000Z",
          states: [
            campaignState({
              entityId: "campaign_three_nulls",
              observedAt: "2026-09-02T00:00:00.000Z",
              startTime: null,
              coverage: {
                campaignStartTime: "degraded_not_observed",
                campaignEndTime: "degraded_not_observed",
              },
            }),
          ],
        }),
      );
      const carried = await readCampaign(
        "campaign_three_nulls",
        "2026-09-02T12:00:00.000Z",
      );
      // The documented carry rule, exercised: a request that never asked does
      // not destroy a schedule the system had observed.
      expect(new Date(carried!.campaignStartTime!).toISOString()).toBe(
        "2026-09-07T07:00:00.000Z",
      );

      const invalidRun = await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: THREE_NULLS_ENDPOINT,
          observedAt: "2026-09-03T00:00:00.000Z",
          states: [
            campaignState({
              entityId: "campaign_three_nulls",
              observedAt: "2026-09-03T00:00:00.000Z",
              startTime: "not-a-date",
            }),
          ],
        }),
      );
      const stored = await storedRow(invalidRun.runId, "campaign_three_nulls");
      expect(stored.field_coverage_json.campaignStartTime).toBe(
        META_FIELD_COVERAGE_SCHEDULE_INVALID,
      );
      const invalid = await readCampaign(
        "campaign_three_nulls",
        "2026-09-03T12:00:00.000Z",
      );
      // NOT "2026-09-07T07:00:00.000Z". An invalid new value must not silently
      // inherit an old one outside the carry rule, and the marker is exactly
      // what keeps it out of that rule.
      expect(invalid!.campaignStartTime).toBeNull();
      // The as-of read is still answering about the same entity at t3, so this
      // is a demotion to unknown rather than a row that vanished.
      expect(invalid!.entityId).toBe("campaign_three_nulls");
      expect(invalid!.configuredStatus).toBe("ACTIVE");
    });

    it("does not carry schedule knowledge captured after the selected state", async () => {
      const selectedObservedAt = "2026-09-12T00:00:00.000Z";
      const selectedCapturedAt = "2026-09-12T01:00:00.000Z";
      const futureCapturedAt = "2026-09-12T12:00:00.000Z";
      const cutoff = "2026-09-13T00:00:00.000Z";
      const campaignId = "campaign_capture_cutoff";
      const adsetId = "adset_capture_cutoff";
      const knownCampaignStart = "2026-09-18T00:00:00.000Z";
      const knownCampaignEnd = "2026-09-28T00:00:00.000Z";
      const knownAdsetStart = "2026-09-19T00:00:00.000Z";
      const knownAdsetEnd = "2026-09-27T00:00:00.000Z";

      // A fact that was genuinely known before the selected state remains
      // eligible for carry-forward. This makes the case reject both temporal
      // leakage and an implementation that simply disables the lateral carry.
      await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: CAPTURE_CUTOFF_ENDPOINT,
          observedAt: "2026-09-10T00:00:00.000Z",
          states: [
            campaignState({
              entityId: campaignId,
              observedAt: "2026-09-10T00:00:00.000Z",
              startTime: knownCampaignStart,
              endTime: knownCampaignEnd,
            }),
          ],
        }),
      );
      await persistMetaEntityObservation(
        completeObservation({
          entityType: "adset",
          endpoint: CAPTURE_CUTOFF_ENDPOINT,
          observedAt: "2026-09-10T00:00:00.000Z",
          states: [
            adsetState({
              entityId: adsetId,
              observedAt: "2026-09-10T00:00:00.000Z",
              startTime: knownAdsetStart,
              endTime: knownAdsetEnd,
              coverage: {
                adsetStartTime: true,
                adsetEndTime: true,
              },
            }),
          ],
        }),
      );

      // These degraded rows are the states that an as-of read is allowed to
      // select. They deliberately contain no schedule because that request
      // did not ask the provider for one.
      await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: CAPTURE_CUTOFF_ENDPOINT,
          observedAt: selectedObservedAt,
          capturedAt: selectedCapturedAt,
          states: [
            campaignState({
              entityId: campaignId,
              observedAt: selectedObservedAt,
              coverage: {
                campaignStartTime: "degraded_not_observed",
                campaignEndTime: "degraded_not_observed",
              },
            }),
          ],
        }),
      );
      await persistMetaEntityObservation(
        completeObservation({
          entityType: "adset",
          endpoint: CAPTURE_CUTOFF_ENDPOINT,
          observedAt: selectedObservedAt,
          capturedAt: selectedCapturedAt,
          states: [
            adsetState({
              entityId: adsetId,
              observedAt: selectedObservedAt,
              coverage: {
                adsetStartTime: "degraded_not_observed",
                adsetEndTime: "degraded_not_observed",
              },
            }),
          ],
        }),
      );

      // This provider fact claims an older observation time, but it did not
      // enter our knowledge until after the selected rows were captured. The
      // lateral must not attach later knowledge to their earlier provenance,
      // even when the reader's broader query cutoff would admit that row.
      await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: CAPTURE_CUTOFF_ENDPOINT,
          observedAt: "2026-09-11T00:00:00.000Z",
          capturedAt: futureCapturedAt,
          states: [
            campaignState({
              entityId: campaignId,
              observedAt: "2026-09-11T00:00:00.000Z",
              startTime: "2026-09-20T00:00:00.000Z",
              endTime: "2026-09-30T00:00:00.000Z",
            }),
          ],
        }),
      );
      await persistMetaEntityObservation(
        completeObservation({
          entityType: "adset",
          endpoint: CAPTURE_CUTOFF_ENDPOINT,
          observedAt: "2026-09-11T00:00:00.000Z",
          capturedAt: futureCapturedAt,
          states: [
            adsetState({
              entityId: adsetId,
              observedAt: "2026-09-11T00:00:00.000Z",
              startTime: "2026-09-21T00:00:00.000Z",
              endTime: "2026-09-29T00:00:00.000Z",
              coverage: {
                adsetStartTime: true,
                adsetEndTime: true,
              },
            }),
          ],
        }),
      );

      // Exercise both stateSelect SQL arms for both schedule pairs. Without
      // the capture bound, all eight assertions below receive the later
      // captured values; without carry-forward, they receive null.
      const filteredCampaign = await readCampaign(campaignId, cutoff);
      const filteredAdset = await readAdset(adsetId, cutoff);
      const allCampaigns = await readMetaEntityStatesAsOf({
        businessId,
        providerAccountId: ACCOUNT_ID,
        entityType: "campaign",
        cutoff,
      });
      const allAdsets = await readMetaEntityStatesAsOf({
        businessId,
        providerAccountId: ACCOUNT_ID,
        entityType: "adset",
        cutoff,
      });
      const unfilteredCampaign = allCampaigns.find(
        (row) => row.entityId === campaignId,
      );
      const unfilteredAdset = allAdsets.find((row) => row.entityId === adsetId);
      const instant = (value: string | null | undefined) =>
        value ? new Date(value).toISOString() : value;

      expect(instant(filteredCampaign?.campaignStartTime)).toBe(knownCampaignStart);
      expect(instant(filteredCampaign?.campaignEndTime)).toBe(knownCampaignEnd);
      expect(instant(filteredAdset?.adsetStartTime)).toBe(knownAdsetStart);
      expect(instant(filteredAdset?.adsetEndTime)).toBe(knownAdsetEnd);
      expect(instant(unfilteredCampaign?.campaignStartTime)).toBe(
        knownCampaignStart,
      );
      expect(instant(unfilteredCampaign?.campaignEndTime)).toBe(
        knownCampaignEnd,
      );
      expect(instant(unfilteredAdset?.adsetStartTime)).toBe(knownAdsetStart);
      expect(instant(unfilteredAdset?.adsetEndTime)).toBe(knownAdsetEnd);
    });

    it("appends the invalid row and comes back on the known -> invalid -> known transition", async () => {
      /*
        The transition, on the ad-set grain so both column pairs are covered.

        The middle observation has to be APPENDED, not deduped away: the delta
        writer compares state hashes, and the hash is computed over the
        NORMALIZED state, so "known" and "explicit unknown" are two different
        states and the writer sees a change. If normalization ever moved after
        the hash, the unknown would hash as the raw string, and the read below
        would still answer with the value at t1.
      */
      const known = "2026-09-07T07:00:00.000Z";
      const first = await persistMetaEntityObservation(
        completeObservation({
          entityType: "adset",
          endpoint: TRANSITION_ENDPOINT,
          observedAt: "2026-09-01T00:00:00.000Z",
          states: [
            adsetState({
              entityId: "adset_transition",
              observedAt: "2026-09-01T00:00:00.000Z",
              startTime: known,
            }),
          ],
        }),
      );
      const second = await persistMetaEntityObservation(
        completeObservation({
          entityType: "adset",
          endpoint: TRANSITION_ENDPOINT,
          observedAt: "2026-09-02T00:00:00.000Z",
          states: [
            adsetState({
              entityId: "adset_transition",
              observedAt: "2026-09-02T00:00:00.000Z",
              startTime: "not-a-date",
            }),
          ],
        }),
      );
      const third = await persistMetaEntityObservation(
        completeObservation({
          entityType: "adset",
          endpoint: TRANSITION_ENDPOINT,
          observedAt: "2026-09-03T00:00:00.000Z",
          states: [
            adsetState({
              entityId: "adset_transition",
              observedAt: "2026-09-03T00:00:00.000Z",
              startTime: known,
            }),
          ],
        }),
      );
      // Three distinct runs, each of which actually wrote the row.
      expect(second.runId).not.toBe(first.runId);
      expect(third.runId).not.toBe(second.runId);
      expect(second.stateCount).toBe(1);
      expect(third.stateCount).toBe(1);

      const atT1 = await readAdset("adset_transition", "2026-09-01T12:00:00.000Z");
      expect(new Date(atT1!.adsetStartTime!).toISOString()).toBe(known);
      const atT2 = await readAdset("adset_transition", "2026-09-02T12:00:00.000Z");
      expect(atT2!.adsetStartTime).toBeNull();
      const atT3 = await readAdset("adset_transition", "2026-09-03T12:00:00.000Z");
      // Back to known. The unknown was a state of the world at t2, not a
      // permanent demotion.
      expect(new Date(atT3!.adsetStartTime!).toISOString()).toBe(known);
      // ...and the t1 and t3 rows really are the same state again.
      const firstRow = await storedRow(first.runId, "adset_transition");
      const thirdRow = await storedRow(third.runId, "adset_transition");
      const secondRow = await storedRow(second.runId, "adset_transition");
      expect(thirdRow.state_hash).toBe(firstRow.state_hash);
      expect(secondRow.state_hash).not.toBe(firstRow.state_hash);
      expect(secondRow.adset_start_time).toBeNull();
      // The middle row's hash is the hash of an EXPLICIT UNKNOWN, not the hash
      // of the raw string it arrived as. That is the same row/hash agreement
      // the campaign case proves, on the other column pair.
      expect(secondRow.state_hash).toBe(
        buildMetaEntityStateHash(
          adsetState({
            entityId: "adset_transition",
            observedAt: "2026-09-02T00:00:00.000Z",
            startTime: null,
            coverage: {
              adsetStartTime: META_FIELD_COVERAGE_SCHEDULE_INVALID,
            },
          }),
        ),
      );
    });

    it("stores a state_hash that agrees with the row it is stored beside", async () => {
      /*
        `state_hash` is computed BEFORE the transaction opens, from the same
        object both INSERT sites read the columns out of. So normalization has
        to happen before the hash call or the stored row and the stored hash
        would describe different values — a row saying "unknown" carrying the
        hash of "2026-09-07T10:00:00+0300".

        Proven by rebuilding the hash from what the row actually SAYS: null
        column, invalid marker in coverage. If the writer had hashed the raw
        string these would differ.
      */
      const result = await persistMetaEntityObservation(
        completeObservation({
          entityType: "campaign",
          endpoint: HASH_ENDPOINT,
          observedAt: "2026-09-01T00:00:00.000Z",
          states: [
            campaignState({
              entityId: "campaign_hash_agreement",
              observedAt: "2026-09-01T00:00:00.000Z",
              startTime: "not-a-date",
              endTime: "2026-10-01T00:00:00+0000",
            }),
          ],
        }),
      );
      const stored = await storedRow(result.runId, "campaign_hash_agreement");
      expect(stored.campaign_start_time).toBeNull();
      expect(new Date(stored.campaign_end_time!).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );

      const rowAsStored = campaignState({
        entityId: "campaign_hash_agreement",
        observedAt: "2026-09-01T00:00:00.000Z",
        startTime: null,
        endTime: "2026-10-01T00:00:00.000Z",
        coverage: {
          campaignStartTime: META_FIELD_COVERAGE_SCHEDULE_INVALID,
          campaignEndTime: true,
        },
      });
      expect(stored.state_hash).toBe(buildMetaEntityStateHash(rowAsStored));
    });
  },
);
