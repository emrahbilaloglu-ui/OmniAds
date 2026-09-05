import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/ads-action-log", () => ({
  createMetaAdsActionLog: vi.fn(async () => ({ id: "log-1" })),
  completeMetaAdsActionLog: vi.fn(async () => ({ id: "log-1" })),
}));
vi.mock("@/lib/meta/ads-write", () => ({
  pauseCampaign: vi.fn(),
  resumeCampaign: vi.fn(),
  pauseAdset: vi.fn(),
  resumeAdset: vi.fn(),
}));

import * as log from "@/lib/meta/ads-action-log";
import * as adsWrite from "@/lib/meta/ads-write";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import {
  createScheduledStatusRuntime,
  SCHEDULED_ACTION_ORIGIN,
} from "@/lib/meta/scheduled-status-runtime";
import type { ScheduledAuthorityGates } from "@/lib/meta/scheduled-action-execution";

const ACTOR = "22222222-2222-4222-8222-222222222222";

const PROPOSAL = {
  id: "p-1",
  businessId: "11111111-1111-4111-8111-111111111111",
  providerAccountId: "act_1",
  scopeType: "adset",
  scopeId: "23851",
  proposedAction: "pause",
  recId: "rec-1",
} as unknown as MetaAutomationProposal;

function gates(overrides: Partial<ScheduledAuthorityGates> = {}): ScheduledAuthorityGates {
  return {
    releaseGateOpen: true,
    autoExecutionEnabled: true,
    enabledProviderAccountId: "act_1",
    enablingActorUserId: ACTOR,
    activationControlVersion: "v-7",
    dryRunOnly: false,
    ...overrides,
  };
}

const SCHEDULED = {
  kind: "scheduled",
  expectedEnablingActorUserId: ACTOR,
  expectedActivationControlVersion: "v-7",
} as const;

function build(options: {
  gateSequence?: Array<ScheduledAuthorityGates | null>;
  modeSequence?: Array<"manual" | "semi_auto" | "auto" | null>;
} = {}) {
  const gateReads = options.gateSequence ?? [gates(), gates()];
  const modeReads = options.modeSequence ?? ["auto", "auto"];
  let gateCall = 0;
  let modeCall = 0;
  return createScheduledStatusRuntime({
    ctx: { businessId: PROPOSAL.businessId } as never,
    readGates: async () => gateReads[Math.min(gateCall++, gateReads.length - 1)],
    readMode: async () => modeReads[Math.min(modeCall++, modeReads.length - 1)],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(log.createMetaAdsActionLog).mockResolvedValue({ id: "log-1" } as never);
});

describe("a scheduled status change never claims an operator confirmed it", () => {
  it("journals under its own origin with no requester", async () => {
    vi.mocked(adsWrite.pauseAdset).mockResolvedValue({
      ok: true,
      verifiedStatus: "PAUSED",
      responsePayload: { success: true },
      verificationPayload: { status: "PAUSED" },
    } as never);

    const runtime = build();
    const result = await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.ok).toBe(true);
    const logged = vi.mocked(log.createMetaAdsActionLog).mock.calls[0]![0];
    expect(logged.source).toBe(SCHEDULED_ACTION_ORIGIN);
    // The enabling admin authorized the standing arrangement; they did not
    // request this row. Naming them here would make the log unable to tell a
    // sweep from a click.
    expect(logged.requestedBy).toBeNull();
    expect(result.receipt.providerMutationAttempted).toBe(true);
  });

  it("refuses a manual authorization outright", async () => {
    const runtime = build();
    const result = await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: {
        kind: "manual",
        explicitConfirmation: true,
        operatorUserId: ACTOR,
      },
    });
    expect(result.receipt.withheld).toBe("manual_confirmation_absent");
    expect(vi.mocked(adsWrite.pauseAdset)).not.toHaveBeenCalled();
  });
});

describe("the authority is re-proved at the pre-POST boundary", () => {
  it("throws inside the hook when the mode changed after the claim", async () => {
    /*
      The first read authorizes and the second does not — exactly the window
      this hook exists for. The primitive turns the throw into a write error
      with no attempt, so the assertion is that the hook refuses; whether a
      request followed is the primitive's own tested contract.
    */
    let hook: (() => Promise<void>) | undefined;
    vi.mocked(adsWrite.pauseAdset).mockImplementation((async (
      _ctx: unknown,
      _id: string,
      options: { beforeMutationAttempt?: () => Promise<void> },
    ) => {
      hook = options.beforeMutationAttempt;
      return { ok: false, httpStatus: 502, error: { code: "x", message: "x" } };
    }) as never);

    const runtime = build({ modeSequence: ["auto", "manual"] });
    await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(hook).toBeDefined();
    await expect(hook!()).rejects.toThrow("mode_not_auto");
  });

  it("refuses when the marker cannot be written, so nothing is sent", async () => {
    let hook: (() => Promise<void>) | undefined;
    vi.mocked(adsWrite.pauseAdset).mockImplementation((async (
      _ctx: unknown,
      _id: string,
      options: { beforeMutationAttempt?: () => Promise<void> },
    ) => {
      hook = options.beforeMutationAttempt;
      return { ok: false, httpStatus: 502, error: { code: "x", message: "x" } };
    }) as never);

    const runtime = build();
    await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => false,
    });

    await expect(hook!()).rejects.toThrow("dispatch_marker_unavailable");
  });
});

describe("an unknown provider answer parks rather than settles", () => {
  it("reports reconcile on an ambiguous outcome", async () => {
    vi.mocked(adsWrite.pauseAdset).mockResolvedValue({
      ok: false,
      httpStatus: 504,
      providerOutcome: "outcome_ambiguous",
      error: { code: "provider_outcome_ambiguous", message: "timeout" },
      mutationAttempt: { attemptCount: 1 },
    } as never);

    const runtime = build();
    const result = await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.ok).toBe(false);
    expect(result.reconcile).toBe(true);
    expect(vi.mocked(log.completeMetaAdsActionLog).mock.calls[0]![0].status)
      .toBe("silent_failure");
  });
});

describe("the row must be one this path can actually execute", () => {
  it("withholds an ad-grain row instead of pausing the wrong thing", async () => {
    const runtime = build();
    const result = await runtime({
      proposal: { ...PROPOSAL, scopeType: "ad" } as MetaAutomationProposal,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("composition_blocked");
  });

  it("withholds without a claim token", async () => {
    const runtime = build();
    const result = await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: null,
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("claim_absent");
  });
});
