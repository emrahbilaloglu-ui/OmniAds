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
  evaluateVolumeHeadroom,
  VOLUME_AVAILABLE_ENV,
  VOLUME_CAPACITY_ENV,
} = await import("@/lib/sync/db-growth-fence");

const GiB = 1024 ** 3;

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

function sizes(overrides: Partial<Record<string, number | null>> = {}) {
  return FENCED_TABLES.map((table) => ({
    database_bytes: overrides.database_bytes ?? 10 * GiB,
    table_name: table,
    table_bytes:
      table in overrides ? overrides[table] : 1 * GiB,
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
      { SYNC_GROWTH_FENCE_DATABASE_BYTES: String(900 * 1024 ** 3) },
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
    // With no measurement, headroom is unknown — never "ok". Reporting an
    // absence of evidence as health is how a logical budget gets mistaken for
    // disk telemetry.
    expect(evaluateVolumeHeadroom({ env: {} }).status).toBe("unknown");
    expect(evaluateVolumeHeadroom({ env: {} }).availableBytes).toBeNull();
    expect(
      evaluateVolumeHeadroom({
        env: {
          [VOLUME_AVAILABLE_ENV]: String(LIVE_MEASUREMENT.volume.availableBytes),
          [VOLUME_CAPACITY_ENV]: String(LIVE_MEASUREMENT.volume.capacityBytes),
        },
      }).status,
    ).toBe("ok");
    expect(
      evaluateVolumeHeadroom({
        env: { [VOLUME_AVAILABLE_ENV]: String(MINIMUM_VOLUME_FREE_BYTES - 1) },
      }).status,
    ).toBe("low");
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
