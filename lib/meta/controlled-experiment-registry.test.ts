import fs from "node:fs";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  CONTROLLED_REGISTRY_SCHEMA_SQL,
  CONTROLLED_REGISTRY_SCHEMA_SQL_SHA256,
  ControlledRegistryValidationError,
  buildEligibilityContract,
  buildSeedCommitment,
  createControlledExperimentRegistryStore,
  stableControlledJson,
} from "./controlled-experiment-registry";

const UUIDS = {
  business: "11111111-1111-4111-8111-111111111111",
  account: "22222222-2222-4222-8222-222222222222",
  evaluation: "33333333-3333-4333-8333-333333333333",
  snapshot: "44444444-4444-4444-8444-444444444444",
};

function manifest(entityId = "ad-1") {
  return [
    {
      assignmentId: `assignment-${entityId}`,
      recommendationFingerprint: `fingerprint-${entityId}`,
      recId: `rec-${entityId}`,
      evaluationId: UUIDS.evaluation,
      snapshotId: UUIDS.snapshot,
      target: { entityType: "ad" as const, entityId },
    },
  ];
}

describe("controlled experiment registry contracts", () => {
  it("canonicalizes object order and commits a sufficiently strong seed", () => {
    expect(stableControlledJson({ z: 1, a: { y: 2, x: 1 } })).toBe(
      '{"a":{"x":1,"y":2},"z":1}',
    );
    expect(
      buildSeedCommitment({
        experimentId: "experiment-1",
        seed: "0123456789abcdef0123456789abcdef",
      }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds the complete manifest and rejects non-native grains", () => {
    const contract = buildEligibilityContract(manifest());
    expect(contract.eligibilityCount).toBe(1);
    expect(contract.eligibilityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(contract.assignmentManifestHash).toMatch(/^[0-9a-f]{64}$/);

    expect(() =>
      buildEligibilityContract([
        {
          ...manifest()[0]!,
          target: { entityType: "campaign", entityId: "campaign-1" },
        },
      ]),
    ).toThrowError(/only for native ad decisions/i);
  });

  it("never accepts a custom query adapter without a bound transaction", () => {
    expect(() =>
      createControlledExperimentRegistryStore({
        query: async () => [],
      }),
    ).toThrowError(ControlledRegistryValidationError);
  });

  it("returns an exact empty outcome set without inspecting or widening SQL", async () => {
    let queryCount = 0;
    const store = createControlledExperimentRegistryStore({
      query: async () => {
        queryCount += 1;
        return [];
      },
      transaction: async (operation) => operation(async () => []),
    });
    await expect(
      store.readVerifiedEvidence({
        businessId: UUIDS.business,
        providerAccountRefId: UUIDS.account,
        providerAccountId: "act_test",
        recTypes: ["engine_v3_ad_decision"],
        outcomeLogIds: [],
      }),
    ).resolves.toEqual([]);
    expect(queryCount).toBe(0);
  });

  it("exports the complete migration SQL used by the seam", () => {
    expect(CONTROLLED_REGISTRY_SCHEMA_SQL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    for (const fragment of [
      "CREATE TABLE IF NOT EXISTS meta_controlled_experiments",
      "CREATE TABLE IF NOT EXISTS meta_controlled_random_assignments",
      "CREATE TABLE IF NOT EXISTS meta_controlled_control_outcome_observations",
      "CREATE TABLE IF NOT EXISTS meta_controlled_control_estimates",
      "engine_v3_ad_evaluations_controlled_identity_key",
      "meta_controlled_experiments_business_fk",
      "meta_validate_controlled_experiment_account_binding",
      "meta_controlled_random_assignments_snapshot_fk",
      "meta_validate_controlled_assignment_batch",
      "trg_meta_controlled_assignment_batch_header_guard",
      "meta_validate_controlled_seed_reveal",
      "meta_validate_controlled_control_observation",
      "meta_prevent_verified_controlled_action_mutation",
      "meta_prevent_bound_controlled_outcome_mutation",
    ]) {
      expect(CONTROLLED_REGISTRY_SCHEMA_SQL).toContain(fragment);
    }
  });
});

const postgresCandidates = [
  process.env.EPHEMERAL_PG_BIN_DIR
    ? `${process.env.EPHEMERAL_PG_BIN_DIR}/initdb`
    : "",
  "/opt/homebrew/opt/postgresql@16/bin/initdb",
  "/opt/homebrew/bin/initdb",
  "/usr/local/opt/postgresql@16/bin/initdb",
  "/usr/bin/initdb",
].filter(Boolean);
const postgresAvailable = postgresCandidates.some((candidate) =>
  fs.existsSync(candidate),
);

describe.runIf(postgresAvailable)(
  "controlled experiment PostgreSQL seam",
  () => {
    it("proves exact schema, atomic assignment, idempotency, and tamper rejection", async () => {
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/ephemeral-postgres-controlled-experiment-registry-seam-child.ts",
          ],
          {
            cwd: process.cwd(),
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(
        "controlled-experiment-registry-seam: ok",
      );
    }, 120_000);
  },
);
