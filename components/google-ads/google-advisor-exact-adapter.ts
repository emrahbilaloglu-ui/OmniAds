import type {
  GoogleAdvisorActionCard,
  GoogleAdvisorActionListBlock,
  GoogleAdvisorResponse,
  GoogleRecommendation,
} from "@/lib/google-ads/growth-advisor-types";

const EMPTY = "—";
const ACTION_CONTRACT_VERSION = "google_ads_advisor_action_v2";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

export type GoogleAdvisorExactTone =
  | "default"
  | "primary"
  | "danger"
  | "muted";

export type GoogleAdvisorExactModeTone =
  | "positive"
  | "primary"
  | "automatic"
  | "danger"
  | "neutral";

export interface GoogleAdvisorExactIdentity {
  accountId?: string | null;
  currencyCode?: string | null;
  windowLabel?: string | null;
  syncLabel?: string | null;
}

export interface GoogleAdvisorExactTileViewModel {
  key: "do-now" | "do-next" | "blocked" | "applied-30d";
  label: string;
  value: string;
  sub: string;
}

export interface GoogleAdvisorExactChangeViewModel {
  label: string;
  items: string[];
  tone: GoogleAdvisorExactTone;
}

export interface GoogleAdvisorExactCardViewModel {
  id: string;
  recommendation: GoogleRecommendation;
  bucket: string;
  bucketTone: "now" | "next" | "blocked" | "neutral";
  type: string;
  mode: string;
  modeTone: GoogleAdvisorExactModeTone;
  money: string;
  action: string;
  scope: string;
  changes: GoogleAdvisorExactChangeViewModel[];
  effect: string;
  why: string;
  validation: string;
  lastLabel: "Rollback" | "Unblock path";
  last: string;
  confidence: string;
  blocked: boolean;
  nativeActionContract: boolean;
  navigationKind: "plan" | "products" | "unsupported";
}

export interface GoogleAdvisorExactViewModel {
  eyebrow: string;
  syncLabel: string;
  tiles: GoogleAdvisorExactTileViewModel[];
  cards: GoogleAdvisorExactCardViewModel[];
}

function textOrDash(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : EMPTY;
}

function listTextOrDash(values: readonly string[] | null | undefined): string {
  const supported = (values ?? [])
    .map((value) => textOrDash(value))
    .filter((value) => value !== EMPTY);
  return supported.length > 0 ? supported.join(" · ") : EMPTY;
}

function nativeActionCard(recommendation: GoogleRecommendation): GoogleAdvisorActionCard | null {
  const card = recommendation.operatorActionCard;
  if (
    !card ||
    card.contractSource !== "native" ||
    card.contractVersion !== ACTION_CONTRACT_VERSION
  ) {
    return null;
  }
  return card;
}

export function isGoogleAdvisorExactActiveRecommendation(
  recommendation: GoogleRecommendation,
) {
  return (
    recommendation.currentStatus !== "suppressed" &&
    recommendation.userAction !== "dismissed"
  );
}

function isBlocked(recommendation: GoogleRecommendation, card: GoogleAdvisorActionCard | null) {
  const blockedPayload =
    card?.exactChangePayload.kind === "blocked_or_insufficient_evidence" &&
    card.exactChangePayload.state === "blocked";
  return (
    recommendation.integrityState === "blocked" ||
    String(recommendation.currentStatus ?? "") === "blocked" ||
    (recommendation.blockers?.length ?? 0) > 0 ||
    (recommendation.decision?.blockers?.length ?? 0) > 0 ||
    card?.expectedEffect.estimationMode === "blocked" ||
    (card?.blockedBecause.length ?? 0) > 0 ||
    blockedPayload
  );
}

function explicitUnblockPath(card: GoogleAdvisorActionCard | null) {
  const block = card?.exactChanges.find(
    (change) => change.label.trim().toLowerCase() === "unblock path",
  );
  return listTextOrDash(block?.items);
}

function navigationKind(
  recommendation: GoogleRecommendation,
  card: GoogleAdvisorActionCard | null,
  blocked: boolean,
): GoogleAdvisorExactCardViewModel["navigationKind"] {
  if (blocked) {
    return recommendation.type === "product_allocation" ? "products" : "unsupported";
  }
  if (!card || recommendation.doBucket === "do_later") return "unsupported";
  if (
    card.exactChangePayload.kind === "blocked_or_insufficient_evidence" &&
    card.exactChangePayload.state === "insufficient_evidence"
  ) {
    return "unsupported";
  }
  return "plan";
}

function bucketView(
  recommendation: GoogleRecommendation,
  blocked: boolean,
): Pick<GoogleAdvisorExactCardViewModel, "bucket" | "bucketTone"> {
  if (blocked) return { bucket: "Blocked", bucketTone: "blocked" };
  if (recommendation.doBucket === "do_now") return { bucket: "Do now", bucketTone: "now" };
  if (recommendation.doBucket === "do_next") return { bucket: "Do next", bucketTone: "next" };
  return { bucket: EMPTY, bucketTone: "neutral" };
}

function sentenceCase(value: string) {
  const spaced = value.replaceAll("_", " ").trim();
  if (!spaced) return EMPTY;
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function typeLabel(recommendation: GoogleRecommendation, card: GoogleAdvisorActionCard | null) {
  switch (card?.exactChangePayload.kind) {
    case "negative_keyword_cleanup":
      return "Query governance";
    case "budget_reallocation":
      return "Budget reallocation";
    case "keyword_buildout":
      return "Keyword buildout";
    case "target_strategy_adjustment":
      return "Target strategy";
    case "asset_group_restructure":
      return "Asset group restructure";
    case "product_allocation":
      return "Product allocation";
    default:
      return sentenceCase(recommendation.type);
  }
}

function modeView(
  card: GoogleAdvisorActionCard | null,
): Pick<GoogleAdvisorExactCardViewModel, "mode" | "modeTone"> {
  if (!card) return { mode: EMPTY, modeTone: "neutral" };
  if (
    card.exactChangePayload.kind === "budget_reallocation" &&
    card.exactChangePayload.estimateMode === "bounded_preview"
  ) {
    return { mode: "bounded preview", modeTone: "positive" };
  }
  switch (card.expectedEffect.estimationMode) {
    case "bounded_range":
      return { mode: "bounded range", modeTone: "positive" };
    case "heuristic_only":
      return { mode: "heuristic only", modeTone: "primary" };
    case "directional_only":
      return { mode: "directional only", modeTone: "automatic" };
    case "blocked":
      return { mode: "blocked", modeTone: "danger" };
    default:
      return { mode: EMPTY, modeTone: "neutral" };
  }
}

function compactEstimateLabel(card: GoogleAdvisorActionCard | null) {
  const label = textOrDash(card?.expectedEffect.estimateLabel);
  if (label === EMPTY || label.includes(" · ")) return label;
  return label.replace(/^(Revenue|Waste recovery|Efficiency):\s*/u, "") || EMPTY;
}

function changeView(block: GoogleAdvisorActionListBlock): GoogleAdvisorExactChangeViewModel {
  const supportedItems = block.items
    .map((item) => textOrDash(item))
    .filter((item) => item !== EMPTY);
  return {
    label: textOrDash(block.label),
    items:
      supportedItems.length > 0
        ? supportedItems
        : [textOrDash(block.emptyLabel)],
    tone: block.tone,
  };
}

function exactChanges(card: GoogleAdvisorActionCard | null) {
  if (!card || card.exactChanges.length === 0) {
    return [{ label: EMPTY, items: [EMPTY], tone: "muted" as const }];
  }
  return card.exactChanges.map(changeView);
}

function blastRadius(card: GoogleAdvisorActionCard | null) {
  if (!card) return EMPTY;
  const count = card?.scope.governedEntityCount;
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return EMPTY;

  const labelByLevel: Record<GoogleRecommendation["level"], string> = {
    account: "account",
    campaign: "campaign",
    query_cluster: "query cluster",
    product_cluster: "product cluster",
    asset_group: "asset group",
  };
  const noun = labelByLevel[card.scope.level];
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function confidenceLine(
  recommendation: GoogleRecommendation,
  card: GoogleAdvisorActionCard | null,
  blocked: boolean,
) {
  if (blocked) {
    return `blocked · re-evaluated each sync · contract ${card ? "v2 · native" : `${EMPTY} · ${EMPTY}`}`;
  }
  return `${textOrDash(recommendation.confidence)} confidence · ${textOrDash(
    recommendation.decision?.riskLevel,
  )} risk · blast radius: ${blastRadius(card)} · contract ${
    card ? "v2 · native" : `${EMPTY} · ${EMPTY}`
  }`;
}

function parseInstant(value: string | null | undefined) {
  if (!value) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function appliedReceiptCount(advisor: GoogleAdvisorResponse | null | undefined): string {
  if (!advisor) return EMPTY;
  const asOf = parseInstant(advisor.metadata?.asOfDate);
  if (asOf === null) return EMPTY;

  const endOfAsOfDay = asOf + 24 * 60 * 60 * 1_000 - 1;
  const cutoff = endOfAsOfDay - THIRTY_DAYS_MS;
  return String(
    advisor.recommendations.filter((recommendation) => {
      if (recommendation.executionStatus !== "applied") return false;
      const terminalReceiptAt =
        parseInstant(recommendation.executedAt) ?? parseInstant(recommendation.appliedAt);
      return (
        terminalReceiptAt !== null &&
        terminalReceiptAt >= cutoff &&
        terminalReceiptAt <= endOfAsOfDay
      );
    }).length,
  );
}

function eyebrow(identity: GoogleAdvisorExactIdentity) {
  return `Google Ads · ${textOrDash(identity.accountId)} · ${textOrDash(
    identity.currencyCode,
  )} · ${textOrDash(identity.windowLabel)} window`;
}

export function buildGoogleAdvisorExactViewModel(
  advisor: GoogleAdvisorResponse | null | undefined,
  identity: GoogleAdvisorExactIdentity = {},
): GoogleAdvisorExactViewModel {
  const hasPayload = advisor != null;
  const cards = (advisor?.recommendations ?? [])
    .filter(isGoogleAdvisorExactActiveRecommendation)
    .map((recommendation) => {
      const card = nativeActionCard(recommendation);
      const blocked = isBlocked(recommendation, card);
      const bucket = bucketView(recommendation, blocked);
      const mode = modeView(card);
      const last = blocked ? explicitUnblockPath(card) : listTextOrDash(card?.rollback);

      return {
        id: recommendation.id,
        recommendation,
        ...bucket,
        type: typeLabel(recommendation, card),
        ...mode,
        money: compactEstimateLabel(card),
        action: textOrDash(card?.primaryAction),
        scope: textOrDash(card?.scope.label),
        changes: exactChanges(card),
        effect: textOrDash(card?.expectedEffect.summary),
        why: textOrDash(card?.whyThisNow),
        validation: listTextOrDash(card?.validation),
        lastLabel: blocked ? ("Unblock path" as const) : ("Rollback" as const),
        last,
        confidence: confidenceLine(recommendation, card, blocked),
        blocked,
        nativeActionContract: card !== null,
        navigationKind: navigationKind(recommendation, card, blocked),
      };
    });

  return {
    eyebrow: eyebrow(identity),
    syncLabel: textOrDash(identity.syncLabel) === EMPTY ? "Synced —" : textOrDash(identity.syncLabel),
    tiles: [
      {
        key: "do-now",
        label: "Do now",
        value: hasPayload
          ? String(
              cards.filter(
                (card) =>
                  !card.blocked && card.recommendation.doBucket === "do_now",
              ).length,
            )
          : EMPTY,
        sub: "ranked by money at stake",
      },
      {
        key: "do-next",
        label: "Do next",
        value: hasPayload
          ? String(
              cards.filter(
                (card) =>
                  !card.blocked && card.recommendation.doBucket === "do_next",
              ).length,
            )
          : EMPTY,
        sub: "this week",
      },
      {
        key: "blocked",
        label: "Blocked",
        value: hasPayload ? String(cards.filter((card) => card.blocked).length) : EMPTY,
        sub: "feed fix first",
      },
      {
        key: "applied-30d",
        label: "Applied · 30d",
        value: appliedReceiptCount(advisor),
        sub: "guarded writes · receipted",
      },
    ],
    cards,
  };
}
