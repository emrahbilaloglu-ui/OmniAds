import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db";
import { runAdDecisionsJob } from "../../jobs/ad-decisions-job";

vi.mock("../../evaluation-store", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  inspectEvaluationStoreSchemaCapability: vi.fn(async () => ({ ready: true, missing: [] })),
  assertEvaluationStoreSchemaReady: vi.fn(async () => undefined),
}));

const input = { businessId: "00000000-0000-4000-8000-000000000901", asOf: "2026-09-28" };
const id = "00000000-0000-4000-8000-000000000902";
const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });

function fixture(options: { innerWriteFails?: boolean; outerWriteFails?: boolean; reaped?: boolean } = {}) {
  let inside = false;
  let status = "running";
  let persisted: Record<string, unknown> | undefined;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO engine_v3_job_runs")) return [{ id }];
    if (sql.includes("pg_try_advisory_xact_lock")) return [{ acquired: true }];
    if (sql.includes("SELECT id FROM engine_v3_job_runs")) {
      if (options.reaped) { status = "failed"; return []; }
      return [{ id }];
    }
    if (sql.includes("SET status = 'failed'")) {
      if ((inside && options.innerWriteFails) || (!inside && options.outerWriteFails)) {
        throw new Error("terminal write connection lost");
      }
      if (status === "running") { status = "failed"; persisted = JSON.parse(String(params[2])); }
      return [];
    }
    if (sql.startsWith("SELECT status FROM engine_v3_job_runs")) return [{ status }];
    return [];
  });
  const db = { query } as unknown as DbClient;
  const hydrateAdDecisionInputs = vi.fn(async () => { throw timeout; });
  return {
    query, hydrateAdDecisionInputs, status: () => status, persisted: () => persisted,
    runtime: {
      db,
      transaction: async <T>(fn: () => Promise<T>) => {
        inside = true;
        try { return await fn(); } finally { inside = false; }
      },
      businessGuard: vi.fn(async () => null),
      resolveFlags: vi.fn(async () => ({ enabled: true })) as never,
      inspectProfileSchema: vi.fn(async () => ({ ready: true, missing: [] })),
      dataSource: { hydrateAdDecisionInputs },
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("native run terminal ownership", () => {
  it("closes a running ledger after an inner failure update is lost", async () => {
    const f = fixture({ innerWriteFails: true });
    const result = await runAdDecisionsJob(input, f.runtime);
    expect(f.status()).toBe("failed");
    expect(result.status).toBe("failed");
    expect(result.terminalStatusPersisted).toBe(true);
    expect(f.persisted()?.code).toBe("57014");
    expect(f.persisted()?.metadata).toMatchObject({ stage_timings: { hydrate_inputs: expect.any(Number) } });
  });

  it("retains the committed terminal error when fallback sees a terminal row", async () => {
    const f = fixture();
    const result = await runAdDecisionsJob(input, f.runtime);
    expect(result.terminalStatusPersisted).toBe(true);
    expect(f.persisted()?.message).toBe(timeout.message);
    expect(f.persisted()?.code).toBe("57014");
  });

  it("reports unpersisted terminal metadata instead of implying closure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture({ innerWriteFails: true, outerWriteFails: true });
    const result = await runAdDecisionsJob(input, f.runtime);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe(timeout.message);
    expect(result.terminalStatusPersisted).toBe(false);
    expect(f.status()).toBe("running");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("terminal_status_write_failed"),
      expect.objectContaining({ jobRunId: id, code: "native_run_finalization_failed" }));
    log.mockRestore();
  });

  it("performs no hydration or evaluation work after a reaper closed the waiting attempt", async () => {
    const f = fixture({ reaped: true });
    const result = await runAdDecisionsJob(input, f.runtime);
    expect(result.status).toBe("skipped");
    expect(result.snapshotsWritten).toBe(0);
    expect(f.hydrateAdDecisionInputs).not.toHaveBeenCalled();
    expect(f.query.mock.calls.some(([sql]) => /INSERT INTO engine_v3_ad_decision/.test(sql))).toBe(false);
  });

  it("independently finalizes a transaction acquisition failure", async () => {
    const f = fixture();
    f.runtime.transaction = async () => { throw new Error("pool acquisition failed"); };
    const result = await runAdDecisionsJob(input, f.runtime);
    expect(result.terminalStatusPersisted).toBe(true);
    expect(f.status()).toBe("failed");
    expect(f.hydrateAdDecisionInputs).not.toHaveBeenCalled();
  });
});
