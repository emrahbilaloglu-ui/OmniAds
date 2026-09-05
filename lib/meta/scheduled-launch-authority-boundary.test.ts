/**
 * A scheduled create asks its authority again before EVERY provider POST.
 *
 * It used to ask once. `createScheduledLaunchRuntime` built a late gate/posture
 * re-read and `runMetaLaunchIntentCreate` fired it a single time, before the
 * whole sequence — so the campaign's answer was reused for the ad set and the
 * ad below it. A campaign could be created, the operator could take the
 * creative family off `auto`, engage the STOP, put the business into rehearsal
 * or shut the Launchpad gate, and the rest of the launch was still built.
 *
 * These cases drive the real chain — the scheduled runtime, its create tail,
 * `runMetaLaunchIntentCreate`, and the real `createCampaign` / `createAdSet` /
 * `createAd` primitives — against a provider double at `fetch`. Nothing here
 * mints the payload the production code should have produced: every provider
 * request counted below was composed and sent by the shipped primitives.
 *
 * The four gates are changed one at a time, each after a create the provider
 * double has already answered, and the assertion is always the same three
 * things: no further provider POST, the identities that DO exist reported and
 * persisted, and the closed gate named in the durable receipt.
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
  The one adapter-side check the primitives make that needs a database: the
  hard block and the atomic credential/selection snapshot. Everything else in
  `launch-write.ts` — the request bodies, the single-POST rule, the read-back
  verification — runs for real against the provider double below.
*/
vi.mock("@/lib/meta/ads-write", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/meta/ads-write")>()),
  getMetaAdsWriteBlockFailure: vi.fn(async () => null),
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
import type { ScheduledAuthorityGates } from "@/lib/meta/scheduled-action-execution";
import { createScheduledLaunchRuntime } from "@/lib/meta/scheduled-launch-runtime";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const OTHER_ACTOR = "44444444-4444-4444-8444-444444444444";
const INTENT = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "act_9";
const VERSION = "activation-v4";
const CREATIVE_A = "23851000000077";
const CREATIVE_B = "23851000000078";

const CAMPAIGN_ID = "120";
const ADSET_IDS = ["121", "131"];
const AD_IDS = ["122", "123", "132", "133"];

/** The payload the operator staged, with two ad sets and two creatives. */
const PAYLOAD = {
  mode: "new_campaign",
  campaign: {
    name: "September test — broad",
    objective: "OUTCOME_SALES",
    specialAdCategories: [],
  },
  budget: { mode: "CBO", schedule: "daily", amountMinor: 50000 },
  creativeIds: [CREATIVE_A, CREATIVE_B],
  creatives: [{ creativeId: CREATIVE_A }, { creativeId: CREATIVE_B }],
  adSets: [adSet("Broad"), adSet("Lookalike")],
  executionAuthority: {
    actionOrigin: "launchpad_manual_v1",
    manualConfirmation: "explicit_operator_confirmation",
  },
} as const;

function adSet(name: string) {
  return {
    clientId: name.toLowerCase(),
    name,
    optimizationGoal: "OFFSITE_CONVERSIONS",
    pixelId: "999",
    customEventType: "PURCHASE",
    targeting: {
      countries: ["TR"],
      ageMin: 18,
      ageMax: 65,
      advantageAudience: true,
      advantagePlacements: true,
    },
    attributionSpec: [{ eventType: "CLICK_THROUGH", windowDays: 7 }],
  } as const;
}

function intent(): MetaLaunchIntent {
  const requestPayload = PAYLOAD as unknown as Record<string, unknown>;
  return {
    id: INTENT,
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    operation: "new_campaign",
    idempotencyKey: "idem-1",
    requestedStatus: "PAUSED",
    lineage: {
      sourceDecisionId: "dec-1",
      sourceDecisionSnapshotId: null,
      creativeBriefId: null,
      sourceDraftId: null,
    },
    requestPayload,
    requestFingerprint: metaLaunchIntentRequestFingerprint({
      operation: "new_campaign",
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
    id: "p-launch-1",
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    scopeType: "campaign",
    scopeId: INTENT,
    proposedAction: "launch",
    launchIntentId: INTENT,
    entityLabel: "September test — broad",
  } as unknown as MetaAutomationProposal;
}

/** Everything an operator can change while a create is in flight. */
type Controls = {
  mode: "manual" | "semi_auto" | "auto";
  gates: ScheduledAuthorityGates;
  rehearsal: boolean;
  blocked: boolean;
  launchpadExecution: boolean;
};

function controls(): Controls {
  return {
    mode: "auto",
    gates: {
      releaseGateOpen: true,
      autoExecutionEnabled: true,
      enabledProviderAccountId: ACCOUNT,
      enablingActorUserId: ACTOR,
      activationControlVersion: VERSION,
      dryRunOnly: false,
    },
    rehearsal: false,
    blocked: false,
    launchpadExecution: true,
  };
}

type ProviderCall = { method: string; path: string };

/**
 * The provider, as a double at `fetch`.
 *
 * It answers the real Graph shapes the primitives verify against — the create
 * response and then the read-back the primitive compares field by field — so a
 * create only "succeeds" here if the shipped verification agrees that it did.
 * `onPost` fires after each POST is answered, which is where a case changes the
 * control plane underneath the sequence.
 */
function providerDouble(onPost: (path: string) => void) {
  const calls: ProviderCall[] = [];
  const adsetForAd = new Map<string, string>();
  let adsetCursor = 0;
  let adCursor = 0;
  const respond = (payload: Record<string, unknown>) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return {
    calls,
    fetch: vi.fn(async (input: string, init?: { method?: string }) => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/v\d+(\.\d+)?\//, "");
      const method = init?.method ?? "GET";
      calls.push({ method, path });
      if (method === "POST") {
        if (path.endsWith("/campaigns")) {
          onPost(path);
          return respond({ id: CAMPAIGN_ID });
        }
        if (path.endsWith("/adsets")) {
          const id = ADSET_IDS[adsetCursor] ?? `unexpected-adset-${adsetCursor}`;
          adsetCursor += 1;
          onPost(path);
          return respond({ id });
        }
        if (path.endsWith("/ads")) {
          const id = AD_IDS[adCursor] ?? `unexpected-ad-${adCursor}`;
          adCursor += 1;
          adsetForAd.set(id, path.split("/")[0] ?? "");
          onPost(path);
          return respond({ id });
        }
        throw new Error(`unexpected provider POST: ${path}`);
      }
      if (path === CAMPAIGN_ID) {
        return respond({
          id: CAMPAIGN_ID,
          account_id: "9",
          status: "PAUSED",
          objective: "OUTCOME_SALES",
        });
      }
      if (ADSET_IDS.includes(path)) {
        return respond({
          id: path,
          account_id: "9",
          campaign_id: CAMPAIGN_ID,
          status: "PAUSED",
          optimization_goal: "OFFSITE_CONVERSIONS",
          promoted_object: { pixel_id: "999", custom_event_type: "PURCHASE" },
        });
      }
      if (AD_IDS.includes(path)) {
        const adsetId = adsetForAd.get(path) ?? "";
        const creativeId = AD_IDS.indexOf(path) % 2 === 0 ? CREATIVE_A : CREATIVE_B;
        return respond({
          id: path,
          account_id: "9",
          status: "PAUSED",
          adset_id: adsetId,
          creative: { id: creativeId },
        });
      }
      // The creative preflight read, which runs before any create.
      return respond({ id: path, account_id: "9" });
    }),
  };
}

function posts(calls: ProviderCall[]) {
  return calls.filter((call) => call.method === "POST").map((call) => call.path);
}

let logSequence = 0;

beforeEach(() => {
  vi.clearAllMocks();
  logSequence = 0;
  vi.mocked(actionLog.createMetaAdsActionLog).mockImplementation((async () => {
    logSequence += 1;
    return { id: `log-${logSequence}` };
  }) as never);
  vi.mocked(actionLog.hasRecentPendingMetaLaunchAction).mockResolvedValue(false);
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
  vi.mocked(validation.validateMetaLaunchRequest).mockResolvedValue({
    ok: true,
    payload: PAYLOAD,
    blockers: [],
    warnings: [],
  } as never);
});

/**
 * One scheduled launch, driven end to end.
 *
 * `change` runs after each provider POST the double answers; a case uses it to
 * close a gate at an exact point in the sequence.
 */
async function runLaunch(change: (input: {
  control: Controls;
  path: string;
  postIndex: number;
}) => void) {
  const control = controls();
  let postIndex = 0;
  const provider = providerDouble((path) => {
    change({ control, path, postIndex });
    postIndex += 1;
  });
  vi.stubGlobal("fetch", provider.fetch);
  vi.mocked(writeGuard.readMetaWritePosture).mockImplementation((async () => ({
    blocked: control.blocked,
    rehearsal: control.rehearsal,
    reason: control.blocked ? "business_kill_switch" : null,
    message: null,
  })) as never);
  vi.mocked(releaseGates.readMetaReleaseGates).mockImplementation((() => ({
    automationLiveWrites: true,
    launchpadExecution: control.launchpadExecution,
    decisionWorkflowUi: true,
  })) as never);

  const run = createScheduledLaunchRuntime({
    readGates: async () => control.gates,
    readMode: async () => control.mode,
    readIntent: async () => intent(),
  });
  const result = await run({
    proposal: proposal(),
    dryRunOnly: false,
    claimToken: "claim-1",
    authorization: {
      kind: "scheduled",
      expectedEnablingActorUserId: ACTOR,
      expectedActivationControlVersion: VERSION,
    },
    beforeProviderPost: async () => true,
  });
  vi.unstubAllGlobals();
  return { result, provider, control };
}

/** What `recordMetaLaunchIntentOutcome` was last asked to persist. */
function persistedOutcome() {
  const calls = vi.mocked(intentStore.recordMetaLaunchIntentOutcome).mock.calls;
  return calls[calls.length - 1]?.[0] as unknown as {
    status: string;
    resultReceipt: { partialResult?: never } & Record<string, unknown> | null;
    errorReceipt: Record<string, unknown> | null;
  } | undefined;
}

describe("the whole sequence runs while every gate stays open", () => {
  it("creates the campaign, both ad sets and all four ads", async () => {
    const { result, provider } = await runLaunch(() => undefined);

    expect(posts(provider.calls)).toEqual([
      "act_9/campaigns",
      "120/adsets",
      "121/ads",
      "121/ads",
      "120/adsets",
      "131/ads",
      "131/ads",
    ]);
    expect(result.ok).toBe(true);
    expect(result.receipt.withheld).toBeNull();
    expect(persistedOutcome()?.status).toBe("succeeded");
  });
});

describe("a gate that closes after the campaign withholds every remaining POST", () => {
  const cases: Array<{
    label: string;
    close: (control: Controls) => void;
    reason: string;
  }> = [
    {
      label: "the creative family is taken off auto",
      close: (control) => {
        control.mode = "manual";
      },
      reason: "mode_not_auto",
    },
    {
      label: "the account is re-activated under a different admin",
      close: (control) => {
        control.gates = { ...control.gates, enablingActorUserId: OTHER_ACTOR };
      },
      reason: "enabling_actor_absent",
    },
    {
      label: "the activation control version is superseded",
      close: (control) => {
        control.gates = {
          ...control.gates,
          activationControlVersion: "activation-v5",
        };
      },
      reason: "scheduled_authority_changed",
    },
    {
      label: "unattended execution is switched off",
      close: (control) => {
        control.gates = { ...control.gates, autoExecutionEnabled: false };
      },
      reason: "auto_execution_disabled",
    },
    {
      label: "the business is put into rehearsal",
      close: (control) => {
        control.rehearsal = true;
      },
      reason: "dry_run_guardrail",
    },
    {
      label: "the STOP is engaged",
      close: (control) => {
        control.blocked = true;
      },
      reason: "kill_switch_engaged",
    },
    {
      label: "the Launchpad gate is shut",
      close: (control) => {
        control.launchpadExecution = false;
      },
      reason: "launchpad_execution_gated",
    },
  ];

  it.each(cases)("$label", async ({ close, reason }) => {
    const { result, provider } = await runLaunch(({ control, postIndex }) => {
      if (postIndex === 0) close(control);
    });

    // The campaign was created and read back; nothing below it was asked for.
    expect(posts(provider.calls)).toEqual(["act_9/campaigns"]);

    // The identity that exists is reported, and so is the gate that closed.
    const body = result.receipt.response as Record<string, unknown>;
    expect(body.campaignId).toBe(CAMPAIGN_ID);
    expect(body.adsetIds).toEqual([]);
    expect(body.adIds).toEqual([]);
    expect(body.failedAt).toBe("adset:1");
    expect(body.withheldReason).toBe(reason);
    expect((body.error as { code: string }).code).toBe("provider_mutation_withheld");
    expect(result.ok).toBe(false);
    // Not a reconcile: the outcome of every POST that happened is known.
    expect(result.reconcile).toBe(false);

    // And the same two facts are what the intent durably keeps.
    const persisted = persistedOutcome();
    expect(persisted?.status).toBe("partially_succeeded");
    expect(persisted?.resultReceipt).toMatchObject({ campaignId: CAMPAIGN_ID });
    expect(persisted?.errorReceipt).toMatchObject({
      code: "provider_mutation_withheld",
      failedAt: "adset:1",
      partialResult: { campaignId: CAMPAIGN_ID, adsetIds: [], adIds: [] },
    });
    expect(String(persisted?.errorReceipt?.message)).toContain(reason);
  });
});

describe("the boundary binds at every grain, not only the first one under the campaign", () => {
  it("withholds the ads when the mode changes after the first ad set", async () => {
    const { result, provider } = await runLaunch(({ control, path }) => {
      if (path.endsWith("/adsets")) control.mode = "semi_auto";
    });

    expect(posts(provider.calls)).toEqual(["act_9/campaigns", "120/adsets"]);
    const body = result.receipt.response as Record<string, unknown>;
    expect(body.campaignId).toBe(CAMPAIGN_ID);
    expect(body.adsetIds).toEqual([ADSET_IDS[0]]);
    expect(body.failedAt).toBe("ad:1:1");
    expect(body.withheldReason).toBe("mode_not_auto");
    expect(persistedOutcome()?.errorReceipt).toMatchObject({
      partialResult: { campaignId: CAMPAIGN_ID, adsetIds: [ADSET_IDS[0]], adIds: [] },
    });
  });

  it("withholds the second ad set after the first ad set's ads are created", async () => {
    const { result, provider } = await runLaunch(({ control, path, postIndex }) => {
      // After the last ad of ad set 1 — campaign, adset, ad, ad.
      if (path.endsWith("/ads") && postIndex === 3) control.mode = "manual";
    });

    expect(posts(provider.calls)).toEqual([
      "act_9/campaigns",
      "120/adsets",
      "121/ads",
      "121/ads",
    ]);
    const body = result.receipt.response as Record<string, unknown>;
    expect(body.adsetIds).toEqual([ADSET_IDS[0]]);
    expect(body.adIds).toEqual([AD_IDS[0], AD_IDS[1]]);
    expect(body.failedAt).toBe("adset:2");
    expect(persistedOutcome()?.status).toBe("partially_succeeded");
  });
});

describe("a gate closed before the first POST leaves the intent untouched", () => {
  it("withholds the campaign itself and settles the row as refused", async () => {
    /*
      The pre-claim reads all pass and the gate closes in the window before the
      first create. Nothing was created, so the queue row is a refusal that
      names the gate rather than a partial launch.
    */
    const control = controls();
    const provider = providerDouble(() => undefined);
    vi.stubGlobal("fetch", provider.fetch);
    let modeReads = 0;
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue({
      blocked: false, rehearsal: false, reason: null, message: null,
    } as never);
    vi.mocked(releaseGates.readMetaReleaseGates).mockReturnValue({
      automationLiveWrites: true, launchpadExecution: true, decisionWorkflowUi: true,
    } as never);

    const run = createScheduledLaunchRuntime({
      readGates: async () => control.gates,
      readMode: async () => {
        modeReads += 1;
        // 1: the pre-claim read. 2: the boundary before `markExecuting`.
        // 3: the boundary immediately before the campaign POST.
        return modeReads >= 3 ? "manual" : "auto";
      },
      readIntent: async () => intent(),
    });
    const result = await run({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: {
        kind: "scheduled",
        expectedEnablingActorUserId: ACTOR,
        expectedActivationControlVersion: VERSION,
      },
      beforeProviderPost: async () => true,
    });
    vi.unstubAllGlobals();

    expect(posts(provider.calls)).toEqual([]);
    expect(result.receipt.withheld).toBe("mode_not_auto");
    expect(result.receipt.providerMutationAttempted).toBe(false);
  });
});
