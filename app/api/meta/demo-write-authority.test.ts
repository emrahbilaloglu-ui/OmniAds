import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(),
}));

const authority = await import("@/app/api/launchpad/meta/demo-write-authority");
const {
  META_OPERATOR_DEMO_WRITE_REFUSAL,
  META_OPERATOR_UNVERIFIED_WRITE_REFUSAL,
  rejectIfMetaOperatorDemoWrite,
} = await import("@/app/api/meta/demo-write-authority");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rejectIfMetaOperatorDemoWrite", () => {
  it("lets a proven live workspace through", async () => {
    vi.mocked(authority.readLaunchpadWriteAuthority).mockResolvedValue("live");

    await expect(
      rejectIfMetaOperatorDemoWrite("biz_1", "operator_response"),
    ).resolves.toBeNull();
  });

  it("refuses a confirmed demo workspace with 403 and the shared code", async () => {
    vi.mocked(authority.readLaunchpadWriteAuthority).mockResolvedValue("demo");

    const response = await rejectIfMetaOperatorDemoWrite("biz_1", "operator_response");
    const payload = await response!.json();

    expect(response!.status).toBe(403);
    expect(payload.error.code).toBe("demo_business_read_only");
    expect(payload.error.action).toBe("operator_response");
    expect(payload.error.message).toBe(META_OPERATOR_DEMO_WRITE_REFUSAL);
  });

  /*
   * FAIL-CLOSED, and this is the half that matters. `readLaunchpadWriteAuthority`
   * answers `unverified` for an empty id, a missing row and any thrown read, so
   * a database outage arrives here — and must never read as authority to write.
   */
  for (const state of ["unverified", "not_established"] as const) {
    it(`refuses ${state} with 503, never treating it as live`, async () => {
      vi.mocked(authority.readLaunchpadWriteAuthority).mockResolvedValue(state);

      const response = await rejectIfMetaOperatorDemoWrite("biz_1", "snapshot_refresh");
      const payload = await response!.json();

      expect(response!.status).toBe(503);
      expect(payload.error.code).toBe("demo_status_unverified");
      expect(payload.error.action).toBe("snapshot_refresh");
      expect(payload.error.message).toBe(META_OPERATOR_UNVERIFIED_WRITE_REFUSAL);
    });
  }

  /*
   * The refusal is stated twice on purpose. `interpretMetaSnapshotRunResponse`
   * — the one interpreter both run-now clients share — reads `payload.message`
   * first, and a refusal it cannot read renders as the generic "Snapshot
   * refresh failed.", which teaches the operator to retry.
   */
  for (const state of ["demo", "unverified"] as const) {
    it(`states the ${state} refusal at the top level as well as inside error`, async () => {
      vi.mocked(authority.readLaunchpadWriteAuthority).mockResolvedValue(state);

      const payload = await (
        await rejectIfMetaOperatorDemoWrite("biz_1", "snapshot_refresh")
      )!.json();

      expect(payload.ok).toBe(false);
      expect(payload.message).toBe(payload.error.message);
      expect(payload.message.length).toBeGreaterThan(30);
    });
  }

  it("asks about the business it was given, and derives nothing itself", async () => {
    vi.mocked(authority.readLaunchpadWriteAuthority).mockResolvedValue("live");

    await rejectIfMetaOperatorDemoWrite("biz_resolved", "operator_response");

    expect(authority.readLaunchpadWriteAuthority).toHaveBeenCalledTimes(1);
    expect(authority.readLaunchpadWriteAuthority).toHaveBeenCalledWith("biz_resolved");
  });
});
