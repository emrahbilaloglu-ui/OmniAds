import { describe, expect, it } from "vitest";
import {
  buildMetaLaunchIntentErrorReceipt,
  buildMetaLaunchIntentResultReceipt,
  metaLaunchIntentRequestFingerprint,
  normalizeMetaLaunchIntentLineage,
} from "@/lib/launchpad/meta-launch-intent";
import {
  bindMetaLaunchpadManualAuthorityToPayload,
  META_LAUNCHPAD_MANUAL_AUTHORITY,
} from "@/lib/launchpad/meta-manual-authority";

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

  it("changes the immutable fingerprint when manual execution authority is absent", () => {
    const requestPayload = { campaign: { name: "A" } };
    const unbound = metaLaunchIntentRequestFingerprint({
      operation: "new_campaign",
      providerAccountId: "act_123",
      requestPayload,
    });
    const bound = metaLaunchIntentRequestFingerprint({
      operation: "new_campaign",
      providerAccountId: "act_123",
      requestPayload: bindMetaLaunchpadManualAuthorityToPayload(
        requestPayload,
        META_LAUNCHPAD_MANUAL_AUTHORITY,
      ),
    });

    expect(bound).not.toBe(unbound);
  });

  it("excludes attempt identity while preserving real semantic payload changes", () => {
    const semantic = metaLaunchIntentRequestFingerprint({
      operation: "add_to_existing",
      providerAccountId: "act_123",
      requestPayload: {
        targetAdsetId: "adset_1",
        executionAuthority: META_LAUNCHPAD_MANUAL_AUTHORITY,
      },
    });
    const freshAttempt = metaLaunchIntentRequestFingerprint({
      operation: "add_to_existing",
      providerAccountId: "act_123",
      requestPayload: {
        targetAdsetId: "adset_1",
        idempotencyKey: "fresh-key",
        launch_intent_id: "fresh-intent",
        nested: { request_fingerprint: "attempt-only" },
        executionAuthority: META_LAUNCHPAD_MANUAL_AUTHORITY,
      },
    });
    const changedTarget = metaLaunchIntentRequestFingerprint({
      operation: "add_to_existing",
      providerAccountId: "act_123",
      requestPayload: {
        targetAdsetId: "adset_2",
        executionAuthority: META_LAUNCHPAD_MANUAL_AUTHORITY,
      },
    });

    expect(freshAttempt).toBe(semantic);
    expect(changedTarget).not.toBe(semantic);
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
      executionAuthority: META_LAUNCHPAD_MANUAL_AUTHORITY,
      requestFingerprint: "fingerprint_1",
      completedAt: "2026-07-10T12:00:00.000Z",
    });
    const error = buildMetaLaunchIntentErrorReceipt({
      providerAccountId: "act_123",
      code: "silent_failure",
      message: "Provider response could not be verified.",
      executionAuthority: META_LAUNCHPAD_MANUAL_AUTHORITY,
      requestFingerprint: "fingerprint_1",
      recordedAt: "2026-07-10T12:00:00.000Z",
    });

    expect(result.recovery).toEqual({
      rollbackSupported: false,
      retrySupported: false,
    });
    expect(error.recovery).toEqual(result.recovery);
    expect(result.executionAuthority).toEqual(
      META_LAUNCHPAD_MANUAL_AUTHORITY,
    );
    expect(error.requestFingerprint).toBe("fingerprint_1");
  });
});
