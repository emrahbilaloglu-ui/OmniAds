import fixtureJson from "@/lib/meta/fixtures/demo-native-canonical-generation.v1.json";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
  type MetaCanonicalDecision,
  type MetaDecisionBlocker,
  type MetaDecisionProvenance,
} from "@/lib/meta/decisions-workspace-contract";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import type { MetaNativeCanonicalDecisionInventory } from "@/lib/meta/decisions-workspace-read-model";
import {
  validateDemoNativeCanonicalFixture,
  type DemoNativeCanonicalFixture,
  type DemoNativeCanonicalFixtureItem,
} from "@/lib/meta/demo-native-canonical-contract";

const DEMO_REVIEW_ONLY_REASON = "demo_synthetic_review_only";

function provenance(input: {
  field: string;
  recordId: string | null;
  asOf: string;
  version?: string | null;
}): MetaDecisionProvenance {
  return {
    source: "committed_demo_native_canonical_fixture",
    field: input.field,
    recordId: input.recordId,
    asOf: input.asOf,
    version: input.version ?? null,
  };
}

function blockerCategory(code: string): MetaDecisionBlocker["category"] {
  if (code.includes("policy")) return "policy";
  if (code.includes("delivery")) return "delivery";
  if (code.includes("campaign")) return "campaign_context";
  if (code.includes("risk")) return "risk";
  if (code.includes("fatigue") || code.includes("assessment")) {
    return "assessment";
  }
  return "data";
}

function blockerLabel(code: string) {
  return code
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function buildSyntheticCanonicalDecision(input: {
  fixture: DemoNativeCanonicalFixture;
  item: DemoNativeCanonicalFixtureItem;
  row: MetaCreativeApiRow;
}): MetaCanonicalDecision {
  const { fixture, item, row } = input;
  const snapshotId = `demo-snapshot-${item.adId}`;
  const evaluationId = `demo-evaluation-${item.adId}`;
  const status = String(row.effective_status ?? "").trim().toUpperCase();
  const hierarchyStatus = status || null;
  const hierarchyActive = hierarchyStatus === "ACTIVE";
  const sourceProvenance = provenance({
    field:
      "engine_generated_label,pre_authority_label,raw_label,confidence,reason,badges",
    recordId: snapshotId,
    asOf: fixture.asOfDate,
    version: fixture.engineVersion,
  });
  const identityProvenance = provenance({
    field:
      "provider_account_id,campaign_id,adset_id,ad_id,creative_id",
    recordId: item.adId,
    asOf: fixture.asOfDate,
    version: fixture.contractVersion,
  });
  const blockers = item.blockerCodes.map((code) => ({
    code,
    label: blockerLabel(code),
    category: blockerCategory(code),
    provenance: sourceProvenance,
  }));
  const thumbnailUrl =
    row.thumbnail_url ?? row.image_url ?? row.card_preview_url ?? null;
  return {
    decisionId: `demo-decision-${item.adId}`,
    episodeId: `demo-episode-${item.adId}-${item.sourceLabel}`,
    episodeStartedAt: fixture.computedAt,
    providerAccountId: fixture.providerAccountId,
    identityGrain: "ad",
    sourceSnapshotId: snapshotId,
    sourceAuthority: {
      status: "demo_synthetic_review_only",
      actionEligible: false,
      reviewOnlyReason: DEMO_REVIEW_ONLY_REASON,
      snapshotId,
      evaluationId,
      inputHash: fixture.sourceInputHash,
      decisionHash: item.decisionHash,
      providerAccountRefId: fixture.providerAccountRefId,
      engineVersion: fixture.engineVersion,
      realAdId: item.adId,
      authorizedAction: null,
      jobRunId: fixture.jobRunId,
    },
    sourceDecision: {
      label: item.sourceLabel,
      preAuthorityLabel: item.preAuthorityLabel,
      authorityBlocker: item.authorityBlocker,
      rawLabel: item.rawLabel,
      reason: item.reason,
      confidence: item.confidence,
      confidenceBand:
        item.confidence >= 80
          ? "high"
          : item.confidence >= 60
            ? "medium"
            : "low",
      truthSource: item.truthSource,
      engineVersion: fixture.engineVersion,
      snapshotAsOf: fixture.asOfDate,
      computedAt: fixture.computedAt,
      badges: item.badges,
      provenance: sourceProvenance,
    },
    parentChain: {
      account: {
        id: fixture.providerAccountId,
        name: row.account_name ?? null,
      },
      campaign: {
        id: item.campaignId,
        name: row.campaign_name ?? null,
      },
      adset: {
        id: item.adsetId,
        name: row.adset_name ?? null,
      },
      ad: { id: item.adId, name: row.name ?? null },
      creative: { id: item.creativeId, name: row.name ?? null },
      provenance: identityProvenance,
    },
    identityResolution: {
      basis: "native_ad_exact",
      candidateAdCount: 1,
      metricsEquivalent: true,
      adActionEligible: false,
    },
    media: {
      state: thumbnailUrl ? "available" : "missing",
      missingMedia: thumbnailUrl ? false : true,
      thumbnail: {
        state: thumbnailUrl ? "available" : "missing",
        url: thumbnailUrl,
      },
      provenance: provenance({
        field: "thumbnail_url,image_url,card_preview_url",
        recordId: item.adId,
        asOf: fixture.asOfDate,
        version: fixture.contractVersion,
      }),
    },
    deliveryScope: {
      state: hierarchyActive
        ? "active"
        : hierarchyStatus
          ? "inactive"
          : "unknown",
      campaignStatus: hierarchyStatus,
      adsetStatus: hierarchyStatus,
      adStatus: hierarchyStatus,
      reason: hierarchyActive
        ? "active_hierarchy"
        : hierarchyStatus
          ? "hierarchy_not_active"
          : "hierarchy_status_unknown",
      provenance: identityProvenance,
    },
    classification: {
      overlayVersion: META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
      queueSection: "creative_rotation",
      lifecycleRole: {
        value: item.lifecycleRole,
        confidence: "high",
        trustedForAction: false,
        blockerCode: null,
        provenance: sourceProvenance,
      },
      assessment: {
        value: item.assessment,
        blockerCode: null,
        provenance: sourceProvenance,
      },
      decisionState: item.decisionState,
      heldAction: item.heldAction,
      legacyBuyerAction: item.buyerAction ?? "diagnose_data",
      buyerAction: item.buyerAction,
      buyerLabel: item.buyerLabel,
      executionAction: item.executionAction,
      resolution:
        item.decisionState === "blocked"
          ? {
              code: "review_demo_evidence",
              category: "system",
              owner: "operator",
              label: "Review synthetic decision evidence",
              nextStep:
                "Inspect the decision and evidence; demo rows can never execute.",
            }
          : null,
      blockers,
      provenance: sourceProvenance,
    },
    riskTier: null,
    confirmationCeremony: "highest",
    riskTierProvenance: {
      status: "proposed",
      reason: "risk_tier_producer_not_persisted",
    },
    promotionBasis: {
      status: "proposed",
      value: null,
      reason: "promotion_basis_not_persisted",
    },
    metrics: {
      spend: item.spend,
      purchases: item.purchases,
      roas: item.roas,
      recent7dRoas: item.recent7dRoas,
      effectiveTargetRoas: item.effectiveTargetRoas,
      ratioToTarget: item.ratioToTarget,
      currency: item.currency,
      attribution: "meta_attributed",
      provenance: provenance({
        field:
          "spend,purchases,roas,recent7d_roas,effective_target_roas,ratio_to_target,currency",
        recordId: item.adId,
        asOf: fixture.asOfDate,
        version: fixture.engineVersion,
      }),
    },
    exposure: {
      kind: "exposure_proxy",
      amount: item.spend,
      currency: item.currency,
      attribution: "meta_attributed",
      grain: "ad",
      provenance: sourceProvenance,
    },
    exposureUnavailableReason: null,
    history: {
      events: {
        status: "unavailable",
        reason: DEMO_REVIEW_ONLY_REASON,
        preCapCount: 0,
        items: [],
      },
      outcomes: {
        status: "unavailable",
        reason: DEMO_REVIEW_ONLY_REASON,
        items: [],
      },
      responses: {
        status: "unavailable",
        reason: DEMO_REVIEW_ONLY_REASON,
        items: [],
      },
      providerWrites: {
        status: "unavailable",
        reason: DEMO_REVIEW_ONLY_REASON,
      },
    },
  };
}

export function readDemoNativeCanonicalDecisionInventory(input: {
  businessId: string;
  providerAccountId: string;
  rows: readonly MetaCreativeApiRow[];
}): MetaNativeCanonicalDecisionInventory {
  const validation = validateDemoNativeCanonicalFixture({
    fixture: fixtureJson,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    rows: input.rows,
  });
  if (!validation.ok) {
    return {
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: validation.reason,
    };
  }
  const rowsByAdId = new Map(
    input.rows.map((row) => [String(row.real_ad_id ?? ""), row]),
  );
  const items = validation.fixture.items.map((item) =>
    buildSyntheticCanonicalDecision({
      fixture: validation.fixture,
      item,
      row: rowsByAdId.get(item.adId)!,
    }),
  );
  return {
    status: "available",
    generation: {
      jobRunId: validation.fixture.jobRunId,
      asOfDate: validation.fixture.asOfDate,
      providerAccountRefId: validation.fixture.providerAccountRefId,
      manifestHash: validation.fixture.manifestHash,
      expectedAdCount: validation.fixture.expectedAdCount,
    },
    items,
    unavailableReason: null,
  };
}
