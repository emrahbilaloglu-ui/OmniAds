#!/usr/bin/env node
/** The D088 migration child. Refuses to run outside its ephemeral cluster. */
import { getDb } from "@/lib/db";
import { runMigrations } from "@/lib/migrations";
import { assertD088BudgetSchema } from "@/lib/meta/budget-schema-verification";
import { UPSERT_CONTEXT_QUERY } from "@/lib/creative-decision-engine/jobs/campaign-context-job";

const checks: Array<{ check: string; detail: string }> = [];
const failures: string[] = [];
const note = (check: string, detail: string) => checks.push({ check, detail });
const require_ = (ok: unknown, message: string) => { if (!ok) failures.push(message); };

const BIZ = "11111111-1111-4111-8111-111111111111";
const OWNER = "55555555-5555-4555-8555-555555555555";

async function main() {
  const expected = process.env.D088_EXPECTED_URL ?? "";
  if (!expected || process.env.DATABASE_URL !== expected
    || !/127\.0\.0\.1:\d+\/d088_migration$/.test(expected)) {
    throw new Error("Refusing to run: DATABASE_URL is not the ephemeral cluster.");
  }
  await runMigrations({ force: true, reason: "d088_migration_seam" });
  const sql = getDb();
  const version = (await sql.query<{ version: string }>("SELECT version()"))[0]?.version ?? "";

  const columns = await sql.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='meta_automation_proposals'
        AND column_name = 'budget_envelope_json'`);
  require_(columns.length === 1, "budget_envelope_json was not created");
  const constraints = await sql.query<{ conname: string; def: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'meta_automation_proposals'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%duplicate%'`);
  const widened = constraints.filter((row) => row.def.includes("budget"));
  require_(widened.length === 1,
    `expected exactly one widened action constraint, found ${widened.length}`);
  require_(!constraints.some((row) => !row.def.includes("budget")),
    "a legacy action constraint without 'budget' still stands");
  note("schema", `budget_envelope_json present; action constraint: ${widened[0]?.conname}`);

  /*
    PRE-DEPLOY AUDIT — the exact postcondition verifier, run here too.

    `runMigrations` above already calls it and throws on failure, so reaching
    this line proves it passed. Calling it explicitly records WHAT it proved in
    the artifact, so a reviewer can see the object list rather than infer it
    from the absence of an exception.
  */
  const budgetSchema = await assertD088BudgetSchema(sql);
  note("d088_schema_contract",
    `${budgetSchema.verified.length} objects proven: ${budgetSchema.verified.join(", ")}`);

  /*
    ROLLBACK COMPATIBILITY, proven with the two statements themselves.

    The migration keeps the legacy three-column unique on
    engine_v3_campaign_context_daily so the PREVIOUS production image — which
    upserts on it — still works after migrating. Both conflict targets are
    executed below against the migrated schema: the old image's bare
    three-column target, and the current writer's statement.
  */
  await sql.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1, 'D088', 'd088@example.invalid', 'x') ON CONFLICT (id) DO NOTHING`, [OWNER]);
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, currency)
     VALUES ($1, 'D088', $2, 'TRY') ON CONFLICT (id) DO NOTHING`, [BIZ, OWNER]);

  /*
    D088 C3 — the ACTIVATION column.

    Activation is business-wide on this table, so the account whose readiness
    was actually proven has to be stored alongside the flag. Additive and
    nullable: an existing row keeps reading, and a business that has never
    activated anything reports `null`, which the runtime treats as "no account
    is activated" rather than as "every account is".
  */
  const activationColumn = await sql.query<{
    data_type: string; is_nullable: string; column_default: string | null;
  }>(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='meta_automation_business_controls'
        AND column_name='auto_execution_provider_account_id'`);
  require_(activationColumn.length === 1,
    "auto_execution_provider_account_id was not created");
  require_(activationColumn[0]?.is_nullable === "YES",
    "auto_execution_provider_account_id must be nullable: unactivated is unknown");
  require_(activationColumn[0]?.column_default === null,
    "auto_execution_provider_account_id must have no default");
  await sql.query(
    `INSERT INTO meta_automation_business_controls
       (business_id, auto_execution_enabled, auto_execution_provider_account_id,
        updated_by)
     VALUES ($1, TRUE, 'act_1', $2)
     ON CONFLICT (business_id) DO UPDATE SET
       auto_execution_enabled = EXCLUDED.auto_execution_enabled,
       auto_execution_provider_account_id =
         EXCLUDED.auto_execution_provider_account_id,
       updated_by = EXCLUDED.updated_by`, [BIZ, OWNER]);
  const activation = await sql.query<{
    account: string | null; updated_by: string | null;
  }>(
    `SELECT auto_execution_provider_account_id AS account, updated_by::text AS updated_by
       FROM meta_automation_business_controls WHERE business_id = $1`, [BIZ]);
  require_(activation[0]?.account === "act_1",
    "the activated account did not round-trip");
  require_(activation[0]?.updated_by === OWNER,
    "the enabling admin did not round-trip as a UUID");
  note("activation",
    `auto_execution_provider_account_id nullable TEXT; round-trips with the enabling admin`);

  /*
    ── ROLLBACK COMPATIBILITY, executed ──────────────────────────────────────

    Two upserts against the migrated schema:

      1. the PREVIOUS production image's statement, which infers the legacy
         three-column unique. Before this correction the migration dropped that
         constraint, so this exact statement failed with 42P10 and the campaign
         role producer stopped on every rollback;
      2. the CURRENT writer's statement, verbatim from the shipped module.

    Both must succeed, and the second must fill in the account the first left
    null — which is what makes rolling forward again a repair rather than a
    second row.
  */
  const CTX_BIZ = BIZ;
  const CTX_CAMPAIGN = "23850000000000001";
  const CTX_DAY = "2026-09-03";
  const OLD_IMAGE_UPSERT = `
    INSERT INTO engine_v3_campaign_context_daily (
      business_id, campaign_id, campaign_name, as_of_date,
      inferred_kind, confidence_score, confidence_class, kind_source,
      kind_basis, resolver_version
    ) VALUES ($1, $2, 'Legacy image row', $3::date,
              'main', 0.9, 'high', 'system_inferred', 'behavioral', 'v-old')
    ON CONFLICT (business_id, campaign_id, as_of_date) DO UPDATE SET
      campaign_name = EXCLUDED.campaign_name,
      resolver_version = EXCLUDED.resolver_version`;

  let oldImageOk = "";
  try {
    await sql.query(OLD_IMAGE_UPSERT, [CTX_BIZ, CTX_CAMPAIGN, CTX_DAY]);
    // Twice, because an upsert that only works on an empty table is not one.
    await sql.query(OLD_IMAGE_UPSERT, [CTX_BIZ, CTX_CAMPAIGN, CTX_DAY]);
    oldImageOk = "ok";
  } catch (error) {
    oldImageOk = error instanceof Error ? error.message : String(error);
  }
  require_(oldImageOk === "ok",
    `the PREVIOUS image's ON CONFLICT (business_id, campaign_id, as_of_date) failed: ${oldImageOk}`);

  let newImageOk = "";
  try {
    await sql.query(UPSERT_CONTEXT_QUERY, [
      CTX_BIZ, "act_1", CTX_CAMPAIGN, "Current image row", CTX_DAY,
      "main", 0.95, "high", "behavioral", "v-new",
      JSON.stringify({}), JSON.stringify([]), JSON.stringify([]),
      JSON.stringify({}), JSON.stringify({}), null,
    ]);
    newImageOk = "ok";
  } catch (error) {
    newImageOk = error instanceof Error ? error.message : String(error);
  }
  require_(newImageOk === "ok",
    `the CURRENT writer's upsert failed against the migrated schema: ${newImageOk}`);

  const ctxRows = await sql.query<{ n: string; account: string | null; name: string }>(
    `SELECT count(*) OVER ()::text AS n, provider_account_id AS account, campaign_name AS name
       FROM engine_v3_campaign_context_daily
      WHERE business_id = $1 AND campaign_id = $2 AND as_of_date = $3::date`,
    [CTX_BIZ, CTX_CAMPAIGN, CTX_DAY]);
  require_(ctxRows.length === 1,
    `both images must converge on ONE row, found ${ctxRows.length}`);
  require_(ctxRows[0]?.account === "act_1",
    "the current writer must fill in the account the legacy row left null");
  note("rollback_compatibility",
    "old-image 3-column ON CONFLICT and the current writer both upsert on the "
    + "migrated schema, converging on one row with the account filled in");


  const insert = async (action: string, envelope: unknown) => sql.query<{ id: string }>(
    // The engine_decision lineage the existing constraint requires: this seam
    // proves the ACTION widening, not a way around any other rule.
    `INSERT INTO meta_automation_proposals
       (business_id, provider_account_id, origin, decision_key, scope_type, scope_id,
        rec_id, rec_type, engine_version, decision_label,
        snapshot_date, proposed_action, action_label, primary_caption, reason,
        expires_at, budget_envelope_json)
     VALUES ($1, 'act_1', 'engine_decision', $2, 'campaign', 'c_100',
             'rec_1', 'campaign', 'v3', 'scale',
             '2026-08-30', $3, $4,
             'Approve & apply', 'seam', now() + interval '1 day', $5::jsonb)
     RETURNING id::text AS id`,
    [BIZ, `campaign:c_100:${action}`, action, action, envelope === null ? null : JSON.stringify(envelope)]);

  // A LEGACY proposal, exactly as it was written before this slice.
  const legacy = await insert("pause", null);
  require_(legacy.length === 1, "a legacy pause proposal could not be inserted");

  // A BUDGET proposal, which the old constraint would have refused.
  const budget = await insert("budget", {
    entityId: "c_100", budgetField: "daily_budget", intendedAmountMinor: 300000,
    fingerprint: "a".repeat(64),
  });
  require_(budget.length === 1, "a budget proposal could not be inserted");

  // ...and a budget proposal WITHOUT its envelope must be refused.
  let refused = "";
  try {
    await insert("budget", null);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  require_(/budget_envelope_check|violates check constraint/.test(refused),
    `an envelope-less budget proposal was not refused (got: ${refused || "no error"})`);

  const readBack = await sql.query<{ proposed_action: string; has_envelope: boolean }>(
    `SELECT proposed_action, (budget_envelope_json IS NOT NULL) AS has_envelope
       FROM meta_automation_proposals WHERE business_id=$1 ORDER BY proposed_action`, [BIZ]);
  require_(readBack.length === 2, `expected 2 readable proposals, found ${readBack.length}`);
  require_(readBack.some((r) => r.proposed_action === "pause" && r.has_envelope === false),
    "the legacy pause proposal no longer reads");
  require_(readBack.some((r) => r.proposed_action === "budget" && r.has_envelope === true),
    "the budget proposal does not read back with its envelope");
  note("compatibility",
    `${readBack.length} proposals read: `
    + readBack.map((r) => `${r.proposed_action}(envelope=${r.has_envelope})`).join(", "));

  /*
    The LIFECYCLE: producer insert -> model read -> claim -> runtime.

    Each step uses the real function, so a change that broke the chain between
    two of them would fail here rather than in a unit test that only ever saw
    one link.
  */
  const { buildBudgetProposalEnvelope } = await import("@/lib/meta/budget-proposal-runtime");
  const { insertBudgetProposalRow } = await import("@/lib/meta/budget-proposal-producer");
  const { readMetaAutomationProposal, claimMetaAutomationProposal } =
    await import("@/lib/meta/automation-proposals");
  const { createBudgetProposalServerRuntime } =
    await import("@/lib/meta/budget-proposal-server-runtime");

  // The REAL row id, reserved before the envelope is fingerprinted.
  const reservedId = "99999999-9999-4999-8999-999999999999";
  const envelope = buildBudgetProposalEnvelope({
    proposalId: reservedId,
    businessId: BIZ, providerAccountId: "act_2",
    ownerGrain: "campaign", entityId: "c_500", parentCampaignId: null,
    budgetField: "daily_budget", ownerMode: "campaign_budget_optimization",
    currentAmountMinor: 250000, intendedAmountMinor: 300000,
    currency: "TRY", currencyExponent: 2,
    currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
    intentVerb: "increase_budget",

    recId: "rec_500", recType: "campaign", snapshotDate: "2026-08-30",
    engineVersion: "v3", decisionHash: "e".repeat(64),
    decisionAt: "2026-08-30T00:00:00.000Z",
  });
  const producedId = await insertBudgetProposalRow({
    businessId: BIZ,
    proposalId: reservedId,
    candidate: {
      businessId: BIZ, scopeType: "campaign", scopeId: "c_500", providerAccountId: "act_2",
      recId: "rec_500", recType: "campaign", snapshotDate: "2026-08-30",
      engineVersion: "v3", decisionLabel: "scale",
      recommendedAction: "increase_budget", targetAmountMinor: 300000,
      reasoning: "typed budget intent", entityLabel: "Prospecting", evidence: {},
      parentCampaignId: null,
      decisionAt: "2026-08-30T00:00:00.000Z",
      decisionHash: "e".repeat(64),
    },
    envelopeJson: JSON.stringify(envelope),
    actionLabel: "Change campaign budget",
  });
  require_(producedId === reservedId,
    `the insert used ${producedId}, not the reserved ${reservedId}`);

  const readProposal = await readMetaAutomationProposal({
    businessId: BIZ, providerAccountId: "act_2", proposalId: producedId!,
  });
  require_(readProposal?.proposedAction === "budget",
    "the produced row did not read back as a budget proposal");
  require_(readProposal?.budgetEnvelope?.fingerprint === envelope.fingerprint,
    "the stored envelope did not re-fingerprint on read");
  require_(readProposal?.budgetEnvelope?.proposalId === producedId,
    "the stored envelope is not bound to its own row id");
  note("lifecycle_read",
    `produced ${producedId}, envelope bound to the same id, fingerprint `
    + `${readProposal?.budgetEnvelope?.fingerprint?.slice(0, 12)}`);

  const claim = await claimMetaAutomationProposal({
    businessId: BIZ, providerAccountId: "act_2", proposalId: producedId!,
    claimedBy: OWNER,
  });
  require_(claim.status === "claimed", `the claim did not succeed (${claim.status})`);
  const claimToken = claim.status === "claimed" ? claim.claimToken : null;

  // The runtime, with readers that report the real closed gates.
  let providerCalls = 0;
  const runtime = createBudgetProposalServerRuntime({
    readGates: async () => ({ releaseGateOpen: false, autoExecutionEnabled: false }),
    loadCompositionSources: async () => null,
    writeDeps: async () => {
      providerCalls += 1;
      throw new Error("must not build write deps under closed gates");
    },
  });
  const outcome = await runtime({
    proposal: readProposal!, dryRunOnly: true, claimToken,
    authorization: {
      kind: "manual", explicitConfirmation: true, operatorUserId: OWNER,
    },
  });
  require_(outcome.ok === false, "the runtime claimed success under closed gates");
  require_(providerCalls === 0, "the runtime built provider deps under closed gates");
  note("lifecycle_runtime",
    `claim ${claimToken?.slice(0, 8)} -> runtime withheld ${outcome.receipt.withheld}, `
    + `${providerCalls} provider deps built`);

  // A tampered envelope must NOT read back.
  await sql.query(
    `UPDATE meta_automation_proposals
        SET budget_envelope_json = jsonb_set(budget_envelope_json,
              '{intendedAmountMinor}', '999999'::jsonb)
      WHERE id = $1::uuid`, [producedId]);
  const tampered = await readMetaAutomationProposal({
    businessId: BIZ, providerAccountId: "act_2", proposalId: producedId!,
  });
  require_(tampered?.budgetEnvelope === null,
    "a tampered envelope still read back as valid");
  note("lifecycle_tamper", "an edited envelope no longer re-fingerprints and reads as null");

  return version;
}

main()
  .then((version) => {
    console.log("__D088__" + JSON.stringify({
      ok: failures.length === 0, postgresVersion: version, checks, failures,
    }));
    process.exit(0);
  })
  .catch((error) => {
    console.log("__D088__" + JSON.stringify({
      ok: false, postgresVersion: "", checks,
      failures: [...failures, error instanceof Error ? error.message : String(error)],
    }));
    process.exit(0);
  });
