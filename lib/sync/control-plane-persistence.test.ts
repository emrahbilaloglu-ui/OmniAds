import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/build-info` used to read the control plane with three `LIMIT 100` scans of
 * `sync_release_gates` — one keyed on build+environment, one on build, and one
 * with NO key predicate at all — then pick the first row of each kind in
 * JavaScript.
 *
 * `LIMIT 100` bounds the ROWS RETURNED, not the work: the planner still has to
 * order the matching set to find the first hundred. On a table that had grown
 * to ~1.35 GB by appending a row per gate evaluation, that made a
 * once-per-request readiness probe proportional to the size of the runaway.
 *
 * Every read is now keyed on exactly what it answers and returns at most one
 * row, with the `emitted_at DESC, id DESC` tie-break the index carries.
 */

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

interface ObservedQuery {
  text: string;
  values: unknown[];
}

/**
 * Fake DB exposing BOTH interfaces the module uses: the tagged template for the
 * repair-plan reads and `.query()` for the parameterised keyed gate reads.
 */
function installDb(
  respond: (query: ObservedQuery) => Array<Record<string, unknown>>,
) {
  const observed: ObservedQuery[] = [];
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const entry = { text: strings.join(" ? "), values };
    observed.push(entry);
    return respond(entry);
  }) as unknown as ReturnType<typeof db.getDb>;
  (tag as unknown as { query: unknown }).query = async (
    text: string,
    values: unknown[] = [],
  ) => {
    const entry = { text, values };
    observed.push(entry);
    return respond(entry);
  };
  vi.mocked(db.getDb).mockReturnValue(tag);
  return observed;
}

function gateRow(overrides: Record<string, unknown>) {
  return {
    id: "row-1",
    build_id: "build-1",
    environment: "production",
    gate_kind: "deploy_gate",
    gate_scope: "release_readiness",
    mode: "measure_only",
    base_result: "pass",
    verdict: "pass",
    blocker_class: null,
    summary: "",
    break_glass: false,
    override_reason: null,
    evidence_json: {},
    emitted_at: "2026-04-15T12:00:00.000Z",
    ...overrides,
  };
}

const isGateQuery = (query: ObservedQuery) =>
  query.text.includes("FROM sync_release_gates");

describe("sync control-plane persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("passes when exact build and environment rows exist", async () => {
    installDb((query) => {
      if (isGateQuery(query) && query.values.includes("production")) {
        const isDeploy = query.values.includes("deploy_gate");
        return [
          gateRow({
            id: isDeploy ? "dg-1" : "rg-1",
            gate_kind: isDeploy ? "deploy_gate" : "release_gate",
            verdict: isDeploy ? "pass" : "measure_only",
          }),
        ];
      }
      if (
        query.text.includes("FROM sync_repair_plans") &&
        query.text.includes("AND environment =")
      ) {
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
    });

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
    installDb((query) => {
      if (isGateQuery(query)) {
        // Only the build-scoped read (no environment value) answers.
        if (query.values.includes("production")) return [];
        if (!query.values.includes("build-1")) return [];
        const isDeploy = query.values.includes("deploy_gate");
        return [
          gateRow({
            id: isDeploy ? "dg-fallback" : "rg-fallback",
            gate_kind: isDeploy ? "deploy_gate" : "release_gate",
            environment: "unknown",
          }),
        ];
      }
      if (
        query.text.includes("FROM sync_repair_plans") &&
        query.text.includes("AND environment =")
      ) {
        return [];
      }
      if (
        query.text.includes("FROM sync_repair_plans") &&
        query.text.includes("WHERE build_id =")
      ) {
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
    });

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

  it("reads one row per key and never scans", async () => {
    const observed = installDb(() => []);

    await controlPlanePersistence.getSyncControlPlanePersistenceStatus({
      buildId: "build-1",
      environment: "production",
      providerScope: "google_ads",
    });

    const gateQueries = observed.filter(isGateQuery);
    // Six: exact/fallback/global × deploy/release. Each is a separate keyed
    // question rather than one scan answering several.
    expect(gateQueries).toHaveLength(6);
    for (const query of gateQueries) {
      expect(query.text).toContain("LIMIT 1");
      expect(query.text).not.toContain("LIMIT 100");
      // Every read narrows to a gate kind and a provider scope, so no query can
      // return rows it then has to sift through.
      expect(query.text).toContain("gate_kind = $1");
      expect(query.text).toContain("COALESCE(provider_scope, 'meta') = $2");
      // Deterministic tie-break: two evaluations in the same millisecond must
      // not resolve to different rows for two readers.
      expect(query.text).toContain("ORDER BY emitted_at DESC, id DESC");
      expect(query.values[0]).toMatch(/^(deploy|release)_gate$/);
      expect(query.values[1]).toBe("google_ads");
    }

    // The exact reads carry build AND environment; the fallback carries build
    // only; the global carries neither. None is unkeyed on kind+scope.
    const keyed = gateQueries.map((query) => query.values.length);
    expect(keyed.filter((count) => count === 4)).toHaveLength(2);
    expect(keyed.filter((count) => count === 3)).toHaveLength(2);
    expect(keyed.filter((count) => count === 2)).toHaveLength(2);
  });
});
