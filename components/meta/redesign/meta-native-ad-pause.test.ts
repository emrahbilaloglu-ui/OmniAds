import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { MetaOsAdDecision } from "@/lib/meta/decisions-os-contract";
import {
  buildNativeMetaCanonicalDecisionInventory,
  buildNativeMetaDecisionsWorkspaceReadModel,
  applyMetaExecutionGovernanceToReadModel,
  type MetaDecisionCampaignContextSourceRow,
  type MetaNativeDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import { buildMetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-presentation";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  createDecisionOriginAdActionIdempotencyKey,
  type DecisionOriginAdExecutionRequest,
} from "@/lib/creative-decision-engine/execution-safety";
import {
  META_DECISION_NATIVE_ACTION_ORIGIN,
  authorizeMetaNativeAdPause,
  describeMetaNativeAdPauseFailure,
  executeMetaNativeAdPause,
} from "./meta-native-ad-pause";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV } from "@/lib/creative-decision-engine/campaign-context/source";

// D074: the zero-blocker state this file authorizes from is reachable only
// after the deliberate operator act of validating the exact resolver version.
// The gate is intentionally unset in production today; stubbing it here is the
// test's simulation of that act, not a claim that validation passed.
beforeAll(() => {
  vi.stubEnv(
    CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV,
    CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  );
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/**
 * WHY THIS FILE BUILDS NOTHING BY HAND.
 *
 * Its first version wrote `blockers: []` into a literal canonical decision and
 * a literal served decision. No producer could reach that state: the read model
 * appended `risk_tier_unclassified` to `classification.blockers`
 * unconditionally, so every canonical decision the server could build carried at
 * least one blocker, and `authorizeMetaNativeAdPause` — which refuses on
 * `canonical.classification.blockers.length > 0` and on
 * `decision.blockers.length > 0` — could never be offered on any real account.
 * The control was dead in production and green in test, and the hand-built
 * fixture is the entire reason those two facts could disagree.
 *
 * So both fixtures now come out of the real producers:
 * `buildNativeMetaCanonicalDecisionInventory` for the canonical envelope and
 * `buildMetaOsDecisionsPresentation` for the served decision, from one set of
 * snapshot source rows. A shape the server cannot produce can no longer turn
 * this file green, because no test here can write a shape at all — the refusal
 * cases mutate producer output rather than replacing it.
 */

const BUSINESS_ID = "biz_1";
const ACCOUNT_ID = "act_1";
const AD_ID = "120000000000000041";
const CREATIVE_ID = "creative_shared";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000041";
const EVALUATION_ID = "10000000-0000-4000-8000-000000000041";
const JOB_RUN_ID = "20000000-0000-4000-8000-000000000001";
const PROVIDER_ACCOUNT_REF_ID = "30000000-0000-4000-8000-000000000001";
const AS_OF_DATE = "2026-07-12";
const DECISION_HASH = "b".repeat(64);

function snapshotRow(): MetaNativeDecisionSnapshotSourceRow {
  return {
    snapshot_id: SNAPSHOT_ID,
    evaluation_id: EVALUATION_ID,
    job_run_id: JOB_RUN_ID,
    provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
    provider_account_id: ACCOUNT_ID,
    ad_id: AD_ID,
    creative_id: CREATIVE_ID,
    as_of_date: AS_OF_DATE,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: ACCOUNT_ID,
    label: "cut",
    pre_authority_label: null,
    authority_blocker: null,
    raw_label: "cut",
    confidence: 88,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 0.5,
    badges: [],
    reason: "Exact Ad evidence is below the account target.",
    spend: 120,
    purchases: 1,
    roas: 1,
    recent7d_roas: 0.9,
    label_transform: null,
    blocked_action_type: null,
    authorized_action: "cut",
    input_hash: "a".repeat(64),
    decision_hash: DECISION_HASH,
    computed_at: "2026-07-12T05:00:00.000Z",
    episode_started_at: AS_OF_DATE,
    lineage_valid: true,
    creative_name: "Shared creative",
    campaign_id: "cmp_1",
    campaign_name: "Main Sales",
    adset_id: "adset_1",
    adset_name: "Broad",
    ad_name: `Ad ${AD_ID}`,
    campaign_status: "ACTIVE",
    adset_status: "ACTIVE",
    ad_status: "ACTIVE",
    currency: "USD",
    thumbnail_url: "https://cdn.example/shared.jpg",
    media_source_present: true,
    media_available: true,
    media_source: "meta_creative_media",
    source_updated_at: "2026-07-12T04:00:00.000Z",
  };
}

function campaignContext(): MetaDecisionCampaignContextSourceRow {
  return {
    campaignId: "cmp_1",
    kind: "main",
    source: "system_inferred",
    confidenceClass: "high",
    sourceUpdatedAt: "2026-07-09T10:00:00.000Z",
    resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  };
}

function generationFor(rows: readonly MetaNativeDecisionSnapshotSourceRow[]) {
  return {
    jobRunId: JOB_RUN_ID,
    asOfDate: AS_OF_DATE,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    manifestHash: hashAdDecisionIdentityManifest({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      asOfDate: AS_OF_DATE,
      adIds: rows.map((row) => row.ad_id),
    }),
    expectedAdCount: rows.length,
  };
}

/** One pass of the real server producers over one set of source rows. */
function producerOutput(): {
  canonical: MetaCanonicalDecision;
  decision: MetaOsAdDecision;
} {
  const rows = [snapshotRow()];
  const inventory = buildNativeMetaCanonicalDecisionInventory({
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT_ID,
    generation: generationFor(rows),
    snapshotRows: rows,
    campaignContextRows: [campaignContext()],
  });
  if (inventory.status !== "available" || inventory.items.length !== 1) {
    throw new Error(
      `Native canonical inventory is not available: ${inventory.unavailableReason}`,
    );
  }
  const readModel = applyMetaExecutionGovernanceToReadModel({
    model: buildNativeMetaDecisionsWorkspaceReadModel({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      generation: generationFor(rows),
      snapshotRows: rows,
      campaignContextRows: [campaignContext()],
      eventSourceAvailable: false,
      outcomeSourceAvailable: false,
      responseSourceAvailable: false,
      generatedAt: "2026-07-12T12:00:00.000Z",
    }),
    governance: {
      verified: true,
      controlsConfigured: true,
      writeBlocked: false,
      blockReason: null,
    },
    pipeline: { verified: true, executionReady: true },
    now: new Date("2026-07-12T12:00:00.000Z"),
  });
  const presentation = buildMetaOsDecisionsPresentation({
    actionNow: [],
    watching: [],
    nonSales: [],
    decisionReadModel: readModel,
    currency: "USD",
  });
  const decision = presentation.ads.items[0];
  if (!decision) throw new Error("The presentation served no Ad decision.");
  const canonical = readModel.queue.adCandidates?.items[0];
  if (!canonical) throw new Error("The governed read model has no canonical Ad.");
  return { canonical, decision };
}

function authorize(
  mutate?: (input: {
    decision: MetaOsAdDecision;
    canonical: MetaCanonicalDecision;
  }) => void,
) {
  const input = producerOutput();
  mutate?.(input);
  return authorizeMetaNativeAdPause({
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT_ID,
    ...input,
  });
}

function authorizedRequest(): DecisionOriginAdExecutionRequest {
  const authorization = authorize();
  if (!authorization.ok) {
    throw new Error(
      `Producer authorization failed: ${authorization.refusalReason}`,
    );
  }
  return authorization.request;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("the fixtures this file authorizes from", () => {
  it("are produced by the server, with an empty blocker list the server can actually reach", () => {
    const { canonical, decision } = producerOutput();

    // The state the old fixture asserted by writing it down. It is now a
    // measurement of what `buildNativeMetaCanonicalDecisionInventory` and
    // `buildMetaOsDecisionsPresentation` emit for an authorized native Cut.
    expect(canonical.classification.blockers).toEqual([]);
    expect(decision.blockers).toEqual([]);
    expect(canonical.sourceAuthority).toMatchObject({
      status: "native_exact",
      actionEligible: true,
      reviewOnlyReason: null,
      authorizedAction: "cut",
      realAdId: AD_ID,
    });
    expect(decision.action).toMatchObject({
      code: "cut",
      intent: "execute",
      targetLevel: "ad",
      providerMutation: "pause",
    });
    expect(decision.lane).toBe("act");
  });

  it("still state that risk is unclassified, and why, as an advisory", () => {
    const { canonical } = producerOutput();

    expect(canonical.classification.advisories).toEqual([
      expect.objectContaining({
        code: "risk_tier_unclassified",
        label: "Risk is unclassified",
        category: "risk",
        reason: "risk_tier_producer_not_persisted",
      }),
    ]);
    // The advisory and the envelope beside it are the same claim; neither may
    // drift into contradicting the other.
    expect(canonical.riskTierProvenance).toEqual({
      status: "proposed",
      reason: "risk_tier_producer_not_persisted",
    });
    expect(canonical.riskTier).toBeNull();
  });
});

describe("authorizeMetaNativeAdPause", () => {
  it("offers the control on producer-shaped data and mints the exact immutable request", () => {
    const result = authorize();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const requestBase = {
      contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      adId: AD_ID,
      snapshotId: SNAPSHOT_ID,
      evaluationId: EVALUATION_ID,
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      decisionHash: DECISION_HASH,
      action: "pause",
      creativeId: CREATIVE_ID,
    };
    expect(result.request).toEqual({
      ...requestBase,
      idempotencyKey: createDecisionOriginAdActionIdempotencyKey(requestBase),
    });
    expect(authorize()).toEqual(result);
    expect(result.request).not.toHaveProperty("actionOrigin");
    expect(result.request).not.toHaveProperty("manualConfirmation");
  });

  it("fails closed when canonical authority is absent", () => {
    const result = authorizeMetaNativeAdPause({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      decision: producerOutput().decision,
      canonical: null,
    });
    expect(result).toMatchObject({ ok: false, request: null });
  });

  it.each([
    [
      "served action tuple mismatch",
      ({ decision }: { decision: MetaOsAdDecision }) => {
        decision.action.intent = "review";
      },
    ],
    [
      "provider account mismatch",
      ({ decision }: { decision: MetaOsAdDecision }) => {
        decision.providerAccountId = "act_other";
      },
    ],
    [
      "non-exact identity",
      ({ canonical }: { canonical: MetaCanonicalDecision }) => {
        if (canonical.identityResolution) {
          canonical.identityResolution.basis = "single_ad_creative_equivalent";
        }
      },
    ],
    [
      "Ad identity mismatch",
      ({ decision }: { decision: MetaOsAdDecision }) => {
        decision.adId = "100000000000099";
      },
    ],
    [
      "snapshot lineage mismatch",
      ({ decision }: { decision: MetaOsAdDecision }) => {
        decision.sourceSnapshotId = "snapshot_other";
      },
    ],
    [
      "held canonical action",
      ({ canonical }: { canonical: MetaCanonicalDecision }) => {
        canonical.classification.heldAction = "cut";
      },
    ],
    [
      "blocked served decision",
      ({ decision }: { decision: MetaOsAdDecision }) => {
        decision.blockers.push({ code: "data_blocked", label: "Data blocked" });
      },
    ],
    [
      "action-ineligible authority",
      ({ canonical }: { canonical: MetaCanonicalDecision }) => {
        if (canonical.sourceAuthority)
          canonical.sourceAuthority.actionEligible = false;
      },
    ],
    [
      "stale execution readiness",
      ({ canonical }: { canonical: MetaCanonicalDecision }) => {
        if (canonical.sourceAuthority) {
          canonical.sourceAuthority.executionReadiness = "stale_decision";
        }
      },
    ],
    [
      "missing execution readiness",
      ({ canonical }: { canonical: MetaCanonicalDecision }) => {
        if (canonical.sourceAuthority) {
          delete canonical.sourceAuthority.executionReadiness;
        }
      },
    ],
    [
      "non-native authority",
      ({ canonical }: { canonical: MetaCanonicalDecision }) => {
        if (canonical.sourceAuthority) {
          canonical.sourceAuthority.status = "legacy_review_only";
        }
      },
    ],
    [
      "canonical decision label mismatch",
      ({ canonical }: { canonical: MetaCanonicalDecision }) => {
        canonical.sourceDecision.label = "scale";
      },
    ],
    [
      "inactive hierarchy",
      ({ canonical }: { canonical: MetaCanonicalDecision }) => {
        if (canonical.deliveryScope)
          canonical.deliveryScope.adStatus = "PAUSED";
      },
    ],
    // Every gate that IS a gate keeps its veto. A real authority blocker in the
    // canonical blocker list still refuses, which is what makes the demotion of
    // `risk_tier_unclassified` a change of one code's classification and not a
    // weakening of the guard.
    [
      "a real canonical blocker",
      ({ canonical }: { canonical: MetaCanonicalDecision }) => {
        canonical.classification.blockers.push({
          code: "delivery_proof",
          label: "Delivery proof is missing",
          category: "delivery",
          provenance: canonical.classification.provenance,
        });
      },
    ],
    // And if the risk-tier advisory is ever pushed back into `blockers`, the
    // guard vetoes it again — the demotion lives in the producer's choice of
    // field, not in a softened check here.
    [
      "the risk-tier advisory re-filed as a blocker",
      ({ canonical }: { canonical: MetaCanonicalDecision }) => {
        canonical.classification.blockers.push({
          code: "risk_tier_unclassified",
          label: "Risk is unclassified",
          category: "risk",
          provenance: canonical.classification.provenance,
        });
      },
    ],
  ])("refuses %s without minting a request", (_name, mutation) => {
    const result = authorize(mutation);
    expect(result).toMatchObject({ ok: false, request: null });
    if (!result.ok) expect(result.refusalReason.trim()).not.toBe("");
  });
});

describe("executeMetaNativeAdPause", () => {
  it("posts the exact native contract once and accepts only verified provider success", async () => {
    const request = authorizedRequest();
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        ok: true,
        action: "pause",
        adId: AD_ID,
        status: "PAUSED",
        duplicate: false,
      }),
    ) as unknown as typeof fetch;

    const result = await executeMetaNativeAdPause({
      request,
      fetchImpl: fetchSpy,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "PAUSED",
      duplicate: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchSpy).mock.calls[0];
    expect(url).toBe(`/api/meta/ads/${AD_ID}/pause`);
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      ...request,
      actionOrigin: META_DECISION_NATIVE_ACTION_ORIGIN,
    });
    expect(body).not.toHaveProperty("manualConfirmation");
    expect(body).not.toHaveProperty("reason");
    expect(body).not.toHaveProperty("force");
  });

  it("accepts a verified duplicate receipt without issuing a second request", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        ok: true,
        action: "pause",
        adId: AD_ID,
        status: "PAUSED",
        duplicate: true,
      }),
    ) as unknown as typeof fetch;

    const result = await executeMetaNativeAdPause({
      request: authorizedRequest(),
      fetchImpl: fetchSpy,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "PAUSED",
      duplicate: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ACTIVE", false],
    ["PENDING", false],
    ["PAUSED", true],
  ])(
    "rejects a 2xx response that does not prove a real PAUSED write (%s, dryRun=%s)",
    async (status, dryRun) => {
      const fetchSpy = vi.fn(async () =>
        jsonResponse({
          ok: true,
          action: "pause",
          adId: AD_ID,
          status,
          dryRun,
        }),
      ) as unknown as typeof fetch;

      const result = await executeMetaNativeAdPause({
        request: authorizedRequest(),
        fetchImpl: fetchSpy,
      });

      expect(result).toMatchObject({ ok: false, code: "invalid_response" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("fails closed on a malformed 2xx response and never retries", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        ok: true,
        action: "pause",
        adId: "wrong_ad",
        status: "PAUSED",
      }),
    ) as unknown as typeof fetch;

    const result = await executeMetaNativeAdPause({
      request: authorizedRequest(),
      fetchImpl: fetchSpy,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "invalid_response",
      reconciliationRequired: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves reconciliation flags from a failed provider outcome and never retries", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            code: "provider_outcome_ambiguous",
            message: "Provider outcome requires reconciliation.",
          },
          reconciliationRequired: true,
          retryAllowed: false,
          providerMutationSucceeded: true,
          providerOutcomeAmbiguous: true,
        },
        409,
      ),
    ) as unknown as typeof fetch;

    const result = await executeMetaNativeAdPause({
      request: authorizedRequest(),
      fetchImpl: fetchSpy,
    });

    expect(result).toEqual({
      ok: false,
      code: "provider_outcome_ambiguous",
      message: "Provider outcome requires reconciliation.",
      reconciliationRequired: true,
      retryAllowed: false,
      providerMutationSucceeded: true,
      providerOutcomeAmbiguous: true,
      payload: expect.any(Object),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("states a verified provider mutation separately from durable reconciliation", () => {
    expect(
      describeMetaNativeAdPauseFailure({
        ok: false,
        code: "provider_verification_persistence_failed",
        message:
          "The prior receipt still requires reconciliation; no new provider write was attempted.",
        reconciliationRequired: true,
        retryAllowed: false,
        providerMutationSucceeded: true,
        providerOutcomeAmbiguous: false,
        payload: null,
      }),
    ).toContain("Provider mutation status: succeeded");
  });

  it("does not claim provider success when the outcome is ambiguous", () => {
    const message = describeMetaNativeAdPauseFailure({
      ok: false,
      code: "provider_outcome_ambiguous",
      message: "Provider response was lost.",
      reconciliationRequired: true,
      retryAllowed: false,
      providerMutationSucceeded: null,
      providerOutcomeAmbiguous: true,
      payload: null,
    });
    expect(message).toContain("Provider mutation status: unknown");
    expect(message).not.toContain("Provider mutation status: succeeded");
  });

  it("fails closed on a network error and never retries", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    const result = await executeMetaNativeAdPause({
      request: authorizedRequest(),
      fetchImpl: fetchSpy,
    });

    expect(result).toEqual({
      ok: false,
      code: "network_outcome_unknown",
      message:
        "The request outcome is unknown because no server response was received. connection reset",
      reconciliationRequired: true,
      retryAllowed: false,
      providerMutationSucceeded: null,
      providerOutcomeAmbiguous: true,
      payload: null,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
