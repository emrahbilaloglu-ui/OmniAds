// Child of ephemeral-postgres-migrations-check. It runs only against the
// throwaway database URL force-set by the parent and never calls Meta.
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  buildMetaLaunchIntentResultReceipt,
  buildMetaLaunchIntentValidationReceipt,
} from "@/lib/launchpad/meta-launch-intent";
import { MetaLaunchIntentLineageError } from "@/lib/launchpad/meta-launch-intent-lineage";
import {
  MetaLaunchIntentTransitionError,
  createMetaLaunchIntent,
  listMetaLaunchIntents,
  markMetaLaunchIntentExecuting,
  recordMetaLaunchIntentOutcome,
  recordMetaLaunchIntentValidation,
} from "@/lib/launchpad/meta-launch-intent-store";
import { parseCreateMetaCreativeBriefRequest } from "@/lib/meta/creative-brief-contract";
import { createMetaCreativeBrief } from "@/lib/meta/creative-brief-store";
import { createMetaAdsActionLog } from "@/lib/meta/ads-action-log";
import {
  defaultActivationJournal,
  LAUNCH_ACTIVATION_RECEIPT_CONTRACT,
} from "@/lib/meta/launch-intent-activation";
import {
  getMetaLaunchIntent,
  recordMetaLaunchIntentActivation,
} from "@/lib/launchpad/meta-launch-intent-store";

function expectEqual(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `launch-intent seam FAILED [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function expectRejects(
  action: () => Promise<unknown>,
  errorType: new (...args: never[]) => Error,
  label: string,
) {
  try {
    await action();
  } catch (error) {
    if (error instanceof errorType) return;
    throw new Error(
      `launch-intent seam FAILED [${label}]: unexpected ${error instanceof Error ? error.name : String(error)}`,
    );
  }
  throw new Error(`launch-intent seam FAILED [${label}]: expected rejection`);
}

async function seedFixture() {
  const db = getDb();
  const users = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash)
     VALUES ('Launch Intent Seam', 'launch-intent-seam@example.test', 'x')
     RETURNING id::text AS id`,
  );
  const businesses = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, owner_id)
     VALUES ('Launch Intent Seam Business', $1::uuid)
     RETURNING id::text AS id`,
    [users[0]!.id],
  );
  const businessId = businesses[0]!.id;
  const userId = users[0]!.id;
  const providerAccountId = "act_launch_intent_seam";

  await db.query(
    `INSERT INTO meta_creative_dimensions (
       business_id, provider_account_id, creative_id, creative_name
     ) VALUES ($1, $2, 'launch_intent_creative_1', 'Launch source creative')`,
    [businessId, providerAccountId],
  );
  const snapshots = await db.query<{ id: string }>(
    `INSERT INTO engine_v3_decision_snapshots_daily (
       business_ref_id, business_id, creative_id, as_of_date,
       engine_version, scope_type, scope_id, label, raw_label,
       confidence, truth_source, effective_target_roas, ratio_to_target,
       badges, reason
     ) VALUES (
       $1::uuid, $1, 'launch_intent_creative_1', '2026-07-10'::date,
       'v3-launch-intent-seam', 'account', '*', 'scale', 'scale',
       82, 'commercial_truth', 2.5, 1.31, '[]'::jsonb,
       'Verified launch lineage'
     ) RETURNING id::text AS id`,
    [businessId],
  );
  const brief = await createMetaCreativeBrief({
    request: parseCreateMetaCreativeBriefRequest({
      businessId,
      providerAccountId,
      idempotencyKey: "launch-intent-seam-brief",
      sourceDecision: {
        snapshotId: snapshots[0]!.id,
        trigger: "launch_intent_seam",
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
  const drafts = await db.query<{ id: string }>(
    `INSERT INTO meta_launch_drafts (
       business_id, provider_account_id, name, payload_json, created_by
     ) VALUES ($1::uuid, $2, 'Account draft', '{}'::jsonb, $3::uuid)
     RETURNING id::text AS id`,
    [businessId, providerAccountId, userId],
  );
  return {
    businessId,
    userId,
    providerAccountId,
    briefId: brief.brief.id,
    draftId: drafts[0]!.id,
  };
}

async function main() {
  if (
    process.env.DATABASE_URL?.includes(":15432/") ||
    process.env.DATABASE_URL?.includes(":5432/")
  ) {
    throw new Error("launch-intent seam refused: DATABASE_URL points at a protected port");
  }
  const fixture = await seedFixture();
  const request = {
    businessId: fixture.businessId,
    providerAccountId: fixture.providerAccountId,
    operation: "new_campaign" as const,
    idempotencyKey: "launch-intent-seam-create-1",
    requestPayload: { campaign: { name: "Seam campaign", status: "PAUSED" } },
    creativeBriefId: fixture.briefId,
    sourceDraftId: fixture.draftId,
    createdBy: fixture.userId,
  };

  const created = await createMetaLaunchIntent(request);
  expectEqual(created.created, true, "first create");
  expectEqual(created.intent.requestedStatus, "PAUSED", "PAUSED invariant");
  expectEqual(created.intent.lineage.creativeBriefId, fixture.briefId, "brief lineage");
  expectEqual(created.intent.lineage.sourceDraftId, fixture.draftId, "draft lineage");

  const replay = await createMetaLaunchIntent(request);
  expectEqual(replay.created, false, "idempotent replay");
  expectEqual(replay.intent.id, created.intent.id, "idempotent singleton");

  const count = await getDb().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM meta_launch_intents
     WHERE business_id = $1::uuid
       AND provider_account_id = $2
       AND idempotency_key = $3`,
    [fixture.businessId, fixture.providerAccountId, request.idempotencyKey],
  );
  expectEqual(count[0]!.count, "1", "one persisted command");

  await expectRejects(
    () =>
      createMetaLaunchIntent({
        ...request,
        providerAccountId: "act_other",
        idempotencyKey: "launch-intent-cross-account-brief",
      }),
    MetaLaunchIntentLineageError,
    "cross-account brief rejection",
  );
  await expectRejects(
    () =>
      createMetaLaunchIntent({
        ...request,
        creativeBriefId: null,
        providerAccountId: "act_other",
        idempotencyKey: "launch-intent-cross-account-draft",
      }),
    MetaLaunchIntentLineageError,
    "cross-account draft rejection",
  );

  const validation = buildMetaLaunchIntentValidationReceipt({
    providerAccountId: fixture.providerAccountId,
    ok: true,
    blockers: [],
    warnings: [],
  });
  const ready = await recordMetaLaunchIntentValidation({
    businessId: fixture.businessId,
    id: created.intent.id,
    receipt: validation,
  });
  expectEqual(ready.status, "ready", "validated ready");
  const executing = await markMetaLaunchIntentExecuting({
    businessId: fixture.businessId,
    id: created.intent.id,
  });
  expectEqual(executing.status, "executing", "executing transition");
  const resultReceipt = buildMetaLaunchIntentResultReceipt({
    providerAccountId: fixture.providerAccountId,
    campaignId: "campaign_seam_1",
    adsetIds: ["adset_seam_1"],
    adIds: ["ad_seam_1"],
  });
  const succeeded = await recordMetaLaunchIntentOutcome({
    businessId: fixture.businessId,
    id: created.intent.id,
    status: "succeeded",
    resultReceipt,
  });
  expectEqual(succeeded.status, "succeeded", "terminal outcome");
  expectEqual(
    succeeded.resultReceipt?.recovery.rollbackSupported,
    false,
    "rollback unsupported",
  );
  expectEqual(
    succeeded.resultReceipt?.recovery.retrySupported,
    false,
    "retry unsupported",
  );
  await expectRejects(
    () =>
      recordMetaLaunchIntentOutcome({
        businessId: fixture.businessId,
        id: created.intent.id,
        status: "succeeded",
        resultReceipt,
      }),
    MetaLaunchIntentTransitionError,
    "terminal intent cannot retry",
  );

  expectEqual(
    (await listMetaLaunchIntents({
      businessId: fixture.businessId,
      providerAccountId: fixture.providerAccountId,
    })).map((intent) => intent.id),
    [created.intent.id],
    "account-scoped list",
  );
  expectEqual(
    await listMetaLaunchIntents({
      businessId: fixture.businessId,
      providerAccountId: "act_other",
    }),
    [],
    "cross-account list withheld",
  );

  const actionLog = await createMetaAdsActionLog({
    businessId: fixture.businessId,
    adId: "launch-intent-seam:campaign",
    action: "launch_campaign",
    requestedBy: fixture.userId,
    launchIntentId: created.intent.id,
    payloadRequest: { operation: "new_campaign" },
  });
  expectEqual(actionLog.launchIntentId, created.intent.id, "action-log lineage");
  const persistedLink = await getDb().query<{ launch_intent_id: string | null }>(
    `SELECT launch_intent_id::text AS launch_intent_id
     FROM meta_ads_action_log
     WHERE id = $1::uuid`,
    [actionLog.id],
  );
  expectEqual(persistedLink[0]!.launch_intent_id, created.intent.id, "direct FK persisted");

  /*
    ── The activation journal, against real SQL ──

    The unit tests drive the sequence against a journal double, which proves
    the sequencing and nothing about the database. What has to be true here is
    the part only Postgres can answer: that an ambiguous settle really does
    land in the state `findUnresolvedMetaAdStatusActionLog`'s query selects,
    so the no-blind-retry gate is a real behaviour and not a claim about one.
  */
  const ambiguousClaim = await defaultActivationJournal.claim({
    businessId: fixture.businessId,
    providerAccountId: fixture.providerAccountId,
    entityId: "seam_adset_ambiguous",
    grain: "adset",
    launchIntentId: created.intent.id,
    operatorUserId: fixture.userId,
    observed: { status: "PAUSED", effectiveStatus: "PAUSED" },
  });
  if (!ambiguousClaim) {
    throw new Error("launch-intent seam FAILED [activation claim]: no row written");
  }
  const claimRow = await getDb().query<{
    launch_intent_id: string | null;
    source: string;
    action: string;
    status: string;
    prior_status: string | null;
  }>(
    `SELECT launch_intent_id::text AS launch_intent_id,
            source,
            action,
            status,
            payload_request->'prior_state'->>'status' AS prior_status
     FROM meta_ads_action_log
     WHERE id = $1::uuid`,
    [ambiguousClaim.id],
  );
  expectEqual(claimRow[0]!.launch_intent_id, created.intent.id, "activation claim lineage");
  expectEqual(claimRow[0]!.source, "launch_activation_v1", "activation claim origin");
  expectEqual(claimRow[0]!.action, "resume", "activation claim action");
  expectEqual(claimRow[0]!.status, "pending", "activation claim starts pending");
  // Written before the POST: the only record of what the entity was.
  expectEqual(claimRow[0]!.prior_status, "PAUSED", "activation claim prior state");

  // A pending claim already blocks a second attempt — that is the state an
  // interrupted process leaves behind.
  expectEqual(
    (await defaultActivationJournal.findUnresolved({
      businessId: fixture.businessId,
      providerAccountId: fixture.providerAccountId,
      entityId: "seam_adset_ambiguous",
    }))?.id,
    ambiguousClaim.id,
    "pending claim is unresolved",
  );

  await defaultActivationJournal.settle({
    id: ambiguousClaim.id,
    outcome: "ambiguous",
    reason: "provider_outcome_ambiguous",
    durationMs: 12,
  });
  const settledAmbiguous = await getDb().query<{ status: string }>(
    `SELECT status FROM meta_ads_action_log WHERE id = $1::uuid`,
    [ambiguousClaim.id],
  );
  expectEqual(settledAmbiguous[0]!.status, "silent_failure", "ambiguous settles unknown");
  expectEqual(
    (await defaultActivationJournal.findUnresolved({
      businessId: fixture.businessId,
      providerAccountId: fixture.providerAccountId,
      entityId: "seam_adset_ambiguous",
    }))?.id,
    ambiguousClaim.id,
    "ambiguous claim still blocks a retry",
  );
  // A different entity is untouched by it. The gate is per entity, not per run.
  expectEqual(
    await defaultActivationJournal.findUnresolved({
      businessId: fixture.businessId,
      providerAccountId: fixture.providerAccountId,
      entityId: "seam_campaign_ok",
    }),
    null,
    "another entity is not blocked",
  );

  const okClaim = await defaultActivationJournal.claim({
    businessId: fixture.businessId,
    providerAccountId: fixture.providerAccountId,
    entityId: "seam_campaign_ok",
    grain: "campaign",
    launchIntentId: created.intent.id,
    operatorUserId: fixture.userId,
    observed: { status: "PAUSED", effectiveStatus: "PAUSED" },
  });
  await defaultActivationJournal.settle({
    id: okClaim!.id, outcome: "activated", reason: null, durationMs: 8,
  });
  expectEqual(
    await defaultActivationJournal.findUnresolved({
      businessId: fixture.businessId,
      providerAccountId: fixture.providerAccountId,
      entityId: "seam_campaign_ok",
    }),
    null,
    "a resolved success does not block",
  );
  // A definite refusal is also resolved: it is known not to have applied.
  const refusedClaim = await defaultActivationJournal.claim({
    businessId: fixture.businessId,
    providerAccountId: fixture.providerAccountId,
    entityId: "seam_ad_refused",
    grain: "ad",
    launchIntentId: created.intent.id,
    operatorUserId: fixture.userId,
    observed: { status: "PAUSED", effectiveStatus: "PAUSED" },
  });
  await defaultActivationJournal.settle({
    id: refusedClaim!.id, outcome: "refused", reason: "verified_not_active", durationMs: 5,
  });
  expectEqual(
    await defaultActivationJournal.findUnresolved({
      businessId: fixture.businessId,
      providerAccountId: fixture.providerAccountId,
      entityId: "seam_ad_refused",
    }),
    null,
    "a definite refusal stays retryable",
  );

  // And the sequence itself survives the response.
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
      // The shape production writes: `delivering` now means FULL coverage, so
      // a receipt has to say what a partial run actually reached.
      partial: true,
      coverage: { planned: 1, on: 0, blocked: 1, ambiguous: 0, notAttempted: 0 },
      blockedAt: "adset",
      blockedReason: "provider_outcome_ambiguous",
      steps: [],
    },
  });
  const reread = await getMetaLaunchIntent({
    businessId: fixture.businessId,
    id: created.intent.id,
  });
  expectEqual(
    (reread?.activationReceipt as { blockedAt?: string } | null)?.blockedAt,
    "adset",
    "activation receipt is durable",
  );

  console.log(
    "[launch-intent-seam] PASS: reviewed brief/draft lineage, account isolation, idempotency, state transitions, immutable recovery, action-log FK, activation claim/settle/no-blind-retry and durable activation receipt.",
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
