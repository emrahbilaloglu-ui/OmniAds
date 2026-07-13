import type { DecisionLabel } from "@/components/common/briefing/types";
import type { LaunchpadOverlayMode } from "@/components/common/briefing/LaunchpadOverlay";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import { asDecisionLabel, cardName } from "@/components/creatives/briefing/card-utils";
import {
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  createDecisionOriginAdActionIdempotencyKey,
  runDecisionOriginAdExecutionPreflight,
  validateDecisionOriginAdExecutionRequest,
  type DecisionOriginAdAction,
  type DecisionOriginAdExecutionEvidence,
  type DecisionOriginAdExecutionPreflightResult,
  type DecisionOriginAdExecutionRequest,
} from "@/lib/creative-decision-engine/execution-safety";

export interface BriefingToastLink {
  href: string;
  label: string;
}

export interface BriefingToast {
  type: "success" | "error" | "info";
  message: string;
  link?: BriefingToastLink | null;
}

export interface PauseBriefingCardResult {
  ok: boolean;
  action?: string;
  adId?: string | null;
  status?: string | null;
  dryRun?: boolean;
  adsManagerUrl?: string | null;
  attemptedIds?: string[];
}

type FetchLike = typeof fetch;

export interface DecisionOriginBriefingCard extends BriefingCreativeCard {
  sourceDecisionEvaluationId?: string | null;
  sourceDecisionHash?: string | null;
}

export interface DecisionOriginAdActionHandlerResult<T> {
  preflight: DecisionOriginAdExecutionPreflightResult;
  providerResult: T | null;
}

export function getCreativeScopeId(card: BriefingCreativeCard) {
  return card.creativeId?.trim() || card.id;
}

function nonEmptyId(value: string | null | undefined) {
  const id = value?.trim();
  return id ? id : null;
}

function uniqueIds(ids: Array<string | null | undefined>) {
  const seen = new Set<string>();
  return ids.flatMap((id) => {
    const normalized = nonEmptyId(id);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

export function getManualBriefingAdActionCandidateIds(card: BriefingCreativeCard) {
  return uniqueIds([
    card.realAdId,
    card.metaAdId,
    card.effectiveAdId,
    card.adId,
    card.creativeId,
    card.id,
  ]);
}

export function getBriefingAdActionInputId(card: BriefingCreativeCard) {
  return nonEmptyId(card.realAdId) ?? "";
}

export function buildBriefingDecisionOriginAdActionRequest(input: {
  businessId: string;
  card: DecisionOriginBriefingCard;
  action: DecisionOriginAdAction;
  idempotencyKey?: string;
  dryRun?: boolean;
}): DecisionOriginAdExecutionRequest {
  const requestBase = {
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: input.businessId.trim(),
    providerAccountId: input.card.providerAccountId?.trim() ?? "",
    adId: getBriefingAdActionInputId(input.card),
    snapshotId:
      input.card.sourceDecisionSnapshotMatch === "matched"
        ? input.card.sourceDecisionSnapshotId?.trim() ?? ""
        : "",
    evaluationId: input.card.sourceDecisionEvaluationId?.trim() ?? "",
    engineVersion:
      input.card.sourceDecisionSnapshotEngineVersion?.trim() ?? "",
    decisionHash: input.card.sourceDecisionHash?.trim() ?? "",
    action: input.action,
    creativeId: nonEmptyId(input.card.creativeId),
    ...(input.dryRun === true ? { dryRun: true } : {}),
  };
  const request: DecisionOriginAdExecutionRequest = {
    ...requestBase,
    idempotencyKey:
      input.idempotencyKey?.trim() ||
      createDecisionOriginAdActionIdempotencyKey(requestBase),
  };
  const blockers = validateDecisionOriginAdExecutionRequest(request);
  if (blockers.length > 0) {
    throw new Error(
      `Decision-origin ad execution blocked (${blockers.join(", ")}).`,
    );
  }
  return request;
}

export async function executeDecisionOriginAdActionWithPreflight<T>(input: {
  request: DecisionOriginAdExecutionRequest;
  rereadEvidence: (
    request: DecisionOriginAdExecutionRequest,
  ) => Promise<DecisionOriginAdExecutionEvidence>;
  mutateProvider: (request: DecisionOriginAdExecutionRequest) => Promise<T>;
  now?: Date;
}): Promise<DecisionOriginAdActionHandlerResult<T>> {
  const preflight = await runDecisionOriginAdExecutionPreflight({
    request: input.request,
    rereadEvidence: input.rereadEvidence,
    now: input.now,
  });
  if (!preflight.shouldMutate) {
    return { preflight, providerResult: null };
  }
  return {
    preflight,
    providerResult: await input.mutateProvider(input.request),
  };
}

export function isCutPrimaryAction(card: BriefingCreativeCard) {
  const primaryKind = card.primary?.kind?.trim().toLowerCase();
  const primaryLabel = card.primary?.label?.trim().toLowerCase();
  const label = asDecisionLabel(card.label) as DecisionLabel;
  return (
    primaryKind === "cut" ||
    primaryKind === "pause" ||
    primaryKind?.includes("pause") ||
    primaryLabel === "cut" ||
    primaryLabel?.includes("pause") ||
    (!primaryKind && label === "cut")
  );
}

function isAdNotFoundResponse(payload: { error?: { code?: string } } | null) {
  return payload?.error?.code === "ad_not_found";
}

export function metaAdActionFailureMessage(
  payload: { error?: { code?: string; message?: string }; message?: string } | null,
  status: number,
) {
  if (payload?.error?.code === "kill_switch_engaged") {
    return "Meta writes are temporarily disabled (kill switch). Try again later.";
  }
  return payload?.error?.message ?? payload?.message ?? `Pause failed (${status})`;
}

export function buildMetaAdsManagerUrlForBriefingCard(
  card: BriefingCreativeCard,
  resolvedAdId?: string | null,
) {
  const accountId = (
    card.providerAccountId ||
    card.accountId ||
    card.metaAccountId ||
    ""
  )
    .replace(/^act_/, "")
    .trim();
  const adId = (
    resolvedAdId ||
    card.realAdId ||
    card.adId ||
    card.metaAdId ||
    card.effectiveAdId ||
    ""
  ).trim();
  if (!accountId || !adId) return null;
  const params = new URLSearchParams({
    act: accountId,
    selected_ad_ids: adId,
  });
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?${params.toString()}`;
}

export function buildCutSuccessToast(
  card: BriefingCreativeCard,
  result: PauseBriefingCardResult,
): BriefingToast {
  if (result.dryRun) {
    return {
      type: "info",
      message: `Dry run completed · ${cardName(card)}`,
      link: null,
    };
  }
  return {
    type: "success",
    message: `Cut applied · ${cardName(card)}`,
    link: buildMetaAdsManagerUrlForBriefingCard(card, result.adId) ?
      {
        href: buildMetaAdsManagerUrlForBriefingCard(card, result.adId)!,
        label: "Open in Meta",
      }
      : null,
  };
}

export function buildLaunchpadOpenToast(mode: LaunchpadOverlayMode): BriefingToast {
  return {
    type: "info",
    message: `Launchpad bridge opened · ${mode.replace(/_/g, " ")}`,
  };
}

export async function pauseBriefingCard(input: {
  businessId: string;
  card: DecisionOriginBriefingCard;
  idempotencyKey?: string;
  dryRun?: boolean;
  fetchImpl?: FetchLike;
}): Promise<PauseBriefingCardResult> {
  if (!isCutPrimaryAction(input.card)) {
    throw new Error("This card does not carry a server-authorized cut action.");
  }
  const request = buildBriefingDecisionOriginAdActionRequest({
    businessId: input.businessId,
    card: input.card,
    action: "pause",
    idempotencyKey: input.idempotencyKey,
    dryRun: input.dryRun,
  });
  const fetcher = input.fetchImpl ?? fetch;
  const response = await fetcher(
    `/api/meta/ads/${encodeURIComponent(request.adId)}/pause`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify(request),
    },
  );
  const payload = (await response.json().catch(() => null)) as
    | (PauseBriefingCardResult & { error?: { code?: string; message?: string } })
    | null;
  if (response.ok && payload?.ok) {
    return { ...payload, attemptedIds: [request.adId] };
  }
  throw new Error(metaAdActionFailureMessage(payload, response.status));
}

/** Explicit compatibility path for operator-selected legacy cards only. */
export async function pauseBriefingCardManualLegacy(input: {
  businessId: string;
  card: BriefingCreativeCard;
  fetchImpl?: FetchLike;
}): Promise<PauseBriefingCardResult> {
  const candidateIds = getManualBriefingAdActionCandidateIds(input.card);
  if (candidateIds.length === 0) {
    throw new Error("No actionable Meta ad id was available for this creative.");
  }
  const fetcher = input.fetchImpl ?? fetch;
  const attemptedIds: string[] = [];
  let lastMessage = "Pause failed.";
  for (const targetId of candidateIds) {
    attemptedIds.push(targetId);
    const response = await fetcher(
      `/api/meta/ads/${encodeURIComponent(targetId)}/pause`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({
          businessId: input.businessId,
          resolutionMode: "manual_legacy",
          recIdOrigin: getCreativeScopeId(input.card),
        }),
      },
    );
    const payload = (await response.json().catch(() => null)) as
      | (PauseBriefingCardResult & { error?: { code?: string; message?: string } })
      | null;
    if (response.ok && payload?.ok) {
      return { ...payload, attemptedIds };
    }
    const message = metaAdActionFailureMessage(payload, response.status);
    lastMessage = message;
    if (!isAdNotFoundResponse(payload)) throw new Error(message);
  }
  throw new Error(`${lastMessage} Tried ${attemptedIds.join(", ")}.`);
}
