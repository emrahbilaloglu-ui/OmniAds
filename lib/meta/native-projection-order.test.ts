import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true, missingTables: [] })),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  resolveEffectiveMetaModes: vi.fn(),
}));

import * as db from "@/lib/db";
import * as controlPlane from "@/lib/meta/automation-control-plane";
import { projectNativeAdProposals } from "@/lib/meta/automation-proposals";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

/**
 * The native ad projection, as its own entry point.
 *
 * It used to live inside the structure snapshot, and the cron runs the native
 * ad chain AFTERWARDS — so it read the previous slot's decisions every time.
 * The morning's decisions never reached the queue in the morning; by the
 * afternoon it was queueing those while the afternoon's own were again still
 * unwritten. Moving it behind publication is the fix, and this pins the
 * contract that makes the move safe: it is callable on its own, gated on the
 * standing mode, and re-runnable.
 */
function recordingDb() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tag = (() => Promise.resolve([])) as unknown as ReturnType<typeof db.getDb>;
  (tag as unknown as { query: unknown }).query = async (
    text: string,
    values: unknown[],
  ) => {
    calls.push({ text, values });
    return [{ id: "proposal_1" }];
  };
  vi.mocked(db.getDb).mockReturnValue(tag);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(controlPlane.resolveEffectiveMetaModes).mockResolvedValue({
    pause: "semi_auto", bid: "manual", budget: "manual", creative: "manual",
  } as never);
});

describe("the native projection runs on its own, after publication", () => {
  it("projects the day's native cuts when the pause family is armed", async () => {
    const calls = recordingDb();

    const result = await projectNativeAdProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-05",
    });

    expect(result).toEqual({ projected: 1, ran: true });
    const insert = calls.find((call) =>
      call.text.includes("INSERT INTO meta_automation_proposals"));
    expect(insert, "the projection issued no insert").toBeDefined();
    // It reads the native decision table, which is exactly the table the chain
    // has just written — and could not have, from the structure snapshot.
    expect(insert!.text).toContain("engine_v3_ad_decision_snapshots_daily");
    // Both conditions: a `cut` whose authority was withheld is a diagnosis,
    // not a proposal.
    expect(insert!.text).toContain("d.label = 'cut'");
    expect(insert!.text).toContain("d.authorized_action = 'cut'");
  });

  it("projects nothing in manual mode", async () => {
    vi.mocked(controlPlane.resolveEffectiveMetaModes).mockResolvedValue({
      pause: "manual", bid: "manual", budget: "manual", creative: "manual",
    } as never);
    const calls = recordingDb();

    expect(await projectNativeAdProposals({
      businessId: BUSINESS, snapshotDate: "2026-09-05",
    })).toEqual({ projected: 0, ran: true });
    expect(calls.some((call) =>
      call.text.includes("INSERT INTO meta_automation_proposals"))).toBe(false);
  });

  it("reports not-ran when the standing mode cannot be read", async () => {
    // Unreadable is not manual, and it is not armed either. The caller can
    // tell the difference and retry.
    vi.mocked(controlPlane.resolveEffectiveMetaModes)
      .mockRejectedValue(new Error("control plane down"));
    recordingDb();

    expect(await projectNativeAdProposals({
      businessId: BUSINESS, snapshotDate: "2026-09-05",
    })).toEqual({ projected: 0, ran: false });
  });

  it("is safe to call again: the insert only refreshes a pending row", async () => {
    /*
      What makes a partial-account retry safe. The ON CONFLICT targets the
      projection's own key and the DO UPDATE is guarded on `status =
      'pending'`, so a second call adds what is missing and never touches a row
      an operator has already decided.
    */
    const calls = recordingDb();
    await projectNativeAdProposals({
      businessId: BUSINESS, snapshotDate: "2026-09-05",
    });
    const insert = calls.find((call) =>
      call.text.includes("INSERT INTO meta_automation_proposals"))!;
    expect(insert.text).toContain("ON CONFLICT");
    expect(insert.text).toContain("meta_automation_proposals.status = 'pending'");
  });
});
