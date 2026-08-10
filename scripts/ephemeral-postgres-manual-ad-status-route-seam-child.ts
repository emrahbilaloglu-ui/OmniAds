// Child of ephemeral-postgres-migrations-check: drives the REAL Meta Ad status
// route end-to-end against a controlled fake provider (D065/D067/D069).
//
// This is a route-level seam, not a component test. It builds an authenticated
// session and a genuinely connected, genuinely selected integration in the
// ephemeral database, then calls the shipped route handler
// (app/api/meta/ads/[adId]/pause/route.ts -> handleMetaAdStatusAction).
//
// Everything in the lifecycle is produced by production code: the action claim,
// the attempt_started event, the single provider POST, the terminal completion,
// and the receipt/reconciliation state. This file never appends a journal event
// itself -- it seeds fixtures, replaces globalThis.fetch, and reads the database
// back. If the shipped orchestrator stopped writing lineage, this seam fails,
// which is the entire point of testing here rather than at the client.
//
// DATABASE_URL is pre-set by the parent to the ephemeral server.
import { NextRequest } from "next/server";

import { createSession } from "@/lib/auth";
import { getDb } from "@/lib/db";

const LABEL = "manual-ad-status-route-seam";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

const USER_ID = "d0690000-0000-4000-8000-0000000000aa";
const OTHER_USER_ID = "d0690000-0000-4000-8000-0000000000bb";
const BUSINESS_ID = "d0690000-0000-4000-8000-000000000069";
const OTHER_BUSINESS_ID = "d0690000-0000-4000-8000-00000000006a";
const ACCOUNT_ID = "act_1069000000001";
const AD_ID = "1069000000101";
const CREATIVE_ID = "1069000000201";
const CAMPAIGN_ID = "1069000000301";
const ADSET_ID = "1069000000401";
const ACCESS_TOKEN = "seam-token-d069";
const AUTH_COOKIE = "omniads_session";

// ---------------------------------------------------------------------------
// Fixtures: the rows a genuinely connected, selected, authenticated workspace
// has. No guard is relaxed anywhere.
// ---------------------------------------------------------------------------
async function seed(): Promise<{ token: string; otherToken: string }> {
  const db = getDb();
  for (const [id, email] of [
    [USER_ID, "d069@adsecute.local"],
    [OTHER_USER_ID, "d069-other@adsecute.local"],
  ] as const) {
    await db.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'D069', $2, 'x') ON CONFLICT (id) DO NOTHING`,
      [id, email],
    );
  }
  for (const [id, owner] of [
    [BUSINESS_ID, USER_ID],
    [OTHER_BUSINESS_ID, OTHER_USER_ID],
  ] as const) {
    await db.query(
      `INSERT INTO businesses (id, name, owner_id)
       VALUES ($1, 'D069 Seam', $2) ON CONFLICT (id) DO NOTHING`,
      [id, owner],
    );
  }
  // Only USER_ID is a member of BUSINESS_ID. OTHER_USER_ID holds a real session
  // but no membership there, so identity/permission mismatch is a real state
  // rather than an absent cookie.
  await db.query(
    `INSERT INTO memberships (user_id, business_id, role, status)
     VALUES ($1, $2, 'admin', 'active')
     ON CONFLICT (user_id, business_id)
     DO UPDATE SET role = 'admin', status = 'active'`,
    [USER_ID, BUSINESS_ID],
  );
  await db.query(
    `INSERT INTO memberships (user_id, business_id, role, status)
     VALUES ($1, $2, 'admin', 'active')
     ON CONFLICT (user_id, business_id) DO NOTHING`,
    [OTHER_USER_ID, OTHER_BUSINESS_ID],
  );

  const accountRows = (await db.query(
    `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone)
     VALUES ('meta', $1, 'D069 Account', 'TRY', 'UTC')
     ON CONFLICT (provider, external_account_id)
     DO UPDATE SET account_name = EXCLUDED.account_name
     RETURNING id::text AS id`,
    [ACCOUNT_ID],
  )) as unknown as Array<{ id: string }>;

  await db.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
     VALUES ($1, 'meta', $2::uuid, $3, 0, TRUE)
     ON CONFLICT (business_id, provider, provider_account_ref_id)
     DO UPDATE SET is_selected = TRUE`,
    [BUSINESS_ID, accountRows[0]!.id, ACCOUNT_ID],
  );

  const connectionRows = (await db.query(
    `INSERT INTO provider_connections (business_id, provider, status, connection_generation)
     VALUES ($1, 'meta', 'connected', 1)
     ON CONFLICT (business_id, provider)
     DO UPDATE SET status = 'connected', connection_generation = 1
     RETURNING id::text AS id`,
    [BUSINESS_ID],
  )) as unknown as Array<{ id: string }>;
  await db.query(
    `INSERT INTO integration_credentials (provider_connection_id, access_token)
     VALUES ($1::uuid, $2)
     ON CONFLICT (provider_connection_id)
     DO UPDATE SET access_token = EXCLUDED.access_token`,
    [connectionRows[0]!.id, ACCESS_TOKEN],
  );

  await db.query(
    `INSERT INTO meta_ad_dimensions
       (business_id, provider_account_id, campaign_id, adset_id, ad_id,
        ad_name_current, ad_status, creative_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'D069 Ad', 'ACTIVE', $6, now())
     ON CONFLICT DO NOTHING`,
    [BUSINESS_ID, ACCOUNT_ID, CAMPAIGN_ID, ADSET_ID, AD_ID, CREATIVE_ID],
  );

  const session = await createSession({
    userId: USER_ID,
    activeBusinessId: BUSINESS_ID,
  });
  const otherSession = await createSession({
    userId: OTHER_USER_ID,
    activeBusinessId: OTHER_BUSINESS_ID,
  });
  return { token: session.token, otherToken: otherSession.token };
}

async function setSelected(selected: boolean) {
  await getDb().query(
    `UPDATE business_provider_accounts SET is_selected = $3
     WHERE business_id = $1 AND provider = 'meta' AND provider_account_id = $2`,
    [BUSINESS_ID, ACCOUNT_ID, selected],
  );
}

// ---------------------------------------------------------------------------
// Controlled fake provider.
// ---------------------------------------------------------------------------
type Recorded = { method: string; url: string };

function liveAd(overrides: Record<string, unknown> = {}) {
  return {
    id: AD_ID,
    account_id: ACCOUNT_ID.replace(/^act_/, ""),
    status: "ACTIVE",
    effective_status: "ACTIVE",
    campaign: { id: CAMPAIGN_ID, status: "ACTIVE", effective_status: "ACTIVE" },
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
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function postCalls(calls: Recorded[]) {
  return calls.filter((call) => call.method === "POST");
}

/** A provider that answers reads and confirms the write. */
function writeConfirmingProvider() {
  let posted = false;
  return installFakeProvider((_url, method) => {
    if (method === "POST") {
      posted = true;
      return json({ success: true });
    }
    return json(
      posted ? liveAd({ status: "PAUSED", effective_status: "PAUSED" }) : liveAd(),
    );
  });
}

// ---------------------------------------------------------------------------
// The real route.
// ---------------------------------------------------------------------------
async function callPauseRoute(input: { token: string; adId?: string }) {
  const { POST } = await import("@/app/api/meta/ads/[adId]/pause/route");
  const adId = input.adId ?? AD_ID;
  const request = new NextRequest(
    `http://localhost/api/meta/ads/${adId}/pause`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${AUTH_COOKIE}=${input.token}`,
      },
      // D065: the origin is declared, never inferred. A manual request carries
      // manual_operator_v1 and no native decision-lineage field at all.
      body: JSON.stringify({
        businessId: BUSINESS_ID,
        providerAccountId: ACCOUNT_ID,
        // The server-presented identity is echoed back explicitly; the route
        // will not accept the path parameter alone as authority.
        adId,
        creativeId: CREATIVE_ID,
        actionOrigin: "manual_operator_v1",
        manualConfirmation: "explicit_operator_confirmation",
      }),
    },
  );
  const response = await POST(request, { params: Promise.resolve({ adId }) });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return { status: response.status, body };
}

async function readLifecycle() {
  const db = getDb();
  const logs = (await db.query(
    `SELECT id::text AS id, status, action, provider_account_id, ad_id, creative_id
     FROM meta_ads_action_log
     WHERE business_id = $1 ORDER BY requested_at ASC`,
    [BUSINESS_ID],
  )) as unknown as Array<Record<string, unknown>>;
  const events = (await db.query(
    `SELECT event_kind, ad_id, creative_id, campaign_id, adset_id,
            provider_account_id, completion_outcome, provider_outcome,
            evidence_json
     FROM meta_ads_action_mutation_attempt_events
     WHERE business_id = $1 ORDER BY created_at ASC`,
    [BUSINESS_ID],
  )) as unknown as Array<Record<string, unknown>>;
  return { logs, events };
}

async function clearLifecycle() {
  const db = getDb();
  // Only the append-only trigger blocks DELETE on the journal, so drop it for
  // fixture reset between cases and restore it immediately. The append-only
  // guarantee itself is asserted in the final case, after all resets.
  await db.query(
    `ALTER TABLE meta_ads_action_mutation_attempt_events DISABLE TRIGGER USER`,
  );
  await db.query(
    `DELETE FROM meta_ads_action_mutation_attempt_events WHERE business_id = $1`,
    [BUSINESS_ID],
  );
  await db.query(
    `ALTER TABLE meta_ads_action_mutation_attempt_events ENABLE TRIGGER USER`,
  );
  await db.query(`DELETE FROM meta_ads_action_log WHERE business_id = $1`, [
    BUSINESS_ID,
  ]);
}

async function main() {
  const { token, otherToken } = await seed();

  // ------------------------------------------------------------------ case 1
  // One authorized pause through the real route. Production creates the claim,
  // attempt_started, one POST, and the terminal completion.
  {
    await clearLifecycle();
    const fake = writeConfirmingProvider();
    try {
      const result = await callPauseRoute({ token });
      if (result.status !== 200) {
        fail(
          "authorized pause",
          `route returned ${result.status}: ${JSON.stringify(result.body)}`,
        );
      }
      const posts = postCalls(fake.calls);
      expectEqual(posts.length, 1, "exactly one POST for one authorized pause");
      if (!posts[0]!.url.includes(AD_ID)) {
        fail("exact target", `POST did not name the Ad: ${posts[0]!.url}`);
      }
      if (!posts[0]!.url.includes(ACCESS_TOKEN)) {
        fail("exact credential", "POST did not carry the authorized credential");
      }
    } finally {
      fake.restore();
    }

    const { logs, events } = await readLifecycle();
    expectEqual(logs.length, 1, "production created exactly one action claim");
    expectEqual(logs[0]!.action, "pause", "claim records the exact action");
    expectEqual(
      logs[0]!.provider_account_id,
      ACCOUNT_ID,
      "claim records the exact provider account",
    );
    expectEqual(logs[0]!.ad_id, AD_ID, "claim records the exact Ad");
    expectEqual(logs[0]!.creative_id, CREATIVE_ID, "claim records the exact creative");

    const kinds = events.map((event) => event.event_kind);
    if (!kinds.includes("attempt_started")) {
      fail("lineage", "production did not write attempt_started");
    }
    if (!kinds.includes("attempt_completed")) {
      fail("lineage", "production did not write a terminal completion");
    }
    const completed = events.find(
      (event) => event.event_kind === "attempt_completed",
    )!;
    // The receipt itself records that no automatic retry happened; the POST
    // count above is the independent check on the same fact.
    const receipt = (completed.evidence_json ?? {}) as Record<string, unknown>;
    const attempt = (receipt.mutationAttempt ?? receipt) as Record<string, unknown>;
    expectEqual(
      attempt.automaticRetryAttempted,
      false,
      "the persisted receipt records that no automatic retry happened",
    );
    expectEqual(attempt.attemptCount, 1, "the persisted receipt records one attempt");
    for (const [column, expected] of [
      ["ad_id", AD_ID],
      ["creative_id", CREATIVE_ID],
      ["campaign_id", CAMPAIGN_ID],
      ["adset_id", ADSET_ID],
      ["provider_account_id", ACCOUNT_ID],
    ] as const) {
      expectEqual(completed[column], expected, `lineage carries exact ${column}`);
    }
  }

  // ------------------------------------------------------------------ case 2
  // Transport ambiguity: at most one POST, no automatic retry, never success.
  {
    await clearLifecycle();
    const fake = installFakeProvider((_url, method) => {
      if (method === "POST") throw new Error("socket hang up");
      return json(liveAd());
    });
    try {
      const result = await callPauseRoute({ token });
      if (result.status === 200) {
        fail("ambiguity", "an ambiguous provider outcome was reported as success");
      }
      expectEqual(
        postCalls(fake.calls).length,
        1,
        "at most one POST, and no automatic retry, on transport ambiguity",
      );
    } finally {
      fake.restore();
    }
    const { events } = await readLifecycle();
    const completed = events.find(
      (event) => event.event_kind === "attempt_completed",
    );
    if (!completed) fail("ambiguity lineage", "no terminal completion recorded");
    const ambiguousReceipt = (completed!.evidence_json ?? {}) as Record<string, unknown>;
    const ambiguousAttempt = (ambiguousReceipt.mutationAttempt ??
      ambiguousReceipt) as Record<string, unknown>;
    expectEqual(
      ambiguousAttempt.automaticRetryAttempted,
      false,
      "the ambiguous receipt records no automatic retry",
    );
  }

  // ------------------------------------------------------- cases 3-6: zero POST
  const zeroPostCases: Array<{
    label: string;
    setup: () => Promise<void>;
    teardown: () => Promise<void>;
    call: () => Promise<{ status: number }>;
  }> = [
    {
      label: "deselected account",
      setup: () => setSelected(false),
      teardown: () => setSelected(true),
      call: () => callPauseRoute({ token }),
    },
    {
      label: "revoked connection generation",
      setup: async () => {
        await getDb().query(
          `UPDATE provider_connections SET status = 'revoked', connection_generation = 2
           WHERE business_id = $1 AND provider = 'meta'`,
          [BUSINESS_ID],
        );
      },
      teardown: async () => {
        await getDb().query(
          `UPDATE provider_connections SET status = 'connected', connection_generation = 1
           WHERE business_id = $1 AND provider = 'meta'`,
          [BUSINESS_ID],
        );
      },
      call: () => callPauseRoute({ token }),
    },
    {
      label: "identity/permission mismatch",
      setup: async () => {},
      teardown: async () => {},
      call: () => callPauseRoute({ token: otherToken }),
    },
    {
      label: "kill switch engaged",
      setup: async () => {
        process.env.META_ADS_WRITE_KILL_SWITCH = "1";
      },
      teardown: async () => {
        delete process.env.META_ADS_WRITE_KILL_SWITCH;
      },
      call: () => callPauseRoute({ token }),
    },
  ];

  for (const zeroCase of zeroPostCases) {
    await clearLifecycle();
    await zeroCase.setup();
    const fake = installFakeProvider(() => json({ success: true }));
    try {
      const result = await zeroCase.call();
      if (result.status === 200) {
        fail(zeroCase.label, "the route allowed a write it must refuse");
      }
      expectEqual(
        postCalls(fake.calls).length,
        0,
        `zero POSTs on ${zeroCase.label}`,
      );
    } finally {
      fake.restore();
      await zeroCase.teardown();
    }
  }

  // ------------------------------------------------------------------ case 7
  // The append-only journal is enforced by the database, not by convention.
  // Run last, after every fixture reset, so nothing here is disabled.
  {
    await clearLifecycle();
    const fake = writeConfirmingProvider();
    try {
      await callPauseRoute({ token });
    } finally {
      fake.restore();
    }
    const db = getDb();
    for (const [statement, label] of [
      [
        `UPDATE meta_ads_action_mutation_attempt_events SET event_kind = 'tampered' WHERE business_id = $1`,
        "UPDATE",
      ],
      [
        `DELETE FROM meta_ads_action_mutation_attempt_events WHERE business_id = $1`,
        "DELETE",
      ],
    ] as const) {
      let refused = false;
      try {
        await db.query(statement, [BUSINESS_ID]);
      } catch {
        refused = true;
      }
      if (!refused) {
        fail("append-only", `the attempt journal accepted an ${label}`);
      }
    }
  }

  console.log(
    `[${LABEL}] PASS: the shipped route creates claim, attempt_started, <=1 POST, terminal completion and exact lineage; zero POST on deselection, revoked generation, permission mismatch and kill switch; no automatic retry on ambiguity; journal append-only at the database.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });
