/**
 * Finding 4, the ad family: the grain the sweep excluded, now executed.
 *
 * The sweep's pending query read `scope_type IN ('campaign','adset')` and the
 * status runtime withheld anything else, so the thousands of authorized native
 * `cut` decisions a day had no unattended path. The reason was real — an ad
 * write is a decision-origin write, with a claim, a post-claim preflight,
 * reconciliation markers and a receipt contract the status path does not carry
 * — but withholding is a safeguard, not an implementation.
 *
 * These cases drive the real runtime against doubles for the decision-origin
 * lifecycle, and assert on what that lifecycle was told.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/ads-action-log", () => ({
  createDecisionOriginMetaAdsActionLog: vi.fn(),
  completeDecisionOriginMetaAdsActionLog: vi.fn(),
  markDecisionOriginActionReconciliationRequired: vi.fn(async () => ({ id: "log-1" })),
  decisionOriginIdempotencyReceiptFromLog: vi.fn(() => ({ status: "success" })),
  resolveExactMetaAdActionTarget: vi.fn(),
}));
vi.mock("@/lib/meta/ads-write", () => ({
  pauseAd: vi.fn(),
  resumeAd: vi.fn(),
  hasSuccessfulMetaProviderMutationAttempt: vi.fn(() => false),
}));
vi.mock("@/lib/meta/decision-origin-action-preflight", () => ({
  runServerDecisionOriginAdActionPreflight: vi.fn(async () => ({
    shouldMutate: true, blockers: [], errorCode: null,
  })),
}));
vi.mock("@/lib/meta/automation-write-guard", () => ({
  readMetaWritePosture: vi.fn(async () => ({ blocked: false, rehearsal: false })),
}));

import * as log from "@/lib/meta/ads-action-log";
import * as adsWrite from "@/lib/meta/ads-write";
import * as preflight from "@/lib/meta/decision-origin-action-preflight";
import * as writeGuard from "@/lib/meta/automation-write-guard";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import {
  createScheduledAdStatusRuntime,
  decisionOriginRequestForProposal,
} from "@/lib/meta/scheduled-ad-status-runtime";
import type { ScheduledAuthorityGates } from "@/lib/meta/scheduled-action-execution";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT = "55555555-5555-4555-8555-555555555555";
const EVALUATION = "66666666-6666-4666-8666-666666666666";
const ACCOUNT = "act_9";
// Numeric, because the decision-origin contract requires an exact Meta
// provider entity id and refuses anything else — a real guard this fixture
// must respect rather than route around.
const AD = "23851000000031";
const CREATIVE = "23851000000077";

/** The lineage the projection now stores on the row. */
const EVIDENCE = {
  recId: EVALUATION,
  recType: "native_ad_cut",
  snapshotDate: "2026-09-04",
  engineVersion: "v3-native",
  decisionKey: `ad:${AD}`,
  creativeId: CREATIVE,
  decisionHash: "d".repeat(64),
  snapshotId: SNAPSHOT,
  evaluationId: EVALUATION,
};

function proposal(overrides: Partial<MetaAutomationProposal> = {}): MetaAutomationProposal {
  return {
    id: "p-ad-1",
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    scopeType: "ad",
    scopeId: AD,
    proposedAction: "pause",
    recId: EVALUATION,
    evidenceRef: EVIDENCE,
    ...overrides,
  } as unknown as MetaAutomationProposal;
}

function gates(overrides: Partial<ScheduledAuthorityGates> = {}): ScheduledAuthorityGates {
  return {
    releaseGateOpen: true,
    autoExecutionEnabled: true,
    enabledProviderAccountId: ACCOUNT,
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

function runtime() {
  return createScheduledAdStatusRuntime({
    ctx: {} as never,
    readGates: async () => gates(),
    readMode: async () => "auto",
    now: () => new Date("2026-09-05T10:00:00.000Z"),
  });
}

async function run(overrides: Partial<MetaAutomationProposal> = {}) {
  return runtime()({
    proposal: proposal(overrides),
    dryRunOnly: false,
    claimToken: "claim-1",
    authorization: SCHEDULED,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
    { blocked: false, rehearsal: false } as never,
  );
  vi.mocked(log.resolveExactMetaAdActionTarget).mockResolvedValue({
    ok: true, target: { adId: AD, creativeId: CREATIVE },
  } as never);
  vi.mocked(log.createDecisionOriginMetaAdsActionLog).mockResolvedValue({
    id: "log-ad-1", idempotentReplay: false,
  } as never);
  vi.mocked(log.completeDecisionOriginMetaAdsActionLog).mockResolvedValue({
    id: "log-ad-1", status: "success",
  } as never);
  vi.mocked(preflight.runServerDecisionOriginAdActionPreflight).mockResolvedValue({
    shouldMutate: true, blockers: [], errorCode: null,
  } as never);
  vi.mocked(adsWrite.pauseAd).mockResolvedValue({
    ok: true,
    verifiedStatus: "PAUSED",
    responsePayload: { success: true },
    verificationPayload: { id: AD, effective_status: "PAUSED" },
    mutationAttempt: { completedAt: "2026-09-05T09:59:59.000Z" },
  } as never);
});

describe("the request is rebuilt from the decision, never invented", () => {
  it("carries the exact lineage the projection stored", () => {
    const request = decisionOriginRequestForProposal(proposal());
    expect(request).toMatchObject({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      adId: AD,
      snapshotId: SNAPSHOT,
      evaluationId: EVALUATION,
      engineVersion: "v3-native",
      decisionHash: "d".repeat(64),
      action: "pause",
      creativeId: CREATIVE,
    });
    // Deterministic: a re-claim of the same decision is the same key, which is
    // what makes the durable idempotency check able to recognise it.
    expect(decisionOriginRequestForProposal(proposal())!.idempotencyKey)
      .toBe(request!.idempotencyKey);
  });

  it("produces nothing at all when the row cannot name its decision", async () => {
    const result = await run({
      evidenceRef: { ...EVIDENCE, snapshotId: undefined } as never,
    });
    expect(result.receipt.withheld).toBe("decision_lineage_absent");
    expect(vi.mocked(log.createDecisionOriginMetaAdsActionLog)).not.toHaveBeenCalled();
    expect(vi.mocked(adsWrite.pauseAd)).not.toHaveBeenCalled();
  });

  it("refuses when the ad no longer carries the creative the decision was about", async () => {
    vi.mocked(log.resolveExactMetaAdActionTarget).mockResolvedValue({
      ok: true, target: { adId: AD, creativeId: "cr_replaced" },
    } as never);
    const result = await run();
    expect(result.receipt.withheld).toBe("creative_identity_mismatch");
    expect(vi.mocked(adsWrite.pauseAd)).not.toHaveBeenCalled();
  });
});

describe("it runs the decision-origin lifecycle, not the status one", () => {
  it("claims, preflights, writes and terminalises through the decision path", async () => {
    const result = await run();

    expect(result.ok).toBe(true);
    const claim = vi.mocked(log.createDecisionOriginMetaAdsActionLog).mock.calls[0]![0];
    expect(claim.request).toMatchObject({ adId: AD, snapshotId: SNAPSHOT });
    // Nobody requested this one, and it never claims an operator did.
    expect(claim.requestedBy).toBeNull();
    expect(claim.payloadRequest).toMatchObject({
      action_origin: "native_decision_v1",
      scheduled_authority: {
        enablingActorUserId: ACTOR, activationControlVersion: "v-7",
      },
    });
    // The post-claim preflight ignores this row's own pending receipt, which
    // is what the operator's path does too.
    expect(vi.mocked(preflight.runServerDecisionOriginAdActionPreflight)
      .mock.calls[0]![0].ignorePendingReceiptActionLogId).toBe("log-ad-1");
    expect(vi.mocked(log.completeDecisionOriginMetaAdsActionLog)
      .mock.calls[0]![0].status).toBe("success");
    // And the pre-POST hook is what the primitive was handed.
    expect(vi.mocked(adsWrite.pauseAd).mock.calls[0]![2])
      .toHaveProperty("beforeMutationAttempt");
  });

  it("blocks and terminalises when the post-claim preflight refuses", async () => {
    vi.mocked(preflight.runServerDecisionOriginAdActionPreflight).mockResolvedValue({
      shouldMutate: false,
      blockers: ["source_freshness"],
      errorCode: "source_freshness",
    } as never);

    const result = await run();

    expect(result.receipt.withheld).toBe("composition_blocked");
    expect(vi.mocked(adsWrite.pauseAd)).not.toHaveBeenCalled();
    // The claim does not stay pending: a refused row must never look like a
    // call that may be in flight.
    expect(vi.mocked(log.completeDecisionOriginMetaAdsActionLog)
      .mock.calls[0]![0]).toMatchObject({
      status: "failure", errorCode: "source_freshness",
    });
  });

  it("parks an unresolvable preflight failure instead of leaving it pending", async () => {
    vi.mocked(preflight.runServerDecisionOriginAdActionPreflight).mockResolvedValue({
      shouldMutate: false, blockers: ["source_freshness"], errorCode: "source_freshness",
    } as never);
    vi.mocked(log.completeDecisionOriginMetaAdsActionLog)
      .mockRejectedValue(new Error("db down"));

    const result = await run();

    expect(result.reconcile).toBe(true);
    expect(vi.mocked(log.markDecisionOriginActionReconciliationRequired)
      .mock.calls[0]![0].outcome).toBe("pre_provider_terminal_persistence_failed");
  });

  it("reports a prior attempt's receipt instead of writing again", async () => {
    vi.mocked(log.createDecisionOriginMetaAdsActionLog).mockResolvedValue({
      id: "log-ad-1", idempotentReplay: true,
    } as never);

    const result = await run();

    // The decision was already executed. A second POST would apply it twice.
    expect(vi.mocked(adsWrite.pauseAd)).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.receipt.providerMutationAttempted).toBe(false);
  });

  it("treats a prior attempt still pending as unresolved, not as done", async () => {
    vi.mocked(log.createDecisionOriginMetaAdsActionLog).mockResolvedValue({
      id: "log-ad-1", idempotentReplay: true,
    } as never);
    vi.mocked(log.decisionOriginIdempotencyReceiptFromLog).mockReturnValue(
      { status: "pending" } as never,
    );

    const result = await run();

    expect(result.ok).toBe(false);
    expect(result.reconcile).toBe(true);
    expect(vi.mocked(adsWrite.pauseAd)).not.toHaveBeenCalled();
  });
});

describe("an unknown provider outcome parks and is never offered again", () => {
  it("marks reconciliation rather than settling an ambiguous write", async () => {
    vi.mocked(adsWrite.pauseAd).mockResolvedValue({
      ok: false,
      httpStatus: 504,
      error: { code: "provider_outcome_ambiguous", message: "timeout" },
      providerOutcome: "outcome_ambiguous",
      mutationAttempt: { completedAt: null },
    } as never);

    const result = await run();

    expect(result.ok).toBe(false);
    expect(result.reconcile).toBe(true);
    expect(vi.mocked(log.markDecisionOriginActionReconciliationRequired)
      .mock.calls[0]![0].outcome).toBe("provider_outcome_ambiguous");
    // Never terminalised: "unknown" is not a failure and not a success.
    expect(vi.mocked(log.completeDecisionOriginMetaAdsActionLog)).not.toHaveBeenCalled();
  });

  it("parks a verified write whose receipt would not persist", async () => {
    vi.mocked(log.completeDecisionOriginMetaAdsActionLog)
      .mockRejectedValue(new Error("receipt down"));

    const result = await run();

    // The change IS live. A row that looked unfinished would be offered again.
    expect(result.reconcile).toBe(true);
    expect(vi.mocked(log.markDecisionOriginActionReconciliationRequired)
      .mock.calls[0]![0].outcome)
      .toBe("provider_write_verified_receipt_persistence_failed");
  });

  it("reports a lineage downgrade the receipt finalisation found", async () => {
    // The completion re-checks the native lineage and can write
    // `silent_failure` over a provider success.
    vi.mocked(log.completeDecisionOriginMetaAdsActionLog).mockResolvedValue({
      id: "log-ad-1", status: "silent_failure",
    } as never);

    const result = await run();

    expect(result.ok).toBe(false);
    expect(result.reconcile).toBe(true);
  });
});

describe("the shared gates apply here too", () => {
  it("withholds on a blocked posture and sends nothing", async () => {
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
      { blocked: true, reason: "kill_switch_engaged", rehearsal: true } as never,
    );
    const result = await run();
    expect(result.receipt.withheld).toBe("kill_switch_engaged");
    expect(vi.mocked(log.createDecisionOriginMetaAdsActionLog)).not.toHaveBeenCalled();
  });

  it("never speaks for an operator", async () => {
    const result = await runtime()({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: {
        kind: "manual", explicitConfirmation: true, operatorUserId: ACTOR,
      },
    });
    expect(result.receipt.withheld).toBe("manual_confirmation_absent");
  });

  it("rehearses without posting when the business is in rehearsal", async () => {
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
      { blocked: false, rehearsal: true } as never,
    );
    vi.mocked(adsWrite.pauseAd).mockResolvedValue({
      ok: true, dryRun: true, verifiedStatus: "ACTIVE",
      responsePayload: {}, verificationPayload: {},
    } as never);

    const result = await run();

    expect(result.ok).toBe(true);
    expect(result.receipt.dryRun).toBe(true);
    expect(vi.mocked(adsWrite.pauseAd).mock.calls[0]![2]).toEqual({ dryRun: true });
    // A rehearsal's key differs from a live one's, so rehearsing does not
    // consume the idempotency of the write it stands in for.
    const claimed = vi.mocked(log.createDecisionOriginMetaAdsActionLog)
      .mock.calls[0]![0].request;
    expect(claimed.dryRun).toBe(true);
    expect(claimed.idempotencyKey)
      .not.toBe(decisionOriginRequestForProposal(proposal())!.idempotencyKey);
  });
});
