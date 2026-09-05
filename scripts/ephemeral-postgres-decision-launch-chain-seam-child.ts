// Child of ephemeral-postgres-migrations-check. It runs only against the
// throwaway database URL force-set by the parent and never calls Meta.
//
// The chain this proves, end to end, from an ELIGIBLE DECISION rather than
// from a hand-written queue row or a finished intent:
//
//   creative decision (scale)
//     -> the brief a person reviewed  +  the draft they composed
//       -> a staged launch intent          (launch-intent-producer)
//         -> a `launch` queue row          (launch-proposal-producer)
//           -> the operator approves it    (the real proposals route)
//             -> ONE provider ad create, PAUSED
//               -> a `resume` queue row    (activation-proposal-producer)
//                 -> a separately authorized activation
//
// Nothing here mints a payload the production code should have produced. The
// intent is written by the shipped store through the shipped producer, the
// queue rows by the shipped projections, and both provider legs by the shipped
// route handlers under a real session. This file seeds fixtures, replaces
// globalThis.fetch with a controlled provider, and reads the database back.
//
// The last leg is the one that matters most: it runs everything a SECOND time
// and asserts that no second intent, no second queue row and no second provider
// ad exist. A producer that stages from a decision is exactly the kind that can
// create a duplicate ad every tick.
import { NextRequest } from "next/server";

import { createSession } from "@/lib/auth";
import { getDb, resetDbClientCache } from "@/lib/db";
import { upsertMetaLaunchDraft } from "@/lib/launchpad/meta-store";
import { getMetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent-store";
import { parseCreateMetaCreativeBriefRequest } from "@/lib/meta/creative-brief-contract";
import { createMetaCreativeBrief } from "@/lib/meta/creative-brief-store";
import {
  insertActivationProposalRow,
  projectMetaActivationProposals,
} from "@/lib/meta/activation-proposal-producer";
import { projectMetaLaunchIntents } from "@/lib/meta/launch-intent-producer";
import {
  insertLaunchProposalRow,
  projectMetaLaunchProposals,
} from "@/lib/meta/launch-proposal-producer";

const LABEL = "decision-launch-chain-seam";
const AUTH_COOKIE = "omniads_session";

const USER_ID = "b2a10000-0000-4000-8000-0000000000a1";
const BUSINESS_ID = "b2a10000-0000-4000-8000-0000000000b1";
const ACCOUNT_ID = "act_2081000000001";
const ACCOUNT_NUMERIC = ACCOUNT_ID.replace(/^act_/, "");
const WINNER_CREATIVE_ID = "2081000000301";
const SOURCE_AD_ID = "2081000000401";
const SOURCE_ADSET_ID = "2081000000501";
const TARGET_CAMPAIGN_ID = "2081000000601";
const TARGET_ADSET_ID = "2081000000701";
const NEW_AD_ID = "2081000000801";
const ACCESS_TOKEN = "seam-token-decision-launch";
const SNAPSHOT_DATE = "2026-09-05";
const DECISION_AS_OF = "2026-09-04";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

function log(message: string) {
  console.log(`[${LABEL}] ${message}`);
}

// ---------------------------------------------------------------------------
// The controlled provider. Every read answers from the fixture's own ids, so a
// create that duplicated the wrong ad or landed in the wrong ad set would be
// refused by the shipped identity checks rather than by this file.
// ---------------------------------------------------------------------------
type Recorded = { method: string; url: string; body: string | null };

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type ProviderState = { adCreated: boolean; adActive: boolean };

function providerPayloadFor(
  objectId: string,
  state: ProviderState,
): unknown | null {
  if (objectId === SOURCE_AD_ID) {
    return {
      id: SOURCE_AD_ID,
      name: "Winner — hero 9x16",
      account_id: ACCOUNT_NUMERIC,
      status: "ACTIVE",
      effective_status: "ACTIVE",
      creative: { id: WINNER_CREATIVE_ID },
      adset_id: SOURCE_ADSET_ID,
    };
  }
  if (objectId === WINNER_CREATIVE_ID) {
    return { id: WINNER_CREATIVE_ID, account_id: ACCOUNT_NUMERIC };
  }
  if (objectId === TARGET_ADSET_ID) {
    return {
      id: TARGET_ADSET_ID,
      account_id: ACCOUNT_NUMERIC,
      campaign_id: TARGET_CAMPAIGN_ID,
      status: "ACTIVE",
      effective_status: "ACTIVE",
    };
  }
  if (objectId === TARGET_CAMPAIGN_ID) {
    return {
      id: TARGET_CAMPAIGN_ID,
      account_id: ACCOUNT_NUMERIC,
      status: "ACTIVE",
      effective_status: "ACTIVE",
    };
  }
  if (objectId === NEW_AD_ID && state.adCreated) {
    const status = state.adActive ? "ACTIVE" : "PAUSED";
    return {
      id: NEW_AD_ID,
      name: "Winner — hero 9x16 (copy)",
      account_id: ACCOUNT_NUMERIC,
      status,
      effective_status: status,
      adset_id: TARGET_ADSET_ID,
      campaign: {
        id: TARGET_CAMPAIGN_ID,
        status: "ACTIVE",
        effective_status: "ACTIVE",
      },
      adset: {
        id: TARGET_ADSET_ID,
        status: "ACTIVE",
        effective_status: "ACTIVE",
      },
      creative: { id: WINNER_CREATIVE_ID },
    };
  }
  return null;
}

function installProvider(): {
  calls: Recorded[];
  state: ProviderState;
  restore: () => void;
} {
  const calls: Recorded[] = [];
  const state: ProviderState = { adCreated: false, adActive: false };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (!url.startsWith("https://graph.facebook.com/")) {
      fail("provider double", `unexpected non-provider request to ${url}`);
    }
    // The write primitives send `URLSearchParams`, so the body is read through
    // its own serializer rather than assumed to be a string.
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : init?.body == null
            ? null
            : String(init.body);
    calls.push({ method, url, body });
    const path = new URL(url).pathname.split("/").filter(Boolean).slice(1).join("/");

    if (method === "POST" && path === `act_${ACCOUNT_NUMERIC}/ads`) {
      if (state.adCreated) {
        // A second create for the same launch would be the duplicate this seam
        // exists to disprove. Answering with a NEW id would hide it, so the
        // double refuses and the assertion below reads the call count anyway.
        fail("provider double", "a second ad create reached the provider");
      }
      state.adCreated = true;
      return json({ id: NEW_AD_ID });
    }
    if (method === "POST" && path === NEW_AD_ID) {
      state.adActive = true;
      return json({ success: true });
    }
    if (method === "GET") {
      const payload = providerPayloadFor(path, state);
      if (payload) return json(payload);
    }
    return json(
      { error: { code: 100, message: `unmapped provider path ${method} ${path}` } },
      400,
    );
  }) as typeof fetch;
  return { calls, state, restore: () => { globalThis.fetch = original; } };
}

// ---------------------------------------------------------------------------
// Fixtures: exactly the rows a real account has when a person has reviewed a
// winner's brief and composed the launch for it.
// ---------------------------------------------------------------------------
async function seed() {
  const db = getDb();
  await db.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1::uuid, 'Decision launch seam', 'decision-launch-seam@adsecute.local', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  await db.query(
    `INSERT INTO businesses (id, name, owner_id)
     VALUES ($1::uuid, 'Decision launch seam', $2::uuid)
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID, USER_ID],
  );
  await db.query(
    `INSERT INTO memberships (user_id, business_id, role, status)
     VALUES ($1::uuid, $2::uuid, 'admin', 'active')
     ON CONFLICT (user_id, business_id)
     DO UPDATE SET role = 'admin', status = 'active'`,
    [USER_ID, BUSINESS_ID],
  );
  /*
    A LIVE business, stated rather than defaulted: `dryRunOnly` ships as
    rehearsal and a create cannot be rehearsed, so an unstated control row would
    make this seam prove a refusal while claiming to prove a create.
  */
  await db.query(
    `INSERT INTO meta_automation_business_controls
       (business_id, kill_switch_engaged, auto_execution_enabled, readiness_tier,
        guardrails_json)
     VALUES ($1::uuid, FALSE, FALSE, 'manual_review', $2::jsonb)
     ON CONFLICT (business_id) DO UPDATE
       SET kill_switch_engaged = FALSE, guardrails_json = EXCLUDED.guardrails_json`,
    [BUSINESS_ID, JSON.stringify({ dryRunOnly: false })],
  );
  /*
    The standing creative mode. `semi_auto` is the only mode this producer
    stages under: the operator approves each queue row and supplies the
    confirmation the create requires, which is a confirmation the producer
    itself cannot give.
  */
  await db.query(
    `INSERT INTO meta_automation_decision_type_modes
       (business_id, decision_type, mode, updated_by)
     VALUES ($1::uuid, 'creative', 'semi_auto', $2::uuid)
     ON CONFLICT (business_id, decision_type)
     DO UPDATE SET mode = 'semi_auto'`,
    [BUSINESS_ID, USER_ID],
  );

  const accountRows = (await db.query(
    `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone)
     VALUES ('meta', $1, 'Decision launch seam account', 'USD', 'UTC')
     ON CONFLICT (provider, external_account_id)
     DO UPDATE SET account_name = EXCLUDED.account_name
     RETURNING id::text AS id`,
    [ACCOUNT_ID],
  )) as Array<{ id: string }>;
  await db.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
     VALUES ($1::uuid, 'meta', $2::uuid, $3, 0, TRUE)
     ON CONFLICT (business_id, provider, provider_account_ref_id)
     DO UPDATE SET is_selected = TRUE`,
    [BUSINESS_ID, accountRows[0]!.id, ACCOUNT_ID],
  );
  const connectionRows = (await db.query(
    `INSERT INTO provider_connections (business_id, provider, status, connection_generation)
     VALUES ($1::uuid, 'meta', 'connected', 1)
     ON CONFLICT (business_id, provider)
     DO UPDATE SET status = 'connected', connection_generation = 1
     RETURNING id::text AS id`,
    [BUSINESS_ID],
  )) as Array<{ id: string }>;
  await db.query(
    `INSERT INTO integration_credentials (provider_connection_id, access_token)
     VALUES ($1::uuid, $2)
     ON CONFLICT (provider_connection_id)
     DO UPDATE SET access_token = EXCLUDED.access_token`,
    [connectionRows[0]!.id, ACCESS_TOKEN],
  );

  // The winning creative, as the warehouse holds it: in this account, live, and
  // carrying the exact source ad a reuse duplicates.
  await db.query(
    `INSERT INTO meta_creative_dimensions
       (business_id, provider_account_id, creative_id, creative_name, ad_id)
     VALUES ($1::uuid, $2, $3, 'Winner — hero 9x16', $4)
     ON CONFLICT DO NOTHING`,
    [BUSINESS_ID, ACCOUNT_ID, WINNER_CREATIVE_ID, SOURCE_AD_ID],
  );
  await db.query(
    `INSERT INTO meta_creative_daily
       (business_id, provider_account_id, date, creative_id, creative_name,
        ad_id, effective_status, account_timezone, account_currency)
     VALUES ($1::uuid, $2, $3::date, $4, 'Winner — hero 9x16', $5, 'ACTIVE',
             'UTC', 'USD')
     ON CONFLICT DO NOTHING`,
    [BUSINESS_ID, ACCOUNT_ID, DECISION_AS_OF, WINNER_CREATIVE_ID, SOURCE_AD_ID],
  );
  // The destination the operator chose: a live campaign and a live ad set.
  await db.query(
    `INSERT INTO meta_campaign_dimensions
       (business_id, provider_account_id, campaign_id, campaign_name_current)
     VALUES ($1::uuid, $2, $3, 'Main · purchase')
     ON CONFLICT DO NOTHING`,
    [BUSINESS_ID, ACCOUNT_ID, TARGET_CAMPAIGN_ID],
  );
  await db.query(
    `INSERT INTO meta_adset_dimensions
       (business_id, provider_account_id, campaign_id, adset_id,
        adset_name_current, adset_status)
     VALUES ($1::uuid, $2, $3, $4, 'Broad · purchase', 'ACTIVE')
     ON CONFLICT DO NOTHING`,
    [BUSINESS_ID, ACCOUNT_ID, TARGET_CAMPAIGN_ID, TARGET_ADSET_ID],
  );

  const snapshots = (await db.query(
    `INSERT INTO engine_v3_decision_snapshots_daily (
       business_ref_id, business_id, creative_id, as_of_date, engine_version,
       scope_type, scope_id, label, confidence, truth_source,
       effective_target_roas, ratio_to_target, badges, reason
     ) VALUES (
       $1::uuid, $1, $2, $3::date, 'v3-decision-launch-seam',
       'account', $4, 'scale', 88, 'commercial_truth',
       2.2, 1.62, '[]'::jsonb, 'Sustained ROAS above target on a mature creative'
     ) RETURNING id::text AS id`,
    [BUSINESS_ID, WINNER_CREATIVE_ID, DECISION_AS_OF, ACCOUNT_ID],
  )) as Array<{ id: string }>;
  const snapshotId = snapshots[0]!.id;

  // The approval: a brief a named person reviewed, written against this exact
  // snapshot through the shipped contract parser and store.
  const brief = await createMetaCreativeBrief({
    request: parseCreateMetaCreativeBriefRequest({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      idempotencyKey: "decision-launch-seam-brief",
      sourceDecision: { snapshotId, trigger: "decision_card" },
      content: {
        keep: "Keep the opening product shot",
        change: "Nothing — this one is working",
        next: "Add it to the main purchase ad set",
      },
      status: "reviewed",
    }),
    createdBy: USER_ID,
  });

  // The exactness: the operator's own composed launch, through the shipped
  // draft store, naming this creative and this destination and nothing else.
  const draft = await upsertMetaLaunchDraft({
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT_ID,
    name: "Promote winner into Broad · purchase",
    payload: {
      mode: "add_to_existing",
      targetCampaignId: TARGET_CAMPAIGN_ID,
      targetAdsetId: TARGET_ADSET_ID,
      targetAdsetName: "Broad · purchase",
      copyMode: "reuse_creative",
      targets: [
        {
          targetCampaignId: TARGET_CAMPAIGN_ID,
          targetAdsetId: TARGET_ADSET_ID,
          targetAdsetName: "Broad · purchase",
        },
      ],
      creativeIds: [WINNER_CREATIVE_ID],
      creatives: [
        { creativeId: WINNER_CREATIVE_ID, sourceAdId: SOURCE_AD_ID, name: "Winner — hero 9x16" },
      ],
    },
    createdBy: USER_ID,
  });

  const session = await createSession({
    userId: USER_ID,
    activeBusinessId: BUSINESS_ID,
  });
  return { snapshotId, briefId: brief.brief.id, draftId: draft.id, token: session.token };
}

/**
 * Two more approved decisions whose launch is NOT fully approved.
 *
 * One has a reviewed brief and no composed launch at all — nobody has said
 * where the ad would go. The other has a composed launch naming a destination
 * that does not exist in this account. Neither may become an intent, and each
 * must say which of the three approvals is missing.
 */
async function seedUnstagedDecisions() {
  const db = getDb();
  const cases = [
    { creativeId: "2081000000302", sourceAdId: "2081000000402", withDraft: false },
    { creativeId: "2081000000303", sourceAdId: "2081000000403", withDraft: true },
  ] as const;
  for (const testCase of cases) {
    await db.query(
      `INSERT INTO meta_creative_dimensions
         (business_id, provider_account_id, creative_id, creative_name, ad_id)
       VALUES ($1::uuid, $2, $3, 'Runner-up', $4)
       ON CONFLICT DO NOTHING`,
      [BUSINESS_ID, ACCOUNT_ID, testCase.creativeId, testCase.sourceAdId],
    );
    const snapshot = (await db.query(
      `INSERT INTO engine_v3_decision_snapshots_daily (
         business_ref_id, business_id, creative_id, as_of_date, engine_version,
         scope_type, scope_id, label, confidence, truth_source,
         effective_target_roas, ratio_to_target, badges, reason
       ) VALUES (
         $1::uuid, $1, $2, $3::date, 'v3-decision-launch-seam',
         'account', $4, 'scale', 71, 'commercial_truth',
         2.2, 1.24, '[]'::jsonb, 'Above target on a second creative'
       ) RETURNING id::text AS id`,
      [BUSINESS_ID, testCase.creativeId, DECISION_AS_OF, ACCOUNT_ID],
    )) as Array<{ id: string }>;
    await createMetaCreativeBrief({
      request: parseCreateMetaCreativeBriefRequest({
        businessId: BUSINESS_ID,
        providerAccountId: ACCOUNT_ID,
        idempotencyKey: `decision-launch-seam-brief-${testCase.creativeId}`,
        sourceDecision: { snapshotId: snapshot[0]!.id, trigger: "decision_card" },
        content: { keep: "Keep it", change: "Nothing", next: "Consider promoting" },
        status: "reviewed",
      }),
      createdBy: USER_ID,
    });
    if (!testCase.withDraft) continue;
    await upsertMetaLaunchDraft({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      name: "Promote runner-up into an ad set that is not here",
      payload: {
        mode: "add_to_existing",
        targetCampaignId: "2081000000699",
        targetAdsetId: "2081000000799",
        copyMode: "reuse_creative",
        targets: [
          { targetCampaignId: "2081000000699", targetAdsetId: "2081000000799" },
        ],
        creativeIds: [testCase.creativeId],
        creatives: [
          { creativeId: testCase.creativeId, sourceAdId: testCase.sourceAdId },
        ],
      },
      createdBy: USER_ID,
    });
  }
}

// ---------------------------------------------------------------------------
// The shipped producers and the shipped routes.
// ---------------------------------------------------------------------------
async function stageIntents() {
  return projectMetaLaunchIntents({
    businessId: BUSINESS_ID,
    snapshotDate: SNAPSHOT_DATE,
  });
}

async function projectLaunchRows() {
  return projectMetaLaunchProposals({
    businessId: BUSINESS_ID,
    snapshotDate: SNAPSHOT_DATE,
    insertProposal: async (insert) =>
      insertLaunchProposalRow({
        candidate: insert.candidate,
        snapshotDate: SNAPSHOT_DATE,
        actionLabel: insert.actionLabel,
      }),
  });
}

async function projectActivationRows() {
  return projectMetaActivationProposals({
    businessId: BUSINESS_ID,
    snapshotDate: SNAPSHOT_DATE,
    insertProposal: async (insert) =>
      insertActivationProposalRow({
        candidate: insert.candidate,
        snapshotDate: SNAPSHOT_DATE,
        actionLabel: insert.actionLabel,
      }),
  });
}

async function approveProposal(input: { token: string; proposalId: string }) {
  const { POST } = await import("@/app/api/meta/automation/proposals/route");
  const url =
    `http://localhost/api/meta/automation/proposals`
    + `?businessId=${BUSINESS_ID}&providerAccountId=${ACCOUNT_ID}`;
  const request = new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${AUTH_COOKIE}=${input.token}`,
    },
    body: JSON.stringify({
      action: "approve",
      proposalId: input.proposalId,
      manualConfirmation: "explicit_operator_confirmation",
    }),
  });
  const response = await POST(request);
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return { status: response.status, body };
}

async function readProposals() {
  return (await getDb().query(
    `SELECT id::text AS id, proposed_action, origin, status, decision_key,
            scope_type, scope_id, entity_label, launch_intent_id::text AS launch_intent_id
       FROM meta_automation_proposals
      WHERE business_id = $1::uuid
      ORDER BY created_at, id`,
    [BUSINESS_ID],
  )) as Array<Record<string, unknown>>;
}

async function readIntents() {
  return (await getDb().query(
    `SELECT id::text AS id, status, requested_status, idempotency_key, operation,
            source_decision_id, source_decision_snapshot_id::text AS snapshot_id,
            creative_brief_id::text AS brief_id, source_draft_id::text AS draft_id,
            request_payload_json, result_receipt_json, activation_receipt_json
       FROM meta_launch_intents
      WHERE business_id = $1::uuid
      ORDER BY created_at, id`,
    [BUSINESS_ID],
  )) as Array<Record<string, unknown>>;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (databaseUrl.includes(":15432/") || databaseUrl.includes(":5432/")) {
    fail("port guard", "DATABASE_URL points at a protected port");
  }
  /*
    Both environment capabilities, stated rather than assumed. With either shut
    every route below answers a refusal and the chain could not be exercised at
    all — which is the correct production behaviour and is why they are named
    here instead of being left to whatever the shell happened to carry.
  */
  process.env.META_AUTOMATION_LIVE_WRITES = "true";
  process.env.META_LAUNCHPAD_EXECUTION = "true";

  const fixture = await seed();
  const provider = installProvider();
  try {
    // --------------------------------------------------- 0. the defect itself
    /*
      Before anything stages, the queue producer is run against a fully approved
      decision and finds NOTHING. That is R2 in one line: the `launch` row, its
      executor and its separately authorized activation all shipped, and no
      producer ever wrote the intent they select on, so the whole family was
      unreachable no matter how correct it was.
    */
    const beforeStaging = await projectLaunchRows();
    expectEqual(beforeStaging.candidates, 0, "no launch candidate before staging");
    expectEqual(
      (await readIntents()).length,
      0,
      "an approved decision alone stages nothing",
    );

    // ------------------------------------------------------------- 1. intent
    const staging = await stageIntents();
    expectEqual(staging.candidates, 1, "one eligible decision");
    expectEqual(staging.staged, 1, "one staged intent");
    expectEqual(staging.refusals, {}, "no refusal on the eligible decision");

    let intents = await readIntents();
    expectEqual(intents.length, 1, "exactly one persisted intent");
    const intent = intents[0]!;
    expectEqual(intent.status, "prepared", "intent rests prepared");
    expectEqual(intent.requested_status, "PAUSED", "PAUSED-only invariant");
    expectEqual(intent.operation, "add_to_existing", "creative reuse operation");
    expectEqual(intent.snapshot_id, fixture.snapshotId, "decision snapshot lineage");
    expectEqual(intent.brief_id, fixture.briefId, "reviewed brief lineage");
    expectEqual(intent.draft_id, fixture.draftId, "operator draft lineage");
    const payload = intent.request_payload_json as Record<string, unknown>;
    expectEqual(payload.targetAdsetId, TARGET_ADSET_ID, "the operator's destination");
    expectEqual(payload.creativeIds, [WINNER_CREATIVE_ID], "the decision's own creative");
    expectEqual(payload.copyMode, "reuse_creative", "approved copy is reused, not rebuilt");
    expectEqual(provider.calls.length, 0, "staging made no provider request");
    const intentId = String(intent.id);
    const firstIdempotencyKey = String(intent.idempotency_key);

    // -------------------------------------------------------- 2. queue row
    const launchRows = await projectLaunchRows();
    expectEqual(launchRows.candidates, 1, "one launch candidate");
    expectEqual(launchRows.projected, 1, "one launch row");
    let proposals = await readProposals();
    expectEqual(proposals.length, 1, "exactly one queue row");
    const launchRow = proposals[0]!;
    expectEqual(launchRow.proposed_action, "launch", "the row is a launch");
    expectEqual(launchRow.origin, "operator_action", "operator origin");
    expectEqual(launchRow.launch_intent_id, intentId, "the row points at the intent");
    expectEqual(launchRow.entity_label, "Broad · purchase", "the row names its destination");

    // ------------------------------------------ 3. the operator approves it
    const approval = await approveProposal({
      token: fixture.token,
      proposalId: String(launchRow.id),
    });
    if (approval.status !== 200 || approval.body?.ok !== true) {
      fail("launch approval", JSON.stringify(approval));
    }
    const adCreatePosts = provider.calls.filter(
      (call) => call.method === "POST" && call.url.includes(`act_${ACCOUNT_NUMERIC}/ads`),
    );
    expectEqual(adCreatePosts.length, 1, "exactly one provider ad create");
    if (!adCreatePosts[0]!.body?.includes(`adset_id=${TARGET_ADSET_ID}`)) {
      fail("create target", adCreatePosts[0]!.body ?? "no body");
    }
    if (!adCreatePosts[0]!.body?.includes("status=PAUSED")) {
      fail("create status", "the create did not ask for PAUSED");
    }

    intents = await readIntents();
    expectEqual(intents.length, 1, "still exactly one intent after the create");
    expectEqual(intents[0]!.status, "succeeded", "intent settled succeeded");
    const receipt = intents[0]!.result_receipt_json as {
      adIds?: string[];
    } | null;
    expectEqual(receipt?.adIds, [NEW_AD_ID], "durable creation receipt");

    // ------------------------------- 4. the separately authorized activation
    const activationRows = await projectActivationRows();
    expectEqual(activationRows.candidates, 1, "one activation candidate");
    expectEqual(activationRows.projected, 1, "one activation row");
    proposals = await readProposals();
    const activationRow = proposals.find(
      (row) => row.proposed_action === "resume",
    );
    if (!activationRow) fail("activation row", "no resume row was raised");
    expectEqual(
      activationRow.launch_intent_id,
      intentId,
      "the activation row names the same intent",
    );
    expectEqual(activationRow.scope_id, NEW_AD_ID, "it points at what was created");

    const activation = await approveProposal({
      token: fixture.token,
      proposalId: String(activationRow.id),
    });
    if (activation.status !== 200 || activation.body?.ok !== true) {
      fail("activation approval", JSON.stringify(activation));
    }
    intents = await readIntents();
    const activationReceipt = intents[0]!.activation_receipt_json as {
      delivering?: boolean;
      steps?: unknown[];
    } | null;
    if (!activationReceipt) fail("activation receipt", "nothing was recorded");
    expectEqual(activationReceipt.delivering, true, "the new ad is delivering");
    expectEqual(
      provider.calls.filter(
        (call) => call.method === "POST" && call.url.includes(`/${NEW_AD_ID}`),
      ).length,
      1,
      "one provider status write for the activation",
    );

    // --------------------------------------------------- 5. the rerun
    /*
      The whole point. A producer that stages from a decision is exactly the
      kind that can create one more ad on every tick, so the tick is run again
      against the same decision, the same brief and the same draft.
    */
    const createPostsBeforeRerun = provider.calls.filter(
      (call) => call.method === "POST" && call.url.includes(`act_${ACCOUNT_NUMERIC}/ads`),
    ).length;
    const restaging = await stageIntents();
    expectEqual(restaging.staged, 0, "the rerun stages no second intent");
    const rerunLaunchRows = await projectLaunchRows();
    expectEqual(rerunLaunchRows.projected, 0, "the rerun raises no second launch row");
    const rerunActivationRows = await projectActivationRows();
    expectEqual(
      rerunActivationRows.candidates,
      0,
      "a delivering launch is no longer an activation candidate",
    );

    intents = await readIntents();
    expectEqual(intents.length, 1, "still exactly one intent");
    expectEqual(intents[0]!.idempotency_key, firstIdempotencyKey, "same decision, same key");
    expectEqual(
      provider.calls.filter(
        (call) => call.method === "POST" && call.url.includes(`act_${ACCOUNT_NUMERIC}/ads`),
      ).length,
      createPostsBeforeRerun,
      "the rerun made no provider request at all",
    );
    proposals = await readProposals();
    expectEqual(proposals.length, 2, "still exactly two queue rows");

    // ------------------------------------------ 6. the refusals, on real SQL
    /*
      The binding constraint, proved rather than asserted: a decision whose
      approval is incomplete produces NO intent and a NAMED reason. Both cases
      go through the same producer, the same candidate query and the same
      shipped validator as the one that succeeded above.
    */
    await seedUnstagedDecisions();
    const refused = await stageIntents();
    expectEqual(refused.staged, 0, "no intent from an incomplete approval");
    expectEqual(
      /*
        Sorted, because the two decisions share an as-of date and the candidate
        query breaks that tie on a generated id — the ORDER of the refusals is
        not a fact worth pinning, only which ones were raised.

        One decision names a destination that is not in the account; the other
        has no composed launch at all, so nobody has said where its ad would go.
      */
      Object.entries(refused.refusals).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      [
        ["launch_payload_not_composed", 1],
        ["target_adset_not_found", 1],
      ],
      "each incomplete approval is refused by name",
    );
    expectEqual(
      (await readIntents()).length,
      1,
      "still exactly one intent after both refusals",
    );

    log(
      "PASS: an eligible decision with a reviewed brief and an operator-composed draft "
      + "stages one PAUSED launch intent, raises one launch row, creates exactly one "
      + "provider ad through the real approval route, activates it through a separate "
      + "approval, and reruns to no second intent, no second row and no second ad; "
      + "an approval missing its destination stages nothing and says which one is missing.",
    );
  } finally {
    provider.restore();
  }
  resetDbClientCache();
}

main().catch((error) => {
  console.error(error);
  try {
    resetDbClientCache();
  } catch {
    // Best-effort cleanup after the original seam failure.
  }
  process.exitCode = 1;
});
