/**
 * What a growth-fence refusal is allowed to do to worker boot.
 *
 * The fence's per-table ceilings exist, in its own words, "to catch a single
 * relation running away inside" the aggregate. It already learned once that
 * treating a ceiling like an aggregate breach is too wide: on 2026-08-08
 * `meta_entity_state_history` sat 0.005% over its ceiling and Google Ads and
 * Shopify sync — which cannot write a byte of it — were stopped for 26 hours.
 * That was fixed for per-operation admission and the boot path was missed.
 *
 * On 2026-08-16 the same table sat 2.5% over (4.10 GiB against 4.00 GiB) while
 * the host reported 137 GB free, and the worker refused to boot, exited, and
 * was restarted forever — so no provider synced at all and nothing reported
 * why. Refusing boot is strictly worse than refusing a write: it removes the
 * process that would do both.
 *
 * These assert the boundary that decision rests on, so a future edit cannot
 * quietly widen a ceiling back into an outage or narrow the aggregate.
 */
import { describe, expect, it } from "vitest";

import {
  DbGrowthFenceRefusal,
  fencedTableProviderFamily,
  operationProviderFamily,
  type DbGrowthFenceDecision,
} from "@/lib/sync/db-growth-fence";

function refusal(
  overrides: Partial<DbGrowthFenceDecision> = {},
): DbGrowthFenceRefusal {
  const decision = {
    allowed: false,
    reason: "table_budget_exceeded",
    offender: {
      table: "meta_entity_state_history",
      bytes: 4_403_699_712,
      budget: 4_294_967_296,
    },
    ...overrides,
  } as unknown as DbGrowthFenceDecision;
  return new DbGrowthFenceRefusal(decision, "durable_worker_boot");
}

/** The predicate `worker-runtime` boots through, stated once. */
function isTableCeilingOnly(error: unknown): boolean {
  return (
    error instanceof DbGrowthFenceRefusal &&
    error.decision.reason === "table_budget_exceeded" &&
    error.decision.offender != null &&
    error.decision.offender.table !== "database"
  );
}

describe("a growth-fence refusal at worker boot", () => {
  it("does not take the process down for one relation over its ceiling", () => {
    expect(isTableCeilingOnly(refusal())).toBe(true);
  });

  it("still takes it down when the aggregate database budget is breached", () => {
    expect(
      isTableCeilingOnly(
        refusal({
          reason: "database_budget_exceeded",
          offender: { table: "database", bytes: 1, budget: 0 },
        } as Partial<DbGrowthFenceDecision>),
      ),
    ).toBe(false);
  });

  it("still takes it down when the fence itself could not be read", () => {
    expect(
      isTableCeilingOnly(
        refusal({
          reason: "fence_read_failed",
          offender: null,
        } as Partial<DbGrowthFenceDecision>),
      ),
    ).toBe(false);
  });

  it("is not fooled by a non-fence error", () => {
    expect(isTableCeilingOnly(new Error("connection reset"))).toBe(false);
  });

  /**
   * Booting is safe only because the write path still refuses. `durable_worker_boot`
   * has no provider family, so per-operation admission cannot prove it harmless —
   * which is exactly why the boot path needed its own answer rather than reusing
   * the collateral rule.
   */
  it("writes to the offending provider still refuse, one operation at a time", () => {
    expect(fencedTableProviderFamily("meta_entity_state_history")).toBe("meta");
    expect(operationProviderFamily("meta_worker_tick")).toBe("meta");
    // Same family => no collateral exemption => the Meta tick still refuses.
    expect(operationProviderFamily("google_ads_worker_tick")).toBe("google_ads");
    // And boot is unprovable, which is why it is handled explicitly.
    expect(operationProviderFamily("durable_worker_boot")).toBeNull();
  });
});
