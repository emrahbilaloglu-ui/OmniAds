/**
 * THE BOOTSTRAP MUST ASK THE SAME QUESTION THE AUTHORITY ASKS.
 *
 * ── ROUND 16 ────────────────────────────────────────────────────────────────
 * The one-shot recovery exists because a correct refusal (`sync_run_unlinked`)
 * is unrecoverable on an account whose daily coverage is already complete: the
 * only writer of current-config receipts is skipped, so no linked receipt is
 * ever written and every purchase-budget hard action holds forever.
 *
 * Round 15's probe decided an endpoint was healthy from `capture_status`, a
 * non-null `sync_run_id` and a succeeded run. The authority demands much more,
 * so a receipt the authority REFUSES could still suppress the repair — a
 * blackout with extra steps. Every case below writes a receipt that satisfies
 * the weak predicate and fails the real one, and asserts the bootstrap still
 * fires.
 *
 * Real PostgreSQL because the answer is decided by committed rows and by the
 * joins the shipped readers actually run.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import {
  claimMetaAuthorityBootstrapAttempt,
  readMetaAuthorityBootstrapProbe,
} from "@/lib/meta/config-observation-attestation";
import {
  META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS,
  shouldBootstrapRecentEditAuthority,
} from "@/lib/meta/recent-edit-authority";
import {
  resolveMetaAuthorityBootstrapDecision,
  resolveMetaPartitionDateAuthority,
} from "@/lib/sync/meta-sync";
import { persistMetaEntityObservation } from "@/lib/meta/entity-state-history";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
/*
  A namespace unique to this INVOCATION, not to an environment variable.

  The ledger and the receipt tables are keyed on (business, account, day), so a
  rerun that reuses an account name accumulates rows and the attempt counts read
  10 where the case expects 1. Pinning `ADSECUTE_SEAM_RUN_SUFFIX` — which is
  exactly what the reversion proofs do — made that the default. The suffix is
  kept in the name for traceability; the nonce is what guarantees isolation.
*/
const RUN_SUFFIX = process.env.ADSECUTE_SEAM_RUN_SUFFIX ?? String(process.pid);
const RUN_NONCE = `${RUN_SUFFIX}${process.pid}${Date.now().toString(36)}`;
const OWNER_EMAIL = `authority-bootstrap-${RUN_NONCE}@example.invalid`;

/*
  A fixed provider-local day, so every clock below is explicit. The knowledge
  bound is 20:00Z on the 5th: inside the day, ahead of every receipt written
  here, and behind the "future" ones.
*/
const DAY_START = new Date("2026-09-05T07:00:00.000Z");
const KNOWLEDGE = new Date("2026-09-05T20:00:00.000Z");
const FRESH = "2026-09-05T12:00:00.000Z";
const RUN_STARTED = "2026-09-05T11:00:00.000Z";

let businessId = "";
let accountRefId = "";
let accountCounter = 0;
let hashCounter = 0;
/*
  Unique per INVOCATION, not per suffix. `meta_entity_observation_runs` carries
  a unique `run_hash`, and a counter that restarts at 1 collided on the second
  run whenever `ADSECUTE_SEAM_RUN_SUFFIX` was pinned — which is exactly how this
  file is re-run during reversion proofs.
*/
const HASH_PREFIX = `${RUN_NONCE}`
  .split("")
  .map((c) => c.charCodeAt(0).toString(16))
  .join("")
  .slice(0, 40);
const hash = () =>
  (HASH_PREFIX + (hashCounter += 1).toString(16)).padStart(64, "0").slice(-64);

/** One isolated account per case, so cases cannot see each other's receipts. */
async function account(label: string) {
  const sql = getDb();
  /*
    A UNIQUE account per CASE and per invocation. The counter keeps two cases in
    one run apart; the suffix keeps two runs apart. Without the counter a pinned
    suffix collided on the provider-account unique key.
  */
  accountCounter += 1;
  const externalId = `act_boot_${RUN_NONCE}_${accountCounter}`.slice(0, 60);
  const [row] = await sql<{ id: string }>`
    INSERT INTO provider_accounts (provider, external_account_id, account_name)
    VALUES ('meta', ${externalId}, ${label})
    ON CONFLICT (provider, external_account_id)
      DO UPDATE SET account_name = EXCLUDED.account_name
    RETURNING id
  `;
  await sql`
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (${businessId}, 'meta', ${row!.id}, ${externalId})
    ON CONFLICT DO NOTHING
  `;
  const [partition] = await sql<{ id: string }>`
    INSERT INTO meta_sync_partitions (
      business_id, provider_account_id, lane, scope, partition_date, status
    ) VALUES (
      ${businessId}, ${externalId}, 'core', 'core_warehouse',
      '2026-09-05'::date, 'succeeded'
    )
    ON CONFLICT (business_id, provider_account_id, lane, scope, partition_date)
      DO UPDATE SET status = EXCLUDED.status
    RETURNING id
  `;
  return { externalId, refId: row!.id, partitionId: partition!.id };
}

/** A healthy, fully attestable capture of one endpoint — then selectively broken. */
async function writeEndpointEvidence(input: {
  acct: Awaited<ReturnType<typeof account>>;
  entityType: "campaign" | "adset";
  endpoint: string;
  captureStatus?: string;
  capturedAt?: string;
  observedAt?: string;
  runStatus?: string;
  runFinishedAt?: string | null;
  syncRunId?: string | null;
  crossAccountRun?: boolean;
  receiptHasError?: boolean;
  /** Recorded scope size on BOTH the run and the receipt. */
  recordedRowCount?: number;
  /** How many present state rows are actually written. */
  actualMembers?: number;
}) {
  const sql = getDb();
  const capturedAt = input.capturedAt ?? FRESH;
  const recorded = input.recordedRowCount ?? 1;
  const actual = input.actualMembers ?? recorded;

  let syncRunId: string | null = null;
  if (input.syncRunId !== null) {
    const [run] = await sql<{ id: string }>`
      INSERT INTO meta_sync_runs (
        partition_id, business_id, business_ref_id, provider_account_id,
        provider_account_ref_id, lane, scope, partition_date, status,
        attempt_count, started_at, finished_at
      ) VALUES (
        ${input.acct.partitionId}::uuid, ${businessId}, ${businessId}::uuid,
        ${input.crossAccountRun ? "act_someone_else" : input.acct.externalId},
        ${input.crossAccountRun ? accountRefId : input.acct.refId}::uuid,
        'core', 'core_warehouse', '2026-09-05'::date,
        ${input.runStatus ?? "succeeded"}, 1, ${RUN_STARTED}::timestamptz,
        ${input.runFinishedAt === undefined ? capturedAt : input.runFinishedAt}::timestamptz
      ) RETURNING id
    `;
    syncRunId = run!.id;
  }

  const [obs] = await sql<{ id: string }>`
    INSERT INTO meta_entity_observation_runs (
      business_ref_id, business_id, provider_account_ref_id, provider_account_id,
      entity_type, endpoint, observed_at, captured_at, completeness,
      page_count, row_count, run_hash
    ) VALUES (
      ${businessId}::uuid, ${businessId}, ${input.acct.refId}::uuid,
      ${input.acct.externalId}, ${input.entityType}, ${input.endpoint},
      ${capturedAt}::timestamptz, ${capturedAt}::timestamptz, 'complete',
      1, ${recorded}, ${hash()}
    ) RETURNING id
  `;
  for (let index = 0; index < actual; index += 1) {
    const entityId = `${input.entityType}_${input.acct.externalId}_${index}`;
    await sql`
      INSERT INTO meta_entity_state_history (
        run_id, business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, entity_type, entity_id, campaign_id, adset_id,
        observed_at, captured_at, run_completeness, presence, state_hash
      ) VALUES (
        ${obs!.id}::uuid, ${businessId}::uuid, ${businessId},
        ${input.acct.refId}::uuid, ${input.acct.externalId},
        ${input.entityType}, ${entityId},
        -- meta_entity_state_history_entity_identity_check: a campaign row's
        -- campaign_id IS its entity id; an ad-set row needs both columns.
        ${input.entityType === "campaign" ? entityId : `cmp_${entityId}`},
        ${input.entityType === "adset" ? entityId : null},
        ${capturedAt}::timestamptz, ${capturedAt}::timestamptz,
        'complete', 'present', ${hash()}
      )
    `;
  }
  await sql`
    INSERT INTO meta_entity_observation_receipts_v2 (
      run_id, business_id, provider_account_id, entity_type, endpoint,
      partition_id, sync_run_id, capture_status, provider_row_count,
      page_count, run_reused, observed_at, captured_at, error_json
    ) VALUES (
      ${obs!.id}::uuid, ${businessId}, ${input.acct.externalId},
      ${input.entityType}, ${input.endpoint}, ${input.acct.partitionId}::uuid,
      ${syncRunId}::uuid, ${input.captureStatus ?? "complete"}, ${recorded},
      1, false, ${input.observedAt ?? capturedAt}::timestamptz,
      ${capturedAt}::timestamptz,
      ${input.receiptHasError ? '{"reason":"seam"}' : null}::jsonb
    )
  `;
}

/** Both endpoints, same shape. */
async function writeBothEndpoints(
  acct: Awaited<ReturnType<typeof account>>,
  over: Partial<Parameters<typeof writeEndpointEvidence>[0]> = {},
) {
  await writeEndpointEvidence({ acct, entityType: "campaign", endpoint: "campaign_configs", ...over });
  await writeEndpointEvidence({ acct, entityType: "adset", endpoint: "adset_configs", ...over });
}

/** The ledger's own high-water mark, read directly. */
async function ledgerMax(input: {
  providerAccountId: string;
  providerLocalDay: string;
}) {
  const sql = getDb();
  const rows = await sql<{ attempts: string }>`
    SELECT COALESCE(MAX(attempt_no), 0)::text AS attempts
      FROM meta_authority_bootstrap_attempts
     WHERE business_id = ${businessId}
       AND provider_account_id = ${input.providerAccountId}
       AND provider_local_day = ${input.providerLocalDay}::date
  `;
  return Number(rows[0]!.attempts);
}

const probeFor = (acct: Awaited<ReturnType<typeof account>>) =>
  readMetaAuthorityBootstrapProbe({
    businessId,
    providerAccountId: acct.externalId,
    knowledgeEndExclusive: KNOWLEDGE,
  });

/** The health half of the decision, with a fresh (zero-attempt) ledger. */
const bootstrapsFor = async (
  acct: Awaited<ReturnType<typeof account>>,
  attemptsSpent: number | null = 0,
) =>
  shouldBootstrapRecentEditAuthority({
    truthState: "provisional",
    probe: { ...(await probeFor(acct)), attemptsSpent },
  });

describe.skipIf(!SEAM)("the bootstrap probe uses the authority's contract", () => {
  beforeAll(async () => {
    /*
      RERUN-SAFE. The seam database is normally fresh, but this file is re-run
      repeatedly while iterating and during reversion proofs — and with a pinned
      `ADSECUTE_SEAM_RUN_SUFFIX` the second run collided on `users_email_key`
      before a single assertion executed. The append-only evidence tables hold
      foreign keys to the business, so a DELETE cascade is refused by design;
      reusing the existing row is the only safe idempotency.
    */
    const sql = getDb();
    const [owner] = await sql<{ id: string }>`
      INSERT INTO users (name, email, password_hash)
      VALUES ('Authority bootstrap seam', ${OWNER_EMAIL}, 'unused')
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    const existing = await sql<{ id: string }>`
      SELECT id FROM businesses WHERE owner_id = ${owner!.id}::uuid LIMIT 1
    `;
    if (existing[0]) {
      businessId = existing[0].id;
    } else {
      const [business] = await sql<{ id: string }>`
        INSERT INTO businesses (name, owner_id)
        VALUES ('Authority bootstrap seam', ${owner!.id}) RETURNING id
      `;
      businessId = business!.id;
    }
    const [fallback] = await sql<{ id: string }>`
      INSERT INTO provider_accounts (provider, external_account_id, account_name)
      VALUES ('meta', ${`act_other_${RUN_NONCE}`.slice(0, 60)}, 'other')
      ON CONFLICT (provider, external_account_id)
        DO UPDATE SET account_name = EXCLUDED.account_name
      RETURNING id
    `;
    accountRefId = fallback!.id;
  });

  it("fires when the account has NO receipts at all", async () => {
    const acct = await account("empty");
    expect(await bootstrapsFor(acct)).toBe(true);
  });

  it("fires on LEGACY receipts with a null sync_run_id", async () => {
    const acct = await account("legacy");
    await writeBothEndpoints(acct, { syncRunId: null });
    const probe = await probeFor(acct);
    expect(probe.campaignReceiptLinked).toBe(false);
    expect(probe.adsetReceiptLinked).toBe(false);
    expect(await bootstrapsFor(acct)).toBe(true);
  });

  it("SUPPRESSES once both endpoints are fully attestable", async () => {
    /*
      The control, and the loop guard. Without it every case here would pass on
      a probe that simply never says healthy.
    */
    const acct = await account("healthy");
    await writeBothEndpoints(acct);
    const probe = await probeFor(acct);
    expect(probe.campaignReceiptLinked).toBe(true);
    expect(probe.adsetReceiptLinked).toBe(true);
    expect(await bootstrapsFor(acct)).toBe(false);
  });

  it("still fires when only ONE endpoint is attestable", async () => {
    const acct = await account("halfonly");
    await writeEndpointEvidence({ acct, entityType: "campaign", endpoint: "campaign_configs" });
    expect(await bootstrapsFor(acct)).toBe(true);
  });

  it.each([
    // Each of these SATISFIES Round 15's weak predicate and FAILS the real one.
    ["a newest PARTIAL capture", { captureStatus: "partial" }],
    ["a newest FAILED capture", { captureStatus: "failed" }],
    ["an ERRORED complete capture", { receiptHasError: true }],
    ["a STALE observation (fresh write, old provider read)", { observedAt: "2026-06-01T09:00:00.000Z" }],
    ["an attempt that FAILED after committing the receipt", { runStatus: "failed" }],
    ["an attempt bound to a DIFFERENT account", { crossAccountRun: true }],
    ["an attempt that finished AFTER the knowledge bound", { runFinishedAt: "2026-09-05T21:00:00.000Z" }],
    ["a COUNT-CORRUPT manifest (recorded 2, reconstructed 1)", { recordedRowCount: 2, actualMembers: 1 }],
  ])("does NOT suppress recovery on %s", async (label, over) => {
    const acct = await account(`bad_${String(label).replace(/\W+/g, "_").slice(0, 24)}`);
    await writeBothEndpoints(acct, over as never);
    const probe = await probeFor(acct);
    expect(probe.campaignReceiptLinked, label).toBe(false);
    expect(await bootstrapsFor(acct), label).toBe(true);
  });

  it("treats a genuinely EMPTY account as valid, not as broken", async () => {
    /*
      Zero entities is a complete, truthful observation of an empty scope: the
      recorded count is 0 and the reconstruction is 0. There is nothing to
      decide about either way, and calling it unusable would keep an empty
      account in permanent recovery.
    */
    const acct = await account("zeroentities");
    await writeBothEndpoints(acct, { recordedRowCount: 0, actualMembers: 0 });
    const probe = await probeFor(acct);
    expect(probe.campaignReceiptLinked).toBe(true);
    expect(probe.adsetReceiptLinked).toBe(true);
    expect(await bootstrapsFor(acct)).toBe(false);
  });

  it("counts BOUNDED attempts from the provider-local day, not a rolling window", async () => {
    /*
      A permanently failing provider must not be retried forever. The counter is
      separate from health on purpose: only a real attestation ends recovery
      early, and only this bound ends it late.
    */
    const acct = await account("bounded");
    /*
      ── ROUND 17 ──────────────────────────────────────────────────────────
      The ledger, not a receipt count. Each of these attempts writes NOTHING —
      no receipts at all — which is exactly the shape Round 16's
      receipt-count/2 inference could not see, and the shape a failing provider
      actually produces.
    */
    for (let attempt = 1; attempt <= META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
      const claim = await claimMetaAuthorityBootstrapAttempt({
        businessId,
        providerAccountId: acct.externalId,
        providerLocalDay: "2026-09-05",
        maxAttempts: META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS,
      });
      expect(claim.claimed).toBe(true);
      expect(claim.attemptNo).toBe(attempt);
    }
    const spent = await ledgerMax({
      providerAccountId: acct.externalId,
      providerLocalDay: "2026-09-05",
      });
    expect(spent).toBe(META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS);
    // Still unhealthy, but the budget is spent: the fourth call is refused.
    expect(await bootstrapsFor(acct, spent)).toBe(false);
    // And the third was still allowed, so the bound is exactly three.
    expect(await bootstrapsFor(acct, META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS - 1)).toBe(true);

    // Yesterday's attempts do not count against today's budget.
    expect(
      await ledgerMax({
        providerAccountId: acct.externalId,
        providerLocalDay: "2026-09-04",
        }),
    ).toBe(0);
  });

  it("counts a CAMPAIGN-ONLY attempt exactly once, like any other", async () => {
    /*
      Round 16 halved a receipt count, so an attempt that committed only the
      campaign endpoint scored 0.5 and floored to zero — three such attempts
      bought unlimited retries. The ledger counts the ATTEMPT, whatever it
      produced.
    */
    const acct = await account("campaignonly");
    for (let attempt = 1; attempt <= META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
      await claimMetaAuthorityBootstrapAttempt({
        businessId,
        providerAccountId: acct.externalId,
        providerLocalDay: "2026-09-05",
        maxAttempts: META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS,
      });
      // Each attempt commits ONE endpoint only, then fails.
      await writeEndpointEvidence({
        acct,
        entityType: "campaign",
        endpoint: "campaign_configs",
        captureStatus: "failed",
        capturedAt: new Date(new Date(FRESH).getTime() + attempt * 60_000).toISOString(),
      });
    }
    const spent = await ledgerMax({
      providerAccountId: acct.externalId,
      providerLocalDay: "2026-09-05",
      });
    expect(spent).toBe(META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS);
    expect(await bootstrapsFor(acct, spent)).toBe(false);
  });

  it("is scoped to the exact business and account", async () => {
    // A neighbour's spent budget must not exhaust this account's.
    const mine = await account("ledgerscope");
    await claimMetaAuthorityBootstrapAttempt({
      businessId,
      providerAccountId: mine.externalId,
      providerLocalDay: "2026-09-05",
      maxAttempts: META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS,
    });
    const neighbour = await account("ledgerneighbour");
    expect(
      await ledgerMax({
        providerAccountId: neighbour.externalId,
        providerLocalDay: "2026-09-05",
        }),
    ).toBe(0);
  });
});


/*
  ── ROUND 19, ITEM A2 ───────────────────────────────────────────────────────
  The former "lifecycle" test lived here. It called the decision function,
  INSERTed a sync run by hand, and called `persistMetaEntityObservation`
  directly — three steps a test author chose, in an order a test author chose.
  That proves the pieces work; it does not prove the shipped orchestration wires
  them together, which is the only thing the item asked for.

  It is replaced by `lib/meta/authority-bootstrap-orchestration.db.test.ts`,
  which drives the real `syncMetaPartitionDay` with only the Graph fetch stubbed
  and reads coverage and receipts back from the database.
*/

describe.skipIf(!SEAM)("ROUND 18 — the bootstrap claim is atomic and bounded", () => {
  it("lets exactly ONE of two concurrent claimants through at attempt 2", async () => {
    /*
      ── ITEM A1 ─────────────────────────────────────────────────────────────
      Round 17 read the count, compared it to the bound, then inserted
      MAX+1 — three statements with two gaps. Two workers reaching the gap
      together both read 2, both decided they were under the bound of 3, and
      both proceeded: the ledger ended at 4 and two provider calls were made on
      a budget of three.

      Started at 2 on purpose: exactly one slot remains, so a race that is not
      atomic overshoots visibly.
    */
    const acct = await account("race");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const seeded = await claimMetaAuthorityBootstrapAttempt({
        businessId,
        providerAccountId: acct.externalId,
        providerLocalDay: "2026-09-05",
        maxAttempts: META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS,
      });
      expect(seeded.claimed).toBe(true);
    }

    // The barrier: both issued before either is awaited.
    const contenders = [0, 1].map(() =>
      claimMetaAuthorityBootstrapAttempt({
        businessId,
        providerAccountId: acct.externalId,
        providerLocalDay: "2026-09-05",
        maxAttempts: META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS,
      }).catch(() => ({ claimed: false, attemptNo: null })),
    );
    const results = await Promise.all(contenders);
    expect(results.filter((one) => one.claimed).length).toBe(1);

    const sql = getDb();
    const rows = await sql<{ max_no: string; total: string }>`
      SELECT COALESCE(MAX(attempt_no), 0)::text AS max_no, count(*)::text AS total
        FROM meta_authority_bootstrap_attempts
       WHERE business_id = ${businessId}
         AND provider_account_id = ${acct.externalId}
         AND provider_local_day = '2026-09-05'::date
    `;
    // The bound held on BOTH measures: no fourth slot, no duplicate row.
    expect(Number(rows[0]!.max_no)).toBe(META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS);
    expect(Number(rows[0]!.total)).toBe(META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS);
  });

  it("refuses every further claim once the budget is spent", async () => {
    const acct = await account("spent");
    for (let attempt = 1; attempt <= META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
      expect(
        (
          await claimMetaAuthorityBootstrapAttempt({
            businessId,
            providerAccountId: acct.externalId,
            providerLocalDay: "2026-09-05",
            maxAttempts: META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS,
          })
        ).claimed,
      ).toBe(true);
    }
    for (let extra = 0; extra < 3; extra += 1) {
      const refused = await claimMetaAuthorityBootstrapAttempt({
        businessId,
        providerAccountId: acct.externalId,
        providerLocalDay: "2026-09-05",
        maxAttempts: META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS,
      });
      expect(refused.claimed).toBe(false);
      expect(refused.attemptNo).toBeNull();
    }
    expect(await ledgerMax({ providerAccountId: acct.externalId, providerLocalDay: "2026-09-05" })).toBe(
      META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS,
    );
  });

  it("does NOT claim for a partition whose day is not the provider-local today", async () => {
    /*
      ── ITEM A3 ─────────────────────────────────────────────────────────────
      A calendar disagreement is not a reason to guess. The partition's target
      day and the authority's provider-local today must be the same date.
    */
    const acct = await account("daymismatch");
    const sql = getDb();
    await sql`
      UPDATE provider_accounts SET timezone = 'America/Los_Angeles'
      WHERE id = ${acct.refId}::uuid
    `;
    await writeBothEndpoints(acct, { syncRunId: null });
    expect(
      await resolveMetaAuthorityBootstrapDecision({
        businessId,
        providerAccountId: acct.externalId,
        // Yesterday's partition, today's authority.
        day: "2026-09-04",
        truthState: "provisional",
        coverageComplete: true,
        partitionAuthority: {
          trusted: true,
          timeZone: "America/Los_Angeles",
          providerLocalToday: "2026-09-05",
        },
        now: KNOWLEDGE,
      }),
    ).toBe(false);
    expect(await ledgerMax({ providerAccountId: acct.externalId, providerLocalDay: "2026-09-05" })).toBe(0);
  });
});
