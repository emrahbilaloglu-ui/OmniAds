import type {
  BriefingCanonicalNativeAdDecision,
  BriefingCreativeCard,
  BriefingPrimaryAction,
  CreativeDecisionCenterRowDecision,
} from "@/components/creatives/briefing/types";
import {
  DECISION_BADGE_DISPLAY,
  type DecisionBadge,
  type DecisionLabel,
  type DecisionOutput,
  type TruthSource,
} from "@/lib/creative-decision-engine/types";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import {
  isExactActiveMetaDecisionDeliveryScope,
  type MetaCanonicalDecision,
} from "@/lib/meta/decisions-workspace-contract";

export const BRIEFING_CANONICAL_NATIVE_AD_CONTRACT_VERSION =
  "briefing-canonical-native-ad.v1" as const;

export type CanonicalBriefingLane = "action" | "watching" | "healthy";

export interface CanonicalBriefingProjection {
  card: BriefingCreativeCard;
  decisionCenterRow: CreativeDecisionCenterRowDecision | null;
  presentationDecision: DecisionOutput;
  lane: CanonicalBriefingLane;
}

type CreativeDecisionCenterBuyerAction =
  CreativeDecisionCenterRowDecision["buyerAction"];
type CreativeDecisionCenterProblemClass =
  CreativeDecisionCenterRowDecision["engine"]["problemClass"];

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

function nonEmpty(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function sha256(value: string | null | undefined) {
  return Boolean(value && /^[a-f0-9]{64}$/i.test(value));
}

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sourceBadge(code: string): DecisionBadge | null {
  const display = DECISION_BADGE_DISPLAY[code as DecisionBadge["type"]];
  return display
    ? {
        type: code as DecisionBadge["type"],
        label: display.label,
        severity: display.severity,
      }
    : null;
}

function decisionLabel(value: string | null | undefined) {
  return DECISION_LABELS.has(value as DecisionLabel)
    ? (value as DecisionLabel)
    : null;
}

function truthSource(value: string): TruthSource | null {
  return TRUTH_SOURCES.has(value as TruthSource)
    ? (value as TruthSource)
    : null;
}

function exactRowForAd(
  row: MetaCreativeApiRow | null | undefined,
  adId: string,
) {
  if (!row) return null;
  const rowAdId = nonEmpty(row.real_ad_id);
  return rowAdId === adId ? row : null;
}

function hierarchyReviewOnlyReason(decision: MetaCanonicalDecision) {
  const scope = decision.deliveryScope;
  const statuses = [
    scope?.campaignStatus,
    scope?.adsetStatus,
    scope?.adStatus,
  ];
  return statuses.some(
    (status) =>
      typeof status === "string" &&
      status.trim() !== "" &&
      status.trim().toUpperCase() !== "ACTIVE",
  )
    ? "current_hierarchy_is_not_active"
    : "current_hierarchy_status_is_unknown";
}

function withExactActiveHierarchyAuthority(
  decision: MetaCanonicalDecision,
): MetaCanonicalDecision {
  const authority = decision.sourceAuthority;
  if (!nonEmpty(decision.parentChain.creative?.id)) {
    return {
      ...decision,
      identityResolution: decision.identityResolution
        ? {
            ...decision.identityResolution,
            adActionEligible: false,
          }
        : decision.identityResolution,
      sourceAuthority: authority
        ? {
            ...authority,
            actionEligible: false,
            authorizedAction: null,
            reviewOnlyReason: "current_creative_identity_is_missing",
          }
        : authority,
    };
  }
  if (!authority) return decision;
  const exactActiveHierarchy = isExactActiveMetaDecisionDeliveryScope(
    decision.deliveryScope,
  );
  if (
    exactActiveHierarchy ||
    (!authority.actionEligible && authority.authorizedAction === null)
  ) {
    return decision;
  }
  return {
    ...decision,
    sourceAuthority: {
      ...authority,
      actionEligible: false,
      authorizedAction: null,
      reviewOnlyReason: hierarchyReviewOnlyReason(decision),
    },
  };
}

function canonicalPrimaryAction(
  decision: MetaCanonicalDecision,
): BriefingPrimaryAction {
  const authority = decision.sourceAuthority!;
  if (!authority.actionEligible) {
    if (decision.classification.heldAction === "cut") {
      if (decision.classification.resolution?.code === "refresh_decision_data") {
        return { kind: "review", label: "Refresh recent evidence" };
      }
      if (decision.classification.resolution?.code === "await_recent_evidence") {
        return { kind: "review", label: "Await recent evidence" };
      }
      return { kind: "review", label: "Cut pending — evidence review" };
    }
    if (decision.classification.heldAction === "scale") {
      return { kind: "review", label: "Scale pending — evidence review" };
    }
    if (decision.classification.heldAction === "refresh") {
      return { kind: "review", label: "Refresh pending — evidence review" };
    }
    return { kind: "review", label: "Open canonical evidence" };
  }
  if (authority.authorizedAction === "cut") {
    return { kind: "cut", label: "Cut" };
  }
  if (authority.authorizedAction === "refresh") {
    return { kind: "review", label: "Review refresh evidence" };
  }
  if (authority.authorizedAction === "scale") {
    return { kind: "review", label: "Review scale evidence" };
  }
  return { kind: "review", label: "Open canonical evidence" };
}

function canonicalLane(
  decision: MetaCanonicalDecision,
  deferred: boolean,
): CanonicalBriefingLane {
  if (deferred) return "watching";
  // The exact-Ad Cut route is currently the only canonical briefing action
  // with a provider-validated execution handoff. Scale/Refresh remain exact
  // persisted decisions, but presenting them as Action Now would overstate
  // UI operability until their full lineage tuple is validated by an executor.
  if (
    decision.sourceAuthority?.actionEligible &&
    decision.sourceAuthority.authorizedAction === "cut"
  ) {
    return "action";
  }
  if (
    decision.classification.decisionState === "monitor" &&
    decision.sourceDecision.label === "keep"
  ) {
    return "healthy";
  }
  return "watching";
}

function primaryDecision(
  buyerAction: CreativeDecisionCenterBuyerAction,
): CreativeDecisionCenterRowDecision["engine"]["primaryDecision"] {
  if (buyerAction === "scale") return "Scale";
  if (buyerAction === "cut") return "Cut";
  if (buyerAction === "refresh") return "Refresh";
  if (buyerAction === "protect") return "Protect";
  if (buyerAction === "test_more" || buyerAction === "watch_launch") {
    return "Test More";
  }
  return "Diagnose";
}

function problemClass(
  decision: MetaCanonicalDecision,
): CreativeDecisionCenterProblemClass {
  const category = decision.classification.resolution?.category;
  if (category === "campaign_context") return "campaign_context";
  if (category === "delivery") return "delivery";
  if (category === "policy") return "policy";
  if (category === "tracking" || category === "data") return "data_quality";
  if (category === "funnel") return "creative";
  return "performance";
}

function priorityForConfidence(
  band: MetaCanonicalDecision["sourceDecision"]["confidenceBand"],
): CreativeDecisionCenterRowDecision["priority"] {
  return band === "high" ? "high" : band === "medium" ? "medium" : "low";
}

function legacyDecisionCenterRow(
  decision: MetaCanonicalDecision,
  adId: string,
): CreativeDecisionCenterRowDecision | null {
  const buyerAction = decision.classification.buyerAction;
  const creativeId = nonEmpty(decision.parentChain.creative?.id);
  if (!buyerAction || !creativeId) return null;
  const blockers = decision.classification.blockers.map((blocker) => blocker.code);
  const directlyExecutable =
    decision.sourceAuthority?.actionEligible === true &&
    decision.sourceAuthority.authorizedAction === "cut";
  return {
    scope: "creative",
    creativeId,
    rowId: adId,
    identityGrain: "ad",
    familyId: null,
    engine: {
      contractVersion: "creative-decision-os.v2.1",
      engineVersion: decision.sourceDecision.engineVersion,
      primaryDecision: primaryDecision(buyerAction),
      actionability: directlyExecutable
        ? "direct"
        : decision.classification.decisionState === "blocked"
          ? "blocked"
          : "review_only",
      problemClass: problemClass(decision),
      confidence: decision.sourceDecision.confidence,
      maturity:
        decision.classification.decisionState === "act"
          ? "actionable"
          : decision.classification.decisionState === "monitor"
            ? "mature"
            : "learning",
      priority: priorityForConfidence(decision.sourceDecision.confidenceBand),
      reasonTags: [...decision.sourceDecision.badges, ...blockers],
      evidenceSummary: decision.sourceDecision.reason,
      blockerReasons: blockers,
      missingData: blockers,
      queueEligible: false,
      applyEligible: false,
    },
    buyerAction,
    buyerLabel: decision.classification.buyerLabel,
    uiBucket: buyerAction,
    executionAction: decision.classification.executionAction,
    sourceDecision: `native:${decision.sourceDecision.label}`,
    confidenceBand: decision.sourceDecision.confidenceBand,
    priority: priorityForConfidence(decision.sourceDecision.confidenceBand),
    oneLine: decision.sourceDecision.reason,
    reasons: [decision.sourceDecision.reason],
    nextStep:
      decision.classification.resolution?.nextStep ??
      decision.classification.buyerLabel,
    missingData: blockers,
  };
}

function presentationDecision(
  decision: MetaCanonicalDecision,
): DecisionOutput | null {
  const label = decisionLabel(decision.sourceDecision.label);
  const sourceTruth = truthSource(decision.sourceDecision.truthSource);
  const effectiveTargetRoas = finite(decision.metrics.effectiveTargetRoas);
  const spend = finite(decision.metrics.spend);
  const purchases = finite(decision.metrics.purchases);
  if (
    !label ||
    !sourceTruth ||
    effectiveTargetRoas === null ||
    spend === null ||
    purchases === null
  ) {
    return null;
  }
  const preAuthorityLabel =
    decisionLabel(decision.sourceDecision.preAuthorityLabel) ?? label;
  const lifecycle = decision.classification.lifecycleRole.value;
  return {
    creativeId: decision.parentChain.creative?.id ?? decision.parentChain.ad!.id,
    creativeName:
      decision.parentChain.creative?.name ?? decision.parentChain.ad?.name ?? null,
    label,
    reason: decision.sourceDecision.reason,
    confidence: decision.sourceDecision.confidence,
    truthSource: sourceTruth,
    effectiveTargetRoas,
    ratioToTarget: finite(decision.metrics.ratioToTarget),
    badges: decision.sourceDecision.badges.flatMap((code) => {
      const badge = sourceBadge(code);
      return badge ? [badge] : [];
    }),
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
      ? lifecycle === "label_needed"
        ? "unlabeled"
        : "labeled"
      : "no_campaign",
    campaignKind:
      lifecycle === "main" || lifecycle === "test" || lifecycle === "mixed"
        ? lifecycle
        : null,
    preAuthorityLabel,
    authorityBlocker: decision.sourceDecision.authorityBlocker,
    blockedActionType: decision.classification.heldAction,
    labelTransform: null,
    engineVersion: decision.sourceDecision.engineVersion,
    generatedAt: decision.sourceDecision.computedAt,
  };
}

export function projectCanonicalNativeAdDecisionToBriefing(input: {
  decision: MetaCanonicalDecision;
  row?: MetaCreativeApiRow | null;
  deferred?: boolean;
}): CanonicalBriefingProjection | null {
  const decision = withExactActiveHierarchyAuthority(input.decision);
  const authority = decision.sourceAuthority;
  const adId = nonEmpty(decision.parentChain.ad?.id);
  const creativeId = nonEmpty(decision.parentChain.creative?.id);
  const nativeAuthority = authority?.status === "native_exact";
  const syntheticReviewAuthority =
    authority?.status === "demo_synthetic_review_only" &&
    authority.actionEligible === false &&
    authority.authorizedAction === null &&
    authority.reviewOnlyReason === "demo_synthetic_review_only" &&
    decision.identityResolution?.adActionEligible === false;
  const exactNativeActionTuple =
    nativeAuthority &&
    authority.actionEligible === true &&
    authority.reviewOnlyReason === null &&
    decision.classification.decisionState === "act" &&
    decision.classification.heldAction === null &&
    decision.sourceDecision.authorityBlocker === null &&
    decision.identityResolution?.adActionEligible === true &&
    creativeId !== null &&
    decision.sourceSnapshotId === authority.snapshotId &&
    authority.authorizedAction !== null &&
    authority.authorizedAction === decision.classification.buyerAction;
  if (
    decision.identityGrain !== "ad" ||
    decision.identityResolution?.basis !== "native_ad_exact" ||
    (!nativeAuthority && !syntheticReviewAuthority) ||
    !adId ||
    authority.realAdId !== adId ||
    decision.providerAccountId !== nonEmpty(decision.providerAccountId) ||
    !nonEmpty(authority.snapshotId) ||
    !nonEmpty(authority.evaluationId) ||
    !nonEmpty(authority.providerAccountRefId) ||
    !nonEmpty(authority.jobRunId) ||
    !sha256(authority.inputHash) ||
    !sha256(authority.decisionHash) ||
    authority.engineVersion !== decision.sourceDecision.engineVersion ||
    (nativeAuthority && decision.sourceSnapshotId !== authority.snapshotId) ||
    (authority.actionEligible ? !exactNativeActionTuple : authority.authorizedAction !== null)
  ) {
    return null;
  }
  const present = presentationDecision(decision);
  if (!present) return null;
  const authorityStatus = nativeAuthority
    ? "native_exact"
    : "demo_synthetic_review_only";
  const row = exactRowForAd(input.row, adId);
  const decisionCenterRow = legacyDecisionCenterRow(decision, adId);
  const persistedPendingTransition =
    decision.sourceDecision.badges.includes("pending_transition") &&
    Boolean(
      nonEmpty(decision.sourceDecision.rawLabel) &&
        decision.sourceDecision.rawLabel !== decision.sourceDecision.label,
    );
  const sourceAuthority: BriefingCanonicalNativeAdDecision["sourceAuthority"] = {
    status: authorityStatus,
    snapshotId: authority.snapshotId,
    evaluationId: authority.evaluationId!,
    inputHash: authority.inputHash!,
    decisionHash: authority.decisionHash!,
    engineVersion: authority.engineVersion,
    providerAccountRefId: authority.providerAccountRefId!,
    providerAccountId: decision.providerAccountId,
    realAdId: adId,
    jobRunId: authority.jobRunId!,
    authorizedAction: authority.authorizedAction,
    actionEligible: authority.actionEligible,
    reviewOnlyReason: authority.reviewOnlyReason,
  };
  const canonical: BriefingCanonicalNativeAdDecision = {
    contractVersion: BRIEFING_CANONICAL_NATIVE_AD_CONTRACT_VERSION,
    identityGrain: "ad",
    decisionId: decision.decisionId,
    episodeId: decision.episodeId,
    sourceSnapshotId: decision.sourceSnapshotId,
    adId,
    creativeId,
    identityResolution: {
      basis: "native_ad_exact",
      adActionEligible:
        decision.identityResolution?.adActionEligible === true,
    },
    classification: {
      decisionState: decision.classification.decisionState,
      buyerAction: decision.classification.buyerAction,
      buyerLabel: decision.classification.buyerLabel,
      executionAction: decision.classification.executionAction,
      heldAction: decision.classification.heldAction,
    },
    sourceDecision: {
      label: decision.sourceDecision.label,
      authorityBlocker: decision.sourceDecision.authorityBlocker,
      confidence: decision.sourceDecision.confidence,
      reason: decision.sourceDecision.reason,
      snapshotAsOf: decision.sourceDecision.snapshotAsOf,
      computedAt: decision.sourceDecision.computedAt,
    },
    sourceAuthority,
  };
  const primary = canonicalPrimaryAction(decision);
  const card: BriefingCreativeCard = {
    id: adId,
    adId,
    realAdId: adId,
    effectiveAdId: adId,
    accountId: decision.providerAccountId,
    providerAccountId: decision.providerAccountId,
    creativeId: decision.parentChain.creative?.id ?? null,
    creativeName:
      decision.parentChain.creative?.name ?? decision.parentChain.ad?.name ?? null,
    name:
      decision.parentChain.ad?.name ??
      decision.parentChain.creative?.name ??
      adId,
    campaign:
      decision.parentChain.campaign?.name ??
      decision.parentChain.campaign?.id ??
      null,
    campaignName: decision.parentChain.campaign?.name ?? null,
    adset:
      decision.parentChain.adset?.name ?? decision.parentChain.adset?.id ?? null,
    adsetName: decision.parentChain.adset?.name ?? null,
    label: present.label,
    truthSource: present.truthSource,
    preAuthorityLabel: present.preAuthorityLabel,
    authorityBlocker: present.authorityBlocker,
    rawLabel: decision.sourceDecision.rawLabel,
    pendingTransition: persistedPendingTransition,
    currency: decision.metrics.currency,
    badges: [...decision.sourceDecision.badges],
    blockers: present.blockers ?? null,
    confidence: decision.sourceDecision.confidence,
    reason: decision.sourceDecision.reason,
    targetRoas: finite(decision.metrics.effectiveTargetRoas),
    ratioToTarget: finite(decision.metrics.ratioToTarget),
    spend: finite(decision.metrics.spend),
    purchases: finite(decision.metrics.purchases),
    roas: finite(decision.metrics.roas),
    impressions: finite(row?.impressions),
    linkClicks: finite(row?.link_clicks),
    addToCart: finite(row?.add_to_cart),
    ctr: finite(row?.ctr_all),
    cpa: finite(row?.cpa),
    frequency: finite(row?.frequency),
    sparkline: [
      finite(decision.metrics.recent7dRoas) ?? 0,
      finite(decision.metrics.roas) ?? 0,
    ],
    primary,
    ...(decisionCenterRow ? { decisionCenterRow } : {}),
    status:
      decision.deliveryScope?.adStatus ?? row?.effective_status ?? null,
    campaignKind:
      present.campaignKind === "main" ||
      present.campaignKind === "test" ||
      present.campaignKind === "mixed"
        ? present.campaignKind
        : null,
    campaignLabelStatus: present.campaignLabelStatus,
    blockedActionType: decision.classification.heldAction,
    engineVersion: decision.sourceDecision.engineVersion,
    sourceAsOf: decision.sourceDecision.snapshotAsOf,
    sourceDataSource: "native_ad_generation",
    mediaPreviewUrl:
      row?.card_preview_url ??
      row?.image_url ??
      row?.preview_url ??
      decision.media.thumbnail.url,
    thumbnailUrl: row?.thumbnail_url ?? decision.media.thumbnail.url,
    tableThumbnailUrl:
      row?.table_thumbnail_url ?? row?.thumbnail_url ?? decision.media.thumbnail.url,
    cardPreviewUrl:
      row?.card_preview_url ??
      row?.image_url ??
      row?.thumbnail_url ??
      decision.media.thumbnail.url,
    previewUrl: row?.preview_url ?? null,
    imageUrl: row?.image_url ?? null,
    cachedThumbnailUrl: row?.cached_thumbnail_url ?? null,
    preview: row?.preview ?? null,
    previewState: row?.preview_state ?? (decision.media.state === "available" ? "preview" : "unavailable"),
    isCatalog: row?.is_catalog ?? false,
    format: row?.format ?? null,
    creativeDeliveryType: row?.creative_delivery_type ?? null,
    creativeVisualFormat: row?.creative_visual_format ?? null,
    creativePrimaryType: row?.creative_primary_type ?? null,
    creativePrimaryLabel: row?.creative_primary_label ?? null,
    creativeSecondaryType: row?.creative_secondary_type ?? null,
    creativeSecondaryLabel: row?.creative_secondary_label ?? null,
    taxonomySource: row?.taxonomy_source ?? null,
    taxonomyReconciledByVideoEvidence:
      row?.taxonomy_reconciled_by_video_evidence ?? null,
    sourceDecisionSnapshotId: authority.snapshotId,
    sourceDecisionSnapshotAsOf: decision.sourceDecision.snapshotAsOf,
    sourceDecisionSnapshotEngineVersion: authority.engineVersion,
    sourceDecisionSnapshotMatch: "matched",
    sourceDecisionAuthorityStatus: authorityStatus,
    sourceDecisionEvaluationId: authority.evaluationId,
    sourceDecisionInputHash: authority.inputHash,
    sourceDecisionHash: authority.decisionHash,
    sourceDecisionProviderAccountRefId: authority.providerAccountRefId,
    sourceDecisionJobRunId: authority.jobRunId,
    sourceDecisionAuthorizedAction: authority.authorizedAction,
    sourceDecisionActionEligible: authority.actionEligible,
    canonicalDecision: canonical,
  };
  return {
    card,
    decisionCenterRow,
    presentationDecision: present,
    lane: canonicalLane(decision, input.deferred === true),
  };
}
