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
  PRODUCTION_VOLUME_BYTES,
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

  // The defect this guards against: the previous 120 GiB default was BELOW the
  // live 136 GB database, so shipping it would have refused every sync on a
  // perfectly healthy deployment.
  it("admits the current healthy 136 GB database", async () => {
    installDb(sizes({ database_bytes: 136 * GB }));
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("ready");
  });

  it("keeps the budget under the 207 GB volume with restore headroom", () => {
    expect(DEFAULT_DATABASE_BUDGET_BYTES).toBeLessThan(PRODUCTION_VOLUME_BYTES);
    // At least 30 GB of volume left for WAL, temp files and index builds.
    expect(PRODUCTION_VOLUME_BYTES - DEFAULT_DATABASE_BUDGET_BYTES).toBeGreaterThan(
      30 * GB,
    );
  });

  it("warns before it refuses, and the warning band is above today's size", async () => {
    const warnAt = DEFAULT_DATABASE_BUDGET_BYTES * 0.9;
    expect(warnAt).toBeGreaterThan(136 * GB);
    installDb(sizes({ database_bytes: warnAt }));
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(true);
    expect(decision.warning).toBe(true);
  });

  it("refuses before the volume becomes unsafe", async () => {
    installDb(sizes({ database_bytes: 190 * GB }));
    const decision = await evaluateDbGrowthFence({ env: {} });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("database_budget_exceeded");
  });

  it("fences every dominant append surface", () => {
    // The two largest tables in the incident were previously unmeasured.
    expect(FENCED_TABLES).toContain("meta_raw_snapshots");
    expect(FENCED_TABLES).toContain("shopify_raw_snapshots");
    expect(FENCED_TABLES).toContain("meta_config_snapshots");
    expect(FENCED_TABLES).toContain("meta_campaign_config_history");
    expect(FENCED_TABLES).toContain("meta_adset_config_history");
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
