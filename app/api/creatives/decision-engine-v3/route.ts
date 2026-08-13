import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  DECISION_BADGE_DISPLAY,
  NATIVE_AD_ENGINE_VERSION,
  type DecisionBadge,
  type DecisionLabel,
  type DecisionOutput,
  type TruthSource,
} from "@/lib/creative-decision-engine/types";
import {
  resolveEngineV3Flags,
  type EngineV3Flags,
} from "@/lib/creative-decision-engine/feature-flags";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import {
  readMetaNativeCanonicalDecisionInventory,
  type MetaNativeDecisionGeneration,
} from "@/lib/meta/decisions-workspace-read-model";

export const dynamic = "force-dynamic";

const NATIVE_AD_SERVING_CONTRACT_VERSION =
  "decision-engine-v3-native-ad-serving.v1" as const;

export interface NativeAdDecisionServingResponse {
  status: "available";
  contractVersion: typeof NATIVE_AD_SERVING_CONTRACT_VERSION;
  businessId: string;
  providerAccountId: string;
  asOf: string;
  engineVersion: string;
  dataSource: "native_persisted_generation";
  generation: Readonly<MetaNativeDecisionGeneration>;
  inventory: {
    preFilterCount: number;
    selectedCount: number;
    identityGrain: "ad";
    items: readonly MetaCanonicalDecision[];
  };
  /**
   * Transitional creative-grain display projection for Launchpad. It is
   * emitted only for a one-to-one creative -> Ad identity and carries no
   * provider-write authority. Exact-Ad serving authority remains `inventory`.
   */
  decisions: DecisionOutput[];
  compatibility: {
    authority: "review_only";
    omittedAmbiguousCreativeCount: number;
  };
  flags: EngineV3Flags;
}

export interface NativeAdDecisionDisabledResponse {
  status: "disabled";
  reason: "engine_v3_disabled_for_business";
  flags: EngineV3Flags;
  decisions?: undefined;
}

export type DecisionEngineV3ServingResponse =
  | NativeAdDecisionServingResponse
  | NativeAdDecisionDisabledResponse;

const DECISION_LABELS = new Set<DecisionLabel>([
  "scale",
  "keep",
  "refresh",
  "cut",
  "test_more",
  "diagnose",
  "out_of_scope",
]);

const TRUTH_SOURCES = new Set<TruthSource>([
  "commercial_truth",
  "commercial_truth_stale",
  "account_baseline",
  "account_baseline_thin",
  "global_default",
]);

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isSha256(value: string | null | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{64}$/.test(value));
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function canonicalItemIsExact(input: {
  decision: MetaCanonicalDecision;
  providerAccountId: string;
  generation: Readonly<MetaNativeDecisionGeneration>;
}): boolean {
  const { decision, generation } = input;
  const authority = decision.sourceAuthority;
  const adId = nonEmpty(decision.parentChain.ad?.id);
  return Boolean(
    decision.providerAccountId === input.providerAccountId &&
      decision.identityGrain === "ad" &&
      decision.identityResolution?.basis === "native_ad_exact" &&
      adId &&
      authority?.status === "native_exact" &&
      authority.realAdId === adId &&
      nonEmpty(authority.snapshotId) &&
      nonEmpty(authority.evaluationId) &&
      authority.providerAccountRefId === generation.providerAccountRefId &&
      authority.jobRunId === generation.jobRunId &&
      authority.engineVersion === decision.sourceDecision.engineVersion &&
      decision.sourceDecision.snapshotAsOf === generation.asOfDate &&
      isSha256(authority.inputHash) &&
      isSha256(authority.decisionHash),
  );
}

function sourceBadges(codes: readonly string[]): DecisionBadge[] {
  return codes.flatMap((code) => {
    const display = DECISION_BADGE_DISPLAY[code as DecisionBadge["type"]];
    return display
      ? [
          {
            type: code as DecisionBadge["type"],
            label: display.label,
            severity: display.severity,
          },
        ]
      : [];
  });
}

function projectNativeDecisionToCreativeReview(
  decision: MetaCanonicalDecision,
): DecisionOutput | null {
  const creative = decision.parentChain.creative;
  const label = decision.sourceDecision.label as DecisionLabel;
  const truthSource = decision.sourceDecision.truthSource as TruthSource;
  if (
    !creative?.id ||
    !DECISION_LABELS.has(label) ||
    !TRUTH_SOURCES.has(truthSource)
  ) {
    return null;
  }
  const confidence = finite(decision.sourceDecision.confidence);
  const effectiveTargetRoas = finite(decision.metrics.effectiveTargetRoas);
  const spend = finite(decision.metrics.spend);
  const purchases = finite(decision.metrics.purchases);
  if (
    confidence === null ||
    effectiveTargetRoas === null ||
    spend === null ||
    purchases === null
  ) {
    return null;
  }
  const lifecycleRole = decision.classification.lifecycleRole.value;
  const preAuthorityLabel = decision.sourceDecision.preAuthorityLabel;
  return {
    creativeId: creative.id,
    creativeName: creative.name,
    label,
    preAuthorityLabel: DECISION_LABELS.has(
      preAuthorityLabel as DecisionLabel,
    )
      ? (preAuthorityLabel as DecisionLabel)
      : label,
    authorityBlocker: decision.sourceDecision.authorityBlocker,
    reason: decision.sourceDecision.reason,
    confidence,
    truthSource,
    effectiveTargetRoas,
    ratioToTarget: finite(decision.metrics.ratioToTarget),
    badges: sourceBadges(decision.sourceDecision.badges),
    blockers: decision.classification.blockers.map((blocker) => ({
      predicate: blocker.code,
      observed: null,
      threshold: null,
      status: "missing",
      severity: "warning",
      reason: blocker.label,
    })),
    metrics: {
      spend,
      purchases,
      roas: finite(decision.metrics.roas),
      recent7dRoas: finite(decision.metrics.recent7dRoas),
    },
    campaignLabelStatus: decision.parentChain.campaign
      ? lifecycleRole === "label_needed"
        ? "unlabeled"
        : "labeled"
      : "no_campaign",
    campaignKind:
      lifecycleRole === "main" ||
      lifecycleRole === "test" ||
      lifecycleRole === "mixed"
        ? lifecycleRole
        : null,
    blockedActionType: decision.classification.heldAction,
    engineVersion: decision.sourceDecision.engineVersion,
    generatedAt: decision.sourceDecision.computedAt,
  };
}

function creativeReviewProjection(input: {
  fullInventory: readonly MetaCanonicalDecision[];
  selectedItems: readonly MetaCanonicalDecision[];
}): { decisions: DecisionOutput[]; omittedAmbiguousCreativeCount: number } {
  const counts = new Map<string, number>();
  for (const decision of input.fullInventory) {
    const creativeId = nonEmpty(decision.parentChain.creative?.id);
    if (creativeId) counts.set(creativeId, (counts.get(creativeId) ?? 0) + 1);
  }
  const ambiguousCreativeIds = new Set(
    [...counts.entries()]
      .filter(([, count]) => count !== 1)
      .map(([creativeId]) => creativeId),
  );
  return {
    decisions: input.selectedItems.flatMap((decision) => {
      const creativeId = nonEmpty(decision.parentChain.creative?.id);
      if (!creativeId || ambiguousCreativeIds.has(creativeId)) return [];
      const projected = projectNativeDecisionToCreativeReview(decision);
      return projected ? [projected] : [];
    }),
    omittedAmbiguousCreativeCount: ambiguousCreativeIds.size,
  };
}

function requestedIds(value: string | null): Set<string> | null {
  if (!value) return null;
  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? new Set(values) : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const businessId = nonEmpty(url.searchParams.get("businessId"));
  const providerAccountId = nonEmpty(
    url.searchParams.get("providerAccountId"),
  );
  const creativeIds = requestedIds(url.searchParams.get("creativeIds"));
  const campaignId = nonEmpty(url.searchParams.get("campaignId"));
  const asOf = nonEmpty(url.searchParams.get("asOf")) ?? undefined;

  if (!businessId) {
    return NextResponse.json({ error: "businessId required" }, { status: 400 });
  }
  if (!providerAccountId) {
    return NextResponse.json(
      { error: "providerAccountId required" },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  const resolvedBusinessId = access.membership.businessId;

  const flags = await resolveEngineV3Flags(resolvedBusinessId);
  if (!flags.enabled) {
    return NextResponse.json(
      {
        status: "disabled",
        reason: "engine_v3_disabled_for_business",
        flags: { ...flags },
      } satisfies NativeAdDecisionDisabledResponse,
      { status: 200 },
    );
  }

  const inventory = await readMetaNativeCanonicalDecisionInventory({
    businessId: resolvedBusinessId,
    providerAccountId,
    asOfDate: asOf,
    creativeIds: creativeIds ? [...creativeIds] : undefined,
  });
  if (inventory.status === "unavailable") {
    return NextResponse.json(
      {
        status: "unavailable",
        reason: inventory.unavailableReason,
        businessId: resolvedBusinessId,
        providerAccountId,
      },
      { status: 409 },
    );
  }
  if (
    inventory.items.some(
      (decision) =>
        !canonicalItemIsExact({
          decision,
          providerAccountId,
          generation: inventory.generation,
        }),
    )
  ) {
    return NextResponse.json(
      {
        status: "unavailable",
        reason: "native_canonical_serving_projection_invalid",
        businessId: resolvedBusinessId,
        providerAccountId,
      },
      { status: 409 },
    );
  }

  const selectedItems = inventory.items.filter((decision) => {
    if (
      creativeIds &&
      !creativeIds.has(decision.parentChain.creative?.id ?? "")
    ) {
      return false;
    }
    if (campaignId && decision.parentChain.campaign?.id !== campaignId) {
      return false;
    }
    return true;
  });
  const review = creativeReviewProjection({
    fullInventory: inventory.items,
    selectedItems,
  });
  const response: NativeAdDecisionServingResponse = {
    status: "available",
    contractVersion: NATIVE_AD_SERVING_CONTRACT_VERSION,
    businessId: resolvedBusinessId,
    providerAccountId,
    asOf: inventory.generation.asOfDate,
    engineVersion:
      inventory.items[0]?.sourceDecision.engineVersion ?? NATIVE_AD_ENGINE_VERSION,
    dataSource: "native_persisted_generation",
    generation: inventory.generation,
    inventory: {
      preFilterCount: inventory.generation.expectedAdCount,
      selectedCount: selectedItems.length,
      identityGrain: "ad",
      items: selectedItems,
    },
    decisions: review.decisions,
    compatibility: {
      authority: "review_only",
      omittedAmbiguousCreativeCount: review.omittedAmbiguousCreativeCount,
    },
    flags,
  };
  return NextResponse.json(response);
}
