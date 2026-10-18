import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDbWithTimeout: vi.fn() }));

const db = await import("@/lib/db");
const {
  evaluateDbGrowthFence,
  readDbGrowthFenceObservation,
  resetDbGrowthFenceReadObservationCache,
  fencedTableProviderFamily,
  operationProviderFamily,
  assertDbGrowthFenceAdmits,
  assertSyncGrowthBoundary,
  resetDbGrowthFenceCache,
  evaluateGrowthFenceOverride,
  DbGrowthFenceRefusal,
  FENCED_TABLES,
  DEFAULT_TABLE_BUDGET_BYTES,
  OVERRIDE_ENV_FLAG,
  OVERRIDE_ENV_VALUE,
  OVERRIDE_REASON_ENV,
  OVERRIDE_EXPIRES_ENV,
  DEFAULT_DATABASE_BUDGET_BYTES,
  LIVE_MEASUREMENT,
  PLANNED_VOLUME_HEADROOM_BYTES,
  MINIMUM_VOLUME_FREE_BYTES,
  DEFAULT_WARNING_RATIO,
  evaluatePhysicalCapacity,
  PHYSICAL_DATA_PATH,
  PHYSICAL_SNAPSHOT_MAX_AGE_MS,
  PHYSICAL_TELEMETRY_SOURCE,
  MINIMUM_VOLUME_FREE_BYTES: MIN_FREE,
} = await import("@/lib/sync/db-growth-fence");

const GiB = 1024 ** 3;
const DB_NAME = "adsecute_prod";

function installDb(
  rows:
    | Array<Record<string, unknown>>
    | (() => never),
) {
  const query = vi.fn(async () => {
    if (typeof rows === "function") rows();
    return rows;
  });
  vi.mocked(db.getDbWithTimeout).mockReturnValue({ query } as never);
  return query;
}

/**
 * A healthy host telemetry row: fresh, on the data path, with room to spare.
 *
 * Every logical-budget test needs one, because physical admission is now a
 * precondition of reaching the logical checks at all — which is the point.
 */
function capacityPayload(overrides: Record<string, unknown> = {}) {
  return {
    sampledAt: new Date().toISOString(),
    hostname: "db-host",
    database: { name: DB_NAME, sizeBytes: 1, sizePretty: "1 bytes" },
    disks: [
      { path: "/", totalBytes: 100 * GiB, usedBytes: 10 * GiB, availableBytes: 90 * GiB },
      {
        path: PHYSICAL_DATA_PATH,
        totalBytes: 400 * GiB,
        usedBytes: 190 * GiB,
        availableBytes: 210 * GiB,
      },
    ],
    ...overrides,
  };
}

function sizes(
  overrides: Partial<Record<string, number | null>> = {},
  capacity: Partial<Record<string, unknown>> = {},
) {
  return FENCED_TABLES.map((table) => ({
    database_bytes: overrides.database_bytes ?? 10 * GiB,
    database_name: DB_NAME,
    table_name: table,
    table_bytes: table in overrides ? overrides[table] : 1 * GiB,
    capacity_id: "1",
    capacity_sampled_at: new Date().toISOString(),
    capacity_age_seconds: 120,
    capacity_payload: capacityPayload(),
    ...capacity,
  }));
}

describe("db growth fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("admits under limit", async () => {
    installDb(sizes());
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("ready");
    expect(decision.warning).toBe(false);
    expect(decision.overridden).toBe(false);
  });

  it("warns inside the threshold band but still admits", async () => {
    installDb(
      sizes({
        meta_entity_state_history:
          DEFAULT_TABLE_BUDGET_BYTES.meta_entity_state_history * 0.9,
      }),
    );
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(true);
    expect(decision.warning).toBe(true);
  });

  it("refuses over a table budget and names the offender", async () => {
    installDb(
      sizes({
        meta_entity_state_history:
          DEFAULT_TABLE_BUDGET_BYTES.meta_entity_state_history + 1,
      }),
    );
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("table_budget_exceeded");
    expect(decision.offender?.table).toBe("meta_entity_state_history");
    expect(decision.offender?.budget).toBeGreaterThan(0);
  });

  it("refuses over the database budget", async () => {
    installDb(sizes({ database_bytes: 500 * GiB }));
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("database_budget_exceeded");
    expect(decision.offender?.table).toBe("database");
  });

  function nativeHeapDb(capacity: Record<string, unknown> = {}, table: Record<string, number> = {}) {
    const raw = DEFAULT_DATABASE_BUDGET_BYTES + GiB;
    const proof = {database_bytes:raw,total_bytes:60*GiB,heap_bytes:20*GiB,
      table_len:20*GiB,approx_free_space:4*GiB};
    const query = vi.fn(async (sql: string) => sql.includes("WITH proof") ? [proof] :
      sizes({database_bytes:raw,...table},capacity));
    vi.mocked(db.getDbWithTimeout).mockReturnValue({query} as never);
    return {query,proof,raw};
  }
  const heapAccountingEnv = {SYNC_GROWTH_FENCE_REUSABLE_NATIVE_HEAP_ENABLED:"true"};
  it("counts proven reusable native main heap without changing raw bytes, budgets or override",async()=>{
    const {raw}=nativeHeapDb();
    const result=await evaluateDbGrowthFence({env:heapAccountingEnv});
    expect(result).toMatchObject({allowed:true,reason:"ready",databaseBytes:raw,
      databaseBudgetBytes:DEFAULT_DATABASE_BUDGET_BYTES,overridden:false,
      databaseAccounting:{rawDatabaseBytes:raw,accountedDatabaseBytes:raw-4*GiB,reusableHeapBytes:4*GiB}});
  });
  it("caps credited headroom and still reserves all of it on disk for any other table",async()=>{
    nativeHeapDb({capacity_payload:capacityPayload({disks:[
      {path:PHYSICAL_DATA_PATH,totalBytes:220*GiB,usedBytes:178*GiB,availableBytes:42*GiB}]})});
    const result=await evaluateDbGrowthFence({env:heapAccountingEnv});
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ready");
    expect(result.databaseAccounting).toMatchObject({provenReusableHeapBytes:4*GiB,
      reusableHeapBytes:2.5*GiB,uncreditedReusableHeapBytes:1.5*GiB});
    expect(result.physical?.projectedFreeBytes).toBe(40.5*GiB);
    expect(result.databaseBudgetBytes-result.databaseAccounting!.accountedDatabaseBytes).toBe(1.5*GiB);
    expect(result.overridden).toBe(false);
  });
  it("falls back to the raw refusal if proof is unavailable or malformed",async()=>{
    const {proof}=nativeHeapDb();proof.approx_free_space=-1;
    expect(await evaluateDbGrowthFence({env:heapAccountingEnv})).toMatchObject({
      allowed:false,reason:"database_budget_exceeded",databaseAccounting:{metric:"raw"}});
  });
  it("keeps independent relation ceilings after aggregate refinement",async()=>{
    nativeHeapDb({}, {meta_raw_snapshots:DEFAULT_TABLE_BUDGET_BYTES.meta_raw_snapshots+1});
    expect(await evaluateDbGrowthFence({env:heapAccountingEnv})).toMatchObject({
      allowed:false,reason:"table_budget_exceeded",offender:{table:"meta_raw_snapshots"}});
  });
  it("names the accounted bytes that actually exceed the aggregate budget",async()=>{
    const {proof,raw}=nativeHeapDb();proof.approx_free_space=GiB/2;
    expect(await evaluateDbGrowthFence({env:heapAccountingEnv})).toMatchObject({
      allowed:false,reason:"database_budget_exceeded",databaseBytes:raw,
      offender:{table:"database",bytes:raw-GiB/2,budget:DEFAULT_DATABASE_BUDGET_BYTES}});
  });

  it.each([
    ["a fenced table is missing", sizes({ meta_creative_lineage_edges: null }), "measurement_missing"],
    ["a measurement is negative", sizes({ sync_release_gates: -1 }), "measurement_invalid"],
  ])("fails closed when %s", async (_label, rows, reason) => {
    installDb(rows as Array<Record<string, unknown>>);
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(reason);
  });

  it("fails closed when the fence read throws", async () => {
    installDb(() => {
      throw new Error("relation does not exist");
    });
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("fence_read_failed");
    expect(decision.errorMessage).toMatch(/relation does not exist/);
  });

  it("fails closed on a malformed budget rather than falling back", async () => {
    installDb(sizes());
    const decision = await evaluateDbGrowthFence({
      env: { SYNC_GROWTH_FENCE_DATABASE_BYTES: "not-a-number" },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("measurement_invalid");
  });

  it("throws on refusal so it cannot be read as benign success", async () => {
    installDb(sizes({ database_bytes: 500 * GiB }));
    await expect(assertDbGrowthFenceAdmits("test_batch", { env: {} })).rejects.toBeInstanceOf(
      DbGrowthFenceRefusal,
    );
  });

  it("returns the decision when admitted", async () => {
    installDb(sizes());
    await expect(
      assertDbGrowthFenceAdmits("test_batch", { env: {} }),
    ).resolves.toMatchObject({ allowed: true });
  });

  describe("emergency override", () => {
    const future = () => new Date(Date.now() + 60 * 60_000).toISOString();
    const granted = () => ({
      [OVERRIDE_ENV_FLAG]: OVERRIDE_ENV_VALUE,
      [OVERRIDE_REASON_ENV]: "incident-4821 manual drain",
      [OVERRIDE_EXPIRES_ENV]: future(),
    });

    it("is default-off", () => {
      expect(evaluateGrowthFenceOverride({ env: {} }).active).toBe(false);
    });

    it.each([
      ["the flag is absent", { ...granted(), [OVERRIDE_ENV_FLAG]: "" }, "flag_missing"],
      ["no reason is given", { ...granted(), [OVERRIDE_REASON_ENV]: "" }, "reason_missing"],
      ["no expiry is given", { ...granted(), [OVERRIDE_EXPIRES_ENV]: "" }, "expiry_missing"],
      [
        "the expiry has passed",
        { ...granted(), [OVERRIDE_EXPIRES_ENV]: new Date(Date.now() - 1000).toISOString() },
        "expired",
      ],
      [
        "the expiry is too far out",
        {
          ...granted(),
          [OVERRIDE_EXPIRES_ENV]: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
        },
        "expiry_too_far",
      ],
    ])("stays inactive when %s", (_label, env, issue) => {
      const result = evaluateGrowthFenceOverride({ env });
      expect(result.active).toBe(false);
      expect(result.issues).toContain(issue);
    });

    it("admits an over-budget run only when fully audited, and marks it", async () => {
      installDb(sizes({ database_bytes: 500 * GiB }));
      const decision = await evaluateDbGrowthFence({ env: granted() });
      expect(decision.allowed).toBe(true);
      expect(decision.overridden).toBe(true);
      // The refusal reason is preserved, so an override never looks healthy.
      expect(decision.reason).toBe("database_budget_exceeded");
      expect(decision.warning).toBe(true);
    });

    it.each([
      [
        "the disk is nearly full",
        {
          capacity_payload: capacityPayload({
            disks: [
              {
                path: PHYSICAL_DATA_PATH,
                totalBytes: 210 * GiB,
                usedBytes: 200 * GiB,
                availableBytes: 10 * GiB,
              },
            ],
          }),
        },
        "physical_free_space_low",
      ],
      [
        "the sample is stale",
        { capacity_age_seconds: PHYSICAL_SNAPSHOT_MAX_AGE_MS / 1000 + 1 },
        "physical_snapshot_stale",
      ],
      [
        "there is no sample at all",
        { capacity_id: null, capacity_sampled_at: null, capacity_age_seconds: null, capacity_payload: null },
        "physical_snapshot_missing",
      ],
      [
        "the payload is malformed",
        { capacity_payload: { database: { name: DB_NAME }, disks: "not-an-array" } },
        "physical_snapshot_malformed",
      ],
    ])("cannot be overridden past a physical refusal — %s", async (_label, capacity, reason) => {
      // The override exists to push past a budget an operator chose. It was
      // never a licence to write into a full or unmeasured disk, and a fully
      // audited override must not reach one.
      installDb(sizes({}, capacity as Record<string, unknown>));
      const decision = await evaluateDbGrowthFence({ env: granted() });
      expect(decision.allowed).toBe(false);
      expect(decision.overridden).toBe(false);
      expect(decision.reason).toBe(reason);
    });
  });
});

describe("physical capacity admission", () => {
  const base = {
    telemetryAvailable: true,
    databaseName: DB_NAME,
    databaseBytes: 136 * GiB,
    databaseBudgetBytes: 160 * GiB,
  };
  const snapshot = (payload: unknown, ageSeconds = 120) => ({
    id: "42",
    sampledAt: new Date().toISOString(),
    ageSeconds,
    payload,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("admits a fresh sample with room to spare and reports what it saw", () => {
    const decision = evaluatePhysicalCapacity({ ...base, snapshot: snapshot(capacityPayload()) });
    expect(decision.admitted).toBe(true);
    expect(decision.reason).toBe("ok");
    expect(decision.snapshotId).toBe("42");
    expect(decision.dataPath).toBe(PHYSICAL_DATA_PATH);
    expect(decision.availableBytes).toBe(210 * GiB);
    // 210 GiB free minus the 24 GiB of budget left to consume.
    expect(decision.projectedFreeBytes).toBe(210 * GiB - 24 * GiB);
  });

  it("refuses when telemetry is not readable at all", () => {
    const decision = evaluatePhysicalCapacity({
      ...base,
      telemetryAvailable: false,
      snapshot: null,
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("telemetry_unavailable");
  });

  it("refuses when the sampler has produced nothing", () => {
    const decision = evaluatePhysicalCapacity({ ...base, snapshot: null });
    expect(decision.reason).toBe("snapshot_missing");
  });

  it("refuses a sample that belongs to a different database", () => {
    const decision = evaluatePhysicalCapacity({
      ...base,
      snapshot: snapshot(capacityPayload({ database: { name: "some_other_db" } })),
    });
    expect(decision.reason).toBe("database_identity_mismatch");
  });

  it("refuses a future-dated sample, which would never age out", () => {
    const decision = evaluatePhysicalCapacity({
      ...base,
      snapshot: snapshot(capacityPayload(), -3600),
    });
    expect(decision.reason).toBe("snapshot_future_dated");
  });

  it("tolerates sub-minute skew from the previous host-clock producer", () => {
    const decision = evaluatePhysicalCapacity({
      ...base,
      snapshot: snapshot(capacityPayload(), -5),
    });
    expect(decision.admitted).toBe(true);
  });

  it("refuses a stale sample", () => {
    const decision = evaluatePhysicalCapacity({
      ...base,
      snapshot: snapshot(capacityPayload(), PHYSICAL_SNAPSHOT_MAX_AGE_MS / 1000 + 1),
    });
    expect(decision.reason).toBe("snapshot_stale");
  });

  it("refuses when the sample has no entry for the data path", () => {
    // The root filesystem is not a substitute: PostgreSQL's data directory is
    // frequently a separate volume, which is exactly the case here.
    const decision = evaluatePhysicalCapacity({
      ...base,
      snapshot: snapshot(
        capacityPayload({
          disks: [{ path: "/", totalBytes: 1, usedBytes: 0, availableBytes: 1 }],
        }),
      ),
    });
    expect(decision.reason).toBe("data_path_missing");
  });

  it.each([
    ["a missing field", { path: PHYSICAL_DATA_PATH, totalBytes: 210 * GiB, usedBytes: 1 }],
    ["a non-numeric field", { path: PHYSICAL_DATA_PATH, totalBytes: "x", usedBytes: 1, availableBytes: 1 }],
    ["a negative field", { path: PHYSICAL_DATA_PATH, totalBytes: 210 * GiB, usedBytes: -1, availableBytes: 1 }],
    ["a zero total", { path: PHYSICAL_DATA_PATH, totalBytes: 0, usedBytes: 0, availableBytes: 0 }],
    ["used above total", { path: PHYSICAL_DATA_PATH, totalBytes: 10, usedBytes: 11, availableBytes: 0 }],
    ["available above total", { path: PHYSICAL_DATA_PATH, totalBytes: 10, usedBytes: 0, availableBytes: 11 }],
  ])("refuses a malformed measurement: %s", (_label, disk) => {
    const decision = evaluatePhysicalCapacity({
      ...base,
      snapshot: snapshot(capacityPayload({ disks: [disk] })),
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("snapshot_malformed");
  });

  it("refuses below the free-space floor", () => {
    const decision = evaluatePhysicalCapacity({
      ...base,
      snapshot: snapshot(
        capacityPayload({
          disks: [
            {
              path: PHYSICAL_DATA_PATH,
              totalBytes: 210 * GiB,
              usedBytes: 210 * GiB - (MIN_FREE - 1),
              availableBytes: MIN_FREE - 1,
            },
          ],
        }),
      ),
    });
    expect(decision.reason).toBe("free_space_low");
  });

  it("refuses a budget the disk could not absorb, however large the budget", () => {
    // This is the case the env-supplied number could never catch: the disk is
    // healthy TODAY, and a 300 GiB budget authorises growth it cannot hold.
    const decision = evaluatePhysicalCapacity({
      ...base,
      databaseBudgetBytes: 400 * GiB,
      snapshot: snapshot(capacityPayload()),
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("projected_free_space_low");
    expect(decision.availableBytes).toBe(210 * GiB);
  });

  it("admits the same disk under a budget it can absorb", () => {
    const decision = evaluatePhysicalCapacity({
      ...base,
      databaseBudgetBytes: 160 * GiB,
      snapshot: snapshot(capacityPayload()),
    });
    expect(decision.admitted).toBe(true);
  });
});

describe("sync growth boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("caches an admitted decision so a hot loop does not re-measure", async () => {
    const query = installDb(sizes());
    const { assertSyncGrowthBoundary, resetDbGrowthFenceCache } = await import(
      "@/lib/sync/db-growth-fence"
    );
    resetDbGrowthFenceCache();
    await assertSyncGrowthBoundary("unit", { env: {} });
    await assertSyncGrowthBoundary("unit", { env: {} });
    await assertSyncGrowthBoundary("unit", { env: {} });
    expect(query).toHaveBeenCalledTimes(1);
    resetDbGrowthFenceCache();
  });

  it("never caches a refusal, so recovery is immediate", async () => {
    const query = installDb(sizes({ database_bytes: 500 * GiB }));
    const { assertSyncGrowthBoundary, resetDbGrowthFenceCache, DbGrowthFenceRefusal } =
      await import("@/lib/sync/db-growth-fence");
    resetDbGrowthFenceCache();
    await expect(assertSyncGrowthBoundary("unit", { env: {} })).rejects.toBeInstanceOf(
      DbGrowthFenceRefusal,
    );
    await expect(assertSyncGrowthBoundary("unit", { env: {} })).rejects.toBeInstanceOf(
      DbGrowthFenceRefusal,
    );
    // Both attempts measured; a cached refusal would have skipped the second.
    expect(query).toHaveBeenCalledTimes(2);
    resetDbGrowthFenceCache();
  });

  it("re-measures at a coarse boundary when fresh is requested", async () => {
    const query = installDb(sizes());
    const { assertSyncGrowthBoundary, resetDbGrowthFenceCache } = await import(
      "@/lib/sync/db-growth-fence"
    );
    resetDbGrowthFenceCache();
    await assertSyncGrowthBoundary("unit", { env: {} });
    await assertSyncGrowthBoundary("unit", { env: {}, fresh: true });
    expect(query).toHaveBeenCalledTimes(2);
    resetDbGrowthFenceCache();
  });

  it("observes a mid-run threshold crossing once the cache expires", async () => {
    let over = false;
    const query = vi.fn(async () =>
      over ? sizes({ database_bytes: 500 * GiB }) : sizes(),
    );
    vi.mocked(db.getDbWithTimeout).mockReturnValue({ query } as never);
    const { assertSyncGrowthBoundary, resetDbGrowthFenceCache, DbGrowthFenceRefusal } =
      await import("@/lib/sync/db-growth-fence");
    resetDbGrowthFenceCache();
    let clock = 0;
    const now = () => clock;
    await assertSyncGrowthBoundary("unit", { env: {}, now });
    over = true;
    clock += 60_000; // past the admitted TTL
    await expect(
      assertSyncGrowthBoundary("unit", { env: {}, now }),
    ).rejects.toBeInstanceOf(DbGrowthFenceRefusal);
    resetDbGrowthFenceCache();
  });
});

describe("admission cache keying", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each([
    ["the database changes", { DATABASE_URL: "postgres://other/db" }],
    [
      "the database budget changes",
      // Different from the default so the key changes, but still a budget the
      // measured disk could absorb — otherwise this would refuse on physical
      // capacity before the cache was ever consulted.
      { SYNC_GROWTH_FENCE_DATABASE_BYTES: String(170 * 1024 ** 3) },
    ],
    [
      "a table budget changes",
      {
        SYNC_GROWTH_FENCE_META_ENTITY_STATE_HISTORY_BYTES: String(800 * 1024 ** 3),
      },
    ],
    ["the override flag changes", { [OVERRIDE_ENV_FLAG]: OVERRIDE_ENV_VALUE }],
    [
      "the override expiry changes",
      { [OVERRIDE_EXPIRES_ENV]: new Date(Date.now() + 60_000).toISOString() },
    ],
  ])("re-measures when %s", async (_label, changed) => {
    const query = installDb(sizes());
    const { assertSyncGrowthBoundary, resetDbGrowthFenceCache } = await import(
      "@/lib/sync/db-growth-fence"
    );
    resetDbGrowthFenceCache();
    await assertSyncGrowthBoundary("unit", { env: { DATABASE_URL: "postgres://a/db" } });
    await assertSyncGrowthBoundary("unit", {
      env: { DATABASE_URL: "postgres://a/db", ...changed },
    });
    // A cache keyed only by time would have served the first decision here.
    expect(query).toHaveBeenCalledTimes(2);
    resetDbGrowthFenceCache();
  });

  it("reuses the cache only for an identical decision input", async () => {
    const query = installDb(sizes());
    const { assertSyncGrowthBoundary, resetDbGrowthFenceCache } = await import(
      "@/lib/sync/db-growth-fence"
    );
    resetDbGrowthFenceCache();
    const env = { DATABASE_URL: "postgres://a/db" };
    await assertSyncGrowthBoundary("unit", { env });
    await assertSyncGrowthBoundary("unit", { env });
    expect(query).toHaveBeenCalledTimes(1);
    resetDbGrowthFenceCache();
  });
});

describe("production volume calibration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  const GB = 1000 ** 3;

  // Every default must admit the live measurement. Two previous defaults were
  // below it — the 120 GiB database budget, and 8/4/4 GiB for a config trio
  // that is actually 21/20/20 GiB — either of which refuses every sync on a
  // deployment that is merely large, not broken.
  it("admits the live measurement on every default", async () => {
    installDb(
      sizes({
        database_bytes: LIVE_MEASUREMENT.databaseBytes,
        ...LIVE_MEASUREMENT.tableBytes,
      }),
    );
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("ready");
    expect(decision.offender).toBeNull();
  });

  it("admits the live database WITH a warning rather than quietly", () => {
    // The warning band is the only notice before refusal. A budget whose band
    // sits above the live size starts silent.
    expect(
      LIVE_MEASUREMENT.databaseBytes,
    ).toBeGreaterThanOrEqual(DEFAULT_DATABASE_BUDGET_BYTES * DEFAULT_WARNING_RATIO);
    expect(LIVE_MEASUREMENT.databaseBytes).toBeLessThan(DEFAULT_DATABASE_BUDGET_BYTES);
  });

  it("is the largest budget that still warns today", () => {
    // Why 160 and not 165+: the next steps up put the band above the live size
    // and the fence goes quiet. Why not 150: it warns, but leaves ~13.5 GiB of
    // headroom, and there is currently no way to reclaim space — the config
    // trio cannot be compacted and the cleanup planner ships no executor. A
    // tighter budget would be depending on work that does not exist.
    const bandAtNextStep = (DEFAULT_DATABASE_BUDGET_BYTES + 5 * GiB) * DEFAULT_WARNING_RATIO;
    expect(bandAtNextStep).toBeGreaterThan(LIVE_MEASUREMENT.databaseBytes);
    const headroom = DEFAULT_DATABASE_BUDGET_BYTES - LIVE_MEASUREMENT.databaseBytes;
    expect(headroom).toBeGreaterThan(20 * GiB);
  });

  it("cannot drive the volume below the host free-space floor", () => {
    // Conservative on purpose: one logical byte is assumed to cost one
    // filesystem byte. Measured filesystem usage is currently BELOW the logical
    // database size and the reason is not established, so the pessimistic
    // direction is the one to assume.
    const growthAllowed =
      DEFAULT_DATABASE_BUDGET_BYTES - LIVE_MEASUREMENT.databaseBytes;
    const freeAfter = LIVE_MEASUREMENT.volume.availableBytes - growthAllowed;
    expect(freeAfter).toBeGreaterThan(MINIMUM_VOLUME_FREE_BYTES);
  });

  it("keeps per-table ceilings above the aggregate so the aggregate binds first", () => {
    const perTableSum = FENCED_TABLES.reduce(
      (sum, table) => sum + DEFAULT_TABLE_BUDGET_BYTES[table],
      0,
    );
    // Deliberate: the aggregate catches total growth, the per-table ceilings
    // catch one relation running away inside it.
    expect(perTableSum).toBeGreaterThan(DEFAULT_DATABASE_BUDGET_BYTES);
  });

  it("emits the warning flag at the live size", async () => {
    installDb(
      sizes({
        database_bytes: LIVE_MEASUREMENT.databaseBytes,
        ...LIVE_MEASUREMENT.tableBytes,
      }),
    );
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(true);
    expect(decision.warning).toBe(true);
  });

  it("caps meta_entity_state_history so it cannot regrow to tens of GiB", () => {
    // The previous 90 GiB budget would have allowed the entire regrowth that
    // produced the incident without one refusal.
    expect(
      DEFAULT_TABLE_BUDGET_BYTES.meta_entity_state_history,
    ).toBeLessThanOrEqual(6 * GiB);
    expect(
      DEFAULT_TABLE_BUDGET_BYTES.meta_entity_state_history,
    ).toBeGreaterThan(LIVE_MEASUREMENT.tableBytes.meta_entity_state_history);
  });

  it("refuses once the database passes the budget", async () => {
    installDb(sizes({ database_bytes: 190 * GB }));
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("database_budget_exceeded");
  });

  it("keeps filesystem admission separate from the logical budget", () => {
    // The planning constant is arithmetic over a point-in-time observation.
    expect(PLANNED_VOLUME_HEADROOM_BYTES).toBe(
      LIVE_MEASUREMENT.volume.capacityBytes - DEFAULT_DATABASE_BUDGET_BYTES,
    );
    expect(MINIMUM_VOLUME_FREE_BYTES).toBe(40 * GiB);
  });

  it("fences every dominant append surface", () => {
    // The two largest tables in the incident were previously unmeasured.
    expect(FENCED_TABLES).toContain("meta_raw_snapshots");
    expect(FENCED_TABLES).toContain("shopify_raw_snapshots");
    expect(FENCED_TABLES).toContain("meta_config_snapshots");
    expect(FENCED_TABLES).toContain("meta_campaign_config_history");
    expect(FENCED_TABLES).toContain("meta_adset_config_history");
    // Google's surfaces were fenced only for product_daily, which left its raw
    // payload table and every lifecycle surface growing unmeasured.
    expect(FENCED_TABLES).toContain("google_ads_raw_snapshots");
    expect(FENCED_TABLES).toContain("google_ads_campaign_state_history");
    expect(FENCED_TABLES).toContain("google_ads_ad_group_state_history");
    expect(FENCED_TABLES).toContain("google_ads_sync_runs");
    expect(FENCED_TABLES).toContain("google_ads_sync_jobs");
    for (const table of FENCED_TABLES) {
      expect(DEFAULT_TABLE_BUDGET_BYTES[table]).toBeGreaterThan(0);
    }
  });

  it("recovers as soon as the database drops back under budget", async () => {
    installDb(sizes({ database_bytes: 190 * GB }));
    await expect(
      evaluateDbGrowthFence({ env: {} }),
    ).resolves.toMatchObject({ allowed: false });
    installDb(sizes({ database_bytes: 136 * GB }));
    await expect(
      evaluateDbGrowthFence({ env: {} }),
    ).resolves.toMatchObject({ allowed: true, reason: "ready" });
  });
});

describe("a single relation over budget refuses its own provider, not all of them", () => {
  // Measured 2026-08-08: meta_entity_state_history sat 208 KB (0.005%) over its
  // 4 GiB ceiling and Google Ads and Shopify sync were stopped alongside Meta
  // for 26 hours, though neither can write a byte of that table.
  it("maps fenced relations to the provider that writes them", () => {
    expect(fencedTableProviderFamily("meta_entity_state_history")).toBe("meta");
    expect(fencedTableProviderFamily("shopify_raw_snapshots")).toBe("shopify");
    expect(fencedTableProviderFamily("google_ads_product_daily")).toBe("google_ads");
  });

  it("maps boundary labels to their provider, including the older google_ prefix, GA4 and Search Console", () => {
    expect(operationProviderFamily("meta_business_cycle")).toBe("meta");
    expect(operationProviderFamily("shopify_business_cycle")).toBe("shopify");
    expect(operationProviderFamily("google_ads_business_cycle")).toBe("google_ads");
    expect(operationProviderFamily("google_sync_recent")).toBe("google_ads");
    expect(operationProviderFamily("google_lifecycle_partition")).toBe("google_ads");
    // Neither GA4 nor Search Console writes any FENCED table (no
    // `ga4_*`/`search_console_*` relation is measured — see
    // `fencedTableProviderFamily` below), but their OPERATION labels must
    // still be positively recognised: a Meta table over budget must not
    // refuse GA4/Search Console sync just because their family was null.
    expect(operationProviderFamily("ga4_reports_sync")).toBe("ga4");
    expect(operationProviderFamily("ga4_report_window")).toBe("ga4");
    expect(operationProviderFamily("ga4_user_facing_report_cache_warm")).toBe("ga4");
    expect(operationProviderFamily("search_console_reports_sync")).toBe("search_console");
    expect(operationProviderFamily("search_console_report_window")).toBe("search_console");
    expect(operationProviderFamily("shopify_user_facing_report_cache_warm")).toBe("shopify");
  });

  it("refuses an unrecognised label rather than guessing it is unrelated", () => {
    // Null is the fail-closed answer: a label added without thought must refuse.
    expect(operationProviderFamily("retention_compaction")).toBeNull();
    expect(operationProviderFamily("")).toBeNull();
    // The OLD ambiguous label every cache warmer used to share must stay
    // unrecognised too -- proving the fix was a rename, not a new alias.
    expect(operationProviderFamily("user_facing_report_cache_warm")).toBeNull();
  });

  it("fencedTableProviderFamily still returns null for GA4/Search Console -- no fenced table backs either", () => {
    // No `ga4_*`/`search_console_*` relation exists in FENCED_TABLES, so
    // neither can ever be an OFFENDER's family, only an OPERATION's.
    expect(fencedTableProviderFamily("sync_release_gates")).toBeNull();
  });
});

describe("collateral-only admission: GA4/Search Console/Shopify report-cache work when only Meta's table is over budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  /** meta_entity_state_history alone over budget -- the exact 2026-08-08/2026-09-03 shape. */
  function installMetaTableOverBudget() {
    return installDb(
      sizes({
        meta_entity_state_history:
          DEFAULT_TABLE_BUDGET_BYTES.meta_entity_state_history + 40_960,
      }),
    );
  }

  const COLLATERAL_OPERATIONS = [
    "ga4_reports_sync",
    "ga4_report_window",
    "search_console_reports_sync",
    "search_console_report_window",
    "ga4_user_facing_report_cache_warm",
    "shopify_user_facing_report_cache_warm",
  ] as const;

  it.each(COLLATERAL_OPERATIONS)(
    "admits %s (with a warning) when only meta_entity_state_history is over budget",
    async (operation) => {
      installMetaTableOverBudget();
      resetDbGrowthFenceCache();
      const decision = await assertSyncGrowthBoundary(operation, { env: {}, fresh: true });
      expect(decision.allowed).toBe(true);
      expect(decision.warning).toBe(true);
      resetDbGrowthFenceCache();
    },
  );

  it("still refuses a same-provider Meta operation when meta_entity_state_history alone is over budget", async () => {
    installMetaTableOverBudget();
    resetDbGrowthFenceCache();
    await expect(
      assertSyncGrowthBoundary("meta_sync_recent", { env: {}, fresh: true }),
    ).rejects.toBeInstanceOf(DbGrowthFenceRefusal);
    resetDbGrowthFenceCache();
  });

  it("a database-wide breach still refuses every one of these operations, GA4/Search Console/Shopify included", async () => {
    installDb(sizes({ database_bytes: 500 * GiB }));
    resetDbGrowthFenceCache();
    for (const operation of COLLATERAL_OPERATIONS) {
      await expect(
        assertSyncGrowthBoundary(operation, { env: {}, fresh: true }),
      ).rejects.toBeInstanceOf(DbGrowthFenceRefusal);
    }
    resetDbGrowthFenceCache();
  });

  it("an unknown operation label still refuses even when only meta_entity_state_history is over budget", async () => {
    installMetaTableOverBudget();
    resetDbGrowthFenceCache();
    await expect(
      assertSyncGrowthBoundary("some_new_operation_nobody_labeled_yet", {
        env: {},
        fresh: true,
      }),
    ).rejects.toBeInstanceOf(DbGrowthFenceRefusal);
    resetDbGrowthFenceCache();
  });

  it("the OLD ambiguous label is STILL refused when only meta_entity_state_history is over budget -- proving the rename, not a broadened heuristic, is what fixed this", async () => {
    installMetaTableOverBudget();
    resetDbGrowthFenceCache();
    await expect(
      assertSyncGrowthBoundary("user_facing_report_cache_warm", { env: {}, fresh: true }),
    ).rejects.toBeInstanceOf(DbGrowthFenceRefusal);
    resetDbGrowthFenceCache();
  });
});

describe("raw table map accounting",()=>{
  const env={SYNC_GROWTH_FENCE_DATABASE_BYTES:String(163*GiB),SYNC_GROWTH_FENCE_REUSABLE_NATIVE_HEAP_ENABLED:"true",SYNC_GROWTH_FENCE_RAW_REUSE_ENABLED:"true"};
  function setup(refuseShop=false,available=210*GiB){
    const raw=164*GiB,meta=22*GiB+100*1024**2,shop=16*GiB+100*1024**2;
    const query=vi.fn(async(text:string,args?:unknown[])=>{
      if(text.includes("public.pg_freespace")){
        if(args?.[0]==="public.shopify_raw_snapshots"&&refuseShop)throw Error("bounded map timeout");
        const isMeta=args?.[0]==="public.meta_raw_snapshots";
        return [{raw_bytes:isMeta?meta:shop,database_bytes:raw,heaps:[
          {kind:"main",oid:isMeta?100:200,heap_bytes:GiB,visible_free_bytes:0},
          {kind:"toast",oid:isMeta?101:201,heap_bytes:isMeta?20*GiB:14*GiB,visible_free_bytes:isMeta?2*GiB:GiB},
        ]}];
      }
      if(text.includes("approx_free_space")&&text.includes("engine_v3_ad_decision_evaluations"))return [{database_bytes:raw,total_bytes:70*GiB,heap_bytes:20*GiB,table_len:20*GiB,approx_free_space:4*GiB}];
      return sizes({database_bytes:raw,meta_raw_snapshots:meta,shopify_raw_snapshots:shop},{capacity_payload:capacityPayload({disks:[{path:PHYSICAL_DATA_PATH,totalBytes:400*GiB,usedBytes:400*GiB-available,availableBytes:available}]})});
    });
    vi.mocked(db.getDbWithTimeout).mockReturnValue({query} as never);return {raw,meta,shop};
  }
  it("keeps163GiB/22GiB/16GiB budgets and admits actual reusable space without an override",async()=>{
    const {raw,meta,shop}=setup();const d=await evaluateDbGrowthFence({env});
    expect(d).toMatchObject({allowed:true,reason:"ready",overridden:false,databaseBytes:raw,
      databaseBudgetBytes:163*GiB,databaseAccounting:{metric:"raw_minus_proven_disjoint_heap_free",accountedDatabaseBytes:157*GiB+2*1024**2},
      rawPayloadReuse:{meta_raw_snapshots:{rawBytes:meta,metric:"visible_map_free"},shopify_raw_snapshots:{rawBytes:shop,metric:"visible_map_free"}}});
    expect(d.tableBudgetBytes).toMatchObject({meta_raw_snapshots:22*GiB,shopify_raw_snapshots:16*GiB});
    expect(d.tableBytes.meta_raw_snapshots).toBe(meta-2*GiB+1024**2);
    expect(d.tableBytes.shopify_raw_snapshots).toBe(shop-GiB+1024**2);
  });
  it("refuses the independent table when its reusable proof is unavailable",async()=>{
    const {shop}=setup(true);const d=await evaluateDbGrowthFence({env});
    expect(d).toMatchObject({allowed:false,reason:"table_budget_exceeded",overridden:false,
      offender:{table:"shopify_raw_snapshots",bytes:shop,budget:16*GiB},
      rawPayloadReuse:{shopify_raw_snapshots:{metric:"raw_fallback",reusableBytes:0}}});
  });
  it("cannot lend proven raw/native headroom beyond actual physical spare",async()=>{
    setup(false,42*GiB);const d=await evaluateDbGrowthFence({env});
    expect(d.allowed).toBe(true);expect(d.databaseAccounting?.reusableHeapBytes).toBe(2.5*GiB);
    expect(d.physical?.projectedFreeBytes).toBe(40.5*GiB);
  });
});

describe("status-only proof overlap", () => {
  const env = {
    SYNC_GROWTH_FENCE_DATABASE_BYTES: String(163 * GiB),
    SYNC_GROWTH_FENCE_REUSABLE_NATIVE_HEAP_ENABLED: "true",
    SYNC_GROWTH_FENCE_RAW_REUSE_ENABLED: "true",
  };
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbGrowthFenceReadObservationCache();
    resetDbGrowthFenceCache();
  });

  function controlledProofs(failShopify = false, blockRaw = false) {
    let releaseNative!: () => void;
    let signalNative!: () => void;
    const blocked = new Promise<void>(resolve => { releaseNative = resolve; });
    const nativeStarted = new Promise<void>(resolve => { signalNative = resolve; });
    let releaseRaw!: () => void;
    const rawBlocked = blockRaw ? new Promise<void>(resolve => { releaseRaw = resolve; }) : Promise.resolve();
    const raw = 164 * GiB;
    const meta = 22 * GiB + 100 * 1024 ** 2;
    const shop = 16 * GiB + 100 * 1024 ** 2;
    const query = vi.fn(async (text: string, args?: unknown[]) => {
      if (text.includes("public.pg_freespace")) {
        await rawBlocked;
        if (args?.[0] === "public.shopify_raw_snapshots" && failShopify) throw Error("owned proof failure");
        const isMeta = args?.[0] === "public.meta_raw_snapshots";
        return [{ raw_bytes: isMeta ? meta : shop, database_bytes: raw, heaps: [
          { kind: "main", oid: isMeta ? 100 : 200, heap_bytes: GiB, visible_free_bytes: 0 },
          { kind: "toast", oid: isMeta ? 101 : 201, heap_bytes: isMeta ? 20 * GiB : 14 * GiB,
            visible_free_bytes: isMeta ? 2 * GiB : GiB },
        ] }];
      }
      if (text.includes("approx_free_space") && text.includes("engine_v3_ad_decision_evaluations")) {
        signalNative();
        await blocked;
        return [{ database_bytes: raw, total_bytes: 70 * GiB, heap_bytes: 20 * GiB,
          table_len: 20 * GiB, approx_free_space: 4 * GiB }];
      }
      return sizes({ database_bytes: raw, meta_raw_snapshots: meta, shopify_raw_snapshots: shop });
    });
    vi.mocked(db.getDbWithTimeout).mockReturnValue({ query } as never);
    return { query, nativeStarted, releaseNative, releaseRaw,
      rawCalls: () => query.mock.calls.filter(([text]) => text.includes("public.pg_freespace")).length };
  }

  it.each(["admission", "observation"] as const)("%s keeps its required proof order and awaits the complete decision", async (mode) => {
    const proof = controlledProofs();
    let settled = false;
    const pending = (mode === "admission" ? evaluateDbGrowthFence({ env }) : readDbGrowthFenceObservation({ env }))
      .then(value => { settled = true; return value; });
    await proof.nativeStarted;
    // Flush promise continuations without releasing the blocked native proof.
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      expect(proof.rawCalls()).toBe(mode === "observation" ? 2 : 0);
      expect(settled).toBe(false);
    } finally {
      proof.releaseNative();
    }
    const decision = await pending;
    expect(decision).toMatchObject({ allowed: true, reason: "ready", overridden: false,
      databaseBudgetBytes: 163 * GiB,
      databaseAccounting: { accountedDatabaseBytes: 157 * GiB + 2 * 1024 ** 2 },
      tableBudgetBytes: { meta_raw_snapshots: 22 * GiB, shopify_raw_snapshots: 16 * GiB } });
    expect(proof.rawCalls()).toBe(2);
  });

  it("keeps a failed raw proof fail-closed and re-measures instead of caching it", async () => {
    const first = controlledProofs(true);
    const pending = readDbGrowthFenceObservation({ env });
    await first.nativeStarted;
    first.releaseNative();
    expect(await pending).toMatchObject({ allowed: false, reason: "table_budget_exceeded",
      offender: { table: "shopify_raw_snapshots" },
      rawPayloadReuse: { shopify_raw_snapshots: { metric: "raw_fallback", reusableBytes: 0 } } });
    const recovered = controlledProofs();
    const retry = readDbGrowthFenceObservation({ env });
    await recovered.nativeStarted;
    recovered.releaseNative();
    expect((await retry).allowed).toBe(true);
    expect(recovered.rawCalls()).toBe(2);
  });

  it("drains a started raw observation before returning a later physical refusal", async () => {
    const proof = controlledProofs(false, true);
    let settled = false;
    const pending = readDbGrowthFenceObservation({ env }).then(value => { settled = true; return value; });
    await proof.nativeStarted;
    const current = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(current + PHYSICAL_SNAPSHOT_MAX_AGE_MS + 1000);
    try {
      proof.releaseNative();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(proof.rawCalls()).toBe(1);
      expect(settled).toBe(false);
    } finally {
      clock.mockRestore();
      proof.releaseRaw();
    }
    expect(await pending).toMatchObject({ allowed: false, reason: "physical_snapshot_stale" });
    expect(proof.rawCalls()).toBe(2);
  });

  it("starts no heap proof when the initial physical admission refuses", async () => {
    const query = installDb(sizes({}, { capacity_payload: capacityPayload({ disks: [
      { path: PHYSICAL_DATA_PATH, totalBytes: 400 * GiB, usedBytes: 370 * GiB, availableBytes: 30 * GiB },
    ] }) }));
    expect((await readDbGrowthFenceObservation({ env })).allowed).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("read-only capacity observation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbGrowthFenceReadObservationCache();
    resetDbGrowthFenceCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("coalesces concurrent readers and preserves the real measurement clock", async () => {
    const query = installDb(sizes());
    const nowMs = Date.now();
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      readDbGrowthFenceObservation({ env: {}, nowMs })));
    expect(query).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result === results[0])).toBe(true);
    const later = await readDbGrowthFenceObservation({ env: {}, nowMs: nowMs + 1000 });
    expect(later.allowed).toBe(true);
    expect(later.evaluatedAt).toBe(new Date(nowMs).toISOString());
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("re-measures after 15 seconds instead of refreshing a cached timestamp", async () => {
    const query = installDb(sizes());
    const nowMs = Date.now();
    await readDbGrowthFenceObservation({ env: {}, nowMs });
    const later = await readDbGrowthFenceObservation({ env: {}, nowMs: nowMs + 15001 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(later.evaluatedAt).toBe(new Date(nowMs + 15001).toISOString());
  });

  it.each(["refused", "failed proof"])("does not retain a %s observation", async (kind) => {
    const query = installDb(kind === "refused" ? sizes({ database_bytes: 500 * GiB }) : () => { throw Error("read failed"); });
    expect((await readDbGrowthFenceObservation({ env: {} })).allowed).toBe(false);
    const recovered = installDb(sizes());
    expect((await readDbGrowthFenceObservation({ env: {} })).allowed).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it.each([
    { DATABASE_URL: "postgres://other/db" },
    { SYNC_GROWTH_FENCE_DATABASE_BYTES: String(170 * GiB) },
    { SYNC_GROWTH_FENCE_META_RAW_SNAPSHOTS_BYTES: String(3 * GiB) },
  ])("isolates different database or budget inputs: %j", async (changed) => {
    const query = installDb(sizes());
    const nowMs = Date.now();
    await readDbGrowthFenceObservation({ env: {}, nowMs });
    await readDbGrowthFenceObservation({ env: changed, nowMs });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("isolates a different statement deadline", async () => {
    const query = installDb(sizes());
    await readDbGrowthFenceObservation({ env: {}, queryTimeoutMs: 5000 });
    await readDbGrowthFenceObservation({ env: {}, queryTimeoutMs: 3000 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("cannot seed the independent write admission cache", async () => {
    const read = installDb(sizes());
    await readDbGrowthFenceObservation({ env: {} });
    const write = installDb(sizes({ database_bytes: 500 * GiB }));
    await expect(assertSyncGrowthBoundary("meta_sync_recent", { env: {} }))
      .rejects.toBeInstanceOf(DbGrowthFenceRefusal);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a future observation after the clock moves backwards", async () => {
    const query = installDb(sizes());
    const nowMs = Date.now();
    await readDbGrowthFenceObservation({ env: {}, nowMs });
    const earlier = await readDbGrowthFenceObservation({ env: {}, nowMs: nowMs - 1 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(earlier.evaluatedAt).toBe(new Date(nowMs - 1).toISOString());
  });

  it("expires before the underlying physical receipt becomes stale", async () => {
    const nowMs = Date.now();
    const sampledAt = new Date(nowMs - (PHYSICAL_SNAPSHOT_MAX_AGE_MS - 1000)).toISOString();
    const query = installDb(sizes({}, {
      capacity_sampled_at: sampledAt,
      capacity_age_seconds: (PHYSICAL_SNAPSHOT_MAX_AGE_MS - 1000) / 1000,
      capacity_payload: capacityPayload({ sampledAt }),
    }));
    expect((await readDbGrowthFenceObservation({ env: {}, nowMs })).allowed).toBe(true);
    await readDbGrowthFenceObservation({ env: {}, nowMs: nowMs + 1001 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not retain an emergency override as a normal admitted observation", async () => {
    const query = installDb(sizes({ database_bytes: 500 * GiB }));
    const env = {
      [OVERRIDE_ENV_FLAG]: OVERRIDE_ENV_VALUE,
      [OVERRIDE_REASON_ENV]: "owned unit test only",
      [OVERRIDE_EXPIRES_ENV]: new Date(Date.now() + 60000).toISOString(),
    };
    const first = await readDbGrowthFenceObservation({ env });
    expect(first.overridden).toBe(true);
    await readDbGrowthFenceObservation({ env });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("reuses a normal completed full proof for reads without refreshing its clock",async()=>{
    const query=installDb(sizes()),full=await evaluateDbGrowthFence({env:{}});
    const nowMs=Date.parse(full.evaluatedAt)+1000;
    expect(await readDbGrowthFenceObservation({env:{},nowMs})).toBe(full);
    expect(query).toHaveBeenCalledTimes(1);
    await readDbGrowthFenceObservation({env:{},nowMs:nowMs+15001});
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("joins a pending full proof while each concurrent full evaluation still measures independently",async()=>{
    const rows=sizes();let release!:()=>void;
    const gate=new Promise<void>(done=>{release=done;});
    const query=installDb(rows);query.mockImplementation(async()=>{await gate;return rows;});
    const full1=evaluateDbGrowthFence({env:{}});
    const full2=evaluateDbGrowthFence({env:{}});
    const read=readDbGrowthFenceObservation({env:{},nowMs:Date.now()+1000});
    try{expect(query).toHaveBeenCalledTimes(2);}finally{release();}
    const [one,two,observed]=await Promise.all([full1,full2,read]);
    expect(one.allowed&&two.allowed).toBe(true);expect(observed).toBe(two);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not join an in-flight full proof with different settings or deadline",async()=>{
    const rows=sizes();let release!:()=>void;
    const gate=new Promise<void>(done=>{release=done;});
    const query=installDb(rows);query.mockImplementationOnce(async()=>{await gate;return rows;});
    const full=evaluateDbGrowthFence({env:{}});
    const read=readDbGrowthFenceObservation({env:{SYNC_GROWTH_FENCE_DATABASE_BYTES:String(170*GiB)},nowMs:Date.now()+1000});
    try{expect(query).toHaveBeenCalledTimes(2);}finally{release();}
    await Promise.all([full,read]);
    resetDbGrowthFenceReadObservationCache();
    await evaluateDbGrowthFence({env:{},queryTimeoutMs:5000});
    await readDbGrowthFenceObservation({env:{},queryTimeoutMs:3000});
    expect(query).toHaveBeenCalledTimes(4);
  });

  it.each(["future","physical expiry","override","refusal"])("does not retain an unsafe full proof: %s",async kind=>{
    const now=Date.now();
    const env=kind==="override"?{[OVERRIDE_ENV_FLAG]:OVERRIDE_ENV_VALUE,[OVERRIDE_REASON_ENV]:"owned only",[OVERRIDE_EXPIRES_ENV]:new Date(now+60000).toISOString()}:{};
    const sampledAt=new Date(now-(PHYSICAL_SNAPSHOT_MAX_AGE_MS-1000)).toISOString();
    const query=installDb(kind==="physical expiry"?sizes({}, {capacity_sampled_at:sampledAt,capacity_age_seconds:(PHYSICAL_SNAPSHOT_MAX_AGE_MS-1000)/1000,capacity_payload:capacityPayload({sampledAt})}):sizes(kind==="override"||kind==="refusal"?{database_bytes:500*GiB}:{}));
    const full=await evaluateDbGrowthFence({env});
    await readDbGrowthFenceObservation({env,nowMs:kind==="future"?Date.parse(full.evaluatedAt)-1:kind==="physical expiry"?now+1001:Date.now()+1});
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not revive an older successful proof after a newer full refusal",async()=>{
    const before=Date.now();let release!:()=>void;
    const gate=new Promise<void>(done=>{release=done;});
    const rows=sizes(),q=installDb(rows);
    q.mockImplementationOnce(async()=>{await gate;return rows;}).mockResolvedValue(sizes({database_bytes:500*GiB}));
    const old=evaluateDbGrowthFence({env:{},nowMs:before-1000});
    expect((await evaluateDbGrowthFence({env:{},nowMs:before})).allowed).toBe(false);
    release();expect((await old).allowed).toBe(true);
    const fresh=installDb(sizes({database_bytes:500*GiB}));
    expect((await readDbGrowthFenceObservation({env:{},nowMs:before+1000})).allowed).toBe(false);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("does not borrow a full proof whose input key changed while measuring",async()=>{
    const env:Record<string,string>={};let release!:()=>void;
    const gate=new Promise<void>(done=>{release=done;});
    const rows=sizes(),q=installDb(rows);q.mockImplementationOnce(async()=>{await gate;return rows;});
    const full=evaluateDbGrowthFence({env}),read=readDbGrowthFenceObservation({env,nowMs:Date.now()+1000});
    env.SYNC_GROWTH_FENCE_DATABASE_BYTES=String(170*GiB);release();
    const [written,observed]=await Promise.all([full,read]);
    expect(observed).not.toBe(written);expect(q).toHaveBeenCalledTimes(2);
  });

  it("bounds waiting by the original proof age without cancelling the full evaluation",async()=>{
    vi.useFakeTimers();
    let release!:()=>void;
    const gate=new Promise<void>(done=>{release=done;});
    const rows=sizes(),q=installDb(rows);q.mockImplementation(async()=>{await gate;return rows;});
    const full=evaluateDbGrowthFence({env:{}}),read=readDbGrowthFenceObservation({env:{}});
    const outcome=read.then(()=>null,error=>String(error.message));
    try{
      await vi.advanceTimersByTimeAsync(15000);
      expect(await outcome).toBe("capacity_observation_full_proof_wait_expired");
      expect(q).toHaveBeenCalledTimes(1);
    }finally{release();await full;vi.useRealTimers();}
  });

  it("does not let an older pending reader refill the cache after a newer full refusal",async()=>{
    vi.useFakeTimers();const start=Date.now();let release!:()=>void;
    const gate=new Promise<void>(done=>{release=done;});
    const rows=sizes(),q=installDb(rows);q.mockImplementationOnce(async()=>{await gate;return rows;}).mockResolvedValue(sizes({database_bytes:500*GiB}));
    const old=evaluateDbGrowthFence({env:{}}),read=readDbGrowthFenceObservation({env:{},nowMs:start});
    try{
      await vi.advanceTimersByTimeAsync(1);
      expect((await evaluateDbGrowthFence({env:{}})).allowed).toBe(false);
      release();await Promise.all([old,read]);
      const fresh=installDb(sizes({database_bytes:500*GiB}));
      expect((await readDbGrowthFenceObservation({env:{},nowMs:start+1000})).allowed).toBe(false);
      expect(fresh).toHaveBeenCalledTimes(1);
    }finally{release();await Promise.allSettled([old,read]);vi.useRealTimers();}
  });

  it.runIf(process.env.ADSECUTE_CAPACITY_REUSE_OWNED_PG==="1")("shares the actual complete native/raw proof with a reader on owned PostgreSQL",async()=>{
    const url=new URL(process.env.DATABASE_URL!);
    expect(url.hostname).toBe("127.0.0.1");expect(url.pathname).toBe("/adsecute_capacity_reuse");expect([5432,15432]).not.toContain(Number(url.port));
    const {Client}=await import("pg"),client=new Client({connectionString:url.href,ssl:false});await client.connect();
    try{
      await client.query("CREATE EXTENSION pgstattuple; CREATE EXTENSION pg_freespacemap; CREATE EXTENSION pg_visibility");
      for(const table of new Set<string>([...FENCED_TABLES,"engine_v3_ad_decision_evaluations"])){
        expect(table).toMatch(/^[a-z][a-z0-9_]+$/);await client.query('CREATE TABLE public."'+table+'"(id int)');
      }
      await client.query("CREATE TABLE system_capacity_snapshots(id bigint,source text,sampled_at timestamptz,payload jsonb)");
      await client.query("INSERT INTO system_capacity_snapshots VALUES (1,$1,now(),$2::jsonb)",[PHYSICAL_TELEMETRY_SOURCE,JSON.stringify(capacityPayload({database:{name:"adsecute_capacity_reuse",sizeBytes:1,sizePretty:"1 byte"}}))]);
      let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});let first=true;
      const query=vi.fn(async(text:string,params?:unknown[])=>{if(first){first=false;await gate;}return(await client.query(text,params)).rows;});
      vi.mocked(db.getDbWithTimeout).mockReturnValue({query} as never);
      const env={SYNC_GROWTH_FENCE_REUSABLE_NATIVE_HEAP_ENABLED:"true",SYNC_GROWTH_FENCE_RAW_REUSE_ENABLED:"true"};
      const full=evaluateDbGrowthFence({env}),read=readDbGrowthFenceObservation({env,nowMs:Date.now()+1000});
      try{expect(query).toHaveBeenCalledTimes(1);}finally{release();}
      const [written,observed]=await Promise.all([full,read]);
      expect(written.allowed).toBe(true);expect(observed).toBe(written);
      const metadata=query.mock.calls.filter(([text])=>text.includes("latest_capacity AS")).length;
      const native=query.mock.calls.filter(([text])=>text.includes("pgstattuple_approx")&&text.includes("engine_v3_ad_decision_evaluations")).length;
      const stateHistory=query.mock.calls.filter(([text])=>text.includes("pgstattuple_approx")&&text.includes("meta_entity_state_history")).length;
      const raw=query.mock.calls.filter(([text])=>text.includes("pg_visibility_map")).length;
      expect({metadata,stateHistory,native,raw}).toEqual({metadata:1,stateHistory:1,native:1,raw:2});expect(query).toHaveBeenCalledTimes(5);
      console.log("owned-capacity-proof-reuse",JSON.stringify({metadata,stateHistory,native,raw,total:query.mock.calls.length,originalClockPreserved:observed.evaluatedAt===written.evaluatedAt,actualSql:true,productionAccess:false}));
    }finally{await client.end();}
  });

  it("shares the full proof across independent module instances without a second DB read",async()=>{
    const rows=sizes();let release!:()=>void;
    const gate=new Promise<void>(done=>{release=done;});
    const first=installDb(rows);first.mockImplementation(async()=>{await gate;return rows;});
    const full=evaluateDbGrowthFence({env:{}});
    vi.resetModules();
    const secondDb=await import("@/lib/db"),second=vi.fn(async()=>rows);
    vi.mocked(secondDb.getDbWithTimeout).mockReturnValue({query:second} as never);
    const other=await import("@/lib/sync/db-growth-fence");
    const read=other.readDbGrowthFenceObservation({env:{},nowMs:Date.now()+1000});
    release();
    const [written,observed]=await Promise.all([full,read]);
    expect(observed).toBe(written);expect(first).toHaveBeenCalledTimes(1);expect(second).not.toHaveBeenCalled();
  });

});
