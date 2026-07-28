import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every Launchpad provider write — campaign, ad set, ad, pause, resume,
 * duplicate — flows through resolveMetaLaunchWriteContext. It built the context
 * with businessId, providerAccountId and accessToken, and omitted
 * connectionGeneration.
 *
 * That mattered because ads-write.ts guarded the pre-POST authority check with
 * `ctx.connectionGeneration ? await assert(...) : { ok: true }`. A missing field
 * therefore did not fail — it silently SKIPPED the check, which is the exact
 * "there is no generation to check" state the guard's own comment forbids. So a
 * user could disconnect Meta and reconnect as a different principal mid-launch
 * and the write still went out under the replaced credential. `bulk-ad-status`
 * resume is the one that starts real spend.
 *
 * The field is now required by the type, so the omission cannot compile again.
 * These tests cover what the type cannot: that the value is real, comes from the
 * connection row, and that an unreadable connection fails closed.
 */

const getIntegration = vi.fn();
const getProviderAccountAssignments = vi.fn();

vi.mock("@/lib/integrations", () => ({
  getIntegration: (...args: unknown[]) => getIntegration(...args),
}));
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: (...args: unknown[]) => getProviderAccountAssignments(...args),
  PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE: 0x50415353,
}));
vi.mock("@/lib/db", () => ({ getDb: () => vi.fn(), runDbTransaction: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  getProviderAccountAssignments.mockReset().mockResolvedValue({ account_ids: ["act_1"] });
  getIntegration.mockReset().mockResolvedValue({
    status: "connected",
    access_token: "tok",
    connection_generation: 7,
  });
});

describe("resolveMetaLaunchWriteContext", () => {
  it("carries the connection generation from the same row as the token", async () => {
    const { resolveMetaLaunchWriteContext } = await import("./meta-validation");
    const result = await resolveMetaLaunchWriteContext("biz-1", "act_1");

    expect(result.ok).toBe(true);
    expect(
      result.ok && result.ctx.connectionGeneration,
      "without this the pre-POST authority check silently self-disables",
    ).toBe("7:connected");
  });

  it("uses the identical generation:status shape the boundary re-reads", async () => {
    const { connectionGenerationTokenFromIntegration } = await import(
      "@/lib/provider-property-selection"
    );
    const { resolveMetaLaunchWriteContext } = await import("./meta-validation");
    const result = await resolveMetaLaunchWriteContext("biz-1", "act_1");

    // A mismatched shape would compare unequal on every write, or worse, never.
    expect(result.ok && result.ctx.connectionGeneration).toBe(
      connectionGenerationTokenFromIntegration({
        status: "connected",
        connection_generation: 7,
      } as never),
    );
  });

  it("fails closed when the connection cannot be read, instead of reporting it disconnected", async () => {
    getIntegration.mockRejectedValue(new Error("connection refused"));
    const { resolveMetaLaunchWriteContext } = await import("./meta-validation");
    const result = await resolveMetaLaunchWriteContext("biz-1", "act_1");

    expect(result.ok).toBe(false);
    // A database outage is "I could not tell", not "the user disconnected".
    expect(result.ok === false && result.blocker.code).toBe("meta_connection_unreadable");
  });

  it("still reports a genuinely disconnected integration as disconnected", async () => {
    getIntegration.mockResolvedValue({ status: "disconnected", access_token: null });
    const { resolveMetaLaunchWriteContext } = await import("./meta-validation");
    const result = await resolveMetaLaunchWriteContext("biz-1", "act_1");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.blocker.code).toBe("meta_not_connected");
  });

  it("defaults a null generation counter rather than emitting an empty token", async () => {
    getIntegration.mockResolvedValue({
      status: "connected",
      access_token: "tok",
      connection_generation: null,
    });
    const { resolveMetaLaunchWriteContext } = await import("./meta-validation");
    const result = await resolveMetaLaunchWriteContext("biz-1", "act_1");

    expect(result.ok && result.ctx.connectionGeneration).toBe("1:connected");
  });
});
