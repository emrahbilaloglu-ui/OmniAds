import { describe, expect, it } from "vitest";
import {
  buildMetaLaunchIntentErrorReceipt,
  buildMetaLaunchIntentResultReceipt,
  metaLaunchIntentRequestFingerprint,
  normalizeMetaLaunchIntentLineage,
} from "@/lib/launchpad/meta-launch-intent";

describe("Meta LaunchIntent domain contract", () => {
  it("fingerprints canonical payload content and the explicit provider account", () => {
    const first = metaLaunchIntentRequestFingerprint({
      operation: "new_campaign",
      providerAccountId: "act_123",
      requestPayload: { campaign: { objective: "OUTCOME_SALES", name: "A" }, count: 2 },
    });
    const reordered = metaLaunchIntentRequestFingerprint({
      operation: "new_campaign",
      providerAccountId: "act_123",
      requestPayload: { count: 2, campaign: { name: "A", objective: "OUTCOME_SALES" } },
    });
    const otherAccount = metaLaunchIntentRequestFingerprint({
      operation: "new_campaign",
      providerAccountId: "act_456",
      requestPayload: { count: 2, campaign: { name: "A", objective: "OUTCOME_SALES" } },
    });

    expect(first).toBe(reordered);
    expect(otherAccount).not.toBe(first);
  });

  it("preserves optional decision, brief, and draft lineage without inventing ids", () => {
    expect(
      normalizeMetaLaunchIntentLineage({
        sourceDecisionId: " decision_1 ",
        sourceDecisionSnapshotId: " snapshot_1 ",
        creativeBriefId: " brief_1 ",
        sourceDraftId: " ",
      }),
    ).toEqual({
      sourceDecisionId: "decision_1",
      sourceDecisionSnapshotId: "snapshot_1",
      creativeBriefId: "brief_1",
      sourceDraftId: null,
    });
  });

  it("states truthfully that neither rollback nor automatic retry exists", () => {
    const result = buildMetaLaunchIntentResultReceipt({
      providerAccountId: "act_123",
      campaignId: "campaign_1",
      completedAt: "2026-07-10T12:00:00.000Z",
    });
    const error = buildMetaLaunchIntentErrorReceipt({
      providerAccountId: "act_123",
      code: "silent_failure",
      message: "Provider response could not be verified.",
      recordedAt: "2026-07-10T12:00:00.000Z",
    });

    expect(result.recovery).toEqual({
      rollbackSupported: false,
      retrySupported: false,
    });
    expect(error.recovery).toEqual(result.recovery);
  });
});
