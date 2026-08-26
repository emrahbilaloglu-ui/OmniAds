"use client";

import { useState, type KeyboardEvent, type MouseEvent } from "react";

import styles from "./MetaDecisionCenterExact.module.css";

const EM_DASH = "—";

export type MetaDecisionCenterExactDisplayValue =
  string | number | null | undefined;
export type MetaDecisionCenterExactScope = "structure" | "creatives";
/**
 * The queue's lanes.
 *
 * `needsres` is the server's own `blocked` state given a lane of its own. It is
 * not a sixth opinion about these rows: `MetaOsDecisionLane` is `act | blocked
 * | monitor`, the server has always classified every structure row into one of
 * the three, and until now a `blocked` row was still drawn under "Action Now"
 * — a lane that promises an action for a decision whose authority the server
 * withheld. Nothing here decides blockedness; it reads `node.lane`.
 */
export type MetaDecisionCenterExactLane =
  "action" | "needsres" | "watching" | "healthy" | "nonsales" | "archive";
export type MetaDecisionCenterExactWindow = "7d" | "14d" | "28d" | "90d";
export type MetaDecisionCenterExactTone =
  "positive" | "negative" | "warning" | "info" | "automation" | "neutral";

export interface MetaDecisionCenterExactIdentityViewModel {
  accountLabel?: MetaDecisionCenterExactDisplayValue;
  currency?: MetaDecisionCenterExactDisplayValue;
  syncedLabel?: MetaDecisionCenterExactDisplayValue;
  snapshotLabel?: MetaDecisionCenterExactDisplayValue;
  engineLabel?: MetaDecisionCenterExactDisplayValue;
  timeLabel?: MetaDecisionCenterExactDisplayValue;
}

export interface MetaDecisionCenterExactChipViewModel {
  label?: MetaDecisionCenterExactDisplayValue;
  tone?: MetaDecisionCenterExactTone;
}

export interface MetaDecisionCenterExactKpisViewModel {
  spend?: {
    value?: MetaDecisionCenterExactDisplayValue;
    delta?: MetaDecisionCenterExactDisplayValue;
    detail?: MetaDecisionCenterExactDisplayValue;
  };
  roas?: {
    label?: MetaDecisionCenterExactDisplayValue;
    value?: MetaDecisionCenterExactDisplayValue;
    /**
     * The whole reference phrase, NOUN INCLUDED — "target 2.50 · stale",
     * "account median 2.10", "target —". The tile prints it verbatim because
     * only the adapter knows which of the pulse's four reference sources is in
     * force, and the account median must never be captioned as a target.
     */
    target?: MetaDecisionCenterExactDisplayValue;
    sparkPath?: string | null;
  };
  snapshot?: {
    freshness?: MetaDecisionCenterExactDisplayValue;
    detail?: MetaDecisionCenterExactDisplayValue;
  };
  labels?: {
    coverage?: MetaDecisionCenterExactDisplayValue;
    percentage?: MetaDecisionCenterExactDisplayValue;
  };
  mode?: {
    value?: MetaDecisionCenterExactDisplayValue;
    chips?: readonly MetaDecisionCenterExactChipViewModel[];
  };
}

export interface MetaDecisionCenterExactCountsViewModel {
  structure?: MetaDecisionCenterExactDisplayValue;
  creatives?: MetaDecisionCenterExactDisplayValue;
  action?: MetaDecisionCenterExactDisplayValue;
  /** Served count of rows the server classified `blocked`. */
  needsres?: MetaDecisionCenterExactDisplayValue;
  watching?: MetaDecisionCenterExactDisplayValue;
  healthy?: MetaDecisionCenterExactDisplayValue;
  nonsales?: MetaDecisionCenterExactDisplayValue;
  archive?: MetaDecisionCenterExactDisplayValue;
  deferred?: MetaDecisionCenterExactDisplayValue;
}

export interface MetaDecisionCenterExactActionRowViewModel {
  id: string;
  name?: MetaDecisionCenterExactDisplayValue;
  level?: MetaDecisionCenterExactDisplayValue;
  /**
   * Where this row sits in the campaign -> ad set structure, already written by
   * the adapter from the row's own served level and parent campaign. The queue
   * mixes both levels as flat siblings, so without this an ad set reads as a
   * peer of the campaign it belongs to.
   */
  lineage?: MetaDecisionCenterExactDisplayValue;
  /** Which end of the relation this row is: the campaign, or one of its ad sets. */
  lineageRole?: "parent" | "child";
  /** True when this is the row the evidence inspector is describing. */
  selected?: boolean;
  chips?: readonly MetaDecisionCenterExactDisplayValue[];
  decisionLabel?: MetaDecisionCenterExactDisplayValue;
  decisionTone?: MetaDecisionCenterExactTone;
  edgeTone?: MetaDecisionCenterExactTone;
  money?: MetaDecisionCenterExactDisplayValue;
  moneySub?: MetaDecisionCenterExactDisplayValue;
  confidence?: MetaDecisionCenterExactDisplayValue;
  confidenceTone?: MetaDecisionCenterExactTone;
  actionLabel?: MetaDecisionCenterExactDisplayValue;
  actionTone?: MetaDecisionCenterExactTone;
  /** True when the server capped this row's confidence. @see QueueStaleDemoted */
  staleDemoted?: boolean;
  staleDemotedReason?: MetaDecisionCenterExactDisplayValue;
  /** Ownership, from the workflow overlay read. Absent when it was not read. */
  workflowChip?: MetaDecisionCenterExactRowWorkflowChip | null;
  onPrimary?: () => void;
  /** Opens this row in the evidence inspector from anywhere on the card. */
  onOpen?: () => void;
  onMenu?: () => void;
}

/**
 * A row the server classified `blocked`, with what is holding it.
 *
 * The extra fields over an action row are all server text: `blocker` is the
 * readiness blocker vocabulary the inspector already prints, `resolution` is
 * the server's own next step, and neither is composed here. There is no
 * `actionLabel` and no `onPrimary` by design — a blocked decision has no
 * authorized action, and offering one would be the UI deciding something the
 * server refused.
 */
export interface MetaDecisionCenterExactNeedsResolutionRowViewModel {
  id: string;
  name?: MetaDecisionCenterExactDisplayValue;
  level?: MetaDecisionCenterExactDisplayValue;
  lineage?: MetaDecisionCenterExactDisplayValue;
  lineageRole?: "parent" | "child";
  selected?: boolean;
  /** The served verdict, still printed: blocked is about authority, not truth. */
  decisionLabel?: MetaDecisionCenterExactDisplayValue;
  decisionTone?: MetaDecisionCenterExactTone;
  /** Why this row cannot move, in the server's words. */
  blocker?: MetaDecisionCenterExactDisplayValue;
  blockerTone?: MetaDecisionCenterExactTone;
  /** The server's next step, when it stated one. */
  resolution?: MetaDecisionCenterExactDisplayValue;
  money?: MetaDecisionCenterExactDisplayValue;
  confidence?: MetaDecisionCenterExactDisplayValue;
  confidenceTone?: MetaDecisionCenterExactTone;
  /** True when the server capped this row's confidence for stale evidence. */
  staleDemoted?: boolean;
  staleDemotedReason?: MetaDecisionCenterExactDisplayValue;
  /** Ownership, from the workflow overlay read. Absent when it was not read. */
  workflowChip?: MetaDecisionCenterExactRowWorkflowChip | null;
  onOpen?: () => void;
}

export interface MetaDecisionCenterExactWatchSegmentViewModel {
  id: string;
  label?: MetaDecisionCenterExactDisplayValue;
  count?: MetaDecisionCenterExactDisplayValue;
}

export interface MetaDecisionCenterExactWatchingRowViewModel {
  id: string;
  segment?: MetaDecisionCenterExactDisplayValue;
  segmentTone?: MetaDecisionCenterExactTone;
  name?: MetaDecisionCenterExactDisplayValue;
  level?: MetaDecisionCenterExactDisplayValue;
  /** @see MetaDecisionCenterExactActionRowViewModel.lineage */
  lineage?: MetaDecisionCenterExactDisplayValue;
  /** @see MetaDecisionCenterExactActionRowViewModel.lineageRole */
  lineageRole?: "parent" | "child";
  /** True when this is the row the evidence inspector is describing. */
  selected?: boolean;
  note?: MetaDecisionCenterExactDisplayValue;
  money?: MetaDecisionCenterExactDisplayValue;
  /** Opens this row in the evidence inspector from anywhere on the card. */
  onOpen?: () => void;
  onReview?: () => void;
}

export interface MetaDecisionCenterExactHealthyGroupViewModel {
  id: string;
  name?: MetaDecisionCenterExactDisplayValue;
  strategy?: MetaDecisionCenterExactDisplayValue;
  rollup?: MetaDecisionCenterExactDisplayValue;
  adsets?: readonly {
    id: string;
    name?: MetaDecisionCenterExactDisplayValue;
    stats?: MetaDecisionCenterExactDisplayValue;
  }[];
}

export interface MetaDecisionCenterExactNonSalesViewModel {
  id?: string;
  name?: MetaDecisionCenterExactDisplayValue;
  level?: MetaDecisionCenterExactDisplayValue;
  contextLabel?: MetaDecisionCenterExactDisplayValue;
  metrics?: readonly {
    id: string;
    label?: MetaDecisionCenterExactDisplayValue;
    value?: MetaDecisionCenterExactDisplayValue;
  }[];
  note?: MetaDecisionCenterExactDisplayValue;
}

export interface MetaDecisionCenterExactArchiveRowViewModel {
  id: string;
  name?: MetaDecisionCenterExactDisplayValue;
  status?: MetaDecisionCenterExactDisplayValue;
  statusTone?: MetaDecisionCenterExactTone;
  spend?: MetaDecisionCenterExactDisplayValue;
  note?: MetaDecisionCenterExactDisplayValue;
  /** Controls only the canonical visual affordance; authority stays outside this component. */
  showResume?: boolean;
  onResume?: () => void;
}

export interface MetaDecisionCenterExactCreativePostureViewModel {
  id: string;
  label?: MetaDecisionCenterExactDisplayValue;
  value?: MetaDecisionCenterExactDisplayValue;
  detail?: MetaDecisionCenterExactDisplayValue;
  tone?: MetaDecisionCenterExactTone;
}

export interface MetaDecisionCenterExactCreativeDecisionViewModel {
  id: string;
  name?: MetaDecisionCenterExactDisplayValue;
  kindShort?: MetaDecisionCenterExactDisplayValue;
  stripeA?: string | null;
  stripeB?: string | null;
  edgeTone?: MetaDecisionCenterExactTone;
  decisionLabel?: MetaDecisionCenterExactDisplayValue;
  decisionTone?: MetaDecisionCenterExactTone;
  /**
   * The served decision STATE — `act`, `blocked` or `monitor` — printed on the
   * row itself.
   *
   * The server keeps the state apart from the verdict on purpose: a held or
   * blocked decision carries a label the same shape as an actionable one, and
   * pooling them into one list is what made a withheld call read as an ordinary
   * recommendation. This badge is the state, never a re-reading of it.
   */
  stateLabel?: MetaDecisionCenterExactDisplayValue;
  stateTone?: MetaDecisionCenterExactTone;
  chips?: readonly MetaDecisionCenterExactDisplayValue[];
  /** The server's own `whyNow` sentence for this row. */
  note?: MetaDecisionCenterExactDisplayValue;
  /** The server's `blockers` and `resolution.nextStep`, joined, never invented. */
  blockedNote?: MetaDecisionCenterExactDisplayValue;
  sparkPath?: string | null;
  money?: MetaDecisionCenterExactDisplayValue;
  moneySub?: MetaDecisionCenterExactDisplayValue;
  actionLabel?: MetaDecisionCenterExactDisplayValue;
  actionTone?: MetaDecisionCenterExactTone;
  onPrimary?: () => void;
  onOpen?: () => void;
}

/**
 * One served decision state, with the rows that carry it.
 *
 * The Creatives scope used to render a single flat list, so `act`, `blocked`
 * and `monitor` decisions sat as visual peers. Grouping is the smallest change
 * that keeps the served state legible without the UI deciding anything: the
 * group key is the server's lane, the label is that lane's name, and the counts
 * are the server's own pre-cap totals beside what this screen is showing.
 */
export interface MetaDecisionCenterExactCreativeGroupViewModel {
  id: string;
  label?: MetaDecisionCenterExactDisplayValue;
  tone?: MetaDecisionCenterExactTone;
  /** "12 shown · 80 eligible pre-cap", written from distinct server counts. */
  count?: MetaDecisionCenterExactDisplayValue;
  /** The action vocabulary the server actually served for this group. */
  note?: MetaDecisionCenterExactDisplayValue;
  rows: readonly MetaDecisionCenterExactCreativeDecisionViewModel[];
}

/**
 * One label/value pair inside the source provenance panel.
 *
 * The label names the served field; the value is the server's own token,
 * string or count, or an em dash when the field was not served. Nothing here
 * is derived from a decision, and nothing here is a sentence this UI wrote.
 */
export interface MetaDecisionCenterExactSourceFactViewModel {
  id: string;
  label?: MetaDecisionCenterExactDisplayValue;
  value?: MetaDecisionCenterExactDisplayValue;
  tone?: MetaDecisionCenterExactTone;
}

/**
 * One of the eight named capability states, shown because it is NOT available.
 *
 * `status` and `reason` are copied from the payload verbatim. A capability the
 * server reports as available is not listed: the panel names what is missing,
 * and the summary line states how many of the eight that is.
 */
export interface MetaDecisionCenterExactCapabilityGapViewModel {
  id: string;
  label?: MetaDecisionCenterExactDisplayValue;
  status?: MetaDecisionCenterExactDisplayValue;
  /** The server's own reason string, never a substitute sentence. */
  reason?: MetaDecisionCenterExactDisplayValue;
  tone?: MetaDecisionCenterExactTone;
}

/**
 * What the decision source is, and what it could not do — beside the rows.
 *
 * The Creatives scope used to say this ONLY when the queue was empty, so an
 * account serving `authority: "legacy_creative"`, `health: "degraded"` and a
 * fallback reason rendered sixty confidently formatted rows and stated none of
 * it. Degradation is a property of the source, not of the row count, so this
 * renders whenever the scope renders.
 *
 * It is a disclosure so the rows stay the primary content, and it is open by
 * default so nothing is hidden until the operator folds it away: the summary
 * line itself carries the authority, the health, the fallback reason, the
 * shown-vs-served counts and the number of capability gaps, so even collapsed
 * the screen cannot read as "fine".
 */
export interface MetaDecisionCenterExactSourceProvenanceViewModel {
  /** "native_ad · healthy" — the served authority and status, joined. */
  headline?: MetaDecisionCenterExactDisplayValue;
  tone?: MetaDecisionCenterExactTone;
  /** "60 shown · 80 served pre-cap", from server counts only. */
  coverageSummary?: MetaDecisionCenterExactDisplayValue;
  /** "2 of 8 not available", counted over the served capability states. */
  capabilitySummary?: MetaDecisionCenterExactDisplayValue;
  source?: readonly MetaDecisionCenterExactSourceFactViewModel[];
  coverage?: readonly MetaDecisionCenterExactSourceFactViewModel[];
  /** The served suppression envelope: one row per reason code, with its count. */
  suppression?: readonly MetaDecisionCenterExactSourceFactViewModel[];
  /** The served limitations: the server's code and the server's message. */
  limitations?: readonly MetaDecisionCenterExactSourceFactViewModel[];
  capabilityGaps?: readonly MetaDecisionCenterExactCapabilityGapViewModel[];
}

/**
 * The per-row ownership chip (H09 `wf-chip`).
 *
 * Carries only what the overlay read returned. `state` is the record's own
 * state or `unknown` for a read that failed; there is no default, because
 * printing "Open" for an unread overlay claims nobody owns the decision.
 */
export interface MetaDecisionCenterExactRowWorkflowChip {
  readonly state:
    | "open"
    | "acknowledged"
    | "deferred"
    | "snoozed"
    | "rejected"
    | "resolved"
    | "unknown";
  readonly label: MetaDecisionCenterExactDisplayValue;
  readonly tone?: MetaDecisionCenterExactTone;
  /** Assignee or hold, when the record carried one. */
  readonly detail?: MetaDecisionCenterExactDisplayValue;
}

/** One of the seven transitions, plus what the surface may do with it. */
export interface MetaDecisionCenterExactWorkflowAction {
  readonly id:
    | "assign"
    | "acknowledge"
    | "defer"
    | "snooze"
    | "reject"
    | "resolve"
    | "reopen";
  readonly label: string;
  /**
   * Non-null exactly when the action may not run. Rendered on the control
   * itself, which stays focusable and `aria-disabled` rather than `disabled` —
   * a control that leaves the tab order takes its own explanation with it.
   */
  readonly refusalReason: string | null;
  readonly onSelect?: () => void;
}

export interface MetaDecisionCenterExactWorkflow {
  /** `unknown` is a read that failed, never a default. */
  readonly state:
    | "open"
    | "acknowledged"
    | "deferred"
    | "snoozed"
    | "rejected"
    | "resolved"
    | "unknown";
  readonly stateLabel: MetaDecisionCenterExactDisplayValue;
  /** Who holds it, or the unavailable mark. Never "unassigned" by inference. */
  readonly assignee: MetaDecisionCenterExactDisplayValue;
  /** The design's own "Let cook until …" line, from the record's snoozeUntil. */
  readonly holdUntil: MetaDecisionCenterExactDisplayValue;
  /** Present when the overlay could not be read. */
  readonly unavailableReason?: string | null;
  readonly actions: readonly MetaDecisionCenterExactWorkflowAction[];
  /** The one sentence explaining why every action is refused, when they all are. */
  readonly actionsRefusedReason?: string | null;
}

export interface MetaDecisionCenterExactInspectorViewModel {
  entityName?: MetaDecisionCenterExactDisplayValue;
  entityMeta?: MetaDecisionCenterExactDisplayValue;
  decisionLabel?: MetaDecisionCenterExactDisplayValue;
  tone?: MetaDecisionCenterExactTone;
  serverVerdict?: MetaDecisionCenterExactDisplayValue;
  contractDetail?: MetaDecisionCenterExactDisplayValue;
  reasons?: readonly MetaDecisionCenterExactDisplayValue[];
  moneyValue?: MetaDecisionCenterExactDisplayValue;
  targetComparison?: MetaDecisionCenterExactDisplayValue;
  moneySparkPath?: string | null;
  moneyDetail?: MetaDecisionCenterExactDisplayValue;
  confidence?: MetaDecisionCenterExactDisplayValue;
  readiness?: MetaDecisionCenterExactDisplayValue;
  blockers?: MetaDecisionCenterExactDisplayValue;
  blockerTone?: MetaDecisionCenterExactTone;
  /**
   * What the server can state but cannot yet measure — kept out of the
   * Blockers line because nothing here withholds an action. Rendered under its
   * own heading so an operator can read "risk is unclassified, because the
   * producer is not persisted" without reading it as a refusal.
   */
  advisories?: MetaDecisionCenterExactDisplayValue;
  /**
   * The operator workflow overlay for THIS decision (WP8).
   *
   * Ownership state, not engine truth. Nothing here can change a decision's
   * label, its authority, or whether a provider action is permitted —
   * `lib/decision-workflow.ts` owns that separation and this only renders its
   * result. A decision that is deferred is still exactly as true as it was.
   *
   * `null` means the surface was not given one, which is different from a read
   * that failed: the read failure arrives as `state: "unknown"` with a reason,
   * because rendering "open" for an unread overlay would claim nobody owns
   * these decisions on no evidence at all.
   */
  workflow?: MetaDecisionCenterExactWorkflow | null;
  evidence?: readonly {
    id: string;
    label?: MetaDecisionCenterExactDisplayValue;
    value?: MetaDecisionCenterExactDisplayValue;
  }[];
  actionLabel?: MetaDecisionCenterExactDisplayValue;
  actionTone?: MetaDecisionCenterExactTone;
  provenance?: MetaDecisionCenterExactDisplayValue;
  onPrimary?: () => void;
}

export interface MetaDecisionCenterExactViewModel {
  identity?: MetaDecisionCenterExactIdentityViewModel;
  activeWindow?: MetaDecisionCenterExactWindow | null;
  counts?: MetaDecisionCenterExactCountsViewModel;
  kpis?: MetaDecisionCenterExactKpisViewModel;
  actionRows?: readonly MetaDecisionCenterExactActionRowViewModel[];
  /** Rows the server classified `blocked`. @see MetaDecisionCenterExactLane */
  needsResolutionRows?: readonly MetaDecisionCenterExactNeedsResolutionRowViewModel[];
  /**
   * Why the Needs Resolution lane has nothing to show, when that is knowable.
   *
   * An account whose payload carries no decision projection at all cannot be
   * said to have zero blocked decisions — that is an unread lane, not an empty
   * one, and the two must not look the same. Server-authored; absent when the
   * projection was read and genuinely held no blocked row.
   */
  needsResolutionNotice?: MetaDecisionCenterExactDisplayValue;
  watchSegments?: readonly MetaDecisionCenterExactWatchSegmentViewModel[];
  watchingRows?: readonly MetaDecisionCenterExactWatchingRowViewModel[];
  healthyGroups?: readonly MetaDecisionCenterExactHealthyGroupViewModel[];
  nonSales?: readonly MetaDecisionCenterExactNonSalesViewModel[] | null;
  archiveRows?: readonly MetaDecisionCenterExactArchiveRowViewModel[];
  /**
   * Why the Creatives scope has nothing to show, when that is knowable.
   *
   * An empty queue and a refused decision source look identical, and the second
   * is the one an operator needs to know about. Rendered in place rather than as
   * a page banner: the question is asked inside this scope, so it is answered
   * there.
   */
  creativesNotice?: MetaDecisionCenterExactDisplayValue;
  /**
   * The served decision source, its health and its gaps — rendered beside the
   * rows rather than instead of them.
   *
   * @see MetaDecisionCenterExactSourceProvenanceViewModel
   */
  sourceProvenance?: MetaDecisionCenterExactSourceProvenanceViewModel | null;
  /**
   * The same envelope, stated in the Structures scope.
   *
   * The Structures scope used to name no source at all, while drawing the
   * action buttons that `providerWriteLinkage` and `responseAttribution`
   * govern. It is the SAME served read model and the SAME view-model type,
   * rendered by the SAME panel — only the fields differ, because the ads
   * pre-cap counts and the ad-grain limitations do not describe a campaign or
   * an ad set and are withheld rather than reprinted under a structure
   * heading.
   *
   * @see MetaDecisionCenterExactSourceProvenanceViewModel
   */
  structureProvenance?: MetaDecisionCenterExactSourceProvenanceViewModel | null;
  creativePosture?: readonly MetaDecisionCenterExactCreativePostureViewModel[];
  creativeDecisions?: readonly MetaDecisionCenterExactCreativeDecisionViewModel[];
  /**
   * The same rows as `creativeDecisions`, split by the served decision state.
   *
   * Both fields exist because they answer different questions: the flat list is
   * what was rendered, the groups are what the server said about each row. The
   * groups win when present; `creativeDecisions` is the fallback for callers
   * that supply rows without state.
   */
  creativeGroups?: readonly MetaDecisionCenterExactCreativeGroupViewModel[];
  /**
   * The closing sentence under the creative queue.
   *
   * It used to be hard-coded prose naming three ad-level calls. The server's
   * vocabulary is not three and is not fixed, so the sentence is now written by
   * the adapter from the action labels this account was actually served.
   */
  creativeFootnote?: MetaDecisionCenterExactDisplayValue;
  inspector?: MetaDecisionCenterExactInspectorViewModel | null;
}

export interface MetaDecisionCenterExactProps {
  viewModel: MetaDecisionCenterExactViewModel;
  scope?: MetaDecisionCenterExactScope;
  defaultScope?: MetaDecisionCenterExactScope;
  lane?: MetaDecisionCenterExactLane;
  defaultLane?: MetaDecisionCenterExactLane;
  inspectorOpen?: boolean;
  onScopeChange?: (scope: MetaDecisionCenterExactScope) => void;
  onLaneChange?: (lane: MetaDecisionCenterExactLane) => void;
  onRunSnapshot?: () => void;
  onNewCampaign?: () => void;
  onManageLabels?: () => void;
  onSortChange?: (sort: MetaDecisionCenterExactSort) => void;
  onSearchChange?: (query: string) => void;
  /**
   * The search term restored from the deep link. The queue is filtered by
   * the page against this same value, so if the box did not show it the
   * operator saw a filtered queue, an empty search box, and no explanation
   * for the rows that were missing.
   */
  initialQuery?: string;
  onOpenCreativeStudio?: () => void;
}

export type MetaDecisionCenterExactSort = "money" | "priority" | "age";

const LANES: readonly { id: MetaDecisionCenterExactLane; label: string }[] = [
  { id: "action", label: "Action Now" },
  // Between the lane that promises an action and the one that promises none:
  // these rows have a verdict and no authority for it.
  { id: "needsres", label: "Needs Resolution" },
  { id: "watching", label: "Watching" },
  { id: "healthy", label: "Healthy" },
  { id: "nonsales", label: "Non-sales" },
  { id: "archive", label: "Archive" },
];

const TONE_CLASS: Record<MetaDecisionCenterExactTone, string> = {
  positive: styles.tonePositive,
  negative: styles.toneNegative,
  warning: styles.toneWarning,
  info: styles.toneInfo,
  automation: styles.toneAutomation,
  neutral: styles.toneNeutral,
};

function display(value: MetaDecisionCenterExactDisplayValue): string {
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : EM_DASH;
  if (typeof value !== "string") return EM_DASH;
  return value.trim() || EM_DASH;
}

function nonBlankDisplay(value: MetaDecisionCenterExactDisplayValue): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function meaningfulDisplay(
  value: MetaDecisionCenterExactDisplayValue,
): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim() !== EM_DASH
  );
}

function toneClass(
  tone: MetaDecisionCenterExactTone | null | undefined,
): string {
  return TONE_CLASS[tone ?? "neutral"];
}

/**
 * A name for an action button whose whole label is the em dash.
 *
 * Keeping the design's geometry when nothing is served is right — the button
 * stays, dimmed and inert — but its rendered label is then a single dash, so
 * assistive tech announces an unnamed dimmed button and nothing explains why.
 * This says why, without changing a pixel. `undefined` for a real label, so a
 * served action keeps its own text as its accessible name.
 */
function unservedActionName(
  label: string,
  subject: string,
): string | undefined {
  return label === EM_DASH ? `No action available: ${subject}` : undefined;
}

function slots<T>(
  values: readonly T[] | null | undefined,
  count: number,
): Array<T | undefined> {
  return Array.from({ length: count }, (_, index) => values?.[index]);
}

function callWithPropagationStopped(event: MouseEvent, callback?: () => void) {
  event.stopPropagation();
  callback?.();
}

/**
 * Keyboard operation for the controls the design draws as spans and divs.
 *
 * The reference pins these as non-button elements and the geometry tests pin
 * that back, so they keep their tag. What they cannot keep is being unreachable:
 * a scope tab, a lane tab, a window segment and the row overflow glyph were all
 * plain `onClick` spans, which meant the entire queue was mouse-only. Role,
 * tab stop and Enter/Space go on without moving a pixel.
 */
function activate(event: KeyboardEvent, callback?: () => void) {
  if (!callback) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  callback();
}

/** Props that turn a design-pinned span/div into a real, named control. */
function controlProps(callback: (() => void) | undefined, label?: string) {
  return {
    role: "button" as const,
    tabIndex: callback ? 0 : -1,
    "aria-disabled": callback ? undefined : true,
    "aria-label": label,
    onClick: callback,
    onKeyDown: (event: KeyboardEvent) => activate(event, callback),
  };
}

/**
 * The whole queue row as one target, without nesting controls inside a control.
 *
 * Only the tiny overflow glyph opened the evidence inspector, so the operator
 * clicked a card and nothing happened. Making the card itself a `role="button"`
 * would have been worse than the bug: ARIA gives a button presentational
 * children, so the row's own action button and overflow control would stop
 * being announced. This is the stretched-link shape instead -- a real,
 * keyboard-native `<button>` covering the card, painted UNDER the row's own
 * controls, so Enter and Space work for free and the controls inside keep their
 * own clicks and their own names.
 */
function QueueCardOpen({
  label,
  onOpen,
}: {
  label: string;
  onOpen?: () => void;
}) {
  if (!onOpen) return null;
  return (
    <button
      aria-label={label}
      className={styles.cardOpen}
      data-ctl="live:META-DEC-05 open-inspector"
      data-meta-exact-card-open
      onClick={onOpen}
      type="button"
    />
  );
}

/**
 * The ownership chip the design draws on every queue row.
 *
 * The workflow overlay's state was reachable only by opening the inspector, so
 * a queue of forty rows could not be scanned for "which of these has somebody
 * already taken". `unknown` is a read that failed and says so; the chip is
 * absent entirely when the overlay was never read, because "Open" would be a
 * claim that nobody owns these decisions made on no evidence.
 */
function QueueWorkflowChip({
  chip,
}: {
  chip?: MetaDecisionCenterExactRowWorkflowChip | null;
}) {
  if (!chip) return null;
  return (
    <span
      className={`${styles.rowChip} ${toneClass(chip.tone)}`}
      data-el="wf-chip"
      data-workflow-state={chip.state}
      title={chip.detail ? display(chip.detail) : undefined}
    >
      {display(chip.label)}
    </span>
  );
}

/**
 * The server's own statement that this row's confidence was capped.
 *
 * Demoted, not dropped: the verdict is still served and still printed. The
 * reason comes from the server — `INVARIANTS.md` forbids deriving it from
 * label text — and the row keeps its ordinary styling so a low-confidence row
 * cannot be mistaken for a high-confidence one by shape alone.
 */
function QueueStaleDemoted({
  demoted,
  reason,
}: {
  demoted?: boolean;
  reason?: MetaDecisionCenterExactDisplayValue;
}) {
  if (!demoted) return null;
  return (
    <span className={styles.staleDemoted} data-el="stale-demoted">
      {meaningfulDisplay(reason)
        ? display(reason)
        : "Confidence was capped for this row; the verdict is still served."}
    </span>
  );
}

/**
 * The campaign -> ad set relation, on the row that has one.
 *
 * Rendered only when the adapter produced a relation: a campaign with no ad-set
 * row beside it in this lane is not "0 ad sets", it is a question this lane does
 * not answer, so it says nothing at all.
 */
function QueueLineage({
  lineage,
  role,
}: {
  lineage?: MetaDecisionCenterExactDisplayValue;
  role?: "parent" | "child";
}) {
  if (!nonBlankDisplay(lineage)) return null;
  return (
    <p className={styles.lineage} data-meta-exact-lineage={role ?? "child"}>
      {role === "child" ? (
        <span aria-hidden="true" className={styles.lineageGlyph}>
          &#8627;
        </span>
      ) : null}
      {display(lineage)}
    </p>
  );
}

/**
 * The row the inspector is describing, said in more than colour.
 *
 * A tinted card and a ring are invisible to a colour-blind operator and to a
 * screen reader alike, so the state is also a word on the card and an
 * `aria-current` on the row.
 */
function QueueSelectedMarker({ selected }: { selected?: boolean }) {
  if (!selected) return null;
  return <span className={styles.selectedMarker}>Inspecting</span>;
}

function ExactKpiBand({
  kpis,
  onManageLabels,
  activeWindow,
}: {
  kpis?: MetaDecisionCenterExactKpisViewModel;
  onManageLabels?: () => void;
  /**
   * The window the header control shows as pressed. Used ONLY while the
   * served label is absent — during loading the window is already known from
   * the control, so an em-dash here would contradict the pill beside it,
   * while a hardcoded "28d" would assert a window nobody selected.
   */
  activeWindow: string;
}) {
  const modeChips = slots(kpis?.mode?.chips, 2);
  return (
    <div className={styles.kpiGrid} data-meta-exact-section="kpis">
      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>Spend · today</p>
        <p className={styles.kpiValue}>
          {display(kpis?.spend?.value)}{" "}
          <span className={styles.spendDelta}>
            {display(kpis?.spend?.delta)}
          </span>
        </p>
        <p className={styles.kpiDetail}>{display(kpis?.spend?.detail)}</p>
      </article>

      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>
          {display(kpis?.roas?.label ?? `ROAS · ${activeWindow}`)}
        </p>
        <p className={styles.kpiValue}>
          {display(kpis?.roas?.value)}{" "}
          {/*
           * The noun comes with the value, it is NOT written here.
           *
           * The pulse resolves this reference from four sources and the tile
           * shows whichever one is in force — including the account median it
           * measures when the business unit has no commercial-truth target.
           * A hardcoded "target" prefix would relabel that median as a target
           * the operator set, which is the one reading the adapter's wording
           * exists to prevent. Nothing served: "target —", the same absence
           * this tile has always shown before an answer arrives.
           */}
          <span className={styles.roasTarget}>
            {kpis?.roas?.target == null || kpis.roas.target === ""
              ? `target ${EM_DASH}`
              : display(kpis.roas.target)}
          </span>
        </p>
        <svg
          aria-hidden="true"
          className={styles.roasSpark}
          viewBox="0 0 100 20"
          preserveAspectRatio="none"
        >
          <path
            d="M0 12 L100 12"
            stroke="#C9D2E0"
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={kpis?.roas?.sparkPath ?? ""}
            fill="none"
            stroke="#2a5fe2"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </article>

      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>Snapshot</p>
        <span className={styles.freshnessPill}>
          {display(kpis?.snapshot?.freshness)}
        </span>
        <p className={styles.snapshotDetail}>
          {display(kpis?.snapshot?.detail)}
        </p>
      </article>

      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>Labels</p>
        <p className={styles.kpiValue}>
          {display(kpis?.labels?.coverage)}{" "}
          <span className={styles.labelPercentage}>
            {display(kpis?.labels?.percentage)}
          </span>
        </p>
        <p className={styles.manageLabels} {...controlProps(onManageLabels)}>
          Manage labels →
        </p>
      </article>

      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>Mode</p>
        <p className={styles.modeValue}>{display(kpis?.mode?.value)}</p>
        <div className={styles.modeChips}>
          {modeChips.map((chip, index) => (
            <span
              className={`${styles.modeChip} ${toneClass(chip?.tone)}`}
              key={`mode-chip-${index}`}
            >
              {display(chip?.label)}
            </span>
          ))}
        </div>
      </article>
    </div>
  );
}

/**
 * How many rows a lane draws before the operator asks for more.
 *
 * The queue used to render every served row at once and state neither how many
 * were drawn nor how many were served, so an account with 600 blocked ads
 * produced 600 cards and no count. Paging locally is the honest shape here: the
 * server already sent this lane's rows, so "load more" appends the next SERVED
 * page rather than issuing a read, and the strip restates showing-X-of-Y after
 * every press — which is exactly what `live:META-DEC-05 load-more` contracts.
 */
const LANE_PAGE_SIZE = 25;

/**
 * The showing-X-of-Y strip, and the control that extends it.
 *
 * Rendered whenever a lane has rows, not only when it has more than one page:
 * "Showing 6 of 6" is a fact an operator needs in order to trust that the lane
 * is complete, and a strip that appears only when something is hidden teaches
 * them that its absence means nothing.
 */
function LanePaging({
  shown,
  served,
  onLoadMore,
  label,
}: {
  shown: number;
  served: number;
  onLoadMore?: () => void;
  label: string;
}) {
  const complete = shown >= served;
  return (
    <p className={styles.lanePaging} data-meta-exact-lane-paging={label}>
      <span data-lane-count="">
        Showing {shown} of {served} served {served === 1 ? "row" : "rows"}
      </span>
      {complete ? (
        <span data-lane-paging-complete="">
          {" · "}All {served} served {served === 1 ? "row is" : "rows are"} shown
        </span>
      ) : (
        <button
          className={styles.lanePagingMore}
          data-ctl="live:META-DEC-05 load-more"
          onClick={onLoadMore}
          type="button"
        >
          Show more
        </button>
      )}
    </p>
  );
}

/** A lane that served no rows, said rather than drawn as blankness. */
function LaneEmpty({
  reason,
  lane,
}: {
  reason: string;
  lane: string;
}) {
  return (
    <p className={styles.laneEmpty} data-meta-exact-lane-empty={lane} role="status">
      {reason}
    </p>
  );
}

function ActionLane({
  rows,
  shown,
  onLoadMore,
}: {
  rows: readonly MetaDecisionCenterExactActionRowViewModel[];
  shown: number;
  onLoadMore?: () => void;
}) {
  const page = rows.slice(0, shown);
  if (rows.length === 0) {
    return (
      <LaneEmpty
        lane="action"
        reason="No rows were served in this lane for this account and snapshot."
      />
    );
  }
  return (
    <div data-collection="decisions" data-meta-exact-lane-body="action">
      {page.map((row) => (
        <article
          aria-current={row.selected ? "true" : undefined}
          className={`${styles.actionCard} ${toneClass(row.edgeTone)} ${
            row.selected ? styles.queueCardSelected : ""
          }`}
          data-meta-exact-action-row={row.id}
          data-meta-exact-selected={row.selected ? "true" : undefined}
          key={row.id}
        >
          <QueueCardOpen
            label={`Open evidence for ${display(row.name)}`}
            onOpen={row.onOpen}
          />
          <div className={styles.actionIdentity}>
            <div className={styles.entityHeading}>
              <span className={styles.entityName}>{display(row.name)}</span>
              <span className={styles.entityLevel}>{display(row.level)}</span>
              <QueueSelectedMarker selected={row.selected} />
            </div>
            <QueueLineage lineage={row.lineage} role={row.lineageRole} />
            <div className={styles.rowChips}>
              {(row.chips ?? []).map((chip, index) => (
                <span
                  className={styles.rowChip}
                  key={`${row.id}-chip-${index}`}
                >
                  {display(chip)}
                </span>
              ))}
              <QueueWorkflowChip chip={row.workflowChip} />
            </div>
            <QueueStaleDemoted
              demoted={row.staleDemoted}
              reason={row.staleDemotedReason}
            />
          </div>
          <span
            className={`${styles.decisionLabel} ${toneClass(row.decisionTone)}`}
            data-el="verdict-chip"
          >
            {display(row.decisionLabel)}
          </span>
          <div className={styles.moneyBlock}>
            <p className={styles.moneyValue}>{display(row.money)}</p>
            <p className={styles.moneySub}>{display(row.moneySub)}</p>
          </div>
          <span
            className={`${styles.confidencePill} ${toneClass(row.confidenceTone)}`}
          >
            {display(row.confidence)} confidence
          </span>
          <button
            aria-label={unservedActionName(
              display(row.actionLabel),
              "this decision was served without one",
            )}
            className={`${styles.primaryAction} ${toneClass(row.actionTone)}`}
            disabled={!row.onPrimary}
            onClick={row.onPrimary}
            type="button"
          >
            {display(row.actionLabel)}
          </button>
          <span
            className={styles.moreAction}
            {...controlProps(
              row.onMenu,
              `Open evidence for ${display(row.name)}`,
            )}
          >
            ⋯
          </span>
        </article>
      ))}
      <LanePaging
        label="action"
        onLoadMore={onLoadMore}
        served={rows.length}
        shown={page.length}
      />
    </div>
  );
}

/**
 * The lane for rows whose authority the server withheld.
 *
 * Deliberately actionless. Every other lane's card ends in a primary button;
 * this one ends in the blocker and the server's next step, because a blocked
 * decision has no authorized action and drawing a disabled one would suggest
 * the operator is one permission away from something the engine has not
 * decided.
 */
function NeedsResolutionLane({
  rows,
  shown,
  notice,
  onLoadMore,
}: {
  rows: readonly MetaDecisionCenterExactNeedsResolutionRowViewModel[];
  shown: number;
  notice?: MetaDecisionCenterExactDisplayValue;
  onLoadMore?: () => void;
}) {
  const page = rows.slice(0, shown);
  if (rows.length === 0) {
    return (
      <LaneEmpty
        lane="needsres"
        reason={
          meaningfulDisplay(notice)
            ? display(notice)
            : "No rows were served in this lane for this account and snapshot."
        }
      />
    );
  }
  return (
    <div data-collection="needsres" data-meta-exact-lane-body="needsres">
      {page.map((row) => (
        <article
          aria-current={row.selected ? "true" : undefined}
          className={`${styles.actionCard} ${styles.needsResolutionCard} ${
            row.selected ? styles.queueCardSelected : ""
          }`}
          data-meta-exact-needsres-row={row.id}
          data-meta-exact-selected={row.selected ? "true" : undefined}
          key={row.id}
        >
          <QueueCardOpen
            label={`Open evidence for ${display(row.name)}`}
            onOpen={row.onOpen}
          />
          <div className={styles.actionIdentity}>
            <div className={styles.entityHeading}>
              <span className={styles.entityName}>{display(row.name)}</span>
              <span className={styles.entityLevel}>{display(row.level)}</span>
              <QueueSelectedMarker selected={row.selected} />
            </div>
            <QueueLineage lineage={row.lineage} role={row.lineageRole} />
            <div className={styles.rowChips}>
              <QueueWorkflowChip chip={row.workflowChip} />
            </div>
            <QueueStaleDemoted
              demoted={row.staleDemoted}
              reason={row.staleDemotedReason}
            />
          </div>
          <span
            className={`${styles.decisionLabel} ${toneClass(row.decisionTone)}`}
            data-el="verdict-chip"
          >
            {display(row.decisionLabel)}
          </span>
          <div className={styles.moneyBlock}>
            <p className={styles.moneyValue}>{display(row.money)}</p>
          </div>
          <span
            className={`${styles.confidencePill} ${toneClass(row.confidenceTone)}`}
          >
            {display(row.confidence)} confidence
          </span>
          {/*
            The blocker, in the server's words. This is the whole point of the
            lane: the row is here because `node.lane === "blocked"`, and the
            operator's next question is what is holding it.
          */}
          <span
            className={`${styles.blockerChip} ${toneClass(row.blockerTone ?? "warning")}`}
            data-el="blocker-chip"
          >
            {display(row.blocker)}
          </span>
          {meaningfulDisplay(row.resolution) ? (
            <p
              className={styles.needsResolutionStep}
              data-meta-exact-needsres-step={row.id}
            >
              {display(row.resolution)}
            </p>
          ) : null}
        </article>
      ))}
      <LanePaging
        label="needsres"
        onLoadMore={onLoadMore}
        served={rows.length}
        shown={page.length}
      />
    </div>
  );
}

function WatchingLane({
  segments,
  rows,
}: {
  segments: readonly MetaDecisionCenterExactWatchSegmentViewModel[];
  rows: readonly MetaDecisionCenterExactWatchingRowViewModel[];
}) {
  return (
    <>
      <div className={styles.watchSegments}>
        {slots(segments, 5).map((segment, index) => (
          <span
            className={styles.watchSegment}
            key={segment?.id ?? `watch-segment-${index}`}
          >
            {segment
              ? `${display(segment.label)} ${display(segment.count)}`
              : EM_DASH}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <article
          aria-current={row.selected ? "true" : undefined}
          className={`${styles.watchingCard} ${
            row.selected ? styles.queueCardSelected : ""
          }`}
          data-meta-exact-watching-row={row.id}
          data-meta-exact-selected={row.selected ? "true" : undefined}
          key={row.id}
        >
          <QueueCardOpen
            label={`Review ${display(row.name)}`}
            onOpen={row.onOpen}
          />
          <span
            className={`${styles.watchBadge} ${toneClass(row.segmentTone)}`}
          >
            {display(row.segment)}
          </span>
          <div className={styles.watchingIdentity}>
            <span className={styles.watchingName}>{display(row.name)}</span>
            <span className={styles.watchLevel}>{display(row.level)}</span>
            <QueueSelectedMarker selected={row.selected} />
            <QueueLineage lineage={row.lineage} role={row.lineageRole} />
            <p className={styles.watchingNote}>{display(row.note)}</p>
          </div>
          <span className={styles.watchingMoney}>{display(row.money)}</span>
          <button
            className={styles.reviewButton}
            disabled={!row.onReview}
            onClick={row.onReview}
            type="button"
          >
            Review
          </button>
        </article>
      ))}
    </>
  );
}

function HealthyLane({
  groups,
}: {
  groups: readonly MetaDecisionCenterExactHealthyGroupViewModel[];
}) {
  return (
    <>
      {groups.map((group) => (
        <article
          className={styles.healthyCard}
          data-meta-exact-healthy-group={group.id}
          key={group.id}
        >
          <div className={styles.healthyHeader}>
            <span className={styles.healthyDot} />
            <span className={styles.healthyName}>{display(group.name)}</span>
            <span className={styles.healthyStrategy}>
              {display(group.strategy)}
            </span>
            <span className={styles.healthyRollup}>
              {display(group.rollup)}
            </span>
          </div>
          {(group.adsets ?? []).map((adset) => (
            <div className={styles.healthyAdset} key={adset.id}>
              <span className={styles.healthyAdsetName}>
                {display(adset.name)}
              </span>
              <span className={styles.healthyStats}>
                {display(adset.stats)}
              </span>
            </div>
          ))}
        </article>
      ))}
    </>
  );
}

function NonSalesCard({
  card,
  id,
}: {
  card?: MetaDecisionCenterExactNonSalesViewModel | null;
  id?: string;
}) {
  const metrics = slots(card?.metrics, 4);
  return (
    <article
      className={styles.nonSalesCard}
      data-meta-exact-nonsales
      data-meta-exact-nonsales-row={id}
    >
      <div className={styles.nonSalesHeading}>
        <span className={styles.nonSalesName}>{display(card?.name)}</span>
        <span className={styles.nonSalesLevel}>{display(card?.level)}</span>
        <span className={styles.nonSalesContext}>
          {display(card?.contextLabel)}
        </span>
      </div>
      <div className={styles.nonSalesMetrics}>
        {metrics.map((metric, index) => (
          <div
            className={styles.nonSalesMetric}
            key={metric?.id ?? `non-sales-metric-${index}`}
          >
            <p className={styles.nonSalesMetricLabel}>
              {display(metric?.label)}
            </p>
            <p className={styles.nonSalesMetricValue}>
              {display(metric?.value)}
            </p>
          </div>
        ))}
      </div>
      <p className={styles.nonSalesNote}>{display(card?.note)}</p>
    </article>
  );
}

/**
 * Every non-sales entity, not just the first.
 *
 * The lane tab counts them all and the queue used to render exactly one card,
 * so an account with four upper-funnel campaigns showed `Non-sales 4` above a
 * single campaign and silently dropped three.
 */
function NonSalesLane({
  cards,
}: {
  cards: readonly MetaDecisionCenterExactNonSalesViewModel[];
}) {
  if (cards.length === 0) return <NonSalesCard card={null} />;
  return (
    <>
      {cards.map((card, index) => (
        <NonSalesCard
          card={card}
          id={card.id ?? `non-sales-${index}`}
          key={card.id ?? index}
        />
      ))}
    </>
  );
}

function ArchiveLane({
  rows,
  windowLabel,
}: {
  rows: readonly MetaDecisionCenterExactArchiveRowViewModel[];
  // The window is selectable from the header, so a fixed "28d" in this
  // column is a claim about which days were summed.
  windowLabel: string;
}) {
  return (
    <article className={styles.archiveCard} data-meta-exact-archive>
      <table className={styles.archiveTable}>
        <thead>
          <tr>
            <th>Entity</th>
            <th>Status</th>
            <th>{`Spend · ${windowLabel}`}</th>
            <th>Note</th>
            <th aria-label="Action" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{display(row.name)}</td>
              <td>
                <span
                  className={`${styles.archiveStatus} ${toneClass(row.statusTone)}`}
                >
                  {display(row.status)}
                </span>
              </td>
              <td>{display(row.spend)}</td>
              <td>{display(row.note)}</td>
              <td>
                {row.showResume === true ? (
                  <button
                    className={styles.resumeButton}
                    disabled={!row.onResume}
                    onClick={row.onResume}
                    type="button"
                  >
                    Resume
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

/**
 * One creative row.
 *
 * Extracted so the queue can render rows inside their served state group
 * without a second copy of the card drifting away from this one.
 */
function CreativeCard({
  row,
}: {
  row: MetaDecisionCenterExactCreativeDecisionViewModel;
}) {
  const stripeA = row.stripeA?.trim() || "#F1F4F9";
  const stripeB = row.stripeB?.trim() || "#F7F9FC";
  return (
    <article
      aria-label={
        row.onOpen ? `Open evidence for ${display(row.name)}` : undefined
      }
      className={`${styles.creativeCard} ${toneClass(row.edgeTone)}`}
      data-meta-exact-creative-row={row.id}
      data-meta-exact-creative-state={
        nonBlankDisplay(row.stateLabel)
          ? String(row.stateLabel).trim()
          : undefined
      }
      {...(row.onOpen
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick: row.onOpen,
            onKeyDown: (event: KeyboardEvent) => activate(event, row.onOpen),
          }
        : {})}
    >
      <span
        className={styles.creativeThumb}
        style={{
          backgroundImage: `repeating-linear-gradient(135deg,${stripeA},${stripeA} 8px,${stripeB} 8px,${stripeB} 16px)`,
        }}
      >
        <span className={styles.creativeKind}>{display(row.kindShort)}</span>
      </span>
      <div className={styles.creativeIdentity}>
        <div className={styles.creativeHeading}>
          <span className={styles.creativeName}>{display(row.name)}</span>
          <span
            className={`${styles.creativeDecisionLabel} ${toneClass(row.decisionTone)}`}
          >
            {display(row.decisionLabel)}
          </span>
          {nonBlankDisplay(row.stateLabel) ? (
            <span
              className={`${styles.creativeStateBadge} ${toneClass(row.stateTone)}`}
              data-meta-exact-creative-row-state
            >
              {display(row.stateLabel)}
            </span>
          ) : null}
        </div>
        <div className={styles.rowChips}>
          {(row.chips ?? []).map((chip, index) => (
            <span className={styles.rowChip} key={`${row.id}-chip-${index}`}>
              {display(chip)}
            </span>
          ))}
        </div>
        {nonBlankDisplay(row.note) ? (
          <p className={styles.creativeNote}>{display(row.note)}</p>
        ) : null}
        {nonBlankDisplay(row.blockedNote) ? (
          <p
            className={styles.creativeBlockedNote}
            data-meta-exact-creative-row-blockers
          >
            {display(row.blockedNote)}
          </p>
        ) : null}
      </div>
      <div className={styles.creativeSparkBlock}>
        <p className={styles.creativeSparkLabel}>CTR · 28d</p>
        <svg aria-hidden="true" viewBox="0 0 100 22" preserveAspectRatio="none">
          <path
            d={row.sparkPath ?? ""}
            fill="none"
            stroke="var(--tone-solid)"
            strokeWidth="1.6"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className={styles.creativeMoneyBlock}>
        <p className={styles.moneyValue}>{display(row.money)}</p>
        <p className={styles.moneySub}>{display(row.moneySub)}</p>
      </div>
      {/* The served action label is DECISION INFORMATION and stays on the row
          as text. It used to be the caption of the button below, which only
          ever opens the evidence window — there is exactly one creative
          callback, `onCreativeReview` — so the control promised an action it
          does not perform. The engine's word is unchanged and still visible;
          what moved is which element carries it. */}
      <p
        className={`${styles.creativeServedAction} ${toneClass(row.actionTone)}`}
        data-meta-exact-creative-served-action={
          nonBlankDisplay(row.actionLabel)
            ? String(row.actionLabel).trim()
            : undefined
        }
      >
        {display(row.actionLabel)}
      </p>
      <button
        aria-label={
          row.onPrimary
            ? `Review evidence for ${display(row.name)}`
            : `Evidence unavailable for ${display(row.name)}`
        }
        className={`${styles.primaryAction} ${toneClass(row.actionTone)}`}
        data-meta-exact-creative-review="true"
        disabled={!row.onPrimary}
        onClick={(event) => callWithPropagationStopped(event, row.onPrimary)}
        type="button"
      >
        Review evidence
      </button>
      <span
        className={styles.evidenceLink}
        {...controlProps(
          row.onOpen ? () => row.onOpen?.() : undefined,
          `Evidence for ${display(row.name)}`,
        )}
        onClick={(event) => callWithPropagationStopped(event, row.onOpen)}
      >
        Evidence →
      </span>
    </article>
  );
}

function SourceFactGroup({
  facts,
  group,
  heading,
}: {
  facts?: readonly MetaDecisionCenterExactSourceFactViewModel[];
  group: string;
  heading: string;
}) {
  if (!facts || facts.length === 0) return null;
  return (
    <div
      className={styles.provenanceGroup}
      data-meta-exact-source-group={group}
    >
      <p className={styles.provenanceHeading}>{heading}</p>
      <dl className={styles.provenanceGrid}>
        {facts.map((fact) => (
          <div
            className={styles.provenanceFact}
            data-meta-exact-source-fact={fact.id}
            key={fact.id}
          >
            <dt className={styles.provenanceLabel}>{display(fact.label)}</dt>
            <dd className={`${styles.provenanceValue} ${toneClass(fact.tone)}`}>
              {display(fact.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The served decision source, stated beside the rows.
 *
 * LAW: this renders whenever the Creatives scope renders. The previous notice
 * appeared only when `decisions.length === 0`, which meant a degraded source
 * with rows — the normal case on a real account — said nothing at all. Source
 * health is a property of the source, never of how many rows survived the cap.
 *
 * Every value inside is the server's own token, string or count; the component
 * writes the field LABELS and nothing else. `<details open>` keeps the rows
 * primary without hiding anything by default, and the summary repeats the
 * load-bearing facts so a folded panel still states the authority, the health,
 * the fallback reason, the shown-vs-served counts and the capability gaps.
 */
function SourceProvenancePanel({
  model,
  notice,
  scope,
  defaultOpen = true,
}: {
  model?: MetaDecisionCenterExactSourceProvenanceViewModel | null;
  /**
   * `viewModel.creativesNotice` — the served limitation joined to the served
   * fallback reason. It lives here now rather than under the queue, because
   * under the queue it was gated on the queue being empty.
   *
   * ONLY the Creatives scope passes it. Every limitation the notice joins is
   * ad-grain, so handing it to the Structures panel would attach an ads
   * refusal to campaign and ad-set rows it does not govern.
   */
  notice?: MetaDecisionCenterExactDisplayValue;
  /** Which scope's envelope this is, for the operator and for assertions. */
  scope: MetaDecisionCenterExactScope;
  /**
   * Open in Creatives, folded in Structures — and nothing is hidden either way.
   *
   * The Creatives scope opens onto a posture band, so the panel is one block
   * among several and stands open. The Structures scope opens onto the rows
   * themselves; an expanded panel of five fact groups there would be a wall
   * between the operator and the queue, which is not what a statement beside
   * the rows means. Folded, the summary still carries the source token, the
   * status, the coverage pairing and the count of capability gaps, so the
   * screen cannot read as "fine" while folded — which is the only property
   * that ever mattered about `open`.
   */
  defaultOpen?: boolean;
}) {
  if (!model) return null;
  return (
    <details
      className={`${styles.provenancePanel} ${toneClass(model.tone)}`}
      data-meta-exact-source-provenance
      data-meta-exact-source-scope={scope}
      open={defaultOpen}
    >
      <summary className={styles.provenanceSummary}>
        <span className={styles.provenanceEyebrow}>Decision source</span>
        <span
          className={`${styles.provenanceHeadline} ${toneClass(model.tone)}`}
          data-meta-exact-source-authority
        >
          {display(model.headline)}
        </span>
        <span
          className={styles.provenanceSummaryFact}
          data-meta-exact-source-coverage
        >
          {display(model.coverageSummary)}
        </span>
        <span
          className={styles.provenanceSummaryFact}
          data-meta-exact-source-capability-summary
        >
          {display(model.capabilitySummary)}
        </span>
      </summary>
      {nonBlankDisplay(notice) ? (
        <p
          className={styles.creativeNotice}
          data-meta-exact-creative-notice
          role="status"
        >
          {display(notice)}
        </p>
      ) : null}
      <SourceFactGroup facts={model.source} group="source" heading="Source" />
      <SourceFactGroup
        facts={model.coverage}
        group="coverage"
        heading="Coverage"
      />
      <SourceFactGroup
        facts={model.suppression}
        group="suppression"
        heading="Withheld from queue"
      />
      <SourceFactGroup
        facts={model.limitations}
        group="limitations"
        heading="Limitations"
      />
      {model.capabilityGaps && model.capabilityGaps.length > 0 ? (
        <div
          className={styles.provenanceGroup}
          data-meta-exact-source-group="capabilities"
        >
          <p className={styles.provenanceHeading}>Capability gaps</p>
          <ul className={styles.provenanceCapabilities}>
            {model.capabilityGaps.map((gap) => (
              <li
                className={styles.provenanceCapability}
                data-meta-exact-source-capability={gap.id}
                key={gap.id}
              >
                <span className={styles.provenanceLabel}>
                  {display(gap.label)}
                </span>
                <span
                  className={`${styles.provenanceStatus} ${toneClass(gap.tone)}`}
                >
                  {display(gap.status)}
                </span>
                <span className={styles.provenanceReason}>
                  {display(gap.reason)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </details>
  );
}

function CreativesScope({
  posture,
  decisions,
  groups,
  provenance,
  notice,
  footnote,
  onOpenCreativeStudio,
}: {
  posture: readonly MetaDecisionCenterExactCreativePostureViewModel[];
  decisions: readonly MetaDecisionCenterExactCreativeDecisionViewModel[];
  groups?: readonly MetaDecisionCenterExactCreativeGroupViewModel[];
  provenance?: MetaDecisionCenterExactSourceProvenanceViewModel | null;
  notice?: MetaDecisionCenterExactDisplayValue;
  footnote?: MetaDecisionCenterExactDisplayValue;
  onOpenCreativeStudio?: () => void;
}) {
  const servedGroups = (groups ?? []).filter((group) => group.rows.length > 0);
  return (
    <>
      <div className={styles.postureGrid} data-meta-exact-creative-posture>
        {slots(posture, 4).map((item, index) => (
          <div
            className={`${styles.postureCard} ${toneClass(item?.tone)}`}
            key={item?.id ?? `posture-${index}`}
          >
            <p className={styles.postureLabel}>{display(item?.label)}</p>
            <p className={styles.postureValue}>{display(item?.value)}</p>
            <p className={styles.postureDetail}>{display(item?.detail)}</p>
          </div>
        ))}
      </div>
      <SourceProvenancePanel
        model={provenance}
        notice={notice}
        scope="creatives"
      />
      {servedGroups.length > 0
        ? servedGroups.map((group) => (
            <section
              className={styles.creativeGroup}
              data-meta-exact-creative-group={group.id}
              key={group.id}
            >
              <header className={styles.creativeGroupHeader}>
                <span
                  className={`${styles.creativeGroupLabel} ${toneClass(group.tone)}`}
                >
                  {display(group.label)}
                </span>
                <span className={styles.creativeGroupCount}>
                  {display(group.count)}
                </span>
                <span className={styles.creativeGroupNote}>
                  {display(group.note)}
                </span>
              </header>
              {group.rows.map((row) => (
                <CreativeCard key={row.id} row={row} />
              ))}
            </section>
          ))
        : decisions.map((row) => <CreativeCard key={row.id} row={row} />)}
      <div className={styles.creativeFootnote}>
        <p data-meta-exact-creative-footnote>{display(footnote)}</p>
        <span {...controlProps(onOpenCreativeStudio)}>
          Open Creative Studio →
        </span>
      </div>
    </>
  );
}

function EvidenceInspector({
  model,
}: {
  model?: MetaDecisionCenterExactInspectorViewModel | null;
}) {
  const reasons = (model?.reasons ?? []).filter(meaningfulDisplay);
  const evidence = (model?.evidence ?? []).filter(
    (item) => meaningfulDisplay(item.label) && meaningfulDisplay(item.value),
  );
  const inspectorTone = toneClass(model?.tone);
  const hasContractDetail = meaningfulDisplay(model?.contractDetail);
  const hasTargetComparison = meaningfulDisplay(model?.targetComparison);
  const hasMoneyDetail = meaningfulDisplay(model?.moneyDetail);
  const hasBlockers = meaningfulDisplay(model?.blockers);
  const hasAdvisories = meaningfulDisplay(model?.advisories);
  const hasProvenance = meaningfulDisplay(model?.provenance);
  return (
    <aside
      className={`${styles.inspector} ${inspectorTone}`}
      data-meta-exact-inspector
    >
      <div className={styles.inspectorHeader}>
        <span className={styles.inspectorEyebrow}>Evidence inspector</span>
        <span className={`${styles.inspectorDecision} ${inspectorTone}`}>
          {display(model?.decisionLabel)}
        </span>
      </div>
      <div className={styles.inspectorBody}>
        <div>
          <p className={styles.inspectorEntity}>{display(model?.entityName)}</p>
          <p className={styles.inspectorMeta}>{display(model?.entityMeta)}</p>
        </div>
        <div className={styles.contractCard}>
          <p className={styles.inspectorSectionLabel}>Decision contract</p>
          <p className={styles.contractCopy}>
            Server verdict: <b>{display(model?.serverVerdict)}</b>
            {hasContractDetail ? `. ${display(model?.contractDetail)}` : null}
          </p>
        </div>
        {reasons.length > 0 ? (
          <div>
            <p className={styles.reasonHeading}>Engine reasoning</p>
            {reasons.map((reason, index) => (
              <p className={styles.reasonRow} key={`reason-${index}`}>
                <span />
                <span>{display(reason)}</span>
              </p>
            ))}
          </div>
        ) : null}
        <div className={styles.moneyImpact}>
          <p className={styles.inspectorSectionLabel}>
            Money impact · ROAS vs target
          </p>
          <p className={styles.inspectorMoneyValue}>
            {display(model?.moneyValue)}
            {hasTargetComparison ? (
              <>
                {" "}
                <span>{display(model?.targetComparison)}</span>
              </>
            ) : null}
          </p>
          <svg
            aria-hidden="true"
            viewBox="0 0 100 24"
            preserveAspectRatio="none"
          >
            <path
              d="M0 14 L100 14"
              stroke="#C9D2E0"
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={model?.moneySparkPath ?? ""}
              fill="none"
              stroke="var(--tone-solid)"
              strokeWidth="1.6"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {hasMoneyDetail ? (
            <p className={styles.inspectorMoneyDetail}>
              {display(model?.moneyDetail)}
            </p>
          ) : null}
        </div>
        <div className={styles.inspectorMiniTiles}>
          <span
            className={`${styles.inspectorMiniTile} ${styles.confidenceTile}`}
          >
            <span className={styles.inspectorMiniLabel}>Confidence</span>
            <span className={styles.inspectorMiniValue}>
              {display(model?.confidence)}
            </span>
          </span>
          <span
            className={`${styles.inspectorMiniTile} ${styles.readinessTile}`}
          >
            <span className={styles.inspectorMiniLabel}>Readiness</span>
            <span className={styles.inspectorMiniValue}>
              {display(model?.readiness)}
            </span>
          </span>
        </div>
        {hasBlockers ? (
          <div>
            <p className={styles.blockersHeading}>Blockers</p>
            <p
              className={`${styles.blockersCopy} ${toneClass(model?.blockerTone)}`}
            >
              {display(model?.blockers)}
            </p>
          </div>
        ) : null}
        {hasAdvisories ? (
          <div>
            <p className={styles.blockersHeading}>Advisories</p>
            <p className={`${styles.blockersCopy} ${toneClass("neutral")}`}>
              {display(model?.advisories)}
            </p>
          </div>
        ) : null}
        {model?.workflow ? (
          <div data-meta-exact-workflow data-workflow-state={model.workflow.state}>
            <p className={styles.inspectorSectionLabel}>Workflow</p>
            {model.workflow.unavailableReason ? (
              /*
                A failed read is said, not defaulted. Rendering "open" here
                would claim nobody owns these decisions — a statement about
                other people's work made on no evidence.
              */
              <p className={styles.contractCopy} role="status">
                {model.workflow.unavailableReason}
              </p>
            ) : (
              <>
                <p className={styles.contractCopy}>
                  {display(model.workflow.stateLabel)}
                  {" · "}
                  {display(model.workflow.assignee)}
                </p>
                {meaningfulDisplay(model.workflow.holdUntil) ? (
                  <p className={styles.inspectorMeta}>
                    {display(model.workflow.holdUntil)}
                  </p>
                ) : null}
              </>
            )}
            {model.workflow.actions.length > 0 ? (
              <div className={styles.workflowActions}>
                {model.workflow.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className={styles.workflowAction}
                    data-workflow-action={action.id}
                    /*
                      `aria-disabled`, not `disabled`. A disabled button leaves
                      the tab order and takes its own explanation with it, so a
                      keyboard or screen-reader operator would find nothing here
                      and no reason why.
                    */
                    aria-disabled={action.refusalReason ? true : undefined}
                    title={action.refusalReason ?? undefined}
                    onClick={
                      action.refusalReason ? undefined : action.onSelect
                    }
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
            {model.workflow.actionsRefusedReason ? (
              <p className={styles.inspectorMeta} data-workflow-refusal>
                {model.workflow.actionsRefusedReason}
              </p>
            ) : null}
          </div>
        ) : null}
        {evidence.map((item, index) => (
          <div
            className={styles.evidenceRow}
            key={item?.id ?? `evidence-${index}`}
          >
            <span>{display(item?.label)}</span>
            <span>{display(item?.value)}</span>
          </div>
        ))}
        <button
          aria-label={unservedActionName(
            display(model?.actionLabel),
            "the inspector has no selection to act on",
          )}
          className={`${styles.inspectorPrimary} ${toneClass(model?.actionTone)}`}
          disabled={!model?.onPrimary}
          onClick={model?.onPrimary}
          type="button"
        >
          {display(model?.actionLabel)}
        </button>
        {hasProvenance ? (
          <p className={styles.provenance}>{display(model?.provenance)}</p>
        ) : null}
      </div>
    </aside>
  );
}

export function MetaDecisionCenterExact({
  viewModel,
  scope,
  defaultScope = "structure",
  lane,
  defaultLane = "action",
  inspectorOpen = true,
  onScopeChange,
  onLaneChange,
  onRunSnapshot,
  onNewCampaign,
  onManageLabels,
  onSortChange,
  onSearchChange,
  initialQuery = "",
  onOpenCreativeStudio,
}: MetaDecisionCenterExactProps) {
  const [internalScope, setInternalScope] =
    useState<MetaDecisionCenterExactScope>(defaultScope);
  const [internalLane, setInternalLane] =
    useState<MetaDecisionCenterExactLane>(defaultLane);
  const [sort, setSort] = useState<MetaDecisionCenterExactSort>("money");
  const [query, setQuery] = useState(initialQuery);
  /**
   * How many rows each lane is currently drawing.
   *
   * Per lane rather than one number, so paging into a long Needs Resolution
   * lane and switching to Action Now does not leave Action Now scrolled open at
   * 200 rows — and coming back does not silently collapse the page the operator
   * had already extended.
   */
  const [shownByLane, setShownByLane] = useState<
    Partial<Record<MetaDecisionCenterExactLane, number>>
  >({});
  const shownFor = (laneId: MetaDecisionCenterExactLane) =>
    shownByLane[laneId] ?? LANE_PAGE_SIZE;
  const loadMoreFor = (laneId: MetaDecisionCenterExactLane) => () =>
    setShownByLane((previous) => ({
      ...previous,
      [laneId]: (previous[laneId] ?? LANE_PAGE_SIZE) + LANE_PAGE_SIZE,
    }));

  const activeScope = scope ?? internalScope;
  const activeLane = lane ?? internalLane;
  const activeWindow =
    viewModel.activeWindow === undefined ? "28d" : viewModel.activeWindow;
  const counts = viewModel.counts;
  const identity = viewModel.identity;
  // The reference resolves the two-column grid for the Action state, and that
  // is where the inspector always sits. Watching gets it too, but only once a
  // row has actually been reviewed: its "Review" button had nowhere to put the
  // evidence on desktop, so pressing it changed nothing at all.
  const showInspector =
    inspectorOpen &&
    activeScope === "structure" &&
    (activeLane === "action" ||
      // Needs Resolution rows open the same inspector — the evidence is the
      // whole reason to open a blocked row — but only once one has been chosen,
      // for the same reason Watching waits: an empty two-column grid on a lane
      // nobody has clicked is a panel of em dashes.
      ((activeLane === "watching" || activeLane === "needsres") &&
        viewModel.inspector != null));

  function selectScope(nextScope: MetaDecisionCenterExactScope) {
    if (scope === undefined) setInternalScope(nextScope);
    onScopeChange?.(nextScope);
  }

  function selectLane(nextLane: MetaDecisionCenterExactLane) {
    if (lane === undefined) setInternalLane(nextLane);
    onLaneChange?.(nextLane);
  }

  return (
    <section className={styles.root} data-screen-label="Meta Decision Center">
      <div className={styles.pageHeader}>
        <div>
          <p className={styles.pageEyebrow}>
            Meta · {display(identity?.accountLabel)} ·{" "}
            {display(identity?.currency)}
          </p>
          <h1>Decision Center</h1>
          <p className={styles.asOfLine} data-meta-exact-source-identity>
            {display(identity?.syncedLabel)} ·{" "}
            {display(identity?.snapshotLabel)} ·{" "}
            {display(identity?.engineLabel)} · {display(identity?.timeLabel)}
          </p>
        </div>
        {/* The 7d/14d/28d/90d pills are gone: the shell topbar picker already
            owns the window, and it offers a wider vocabulary than these four.
            Two controls for one value is also two WRITERS for one value —
            exactly the split the single date authority removed everywhere
            else. `activeWindow` stays: it is the window the payload was
            SERVED for, and the archive column header and the ROAS label
            still name it. */}
        <div className={styles.headerTools}>
          <button
            className={styles.snapshotButton}
            disabled={!onRunSnapshot}
            onClick={onRunSnapshot}
            type="button"
          >
            Run snapshot
          </button>
          <button
            className={styles.newCampaignButton}
            disabled={!onNewCampaign}
            onClick={onNewCampaign}
            type="button"
          >
            + New campaign
          </button>
        </div>
      </div>

      <ExactKpiBand
        kpis={viewModel.kpis}
        onManageLabels={onManageLabels}
        activeWindow={activeWindow ?? EM_DASH}
      />

      <div className={styles.scopeRow}>
        <span className={styles.scopeControl}>
          <span
            aria-pressed={activeScope === "structure"}
            className={`${styles.scopeOption} ${
              activeScope === "structure" ? styles.scopeOptionActive : ""
            }`}
            data-meta-exact-scope="structure"
            {...controlProps(() => selectScope("structure"))}
          >
            Campaigns &amp; Ad sets
            <span>{display(counts?.structure)}</span>
          </span>
          <span
            aria-pressed={activeScope === "creatives"}
            className={`${styles.scopeOption} ${
              activeScope === "creatives" ? styles.scopeOptionActive : ""
            }`}
            data-meta-exact-scope="creatives"
            {...controlProps(() => selectScope("creatives"))}
          >
            Creatives
            <span>{display(counts?.creatives)}</span>
          </span>
        </span>
        <p data-meta-exact-queue-snapshot>
          queue reflects {display(identity?.snapshotLabel)} — the date range
          scopes metrics, not decisions
        </p>
      </div>

      {activeScope === "structure" ? (
        <div className={styles.laneToolbar} data-meta-exact-lane-toolbar>
          {/*
            One radiogroup, because these are one choice. The lane options were
            individually `aria-pressed` spans with no group and no arrow keys,
            so a screen-reader operator met six unrelated toggles instead of a
            six-way selector, and the design's own arrow-key contract
            (`live:lane`) had nothing to bind to.
          */}
          <span
            aria-label="Decision lanes"
            className={styles.laneGroup}
            data-ctl="live:lane"
            onKeyDown={(event) => {
              const index = LANES.findIndex((item) => item.id === activeLane);
              if (index < 0) return;
              const step =
                event.key === "ArrowRight" || event.key === "ArrowDown"
                  ? 1
                  : event.key === "ArrowLeft" || event.key === "ArrowUp"
                    ? -1
                    : 0;
              if (step === 0) return;
              event.preventDefault();
              selectLane(
                LANES[(index + step + LANES.length) % LANES.length]!.id,
              );
            }}
            role="radiogroup"
          >
            {LANES.map((item) => (
              <span
                key={item.id}
                {...controlProps(() => selectLane(item.id))}
                /*
                  Spread first, overridden after: `controlProps` supplies the
                  click and Enter/Space handling every control on this surface
                  shares, but its `role="button"` and always-0 tabIndex are
                  wrong for a radio inside a group — only the checked option is
                  tabbable, and the arrows on the group move between them.
                */
                aria-checked={activeLane === item.id}
                className={`${styles.laneOption} ${
                  activeLane === item.id ? styles.laneOptionActive : ""
                }`}
                data-ctl="live:META-DEC-01 lane"
                data-meta-exact-lane={item.id}
                role="radio"
                tabIndex={activeLane === item.id ? 0 : -1}
              >
                {item.label}
                <span>{display(counts?.[item.id])}</span>
              </span>
            ))}
          </span>
          <span className={styles.deferredPill}>
            Deferred {display(counts?.deferred)}
          </span>
          <span className={styles.toolbarSpacer} />
          <select
            aria-label="Sort decisions"
            onChange={(event) => {
              const next = event.target.value as MetaDecisionCenterExactSort;
              setSort(next);
              onSortChange?.(next);
            }}
            value={sort}
          >
            <option value="money">Sort: Money at stake</option>
            <option value="priority">Sort: Priority</option>
            <option value="age">Sort: Age</option>
          </select>
          <input
            aria-label="Search entities"
            onChange={(event) => {
              setQuery(event.target.value);
              onSearchChange?.(event.target.value);
            }}
            placeholder="Search entities…"
            value={query}
          />
        </div>
      ) : (
        /*
         * The search box follows the term, not the scope.
         *
         * The query is ONE piece of page state and it filtered the creative
         * rows all along, but the only control that could see or clear it lived
         * in the structure toolbar. Switching scope with a term typed therefore
         * hid creative rows behind a filter with no visible cause and no way
         * out. Clearing the term on scope change was the other option and is
         * worse: it silently discards something the operator typed on purpose,
         * and the term is also what the deep link restores. So the control
         * comes along instead.
         *
         * The lane pills and the sort do NOT come along: the lanes are the
         * structure lanes and the sort is applied to structure rows only, so
         * rendering either here would be a control that changes nothing.
         */
        <div className={styles.laneToolbar} data-meta-exact-creative-toolbar>
          <span className={styles.toolbarSpacer} />
          <input
            aria-label="Search creatives"
            onChange={(event) => {
              setQuery(event.target.value);
              onSearchChange?.(event.target.value);
            }}
            placeholder="Search creatives…"
            value={query}
          />
        </div>
      )}

      <div
        className={`${styles.workspace} ${showInspector ? styles.workspaceWithInspector : ""}`}
        data-meta-exact-workspace
      >
        <div className={styles.queue}>
          {/*
           * The Structures scope states its own source, in every lane.
           *
           * It used to state none at all: the same read model and the same
           * capabilities envelope back both scopes, but only Creatives said so,
           * while Structures is the scope that draws the action buttons
           * `providerWriteLinkage` and `responseAttribution` govern. Rendered
           * outside the lane branches on purpose — the source is a property of
           * the account and the snapshot, not of which lane happens to be
           * selected, and a panel that vanished on the Archive tab would be a
           * disclosure the operator could lose by clicking.
           *
           * @see structureProvenance in meta-decision-center-exact-adapter.ts
           */}
          {activeScope === "structure" ? (
            <SourceProvenancePanel
              defaultOpen={false}
              model={viewModel.structureProvenance}
              scope="structure"
            />
          ) : null}
          {activeScope === "structure" && activeLane === "action" ? (
            <ActionLane
              onLoadMore={loadMoreFor("action")}
              rows={viewModel.actionRows ?? []}
              shown={shownFor("action")}
            />
          ) : null}
          {activeScope === "structure" && activeLane === "needsres" ? (
            <NeedsResolutionLane
              notice={viewModel.needsResolutionNotice}
              onLoadMore={loadMoreFor("needsres")}
              rows={viewModel.needsResolutionRows ?? []}
              shown={shownFor("needsres")}
            />
          ) : null}
          {activeScope === "structure" && activeLane === "watching" ? (
            <WatchingLane
              rows={viewModel.watchingRows ?? []}
              segments={viewModel.watchSegments ?? []}
            />
          ) : null}
          {activeScope === "structure" && activeLane === "healthy" ? (
            <HealthyLane groups={viewModel.healthyGroups ?? []} />
          ) : null}
          {activeScope === "structure" && activeLane === "nonsales" ? (
            <NonSalesLane cards={viewModel.nonSales ?? []} />
          ) : null}
          {activeScope === "structure" && activeLane === "archive" ? (
            <ArchiveLane
              rows={viewModel.archiveRows ?? []}
              windowLabel={activeWindow ?? EM_DASH}
            />
          ) : null}
          {activeScope === "creatives" ? (
            <CreativesScope
              decisions={viewModel.creativeDecisions ?? []}
              footnote={viewModel.creativeFootnote}
              groups={viewModel.creativeGroups}
              notice={viewModel.creativesNotice}
              onOpenCreativeStudio={onOpenCreativeStudio}
              posture={viewModel.creativePosture ?? []}
              provenance={viewModel.sourceProvenance}
            />
          ) : null}
        </div>
        {showInspector ? (
          <EvidenceInspector model={viewModel.inspector} />
        ) : null}
      </div>
    </section>
  );
}
