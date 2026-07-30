import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("runtime contract", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = "postgres://user:pass@127.0.0.1:5432/adsecute_prod";
    delete process.env.SYNC_WORKER_MODE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("marks production contract invalid when critical sync posture is implicit", async () => {
    process.env = { ...process.env, NODE_ENV: "production" };
    delete process.env.META_AUTHORITATIVE_FINALIZATION_V2;
    delete process.env.META_RETENTION_EXECUTION_ENABLED;
    delete process.env.SYNC_DEPLOY_GATE_MODE;
    delete process.env.SYNC_RELEASE_GATE_MODE;
    delete process.env.SYNC_RELEASE_CANARY_BUSINESSES;

    const { buildRuntimeContract } = await import("@/lib/sync/runtime-contract");
    const contract = buildRuntimeContract({ service: "web" });

    expect(contract.validation.pass).toBe(false);
    expect(contract.validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "meta_finalization_implicit",
        "meta_retention_implicit",
        "deploy_gate_mode_implicit",
        "release_gate_mode_implicit",
        "release_canary_unconfigured",
      ]),
    );
  });

  it("accepts production contract when explicit posture and canaries are present", async () => {
    process.env = { ...process.env, NODE_ENV: "production" };
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";
    process.env.META_RETENTION_EXECUTION_ENABLED = "0";
    process.env.SYNC_DEPLOY_GATE_MODE = "block";
    process.env.SYNC_RELEASE_GATE_MODE = "measure_only";
    process.env.SYNC_RELEASE_CANARY_BUSINESSES =
      "172d0ab8-495b-4679-a4c6-ffa404c389d3,5dbc7147-f051-4681-a4d6-20617170074f";

    const { buildRuntimeContract } = await import("@/lib/sync/runtime-contract");
    const contract = buildRuntimeContract({ service: "web" });

    expect(contract.validation.pass).toBe(true);
    expect(contract.config.releaseCanaryConfigured).toBe(true);
    expect(contract.config.releaseCanaryHasMandatoryCanary).toBe(true);
    expect(contract.config.deployGateMode).toBe("block");
    expect(contract.config.releaseGateMode).toBe("measure_only");
  });

  it("throws on invalid production startup contract", async () => {
    process.env = { ...process.env, NODE_ENV: "production" };
    delete process.env.META_AUTHORITATIVE_FINALIZATION_V2;
    process.env.META_RETENTION_EXECUTION_ENABLED = "0";
    process.env.SYNC_DEPLOY_GATE_MODE = "block";
    process.env.SYNC_RELEASE_GATE_MODE = "measure_only";

    const { assertRuntimeContractStartup } = await import("@/lib/sync/runtime-contract");

    expect(() => assertRuntimeContractStartup({ service: "web" })).toThrow(
      /Runtime contract invalid/,
    );
  });

  it("keeps config fingerprint stable across web and worker roles for the same posture", async () => {
    process.env = { ...process.env, NODE_ENV: "production" };
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";
    process.env.META_RETENTION_EXECUTION_ENABLED = "0";
    process.env.SYNC_DEPLOY_GATE_MODE = "block";
    process.env.SYNC_RELEASE_GATE_MODE = "measure_only";
    process.env.SYNC_RELEASE_CANARY_BUSINESSES =
      "172d0ab8-495b-4679-a4c6-ffa404c389d3,5dbc7147-f051-4681-a4d6-20617170074f";

    const { buildRuntimeContract } = await import("@/lib/sync/runtime-contract");
    const webContract = buildRuntimeContract({ service: "web" });
    const workerContract = buildRuntimeContract({
      service: "worker",
      env: {
        ...process.env,
        SYNC_WORKER_MODE: "1",
      },
    });

    expect(webContract.config).toEqual(workerContract.config);
    expect(webContract.configFingerprint).toBe(workerContract.configFingerprint);
  });

  // The staged worker has to be identifiable from its own runtime row. Nothing
  // else in that row can distinguish it: service, runtime_role and build_id are
  // identical by design because deploy-disabled starts the release's own worker,
  // health_state is binary and genuinely 'healthy' for a process that started and
  // validated, and provider_scopes is a static per-service constant rather than
  // the lane admission set.
  it("records that a worker is the staged one, in every spelling the entrypoint accepts", async () => {
    const { buildRuntimeContract } = await import("@/lib/sync/runtime-contract");
    for (const value of ["1", "true", "yes", "enabled", "ENABLED", " True "]) {
      const contract = buildRuntimeContract({
        service: "worker",
        env: { ...process.env, SYNC_WORKER_STAGING_IDLE: value },
      });
      expect(contract.config.workerStagingIdle).toBe(true);
    }
    for (const value of ["", "0", "false", "no"]) {
      const contract = buildRuntimeContract({
        service: "worker",
        env: { ...process.env, SYNC_WORKER_STAGING_IDLE: value },
      });
      expect(contract.config.workerStagingIdle).toBe(false);
    }
    // The variable is meaningless for web, and must never make a web row claim
    // to be a staged worker.
    expect(
      buildRuntimeContract({
        service: "web",
        env: { ...process.env, SYNC_WORKER_STAGING_IDLE: "1" },
      }).config.workerStagingIdle,
    ).toBe(false);
  });

  // Deliberately outside the fingerprint: that value is compared BETWEEN the web
  // and worker rows, so a term only the worker can carry would make them disagree
  // during every staged deploy — the gate would refuse for a fingerprint mismatch
  // instead of for the staged worker that actually applies.
  it("keeps the staged flag out of the config fingerprint, so web and worker still agree during a staged deploy", async () => {
    const { buildRuntimeContract } = await import("@/lib/sync/runtime-contract");
    const web = buildRuntimeContract({ service: "web", env: { ...process.env } });
    const staged = buildRuntimeContract({
      service: "worker",
      env: { ...process.env, SYNC_WORKER_STAGING_IDLE: "1" },
    });

    expect(staged.config.workerStagingIdle).toBe(true);
    expect(web.config.workerStagingIdle).toBe(false);
    expect(staged.config).not.toEqual(web.config);
    expect(staged.configFingerprint).toBe(web.configFingerprint);
  });
});
