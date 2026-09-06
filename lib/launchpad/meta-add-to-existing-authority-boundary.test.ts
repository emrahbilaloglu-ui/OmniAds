/**
 * Add-to-existing asks its authority again before every duplicate, from inside
 * the write primitive.
 *
 * This is the same hole R3 names for the new-campaign sequence, in the other
 * multi-create path: `runMetaAddToExistingCreate` fired the caller's pre-POST
 * boundary once and then walked a target × creative matrix, so one answer
 * covered every duplicate in it.
 *
 * The check now goes in as `duplicateAd`'s own `beforeMutationAttempt`, which
 * the primitive runs after its account, kill-switch, source-identity and policy
 * checks and immediately before the create POST — the only place a re-read can
 * still prevent a write rather than describe it. So this drives the real
 * scheduled runtime, the real `runMetaAddToExistingCreate` and the real
 * `duplicateAd` against a provider double at `fetch`, and counts POSTs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/automation-write-guard", () => ({
  readMetaWritePosture: vi.fn(),
}));
vi.mock("@/lib/meta/release-gates", () => ({
  readMetaReleaseGates: vi.fn(),
}));
vi.mock("@/lib/meta/write-safety-contract", () => ({
  missingSteps: vi.fn(() => []),
  writeFamily: vi.fn((id: string) => ({ id })),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-service", () => ({
  prepareMetaLaunchIntentForExecution: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  getMetaLaunchIntent: vi.fn(),
  markMetaLaunchIntentExecuting: vi.fn(async () => ({ status: "executing" })),
  recordMetaLaunchIntentOutcome: vi.fn(),
  recordMetaLaunchIntentPreExecutionFailure: vi.fn(async () => null),
  recordMetaLaunchIntentValidation: vi.fn(async () => null),
  recordMetaLaunchIntentWriteBlocked: vi.fn(async () => null),
}));
vi.mock("@/lib/meta/ads-action-log", () => ({
  createMetaAdsActionLog: vi.fn(),
  completeMetaAdsActionLog: vi.fn(async () => null),
  hasRecentPendingMetaLaunchAction: vi.fn(async () => false),
  hasRecentPendingMetaAddToExistingAction: vi.fn(async () => false),
}));
vi.mock("@/lib/launchpad/meta-validation", () => ({
  resolveMetaLaunchWriteContext: vi.fn(),
  validateMetaLaunchRequest: vi.fn(),
  validateMetaAddToExistingRequest: vi.fn(),
  validateMetaAddToExistingLiveProviderPreflight: vi.fn(),
}));
/*
  `duplicateAd` reads its hard block and its atomic credential/selection
  snapshot from the database through these three, and calls them internally —
  not across the `ads-write` module boundary — so they are what has to be stood
  in for. The primitive itself, its single-POST rule and its read-back
  verification all run for real below.
*/
vi.mock("@/lib/meta/automation-control-plane", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/meta/automation-control-plane")>()),
  getMetaWriteBlockState: vi.fn(async () => ({
    blocked: false, reason: null, message: null, guardRule: null,
  })),
}));
vi.mock("@/lib/provider-write-authority", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/provider-write-authority")>()),
  assertProviderWriteAuthorityUnchanged: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/meta/account-context", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/meta/account-context")>()),
  resolveMetaAccountAuthority: vi.fn(async () => ({ state: "authorized" })),
}));

import * as actionLog from "@/lib/meta/ads-action-log";
import * as intentService from "@/lib/launchpad/meta-launch-intent-service";
import * as intentStore from "@/lib/launchpad/meta-launch-intent-store";
import * as releaseGates from "@/lib/meta/release-gates";
import * as validation from "@/lib/launchpad/meta-validation";
import * as writeGuard from "@/lib/meta/automation-write-guard";
import { metaLaunchIntentRequestFingerprint } from "@/lib/launchpad/meta-launch-intent";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import { createScheduledLaunchRuntime } from "@/lib/meta/scheduled-launch-runtime";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const INTENT = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "act_9";
const VERSION = "activation-v4";
const CREATIVE = "creative_1";
const SOURCE_AD = "source_ad_1";
const TARGETS = [
  { targetCampaignId: "camp_1", targetAdsetId: "adset_1" },
  { targetCampaignId: "camp_1", targetAdsetId: "adset_2" },
];
const NEW_AD_IDS = ["new_ad_1", "new_ad_2"];

const PAYLOAD = {
  mode: "add_to_existing",
  copyMode: "reuse_creative",
  targets: TARGETS,
  creativeIds: [CREATIVE],
  creatives: [{ creativeId: CREATIVE, sourceAdId: SOURCE_AD, name: "Source" }],
  executionAuthority: {
    actionOrigin: "launchpad_manual_v1",
    manualConfirmation: "explicit_operator_confirmation",
  },
} as const;

function intent(): MetaLaunchIntent {
  const requestPayload = PAYLOAD as unknown as Record<string, unknown>;
  return {
    id: INTENT,
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    operation: "add_to_existing",
    idempotencyKey: "idem-2",
    requestedStatus: "PAUSED",
    lineage: {
      sourceDecisionId: "dec-1",
      sourceDecisionSnapshotId: null,
      creativeBriefId: null,
      sourceDraftId: null,
    },
    requestPayload,
    requestFingerprint: metaLaunchIntentRequestFingerprint({
      operation: "add_to_existing",
      providerAccountId: ACCOUNT,
      requestPayload,
    }),
    status: "prepared",
    validationReceipt: null,
    resultReceipt: null,
    errorReceipt: null,
    activationApproval: null,
    activationReceipt: null,
    createdBy: ACTOR,
    createdAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T08:00:00.000Z",
    startedAt: null,
    completedAt: null,
  } as MetaLaunchIntent;
}

function proposal(): MetaAutomationProposal {
  return {
    id: "p-launch-2",
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    scopeType: "campaign",
    scopeId: INTENT,
    proposedAction: "launch",
    launchIntentId: INTENT,
    entityLabel: "Add winner to two ad sets",
  } as unknown as MetaAutomationProposal;
}

type ProviderCall = { method: string; path: string };

function providerDouble(onPost: () => void) {
  const calls: ProviderCall[] = [];
  const adsetForAd = new Map<string, string>();
  let adCursor = 0;
  const respond = (payload: Record<string, unknown>) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return {
    calls,
    fetch: vi.fn(async (input: string, init?: { method?: string; body?: BodyInit }) => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/v\d+(\.\d+)?\//, "");
      const method = init?.method ?? "GET";
      calls.push({ method, path });
      if (method === "POST") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        const id = NEW_AD_IDS[adCursor] ?? `unexpected-ad-${adCursor}`;
        adCursor += 1;
        adsetForAd.set(id, body.get("adset_id") ?? "");
        onPost();
        return respond({ id });
      }
      if (path === SOURCE_AD) {
        return respond({
          id: SOURCE_AD,
          name: "Source",
          account_id: "9",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          creative: { id: CREATIVE },
          adset_id: "adset_0",
        });
      }
      if (NEW_AD_IDS.includes(path)) {
        return respond({
          id: path,
          name: "Source",
          account_id: "9",
          status: "PAUSED",
          effective_status: "PAUSED",
          adset_id: adsetForAd.get(path) ?? "",
          creative: { id: CREATIVE },
        });
      }
      throw new Error(`unexpected provider GET: ${path}`);
    }),
  };
}

function posts(calls: ProviderCall[]) {
  return calls.filter((call) => call.method === "POST");
}

let logSequence = 0;

beforeEach(() => {
  vi.clearAllMocks();
  logSequence = 0;
  vi.mocked(actionLog.createMetaAdsActionLog).mockImplementation((async () => {
    logSequence += 1;
    return { id: `log-${logSequence}` };
  }) as never);
  vi.mocked(actionLog.hasRecentPendingMetaAddToExistingAction).mockResolvedValue(false);
  vi.mocked(intentStore.markMetaLaunchIntentExecuting).mockResolvedValue({
    status: "executing",
  } as never);
  vi.mocked(intentStore.recordMetaLaunchIntentOutcome).mockImplementation((async (
    input: { status: string },
  ) => ({ status: input.status })) as never);
  vi.mocked(intentService.prepareMetaLaunchIntentForExecution).mockResolvedValue({
    ok: true,
    intent: intent(),
  } as never);
  vi.mocked(validation.resolveMetaLaunchWriteContext).mockResolvedValue({
    ok: true,
    ctx: {
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      accessToken: "token",
      connectionGeneration: "7:active",
    },
  } as never);
  vi.mocked(validation.validateMetaAddToExistingRequest).mockResolvedValue({
    ok: true,
    payload: {
      mode: "add_to_existing",
      copyMode: "reuse_creative",
      targetCampaignId: TARGETS[0]!.targetCampaignId,
      targetAdsetId: TARGETS[0]!.targetAdsetId,
      targets: TARGETS,
      creativeIds: [CREATIVE],
      creatives: [{ creativeId: CREATIVE, sourceAdId: SOURCE_AD, name: "Source" }],
      names: {},
    },
    targets: TARGETS.map((target) => ({ ...target, adsetName: target.targetAdsetId })),
    creatives: [{ creativeId: CREATIVE, sourceAdId: SOURCE_AD, creativeName: "Source" }],
    blockers: [],
    warnings: [],
  } as never);
  vi.mocked(validation.validateMetaAddToExistingLiveProviderPreflight)
    .mockResolvedValue({ ok: true, blockers: [], checks: [] } as never);
  vi.mocked(releaseGates.readMetaReleaseGates).mockReturnValue({
    automationLiveWrites: true, launchpadExecution: true, decisionWorkflowUi: true,
  } as never);
});

async function runAddToExisting(afterEachPost: (state: {
  mode: { value: "manual" | "semi_auto" | "auto" };
  posted: number;
}) => void) {
  const mode = { value: "auto" as "manual" | "semi_auto" | "auto" };
  let posted = 0;
  const provider = providerDouble(() => {
    posted += 1;
    afterEachPost({ mode, posted });
  });
  vi.stubGlobal("fetch", provider.fetch);
  vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue({
    blocked: false, rehearsal: false, reason: null, message: null,
  } as never);

  const run = createScheduledLaunchRuntime({
    readGates: async () => ({
      releaseGateOpen: true,
      autoExecutionEnabled: true,
      enabledProviderAccountId: ACCOUNT,
      enablingActorUserId: ACTOR,
      activationControlVersion: VERSION,
      dryRunOnly: false,
    }),
    readMode: async () => mode.value,
    readIntent: async () => intent(),
  });
  const result = await run({
    proposal: proposal(),
    dryRunOnly: false,
    claimToken: "claim-2",
    authorization: {
      kind: "scheduled",
      expectedEnablingActorUserId: ACTOR,
      expectedActivationControlVersion: VERSION,
    },
    beforeProviderPost: async () => true,
  });
  vi.unstubAllGlobals();
  return { result, provider };
}

function persistedOutcome() {
  const calls = vi.mocked(intentStore.recordMetaLaunchIntentOutcome).mock.calls;
  return calls[calls.length - 1]?.[0] as unknown as {
    status: string;
    resultReceipt: Record<string, unknown> | null;
    errorReceipt: Record<string, unknown> | null;
  } | undefined;
}

describe("both duplicates run while the creative family stays on auto", () => {
  it("creates one ad in each target ad set", async () => {
    const { result, provider } = await runAddToExisting(() => undefined);

    expect(posts(provider.calls)).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.receipt.response).toMatchObject({
      adIds: NEW_AD_IDS,
      failedCount: 0,
      successCount: 2,
    });
  });
});

describe("a gate that closes after the first duplicate withholds the second", () => {
  it("never POSTs the second ad and keeps the first ad's identity", async () => {
    const { result, provider } = await runAddToExisting(({ mode, posted }) => {
      if (posted === 1) mode.value = "manual";
    });

    // One create POST, not two. The second was refused inside `duplicateAd`,
    // after its own checks and before its request.
    expect(posts(provider.calls)).toHaveLength(1);

    const body = result.receipt.response as Record<string, unknown>;
    expect(body.adIds).toEqual([NEW_AD_IDS[0]]);
    expect(body.successCount).toBe(1);
    expect(body.failedCount).toBe(1);
    expect(body.halted).toBe(true);
    expect(body.haltedReason).toMatchObject({
      code: "provider_mutation_withheld",
    });
    expect(String((body.haltedReason as { message: string }).message))
      .toContain("mode_not_auto");
    expect(result.ok).toBe(false);
    // Nothing is unknown here, so the row is not parked for reconciliation.
    expect(result.reconcile).toBe(false);

    const persisted = persistedOutcome();
    expect(persisted?.status).toBe("partially_succeeded");
    expect(persisted?.resultReceipt).toMatchObject({ adIds: [NEW_AD_IDS[0]] });
    expect(persisted?.errorReceipt).toMatchObject({
      code: "provider_mutation_withheld",
    });
  });
});
