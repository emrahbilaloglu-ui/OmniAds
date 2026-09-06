// Child of ephemeral-postgres-migrations-check. It runs only against the
// throwaway database URL force-set by the parent and never calls Meta.
//
// ── What only a database can answer here ──
//
// Two findings meet in this file. Activation used to take `adsetIds[0]` and
// `adIds[0]`, so a launch that created two ad sets and two ads was turned on as
// three entities and still reported `delivering: true`; and the stored approval
// that authorizes an unattended run was validated once, from the intent loaded
// at the top of the sequence, while the operator's own route could revoke it
// between two provider calls.
//
// The in-process cases drive the real activation over a provider double and
// prove the sequencing. What they cannot prove is the part that lives in
// Postgres: that the complete identity set survives the receipt's JSONB round
// trip with the parentage the plan reads off it, that one durable action-log
// row really is written per entity rather than per grain, that a five-identity
// activation receipt is readable back in full, and that a revocation persisted
// by the operator route's own writer is refused by the dispatch-time check
// reading the same row.
//
// ── And the window between the last question and the POST ──
//
// A third finding meets them. `activateHierarchy` asks `authorize`, and only
// then does the caller read the action log, write a durable claim, and hand the
// write to a primitive that takes its own atomic authority snapshot. Three
// awaits stand between the answer and the request, and the three resume
// primitives were called with no options at all — so an operator revoking
// inside any of those awaits was ignored for exactly one POST, which is one
// live campaign beginning to spend under a permission that no longer exists.
//
// The fix hands the same gate into each primitive's `beforeMutationAttempt`
// hook. That is only provable where the primitive really runs and the
// revocation is a real UPDATE the hook reads back, so the last section here
// drives `resumeCampaign` and `resumeAd` for real against an in-process
// provider double that refuses any request to a host other than the Graph API.
// Nothing in this process may reach Meta: the double is the only thing on the
// other side of `fetch`, and the assertions are about which requests it saw.
import { getDb, resetDbClientCache } from "@/lib/db";
import type { MetaAdsWriteContext } from "@/lib/meta/ads-write";
import {
  buildMetaLaunchIntentResultReceipt,
  buildMetaLaunchIntentValidationReceipt,
} from "@/lib/launchpad/meta-launch-intent";
import {
  createMetaLaunchIntent,
  getMetaLaunchIntent,
  markMetaLaunchIntentExecuting,
  recordMetaLaunchIntentActivation,
  recordMetaLaunchIntentActivationApproval,
  recordMetaLaunchIntentOutcome,
  recordMetaLaunchIntentValidation,
} from "@/lib/launchpad/meta-launch-intent-store";
import { parseCreateMetaCreativeBriefRequest } from "@/lib/meta/creative-brief-contract";
import { createMetaCreativeBrief } from "@/lib/meta/creative-brief-store";
import {
  buildActivationApproval,
  revokeActivationApproval,
  validateActivationApproval,
  type ActivationApproval,
} from "@/lib/meta/launch-activation-approval";
import {
  ACTIVATION_POLICY_VERSION,
  activateLaunchIntent,
  activationPlanForIntent,
  defaultActivationJournal,
  LAUNCH_ACTIVATION_RECEIPT_CONTRACT,
} from "@/lib/meta/launch-intent-activation";
import type { ActivationGrain } from "@/lib/meta/hierarchy-activation";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";

function expectEqual(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `activation-identity seam FAILED [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const ACCOUNT = "act_activation_identity_seam";
const CAMPAIGN = "camp_ai_seam_1";
const ADSETS = ["set_ai_seam_1", "set_ai_seam_2"];
const ADS = ["ad_ai_seam_1", "ad_ai_seam_2"];

/*
  The account the write primitives are driven against.

  Numeric, because `normalizeProviderAccountId` reduces an account id to its
  digits and refuses anything that has none — the identity fixture's descriptive
  id above never reaches a provider, and this one has to.
*/
const HOOK_ACCOUNT = "act_9012345";
const HOOK_TOKEN = "activation-identity-seam-token";
const HOOK_CONNECTION_GENERATION = "1:connected";
const HOOK_CAMPAIGN = "camp_hook_seam_1";
const HOOK_ADSET = "set_hook_seam_1";
const HOOK_CAMPAIGN_AD = "ad_hook_seam_1";
/** The live structure an add-to-existing launch joins, and the ad it added. */
const LIVE_CAMPAIGN = "camp_hook_live_1";
const LIVE_ADSET = "set_hook_live_1";
const HOOK_OK_AD = "ad_hook_ok_1";
const HOOK_PREFLIGHT_AD = "ad_hook_preflight_1";
const HOOK_CREATIVE = "activation_identity_creative_1";

async function seedFixture() {
  const db = getDb();
  const users = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash)
     VALUES ('Activation Identity Seam', 'activation-identity-seam@example.test', 'x')
     RETURNING id::text AS id`,
  );
  const businesses = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, owner_id)
     VALUES ('Activation Identity Seam Business', $1::uuid)
     RETURNING id::text AS id`,
    [users[0]!.id],
  );
  const businessId = businesses[0]!.id;
  const userId = users[0]!.id;

  await db.query(
    `INSERT INTO meta_creative_dimensions (
       business_id, provider_account_id, creative_id, creative_name
     ) VALUES ($1, $2, 'activation_identity_creative_1', 'Seam source creative')`,
    [businessId, ACCOUNT],
  );
  const snapshots = await db.query<{ id: string }>(
    `INSERT INTO engine_v3_decision_snapshots_daily (
       business_ref_id, business_id, creative_id, as_of_date,
       engine_version, scope_type, scope_id, label, raw_label,
       confidence, truth_source, effective_target_roas, ratio_to_target,
       badges, reason
     ) VALUES (
       $1::uuid, $1, 'activation_identity_creative_1', '2026-07-10'::date,
       'v3-activation-identity-seam', 'account', '*', 'scale', 'scale',
       82, 'commercial_truth', 2.5, 1.31, '[]'::jsonb,
       'Verified launch lineage'
     ) RETURNING id::text AS id`,
    [businessId],
  );
  const brief = await createMetaCreativeBrief({
    request: parseCreateMetaCreativeBriefRequest({
      businessId,
      providerAccountId: ACCOUNT,
      idempotencyKey: "activation-identity-seam-brief",
      sourceDecision: {
        snapshotId: snapshots[0]!.id,
        trigger: "activation_identity_seam",
      },
      content: {
        keep: "Keep the product proof",
        change: "Change the opening hook",
        next: "Test a shorter opening",
      },
      status: "reviewed",
    }),
    createdBy: userId,
  });
  return { businessId, userId, briefId: brief.brief.id };
}

async function main() {
  if (
    process.env.DATABASE_URL?.includes(":15432/") ||
    process.env.DATABASE_URL?.includes(":5432/")
  ) {
    throw new Error(
      "activation-identity seam refused: DATABASE_URL points at a protected port",
    );
  }
  const fixture = await seedFixture();

  /*
    A launch that made two ad sets and, under each, one ad.

    The `steps` array is the create runtime's own shape — an `adset` step, then
    the ads created inside that ad set's loop — and it is the ONLY record of
    which ad set an ad belongs to. Whether that survives a JSONB round trip is
    exactly the question this file exists to answer.
  */
  const created = await createMetaLaunchIntent({
    businessId: fixture.businessId,
    providerAccountId: ACCOUNT,
    operation: "new_campaign",
    idempotencyKey: "activation-identity-seam-create-1",
    requestPayload: {
      campaign: { name: "Seam campaign", status: "PAUSED" },
      creatives: [{ creativeId: "activation_identity_creative_1" }],
      adSets: [{ name: "Broad" }, { name: "Interest" }],
    },
    creativeBriefId: fixture.briefId,
    createdBy: fixture.userId,
  });
  await recordMetaLaunchIntentValidation({
    businessId: fixture.businessId,
    id: created.intent.id,
    receipt: buildMetaLaunchIntentValidationReceipt({
      providerAccountId: ACCOUNT, ok: true, blockers: [], warnings: [],
    }),
  });
  await markMetaLaunchIntentExecuting({
    businessId: fixture.businessId,
    id: created.intent.id,
  });
  await recordMetaLaunchIntentOutcome({
    businessId: fixture.businessId,
    id: created.intent.id,
    status: "succeeded",
    resultReceipt: buildMetaLaunchIntentResultReceipt({
      providerAccountId: ACCOUNT,
      campaignId: CAMPAIGN,
      adsetIds: [...ADSETS],
      adIds: [...ADS],
      steps: [
        { kind: "campaign", index: 0, status: "success", id: CAMPAIGN },
        { kind: "adset", index: 0, status: "success", id: ADSETS[0] },
        { kind: "ad", index: 0, status: "success", id: ADS[0] },
        { kind: "adset", index: 1, status: "success", id: ADSETS[1] },
        { kind: "ad", index: 1, status: "success", id: ADS[1] },
      ],
    }),
  });

  // ── The plan, built from the row as Postgres returns it ──
  const persisted = await getMetaLaunchIntent({
    businessId: fixture.businessId,
    id: created.intent.id,
  });
  if (!persisted) {
    throw new Error("activation-identity seam FAILED [reread]: intent not found");
  }
  expectEqual(
    activationPlanForIntent(persisted),
    [
      { grain: "campaign", entityId: CAMPAIGN },
      { grain: "adset", entityId: ADSETS[0], parentEntityId: CAMPAIGN },
      { grain: "adset", entityId: ADSETS[1], parentEntityId: CAMPAIGN },
      // Read off the stored step ordering: each ad under the ad set that made
      // it, so a blocked ad set stops its own ad and not the sibling's.
      { grain: "ad", entityId: ADS[0], parentEntityId: ADSETS[0] },
      { grain: "ad", entityId: ADS[1], parentEntityId: ADSETS[1] },
    ],
    "complete identity set survives the receipt round trip",
  );

  /*
    ── One durable row per entity, not one per grain ──

    The old plan reached three entities, so History could only ever show three
    rows for a five-entity launch. These are the real claims, in the real table.
  */
  const plan = activationPlanForIntent(persisted);
  const claims: string[] = [];
  for (const target of plan) {
    const claim = await defaultActivationJournal.claim({
      businessId: fixture.businessId,
      providerAccountId: ACCOUNT,
      entityId: target.entityId,
      grain: target.grain,
      launchIntentId: created.intent.id,
      operatorUserId: fixture.userId,
      observed: { status: "PAUSED", effectiveStatus: "PAUSED" },
    });
    if (!claim) {
      throw new Error(
        `activation-identity seam FAILED [claim ${target.entityId}]: no row written`,
      );
    }
    claims.push(claim.id);
  }
  const rows = await getDb().query<{ ad_id: string; scope_type: string | null }>(
    `SELECT ad_id, payload_request->>'scope_type' AS scope_type
     FROM meta_ads_action_log
     WHERE launch_intent_id = $1::uuid
       AND source = 'launch_activation_v1'
     ORDER BY created_at, ad_id`,
    [created.intent.id],
  );
  expectEqual(
    rows.map((row) => [row.ad_id, row.scope_type]),
    [
      [CAMPAIGN, "campaign"],
      [ADSETS[0], "adset"],
      [ADSETS[1], "adset"],
      [ADS[0], "ad"],
      [ADS[1], "ad"],
    ],
    "one journalled row per identity",
  );

  // The second ad set refuses; everything else comes on. That is a partial
  // activation, and the rows have to say so entity by entity.
  const settlements: Array<"activated" | "refused"> = [
    "activated", "activated", "refused", "activated", "refused",
  ];
  for (const [index, claimId] of claims.entries()) {
    await defaultActivationJournal.settle({
      id: claimId,
      outcome: settlements[index]!,
      reason: settlements[index] === "refused" ? "adset_in_review" : null,
      durationMs: 7,
    });
  }
  const settled = await getDb().query<{ ad_id: string; status: string }>(
    `SELECT ad_id, status
     FROM meta_ads_action_log
     WHERE launch_intent_id = $1::uuid
       AND source = 'launch_activation_v1'
     ORDER BY created_at, ad_id`,
    [created.intent.id],
  );
  expectEqual(
    settled.map((row) => [row.ad_id, row.status]),
    [
      [CAMPAIGN, "success"],
      [ADSETS[0], "success"],
      [ADSETS[1], "failure"],
      [ADS[0], "success"],
      [ADS[1], "failure"],
    ],
    "each identity settles on its own",
  );

  /*
    ── The receipt accounts for all five, and reads back that way ──

    A reload used to make a half-activated hierarchy look like one nobody had
    touched. With several ad sets it was worse: the receipt did not even name
    the entities that had never been considered.
  */
  const steps = plan.map((target, index) => ({
    grain: target.grain as ActivationGrain,
    entityId: target.entityId,
    outcome: settlements[index] === "activated"
      ? ("activated" as const)
      : index === 2 ? ("blocked" as const) : ("not_attempted" as const),
    reason: settlements[index] === "activated"
      ? null
      : index === 2 ? "adset_in_review" : "blocked_at_adset",
    verified: null,
    actionLogId: claims[index]!,
    claimOutcome: settlements[index] === "activated"
      ? ("activated" as const)
      : ("refused" as const),
  }));
  await recordMetaLaunchIntentActivation({
    businessId: fixture.businessId,
    id: created.intent.id,
    receipt: {
      contract: LAUNCH_ACTIVATION_RECEIPT_CONTRACT,
      intentId: created.intent.id,
      authorization: "operator",
      operatorUserId: fixture.userId,
      recordedAt: "2026-09-05T11:00:00.000Z",
      delivering: false,
      partial: true,
      coverage: { planned: 5, on: 3, blocked: 1, ambiguous: 0, notAttempted: 1 },
      blockedAt: "adset",
      blockedReason: "adset_in_review",
      steps,
    },
  });
  const withReceipt = await getMetaLaunchIntent({
    businessId: fixture.businessId,
    id: created.intent.id,
  });
  const stored = withReceipt?.activationReceipt as {
    delivering?: boolean;
    partial?: boolean;
    coverage?: Record<string, number>;
    steps?: Array<{ entityId: string; outcome: string }>;
  } | null;
  expectEqual(stored?.delivering, false, "a partial run is not delivering");
  expectEqual(stored?.partial, true, "and it says partial rather than failed");
  /*
    Field by field, because `jsonb` does not keep the key order it was given —
    it stores an object, not the text of one. Comparing serialized documents
    here would fail on an ordering the column never promised.
  */
  for (const [key, expected] of Object.entries({
    planned: 5, on: 3, blocked: 1, ambiguous: 0, notAttempted: 1,
  })) {
    expectEqual(stored?.coverage?.[key], expected, `coverage.${key} round trip`);
  }
  expectEqual(
    stored?.steps?.map((step) => [step.entityId, step.outcome]),
    [
      [CAMPAIGN, "activated"],
      [ADSETS[0], "activated"],
      [ADSETS[1], "blocked"],
      [ADS[0], "activated"],
      [ADS[1], "not_attempted"],
    ],
    "every identity is accounted for in the durable receipt",
  );

  /*
    ── The approval, written and then withdrawn, in the real column ──

    An unattended run's whole authority is this document, and the operator's own
    route can rewrite it while a sequence is in flight. What has to be true in
    the database is that the writer's shape is one the dispatch-time validator
    accepts, and that a persisted revocation is refused by the same check when
    the row is read again.
  */
  const identities = {
    campaignId: CAMPAIGN,
    // Both ad sets and both creatives: the document names sets, and a launch
    // whose second ad set went unnamed is exactly the hole that shape closes.
    adsetIds: [...ADSETS],
    adIds: [...ADS],
    creativeIds: [
      "activation_identity_creative_1",
      "activation_identity_creative_2",
    ],
  };
  const facts = {
    id: persisted.id,
    businessId: persisted.businessId,
    providerAccountId: persisted.providerAccountId,
    operation: persisted.operation,
    requestFingerprint: persisted.requestFingerprint,
  };
  const built = buildActivationApproval({
    intent: facts,
    identities,
    approvedScope: "hierarchy",
    approvedBy: fixture.userId,
    approvedAt: "2026-09-05T10:00:00.000Z",
    expiresAt: "2126-09-05T10:00:00.000Z",
    approvedAssetVersion: "v1",
    approvedCopyHash: "c".repeat(64),
    policyVersion: ACTIVATION_POLICY_VERSION,
  });
  if (!built.ok) {
    throw new Error(
      `activation-identity seam FAILED [approval build]: ${built.refusal}`,
    );
  }
  await recordMetaLaunchIntentActivationApproval({
    businessId: fixture.businessId,
    id: created.intent.id,
    approval: built.approval,
  });
  const approved = await getMetaLaunchIntent({
    businessId: fixture.businessId,
    id: created.intent.id,
  });
  expectEqual(
    validateActivationApproval({
      stored: approved?.activationApproval,
      intent: facts,
      identities,
      policyVersion: ACTIVATION_POLICY_VERSION,
      now: new Date("2026-09-05T12:00:00.000Z"),
    }).approved,
    true,
    "the persisted approval is one the dispatch check accepts",
  );

  // The operator withdraws it. The write sets `revokedAt` rather than clearing
  // the column, so the record still says who approved what.
  await recordMetaLaunchIntentActivationApproval({
    businessId: fixture.businessId,
    id: created.intent.id,
    approval: revokeActivationApproval(
      approved?.activationApproval as ActivationApproval,
      "2026-09-05T12:30:00.000Z",
    ),
  });
  const revoked = await getMetaLaunchIntent({
    businessId: fixture.businessId,
    id: created.intent.id,
  });
  expectEqual(
    (revoked?.activationApproval as { approvedBy?: string })?.approvedBy,
    fixture.userId,
    "a withdrawn approval still records who gave it",
  );
  /*
    And the production entry point refuses it, reading the row itself.

    This is the only direction `activateLaunchIntent` can be driven here: it
    refuses before composing a plan, so no provider is contacted — which is
    also exactly what the per-step re-read does when the same document is
    withdrawn between two steps of an in-flight sequence.
  */
  const refused = await activateLaunchIntent({
    intent: revoked!,
    ctx: {} as never,
    authorization: { kind: "scheduled" },
    reloadIntent: async () =>
      getMetaLaunchIntent({ businessId: fixture.businessId, id: created.intent.id }),
  });
  expectEqual(
    refused,
    { ok: false, refusal: "activation_approval_revoked" },
    "a persisted revocation refuses an unattended run",
  );

  /*
    ── An approval that covers less than the launch produced ──

    The document that used to ship named ONE creative and ONE ad set, so a
    launch built from two of each was either refused outright or activated
    under an authorization that never mentioned half of it. The set form makes
    the question answerable, and this is the answer: containment is checked
    against what the receipt says exists, so an approval missing the second
    creative refuses by name instead of covering it silently.
  */
  const narrowBuilt = buildActivationApproval({
    intent: facts,
    identities: { ...identities, creativeIds: [identities.creativeIds[0]!] },
    approvedScope: "hierarchy",
    approvedBy: fixture.userId,
    approvedAt: "2026-09-05T10:00:00.000Z",
    expiresAt: "2126-09-05T10:00:00.000Z",
    approvedAssetVersion: "v1",
    approvedCopyHash: "c".repeat(64),
    policyVersion: ACTIVATION_POLICY_VERSION,
  });
  if (!narrowBuilt.ok) {
    throw new Error(
      `activation-identity seam FAILED [narrow approval build]: ${narrowBuilt.refusal}`,
    );
  }
  await recordMetaLaunchIntentActivationApproval({
    businessId: fixture.businessId,
    id: created.intent.id,
    approval: narrowBuilt.approval,
  });
  const narrowStored = await getMetaLaunchIntent({
    businessId: fixture.businessId,
    id: created.intent.id,
  });
  expectEqual(
    validateActivationApproval({
      stored: narrowStored?.activationApproval,
      intent: facts,
      identities,
      policyVersion: ACTIVATION_POLICY_VERSION,
      now: new Date("2026-09-05T12:00:00.000Z"),
    }),
    { approved: false, refusal: "activation_approval_asset_mismatch" },
    "an approval naming one of the two creatives is refused, not stretched",
  );
  expectEqual(
    validateActivationApproval({
      stored: narrowStored?.activationApproval,
      intent: facts,
      identities: { ...identities, creativeIds: [identities.creativeIds[0]!] },
      policyVersion: ACTIVATION_POLICY_VERSION,
      now: new Date("2026-09-05T12:00:00.000Z"),
    }).approved,
    true,
    "and the same document still covers the launch it does name",
  );

  await proveProviderBoundaryHook(fixture);

  console.log(
    "[activation-identity-seam] PASS: complete identity set with parentage survives the receipt round trip, one journalled row per entity settles independently, a five-identity partial receipt reads back with its counts, a persisted approval is accepted then refused once withdrawn, an approval naming fewer creatives than the launch produced is refused by name, and — driving the real resume primitives against a provider double — a revocation committed during the journal claim or inside the primitive's own preflight yields zero POSTs, a settled `failure` row naming the code, and no unresolved prior attempt left behind.",
  );
  resetDbClientCache();
}

// ---------------------------------------------------------------------------
// The provider boundary: the real primitives, a real revocation, zero POSTs.
// ---------------------------------------------------------------------------

type EntityState = { status: string; effective: string };

/**
 * Everything on the other side of `fetch`, and nothing else.
 *
 * Any request to a host other than the Graph API throws rather than escaping:
 * this process must never reach Meta, and a double that quietly forwarded one
 * would make every assertion below meaningless.
 */
function installProviderDouble(input: {
  campaigns: Map<string, EntityState>;
  adsets: Map<string, EntityState>;
  ads: Map<string, EntityState>;
  adParents: Map<string, { adsetId: string; campaignId: string; creativeId: string }>;
  /**
   * Fired on every GET, with how many times that entity has been read.
   *
   * This is what makes the preflight window expressible: the sequence reads an
   * entity once to decide whether to send anything, and the write primitive
   * reads it again as its own preflight — the second read is strictly after
   * `authorize` answered and after the durable claim was written.
   */
  onGet?: (path: string, seen: number) => Promise<void>;
}) {
  const original = globalThis.fetch;
  const requests: string[] = [];
  const posts: string[] = [];
  const seenByPath = new Map<string, number>();
  const numericAccount = HOOK_ACCOUNT.replace(/[^0-9]/g, "");

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });

  const readEntity = (path: string): Record<string, unknown> | null => {
    const campaign = input.campaigns.get(path);
    if (campaign) {
      return {
        id: path,
        account_id: numericAccount,
        status: campaign.status,
        effective_status: campaign.effective,
      };
    }
    const adset = input.adsets.get(path);
    if (adset) {
      return {
        id: path,
        account_id: numericAccount,
        status: adset.status,
        effective_status: adset.effective,
        campaign: { id: HOOK_CAMPAIGN },
      };
    }
    const ad = input.ads.get(path);
    if (!ad) return null;
    const parent = input.adParents.get(path);
    if (!parent) return null;
    const parentAdset = input.adsets.get(parent.adsetId);
    const parentCampaign = input.campaigns.get(parent.campaignId);
    if (!parentAdset || !parentCampaign) return null;
    return {
      id: path,
      account_id: numericAccount,
      status: ad.status,
      effective_status: ad.effective,
      creative: { id: parent.creativeId },
      adset: {
        id: parent.adsetId,
        status: parentAdset.status,
        effective_status: parentAdset.effective,
      },
      campaign: {
        id: parent.campaignId,
        status: parentCampaign.status,
        effective_status: parentCampaign.effective,
      },
    };
  };

  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = String(target);
    if (!url.startsWith("https://graph.facebook.com/")) {
      throw new Error(
        `activation-identity seam refused a non-provider request to ${url}`,
      );
    }
    const method = (init?.method ?? "GET").toUpperCase();
    // Drop the Graph API version segment; what is asserted is the entity path.
    const path = new URL(url).pathname.split("/").filter(Boolean).slice(1).join("/");
    requests.push(`${method} ${path}`);

    if (method === "POST") {
      posts.push(path);
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(String(init?.body ?? ""));
      const status = body.get("status") ?? "";
      const next: EntityState = { status, effective: status };
      if (input.campaigns.has(path)) input.campaigns.set(path, next);
      else if (input.adsets.has(path)) input.adsets.set(path, next);
      else if (input.ads.has(path)) input.ads.set(path, next);
      else return json({ error: { code: 100, message: `unmapped ${path}` } }, 400);
      return json({ success: true });
    }

    const seen = (seenByPath.get(path) ?? 0) + 1;
    seenByPath.set(path, seen);
    if (input.onGet) await input.onGet(path, seen);
    const payload = readEntity(path);
    if (!payload) return json({ error: { code: 100, message: `unmapped ${path}` } }, 400);
    return json(payload);
  }) as typeof fetch;

  return {
    requests,
    posts,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Everything a real provider write checks before it will send anything. */
async function seedWriteAuthority(businessId: string) {
  const db = getDb();
  const accounts = await db.query<{ id: string }>(
    `INSERT INTO provider_accounts (provider, external_account_id, account_name)
     VALUES ('meta', $1, 'Activation hook seam account')
     ON CONFLICT (provider, external_account_id)
     DO UPDATE SET account_name = EXCLUDED.account_name
     RETURNING id::text AS id`,
    [HOOK_ACCOUNT],
  );
  await db.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id,
        position, is_selected)
     VALUES ($1::uuid, 'meta', $2::uuid, $3, 0, TRUE)
     ON CONFLICT (business_id, provider, provider_account_ref_id)
     DO UPDATE SET is_selected = TRUE`,
    [businessId, accounts[0]!.id, HOOK_ACCOUNT],
  );
  const connections = await db.query<{ id: string }>(
    `INSERT INTO provider_connections (business_id, provider, status, connection_generation)
     VALUES ($1::uuid, 'meta', 'connected', 1)
     ON CONFLICT (business_id, provider)
     DO UPDATE SET status = 'connected', connection_generation = 1
     RETURNING id::text AS id`,
    [businessId],
  );
  await db.query(
    `INSERT INTO integration_credentials (provider_connection_id, access_token)
     VALUES ($1::uuid, $2)
     ON CONFLICT (provider_connection_id)
     DO UPDATE SET access_token = EXCLUDED.access_token`,
    [connections[0]!.id, HOOK_TOKEN],
  );
  /*
    The write choke point fails closed with no persisted control row, and
    rehearsal is the shipped default. Both are stated rather than inherited:
    this seam is about which requests the boundary allows, and a business
    parked in rehearsal would prove a refusal while claiming to prove a POST.
  */
  await db.query(
    `INSERT INTO meta_automation_business_controls
       (business_id, kill_switch_engaged, auto_execution_enabled, readiness_tier,
        guardrails_json)
     VALUES ($1::uuid, FALSE, FALSE, 'manual_review', $2::jsonb)
     ON CONFLICT (business_id) DO UPDATE
       SET kill_switch_engaged = FALSE,
           readiness_tier = 'manual_review',
           guardrails_json = EXCLUDED.guardrails_json`,
    [businessId, JSON.stringify({ dryRunOnly: false })],
  );
}

/** A succeeded intent with the identities a launch really produced. */
async function seedHookIntent(input: {
  businessId: string;
  userId: string;
  idempotencyKey: string;
  operation: "new_campaign" | "add_to_existing";
  campaignId: string;
  adsetIds: string[];
  adIds: string[];
}) {
  const created = await createMetaLaunchIntent({
    businessId: input.businessId,
    providerAccountId: HOOK_ACCOUNT,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    requestPayload: {
      campaign: { name: `Hook seam ${input.idempotencyKey}`, status: "PAUSED" },
      creatives: [{ creativeId: HOOK_CREATIVE }],
    },
    createdBy: input.userId,
  });
  await recordMetaLaunchIntentValidation({
    businessId: input.businessId,
    id: created.intent.id,
    receipt: buildMetaLaunchIntentValidationReceipt({
      providerAccountId: HOOK_ACCOUNT, ok: true, blockers: [], warnings: [],
    }),
  });
  await markMetaLaunchIntentExecuting({
    businessId: input.businessId,
    id: created.intent.id,
  });
  await recordMetaLaunchIntentOutcome({
    businessId: input.businessId,
    id: created.intent.id,
    status: "succeeded",
    resultReceipt: buildMetaLaunchIntentResultReceipt({
      providerAccountId: HOOK_ACCOUNT,
      campaignId: input.campaignId,
      adsetIds: [...input.adsetIds],
      adIds: [...input.adIds],
      steps: [
        { kind: "campaign", index: 0, status: "success", id: input.campaignId },
        ...input.adsetIds.map((id, index) => ({
          kind: "adset", index, status: "success", id,
        })),
        ...input.adIds.map((id, index) => ({
          kind: "ad", index, status: "success", id,
        })),
      ],
    }),
  });
  const persisted = await getMetaLaunchIntent({
    businessId: input.businessId,
    id: created.intent.id,
  });
  if (!persisted) {
    throw new Error(
      `activation-identity seam FAILED [hook intent ${input.idempotencyKey}]: not readable`,
    );
  }
  return persisted;
}

/** Write the approval the unattended run acts under, through the real writer. */
async function approveHookIntent(input: {
  businessId: string;
  intent: MetaLaunchIntent;
  approvedBy: string;
  approvedScope: "ad" | "hierarchy";
}) {
  const receipt = input.intent.resultReceipt!;
  const built = buildActivationApproval({
    intent: {
      id: input.intent.id,
      businessId: input.intent.businessId,
      providerAccountId: input.intent.providerAccountId,
      operation: input.intent.operation,
      requestFingerprint: input.intent.requestFingerprint,
    },
    identities: {
      campaignId: receipt.campaignId,
      adsetIds: receipt.adsetIds ?? [],
      adIds: receipt.adIds ?? [],
      creativeIds: [HOOK_CREATIVE],
    },
    approvedScope: input.approvedScope,
    approvedBy: input.approvedBy,
    approvedAt: "2026-09-05T10:00:00.000Z",
    expiresAt: "2126-09-05T10:00:00.000Z",
    approvedAssetVersion: "v1",
    approvedCopyHash: "d".repeat(64),
    policyVersion: ACTIVATION_POLICY_VERSION,
  });
  if (!built.ok) {
    throw new Error(
      `activation-identity seam FAILED [hook approval]: ${built.refusal}`,
    );
  }
  await recordMetaLaunchIntentActivationApproval({
    businessId: input.businessId,
    id: input.intent.id,
    approval: built.approval,
  });
}

/** The operator's own withdrawal, committed to the row mid-sequence. */
async function revokeHookApproval(businessId: string, intentId: string) {
  const current = await getMetaLaunchIntent({ businessId, id: intentId });
  await recordMetaLaunchIntentActivationApproval({
    businessId,
    id: intentId,
    approval: revokeActivationApproval(
      current!.activationApproval as ActivationApproval,
      new Date().toISOString(),
    ),
  });
}

async function actionLogRowsFor(intentId: string) {
  return getDb().query<{
    ad_id: string;
    status: string;
    error_code: string | null;
  }>(
    `SELECT ad_id, status, error_code
     FROM meta_ads_action_log
     WHERE launch_intent_id = $1::uuid
       AND source = 'launch_activation_v1'
     ORDER BY created_at, ad_id`,
    [intentId],
  );
}

async function proveProviderBoundaryHook(fixture: {
  businessId: string;
  userId: string;
}) {
  /*
    The environment capability, opened deliberately for this seam.

    With it shut, `getMetaAdsWriteBlockFailure` answers `release_capability_closed`
    before the pre-POST hook is ever reached — so every case below would pass for
    the wrong reason and prove nothing about the hook.
  */
  process.env.META_AUTOMATION_LIVE_WRITES = "true";
  await seedWriteAuthority(fixture.businessId);

  const ctx: MetaAdsWriteContext = {
    businessId: fixture.businessId,
    providerAccountId: HOOK_ACCOUNT,
    accessToken: HOOK_TOKEN,
    connectionGeneration: HOOK_CONNECTION_GENERATION,
  };

  /*
    ── Case A: the revocation lands DURING the journal claim ──

    `authorize` has already answered. The claim is a durable write, and the
    operator's route commits the withdrawal while it is in flight. Before the
    hook existed the campaign was POSTed anyway — one live campaign, spending,
    under a permission that had been withdrawn before the request was built.
  */
  const claimIntent = await seedHookIntent({
    businessId: fixture.businessId,
    userId: fixture.userId,
    idempotencyKey: "activation-hook-claim-window",
    operation: "new_campaign",
    campaignId: HOOK_CAMPAIGN,
    adsetIds: [HOOK_ADSET],
    adIds: [HOOK_CAMPAIGN_AD],
  });
  await approveHookIntent({
    businessId: fixture.businessId,
    intent: claimIntent,
    approvedBy: fixture.userId,
    approvedScope: "hierarchy",
  });
  const approvedClaimIntent = (await getMetaLaunchIntent({
    businessId: fixture.businessId,
    id: claimIntent.id,
  }))!;

  const claimDouble = installProviderDouble({
    campaigns: new Map([[HOOK_CAMPAIGN, { status: "PAUSED", effective: "PAUSED" }]]),
    adsets: new Map([[HOOK_ADSET, { status: "PAUSED", effective: "PAUSED" }]]),
    ads: new Map([[HOOK_CAMPAIGN_AD, { status: "PAUSED", effective: "PAUSED" }]]),
    adParents: new Map([
      [HOOK_CAMPAIGN_AD, {
        adsetId: HOOK_ADSET, campaignId: HOOK_CAMPAIGN, creativeId: HOOK_CREATIVE,
      }],
    ]),
  });
  let claimResult;
  try {
    claimResult = await activateLaunchIntent({
      intent: approvedClaimIntent,
      ctx,
      authorization: { kind: "scheduled" },
      reloadIntent: () =>
        getMetaLaunchIntent({ businessId: fixture.businessId, id: claimIntent.id }),
      journal: {
        ...defaultActivationJournal,
        // The real claim, and then the real UPDATE — in that order, inside the
        // one await the entry gate and the per-step gate both stand in front of.
        claim: async (claimInput) => {
          const row = await defaultActivationJournal.claim(claimInput);
          await revokeHookApproval(fixture.businessId, claimIntent.id);
          return row;
        },
      },
    });
  } finally {
    claimDouble.restore();
  }

  if (!claimResult.ok) {
    throw new Error(
      `activation-identity seam FAILED [claim window]: refused as ${claimResult.refusal}`,
    );
  }
  expectEqual(claimDouble.posts, [], "no POST after a revocation during the claim");
  expectEqual(
    claimDouble.requests,
    [`GET ${HOOK_CAMPAIGN}`],
    "only the sequence's own read-back reached the provider",
  );
  expectEqual(
    [claimResult.activation.blockedAt, claimResult.activation.blockedReason],
    ["campaign", "activation_approval_revoked"],
    "the refusal names the withdrawn authority",
  );
  expectEqual(
    claimResult.activation.coverage,
    { planned: 3, on: 0, blocked: 1, ambiguous: 0, notAttempted: 2 },
    "nothing is on, and the run halted rather than trying the siblings",
  );
  expectEqual(
    claimResult.receipt.steps.map((step) => [step.entityId, step.outcome, step.claimOutcome]),
    [
      [HOOK_CAMPAIGN, "blocked", "authority_refused"],
      [HOOK_ADSET, "not_attempted", null],
      [HOOK_CAMPAIGN_AD, "not_attempted", null],
    ],
    "the receipt says the authority refused rather than that a provider did",
  );
  /*
    And the claimed row is SETTLED, in the real table.

    A row left `pending` is this table's statement that a call may be in flight;
    `findUnresolvedMetaAdStatusActionLog` reads exactly that and would block the
    next honest attempt on an entity nothing has written to.
  */
  expectEqual(
    (await actionLogRowsFor(claimIntent.id)).map((row) => [
      row.ad_id, row.status, row.error_code,
    ]),
    [[HOOK_CAMPAIGN, "failure", "activation_approval_revoked"]],
    "the claim settles as a definite non-write naming the code",
  );
  expectEqual(
    await defaultActivationJournal.findUnresolved({
      businessId: fixture.businessId,
      providerAccountId: HOOK_ACCOUNT,
      entityId: HOOK_CAMPAIGN,
    }),
    null,
    "the no-blind-retry gate reads no unresolved prior attempt",
  );

  /*
    ── Case B: the same run, with the approval standing ──

    The hook is a gate, not a brake. An add-to-existing launch's plan is the ad
    alone — the ad set it joined is somebody else's and is never activated — and
    `updateAdStatus` reads that ad back, runs the hook, POSTs once and verifies.
  */
  const okIntent = await seedHookIntent({
    businessId: fixture.businessId,
    userId: fixture.userId,
    idempotencyKey: "activation-hook-approval-holds",
    operation: "add_to_existing",
    campaignId: LIVE_CAMPAIGN,
    adsetIds: [LIVE_ADSET],
    adIds: [HOOK_OK_AD],
  });
  await approveHookIntent({
    businessId: fixture.businessId,
    intent: okIntent,
    approvedBy: fixture.userId,
    approvedScope: "ad",
  });
  const approvedOkIntent = (await getMetaLaunchIntent({
    businessId: fixture.businessId,
    id: okIntent.id,
  }))!;
  const liveStructure = () => ({
    campaigns: new Map([[LIVE_CAMPAIGN, { status: "ACTIVE", effective: "ACTIVE" }]]),
    adsets: new Map([[LIVE_ADSET, { status: "ACTIVE", effective: "ACTIVE" }]]),
  });
  const okDouble = installProviderDouble({
    ...liveStructure(),
    ads: new Map([[HOOK_OK_AD, { status: "PAUSED", effective: "PAUSED" }]]),
    adParents: new Map([
      [HOOK_OK_AD, {
        adsetId: LIVE_ADSET, campaignId: LIVE_CAMPAIGN, creativeId: HOOK_CREATIVE,
      }],
    ]),
  });
  let okResult;
  try {
    okResult = await activateLaunchIntent({
      intent: approvedOkIntent,
      ctx,
      authorization: { kind: "scheduled" },
      reloadIntent: () =>
        getMetaLaunchIntent({ businessId: fixture.businessId, id: okIntent.id }),
    });
  } finally {
    okDouble.restore();
  }
  if (!okResult.ok) {
    throw new Error(
      `activation-identity seam FAILED [approval holds]: refused as ${okResult.refusal}`,
    );
  }
  expectEqual(okDouble.posts, [HOOK_OK_AD], "the approved ad is POSTed exactly once");
  expectEqual(
    [okResult.activation.delivering, okResult.activation.coverage],
    [true, { planned: 1, on: 1, blocked: 0, ambiguous: 0, notAttempted: 0 }],
    "and the run reports the whole plan on",
  );
  expectEqual(
    (await actionLogRowsFor(okIntent.id)).map((row) => [
      row.ad_id, row.status, row.error_code,
    ]),
    [[HOOK_OK_AD, "success", null]],
    "the durable row records the verified activation",
  );

  /*
    ── Case C: the revocation lands INSIDE the primitive's own preflight ──

    Strictly later than the claim window. The sequence has already read the ad
    to decide whether to send anything (`seen === 1`) and written its claim;
    `updateAdStatus` then reads the ad again as its own preflight (`seen === 2`).
    The withdrawal is committed during that second read, so it is after
    `authorize`, after the claim, and before the single POST.
  */
  const preflightIntent = await seedHookIntent({
    businessId: fixture.businessId,
    userId: fixture.userId,
    idempotencyKey: "activation-hook-preflight-window",
    operation: "add_to_existing",
    campaignId: LIVE_CAMPAIGN,
    adsetIds: [LIVE_ADSET],
    adIds: [HOOK_PREFLIGHT_AD],
  });
  await approveHookIntent({
    businessId: fixture.businessId,
    intent: preflightIntent,
    approvedBy: fixture.userId,
    approvedScope: "ad",
  });
  const approvedPreflightIntent = (await getMetaLaunchIntent({
    businessId: fixture.businessId,
    id: preflightIntent.id,
  }))!;
  const preflightDouble = installProviderDouble({
    ...liveStructure(),
    ads: new Map([[HOOK_PREFLIGHT_AD, { status: "PAUSED", effective: "PAUSED" }]]),
    adParents: new Map([
      [HOOK_PREFLIGHT_AD, {
        adsetId: LIVE_ADSET, campaignId: LIVE_CAMPAIGN, creativeId: HOOK_CREATIVE,
      }],
    ]),
    onGet: async (path, seen) => {
      if (path === HOOK_PREFLIGHT_AD && seen === 2) {
        await revokeHookApproval(fixture.businessId, preflightIntent.id);
      }
    },
  });
  let preflightResult;
  try {
    preflightResult = await activateLaunchIntent({
      intent: approvedPreflightIntent,
      ctx,
      authorization: { kind: "scheduled" },
      reloadIntent: () =>
        getMetaLaunchIntent({ businessId: fixture.businessId, id: preflightIntent.id }),
    });
  } finally {
    preflightDouble.restore();
  }
  if (!preflightResult.ok) {
    throw new Error(
      `activation-identity seam FAILED [preflight window]: refused as ${preflightResult.refusal}`,
    );
  }
  expectEqual(
    preflightDouble.posts,
    [],
    "no POST after a revocation during the provider preflight",
  );
  expectEqual(
    preflightDouble.requests,
    [`GET ${HOOK_PREFLIGHT_AD}`, `GET ${HOOK_PREFLIGHT_AD}`],
    "the two reads happened and the write did not",
  );
  expectEqual(
    [preflightResult.activation.blockedAt, preflightResult.activation.blockedReason],
    ["ad", "activation_approval_revoked"],
    "the preflight refusal names the withdrawn authority too",
  );
  expectEqual(
    (await actionLogRowsFor(preflightIntent.id)).map((row) => [
      row.ad_id, row.status, row.error_code,
    ]),
    [[HOOK_PREFLIGHT_AD, "failure", "activation_approval_revoked"]],
    "and its claim settles as a definite non-write as well",
  );
  expectEqual(
    await defaultActivationJournal.findUnresolved({
      businessId: fixture.businessId,
      providerAccountId: HOOK_ACCOUNT,
      entityId: HOOK_PREFLIGHT_AD,
    }),
    null,
    "leaving no unresolved prior attempt on the ad either",
  );
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
