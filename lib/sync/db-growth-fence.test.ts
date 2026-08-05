import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDbWithTimeout: vi.fn() }));

const db = await import("@/lib/db");
const {
  evaluateDbGrowthFence,
  assertDbGrowthFenceAdmits,
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

/**
 * THE INCIDENT THIS ENCODES (found 2026-08-05; frozen since at least 08-04)
 *
 * Google Ads sync was refused on every single cycle with
 *   physical_projected_free_space_low — "Consuming the remaining 87,841,162,217
 *   bytes of logical budget would leave -10,100,773,865 bytes free, below the
 *   42,949,672,960 byte floor."
 *
 * The arithmetic was right and the fence was doing its job. What was wrong is
 * that the budget it defended is a STATIC 160 GiB while the volume is 221 GB
 * with a 40 GiB floor — admission needs `budget <= databaseBytes + available -
 * floor`, about 118 GB here. No amount of live data could satisfy 160 GiB, so
 * the refusal was permanent and nothing could ever clear it.
 *
 * Downstream: the worker recorded `capacity_refused` in a heartbeat, reported
 * itself idle, never took a runner lease, and so never claimed a partition.
 * 6,453 partitions sat queued, 6,376 never attempted once, oldest created three
 * and a half months earlier.
 */
describe("db growth fence — budget is bounded by what the volume can hold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // The exact production shape, in bytes, from the worker's own safetyRefusal.
  const PROD_TOTAL = 221_348_159_488;
  const PROD_USED = 142_495_780_864;
  const PROD_AVAILABLE = 77_740_388_352;
  const PROD_DB_BYTES = 83_957_529_623;

  function productionShapedRows() {
    return FENCED_TABLES.map((table) => ({
      database_bytes: PROD_DB_BYTES,
      database_name: DB_NAME,
      table_name: table,
      table_bytes: 1 * GiB,
      capacity_id: "6320",
      capacity_sampled_at: new Date().toISOString(),
      capacity_age_seconds: 120,
      capacity_payload: capacityPayload({
        database: { name: DB_NAME, sizeBytes: PROD_DB_BYTES, sizePretty: "78 GB" },
        disks: [
          {
            path: PHYSICAL_DATA_PATH,
            totalBytes: PROD_TOTAL,
            usedBytes: PROD_USED,
            availableBytes: PROD_AVAILABLE,
          },
        ],
      }),
    }));
  }

  it("admits the exact production shape that was permanently refused", async () => {
    // Proof the old behaviour was unsatisfiable: with the CONFIGURED budget the
    // physical evaluator still refuses this very telemetry.
    expect(
      evaluatePhysicalCapacity({
        telemetryAvailable: true,
        snapshot: {
          id: "6320",
          sampledAt: new Date().toISOString(),
          ageSeconds: 120,
          payload: productionShapedRows()[0].capacity_payload,
        },
        databaseName: DB_NAME,
        databaseBytes: PROD_DB_BYTES,
        databaseBudgetBytes: DEFAULT_DATABASE_BUDGET_BYTES,
      }).admitted,
    ).toBe(false);

    installDb(productionShapedRows());
    const decision = await evaluateDbGrowthFence({ env: {} });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("ready");
    // Lowered to what the disk can honour, never above the configured value.
    expect(decision.databaseBudgetBytes).toBeLessThan(DEFAULT_DATABASE_BUDGET_BYTES);
    expect(decision.databaseBudgetBytes).toBe(
      PROD_DB_BYTES + PROD_AVAILABLE - MINIMUM_VOLUME_FREE_BYTES,
    );
  });

  it("never raises the budget above the configured value", async () => {
    // Huge free space: the honourable ceiling would exceed the configured budget,
    // so the configured budget must remain the hard cap.
    installDb(sizes());
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.databaseBudgetBytes).toBe(DEFAULT_DATABASE_BUDGET_BYTES);
  });

  it("is not an override: a volume already under the floor still refuses", async () => {
    installDb(
      FENCED_TABLES.map((table) => ({
        database_bytes: PROD_DB_BYTES,
        database_name: DB_NAME,
        table_name: table,
        table_bytes: 1 * GiB,
        capacity_id: "1",
        capacity_sampled_at: new Date().toISOString(),
        capacity_age_seconds: 120,
        capacity_payload: capacityPayload({
          disks: [
            {
              path: PHYSICAL_DATA_PATH,
              totalBytes: PROD_TOTAL,
              usedBytes: PROD_TOTAL - 1 * GiB,
              availableBytes: 1 * GiB, // far below the 40 GiB floor
            },
          ],
        }),
      })),
    );
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("physical_free_space_low");
  });

  it("grants only the sliver the volume can actually spare, and warns", async () => {
    // 41 GiB free against a 40 GiB floor is exactly 1 GiB of legitimate
    // headroom. The fence must admit that sliver and no more — and because the
    // live database then sits at ~98.7% of the effective budget, it must WARN
    // rather than admit silently. (A volume BELOW the floor never reaches this
    // path at all: `free_space_low` denies first, which the test above pins.)
    const tightAvailable = 41 * GiB; // barely above the 40 GiB floor
    installDb(
      FENCED_TABLES.map((table) => ({
        database_bytes: PROD_DB_BYTES,
        database_name: DB_NAME,
        table_name: table,
        table_bytes: 1 * GiB,
        capacity_id: "1",
        capacity_sampled_at: new Date().toISOString(),
        capacity_age_seconds: 120,
        capacity_payload: capacityPayload({
          disks: [
            {
              path: PHYSICAL_DATA_PATH,
              totalBytes: PROD_TOTAL,
              usedBytes: PROD_TOTAL - tightAvailable,
              availableBytes: tightAvailable,
            },
          ],
        }),
      })),
    );
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(true);
    // Exactly the spare capacity, not a byte more.
    expect(decision.databaseBudgetBytes).toBe(
      PROD_DB_BYTES + tightAvailable - MINIMUM_VOLUME_FREE_BYTES,
    );
    expect(decision.databaseBudgetBytes - PROD_DB_BYTES).toBe(1 * GiB);
    // Nearly full against that ceiling, so this must not pass silently.
    expect(decision.warning).toBe(true);
  });

  it("re-admits by itself once the volume grows, with no config change", async () => {
    // The self-healing property: same static constant, more disk, admitted.
    const grownAvailable = 160 * GiB;
    installDb(
      FENCED_TABLES.map((table) => ({
        database_bytes: PROD_DB_BYTES,
        database_name: DB_NAME,
        table_name: table,
        table_bytes: 1 * GiB,
        capacity_id: "1",
        capacity_sampled_at: new Date().toISOString(),
        capacity_age_seconds: 120,
        capacity_payload: capacityPayload({
          disks: [
            {
              path: PHYSICAL_DATA_PATH,
              totalBytes: PROD_TOTAL + grownAvailable,
              usedBytes: PROD_USED,
              availableBytes: grownAvailable,
            },
          ],
        }),
      })),
    );
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(true);
    expect(decision.databaseBudgetBytes).toBe(DEFAULT_DATABASE_BUDGET_BYTES);
  });
});
