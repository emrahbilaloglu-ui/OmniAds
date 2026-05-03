import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/build-runtime", () => ({
  getCurrentRuntimeBuildId: vi.fn(() => "build-1"),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn(async () => null),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const db = await import("@/lib/db");
const controlPlanePersistence = await import("@/lib/sync/control-plane-persistence");

describe("sync control-plane persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("passes when exact build and environment rows exist", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      (async (strings: TemplateStringsArray) => {
        const query = strings.join(" ");
        if (query.includes("FROM sync_release_gates") && query.includes("AND environment =")) {
          return [
            {
              id: "dg-1",
              build_id: "build-1",
              environment: "production",
              gate_kind: "deploy_gate",
              verdict: "pass",
              emitted_at: "2026-04-15T12:00:00.000Z",
            },
            {
              id: "rg-1",
              build_id: "build-1",
              environment: "production",
              gate_kind: "release_gate",
              verdict: "measure_only",
              emitted_at: "2026-04-15T12:00:01.000Z",
            },
          ];
        }
        if (query.includes("FROM sync_release_gates") && query.includes("WHERE build_id =")) {
          return [];
        }
        if (query.includes("FROM sync_repair_plans") && query.includes("AND environment =")) {
          return [
            {
              id: "rp-1",
              build_id: "build-1",
              environment: "production",
              provider_scope: "meta",
              eligible: true,
              emitted_at: "2026-04-15T12:00:02.000Z",
            },
          ];
        }
        return [];
      }) as never,
    );

    const result = await controlPlanePersistence.getSyncControlPlanePersistenceStatus({
      buildId: "build-1",
      environment: "production",
      providerScope: "meta",
    });

    expect(result.exactRowsPresent).toBe(true);
    expect(result.missingExact).toEqual([]);
    expect(result.exact.deployGate?.id).toBe("dg-1");
    expect(result.exact.releaseGate?.id).toBe("rg-1");
    expect(result.exact.repairPlan?.id).toBe("rp-1");
  });

  it("reports build-only fallback rows when exact environment rows are missing", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      (async (strings: TemplateStringsArray) => {
        const query = strings.join(" ");
        if (query.includes("FROM sync_release_gates") && query.includes("AND environment =")) {
          return [];
        }
        if (query.includes("FROM sync_release_gates") && query.includes("WHERE build_id =")) {
          return [
            {
              id: "dg-fallback",
              build_id: "build-1",
              environment: "unknown",
              gate_kind: "deploy_gate",
              verdict: "pass",
              emitted_at: "2026-04-15T12:00:00.000Z",
            },
            {
              id: "rg-fallback",
              build_id: "build-1",
              environment: "unknown",
              gate_kind: "release_gate",
              verdict: "measure_only",
              emitted_at: "2026-04-15T12:00:01.000Z",
            },
          ];
        }
        if (query.includes("FROM sync_repair_plans") && query.includes("AND environment =")) {
          return [];
        }
        if (query.includes("FROM sync_repair_plans") && query.includes("WHERE build_id =")) {
          return [
            {
              id: "rp-fallback",
              build_id: "build-1",
              environment: "unknown",
              provider_scope: "meta",
              eligible: true,
              emitted_at: "2026-04-15T12:00:02.000Z",
            },
          ];
        }
        return [];
      }) as never,
    );

    const result = await controlPlanePersistence.getSyncControlPlanePersistenceStatus({
      buildId: "build-1",
      environment: "production",
      providerScope: "meta",
    });

    expect(result.exactRowsPresent).toBe(false);
    expect(result.missingExact).toEqual(["deployGate", "releaseGate", "repairPlan"]);
    expect(result.fallbackByBuild.deployGate?.environment).toBe("unknown");
    expect(result.fallbackByBuild.releaseGate?.environment).toBe("unknown");
    expect(result.fallbackByBuild.repairPlan?.environment).toBe("unknown");
  });

  it("bounds release gate lookups so build-info readiness stays cheap", async () => {
    const queries: string[] = [];
    vi.mocked(db.getDb).mockReturnValue(
      (async (strings: TemplateStringsArray) => {
        queries.push(strings.join(" "));
        return [];
      }) as never,
    );

    await controlPlanePersistence.getSyncControlPlanePersistenceStatus({
      buildId: "build-1",
      environment: "production",
      providerScope: "google_ads",
    });

    const gateQueries = queries.filter((query) => query.includes("FROM sync_release_gates"));
    expect(gateQueries).toHaveLength(3);
    expect(gateQueries.every((query) => query.includes("LIMIT 100"))).toBe(true);
  });
});
