import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB_NAME = "adsecute_controlled_registry_seam";
const DB_USER = "postgres";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function postgresBin(name: string) {
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR
      ? path.join(process.env.EPHEMERAL_PG_BIN_DIR, name)
      : "",
    `/opt/homebrew/opt/postgresql@16/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/opt/postgresql@16/bin/${name}`,
    `/usr/bin/${name}`,
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`PostgreSQL binary not found: ${name}`);
  return found;
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, { encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

async function expectPgError(
  operation: () => Promise<unknown>,
  codes: readonly string[],
  label: string,
) {
  try {
    await operation();
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (codes.includes(code)) return;
    throw error;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

function iso(value: number | Date) {
  return new Date(value).toISOString();
}

function utcMidnight(daysFromToday: number) {
  const now = new Date();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysFromToday,
    ),
  );
}

async function main() {
  const initdb = postgresBin("initdb");
  const pgCtl = postgresBin("pg_ctl");
  const createdb = postgresBin("createdb");
  const port = await freePort();
  assert(
    !FORBIDDEN_PORTS.has(port),
    `Refusing forbidden PostgreSQL port ${port}.`,
  );

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "adsecute-controlled-registry-"),
  );
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  let started = false;

  try {
    run(initdb, [
      "-D",
      dataDir,
      "-U",
      DB_USER,
      "-A",
      "trust",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    run(pgCtl, [
      "-D",
      dataDir,
      "-l",
      logFile,
      "-o",
      `-F -h 127.0.0.1 -p ${port}`,
      "-w",
      "start",
    ]);
    started = true;
    run(createdb, [
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-U",
      DB_USER,
      DB_NAME,
    ]);

    const databaseUrl = `postgresql://${DB_USER}@127.0.0.1:${port}/${DB_NAME}`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.DB_SSL_MODE = "disable";

    const registry = await import("@/lib/meta/controlled-experiment-registry");
    const { getDb, resetDbClientCache, runDbTransaction } =
      await import("@/lib/db");
    const sql = getDb();

    async function expectRegistryRejection(
      operation: () => Promise<unknown>,
      label: string,
    ) {
      try {
        await operation();
      } catch (error) {
        if (
          error instanceof registry.ControlledRegistryConflictError ||
          error instanceof registry.ControlledRegistryValidationError
        ) {
          return;
        }
        throw error;
      }
      throw new Error(`${label} unexpectedly succeeded.`);
    }

    await sql.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL
      );
      CREATE TABLE provider_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider TEXT NOT NULL DEFAULT 'meta',
        external_account_id TEXT NOT NULL
      );
      CREATE TABLE business_provider_accounts (
        business_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_account_ref_id UUID NOT NULL
          REFERENCES provider_accounts(id) ON DELETE RESTRICT,
        provider_account_id TEXT NOT NULL,
        UNIQUE (business_id, provider_account_ref_id, provider_account_id)
      );
      CREATE TABLE engine_v3_ad_decision_evaluations (
        id UUID PRIMARY KEY,
        business_ref_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
        provider_account_id TEXT NOT NULL,
        decision_entity_type TEXT NOT NULL,
        decision_entity_id TEXT NOT NULL,
        input_hash CHAR(64) NOT NULL,
        decision_hash CHAR(64) NOT NULL,
        engine_version TEXT NOT NULL
      );
      CREATE TABLE engine_v3_ad_decision_snapshots_daily (
        id UUID PRIMARY KEY,
        evaluation_id UUID NOT NULL
          REFERENCES engine_v3_ad_decision_evaluations(id) ON DELETE RESTRICT,
        business_ref_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
        provider_account_id TEXT NOT NULL,
        decision_entity_type TEXT NOT NULL,
        decision_entity_id TEXT NOT NULL,
        input_hash CHAR(64) NOT NULL,
        decision_hash CHAR(64) NOT NULL,
        engine_version TEXT NOT NULL
      );
      CREATE TABLE engine_v3_ad_decision_outcomes_daily (
        id UUID PRIMARY KEY,
        contract_version TEXT NOT NULL,
        classifier_version TEXT NOT NULL,
        decision_snapshot_id UUID NOT NULL
          REFERENCES engine_v3_ad_decision_snapshots_daily(id) ON DELETE RESTRICT,
        evaluation_id UUID NOT NULL
          REFERENCES engine_v3_ad_decision_evaluations(id) ON DELETE RESTRICT,
        business_ref_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
        business_id TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        decision_entity_type TEXT NOT NULL,
        decision_entity_id TEXT NOT NULL,
        ad_id TEXT NOT NULL,
        outcome_window_start DATE NOT NULL,
        outcome_window_end DATE NOT NULL,
        window_complete BOOLEAN NOT NULL,
        measurement_status TEXT NOT NULL,
        realized_outcome TEXT NOT NULL,
        action_contaminated BOOLEAN NOT NULL,
        outcome_roas DOUBLE PRECISION,
        outcome_revenue DOUBLE PRECISION NOT NULL,
        outcome_purchases DOUBLE PRECISION NOT NULL,
        outcome_spend DOUBLE PRECISION NOT NULL,
        action_source_hash CHAR(64) NOT NULL,
        source_manifest_hash CHAR(64) NOT NULL,
        source_receipts_json JSONB NOT NULL,
        computed_at TIMESTAMPTZ NOT NULL
      );
      CREATE OR REPLACE FUNCTION reject_engine_v3_ad_outcome_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'engine_v3_ad_decision_outcomes_daily rows are immutable';
      END;
      $$;
      CREATE TRIGGER trg_engine_v3_ad_outcomes_immutable
      BEFORE UPDATE OR DELETE ON engine_v3_ad_decision_outcomes_daily
      FOR EACH ROW EXECUTE FUNCTION reject_engine_v3_ad_outcome_mutation();
      CREATE TABLE meta_ads_action_log (
        id UUID PRIMARY KEY,
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
        ad_id TEXT NOT NULL,
        creative_id TEXT,
        action TEXT NOT NULL,
        source TEXT NOT NULL,
        requested_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL,
        rec_id_origin TEXT,
        verification_payload JSONB,
        verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE meta_decision_action_outcome_logs (
        id UUID PRIMARY KEY,
        business_id TEXT NOT NULL,
        business_ref_id UUID,
        provider_account_id TEXT,
        provider_account_ref_id UUID,
        recommendation_fingerprint TEXT NOT NULL,
        rec_id TEXT,
        rec_type TEXT,
        decision_label TEXT,
        action_type TEXT NOT NULL,
        outcome_status TEXT,
        payload_json JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL
      );
    `);
    await sql.query(registry.CONTROLLED_REGISTRY_SCHEMA_SQL);
    await sql.query(registry.CONTROLLED_REGISTRY_SCHEMA_SQL);

    const capabilities = await registry.inspectControlledRegistryCapabilities();
    assert(
      capabilities.ready,
      `Schema capability mismatch: ${capabilities.issues.join("\n")}`,
    );

    const businessId = randomUUID();
    const providerAccountRefId = randomUUID();
    const providerAccountId = "act_controlled_registry_seam";
    await sql.query(
      `INSERT INTO businesses (id, name) VALUES ($1::uuid, 'Controlled seam')`,
      [businessId],
    );
    await sql.query(
      `INSERT INTO provider_accounts (id, external_account_id) VALUES ($1::uuid, $2)`,
      [providerAccountRefId, providerAccountId],
    );
    await sql.query(
      `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id)
       VALUES ($1::text, 'meta', $2::uuid, $3)`,
      [businessId, providerAccountRefId, providerAccountId],
    );

    async function nativeLineage(adIds: readonly string[]) {
      const entries = [];
      for (const adId of adIds) {
        const evaluationId = randomUUID();
        const snapshotId = randomUUID();
        const inputHash = registry.controlledSha256({ adId, type: "input" });
        const decisionHash = registry.controlledSha256({
          adId,
          type: "decision",
        });
        await sql.query(
          `INSERT INTO engine_v3_ad_decision_evaluations
           (id, business_ref_id, provider_account_id, decision_entity_type,
            decision_entity_id, input_hash, decision_hash, engine_version)
           VALUES ($1::uuid, $2::uuid, $3, 'ad', $4, $5, $6, $7)`,
          [
            evaluationId,
            businessId,
            providerAccountId,
            adId,
            inputHash,
            decisionHash,
            "v3-ad-seam",
          ],
        );
        await sql.query(
          `INSERT INTO engine_v3_ad_decision_snapshots_daily
           (id, evaluation_id, business_ref_id, provider_account_id,
            decision_entity_type, decision_entity_id, input_hash,
            decision_hash, engine_version)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ad', $5, $6, $7, $8)`,
          [
            snapshotId,
            evaluationId,
            businessId,
            providerAccountId,
            adId,
            inputHash,
            decisionHash,
            "v3-ad-seam",
          ],
        );
        entries.push({
          adId,
          evaluationId,
          snapshotId,
          inputHash,
          decisionHash,
        });
      }
      return entries;
    }

    const futureLineage = await nativeLineage(
      Array.from({ length: 8 }, (_, index) => `future-ad-${index + 1}`),
    );
    const futureManifest = futureLineage.map((entry, index) => ({
      assignmentId: `future-assignment-${index + 1}`,
      recommendationFingerprint: `future-fingerprint-${index + 1}`,
      recId: `future-rec-${index + 1}`,
      evaluationId: entry.evaluationId,
      snapshotId: entry.snapshotId,
      target: { entityType: "ad" as const, entityId: entry.adId },
    }));
    const futureExperimentId = "future-experiment";
    const futureBatchId = "future-batch";
    const futureSeed = "future-seed-0123456789abcdef0123456789abcdef";
    const futureWindowStart = utcMidnight(2);
    const futureWindowEnd = utcMidnight(5);
    const futureEnds = utcMidnight(6);
    const futureStarts = new Date(Date.now() + 60 * 60 * 1000);
    const futureRegistration = {
      experimentId: futureExperimentId,
      businessId,
      providerAccountRefId,
      providerAccountId,
      name: "Future atomic assignment seam",
      hypothesis: "Atomic assignment survives concurrent retries.",
      primaryMetric: "outcome_roas" as const,
      metricDirection: "increase" as const,
      randomizationUnit: "ad" as const,
      seedCommitmentHash: registry.buildSeedCommitment({
        experimentId: futureExperimentId,
        seed: futureSeed,
      }),
      startsAt: iso(futureStarts),
      outcomeWindowStartAt: iso(futureWindowStart),
      outcomeWindowEndAt: iso(futureWindowEnd),
      endsAt: iso(futureEnds),
      eligibilityManifest: futureManifest,
      arms: [
        {
          armId: "future-control",
          role: "control" as const,
          allocationOrder: 0,
          assignmentProbability: 0.5,
          treatmentAction: null,
        },
        {
          armId: "future-treatment",
          role: "treatment" as const,
          allocationOrder: 1,
          assignmentProbability: 0.5,
          treatmentAction: "pause",
        },
      ],
    };
    const unassignedBusinessId = randomUUID();
    await sql.query(
      `INSERT INTO businesses (id, name)
       VALUES ($1::uuid, 'Unassigned controlled seam')`,
      [unassignedBusinessId],
    );
    const unassignedExperimentId = "unassigned-account-experiment";
    await expectRegistryRejection(
      () =>
        registry.preregisterControlledExperiment({
          ...futureRegistration,
          experimentId: unassignedExperimentId,
          businessId: unassignedBusinessId,
          seedCommitmentHash: registry.buildSeedCommitment({
            experimentId: unassignedExperimentId,
            seed: futureSeed,
          }),
          arms: futureRegistration.arms.map((arm) => ({
            ...arm,
            armId: `unassigned-${arm.armId}`,
          })),
        }),
      "unassigned business/account preregistration",
    );
    const [unassignedExperiment] = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM meta_controlled_experiments WHERE id = $1`,
      [unassignedExperimentId],
    );
    assert(
      unassignedExperiment?.count === "0",
      "Rejected account binding leaked an experiment row.",
    );
    const headerOnlyExperimentId = "header-only-experiment";
    const headerOnlyBatchId = "header-only-batch";
    const headerOnlySeed = "header-only-seed-0123456789abcdef0123456789abcdef";
    const headerOnlyManifest = futureManifest.slice(0, 1);
    const headerOnlyEligibility =
      registry.buildEligibilityContract(headerOnlyManifest);
    await registry.preregisterControlledExperiment({
      ...futureRegistration,
      experimentId: headerOnlyExperimentId,
      seedCommitmentHash: registry.buildSeedCommitment({
        experimentId: headerOnlyExperimentId,
        seed: headerOnlySeed,
      }),
      eligibilityManifest: headerOnlyManifest,
      arms: futureRegistration.arms.map((arm) => ({
        ...arm,
        armId: `header-only-${arm.armId}`,
      })),
    });
    await expectPgError(
      () =>
        runDbTransaction(async () => {
          const transactionSql = getDb();
          await transactionSql.query(
            `INSERT INTO meta_controlled_assignment_batches
             (id,contract_version,experiment_id,business_id,
              provider_account_ref_id,provider_account_id,eligibility_count,
              eligibility_hash,assignment_manifest_hash,
              eligibility_manifest_json,batch_hash,assigned_at,created_at)
             VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$9,$10::jsonb,$11,
                     statement_timestamp(),statement_timestamp())`,
            [
              headerOnlyBatchId,
              registry.CONTROLLED_BATCH_VERSION,
              headerOnlyExperimentId,
              businessId,
              providerAccountRefId,
              providerAccountId,
              headerOnlyEligibility.eligibilityCount,
              headerOnlyEligibility.eligibilityHash,
              headerOnlyEligibility.assignmentManifestHash,
              JSON.stringify(headerOnlyEligibility.manifest),
              registry.controlledSha256({
                experimentId: headerOnlyExperimentId,
                batchId: headerOnlyBatchId,
              }),
            ],
          );
        }),
      ["23514"],
      "zero-assignment batch commit",
    );
    const registered =
      await registry.preregisterControlledExperiment(futureRegistration);
    const registeredRetry =
      await registry.preregisterControlledExperiment(futureRegistration);
    assert(
      registered.registrationHash === registeredRetry.registrationHash,
      "Exact preregistration retry was not idempotent.",
    );

    const assignmentInput = {
      batchId: futureBatchId,
      experimentId: futureExperimentId,
      businessId,
      providerAccountRefId,
      providerAccountId,
      randomizationSeed: futureSeed,
      eligibilityManifest: futureManifest,
    };
    const [concurrentA, concurrentB] = await Promise.all([
      registry.createControlledAssignmentBatch(assignmentInput),
      registry.createControlledAssignmentBatch(assignmentInput),
    ]);
    assert(
      concurrentA.batchHash === concurrentB.batchHash &&
        concurrentA.assignments.length === futureManifest.length,
      "Concurrent assignment retries did not return the same complete batch.",
    );
    const assignmentRetry =
      await registry.createControlledAssignmentBatch(assignmentInput);
    assert(
      assignmentRetry.batchHash === concurrentA.batchHash,
      "Exact assignment retry was not idempotent.",
    );
    await expectRegistryRejection(
      () =>
        registry.createControlledAssignmentBatch({
          ...assignmentInput,
          eligibilityManifest: futureManifest.slice(0, -1),
        }),
      "selective assignment manifest",
    );
    const reveal = await registry.finalizeControlledSeedReveal({
      batchId: futureBatchId,
      experimentId: futureExperimentId,
      businessId,
      providerAccountRefId,
      providerAccountId,
      randomizationSeed: futureSeed,
    });
    const revealRetry = await registry.finalizeControlledSeedReveal({
      batchId: futureBatchId,
      experimentId: futureExperimentId,
      businessId,
      providerAccountRefId,
      providerAccountId,
      randomizationSeed: futureSeed,
    });
    assert(reveal.revealHash === revealRetry.revealHash, "Seed retry drifted.");
    await expectPgError(
      () =>
        sql.query(
          `UPDATE meta_controlled_random_assignments
           SET randomization_draw = 0.1 WHERE batch_id = $1`,
          [futureBatchId],
        ),
      ["55000"],
      "immutable assignment tamper",
    );

    const historicalLineage = await nativeLineage(
      Array.from({ length: 10 }, (_, index) => `historical-ad-${index + 1}`),
    );
    const historicalManifest = historicalLineage.map((entry, index) => ({
      assignmentId: `historical-assignment-${index + 1}`,
      recommendationFingerprint: `historical-fingerprint-${index + 1}`,
      recId: `historical-rec-${index + 1}`,
      evaluationId: entry.evaluationId,
      snapshotId: entry.snapshotId,
      target: { entityType: "ad" as const, entityId: entry.adId },
    }));
    const historicalExperimentId = "historical-experiment";
    const historicalBatchId = "historical-batch";
    const historicalStart = utcMidnight(-8);
    const historicalWindowStart = utcMidnight(-7);
    const historicalWindowEnd = utcMidnight(-4);
    const historicalEnds = utcMidnight(-2);
    const historicalPreregistered = utcMidnight(-9);
    const historicalAssigned = new Date(
      historicalPreregistered.getTime() + 3_600_000,
    );
    const eligibility = registry.buildEligibilityContract(historicalManifest);

    function plan(seed: string) {
      return eligibility.manifest.map((entry) => {
        const proofHash = registry.controlledSha256({
          algorithm: registry.CONTROLLED_RANDOMIZATION_ALGORITHM,
          experimentId: historicalExperimentId,
          businessId,
          providerAccountId,
          target: entry.target,
          seed,
        });
        const draw =
          Number.parseInt(proofHash.slice(0, 12), 16) / 281_474_976_710_656;
        return {
          entry,
          proofHash,
          draw,
          role: draw < 0.5 ? "control" : "treatment",
        };
      });
    }
    let historicalSeed = "";
    let historicalPlan: ReturnType<typeof plan> = [];
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const candidate = `historical-seed-${String(attempt).padStart(4, "0")}-0123456789abcdef0123456789abcdef`;
      const candidatePlan = plan(candidate);
      const controls = candidatePlan.filter(
        (entry) => entry.role === "control",
      ).length;
      const treatments = candidatePlan.length - controls;
      if (controls >= 2 && treatments >= 1) {
        historicalSeed = candidate;
        historicalPlan = candidatePlan;
        break;
      }
    }
    assert(
      historicalSeed,
      "Could not find deterministic seam arm distribution.",
    );
    const seedCommitmentHash = registry.buildSeedCommitment({
      experimentId: historicalExperimentId,
      seed: historicalSeed,
    });
    const armInputs = [
      {
        contractVersion: registry.CONTROLLED_ARM_VERSION,
        experimentId: historicalExperimentId,
        armId: "historical-control",
        role: "control" as const,
        allocationOrder: 0,
        assignmentProbability: 0.5,
        treatmentAction: null,
      },
      {
        contractVersion: registry.CONTROLLED_ARM_VERSION,
        experimentId: historicalExperimentId,
        armId: "historical-treatment",
        role: "treatment" as const,
        allocationOrder: 1,
        assignmentProbability: 0.5,
        treatmentAction: "pause",
      },
    ];
    const arms = armInputs.map((arm) => ({
      ...arm,
      armHash: registry.controlledSha256(arm),
    }));
    const registrationBase = {
      contractVersion: registry.CONTROLLED_EXPERIMENT_VERSION,
      experimentId: historicalExperimentId,
      businessId,
      providerAccountRefId,
      providerAccountId,
      name: "Historical native outcome seam",
      hypothesis: "Native control outcomes define the control estimate.",
      primaryMetric: "outcome_roas",
      metricDirection: "increase",
      randomizationUnit: "ad",
      randomizationAlgorithm: registry.CONTROLLED_RANDOMIZATION_ALGORITHM,
      seedCommitmentHash,
      eligibilityCount: eligibility.eligibilityCount,
      eligibilityHash: eligibility.eligibilityHash,
      assignmentManifestHash: eligibility.assignmentManifestHash,
      startsAt: iso(historicalStart),
      outcomeWindowStartAt: iso(historicalWindowStart),
      outcomeWindowEndAt: iso(historicalWindowEnd),
      endsAt: iso(historicalEnds),
      arms,
    };
    const registrationHash = registry.controlledSha256(registrationBase);
    const assignments = historicalPlan.map(
      ({ entry, proofHash, draw, role }) => {
        const arm = role === "control" ? arms[0]! : arms[1]!;
        const base = {
          contractVersion: registry.CONTROLLED_ASSIGNMENT_VERSION,
          ...entry,
          experimentId: historicalExperimentId,
          batchId: historicalBatchId,
          armId: arm.armId,
          armRole: arm.role,
          assignedAction: arm.treatmentAction,
          assignmentProbability: arm.assignmentProbability,
          randomizationAlgorithm: registry.CONTROLLED_RANDOMIZATION_ALGORITHM,
          seedCommitmentHash,
          eligibilityHash: eligibility.eligibilityHash,
          randomizationDraw: draw,
          randomizationProofHash: proofHash,
        };
        return { ...base, assignmentHash: registry.controlledSha256(base) };
      },
    );
    const batchHash = registry.controlledSha256({
      contractVersion: registry.CONTROLLED_BATCH_VERSION,
      batchId: historicalBatchId,
      experimentId: historicalExperimentId,
      businessId,
      providerAccountRefId,
      providerAccountId,
      eligibilityCount: eligibility.eligibilityCount,
      eligibilityHash: eligibility.eligibilityHash,
      assignmentManifestHash: eligibility.assignmentManifestHash,
      assignments: assignments.map((assignment) => ({
        assignmentId: assignment.assignmentId,
        assignmentHash: assignment.assignmentHash,
      })),
    });

    await runDbTransaction(async () => {
      const transactionSql = getDb();
      await transactionSql.query(
        `INSERT INTO meta_controlled_experiments
         (id, contract_version, business_id, provider_account_ref_id,
          provider_account_id, name, hypothesis, primary_metric,
          metric_direction, randomization_unit, randomization_algorithm,
          seed_commitment_hash, eligibility_count, eligibility_hash,
          assignment_manifest_hash, starts_at, outcome_window_start_at,
          outcome_window_end_at, ends_at, registration_hash,
          preregistered_at, created_at)
         VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 $16::timestamptz,$17::timestamptz,$18::timestamptz,$19::timestamptz,
                 $20,$21::timestamptz,$21::timestamptz)`,
        [
          historicalExperimentId,
          registry.CONTROLLED_EXPERIMENT_VERSION,
          businessId,
          providerAccountRefId,
          providerAccountId,
          registrationBase.name,
          registrationBase.hypothesis,
          registrationBase.primaryMetric,
          registrationBase.metricDirection,
          registrationBase.randomizationUnit,
          registrationBase.randomizationAlgorithm,
          seedCommitmentHash,
          eligibility.eligibilityCount,
          eligibility.eligibilityHash,
          eligibility.assignmentManifestHash,
          registrationBase.startsAt,
          registrationBase.outcomeWindowStartAt,
          registrationBase.outcomeWindowEndAt,
          registrationBase.endsAt,
          registrationHash,
          iso(historicalPreregistered),
        ],
      );
      for (const arm of arms) {
        await transactionSql.query(
          `INSERT INTO meta_controlled_experiment_arms
           (id, contract_version, experiment_id, business_id,
            provider_account_ref_id, provider_account_id, arm_role,
            allocation_order, assignment_probability, treatment_action,
            arm_hash, created_at)
           VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11,$12::timestamptz)`,
          [
            arm.armId,
            registry.CONTROLLED_ARM_VERSION,
            historicalExperimentId,
            businessId,
            providerAccountRefId,
            providerAccountId,
            arm.role,
            arm.allocationOrder,
            arm.assignmentProbability,
            arm.treatmentAction,
            arm.armHash,
            iso(historicalPreregistered),
          ],
        );
      }
      await transactionSql.query(
        `INSERT INTO meta_controlled_assignment_batches
         (id, contract_version, experiment_id, business_id,
          provider_account_ref_id, provider_account_id, eligibility_count,
          eligibility_hash, assignment_manifest_hash, eligibility_manifest_json,
          batch_hash, assigned_at, created_at)
         VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$9,$10::jsonb,$11,
                 $12::timestamptz,$12::timestamptz)`,
        [
          historicalBatchId,
          registry.CONTROLLED_BATCH_VERSION,
          historicalExperimentId,
          businessId,
          providerAccountRefId,
          providerAccountId,
          eligibility.eligibilityCount,
          eligibility.eligibilityHash,
          eligibility.assignmentManifestHash,
          JSON.stringify(eligibility.manifest),
          batchHash,
          iso(historicalAssigned),
        ],
      );
      for (const assignment of assignments) {
        await transactionSql.query(
          `INSERT INTO meta_controlled_random_assignments
           (id, contract_version, experiment_id, batch_id, arm_id, arm_role,
            business_id, provider_account_ref_id, provider_account_id,
            recommendation_fingerprint, rec_id, evaluation_id, snapshot_id,
            entity_type, entity_id, assigned_action, assignment_probability,
            randomization_algorithm, seed_commitment_hash, eligibility_hash,
            randomization_draw, randomization_proof_hash, assignment_hash,
            assigned_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9,$10,$11,$12::uuid,
                   $13::uuid,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
                   $24::timestamptz,$24::timestamptz)`,
          [
            assignment.assignmentId,
            registry.CONTROLLED_ASSIGNMENT_VERSION,
            historicalExperimentId,
            historicalBatchId,
            assignment.armId,
            assignment.armRole,
            businessId,
            providerAccountRefId,
            providerAccountId,
            assignment.recommendationFingerprint,
            assignment.recId,
            assignment.evaluationId,
            assignment.snapshotId,
            assignment.target.entityType,
            assignment.target.entityId,
            assignment.assignedAction,
            assignment.assignmentProbability,
            registry.CONTROLLED_RANDOMIZATION_ALGORITHM,
            seedCommitmentHash,
            eligibility.eligibilityHash,
            assignment.randomizationDraw,
            assignment.randomizationProofHash,
            assignment.assignmentHash,
            iso(historicalAssigned),
          ],
        );
      }
    });
    const seedHash = registry.buildSeedCommitment({
      experimentId: historicalExperimentId,
      seed: historicalSeed,
    });
    const revealHash = registry.controlledSha256({
      contractVersion: registry.CONTROLLED_SEED_REVEAL_VERSION,
      batchId: historicalBatchId,
      experimentId: historicalExperimentId,
      businessId,
      providerAccountRefId,
      providerAccountId,
      seedHash,
      seed: historicalSeed,
    });
    const historicalRevealAt = new Date(historicalAssigned.getTime() + 60_000);
    await sql.query(
      `INSERT INTO meta_controlled_seed_reveals
       (batch_id, contract_version, experiment_id, business_id,
        provider_account_ref_id, provider_account_id, revealed_seed,
        seed_hash, reveal_hash, revealed_at, created_at)
       VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$9,
               $10::timestamptz,$10::timestamptz)`,
      [
        historicalBatchId,
        registry.CONTROLLED_SEED_REVEAL_VERSION,
        historicalExperimentId,
        businessId,
        providerAccountRefId,
        providerAccountId,
        historicalSeed,
        seedHash,
        revealHash,
        iso(historicalRevealAt),
      ],
    );

    const controlAssignments = assignments.filter(
      (assignment) => assignment.armRole === "control",
    );
    const outcomeComputedAt = new Date(
      historicalWindowEnd.getTime() + 6 * 3_600_000,
    );
    async function insertNativeOutcome(
      assignment: (typeof assignments)[number],
      value: number,
      computedAt: Date,
      actionContaminated = false,
      verifiedActions: readonly unknown[] = [],
    ) {
      const outcomeId = randomUUID();
      const sourceReceipts = {
        adDailyPublication: [],
        adFacts: [],
        invalidAdFacts: [],
        verifiedActions,
        invalidActions: [],
        entityStates: [],
        invalidFactCount: 0,
      };
      const actionSourceHash = registry.controlledSha256(verifiedActions);
      const sourceHash = registry.controlledSha256({
        assignmentId: assignment.assignmentId,
        value,
        computedAt: iso(computedAt),
        sourceReceipts,
      });
      await sql.query(
        `INSERT INTO engine_v3_ad_decision_outcomes_daily
         (id, contract_version, classifier_version, decision_snapshot_id,
          evaluation_id, business_ref_id, business_id, provider_account_id,
          decision_entity_type, decision_entity_id, ad_id,
          outcome_window_start, outcome_window_end, window_complete,
          measurement_status, realized_outcome, action_contaminated,
          outcome_roas, outcome_revenue, outcome_purchases, outcome_spend,
          action_source_hash, source_manifest_hash, source_receipts_json,
          computed_at)
         VALUES ($1::uuid,'engine-v3-ad-decision-outcome.v1','seam-classifier.v1',
                 $2::uuid,$3::uuid,$4::uuid,$4,$5,'ad',$6,$6,
                 $7::date,$8::date,TRUE,'known','positive',$17,
                 $9,$10,$11,$12,$13,$14,$15::jsonb,$16::timestamptz)`,
        [
          outcomeId,
          assignment.snapshotId,
          assignment.evaluationId,
          businessId,
          providerAccountId,
          assignment.target.entityId,
          iso(historicalWindowStart).slice(0, 10),
          iso(historicalWindowEnd).slice(0, 10),
          value,
          value * 100,
          value,
          100,
          actionSourceHash,
          sourceHash,
          JSON.stringify(sourceReceipts),
          iso(computedAt),
          actionContaminated,
        ],
      );
      return outcomeId;
    }
    for (let index = 0; index < controlAssignments.length; index += 1) {
      const assignment = controlAssignments[index]!;
      const computedAt =
        index === controlAssignments.length - 1
          ? new Date(historicalWindowEnd.getTime() - 60_000)
          : outcomeComputedAt;
      await insertNativeOutcome(assignment, index + 1, computedAt);
    }

    const tamperAssignment = controlAssignments[0]!;
    const [tamperNativeOutcome] = await sql.query<{
      id: string;
      contract_version: string;
      classifier_version: string;
      source_manifest_hash: string;
      computed_at: string;
    }>(
      `SELECT id::text, contract_version, classifier_version,
              source_manifest_hash::text, computed_at::text
       FROM engine_v3_ad_decision_outcomes_daily
       WHERE decision_snapshot_id = $1::uuid
         AND evaluation_id = $2::uuid
       ORDER BY computed_at DESC, id DESC
       LIMIT 1`,
      [tamperAssignment.snapshotId, tamperAssignment.evaluationId],
    );
    assert(tamperNativeOutcome, "Missing native outcome for tamper seam.");
    const tamperObservationId = randomUUID();
    const tamperComputedAt = iso(new Date(tamperNativeOutcome.computed_at));
    const tamperValue = "999.000000000000";
    const tamperReceipt = {
      contractVersion: registry.CONTROLLED_SOURCE_RECEIPT_VERSION,
      nativeOutcomeId: tamperNativeOutcome.id,
      sourceManifestHash: tamperNativeOutcome.source_manifest_hash,
      computedAt: tamperComputedAt,
      metricName: "outcome_roas",
    };
    const tamperObservationHash = registry.buildControlObservationHash({
      observationId: tamperObservationId,
      experimentId: historicalExperimentId,
      batchId: historicalBatchId,
      controlAssignmentId: tamperAssignment.assignmentId,
      nativeOutcomeId: tamperNativeOutcome.id,
      nativeOutcomeContractVersion: tamperNativeOutcome.contract_version,
      nativeOutcomeClassifierVersion: tamperNativeOutcome.classifier_version,
      nativeOutcomeSourceManifestHash: tamperNativeOutcome.source_manifest_hash,
      nativeOutcomeComputedAt: tamperComputedAt,
      metricName: "outcome_roas",
      metricDirection: "increase",
      windowStartAt: iso(historicalWindowStart),
      windowEndAt: iso(historicalWindowEnd),
      value: tamperValue,
      observedAt: tamperComputedAt,
      asOf: iso(historicalEnds),
    });
    await expectPgError(
      () =>
        sql.query(
          `INSERT INTO meta_controlled_control_outcome_observations
           (id,contract_version,experiment_id,batch_id,control_assignment_id,
            arm_role,business_id,provider_account_ref_id,provider_account_id,
            native_outcome_id,native_outcome_contract_version,
            native_outcome_classifier_version,native_outcome_source_manifest_hash,
            native_outcome_computed_at,metric_name,metric_direction,
            window_start_at,window_end_at,source_receipt_id,source_receipt_hash,
            source_receipt_json,metric_value,sample_size,observation_status,
            observed_at,as_of,finalized_at,observation_hash,created_at)
           VALUES ($1::uuid,$2,$3,$4,$5,'control',$6::uuid,$7::uuid,$8,
                   $9::uuid,$10,$11,$12,$13::timestamptz,'outcome_roas',
                   'increase',$14::timestamptz,$15::timestamptz,$9,$12,
                   $16::jsonb,$17::numeric,1,'finalized',$13::timestamptz,
                   $18::timestamptz,statement_timestamp(),$19,
                   statement_timestamp())`,
          [
            tamperObservationId,
            registry.CONTROLLED_OBSERVATION_VERSION,
            historicalExperimentId,
            historicalBatchId,
            tamperAssignment.assignmentId,
            businessId,
            providerAccountRefId,
            providerAccountId,
            tamperNativeOutcome.id,
            tamperNativeOutcome.contract_version,
            tamperNativeOutcome.classifier_version,
            tamperNativeOutcome.source_manifest_hash,
            tamperComputedAt,
            iso(historicalWindowStart),
            iso(historicalWindowEnd),
            JSON.stringify(tamperReceipt),
            tamperValue,
            iso(historicalEnds),
            tamperObservationHash,
          ],
        ),
      ["23514"],
      "caller-controlled control metric tamper",
    );

    await expectRegistryRejection(
      () =>
        registry.materializeControlledControlObservations({
          experimentId: historicalExperimentId,
          batchId: historicalBatchId,
          businessId,
          providerAccountRefId,
          providerAccountId,
        }),
      "incomplete control outcome chronology",
    );
    const [zeroObservationRow] = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM meta_controlled_control_outcome_observations
       WHERE experiment_id = $1`,
      [historicalExperimentId],
    );
    assert(
      zeroObservationRow?.count === "0",
      "Incomplete observation set leaked a partial write.",
    );
    await insertNativeOutcome(
      controlAssignments.at(-1)!,
      controlAssignments.length,
      new Date(historicalEnds.getTime() + 60_000),
    );
    await expectRegistryRejection(
      () =>
        registry.materializeControlledControlObservations({
          experimentId: historicalExperimentId,
          batchId: historicalBatchId,
          businessId,
          providerAccountRefId,
          providerAccountId,
        }),
      "late control outcome chronology",
    );
    const [lateObservationRow] = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM meta_controlled_control_outcome_observations
       WHERE experiment_id = $1`,
      [historicalExperimentId],
    );
    assert(
      lateObservationRow?.count === "0",
      "Late observation set leaked a partial write.",
    );
    await insertNativeOutcome(
      controlAssignments.at(-1)!,
      controlAssignments.length,
      outcomeComputedAt,
    );
    const observations =
      await registry.materializeControlledControlObservations({
        experimentId: historicalExperimentId,
        batchId: historicalBatchId,
        businessId,
        providerAccountRefId,
        providerAccountId,
      });
    const observationRetry =
      await registry.materializeControlledControlObservations({
        experimentId: historicalExperimentId,
        batchId: historicalBatchId,
        businessId,
        providerAccountRefId,
        providerAccountId,
      });
    assert(
      observations.length === controlAssignments.length &&
        observations.map((row) => row.observationId).join(",") ===
          observationRetry.map((row) => row.observationId).join(","),
      "Control observation materialization was not full-set idempotent.",
    );

    const treatment = assignments.find(
      (assignment) => assignment.armRole === "treatment",
    )!;
    const treatmentLineage = historicalLineage.find(
      (entry) => entry.adId === treatment.target.entityId,
    )!;
    const actionLogId = randomUUID();
    const actionExecutedAt = new Date(historicalStart.getTime() + 3_600_000);
    const providerObservedAt = new Date(actionExecutedAt.getTime() + 60_000);
    const verifiedAt = new Date(actionExecutedAt.getTime() + 120_000);
    const providerResponseHash = registry.controlledSha256({
      provider: "meta",
      actionLogId,
    });
    const verificationPayload = {
      contractVersion: registry.CONTROLLED_PROVIDER_VERIFICATION_VERSION,
      actionLogId,
      controlledAssignmentId: treatment.assignmentId,
      businessId,
      providerAccountRefId,
      providerAccountId,
      snapshotId: treatment.snapshotId,
      evaluationId: treatment.evaluationId,
      engineVersion: "v3-ad-seam",
      decisionHash: treatmentLineage.decisionHash,
      entityType: "ad" as const,
      entityId: treatment.target.entityId,
      action: "pause",
      status: "PAUSED",
      observedAt: iso(providerObservedAt),
      responseHash: providerResponseHash,
    };
    const providerVerificationHash =
      registry.buildControlledProviderVerificationHash({
        ...verificationPayload,
        action: "pause",
        status: "PAUSED",
      });
    const unboundTreatedNativeOutcomeId = await insertNativeOutcome(
      treatment,
      controlAssignments.length + 1,
      outcomeComputedAt,
      true,
    );
    const treatedNativeOutcomeId = await insertNativeOutcome(
      treatment,
      controlAssignments.length + 1,
      outcomeComputedAt,
      true,
      [
        {
          id: actionLogId,
          businessId,
          providerAccountRefId,
          providerAccountId,
          targetEntityType: "ad",
          targetEntityId: treatment.target.entityId,
          action: "pause",
          status: "success",
          dryRun: false,
          executedAt: iso(actionExecutedAt),
          verifiedAt: iso(verifiedAt),
          providerEntityId: treatment.target.entityId,
          providerAction: "pause",
          providerStatus: "PAUSED",
          providerObservedAt: iso(providerObservedAt),
          providerResponseHash,
          providerVerificationHash,
          verificationPayload,
          source: "decision_origin",
          sourceSnapshotId: treatment.snapshotId,
          sourceEvaluationId: treatment.evaluationId,
          engineVersion: "v3-ad-seam",
          decisionHash: treatmentLineage.decisionHash,
          idempotencyKey: `controlled:${treatment.assignmentId}`,
          nativeDecisionLineageValidated: true,
          nativeReceiptHashValidated: false,
          controlledReceiptHashValidated: true,
          controlledAssignmentId: treatment.assignmentId,
          recIdOrigin: treatment.recId,
          createdAt: iso(actionExecutedAt),
          updatedAt: iso(verifiedAt),
        },
      ],
    );
    await expectPgError(
      () =>
        sql.query(
          `INSERT INTO meta_ads_action_log
           (id,business_id,ad_id,action,source,requested_at,status,rec_id_origin,
            verification_payload,verified_at,created_at,updated_at,
            provider_account_ref_id,provider_account_id,controlled_assignment_id,
            target_entity_type,target_entity_id,source_snapshot_id,
            source_evaluation_id,engine_version,decision_hash,dry_run,executed_at,
            provider_entity_id,provider_action,provider_status,
            provider_observed_at,provider_response_hash,provider_verification_hash)
           VALUES ($1::uuid,$2::uuid,$3,'pause','decision_origin',$4::timestamptz,
                   'success',$5,'{}'::jsonb,$6::timestamptz,$4::timestamptz,
                   $4::timestamptz,$7::uuid,$8,$9,'ad',$3,$10::uuid,$11::uuid,
                   $12,$13,FALSE,$4::timestamptz,$3,'pause','PAUSED',
                   $14::timestamptz,$15,$16)`,
          [
            actionLogId,
            businessId,
            treatment.target.entityId,
            iso(actionExecutedAt),
            treatment.recId,
            iso(verifiedAt),
            providerAccountRefId,
            providerAccountId,
            treatment.assignmentId,
            treatment.snapshotId,
            treatment.evaluationId,
            "v3-ad-seam",
            treatmentLineage.decisionHash,
            iso(providerObservedAt),
            providerResponseHash,
            providerVerificationHash,
          ],
        ),
      ["23514"],
      "arbitrary provider verification payload",
    );
    await sql.query(
      `INSERT INTO meta_ads_action_log
       (id,business_id,ad_id,action,source,requested_at,status,rec_id_origin,
        verification_payload,verified_at,created_at,updated_at,
        provider_account_ref_id,provider_account_id,controlled_assignment_id,
        target_entity_type,target_entity_id,source_snapshot_id,
        source_evaluation_id,engine_version,decision_hash,dry_run,executed_at,
        provider_entity_id,provider_action,provider_status,
        provider_observed_at,provider_response_hash,provider_verification_hash)
       VALUES ($1::uuid,$2::uuid,$3,'pause','decision_origin',$4::timestamptz,
               'success',$5,$6::jsonb,$7::timestamptz,$4::timestamptz,
               $4::timestamptz,$8::uuid,$9,$10,'ad',$3,$11::uuid,$12::uuid,
               $13,$14,FALSE,$4::timestamptz,$3,'pause','PAUSED',
               $15::timestamptz,$16,$17)`,
      [
        actionLogId,
        businessId,
        treatment.target.entityId,
        iso(actionExecutedAt),
        treatment.recId,
        JSON.stringify(verificationPayload),
        iso(verifiedAt),
        providerAccountRefId,
        providerAccountId,
        treatment.assignmentId,
        treatment.snapshotId,
        treatment.evaluationId,
        "v3-ad-seam",
        treatmentLineage.decisionHash,
        iso(providerObservedAt),
        providerResponseHash,
        providerVerificationHash,
      ],
    );

    const estimateId = "historical-estimate";
    const outcomeLogId = randomUUID();
    const outcomePayload = {
      evidenceClass: registry.CONTROLLED_EVIDENCE_CLASS,
      causalDesign: {
        contractVersion: registry.CONTROLLED_CAUSAL_DESIGN_VERSION,
        method: "randomized_controlled_trial",
        experimentId: historicalExperimentId,
        batchId: historicalBatchId,
        assignmentId: treatment.assignmentId,
        estimateId,
      },
      treatmentReceipt: {
        contractVersion: registry.CONTROLLED_TREATMENT_RECEIPT_VERSION,
        actionLogId,
        status: "success",
        verificationStatus: "verified",
        recommendationFingerprint: treatment.recommendationFingerprint,
        recId: treatment.recId,
        experimentId: historicalExperimentId,
        batchId: historicalBatchId,
        assignmentId: treatment.assignmentId,
      },
    };
    const outcomeOccurredAt = new Date(
      historicalWindowEnd.getTime() + 12 * 3_600_000,
    );
    async function insertOutcomeLog(status: "positive" | "negative") {
      await sql.query(
        `INSERT INTO meta_decision_action_outcome_logs
         (id,business_id,business_ref_id,provider_account_id,
          provider_account_ref_id,recommendation_fingerprint,rec_id,rec_type,
          decision_label,action_type,outcome_status,payload_json,occurred_at)
         VALUES ($1::uuid,$2::text,$2::uuid,$3,$4::uuid,$5,$6,
                 'engine_v3_ad_decision','cut','outcome',$9,$7::jsonb,
                 $8::timestamptz)`,
        [
          outcomeLogId,
          businessId,
          providerAccountId,
          providerAccountRefId,
          treatment.recommendationFingerprint,
          treatment.recId,
          JSON.stringify(outcomePayload),
          iso(outcomeOccurredAt),
          status,
        ],
      );
    }
    const estimateInput = {
      estimateId,
      experimentId: historicalExperimentId,
      batchId: historicalBatchId,
      treatedAssignmentId: treatment.assignmentId,
      treatedOutcomeLogId: outcomeLogId,
      treatedNativeOutcomeId,
      treatmentActionLogId: actionLogId,
      businessId,
      providerAccountRefId,
      providerAccountId,
    };
    await insertOutcomeLog("negative");
    let mismatchedOutcomeRejected = false;
    try {
      await registry.finalizeControlledControlEstimate(estimateInput);
    } catch (error) {
      mismatchedOutcomeRejected =
        error instanceof registry.ControlledRegistryConflictError;
    }
    assert(
      mismatchedOutcomeRejected,
      "Caller terminal status overrode the immutable native realized outcome.",
    );
    await sql.query(
      `DELETE FROM meta_decision_action_outcome_logs WHERE id = $1::uuid`,
      [outcomeLogId],
    );
    await insertOutcomeLog("positive");
    await expectRegistryRejection(
      () =>
        registry.finalizeControlledControlEstimate({
          ...estimateInput,
          treatedNativeOutcomeId: unboundTreatedNativeOutcomeId,
        }),
      "treated native outcome without exact action receipt",
    );
    const finalized = await registry.finalizeControlledControlEstimate({
      ...estimateInput,
    });
    const finalizedRetry = await registry.finalizeControlledControlEstimate({
      ...estimateInput,
    });
    assert(
      finalized.estimateHash === finalizedRetry.estimateHash &&
        finalized.sampleSize === controlAssignments.length &&
        finalized.variance !== null &&
        finalized.standardError !== null,
      "DB-derived estimate or uncertainty was not exact/idempotent.",
    );
    const verifiedEvidence =
      await registry.readVerifiedControlledEvidenceForOutcomes({
        businessId,
        providerAccountRefId,
        providerAccountId,
        recTypes: ["engine_v3_ad_decision"],
        outcomeLogIds: [outcomeLogId],
      });
    assert(
      verifiedEvidence.length === 1 &&
        verifiedEvidence[0]?.controlledEvidenceValidated === true &&
        verifiedEvidence[0]?.invalidReasonCodes.length === 0,
      `Exact controlled evidence hydration failed: ${JSON.stringify(verifiedEvidence)}`,
    );

    await expectPgError(
      () =>
        sql.query(
          `UPDATE meta_controlled_control_estimates
           SET estimate_value = estimate_value + 1 WHERE id = $1`,
          [estimateId],
        ),
      ["55000"],
      "immutable estimate tamper",
    );
    await expectPgError(
      () =>
        sql.query(
          `UPDATE meta_decision_action_outcome_logs
           SET outcome_status = 'negative' WHERE id = $1::uuid`,
          [outcomeLogId],
        ),
      ["55000"],
      "estimate-bound outcome tamper",
    );

    await runDbTransaction(async () => {
      const transactionSql = getDb();
      await transactionSql.query(
        `ALTER TABLE meta_controlled_seed_reveals
         DISABLE TRIGGER trg_meta_controlled_seed_reveal_guard`,
      );
      const degraded = await registry.inspectControlledRegistryCapabilities();
      assert(
        !degraded.ready &&
          degraded.issues.some((issue) => issue.includes("seed_reveal_guard")),
        "Schema capability inspection did not detect a disabled trigger.",
      );
      throw new Error("rollback-capability-tamper");
    }).catch((error) => {
      if (
        error instanceof Error &&
        error.message === "rollback-capability-tamper"
      ) {
        return;
      }
      throw error;
    });
    await runDbTransaction(async () => {
      const transactionSql = getDb();
      await transactionSql.query(`
        CREATE OR REPLACE FUNCTION meta_validate_controlled_seed_reveal()
        RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          RETURN NEW;
        END
        $fn$
      `);
      const degraded = await registry.inspectControlledRegistryCapabilities();
      assert(
        !degraded.ready &&
          degraded.issues.some((issue) => issue.includes("seed_reveal_guard")),
        "Schema capability inspection accepted a trigger with the wrong function body.",
      );
      throw new Error("rollback-trigger-definition-tamper");
    }).catch((error) => {
      if (
        error instanceof Error &&
        error.message === "rollback-trigger-definition-tamper"
      ) {
        return;
      }
      throw error;
    });

    resetDbClientCache();
    console.log("controlled-experiment-registry-seam: ok");
  } finally {
    if (started) {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
        encoding: "utf8",
      });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
