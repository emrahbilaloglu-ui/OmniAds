"use client";

import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import {
  useCopy,
  useZeroBaseLanguage,
} from "@/components/zero-base/i18n/copy-provider";

import styles from "./MetaDecisionCenterExact.module.css";
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
    /** Server-fact presentation: classified/unresolved coverage, not a manual label. */
    detail?: MetaDecisionCenterExactDisplayValue;
    /** Locale-neutral server state. The client translates it; it does not infer it. */
    status?: "no_active" | "unresolved" | "resolved" | "unavailable";
    activeCount?: MetaDecisionCenterExactDisplayValue;
    unresolvedCount?: MetaDecisionCenterExactDisplayValue;
    /** Automatic roles that passed the independent action-authority gate. */
    actionAuthoritativeCount?: MetaDecisionCenterExactDisplayValue;
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
 * The extra fields over an action row are stable buyer copy mapped from the
 * server's blocker and resolution codes. There is no `actionLabel` and no
 * `onPrimary` by design — a blocked decision has no authorized action, and
 * offering one would be the UI deciding something the server refused.
 */
export interface MetaDecisionCenterExactNeedsResolutionRowViewModel {
  id: string;
  name?: MetaDecisionCenterExactDisplayValue;
  level?: MetaDecisionCenterExactDisplayValue;
  lineage?: MetaDecisionCenterExactDisplayValue;
  lineageRole?: "parent" | "child";
  selected?: boolean;
  /** Automatic role/context facts; never a manual Test/Main/Mixed label. */
  chips?: readonly MetaDecisionCenterExactDisplayValue[];
  /** The served verdict, still printed: blocked is about authority, not truth. */
  decisionLabel?: MetaDecisionCenterExactDisplayValue;
  decisionTone?: MetaDecisionCenterExactTone;
  /** Why this row cannot move, mapped to stable buyer-facing copy. */
  blocker?: MetaDecisionCenterExactDisplayValue;
  /** True only when `blocker` came from the buyer-copy mapping. */
  blockerBuyerFacing?: boolean;
  /** Exact number of server-owned readiness checks still open. */
  blockerCount?: number | null;
  blockerTone?: MetaDecisionCenterExactTone;
  /** The next step mapped from the server's resolution code. */
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
  /**
   * The verdict the ENGINE reached and the server then WITHHELD, in buyer
   * words — "Held verdict: Refresh creative".
   *
   * A SECOND, SEPARATE FACT from `decisionLabel`, and that is the whole point.
   * A held Refresh publishes `keep`, so the published label reads "Keep
   * monitoring" — the opposite of what the engine concluded — and the row said
   * nothing else. This badge is the engine's conclusion; the label beside it
   * stays the authorized outcome. Absent when no held verdict was served,
   * which is not the same fact as "nothing was held".
   *
   * It is EVIDENCE, never authorization: a row carrying it offers no execution
   * control, and this component draws none from it.
   * @see heldCreativeVerdict in meta-decision-center-exact-adapter.ts
   */
  heldVerdictLabel?: MetaDecisionCenterExactDisplayValue;
  heldVerdictTone?: MetaDecisionCenterExactTone;
  /**
   * What to do about it, in the same buyer language as the label.
   *
   * ROUND 9 ITEM 8. The INSPECTOR model carried this and the creative ROW model
   * did not, so the mobile row — which is built from the row model — could not
   * show it even once it started drawing the label. Both models now carry both
   * halves from the one producer.
   */
  heldVerdictNextStep?: MetaDecisionCenterExactDisplayValue;
  chips?: readonly MetaDecisionCenterExactDisplayValue[];
  /**
   * The row's one sentence, in buyer language.
   *
   * NOT the server's `whyNow`, which this comment used to claim: that field
   * carries producer prose — bracketed internal states like
   * "[Ad metrics unavailable - fail closed]" and reason codes — and it must not
   * reach an operator. The adapter maps the served blocker, resolution and
   * action codes through the buyer-copy catalogs instead, and a code with no
   * entry falls back to a written sentence rather than to itself.
   * @see buyerFacingCreativeReason in meta-decision-center-exact-adapter.ts
   */
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
  /**
   * The verdict the engine reached and authority withheld.
   *
   * ADDITIONAL to `decisionLabel`, never a replacement for it. A held Refresh
   * publishes `keep`, so `decisionLabel` reads "Keep monitoring" — still true,
   * because it is what authority allows — while the engine's own conclusion
   * was the opposite. The queue row draws both; the panel it opens must draw
   * both too, or the second fact is lost one click later.
   *
   * Absent when nothing was held. Absence is not a verdict, so no held block
   * is drawn and the published tone stands unaltered.
   */
  heldVerdictLabel?: MetaDecisionCenterExactDisplayValue;
  heldVerdictTone?: MetaDecisionCenterExactTone;
  /**
   * The next step for THE HELD VERDICT, from its own resolution.
   *
   * Separate from `reasons` and `contractDetail`, which answer for the
   * PUBLISHED decision. Merging them would attach the published label's
   * sentence to the withheld verdict, which is how a withheld Refresh came to
   * be explained as "Review the missing evidence before taking action."
   */
  heldVerdictNextStep?: MetaDecisionCenterExactDisplayValue;
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

function inspectorDateLocale(language: "en" | "tr"): string {
  return language === "tr" ? "tr-TR" : "en-US";
}

function calendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value.trim()
    ? parsed
    : null;
}

function postgresInstant(value: string): Date | null {
  const normalized = value
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T")
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
    .replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function formatInspectorDate(value: string, language: "en" | "tr"): string {
  const parsed = calendarDate(value);
  if (!parsed) return value;
  return new Intl.DateTimeFormat(inspectorDateLocale(language), {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function formatInspectorAsOf(
  value: MetaDecisionCenterExactDisplayValue,
  language: "en" | "tr",
): string {
  const raw = display(value);
  const dateOnly = calendarDate(raw);
  if (dateOnly) return formatInspectorDate(raw, language);
  const parsed = postgresInstant(raw);
  if (!parsed) return raw;
  return new Intl.DateTimeFormat(inspectorDateLocale(language), {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(parsed);
}

function formatInspectorEvidenceWindow(
  value: MetaDecisionCenterExactDisplayValue,
  language: "en" | "tr",
): string {
  const raw = display(value);
  const match = /^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/.exec(
    raw,
  );
  if (!match) return raw;
  return `${formatInspectorDate(match[1], language)} – ${formatInspectorDate(match[2], language)}`;
}

const GENERIC_NEEDS_RESOLUTION_COPY = new Set([
  "Review and apply this change manually.",
  "Review the evidence before making a change.",
]);

export function metaNeedsResolutionNextStep(
  row: MetaDecisionCenterExactNeedsResolutionRowViewModel,
  language: "en" | "tr",
): string {
  const resolution = display(row.resolution);
  if (
    meaningfulDisplay(row.resolution) &&
    !GENERIC_NEEDS_RESOLUTION_COPY.has(resolution)
  ) {
    return resolution;
  }
  if (row.blockerBuyerFacing && meaningfulDisplay(row.blocker)) {
    return display(row.blocker);
  }
  return language === "tr"
    ? "Karar ayrıntılarını açın."
    : "Open decision details.";
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

function positiveDisplayCount(
  value: MetaDecisionCenterExactDisplayValue,
): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value !== "string") return false;
  const normalized = value.trim().replaceAll(",", "");
  return /^\d+$/.test(normalized) && Number(normalized) > 0;
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
 * The selected fill/ring gives the visual cue; `aria-current` and this clipped
 * word carry the same state to assistive technology without adding another
 * badge that changes the accepted V2 card geometry.
 */
function QueueSelectedMarker({ selected }: { selected?: boolean }) {
  const copy = useCopy();
  if (!selected) return null;
  return (
    <span
      aria-label={copy.inspecting}
      className={styles.selectedMarker}
      title={copy.inspecting}
    >
      {copy.inspecting}
    </span>
  );
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
  const copy = useCopy();
  const complete = shown >= served;
  return (
    <p className={styles.lanePaging} data-meta-exact-lane-paging={label}>
      <span data-lane-count="">
        {(complete ? copy.allServedRowsShown : copy.showingOfServedRows)
          .replace("{shown}", String(shown))
          .replace("{served}", String(served))}
      </span>
      {!complete ? (
        <button
          className={styles.lanePagingMore}
          data-ctl="live:META-DEC-05 load-more"
          onClick={onLoadMore}
          type="button"
        >
          {copy.showMore}
        </button>
      ) : null}
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
 * Deliberately actionless. Each row carries one concise next step, while the
 * selected row's evidence inspector carries the full reason. Generic review
 * prose is suppressed, and the queue preserves the verdict, metrics and
 * confidence.
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
            title={
              row.staleDemoted && meaningfulDisplay(row.staleDemotedReason)
                ? display(row.staleDemotedReason)
                : undefined
            }
          >
            {display(row.confidence)} {copy.confidence.toLowerCase()}
          </span>
          <span className={styles.resolutionStep} data-el="resolution-step">
            {metaNeedsResolutionNextStep(row, language)}
          </span>
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
  const visibleSegments = segments.filter((segment) =>
    positiveDisplayCount(segment.count),
  );
  return (
    <>
      {visibleSegments.length > 0 ? (
        <div className={styles.watchSegments}>
          {visibleSegments.map((segment) => (
            <span className={styles.watchSegment} key={segment.id}>
              {display(segment.label)} {display(segment.count)}
            </span>
          ))}
        </div>
      ) : null}
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
  const metrics = (card?.metrics ?? []).filter((metric) =>
    meaningfulDisplay(metric.value),
  );
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
        {metrics.map((metric) => (
          <div className={styles.nonSalesMetric} key={metric.id}>
            <p className={styles.nonSalesMetricLabel}>
              {display(metric.label)}
            </p>
            <p className={styles.nonSalesMetricValue}>
              {display(metric.value)}
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
  grouped = false,
}: {
  row: MetaDecisionCenterExactCreativeDecisionViewModel;
  grouped?: boolean;
}) {
  const copy = useCopy();
  const stripeA = row.stripeA?.trim() || "#F1F4F9";
  const stripeB = row.stripeB?.trim() || "#F7F9FC";
  const isBlocked =
    nonBlankDisplay(row.stateLabel) &&
    String(row.stateLabel).trim().toLowerCase() === "blocked";
  /*
   * A HELD VERDICT SUPPRESSES THE ACTION LINE ON ITS OWN.
   *
   * `isBlocked` above is a string comparison against a badge caption, so a row
   * that carries a held verdict but no state badge — the flat `creativeDecisions`
   * path, and any caller that supplies rows without state — read as unblocked
   * and drew the served action line. The typed held verdict is the fact that
   * actually governs here: it is served only with an unauthorized label, so a
   * row carrying one has no authorized action to advertise.
   */
  const isHeld = nonBlankDisplay(row.heldVerdictLabel);
  const rowNote = isBlocked
    ? nonBlankDisplay(row.blockedNote)
      ? row.blockedNote
      : row.note
    : row.note;
  return (
    <article
      className={`${styles.creativeCard} ${toneClass(row.edgeTone)}`}
      data-meta-exact-creative-row={row.id}
      data-meta-exact-creative-state={
        nonBlankDisplay(row.stateLabel)
          ? String(row.stateLabel).trim()
          : undefined
      }
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
          {/* The engine's withheld conclusion, drawn beside the authorized
              label and never merged into it. It borrows the state badge's
              class because it is the same pill shape and the stylesheet is
              owned by another lane this round; it carries its own attribute
              and its own tone, so nothing about it reads as the state. */}
          {nonBlankDisplay(row.heldVerdictLabel) ? (
            <span
              className={`${styles.creativeStateBadge} ${toneClass(row.heldVerdictTone)}`}
              data-meta-exact-creative-held-verdict
            >
              {display(row.heldVerdictLabel)}
            </span>
          ) : null}
          {!grouped && nonBlankDisplay(row.stateLabel) ? (
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
        {nonBlankDisplay(rowNote) ? (
          <p
            className={isBlocked ? styles.creativeBlockedNote : styles.creativeNote}
            data-meta-exact-creative-next-step={isBlocked ? "true" : undefined}
          >
            {display(rowNote)}
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
      {!isBlocked && !isHeld && nonBlankDisplay(row.actionLabel) ? (
        <p
          className={`${styles.creativeServedAction} ${toneClass(row.actionTone)}`}
          data-meta-exact-creative-served-action={String(
            row.actionLabel,
          ).trim()}
        >
          {display(row.actionLabel)}
        </p>
      ) : null}
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
    </article>
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
  footnote,
  notice,
  onOpenCreativeStudio,
}: {
  posture: readonly MetaDecisionCenterExactCreativePostureViewModel[];
  decisions: readonly MetaDecisionCenterExactCreativeDecisionViewModel[];
  groups?: readonly MetaDecisionCenterExactCreativeGroupViewModel[];
  lane: MetaDecisionCenterExactLane;
  footnote?: MetaDecisionCenterExactDisplayValue;
  /**
   * The served source-health sentence, when the server sent one.
   *
   * `creativesNotice` has been on the view model and in this component's props
   * type since the adapter first produced it, and it reached NO pixel: nothing
   * destructured it and nothing rendered it. So the one condition it exists to
   * explain — the decision source cannot answer for the ACTIVE Ads this
   * account is running — was computed on every render and thrown away, while
   * the scope showed either an unexplained empty lane or a lane full of
   * placeholder rows. @see creativesNotice in meta-decision-center-exact-adapter.ts
   */
  notice?: MetaDecisionCenterExactDisplayValue;
  onOpenCreativeStudio?: () => void;
}) {
  const copy = useCopy();
  const visiblePosture = posture.filter(
    (item) => meaningfulDisplay(item.value) || meaningfulDisplay(item.detail),
  );
  const servedGroups = (groups ?? []).filter((group) => group.rows.length > 0);
  const selectedGroupId = creativeGroupIdForLane(lane);
  const visibleGroups = selectedGroupId
    ? servedGroups.filter((group) => group.id === selectedGroupId)
    : servedGroups;
  const hasGroupedDecisions = groups !== undefined;
  return (
    <>
      {visiblePosture.length > 0 ? (
        <div className={styles.postureGrid} data-meta-exact-creative-posture>
          {visiblePosture.map((item) => (
            <div
              className={`${styles.postureCard} ${toneClass(item.tone)}`}
              key={item.id}
            >
              <p className={styles.postureLabel}>{display(item.label)}</p>
              {meaningfulDisplay(item.value) ? (
                <p className={styles.postureValue}>{display(item.value)}</p>
              ) : null}
              {meaningfulDisplay(item.detail) ? (
                <p className={styles.postureDetail}>{display(item.detail)}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {meaningfulDisplay(notice) ? (
        <p className={styles.creativeFootnote} data-meta-exact-creatives-notice>
          {display(notice)}
        </p>
      ) : null}
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
              {meaningfulDisplay(group.note) ? (
                <span className={styles.creativeGroupNote}>
                  {display(group.note)}
                </span>
              ) : null}
            </header>
            {group.rows.map((row) => (
              <CreativeCard grouped key={row.id} row={row} />
            ))}
          </section>
        ))
      ) : (
        decisions.map((row) => <CreativeCard key={row.id} row={row} />)
      )}
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
            {display(conflict.currentStateLabel)}
          </dd>
        </div>
        <div>
          <dt>{copy.youTried}</dt>
          <dd data-meta-exact-conflict-attempted>
            {display(conflict.attemptedLabel)}
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
          {copy.keepMineReapplyAgainstVersion}
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
  if (!model) return null;

  const reason = (model.reasons ?? []).find(meaningfulDisplay);
  const hasTargetComparison = meaningfulDisplay(model.targetComparison);
  const hasMoneyDetail = meaningfulDisplay(model.moneyDetail);
  /*
   * A HELD VERDICT SUPPRESSES THE MUTATION CEREMONY, exactly as it suppresses
   * the queue row's served-action line.
   *
   * `manualAction` is the `gated:META-WRITE-01` sheet — a provider write. A
   * held verdict is served only with an UNAUTHORIZED label, so a panel
   * carrying one has, by definition, no authorized change to offer; letting
   * the sheet fall through as the panel's primary control would put an
   * execution affordance one click from a verdict authority refused.
   *
   * The evidence-review primary (`model.onPrimary`) is untouched: reading the
   * evidence is what a held row is for.
   */
  const isHeld = nonBlankDisplay(model.heldVerdictLabel);
  const manualAction =
    !isHeld &&
    model.manualAction &&
    !model.manualAction.refusalReason &&
    model.manualAction.onOpen
      ? model.manualAction
      : null;
  const primaryAction = model.onPrimary
    ? {
        label: model.actionLabel,
        onClick: model.onPrimary,
        tone: model.actionTone,
      }
    : manualAction
      ? {
          label: manualAction.label,
          onClick: manualAction.onOpen,
          tone: model.actionTone,
        }
      : null;
  const inspectorTone = toneClass(model.tone);
  const remediation = meaningfulDisplay(model.serverVerdict)
    ? model.serverVerdict
    : model.decisionLabel;

  return (
    <aside
      className={`${styles.inspector} ${inspectorTone}`}
      data-meta-exact-inspector
    >
      <div className={styles.inspectorHeader}>
        <span className={styles.inspectorEyebrow}>
          {language === "tr" ? "Karar ayrıntıları" : "Decision details"}
        </span>
        <span className={`${styles.inspectorDecision} ${inspectorTone}`}>
          {display(model.decisionLabel)}
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
          <p className={styles.inspectorEntity}>{display(model.entityName)}</p>
          {meaningfulDisplay(model.entityMeta) ? (
            <p className={styles.inspectorMeta}>{display(model.entityMeta)}</p>
          ) : null}
        </div>

        {/*
          The engine's withheld conclusion, drawn as its own block above the
          published remediation and never merged into it. It carries the held
          verdict's OWN next step, so the specific resolution survives the
          click that opened this panel.

          The badge is the queue row's `creativeStateBadge` with the same
          warning tone, so the operator recognises the same pill they clicked
          from; the card and copy classes are the panel's own. Both are
          borrowed rather than added because this round does not own the
          stylesheet. The label already reads "Held verdict: …", so no section
          heading is drawn above it.
        */}
        {nonBlankDisplay(model.heldVerdictLabel) ? (
          <div
            className={styles.contractCard}
            data-meta-exact-inspector-held-verdict
          >
            <span
              className={`${styles.creativeStateBadge} ${toneClass(model.heldVerdictTone)}`}
              data-meta-exact-inspector-held-verdict-label
            >
              {display(model.heldVerdictLabel)}
            </span>
            {meaningfulDisplay(model.heldVerdictNextStep) ? (
              <p
                className={styles.contractCopy}
                data-meta-exact-inspector-held-next-step
              >
                {display(model.heldVerdictNextStep)}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className={styles.contractCard}>
          <p className={styles.inspectorSectionLabel}>
            {language === "tr" ? "Ne yapılmalı" : "What to do"}
          </p>
          <p className={styles.contractCopy}>
            <b>{display(remediation)}</b>
          </p>
        </div>

        {reason ? (
          <div>
            <p className={styles.reasonHeading}>
              {language === "tr" ? "Neden" : "Why"}
            </p>
            <p className={styles.reasonRow}>
              <span />
              <span>{display(reason)}</span>
            </p>
          </div>
        ) : null}

        <div className={styles.moneyImpact}>
          <p className={styles.inspectorSectionLabel}>
            {language === "tr" ? "Temel metrikler" : "Key metrics"}
          </p>
          <p className={styles.inspectorMoneyValue}>
            {display(model.moneyValue)}
            {hasTargetComparison ? (
              <>
                {" "}
                <span>{display(model.targetComparison)}</span>
              </>
            ) : null}
          </p>
          {hasMoneyDetail ? (
            <p className={styles.inspectorMoneyDetail}>
              {display(model.moneyDetail)}
            </p>
          ) : null}
        </div>

        {meaningfulDisplay(model.confidence) ? (
          <div className={styles.inspectorMiniTiles}>
            <span
              className={`${styles.inspectorMiniTile} ${styles.confidenceTile}`}
            >
              <span className={styles.inspectorMiniLabel}>
                {copy.confidence}
              </span>
              <span className={styles.inspectorMiniValue}>
                {display(model.confidence)}
              </span>
            </span>
          </div>
        ) : null}

        {meaningfulDisplay(model.asOf) ||
        meaningfulDisplay(model.evidenceWindow) ? (
          <dl className={styles.evidenceProvenance}>
            {meaningfulDisplay(model.asOf) ? (
              <div>
                <dt>{copy.asOf}</dt>
                <dd data-el="asof-row">
                  {formatInspectorAsOf(model.asOf, language)}
                </dd>
              </div>
            ) : null}
            {meaningfulDisplay(model.evidenceWindow) ? (
              <div>
                <dt>{copy.evidenceWindow}</dt>
                <dd data-el="evidence-window">
                  {formatInspectorEvidenceWindow(
                    model.evidenceWindow,
                    language,
                  )}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {primaryAction ? (
          <button
            className={`${styles.inspectorPrimary} ${toneClass(primaryAction.tone)}`}
            onClick={primaryAction.onClick}
            type="button"
          >
            {meaningfulDisplay(primaryAction.label)
              ? display(primaryAction.label)
              : language === "tr"
                ? "İşlemi aç"
                : "Open action"}
          </button>
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
  const identityParts = [
    "Meta",
    meaningfulDisplay(identity?.accountLabel)
      ? display(identity?.accountLabel)
      : null,
    meaningfulDisplay(identity?.currency) ? display(identity?.currency) : null,
  ].filter((value): value is string => Boolean(value));
  const structureLaneItems = LANES.filter(
    (item) =>
      item.id === "action" ||
      item.id === "needsres" ||
      item.id === "watching" ||
      item.id === activeLane ||
      (item.id === "healthy" && positiveDisplayCount(counts?.healthy)),
  );
  // The reference opens the evidence rail beside the selected queue row. Each
  // decision-bearing structure lane now has a default selection, so switching
  // lanes keeps that same readable two-column resting state.
  const showInspector =
    inspectorOpen &&
    activeScope === "structure" &&
    (activeLane === "action" ||
      activeLane === "watching" ||
      activeLane === "needsres") &&
    viewModel.inspector != null;

  const creativeLaneItems = [
    {
      id: "action",
      label: copy.laneActionNow,
      count: viewModel.operatorSummary?.scopeCounts?.creatives?.action,
    },
    {
      id: "needsres",
      label: copy.laneNeedsResolution,
      count: viewModel.operatorSummary?.scopeCounts?.creatives?.needsResolution,
    },
    {
      id: "watching",
      label: copy.laneWatching,
      count: viewModel.operatorSummary?.scopeCounts?.creatives?.watching,
    },
  ] as const;
  const activeCreativeLane =
    activeLane === "action" ||
    activeLane === "needsres" ||
    activeLane === "watching"
      ? activeLane
      : "action";

  function selectScope(nextScope: MetaDecisionCenterExactScope) {
    if (scope === undefined) setInternalScope(nextScope);
    if (
      nextScope === "creatives" &&
      creativeGroupIdForLane(activeLane) === null
    ) {
      selectLane("action");
    }
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
          <p className={styles.pageEyebrow}>{identityParts.join(" · ")}</p>
          <h1>{copy.decisionCenter}</h1>
          {meaningfulDisplay(identity?.syncedLabel) ? (
            <p className={styles.asOfLine} data-meta-exact-source-identity>
              {language === "tr" ? "Güncellendi" : "Updated"}:{" "}
              {display(identity?.syncedLabel)}
            </p>
          ) : null}
        </div>
        {/* The 7d/14d/28d/90d pills are gone: the shell topbar picker already
            owns the window, and it offers a wider vocabulary than these four.
            Two controls for one value is also two WRITERS for one value —
            exactly the split the single date authority removed everywhere
            else. `activeWindow` stays: it is the window the payload was
            SERVED for, and the archive column header and the ROAS label
            still name it. */}
        <div className={styles.headerTools}>
          {onRunSnapshot ? (
            <button
              className={styles.snapshotButton}
              onClick={onRunSnapshot}
              type="button"
            >
              {language === "tr" ? "Kararları yenile" : "Refresh decisions"}
            </button>
          ) : null}
          {adsManagerHref ? (
            <a
              className={styles.snapshotButton}
              href={adsManagerHref}
              rel="noopener noreferrer"
              target="_blank"
            >
              {language === "tr" ? "Meta Ads'i aç" : "Open Meta Ads"}
            </a>
          ) : null}
        </div>
      </div>

      <ExactKpiBand
        kpis={viewModel.kpis}
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
            {copy.campaignsAndAdSets}
            {meaningfulDisplay(counts?.structure) ? (
              <span>{display(counts?.structure)}</span>
            ) : null}
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
            {meaningfulDisplay(counts?.creatives) ? (
              <span>{display(counts?.creatives)}</span>
            ) : null}
          </span>
        </span>
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
              const index = structureLaneItems.findIndex(
                (item) => item.id === activeLane,
              );
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
                structureLaneItems[
                  (index + step + structureLaneItems.length) %
                    structureLaneItems.length
                ]!.id,
              );
            }}
            role="radiogroup"
          >
            {structureLaneItems.map((item) => (
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
                {meaningfulDisplay(counts?.[item.id]) ? (
                  <span>{display(counts?.[item.id])}</span>
                ) : null}
              </button>
            ))}
          </span>
          {positiveDisplayCount(counts?.deferred) ? (
            <span className={styles.deferredPill}>
              {copy.deferred} {display(counts?.deferred)}
            </span>
          ) : null}
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
         * Sort does NOT come along: it is applied to structure rows only. The
         * three decision-bearing lane controls DO come along because the
         * server also groups creatives as Act, Blocked and Monitor. Without
         * these controls, a lane retained while switching scopes became an
         * invisible filter with no way to reach the other creative groups.
         */
        <div className={styles.laneToolbar} data-meta-exact-creative-toolbar>
          <span
            aria-label={`${copy.decisionLanes} · ${copy.creatives}`}
            className={styles.laneGroup}
            data-meta-exact-creative-lane-toolbar
            onKeyDown={(event) => {
              const index = creativeLaneItems.findIndex(
                (item) => item.id === activeCreativeLane,
              );
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
                creativeLaneItems[
                  (index + step + creativeLaneItems.length) %
                    creativeLaneItems.length
                ]!.id,
              );
            }}
            role="radiogroup"
          >
            {creativeLaneItems.map((item) => (
              <button
                aria-checked={activeCreativeLane === item.id}
                className={`${styles.laneOption} ${
                  activeCreativeLane === item.id ? styles.laneOptionActive : ""
                }`}
                data-meta-exact-creative-lane={item.id}
                key={item.id}
                onClick={() => selectLane(item.id)}
                role="radio"
                tabIndex={activeCreativeLane === item.id ? 0 : -1}
                type="button"
              >
                {item.label}
                {meaningfulDisplay(item.count) ? (
                  <span>{display(item.count)}</span>
                ) : null}
              </button>
            ))}
          </span>
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
              lane={activeCreativeLane}
              notice={viewModel.creativesNotice}
              onOpenCreativeStudio={onOpenCreativeStudio}
              posture={viewModel.creativePosture ?? []}
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
    </section>
  );
}
