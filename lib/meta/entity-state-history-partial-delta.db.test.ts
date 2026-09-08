/**
 * The 2026-09-07 rewrite storm, against a real PostgreSQL.
 *
 * WHAT WAS BROKEN. `persistMetaEntityObservation` delta-bounded only the
 * `complete` lane. Every other lane fell through to `statesToPersist = states`
 * and re-wrote every observed row. Two consequences, both measured read-only on
 * production 2026-09-07 with `meta_entity_state_history` at 6,443,089,920 bytes
 * against the 6 GiB D089 ceiling (638,976 bytes over, admission refused):
 *
 *   1. PARTIAL RETRIES. `receiptCompleteness` in `lib/api/meta.ts` returns
 *      `partial` whenever pagination breaks part-way — and also when pagination
 *      completed but `invalidRowCount > 0`, because it returns `complete` only
 *      for `receipt.complete && invalidRowCount === 0`. A retry breaks at a
 *      different page, so `pageCount`/`rowCount`/`error` differ and the
 *      same-completeness heartbeat cannot coalesce them. 126,500 partial state
 *      rows were written since 2026-09-04 and 126,500 of them carried a
 *      `state_hash` identical to the entity's immediately preceding row. One
 *      `ad_configs` scope wrote 94,500 such rows across 41 partial runs.
 *   2. THE LINEAGE CARRY. `lineageRelevantAdIds` named every ad in
 *      `adCreativeRelationships`, which for an `ad_configs` payload is every ad
 *      carrying a creative, so the complete-lane delta carried the whole scope
 *      back in. All twelve production `ad_configs` delta runs on 2026-09-06 —
 *      one per ad account, twelve accounts, i.e. every run on that endpoint
 *      rather than a streak inside one account — recorded
 *      `changedEntityCount: 0, newEntityCount: 0, exitedEntityCount: 0` beside
 *      `lineageCarriedEntityCount` = `physicalStateRows` = the account's whole
 *      ad scope, up to 3288.
 *
 * WHY REAL POSTGRES. Both defects are decided by what the writer's baseline
 * SELECT returns from rows a previous call actually committed, and by the
 * composite FK that binds `meta_creative_lineage_edges` to state rows BY RUN. A
 * template-SQL mock returns whatever the test author typed, so it can prove
 * neither. Everything below drives the shipped `persistMetaEntityObservation`
 * and reads back through the shipped `readMetaEntityStatesAsOf` and
 * `readMetaObservationWriterPressure`; no query is restated here.
 *
 * THE SAFETY HALF IS TESTED AS HARD AS THE SAVING. A partial page proves what
 * it contains, never what it omits. `does not fabricate absence for entities a
 * partial page omits` and `keeps the complete lane's scope-exit contract
 * intact` fail if the dedupe is ever generalised into the scope-exit contract
 * the complete lane earns. `carries a shared-creative group on a PARTIAL page
 * too` covers the opposite risk in the same branch: the dedupe must not
 * suppress a row an edge is about to FK-reference.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import {
  META_PARTIAL_MANIFEST_CONTRACT,
  persistMetaEntityObservation,
  readMetaEntityStatesAsOf,
  readMetaObservationWriterPressure,
  type MetaEntityObservationStateInput,
} from "@/lib/meta/entity-state-history";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

/** Ids chosen not to collide with any other stage of the seam gate. */
const OWNER_EMAIL = "entity-state-partial-delta@example.invalid";
const ACCOUNT_ID = "act_partial_delta_7001";
const AD_ENDPOINT = "ad_configs_partial_delta";
const ADSET_ENDPOINT = "adset_configs_partial_delta";
const LINEAGE_ENDPOINT = "ad_configs_lineage_carry";
const PARTIAL_LINEAGE_ENDPOINT = "ad_configs_partial_lineage_carry";
/** The equivalence pair: identical complete history, one with a partial run in it. */
const EQUIV_WITH_ENDPOINT = "adset_configs_equivalence_with_partial";
const EQUIV_WITHOUT_ENDPOINT = "adset_configs_equivalence_without_partial";
const RECENCY_ENDPOINT = "adset_configs_partial_recency";
const WINDOW_COALESCED_ENDPOINT = "adset_configs_window_coalesced";
const WINDOW_CROSSING_ENDPOINT = "adset_configs_window_crossing";
const WINDOW_AFTER_UNTIL_ENDPOINT = "adset_configs_window_after_until";

let businessId = "";

async function seed() {
  const sql = getDb();
  const [owner] = await sql<{ id: string }>`
    INSERT INTO users (name, email, password_hash)
    VALUES ('Partial delta seam', ${OWNER_EMAIL}, 'unused')
    RETURNING id
  `;
  if (!owner?.id) throw new Error("Could not create the seam owner.");
  const [business] = await sql<{ id: string }>`
    INSERT INTO businesses (name, owner_id)
    VALUES ('Partial delta seam', ${owner.id})
    RETURNING id
  `;
  if (!business?.id) throw new Error("Could not create the seam business.");
  businessId = business.id;
  const [account] = await sql<{ id: string }>`
    INSERT INTO provider_accounts (provider, external_account_id, account_name)
    VALUES ('meta', ${ACCOUNT_ID}, 'Partial delta seam')
    RETURNING id
  `;
  if (!account?.id) throw new Error("Could not create the seam account.");
  await sql`
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (${businessId}, 'meta', ${account.id}, ${ACCOUNT_ID})
  `;
}

function adsetState(input: {
  entityId: string;
  status: string;
  observedAt: string;
}): MetaEntityObservationStateInput {
  return {
    businessId,
    providerAccountId: ACCOUNT_ID,
    entityType: "adset",
    entityId: input.entityId,
    campaignId: "campaign_partial_delta",
    adsetId: input.entityId,
    adId: null,
    creativeId: null,
    entityName: input.entityId,
    configuredStatus: input.status,
    effectiveStatus: input.status,
    learningSource: "not_observed",
    budgetOrigin: "not_applicable",
    presence: "present",
    fieldCoverage: { configuredStatus: true },
    providerUpdatedAt: "2026-08-10T00:00:00.000Z",
    observedAt: input.observedAt,
  };
}

function adState(input: {
  entityId: string;
  creativeId: string;
  status: string;
  observedAt: string;
}): MetaEntityObservationStateInput {
  return {
    businessId,
    providerAccountId: ACCOUNT_ID,
    entityType: "ad",
    entityId: input.entityId,
    campaignId: "campaign_lineage_carry",
    adsetId: "adset_lineage_carry",
    adId: input.entityId,
    creativeId: input.creativeId,
    entityName: input.entityId,
    configuredStatus: input.status,
    effectiveStatus: input.status,
    learningSource: "not_observed",
    budgetOrigin: "not_applicable",
    presence: "present",
    fieldCoverage: { configuredStatus: true },
    providerUpdatedAt: "2026-08-10T00:00:00.000Z",
    observedAt: input.observedAt,
  };
}

/**
 * A partial receipt exactly as `persistMetaStatusConfigObservation` builds one:
 * the pages that DID arrive, the page count that was reached, and the
 * pagination failure receipt. `pageCount`/`providerRowCount`/`error` are what
 * differ between retries and therefore what defeats the heartbeat.
 */
function partialAdsetObservation(input: {
  observedAt: string;
  capturedAt: string;
  entities: Array<{ id: string; status: string }>;
  pageCount: number;
  endpoint?: string;
}) {
  return {
    businessId,
    providerAccountId: ACCOUNT_ID,
    entityType: "adset" as const,
    endpoint: input.endpoint ?? ADSET_ENDPOINT,
    observedAt: input.observedAt,
    capturedAt: input.capturedAt,
    completeness: "partial" as const,
    pageCount: input.pageCount,
    providerRowCount: input.entities.length,
    states: input.entities.map((entity) =>
      adsetState({
        entityId: entity.id,
        status: entity.status,
        observedAt: input.observedAt,
      }),
    ),
    error: {
      pagination: {
        pageCount: input.pageCount,
        complete: false,
        termination: "http_failure",
        failure: { kind: "http_failure", httpStatus: 400 },
      },
      invalidRowCount: 0,
    },
  };
}

function completeAdsetObservation(input: {
  observedAt: string;
  capturedAt: string;
  entities: Array<{ id: string; status: string }>;
}) {
  return {
    businessId,
    providerAccountId: ACCOUNT_ID,
    entityType: "adset" as const,
    endpoint: ADSET_ENDPOINT,
    observedAt: input.observedAt,
    capturedAt: input.capturedAt,
    completeness: "complete" as const,
    pageCount: 1,
    providerRowCount: input.entities.length,
    states: input.entities.map((entity) =>
      adsetState({
        entityId: entity.id,
        status: entity.status,
        observedAt: input.observedAt,
      }),
    ),
  };
}

async function rowsForRun(runId: string) {
  const sql = getDb();
  return sql<{ entity_id: string; presence: string; state_hash: string }>`
    SELECT entity_id, presence, state_hash
    FROM meta_entity_state_history
    WHERE run_id = ${runId}::uuid
    ORDER BY entity_id
  `;
}

describe.skipIf(!SEAM)("partial-lane delta dedupe (real PostgreSQL)", () => {
  beforeAll(async () => {
    await seed();
  });

  afterAll(async () => {
    // The ephemeral cluster is thrown away by the seam runner; nothing to undo.
  });

  it("writes nothing for partial rows the history already answers with", async () => {
    const base = await persistMetaEntityObservation(
      completeAdsetObservation({
        observedAt: "2026-11-01T00:00:00.000Z",
        capturedAt: "2026-11-01T00:00:01.000Z",
        entities: [
          { id: "as_p1", status: "ACTIVE" },
          { id: "as_p2", status: "ACTIVE" },
          { id: "as_p3", status: "ACTIVE" },
        ],
      }),
    );
    expect(base.manifestKind).toBe("full");
    expect(base.stateCount).toBe(3);

    // The same three ad sets arrive again on a page-1-only partial receipt.
    // Every row restates content the complete run already carries.
    const partial = await persistMetaEntityObservation(
      partialAdsetObservation({
        observedAt: "2026-11-01T01:00:00.000Z",
        capturedAt: "2026-11-01T01:00:01.000Z",
        pageCount: 1,
        entities: [
          { id: "as_p1", status: "ACTIVE" },
          { id: "as_p2", status: "ACTIVE" },
          { id: "as_p3", status: "ACTIVE" },
        ],
      }),
    );
    expect(partial.coalesced).toBe(false);
    expect(partial.stateCount).toBe(0);
    expect(await rowsForRun(partial.runId)).toHaveLength(0);
    // The lane keeps its legacy classification: 'delta' is a complete-lane word
    // that switches manifest-reconstruction arms in three readers.
    expect(partial.manifestKind).toBeNull();
    expect(partial.deltaStats).toMatchObject({
      logicalEntityCount: 3,
      changedEntityCount: 0,
      newEntityCount: 0,
      exitedEntityCount: 0,
      physicalStateRows: 0,
    });
  });

  it("survives a retry storm without appending a copy per attempt", async () => {
    // Three retries of the SAME truth that each break at a different page, so
    // each carries a different run identity and none of them can coalesce.
    const entities = [
      { id: "as_p1", status: "ACTIVE" },
      { id: "as_p2", status: "ACTIVE" },
      { id: "as_p3", status: "ACTIVE" },
    ];
    const retries = [];
    for (const [index, pageCount] of [2, 3, 4].entries()) {
      retries.push(
        await persistMetaEntityObservation(
          partialAdsetObservation({
            observedAt: `2026-11-01T0${2 + index}:00:00.000Z`,
            capturedAt: `2026-11-01T0${2 + index}:00:01.000Z`,
            pageCount,
            entities,
          }),
        ),
      );
    }
    expect(retries.map((retry) => retry.coalesced)).toEqual([
      false,
      false,
      false,
    ]);
    expect(retries.map((retry) => retry.stateCount)).toEqual([0, 0, 0]);
  });

  it("records a real change seen on a partial page", async () => {
    const changed = await persistMetaEntityObservation(
      partialAdsetObservation({
        observedAt: "2026-11-01T06:00:00.000Z",
        capturedAt: "2026-11-01T06:00:01.000Z",
        pageCount: 1,
        entities: [
          { id: "as_p1", status: "ACTIVE" },
          { id: "as_p2", status: "PAUSED" },
        ],
      }),
    );
    expect(changed.stateCount).toBe(1);
    expect((await rowsForRun(changed.runId)).map((row) => row.entity_id)).toEqual(
      ["as_p2"],
    );
    const states = await readMetaEntityStatesAsOf({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "adset",
      entityIds: ["as_p1", "as_p2", "as_p3"],
      cutoff: "2026-11-01T07:00:00.000Z",
    });
    expect(
      Object.fromEntries(
        states.map((state) => [state.entityId, state.configuredStatus]),
      ),
    ).toEqual({ as_p1: "ACTIVE", as_p2: "PAUSED", as_p3: "ACTIVE" });
  });

  it("records an entity a partial page sees for the first time", async () => {
    const seenFirst = await persistMetaEntityObservation(
      partialAdsetObservation({
        observedAt: "2026-11-01T08:00:00.000Z",
        capturedAt: "2026-11-01T08:00:01.000Z",
        pageCount: 1,
        entities: [
          { id: "as_p1", status: "ACTIVE" },
          { id: "as_p4", status: "ACTIVE" },
        ],
      }),
    );
    expect(seenFirst.stateCount).toBe(1);
    expect(seenFirst.deltaStats).toMatchObject({
      newEntityCount: 1,
      changedEntityCount: 0,
      exitedEntityCount: 0,
    });
  });

  it("does not fabricate absence for entities a partial page omits", async () => {
    // as_p3 is present in history and simply not on this page. A partial page
    // proves what it contains, never what it omits.
    const omitting = await persistMetaEntityObservation(
      partialAdsetObservation({
        observedAt: "2026-11-01T10:00:00.000Z",
        capturedAt: "2026-11-01T10:00:01.000Z",
        pageCount: 1,
        entities: [{ id: "as_p1", status: "ACTIVE" }],
      }),
    );
    expect(omitting.stateCount).toBe(0);
    expect(omitting.deltaStats).toMatchObject({ exitedEntityCount: 0 });

    const sql = getDb();
    const absent = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count
      FROM meta_entity_state_history
      WHERE business_id = ${businessId}
        AND provider_account_id = ${ACCOUNT_ID}
        AND entity_type = 'adset'
        AND presence = 'absent_unconfirmed'
    `;
    expect(absent[0]?.count).toBe("0");

    const states = await readMetaEntityStatesAsOf({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "adset",
      entityIds: ["as_p3"],
      cutoff: "2026-11-01T11:00:00.000Z",
    });
    expect(states).toHaveLength(1);
    expect(states[0]?.presence).toBe("present");
    expect(states[0]?.configuredStatus).toBe("ACTIVE");
  });

  it("keeps the complete lane's scope-exit contract intact", async () => {
    // The suppressed partial rows must not have disturbed the complete lane's
    // baseline: a genuine complete shrink still writes exactly the exit row.
    const shrink = await persistMetaEntityObservation(
      completeAdsetObservation({
        observedAt: "2026-11-01T12:00:00.000Z",
        capturedAt: "2026-11-01T12:00:01.000Z",
        entities: [
          { id: "as_p1", status: "ACTIVE" },
          { id: "as_p2", status: "PAUSED" },
          { id: "as_p4", status: "ACTIVE" },
        ],
      }),
    );
    expect(shrink.manifestKind).toBe("delta");
    expect(shrink.deltaStats).toMatchObject({ exitedEntityCount: 1 });
    const rows = await rowsForRun(shrink.runId);
    const exited = rows.find((row) => row.entity_id === "as_p3");
    expect(exited?.presence).toBe("absent_unconfirmed");
  });
});

describe.skipIf(!SEAM)("lineage carry narrowing (real PostgreSQL)", () => {
  beforeAll(async () => {
    if (!businessId) await seed();
  });

  it("carries no unchanged ad when no creative is shared", async () => {
    const observation = (input: {
      observedAt: string;
      capturedAt: string;
      statuses: Record<string, string>;
      withRelationships: boolean;
    }) => ({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "ad" as const,
      endpoint: LINEAGE_ENDPOINT,
      observedAt: input.observedAt,
      capturedAt: input.capturedAt,
      completeness: "complete" as const,
      pageCount: 1,
      providerRowCount: 3,
      states: Object.entries(input.statuses).map(([adId, status]) =>
        adState({
          entityId: adId,
          // One ad per creative: no group of two, so no observation_run edge
          // is derivable and no ad needs a durable row for one.
          creativeId: `creative_solo_${adId}`,
          status,
          observedAt: input.observedAt,
        }),
      ),
      ...(input.withRelationships
        ? {
            adCreativeRelationships: Object.keys(input.statuses).map((adId) => ({
              adId,
              creativeId: `creative_solo_${adId}`,
              providerCreatedAt: "2026-06-01T00:00:00.000Z",
            })),
          }
        : {}),
    });

    const full = await persistMetaEntityObservation(
      observation({
        observedAt: "2026-11-02T00:00:00.000Z",
        capturedAt: "2026-11-02T00:00:01.000Z",
        statuses: { ad_solo_1: "ACTIVE", ad_solo_2: "ACTIVE", ad_solo_3: "ACTIVE" },
        withRelationships: true,
      }),
    );
    expect(full.manifestKind).toBe("full");
    expect(full.stateCount).toBe(3);

    // One ad changes. The pre-fix carry named all three and rewrote the scope.
    const delta = await persistMetaEntityObservation(
      observation({
        observedAt: "2026-11-02T01:00:00.000Z",
        capturedAt: "2026-11-02T01:00:01.000Z",
        statuses: { ad_solo_1: "ACTIVE", ad_solo_2: "PAUSED", ad_solo_3: "ACTIVE" },
        withRelationships: true,
      }),
    );
    expect(delta.manifestKind).toBe("delta");
    expect(delta.deltaStats).toMatchObject({
      logicalEntityCount: 3,
      changedEntityCount: 1,
      lineageCarriedEntityCount: 0,
      physicalStateRows: 1,
    });
    expect(delta.stateCount).toBe(1);
  });

  it("still carries a shared-creative group so its edge can attach", async () => {
    const shared = (input: {
      observedAt: string;
      capturedAt: string;
      secondStatus: string;
      withRelationships: boolean;
    }) => ({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "ad" as const,
      endpoint: AD_ENDPOINT,
      observedAt: input.observedAt,
      capturedAt: input.capturedAt,
      completeness: "complete" as const,
      pageCount: 1,
      providerRowCount: 3,
      states: [
        adState({
          entityId: "ad_share_1",
          creativeId: "creative_shared",
          status: "ACTIVE",
          observedAt: input.observedAt,
        }),
        adState({
          entityId: "ad_share_2",
          creativeId: "creative_shared",
          status: "ACTIVE",
          observedAt: input.observedAt,
        }),
        adState({
          entityId: "ad_share_3",
          creativeId: "creative_lonely",
          status: input.secondStatus,
          observedAt: input.observedAt,
        }),
      ],
      ...(input.withRelationships
        ? {
            adCreativeRelationships: [
              {
                adId: "ad_share_1",
                creativeId: "creative_shared",
                providerCreatedAt: "2026-06-01T00:00:00.000Z",
              },
              {
                adId: "ad_share_2",
                creativeId: "creative_shared",
                providerCreatedAt: "2026-06-02T00:00:00.000Z",
              },
              {
                adId: "ad_share_3",
                creativeId: "creative_lonely",
                providerCreatedAt: "2026-06-03T00:00:00.000Z",
              },
            ],
          }
        : {}),
    });

    await persistMetaEntityObservation(
      shared({
        observedAt: "2026-11-03T00:00:00.000Z",
        capturedAt: "2026-11-03T00:00:01.000Z",
        secondStatus: "ACTIVE",
        withRelationships: false,
      }),
    );
    // ad_share_3 changes; ad_share_1 and ad_share_2 do not. The shared pair
    // must still land in this run or the edge below has no row to reference.
    const delta = await persistMetaEntityObservation(
      shared({
        observedAt: "2026-11-03T01:00:00.000Z",
        capturedAt: "2026-11-03T01:00:01.000Z",
        secondStatus: "PAUSED",
        withRelationships: true,
      }),
    );
    expect(delta.manifestKind).toBe("delta");
    expect(delta.deltaStats).toMatchObject({
      changedEntityCount: 1,
      // ad_share_1 + ad_share_2, and NOT the lone-creative ad_share_3, which is
      // in the run because it changed rather than because it was carried.
      lineageCarriedEntityCount: 2,
      physicalStateRows: 3,
    });
    const sql = getDb();
    const [edges] = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count
      FROM meta_creative_lineage_edges
      WHERE business_id = ${businessId}
        AND provider_account_id = ${ACCOUNT_ID}
        AND source_creative_id = 'creative_shared'
        AND observation_run_id = ${delta.runId}::uuid
    `;
    expect(Number(edges?.count)).toBe(1);
  });

  it("carries a shared-creative group on a PARTIAL page too", async () => {
    /*
      The partial lane has its OWN lineage carry, and it is the arm that can
      suppress the very rows an edge needs.

      `meta_creative_lineage_edges` FK-references state rows BY RUN
      (run_id, entity_type, ad_id, creative_id), and the partial dedupe removes
      the write for every entity whose `state_hash` the history already
      answers with. On a partial page where nothing changed that is EVERY row.
      `persistMetaObservationLineage` is handed `statesToPersist` precisely
      because of that FK, so with no carry the shared pair is not among the
      rows it may build an edge from and the edge is not refused — it is never
      derived. MEASURED, by deleting the carry from the partial branch and
      re-running this file against a fresh cluster: `lineageCount: 0`,
      `stateCount: 0`, no error anywhere. That is the H8 shape the complete
      lane's carry already exists to prevent, and on this lane the "next
      appending observation" that would recover it may never come, because
      every dedupe-clean retry writes nothing.

      Every other lineage assertion in this file drives
      `completeness: "complete"`, which exercises a different block of the
      writer, so this arm ran in no test at all.

      The shape asserted is the partial lane's, not the complete lane's: no
      entity changed, so the two rows this run holds are there ONLY because
      the shared-creative group was carried in, and `manifestKind` stays NULL
      because 'delta' is a complete-lane word.
    */
    const sharedPartial = (input: {
      observedAt: string;
      capturedAt: string;
      pageCount: number;
      withRelationships: boolean;
    }) => ({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "ad" as const,
      endpoint: PARTIAL_LINEAGE_ENDPOINT,
      observedAt: input.observedAt,
      capturedAt: input.capturedAt,
      completeness: "partial" as const,
      pageCount: input.pageCount,
      providerRowCount: 3,
      states: [
        adState({
          entityId: "ad_pshare_1",
          creativeId: "creative_partial_shared",
          status: "ACTIVE",
          observedAt: input.observedAt,
        }),
        adState({
          entityId: "ad_pshare_2",
          creativeId: "creative_partial_shared",
          status: "ACTIVE",
          observedAt: input.observedAt,
        }),
        adState({
          entityId: "ad_pshare_3",
          creativeId: "creative_partial_lonely",
          status: "ACTIVE",
          observedAt: input.observedAt,
        }),
      ],
      ...(input.withRelationships
        ? {
            adCreativeRelationships: [
              {
                adId: "ad_pshare_1",
                creativeId: "creative_partial_shared",
                providerCreatedAt: "2026-06-01T00:00:00.000Z",
              },
              {
                adId: "ad_pshare_2",
                creativeId: "creative_partial_shared",
                providerCreatedAt: "2026-06-02T00:00:00.000Z",
              },
              {
                adId: "ad_pshare_3",
                creativeId: "creative_partial_lonely",
                providerCreatedAt: "2026-06-03T00:00:00.000Z",
              },
            ],
          }
        : {}),
      error: {
        pagination: {
          pageCount: input.pageCount,
          complete: false,
          termination: "http_failure",
          failure: { kind: "http_failure", httpStatus: 400 },
        },
        invalidRowCount: 0,
      },
    });

    const first = await persistMetaEntityObservation(
      sharedPartial({
        observedAt: "2026-11-05T00:00:00.000Z",
        capturedAt: "2026-11-05T00:00:01.000Z",
        pageCount: 1,
        withRelationships: false,
      }),
    );
    expect(first.stateCount).toBe(3);

    // A retry that breaks at a different page, so the run identity differs and
    // the heartbeat cannot coalesce it. Nothing about the three ads changed;
    // the relationships are what is new.
    const retry = await persistMetaEntityObservation(
      sharedPartial({
        observedAt: "2026-11-05T01:00:00.000Z",
        capturedAt: "2026-11-05T01:00:01.000Z",
        pageCount: 2,
        withRelationships: true,
      }),
    );
    expect(retry.coalesced).toBe(false);
    expect(retry.manifestKind).toBeNull();
    expect(retry.deltaStats).toMatchObject({
      logicalEntityCount: 3,
      changedEntityCount: 0,
      newEntityCount: 0,
      // Structurally zero on this lane, whatever else the run does.
      exitedEntityCount: 0,
      // ad_pshare_1 + ad_pshare_2 only: the lone-creative ad_pshare_3 can
      // produce no `observation_run` edge, so it needs no row here.
      lineageCarriedEntityCount: 2,
      physicalStateRows: 2,
    });
    expect(retry.stateCount).toBe(2);
    expect((await rowsForRun(retry.runId)).map((row) => row.entity_id)).toEqual([
      "ad_pshare_1",
      "ad_pshare_2",
    ]);
    expect(retry.lineageCount).toBe(1);

    const sql = getDb();
    const [edges] = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count
      FROM meta_creative_lineage_edges
      WHERE business_id = ${businessId}
        AND provider_account_id = ${ACCOUNT_ID}
        AND source_creative_id = 'creative_partial_shared'
        AND observation_run_id = ${retry.runId}::uuid
    `;
    expect(Number(edges?.count)).toBe(1);
  });
});

describe.skipIf(!SEAM)("writer-pressure readback (real PostgreSQL)", () => {
  beforeAll(async () => {
    if (!businessId) await seed();
  });

  it("separates 'nothing attempted' from 'attempted and refused' from 'wrote'", async () => {
    // A lane that was attempted and refused by the provider: a failed receipt
    // carries an error and writes no state at all. This is the shape the
    // campaign_configs writer has been in on production since 2026-09-04.
    await persistMetaEntityObservation({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "campaign",
      endpoint: "campaign_configs_partial_delta",
      observedAt: "2026-11-04T00:00:00.000Z",
      capturedAt: "2026-11-04T00:00:01.000Z",
      completeness: "failed",
      pageCount: 0,
      providerRowCount: 0,
      states: [],
      error: {
        pagination: {
          pageCount: 0,
          complete: false,
          termination: "http_failure",
          failure: { kind: "http_failure", httpStatus: 400 },
        },
        invalidRowCount: 0,
      },
    });

    const pressure = await readMetaObservationWriterPressure({
      since: "2026-11-01T00:00:00.000Z",
      businessIds: [businessId],
    });
    const byLane = new Map(
      pressure.map((row) => [`${row.endpoint}:${row.completeness}`, row]),
    );

    const refused = byLane.get("campaign_configs_partial_delta:failed");
    expect(refused).toBeDefined();
    expect(refused?.runsWithError).toBe(1);
    expect(refused?.physicalStateRows).toBe(0);
    expect(refused?.lastStateCapturedAt).toBeNull();
    expect(refused?.lastErrorKind).toBe("http_failure");
    expect(refused?.lastErrorHttpStatus).toBe(400);
    // No complete campaign lane exists at all: nothing succeeded, so nothing to
    // report. Absence of a row is the "no successful capture" fact.
    expect(byLane.has("campaign_configs_partial_delta:complete")).toBe(false);

    const wrote = byLane.get(`${ADSET_ENDPOINT}:complete`);
    expect(wrote).toBeDefined();
    expect(wrote?.physicalStateRows).toBeGreaterThan(0);
    expect(wrote?.lastStateCapturedAt).not.toBeNull();
    expect(wrote?.runsWithError).toBe(0);

    // The partial lane is the one this change exists for: many appended runs,
    // a real provider error on each, and (after the dedupe) far fewer physical
    // rows than the logical entity count those runs observed.
    const deduped = byLane.get(`${ADSET_ENDPOINT}:partial`);
    expect(deduped).toBeDefined();
    expect(deduped?.runsAppended).toBeGreaterThan(1);
    expect(deduped?.deltaLogicalEntityCount).not.toBeNull();
    expect(deduped?.physicalStateRows).toBeLessThan(
      deduped?.deltaLogicalEntityCount ?? 0,
    );
  });

  it("refuses an empty business scope rather than silently going global", async () => {
    await expect(
      readMetaObservationWriterPressure({
        since: "2026-11-01T00:00:00.000Z",
        businessIds: [],
      }),
    ).rejects.toThrow("businessIds must be null or a non-empty list.");
  });
});

/**
 * A generic ad-set observation, so a case can vary the one axis it is about
 * (endpoint, lane, receipt shape, capture cohort) without restating the rest.
 */
function adsetObservation(input: {
  endpoint: string;
  completeness: "complete" | "partial";
  observedAt: string;
  capturedAt: string;
  entities: Array<{ id: string; status: string }>;
  pageCount?: number;
  error?: Record<string, unknown> | null;
  captureReceipt?: { partitionId: string } | null;
}) {
  return {
    businessId,
    providerAccountId: ACCOUNT_ID,
    entityType: "adset" as const,
    endpoint: input.endpoint,
    observedAt: input.observedAt,
    capturedAt: input.capturedAt,
    completeness: input.completeness,
    pageCount: input.pageCount ?? 1,
    providerRowCount: input.entities.length,
    states: input.entities.map((entity) =>
      adsetState({
        entityId: entity.id,
        status: entity.status,
        observedAt: input.observedAt,
      }),
    ),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.captureReceipt
      ? {
          captureReceipt: {
            partitionId: input.captureReceipt.partitionId,
            sourceSnapshotId: null,
            sourceSnapshotRefId: null,
          },
        }
      : {}),
  };
}

/**
 * A pagination receipt whose CLASSIFICATION is fixed and whose REQUEST identity
 * varies — the exact pair the semantic hash had to stop distinguishing. Every
 * field here is one `lib/api/meta.ts` actually emits: `paginationReceiptContext`
 * passes `receipt.failure` through whole, and that object carries `message`,
 * `pageUrl`, `attempts` and `fbtraceId` beside the classification.
 */
function partialFailureReceipt(input: {
  pageCount: number;
  fbtraceId: string;
  pageUrl: string;
  attempts: number;
  message: string;
  httpStatus?: number;
}) {
  return {
    pagination: {
      pageCount: input.pageCount,
      complete: false,
      termination: "http_failure",
      failure: {
        kind: "http_failure",
        message: input.message,
        pageIndex: input.pageCount,
        pageUrl: input.pageUrl,
        httpStatus: input.httpStatus ?? 400,
        errorCode: 100,
        errorSubcode: 33,
        isTransient: false,
        fbtraceId: input.fbtraceId,
        attempts: input.attempts,
      },
      fieldDegradation: null,
    },
    invalidRowCount: 0,
  };
}

/** A real sync partition, because the receipt's partition FK is enforced. */
async function createPartition(scope: string, partitionDate: string) {
  const sql = getDb();
  const [partition] = await sql<{ id: string }>`
    INSERT INTO meta_sync_partitions (
      business_id, provider_account_id, lane, scope, partition_date, status
    )
    VALUES (
      ${businessId}, ${ACCOUNT_ID}, 'core', ${scope}, ${partitionDate}::date,
      'succeeded'
    )
    RETURNING id::text AS id
  `;
  if (!partition?.id) throw new Error("Could not create the seam partition.");
  return partition.id;
}

/** Every stored row for a set of ad-set entities, in the D075 winner order. */
async function storedAdsetRows(entityIds: string[]) {
  const sql = getDb();
  return sql<{
    entity_id: string;
    presence: string;
    configured_status: string | null;
    observed_at: string;
    captured_at: string;
  }>`
    SELECT entity_id, presence, configured_status,
           observed_at::text AS observed_at, captured_at::text AS captured_at
    FROM meta_entity_state_history
    WHERE business_id = ${businessId}
      AND provider_account_id = ${ACCOUNT_ID}
      AND entity_type = 'adset'
      AND entity_id = ANY(${entityIds}::text[])
    ORDER BY entity_id, observed_at, captured_at, created_at, id
  `;
}

async function runRow(runId: string) {
  const sql = getDb();
  const [row] = await sql<{
    captured_at: string;
    last_seen_at: string | null;
    last_captured_at: string | null;
    repeat_count: number | string;
    manifest_kind: string | null;
    row_count: number | string;
    delta_stats_json: Record<string, unknown> | null;
  }>`
    SELECT captured_at::text AS captured_at,
           last_seen_at::text AS last_seen_at,
           last_captured_at::text AS last_captured_at,
           repeat_count, manifest_kind, row_count, delta_stats_json
    FROM meta_entity_observation_runs
    WHERE id = ${runId}::uuid
  `;
  return row;
}

describe.skipIf(!SEAM)(
  "partial runs are transparent to a timeline read (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      if (!businessId) await seed();
    });

    /*
      AS-OF / TIMELINE EQUIVALENCE, exercised rather than argued.

      Two scopes receive the IDENTICAL pair of complete observations. One of
      them additionally receives a partial observation between them that
      positively re-observes both entities and changes nothing. The claim under
      test is that the partial run is invisible to a reader: the same answers at
      every cutoff, the same per-entity transition sequence, and — the clause
      that fails without the dedupe — the same number of stored rows.

      Two scopes rather than one replayed scope, because `readMetaEntityStatesAsOf`
      is endpoint-blind: it resolves winners across every endpoint of the
      account, so the control has to be different ENTITIES, not merely a
      different endpoint.
    */
    const WITH_IDS = ["eq_w_1", "eq_w_2"];
    const WITHOUT_IDS = ["eq_n_1", "eq_n_2"];
    const T1 = "2026-12-01T00:00:00.000Z";
    const T1_CAP = "2026-12-01T00:00:01.000Z";
    const T2 = "2026-12-01T01:00:00.000Z";
    const T2_CAP = "2026-12-01T01:00:01.000Z";
    const T3 = "2026-12-01T02:00:00.000Z";
    const T3_CAP = "2026-12-01T02:00:01.000Z";
    const CUTOFFS = [
      "2026-11-30T23:00:00.000Z",
      "2026-12-01T00:30:00.000Z",
      "2026-12-01T01:30:00.000Z",
      "2026-12-01T03:00:00.000Z",
    ];

    it("answers a timeline across a partial run exactly as it would without one", async () => {
      const withFirst = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: EQUIV_WITH_ENDPOINT,
          completeness: "complete",
          observedAt: T1,
          capturedAt: T1_CAP,
          entities: [
            { id: WITH_IDS[0]!, status: "ACTIVE" },
            { id: WITH_IDS[1]!, status: "ACTIVE" },
          ],
        }),
      );
      const withoutFirst = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: EQUIV_WITHOUT_ENDPOINT,
          completeness: "complete",
          observedAt: T1,
          capturedAt: T1_CAP,
          entities: [
            { id: WITHOUT_IDS[0]!, status: "ACTIVE" },
            { id: WITHOUT_IDS[1]!, status: "ACTIVE" },
          ],
        }),
      );
      expect(withFirst.stateCount).toBe(2);
      expect(withoutFirst.stateCount).toBe(2);

      // ONLY the first scope sees a partial observation, and it carries no new
      // truth at all: both entities, both unchanged.
      const interleaved = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: EQUIV_WITH_ENDPOINT,
          completeness: "partial",
          observedAt: T2,
          capturedAt: T2_CAP,
          entities: [
            { id: WITH_IDS[0]!, status: "ACTIVE" },
            { id: WITH_IDS[1]!, status: "ACTIVE" },
          ],
          error: partialFailureReceipt({
            pageCount: 1,
            fbtraceId: "Aequivalence1",
            pageUrl: "https://graph.facebook.com/v25.0/act_x/adsets?after=eq1",
            attempts: 1,
            message: "page 2 refused",
          }),
        }),
      );
      expect(interleaved.stateCount).toBe(0);
      expect(interleaved.manifestKind).toBeNull();
      // The discriminator, read back as a VALUE rather than inferred from the
      // NULL manifest kind that legacy full-payload runs also carry.
      expect(interleaved.deltaStats?.manifestContract).toBe(
        META_PARTIAL_MANIFEST_CONTRACT,
      );

      const withSecond = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: EQUIV_WITH_ENDPOINT,
          completeness: "complete",
          observedAt: T3,
          capturedAt: T3_CAP,
          entities: [
            { id: WITH_IDS[0]!, status: "PAUSED" },
            { id: WITH_IDS[1]!, status: "ACTIVE" },
          ],
        }),
      );
      const withoutSecond = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: EQUIV_WITHOUT_ENDPOINT,
          completeness: "complete",
          observedAt: T3,
          capturedAt: T3_CAP,
          entities: [
            { id: WITHOUT_IDS[0]!, status: "PAUSED" },
            { id: WITHOUT_IDS[1]!, status: "ACTIVE" },
          ],
        }),
      );
      expect(withSecond.stateCount).toBe(1);
      expect(withoutSecond.stateCount).toBe(1);

      // 1. Same answers, cutoff by cutoff.
      for (const cutoff of CUTOFFS) {
        const read = async (entityIds: string[]) => {
          const states = await readMetaEntityStatesAsOf({
            businessId,
            providerAccountId: ACCOUNT_ID,
            entityType: "adset",
            entityIds,
            cutoff,
          });
          const byId = new Map(states.map((state) => [state.entityId, state]));
          return entityIds.map((entityId) => {
            const state = byId.get(entityId);
            return state
              ? { presence: state.presence, status: state.configuredStatus }
              : null;
          });
        };
        expect(await read(WITH_IDS)).toEqual(await read(WITHOUT_IDS));
      }

      // 2. Same per-entity transition sequence. Consecutive duplicates are
      //    collapsed, which is what makes this a TIMELINE comparison rather
      //    than a row comparison — a reader that re-emitted an unchanged row
      //    would fail (1) instead.
      const transitions = async (entityIds: string[]) => {
        const rows = await storedAdsetRows(entityIds);
        const byIndex = new Map(entityIds.map((id, index) => [id, index]));
        const out: Array<[number, string, string | null]> = [];
        for (const row of rows) {
          const key: [number, string, string | null] = [
            byIndex.get(row.entity_id)!,
            row.presence,
            row.configured_status,
          ];
          const previous = out.filter((entry) => entry[0] === key[0]).at(-1);
          if (
            previous &&
            previous[1] === key[1] &&
            previous[2] === key[2]
          ) {
            continue;
          }
          out.push(key);
        }
        return out;
      };
      expect(await transitions(WITH_IDS)).toEqual(
        await transitions(WITHOUT_IDS),
      );

      // 3. And it cost nothing. This is the clause the pre-dedupe writer fails:
      //    it stored two extra rows in the WITH scope whose content the
      //    history already answered with.
      const withRows = await storedAdsetRows(WITH_IDS);
      const withoutRows = await storedAdsetRows(WITHOUT_IDS);
      expect(withRows).toHaveLength(withoutRows.length);
      expect(withRows).toHaveLength(3);
    });
  },
);

describe.skipIf(!SEAM)(
  "positive re-observation advances recency (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      if (!businessId) await seed();
    });

    /*
      THE PROVENANCE CLOCK, exercised.

      A partial re-observation that finds nothing changed writes no state row,
      so the entity's own row keeps its original clocks — history is append-only
      and must not be rewritten. The question that leaves open is whether
      anything advances at all, or whether a re-observed entity simply freezes
      at its first sighting.

      What advances is the RUN, and it only can because the semantic hash stopped
      carrying request identity. `receipt.failure` differs on every attempt —
      `fbtraceId` is Meta's per-request trace id — so under the v1 hash two
      identical partial truths were two distinct observations, each appending its
      own run and freezing the previous one's clocks. Under v2 they are one run
      whose `last_seen_at`, `last_captured_at` and `repeat_count` move.
    */
    const RECENCY_IDS = ["rc_1", "rc_2"];
    const FIRST_OBSERVED = "2026-12-02T00:00:00.000Z";
    const FIRST_CAPTURED = "2026-12-02T00:00:01.000Z";
    const SECOND_OBSERVED = "2026-12-02T00:20:00.000Z";
    const SECOND_CAPTURED = "2026-12-02T00:20:01.000Z";

    it("advances the run clocks for an unchanged partial re-observation instead of freezing them", async () => {
      const entities = [
        { id: RECENCY_IDS[0]!, status: "ACTIVE" },
        { id: RECENCY_IDS[1]!, status: "ACTIVE" },
      ];
      const first = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: RECENCY_ENDPOINT,
          completeness: "partial",
          observedAt: FIRST_OBSERVED,
          capturedAt: FIRST_CAPTURED,
          entities,
          pageCount: 3,
          error: partialFailureReceipt({
            pageCount: 3,
            fbtraceId: "AZm1firsttrace",
            pageUrl: "https://graph.facebook.com/v25.0/act_x/adsets?after=one",
            attempts: 1,
            message: "(#100) page 4 refused for request one",
          }),
        }),
      );
      expect(first.coalesced).toBe(false);
      expect(first.stateCount).toBe(2);

      // The same truth, the same failure, a different REQUEST: a new trace id,
      // a new cursor, a different retry count, different free text.
      const second = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: RECENCY_ENDPOINT,
          completeness: "partial",
          observedAt: SECOND_OBSERVED,
          capturedAt: SECOND_CAPTURED,
          entities,
          pageCount: 3,
          error: partialFailureReceipt({
            pageCount: 3,
            fbtraceId: "BZm2secondtrace",
            pageUrl: "https://graph.facebook.com/v25.0/act_x/adsets?after=two",
            attempts: 4,
            message: "(#100) page 4 refused for request two",
          }),
        }),
      );
      expect(second.coalesced).toBe(true);
      expect(second.runId).toBe(first.runId);
      expect(second.repeatCount).toBe(2);
      expect(second.semanticHash).toBe(first.semanticHash);

      // Recency ADVANCED: the run that carries these rows now says it was last
      // seen and last captured at the second observation's clocks.
      const kept = await runRow(first.runId);
      expect(kept?.last_seen_at).not.toBeNull();
      expect(new Date(kept!.last_seen_at!).toISOString()).toBe(SECOND_OBSERVED);
      expect(new Date(kept!.last_captured_at!).toISOString()).toBe(
        SECOND_CAPTURED,
      );
      // And the payload clocks did NOT move — history is not rewritten.
      expect(new Date(kept!.captured_at).toISOString()).toBe(FIRST_CAPTURED);
      const rows = await storedAdsetRows(RECENCY_IDS);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(new Date(row.observed_at).toISOString()).toBe(FIRST_OBSERVED);
      }
    });

    it("still refuses to coalesce two DIFFERENT failures", async () => {
      // The guard against over-correcting. Only request identity was removed
      // from the semantic hash; the failure classification is truth and a 500
      // is not a 400. If this ever coalesces, a lane's real failure history has
      // been collapsed into whichever shape happened to arrive first.
      const entities = [
        { id: RECENCY_IDS[0]!, status: "ACTIVE" },
        { id: RECENCY_IDS[1]!, status: "ACTIVE" },
      ];
      const differentFailure = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: RECENCY_ENDPOINT,
          completeness: "partial",
          observedAt: "2026-12-02T00:40:00.000Z",
          capturedAt: "2026-12-02T00:40:01.000Z",
          entities,
          pageCount: 3,
          error: partialFailureReceipt({
            pageCount: 3,
            fbtraceId: "CZm3thirdtrace",
            pageUrl: "https://graph.facebook.com/v25.0/act_x/adsets?after=three",
            attempts: 1,
            message: "(#100) page 4 refused for request three",
            httpStatus: 500,
          }),
        }),
      );
      expect(differentFailure.coalesced).toBe(false);
      // It is a new run, and the dedupe still suppressed every row, because the
      // entity truth it carried is the truth the history already answers with.
      expect(differentFailure.stateCount).toBe(0);
      expect(await storedAdsetRows(RECENCY_IDS)).toHaveLength(2);
    });
  },
);

describe.skipIf(!SEAM)(
  "writer-pressure window boundaries (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      if (!businessId) await seed();
    });

    /*
      THE WINDOW HAD TO MEAN SOMETHING.

      `readMetaObservationWriterPressure` filters runs on `captured_at`, which
      is a run's FIRST capture. A run is coalesced content, so its
      `repeat_count` and heartbeat keep moving afterwards: summing them off
      window-selected rows produced a number that was neither the window's nor
      the lifetime's. Both directions are exercised below against real rows.
    */

    it("counts a re-observation inside the window whose run was appended before it", async () => {
      const partitionBefore = await createPartition(
        "configs_window_before",
        "2026-12-03",
      );
      const partitionInside = await createPartition(
        "configs_window_inside",
        "2026-12-03",
      );
      const entities = [{ id: "wc_1", status: "ACTIVE" }];
      const appended = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: WINDOW_COALESCED_ENDPOINT,
          completeness: "complete",
          observedAt: "2026-12-03T00:00:00.000Z",
          capturedAt: "2026-12-03T00:00:01.000Z",
          entities,
          captureReceipt: { partitionId: partitionBefore },
        }),
      );
      expect(appended.coalesced).toBe(false);

      // The same truth again, INSIDE the window. It coalesces, so the run row
      // still carries its original `captured_at` from before the window.
      const reObserved = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: WINDOW_COALESCED_ENDPOINT,
          completeness: "complete",
          observedAt: "2026-12-03T06:00:00.000Z",
          capturedAt: "2026-12-03T06:00:01.000Z",
          entities,
          captureReceipt: { partitionId: partitionInside },
        }),
      );
      expect(reObserved.coalesced).toBe(true);
      expect(reObserved.runId).toBe(appended.runId);

      const pressure = await readMetaObservationWriterPressure({
        since: "2026-12-03T03:00:00.000Z",
        until: "2026-12-03T12:00:00.000Z",
        businessIds: [businessId],
      });
      const lane = pressure.find(
        (row) =>
          row.endpoint === WINDOW_COALESCED_ENDPOINT &&
          row.completeness === "complete",
      );
      // Before the receipt join this lane produced NO row at all, and "no row"
      // is the instrument's word for "nothing was attempted" — the opposite of
      // what happened.
      expect(lane).toBeDefined();
      expect(lane?.runsAppended).toBe(0);
      expect(lane?.lifetimeOccurrencesOfWindowRuns).toBe(0);
      expect(lane?.windowOccurrences).toBe(1);
      expect(lane?.firstWindowOccurrenceAt).not.toBeNull();
      expect(
        new Date(lane!.lastWindowOccurrenceAt!).toISOString(),
      ).toBe("2026-12-03T06:00:01.000Z");
    });

    it("keeps occurrences after the window's until out of the window number", async () => {
      const partitionInside = await createPartition(
        "configs_window_in",
        "2026-12-04",
      );
      const partitionAfter = await createPartition(
        "configs_window_after",
        "2026-12-04",
      );
      const entities = [{ id: "wa_1", status: "ACTIVE" }];
      const appended = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: WINDOW_CROSSING_ENDPOINT,
          completeness: "complete",
          observedAt: "2026-12-04T01:00:00.000Z",
          capturedAt: "2026-12-04T01:00:01.000Z",
          entities,
          captureReceipt: { partitionId: partitionInside },
        }),
      );
      const afterUntil = await persistMetaEntityObservation(
        adsetObservation({
          endpoint: WINDOW_CROSSING_ENDPOINT,
          completeness: "complete",
          observedAt: "2026-12-04T20:00:00.000Z",
          capturedAt: "2026-12-04T20:00:01.000Z",
          entities,
          captureReceipt: { partitionId: partitionAfter },
        }),
      );
      expect(afterUntil.coalesced).toBe(true);
      expect(afterUntil.runId).toBe(appended.runId);

      // A lane whose only activity is entirely after `until`.
      const partitionOutside = await createPartition(
        "configs_window_outside",
        "2026-12-04",
      );
      await persistMetaEntityObservation(
        adsetObservation({
          endpoint: WINDOW_AFTER_UNTIL_ENDPOINT,
          completeness: "complete",
          observedAt: "2026-12-04T21:00:00.000Z",
          capturedAt: "2026-12-04T21:00:01.000Z",
          entities: [{ id: "wo_1", status: "ACTIVE" }],
          captureReceipt: { partitionId: partitionOutside },
        }),
      );

      const pressure = await readMetaObservationWriterPressure({
        since: "2026-12-04T00:00:00.000Z",
        until: "2026-12-04T12:00:00.000Z",
        businessIds: [businessId],
      });
      const lane = pressure.find(
        (row) =>
          row.endpoint === WINDOW_CROSSING_ENDPOINT &&
          row.completeness === "complete",
      );
      expect(lane).toBeDefined();
      expect(lane?.runsAppended).toBe(1);
      // The window saw ONE capture. The run has seen two in its lifetime, and
      // the field that says so is named for what it is.
      expect(lane?.windowOccurrences).toBe(1);
      expect(lane?.lifetimeOccurrencesOfWindowRuns).toBe(2);
      expect(
        new Date(lane!.lastWindowOccurrenceAt!).toISOString(),
      ).toBe("2026-12-04T01:00:01.000Z");
      // The lifetime heartbeat is later than `until`, and it is labelled as a
      // property of the window's RUNS rather than of the window.
      expect(
        new Date(lane!.lastHeartbeatAtOfWindowRuns!).toISOString(),
      ).toBe("2026-12-04T20:00:01.000Z");

      // The guard against over-correcting: the receipt side must respect
      // `until` too, or a lane that only ran afterwards would be reported as
      // window activity.
      expect(
        pressure.some((row) => row.endpoint === WINDOW_AFTER_UNTIL_ENDPOINT),
      ).toBe(false);
    });
  },
);
