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
// The provider POST itself is absent by construction — this process must never
// reach Meta — so `activateLaunchIntent` is driven here only down the path that
// refuses before contacting anything.
import { getDb, resetDbClientCache } from "@/lib/db";
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

  console.log(
    "[activation-identity-seam] PASS: complete identity set with parentage survives the receipt round trip, one journalled row per entity settles independently, a five-identity partial receipt reads back with its counts, a persisted approval is accepted then refused once withdrawn, and an approval naming fewer creatives than the launch produced is refused by name.",
  );
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
