"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { buildCreativeStudioTabHrefs } from "@/lib/meta/creative-studio-tab-hrefs";
import type { CreativeRouteWindow } from "@/lib/zero-base/creative/route-scope";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeStudioExact } from "@/components/creatives/CreativeStudioExact";
import { buildCreativeStudioTabCounts } from "@/components/creatives/creative-studio-tab-counts";
import {
  retainedDecisionGenerationFromInventory,
  type CreativeInboxColumnId,
  type CreativeStudioInboxCard,
  type CreativeStudioInboxColumn,
  type CreativeStudioInboxModel,
  type CreativeStudioTone,
} from "@/components/creatives/creative-studio-exact-types";
import type {
  BriefingCanonicalInventorySource,
  BriefingCanonicalNativeAdDecision,
  BriefingCreativeCard,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";
import { buyerFacingCreativeBlocker } from "@/components/meta/decision-center/meta-decision-center-exact-adapter";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { DECISION_AUTHORITY_BLOCKERS } from "@/lib/creative-decision-engine/types";
import {
  flattenCreativeStudioBriefingCards,
  scopeCreativeInboxCards,
} from "@/app/(dashboard)/platforms/meta/creatives/studio-truth";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { useAppStore } from "@/store/app-store";

/**
 * Creative Studio — Inbox.
 *
 * ## What this surface stopped claiming
 *
 * It used to draw four columns named Requested / In production / Delivered /
 * Live: a creative-production pipeline. Nothing in this product produces one.
 * Re-provable by grep:
 *
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'workflowStatus|workflow_status|columnId|column_id|stage' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E '\bassignee\b|assigned_to|assignedTo' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'dueAt|due_at|dueDate' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'versionNumber|approvalState|approvedBy|approved_by' app lib components
 *
 * Every live hit belongs to something else — `lib/decision-workflow*` is the
 * DECISION ownership overlay (open/acknowledged/deferred/… on a decision key,
 * and its own header says no transition there can change a decision's label),
 * and every `command_center_*` hit sits under `lib/archive/v1-v2-v21/`.
 * `lib/migrations.ts` declares no workflow table. `/api/creatives/inbox` serves
 * briefing cards plus cache/status/error plumbing and no workflow field.
 *
 * A caption saying "these columns are unavailable" underneath four columns
 * named after a pipeline did not fix that: the headings are the claim. So the
 * headings are gone.
 *
 * ## What it shows instead
 *
 * The real content this surface has always had access to: the scoped creative
 * BRIEFING decision items, in the authority's own three served sections —
 * `actionNow`, `watching`, `healthy`. That is the engine's own grouping of its
 * own output, presented under its own names.
 *
 * Nothing here reclassifies it. No card is moved between sections, no decision
 * or buyerAction is inferred, no label is recomputed: the segment a card lands
 * in is decided entirely by which array of the briefing response it arrived in,
 * and the label and summary on the card come from served fields only (see the
 * two presentation steps below). A section the authority served nothing for shows a real
 * zero; a briefing read that FAILED shows the failure, never an empty board.
 *
 * A `degraded` read (D102) is the retained last successful generation after
 * the latest native run failed. Its cards are real and are shown, under one
 * banner that names both runs and says none can be applied. The server serves
 * it with an empty Action now and no execution authority; a degraded response
 * that cannot name both runs, or that offers an Action now card, is refused as
 * unverifiable rather than drawn.
 *
 * Two presentation steps sit on top, and both read only served fields. A card
 * whose served Cut cannot be applied now, or whose Cut is held, is labelled
 * from its served codes (buyer action, held action, raw label, readiness,
 * review-only reason, hold blockers) mapped to fixed copy; and Watching is
 * ordered so those Cuts come first. Neither step changes a section, a
 * decision or what may be executed.
 *
 * The request -> version -> approval -> Launchpad handoff workflow remains
 * UNBUILT, and the board says so in its own strip rather than implying it works
 * and has no traffic today.
 */

/** The engine's served sections, in the order the authority serves them. */
const INBOX_SEGMENTS: ReadonlyArray<{
  id: CreativeInboxColumnId;
  name: string;
  tone: CreativeStudioTone;
}> = [
  { id: "action-now", name: "Action now", tone: "warning" },
  { id: "watching", name: "Watching", tone: "info" },
  { id: "healthy", name: "Healthy", tone: "positive" },
];

type InboxCard = BriefingCreativeCard & {
  businessId: string;
  /**
   * Which served briefing section this card arrived in. Assigned from the
   * response's own arrays; never derived from the card's contents.
   */
  briefingSegment: CreativeInboxColumnId;
};

interface CreativeInboxResponse {
  inbox?: InboxCard[];
  /**
   * The briefing authority states when its own inventory could not be read.
   * It publishes this today and this surface ignored it, so an UNAVAILABLE
   * inventory arrived as HTTP 200 with empty lanes and the board drew it as a
   * measured zero — "this account has nothing to act on" when the truth was
   * "we could not read what it has". Live on act_822913786458311.
   *
   * `generation` and `degradation` are read only to name the two runs of a
   * `degraded` (D102) inventory.
   */
  canonicalDecisionInventory?: {
    status?: string | null;
    unavailableReason?: string | null;
    generation?: BriefingCanonicalInventorySource["generation"];
    degradation?: BriefingCanonicalInventorySource["degradation"];
  } | null;
  source?: {
    measurementReconciliation?: {
      snapshotLatest?: { observedAt?: string | null } | null;
    } | null;
  } | null;
}

export interface MetaCreativeInboxPageProps {
  businessId?: string;
  providerAccountId?: string | null;
  /**
   * The window the canonical route parsed out of `?start`/`?end`, validated on
   * the server.
   *
   * The briefing read this surface performs is not windowed — it is asked for a
   * business and an account — so this never filters anything here and is never
   * captioned as if it did. It exists so the window survives the walk through
   * this surface: the Studio tab links were built with empty bounds, which
   * silently reset the operator's range on the way to the next tab.
   */
  serverDateWindow?: CreativeRouteWindow | null;
}

/**
 * Splits the flattened briefing cards back into the sections they came from.
 *
 * `flattenCreativeStudioBriefingCards` walks `[...actionNow, ...watching,
 * ...healthy]` in that order and keeps the FIRST occurrence of each card key.
 * So the flattened list is three contiguous runs, and the length of each run is
 * exactly the length of the flatten of the corresponding prefix. Re-flattening
 * the prefixes is therefore an exact partition and — crucially — it reuses the
 * authority's own de-duplication rather than reimplementing the key function
 * here, where a drift would silently move cards between segments.
 */
function segmentBriefingCards(
  payload: CreativesBriefingResponse | null,
): Array<{ card: BriefingCreativeCard; segment: CreativeInboxColumnId }> {
  const all = flattenCreativeStudioBriefingCards(payload);
  if (!payload) return [];
  const actionCount = flattenCreativeStudioBriefingCards({
    ...payload,
    watching: [],
    healthy: [],
  }).length;
  const throughWatchingCount = flattenCreativeStudioBriefingCards({
    ...payload,
    healthy: [],
  }).length;
  return all.map((card, index) => ({
    card,
    segment:
      index < actionCount
        ? "action-now"
        : index < throughWatchingCount
          ? "watching"
          : "healthy",
  }));
}

type ServedExecutionReadiness = NonNullable<
  BriefingCanonicalNativeAdDecision["sourceAuthority"]["executionReadiness"]
>;

/**
 * Served execution readiness, as a buyer reads it.
 *
 * `live_preflight_required` is the only value that lets a change be offered,
 * so it has no entry and is never shown. Any other value — and an absent or
 * unrecognised one, which INVARIANTS treats as review-only — says why this
 * card cannot be applied from here right now.
 */
const READINESS_COPY: Readonly<
  Record<Exclude<ServedExecutionReadiness, "live_preflight_required">, string>
> = {
  decision_not_authorized: "Review only",
  // The server serves `stale_decision` for every non-fresh decision, including
  // a future or unreadable computation time; `readinessCopy` names which one
  // from the served freshness. This line is only the fallback.
  stale_decision: "Decision not fresh",
  engine_version_drift: "Decision version outdated",
  kill_switched: "Kill switch on",
  governance_unavailable: "Automation safeguards unverified",
  source_pipeline_unready: "Source data not ready",
};

/**
 * The readiness sentence for one served authority. `stale_decision` is named
 * from the served `decisionFreshness`, whose status and age ceiling are the
 * server's, so the copy never states an age the served fields contradict.
 */
function readinessCopy(
  authority: BriefingCanonicalNativeAdDecision["sourceAuthority"] | null,
): string {
  const readiness = authority?.executionReadiness ?? null;
  if (readiness === "stale_decision") {
    const freshness = authority?.decisionFreshness ?? null;
    if (freshness?.status === "stale" && Number.isFinite(freshness.maxAgeHours)) {
      return `Decision older than ${freshness.maxAgeHours} hours`;
    }
    if (freshness?.status === "future") return "Decision time is ahead of the clock";
    if (freshness?.status === "unavailable") return "Decision age unknown";
  }
  return (
    copyFor(READINESS_COPY, readiness) ?? READINESS_COPY.decision_not_authorized
  );
}

/**
 * Served review-only reasons that explain why a Cut is not in Action now.
 * Codes without a sentence here are left to the Readiness fact rather than
 * printed raw.
 */
const REVIEW_ONLY_REASON_COPY: Readonly<Record<string, string>> = {
  current_hierarchy_status_is_unknown:
    "Not in Action now because this ad's current status could not be confirmed.",
  current_hierarchy_is_not_active:
    "Not in Action now because this ad is inactive.",
  current_creative_identity_is_missing:
    "Not in Action now because this ad's creative could not be identified.",
  native_latest_job_failed_last_successful_generation_is_not_current:
    "Not in Action now because the latest decision run failed; this is the last completed run.",
};

/**
 * A held action's own name, used only when its raw label is that action. It
 * renders "Cut · Held", the same words the server's held buyer label uses, but
 * from the served code, so no held label can claim more than the code says.
 */
const HELD_ACTION_COPY = {
  cut: "Cut",
  scale: "Scale",
  refresh: "Refresh",
} as const;

/**
 * What a held action is when the raw label is something softer. A held Cut on
 * a `test_more` card is a signal to reduce spend, not the Cut itself; a held
 * Scale or Refresh keeps its own name and never borrows Cut's.
 */
const HELD_SIGNAL_COPY = {
  cut: "Spend reduction signal held",
  scale: "Scale signal held",
  refresh: "Refresh signal held",
} as const;

/** The soft raw labels a held signal can sit under. */
const SOFT_RAW_LABEL_COPY: Readonly<Record<string, string>> = {
  test_more: "Test more",
  keep: "Keep",
  diagnose: "Diagnose",
  out_of_scope: "Out of scope",
};

/** The authority-hold vocabulary, in the engine's own closed list. */
const HOLD_REASON_CODES: ReadonlySet<string> = new Set(
  DECISION_AUTHORITY_BLOCKERS,
);

/**
 * Hold codes the read model has no label for. It serves them as the code with
 * its underscores removed ("Profile hard action ineligible"), so these take the
 * Decision Center's buyer sentence for the same code and both surfaces explain
 * one hold in the same words. A hold the server did write a label for keeps it.
 */
const UNLABELLED_HOLD_REASON_CODES: ReadonlySet<string> = new Set([
  "profile_hard_action_ineligible",
  "source_freshness",
  "campaign_context",
  "native_metrics_unavailable",
  "native_profile_unavailable",
  "recent_recovery_unverifiable",
]);

function asSentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

/**
 * A served Cut that cannot be applied from here right now.
 *
 * The server classified this card's buyer action as Cut and holds nothing, but
 * it is not the one executable tuple — authorized AND
 * `live_preflight_required` — so the briefing filed it under Watching. That
 * covers an authorized Cut stopped by governance, the kill switch, a decision
 * older than 12 hours, an unready source pipeline or a version drift, and a
 * Cut whose current hierarchy could not be confirmed. Read, never derived.
 */
function isCutNotReadyNow(card: BriefingCreativeCard): boolean {
  const canonical = card.canonicalDecision ?? null;
  if (!canonical) return false;
  const authority = canonical.sourceAuthority;
  return (
    canonical.classification.buyerAction === "cut" &&
    (canonical.classification.heldAction ?? null) === null &&
    !(
      authority?.actionEligible === true &&
      authority.executionReadiness === "live_preflight_required"
    )
  );
}

/**
 * Watching, most urgent first: a served Cut that cannot be applied now, then a
 * held Cut whose raw label is Cut, then a softer card carrying a held Cut
 * signal, then everything else. Within a rank the server's order stands.
 */
function watchingRank(card: BriefingCreativeCard): number {
  if (isCutNotReadyNow(card)) return 0;
  if (card.canonicalDecision?.classification.heldAction === "cut") {
    // Only a served soft raw label demotes a held Cut to a reduction signal.
    // A missing raw label is unknown provenance (D056), not a soft verdict.
    const rawLabel = text(card.rawLabel);
    return rawLabel && rawLabel !== "cut" ? 2 : 1;
  }
  return 3;
}

function orderWatchingCards(cards: readonly InboxCard[]): InboxCard[] {
  return cards
    .map((card, index) => ({ card, index, rank: watchingRank(card) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ card }) => card);
}

/**
 * Why a held card is held, from served codes only.
 *
 * The served authority blocker comes first, then any other served blocker in
 * the authority-hold vocabulary — `config_source_authority` rides beside the
 * first blocker when configuration is unverified. Evidence-detail blockers are
 * left to the evidence views. A `passed` entry is provenance, not a hold.
 */
function heldReasons(card: BriefingCreativeCard): string[] {
  const served = new Map<string, string>();
  for (const blocker of card.blockers ?? []) {
    const code = text(blocker.predicate);
    if (!code || blocker.status === "passed" || served.has(code)) continue;
    served.set(code, text(blocker.reason));
  }
  const codes = [
    text(card.canonicalDecision?.sourceDecision.authorityBlocker),
    ...served.keys(),
  ].filter((code) => HOLD_REASON_CODES.has(code));
  const reasons = [...new Set(codes)].map((code) => {
    const label = served.get(code);
    return UNLABELLED_HOLD_REASON_CODES.has(code) || !label
      ? buyerFacingCreativeBlocker(code)
      : asSentence(label);
  });
  if (reasons.length > 0) return [...new Set(reasons)];
  const first = [...served.values()].find(Boolean);
  return first ? [asSentence(first)] : [];
}

/**
 * Money, never inferred.
 *
 * An unknown currency prints the bare number rather than borrowing a symbol.
 * An unmeasured amount returns null, which the card renders as an em dash; a
 * measured zero returns "0" and stays a zero.
 */
function formatMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const code =
    typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: code,
        maximumFractionDigits: 0,
      }).format(value);
    } catch {
      // An unrecognised ISO-shaped code is not a reason to invent one.
    }
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    value,
  );
}

function formatRatio(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${value.toFixed(2)}x`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A fixed-copy lookup that never answers for a code it does not list. */
function copyFor(
  catalog: Readonly<Record<string, string>>,
  code: string | null | undefined,
): string | null {
  const key = text(code);
  return key && Object.prototype.hasOwnProperty.call(catalog, key)
    ? (catalog[key] ?? null)
    : null;
}

/**
 * One served card, rendered as itself.
 *
 * `source` is the server's buyer label: the Decision Center row's when one was
 * served, else the canonical envelope's own `classification.buyerLabel` — the
 * projection omits the row whenever the buyer action is null, which is every
 * Diagnose card, and those still serve "Diagnose data". Two cases are named
 * from served codes instead, because the served label alone reads wrong:
 *
 *  - a Cut that cannot be applied now serves the same plain "Cut" as a ready
 *    one, so it is labelled not ready and carries its served readiness;
 *  - a held Cut serves "Cut · Held" whether its raw label is Cut or a softer
 *    label carrying only a spend reduction signal, so the soft case says so.
 *
 * Hold reasons name the served blockers. Nothing here derives a decision from
 * metrics or calls a hold anything its served codes do not say.
 */
function toStudioCard(
  card: InboxCard,
  tone: CreativeStudioTone,
  id: string,
): CreativeStudioInboxCard {
  const decision = card.decisionCenterRow ?? null;
  const canonical = card.canonicalDecision ?? null;
  const authority = canonical?.sourceAuthority ?? null;
  const buyerAction = canonical?.classification.buyerAction ?? null;
  const servedHeldAction = canonical?.classification.heldAction;
  const heldAction =
    servedHeldAction === "cut" ||
    servedHeldAction === "scale" ||
    servedHeldAction === "refresh"
      ? servedHeldAction
      : null;
  const rawLabel = text(card.rawLabel);
  const cutNotReadyNow = isCutNotReadyNow(card);
  const source = cutNotReadyNow
    ? "Cut · Not ready to apply"
    : heldAction
      ? rawLabel === heldAction
        ? `${HELD_ACTION_COPY[heldAction]} · Held`
        : rawLabel
          ? `${copyFor(SOFT_RAW_LABEL_COPY, rawLabel) ?? "Recommendation"} · ${HELD_SIGNAL_COPY[heldAction]}`
          : text(canonical?.classification.buyerLabel) ||
            `${HELD_ACTION_COPY[heldAction]} · Held`
      : text(decision?.buyerLabel) ||
        text(canonical?.classification.buyerLabel) ||
        null;
  const evidenceReason =
    text(canonical?.sourceDecision.reason) ||
    text(decision?.oneLine) ||
    text(card.campaignName) ||
    text(card.campaign) ||
    null;
  const notReadyReason = cutNotReadyNow
    ? copyFor(REVIEW_ONLY_REASON_COPY, authority?.reviewOnlyReason)
    : null;
  const holds = heldAction ? heldReasons(card) : [];
  const note =
    [
      evidenceReason,
      notReadyReason,
      holds.length > 0 ? `Held: ${holds.join(" ")}` : null,
    ]
      .filter(Boolean)
      .join(" ") || null;
  const hardAction =
    heldAction !== null ||
    buyerAction === "cut" ||
    buyerAction === "scale" ||
    buyerAction === "refresh";
  const executable =
    authority?.actionEligible === true &&
    authority.executionReadiness === "live_preflight_required";
  return {
    id,
    source,
    sourceTone: tone,
    name:
      text(card.creativeName) ||
      text(card.name) ||
      text(card.creativeId) ||
      text(card.id),
    note,
    facts: [
      { label: "Spend", value: formatMoney(card.spend, card.currency) },
      { label: "ROAS", value: formatRatio(card.roas) },
      // Same predicate as isCutNotReadyNow: only the authorized,
      // live-preflight tuple is ready. A hierarchy hold can leave the served
      // readiness at `live_preflight_required` while `actionEligible` is
      // false, and that card is not ready either.
      ...(canonical && hardAction && !executable
        ? [{
            label: "Readiness",
            value:
              authority?.executionReadiness === "live_preflight_required"
                ? READINESS_COPY.decision_not_authorized
                : readinessCopy(authority),
          }]
        : []),
    ],
  };
}

async function fetchCreativeInbox(
  businessId: string,
  providerAccountId: string,
): Promise<CreativeInboxResponse> {
  const params = new URLSearchParams({
    businessId,
    providerAccountId,
    decisionCenter: "1",
  });
  const response = await fetch(`/api/creatives/briefing?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    (CreativesBriefingResponse & { message?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.message ?? "Creative inbox could not load.");
  }
  // A success-shaped empty or malformed body is not evidence of zero
  // decisions. The canonical inventory must explicitly say whether it was
  // read, and the three served sections must all be present. A `degraded`
  // inventory (D102) must also name both of its runs and, by the server's own
  // rule for a retained generation, offer nothing in Action now.
  const inventory = payload?.source?.canonicalDecisionInventory ?? null;
  if (
    !payload ||
    !Array.isArray(payload.actionNow) ||
    !Array.isArray(payload.watching) ||
    !Array.isArray(payload.healthy) ||
    !["available", "degraded", "unavailable"].includes(
      inventory?.status ?? "",
    ) ||
    (inventory?.status === "degraded" &&
      (!retainedDecisionGenerationFromInventory(inventory) ||
        payload.actionNow.length > 0))
  ) {
    throw new Error("Creative decision inventory could not be verified.");
  }
  return {
    inbox: segmentBriefingCards(payload).map(({ card, segment }) => ({
      ...card,
      businessId,
      briefingSegment: segment,
    })),
    source: {
      measurementReconciliation: {
        snapshotLatest: {
          observedAt:
            payload?.source?.measurementReconciliation?.snapshotLatest
              ?.observedAt ?? null,
        },
      },
    },
    canonicalDecisionInventory:
      payload?.source?.canonicalDecisionInventory ?? null,
  } satisfies CreativeInboxResponse;
}

function resolveCardAccountId(card: BriefingCreativeCard): string {
  return (
    card.providerAccountId?.trim() ||
    card.accountId?.trim() ||
    card.metaAccountId?.trim() ||
    ""
  );
}

export default function MetaCreativeInboxPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
  serverDateWindow = null,
}: MetaCreativeInboxPageProps = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const storeBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceResolved = useAppStore((state) => state.workspaceResolved);
  const hasAuthorizedBusinessScope = authorizedBusinessId !== undefined;
  const hasAuthorizedProviderScope = authorizedProviderAccountId !== undefined;
  const businessId = hasAuthorizedBusinessScope
    ? (authorizedBusinessId?.trim() ?? "")
    : (storeBusinessId ?? "");
  const scopeResolved = hasAuthorizedBusinessScope || workspaceResolved;
  const requestedProviderAccountId = hasAuthorizedProviderScope
    ? (authorizedProviderAccountId?.trim() ?? "")
    : (searchParams?.get("providerAccountId")?.trim() ?? "");
  const [selectedProviderAccountId, setSelectedProviderAccountId] = useState(
    requestedProviderAccountId,
  );

  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled:
      scopeResolved && Boolean(businessId) && !hasAuthorizedProviderScope,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: () => fetchMetaHistoryAccounts({ businessId }),
  });
  const providerAccounts = providerAccountsQuery.data ?? [];
  const discoveredProviderAccountId =
    (selectedProviderAccountId &&
    providerAccounts.some((account) => account.id === selectedProviderAccountId)
      ? selectedProviderAccountId
      : "") || (providerAccounts.length === 1 ? providerAccounts[0]!.id : "");
  const providerAccountId = hasAuthorizedProviderScope
    ? (authorizedProviderAccountId?.trim() ?? "")
    : discoveredProviderAccountId;

  useEffect(() => {
    if (hasAuthorizedProviderScope) return;
    setSelectedProviderAccountId((current) => {
      if (
        current &&
        providerAccounts.some((account) => account.id === current)
      ) {
        return current;
      }
      if (
        requestedProviderAccountId &&
        providerAccounts.some(
          (account) => account.id === requestedProviderAccountId,
        )
      ) {
        return requestedProviderAccountId;
      }
      return "";
    });
  }, [
    businessId,
    hasAuthorizedProviderScope,
    providerAccounts,
    requestedProviderAccountId,
  ]);

  const inboxQuery = useQuery({
    queryKey: ["creative-account-inbox", businessId, providerAccountId],
    enabled: scopeResolved && Boolean(businessId) && Boolean(providerAccountId),
    staleTime: 30 * 1000,
    queryFn: () => fetchCreativeInbox(businessId, providerAccountId),
  });
  const cards = inboxQuery.data?.inbox ?? [];
  const scoped = useMemo(
    () =>
      businessId && providerAccountId
        ? scopeCreativeInboxCards(cards, { businessId, providerAccountId })
        : {
            cards: [] as InboxCard[],
            excludedBusinessCount: 0,
            excludedAccountCount: 0,
            missingAccountCount: cards.filter(
              (card) => !resolveCardAccountId(card),
            ).length,
          },
    [businessId, cards, providerAccountId],
  );
  const scopeLoading =
    !scopeResolved ||
    (!hasAuthorizedProviderScope && providerAccountsQuery.isLoading);
  const scopeError =
    !hasAuthorizedProviderScope && providerAccountsQuery.isError;
  const inboxLoading =
    scopeResolved &&
    Boolean(businessId) &&
    Boolean(providerAccountId) &&
    (inboxQuery.isLoading || (!inboxQuery.data && inboxQuery.isFetching));

  useTierZeroFreshness({
    surface: "creative_studio",
    isLoading: scopeLoading || inboxLoading,
    isFetching:
      inboxQuery.isFetching ||
      (!hasAuthorizedProviderScope && providerAccountsQuery.isFetching),
    error: inboxQuery.error ?? providerAccountsQuery.error,
    // This surface reads ONE account from ONE authority. That read either
    // succeeds or throws; there is no partial. A per-account error list used to
    // be carried here from the multi-business /api/creatives/inbox shape, but
    // this page has never called that route, so the list was always empty and
    // the "incomplete" signal could never fire.
    partialReason: null,
    asOf: measuredAsOf(
      inboxQuery.data?.source?.measurementReconciliation?.snapshotLatest
        ?.observedAt ?? null,
    ),
    businessId: businessId || null,
    onRetry: () => {
      if (!hasAuthorizedProviderScope && providerAccountsQuery.isError) {
        void providerAccountsQuery.refetch();
      }
      if (businessId && providerAccountId) void inboxQuery.refetch();
    },
  });

  // The authority publishes when its OWN inventory could not be read. A 200
  // with empty lanes over an unavailable inventory is a read failure wearing
  // a success's clothes, and drawing it as an empty board asserts a measured
  // zero the account never produced.
  const inventory = inboxQuery.data?.canonicalDecisionInventory ?? null;
  // D102: the retained generation after a failed latest run is a real read,
  // shown read-only under a banner naming both runs. It counts as read only
  // while it can name them and nothing reached Action now, the same rule the
  // fetch enforces.
  const servedRetainedGeneration =
    retainedDecisionGenerationFromInventory(inventory);
  const retainedGeneration =
    servedRetainedGeneration &&
    !cards.some((card) => card.briefingSegment === "action-now")
      ? servedRetainedGeneration
      : null;
  const inventoryUnavailable =
    Boolean(providerAccountId) &&
    !inboxLoading &&
    inventory?.status !== "available" &&
    retainedGeneration === null;
  const readFailed = scopeError || inboxQuery.isError || inventoryUnavailable;
  // The degraded banner renders only on a ready or empty board. A cached
  // retained read whose refetch then failed would otherwise leave retained
  // cards on screen with no statement that they are read-only.
  const hideCards =
    inventoryUnavailable || (readFailed && retainedGeneration !== null);
  const state = scopeLoading
    ? "loading"
    : readFailed
      ? "error"
      : !providerAccountId
        ? "account_required"
        : inboxLoading
          ? "loading"
          : scoped.cards.length > 0
            ? "ready"
            : "empty";

  /**
   * Every rendered card traces to a served briefing card, and only to that.
   *
   * The segment comes off the card's own `briefingSegment`, which was stamped
   * from the response array it arrived in. A card whose segment is unreadable
   * is dropped rather than parked in a default column, because a default would
   * be this surface deciding something the engine did not say. Nor is any card
   * drawn from an inventory that did not verify: a degraded read that breaks
   * its own rule shows the failure, not its cards.
   */
  const columns: CreativeStudioInboxColumn[] = useMemo(() => {
    const usedIds = new Set<string>();
    return INBOX_SEGMENTS.map((segment) => {
      const segmentCards = hideCards
        ? []
        : scoped.cards.filter((card) => card.briefingSegment === segment.id);
      // Action now and Healthy keep the server's order exactly.
      const orderedCards = segment.id === "watching"
        ? orderWatchingCards(segmentCards)
        : segmentCards;
      return {
        ...segment,
        cards: orderedCards.map((card) => {
          const base = text(card.id) || text(card.creativeId) || segment.id;
          let id = base;
          let suffix = 2;
          while (usedIds.has(id)) id = `${base}#${suffix++}`;
          usedIds.add(id);
          return toStudioCard(card, segment.tone, id);
        }),
      };
    });
  }, [hideCards, scoped.cards]);

  const servedCount = scoped.cards.length;
  const message = scopeLoading
    ? "Loading Meta accounts."
    : scopeError
      ? "Meta accounts are temporarily unavailable."
      : !providerAccountId
        ? "Select a Meta account to view creative decisions."
        : inboxLoading
          ? "Loading creative decisions."
          : inboxQuery.isError
            ? "Creative decisions are temporarily unavailable."
            : inventoryUnavailable
              ? "Creative decisions are temporarily unavailable."
              : "No creative decisions need attention.";

  const model: CreativeStudioInboxModel = {
    state,
    message:
      scoped.missingAccountCount > 0
        ? `${message} Some items could not be matched to the selected account.`
        : message,
    columns,
    retainedGeneration:
      state === "ready" || state === "empty" ? retainedGeneration : null,
  };
  // Pass the arriving window straight through. Empty bounds here meant every
  // link out of the Inbox dropped the range the operator came in with, so
  // Assets -> Inbox -> Copies quietly reset the window mid-walk. The Inbox
  // invents nothing: with no window in the URL the links carry none, exactly as
  // before.
  const tabHrefs = buildCreativeStudioTabHrefs({
    pathname,
    businessId,
    providerAccountId,
    start: serverDateWindow?.start ?? "",
    end: serverDateWindow?.end ?? "",
  });

  if (scopeResolved && !businessId) return <BusinessEmptyState />;

  return (
    // `data-inbox-state` describes the BRIEFING READ, which is the only source
    // this surface has: loading, failed, no account, served with items, served
    // with none.
    <div data-inbox-state={state} data-testid="creative-inbox-studio-page">
      <CreativeStudioExact
        activeTab="inbox"
        // The chip now states a MEASUREMENT: how many scoped decision items
        // this tab is showing. It was withheld while the board drew a workflow
        // queue nobody measured; the board no longer claims a queue, so the
        // number is a fact about what is on the tab. `null` while the read is
        // loading, failed or unscoped keeps the em dash — the chip's own "not
        // served" rendering — and a measured zero draws no chip at all, which
        // is the reference's own behaviour for a zero.
        counts={buildCreativeStudioTabCounts({
          inbox: state === "ready" || state === "empty" ? servedCount : null,
        })}
        inbox={model}
        tabHrefs={tabHrefs}
      />
    </div>
  );
}
