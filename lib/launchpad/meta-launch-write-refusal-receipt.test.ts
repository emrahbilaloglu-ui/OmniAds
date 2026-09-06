/**
 * The durable receipt names the posture that actually refused the launch.
 *
 * Both Launchpad create handlers refuse at a SECOND posture read, after the
 * intent has been prepared, and then transition that intent to `write_blocked`
 * permanently. The receipt they filed said `kill_switch_engaged` no matter
 * what refused: a business in rehearsal was answered `dry_run_guardrail` on
 * the wire and recorded as a kill switch nobody had engaged, and so was every
 * non-kill-switch posture — a closed release capability, a read-only readiness
 * tier — that closes between the route's first `getMetaWriteBlockState` check
 * and this one. The receipt is the only record a later receipt/history reader
 * has, so it may not disagree with the response.
 *
 * The refusal envelope here is the REAL `metaWriteBlockedResponse`: it is the
 * one place the posture -> code mapping lives, and this suite exists to prove
 * the receipt agrees with it rather than restating a copy. Only the posture
 * READ is stood in for — the first gate passes on its own, because
 * `getMetaWriteBlockState` short-circuits to unblocked under vitest.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { META_LAUNCHPAD_MANUAL_AUTHORITY } from "@/lib/launchpad/meta-manual-authority";
import { isMetaWriteBlockedCode } from "@/lib/meta/write-blocked-codes";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  rejectIfLaunchpadDemoWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/meta/ads-action-log", () => ({
  createMetaAdsActionLog: vi.fn(),
  completeMetaAdsActionLog: vi.fn(),
  hasRecentPendingMetaLaunchAction: vi.fn(async () => false),
  hasRecentPendingMetaAddToExistingAction: vi.fn(async () => false),
}));
vi.mock("@/lib/meta/launch-write", () => ({
  createCampaign: vi.fn(),
  createAdSet: vi.fn(),
  createAd: vi.fn(),
  preflightMetaLaunchCreatives: vi.fn(),
}));
vi.mock("@/lib/meta/automation-write-guard", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/meta/automation-write-guard")>()),
  readMetaWritePosture: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-validation", () => ({
  metaLaunchAccountBlockerHttpStatus: vi.fn(() => 403),
  resolveAssignedMetaLaunchAccount: vi.fn(async () => ({
    ok: true,
    providerAccountId: "act_123",
  })),
  resolveMetaLaunchWriteContext: vi.fn(),
  validateMetaLaunchRequest: vi.fn(),
  validateMetaAddToExistingRequest: vi.fn(),
  validateMetaAddToExistingLiveProviderPreflight: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-capability", () => ({
  getMetaLaunchIntentCapability: vi.fn(async () => ({
    status: "ready",
    canRead: true,
    canWrite: true,
    missingTables: [],
    checkedAt: "2026-09-05T08:00:00.000Z",
  })),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-service", () => ({
  prepareMetaLaunchIntentForExecution: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  getMetaLaunchIntent: vi.fn(async () => null),
  markMetaLaunchIntentExecuting: vi.fn(),
  recordMetaLaunchIntentOutcome: vi.fn(),
  recordMetaLaunchIntentPreExecutionFailure: vi.fn(),
  recordMetaLaunchIntentValidation: vi.fn(),
  recordMetaLaunchIntentWriteBlocked: vi.fn(async () => ({
    id: "intent_1",
    status: "write_blocked",
  })),
}));

const access = await import("@/lib/access");
const writeGuard = await import("@/lib/meta/automation-write-guard");
const intentService = await import("@/lib/launchpad/meta-launch-intent-service");
const intentStore = await import("@/lib/launchpad/meta-launch-intent-store");
const validation = await import("@/lib/launchpad/meta-validation");
const { handleMetaAddToExistingAction, handleMetaLaunchAction } = await import(
  "@/lib/launchpad/meta-launch-route-handlers"
);

type MetaWritePosture = import("@/lib/meta/automation-write-guard").MetaWritePosture;

const BUSINESS_ID = "9c1f6d2a-4f52-4a2e-9c1b-6d3f8a71b204";
const USER_ID = "7b2e4c11-9d33-4f88-a0d5-2c7e5b6a1f39";

function posture(over: Partial<MetaWritePosture> = {}): MetaWritePosture {
  return {
    blocked: false,
    rehearsal: false,
    reason: null,
    message: null,
    ...over,
  } as MetaWritePosture;
}

function launchRequest() {
  return new NextRequest("http://localhost/api/launchpad/meta/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...META_LAUNCHPAD_MANUAL_AUTHORITY,
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      idempotencyKey: "idem_refusal",
      payload: {
        campaign: {
          name: "Refusal receipt",
          objective: "OUTCOME_SALES",
          specialAdCategories: [],
        },
        budget: {
          mode: "CBO",
          schedule: "daily",
          amountMinor: 5000,
          bidStrategy: "LOWEST_COST_WITHOUT_CAP",
        },
        creatives: [{ creativeId: "creative_1", name: "Creative 1" }],
        adSets: [
          {
            clientId: "adset-1",
            name: "Ad set 1",
            optimizationGoal: "OFFSITE_CONVERSIONS",
            pixelId: "pixel_1",
            customEventType: "PURCHASE",
            targeting: { countries: ["US"], ageMin: 18, ageMax: 65 },
          },
        ],
      },
    }),
  });
}

function addToExistingRequest() {
  return new NextRequest("http://localhost/api/launchpad/meta/add-to-existing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...META_LAUNCHPAD_MANUAL_AUTHORITY,
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      idempotencyKey: "idem_refusal_add",
      copyMode: "reuse_creative",
      targets: [{ targetCampaignId: "camp_1", targetAdsetId: "adset_1" }],
      creativeIds: ["creative_1"],
      creatives: [{ creativeId: "creative_1", sourceAdId: "ad_1", name: "Winner" }],
    }),
  });
}

/** The receipt the handler filed on the intent, not the one it returned. */
function recordedReceipt() {
  const calls = vi.mocked(intentStore.recordMetaLaunchIntentWriteBlocked).mock.calls;
  expect(calls).toHaveLength(1);
  return (calls[0]![0] as { receipt: { code: string; message: string; failedAt: string | null } })
    .receipt;
}

beforeEach(() => {
  vi.clearAllMocks();
  // This suite is about the write-guard refusal, so the execution gate is
  // opened deliberately; its own refusal has coverage elsewhere.
  process.env.META_LAUNCHPAD_EXECUTION = "true";
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: { user: { id: USER_ID, email: "operator@adsecute.com" } },
    membership: { businessId: BUSINESS_ID },
  } as never);
  vi.mocked(validation.resolveAssignedMetaLaunchAccount).mockResolvedValue({
    ok: true,
    providerAccountId: "act_123",
  });
  vi.mocked(intentService.prepareMetaLaunchIntentForExecution).mockResolvedValue({
    ok: true,
    created: true,
    intent: {
      id: "intent_1",
      status: "prepared",
      requestFingerprint: "fingerprint_1",
      lineage: {
        sourceDecisionId: null,
        sourceDecisionSnapshotId: null,
        creativeBriefId: null,
        sourceDraftId: null,
      },
    },
  } as never);
  vi.mocked(intentStore.recordMetaLaunchIntentWriteBlocked).mockResolvedValue({
    id: "intent_1",
    status: "write_blocked",
  } as never);
});

describe("a refused Launchpad create files the refusal it answered with", () => {
  it("records rehearsal as the rehearsal guardrail, not a kill switch", async () => {
    /*
      The defect in its plainest form: nothing is stopped, the business is
      rehearsing, and the operator was told `dry_run_guardrail` while the
      permanent record said a kill switch was engaged.
    */
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
      posture({ rehearsal: true }),
    );

    const response = await handleMetaLaunchAction(launchRequest());
    const body = (await response.json()) as {
      error: { code: string };
      launchIntentStatus: string;
    };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("dry_run_guardrail");
    expect(body.launchIntentStatus).toBe("write_blocked");
    const receipt = recordedReceipt();
    expect(receipt.code).toBe("dry_run_guardrail");
    expect(receipt.message).not.toMatch(/kill switch/i);
    expect(receipt.failedAt).toBe("write_guard");
  });

  it("records a closed release capability as itself", async () => {
    // The posture the release-gate work made reachable: live writes are simply
    // not open in this environment, and no operator engaged anything.
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
      posture({
        blocked: true,
        rehearsal: true,
        reason: "release_capability_closed",
        message: "Live Meta writes are not open in this environment.",
      }),
    );

    const response = await handleMetaLaunchAction(launchRequest());
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("release_capability_closed");
    const receipt = recordedReceipt();
    expect(receipt.code).toBe("release_capability_closed");
    expect(receipt.message).toBe(
      "Live Meta writes are not open in this environment.",
    );
    // The sharp edge the frozen list guards: whatever the code becomes, the
    // callers that halt a multi-entity sequence on it must still recognise it.
    expect(isMetaWriteBlockedCode(receipt.code)).toBe(true);
  });

  it("still calls the kill switch a kill switch", async () => {
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
      posture({
        blocked: true,
        rehearsal: true,
        reason: "business_kill_switch",
        message: "Meta writes are disabled by kill switch.",
      }),
    );

    const response = await handleMetaLaunchAction(launchRequest());
    const body = (await response.json()) as { error: { code: string } };

    expect(body.error.code).toBe("kill_switch_engaged");
    expect(recordedReceipt().code).toBe("kill_switch_engaged");
  });

  it("names the posture on add-to-existing too", async () => {
    // The same block, in the other create family: one hard-coded receipt each.
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
      posture({
        blocked: true,
        rehearsal: true,
        reason: "readiness_tier_read_only",
        message: "This business is parked in the read-only readiness tier.",
      }),
    );

    const response = await handleMetaAddToExistingAction(addToExistingRequest());
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("readiness_tier_read_only");
    expect(recordedReceipt().code).toBe("readiness_tier_read_only");
  });

  it("refuses add-to-existing rehearsal with the guardrail it returns", async () => {
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
      posture({ rehearsal: true }),
    );

    const response = await handleMetaAddToExistingAction(addToExistingRequest());
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("dry_run_guardrail");
    expect(recordedReceipt().code).toBe("dry_run_guardrail");
  });
});
