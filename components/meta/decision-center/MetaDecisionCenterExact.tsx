"use client";

import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import {
  useCopy,
  useZeroBaseLanguage,
} from "@/components/zero-base/i18n/copy-provider";

import styles from "./MetaDecisionCenterExact.module.css";
import { BudgetDecisionEvidencePanel } from "./BudgetDecisionEvidencePanel";
import { BudgetDryRunPanel } from "./BudgetDryRunPanel";
import type { MetaBudgetDryRunPanel } from "@/lib/meta/budget-dry-run-panel";
import type { MetaBudgetDecisionEvidenceByDirection } from "@/lib/meta/budget-decision-evidence-panel";

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
/**
 * The grain a decision row was served at.
 *
 * `account` is deliberately absent: the older decisions URL contract lists it,
 * and this queue has no account-grain row to filter to. Offering it would be a
 * control that can only ever empty the table.
 */
export type MetaDecisionCenterExactLevel = "campaign" | "adset" | "ad";
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
    /** Legacy fully-rendered label. Current payloads carry `date` instead. */
    label?: MetaDecisionCenterExactDisplayValue;
    /** Locale-neutral exact day this value describes; never assumed to be today. */
    date?: MetaDecisionCenterExactDisplayValue;
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
  campaignRoles?: {
    coverage?: MetaDecisionCenterExactDisplayValue;
    percentage?: MetaDecisionCenterExactDisplayValue;
    /** Server-fact presentation: resolved/unresolved coverage, not a manual label. */
    detail?: MetaDecisionCenterExactDisplayValue;
    /** Locale-neutral server state. The client translates it; it does not infer it. */
    status?: "no_active" | "unresolved" | "resolved" | "unavailable";
    unresolvedCount?: MetaDecisionCenterExactDisplayValue;
  };
  mode?: {
    value?: MetaDecisionCenterExactDisplayValue;
    chips?: readonly MetaDecisionCenterExactChipViewModel[];
  };
}

export interface MetaDecisionCenterExactOperatorSummaryViewModel {
  /** Totals across both server-owned scopes, not a UI reclassification. */
  action?: MetaDecisionCenterExactDisplayValue;
  needsResolution?: MetaDecisionCenterExactDisplayValue;
  watching?: MetaDecisionCenterExactDisplayValue;
  creatives?: MetaDecisionCenterExactDisplayValue;
  /** Scope containing the first served row for each summary route. */
  actionScope?: MetaDecisionCenterExactScope;
  needsResolutionScope?: MetaDecisionCenterExactScope;
  watchingScope?: MetaDecisionCenterExactScope;
  /** Per-scope server counts used when one combined CTA cannot show every row. */
  scopeCounts?: {
    structure?: {
      action?: MetaDecisionCenterExactDisplayValue;
      needsResolution?: MetaDecisionCenterExactDisplayValue;
      watching?: MetaDecisionCenterExactDisplayValue;
    };
    creatives?: {
      action?: MetaDecisionCenterExactDisplayValue;
      needsResolution?: MetaDecisionCenterExactDisplayValue;
      watching?: MetaDecisionCenterExactDisplayValue;
    };
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
  /** Exact number of server-owned readiness checks still open. */
  blockerCount?: number | null;
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
  /**
   * The server-owned commercial spend-unit anchor and the counts it withholds.
   * Rendered verbatim; the client never derives eligibility from it.
   */
  commercialAnchor?: readonly MetaDecisionCenterExactSourceFactViewModel[];
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
  /**
   * Fields this transition cannot be sent without.
   *
   * `assign` needs an assignee, `snooze` an instant, `reject` a reason code.
   * All three were offered with those fields hard-coded null, so two of them
   * were guaranteed 422s and the third was a no-op that still burned a
   * `stateVersion` — which made every other open tab conflict.
   */
  readonly requires?: readonly ("assignee" | "snoozeUntil" | "reasonCode")[];
  readonly onSelect?: (values: {
    assigneeUserId?: string;
    snoozeUntil?: string;
    reasonCode?: string;
  }) => void;
}

/**
 * A refused transition, and the two things an operator may do about it (H12).
 *
 * The names come from the design's contract and they are not intuitive, so:
 * `keep` is KEEP MINE — "re-submits transition with fresh expectedVersion" —
 * and `reapply` is TAKE SERVER — "discards local transition; row re-renders
 * server state". Neither is automatic: a silent retry against the new version
 * would overwrite whatever the other operator just did without anyone reading
 * it.
 */
export interface MetaDecisionCenterExactWorkflowConflict {
  /** What the server says the decision is NOW. */
  readonly currentStateLabel: MetaDecisionCenterExactDisplayValue;
  readonly currentVersion: number;
  /** What the operator was trying to do, and from which version. */
  readonly attemptedLabel: MetaDecisionCenterExactDisplayValue;
  readonly attemptedFromVersion: number;
  readonly message: MetaDecisionCenterExactDisplayValue;
  /**
   * Non-null when re-applying is refused — the transition no longer applies to
   * the state the server is in. Stated rather than hidden: an operator whose
   * only option is to take the server's answer should be told why.
   */
  readonly keepRefusedReason?: string | null;
  readonly onKeepMine?: () => void;
  readonly onTakeServer?: () => void;
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
  /**
   * Why the transition menu may not be opened, or null when it may.
   *
   * Present-and-refusing rather than absent: `gated:META-WF-02..08 menu`'s own
   * failure clause is "guest/reviewer: menu absent/disabled with reason", and a
   * menu that vanishes takes its explanation with it.
   */
  readonly menuRefusedReason?: string | null;
  /** True while a transition is in flight for this decision. */
  readonly pending?: boolean;
  readonly conflict?: MetaDecisionCenterExactWorkflowConflict | null;
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
   * When the engine wrote this verdict, and what it measured.
   *
   * Two separate facts, drawn separately, because collapsing them is how a
   * stale read looks current: a snapshot written this morning can describe a
   * window that ended three days ago. `asOf` is the engine's write time;
   * `evidenceWindow` is the range every figure in this panel covers.
   */
  asOf?: MetaDecisionCenterExactDisplayValue;
  evidenceWindow?: MetaDecisionCenterExactDisplayValue;
  /**
   * Metrics the server did not serve at this row's grain.
   *
   * Named rather than smoothed over. A null metric is not a zero — the
   * invariant is explicit that source absence must never become a measured
   * zero — so the panel says which figures are missing instead of printing an
   * em dash the reader has to interpret.
   */
  provenanceGaps?: readonly MetaDecisionCenterExactDisplayValue[];
  /**
   * The brief control's posture (`live:CREATIVE-07 brief`).
   *
   * A brief is derived from a creative decision snapshot, so a structure row
   * cannot mint one and says why rather than offering a link that would be
   * refused after the navigation. Server-authored: the reason is the brief
   * contract's own gate text.
   */
  brief?:
    | { href: string; label?: MetaDecisionCenterExactDisplayValue }
    | { refusalReason: string }
    | null;
  /**
   * The manual action sheet (`gated:META-WRITE-01 open-manual`).
   *
   * The mutation ceremony — preflight, type-to-confirm, receipt,
   * reconciliation — already exists and is server-gated by
   * `ZERO_BASE_MUTATION_UI_ENABLED`, which defaults off. What was missing was
   * any way to reach it from a decision.
   *
   * Present-and-refusing when the gate is shut or the viewer may not write,
   * because a control that disappears takes the reason with it and the surface
   * then reads as a product with no manual path at all.
   */
  manualAction?: {
    label?: MetaDecisionCenterExactDisplayValue;
    refusalReason: string | null;
    onOpen?: () => void;
  } | null;
  /**
   * The narrow terminus bar (H52/H57).
   *
   * At 390 and 320 the decision detail is the end of the read: the operator has
   * scrolled past the verdict, the evidence and the workflow, and the two
   * things they may still need — the manual action sheet and the Meta stop —
   * are several screens back up the rail. The bar keeps both one tap away.
   *
   * Absent at desktop, where the rail already carries the stop and the
   * inspector's own controls are still on screen.
   */
  stickyBar?: { metaStopHref: string } | null;
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
  /**
   * The server-owned budget-decision evidence panel, carried as the OBJECT the
   * server projected rather than flattened into the fact list every other
   * provenance group uses. Flattening separates a blocker code from its own
   * sentence, which is the defect this contract exists to prevent.
   *
   * `null` and `undefined` both mean the server sent no panel. Neither is ever
   * rendered as "nothing is blocking".
   */
  budgetEvidence?: MetaBudgetDecisionEvidenceByDirection | null;
  budgetDryRun?: MetaBudgetDryRunPanel | null;
  /**
   * D078 R4/C3.1: every assigned identity with its selection/coverage
   * state. Display-only; a deselected identity is read-only historical
   * evidence and never an actionable write scope. FOUR states, preserved
   * verbatim from the workspace payload through the adapter: `undefined`
   * = the payload never carried the field (legacy; render nothing),
   * `null` = the server read FAILED (render the visible unavailable
   * warning), `[]` = a successful read proved zero assigned identities
   * (render the explicit anomalous state), populated = render the panel.
   */
  assignedAccountStates?:
    | readonly import("@/components/meta/redesign/types").MetaAssignedAccountStateSummary[]
    | null;
  identity?: MetaDecisionCenterExactIdentityViewModel;
  activeWindow?: MetaDecisionCenterExactWindow | null;
  counts?: MetaDecisionCenterExactCountsViewModel;
  operatorSummary?: MetaDecisionCenterExactOperatorSummaryViewModel;
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
  /**
   * Closes the evidence inspector (`live:close`).
   *
   * The panel had no close control at all: `inspectorOpen` is computed by the
   * page and is unconditionally true on the Action lane, so an operator who
   * opened a row could not put it away. Absent means the caller does not offer
   * one, and the control is then not drawn — rather than drawn and inert.
   */
  onCloseInspector?: () => void;
  /**
   * The provider's own campaign manager for this account.
   *
   * A link out, never an executed action, and labelled as one. It has no key in
   * the design's control contract — the contract's `live:META-DEC-13 open` is
   * the inactive-assets strip, not this — so it carries no `data-ctl` rather
   * than borrowing one that means something else.
   */
  adsManagerHref?: string | null;
  onScopeChange?: (scope: MetaDecisionCenterExactScope) => void;
  onLaneChange?: (lane: MetaDecisionCenterExactLane) => void;
  onRunSnapshot?: () => void;
  onNewCampaign?: () => void;
  onSortChange?: (sort: MetaDecisionCenterExactSort) => void;
  /**
   * The levels the table is filtered to. Empty means every level.
   *
   * Controlled by the page, because the value lives in the URL: the design's
   * own contract for this control is "campaign/ad set/ad level switch; URL
   * param (INV-18)", and a filter the link cannot carry is not that control.
   */
  levels?: readonly MetaDecisionCenterExactLevel[];
  onLevelsChange?: (levels: MetaDecisionCenterExactLevel[]) => void;
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

/**
 * The lanes, in order, keyed to the copy catalogue.
 *
 * The label is a KEY rather than a string: this table is module-level and a
 * hook cannot run here, so the component resolves each one at render. That is
 * also what makes the Turkish artboards render from the component instead of
 * from a paragraph pasted into the frame registry.
 */
const LANES: readonly {
  id: MetaDecisionCenterExactLane;
  labelKey:
    | "laneActionNow"
    | "laneNeedsResolution"
    | "laneWatching"
    | "laneHealthy"
    | "laneNonSales"
    | "laneArchive";
}[] = [
  { id: "action", labelKey: "laneActionNow" },
  // Between the lane that promises an action and the one that promises none:
  // these rows have a verdict and no authority for it.
  { id: "needsres", labelKey: "laneNeedsResolution" },
  { id: "watching", labelKey: "laneWatching" },
  { id: "healthy", labelKey: "laneHealthy" },
  { id: "nonsales", labelKey: "laneNonSales" },
  { id: "archive", labelKey: "laneArchive" },
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

/**
 * A count only when the server actually served one.
 *
 * The operating summary must never turn an absent count into zero: zero means
 * the queue was read and proved empty, while an em dash means the read did not
 * establish a count. Formatted integer strings are accepted because the exact
 * view model intentionally supports both display strings and numbers.
 */
function servedCount(
  value: MetaDecisionCenterExactDisplayValue,
): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll(",", "");
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
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

/**
 * The disclosure stays compact, but its closed state must never hide why a
 * budget decision is blocked. Every reason below is carried by the server
 * panel; this helper only chooses which served status sentences to expose.
 */
function budgetDecisionReadinessSummary(
  evidence?: MetaBudgetDecisionEvidenceByDirection | null,
  dryRun?: MetaBudgetDryRunPanel | null,
): {
  text: string;
  state: "blocked" | "unavailable" | "review_only" | "unknown";
} {
  const blockingStates: string[] = [];
  let hasBlockedState = false;
  let hasUnavailableState = false;

  for (const [label, panel] of [
    ["Increase", evidence?.increase],
    ["Decrease", evidence?.decrease],
  ] as const) {
    if (!panel) continue;
    if (panel.status === "unavailable") {
      hasUnavailableState = true;
      blockingStates.push(
        `${label} unavailable · ${panel.executionReadiness.why}`,
      );
      continue;
    }
    if (panel.authority === "blocked") {
      hasBlockedState = true;
      blockingStates.push(
        `${label} blocked · ${panel.primaryBlocker?.reason ?? panel.executionReadiness.why}`,
      );
    }
  }

  if (dryRun?.status === "unavailable") {
    hasUnavailableState = true;
    blockingStates.push(`Dry run unavailable · ${dryRun.headline}`);
  } else if (dryRun?.required.blockers[0]) {
    hasBlockedState = true;
    blockingStates.push(`Dry run blocked · ${dryRun.required.blockers[0].why}`);
  }

  if (blockingStates.length > 0) {
    return {
      text: blockingStates.join(" · "),
      state: hasBlockedState
        ? "blocked"
        : hasUnavailableState
          ? "unavailable"
          : "unknown",
    };
  }
  if (dryRun) return { text: dryRun.headline, state: "review_only" };
  if (evidence) {
    return {
      text: evidence.increase.executionReadiness.why,
      state: "review_only",
    };
  }
  return { text: EM_DASH, state: "unknown" };
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
  const copy = useCopy();
  if (!demoted) return null;
  return (
    <span className={styles.staleDemoted} data-el="stale-demoted">
      {meaningfulDisplay(reason)
        ? display(reason)
        : copy.confidenceCappedStillServed}
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
  const copy = useCopy();
  if (!selected) return null;
  return <span className={styles.selectedMarker}>{copy.inspecting}</span>;
}

function ExactKpiBand({
  kpis,
  activeWindow,
}: {
  kpis?: MetaDecisionCenterExactKpisViewModel;
  /**
   * The window the header control shows as pressed. Used ONLY while the
   * served label is absent — during loading the window is already known from
   * the control, so an em-dash here would contradict the pill beside it,
   * while a hardcoded "28d" would assert a window nobody selected.
   */
  activeWindow: string;
}) {
  const copy = useCopy();
  const language = useZeroBaseLanguage();
  const modeChips = slots(kpis?.mode?.chips, 2);
  return (
    <div className={styles.kpiGrid} data-meta-exact-section="kpis">
      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>
          {display(
            nonBlankDisplay(kpis?.spend?.date)
              ? `${language === "tr" ? "Harcama" : "Spend"} · ${String(kpis!.spend!.date)}`
              : (kpis?.spend?.label ?? copy.spendToday),
          )}
        </p>
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
        <p className={styles.kpiLabel}>
          {language === "tr"
            ? "Öneri anlık görüntüsü"
            : "Recommendation snapshot"}
        </p>
        <span className={styles.freshnessPill}>
          {display(kpis?.snapshot?.freshness)}
        </span>
        <p className={styles.snapshotDetail}>
          {display(kpis?.snapshot?.detail)}
        </p>
      </article>

      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>
          {language === "tr" ? "Kampanya rolleri" : "Campaign roles"}
        </p>
        <p className={styles.kpiValue}>
          {display(kpis?.campaignRoles?.coverage)}{" "}
          <span className={styles.rolePercentage}>
            {display(kpis?.campaignRoles?.percentage)}
          </span>
        </p>
        <p className={styles.roleInference}>
          {display(
            kpis?.campaignRoles?.status === "no_active"
              ? language === "tr"
                ? "Otomatik çıkarım · aktif kampanya yok"
                : "Automatic inference · no active campaigns"
              : kpis?.campaignRoles?.status === "unresolved"
                ? language === "tr"
                  ? `Otomatik çıkarım · ${display(kpis.campaignRoles.unresolvedCount)} çözümlenmedi`
                  : `Automatic inference · ${display(kpis.campaignRoles.unresolvedCount)} unresolved`
                : kpis?.campaignRoles?.status === "resolved"
                  ? language === "tr"
                    ? "Otomatik çıkarım · tüm aktif kampanyalar çözüldü"
                    : "Automatic inference · all active campaigns resolved"
                  : kpis?.campaignRoles?.status === "unavailable"
                    ? language === "tr"
                      ? "Otomatik çıkarım kullanılamıyor · kesin aksiyonlar engelli"
                      : "Automatic inference unavailable · hard actions remain blocked"
                    : (kpis?.campaignRoles?.detail ??
                      (language === "tr"
                        ? "Otomatik sınıflandırma"
                        : "Automatic inference")),
          )}
        </p>
      </article>

      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>{copy.kpiModeLabel}</p>
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
 * The operator's starting point.
 *
 * Every number and lane remains server-owned. This component does not infer a
 * buyer action, promote a blocked decision or reinterpret confidence; it only
 * turns the already-served queue counts into a readable route into that queue.
 */
function OperatorDecisionSummary({
  counts,
  summary,
  onSelectLane,
  onSelectScope,
}: {
  counts?: MetaDecisionCenterExactCountsViewModel;
  summary?: MetaDecisionCenterExactOperatorSummaryViewModel;
  onSelectLane: (lane: MetaDecisionCenterExactLane) => void;
  onSelectScope: (scope: MetaDecisionCenterExactScope) => void;
}) {
  const language = useZeroBaseLanguage();
  const action = servedCount(summary?.action ?? counts?.action);
  const needsResolution = servedCount(
    summary?.needsResolution ?? counts?.needsres,
  );
  const watching = servedCount(summary?.watching ?? counts?.watching);

  const routeButtons = ({
    lane,
    total,
    fallbackScope,
    genericLabel,
    structureLabel,
    creativeLabel,
    structureCount,
    creativeCount,
  }: {
    lane: MetaDecisionCenterExactLane;
    total: number | null;
    fallbackScope: MetaDecisionCenterExactScope;
    genericLabel: string;
    structureLabel: string;
    creativeLabel: string;
    structureCount: MetaDecisionCenterExactDisplayValue;
    creativeCount: MetaDecisionCenterExactDisplayValue;
  }) => {
    if (total === null || total <= 0) return null;

    const perScope = (
      [
        {
          scope: "structure" as const,
          count: servedCount(structureCount),
          label: structureLabel,
        },
        {
          scope: "creatives" as const,
          count: servedCount(creativeCount),
          label: creativeLabel,
        },
      ] as const
    ).flatMap((item) =>
      item.count !== null && item.count > 0
        ? [{ ...item, count: item.count }]
        : [],
    );

    if (perScope.length > 1) {
      return perScope.map((item) => (
        <button
          key={`${lane}-${item.scope}`}
          type="button"
          onClick={() => openLane(lane, item.scope)}
        >
          {item.label} ({item.count})
        </button>
      ));
    }

    return (
      <button
        type="button"
        onClick={() => openLane(lane, perScope[0]?.scope ?? fallbackScope)}
      >
        {genericLabel}
      </button>
    );
  };

  const headline =
    action !== null && action > 0
      ? language === "tr"
        ? `${action} karar şimdi operatör incelemesi bekliyor.`
        : `${action} decision${action === 1 ? "" : "s"} need operator review now.`
      : needsResolution !== null && needsResolution > 0
        ? language === "tr"
          ? `Şu anda uygulanmaya hazır değişiklik yok. ${needsResolution} kararın kanıt eksiği çözülmeli.`
          : `No immediate Meta change is ready. ${needsResolution} decision${needsResolution === 1 ? "" : "s"} need evidence resolved.`
        : action === 0 &&
            needsResolution === 0 &&
            watching !== null &&
            watching > 0
          ? language === "tr"
            ? `Şu anda değişiklik önerilmiyor. ${watching} karar izleniyor.`
            : `No immediate Meta change is recommended. ${watching} decision${watching === 1 ? " is" : "s are"} being watched.`
          : action === 0 && needsResolution === 0 && watching === 0
            ? language === "tr"
              ? "Bu anlık görüntü için Meta değişikliği önerilmiyor."
              : "No Meta change is recommended for this snapshot."
            : language === "tr"
              ? "Güncel öneri özeti doğrulanamadı."
              : "The current recommendation summary could not be verified.";

  const openLane = (
    lane: MetaDecisionCenterExactLane,
    scope: MetaDecisionCenterExactScope,
  ) => {
    onSelectScope(scope);
    onSelectLane(lane);
  };

  return (
    <section
      className={styles.operatorSummary}
      data-meta-exact-operator-summary
      aria-labelledby="meta-operator-summary-title"
    >
      <div className={styles.operatorSummaryCopy}>
        <p className={styles.operatorSummaryEyebrow}>
          {language === "tr"
            ? "Adsecute şimdi ne öneriyor?"
            : "What Adsecute recommends now"}
        </p>
        <h2 id="meta-operator-summary-title">{headline}</h2>
        <p>
          {language === "tr"
            ? "Kampanya rolü otomatik belirlenir; çözülemeyen roller yeni kanıt gelene kadar güvenli biçimde engellenir."
            : "Campaign role is inferred automatically; unresolved roles stay safely blocked until fresh evidence resolves them."}
        </p>
        <div className={styles.operatorSummaryActions}>
          {action !== null && action > 0
            ? routeButtons({
                lane: "action",
                total: action,
                fallbackScope: summary?.actionScope ?? "structure",
                genericLabel:
                  language === "tr"
                    ? "Şimdi yapılacakları incele"
                    : "Review Action Now",
                structureLabel:
                  language === "tr"
                    ? "Yapı aksiyonlarını incele"
                    : "Review structure actions",
                creativeLabel:
                  language === "tr"
                    ? "Kreatif aksiyonlarını incele"
                    : "Review creative actions",
                structureCount: summary?.scopeCounts?.structure?.action,
                creativeCount: summary?.scopeCounts?.creatives?.action,
              })
            : needsResolution !== null && needsResolution > 0
              ? routeButtons({
                  lane: "needsres",
                  total: needsResolution,
                  fallbackScope:
                    summary?.needsResolutionScope ?? "structure",
                  genericLabel:
                    language === "tr" ? "Engelleri çöz" : "Resolve blockers",
                  structureLabel:
                    language === "tr"
                      ? "Yapı engellerini çöz"
                      : "Resolve structure blockers",
                  creativeLabel:
                    language === "tr"
                      ? "Kreatif engellerini çöz"
                      : "Resolve creative blockers",
                  structureCount:
                    summary?.scopeCounts?.structure?.needsResolution,
                  creativeCount:
                    summary?.scopeCounts?.creatives?.needsResolution,
                })
              : watching !== null && watching > 0
                ? routeButtons({
                    lane: "watching",
                    total: watching,
                    fallbackScope: summary?.watchingScope ?? "structure",
                    genericLabel:
                      language === "tr" ? "İzlenenleri gör" : "Review watching",
                    structureLabel:
                      language === "tr"
                        ? "Yapı izleme listesini incele"
                        : "Review structure watchlist",
                    creativeLabel:
                      language === "tr"
                        ? "Kreatif izleme listesini incele"
                        : "Review creative watchlist",
                    structureCount: summary?.scopeCounts?.structure?.watching,
                    creativeCount: summary?.scopeCounts?.creatives?.watching,
                  })
                : null}
        </div>
      </div>
    </section>
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
  const copy = useCopy();
  const complete = shown >= served;
  return (
    <p className={styles.lanePaging} data-meta-exact-lane-paging={label}>
      <span data-lane-count="">
        {copy.showingOfServedRows
          .replace("{shown}", String(shown))
          .replace("{served}", String(served))}
      </span>
      {complete ? (
        <span data-lane-paging-complete="">
          {" · "}
          {copy.allServedRowsShown.replace("{served}", String(served))}
        </span>
      ) : (
        <button
          className={styles.lanePagingMore}
          data-ctl="live:META-DEC-05 load-more"
          onClick={onLoadMore}
          type="button"
        >
          {copy.showMore}
        </button>
      )}
    </p>
  );
}

/**
 * The level filter (`live:META-DEC-02 level`).
 *
 * Two things it deliberately does NOT do.
 *
 * It does not offer a level the current scope cannot serve. Structure rows are
 * campaigns and ad sets; the Creatives scope is ads, and only ads. An option
 * that could only ever empty the table is drawn disabled with the reason,
 * rather than left out — an absent option reads as an oversight, and a present
 * one that empties the screen reads as a broken filter.
 *
 * And it does not collapse a multi-level selection. `levels=campaign,adset`
 * from a link is two levels, and the select says so rather than silently
 * showing one of them; choosing any option replaces the pair, which is the
 * operator's own act.
 */
const LEVEL_OPTIONS: readonly {
  id: MetaDecisionCenterExactLevel;
  labelKey: "levelCampaign" | "levelAdSet" | "levelAd";
}[] = [
  { id: "campaign", labelKey: "levelCampaign" },
  { id: "adset", labelKey: "levelAdSet" },
  { id: "ad", labelKey: "levelAd" },
];

function LevelFilter({
  levels,
  scope,
  onLevelsChange,
}: {
  levels: readonly MetaDecisionCenterExactLevel[];
  scope: MetaDecisionCenterExactScope;
  onLevelsChange?: (levels: MetaDecisionCenterExactLevel[]) => void;
}) {
  const copy = useCopy();
  const served: readonly MetaDecisionCenterExactLevel[] =
    scope === "creatives" ? ["ad"] : ["campaign", "adset"];
  const value =
    levels.length === 0 ? "all" : levels.length === 1 ? levels[0]! : "multiple";
  return (
    <label className={styles.levelFilter} data-meta-exact-level-filter={value}>
      <span className={styles.levelFilterLabel}>{copy.level}</span>
      <select
        aria-label={copy.filterByLevel}
        data-ctl="live:META-DEC-02 level"
        data-level-filter="select"
        disabled={!onLevelsChange}
        onChange={(event) => {
          const next = event.target.value;
          onLevelsChange?.(
            next === "all" || next === "multiple"
              ? []
              : [next as MetaDecisionCenterExactLevel],
          );
        }}
        value={value}
      >
        <option value="all">{copy.allLevels}</option>
        {LEVEL_OPTIONS.map((option) => {
          const unavailable = !served.includes(option.id);
          return (
            <option disabled={unavailable} key={option.id} value={option.id}>
              {copy[option.labelKey]}
              {unavailable
                ? ` — ${
                    scope === "creatives"
                      ? copy.structuresAreInOtherScope
                      : copy.adsAreInCreativesScope
                  }`
                : ""}
            </option>
          );
        })}
        {value === "multiple" ? (
          <option value="multiple">
            {levels.length} {copy.levelsFromTheLink}
          </option>
        ) : null}
      </select>
    </label>
  );
}

/**
 * Copy a link that reproduces this view (`live:INV-18 share-view`).
 *
 * The URL already carries everything the contract names — account, lane, level,
 * window — because every one of those controls writes to it. So the control is
 * a copy, not a link: there is nowhere to navigate to that is not where the
 * operator already is.
 *
 * Three states, because the clipboard can refuse. Idle offers the copy; copied
 * announces through `role="status"`, which is what "'copied' announced
 * (role=status)" in the contract asks for; refused falls back to a selectable
 * field holding the URL, so a denied clipboard costs the operator a keystroke
 * rather than the link.
 */
function ShareViewControl() {
  const copy = useCopy();
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "copied" } | { kind: "manual"; url: string }
  >({ kind: "idle" });

  const share = async () => {
    const url = typeof window === "undefined" ? "" : window.location.href;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setState({ kind: "copied" });
    } catch {
      // Denied, unavailable, or an insecure context. All three are the same
      // fact for the operator: the browser will not copy for them.
      setState({ kind: "manual", url });
    }
  };

  return (
    <span className={styles.shareView} data-meta-exact-share-view={state.kind}>
      <button
        className={styles.shareViewButton}
        data-ctl="live:INV-18 share-view"
        onClick={() => void share()}
        type="button"
      >
        {copy.copyLinkToThisView}
      </button>
      {state.kind === "copied" ? (
        <span data-meta-exact-share-copied="" role="status">
          {copy.linkCopiedReproducesView}
        </span>
      ) : null}
      {state.kind === "manual" ? (
        <span role="status">
          <label>
            {copy.copyThisLink}
            <input
              data-meta-exact-share-manual=""
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={state.url}
            />
          </label>
        </span>
      ) : null}
    </span>
  );
}

/** A lane that served no rows, said rather than drawn as blankness. */
function LaneEmpty({ reason, lane }: { reason: string; lane: string }) {
  return (
    <p
      className={styles.laneEmpty}
      data-meta-exact-lane-empty={lane}
      role="status"
    >
      {reason}
    </p>
  );
}

function ActionLane({
  rows,
  shown,
  emptyReason,
  onLoadMore,
}: {
  rows: readonly MetaDecisionCenterExactActionRowViewModel[];
  shown: number;
  emptyReason: string;
  onLoadMore?: () => void;
}) {
  const copy = useCopy();
  const page = rows.slice(0, shown);
  if (rows.length === 0) {
    return <LaneEmpty lane="action" reason={emptyReason} />;
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
            {display(row.confidence)} {copy.confidence.toLowerCase()}
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
  emptyReason,
  onLoadMore,
}: {
  rows: readonly MetaDecisionCenterExactNeedsResolutionRowViewModel[];
  shown: number;
  notice?: MetaDecisionCenterExactDisplayValue;
  emptyReason: string;
  onLoadMore?: () => void;
}) {
  const copy = useCopy();
  const language = useZeroBaseLanguage();
  const page = rows.slice(0, shown);
  if (rows.length === 0) {
    return (
      <LaneEmpty
        lane="needsres"
        reason={meaningfulDisplay(notice) ? display(notice) : emptyReason}
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
            {display(row.confidence)} {copy.confidence.toLowerCase()}
          </span>
          {/*
            The blocker, in the server's words. This is the whole point of the
            lane: the row is here because `node.lane === "blocked"`, and the
            operator's next question is what is holding it.
          */}
          <div className={styles.blockerSummary}>
            <span
              className={`${styles.blockerChip} ${toneClass(row.blockerTone ?? "warning")}`}
              data-el="blocker-chip"
            >
              {display(row.blocker)}
            </span>
            {typeof row.blockerCount === "number" && row.blockerCount > 1 ? (
              <span className={styles.blockerCount}>
                {language === "tr"
                  ? `${row.blockerCount} güvenlik kontrolü açık · tüm ayrıntılar için kanıtı aç`
                  : `${row.blockerCount} safety checks open · open evidence for full details`}
              </span>
            ) : null}
          </div>
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
  const copy = useCopy();
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
            {copy.review}
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
  const copy = useCopy();
  return (
    <article className={styles.archiveCard} data-meta-exact-archive>
      <table className={styles.archiveTable}>
        <thead>
          <tr>
            <th>{copy.entity}</th>
            <th>{copy.status}</th>
            <th>{`Spend · ${windowLabel}`}</th>
            <th>{copy.note}</th>
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
                    {copy.resume}
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
  const copy = useCopy();
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
        <p className={styles.creativeSparkLabel}>{copy.ctrWindowed}</p>
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
            ? `${copy.reviewEvidence} — ${display(row.name)}`
            : `Evidence unavailable for ${display(row.name)}`
        }
        className={`${styles.primaryAction} ${toneClass(row.actionTone)}`}
        data-meta-exact-creative-review="true"
        disabled={!row.onPrimary}
        onClick={(event) => callWithPropagationStopped(event, row.onPrimary)}
        type="button"
      >
        {copy.reviewEvidence}
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
  const copy = useCopy();
  if (!model) return null;
  return (
    <details
      className={`${styles.provenancePanel} ${toneClass(model.tone)}`}
      data-meta-exact-source-provenance
      data-meta-exact-source-scope={scope}
      open={defaultOpen}
    >
      <summary className={styles.provenanceSummary}>
        <span className={styles.provenanceEyebrow}>{copy.decisionSource}</span>
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
        heading={copy.coverage}
      />
      <SourceFactGroup
        facts={model.suppression}
        group="suppression"
        heading={copy.withheldFromQueue}
      />
      <SourceFactGroup
        facts={model.limitations}
        group="limitations"
        heading={copy.limitations}
      />
      <SourceFactGroup
        facts={model.commercialAnchor}
        group="commercial-anchor"
        heading="Commercial anchor"
      />

      {model.capabilityGaps && model.capabilityGaps.length > 0 ? (
        <div
          className={styles.provenanceGroup}
          data-meta-exact-source-group="capabilities"
        >
          <p className={styles.provenanceHeading}>{copy.capabilityGaps}</p>
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

function creativeGroupIdForLane(
  lane: MetaDecisionCenterExactLane,
): "act" | "blocked" | "monitor" | null {
  if (lane === "action") return "act";
  if (lane === "needsres") return "blocked";
  if (lane === "watching") return "monitor";
  return null;
}

function CreativesScope({
  posture,
  decisions,
  groups,
  lane,
  provenance,
  notice,
  footnote,
  onOpenCreativeStudio,
}: {
  posture: readonly MetaDecisionCenterExactCreativePostureViewModel[];
  decisions: readonly MetaDecisionCenterExactCreativeDecisionViewModel[];
  groups?: readonly MetaDecisionCenterExactCreativeGroupViewModel[];
  lane: MetaDecisionCenterExactLane;
  provenance?: MetaDecisionCenterExactSourceProvenanceViewModel | null;
  notice?: MetaDecisionCenterExactDisplayValue;
  footnote?: MetaDecisionCenterExactDisplayValue;
  onOpenCreativeStudio?: () => void;
}) {
  const copy = useCopy();
  const servedGroups = (groups ?? []).filter((group) => group.rows.length > 0);
  const selectedGroupId = creativeGroupIdForLane(lane);
  const visibleGroups = selectedGroupId
    ? servedGroups.filter((group) => group.id === selectedGroupId)
    : servedGroups;
  const hasGroupedDecisions = groups !== undefined;
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
      {hasGroupedDecisions && visibleGroups.length === 0 ? (
        <LaneEmpty lane={`creatives-${lane}`} reason={copy.laneServedNoRows} />
      ) : hasGroupedDecisions ? (
        visibleGroups.map((group) => (
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
      ) : (
        decisions.map((row) => <CreativeCard key={row.id} row={row} />)
      )}
      <SourceProvenancePanel
        defaultOpen={false}
        model={provenance}
        notice={notice}
        scope="creatives"
      />
      <div className={styles.creativeFootnote}>
        <p data-meta-exact-creative-footnote>{display(footnote)}</p>
        <span {...controlProps(onOpenCreativeStudio)}>
          Open Creative Studio →
        </span>
      </div>
    </>
  );
}

/**
 * The transition menu (`gated:META-WF-02..08 menu`).
 *
 * The seven transitions used to render as seven bare buttons in a row, each
 * `aria-disabled` with a title. Three things were wrong with that: the design
 * draws a `⋯` menu and not a button bar; a title is not an accessible
 * explanation; and `assign`, `snooze` and `reject` were fired with their
 * required fields hard-coded null, so two of them were guaranteed 422s and the
 * third was a no-op that still burned a version and made every other open tab
 * conflict.
 *
 * So: one trigger, a real `role="menu"` with roving focus and Escape, and a
 * form for the transitions that need one. Refusal keeps the trigger present
 * and explains itself in text — the contract's own failure clause is
 * "guest/reviewer: menu absent/disabled with reason".
 */
function WorkflowMenu({
  workflow,
}: {
  workflow: MetaDecisionCenterExactWorkflow;
}) {
  const copy = useCopy();
  const [open, setOpen] = useState(false);
  const [collecting, setCollecting] =
    useState<MetaDecisionCenterExactWorkflowAction | null>(null);
  const [values, setValues] = useState<{
    assigneeUserId: string;
    snoozeUntil: string;
    reasonCode: string;
  }>({ assigneeUserId: "", snoozeUntil: "", reasonCode: "" });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const refused =
    workflow.menuRefusedReason ?? workflow.actionsRefusedReason ?? null;

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setCollecting(null);
    if (returnFocus) triggerRef.current?.focus();
  };

  const choose = (action: MetaDecisionCenterExactWorkflowAction) => {
    if (action.refusalReason) return;
    if ((action.requires ?? []).length > 0) {
      setCollecting(action);
      setOpen(false);
      return;
    }
    action.onSelect?.({});
    close(true);
  };

  const missing = (collecting?.requires ?? []).filter((field) =>
    field === "assignee"
      ? !values.assigneeUserId.trim()
      : field === "snoozeUntil"
        ? !values.snoozeUntil.trim()
        : !values.reasonCode.trim(),
  );

  return (
    <div
      className={styles.workflowActions}
      data-meta-exact-workflow-menu={open ? "open" : "closed"}
    >
      <button
        aria-disabled={refused ? true : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        className={styles.workflowMenuTrigger}
        data-ctl="gated:META-WF-02..08 menu"
        onClick={refused ? undefined : () => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        ⋯ {copy.workflow}
      </button>
      {refused ? (
        <p className={styles.inspectorMeta} data-workflow-menu-refusal>
          {refused}
        </p>
      ) : null}
      {workflow.pending ? (
        <p className={styles.inspectorMeta} role="status">
          {copy.recordingEllipsis}
        </p>
      ) : null}
      {open && !refused ? (
        <div
          className={styles.workflowMenu}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close(true);
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = Array.from(
              menuRef.current?.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]',
              ) ?? [],
            );
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const step = event.key === "ArrowDown" ? 1 : -1;
            items[(index + step + items.length) % items.length]?.focus();
          }}
          ref={menuRef}
          role="menu"
        >
          {workflow.actions.map((action) => (
            <button
              aria-disabled={action.refusalReason ? true : undefined}
              className={styles.workflowAction}
              data-workflow-action={action.id}
              key={action.id}
              onClick={() => choose(action)}
              role="menuitem"
              type="button"
            >
              {action.label}
              {(action.requires ?? []).length > 0 ? "…" : ""}
              {action.refusalReason ? (
                <span className={styles.workflowActionRefusal}>
                  {action.refusalReason}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {collecting ? (
        <form
          className={styles.workflowForm}
          data-meta-exact-workflow-form={collecting.id}
          onSubmit={(event) => {
            event.preventDefault();
            if (missing.length > 0) return;
            collecting.onSelect?.({
              ...(values.assigneeUserId.trim()
                ? { assigneeUserId: values.assigneeUserId.trim() }
                : {}),
              ...(values.snoozeUntil.trim()
                ? { snoozeUntil: values.snoozeUntil.trim() }
                : {}),
              ...(values.reasonCode.trim()
                ? { reasonCode: values.reasonCode.trim() }
                : {}),
            });
            close(true);
          }}
        >
          <p className={styles.inspectorSectionLabel}>{collecting.label}</p>
          {(collecting.requires ?? []).includes("assignee") ? (
            <label>
              {copy.assignToMemberId}
              <input
                onChange={(event) =>
                  setValues((v) => ({
                    ...v,
                    assigneeUserId: event.target.value,
                  }))
                }
                required
                value={values.assigneeUserId}
              />
            </label>
          ) : null}
          {(collecting.requires ?? []).includes("snoozeUntil") ? (
            <label>
              {copy.letCookUntilLabel}
              <input
                onChange={(event) =>
                  setValues((v) => ({ ...v, snoozeUntil: event.target.value }))
                }
                required
                type="datetime-local"
                value={values.snoozeUntil}
              />
            </label>
          ) : null}
          {(collecting.requires ?? []).includes("reasonCode") ? (
            <label>
              {copy.reasonCode}
              <input
                onChange={(event) =>
                  setValues((v) => ({ ...v, reasonCode: event.target.value }))
                }
                required
                value={values.reasonCode}
              />
            </label>
          ) : null}
          <span className={styles.workflowFormActions}>
            <button type="submit">{collecting.label}</button>
            <button onClick={() => close(true)} type="button">
              {copy.cancel}
            </button>
          </span>
        </form>
      ) : null}
    </div>
  );
}

/**
 * The version-conflict dialog (H12).
 *
 * Shown, never resolved silently. The operator sees what the server says the
 * decision is NOW beside what they were trying to do, and chooses — because a
 * silent retry against the refreshed version would overwrite whatever the other
 * operator just did without anyone reading it.
 *
 * The two control keys read backwards and are the design's own: `keep` is KEEP
 * MINE (re-submit against the fresh version) and `reapply` is TAKE SERVER
 * (discard the local transition).
 */
function WorkflowConflictDialog({
  conflict,
}: {
  conflict: MetaDecisionCenterExactWorkflowConflict;
}) {
  const copy = useCopy();
  return (
    <div
      aria-label={copy.decisionChangedWhileReading}
      aria-modal="false"
      className={styles.conflictDialog}
      data-el="conflict-dialog"
      role="dialog"
    >
      <p className={styles.conflictMessage}>{display(conflict.message)}</p>
      <dl className={styles.conflictFacts}>
        <div>
          <dt>{copy.serverNow}</dt>
          <dd data-meta-exact-conflict-current>
            {display(conflict.currentStateLabel)} · version{" "}
            {conflict.currentVersion}
          </dd>
        </div>
        <div>
          <dt>{copy.youTried}</dt>
          <dd data-meta-exact-conflict-attempted>
            {display(conflict.attemptedLabel)} · from version{" "}
            {conflict.attemptedFromVersion}
          </dd>
        </div>
      </dl>
      <span className={styles.conflictActions}>
        <button
          aria-disabled={conflict.keepRefusedReason ? true : undefined}
          data-ctl="live:META-WF-11 keep"
          onClick={conflict.keepRefusedReason ? undefined : conflict.onKeepMine}
          type="button"
        >
          {copy.keepMineReapplyAgainstVersion} {conflict.currentVersion}
        </button>
        <button
          data-ctl="live:META-WF-11 reapply"
          onClick={conflict.onTakeServer}
          type="button"
        >
          {copy.takeTheServersState}
        </button>
      </span>
      {conflict.keepRefusedReason ? (
        <p
          className={styles.inspectorMeta}
          data-meta-exact-conflict-keep-refused
        >
          {conflict.keepRefusedReason}
        </p>
      ) : null}
    </div>
  );
}

function EvidenceInspector({
  model,
  onClose,
}: {
  model?: MetaDecisionCenterExactInspectorViewModel | null;
  onClose?: () => void;
}) {
  const copy = useCopy();
  const language = useZeroBaseLanguage();
  const reasons = (model?.reasons ?? []).filter(meaningfulDisplay);
  const evidence = (model?.evidence ?? []).filter(
    (item) => meaningfulDisplay(item.label) && meaningfulDisplay(item.value),
  );
  const inspectorTone = toneClass(model?.tone);
  const hasContractDetail = meaningfulDisplay(model?.contractDetail);
  const hasTargetComparison = meaningfulDisplay(model?.targetComparison);
  const hasMoneyDetail = meaningfulDisplay(model?.moneyDetail);
  const hasBlockers = meaningfulDisplay(model?.blockers);
  const blockerItems = hasBlockers
    ? display(model?.blockers)
        .split(" · ")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  const hasAdvisories = meaningfulDisplay(model?.advisories);
  const hasProvenance = meaningfulDisplay(model?.provenance);
  /*
   * No selection, no panel.
   *
   * This used to render regardless, so once the inspector became closable — and
   * once a lane could have no selected row — the operator would have met a
   * fully drawn panel of em dashes rather than an absent one.
   */
  if (!model) return null;
  return (
    <aside
      className={`${styles.inspector} ${inspectorTone}`}
      data-meta-exact-inspector
    >
      <div className={styles.inspectorHeader}>
        <span className={styles.inspectorEyebrow}>
          {copy.evidenceInspector}
        </span>
        <span className={`${styles.inspectorDecision} ${inspectorTone}`}>
          {display(model?.decisionLabel)}
        </span>
        {onClose ? (
          <button
            aria-label={copy.closeEvidenceInspector}
            className={styles.inspectorClose}
            data-ctl="live:close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        ) : null}
      </div>
      <div className={styles.inspectorBody}>
        <div>
          <p className={styles.inspectorEntity}>{display(model?.entityName)}</p>
          <p className={styles.inspectorMeta}>{display(model?.entityMeta)}</p>
        </div>
        <div className={styles.contractCard}>
          <p className={styles.inspectorSectionLabel}>
            {copy.decisionContract}
          </p>
          <p className={styles.contractCopy}>
            {copy.serverVerdict}: <b>{display(model?.serverVerdict)}</b>
            {hasContractDetail ? `. ${display(model?.contractDetail)}` : null}
          </p>
        </div>
        {reasons.length > 0 ? (
          <div>
            <p className={styles.reasonHeading}>{copy.engineReasoning}</p>
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
            {copy.moneyImpactVsTarget}
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
            <span className={styles.inspectorMiniLabel}>{copy.confidence}</span>
            <span className={styles.inspectorMiniValue}>
              {display(model?.confidence)}
            </span>
          </span>
          <span
            className={`${styles.inspectorMiniTile} ${styles.readinessTile}`}
          >
            <span className={styles.inspectorMiniLabel}>{copy.readiness}</span>
            <span className={styles.inspectorMiniValue}>
              {display(model?.readiness)}
            </span>
          </span>
        </div>
        {hasBlockers ? (
          <div>
            <p className={styles.blockersHeading}>{copy.blockers}</p>
            <ul
              className={styles.inspectorBlockerList}
              data-meta-exact-blockers
            >
              {blockerItems.map((blocker, index) => (
                <li
                  className={`${styles.blockersCopy} ${toneClass(model?.blockerTone)}`}
                  key={`inspector-blocker-${index}`}
                >
                  {blocker}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {hasAdvisories ? (
          <div>
            <p className={styles.blockersHeading}>{copy.advisories}</p>
            <p className={`${styles.blockersCopy} ${toneClass("neutral")}`}>
              {display(model?.advisories)}
            </p>
          </div>
        ) : null}
        {/*
          What this verdict was measured over.

          Two facts and never one: `asof-row` is when the engine wrote the
          snapshot, `evidence-window` is the range the figures above cover. A
          verdict without the window is unfalsifiable — the reader cannot tell
          what it was measured over — and a snapshot time presented as the
          window is how a stale read passes for a current one.
        */}
        {meaningfulDisplay(model?.asOf) ||
        meaningfulDisplay(model?.evidenceWindow) ? (
          <dl className={styles.evidenceProvenance}>
            <div>
              <dt>{copy.asOf}</dt>
              <dd data-el="asof-row">{display(model?.asOf)}</dd>
            </div>
            <div>
              <dt>{copy.evidenceWindow}</dt>
              <dd data-el="evidence-window">
                {display(model?.evidenceWindow)}
              </dd>
            </div>
          </dl>
        ) : null}
        {(model?.provenanceGaps ?? []).filter(meaningfulDisplay).length > 0 ? (
          <div>
            <p className={styles.blockersHeading}>
              {copy.notServedAtThisGrain}
            </p>
            <p className={styles.provenanceGap} data-el="provenance-gap">
              {(model?.provenanceGaps ?? [])
                .filter(meaningfulDisplay)
                .map((gap) => display(gap))
                .join(" · ")}
            </p>
          </div>
        ) : null}
        {/*
          The row's own onward actions, as opposed to the decision's primary
          action. Grouped under one marker because the design treats them as one
          band: what an operator can do with THIS row without executing it.
        */}
        {model?.workflow ? (
          <div
            data-meta-exact-workflow
            data-workflow-state={model.workflow.state}
          >
            <p className={styles.inspectorSectionLabel}>{copy.workflow}</p>
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
              <WorkflowMenu workflow={model.workflow} />
            ) : null}
            {model.workflow.conflict ? (
              <WorkflowConflictDialog conflict={model.workflow.conflict} />
            ) : null}
            {model.workflow.actionsRefusedReason ? (
              <p className={styles.inspectorMeta} data-workflow-refusal>
                {model.workflow.actionsRefusedReason}
              </p>
            ) : null}
          </div>
        ) : null}
        {model?.stickyBar ? (
          <div className={styles.stickyBar} data-meta-exact-sticky-bar>
            <button
              aria-disabled={
                model.manualAction?.refusalReason ? true : undefined
              }
              className={styles.manualActionButton}
              data-ctl="gated:META-WRITE-01"
              onClick={
                model.manualAction?.refusalReason
                  ? undefined
                  : model.manualAction?.onOpen
              }
              type="button"
            >
              {copy.openManualAction}
            </button>
            <a
              className={styles.stickyBarNav}
              data-ctl="live:nav"
              href={model.stickyBar.metaStopHref}
            >
              {copy.metaStop}
            </a>
          </div>
        ) : null}
        {model?.manualAction ? (
          <p className={styles.rowAction}>
            <button
              aria-disabled={
                model.manualAction.refusalReason ? true : undefined
              }
              className={styles.manualActionButton}
              data-ctl="gated:META-WRITE-01 open-manual"
              onClick={
                model.manualAction.refusalReason
                  ? undefined
                  : model.manualAction.onOpen
              }
              type="button"
            >
              {meaningfulDisplay(model.manualAction.label)
                ? display(model.manualAction.label)
                : copy.openManualAction}
            </button>
            {model.manualAction.refusalReason ? (
              <span
                className={styles.manualActionRefusal}
                data-meta-exact-manual-refusal
              >
                {model.manualAction.refusalReason}
              </span>
            ) : null}
          </p>
        ) : null}
        {model?.brief ? (
          <p className={styles.rowAction} data-el="row-action">
            {"href" in model.brief ? (
              <a
                data-ctl="live:CREATIVE-07 brief"
                href={model.brief.href}
                rel="noopener"
              >
                {meaningfulDisplay(model.brief.label)
                  ? display(model.brief.label)
                  : copy.openTheBrief}
              </a>
            ) : (
              <button
                aria-disabled="true"
                data-ctl="live:CREATIVE-07 brief"
                data-refused=""
                type="button"
              >
                {model.brief.refusalReason}
              </button>
            )}
          </p>
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
  onCloseInspector,
  adsManagerHref = null,
  onScopeChange,
  onLaneChange,
  onRunSnapshot,
  onNewCampaign,
  onSortChange,
  levels = [],
  onLevelsChange,
  onSearchChange,
  initialQuery = "",
  onOpenCreativeStudio,
}: MetaDecisionCenterExactProps) {
  const copy = useCopy();
  /*
   * The active language, for one marker.
   *
   * P06 and P07 are the Turkish artboards and their `turkish-strings` marker
   * used to come from a paragraph pasted into the frame registry, which the
   * anatomy gate (a substring match on the rendered HTML) could not tell from a
   * component that had actually been translated. Emitted here, it means what it
   * says: this header is rendering the catalogue's Turkish.
   */
  const language = useZeroBaseLanguage();
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
  /*
   * The surface root, so closing the inspector can hand focus back.
   *
   * `live:close` contracts "focus returns to originating row", and the row that
   * opened the panel is the one the view model marked selected. Queried at
   * close time rather than tracked in a ref map: the rows are rebuilt on every
   * payload, and a map keyed by id would hold stale nodes across a re-read.
   */
  const rootRef = useRef<HTMLElement | null>(null);
  /*
   * The search box, so `/` can reach it.
   *
   * `live:META-DEC-17 search` contracts "click or / key". The key is bound on
   * the surface rather than the document: this component does not own the page,
   * and a global listener would steal `/` from anything else on it.
   */
  const searchRef = useRef<HTMLInputElement | null>(null);
  const shownFor = (laneId: MetaDecisionCenterExactLane) =>
    shownByLane[laneId] ?? LANE_PAGE_SIZE;
  const loadMoreFor = (laneId: MetaDecisionCenterExactLane) => () =>
    setShownByLane((previous) => ({
      ...previous,
      [laneId]: (previous[laneId] ?? LANE_PAGE_SIZE) + LANE_PAGE_SIZE,
    }));

  const activeScope = scope ?? internalScope;
  const activeLane = lane ?? internalLane;
  /*
   * Why a lane is empty, distinguishing the two cases that look identical.
   *
   * "Nothing was served" and "everything served was filtered out" are different
   * facts, and a lane that says the first while the operator has a search term
   * and a level selected is telling them the account is empty when it is not.
   */
  const activeFilters = [
    query.trim() ? copy.theSearchTerm.replace("{term}", query.trim()) : null,
    levels.length > 0
      ? (levels.length === 1 ? copy.theLevel : copy.theLevels).replace(
          "{levels}",
          levels.join(", "),
        )
      : null,
  ].filter((value): value is string => Boolean(value));
  const laneEmptyReason =
    activeFilters.length > 0
      ? copy.noRowMatchesFilters.replace("{filters}", activeFilters.join(" · "))
      : copy.laneServedNoRows;
  const activeWindow =
    viewModel.activeWindow === undefined ? "28d" : viewModel.activeWindow;
  const counts = viewModel.counts;
  const identity = viewModel.identity;
  const budgetReadinessSummary = budgetDecisionReadinessSummary(
    viewModel.budgetEvidence,
    viewModel.budgetDryRun,
  );
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
    <section
      className={styles.root}
      data-screen-label="Meta Decision Center"
      onKeyDown={(event) => {
        if (event.key !== "/" || event.defaultPrevented) return;
        const target = event.target as HTMLElement | null;
        // Never while the operator is typing: `/` is a character in a search
        // term, an entity name and a reason code.
        const tag = target?.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target?.isContentEditable
        )
          return;
        event.preventDefault();
        searchRef.current?.focus();
      }}
      ref={rootRef}
    >
      <div
        className={styles.pageHeader}
        data-el={language === "tr" ? "turkish-strings" : undefined}
      >
        <div>
          <p className={styles.pageEyebrow}>
            Meta · {display(identity?.accountLabel)} ·{" "}
            {display(identity?.currency)}
          </p>
          <h1>{copy.decisionCenter}</h1>
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
            {copy.runSnapshot}
          </button>
          <button
            className={styles.newCampaignButton}
            disabled={!onNewCampaign}
            onClick={onNewCampaign}
            type="button"
          >
            {copy.newCampaign}
          </button>
        </div>
      </div>

      <ExactKpiBand
        kpis={viewModel.kpis}
        activeWindow={activeWindow ?? EM_DASH}
      />

      <OperatorDecisionSummary
        counts={counts}
        summary={viewModel.operatorSummary}
        onSelectLane={selectLane}
        onSelectScope={selectScope}
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
            {copy.campaignsAndAdSets}
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
            {copy.creatives}
            <span>{display(counts?.creatives)}</span>
          </span>
        </span>
        <p data-meta-exact-queue-snapshot>
          queue reflects {display(identity?.snapshotLabel)} —{" "}
          {copy.queueReflectsSnapshot}
        </p>
        {/*
          Beside the controls that scope the list, not after every row: the link
          reproduces the VIEW, so it belongs where the view is chosen.
        */}
        <ShareViewControl />
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
            aria-label={copy.decisionLanes}
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
              <button
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
                type="button"
              >
                {copy[item.labelKey]}
                <span>{display(counts?.[item.id])}</span>
              </button>
            ))}
          </span>
          <span className={styles.deferredPill}>
            {copy.deferred} {display(counts?.deferred)}
          </span>
          <span className={styles.toolbarSpacer} />
          <LevelFilter
            levels={levels}
            onLevelsChange={onLevelsChange}
            scope={activeScope}
          />
          <select
            aria-label={copy.sortDecisions}
            onChange={(event) => {
              const next = event.target.value as MetaDecisionCenterExactSort;
              setSort(next);
              onSortChange?.(next);
            }}
            value={sort}
          >
            <option value="money">{copy.sortMoneyAtStake}</option>
            <option value="priority">{copy.sortPriority}</option>
            <option value="age">{copy.sortAge}</option>
          </select>
          <input
            aria-label={copy.searchEntities}
            data-ctl="live:META-DEC-17 search"
            onChange={(event) => {
              setQuery(event.target.value);
              onSearchChange?.(event.target.value);
            }}
            placeholder={`${copy.searchEntities}…`}
            ref={searchRef}
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
          {/*
            The level filter comes along for the same reason the search box
            does: it is page state that filters THESE rows too, and a control
            that vanished on scope change would leave a filter applied with no
            visible cause and no way out.
          */}
          <LevelFilter
            levels={levels}
            onLevelsChange={onLevelsChange}
            scope={activeScope}
          />
          <input
            aria-label={copy.searchCreatives}
            data-ctl="live:META-DEC-17 search"
            onChange={(event) => {
              setQuery(event.target.value);
              onSearchChange?.(event.target.value);
            }}
            placeholder={`${copy.searchCreatives}…`}
            ref={searchRef}
            value={query}
          />
        </div>
      )}

      <div
        className={`${styles.workspace} ${showInspector ? styles.workspaceWithInspector : ""}`}
        data-meta-exact-workspace
      >
        <div className={styles.queue}>
          {activeScope === "structure" && activeLane === "action" ? (
            <ActionLane
              emptyReason={laneEmptyReason}
              onLoadMore={loadMoreFor("action")}
              rows={viewModel.actionRows ?? []}
              shown={shownFor("action")}
            />
          ) : null}
          {activeScope === "structure" && activeLane === "needsres" ? (
            <NeedsResolutionLane
              emptyReason={laneEmptyReason}
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
              lane={activeLane}
              notice={viewModel.creativesNotice}
              onOpenCreativeStudio={onOpenCreativeStudio}
              posture={viewModel.creativePosture ?? []}
              provenance={viewModel.sourceProvenance}
            />
          ) : null}
          {/*
           * Supporting evidence follows the decision queue. The reference
           * surface opens with actionable rows; source and budget diagnostics
           * remain available without standing between the operator and the
           * decision they came here to review.
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
          {viewModel.budgetEvidence || viewModel.budgetDryRun ? (
            <details className={styles.technicalDisclosure}>
              <summary>
                <span
                  className={styles.technicalDisclosureSummary}
                  data-readiness-state={budgetReadinessSummary.state}
                >
                  <span>Budget decision readiness</span>
                  <small data-meta-exact-budget-readiness-summary>
                    {budgetReadinessSummary.text}
                  </small>
                </span>
              </summary>
              <div className={styles.technicalDisclosureBody}>
                <BudgetDecisionEvidencePanel
                  evidence={viewModel.budgetEvidence ?? null}
                />
                <BudgetDryRunPanel panel={viewModel.budgetDryRun ?? null} />
              </div>
            </details>
          ) : null}
        </div>
        {showInspector ? (
          <EvidenceInspector
            model={viewModel.inspector}
            onClose={
              onCloseInspector
                ? () => {
                    onCloseInspector();
                    // The row that opened it, then any row: a panel that closed
                    // and left focus on `<body>` would drop a keyboard operator
                    // at the top of the document.
                    const back =
                      rootRef.current?.querySelector<HTMLElement>(
                        '[data-meta-exact-selected="true"] [data-meta-exact-card-open]',
                      ) ??
                      rootRef.current?.querySelector<HTMLElement>(
                        "[data-meta-exact-card-open]",
                      );
                    back?.focus();
                  }
                : undefined
            }
          />
        ) : null}
      </div>

      {/*
        Supporting account coverage follows the decisions. These facts remain
        available for audit, but they must not displace the queue from the
        first viewport.

        D078 R4 (correction 2): every assigned identity keeps its selection
        state, currency, timezone, own-window spend, fact freshness, latest
        generation, decision counts and policy visible inside this disclosure.
      */}
      {viewModel.assignedAccountStates === null ? (
        <p
          className={styles.inactiveStrip}
          data-meta-exact-account-coverage
          data-testid="assigned-account-coverage-unavailable"
          role="alert"
        >
          Assigned-account coverage unavailable — the account-state read failed.
          Do not assume there is only one account or no historical account for
          this business.
        </p>
      ) : null}
      {viewModel.assignedAccountStates &&
      viewModel.assignedAccountStates.length === 0 ? (
        <p
          className={styles.inactiveStrip}
          data-meta-exact-account-coverage
          data-testid="assigned-account-coverage-empty"
        >
          Account-state read succeeded and found ZERO assigned Meta identities —
          anomalous for an active Meta workspace; verify the account assignment
          before trusting any decision surface here.
        </p>
      ) : null}
      {viewModel.assignedAccountStates &&
      viewModel.assignedAccountStates.length > 0 ? (
        <details
          className={`${styles.inactiveStrip} ${styles.accountCoverageDisclosure}`}
          data-meta-exact-account-coverage
          data-testid="assigned-account-coverage"
        >
          <summary className={styles.accountCoverageSummary}>
            <strong>
              {viewModel.assignedAccountStates.length} assigned Meta account
              {viewModel.assignedAccountStates.length === 1 ? "" : "s"}
            </strong>
            <span>
              {(() => {
                const deselected =
                  viewModel.assignedAccountStates?.filter(
                    (state) => state.selectionState === "deselected_historical",
                  ) ?? [];
                const deselectedWithSpend = deselected.filter(
                  (state) => state.spend14d !== null && state.spend14d > 0,
                );
                const deselectedWithoutSpendProof = deselected.filter(
                  (state) => state.spend14d === null,
                );
                if (deselectedWithSpend.length > 0) {
                  return language === "tr"
                    ? `Uyarı: Seçili olmayan ${deselectedWithSpend.length} hesapta son 14 gün harcaması var; bu hesaplar salt okunur ve sunulan kararların dışında.`
                    : `Warning: ${deselectedWithSpend.length} deselected account${deselectedWithSpend.length === 1 ? " has" : "s have"} recorded 14-day spend; ${deselectedWithSpend.length === 1 ? "it is" : "they are"} read-only and excluded from served decisions.`;
                }
                if (deselectedWithoutSpendProof.length > 0) {
                  return language === "tr"
                    ? `Uyarı: Seçili olmayan ${deselectedWithoutSpendProof.length} hesabın son 14 gün harcaması doğrulanamadı; karar kapsamına güvenmeden önce ayrıntıları inceleyin.`
                    : `Warning: ${deselectedWithoutSpendProof.length} deselected account${deselectedWithoutSpendProof.length === 1 ? " has" : "s have"} no verified 14-day spend; review details before trusting the decision scope.`;
                }
                const selected = viewModel.assignedAccountStates?.find(
                  (state) => state.selectionState === "selected",
                );
                return selected?.latestFactDate
                  ? `Selected account data through ${selected.latestFactDate}`
                  : "Open account coverage details";
              })()}
            </span>
          </summary>
          <strong>Assigned accounts</strong>
          {viewModel.assignedAccountStates.map((state) => (
            <div
              key={state.providerAccountId}
              data-account-coverage-id={state.providerAccountId}
              data-account-selection-state={state.selectionState}
              style={{ display: "grid", gap: 2, margin: "6px 0" }}
            >
              <span>
                {state.accountName
                  ? `${state.accountName} | ${state.providerAccountId}`
                  : state.providerAccountId}{" "}
                —{" "}
                {state.selectionState === "selected"
                  ? "selected · serving"
                  : "deselected · read-only history"}
              </span>
              <span data-account-coverage-facts>
                {[
                  state.accountCurrency
                    ? `currency ${state.accountCurrency}`
                    : null,
                  state.accountTimezone
                    ? `timezone ${state.accountTimezone}`
                    : null,
                  state.spend14d !== null
                    ? `spend 14d ${state.spend14d.toLocaleString("en-US", { maximumFractionDigits: 0 })}${state.accountCurrency ? ` ${state.accountCurrency}` : ""}`
                    : "spend 14d unavailable",
                  state.latestFactDate
                    ? `facts to ${state.latestFactDate}`
                    : "fact freshness unavailable",
                  state.latestDecisionAsOf
                    ? `latest decisions ${state.latestDecisionAsOf}`
                    : "no produced decision generation",
                  state.latestDecisionRows !== null
                    ? `${state.latestDecisionRows} decision rows` +
                      (state.latestDecisionAuthorizedRows
                        ? ` (${state.latestDecisionAuthorizedRows} authorized)`
                        : "") +
                      (state.selectionState === "deselected_historical" &&
                      state.latestDecisionRows > 0
                        ? " — unserved"
                        : "")
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span data-account-coverage-policy>{state.policy}</span>
            </div>
          ))}
        </details>
      ) : null}
      {activeScope === "structure" ? (
        <p className={styles.inactiveStrip} data-meta-exact-inactive-strip>
          <span>
            {copy.inactiveAssets} {display(counts?.archive)} —{" "}
            {copy.outsideDecisionLanesAdvisory}
          </span>
          <button
            className={styles.inactiveStripOpen}
            data-ctl="live:META-DEC-13 open"
            onClick={() => selectLane("archive")}
            type="button"
          >
            {copy.openInactiveAssetsDetail}
          </button>
          {adsManagerHref ? (
            <a
              className={styles.adsManagerLink}
              data-meta-exact-ads-manager-link
              href={adsManagerHref}
              rel="noopener noreferrer"
              target="_blank"
            >
              {copy.openMetaAdsManager}
              <span className={styles.adsManagerNote}>
                {copy.opensMetaNothingExecuted}
              </span>
            </a>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
