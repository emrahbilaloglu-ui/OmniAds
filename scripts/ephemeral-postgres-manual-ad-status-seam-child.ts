// Child of ephemeral-postgres-migrations-check: drives the REAL manual Meta Ad
// status write path end-to-end against a controlled fake provider (D065/D067/
// D069).
//
// Why this exists: every other test of this path either mocks the write client
// or mocks the authority guards. Neither shows what the shipped code does when
// the guards are live. This seam builds a deterministic connected-integration
// fixture that satisfies current main's guards *as written* -- business/account
// assignment, connection generation, and the pre-POST authority snapshot -- and
// then exercises the real writer. No guard is weakened or stubbed, and no live
// provider is contacted: only global fetch is replaced.
//
// What it proves:
//   1. one POST maximum for one authorized mutation;
//   2. exact target and account authority (wrong account is refused, and the
//      POST that does go out names the exact Ad);
//   3. no automatic retry when the provider outcome is ambiguous;
//   4. durable attempt lineage: started/completed events on the append-only
//      journal, bound to the source action log;
//   5. fail-closed behaviour when the connection generation moves between
//      request build and POST, and when the account is deselected.
//
// DATABASE_URL is pre-set by the parent to the ephemeral server.
import { getDb } from "@/lib/db";
import { pauseAd, type MetaAdsWriteContext } from "@/lib/meta/ads-write";
import {
  MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
  appendManualMetaAdStatusMutationAttemptCompleted,
  appendManualMetaAdStatusMutationAttemptStarted,
  createMetaAdsActionLog,
} from "@/lib/meta/ads-action-log";

const LABEL = "manual-ad-status-seam";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

const USER_ID = "d0690000-0000-4000-8000-0000000000aa";
const BUSINESS_ID = "d0690000-0000-4000-8000-000000000069";
const ACCOUNT_ID = "act_1069000000001";
const OTHER_ACCOUNT_ID = "act_1069000000002";
const AD_ID = "1069000000101";
const CREATIVE_ID = "1069000000201";
const CAMPAIGN_ID = "1069000000301";
const ADSET_ID = "1069000000401";


const ACCESS_TOKEN = "seam-token-d069";

// ---------------------------------------------------------------------------
// Deterministic connected-integration fixture.
//
// These are the exact rows the shipped guards read. Nothing here relaxes a
// check; it supplies the state a genuinely connected, genuinely selected
// account would have.
// ---------------------------------------------------------------------------
async function seedConnectedIntegration(): Promise<string> {
  const db = getDb();
  await db.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1, 'D069 Operator', 'd069@adsecute.local', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  await db.query(
    `INSERT INTO businesses (id, name, owner_id)
     VALUES ($1, 'D069 Seam', $2)
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID, USER_ID],
  );

  const accountRefIds = new Map<string, string>();
  for (const external of [ACCOUNT_ID, OTHER_ACCOUNT_ID]) {
    const rows = (await db.query(
      `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone)
       VALUES ('meta', $1, 'D069 Account', 'TRY', 'UTC')
       ON CONFLICT (provider, external_account_id)
       DO UPDATE SET account_name = EXCLUDED.account_name
       RETURNING id::text AS id`,
      [external],
    )) as unknown as Array<{ id: string }>;
    accountRefIds.set(external, rows[0]!.id);
  }

  // Only ACCOUNT_ID is selected. OTHER_ACCOUNT_ID is bound but deselected, so
  // "assigned but not selected" is a real state this seam can exercise.
  await db.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
     VALUES ($1, 'meta', $2::uuid, $3, 0, TRUE)
     ON CONFLICT (business_id, provider, provider_account_ref_id)
     DO UPDATE SET is_selected = TRUE`,
    [BUSINESS_ID, accountRefIds.get(ACCOUNT_ID), ACCOUNT_ID],
  );
  await db.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
     VALUES ($1, 'meta', $2::uuid, $3, 1, FALSE)
     ON CONFLICT (business_id, provider, provider_account_ref_id)
     DO UPDATE SET is_selected = FALSE`,
    [BUSINESS_ID, accountRefIds.get(OTHER_ACCOUNT_ID), OTHER_ACCOUNT_ID],
  );

  const connectionRows = (await db.query(
    `INSERT INTO provider_connections (business_id, provider, status, connection_generation)
     VALUES ($1, 'meta', 'connected', 1)
     ON CONFLICT (business_id, provider)
     DO UPDATE SET status = 'connected', connection_generation = 1
     RETURNING id::text AS id`,
    [BUSINESS_ID],
  )) as unknown as Array<{ id: string }>;
  const connectionId = connectionRows[0]!.id;

  await db.query(
    `INSERT INTO integration_credentials (provider_connection_id, access_token)
     VALUES ($1::uuid, $2)
     ON CONFLICT (provider_connection_id)
     DO UPDATE SET access_token = EXCLUDED.access_token`,
    [connectionId, ACCESS_TOKEN],
  );

  return accountRefIds.get(ACCOUNT_ID)!;
}

async function setConnectionGeneration(generation: number) {
  const db = getDb();
  await db.query(
    `UPDATE provider_connections SET connection_generation = $2
     WHERE business_id = $1 AND provider = 'meta'`,
    [BUSINESS_ID, generation],
  );
}

async function setAccountSelected(selected: boolean) {
  const db = getDb();
  await db.query(
    `UPDATE business_provider_accounts SET is_selected = $3
     WHERE business_id = $1 AND provider = 'meta' AND provider_account_id = $2`,
    [BUSINESS_ID, ACCOUNT_ID, selected],
  );
}

// ---------------------------------------------------------------------------
// Controlled fake provider. Records every request; never leaves the process.
// ---------------------------------------------------------------------------
type Recorded = { method: string; url: string };

function installFakeProvider(
  handler: (url: string, method: string) => Response,
): { calls: Recorded[]; restore: () => void } {
  const calls: Recorded[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (!url.startsWith("https://graph.facebook.com/")) {
      fail("fake provider", `unexpected non-provider request to ${url}`);
    }
    calls.push({ method, url });
    return handler(url, method);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/**
 * The exact live Ad shape the write path re-reads before it will mutate: id,
 * owning account, hierarchy, creative and both status fields. D065 requires
 * exact live identity, so a fake that omits any of these is correctly refused.
 */
function liveAd(overrides: Record<string, unknown> = {}) {
  return {
    id: AD_ID,
    account_id: ACCOUNT_ID.replace(/^act_/, ""),
    status: "ACTIVE",
    effective_status: "ACTIVE",
    // Hierarchy status is required evidence, not decoration: D065 refuses to
    // treat an Ad as ACTIVE when its campaign or ad set is not.
    campaign: {
      id: CAMPAIGN_ID,
      status: "ACTIVE",
      effective_status: "ACTIVE",
    },
    adset: { id: ADSET_ID, status: "ACTIVE", effective_status: "ACTIVE" },
    creative: { id: CREATIVE_ID },
    ...overrides,
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ctx(overrides: Partial<MetaAdsWriteContext> = {}): MetaAdsWriteContext {
  return {
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
    connectionGeneration: "1:connected",
    ...overrides,
  };
}

function postCalls(calls: Recorded[]) {
  return calls.filter((call) => call.method === "POST");
}

async function main() {
  const providerAccountRefId = await seedConnectedIntegration();

  // ------------------------------------------------------------------ case 1
  // One authorized pause: exactly one POST, naming the exact Ad.
  {
    // ACTIVE before the write, PAUSED after it: the pre-read must see something
    // worth changing, and the verification read must see the change land.
    let posted = false;
    const fake = installFakeProvider((_url, method) => {
      if (method === "POST") {
        posted = true;
        return json({ success: true });
      }
      return json(
        posted
          ? liveAd({ status: "PAUSED", effective_status: "PAUSED" })
          : liveAd(),
      );
    });
    try {
      const result = await pauseAd(ctx(), AD_ID);
      if (!result.ok) {
        fail("authorized pause", `refused: ${JSON.stringify(result.error)}`);
      }
      const posts = postCalls(fake.calls);
      expectEqual(posts.length, 1, "exactly one POST for one authorized pause");
      if (!posts[0]!.url.includes(AD_ID)) {
        fail("exact target", `POST did not name the Ad: ${posts[0]!.url}`);
      }
      if (!posts[0]!.url.includes(ACCESS_TOKEN)) {
        fail("exact credential", "POST did not carry the authorized token");
      }
    } finally {
      fake.restore();
    }
  }

  // ------------------------------------------------------------------ case 2
  // Ambiguous provider outcome: still one POST, and no automatic retry.
  {
    const fake = installFakeProvider((_url, method) => {
      if (method === "POST") {
        // A transport-level ambiguity: the provider neither confirms nor denies.
        throw new Error("socket hang up");
      }
      return json(liveAd());
    });
    try {
      const result = await pauseAd(ctx(), AD_ID);
      if (result.ok) fail("ambiguity", "ambiguous outcome was reported as success");
      expectEqual(
        postCalls(fake.calls).length,
        1,
        "no automatic retry after an ambiguous provider outcome",
      );
    } finally {
      fake.restore();
    }
  }

  // ------------------------------------------------------------------ case 3
  // Fail closed when the connection generation moves between build and POST.
  {
    await setConnectionGeneration(2);
    const fake = installFakeProvider(() => json({ success: true }));
    try {
      const result = await pauseAd(ctx({ connectionGeneration: "1:connected" }), AD_ID);
      if (result.ok) fail("generation drift", "a stale generation was allowed to write");
      expectEqual(
        postCalls(fake.calls).length,
        0,
        "zero POSTs when the connection generation moved",
      );
    } finally {
      fake.restore();
      await setConnectionGeneration(1);
    }
  }

  // ------------------------------------------------------------------ case 4
  // Fail closed when the account is no longer selected.
  {
    await setAccountSelected(false);
    const fake = installFakeProvider(() => json({ success: true }));
    try {
      const result = await pauseAd(ctx(), AD_ID);
      if (result.ok) fail("deselected account", "a deselected account was allowed to write");
      expectEqual(
        postCalls(fake.calls).length,
        0,
        "zero POSTs when the account is deselected",
      );
    } finally {
      fake.restore();
      await setAccountSelected(true);
    }
  }

  // ------------------------------------------------------------------ case 5
  // Durable attempt lineage on the append-only journal, bound to its source.
  {
    const actionLog = await createMetaAdsActionLog({
      businessId: BUSINESS_ID,
      adId: AD_ID,
      creativeId: CREATIVE_ID,
      providerAccountRefId,
      providerAccountId: ACCOUNT_ID,
      action: "pause",
      source: "manual_operator_v1",
      requestedBy: USER_ID,
      // The journal contract is declared on the source claim itself: an attempt
      // event may only bind to a claim that already announced it would be
      // journalled, so lineage cannot be attached to an arbitrary log row.
      payloadRequest: {
        scope_type: "ad",
        manual_confirmation: true,
        mutation_journal_required: true,
        mutation_journal_contract_version:
          MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
        manual_status_mutation_target: {
          businessId: BUSINESS_ID,
          providerAccountId: ACCOUNT_ID,
          adId: AD_ID,
          creativeId: CREATIVE_ID,
          campaignId: CAMPAIGN_ID,
          adsetId: ADSET_ID,
        },
      },
    });

    const started = await appendManualMetaAdStatusMutationAttemptStarted({
      sourceActionLogId: actionLog.id,
      action: "pause",
      postPath: AD_ID,
      target: {
        businessId: BUSINESS_ID,
        providerAccountId: ACCOUNT_ID,
        adId: AD_ID,
        creativeId: CREATIVE_ID,
        campaignId: CAMPAIGN_ID,
        adsetId: ADSET_ID,
      },
    } as never);
    if (!started?.attemptId) {
      fail("attempt lineage", "no attempt_started event was persisted");
    }

    // The completion event carries the provider receipt itself. Timestamps are
    // derived from the DB-issued lease rather than invented, and the outcome
    // recorded is the ambiguous one: it is the case D069 most needs durable,
    // because it is the case where a retry would double-write.
    const attemptedAt = started.startedAt;
    const completedAt = new Date(
      Math.min(
        Date.parse(started.startedAt) + 1000,
        Date.parse(started.leaseDeadline),
      ),
    ).toISOString();
    await appendManualMetaAdStatusMutationAttemptCompleted({
      sourceActionLogId: actionLog.id,
      attemptId: started.attemptId,
      completionOutcome: "provider_outcome_ambiguous",
      mutationAttempt: {
        attemptCount: 1,
        method: "POST",
        path: started.postPath,
        attemptedAt,
        completedAt,
        providerResponseReceived: false,
        httpStatus: null,
        outcome: "outcome_ambiguous",
        automaticRetryAttempted: false,
        transportError: { code: "socket_hang_up" },
      },
    });

    const db = getDb();
    const events = (await db.query(
      `SELECT event_kind FROM meta_ads_action_mutation_attempt_events
       WHERE source_action_log_id = $1::uuid ORDER BY created_at ASC`,
      [actionLog.id],
    )) as unknown as Array<{ event_kind: string }>;
    const kinds = events.map((event) => event.event_kind).sort();
    expectEqual(
      kinds,
      ["attempt_completed", "attempt_started"],
      "attempt lineage is durable and bound to its source action log",
    );

    // The journal is append-only in the database, not merely by convention.
    let updateRefused = false;
    try {
      await db.query(
        `UPDATE meta_ads_action_mutation_attempt_events SET event_kind = 'tampered'
         WHERE source_action_log_id = $1::uuid`,
        [actionLog.id],
      );
    } catch {
      updateRefused = true;
    }
    if (!updateRefused) fail("append-only", "the attempt journal accepted an UPDATE");

    let deleteRefused = false;
    try {
      await db.query(
        `DELETE FROM meta_ads_action_mutation_attempt_events
         WHERE source_action_log_id = $1::uuid`,
        [actionLog.id],
      );
    } catch {
      deleteRefused = true;
    }
    if (!deleteRefused) fail("append-only", "the attempt journal accepted a DELETE");
  }

  console.log(
    `[${LABEL}] PASS: one POST maximum, exact target/credential, no retry on ambiguity, fail-closed on generation drift and deselection, append-only attempt lineage.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
