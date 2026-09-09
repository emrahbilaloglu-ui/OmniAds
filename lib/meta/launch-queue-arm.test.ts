/**
 * The Automation queue can finally execute the two Launchpad families.
 *
 * A `launch` row has been raisable for a while and was refused by the executor
 * with `unsupported_action`, which the approval boundary settles as `failed` —
 * so approving one destroyed the row and created nothing. An activation row is
 * worse than refused: `resume` is an ordinary verb, so without the lineage
 * branch it would have gone to the entity handler, which resumes one entity and
 * knows nothing about the campaign above it.
 *
 * These cases pin what the two branches forward, where they get it from, and
 * the one thing the row is never allowed to supply: the payload. The operator's
 * `executionAuthority` is inside the intent fingerprint, so a queue dispatch
 * that recomposed the payload to describe itself would be refused by the intent
 * service as `launch_intent_contract_mismatch`.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  normalizeMetaAddToExistingPayload,
  normalizeMetaLaunchPayload,
} from "@/lib/launchpad/meta";
import {
  META_LAUNCHPAD_MANUAL_AUTHORITY,
  bindMetaLaunchpadManualAuthorityToPayload,
} from "@/lib/launchpad/meta-manual-authority";
import { metaLaunchIntentRequestFingerprint } from "@/lib/launchpad/meta-launch-intent";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";

vi.mock("@/lib/meta/entity-action-routes", () => ({
  handleMetaEntityPauseAction: vi.fn(),
  handleMetaEntityResumeAction: vi.fn(),
  handleMetaAdsetBidAction: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-launch-route-handlers", () => ({
  handleMetaLaunchAction: vi.fn(),
  handleMetaAddToExistingAction: vi.fn(),
}));
vi.mock("@/lib/meta/launch-activation-route-handlers", () => ({
  handleMetaLaunchIntentActivateAction: vi.fn(),
}));

const entityRoutes = await import("@/lib/meta/entity-action-routes");
const launchHandlers = await import("@/lib/launchpad/meta-launch-route-handlers");
const activationHandlers = await import(
  "@/lib/meta/launch-activation-route-handlers"
);
const { executeMetaAutomationProposal } = await import(
  "@/lib/meta/automation-proposal-execution"
);
type MetaAutomationProposal =
  import("@/lib/meta/automation-proposals").MetaAutomationProposal;

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ACCOUNT_ID = "act_9001";

const RAW_LAUNCH_PAYLOAD = {
  campaign: { name: "Winter prospecting", specialAdCategories: [] },
  budget: { mode: "CBO", amountMinor: 250000, currency: "TRY" },
  creativeIds: ["cr_1"],
  creatives: [{ creativeId: "cr_1", name: "Hero 9x16" }],
  adSets: [
    {
      clientId: "adset-1",
      name: "Broad 18-45",
      pixelId: "px_1",
      targeting: { countries: ["TR"] },
    },
  ],
};

const RAW_ADD_TO_EXISTING_PAYLOAD = {
  mode: "add_to_existing",
  targetCampaignId: "23847",
  targetAdsetId: "23848",
  copyMode: "reuse_creative",
  targets: [{ targetCampaignId: "23847", targetAdsetId: "23848" }],
  creativeIds: ["cr_7"],
  creatives: [{ creativeId: "cr_7", sourceAdId: "ad_7", name: "Winner" }],
  names: { cr_7: "Winner — copy" },
};

function storedLaunchPayload() {
  return bindMetaLaunchpadManualAuthorityToPayload(
    normalizeMetaLaunchPayload(RAW_LAUNCH_PAYLOAD),
    META_LAUNCHPAD_MANUAL_AUTHORITY,
  ) as unknown as Record<string, unknown>;
}

function storedAddToExistingPayload() {
  return bindMetaLaunchpadManualAuthorityToPayload(
    normalizeMetaAddToExistingPayload(RAW_ADD_TO_EXISTING_PAYLOAD),
    META_LAUNCHPAD_MANUAL_AUTHORITY,
  ) as unknown as Record<string, unknown>;
}

function intent(
  operation: MetaLaunchIntent["operation"],
): MetaLaunchIntent {
  const requestPayload =
    operation === "add_to_existing"
      ? storedAddToExistingPayload()
      : storedLaunchPayload();
  return {
    id: INTENT_ID,
    businessId: BUSINESS_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    operation,
    idempotencyKey: "idem-7f3c",
    requestedStatus: "PAUSED",
    lineage: {
      sourceDecisionId: null,
      sourceDecisionSnapshotId: null,
      creativeBriefId: null,
      sourceDraftId: null,
    },
    requestPayload,
    requestFingerprint: metaLaunchIntentRequestFingerprint({
      operation,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      requestPayload,
    }),
    status: "prepared",
    validationReceipt: null,
    resultReceipt: null,
    errorReceipt: null,
    activationApproval: null,
    activationReceipt: null,
    createdBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
}

function proposal(
  overrides: Partial<MetaAutomationProposal> = {},
): MetaAutomationProposal {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    businessId: BUSINESS_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    /*
      The value the producer actually writes (`launch-proposal-producer.ts`),
      carried past the union with the same cast `mapProposalRow` already
      performs: `META_AUTOMATION_PROPOSAL_ORIGINS` still lists only the two
      engine origins. The fixture states the row the database holds, not the
      row the type currently admits.
    */
    origin: "operator_action" as MetaAutomationProposal["origin"],
    ruleId: null,
    dedupeKey: null,
    decisionKey: `launch:${INTENT_ID}`,
    scopeType: "campaign",
    scopeId: INTENT_ID,
    recId: null,
    recType: null,
    snapshotDate: "2026-09-05",
    engineVersion: null,
    decisionLabel: null,
    proposedAction: "launch",
    actionLabel: "Launch campaign",
    primaryCaption: "Approve & launch",
    entityLabel: "Winter prospecting",
    reason: "A prepared launch is waiting for an operator.",
    evidenceLabel: null,
    evidenceRef: {},
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    receipt: null,
    bidEnvelope: null,
    budgetEnvelope: null,
    launchIntentId: INTENT_ID,
    claimToken: "claim-1",
    claimedBy: "user_1",
    claimedAt: new Date().toISOString(),
    dispatchStartedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function operatorRequest() {
  return new NextRequest(
    `http://localhost/api/meta/automation/proposals?businessId=${BUSINESS_ID}`,
    { method: "POST", headers: { cookie: "adsecute_session=token-abc" } },
  );
}

function okAnswer(body: Record<string, unknown>) {
  return NextResponse.json({ ok: true, ...body }, { status: 200 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("an approved launch row reaches the guarded Launchpad handler", () => {
  it("forwards a new_campaign intent with the intent's own key and payload", async () => {
    vi.mocked(launchHandlers.handleMetaLaunchAction).mockResolvedValue(
      okAnswer({ campaignId: "23999", adsetIds: ["24000"], adIds: ["24001"] }),
    );

    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
      receiptKey: "claim-1",
      launchIntent: async () => intent("new_campaign"),
    });

    expect(result.ok).toBe(true);
    expect(result.receipt.withheld).toBeNull();
    expect(result.receipt.endpoint).toBe("/api/launchpad/meta/launch");
    expect(launchHandlers.handleMetaAddToExistingAction).not.toHaveBeenCalled();

    const [forwarded] = vi.mocked(launchHandlers.handleMetaLaunchAction).mock
      .calls[0]!;
    const body = (await forwarded.json()) as Record<string, unknown>;
    expect(forwarded.headers.get("cookie")).toBe("adsecute_session=token-abc");
    expect(body.actionOrigin).toBe("launchpad_manual_v1");
    expect(body.manualConfirmation).toBe("explicit_operator_confirmation");
    expect(body.idempotencyKey).toBe("idem-7f3c");
    expect(body.launchIntentId).toBe(INTENT_ID);
    expect(body.providerAccountId).toBe(PROVIDER_ACCOUNT_ID);
    expect(body.payload).toEqual(storedLaunchPayload());
  });

  it("re-derives the intent's stored fingerprint from the forwarded body", async () => {
    // The whole point of replaying rather than recomposing. If the executor
    // added a single field of its own, `prepareMetaLaunchIntentForExecution`
    // would answer `launch_intent_contract_mismatch` and nothing would run.
    vi.mocked(launchHandlers.handleMetaLaunchAction).mockResolvedValue(
      okAnswer({}),
    );
    const stored = intent("new_campaign");

    await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
      receiptKey: "claim-1",
      launchIntent: async () => stored,
    });

    const [forwarded] = vi.mocked(launchHandlers.handleMetaLaunchAction).mock
      .calls[0]!;
    const body = (await forwarded.json()) as { payload: unknown };
    // Exactly what the handler does with the body before it prepares the intent.
    const rederived = metaLaunchIntentRequestFingerprint({
      operation: "new_campaign",
      providerAccountId: PROVIDER_ACCOUNT_ID,
      requestPayload: bindMetaLaunchpadManualAuthorityToPayload(
        normalizeMetaLaunchPayload(body.payload),
        META_LAUNCHPAD_MANUAL_AUTHORITY,
      ),
    });

    expect(rederived).toBe(stored.requestFingerprint);
  });

  it("sends an add_to_existing intent to the duplicate route, from the intent", async () => {
    // The row says `launch` either way; only the intent knows which create it
    // is. A row that could pick the route could create a campaign for an intent
    // that was only ever meant to add an ad to an existing ad set.
    vi.mocked(launchHandlers.handleMetaAddToExistingAction).mockResolvedValue(
      okAnswer({ adIds: ["24100"] }),
    );
    const stored = intent("add_to_existing");

    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal({ scopeType: "ad", scopeId: "ad_7" }),
      dryRunOnly: false,
      receiptKey: "claim-1",
      launchIntent: async () => stored,
    });

    expect(result.receipt.endpoint).toBe("/api/launchpad/meta/add-to-existing");
    expect(launchHandlers.handleMetaLaunchAction).not.toHaveBeenCalled();

    const [forwarded] = vi.mocked(
      launchHandlers.handleMetaAddToExistingAction,
    ).mock.calls[0]!;
    const body = (await forwarded.json()) as Record<string, unknown>;
    const rederived = metaLaunchIntentRequestFingerprint({
      operation: "add_to_existing",
      providerAccountId: PROVIDER_ACCOUNT_ID,
      requestPayload: bindMetaLaunchpadManualAuthorityToPayload(
        normalizeMetaAddToExistingPayload({
          mode: "add_to_existing",
          targetCampaignId: body.targetCampaignId,
          targetAdsetId: body.targetAdsetId,
          copyMode: body.copyMode,
          targets: body.targets,
          creativeIds: body.creativeIds,
          creatives: body.creatives,
          names: body.names,
          sourceAdIds: {},
        }),
        META_LAUNCHPAD_MANUAL_AUTHORITY,
      ),
    });

    expect(rederived).toBe(stored.requestFingerprint);
  });

  it("withholds a launch row whose lineage is missing and reaches no handler", async () => {
    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal({ launchIntentId: null }),
      dryRunOnly: false,
      receiptKey: "claim-1",
      launchIntent: async () => intent("new_campaign"),
    });

    expect(result.ok).toBe(false);
    expect(result.receipt.withheld).toBe("launch_intent_absent");
    expect(result.receipt.endpoint).toBeNull();
    expect(launchHandlers.handleMetaLaunchAction).not.toHaveBeenCalled();
  });

  it("withholds rather than pretending when the guardrail says dry run", async () => {
    // A create has no rehearsal. Dispatching under `dryRunOnly` would make the
    // guardrail above the queue decorative for the most expensive family.
    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: true,
      receiptKey: "claim-1",
      launchIntent: async () => intent("new_campaign"),
    });

    expect(result.receipt.withheld).toBe("dry_run_guardrail");
    expect(launchHandlers.handleMetaLaunchAction).not.toHaveBeenCalled();
  });

  it("no longer answers unsupported_action", async () => {
    vi.mocked(launchHandlers.handleMetaLaunchAction).mockResolvedValue(
      okAnswer({}),
    );

    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
      receiptKey: "claim-1",
      launchIntent: async () => intent("new_campaign"),
    });

    expect(result.receipt.withheld).not.toBe("unsupported_action");
  });
});

describe("the dispatch marker fires at the handler's own boundary", () => {
  it("hands the marker to the handler instead of stamping it first", async () => {
    // The defect this closes: the boundary stamped `dispatch_started_at` before
    // the executor ran, and the executor then refused without contacting Meta.
    let markedBeforeHandler = false;
    let markedDuringHandler = false;
    vi.mocked(launchHandlers.handleMetaLaunchAction).mockImplementation(
      async (_request, options) => {
        markedBeforeHandler = markedDuringHandler;
        await options?.beforeProviderMutation?.();
        return okAnswer({});
      },
    );

    await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
      receiptKey: "claim-1",
      launchIntent: async () => intent("new_campaign"),
      markDispatchStarted: async () => {
        markedDuringHandler = true;
        return true;
      },
    });

    expect(markedBeforeHandler).toBe(false);
    expect(markedDuringHandler).toBe(true);
  });

  it("preserves the launch handler's exact non-attempt after a marker was written", async () => {
    vi.mocked(launchHandlers.handleMetaLaunchAction).mockImplementationOnce(
      async (_request, options) => {
        expect(await options?.beforeProviderMutation?.()).toBe(true);
        return NextResponse.json(
          {
            ok: false,
            error: { code: "provider_mutation_withheld" },
            providerMutationAttempted: false,
          },
          { status: 409 },
        );
      },
    );

    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal(),
      dryRunOnly: false,
      receiptKey: "claim-1",
      launchIntent: async () => intent("new_campaign"),
      markDispatchStarted: async () => true,
    });

    expect(result.receipt.providerMutationAttempted).toBe(false);
  });
});

describe("an activation resume is not an entity resume", () => {
  it("forwards a lineage-carrying resume to the activation handler", async () => {
    vi.mocked(
      activationHandlers.handleMetaLaunchIntentActivateAction,
    ).mockResolvedValue(okAnswer({ delivering: true }));

    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal({
        proposedAction: "resume",
        scopeType: "campaign",
        scopeId: "23999",
        decisionKey: `activate:${INTENT_ID}`,
      }),
      dryRunOnly: false,
      receiptKey: "claim-1",
    });

    expect(result.ok).toBe(true);
    expect(result.receipt.endpoint).toBe(
      `/api/launchpad/meta/intents/${INTENT_ID}/activate`,
    );
    // The entity handler resumes one entity and knows nothing about the
    // campaign above it. It must never see an activation row.
    expect(entityRoutes.handleMetaEntityResumeAction).not.toHaveBeenCalled();

    const [forwarded, context] = vi.mocked(
      activationHandlers.handleMetaLaunchIntentActivateAction,
    ).mock.calls[0]!;
    expect(await context.params).toEqual({ id: INTENT_ID });
    const body = (await forwarded.json()) as Record<string, unknown>;
    expect(body.actionOrigin).toBe("manual_operator_v1");
    expect(body.manualConfirmation).toBe("explicit_operator_confirmation");
  });

  it("leaves a resume without lineage on the entity path", async () => {
    vi.mocked(entityRoutes.handleMetaEntityResumeAction).mockResolvedValue(
      okAnswer({}),
    );

    await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal({
        proposedAction: "resume",
        scopeType: "adset",
        scopeId: "23848",
        launchIntentId: null,
        decisionKey: "adset:23848",
      }),
      dryRunOnly: false,
      receiptKey: "claim-1",
    });

    expect(entityRoutes.handleMetaEntityResumeAction).toHaveBeenCalledTimes(1);
    expect(
      activationHandlers.handleMetaLaunchIntentActivateAction,
    ).not.toHaveBeenCalled();
  });

  it("preserves the activation handler's exact non-attempt", async () => {
    vi.mocked(
      activationHandlers.handleMetaLaunchIntentActivateAction,
    ).mockResolvedValueOnce(
      NextResponse.json(
        {
          ok: true,
          delivering: false,
          providerMutationAttempted: false,
        },
        { status: 200 },
      ),
    );

    const result = await executeMetaAutomationProposal({
      request: operatorRequest(),
      businessId: BUSINESS_ID,
      proposal: proposal({
        proposedAction: "resume",
        scopeType: "campaign",
        scopeId: "23999",
        decisionKey: `activate:${INTENT_ID}`,
      }),
      dryRunOnly: false,
      receiptKey: "claim-1",
    });

    expect(result.receipt.providerMutationAttempted).toBe(false);
  });
});
