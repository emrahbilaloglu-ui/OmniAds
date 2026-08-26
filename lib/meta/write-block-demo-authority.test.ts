import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SHARED write-block boundary, tested where the wrappers delegate to it.
 *
 * The ad / campaign / ad-set action routes are three-line wrappers:
 * `export async function POST(...) { return handleMetaAdStatusAction(...) }`.
 * Their demo refusal lives several helpers deep in
 * `lib/meta/ads-action-routes.ts` and `lib/meta/entity-action-routes.ts`, at
 * `rejectIfMetaWritesBlocked` -> `getMetaWriteBlockState`. Adding a second gate
 * to each wrapper would be a redundant authority over the same fact, so the
 * right move is to prove the shared one — and that is what this does.
 *
 * ## Why this file has to set an environment variable
 *
 * `getMetaWriteBlockState` short-circuits under vitest:
 *
 *   const isVitest = env.VITEST === "true" || env.NODE_ENV === "test";
 *   if (isVitest && env.META_AUTOMATION_WRITE_GUARD_TEST_READS !== "1") {
 *     return { blocked: false, reason: null, message: null };
 *   }
 *
 * So EVERY other test in this repository runs with the guard answering "not
 * blocked" before it reads anything. A green suite is not evidence that the
 * demo arm, the missing-business arm or the unreadable-control arm work. This
 * file sets `META_AUTOMATION_WRITE_GUARD_TEST_READS=1` so the real code runs.
 */

const getDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb }));

const { getMetaWriteBlockState } = await import("@/lib/meta/automation-control-plane");

const BUSINESS = "b0000000-0000-4000-8000-00000000000f";

/**
 * The tagged-template client. `readBusinessControlState` issues one query and
 * reads `rows[0]`, so a test controls the whole answer by choosing those rows —
 * or by throwing, which is the case that matters most.
 */
function stubRows(rows: unknown[] | Error) {
  getDb.mockReturnValue(() =>
    rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
  );
}

function controlRow(overrides: Record<string, unknown> = {}) {
  return {
    business_id: BUSINESS,
    is_demo_business: false,
    kill_switch_engaged: false,
    kill_switch_reason: null,
    auto_execution_enabled: false,
    readiness_tier: "manual_review",
    guardrails_json: {},
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the shared Meta write block is fail-closed about demo status", () => {
  it("does not block a proven live workspace", async () => {
    stubRows([controlRow()]);

    await expect(
      getMetaWriteBlockState({ businessId: BUSINESS }),
    ).resolves.toMatchObject({ blocked: false, reason: null });
  });

  it("blocks a business the database says is a demo workspace", async () => {
    stubRows([controlRow({ is_demo_business: true })]);

    await expect(
      getMetaWriteBlockState({ businessId: BUSINESS }),
    ).resolves.toMatchObject({
      blocked: true,
      reason: "demo_business_read_only",
    });
  });

  /*
   * The half that decides whether "fail-closed" is a real property or a
   * comment. An unreadable control state must block, not pass.
   */
  it("blocks when the control state cannot be read at all", async () => {
    stubRows(new Error("connection terminated unexpectedly"));

    await expect(
      getMetaWriteBlockState({ businessId: BUSINESS }),
    ).resolves.toMatchObject({
      blocked: true,
      reason: "control_state_unavailable",
    });
  });

  it("blocks when the business row is missing, rather than treating it as live", async () => {
    stubRows([]);

    await expect(
      getMetaWriteBlockState({ businessId: BUSINESS }),
    ).resolves.toMatchObject({
      blocked: true,
      reason: "control_state_unavailable",
    });
  });

  /*
   * The well-known demo id is refused before any read at all, so it holds even
   * against a database that cannot answer.
   */
  it("blocks the canonical demo business without reading anything", async () => {
    stubRows(new Error("the database must not be consulted for this case"));

    await expect(
      getMetaWriteBlockState({ businessId: "11111111-1111-4111-8111-111111111111" }),
    ).resolves.toMatchObject({
      blocked: true,
      reason: "demo_business_read_only",
    });
    expect(getDb).not.toHaveBeenCalled();
  });

  /*
   * And the escape hatch itself, pinned. If this ever stops being conditional
   * on the environment variable, every other test in the repository silently
   * starts exercising a different code path than production.
   */
  it("short-circuits under vitest unless the read flag is set", async () => {
    vi.unstubAllEnvs();
    stubRows(new Error("must not be reached while the short-circuit is active"));

    await expect(
      getMetaWriteBlockState({ businessId: BUSINESS }),
    ).resolves.toMatchObject({ blocked: false });
    expect(getDb).not.toHaveBeenCalled();
  });
});
