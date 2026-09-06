/**
 * A staged approval withdrawn BETWEEN the staging and the provider POST.
 *
 * The producer stages an intent from a reviewed brief, the queue raises a row,
 * and the sweep replays the stored payload. Every check on that path compares
 * the intent to the request — account, operation, idempotency key, request
 * fingerprint, the four lineage ids — and every one of them still matches after
 * the brief those ids point at has been moved off `reviewed`, because the
 * intent stores the brief's ID and not its status.
 *
 * So the question has to be asked again, and these cases pin every place it is:
 *
 * - once when the sequence is prepared, which is where a withdrawal committed
 *   before the sweep is caught before anything is read or validated;
 * - once more immediately before the validation receipt is persisted, which is
 *   the last moment a refusal leaves the intent exactly as it was found —
 *   `recordMetaLaunchIntentValidation` takes it to `ready`, and `ready` is a
 *   state no caller may start a create from;
 * - and again at EVERY pre-POST boundary, which is the only place a withdrawal
 *   committed during an earlier create in the same sequence can still prevent
 *   a write rather than describe one — on the unattended arm and on the arm an
 *   operator approves a queue row through, which had the marker alone.
 *
 * What must not change is everything around it: an already-consumed intent and
 * an unresolved provider outcome still report themselves, an ambiguous outcome
 * still parks, and a refused authority is never reported as a provider contact.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/launchpad/meta-launch-intent-lineage", () => ({
  readMetaLaunchIntentApprovalStanding: vi.fn(async () => ({ stands: true })),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  getMetaLaunchIntent: vi.fn(),
  createMetaLaunchIntent: vi.fn(),
  markMetaLaunchIntentExecuting: vi.fn(),
  recordMetaLaunchIntentOutcome: vi.fn(),
  recordMetaLaunchIntentPreExecutionFailure: vi.fn(async () => null),
  recordMetaLaunchIntentValidation: vi.fn(async () => null),
  recordMetaLaunchIntentWriteBlocked: vi.fn(async () => null),
}));
vi.mock("@/lib/meta/automation-write-guard", () => ({
  readMetaWritePosture: vi.fn(async () => ({
    blocked: false, rehearsal: false, reason: null, message: null,
  })),
}));
vi.mock("@/lib/meta/release-gates", () => ({
  readMetaReleaseGates: vi.fn(() => ({
    automationLiveWrites: true,
    launchpadExecution: true,
    decisionWorkflowUi: true,
  })),
}));
vi.mock("@/lib/meta/write-safety-contract", () => ({
  missingSteps: vi.fn(() => []),
  writeFamily: vi.fn((id: string) => ({ id })),
}));
/*
  The manual arm's own tail. `executeMetaAutomationProposal` forwards an
  approved `launch` row to these two handlers and hands them the pre-POST
  boundary; standing in for them is how the boundary can be asked the way a
  three-POST create asks it, without a session, a database or a provider.
*/
vi.mock("@/lib/launchpad/meta-launch-route-handlers", () => ({
  handleMetaLaunchAction: vi.fn(),
  handleMetaAddToExistingAction: vi.fn(),
}));

import { NextRequest, NextResponse } from "next/server";

import { readMetaLaunchIntentApprovalStanding } from "@/lib/launchpad/meta-launch-intent-lineage";
import { handleMetaAddToExistingAction } from "@/lib/launchpad/meta-launch-route-handlers";
import type { MetaLaunchProviderMutationVerdict } from "@/lib/launchpad/meta-launch-execution";
import { executeMetaAutomationProposal } from "@/lib/meta/automation-proposal-execution";
import { getMetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent-store";
import { metaLaunchIntentRequestFingerprint } from "@/lib/launchpad/meta-launch-intent";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import { prepareMetaLaunchIntentForExecution } from "@/lib/launchpad/meta-launch-intent-service";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import type { ScheduledAuthorityGates } from "@/lib/meta/scheduled-action-execution";
import {
  createScheduledLaunchRuntime,
  type ScheduledLaunchCreateRequest,
} from "@/lib/meta/scheduled-launch-runtime";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const INTENT = "33333333-3333-4333-8333-333333333333";
const BRIEF = "44444444-4444-4444-8444-444444444444";
const DRAFT = "55555555-5555-4555-8555-555555555555";
const SNAPSHOT = "66666666-6666-4666-8666-666666666666";
const ACCOUNT = "act_9";
const VERSION = "activation-v4";

/** The producer's own staged payload: a decision approved it, no operator did. */
const PAYLOAD = {
  mode: "add_to_existing",
  targetCampaignId: "120",
  targetAdsetId: "121",
  copyMode: "reuse_creative",
  creativeIds: ["23851000000077"],
  executionAuthority: {
    actionOrigin: "launchpad_decision_staged_v1",
    manualConfirmation: "decision_staged_approval",
  },
} as const;

function intent(overrides: Partial<MetaLaunchIntent> = {}): MetaLaunchIntent {
  const requestPayload = (overrides.requestPayload ?? PAYLOAD) as Record<string, unknown>;
  const operation = overrides.operation ?? "add_to_existing";
  return {
    id: INTENT,
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    operation,
    idempotencyKey: "idem-1",
    requestedStatus: "PAUSED",
    lineage: {
      sourceDecisionId: "meta:decision:account:act_9:23851000000077",
      sourceDecisionSnapshotId: SNAPSHOT,
      creativeBriefId: BRIEF,
      sourceDraftId: DRAFT,
    },
    requestPayload,
    requestFingerprint: metaLaunchIntentRequestFingerprint({
      operation, providerAccountId: ACCOUNT, requestPayload,
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
    ...overrides,
  } as MetaLaunchIntent;
}

const WITHDRAWN = {
  stands: false as const,
  code: "creative_brief_not_reviewed" as const,
  message: "Creative Brief must be reviewed before it can become launch lineage.",
};

function prepareInput(overrides: Record<string, unknown> = {}) {
  return {
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    operation: "add_to_existing" as const,
    idempotencyKey: "idem-1",
    requestPayload: PAYLOAD as unknown as object,
    launchIntentId: INTENT,
    ...overrides,
  };
}

function proposal(): MetaAutomationProposal {
  return {
    id: "p-launch-1",
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    scopeType: "ad",
    scopeId: INTENT,
    proposedAction: "launch",
    launchIntentId: INTENT,
    entityLabel: "Broad · purchase",
  } as unknown as MetaAutomationProposal;
}

function gates(): ScheduledAuthorityGates {
  return {
    releaseGateOpen: true,
    autoExecutionEnabled: true,
    enabledProviderAccountId: ACCOUNT,
    enablingActorUserId: ACTOR,
    activationControlVersion: VERSION,
    dryRunOnly: false,
  };
}

const SCHEDULED = {
  kind: "scheduled",
  expectedEnablingActorUserId: ACTOR,
  expectedActivationControlVersion: VERSION,
} as const;

/**
 * The provider tail, as a seam that asks the boundary `posts` times.
 *
 * A create is three or more POSTs with read-backs and durable writes between
 * them, and the shipped tail asks the boundary before each. Standing in for it
 * this way is the only honest way to assert "the second POST was never made"
 * without a provider: the tail records what it was allowed to do.
 */
function tail(input: {
  posts: number;
  seen: Array<{ index: number; verdict: unknown }>;
  ambiguous?: boolean;
}) {
  return async (request: ScheduledLaunchCreateRequest) => {
    let made = 0;
    for (let index = 0; index < input.posts; index += 1) {
      const verdict = await request.beforeProviderMutation();
      input.seen.push({ index, verdict });
      if (verdict !== true) {
        return {
          ok: false,
          status: 409,
          body: {
            ok: false,
            error: {
              code: "provider_mutation_withheld",
              message: "nothing further was created on Meta",
            },
            withheldReason:
              typeof verdict === "object" ? verdict.reason : null,
          },
          // Honest: whether anything was created before the refusal.
          providerMutationAttempted: made > 0,
        };
      }
      made += 1;
    }
    return {
      ok: !input.ambiguous,
      status: input.ambiguous ? 502 : 200,
      body: input.ambiguous
        ? {
            ok: false,
            error: { code: "provider_outcome_ambiguous", message: "unknown" },
            retryAllowed: false,
          }
        : { ok: true, adIds: ["122"] },
      providerMutationAttempted: true,
    };
  };
}

function runtime(input: {
  seen: Array<{ index: number; verdict: unknown }>;
  posts?: number;
  ambiguous?: boolean;
}) {
  return createScheduledLaunchRuntime({
    readGates: async () => gates(),
    readMode: async () => "auto",
    readIntent: async () => intent(),
    runCreate: tail({
      posts: input.posts ?? 1,
      seen: input.seen,
      ambiguous: input.ambiguous,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readMetaLaunchIntentApprovalStanding).mockResolvedValue({ stands: true });
  vi.mocked(getMetaLaunchIntent).mockResolvedValue(intent());
});

describe("the once-per-sequence read, in prepare", () => {
  it("refuses a prepared intent whose brief left `reviewed`, by name", async () => {
    vi.mocked(readMetaLaunchIntentApprovalStanding).mockResolvedValue(WITHDRAWN);

    const result = await prepareMetaLaunchIntentForExecution(prepareInput());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe(
      "creative_brief_not_reviewed",
    );
    expect(result.ok === false && result.status).toBe(409);
    // The current rows, never the staged payload — which cannot say whether the
    // approval behind it still stands.
    expect(readMetaLaunchIntentApprovalStanding).toHaveBeenCalledWith({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: intent().lineage,
    });
  });

  it("lets an unchanged approval through", async () => {
    const result = await prepareMetaLaunchIntentForExecution(prepareInput());

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.created).toBe(false);
  });

  it("still reports an already-consumed intent instead of the withdrawal", async () => {
    /*
      Order matters. A withdrawal must never make a launch that may already be
      live read as one that never ran, so the consumed and ambiguous answers are
      given first — and the standing read is not even made.
    */
    vi.mocked(readMetaLaunchIntentApprovalStanding).mockResolvedValue(WITHDRAWN);
    vi.mocked(getMetaLaunchIntent).mockResolvedValue(intent({ status: "succeeded" }));

    const result = await prepareMetaLaunchIntentForExecution(prepareInput());

    expect(result.ok === false && result.error.code).toBe(
      "launch_intent_already_consumed",
    );
    expect(readMetaLaunchIntentApprovalStanding).not.toHaveBeenCalled();
  });

  it("still parks an unresolved provider outcome instead of the withdrawal", async () => {
    vi.mocked(readMetaLaunchIntentApprovalStanding).mockResolvedValue(WITHDRAWN);
    vi.mocked(getMetaLaunchIntent).mockResolvedValue(
      intent({
        status: "silent_failure",
        errorReceipt: {
          code: "provider_outcome_ambiguous",
          partialResult: { steps: [] },
        } as never,
      }),
    );

    const result = await prepareMetaLaunchIntentForExecution(prepareInput());

    expect(result.ok === false && result.error.code).toBe(
      "launch_intent_provider_outcome_ambiguous",
    );
    expect(readMetaLaunchIntentApprovalStanding).not.toHaveBeenCalled();
  });
});

describe("the read at every pre-POST boundary", () => {
  it("withholds the create and never stamps a dispatch marker", async () => {
    vi.mocked(readMetaLaunchIntentApprovalStanding).mockResolvedValue(WITHDRAWN);
    const seen: Array<{ index: number; verdict: unknown }> = [];
    const marker = vi.fn(async () => true);

    const result = await runtime({ seen })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: marker,
    });

    expect(seen).toEqual([
      { index: 0, verdict: { allowed: false, reason: "creative_brief_not_reviewed" } },
    ]);
    /*
      Before the caller's own gates, so a withdrawn approval never stamps
      write-ahead dispatch intent for a call that will not be made.
    */
    expect(marker).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.receipt.providerMutationAttempted).toBe(false);
    expect(result.reconcile).toBe(false);
  });

  it("settles the row with the withdrawal's own code, not a withheld gate", async () => {
    vi.mocked(readMetaLaunchIntentApprovalStanding).mockResolvedValue(WITHDRAWN);
    const seen: Array<{ index: number; verdict: unknown }> = [];

    const result = await runtime({ seen })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    // `withheld` is the vocabulary of gates an operator closed. An approval an
    // operator WITHDREW is a different fact and says so in its own words.
    expect(result.receipt.withheld).toBeNull();
    expect(result.receipt.httpStatus).toBe(409);
    expect(result.receipt.response).toEqual({
      ok: false,
      error: {
        code: "creative_brief_not_reviewed",
        message: WITHDRAWN.message,
      },
      launchIntentId: INTENT,
    });
  });

  it("fails closed when the approval source cannot be read at all", async () => {
    vi.mocked(readMetaLaunchIntentApprovalStanding).mockResolvedValue({
      stands: false,
      code: "launch_approval_source_unreadable",
      message: "The approval could not be read.",
    });
    const seen: Array<{ index: number; verdict: unknown }> = [];

    const result = await runtime({ seen })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(seen[0]?.verdict).toEqual({
      allowed: false,
      reason: "launch_approval_source_unreadable",
    });
    expect(result.receipt.providerMutationAttempted).toBe(false);
  });

  it("asks once per POST, and a withdrawal mid-sequence stops the rest", async () => {
    /*
      The reason it is not a single read before the sequence: a launch is three
      or more POSTs, and an operator can un-review the brief in the gaps between
      them. The first two creates are allowed, the third is not.
    */
    vi.mocked(readMetaLaunchIntentApprovalStanding)
      .mockResolvedValueOnce({ stands: true })
      .mockResolvedValueOnce({ stands: true })
      .mockResolvedValue(WITHDRAWN);
    const seen: Array<{ index: number; verdict: unknown }> = [];

    const result = await runtime({ seen, posts: 4 })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(seen.map((entry) => entry.verdict)).toEqual([
      true,
      true,
      { allowed: false, reason: "creative_brief_not_reviewed" },
    ]);
    expect(readMetaLaunchIntentApprovalStanding).toHaveBeenCalledTimes(3);
    /*
      Two creates really happened, so this is NOT a proven non-attempt: the
      receipt carries the partial truth rather than the clean refusal the first
      case reports.
    */
    expect(result.receipt.providerMutationAttempted).toBe(true);
    expect(result.receipt.withheld).toBeNull();
  });

  it("leaves the unchanged-approval path exactly as it was", async () => {
    const seen: Array<{ index: number; verdict: unknown }> = [];
    const marker = vi.fn(async () => true);

    const result = await runtime({ seen, posts: 3 })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: marker,
    });

    expect(seen.map((entry) => entry.verdict)).toEqual([true, true, true]);
    expect(marker).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(true);
    expect(result.receipt.withheld).toBeNull();
    expect(result.receipt.providerMutationAttempted).toBe(true);
  });

  it("still parks an ambiguous outcome for reconciliation", async () => {
    const seen: Array<{ index: number; verdict: unknown }> = [];

    const result = await runtime({ seen, ambiguous: true })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(result.reconcile).toBe(true);
    expect(result.receipt.providerMutationAttempted).toBe(true);
  });
});

/**
 * The same boundary, on the arm an operator approves a queue row through.
 *
 * `executeMetaAutomationProposal` used to hand the Launchpad handlers the
 * dispatch marker and nothing else, so an operator-approved launch got exactly
 * the coverage the scheduled arm proves insufficient: one approval read, taken
 * before the write context, the validation and a live provider preflight, and
 * then three or more POSTs made on the strength of it.
 *
 * What must NOT change is what authorizes this arm. The body is still the
 * operator's own `launchpad_manual_v1` / `explicit_operator_confirmation`, and
 * a marker that cannot be written still refuses exactly as it did.
 */
describe("the manual queue-approval arm", () => {
  /** The handler's own sequence: ask the boundary before each create. */
  function handlerTail(input: {
    posts: number;
    seen: Array<{ index: number; verdict: unknown }>;
  }) {
    return async (
      _request: NextRequest,
      options?: {
        beforeProviderMutation?: () => Promise<MetaLaunchProviderMutationVerdict>;
      },
    ) => {
      let made = 0;
      for (let index = 0; index < input.posts; index += 1) {
        const verdict = await options!.beforeProviderMutation!();
        input.seen.push({ index, verdict });
        if (verdict !== true) {
          return NextResponse.json(
            {
              ok: false,
              error: { code: "provider_mutation_withheld" },
              createdBeforeRefusal: made,
            },
            { status: 409 },
          );
        }
        made += 1;
      }
      return NextResponse.json({ ok: true, adIds: ["122"] }, { status: 200 });
    };
  }

  function approve(input: {
    posts: number;
    seen: Array<{ index: number; verdict: unknown }>;
    markDispatchStarted?: () => Promise<boolean>;
  }) {
    vi.mocked(handleMetaAddToExistingAction).mockImplementation(
      handlerTail({ posts: input.posts, seen: input.seen }) as never,
    );
    return executeMetaAutomationProposal({
      request: new NextRequest("http://localhost/api/meta/automation/proposals", {
        method: "POST",
      }),
      businessId: BUSINESS,
      proposal: proposal(),
      dryRunOnly: false,
      receiptKey: "claim-1",
      launchIntent: async () => intent(),
      markDispatchStarted: input.markDispatchStarted ?? (async () => true),
    });
  }

  it("withholds every remaining POST once the approval is withdrawn", async () => {
    vi.mocked(readMetaLaunchIntentApprovalStanding)
      .mockResolvedValueOnce({ stands: true })
      .mockResolvedValue(WITHDRAWN);
    const seen: Array<{ index: number; verdict: unknown }> = [];
    const marker = vi.fn(async () => true);

    const result = await approve({ posts: 4, seen, markDispatchStarted: marker });

    expect(seen.map((entry) => entry.verdict)).toEqual([
      true,
      { allowed: false, reason: "creative_brief_not_reviewed" },
    ]);
    // Asked per POST, not once per dispatch.
    expect(readMetaLaunchIntentApprovalStanding).toHaveBeenCalledTimes(2);
    // And the withheld create never stamped write-ahead dispatch intent.
    expect(marker).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.receipt.httpStatus).toBe(409);
  });

  it("reads the CURRENT rows for the intent's own lineage", async () => {
    const seen: Array<{ index: number; verdict: unknown }> = [];

    await approve({ posts: 1, seen });

    expect(readMetaLaunchIntentApprovalStanding).toHaveBeenCalledWith({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: intent().lineage,
    });
  });

  it("leaves an unwithdrawn approval dispatching exactly as before", async () => {
    const seen: Array<{ index: number; verdict: unknown }> = [];
    const marker = vi.fn(async () => true);

    const result = await approve({ posts: 3, seen, markDispatchStarted: marker });

    expect(seen.map((entry) => entry.verdict)).toEqual([true, true, true]);
    expect(marker).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(true);
    expect(result.receipt.withheld).toBeNull();
  });

  it("still refuses on a marker that cannot be written, unchanged", async () => {
    /*
      The marker's own refusal is a `false`, not a named reason, and the
      handler turns that into `dispatch_marker_unavailable`. Wrapping it must
      not have renamed it.
    */
    const seen: Array<{ index: number; verdict: unknown }> = [];

    const result = await approve({
      posts: 2,
      seen,
      markDispatchStarted: async () => false,
    });

    expect(seen.map((entry) => entry.verdict)).toEqual([false]);
    expect(result.ok).toBe(false);
  });
});
