import { existsSync, readdirSync, readFileSync } from "node:fs";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildMetaDecisionCenterExactViewModel,
  buildMetaStructureInventoryViewModel,
} from "./meta-decision-center-exact-adapter";
import {
  buildProbePayload,
  servedFieldWalk,
  type ProbeScenario,
  type ServedField,
} from "./served-field-probe";
import {
  buildCreativeEvidenceWindowExactViewModel,
  type CreativeEvidenceWindowExactAdRow,
  type CreativeEvidenceWindowExactSeriesPayload,
} from "@/components/creatives/creative-evidence-window-exact-adapter";
import type { MetaOsAdDecision } from "@/lib/meta/decisions-os-contract";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { MetaDecisionCenterExactViewModel } from "./MetaDecisionCenterExact";
import { MetaPlatformPage } from "@/components/meta/redesign/MetaPlatformPage";
import type {
  MetaDecisionsWorkspacePayload,
  MetaStructureInventoryEntity,
} from "@/components/meta/redesign/types";

/**
 * THE SERVED-FIELD COVERAGE MATRIX FOR THE META DECISION PAGE.
 *
 * WHY THIS IS A TEST AND NOT A DOCUMENT. A document that lists which served
 * fields reach the screen is correct on the day it is written and wrong on the
 * next commit, and nothing tells anyone. This file enumerates the Decision
 * payload's fields FROM THE CONTRACT SOURCE with the TypeScript parser, and
 * fails when a field has no classification. Adding a field to the workspace
 * contract, the OS presentation, the canonical read model or the structure
 * inventory therefore breaks this test until someone states, in writing, what
 * the Decision page does with it.
 *
 * THE THREE ANSWERS, and only these three:
 *
 *   RENDERED                   - the field reaches the operator today. The
 *                                entry names the surface and the element.
 *   WIRED-NOW                  - a wiring lane in THIS round changed
 *                                production code to put it on screen and said
 *                                so in its handoff. Same naming rule.
 *   INTENTIONALLY-NOT-RENDERED - a stated choice, with a reason a reader can
 *                                go and check. "A diagnostic key an operator
 *                                cannot act on does not belong on a decision
 *                                card" is a legitimate answer; silence is not.
 *
 * RENDERED AND WIRED-NOW ARE PROVEN IDENTICALLY. The split is a record of what
 * this round changed, not a difference in strength, and it is deliberately
 * NOT "the field is younger than the deployed release" — almost every surface
 * this matrix names is younger than that, so such a rule would put two hundred
 * entries under WIRED-NOW and tell a reader nothing.
 *
 * WHAT COUNTS AS "THE DECISION PAGE". Three surfaces, and no others:
 * `MetaDecisionCenterExact` through `meta-decision-center-exact-adapter.ts`,
 * the `MetaPlatformPage` chrome around it (banners, header, account inventory,
 * the mobile screens), and `CreativeEvidenceWindowExact` through
 * `creative-evidence-window-exact-adapter.ts`. A field rendered ONLY on
 * Creative Studio, Meta History, Commercial Truth or Overview is
 * not rendered here, and where that is the reason for withholding it, the
 * entry says which surface owns it instead.
 *
 * AND THE ANSWER IS PROVEN, NOT ASSERTED. A "RENDERED" entry naming a surface
 * used to be checked against a list of sixteen surface names and nothing else,
 * so a field marked rendered at a surface that never reads it passed exactly
 * as loudly as one the operator can see. The second half of this file builds
 * the whole payload from the contract source, runs the real adapters and the
 * real page over it, and repeats the run with that ONE field carrying a
 * different value: a RENDERED claim holds only if the NAMED surface's output
 * moves, and a withholding holds only if NO surface's output moves. Every
 * claim the running code refuses to support is named in `UNPROVEN_CLAIMS` or
 * `CONTRADICTED_WITHHOLDINGS` rather than quietly re-classified.
 *
 * AND WHERE THE CODE ALLOWS IT, THE ELEMENT IS PROVEN TOO. Naming a surface is
 * a weaker claim than these notes make: an entry could name the right panel and
 * the wrong line on it and the surface-level probe would not notice — which is
 * exactly what happened to `MetaOsAdDecision.resolution.code`, whose note said
 * "the 'Served resolution' line" for a value that is printed on a diagnostics
 * row instead. Three of the surfaces emit rows carrying a STABLE ID next to
 * their label (`facts`, `authority`, `diagnostics`, the provenance groups), so
 * an entry that names such a row states its id in `element` and is proven by
 * THAT ROW's value moving. Entries whose element has no id — a chip, a tone, a
 * money sub-line, anything on the two surfaces observed as HTML — keep the
 * surface-level proof and carry no `element`, and the test named "states which
 * claims carry element-level proof" reports the split out loud so a reader
 * knows the strength of each claim instead of assuming they are equal.
 *
 * AND "REACHES A SURFACE" MEANS THE VIEW MODEL, NOT THE OPERATOR'S EYE. This
 * has been true since the file was written and was never said. Fourteen of the
 * sixteen surfaces are SERIALISED VIEW MODELS; only BANNERS and MOBILE are
 * observed as rendered HTML. So every count and every claim in this file means
 * "reaches the view model that feeds a panel", which is WEAKER than "an
 * operator can see it". The gap is real and it is demonstrated rather than
 * conceded: `MetaArchivedEntity.name` moves the ARCHIVE view model and does
 * NOT move the page's rendered DOM in the default scope, because the Archive
 * lane sits behind a lane tab. The weaker proof is still the right default —
 * a panel one tab press away is rendering, and a file that counted only the
 * default render would call the Archive lane, the Watching lane, the inspector
 * and the evidence window unrendered, which is false in a more damaging
 * direction — so BOTH are measured: the desktop Decision Centre is now
 * rendered to HTML from the real component as well, which puts four whole
 * surfaces (the identity header, the KPI strip, the scope/lane/window pills
 * and the Action Now rows — 45 claims) on rendered-HTML proof, and the split
 * is pinned per surface. @see DOM_PROOF_BY_SURFACE
 *
 * AND THE FILE'S OWN LARGEST NUMBER IS WRITTEN DOWN. Most served leaves reach
 * no surface at all, and until this round that count was never stated, so
 * nobody could check it and nobody could notice what it was measuring instead
 * — a fixture that opened the evidence window with an EMPTY ad-grain read and
 * rendered the page in half the scenarios would have counted a leaf as absent
 * for reasons that belong to the probe rather than to the product. Both
 * shortcuts were measured and removed, the count is pinned, and the test that
 * pins it says in full what the number is and is not. @see NOWHERE_LEAVES
 *
 * WHAT THIS MATRIX IS NOT. It is not a claim that every RENDERED field is
 * REACHABLE. The evidence window's fields are rendered by code that a real
 * account currently cannot reach by clicking, because the queue only offers
 * the affordance to rows that arrived with a canonical envelope. That is a
 * separate, tracked defect about the affordance, not about coverage, and
 * pretending otherwise here would hide one problem inside another.
 */

type Classification = "RENDERED" | "WIRED-NOW" | "INTENTIONALLY-NOT-RENDERED";

interface Coverage {
  readonly classification: Classification;
  /** Named surface for RENDERED / WIRED-NOW; empty for the third answer. */
  readonly where: string;
  /** The element or the reason, in one sentence. */
  readonly note: string;
  /**
   * The stable id of the labelled row the note names, when the named surface
   * emits one.
   *
   * Present means the claim is proven AT THE ELEMENT: the probe compares that
   * row's own serialised value, not the whole surface, so naming the right
   * panel and the wrong line on it fails. Absent means the claim rests on the
   * surface alone — the element is a chip, a tone, a sub-line or a rendered
   * HTML fragment with no id to key on — and the reader is told so rather than
   * left to assume every entry is equally strong.
   */
  readonly element?: string;
}

/**
 * The surfaces a RENDERED claim may name. A free-text "where" would let
 * "somewhere in the app" pass for an answer; this list is the vocabulary, and
 * every one of these is a place a reader can open and look at.
 *
 * FOURTEEN OF THESE SIXTEEN ARE VIEW MODELS, NOT PIXELS. Only BANNERS and
 * MOBILE are observed as rendered HTML; the other fourteen are the serialised
 * output of the adapters that feed a panel. Naming one of them therefore
 * claims "this field reaches the view model that feeds that panel", which is
 * weaker than "an operator can see it" — the panel may sit behind a lane tab,
 * a scope tab, a row selection or a window that has to be opened. The distance
 * is measured, not assumed. @see DOM_PROOF_BY_SURFACE
 */
const S = {
  HEADER: "decision center · identity header",
  KPI: "decision center · KPI strip",
  PILLS: "decision center · scope, lane and window pills",
  ACTION: "decision center · Action Now and Watching rows",
  WATCHING: "decision center · Watching lane",
  HEALTHY: "decision center · Healthy groups",
  NONSALES: "decision center · Non-sales card",
  ARCHIVE: "decision center · Archive lane",
  CREATIVES: "decision center · Creatives queue",
  POSTURE: "decision center · creative posture band",
  INSPECTOR: "decision center · evidence inspector",
  PROVENANCE: "decision center · source provenance panel",
  INVENTORY: "page · account inventory table",
  BANNERS: "page · workspace posture banners",
  MOBILE: "page · mobile posture panels",
  EVIDENCE: "page · creative evidence window",
  COVERAGE: "decision center · assigned-account coverage strip",
} as const;

const SURFACES: ReadonlySet<string> = new Set(Object.values(S));

function R(where: string, note: string, element?: string): Coverage {
  return { classification: "RENDERED", where, note, element };
}

/** Rendered for the first time in this round's wiring pass. */
function W(where: string, note: string, element?: string): Coverage {
  return { classification: "WIRED-NOW", where, note, element };
}

function N(note: string): Coverage {
  return { classification: "INTENTIONALLY-NOT-RENDERED", where: "", note };
}

/**
 * The canonical resolution is the SERVED resolution, forwarded verbatim.
 *
 * `lib/meta/decisions-os-presentation.ts:1126` writes
 * `resolution: decision.classification.resolution` — this object, under the
 * name `MetaOsAdDecision.resolution`, which the evidence window's "Served
 * resolution" line and its diagnostics row both print. The only second writer
 * (presentation:~1220) SYNTHESISES a resolution for a pending-inventory ad that
 * has no canonical decision at all, so there is no canonical resolution for a
 * second block to disagree with — a second heading would print em dashes beside
 * a populated line and read as two producers contradicting each other where one
 * produced nothing. A fabricated disagreement is the same class of defect as a
 * fabricated measurement.
 *
 * This is NOT a wiring gap laundered into a choice: the operator CAN see these
 * five values, through the forward. The equivalence is pinned by
 * meta-decision-center-exact-adapter.test.ts > "the canonical resolution is the
 * served resolution", which counts the two writers and fails on a third.
 */
const RESOLUTION_IS_FORWARDED =
  "The canonical MetaDecisionResolution IS MetaOsAdDecision.resolution: decisions-os-presentation.ts:1126 forwards this object verbatim, and the evidence window prints it on the 'Served resolution' line and the 'served resolution code' diagnostics row. The only other writer synthesises a resolution for a pending-inventory ad that has NO canonical decision, so a second block under a second label could only print em dashes beside a populated line and read as a producer disagreement that cannot exist. Pinned by meta-decision-center-exact-adapter.test.ts > 'the canonical resolution is the served resolution'.";

/**
 * The section cap's receipt, and the exact reads of `queue.sections` behind it.
 *
 * The claim underneath this withholding is that no section SELECTS or ORDERS
 * anything on this screen, so the receipt for a section's own cut is an audit
 * identity for a list nobody is looking at. That claim is about the reads, and
 * the reads are counted by the test named "counts every read of queue.sections
 * on the Decision page" rather than asserted here in prose.
 */
const SECTION_RECEIPT_IS_NOT_DRAWN =
  "The receipt is the audit identity of a top-N cap on the compact three-section queue, which this surface does not draw: queue.sections is read in exactly three places across the Decision page, and none of them selects or orders a row - the adapter's canonical lookup union (meta-decision-center-exact-adapter.ts, defaultCanonicalDecisions), the page's own copy of that union (MetaPlatformPage.tsx, canonicalDecisionEnvelopes), and sectionCapFacts, which reads each section's suppressionReceipt and nothing else. The one field of this envelope that does reach the screen is suppressedCount, on the source panel.";

/**
 * THE FOUR PACING LEAVES, AND THE WITHHOLDING REASON THAT WAS SIMPLY FALSE.
 *
 * WHAT THE ENTRIES USED TO SAY. "Month-to-date pacing is the Overview
 * surface's subject." That named another screen, and a reason that names
 * another screen is worth exactly what that screen's existence is worth. The
 * screen exists — `app/(dashboard)/overview/legacy-page.tsx` really does draw
 * Spend, Revenue, ROAS and CPA with a previous-period comparison — but
 * month-to-date pacing is NOT on it: `grep -riE 'month.to.date|mtd|pacing'`
 * over `app/(dashboard)/overview` and `app/api/overview` returns nothing at
 * all. The withholding was defensible; the sentence under it was not true.
 *
 * WHAT IS TRUE, AND IT IS A STRONGER REASON THAN THE ONE IT REPLACES. Three of
 * these four are not measurements of anything the operator set:
 *
 *   mtdTarget   = Math.max(spend, spend / dayOfMonth * 30)   route.ts:775
 *   dayPace     = spend / mtdTarget                          route.ts:819
 *   dailyTarget = mtdTarget / 30                             route.ts:822
 *
 * `mtdTarget` is the account's own month-to-date spend extrapolated in a
 * straight line to the end of the month. No budget, no commercial truth, no
 * operator input enters it. Drawing it beside the word "target" would state a
 * claim the server never made — the same defect this round fixed on the ROAS
 * tile, where a MEASURED account median was about to be printed under the
 * target's noun, one noun over.
 *
 * `dayPace` is worse than derived, it is degenerate: substitute the line above
 * and it collapses to `dayOfMonth / 30` on every day before the 30th, and to
 * 1 on the 30th and 31st. It cannot distinguish an account overspending from
 * one that has stopped; it reports the calendar. That is proven by arithmetic
 * in the test below, not asserted here.
 *
 * `mtdSpend` is the one real measurement of the four, and it is withheld for a
 * different reason: nothing on this page is stated per calendar month. Every
 * lane, pill and tile is scoped to the selected window or to today. It is not
 * being deferred to a surface that owns it, because there is none — the test
 * below walks the repo and pins the complete set of files that name these four
 * fields at all.
 *
 * THE HONESTY LAW THIS SERVES. A derived extrapolation rendered under the word
 * "target" is a fabricated value rendered as a measurement. Withholding it is
 * not a coverage gap; wiring it would be the defect.
 */
/**
 * Every non-test `.ts`/`.tsx` under `app`, `components` or `lib` that names any
 * of the four pacing fields, and what it does with it.
 *
 * NOT ONE OF THEM RENDERS. That is the whole content of the withholding, and
 * it is a fact about the repository rather than about another screen, so it is
 * asserted by walking the repository. `lib/meta/entity-signals-backfill.ts` is
 * listed because the string matches, not because the field does: its `mtdSpend`
 * is a LOCAL const summed from its own rows on the way to a `mtd_spend` signal
 * column, and it never touches `MetaPulsePayload.pacing`. Naming it here is the
 * honest version of "the grep found four files"; leaving it out would make the
 * pin agree with the claim by hiding the inconvenient hit.
 */
const PACING_FIELD_MENTIONS: Record<string, string> = {
  "app/api/meta/account-pulse/route.ts":
    "produces all four (:775 the extrapolation, :817-822 the served object)",
  "app/api/meta/decisions-workspace/route.ts":
    "D071 names `pacing.mtdSpend` and `pacing.dayPace` in prose only, to state why a confirmed demo workspace is refused with 503 instead of served: they are non-nullable numbers with no unavailable representation, so emitting zeros would turn source absence into a measured value. It renders nothing and computes nothing - naming the fields is how the refusal stays auditable",
  "components/meta/redesign/types.ts":
    "declares them on MetaPulsePayload.pacing",
  "components/meta/redesign/test-fixtures.ts":
    "a shared test fixture's pacing block; a fixture is not a render",
  "lib/meta/entity-signals-backfill.ts":
    "a local `mtdSpend` const of its own rows, written to a mtd_spend signal column - a different symbol that happens to share a name",
};

/**
 * EVERY OTHER SCREEN A WITHHOLDING NAMES, AND THE FILE THAT PROVES IT DOES THE
 * THING THE NOTE CREDITS IT WITH.
 *
 * "This belongs to the X surface" is the most inviting sentence in the table
 * and the easiest one to get away with: it sounds like a decision and it costs
 * nothing to write. It is worth exactly what that screen's existence is worth,
 * and one of them was worth nothing — the four pacing leaves were withheld
 * because "month-to-date pacing is the Overview surface's subject", and
 * Overview draws no month-to-date pacing at all.
 *
 * So every remaining screen-name is pinned to a file and to a string in that
 * file which is the CAPABILITY the note names, not merely the screen's
 * existence. Overview is credited with a period-over-period comparison of
 * account totals, so the pin is its compare mode; Meta History is credited
 * with rendering event rows, so the pin is its journal row's own heading.
 * @see the test that reads this
 */
const OTHER_SCREENS_NAMED: Record<
  string,
  { readonly file: string; readonly proves: string }
> = {
  Overview: {
    file: "app/(dashboard)/overview/legacy-page.tsx",
    proves: 'type CompareMode = "none" | "previous_period";',
  },
  Reports: {
    file: "components/reports/reports-exact-container.tsx",
    proves: 'compareMode === "previous_period"',
  },
  "Commercial Truth": {
    file: "components/commercial-truth/CommercialTruthScreen.tsx",
    proves: "breakEvenRoas",
  },
  "Meta History": {
    file: "app/(dashboard)/platforms/meta/history/history-view.tsx",
    proves: "<span>Entity and event</span>",
  },
  "Creative Studio": {
    file: "components/creatives/briefing/action-authority.ts",
    proves: "classification.buyerAction",
  },
};

const PACING_IS_EXTRAPOLATED_FROM_SPEND = [
  "MetaPulsePayload.pacing.mtdSpend",
  "MetaPulsePayload.pacing.mtdTarget",
  "MetaPulsePayload.pacing.dayPace",
  "MetaPulsePayload.pacing.dailyTarget",
] as const;

const COVERAGE: Record<string, Coverage> = {
  // D078 R4: the account-coverage strip. A deselected-but-spending assigned
  // identity is an explicit fact on this screen; the strip is display-only
  // and grants nothing.
  "MetaAssignedAccountStateSummary.providerAccountId": R(
    S.COVERAGE,
    "each account chip's id and data-account-coverage-id",
  ),
  "MetaAssignedAccountStateSummary.accountName": R(
    S.COVERAGE,
    "each account chip's name prefix",
  ),
  "MetaAssignedAccountStateSummary.selectionState": R(
    S.COVERAGE,
    "the 'selected · serving' / 'deselected · read-only history' wording and data-account-selection-state",
  ),
  "MetaAssignedAccountStateSummary.accountCurrency": R(
    S.COVERAGE,
    "the visible 'currency <code>' fact and the spend suffix",
  ),
  "MetaAssignedAccountStateSummary.accountTimezone": R(
    S.COVERAGE,
    "the visible 'timezone <tz>' fact on each account row",
  ),
  "MetaAssignedAccountStateSummary.latestDecisionAuthorizedRows": R(
    S.COVERAGE,
    "the '(<n> authorized)' suffix on the decision-rows fact",
  ),
  "MetaAssignedAccountStateSummary.latestFactDate": R(
    S.COVERAGE,
    "the 'facts to <date>' suffix",
  ),
  "MetaAssignedAccountStateSummary.spend14d": R(
    S.COVERAGE,
    "the 'spend 14d <amount>' suffix",
  ),
  "MetaAssignedAccountStateSummary.latestDecisionAsOf": R(
    S.COVERAGE,
    "inside the chip's title/policy line (server-composed sentence)",
  ),
  "MetaAssignedAccountStateSummary.latestDecisionRows": R(
    S.COVERAGE,
    "the '<n> produced decisions unserved' suffix on deselected chips",
  ),
  "MetaAssignedAccountStateSummary.policy": R(
    S.COVERAGE,
    "each chip's title attribute (hover) — the operator policy sentence",
  ),
  "MetaDecisionsWorkspacePayload.readState": N(
    "Not rendered BY THIS BODY, and deliberately so: the Decision Center forwards the §9 envelope to the surface-state region the canonical page mounts beside it (components/meta/meta-surface-state-live.tsx), which prints the state, the operator sentence and the failure code. Rendering it here as well would put two statements about the same read on one screen, and the body would then need its own opinion about which is current.",
  ),
  "MetaDecisionsWorkspacePayload.businessId": N(
    "The payload echoes back the business it was requested for; the shell's business switcher is what names the account, and a second copy on screen could only agree or be wrong.",
  ),
  "MetaDecisionsWorkspacePayload.window": R(
    S.PILLS,
    "the active window pill, and the ROAS tile's window label",
  ),
  "MetaDecisionsWorkspacePayload.statusFilter": N(
    "The request's own status filter echoed back; what the screen states is the lane counts that filter produced, not the filter.",
  ),
  "MetaDecisionsWorkspacePayload.startDate": N(
    "A range echo of the request: the date-window control renders the URL's own range (resolveDateWindowFromParams), so a second copy could disagree with the control the operator set.",
  ),
  "MetaDecisionsWorkspacePayload.endDate": W(
    S.KPI,
    "the Spend tile's exact as-of date, so a stale or historical range is never mislabeled as today",
  ),
  "MetaDecisionsWorkspacePayload.queue.groups[].key": N(
    "A five-group summary that restates lanes.counts, which the lane pills already render; two counts of one population on one screen can disagree, and only one of them can be right.",
  ),
  "MetaDecisionsWorkspacePayload.queue.groups[].label": N(
    "A five-group summary that restates lanes.counts, which the lane pills already render; two counts of one population on one screen can disagree, and only one of them can be right.",
  ),
  "MetaDecisionsWorkspacePayload.queue.groups[].count": N(
    "A five-group summary that restates lanes.counts, which the lane pills already render; two counts of one population on one screen can disagree, and only one of them can be right.",
  ),
  "MetaDecisionsWorkspacePayload.queue.actionStates.executablePause": N(
    "A tally of action KINDS inside Action Now; every row already states its own served action label, and a per-kind total the operator cannot click adds no decision. It would belong in the source panel's coverage group.",
  ),
  "MetaDecisionsWorkspacePayload.queue.actionStates.executableBid": N(
    "A tally of action KINDS inside Action Now; every row already states its own served action label, and a per-kind total the operator cannot click adds no decision. It would belong in the source panel's coverage group.",
  ),
  "MetaDecisionsWorkspacePayload.queue.actionStates.executableResume": N(
    "A tally of action KINDS inside Action Now; every row already states its own served action label, and a per-kind total the operator cannot click adds no decision. It would belong in the source panel's coverage group.",
  ),
  "MetaDecisionsWorkspacePayload.queue.actionStates.launchpadRoutes": N(
    "A tally of action KINDS inside Action Now; every row already states its own served action label, and a per-kind total the operator cannot click adds no decision. It would belong in the source panel's coverage group.",
  ),
  "MetaDecisionsWorkspacePayload.queue.actionStates.reviewOnly": N(
    "A tally of action KINDS inside Action Now; every row already states its own served action label, and a per-kind total the operator cannot click adds no decision. It would belong in the source panel's coverage group.",
  ),
  "MetaDecisionsWorkspacePayload.queue.actionStates.missingActionKind": N(
    "A tally of action KINDS inside Action Now; every row already states its own served action label, and a per-kind total the operator cannot click adds no decision. It would belong in the source panel's coverage group.",
  ),
  // The server-owned commercial spend-unit anchor. Every leaf is copied into
  // the source-provenance panel's "Commercial anchor" group by
  // meta-decision-center-exact-adapter.commercialAnchorFacts; the client
  // derives none of it.
  "MetaCommercialAnchorPanel.contractVersion": N(
    "The panel's own contract version. The screen prints the anchor, not the version of the envelope that carried it; the version exists so a stale client can refuse the payload, which is not a rendering job.",
  ),
  "MetaCommercialAnchorPanel.status": R(
    S.PROVENANCE,
    "the Commercial anchor group's first row, and the tone that marks it as withholding",
    "anchor-status",
  ),
  "MetaCommercialAnchorPanel.currency": R(
    S.PROVENANCE,
    "the currency every anchor money value in the group is formatted in; never defaulted to USD",
    "anchor-currency",
  ),
  "MetaCommercialAnchorPanel.withheld.profileHardActionEvidence": R(
    S.PROVENANCE,
    "the Withheld · profile hard-action evidence count. Deliberately generic: the persisted `profile_hard_action_ineligible` family also covers scale calibration, so naming a commercial-threshold cause here would assert a sub-cause the row does not record",
    "anchor-withheld-profile-evidence",
  ),
  "MetaCommercialAnchorPanel.withheld.campaignContext": R(
    S.PROVENANCE,
    "the Withheld · campaign role unresolved count, which separates the independent gate from the anchor",
    "anchor-withheld-campaign-context",
  ),
  "MetaCommercialAnchorPanel.withheld.recentRecoveryUnverifiable": R(
    S.PROVENANCE,
    "the Withheld · recovery unverifiable count",
    "anchor-withheld-recovery",
  ),
  "MetaCommercialAnchorPanel.withheld.total": N(
    "The sum of the four withholding counts, three of which are already rows in the same group. A total the operator can add up from the rows above it invites a reader to look for the difference.",
  ),
  "MetaCommercialAnchorPanel.withheld.other": N(
    "A catch-all for an authority blocker this contract does not name. It is zero for every blocker the engine currently emits; a row that is always zero teaches an operator to ignore the group.",
  ),
  // The canonical commercial-anchor explanation, copied verbatim from
  // AccountDecisionProfile.hardActionEligibility and rendered by
  // meta-decision-center-exact-adapter.commercialAnchorFacts. The client
  // derives none of it.
  "MetaCommercialAnchorPanel.unavailableReason": R(
    S.PROVENANCE,
    "the 'Unavailable because' row, shown when the canonical profile could not be served",
    "anchor-unavailable-reason",
  ),
  "CommercialAnchorExplanation.contractVersion": N(
    "The explanation's own contract version. The screen prints the anchor, not the version of the envelope that carried it; the version exists so a stale client can refuse the payload.",
  ),
  "CommercialAnchorExplanation.status": R(
    S.PROVENANCE,
    "the Commercial anchor row: the engine's own resolved status",
    "anchor-status",
  ),
  "CommercialAnchorExplanation.thresholdEligible": R(
    S.PROVENANCE,
    "the tone of the Commercial anchor row: warning while the threshold gate is unsatisfied",
    "anchor-status",
  ),
  "CommercialAnchorExplanation.spendUnit": R(
    S.PROVENANCE,
    "the resolved hard-action spend unit, formatted in the business currency",
    "anchor-spend-unit",
  ),
  "CommercialAnchorExplanation.spendUnitSource": R(
    S.PROVENANCE,
    "the Spend unit source row — the engine's actual rung, including meta_derived_aov and account_history",
    "anchor-source",
  ),
  "CommercialAnchorExplanation.spendUnitConfidence": R(
    S.PROVENANCE,
    "the Spend unit confidence row, warning-toned below medium",
    "anchor-confidence",
  ),
  "CommercialAnchorExplanation.currency": N(
    "The explanation's own currency slot. The panel attaches the business/account currency it knows and the adapter renders that one; printing two currency facts for one screen would be ambiguous.",
  ),
  "CommercialAnchorExplanation.targetPackFreshness": R(
    S.PROVENANCE,
    "the Target provenance row, warning-toned when the timestamp is unverifiable",
    "anchor-freshness",
  ),
  "CommercialAnchorExplanation.targetPackUpdatedAt": R(
    S.PROVENANCE,
    "the timestamp appended to the Target provenance row",
    "anchor-freshness",
  ),
  "CommercialAnchorExplanation.metaAovQuality": R(
    S.PROVENANCE,
    "the sample-quality suffix on the Sampled Meta AOV row",
    "anchor-meta-aov",
  ),
  "CommercialAnchorExplanation.missingInputs": R(
    S.PROVENANCE,
    "the Missing inputs row, which is the actionable half of the panel",
    "anchor-missing-inputs",
  ),
  "CommercialAnchorLineage.targetCpa": R(
    S.PROVENANCE,
    "the Target CPA lineage row",
    "anchor-target-cpa",
  ),
  "CommercialAnchorLineage.operatorAovAssumption": R(
    S.PROVENANCE,
    "the AOV assumption lineage row",
    "anchor-aov",
  ),
  "CommercialAnchorLineage.targetRoas": R(
    S.PROVENANCE,
    "the Target ROAS lineage row",
    "anchor-target-roas",
  ),
  "CommercialAnchorLineage.breakEvenRoas": R(
    S.PROVENANCE,
    "the Break-even ROAS lineage row",
    "anchor-break-even-roas",
  ),
  "CommercialAnchorLineage.metaAttributedAovMean90d": R(
    S.PROVENANCE,
    "the Sampled Meta AOV row's amount",
    "anchor-meta-aov",
  ),
  "CommercialAnchorLineage.metaAttributedAovPurchaseCount90d": R(
    S.PROVENANCE,
    "the purchase count behind the Sampled Meta AOV row",
    "anchor-meta-aov",
  ),
  "CommercialAnchorLineage.attributionAovAdjustmentMultiplier": R(
    S.PROVENANCE,
    "the Attribution AOV adjustment row, which scales the Meta-derived spend unit",
    "anchor-attribution-adjustment",
  ),
  "CommercialAnchorLineage.accountCpaP50": R(
    S.PROVENANCE,
    "the Account CPA p50 row, labelled as history and explicitly not an operator target",
    "anchor-account-cpa-p50",
  ),
  "CommercialAnchorLineage.accountCpaSampleCount": R(
    S.PROVENANCE,
    "the sample size printed beside the account CPA p50",
    "anchor-account-cpa-p50",
  ),
  "CommercialAnchorActionExplanation.eligible": N(
    "The canonical anchor's own per-action verdict. The screen shows the profile's EFFECTIVE verdict (MetaCommercialAnchorActionRow.eligible), which the Cut-only stop-loss overlay can widen; showing both would contradict itself on one row.",
  ),
  "CommercialAnchorActionExplanation.blockerCode": N(
    "Same reason as the sibling `eligible`: the effective code on the action row is the one the surface renders.",
  ),
  "CommercialAnchorActionExplanation.operatorCopy": N(
    "The canonical anchor's own copy. The surface renders the EFFECTIVE row's copy (MetaCommercialAnchorActionRow.operatorCopy), which the projection sources from here for a withheld action; rendering both would print the same sentence twice.",
  ),
  "MetaCommercialAnchorActionRow.action": R(
    S.PROVENANCE,
    "the Scale / Cut / Refresh row label",
    "anchor-action-scale",
  ),
  "MetaCommercialAnchorActionRow.eligible": R(
    S.PROVENANCE,
    "whether that action reads 'eligible' or 'withheld'",
    "anchor-action-scale",
  ),
  "MetaCommercialAnchorActionRow.blockerCode": R(
    S.PROVENANCE,
    "the stable code printed beside the verdict on the action row",
    "anchor-action-scale",
  ),
  "MetaCommercialAnchorActionRow.operatorCopy": R(
    S.PROVENANCE,
    "the action's own next-step row",
    "anchor-action-scale-copy",
  ),
  "MetaDecisionsWorkspacePayload.system.trackingBlocked": R(
    S.BANNERS,
    "the server-authoritative tracking safety gate used by the desktop and mobile warning surfaces",
  ),
  "MetaDecisionsWorkspacePayload.system.laneSnapshotDate": N(
    "The header prints ONE snapshot identity - decisionReadModel.source.snapshotAsOf, falling back to lanes.snapshotDate - and a second snapshot date beside it would read as a second snapshot.",
  ),
  "MetaDecisionsWorkspacePayload.system.laneSnapshotCreatedAt": N(
    "The engine write time of the lane rows; the header states the read model's own computed-at, and two write times for one run cannot both be the one that matters.",
  ),
  "MetaDecisionsWorkspacePayload.system.engineVersion": R(
    S.HEADER,
    "the engine label's last fallback, after the read model and the OS presentation",
  ),
  "MetaDecisionsWorkspacePayload.system.currency": R(
    S.HEADER,
    "the identity currency chip, and the currency every money value on the screen is formatted in",
  ),
  "MetaDecisionsWorkspacePayload.system.killSwitchEngaged": R(
    S.BANNERS,
    "the kill-switch banner, and the mobile viewer-authority panel",
  ),
  "MetaDecisionsWorkspacePayload.system.killSwitchReason": R(
    S.BANNERS,
    "the kill-switch banner's detail, and the mobile viewer-authority panel",
  ),
  "MetaDecisionsWorkspacePayload.system.governanceVerified": N(
    "The workspace route already converts this server fact into the blocking execution-governance banner and row-level executionReadiness. Rendering the raw boolean beside those conclusions would duplicate the same gate without adding an operator action.",
  ),
  "MetaDecisionsWorkspacePayload.system.businessControlsConfigured": N(
    "The workspace route already converts this server fact into the blocking execution-governance banner and row-level executionReadiness. Rendering the raw boolean beside those conclusions would duplicate the same gate without adding an operator action.",
  ),
  "MetaDecisionsWorkspacePayload.system.executionGovernanceState": N(
    "The server-authored banner and each exact row's executionReadiness are the operator-facing projections of this summary enum; a third rendering would give one gate two competing labels.",
  ),
  "MetaDecisionsWorkspacePayload.system.executionGovernanceReason": N(
    "The server-authored execution-governance banner already states this reason in actionable prose; the raw code remains a response diagnostic rather than a second banner line.",
  ),
  "MetaDecisionPipelineOperationalHealth.contractVersion": W(
    S.PROVENANCE,
    "the pipeline contract row on both source-provenance scopes",
    "pipeline-contract",
  ),
  "MetaDecisionPipelineOperationalHealth.evaluatedAt": W(
    S.PROVENANCE,
    "the pipeline evaluation timestamp row",
    "pipeline-evaluated",
  ),
  "MetaDecisionPipelineOperationalHealth.overall": W(
    S.PROVENANCE,
    "the decision-pipeline health row and provenance tone",
    "pipeline-health",
  ),
  "MetaDecisionPipelineOperationalHealth.executionReady": W(
    S.PROVENANCE,
    "the explicit pipeline execution-readiness row",
    "pipeline-execution-ready",
  ),
  "MetaDecisionPipelineOperationalHealth.blockers": W(
    S.PROVENANCE,
    "the complete server blocker-code row",
    "pipeline-blockers",
  ),
  "MetaDecisionPipelineOperationalHealth.syncActivity.status": W(
    S.PROVENANCE,
    "the durable sync-activity status row",
    "pipeline-sync-status",
  ),
  "MetaDecisionPipelineOperationalHealth.syncActivity.latestAt": W(
    S.PROVENANCE,
    "the latest successful scoped sync timestamp row",
    "pipeline-sync-latest",
  ),
  "MetaDecisionPipelineOperationalHealth.syncActivity.ageMinutes": W(
    S.PROVENANCE,
    "the successful sync age row",
    "pipeline-sync-age",
  ),
  "MetaDecisionPipelineOperationalHealth.syncActivity.maxAgeMinutes": W(
    S.PROVENANCE,
    "the sync-age ceiling row",
    "pipeline-sync-limit",
  ),
  "MetaDecisionPipelineOperationalHealth.syncActivity.latestJobStatus": W(
    S.PROVENANCE,
    "the latest durable sync job status row",
    "pipeline-sync-job-status",
  ),
  "MetaDecisionPipelineOperationalHealth.syncActivity.latestRunStatus": W(
    S.PROVENANCE,
    "the latest durable sync run status row",
    "pipeline-sync-run-status",
  ),
  "MetaDecisionPipelineOperationalHealth.syncActivity.reason": W(
    S.PROVENANCE,
    "the sync-dimension reason row",
    "pipeline-sync-reason",
  ),
  "MetaDecisionPipelineOperationalHealth.warehouse.status": W(
    S.PROVENANCE,
    "the finalized warehouse cutoff status row",
    "pipeline-warehouse-status",
  ),
  "MetaDecisionPipelineOperationalHealth.warehouse.latestFinalizedDate": W(
    S.PROVENANCE,
    "the latest finalized and validated Ad-day row",
    "pipeline-warehouse-latest",
  ),
  "MetaDecisionPipelineOperationalHealth.warehouse.expectedFinalizedDate": W(
    S.PROVENANCE,
    "the account-timezone-derived expected cutoff row",
    "pipeline-warehouse-expected",
  ),
  "MetaDecisionPipelineOperationalHealth.warehouse.lagDays": W(
    S.PROVENANCE,
    "the warehouse lag row",
    "pipeline-warehouse-lag",
  ),
  "MetaDecisionPipelineOperationalHealth.warehouse.accountTimeZone": W(
    S.PROVENANCE,
    "the provider account timezone used for cutoff evaluation",
    "pipeline-account-timezone",
  ),
  "MetaDecisionPipelineOperationalHealth.warehouse.reason": W(
    S.PROVENANCE,
    "the warehouse-dimension reason row",
    "pipeline-warehouse-reason",
  ),
  "MetaDecisionPipelineOperationalHealth.admission.status": W(
    S.PROVENANCE,
    "the live sync-admission status row",
    "pipeline-admission-status",
  ),
  "MetaDecisionPipelineOperationalHealth.admission.allowed": W(
    S.PROVENANCE,
    "the explicit live admission verdict row",
    "pipeline-admission-allowed",
  ),
  "MetaDecisionPipelineOperationalHealth.admission.reason": W(
    S.PROVENANCE,
    "the live growth-fence reason row",
    "pipeline-admission-reason",
  ),
  "MetaDecisionPipelineOperationalHealth.admission.evaluatedAt": W(
    S.PROVENANCE,
    "the admission evaluation timestamp row",
    "pipeline-admission-evaluated",
  ),
  "MetaDecisionPipelineOperationalHealth.admission.offender.table": W(
    S.PROVENANCE,
    "the physical-growth offender table row",
    "pipeline-admission-table",
  ),
  "MetaDecisionPipelineOperationalHealth.admission.offender.bytes": W(
    S.PROVENANCE,
    "the offender's exact physical byte-size row",
    "pipeline-admission-bytes",
  ),
  "MetaDecisionPipelineOperationalHealth.admission.offender.budget": W(
    S.PROVENANCE,
    "the offender's exact byte-budget row",
    "pipeline-admission-budget",
  ),
  "MetaDecisionPipelineOperationalHealth.admission.offender.overByBytes": W(
    S.PROVENANCE,
    "the exact over-budget byte count row",
    "pipeline-admission-over",
  ),
  "MetaDecisionPipelineHealth.decisionGeneration.status": W(
    S.PROVENANCE,
    "the exact decision-generation clock status row",
    "pipeline-generation-status",
  ),
  "MetaDecisionPipelineHealth.decisionGeneration.computedAt": W(
    S.PROVENANCE,
    "the exact generation computed-at row",
    "pipeline-generation-computed",
  ),
  "MetaDecisionPipelineHealth.decisionGeneration.ageHours": W(
    S.PROVENANCE,
    "the exact generation age row",
    "pipeline-generation-age",
  ),
  "MetaDecisionPipelineHealth.decisionGeneration.maxAgeHours": W(
    S.PROVENANCE,
    "the shared exact-decision age ceiling row",
    "pipeline-generation-limit",
  ),
  "MetaDecisionPipelineHealth.decisionGeneration.engineVersion": W(
    S.PROVENANCE,
    "the generation engine row",
    "pipeline-generation-engine",
  ),
  "MetaDecisionPipelineHealth.decisionGeneration.reason": W(
    S.PROVENANCE,
    "the generation-dimension reason row",
    "pipeline-generation-reason",
  ),
  "MetaDecisionPipelineHealth.manifest.status": W(
    S.PROVENANCE,
    "the exact native manifest status row",
    "pipeline-manifest-status",
  ),
  "MetaDecisionPipelineHealth.manifest.authority": W(
    S.PROVENANCE,
    "the manifest authority row",
    "pipeline-manifest-authority",
  ),
  "MetaDecisionPipelineHealth.manifest.jobRunId": W(
    S.PROVENANCE,
    "the manifest job-run lineage row",
    "pipeline-manifest-job",
  ),
  "MetaDecisionPipelineHealth.manifest.manifestHash": W(
    S.PROVENANCE,
    "the manifest identity hash row",
    "pipeline-manifest-hash",
  ),
  "MetaDecisionPipelineHealth.manifest.expectedAdCount": W(
    S.PROVENANCE,
    "the manifest's expected exact-Ad population row",
    "pipeline-manifest-expected",
  ),
  "MetaDecisionPipelineHealth.manifest.reason": W(
    S.PROVENANCE,
    "the manifest validation reason row",
    "pipeline-manifest-reason",
  ),
  "MetaPulsePayload.businessId": N(
    "The pulse echoes the business it was computed for; the shell names the account once.",
  ),
  "MetaPulsePayload.window": N(
    "The window is stated once, from the workspace envelope, on the window pills and the ROAS tile label.",
  ),
  "MetaPulsePayload.statusFilter": N(
    "The request's own status filter echoed back inside the pulse; the screen states the counts it produced.",
  ),
  "MetaPulsePayload.startDate": N(
    "A range echo; the date-window control renders the URL's range and a second copy could disagree with it.",
  ),
  "MetaPulsePayload.endDate": N(
    "A range echo; the date-window control renders the URL's range and a second copy could disagree with it.",
  ),
  "MetaPulsePayload.pacing.mtdSpend": N(
    "A real month-to-date measurement with nowhere on this page to be: every lane, pill and tile here is scoped to the selected window or to today, and no month-to-date number is stated anywhere on it. It is not deferred to another screen either - the complete set of non-test files naming it is walked and pinned, and not one of them renders it. @see PACING_FIELD_MENTIONS, PACING_IS_EXTRAPOLATED_FROM_SPEND",
  ),
  "MetaPulsePayload.pacing.mtdTarget": N(
    "Not a target: app/api/meta/account-pulse/route.ts:775 is `Math.max(spend, spend / dayOfMonth * 30)`, a straight-line extrapolation of the account's OWN month-to-date spend with no operator budget anywhere in it. Printing it under the word `target` is the exact defect the ROAS tile had fixed this round, one noun over. @see PACING_IS_EXTRAPOLATED_FROM_SPEND",
  ),
  "MetaPulsePayload.pacing.dayPace": N(
    "Not a pace: route.ts:819 divides month-to-date spend by that same extrapolation of month-to-date spend, so before the 30th it is exactly `dayOfMonth / 30` and on the 30th and 31st exactly 1 - the fraction of the calendar month elapsed, wearing the account's name. @see PACING_IS_EXTRAPOLATED_FROM_SPEND",
  ),
  "MetaPulsePayload.pacing.windowSpend": R(
    S.KPI,
    "the divisor that decides whether the window's ROAS is printed at all rather than as 0.00 (formatRoasAgainstSpend)",
  ),
  "MetaPulsePayload.pacing.spendToday": R(S.KPI, "the spend tile's value"),
  "MetaPulsePayload.pacing.dailyTarget": N(
    "Not a configured daily target: route.ts:822 is that same extrapolation divided by 30, so it moves with the account's own spend and with the day of the month and with nothing an operator set. The spend tile compares today against the 7-day average the account actually ran, which is a measurement. @see PACING_IS_EXTRAPOLATED_FROM_SPEND",
  ),
  "MetaPulsePayload.pacing.avg7dSpend": R(
    S.KPI,
    "the spend tile's delta, stated as a percentage against the 7-day average",
  ),
  "MetaPulsePayload.pacing.conversionsToday": R(
    S.KPI,
    "the spend tile's detail line",
  ),
  "MetaPulsePayload.pacing.avg7dConversions": R(
    S.KPI,
    "the spend tile's detail line, beside today's conversions",
  ),
  "MetaPulsePayload.roas.selected": R(
    S.KPI,
    "the ROAS tile's value for the selected window",
  ),
  "MetaPulsePayload.roas.d7": N(
    "The tile reports the window the operator selected; three more fixed-window ROAS figures on the same tile compete with the one they chose.",
  ),
  "MetaPulsePayload.roas.d14": N(
    "The tile reports the window the operator selected; three more fixed-window ROAS figures on the same tile compete with the one they chose.",
  ),
  "MetaPulsePayload.roas.d28": N(
    "The tile reports the window the operator selected; three more fixed-window ROAS figures on the same tile compete with the one they chose.",
  ),
  "MetaPulsePayload.roas.target": R(
    S.KPI,
    "the ROAS tile's reference line, when a commercial-truth target is the source in force (fresh or stale)",
  ),
  // WIRED-NOW rather than RENDERED, and the distinction is the point. Until
  // this round the tile printed an em dash here - "we could not tell" - about
  // a median the server had MEASURED and had named as the source in force, and
  // this file carried the defect under WITHHELD_BY_DEFECT with the fix and its
  // owner written out. The fix landed in targetRoasDisplay
  // (meta-decision-center-exact-adapter.ts:250-264, a fourth argument), so the
  // field now reaches the operator under the median's OWN noun. That is
  // exactly what this file means by "a wiring lane in THIS round changed
  // production code to put it on screen and said so in its handoff", so it is
  // recorded there rather than folded into the two hundred entries that were
  // already true. The handoff that landed the fix suggested R(); W() is the
  // same proof and the truer record.
  "MetaPulsePayload.roas.median": W(
    S.KPI,
    "the ROAS tile's reference line whenever target_source is 'account_median' - printed as 'account median 2.10', never as a target",
  ),
  "MetaPulsePayload.roas.target_source": R(
    S.KPI,
    "decides both the noun the reference line carries ('target' vs 'account median') and whether it carries a freshness qualifier (targetRoasDisplay)",
  ),
  "MetaPulsePayload.roas.targetFreshness": R(
    S.KPI,
    "the target line's 'stale' / 'freshness unknown' qualifier",
  ),
  "MetaPulsePayload.roas.targetUpdatedAt": N(
    "Freshness is stated as a word the operator can act on ('stale', 'freshness unknown'); the raw timestamp is the input to that word, not a second fact.",
  ),
  "MetaPulsePayload.roasHistory": R(S.KPI, "the ROAS tile's sparkline"),
  "MetaPulsePayload.spend.current": N(
    "Period-over-period account totals are the Overview and Reports comparison; the Decision strip reports today against the 7-day average and every row carries its own money.",
  ),
  "MetaPulsePayload.spend.prev": N(
    "Period-over-period account totals are the Overview and Reports comparison; the Decision strip reports today against the 7-day average and every row carries its own money.",
  ),
  "MetaPulsePayload.revenue.current": N(
    "Period-over-period account totals are the Overview and Reports comparison; the Decision strip reports today against the 7-day average and every row carries its own money.",
  ),
  "MetaPulsePayload.revenue.prev": N(
    "Period-over-period account totals are the Overview and Reports comparison; the Decision strip reports today against the 7-day average and every row carries its own money.",
  ),
  "MetaPulsePayload.cpa.current": N(
    "Period-over-period account totals are the Overview and Reports comparison; the Decision strip reports today against the 7-day average and every row carries its own money.",
  ),
  "MetaPulsePayload.cpa.prev": N(
    "Period-over-period account totals are the Overview and Reports comparison; the Decision strip reports today against the 7-day average and every row carries its own money.",
  ),
  "MetaPulsePayload.matureCampaigns": N(
    "An account-level maturity tally; the Watching lane states the learning population as a served segment chip, and two counts of 'still learning' on one screen can disagree.",
  ),
  "MetaPulsePayload.learningCampaigns": N(
    "An account-level maturity tally; the Watching lane states the learning population as a served segment chip, and two counts of 'still learning' on one screen can disagree.",
  ),
  "MetaPulsePayload.operatingMode": R(S.KPI, "the mode tile's value"),
  "MetaPulsePayload.seasonalRegime": R(S.KPI, "the mode tile's first chip"),
  "MetaPulsePayload.engineLastRun": N(
    "The header already states the engine version and the snapshot's computed-at from the read model; the pulse's own last-run time is a fourth timestamp for one run.",
  ),
  "MetaPulsePayload.engineVersion": N(
    "The header's engine label resolves from the read model, then the OS presentation, then system.engineVersion; the pulse copy is a fourth spelling of one version.",
  ),
  "MetaPulsePayload.campaignContextMode": N(
    "A diagnostic naming which labelling mode produced campaign context; the label-coverage tile states the coverage that mode produces, which is the half an operator can act on.",
  ),
  "MetaPulsePayload.trackingHealth.status": R(
    S.KPI,
    "the mode tile's tracking chip, and the gate on the tracking banner",
  ),
  "MetaPulsePayload.trackingHealth.detail": R(
    S.BANNERS,
    "the tracking banner's detail line",
  ),
  "MetaPulsePayload.trackingAnomalyActive": N(
    "The workspace system envelope is the server-authoritative tracking safety gate; this pulse flag is retained only for compatibility and cannot override it.",
  ),
  "MetaPulsePayload.lastSyncAt": R(
    S.HEADER,
    "the 'synced Nm ago' identity chip, and the snapshot tile's detail line",
  ),
  "MetaPulsePayload.currency": N(
    "Money is formatted from the scoped account's currency and then system.currency; the pulse copy is the same code arriving by another route.",
  ),
  "MetaPulsePayload.dataReadiness.status": R(
    S.BANNERS,
    "the data-readiness banner's gate",
  ),
  "MetaPulsePayload.dataReadiness.isPartial": R(
    S.BANNERS,
    "the data-readiness banner's gate",
  ),
  "MetaPulsePayload.dataReadiness.notReadyReason": R(
    S.BANNERS,
    "the data-readiness banner's detail line",
  ),
  "MetaPulsePayload.dataReadiness.evidenceSource": W(
    S.BANNERS,
    "the evidence-source disclosure banner",
  ),
  "MetaLanePayload.businessId": N(
    "The lane payload echoes the business it was computed for; the shell names the account once.",
  ),
  "MetaLanePayload.startDate": W(
    S.INSPECTOR,
    "the evidence-window fact, which states the range every figure on the panel covers; a verdict without it cannot be checked against anything",
  ),
  "MetaLanePayload.endDate": W(
    S.INSPECTOR,
    "the other half of the evidence-window fact",
  ),
  "MetaLanePayload.sourceModel": N(
    "Which lane model produced the rows; the source panel states the decision source, its table and its authority for the grain that actually carries authority.",
  ),
  "MetaLanePayload.snapshotDate": R(
    S.HEADER,
    "the snapshot identity chip, when the read model served no snapshotAsOf",
  ),
  "MetaLanePayload.snapshotCreatedAt": W(
    S.INSPECTOR,
    "the as-of fact, drawn beside the evidence window and never as it: a snapshot written this morning can describe a window that ended days ago",
  ),
  "MetaLanePayload.statusFilter": N(
    "The request's own status filter echoed back; the lane counts it produced are what the pills state.",
  ),
  "MetaLanePayload.actionNow": R(S.ACTION, "every Action Now row"),
  "MetaLanePayload.watching": R(S.WATCHING, "every Watching row"),
  "MetaLanePayload.nonSales": R(S.NONSALES, "the Non-sales informational card"),
  "MetaLanePayload.deferredIds": R(
    S.PILLS,
    "the Deferred pill's count, when the caller supplies no filtered count of its own",
  ),
  "MetaLanePayload.counts.actionNow": R(S.PILLS, "the lane pills' counts"),
  "MetaLanePayload.counts.watching": R(S.PILLS, "the lane pills' counts"),
  "MetaLanePayload.counts.healthy": R(S.PILLS, "the lane pills' counts"),
  "MetaLanePayload.counts.nonSales": R(S.PILLS, "the lane pills' counts"),
  "MetaLanePayload.counts.archive": R(S.PILLS, "the lane pills' counts"),
  "MetaSnapshotHealth.latestSnapshotDate": N(
    "The header already states the served snapshot's as-of date; a second date under a freshness heading would read as a second snapshot.",
  ),
  "MetaSnapshotHealth.lastRunAt": N(
    "The header states the snapshot's computed-at from the read model, which is the same run.",
  ),
  "MetaSnapshotHealth.engineVersion": W(
    S.KPI,
    "the Recommendation snapshot tile's explicitly labelled recommendation-engine detail",
  ),
  "MetaSnapshotHealth.currentEngineVersion": N(
    "The freshness tile states the status word the version comparison produces, and the header states the engine that actually ran.",
  ),
  "MetaSnapshotHealth.isCurrentEngineVersion": N(
    "The freshness tile states the status word the version comparison produces, and the header states the engine that actually ran.",
  ),
  "MetaSnapshotHealth.ageHours": R(S.KPI, "the snapshot tile's 'Nh old'"),
  "MetaSnapshotHealth.status": R(
    S.KPI,
    "the snapshot tile's freshness word, and the snapshot-health banner's gate and tone",
  ),
  "MetaSnapshotHealth.staleReason": R(
    S.BANNERS,
    "the snapshot-health banner's detail line",
  ),
  "MetaDecisionsWorkspaceViewer.role": R(
    S.MOBILE,
    "the viewer-authority panel's role line",
  ),
  "MetaDecisionsWorkspaceViewer.isReviewer": R(
    S.BANNERS,
    "selects the reviewer wording of the read-only banner",
  ),
  "MetaDecisionsWorkspaceViewer.readOnly": R(
    S.BANNERS,
    "the read-only banner's gate, and the write-capability sentence on mobile",
  ),
  "MetaDecisionsWorkspaceViewer.readOnlyReason": R(
    S.BANNERS,
    "the read-only banner's detail, and the mobile viewer-authority panel",
  ),
  "MetaDecisionsWorkspaceBanner.id": R(
    S.BANNERS,
    "the banner's data-banner-id, its sort key and the tracking banner's dismissal identity",
  ),
  "MetaDecisionsWorkspaceBanner.tone": R(S.BANNERS, "the banner's tone class"),
  "MetaDecisionsWorkspaceBanner.title": R(S.BANNERS, "the banner's title"),
  "MetaDecisionsWorkspaceBanner.detail": R(
    S.BANNERS,
    "the banner's detail line",
  ),
  "MetaDecisionsWorkspaceBanner.blocking": R(
    S.BANNERS,
    "data-banner-blocking, and whether the banner is announced as an alert or a status",
  ),
  "MetaDecisionsWorkspaceBanner.scope": R(
    S.BANNERS,
    "data-banner-scope on desktop and mobile, plus the target-hard-actions scope sentence",
  ),
  "MetaDecisionsWorkspaceBanner.action.label": R(
    S.BANNERS,
    "the served banner action's desktop and mobile link label",
  ),
  "MetaDecisionsWorkspaceBanner.action.href": R(
    S.BANNERS,
    "the served internal banner destination after route-family adaptation",
  ),
  "MetaDecisionsDigest.snapshotDate": W(
    S.BANNERS,
    "the silent-failure banner's since-window",
  ),
  "MetaDecisionsDigest.unavailableReason": N(
    "Every arm that sets it returns the UNTOUCHED emptyDecisionDigest zeros - app/api/meta/decisions-workspace/route.ts:765 builds them, :975-979 spreads them under the read failure, and :1336-1343 writes the same zeros inline for the compact surface - so the one count the banner strip does render is withheld by its own `> 0` gate in every state this reason accompanies. The reason explains the absence of nothing.",
  ),
  "MetaDecisionsDigest.labelFlips.count": N(
    "A since-yesterday recap of decision labels that changed; the Decision page states the current decision, and the per-decision history a flip belongs to is the evidence window's journal and Meta History's timeline.",
  ),
  "MetaDecisionsDigest.labelFlips.publishedCount": N(
    "A since-yesterday recap of decision labels that changed; the Decision page states the current decision, and the per-decision history a flip belongs to is the evidence window's journal and Meta History's timeline.",
  ),
  "MetaDecisionsDigest.labelFlips.items[].id": N(
    "A since-yesterday recap of decision labels that changed; the Decision page states the current decision, and the per-decision history a flip belongs to is the evidence window's journal and Meta History's timeline.",
  ),
  "MetaDecisionsDigest.labelFlips.items[].title": N(
    "A since-yesterday recap of decision labels that changed; the Decision page states the current decision, and the per-decision history a flip belongs to is the evidence window's journal and Meta History's timeline.",
  ),
  "MetaDecisionsDigest.labelFlips.items[].previousLabel": N(
    "A since-yesterday recap of decision labels that changed; the Decision page states the current decision, and the per-decision history a flip belongs to is the evidence window's journal and Meta History's timeline.",
  ),
  "MetaDecisionsDigest.labelFlips.items[].currentLabel": N(
    "A since-yesterday recap of decision labels that changed; the Decision page states the current decision, and the per-decision history a flip belongs to is the evidence window's journal and Meta History's timeline.",
  ),
  "MetaDecisionsDigest.labelFlips.items[].status": N(
    "A since-yesterday recap of decision labels that changed; the Decision page states the current decision, and the per-decision history a flip belongs to is the evidence window's journal and Meta History's timeline.",
  ),
  "MetaDecisionsDigest.labelFlips.items[].occurredAt": N(
    "A since-yesterday recap of decision labels that changed; the Decision page states the current decision, and the per-decision history a flip belongs to is the evidence window's journal and Meta History's timeline.",
  ),
  "MetaDecisionsDigest.actions.verifiedCount": W(
    S.BANNERS,
    "the silent-failure banner's denominator, the M in 'N of M'",
  ),
  "MetaDecisionsDigest.actions.silentFailureCount": W(
    S.BANNERS,
    "the silent-failure banner's count",
  ),
  "MetaDecisionsDigest.actions.countsTruncated": W(
    S.BANNERS,
    "the width switch on that same sentence: MetaPlatformPage.tsx:2386 branches on it, so the title reads 'At least N recorded actions ended without a verified outcome.' instead of 'N recorded actions ended...', and the detail reads 'counts only its M most recent recorded actions ... The window may hold more recorded actions than this count covers; whether it does, and how many, is unavailable here.' instead of 'carries M recorded actions'. It is served, and rendered, because both counts are filtered from a CAPPED action-log read, and a measurement stated in a frame wider than the measurement is the defect the sentence exists to avoid.",
  ),
  "MetaDecisionsDigest.actions.countedRowCap": W(
    S.BANNERS,
    "the ', the most a <cap>-row cap lets it read,' clause inside that truncated detail, which is where the 'M most recent' came from: MetaPlatformPage.tsx:2387-2395 reads it and, when the payload serves no positive cap, drops the clause rather than inventing a bound to round the sentence out.",
  ),
  "MetaDecisionsDigest.actions.items[].id": N(
    "The banner strip now states this envelope's COUNTS - how many recorded actions were verified and how many were not - but the Decision page renders no action LOG at all, and a row of it is the part that has nowhere to go: this envelope is the strongest candidate in the payload for a surface of its own, and it is named as one rather than squeezed onto a decision card.",
  ),
  "MetaDecisionsDigest.actions.items[].action": N(
    "The banner strip now states this envelope's COUNTS - how many recorded actions were verified and how many were not - but the Decision page renders no action LOG at all, and a row of it is the part that has nowhere to go: this envelope is the strongest candidate in the payload for a surface of its own, and it is named as one rather than squeezed onto a decision card.",
  ),
  "MetaDecisionsDigest.actions.items[].target": N(
    "The banner strip now states this envelope's COUNTS - how many recorded actions were verified and how many were not - but the Decision page renders no action LOG at all, and a row of it is the part that has nowhere to go: this envelope is the strongest candidate in the payload for a surface of its own, and it is named as one rather than squeezed onto a decision card.",
  ),
  "MetaDecisionsDigest.actions.items[].actor": N(
    "The banner strip now states this envelope's COUNTS - how many recorded actions were verified and how many were not - but the Decision page renders no action LOG at all, and a row of it is the part that has nowhere to go: this envelope is the strongest candidate in the payload for a surface of its own, and it is named as one rather than squeezed onto a decision card.",
  ),
  "MetaDecisionsDigest.actions.items[].status": N(
    "The banner strip now states this envelope's COUNTS - how many recorded actions were verified and how many were not - but the Decision page renders no action LOG at all, and a row of it is the part that has nowhere to go: this envelope is the strongest candidate in the payload for a surface of its own, and it is named as one rather than squeezed onto a decision card.",
  ),
  "MetaDecisionsDigest.actions.items[].occurredAt": N(
    "The banner strip now states this envelope's COUNTS - how many recorded actions were verified and how many were not - but the Decision page renders no action LOG at all, and a row of it is the part that has nowhere to go: this envelope is the strongest candidate in the payload for a surface of its own, and it is named as one rather than squeezed onto a decision card.",
  ),
  "MetaDecisionsDigest.actions.items[].detail": N(
    "The banner strip now states this envelope's COUNTS - how many recorded actions were verified and how many were not - but the Decision page renders no action LOG at all, and a row of it is the part that has nowhere to go: this envelope is the strongest candidate in the payload for a surface of its own, and it is named as one rather than squeezed onto a decision card.",
  ),
  "MetaDecisionsDigest.anomalies.openedCount": N(
    "The page reads anomalies from /api/meta/anomalies and renders them in its own alerts strip and drill; the digest's copy is the same population counted at a different moment, and two anomaly counts on one screen can disagree.",
  ),
  "MetaDecisionsDigest.anomalies.items[].id": N(
    "The page reads anomalies from /api/meta/anomalies and renders them in its own alerts strip and drill; the digest's copy is the same population counted at a different moment, and two anomaly counts on one screen can disagree.",
  ),
  "MetaDecisionsDigest.anomalies.items[].title": N(
    "The page reads anomalies from /api/meta/anomalies and renders them in its own alerts strip and drill; the digest's copy is the same population counted at a different moment, and two anomaly counts on one screen can disagree.",
  ),
  "MetaDecisionsDigest.anomalies.items[].status": N(
    "The page reads anomalies from /api/meta/anomalies and renders them in its own alerts strip and drill; the digest's copy is the same population counted at a different moment, and two anomaly counts on one screen can disagree.",
  ),
  "MetaDecisionsDigest.anomalies.items[].occurredAt": N(
    "The page reads anomalies from /api/meta/anomalies and renders them in its own alerts strip and drill; the digest's copy is the same population counted at a different moment, and two anomaly counts on one screen can disagree.",
  ),
  "MetaDecisionsDigest.deferrals.dueCount": N(
    "The Deferred pill counts the deferrals the lane payload serves; a second due-count under a recap heading would be a different number for the same idea.",
  ),
  "MetaDecisionsDigest.deferrals.items[].id": N(
    "The Deferred pill counts the deferrals the lane payload serves; a second due-count under a recap heading would be a different number for the same idea.",
  ),
  "MetaDecisionsDigest.deferrals.items[].title": N(
    "The Deferred pill counts the deferrals the lane payload serves; a second due-count under a recap heading would be a different number for the same idea.",
  ),
  "MetaDecisionsDigest.deferrals.items[].dueAt": N(
    "The Deferred pill counts the deferrals the lane payload serves; a second due-count under a recap heading would be a different number for the same idea.",
  ),
  "MetaDecisionsDigest.deferrals.items[].detail": N(
    "The Deferred pill counts the deferrals the lane payload serves; a second due-count under a recap heading would be a different number for the same idea.",
  ),
  "MetaDecisionsWorkspaceReadModel.contractVersion": N(
    "The read model's own version; the inspector's provenance line already carries the presentation version the rows were built at, and a second version string names a contract the operator cannot act on.",
  ),
  "MetaDecisionsWorkspaceReadModel.status": W(
    S.PROVENANCE,
    "the 'Read model status' fact in BOTH scopes; it does NOT colour the headline - the headline and its tone read source.status",
    "read-model-status",
  ),
  "MetaDecisionsWorkspaceReadModel.generatedAt": N(
    "When the read model was assembled is not a fact about the data; the header and the source panel state the snapshot's as-of and computed-at, which are.",
  ),
  "MetaDecisionsWorkspaceReadModel.scope.businessId": R(
    S.PROVENANCE,
    "the structure scope's 'Business' fact",
    "scope-business",
  ),
  "MetaDecisionsWorkspaceReadModel.scope.providerAccountId": R(
    S.HEADER,
    "the account label, when no account row was resolved, and the structure scope's 'Provider account' fact",
  ),
  "MetaDecisionsWorkspaceReadModel.scope.decisionMode": N(
    "The contract admits one value, 'current': a field that cannot vary states nothing when printed.",
  ),
  "MetaDecisionsWorkspaceReadModel.scope.metricsRangeAffectsDecisionSnapshot":
    N(
      "The contract pins this false, and the header already says so by stating the snapshot's own as-of date beside the selected window.",
    ),
  "MetaDecisionsWorkspaceReadModel.unavailable.code": R(
    S.PROVENANCE,
    "the 'Unavailable' fact in both scopes, printed only when the server declared one",
    "unavailable-code",
  ),
  "MetaDecisionsWorkspaceReadModel.unavailable.message": R(
    S.PROVENANCE,
    "the 'Unavailable detail' fact in both scopes, printed only when the server declared one, and the mobile posture panel",
    "unavailable-message",
  ),
  "MetaDecisionsWorkspaceReadModel.source.status": R(
    S.PROVENANCE,
    "the 'Source status' fact in both scopes, and the structure scope's headline and its tone",
    "status",
  ),
  "MetaDecisionsWorkspaceReadModel.source.authority": R(
    S.PROVENANCE,
    "the Creatives scope headline and its 'Authority' fact",
    "authority",
  ),
  "MetaDecisionsWorkspaceReadModel.source.table": R(
    S.PROVENANCE,
    "the 'Table' fact, and the evidence window's diagnostics",
    "table",
  ),
  "MetaDecisionsWorkspaceReadModel.source.snapshotAsOf": R(
    S.HEADER,
    "the snapshot identity chip, and the 'Snapshot as of' fact in both scopes",
  ),
  "MetaDecisionsWorkspaceReadModel.source.computedAt": R(
    S.HEADER,
    "the header's UTC time, and the 'Computed at' fact in both scopes",
  ),
  "MetaDecisionsWorkspaceReadModel.source.engineVersion": R(
    S.HEADER,
    "the engine label, and the 'Engine' fact in both scopes",
  ),
  "MetaDecisionsWorkspaceReadModel.source.fallbackReason": R(
    S.PROVENANCE,
    "the 'Fallback reason' fact, the creatives notice and the mobile posture panel",
    "fallback-reason",
  ),
  "MetaDecisionsWorkspaceReadModel.source.generation.jobRunId": R(
    S.PROVENANCE,
    "the 'Generation job run' fact, and the evidence window's diagnostics",
    "generation-job-run",
  ),
  "MetaDecisionsWorkspaceReadModel.source.generation.providerAccountRefId": R(
    S.PROVENANCE,
    "the 'Provider account ref' fact, and the evidence window's diagnostics",
    "generation-account-ref",
  ),
  "MetaDecisionsWorkspaceReadModel.source.generation.manifestHash": R(
    S.PROVENANCE,
    "the 'Manifest hash' fact, and the evidence window's diagnostics",
    "generation-manifest",
  ),
  "MetaDecisionsWorkspaceReadModel.source.generation.expectedAdCount": R(
    S.PROVENANCE,
    "the 'Expected ads' fact, and the evidence window's diagnostics",
    "generation-expected-ads",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.deduplicationGrain": N(
    "A restatement of source.authority, which the source panel prints: every producer sets 'ad' exactly when the authority is native_ad and 'creative' otherwise (lib/meta/decisions-workspace-read-model.ts). Two vocabularies for one fact side by side invite the reader to look for a difference that cannot exist.",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.sourcePreCapCount": R(
    S.PROVENANCE,
    "the 'Decision source (pre-cap)' coverage fact",
    "queue-source-pre-cap",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.queuedPreCapCount": R(
    S.PROVENANCE,
    "the 'Queued (pre-cap)' coverage fact",
    "queue-queued-pre-cap",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.adCandidates.selectionVersion": N(
    "The version of the candidate selection algorithm; the panel states what the selection DID - how many identities were eligible, selected and omitted, and for which reason - which is the part that changes what the operator sees.",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.adCandidates.limit": N(
    "The cap's configured size; the panel states the two numbers the cap produced against TWO eligible pre-cap counts - the read model's own and the OS presentation's derived maximum, each under a label naming which one it is - and that pair is what tells an operator the list is partial.",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.adCandidates.preCapCount": R(
    S.MOBILE,
    "the withheld panel's 'N of M exact Ad identities selected'",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.adCandidates.eligiblePreCapCount": W(
    S.PROVENANCE,
    "the 'Eligible (pre-cap) · read model' coverage fact",
    "queue-eligible-pre-cap",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.adCandidates.selectedCount": R(
    S.MOBILE,
    "the withheld panel's 'N of M exact Ad identities selected'",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.adCandidates.stateCounts{}.preCapCount":
    N(
      "The per-state pre-cap sizes; the account-level pre-cap total is stated against the selected total, and the queue's own group headers already say 'N shown · M served' for each state from the OS presentation's counts.",
    ),
  "MetaDecisionsWorkspaceReadModel.queue.adCandidates.stateCounts{}.selectedCount":
    R(
      S.MOBILE,
      "the withheld panel's per-state breakdown of the selected identities",
    ),
  "MetaDecisionsWorkspaceReadModel.queue.adCandidates.omittedAmbiguousIdentity":
    N(
      "The OS presentation forwards the same three omission counts as os.ads.omitted*, and those are the ones the source panel prints; printing both copies would list every omitted ad twice under two labels.",
    ),
  "MetaDecisionsWorkspaceReadModel.queue.adCandidates.omittedWithoutVerifiedAdId":
    N(
      "The OS presentation forwards the same three omission counts as os.ads.omitted*, and those are the ones the source panel prints; printing both copies would list every omitted ad twice under two labels.",
    ),
  "MetaDecisionsWorkspaceReadModel.queue.adCandidates.omittedNotApplicable": N(
    "The OS presentation forwards the same three omission counts as os.ads.omitted*, and those are the ones the source panel prints; printing both copies would list every omitted ad twice under two labels.",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.inactiveAssets.preCapCount": N(
    "The Archive lane renders every withheld Ad decision it was served and counts them into the lane pill; a pre-cap total beside a list that is not capped states nothing new.",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.inactiveAssets.inactiveCount": R(
    S.MOBILE,
    "the withheld panel's inactive-Ad count",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.inactiveAssets.unknownCount": R(
    S.MOBILE,
    "the withheld panel's 'N unknown status' qualifier",
  ),
  "MetaDecisionsWorkspaceReadModel.queue.omittedFromQueue.count": R(
    S.PROVENANCE,
    "the 'Withheld from queue' group's total",
    "suppressed-count",
  ),
  "MetaOsDecisionsPresentation.contractVersion": N(
    "The presentation version is printed once, on the inspector's provenance line, where it qualifies the row being inspected.",
  ),
  "MetaOsDecisionsPresentation.generatedAt": N(
    "When the presentation was assembled is not a fact about the data; the header states the snapshot's as-of and the run's computed-at, which are.",
  ),
  "MetaOsDecisionsPresentation.source.snapshotAsOf": R(
    S.HEADER,
    "the snapshot identity chip, when neither the read model nor the lanes served one",
  ),
  "MetaOsDecisionsPresentation.source.engineVersion": R(
    S.HEADER,
    "the engine label, when the read model served none",
  ),
  "MetaOsDecisionsPresentation.source.structureSource": R(
    S.PROVENANCE,
    "the structure scope's headline and its 'Structure source' fact, and the mobile posture panel",
  ),
  "MetaOsDecisionsPresentation.source.adsSource": R(
    S.PROVENANCE,
    "the Creatives scope's 'Ads source' fact, and the mobile posture panel",
    "ads-source",
  ),
  "MetaOsDecisionsPresentation.source.health": R(
    S.PROVENANCE,
    "the Creatives scope headline, its tone and its 'Health' fact, and the mobile posture panel",
    "health",
  ),
  "MetaOsDecisionsPresentation.source.fallbackReason": R(
    S.PROVENANCE,
    "the 'Fallback reason' fact, when the read model served none, and the creatives notice",
    "fallback-reason",
  ),
  "MetaOsDecisionsPresentation.structure.actCount": R(
    S.PROVENANCE,
    "the structure scope's 'Lane · act' coverage fact, and part of the decision-carrying total",
    "structure-act",
  ),
  "MetaOsDecisionsPresentation.structure.blockedCount": R(
    S.PROVENANCE,
    "the structure scope's 'Lane · blocked' coverage fact, and part of the decision-carrying total",
    "structure-blocked",
  ),
  "MetaOsDecisionsPresentation.structure.monitorCount": R(
    S.PROVENANCE,
    "the structure scope's 'Lane · monitor' coverage fact, and part of the decision-carrying total",
    "structure-monitor",
  ),
  "MetaOsDecisionsPresentation.structure.suppressedAlternativeCount": R(
    S.PROVENANCE,
    "the structure scope's 'Suppressed alternatives' coverage fact",
    "structure-suppressed-alternatives",
  ),
  "MetaOsDecisionsPresentation.ads.actCount": N(
    "The creative group headers count the rendered rows in each state directly and state the served pre-cap total beside them; these three are the same three numbers after the cap.",
  ),
  "MetaOsDecisionsPresentation.ads.blockedCount": N(
    "The creative group headers count the rendered rows in each state directly and state the served pre-cap total beside them; these three are the same three numbers after the cap.",
  ),
  "MetaOsDecisionsPresentation.ads.monitorCount": N(
    "The creative group headers count the rendered rows in each state directly and state the served pre-cap total beside them; these three are the same three numbers after the cap.",
  ),
  "MetaOsDecisionsPresentation.ads.statePreCapCounts": R(
    S.CREATIVES,
    "each group header's 'N shown · M served'",
  ),
  "MetaOsDecisionsPresentation.ads.eligiblePreCapCount": R(
    S.PROVENANCE,
    "the coverage summary's shown-versus-eligible pair, which names it as derived, and the 'Eligible (pre-cap) · derived maximum' fact",
    "ads-eligible-pre-cap",
  ),
  "MetaOsDecisionsPresentation.ads.omittedWithoutVerifiedAdId": R(
    S.PROVENANCE,
    "the 'Omitted · unverified ad id' coverage fact",
    "omitted-unverified-ad-id",
  ),
  "MetaOsDecisionsPresentation.ads.omittedAmbiguousIdentity": R(
    S.PROVENANCE,
    "the 'Omitted · ambiguous identity' coverage fact",
    "omitted-ambiguous-identity",
  ),
  "MetaOsDecisionsPresentation.ads.omittedNotApplicable": R(
    S.PROVENANCE,
    "the 'Omitted · not applicable' coverage fact",
    "omitted-not-applicable",
  ),
  "MetaOsDecisionsPresentation.ads.sourcePreCapCount": R(
    S.PROVENANCE,
    "the 'Decision source (pre-cap)' coverage fact, when the read model's own copy is absent",
    "queue-source-pre-cap",
  ),
  "MetaOsDecisionsPresentation.inactive.count": N(
    "An advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice.",
  ),
  "MetaOsDecisionsPresentation.inactive.inactiveCount": N(
    "An advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice.",
  ),
  "MetaOsDecisionsPresentation.inactive.unknownCount": N(
    "An advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice.",
  ),
  "MetaOsDecisionsPresentation.limitations[].code": R(
    S.PROVENANCE,
    "the Limitations group in both scopes, the creatives notice, and the mobile posture panel",
  ),
  "MetaOsDecisionsPresentation.limitations[].message": R(
    S.PROVENANCE,
    "the Limitations group in both scopes, the creatives notice, and the mobile posture panel",
  ),
  "MetaCampaignRoleCoverage.activeCampaigns": R(
    S.KPI,
    "the automatic campaign-role tile's denominator and its percentage",
  ),
  "MetaCampaignRoleCoverage.classifiedCampaigns": R(
    S.KPI,
    "the automatic campaign-role tile's numerator and its percentage",
  ),
  "MetaCampaignRoleCoverage.actionAuthoritativeCampaigns": W(
    S.KPI,
    "the automatic-inference detail line's authority numerator, kept separate from classification coverage",
  ),
  "MetaCampaignRoleCoverage.unresolvedCampaigns": W(
    S.KPI,
    "the automatic-inference detail line, explicitly identifying unresolved campaigns without a manual label workflow",
  ),
  "MetaCampaignRoleCoverage.latestUpdatedAt": N(
    "When automatic role inference last changed is coverage freshness; the tile states the coverage itself, which is what gates campaign context.",
  ),
  "MetaTargetAnchor.configured": N(
    "The ROAS tile states the effective target and its freshness from pulse.roas, which is the number the engine decides against; the anchor's configured and break-even pairs are the Commercial Truth surface's subject.",
  ),
  "MetaTargetAnchor.source": N(
    "The ROAS tile states the effective target and its freshness from pulse.roas, which is the number the engine decides against; the anchor's configured and break-even pairs are the Commercial Truth surface's subject.",
  ),
  "MetaTargetAnchor.targetRoas": N(
    "The ROAS tile states the effective target and its freshness from pulse.roas, which is the number the engine decides against; the anchor's configured and break-even pairs are the Commercial Truth surface's subject.",
  ),
  "MetaTargetAnchor.breakEvenRoas": N(
    "The ROAS tile states the effective target and its freshness from pulse.roas, which is the number the engine decides against; the anchor's configured and break-even pairs are the Commercial Truth surface's subject.",
  ),
  "MetaTargetAnchor.targetCpa": N(
    "The ROAS tile states the effective target and its freshness from pulse.roas, which is the number the engine decides against; the anchor's configured and break-even pairs are the Commercial Truth surface's subject.",
  ),
  "MetaTargetAnchor.breakEvenCpa": N(
    "The ROAS tile states the effective target and its freshness from pulse.roas, which is the number the engine decides against; the anchor's configured and break-even pairs are the Commercial Truth surface's subject.",
  ),
  "MetaTargetAnchor.freshness": N(
    "The ROAS tile states the effective target and its freshness from pulse.roas, which is the number the engine decides against; the anchor's configured and break-even pairs are the Commercial Truth surface's subject.",
  ),
  "MetaTargetAnchor.updatedAt": N(
    "The ROAS tile states the effective target and its freshness from pulse.roas, which is the number the engine decides against; the anchor's configured and break-even pairs are the Commercial Truth surface's subject.",
  ),
  "MetaHealthyEntity.id": R(S.HEALTHY, "the group and ad-set row keys"),
  "MetaHealthyEntity.level": R(
    S.HEALTHY,
    "decides whether a served row is the group's campaign line or one of its ad sets",
  ),
  "MetaHealthyEntity.name": R(
    S.HEALTHY,
    "the group name and each ad-set row's name",
  ),
  "MetaHealthyEntity.campaignId": R(
    S.HEALTHY,
    "the key each group is assembled on",
  ),
  "MetaHealthyEntity.campaignName": R(
    S.HEALTHY,
    "the group name, when the campaign row itself was not served",
  ),
  "MetaHealthyEntity.campaignKind": N(
    "The Healthy lane's claim is that nothing needs doing; the campaign's role is what the Action and Watching rows carry as a chip, where it changes what the operator does next.",
  ),
  "MetaHealthyEntity.spend": R(
    S.HEALTHY,
    "the group rollup line and each ad-set row's stats",
  ),
  "MetaHealthyEntity.roas": R(
    S.HEALTHY,
    "the group rollup line and each ad-set row's stats",
  ),
  "MetaHealthyEntity.cpa": N(
    "The group line states spend and ROAS; a third money figure on a lane whose whole claim is that nothing needs doing crowds the two that carry the claim.",
  ),
  "MetaHealthyEntity.status": N(
    "Every row in this lane is delivering - that is what puts it here - so a status column would repeat the lane's own name on every line.",
  ),
  "MetaHealthyEntity.optimizationGoal": N(
    "The lane states the bid strategy, which is the setting a healthy campaign is usually checked against; the optimization goal belongs with the rest of the setup in the account inventory, which prints it.",
  ),
  "MetaHealthyEntity.customEventType": N(
    "The lane states the bid strategy; the conversion event is setup detail the account inventory's Setup column carries.",
  ),
  "MetaHealthyEntity.bidStrategyType": R(
    S.HEALTHY,
    "the group's strategy line, when the server sent no ready-made label",
  ),
  "MetaHealthyEntity.bidStrategyLabel": R(
    S.HEALTHY,
    "the group's strategy line",
  ),
  "MetaHealthyEntity.manualBidAmount": N(
    "Bid and budget amounts arrive in the provider's minor units with no scale stated anywhere in the contract; printing one would be a hundredfold error on a number the operator can act on. @see inventoryConfiguration",
  ),
  "MetaHealthyEntity.previousManualBidAmount": N(
    "Bid and budget amounts arrive in the provider's minor units with no scale stated anywhere in the contract; printing one would be a hundredfold error on a number the operator can act on. @see inventoryConfiguration",
  ),
  "MetaHealthyEntity.bidValue": N(
    "Bid and budget amounts arrive in the provider's minor units with no scale stated anywhere in the contract; printing one would be a hundredfold error on a number the operator can act on. @see inventoryConfiguration",
  ),
  "MetaHealthyEntity.bidValueFormat": N(
    "The format token qualifies a bid amount this lane does not print, and a unit label with no number beside it states nothing.",
  ),
  "MetaHealthyEntity.previousBidValue": N(
    "Bid and budget amounts arrive in the provider's minor units with no scale stated anywhere in the contract; printing one would be a hundredfold error on a number the operator can act on. @see inventoryConfiguration",
  ),
  "MetaHealthyEntity.previousBidValueFormat": N(
    "The format token qualifies a bid amount this lane does not print, and a unit label with no number beside it states nothing.",
  ),
  "MetaHealthyEntity.previousBidValueCapturedAt": N(
    "The timestamp of a previous bid this lane does not print; bid history is the bid-regime surface's subject.",
  ),
  "MetaHealthyEntity.isOptimizationGoalMixed": N(
    "A mixed flag is rendered exactly where the value it qualifies is rendered, and this lane prints no optimization goal - a qualifier with nothing on screen to qualify is not readable.",
  ),
  "MetaHealthyEntity.isCustomEventTypeMixed": N(
    "A mixed flag is rendered exactly where the value it qualifies is rendered, and this lane prints no conversion event - a qualifier with nothing on screen to qualify is not readable.",
  ),
  "MetaHealthyEntity.isBidStrategyMixed": W(
    S.HEALTHY,
    "the group's strategy line now reads 'Lowest Cost · mixed' when the server says the ad sets under it do not share one strategy, instead of printing the campaign row's answer flatly for a group it is false for",
  ),
  "MetaHealthyEntity.isBidValueMixed": N(
    "A mixed flag is rendered exactly where the value it qualifies is rendered, and this lane prints no bid amount - the amounts themselves are refused for their unstated unit scale.",
  ),
  "MetaArchivedEntity.id": R(S.ARCHIVE, "the row key"),
  "MetaArchivedEntity.level": R(
    S.ARCHIVE,
    "the grain that leads the status cell, so an ad set's 'Campaign paused 1050d' cannot read as the ad set's own status",
  ),
  "MetaArchivedEntity.name": R(S.ARCHIVE, "the row's name"),
  "MetaArchivedEntity.campaignId": N(
    "The Archive lane names the entity and its grain; the parent id is a join key, and the parent's own row is in the same lane when it is archived too.",
  ),
  "MetaArchivedEntity.campaignName": N(
    "The Archive lane names the entity and its grain; the served status label already carries the parent's state where the server put it there.",
  ),
  "MetaArchivedEntity.campaignKind": N(
    "An archived row's campaign role changes nothing an operator can do with it: the lane offers no action at either grain.",
  ),
  "MetaArchivedEntity.status": R(
    S.ARCHIVE,
    "the status cell's tone, and its text when no label was served",
  ),
  "MetaArchivedEntity.statusLabel": R(
    S.ARCHIVE,
    "the status cell, after the grain that qualifies it",
  ),
  "MetaArchivedEntity.spend": R(S.ARCHIVE, "the row's spend"),
  "MetaArchivedEntity.roas": N(
    "An archived entity's return is a claim about a period it is no longer delivering in; the lane states what it spent and why it is here, and offers no action either way.",
  ),
  "MetaArchivedEntity.cpa": N(
    "An archived entity's cost per purchase is a claim about a period it is no longer delivering in; the lane states what it spent and why it is here.",
  ),
  "MetaArchivedEntity.purchases": N(
    "An archived entity's purchases are a claim about a period it is no longer delivering in; the lane states what it spent and why it is here.",
  ),
  "MetaArchivedEntity.lastKnownWindow": N(
    "The lane header already names the window every row is reported over.",
  ),
  "MetaArchivedEntity.diagnosticNote": R(S.ARCHIVE, "the row's note"),
  "MetaArchivedEntity.advisory.decisionLabel": N(
    "An archived row carries no action tuple, so a decision label here would read as a recommendation the surface cannot offer - which is exactly the invariant this lane must not break.",
  ),
  "MetaArchivedEntity.advisory.primaryActionLabel": N(
    "An archived row carries no action tuple, so an action label here would draw a control that can never be pressed.",
  ),
  "MetaArchivedEntity.advisory.why": R(
    S.ARCHIVE,
    "the row's note, when the server sent no diagnostic note",
  ),
  "MetaArchivedEntity.advisory.confidence": N(
    "Confidence qualifies an advisory verdict this lane deliberately does not print.",
  ),
  "MetaStructureInventoryEntity.id": R(
    S.INVENTORY,
    "the row key, prefixed with its grain",
  ),
  "MetaStructureInventoryEntity.level": R(S.INVENTORY, "the Grain column"),
  "MetaStructureInventoryEntity.name": R(S.INVENTORY, "the Entity column"),
  "MetaStructureInventoryEntity.campaignId": R(
    S.INVENTORY,
    "the Campaign column, when the parent was served without a name",
  ),
  "MetaStructureInventoryEntity.campaignName": R(
    S.INVENTORY,
    "the Campaign column for an ad-set row",
  ),
  "MetaStructureInventoryEntity.campaignKind": R(
    S.INVENTORY,
    "the Campaign column for a campaign row",
  ),
  "MetaStructureInventoryEntity.status": R(
    S.INVENTORY,
    "the Status column, when the server sent no ready-made label",
  ),
  "MetaStructureInventoryEntity.statusLabel": R(
    S.INVENTORY,
    "the Status column",
  ),
  "MetaStructureInventoryEntity.metrics.spend": R(
    S.INVENTORY,
    "the Spend column",
  ),
  "MetaStructureInventoryEntity.metrics.purchases": R(
    S.INVENTORY,
    "the Purchases column",
  ),
  "MetaStructureInventoryEntity.metrics.roas": R(
    S.INVENTORY,
    "the ROAS column, printed only against spend the entity actually had",
  ),
  "MetaStructureInventoryEntity.metrics.cpa": W(
    S.INVENTORY,
    "the CPA column, formatted as money because the server derives it as spend over conversions in the same unit as the Spend column",
  ),
  "MetaStructureInventoryEntity.metrics.ctr": W(
    S.INVENTORY,
    "the CTR column, suffixed with a percent sign and never rescaled, because the server serves it already multiplied by 100",
  ),
  "MetaStructureInventoryEntity.metrics.frequency": N(
    "Derived from a reach figure summed across days, which counts one person once per day and drags the ratio below the truth - the same defect that keeps 'Reach · 28d' an em dash on the Non-sales card. @see deriveMetaFrequencyFromReach",
  ),
  "MetaStructureInventoryEntity.entityConfiguration": R(
    S.INVENTORY,
    "the Setup column, carrying the served labels only and never the minor-unit budget figures",
  ),
  "MetaWatchingSegment.key": R(
    S.WATCHING,
    "selects which of the five fixed segment chips this served count fills",
  ),
  "MetaWatchingSegment.label": N(
    "The five chips are fixed slots carrying their own labels so an absent segment still holds its place; a served label would let the chip row change shape per account.",
  ),
  "MetaWatchingSegment.count": R(S.WATCHING, "the segment chip's count"),
  "MetaWatchingSegment.description": N(
    "The chip is a count; a sentence of explanation has no room on it and would push the counts apart.",
  ),
  "MetaWatchingSegment.ctaLabel": N(
    "The chips are counts, not controls: wiring the served link would put a navigation control into a lane that offers none, and a chip that moved the operator elsewhere is an action the segment never carried.",
  ),
  "MetaWatchingSegment.href": N(
    "The chips are counts, not controls: wiring the served link would put a navigation control into a lane that offers none, and a chip that moved the operator elsewhere is an action the segment never carried.",
  ),
  "MetaDecisionQueueSection.key": N(
    "This surface renders lanes and the served ads population, not the read model's compact three-section queue; the section a decision was filed in names a queue that is never drawn here.",
  ),
  "MetaDecisionQueueSection.label": N(
    "This surface renders lanes and the served ads population, not the read model's compact three-section queue; the section's label names a queue that is never drawn here.",
  ),
  "MetaDecisionQueueSection.topN": N(
    "The size of a cap on a queue this surface does not render: its ads population comes from queue.adCandidates, whose own pre-cap and omission counts the source panel prints.",
  ),
  "MetaDecisionQueueSection.preCapCount": N(
    "The size of a cap on a queue this surface does not render: its ads population comes from queue.adCandidates, whose own pre-cap and omission counts the source panel prints.",
  ),
  "MetaDecisionQueueSection.selectedCount": N(
    "The size of a cap on a queue this surface does not render: its ads population comes from queue.adCandidates, whose own pre-cap and omission counts the source panel prints.",
  ),
  "MetaDecisionQueueSection.rankablePreCapCount": N(
    "Splits a section's pre-cap population by whether exposure could rank it; the section itself is not drawn here, and the exposure that ranks it is not printed either.",
  ),
  "MetaDecisionQueueSection.unrankablePreCapCount": N(
    "Splits a section's pre-cap population by whether exposure could rank it; the section itself is not drawn here, and the exposure that ranks it is not printed either.",
  ),
  "MetaCanonicalDecision.decisionId": R(
    S.EVIDENCE,
    "the diagnostics' 'decision id' row, ahead of the served decision's own spelling",
    "decision-id",
  ),
  "MetaCanonicalDecision.episodeId": R(
    S.EVIDENCE,
    "the diagnostics' episode id",
    "episode-id",
  ),
  "MetaCanonicalDecision.episodeStartedAt": R(
    S.EVIDENCE,
    "the diagnostics' episode start",
    "episode-started",
  ),
  "MetaCanonicalDecision.providerAccountId": R(
    S.EVIDENCE,
    "the diagnostics' provider account",
    "provider-account",
  ),
  "MetaCanonicalDecision.identityGrain": R(
    S.EVIDENCE,
    "the diagnostics' identity grain",
    "identity-grain",
  ),
  "MetaCanonicalDecision.sourceSnapshotId": R(
    S.EVIDENCE,
    "the diagnostics' 'snapshot id' row, ahead of the authority's and the served decision's spellings, and the key the envelope is looked up by",
    "snapshot-id",
  ),
  "MetaCanonicalDecision.sourceDecision.label": N(
    "The window states the published buyer label and the pre-authority label it came from; the raw source label is the same verdict in a third vocabulary.",
  ),
  "MetaCanonicalDecision.sourceDecision.preAuthorityLabel": R(
    S.EVIDENCE,
    "the diagnostics' pre-authority label",
    "pre-authority-label",
  ),
  "MetaCanonicalDecision.sourceDecision.authorityBlocker": R(
    S.EVIDENCE,
    "the diagnostics' authority blocker",
    "authority-blocker",
  ),
  "MetaCanonicalDecision.sourceDecision.rawLabel": N(
    "The served presentation decision's own rawLabel is printed in the diagnostics; the canonical twin is the same string from the same snapshot.",
  ),
  "MetaCanonicalDecision.sourceDecision.reason": R(
    S.EVIDENCE,
    "the window's reason lines",
  ),
  "MetaCanonicalDecision.sourceDecision.confidence": N(
    "The window prints the confidence BAND, which is the engine's own bucketing of this score, and the served decision's numeric score beside it; a third number for one confidence invites arithmetic nobody defined.",
  ),
  "MetaCanonicalDecision.sourceDecision.confidenceBand": R(
    S.EVIDENCE,
    "the window's band chip and its tone",
  ),
  "MetaCanonicalDecision.sourceDecision.truthSource": R(
    S.EVIDENCE,
    "the diagnostics' truth source",
    "truth-source",
  ),
  "MetaCanonicalDecision.sourceDecision.engineVersion": R(
    S.EVIDENCE,
    "the diagnostics' engine version",
  ),
  "MetaCanonicalDecision.sourceDecision.snapshotAsOf": R(
    S.EVIDENCE,
    "the window's as-of date",
  ),
  "MetaCanonicalDecision.sourceDecision.computedAt": W(
    S.EVIDENCE,
    "the audit block's exact decision computed-at row, kept separate from recommendation snapshot and sync clocks",
    "exact-decision-computed-at",
  ),
  "MetaCanonicalDecision.sourceDecision.badges": N(
    "Free-form engine badges with no served label or ordering; the blockers, the resolution and the authority provenance already state the facts a badge abbreviates, in words the operator can act on.",
  ),
  "MetaCanonicalDecision.identityResolution.basis": R(
    S.EVIDENCE,
    "the audit block's 'Identity resolution'",
    "identity-basis",
  ),
  "MetaCanonicalDecision.identityResolution.candidateAdCount": R(
    S.EVIDENCE,
    "the audit block's 'Candidate ads'",
    "identity-candidates",
  ),
  "MetaCanonicalDecision.identityResolution.metricsEquivalent": R(
    S.EVIDENCE,
    "the audit block's 'Candidate ads' line",
    "identity-candidates",
  ),
  "MetaCanonicalDecision.identityResolution.adActionEligible": R(
    S.EVIDENCE,
    "the audit block's 'Candidate ads' line",
    "identity-candidates",
  ),
  "MetaCanonicalDecision.classification.overlayVersion": N(
    "The version of the classification overlay; the window states the classification's own provenance (which source and field produced it), which is the part that answers 'where did this come from'.",
  ),
  "MetaCanonicalDecision.classification.queueSection": N(
    "Names the read model's compact three-section queue, which this surface does not render.",
  ),
  "MetaCanonicalDecision.classification.decisionState": R(
    S.EVIDENCE,
    "the audit block's decision state and its tone",
    "decision-state",
  ),
  "MetaCanonicalDecision.classification.heldAction": R(
    S.EVIDENCE,
    "the audit block's 'Held action', shown only when an action is actually held",
    "held-action",
  ),
  "MetaCanonicalDecision.classification.legacyBuyerAction": N(
    "The superseded spelling of buyerAction, kept in the contract for older payloads; printing a retired vocabulary beside the current one would show the operator two verdicts.",
  ),
  "MetaCanonicalDecision.classification.buyerAction": N(
    "The window prints the buyer LABEL this action resolves to, which is the same decision in the words the operator reads; Creative Studio's action authority is where the machine token is consumed.",
  ),
  "MetaCanonicalDecision.classification.buyerLabel": R(
    S.EVIDENCE,
    "the window's verdict line",
  ),
  "MetaCanonicalDecision.classification.executionAction": N(
    "An execution route this surface cannot offer: the Decision page mints no provider write from a canonical decision, and printing the route would suggest a control that is not there.",
  ),
  "MetaCanonicalDecision.riskTier": R(
    S.EVIDENCE,
    "the audit block's 'Risk tier'",
    "risk-tier",
  ),
  "MetaCanonicalDecision.confirmationCeremony": R(
    S.EVIDENCE,
    "the audit block's 'Confirmation ceremony', read from the canonical envelope and never from the served copy",
    "confirmation-ceremony",
  ),
  "MetaCanonicalDecision.riskTierProvenance.status": N(
    "The contract pins it 'proposed'; the window prints the REASON that status carries, which is the part that says what is missing.",
  ),
  "MetaCanonicalDecision.riskTierProvenance.reason": R(
    S.EVIDENCE,
    "the audit block's risk-tier line, when no tier was produced",
  ),
  "MetaCanonicalDecision.promotionBasis.status": R(
    S.EVIDENCE,
    "the diagnostics' promotion basis",
  ),
  "MetaCanonicalDecision.promotionBasis.value": N(
    "The contract pins it null: the producer is not persisted, and the status and reason beside it say exactly that.",
  ),
  "MetaCanonicalDecision.promotionBasis.reason": R(
    S.EVIDENCE,
    "the diagnostics' promotion basis",
  ),
  "MetaCanonicalDecision.metrics.spend": R(
    S.EVIDENCE,
    "the window's money line and its spend fact",
  ),
  "MetaCanonicalDecision.metrics.purchases": R(
    S.EVIDENCE,
    "the window's funnel and purchases fact",
    "purchases",
  ),
  "MetaCanonicalDecision.metrics.roas": R(
    S.EVIDENCE,
    "the window's money line",
  ),
  "MetaCanonicalDecision.metrics.recent7dRoas": N(
    "A second window's return on the same card as the decision window's; the engine decides against the decision window, and two ROAS figures with no stated windows beside them read as a disagreement.",
  ),
  "MetaCanonicalDecision.metrics.ctr": N(
    "The window draws this ad's CTR as a 28-day daily trail from the ad series read, which is the same measure at higher resolution; a scalar beside the chart would be the chart's own average restated.",
  ),
  "MetaCanonicalDecision.metrics.frequency": N(
    "The served presentation decision's frequency is the one this surface reads - it is the same 28-day lifecycle figure, and it is what the posture band and the window's frequency fact are computed from.",
  ),
  "MetaCanonicalDecision.metrics.effectiveTargetRoas": R(
    S.EVIDENCE,
    "the window's target comparison",
  ),
  "MetaCanonicalDecision.metrics.ratioToTarget": N(
    "The rows and the window state ROAS and 'vs N target' side by side, which is the ratio's two operands; the quotient adds a third number that can only agree with them.",
  ),
  "MetaCanonicalDecision.metrics.currency": R(
    S.EVIDENCE,
    "the currency the window's money is formatted in, and the fallback for a creative row's currency",
  ),
  "MetaCanonicalDecision.metrics.attribution": N(
    "The served decision's attribution token is the one printed, in the diagnostics' 'served grain' line; the contract admits one value, so the canonical twin cannot differ.",
  ),
  "MetaCanonicalDecision.creativeFormat": N(
    "The served presentation decision's creativeFormat is what the queue's thumb abbreviates to IMG, VID or CAT; the canonical twin is the same field from the same lifecycle row.",
  ),
  "MetaCanonicalDecision.fatigueStatus": R(
    S.EVIDENCE,
    "the window's fatigue fact, when the served decision carried none",
    "decision-specific",
  ),
  "MetaCanonicalDecision.exposureUnavailableReason": N(
    "Exposure is the section queue's ranking input and is not printed on this surface; the reason it is missing explains the absence of a number nobody sees.",
  ),
  "MetaDecisionSuppressionReason.code": R(
    S.PROVENANCE,
    "one labelled row per reason in the 'Withheld from queue' group",
  ),
  "MetaDecisionSuppressionReason.count": R(
    S.PROVENANCE,
    "the count beside each withholding reason",
  ),
  "MetaDecisionCapabilityState.status": R(
    S.PROVENANCE,
    "the capability gap's status word and its tone, one row per gap in both scopes; pinned at the 'stableDecisionIdentity' gap, one of the eight the contract names",
    "stableDecisionIdentity",
  ),
  "MetaDecisionCapabilityState.reason": R(
    S.PROVENANCE,
    "the capability gap's served reason, one row per gap in both scopes, and the evidence window's unavailability lines; pinned at the 'stableDecisionIdentity' gap",
    "stableDecisionIdentity",
  ),
  "MetaOsStructureGroup.id": N(
    "The key the census is walked by to find the node behind a row; it names no fact about the campaign.",
  ),
  "MetaOsStructureGroup.urgentAdsetCount": N(
    "The lanes list ad-set rows individually, each with its own served urgency; a per-campaign urgent tally would be a second ordering the lane does not follow.",
  ),
  "MetaOsAdDecision.id": R(
    S.CREATIVES,
    "the row key, the selection identity, and the diagnostics' served row id",
  ),
  "MetaOsAdDecision.decisionId": R(
    S.EVIDENCE,
    "the diagnostics' 'decision id' row, behind the canonical envelope's own spelling; it is also the key the queue row looks that envelope up by and it travels to onCreativeReview, and the queue itself prints no decision id",
    "decision-id",
  ),
  "MetaOsAdDecision.sourceSnapshotId": R(
    S.EVIDENCE,
    "the diagnostics' 'snapshot id' row, behind the canonical envelope's and the authority's; it is also the second half of that lookup key and it travels to onCreativeReview, and the queue itself prints no snapshot id",
    "snapshot-id",
  ),
  "MetaOsAdDecision.episodeId": R(
    S.EVIDENCE,
    "the diagnostics' episode id, when the canonical envelope is absent",
    "episode-id",
  ),
  "MetaOsAdDecision.providerAccountId": R(
    S.EVIDENCE,
    "the diagnostics' provider account, when the canonical envelope is absent",
    "provider-account",
  ),
  "MetaOsAdDecision.adId": R(
    S.CREATIVES,
    "the key the row's CTR sparkline is looked up by, and the diagnostics' served ad",
  ),
  "MetaOsAdDecision.adName": R(
    S.CREATIVES,
    "the row's name, and the window's title",
  ),
  "MetaOsAdDecision.campaignId": R(
    S.EVIDENCE,
    "the diagnostics' served campaign",
    "served-campaign",
  ),
  "MetaOsAdDecision.campaignName": R(
    S.INSPECTOR,
    "the inspector's entity meta line, and the window's diagnostics",
  ),
  "MetaOsAdDecision.adsetId": R(
    S.EVIDENCE,
    "the diagnostics' served ad set",
    "served-adset",
  ),
  "MetaOsAdDecision.adsetName": R(
    S.INSPECTOR,
    "the inspector's entity meta line, and the window's diagnostics",
  ),
  "MetaOsAdDecision.creativeId": R(
    S.EVIDENCE,
    "the diagnostics' served creative",
    "served-creative",
  ),
  "MetaOsAdDecision.creativeName": R(
    S.EVIDENCE,
    "the diagnostics' served creative",
    "served-creative",
  ),
  "MetaOsAdDecision.thumbnailUrl": R(
    S.EVIDENCE,
    "the window's preview, when the canonical envelope served no thumbnail",
  ),
  "MetaOsAdDecision.lifecycleRole": R(
    S.CREATIVES,
    "the row's first chip, and the window's 'served campaign role'",
  ),
  "MetaOsAdDecision.campaignRoleSource": R(
    S.EVIDENCE,
    "the 'served campaign role' line",
    "served-campaign-role",
  ),
  "MetaOsAdDecision.campaignRoleConfidence": R(
    S.EVIDENCE,
    "the 'served campaign role' line",
    "served-campaign-role",
  ),
  "MetaOsAdDecision.campaignRoleTrustedForAction": R(
    S.EVIDENCE,
    "the 'served campaign role' line and its tone",
    "served-campaign-role",
  ),
  /*
   * D074/D076: the resolver's own explanation for the campaign's automatically
   * inferred role, printed verbatim on its own rows so it can never be read as
   * the provisional display role above it. A null kind prints as unresolved
   * with the server's own reason beside it — never as a fallback kind.
   */
  "MetaOsCampaignRoleExplanation.kind": W(
    S.EVIDENCE,
    "the 'Automatically inferred role' row — the resolver's own published kind, or 'unresolved' when it published none",
    "served-role-inference",
  ),
  "MetaOsCampaignRoleExplanation.confidenceClass": W(
    S.EVIDENCE,
    "the 'Automatically inferred role' row, beside the kind",
    "served-role-inference",
  ),
  "MetaOsCampaignRoleExplanation.confidenceScore": W(
    S.EVIDENCE,
    "the 'Automatically inferred role' row: a measured zero prints score 0.00, a null score prints no score at all",
    "served-role-inference",
  ),
  "MetaOsCampaignRoleExplanation.evidence": W(
    S.EVIDENCE,
    "the 'Why' row — the resolver's evidence sentences, joined verbatim",
    "served-role-evidence",
  ),
  "MetaOsCampaignRoleExplanation.conflictReasons": W(
    S.EVIDENCE,
    "the 'Conflicting signals' row and its tone",
    "served-role-conflicts",
  ),
  "MetaOsCampaignRoleExplanation.unresolvedReason": W(
    S.EVIDENCE,
    "the 'Unresolved' row — the server's own reason, humanised; an em dash when a kind is published",
    "served-role-status",
  ),
  "MetaOsCampaignRoleExplanation.lastEvaluatedAt": W(
    S.EVIDENCE,
    "the 'Last evaluated' row",
    "served-role-evaluated",
  ),
  "MetaOsCampaignRoleExplanation.resolverVersion": W(
    S.EVIDENCE,
    "the 'Last evaluated' row, beside the evaluation time",
    "served-role-evaluated",
  ),
  "MetaOsAdDecision.lane": R(
    S.CREATIVES,
    "the group a row is filed under, its state chip and the blocked row's edge tone",
  ),
  "MetaOsAdDecision.assessment": R(
    S.EVIDENCE,
    "the window's reason lines, deduped against why-now",
  ),
  "MetaOsAdDecision.confidence": R(
    S.INSPECTOR,
    "the inspector's confidence line, and the window's served-confidence line",
  ),
  "MetaOsAdDecision.confidenceScore": R(
    S.EVIDENCE,
    "the served-confidence line: a measured zero prints score 0.00, a null score prints no score at all",
    "served-confidence",
  ),
  "MetaOsAdDecision.riskTier": R(
    S.EVIDENCE,
    "the served risk and ceremony line, kept apart from the canonical pair that gates a write",
    "served-risk-tier",
  ),
  "MetaOsAdDecision.confirmationCeremony": R(
    S.INSPECTOR,
    "the inspector's readiness line, and the window's served risk and ceremony line",
  ),
  "MetaOsAdDecision.whyNow": R(
    S.CREATIVES,
    "the row's note, the inspector's reason line and the window's reasons",
  ),
  "MetaOsAdDecision.blockers[].code": R(
    S.EVIDENCE,
    "the diagnostics' blocker codes",
    "blocker-codes",
  ),
  "MetaOsAdDecision.blockers[].label": R(
    S.CREATIVES,
    "the blocked row's note, the inspector's blockers line and the window's verdict sub-line",
  ),
  "MetaOsAdDecision.resolution.code": R(
    S.EVIDENCE,
    "the diagnostics row 'served resolution code'",
    "served-resolution-code",
  ),
  "MetaOsAdDecision.resolution.category": R(
    S.EVIDENCE,
    "the 'Served resolution' line, printed only when it differs from the owner beside it",
    "served-resolution",
  ),
  "MetaOsAdDecision.resolution.owner": R(
    S.EVIDENCE,
    "the 'Served resolution' line - who has to act",
    "served-resolution",
  ),
  "MetaOsAdDecision.resolution.label": R(
    S.EVIDENCE,
    "the 'Served resolution' line",
    "served-resolution",
  ),
  "MetaOsAdDecision.resolution.nextStep": R(
    S.CREATIVES,
    "the blocked row's 'Next:' note, and the inspector's contract detail",
  ),
  "MetaOsAdDecision.creativeFormat": R(
    S.CREATIVES,
    "the three-letter kind inside the row's thumb - IMG, VID or CAT, and an em dash for anything else",
  ),
  "MetaOsAdDecision.fatigueStatus": R(
    S.POSTURE,
    "the fatigued spend share tile's population, and the window's fatigue fact",
    "fatigued-spend-share",
  ),
  "MetaOsAdDecision.rawLabel": R(
    S.EVIDENCE,
    "the diagnostics' served raw label",
    "served-raw-label",
  ),
  "MetaOsAdDecision.publishedLabel": R(
    S.CREATIVES,
    "the row's tone, the refresh-pipeline count on the posture band, and the window's verdict when no canonical label was served",
  ),
  "MetaOsAdDecision.engineVersion": R(
    S.EVIDENCE,
    "the diagnostics' engine version, behind the authority's and the canonical decision's",
    "engine-version",
  ),
  "MetaOsAdDecision.snapshotAsOf": R(
    S.INSPECTOR,
    "the inspector's snapshot evidence row, and the window's as-of date",
    "snapshot",
  ),
  "MetaOsAdDecision.sourceGrain": R(
    S.EVIDENCE,
    "the diagnostics' 'served grain' line",
    "served-grain",
  ),
  "MetaOsAdDecision.decisionAvailability": R(
    S.CREATIVES,
    "the 'Pending native evidence' chip, and the window's served-availability line",
  ),
  "MetaOsInactiveAsset.id": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.level": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.providerEntityId": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.name": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.campaignName": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.adsetName": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.status": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.deliveryState": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.advisoryLabel": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.advisoryReason": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.confidence": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.source": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaOsInactiveAsset.providerWriteAuthority": N(
    "The OS presentation's advisory projection of rows the Archive lane already renders from the read model's own canonical envelopes, which carry the delivery statuses and the withholding reason this projection drops; rendering both would list every inactive asset twice at two different fidelities.",
  ),
  "MetaDecisionExposureDigest.basis": N(
    "A pre-cap exposure roll-up per currency for a section queue this surface does not render; the money on this screen is stated per row, in that row's own currency, where the operator is deciding.",
  ),
  "MetaDecisionExposureDigest.byCurrency[].currency": N(
    "A pre-cap exposure roll-up per currency for a section queue this surface does not render; the money on this screen is stated per row, in that row's own currency, where the operator is deciding.",
  ),
  "MetaDecisionExposureDigest.byCurrency[].amount": N(
    "A pre-cap exposure roll-up per currency for a section queue this surface does not render; the money on this screen is stated per row, in that row's own currency, where the operator is deciding.",
  ),
  "MetaDecisionExposureDigest.byCurrency[].decisionCount": N(
    "A pre-cap exposure roll-up per currency for a section queue this surface does not render; the money on this screen is stated per row, in that row's own currency, where the operator is deciding.",
  ),
  "MetaDecisionExposureDigest.unavailableCount": N(
    "A pre-cap exposure roll-up per currency for a section queue this surface does not render; the money on this screen is stated per row, in that row's own currency, where the operator is deciding.",
  ),
  "MetaDecisionExposureDigest.crossCurrencyTotal": N(
    "A pre-cap exposure roll-up per currency for a section queue this surface does not render; the money on this screen is stated per row, in that row's own currency, where the operator is deciding.",
  ),
  "MetaDecisionSuppressionReceipt.receiptId": N(SECTION_RECEIPT_IS_NOT_DRAWN),
  "MetaDecisionSuppressionReceipt.selectionVersion": N(
    SECTION_RECEIPT_IS_NOT_DRAWN,
  ),
  "MetaDecisionSuppressionReceipt.topN": N(SECTION_RECEIPT_IS_NOT_DRAWN),
  "MetaDecisionSuppressionReceipt.preCapCount": N(SECTION_RECEIPT_IS_NOT_DRAWN),
  "MetaDecisionSuppressionReceipt.selectedCount": N(
    SECTION_RECEIPT_IS_NOT_DRAWN,
  ),
  "MetaDecisionSuppressionReceipt.suppressedCount": R(
    S.PROVENANCE,
    "the 'Section cap · envelopes held back' fact, summed across the sections: a decision the cap held back is one fewer canonical envelope for a queue row to open its evidence with, which is the consequence this screen carries",
    "section-cap-held-back",
  ),
  "MetaDecisionSourceAuthority.status": R(
    S.EVIDENCE,
    "the audit block's 'Source authority' and its tone",
    "source-authority",
  ),
  "MetaDecisionSourceAuthority.actionEligible": R(
    S.EVIDENCE,
    "the audit block's 'Decision-authorized', which is never inferred from the served action label or confused with current execution readiness",
    "action-eligibility",
  ),
  "MetaDecisionSourceAuthority.reviewOnlyReason": R(
    S.ARCHIVE,
    "the withheld Ad row's note, and the window's 'Review-only because'",
  ),
  "MetaDecisionSourceAuthority.snapshotId": R(
    S.EVIDENCE,
    "the diagnostics' snapshot id",
    "snapshot-id",
  ),
  "MetaDecisionSourceAuthority.evaluationId": R(
    S.EVIDENCE,
    "the diagnostics' evaluation id",
    "evaluation-id",
  ),
  "MetaDecisionSourceAuthority.inputHash": R(
    S.EVIDENCE,
    "the diagnostics' input hash",
    "input-hash",
  ),
  "MetaDecisionSourceAuthority.decisionHash": R(
    S.EVIDENCE,
    "the diagnostics' decision hash",
    "decision-hash",
  ),
  "MetaDecisionSourceAuthority.providerAccountRefId": R(
    S.EVIDENCE,
    "the diagnostics' provider account ref",
    "provider-account-ref",
  ),
  "MetaDecisionSourceAuthority.engineVersion": R(
    S.EVIDENCE,
    "the diagnostics' engine version, ahead of the other two spellings",
    "engine-version",
  ),
  "MetaDecisionSourceAuthority.realAdId": R(
    S.EVIDENCE,
    "the diagnostics' real ad id",
    "real-ad-id",
  ),
  "MetaDecisionSourceAuthority.authorizedAction": R(
    S.EVIDENCE,
    "the audit block's 'Authorized action'",
    "authorized-action",
  ),
  "MetaDecisionSourceAuthority.jobRunId": R(
    S.EVIDENCE,
    "the diagnostics' job run id",
    "job-run-id",
  ),
  "MetaDecisionSourceAuthority.executionReadiness": W(
    S.EVIDENCE,
    "the audit block's server-owned execution-readiness row",
    "execution-readiness",
  ),
  "MetaDecisionSourceAuthority.decisionFreshness.status": W(
    S.EVIDENCE,
    "the audit block's exact-decision freshness status",
    "exact-decision-freshness",
  ),
  "MetaDecisionSourceAuthority.decisionFreshness.ageHours": W(
    S.EVIDENCE,
    "the audit block's exact-decision age, distinct from recommendation snapshot age",
    "exact-decision-freshness",
  ),
  "MetaDecisionSourceAuthority.decisionFreshness.maxAgeHours": W(
    S.EVIDENCE,
    "the audit block's exact-decision execution-age ceiling",
    "exact-decision-freshness",
  ),
  "MetaDecisionSourceAuthority.decisionFreshness.computedAt": N(
    "The exact decision computed-at row renders sourceDecision.computedAt, the canonical decision timestamp. Repeating the identical timestamp nested inside the derived freshness receipt would imply a second clock.",
  ),
  "MetaDecisionProvenance.source": R(
    S.EVIDENCE,
    "the diagnostics' 'classification source', as source.field",
    "classification-provenance",
  ),
  "MetaDecisionProvenance.field": R(
    S.EVIDENCE,
    "the diagnostics' 'classification source', as source.field",
    "classification-provenance",
  ),
  "MetaDecisionProvenance.recordId": N(
    "The row id inside the source table; the window prints the snapshot id, the evaluation id and both hashes, which are the receipts a reader can take back to the engine.",
  ),
  "MetaDecisionProvenance.asOf": N(
    "Every envelope on the card is as of one snapshot, which the window states once; a per-field as-of would suggest the fields were read at different times.",
  ),
  "MetaDecisionProvenance.version": N(
    "The producing contract's version; the window prints the engine version and the overlay's own source and field, which is what identifies the producer.",
  ),
  "MetaDecisionMediaEnvelope.state": R(
    S.EVIDENCE,
    "the 'Creative media' fact and its tone, which answers whether the creative's media is readable AT SOURCE - a different question from whether the window found a picture to show, which the thumbnail's own state answers",
    "creative-media",
  ),
  "MetaDecisionMediaEnvelope.missingMedia": N(
    "A nullable restatement of the thumbnail state the window already checks; the preview either appears or the served presentation's own thumbnail is used.",
  ),
  "MetaDecisionMediaEnvelope.thumbnail.state": R(
    S.EVIDENCE,
    "gates whether the canonical thumbnail is used as the preview",
  ),
  "MetaDecisionMediaEnvelope.thumbnail.url": R(
    S.EVIDENCE,
    "the window's preview image",
  ),
  "MetaDecisionDeliveryScope.state": R(
    S.EVIDENCE,
    "the audit block's 'Delivery scope' and its tone, and the Archive row's status when no ad status was served",
    "delivery-scope",
  ),
  "MetaDecisionDeliveryScope.campaignStatus": R(
    S.EVIDENCE,
    "the audit block's delivery line, and the Archive row's note",
    "delivery-scope",
  ),
  "MetaDecisionDeliveryScope.adsetStatus": R(
    S.EVIDENCE,
    "the audit block's delivery line, and the Archive row's note",
    "delivery-scope",
  ),
  "MetaDecisionDeliveryScope.adStatus": R(
    S.ARCHIVE,
    "the withheld Ad row's status and tone, and the evidence window's delivery line",
  ),
  "MetaDecisionDeliveryScope.reason": N(
    "The state and the three hierarchy statuses are printed together, and the reason is the sentence form of exactly that triple.",
  ),
  "MetaDecisionLifecycleRoleOverlay.value": N(
    "The served presentation decision states the lifecycle role on the row itself, as a chip and in the window's 'served campaign role' line; the overlay is the same role one envelope down.",
  ),
  "MetaDecisionLifecycleRoleOverlay.confidence": N(
    "The served decision's campaignRoleConfidence is the copy the window prints, beside the role and its trust flag.",
  ),
  "MetaDecisionLifecycleRoleOverlay.trustedForAction": N(
    "The served decision's campaignRoleTrustedForAction is the copy the window prints, in words, with its own tone.",
  ),
  "MetaDecisionLifecycleRoleOverlay.blockerCode": N(
    "The blocker codes are printed as one list in the diagnostics; a per-overlay code repeats an entry from it.",
  ),
  "MetaDecisionAssessmentOverlay.value": N(
    "The served presentation decision's assessment is what the window prints, deduped against the reason line; the overlay is the same assessment one envelope down.",
  ),
  "MetaDecisionAssessmentOverlay.blockerCode": N(
    "The blocker codes are printed as one list in the diagnostics; a per-overlay code repeats an entry from it.",
  ),
  "MetaDecisionResolution.code": N(RESOLUTION_IS_FORWARDED),
  "MetaDecisionResolution.category": N(RESOLUTION_IS_FORWARDED),
  "MetaDecisionResolution.owner": N(RESOLUTION_IS_FORWARDED),
  "MetaDecisionResolution.label": N(RESOLUTION_IS_FORWARDED),
  "MetaDecisionResolution.nextStep": N(RESOLUTION_IS_FORWARDED),
  "MetaDecisionBlocker.code": R(
    S.EVIDENCE,
    "the diagnostics' blocker codes",
    "blocker-codes",
  ),
  "MetaDecisionBlocker.label": R(
    S.EVIDENCE,
    "the verdict sub-line's authority gates",
  ),
  "MetaDecisionBlocker.category": N(
    "The blocker is printed as its label beside the verdict and as its code in the receipts; the category groups codes for a producer, and the operator acts on the label.",
  ),
  /*
   * The advisory is the same shape as a blocker and deliberately NOT one.
   * `risk_tier_unclassified` used to sit in `classification.blockers`, where it
   * vetoed every exact-Ad action on every account because the risk-tier
   * PRODUCER is not persisted — a gap in our own pipeline silently answering
   * for the ad. It moved to `classification.advisories`, which gates nothing,
   * and it still has to be SAID: withholding the statement would trade one
   * dishonesty for another.
   */
  "MetaDecisionAdvisory.code": R(
    S.EVIDENCE,
    "the diagnostics' advisory codes",
    "advisory-codes",
  ),
  "MetaDecisionAdvisory.label": R(
    S.EVIDENCE,
    "the verdict sub-line's advisory sentence",
  ),
  "MetaDecisionAdvisory.reason": R(
    S.EVIDENCE,
    "the advisory sentence's stated cause, after the em dash",
  ),
  "MetaDecisionExposure.kind": N(
    "A pre-cap ranking input for the compact section queue this surface does not render; the money the operator reads is the row's own spend, in the row's own currency.",
  ),
  "MetaDecisionExposure.amount": N(
    "A pre-cap ranking input for the compact section queue this surface does not render; the money the operator reads is the row's own spend, in the row's own currency.",
  ),
  "MetaDecisionExposure.currency": N(
    "A pre-cap ranking input for the compact section queue this surface does not render; the money the operator reads is the row's own spend, in the row's own currency.",
  ),
  "MetaDecisionExposure.attribution": N(
    "A pre-cap ranking input for the compact section queue this surface does not render; the money the operator reads is the row's own spend, in the row's own currency.",
  ),
  "MetaDecisionExposure.grain": N(
    "A pre-cap ranking input for the compact section queue this surface does not render; the money the operator reads is the row's own spend, in the row's own currency.",
  ),
  "MetaDecisionHistoryEnvelope.events.status": R(
    S.EVIDENCE,
    "the audit block's 'Decision events', which says unavailable rather than empty",
    "decision-events",
  ),
  "MetaDecisionHistoryEnvelope.events.reason": R(
    S.EVIDENCE,
    "the audit block's 'Decision events' when the journal is unavailable",
    "decision-events",
  ),
  "MetaDecisionHistoryEnvelope.events.preCapCount": R(
    S.EVIDENCE,
    "the audit block's 'N recorded of M served'",
    "decision-events",
  ),
  "MetaDecisionHistoryEnvelope.outcomes.status": R(
    S.EVIDENCE,
    "the audit block's 'Recorded outcomes'",
    "decision-outcomes",
  ),
  "MetaDecisionHistoryEnvelope.outcomes.reason": R(
    S.EVIDENCE,
    "the audit block's 'Recorded outcomes' when the journal is unavailable",
    "decision-outcomes",
  ),
  "MetaDecisionHistoryEnvelope.responses.status": R(
    S.EVIDENCE,
    "the audit block's 'Operator responses'",
    "operator-responses",
  ),
  "MetaDecisionHistoryEnvelope.responses.reason": R(
    S.EVIDENCE,
    "the audit block's 'Operator responses' when the journal is unavailable",
    "operator-responses",
  ),
  "MetaDecisionHistoryEnvelope.responses.items[].id": N(
    "The window states the journal's availability and the number of records it holds; the individual responses are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEnvelope.responses.items[].observationStatus": N(
    "The window states the journal's availability and the number of records it holds; the individual responses are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEnvelope.responses.items[].responseType": N(
    "The window states the journal's availability and the number of records it holds; the individual responses are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEnvelope.responses.items[].detectedAt": N(
    "The window states the journal's availability and the number of records it holds; the individual responses are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEnvelope.responses.items[].responseCutoff": N(
    "The window states the journal's availability and the number of records it holds; the individual responses are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEnvelope.providerWrites.status": R(
    S.EVIDENCE,
    "the audit block's 'Provider write outcome'",
    "provider-write-outcome",
  ),
  "MetaDecisionHistoryEnvelope.providerWrites.reason": R(
    S.EVIDENCE,
    "the audit block's 'Provider write outcome' when the linkage is unavailable",
    "provider-write-outcome",
  ),
  "MetaOsStructureNode.id": N(
    "The node's own key; the row is identified by the recommendation it enriches, which is what the inspector's provenance line names.",
  ),
  "MetaOsStructureNode.sourceRecommendationId": R(
    S.INSPECTOR,
    "the provenance line, and the key every lane row is joined to its node by",
  ),
  "MetaOsStructureNode.level": N(
    "The row states its own grain from the recommendation it was built from - Campaign or Ad set - and the node's copy is the same grain.",
  ),
  "MetaOsStructureNode.providerEntityId": N(
    "The provider's id for an entity the row already names; the Decision page mints no provider call from a structure row, so the id is a join key rather than a fact on screen.",
  ),
  "MetaOsStructureNode.campaignId": N(
    "The row's lineage line is built from the recommendation's own campaign id and name, which is the same parent.",
  ),
  "MetaOsStructureNode.campaignName": N(
    "The row's lineage line is built from the recommendation's own campaign id and name, which is the same parent.",
  ),
  "MetaOsStructureNode.name": N(
    "The row's name comes from the recommendation it was built from; two names for one entity can disagree and only one can be the row's.",
  ),
  "MetaOsStructureNode.lifecycleRole": N(
    "The row states the campaign's kind as a chip from its own served campaign context; the node's lifecycle role is the same role under the OS vocabulary.",
  ),
  "MetaOsStructureNode.campaignRoleTrustedForAction": N(
    "Whether the role may be acted on is already expressed where it bites: a row whose context is untrusted carries the server's blocker label as a chip and its action tuple says review.",
  ),
  "MetaOsStructureNode.budgetOwner": N(
    "Where the budget lives is stated in the account inventory's Setup column, from the served entity configuration, for every campaign and ad set rather than only for the few with a decision.",
  ),
  "MetaOsStructureNode.budgetMode": N(
    "Where the budget lives is stated in the account inventory's Setup column, from the served entity configuration, for every campaign and ad set rather than only for the few with a decision.",
  ),
  "MetaOsStructureNode.controlOwner": N(
    "Which level controls the entity is setup detail the account inventory's Setup column carries; the row itself states the action and the scope note that action applies at.",
  ),
  "MetaOsStructureNode.status": N(
    "The row's status chip comes from the recommendation's own entity configuration; the node's copy is the same status.",
  ),
  "MetaOsStructureNode.optimizationGoal": N(
    "The row's optimization-goal chip comes from the recommendation's own entity configuration; the node's copy is the same goal.",
  ),
  "MetaOsStructureNode.lane": W(
    S.PILLS,
    "the server-owned Act, Blocked or Monitor verdict routes the recommendation and changes the matching lane count; inventory-only Monitor nodes remain outside the watched-decision total",
  ),
  "MetaOsStructureNode.confidence": R(
    S.ACTION,
    "the row's confidence chip and its tone, and the inspector's confidence line",
  ),
  "MetaOsStructureNode.assessment": R(
    S.ACTION,
    "the row's decision label, when the recommendation carried none",
  ),
  "MetaOsStructureNode.whyNow": R(
    S.INSPECTOR,
    "the inspector's reason line; Monitor rows also reuse it as their Watching note",
  ),
  "MetaOsStructureNode.expectedImpact": R(
    S.ACTION,
    "the row's money sub-line and the inspector's money detail",
  ),
  "MetaOsStructureNode.evidence[].label": R(
    S.INSPECTOR,
    "one row of the inspector's evidence list",
  ),
  "MetaOsStructureNode.evidence[].value": R(
    S.INSPECTOR,
    "one row of the inspector's evidence list",
  ),
  "MetaOsStructureNode.evidence[].tone": N(
    "The inspector prints the served evidence as label and value; colouring a fact the server measured would put a verdict on evidence, which is the one thing evidence must not carry.",
  ),
  "MetaOsStructureNode.suppressedAlternativeCount": N(
    "How many alternatives were suppressed for this one node; the account total is printed on the structure source panel, where a coverage number belongs, and a per-row count of paths not taken competes with the path that was.",
  ),
  "MetaOsDecisionPriority.band": R(
    S.EVIDENCE,
    "the 'Served priority' row's band, for the one row the operator opened; the queue itself renders the order the server sent and prints neither band nor rank, because a rank printed on an already-ranked list invites re-sorting it",
    "served-priority",
  ),
  "MetaOsDecisionPriority.rank": R(
    S.EVIDENCE,
    "the 'Served priority' row's 'rank N', for the one row the operator opened; the queue itself renders the order the server sent and prints neither band nor rank",
    "served-priority",
  ),
  "MetaOsDecisionPriority.version": R(
    S.INSPECTOR,
    "the provenance line, which states the presentation version the row was built at",
  ),
  "MetaOsDecisionUrgency.level": N(
    "Urgency is the key the structure lanes were ordered by; the row states why-now, which is the reason behind the rank rather than the rank itself.",
  ),
  "MetaOsDecisionUrgency.rank": N(
    "Urgency is the key the structure lanes were ordered by; the row states why-now, which is the reason behind the rank rather than the rank itself.",
  ),
  "MetaOsDecisionUrgency.label": N(
    "Urgency is the key the structure lanes were ordered by; the row states why-now, which is the reason behind the rank rather than the rank itself.",
  ),
  "MetaOsDecisionUrgency.reason": N(
    "Urgency's reason and the node's why-now are the same question answered twice; the row prints why-now.",
  ),
  /*
    PRE-DEPLOY AUDIT: `MetaOsDecisionAction` became a UNION when D081 added the
    budget branch, so the walk now emits these leaves under the base interface
    they are declared on. The classifications below are the established ones,
    moved to the keys the walk produces — not new judgements.
  */
  "MetaOsLegacyDecisionAction.budgetIntent": N(
    "Typed `never`: the legacy branch cannot carry a budget payload, and the type says so at compile time. There is no value to render — a field that cannot exist is not information withheld from the operator.",
  ),
  "MetaOsLegacyDecisionAction.bidIntent": N(
    "Typed `never`, for the same reason as the budget marker beside it: the legacy branch cannot carry a bid payload either.",
  ),
  "MetaOsBudgetDecisionAction.bidIntent": N(
    "Typed `never`: one action carries ONE typed payload. Two would make 'what is being proposed here' a question with two answers, and the queue projects a row per payload — so a double-payload action would become two proposals for one decision. The type refuses it, and `assertCanonicalDecisionAction` refuses it again for callers arriving through JSON.",
  ),
  "MetaOsDecisionActionBase.code": R(
    S.EVIDENCE,
    "the 'Served action' row, as 'code · intent · targetLevel'; the queue's own button prints the LABEL and never the code, and the served tuple travels to onStructurePrimary by reference",
    "served-action",
  ),
  "MetaOsDecisionActionBase.label": R(
    S.ACTION,
    "the row's action button, the creative row's decision label, and the inspector's server verdict",
  ),
  "MetaOsDecisionActionBase.intent": R(
    S.EVIDENCE,
    "the second part of the 'Served action' row, beside the code and the target level; the queue's button carries the action's TONE, which the provider mutation decides",
    "served-action",
  ),
  "MetaOsDecisionActionBase.targetLevel": R(
    S.EVIDENCE,
    "the third part of the 'Served action' row; the queue's row states the grain in words instead, and the tuple carries the level to the callback boundary unchanged",
    "served-action",
  ),
  "MetaOsDecisionActionBase.providerMutation": R(
    S.ACTION,
    "the action button's tone: a pause reads negative and a resume positive",
  ),
  "MetaOsDecisionActionBase.scopeNote": R(
    S.CREATIVES,
    "the creative row's money sub-line, and the inspector's contract detail",
  ),
  "MetaOsDecisionMetrics.spend": R(
    S.ACTION,
    "every row's money line, the posture band's weighting, and the inspector's spend evidence",
  ),
  "MetaOsDecisionMetrics.purchases": R(
    S.INSPECTOR,
    "the purchases evidence row",
    "purchases",
  ),
  "MetaOsDecisionMetrics.roas": R(
    S.ACTION,
    "every row's money line and the creative row's ROAS chip",
  ),
  /*
   * Both are still not printed as numbers, and both now reach the panel as
   * their own ABSENCE. A null metric is not a zero, and the grain that did not
   * serve it is a fact the reader needs in order to know why the figure is not
   * there — so the provenance-gap line names it.
   */
  "MetaOsDecisionMetrics.cpa": W(
    S.INSPECTOR,
    "the provenance-gap line, which names CPA as not served at this row's grain rather than leaving an unexplained gap",
  ),
  "MetaOsDecisionMetrics.ctr": W(
    S.INSPECTOR,
    "the provenance-gap line, for the same reason as CPA",
  ),
  "MetaOsDecisionMetrics.frequency": R(
    S.POSTURE,
    "the spend-weighted 'Avg frequency · 28d' tile, and the evidence window's frequency fact",
    "average-frequency",
  ),
  "MetaOsDecisionMetrics.effectiveTargetRoas": R(
    S.ACTION,
    "the 'vs N target' sub-line on structure and creative rows, and the inspector's target comparison",
  ),
  "MetaOsDecisionMetrics.ratioToTarget": N(
    "The rows print ROAS and 'vs N target' side by side, which is this ratio's two operands; the quotient is a third number that can only agree with them.",
  ),
  "MetaOsDecisionMetrics.currency": R(
    S.CREATIVES,
    "the currency a creative row's money is formatted in, ahead of the account fallback",
  ),
  "MetaOsDecisionMetrics.attribution": R(
    S.EVIDENCE,
    "the diagnostics' 'served grain' line",
  ),
  "MetaOsDecisionMetrics.grain": R(
    S.EVIDENCE,
    "the diagnostics' 'served grain' line",
    "served-grain",
  ),
  "MetaOsDecisionAuthorityProvenance.availability": R(
    S.EVIDENCE,
    "the 'Served label provenance' line and its tone",
    "served-authority-provenance",
  ),
  "MetaOsDecisionAuthorityProvenance.preAuthorityLabel": R(
    S.EVIDENCE,
    "the 'Served label provenance' line",
    "served-authority-provenance",
  ),
  "MetaOsDecisionAuthorityProvenance.postAuthorityRawLabel": R(
    S.EVIDENCE,
    "the 'Served label provenance' line",
    "served-authority-provenance",
  ),
  "MetaOsDecisionAuthorityProvenance.publishedLabel": R(
    S.EVIDENCE,
    "the 'Served label provenance' line",
    "served-authority-provenance",
  ),
  "MetaOsDecisionAuthorityProvenance.firstBlocker.code": R(
    S.EVIDENCE,
    "the diagnostics' 'authority blocker' row, behind the canonical envelope's own; the provenance line above it prints the blocker's LABEL instead",
    "authority-blocker",
  ),
  "MetaOsDecisionAuthorityProvenance.firstBlocker.label": R(
    S.EVIDENCE,
    "the 'Served label provenance' line's first blocker",
    "served-authority-provenance",
  ),
  "MetaOsDecisionAuthorityProvenance.firstBlocker.explanation": R(
    S.EVIDENCE,
    "the 'Label held because' row, which prints an em dash rather than nothing when a tripped gate arrived without its sentence",
    "served-first-blocker-explanation",
  ),
  "MetaDecisionParentRef.id": R(
    S.EVIDENCE,
    "the diagnostics' parent chain, and the Archive row's name for a withheld Ad when nothing else named it",
  ),
  "MetaDecisionParentRef.name": R(
    S.EVIDENCE,
    "the diagnostics' parent chain, and the Archive row's name for a withheld Ad",
  ),
  "MetaDecisionHistoryEvent.id": N(
    "The window states how many decision events the journal holds and whether it could be read at all; the events themselves are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEvent.eventType": N(
    "The window states how many decision events the journal holds and whether it could be read at all; the events themselves are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEvent.eventDate": N(
    "The window states how many decision events the journal holds and whether it could be read at all; the events themselves are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEvent.previousLabel": N(
    "The window states how many decision events the journal holds and whether it could be read at all; the events themselves are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEvent.currentLabel": N(
    "The window states how many decision events the journal holds and whether it could be read at all; the events themselves are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEvent.operatorActionType": N(
    "The window states how many decision events the journal holds and whether it could be read at all; the events themselves are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEvent.notes": N(
    "The window states how many decision events the journal holds and whether it could be read at all; the events themselves are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEvent.actor": N(
    "The window states how many decision events the journal holds and whether it could be read at all; the events themselves are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionHistoryEvent.actorAttributionStatus": N(
    "The window states how many decision events the journal holds and whether it could be read at all; the events themselves are a timeline, and a timeline on a decision card crowds out the decision. Meta History is the surface that renders event rows.",
  ),
  "MetaDecisionOutcome.id": N(
    "The window states how many recorded outcomes the journal holds and whether it could be read at all; the outcomes themselves are a backtest, which is the decision-quality surface's subject rather than this card's.",
  ),
  "MetaDecisionOutcome.outcomeWindowDays": N(
    "The window states how many recorded outcomes the journal holds and whether it could be read at all; the outcomes themselves are a backtest, which is the decision-quality surface's subject rather than this card's.",
  ),
  "MetaDecisionOutcome.evaluationDate": N(
    "The window states how many recorded outcomes the journal holds and whether it could be read at all; the outcomes themselves are a backtest, which is the decision-quality surface's subject rather than this card's.",
  ),
  "MetaDecisionOutcome.realizedOutcome": N(
    "The window states how many recorded outcomes the journal holds and whether it could be read at all; the outcomes themselves are a backtest, which is the decision-quality surface's subject rather than this card's.",
  ),
  "MetaDecisionOutcome.severity": N(
    "The window states how many recorded outcomes the journal holds and whether it could be read at all; the outcomes themselves are a backtest, which is the decision-quality surface's subject rather than this card's.",
  ),
  "MetaDecisionOutcome.classifierVersion": N(
    "The window states how many recorded outcomes the journal holds and whether it could be read at all; the outcomes themselves are a backtest, which is the decision-quality surface's subject rather than this card's.",
  ),
  "MetaOsStructureBidConfiguration.strategyType": N(
    "The Decision page does not read the node's bid envelope: the Healthy lane states the bid strategy from its own served entity, and the account inventory states it for every campaign and ad set.",
  ),
  "MetaOsStructureBidConfiguration.strategyLabel": N(
    "The Decision page does not read the node's bid envelope: the Healthy lane states the bid strategy from its own served entity, and the account inventory states it for every campaign and ad set.",
  ),
  "MetaOsStructureBidConfiguration.currentValue": N(
    "Bid and budget amounts arrive in the provider's minor units with no scale stated in the contract; printing one would be a hundredfold error on a number the operator can act on. @see inventoryConfiguration",
  ),
  "MetaOsStructureBidConfiguration.currentValueFormat": N(
    "The format token qualifies a bid amount this surface refuses to print for its unstated unit scale.",
  ),
  "MetaOsStructureBidConfiguration.previousValue": N(
    "Bid and budget amounts arrive in the provider's minor units with no scale stated in the contract; printing one would be a hundredfold error on a number the operator can act on. @see inventoryConfiguration",
  ),
  "MetaOsStructureBidConfiguration.previousValueFormat": N(
    "The format token qualifies a bid amount this surface refuses to print for its unstated unit scale.",
  ),
  "MetaOsStructureBidConfiguration.previousValueCapturedAt": N(
    "The timestamp of a previous bid this surface does not print; bid history is the bid-regime surface's subject.",
  ),
  "MetaOsStructureBidConfiguration.dailyBudget": N(
    "Bid and budget amounts arrive in the provider's minor units with no scale stated in the contract; printing one would be a hundredfold error on a number the operator can act on. @see inventoryConfiguration",
  ),
  "MetaOsStructureBidConfiguration.lifetimeBudget": N(
    "Bid and budget amounts arrive in the provider's minor units with no scale stated in the contract; printing one would be a hundredfold error on a number the operator can act on. @see inventoryConfiguration",
  ),
  "MetaOsStructureBidConfiguration.budgetUtilization": N(
    "A ratio of spend to a budget this surface refuses to print; a percentage whose denominator is not on screen cannot be checked by the reader.",
  ),

  /*
    ══ PRE-DEPLOY AUDIT — the budget evidence and dry-run branches ══════════

    `system.budgetEvidence` and `system.budgetDryRun` are served by
    `app/api/meta/decisions-workspace/route.ts` and rendered by
    `components/meta/decision-center/BudgetDecisionEvidencePanel.tsx` and
    `BudgetDryRunPanel.tsx`, mounted on the desktop provenance panel and again
    on the mobile stage. Their interfaces were declared in files the walk did
    not open, so the probe threw at import and this whole matrix — the thing
    that proves every served field reaches a surface — could not run at all.

    Each leaf below is classified from the component that renders it, by its
    `data-el` marker, not from the field name.
  */

  // ── the directional wrapper ──────────────────────────────────────────────
  "MetaBudgetDecisionEvidenceByDirection.contractVersion": N(
    "A contract discriminator the panel branches on; the operator reads the evidence, not the schema version that carried it.",
  ),
  "MetaBudgetDecisionEvidenceByDirection.directionSelected": W(
    S.MOBILE,
    "the wrapper's selected-direction attribute, always `none` on an account panel",
  ),
  "MetaBudgetDecisionEvidenceByDirection.directionSelectedWhy": W(
    S.MOBILE,
    "the sentence explaining why no direction is selected on an account-scoped panel",
  ),
  /*
    PRE-DEPLOY AUDIT — reclassified W -> N against the running code. The first
    draft claimed this sentence was printed beside `directionSelectedWhy`; a
    grep across app/, components/, lib/ and scripts/ finds the route producing
    it and NO component reading it. It is not withheld information either:
    each DirectionPanel prints the profile action it consulted from
    `directionToAction.increase` / `.decrease` at `direction-action`, so the
    mapping is on screen per direction rather than restated once in prose.
  */
  "MetaBudgetDecisionEvidenceByDirection.directionToActionWhy": N(
    "A single prose gloss on the direction-to-action mapping. Each direction panel already prints the action it consulted, which states the same mapping where the reader is looking.",
  ),
  "MetaBudgetDecisionEvidenceByDirection.directionToAction.increase": W(
    S.MOBILE,
    "the increase panel's action attribute — the server's own direction-to-action mapping",
  ),
  "MetaBudgetDecisionEvidenceByDirection.directionToAction.decrease": W(
    S.MOBILE,
    "the decrease panel's action attribute — the server's own direction-to-action mapping",
  ),

  // ── one direction's panel ────────────────────────────────────────────────
  "MetaBudgetDecisionEvidencePanel.contractVersion": N(
    "The panel's own schema version. The surface prints the PROFILE contract it consulted, which is the one an operator can reconcile.",
  ),
  "MetaBudgetDecisionEvidencePanel.status": W(
    S.MOBILE,
    "the direction group's status attribute, which selects the resolved or unavailable body",
  ),
  "MetaBudgetDecisionEvidencePanel.unavailableReason": W(
    S.MOBILE,
    "the reason line shown when the direction's evidence could not be resolved",
  ),
  "MetaBudgetDecisionEvidencePanel.authority": W(
    S.MOBILE,
    "the authority line — validated for review only, or blocked",
  ),
  "MetaBudgetDecisionEvidencePanel.primaryBlocker.code": W(
    S.MOBILE,
    "the first blocker's canonical code",
  ),
  "MetaBudgetDecisionEvidencePanel.primaryBlocker.reason": W(
    S.MOBILE,
    "the first blocker's operator sentence, beside its code",
  ),

  // ── the commercial lineage this direction consulted ──────────────────────
  "MetaBudgetDecisionEvidencePanel.commercialLineage.selectedAction": W(
    S.MOBILE,
    "the availability line's action attribute — which profile action this direction read",
  ),
  "MetaBudgetDecisionEvidencePanel.commercialLineage.eligible": W(
    S.MOBILE,
    "the canonical eligibility line, which prints `unknown` rather than false when the profile did not say",
  ),
  "MetaBudgetDecisionEvidencePanel.commercialLineage.code": W(
    S.MOBILE,
    "the canonical code line, which prints `none` when the profile published no code",
  ),
  "MetaBudgetDecisionEvidencePanel.commercialLineage.reason": W(
    S.MOBILE,
    "the unresolved-availability sentence, printed when the gates could not be resolved",
  ),
  "MetaBudgetDecisionEvidencePanel.commercialLineage.contractVersion": W(
    S.MOBILE,
    "the profile-contract line, printed beside the expected and observed contracts",
  ),
  "MetaBudgetDecisionEvidencePanel.commercialLineage.availability.status": W(
    S.MOBILE,
    "the source status printed on the contract line and carried as the availability attribute",
  ),
  "MetaBudgetDecisionEvidencePanel.commercialLineage.anchorExplanation": W(
    S.MOBILE,
    "the canonical anchor explanation block, rendered verbatim and never re-derived",
  ),

  // ── execution readiness, and the control it does not enable ──────────────
  "MetaBudgetDecisionEvidencePanel.executionReadiness.state": W(
    S.MOBILE,
    "the readiness attribute on the execution line — `not_executable` in this slice",
  ),
  "MetaBudgetDecisionEvidencePanel.executionReadiness.ctaEnabled": W(
    S.MOBILE,
    "the CTA-enabled attribute on the execution line, which the disabled button restates",
  ),
  "MetaBudgetDecisionEvidencePanel.executionReadiness.why": W(
    S.MOBILE,
    "the sentence saying why this direction is not executable",
  ),

  // ── the counterfactual, which is never authority ─────────────────────────
  "MetaBudgetDecisionEvidencePanel.counterfactual.label": N(
    "Set only by an explicitly labelled counterfactual scenario, which the served account panel never carries; the offline replay owns it. Rendering a hypothetical beside measured evidence is exactly the confusion the panel exists to prevent.",
  ),
  "MetaBudgetDecisionEvidencePanel.counterfactual.neverActionAuthority": N(
    "A constant `true` restating that a counterfactual grants no authority. It qualifies a label this surface does not print.",
  ),

  // ── one gate section within a direction ──────────────────────────────────
  "EvidencePanelSection.section": W(
    S.MOBILE,
    "the section list item's key attribute, and the title it selects",
  ),
  "EvidencePanelSection.clear": W(
    S.MOBILE,
    "the section's clear attribute, and the ` · clear` marker it selects",
  ),
  "EvidencePanelSection.blockerCodes": W(
    S.MOBILE,
    "one list item per blocker code, each carrying the code as an attribute",
  ),
  "EvidencePanelSection.reasons": W(
    S.MOBILE,
    "the operator sentence printed inside each blocker list item, positionally paired with its code",
  ),

  // ── the D085 dry-run panel ───────────────────────────────────────────────
  "DryRunPanelFact.label": W(
    S.MOBILE,
    "the label half of every observed, proposed and simulated fact row",
  ),
  "DryRunPanelFact.value": W(
    S.MOBILE,
    "the value half of every observed, proposed and simulated fact row",
  ),

  // ── the D085 dry-run panel's own fields ──────────────────────────────────
  /*
    PRE-DEPLOY AUDIT — reclassified N -> W by the probe, not by intent. The
    claim was that the surface prints the three fingerprints instead; the
    literal search found this version string on MOBILE in every baseline,
    because `BudgetDryRunPanel` puts it on the wrapper as `data-contract`.
    A withholding the probe can see through is a false claim, so it is
    recorded as what it is.
  */
  "MetaBudgetDryRunPanel.contractVersion": W(
    S.MOBILE,
    "the panel wrapper's data-contract attribute, which pins the schema the preview was built against",
  ),
  "MetaBudgetDryRunPanel.status": W(
    S.MOBILE,
    "selects the unavailable body or the full preview",
  ),
  "MetaBudgetDryRunPanel.unavailableReason": W(
    S.MOBILE,
    "the reason line shown when no dry run could be built",
  ),
  "MetaBudgetDryRunPanel.headline": W(S.MOBILE, "the panel heading"),
  "MetaBudgetDryRunPanel.observed.title": W(
    S.MOBILE,
    "the observed-state section heading",
  ),
  "MetaBudgetDryRunPanel.observed.note": W(
    S.MOBILE,
    "the observed-state note beneath its heading",
  ),
  "MetaBudgetDryRunPanel.proposed.title": W(
    S.MOBILE,
    "the proposed-change section heading",
  ),
  "MetaBudgetDryRunPanel.proposed.note": W(
    S.MOBILE,
    "the proposed-change note beneath its heading",
  ),
  "MetaBudgetDryRunPanel.proposed.available": W(
    S.MOBILE,
    "the availability attribute on the proposed-change note, which distinguishes an absent proposal from a refused one",
  ),
  "MetaBudgetDryRunPanel.simulated.title": W(
    S.MOBILE,
    "the simulated-result section heading",
  ),
  "MetaBudgetDryRunPanel.simulated.note": W(
    S.MOBILE,
    "the simulated-result note beneath its heading",
  ),
  "MetaBudgetDryRunPanel.simulated.available": W(
    S.MOBILE,
    "the availability attribute on the simulated-result note",
  ),
  "MetaBudgetDryRunPanel.required.title": W(
    S.MOBILE,
    "the requirements section heading",
  ),
  "MetaBudgetDryRunPanel.required.note": W(
    S.MOBILE,
    "the requirements note, printed as the blocker line",
  ),
  "MetaBudgetDryRunPanel.required.writeSafetyMissing": W(
    S.MOBILE,
    "the §10 write-safety steps this preview reports as unmet, listed by name",
  ),
  "MetaBudgetDryRunPanel.required.blockers[].code": W(
    S.MOBILE,
    "each blocker's canonical code, carried as the attribute on its own line",
  ),
  "MetaBudgetDryRunPanel.required.blockers[].why": W(
    S.MOBILE,
    "each blocker's operator sentence, printed on that line",
  ),
  "MetaBudgetDryRunPanel.required.readbackRequirement": W(
    S.MOBILE,
    "the independent read-back a real write would still owe",
  ),
  "MetaBudgetDryRunPanel.execution.executionState": W(
    S.MOBILE,
    "the execution line's state attribute and its printed value",
  ),
  "MetaBudgetDryRunPanel.execution.providerWriteAttempted": W(
    S.MOBILE,
    "the execution line's 'provider write attempted' half — false, and printed rather than implied",
  ),
  "MetaBudgetDryRunPanel.execution.providerOutcome": W(
    S.MOBILE,
    "the execution line's provider-outcome attribute and printed value",
  ),
  "MetaBudgetDryRunPanel.execution.readbackClassification": W(
    S.MOBILE,
    "the execution line's read-back classification",
  ),
  "MetaBudgetDryRunPanel.execution.nextRequirement": W(
    S.MOBILE,
    "the 'next requirement' line — what would have to become true next",
  ),
  "MetaBudgetDryRunPanel.execution.ctaLabel": W(
    S.MOBILE,
    "the label on the permanently disabled CTA",
  ),
  "MetaBudgetDryRunPanel.execution.ctaEnabled": W(
    S.MOBILE,
    "the CTA's enabled attribute, which is false and drives its disabled state",
  ),
  "MetaBudgetDryRunPanel.execution.executable": N(
    "The server's own executable flag. The surface prints `executionState`, `providerOutcome` and the disabled CTA instead: three facts an operator can check, rather than one boolean that would have to be trusted.",
  ),
  "MetaBudgetDryRunPanel.fingerprints.input": W(
    S.MOBILE,
    "the input fingerprint on the fingerprints line",
  ),
  "MetaBudgetDryRunPanel.fingerprints.policy": W(
    S.MOBILE,
    "the policy fingerprint on the fingerprints line",
  ),
  "MetaBudgetDryRunPanel.fingerprints.preflight": W(
    S.MOBILE,
    "the preflight fingerprint on the fingerprints line",
  ),

  /*
    ── the canonical decision ACTION ────────────────────────────────────────

    `MetaOsDecisionAction` became a union when D081 added the budget branch, so
    its base members surfaced in this walk for the first time. The queue prints
    the served action LABEL and searches it; the rest of the action is decision
    information the row does not print.
  */
  "MetaOsBudgetDecisionAction.intent": N(
    "Pinned to `review` by the type. A constant that cannot vary is not information an operator can act on. @see MetaOsDecisionActionBase.intent",
  ),
  "MetaOsBudgetDecisionAction.targetLevel": N(
    "Narrowed to campaign or ad set by the type. @see MetaOsDecisionActionBase.targetLevel",
  ),
  "MetaOsBudgetDecisionAction.providerMutation": N(
    "Pinned to `null` by the type: a budget review action is never dispatchable. The panel states non-executability directly. @see MetaOsDecisionActionBase.providerMutation",
  ),
  "MetaOsDecisionsPresentation.budgetReview.count": N(
    "How many budget review actions the presentation carries. The Decision Center renders the evidence panel per direction rather than a count, and a count with no list beside it is a number the reader cannot check.",
  ),

  /*
    ── the LOSSLESS canonical budget intent ─────────────────────────────────

    `MetaOsBudgetDecisionAction.budgetIntent` carries the complete operation a
    budget review action was derived from: scope, amounts in provider minor
    units, clocks, rounding, read-back and rollback plans, source digests and
    producer provenance. It exists so a review action is losslessly replayable
    and so nothing downstream has to re-derive it.

    None of it is rendered, and that is the design rather than an omission.
    The Decision Center prints the EVIDENCE panel — gate sections, the
    canonical code, the first blocker, execution readiness — which is the same
    decision stated in facts an operator can check. Printing the raw intent
    beside it would put two vocabularies for one decision on one screen, and
    the amounts specifically arrive in minor units with no scale in the
    contract, which is the same hundredfold hazard the structure surface
    already refuses.
  */
  "MetaOsBudgetIntentPayload.authorityEvidenceAsOf": N(
    "The day the role authority resolved. @see MetaOsBudgetIntentPayload.effectiveAsOf",
  ),
  "MetaOsBudgetIntentPayload.authorityStatus": N(
    "The validator's own authorised/rejected verdict. The panel prints the canonical eligibility and the first blocker instead, which say the same thing in the operator's vocabulary.",
  ),
  "MetaOsBudgetIntentPayload.blockerCodes": N(
    "The intent validator's rejection codes. The panel prints the DECISION gate blockers per section, which are the codes this surface's own contract owns.",
  ),
  "MetaOsBudgetIntentPayload.budgetField": N(
    "Daily or lifetime. Part of the proposal the account panel does not select.",
  ),
  "MetaOsBudgetIntentPayload.contractVersion": N(
    "The intent schema version. The panel prints the profile contract it consulted, which is the version an operator can reconcile against retained evidence.",
  ),
  "MetaOsBudgetIntentPayload.createdBy.contractVersion": N(
    "That producer's contract version. @see MetaOsBudgetIntentPayload.createdBy.module",
  ),
  "MetaOsBudgetIntentPayload.createdBy.module": N(
    "The module that produced the intent. Build provenance, not account evidence.",
  ),
  "MetaOsBudgetIntentPayload.currency": N(
    "The account currency of the amounts above, which this panel does not print. @see MetaOsBudgetIntentPayload.currentMinorUnits",
  ),
  "MetaOsBudgetIntentPayload.currencyExponent": N(
    "The captured minor-unit exponent for that currency. It exists so the amounts can be scaled correctly by a consumer that prints them; this surface prints none.",
  ),
  "MetaOsBudgetIntentPayload.currencyRegistry.source": N(
    "Where the minor-unit exponent came from. It qualifies a scale used on amounts this surface does not print.",
  ),
  "MetaOsBudgetIntentPayload.currencyRegistry.version": N(
    "The version of that registry. @see MetaOsBudgetIntentPayload.currencyRegistry.source",
  ),
  "MetaOsBudgetIntentPayload.currentMinorUnits": N(
    "The observed amount, in provider minor units with no scale in the contract. @see MetaOsStructureBidConfiguration.dailyBudget",
  ),
  "MetaOsBudgetIntentPayload.deltaMinorUnits": N(
    "The signed change, in provider minor units. @see MetaOsStructureBidConfiguration.dailyBudget",
  ),
  "MetaOsBudgetIntentPayload.direction": N(
    "Increase or decrease. The panel is laid out BY direction — two labelled groups — so the direction is the structure of the surface rather than a field inside it.",
  ),
  "MetaOsBudgetIntentPayload.effectiveAsOf": N(
    "The day the owner row was true. Replay provenance, not a fact a reader of the panel can act on.",
  ),
  "MetaOsBudgetIntentPayload.evidenceWindow.from": N(
    "The first day of the window the evidence spans. The page's own window pills state the window the operator selected.",
  ),
  "MetaOsBudgetIntentPayload.evidenceWindow.to": N(
    "The last day of that window. @see MetaOsBudgetIntentPayload.evidenceWindow.from",
  ),
  "MetaOsBudgetIntentPayload.executionState": N(
    "The intent's execution state. The dry-run panel prints its own execution state, provider outcome and read-back classification; two execution states on one screen could disagree.",
  ),
  "MetaOsBudgetIntentPayload.idempotencyKey": N(
    "The durable write identity a real execution would claim. Printing it beside a non-executable review would imply a claim exists.",
  ),
  "MetaOsBudgetIntentPayload.intentKey": N(
    "The canonical intent identity. It joins a review action to its replay; the surface identifies the decision by its own row, not by a second key.",
  ),
  "MetaOsBudgetIntentPayload.kind": N(
    "The payload discriminator. It selects the branch; it is not a fact about the account.",
  ),
  "MetaOsBudgetIntentPayload.knowledgeAsOf": N(
    "The point-in-time cutoff the facts were read as of. @see MetaOsBudgetIntentPayload.effectiveAsOf",
  ),
  "MetaOsBudgetIntentPayload.originDate": N(
    "The day the intent originated. The evidence panel reports the gates as of the served decision, whose own clock the row already carries.",
  ),
  "MetaOsBudgetIntentPayload.ownerMode": N(
    "Which entity owns the budget. Structural provenance for the write path; the panel states the gates, not the ownership resolution.",
  ),
  "MetaOsBudgetIntentPayload.percent": N(
    "The change magnitude as a percentage. The evidence panel is account-scoped and selects no direction, so there is no single proposal whose magnitude it could print.",
  ),
  "MetaOsBudgetIntentPayload.proposedMinorUnits": N(
    "The proposed amount, in provider minor units. @see MetaOsStructureBidConfiguration.dailyBudget",
  ),
  "MetaOsBudgetIntentPayload.readback.expectedMinorUnits": N(
    "The value that read-back would have to observe. @see MetaOsBudgetIntentPayload.readback.field",
  ),
  "MetaOsBudgetIntentPayload.readback.field": N(
    "The field an independent read-back would verify after a write. It describes a write this slice never performs; the dry-run panel states the read-back requirement in words.",
  ),
  "MetaOsBudgetIntentPayload.readback.independentRead": N(
    "That the read-back must be an independent GET. @see MetaOsBudgetIntentPayload.readback.field",
  ),
  "MetaOsBudgetIntentPayload.rollback.field": N(
    "The field that rollback would restore. @see MetaOsBudgetIntentPayload.rollback.operation",
  ),
  "MetaOsBudgetIntentPayload.rollback.operation": N(
    "The compensating operation a landed write would need. It describes a rollback for a write that cannot happen here.",
  ),
  "MetaOsBudgetIntentPayload.rollback.priorMinorUnits": N(
    "The value it would restore. @see MetaOsBudgetIntentPayload.rollback.operation",
  ),
  "MetaOsBudgetIntentPayload.rounding.applied": N(
    "Whether that rounding changed the value. @see MetaOsBudgetIntentPayload.rounding.rule",
  ),
  "MetaOsBudgetIntentPayload.rounding.exactUnrounded": N(
    "The pre-rounding amount. @see MetaOsBudgetIntentPayload.rounding.rule",
  ),
  "MetaOsBudgetIntentPayload.rounding.rule": N(
    "How a fractional amount would be rounded to minor units. It qualifies amounts this surface does not print.",
  ),
  "MetaOsBudgetIntentPayload.scope.businessId": N(
    "The workspace this intent belongs to, already the identity of the whole page.",
  ),
  "MetaOsBudgetIntentPayload.scope.entityGrain": N(
    "The grain of the target entity. The panel is account-scoped and names no entity.",
  ),
  "MetaOsBudgetIntentPayload.scope.entityId": N(
    "The target entity id. @see MetaOsBudgetIntentPayload.scope.entityGrain",
  ),
  "MetaOsBudgetIntentPayload.scope.parentCampaignId": N(
    "The parent campaign of an ad-set target. @see MetaOsBudgetIntentPayload.scope.entityGrain",
  ),
  "MetaOsBudgetIntentPayload.scope.providerAccountId": N(
    "The account, already printed in the identity header and the account inventory.",
  ),
  "MetaOsBudgetIntentPayload.sourceFingerprints.configStateHash": N(
    "A digest of the subject row the intent was built from. Provenance for replay; the panel prints the contract versions a reader can reconcile.",
  ),
  "MetaOsBudgetIntentPayload.sourceFingerprints.ownerStateHash": N(
    "A digest of the owner row. @see MetaOsBudgetIntentPayload.sourceFingerprints.configStateHash",
  ),
  "MetaOsBudgetIntentPayload.sourceFingerprints.roleAuthorityHash": N(
    "A digest of the role resolution. @see MetaOsBudgetIntentPayload.sourceFingerprints.configStateHash",
  ),
  "MetaOsBudgetIntentPayload.targetSource.source": N(
    "Which commercial target the intent read. The panel prints the profile contract and the canonical code, which is the same lineage in the vocabulary this surface uses.",
  ),
  "MetaOsBudgetIntentPayload.targetSource.version": N(
    "The version of that target. @see MetaOsBudgetIntentPayload.targetSource.source",
  ),
};

/**
 * Contracts the walk reaches but does not open, each one already owned by its
 * own surface and its own tests.
 *
 * This list is asserted, so a NEW foreign contract appearing inside the
 * Decision payload fails here rather than slipping past the matrix in the one
 * place a walk bounded by file could not see it.
 */
const EXTERNAL_BOUNDARY: ReadonlySet<string> = new Set([
  // Every lane row. Its own presentation is pinned by the adapter tests and by
  // `meta-card-utils`; the matrix classifies the ARRAYS that carry them.
  "MetaRecommendation",
  // The served status filter's value type.
  "BriefingStatusFilter",
  // The campaign role token on lane and inventory rows.
  "MetaCampaignKind",
  // The §9 read-state envelope. Its own shape is pinned by
  // `lib/meta/surface-read-state.test.ts` and its rendering by
  // `components/meta/MetaSurfaceState`; this matrix classifies the FIELD that
  // carries it, not the contract inside it.
  "MetaResponseEnvelope",
  /*
    PRE-DEPLOY AUDIT: the §10 write-safety step vocabulary, reached through the
    dry-run panel's `required.writeSafetyMissing`. It is owned by
    `lib/meta/write-safety-contract.ts` and machine-checked against the code by
    its own conformance test; this matrix classifies the FIELD that carries the
    list, not the eighteen steps inside it.
  */
  "WriteSafetyStep",
]);

/**
 * Every served VALUE the payload can carry, keyed `Interface.dotted.path`.
 *
 * The walk lives in `served-field-probe.ts` because the same walk that
 * enumerates the leaves also BUILDS a payload carrying every one of them —
 * one walk, so the keys this matrix classifies and the keys the proof below
 * probes can never be two different sets.
 *
 * Only leaves are keyed. A member whose type is another contract interface is
 * a container: its own members are classified under that interface, and
 * classifying the container too would ask for the same answer twice. `[]`
 * marks an array element and `{}` a Record value, so the shape of the path
 * matches the shape of the data.
 */
function servedFields(): {
  fields: readonly ServedField[];
  externals: ReadonlySet<string>;
} {
  return servedFieldWalk();
}

describe("Meta Decision payload · served-field coverage matrix", () => {
  const { fields, externals } = servedFields();

  it("walks the whole payload, and pins its size exactly", () => {
    /*
     * A parser change that silently stopped walking would make every other
     * assertion in this file pass by finding nothing — so the size is checked.
     *
     * WHY EXACT AND NOT A FLOOR. The floor this replaced was ">400 fields,
     * >30 interfaces": the walk really produces 544 and 45, so a regression
     * that dropped a hundred and thirty leaves — a whole interface's worth of
     * them, every one classified as withheld for the wrong reason — cleared it
     * with room to spare. A floor 25% below the truth is not a tripwire.
     *
     * HOW TO UPDATE IT. Deliberately, in the same commit that changes the
     * contract, and only after the "classifies every served field" and "keeps
     * no classification for a field the payload no longer serves" assertions
     * have NAMED the field that appeared or left. If a contract change moves
     * these numbers and nothing else in this file changed, the walk is broken,
     * not the numbers.
     *
     * `varies` is pinned too: it is the count the probe can actually mutate,
     * and the rest are proven by their literal instead. A leaf silently
     * becoming pinned would move a claim from the strong proof to the weak one
     * with nothing said.
     */
    /*
      PRE-DEPLOY AUDIT: 647 -> 757 leaves, 54 -> 63 interfaces, 620 -> 707
      varying. The increase is the two served branches the walk could not enter
      at all before — `system.budgetEvidence` and `system.budgetDryRun`, whose
      contracts lived in unopened files — plus the canonical decision ACTION,
      whose union type stopped the walk at its alias — and the independent
      automatic-role authority numerator. Every new leaf was NAMED
      by "classifies every served field" before these numbers moved, which is
      the order the paragraph above requires.
    */
    /*
      759: two `never` markers, from the canonical action's new bid branch.

      They are exclusions rather than data — a bid action cannot also carry a
      budget payload, and the legacy branch can carry neither — so the varying
      count is unchanged. A leaf that cannot hold a value never varies.

      MERGE NOTE (origin/main, PR #275): main still carries 757 here, which was
      correct for main's tree and is not correct for this one. The two extra
      leaves come from THIS branch's canonical bid action, so the merged tree
      has 759. The number is asserted, not chosen: the walk below counts it.
    */
    expect(fields.length).toBe(759);
    expect(new Set(fields.map((field) => field.iface)).size).toBe(62);
    expect(fields.filter((field) => field.varies).length).toBe(707);
    expect(fields.some((field) => field.key.endsWith(".metrics.cpa"))).toBe(
      true,
    );
  });

  it("classifies every served field", () => {
    const unclassified = fields
      .map((field) => field.key)
      .filter((key) => !COVERAGE[key])
      .sort();
    // A new field on any of the four contracts lands here. Classify it as
    // RENDERED, WIRED-NOW or INTENTIONALLY-NOT-RENDERED — the third is a real
    // answer, an empty one is not.
    expect(unclassified).toEqual([]);
  });

  it("keeps no classification for a field the payload no longer serves", () => {
    const served = new Set(fields.map((field) => field.key));
    const stale = Object.keys(COVERAGE)
      .filter((key) => !served.has(key))
      .sort();
    expect(stale).toEqual([]);
  });

  it("makes every rendered claim name a surface a reader can open", () => {
    const bad = Object.entries(COVERAGE)
      .filter(
        ([, value]) =>
          value.classification !== "INTENTIONALLY-NOT-RENDERED" &&
          !SURFACES.has(value.where),
      )
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it("makes every withholding a stated reason rather than a shrug", () => {
    const weak = Object.entries(COVERAGE)
      .filter(
        ([, value]) => value.classification === "INTENTIONALLY-NOT-RENDERED",
      )
      .filter(
        ([, value]) =>
          value.where !== "" ||
          value.note.trim().length < 60 ||
          /^(n\/a|none|unused|todo|tbd|not needed)\b/i.test(value.note.trim()),
      )
      .map(([key]) => key);
    expect(weak).toEqual([]);
  });

  it("states which foreign contracts the payload reaches into", () => {
    // A new foreign contract inside the Decision payload is a coverage gap the
    // file-bounded walk cannot see on its own, so it is named here instead.
    expect([...externals].sort()).toEqual([...EXTERNAL_BOUNDARY].sort());
  });

  it("carries no field that is rendered and withheld at the same time", () => {
    for (const [key, value] of Object.entries(COVERAGE)) {
      if (value.classification === "INTENTIONALLY-NOT-RENDERED") {
        expect(value.where, key).toBe("");
      } else {
        expect(value.note.trim().length, key).toBeGreaterThan(0);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * THE PROOF
 *
 * Everything above this line enforces that every served field HAS an answer.
 * Nothing above this line can tell whether the answer is TRUE: a RENDERED
 * entry was checked against a list of sixteen surface names, so a field marked
 * rendered at a surface that never reads it passed exactly as loudly as one
 * the operator can actually see. A coverage test that cannot fail certifies
 * the gap it was written to close.
 *
 * WHAT IS PROVEN HERE, for every classified field, WITHOUT consulting the
 * table above:
 *
 *   RENDERED / WIRED-NOW  changing the field changes what the NAMED surface
 *                         produces. The whole payload is built from the
 *                         contract source (`served-field-probe.ts`), the real
 *                         adapters and the real page are run over it, and the
 *                         run is repeated with that ONE leaf carrying a
 *                         different value everywhere it occurs. Same output =
 *                         the field reached nothing, and the claim fails.
 *
 *   INTENTIONALLY-        changing the field changes NO surface's output. A
 *   NOT-RENDERED          withholding that is merely asserted is worth
 *                         nothing; this is the same probe read the other way.
 *
 * WHY A CHANGE AND NOT A SENTINEL. A sentinel token proves a pass-through and
 * nothing else: a ratio, a formatted money string, a tone, a count and a gate
 * all carry a served field to the screen without carrying its text. The probe
 * therefore asserts the OBSERVABLE RESULT of whatever transform the field
 * feeds — and for the leaves whose value is a free string it is a sentinel
 * anyway, because a unique token is what the alternate value is.
 *
 * WHERE A CHANGE IS IMPOSSIBLE. Some leaves the contract pins to ONE value
 * (`attribution: "meta_attributed"`, a `typeof CONTRACT_VERSION`). Nothing can
 * be varied there, so those are proven by the literal's own text appearing —
 * or, for a withheld one, not appearing — in the named surface, and the ones
 * whose literal is too common for a text search to decide are named in
 * `PINNED_BEYOND_TEXT_PROOF` rather than passed over in silence.
 *
 * PROVIDER WRITES. The probe runs adapters and a server render. It performs no
 * mutation: the only callbacks it supplies are recorders, and the page is
 * rendered to static markup with no event loop, no client and no network.
 */

const state = vi.hoisted(() => ({
  workspace: null as unknown,
  accounts: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/platforms/meta",
  useSearchParams: () => new URLSearchParams("window=28d"),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (input: unknown) => unknown) =>
    selector({ businesses: [], selectBusiness: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (input: { queryKey: unknown[] }) => {
    const key = String(input.queryKey[0]);
    const data =
      key === "meta-decisions-workspace"
        ? state.workspace
        : key === "meta-provider-accounts"
          ? state.accounts
          : null;
    return { data, isLoading: false, isError: false, error: null };
  },
}));

/*
 * The Decision Center itself renders NOTHING inside the page probe.
 *
 * Its twelve surfaces are observed directly from the view model it is handed,
 * so leaving it mounted here would fold every one of them into the two
 * surfaces this render exists to observe — the workspace banners and the
 * mobile posture panels — and a field rendered in the KPI strip would "prove"
 * itself in the banner strip.
 */
vi.mock(
  "@/components/meta/decision-center/MetaDecisionCenterExact",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/meta/decision-center/MetaDecisionCenterExact")
    >()),
    MetaDecisionCenterExact: () => null,
  }),
);

/** The probe's name for each surface the matrix's `where` vocabulary admits. */
const PROBE_SURFACE: Record<string, string> = {
  [S.HEADER]: "HEADER",
  [S.KPI]: "KPI",
  [S.PILLS]: "PILLS",
  [S.ACTION]: "ACTION",
  [S.WATCHING]: "WATCHING",
  [S.HEALTHY]: "HEALTHY",
  [S.NONSALES]: "NONSALES",
  [S.ARCHIVE]: "ARCHIVE",
  [S.CREATIVES]: "CREATIVES",
  [S.POSTURE]: "POSTURE",
  [S.INSPECTOR]: "INSPECTOR",
  [S.PROVENANCE]: "PROVENANCE",
  [S.INVENTORY]: "INVENTORY",
  [S.BANNERS]: "BANNERS",
  [S.MOBILE]: "MOBILE",
  [S.EVIDENCE]: "EVIDENCE",
  [S.COVERAGE]: "COVERAGE",
};

/**
 * The account states the probe runs against.
 *
 * One "everything present" payload cannot prove a FALLBACK — the spelling that
 * only speaks when the preferred one is absent stays silent, and its RENDERED
 * claim would look false — and it cannot prove a GATE, because the gate never
 * opens. Each scenario below is a state a real account arrives in. The
 * mutation always wins over a scenario's own erasure or pin, which is what
 * lets one scenario silence a whole fallback chain and still give every member
 * of that chain its turn.
 */
const SCENARIOS: readonly ProbeScenario[] = [
  { name: "full" },
  {
    // Grandmix: sixty served ads, not one of which joins a decision snapshot.
    // Everything the row carries has to come off the served decision.
    name: "noEnvelope",
    empty: [
      "decisionReadModel.queue.adCandidates.items",
      "decisionReadModel.queue.inactiveAssets.items",
      "decisionReadModel.queue.sections.integrity_fires.items",
      "decisionReadModel.queue.sections.money_moves.items",
      "decisionReadModel.queue.sections.creative_rotation.items",
    ],
  },
  {
    // The preferred spelling of every fact that has more than one.
    name: "fallback",
    erase: [
      "MetaDecisionsWorkspaceReadModel.source.snapshotAsOf",
      "MetaDecisionsWorkspaceReadModel.source.engineVersion",
      "MetaDecisionsWorkspaceReadModel.source.computedAt",
      "MetaDecisionsWorkspaceReadModel.source.fallbackReason",
      "MetaDecisionsWorkspaceReadModel.queue.sourcePreCapCount",
      "MetaLanePayload.snapshotDate",
      "MetaOsDecisionsPresentation.source.snapshotAsOf",
      "MetaOsDecisionsPresentation.source.engineVersion",
      "MetaOsDecisionsPresentation.source.fallbackReason",
      "MetaDecisionsWorkspacePayload.system.engineVersion",
      "MetaDecisionsWorkspacePayload.system.currency",
      "MetaOsDecisionMetrics.spend",
      "MetaOsDecisionMetrics.roas",
      "MetaOsDecisionMetrics.purchases",
      "MetaOsDecisionMetrics.cpa",
      "MetaOsDecisionMetrics.ctr",
      "MetaOsDecisionMetrics.frequency",
      "MetaOsDecisionMetrics.effectiveTargetRoas",
      "MetaOsDecisionMetrics.ratioToTarget",
      "MetaOsDecisionMetrics.currency",
      "MetaOsAdDecision.rawLabel",
      "MetaOsAdDecision.creativeFormat",
      "MetaOsAdDecision.fatigueStatus",
      "MetaOsAdDecision.riskTier",
      "MetaCanonicalDecision.riskTier",
      "MetaPulsePayload.currency",
      "MetaHealthyEntity.campaignId",
      "MetaHealthyEntity.bidStrategyLabel",
      "MetaArchivedEntity.statusLabel",
      "MetaArchivedEntity.diagnosticNote",
      "MetaStructureInventoryEntity.statusLabel",
      "MetaOsStructureBidConfiguration.strategyLabel",
      "MetaCanonicalDecision.sourceSnapshotId",
    ],
  },
  {
    // Ad-set grain. Half of these rows render through a different branch than
    // a campaign does — the parent lineage column, the group with no campaign
    // row in it — and that branch is invisible at campaign grain.
    name: "adsetGrain",
    erase: ["MetaStructureInventoryEntity.campaignName"],
    force: {
      "MetaHealthyEntity.level": "adset",
      "MetaStructureInventoryEntity.level": "adset",
      "MetaArchivedEntity.level": "adset",
      "MetaOsStructureNode.level": "adset",
      // The node joins the Watching row rather than the Action Now row.
      "MetaOsStructureNode.sourceRecommendationId": "rec_probe_watch",
      // A segment key the Watching band actually has a slot for.
      "MetaWatchingSegment.key": "learning",
      // The target line only carries a qualifier when freshness is unknown.
      "MetaPulsePayload.roas.targetFreshness": "unknown",
    },
  },
  {
    // No served banners, so the page's own fallback synthesis runs — the only
    // path on which the pulse's readiness, tracking and snapshot health reach
    // a banner at all.
    name: "noServedBanners",
    empty: ["banners"],
  },
  {
    /*
     * The business unit with no commercial-truth target at all.
     *
     * The pulse serves the account median it MEASURED, a null target, and
     * `target_source: "account_median"` to say which of the two is in force
     * (app/api/meta/account-pulse/route.ts:199-207). Without this scenario the
     * probe never left the first member of that union, so every claim and
     * every guard about the median arm was measured in a state the arm does
     * not occur in — and one of them, the `WITHHELD_BY_DEFECT` loop, was
     * advertised as a tripwire while being unable to fire. @see
     * WITHHELD_BY_DEFECT
     */
    name: "accountMedianReference",
    force: {
      "MetaPulsePayload.roas.target_source": "account_median",
      "MetaPulsePayload.roas.target": null,
    },
  },
  {
    /*
     * The account with neither: no commercial truth and no median to fall back
     * on, which the server answers with `target_source: "none"` and two nulls
     * (route.ts:209-214). This is the ONE arm where the tile is allowed to say
     * "we could not tell", so it is also the arm that has to be observed
     * before that em dash can be called correct rather than assumed.
     */
    name: "noRoasReference",
    force: {
      "MetaPulsePayload.roas.target_source": "none",
      "MetaPulsePayload.roas.target": null,
      "MetaPulsePayload.roas.median": null,
    },
  },
  {
    /*
     * THE DEMO BUSINESS UNIT, WHICH IS THE ARM THE EVIDENCE-SOURCE BANNER
     * EXISTS FOR AND THE ONE THE PROBE COULD NOT REACH ON ITS OWN.
     *
     * `MetaPulsePayload.dataReadiness.evidenceSource` is typed as a bare
     * `string` (components/meta/redesign/types.ts:69), so the probe's sentinel
     * lands on the notice's LAST branch — "a token this page cannot read" —
     * and the demo branch, the one `metaEvidenceSourceNotice` was written for,
     * never runs. Pinning a claim to a branch the fixture cannot enter is how
     * the `WITHHELD_BY_DEFECT` guard spent a whole round unable to fire.
     *
     * The readiness pair is forced HEALTHY on purpose. `lib/meta/campaigns-
     * source.ts:65-72` returns `status: "ok"` and `isPartial: false` around
     * demo rows, so on a demo account the readiness banner
     * (`status !== "ok" || isPartial`) does not fire and the disclosure is the
     * ONLY thing standing between the operator and fabricated figures drawn in
     * the format measured ones use. The probe's boolean base is `true`, which
     * would have put a readiness banner up beside it and made the arm look
     * milder than it is.
     */
    name: "demoEvidence",
    force: {
      "MetaPulsePayload.dataReadiness.evidenceSource": "demo",
      "MetaPulsePayload.dataReadiness.status": "ok",
      "MetaPulsePayload.dataReadiness.isPartial": false,
    },
  },
  {
    /*
     * The account whose numbers ARE a measurement of itself.
     *
     * `metaEvidenceSourceNotice` returns null for the six tokens in
     * `META_MEASURED_EVIDENCE_SOURCES`, and until this scenario existed no
     * state the probe built ever took that return: the sentinel is an
     * unrecognised token in all eight of the others, so the banner was up in
     * every observation and its SILENCE — the whole point of a disclosure —
     * was never observed. A notice that cannot be observed absent is not
     * proven to be conditional on anything.
     */
    name: "measuredEvidence",
    force: {
      "MetaPulsePayload.dataReadiness.evidenceSource": "warehouse",
    },
  },
  {
    /*
     * THE ACTION DIGEST THAT FITS INSIDE ITS OWN ROW CAP.
     *
     * The silent-failure banner has two widths and the payload chooses between
     * them: `MetaDecisionsDigest.actions.countsTruncated` (MetaPlatformPage.ts
     * :2386) switches the title between a COUNT ("2 recorded actions ended
     * without a verified outcome.") and a FLOOR ("At least 2 ..."), and the
     * detail between "carries M recorded actions" and "counts only its M most
     * recent recorded actions ... The window may hold more recorded actions than
     * this count covers".
     *
     * WHY A STATE AND NOT JUST THE MUTATION. The probe's boolean rule is base
     * `true` / alt `false` (served-field-probe.ts:617), so EVERY scenario's
     * baseline arrives truncated and the narrow sentence — the one the banner
     * has printed since it was written — is reached by no state at all. The
     * mutation run does enter it, which is what proves the leaf varies, but a
     * mutation is a diff between two texts nobody reads: it can tell you the
     * sentence changed and not that either sentence is right. Pinning a claim
     * to a branch no fixture enters is exactly how the ROAS reference guard
     * spent a round unable to fire. @see SCENARIOS.accountMedianReference
     *
     * So the untruncated arm gets a state, and the test named "observes both
     * widths of the silent-failure banner's sentence" reads BOTH out of the
     * rendered strip: the floor and the cap clause from a truncated baseline,
     * the plain count and the ABSENCE of the cap clause from this one. Delete
     * this scenario and that second half has nowhere to look.
     *
     * Nothing else in the payload branches on the flag, so this state is the
     * digest's sentence and nothing more.
     */
    name: "untruncatedActionDigest",
    force: {
      "MetaDecisionsDigest.actions.countsTruncated": false,
    },
  },
  {
    // Every "we could not" the payload can say at once.
    name: "degraded",
    empty: ["banners"],
    // A digest that cannot name the day its counts start from. The silent-
    // failure notice omits its " since <date>" phrase here, which is the only
    // state in which the omission can be observed at all.
    erase: ["MetaDecisionsDigest.snapshotDate"],
    force: {
      "MetaDecisionCapabilityState.status": "unavailable",
      "MetaDecisionsWorkspaceReadModel.status": "unavailable",
      "MetaDecisionsWorkspaceReadModel.source.status": "unavailable",
      "MetaDecisionsWorkspaceReadModel.source.authority": "unavailable",
      "MetaSnapshotHealth.status": "stale",
      "MetaPulsePayload.trackingHealth.status": "blocked",
      // Readiness is partial-free here so the STATUS alone decides the banner;
      // `isPartial` gets its own turn in the scenario above, where it does.
      "MetaPulsePayload.dataReadiness.isPartial": false,
      "MetaDecisionHistoryEnvelope.events.status": "unavailable",
      "MetaDecisionHistoryEnvelope.outcomes.status": "unavailable",
      "MetaDecisionHistoryEnvelope.responses.status": "unavailable",
      "MetaDecisionHistoryEnvelope.providerWrites.status": "unavailable",
      "MetaDecisionMediaEnvelope.state": "missing",
      "MetaDecisionMediaEnvelope.thumbnail.state": "missing",
      "MetaOsAdDecision.lane": "blocked",
      "MetaOsAdDecision.decisionAvailability": "pending_native_evidence",
      "MetaDecisionSourceAuthority.status": "legacy_review_only",
      "MetaDecisionSourceAuthority.actionEligible": false,
    },
  },
  {
    /*
     * PRE-DEPLOY AUDIT — THE BUDGET PANELS' OTHER ARM.
     *
     * Six budget leaves reached no surface in any scenario above, and the
     * first draft of this pass excused them in a register: "rendered only
     * when the panel is unavailable / the section is not clear, and the
     * fixture never builds that state". That is the empty-fixture argument
     * this file was written to refuse — an excuse is not a measurement, and a
     * branch nothing constructs is a branch nothing checks.
     *
     * So the state is constructed instead. `BudgetDecisionEvidencePanel`
     * prints `unavailableReason` only under `status === "unavailable"`, and
     * `section.blockerCodes` / `section.reasons` only for a section whose
     * `clear` is false. `BudgetDryRunPanel` prints its own reason AND
     * `required.note` on the same unavailable arm. One scenario reaches all
     * five, and they are now proven the way every other claim here is.
     */
    name: "budgetUnavailable",
    force: {
      // Only the three GATES are pinned. The reasons themselves are left to
      // the probe: `leafValueFor` lets a mutation win over a force, so each of
      // them still gets its own turn under test in this very scenario.
      "MetaBudgetDecisionEvidencePanel.status": "unavailable",
      "MetaBudgetDryRunPanel.status": "unavailable",
    },
  },
  {
    /*
     * PRE-DEPLOY AUDIT — and the section arm, which needs the OPPOSITE state.
     * An unavailable evidence panel returns before it renders `sections` at
     * all, so the not-clear branch is only reachable while the panel is
     * resolved. Measured, not reasoned: with both gates in one scenario the
     * two section leaves still reached nothing.
     */
    name: "budgetSectionBlocked",
    force: {
      "EvidencePanelSection.clear": false,
    },
  },
];

/**
 * The scenarios the PAGE is rendered for: all of them.
 *
 * This used to be three of six — the full payload, the degraded one and the
 * one with no served banners — on the argument that "rendering the page for
 * the other three would add nothing but seconds". That argument was never
 * measured, and an unmeasured exclusion is exactly the shape of the empty
 * fixture that inflated this file's own absence count. It was measured: with
 * the page rendered in EVERY scenario the set of leaves reaching no surface is
 * identical, and the run costs about two seconds more. The argument was true.
 *
 * It is kept as an equality rather than as a list anyway, because the version
 * that is true costs two seconds and the version that is asserted costs a
 * caveat on every count this file prints: "reaches nothing" now means "reaches
 * nothing in any state the probe can build", with no surface excused from
 * looking.
 */
const PAGE_SCENARIOS = new Set(SCENARIOS.map((scenario) => scenario.name));

const PROBE_NOW = "2026-03-30T12:00:00.000Z";

/**
 * How each surface's RENDERED and WIRED-NOW claims are proven:
 * `[proven at the element, proven at the surface alone]`.
 *
 * A surface-level claim says "this field moves something on that panel"; an
 * element-level one says "it moves THAT labelled row". The second caught a
 * claim naming the right panel and the wrong line on it
 * (`MetaOsAdDecision.resolution.code`), which is why the split is worth
 * stating rather than averaging. @see Coverage.element
 */
const ELEMENT_PROOF_BY_SURFACE: Record<string, [number, number]> = {
  // D078 R4 (correction 2): eleven surface-level claims (timezone and the
  // authorized-rows suffix added); the panel has no keyable row ids.
  COVERAGE: [0, 11],
  // PRE-DEPLOY AUDIT — 10 -> 9. `MetaOsDecisionActionBase.intent` was recorded
  // as the action button's TONE; the probe shows the tone follows
  // `providerMutation`, and `intent` moves the 'Served action' row instead.
  ACTION: [0, 9],
  ARCHIVE: [0, 10],
  BANNERS: [0, 25],
  CREATIVES: [0, 14],
  EVIDENCE: [94, 22],
  HEADER: [0, 10],
  HEALTHY: [0, 10],
  // Five more claims on this panel, none of them keyed to a stable row id:
  // the provenance band is one band, not a table of rows.
  INSPECTOR: [2, 14],
  INVENTORY: [0, 14],
  KPI: [0, 22],
  // PRE-DEPLOY AUDIT — 6 -> 59: the budget evidence, gate and dry-run panels
  // render here. Element-level stays 0 by construction (see
  // SURFACES_WITHOUT_ELEMENT_IDS), not by omission.
  MOBILE: [0, 59],
  NONSALES: [0, 1],
  PILLS: [0, 8],
  POSTURE: [2, 0],
  PROVENANCE: [97, 5],
  WATCHING: [0, 3],
};

/**
 * THE SAME SPLIT AGAIN, FROM THE OTHER SIDE: how many claims the rendered DOM
 * carries, and how many rest on a view model alone.
 *
 * `[proven in the default render's DOM, proven at the view model only]`. The
 * second column is not a defect list — a lane behind a tab, a scope behind
 * another tab, the inspector before a row is picked and the evidence window
 * before it is opened are all real rendering that a default `renderToStatic-
 * Markup` never reaches. It is the honest size of the distance between
 * "reaches the view model that feeds a panel" and "an operator can see it".
 */
const DOM_PROOF_BY_SURFACE: Record<string, [number, number]> = {
  // Drawn by the desktop component in the state the page mounts in, and
  // therefore proven in rendered HTML rather than in a view model.
  // PRE-DEPLOY AUDIT — 10 -> 9: `MetaOsDecisionActionBase.intent` moves the
  // evidence window's 'Served action' row, not the queue button's tone.
  ACTION: [9, 0],
  HEADER: [10, 0],
  KPI: [22, 0],
  PILLS: [8, 0],
  // Partly: the inspector's own facts render, the ones it only shows for a
  // selected creative do not; the Creatives queue and the source panel sit
  // behind the scope tabs and show only what the resting scope draws.
  CREATIVES: [2, 12],
  // The provenance band put five payload leaves in this panel's DOM that had
  // never reached a screen: the evidence window's two dates, the engine write
  // time, and the two metrics whose ABSENCE the gap line now names.
  INSPECTOR: [9, 6],
  PROVENANCE: [50, 50],
  WATCHING: [1, 2],
  // Behind a lane tab the default render never presses. This is the whole
  // demonstration: ARCHIVE's claims are real and none of them is in the DOM
  // of a page nobody has clicked yet.
  ARCHIVE: [0, 10],
  HEALTHY: [0, 10],
  NONSALES: [0, 1],
  POSTURE: [1, 1],
  // Drawn by a DIFFERENT component than this channel renders: the inventory
  // table and the creative evidence window are their own surfaces, and the
  // banner strip and the mobile panels are already observed as HTML in their
  // own right, so a zero here says "not this component" and not "not on
  // screen".
  BANNERS: [0, 25],
  EVIDENCE: [1, 111],
  INVENTORY: [0, 14],
  // PRE-DEPLOY AUDIT — 0 -> 40 in the DOM: the budget evidence, gate and
  // dry-run panels are drawn by the default render, so their claims are
  // proven in rendered HTML rather than in a view model.
  MOBILE: [40, 6],
  // D078 R4 (correction 2): the coverage PANEL renders every one of its
  // eleven leaves as visible text in the resting desktop DOM — including
  // the policy sentence and timezone that correction 1 hid or dropped.
  COVERAGE: [11, 0],
};

/** `[in the DOM, view model only]`, over every claim whose field can vary. */
// PRE-DEPLOY AUDIT — [120, 248] -> [159, 249]. The budget panels render in
// the default markup, so 39 of their claims are proven in the DOM rather than
// in a view model; one more sits behind a control.
const DOM_PROOF_TOTALS: [number, number] = [164, 248];

/** Claims on leaves the contract pins to one value, which cannot be varied. */
// PRE-DEPLOY AUDIT — 7 -> 20. Thirteen more claims sit on leaves the budget
// contracts pin in the TYPE (`ctaEnabled: false`, `intent: "review"`,
// `executionState: "validated_only"`, …), which the probe cannot vary.
const DOM_PROOF_PINNED_LEAVES = 20;

/**
 * Leaves the probe varies that move NO surface, in any scenario.
 *
 * Pinned so the file's largest claim is a number a reader can check rather
 * than a feeling. @see the test that reads it for what it does and does not
 * mean.
 */
// PRE-DEPLOY AUDIT — 252 -> 298. The 46 are budget contract leaves the two
// panels do not print: the intent envelope's idempotency, rollback and
// read-back plumbing, the gate verdict's internal codes, and the dry-run's
// server-side executable flag. Each is classified with its own reason above;
// this is their total.
const NOWHERE_LEAVES = 295;

/**
 * Of those, the ones that DO reach the callback boundary — the served tuple
 * handed to `onCreativeReview` and friends. Reaching a callback is not
 * rendering and no classification in this file may rest on it; the count is
 * kept so "it travels to the boundary" is written down rather than confused
 * with a pixel.
 */
const NOWHERE_BUT_AT_THE_BOUNDARY = 54;

/** The one character every surface in this app prints for "unserved". */
const EM_DASH = "\u2014";

interface ProbeOutcome {
  /** Surfaces whose rendered output changed when this field changed. */
  readonly display: readonly string[];
  /** `SURFACE#rowId` for every labelled row whose own value changed. */
  readonly elements: readonly string[];
  /** Whether a served callback's arguments changed. Never proof of rendering. */
  readonly callback: boolean;
  /**
   * Whether the DESKTOP DECISION CENTRE'S RENDERED HTML changed.
   *
   * Its own channel, like `callback`, and for the opposite reason: it is
   * STRONGER than a surface, not weaker. Fourteen of the sixteen surfaces are
   * serialised view models, so "reaches a surface" means "reaches the view
   * model that feeds a panel" and not "an operator can see it"; this channel
   * is the part of the page a default render really puts in the DOM. It is
   * reported rather than required, because the panels the default render does
   * NOT open — the lanes behind a tab, the scopes behind another, the
   * inspector before a row is picked — are real rendering too.
   * @see the test that reports the split
   */
  readonly dom: boolean;
}

function serialiseSurface(node: unknown): string {
  return (
    JSON.stringify(node, (_key, value) =>
      typeof value === "function" ? "[fn]" : value,
    ) ?? "undefined"
  );
}

/**
 * The surfaces whose rows carry no id the probe can key on.
 *
 * BANNERS and MOBILE are observed as rendered HTML rather than as view models,
 * and the twelve Decision Center surfaces that are view models mostly emit
 * chips, tones and sub-lines rather than labelled rows. Naming them here is
 * the honest version of "this claim is proven at the surface, not the element";
 * the alternative — an element id invented for a line that has none — would be
 * a proof of nothing dressed as the strongest kind of proof in the file.
 */
const SURFACES_WITHOUT_ELEMENT_IDS: ReadonlySet<string> = new Set([
  "BANNERS",
  "MOBILE",
]);

/**
 * Every labelled row one surface emits, keyed `SURFACE#id`.
 *
 * A row is a `{ id, label?, value? }` object anywhere inside the surface's view
 * model — the evidence window's `facts`, `authority` and `diagnostics`, and the
 * source panel's `source`, `coverage`, `suppression` and `limitations` groups
 * all have that shape, and so does anything later given it. Rows are found by
 * SHAPE rather than by a hard-coded list of paths, so a new group of facts is
 * keyable the day it is written rather than the day someone remembers to add
 * it here.
 *
 * Duplicate ids on one surface are joined rather than overwritten: the evidence
 * window is observed in three served states at once, and dropping two of the
 * three would silently narrow the proof to the first.
 *
 * A row must be FLAT — every one of its own values a primitive. The Creatives
 * queue's group headers carry `{ id, label, rows }`, and keying on one of those
 * would let any change to any row inside it "prove" the group header moved,
 * which is the surface-level proof again under a more precise-sounding name.
 */
function isFlatRow(record: Record<string, unknown>): boolean {
  return Object.values(record).every(
    (value) => value === null || typeof value !== "object",
  );
}

function collectLabelledRows(
  surface: string,
  node: unknown,
  sink: Record<string, string>,
): void {
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const id = record.id;
    if (
      typeof id === "string" &&
      id.length > 0 &&
      ("label" in record || "value" in record) &&
      isFlatRow(record)
    ) {
      const key = `${surface}#${id}`;
      const text = serialiseSurface(record);
      sink[key] = sink[key] === undefined ? text : `${sink[key]}|${text}`;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(node);
}

/**
 * One element of the rendered page, by the test id it carries.
 *
 * Slicing rather than matching the whole document keeps the banner strip and
 * the mobile panels apart from each other and from the account inventory that
 * shares the page with them.
 */
function elementHtml(html: string, marker: string): string {
  const index = html.indexOf(marker);
  if (index < 0) return "";
  const open = html.lastIndexOf("<", index);
  const tagMatch = /^<([a-zA-Z0-9-]+)/.exec(html.slice(open));
  if (!tagMatch) return "";
  const tag = tagMatch[1]!;
  const openRe = new RegExp(`<${tag}[\\s>]`, "g");
  const closeRe = new RegExp(`</${tag}>`, "g");
  let depth = 0;
  let cursor = open;
  for (;;) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) return html.slice(open);
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + 1;
      continue;
    }
    depth -= 1;
    cursor = nextClose.index + 1;
    if (depth === 0) return html.slice(open, nextClose.index + tag.length + 3);
  }
}

/**
 * What the served tuple carries to the callback boundary.
 *
 * Kept as its OWN channel and never mixed into a surface, because handing a
 * served object to a callback is not rendering it: the whole decision travels
 * through `onCreativeReview`, and folding that into the Creatives queue's
 * output would let every field of every decision "prove" itself there. It
 * proves exactly one thing — that a value reached the boundary — and NO
 * classification in this file is allowed to rest on it. It is recorded, in
 * `NEGATIVE_CLAIM_PINS`, so that "it also travels to the boundary" is written
 * down rather than mistaken for a pixel.
 *
 * The callbacks are recorders. Nothing here can reach a provider.
 */
function callbackChannel(payload: MetaDecisionsWorkspacePayload): string {
  const recorded: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      recorded.push(`${name}:${JSON.stringify(args)}`);
    };
  const viewModel = buildMetaDecisionCenterExactViewModel({
    workspace: payload,
    now: PROBE_NOW,
    overrides: { creativeCtrSeriesByAdId: probeCtrSeries },
    callbacks: {
      onStructurePrimary: record("structurePrimary"),
      onStructureMenu: record("structureMenu"),
      onWatchingReview: record("watchingReview"),
      onCreativeReview: record("creativeReview"),
    },
  });
  JSON.stringify(viewModel, (_key, value) => {
    if (typeof value !== "function") return value;
    try {
      (value as () => void)();
    } catch (error) {
      recorded.push(`threw:${(error as Error).message}`);
    }
    return "[fn]";
  });
  return recorded.join("|");
}

/**
 * The ad-grain reads the evidence window is opened with.
 *
 * WHY THESE EXIST. The window was observed with `adRows: []` and
 * `adSeries: { adCount: 0, points: [] }` — a resolved-but-empty helper read —
 * so every branch that only runs when the ad-grain read DID resolve (the
 * grouped ad-set card, the funnel's impression, click and add-to-cart counts,
 * the impression-weighted thumbstop, the first-seen date, the CTR and
 * frequency trails) was never entered, and any leaf that reached the operator
 * only through one of them would have been counted as reaching nowhere. That
 * is a fixture artefact wearing the costume of a measurement.
 *
 * WHAT MEASURING IT ACTUALLY SHOWED. Populating both reads moves the count of
 * leaves reaching no surface by ZERO: 252 before, 252 after. The reason is
 * structural rather than lucky — `adRows` and `adSeries` are a SEPARATE read
 * (`/api/meta/creatives` and `/api/meta/ads/series`), not part of the
 * decisions workspace payload this file walks, so no served leaf travels
 * through them. The branches they gate consume row data plus payload fields
 * that already reach the window through the empty-read fallback. The suspicion
 * was worth measuring and the honest result is that it cost nothing.
 *
 * WHY BOTH STATES ARE OBSERVED AND NOT JUST THE POPULATED ONE. Replacing the
 * empty read instead of adding to it was measured too, and it LOSES a proof:
 * with rows carrying their own `purchases`, `buildFunnel` sums the rows and
 * `MetaCanonicalDecision.metrics.purchases` stops reaching the funnel, taking
 * the count of leaves reaching nowhere from 252 to 253 and turning a proven
 * RENDERED claim into an unprovable one. The empty read is not a degenerate
 * fixture, it is the state every account is in until the helper read lands,
 * and the fallbacks it opens are real rendering. So the window is observed in
 * both, and a field that moves in either one counts.
 *
 * These rows are CONSTANTS and are deliberately not derived from the probe
 * payload. A fixture that echoed a served field back into the window would let
 * that field "prove" itself against the test's own hand.
 */
const PROBE_AD_ROWS: readonly CreativeEvidenceWindowExactAdRow[] = [
  {
    id: "probe-ad-row-a",
    adsetId: "probe-adset-a",
    adsetName: "Probe ad set A",
    spend: 4210.5,
    purchaseValue: 12631.5,
    roas: 3,
    impressions: 240_000,
    linkClicks: 5400,
    addToCart: 820,
    purchases: 140,
    thumbstop: 31.5,
    launchDate: "2026-02-11",
  },
  {
    id: "probe-ad-row-b",
    adsetId: "probe-adset-b",
    adsetName: "Probe ad set B",
    spend: 1180.25,
    purchaseValue: 1770.375,
    roas: 1.5,
    impressions: 60_000,
    linkClicks: 900,
    addToCart: 110,
    purchases: 18,
    thumbstop: 19.25,
    launchDate: "2026-03-02",
  },
];

/** A full 28-day trail, the length the card's own caption names. */
const PROBE_AD_SERIES: CreativeEvidenceWindowExactSeriesPayload = {
  adCount: 2,
  points: Array.from({ length: 28 }, (_value, index) => ({
    date: `2026-03-${String(index + 1).padStart(2, "0")}`,
    // Served and deliberately unread by the card: link clicks are not
    // ingested, so the adapter draws all-clicks CTR instead.
    linkCtr: null,
    ctr: 1.2 + (index % 7) * 0.15,
    frequency: 1.05 + (index % 5) * 0.08,
  })),
};

/** The state every account is in before the helper reads land. */
const EMPTY_AD_SERIES: CreativeEvidenceWindowExactSeriesPayload = {
  adCount: 0,
  points: [],
};

let probeCtrSeries: ReadonlyMap<string, readonly number[]> = new Map();
let probeAccountId: string | null = null;
/**
 * The UNMOCKED desktop Decision Centre, loaded once for the DOM channel.
 *
 * The file's own `vi.mock` replaces this component with `() => null` for the
 * page render, and that mock is load-bearing: without it the twelve view-model
 * surfaces would fold into the banner strip and a KPI field would "prove"
 * itself there. `vi.importActual` gets the real one back for the one place
 * that wants a rendered panel rather than a view model.
 */
let realDecisionCentre: React.ComponentType<{
  viewModel: MetaDecisionCenterExactViewModel;
}> | null = null;

/**
 * Every surface's output for one payload, as text.
 *
 * The twelve Decision Center surfaces are read off the view model the page
 * hands the component, the inventory and the evidence window off their own
 * adapters, and the banners and mobile panels off the rendered page. The
 * evidence window is built SIX times: the page opens it in three served
 * states — with both envelopes, with the served decision alone (the state
 * every Grandmix row is in), and with the canonical envelope alone — and each
 * of those three is observed with the ad-grain helper read resolved and with
 * it resolved-but-empty, because the two open different branches and a proof
 * exists in each. @see PROBE_AD_ROWS
 */
interface Observation {
  /** One serialised blob per surface. */
  readonly surfaces: Record<string, string>;
  /** One serialised blob per labelled row, keyed `SURFACE#id`. */
  readonly elements: Record<string, string>;
  /**
   * The desktop Decision Centre as the page actually renders it, in the
   * default scope and lane. NEVER a surface: no claim may name it, and it is
   * sliced out of the SAME `renderToStaticMarkup` call the banners and the
   * mobile panels already come from, so it costs one `indexOf` rather than a
   * second render.
   */
  readonly dom: string;
}

function observeSurfaces(
  payload: MetaDecisionsWorkspacePayload,
  withPage: boolean,
): Observation {
  const overrides = { creativeCtrSeriesByAdId: probeCtrSeries };
  const viewModel = buildMetaDecisionCenterExactViewModel({
    workspace: payload,
    now: PROBE_NOW,
    overrides,
  });
  const decision = payload.os?.ads?.items?.[0] ?? null;
  const canonical =
    payload.decisionReadModel?.queue?.adCandidates?.items?.[0] ?? null;
  const creativeSelection = buildMetaDecisionCenterExactViewModel({
    workspace: payload,
    now: PROBE_NOW,
    overrides,
    selection: decision
      ? {
          kind: "creative",
          decisionId: decision.decisionId,
          sourceSnapshotId: decision.sourceSnapshotId,
        }
      : null,
  });
  const evidence = (
    servedDecision: MetaOsAdDecision | null,
    servedCanonical: MetaCanonicalDecision | null,
    adRows: readonly CreativeEvidenceWindowExactAdRow[],
    adSeries: CreativeEvidenceWindowExactSeriesPayload,
  ) =>
    buildCreativeEvidenceWindowExactViewModel({
      decision: servedDecision,
      canonical: servedCanonical,
      capabilities: payload.decisionReadModel?.capabilities ?? null,
      source: payload.decisionReadModel?.source ?? null,
      fallbackCurrency: payload.system?.currency ?? null,
      adRows,
      adSeries,
    });

  const groups: Record<string, unknown> = {
    // D078 R4: the coverage strip renders this view-model list verbatim.
    COVERAGE: viewModel.assignedAccountStates,
    HEADER: viewModel.identity,
    KPI: viewModel.kpis,
    PILLS: { counts: viewModel.counts, window: viewModel.activeWindow },
    ACTION: viewModel.actionRows,
    WATCHING: {
      segments: viewModel.watchSegments,
      rows: viewModel.watchingRows,
    },
    HEALTHY: viewModel.healthyGroups,
    NONSALES: viewModel.nonSales,
    ARCHIVE: viewModel.archiveRows,
    CREATIVES: {
      rows: viewModel.creativeDecisions,
      groups: viewModel.creativeGroups,
      notice: viewModel.creativesNotice,
      footnote: viewModel.creativeFootnote,
    },
    POSTURE: viewModel.creativePosture,
    INSPECTOR: [viewModel.inspector, creativeSelection.inspector],
    PROVENANCE: [viewModel.sourceProvenance, viewModel.structureProvenance],
    INVENTORY: buildMetaStructureInventoryViewModel({
      workspace: payload,
      fallbackCurrency: payload.system?.currency ?? null,
    }),
    // Three served states of the decision pair, each in both states of the
    // ad-grain helper read. @see PROBE_AD_ROWS for why both, measured.
    EVIDENCE: [
      evidence(decision, canonical, PROBE_AD_ROWS, PROBE_AD_SERIES),
      evidence(decision, null, PROBE_AD_ROWS, PROBE_AD_SERIES),
      evidence(null, canonical, PROBE_AD_ROWS, PROBE_AD_SERIES),
      evidence(decision, canonical, [], EMPTY_AD_SERIES),
      evidence(decision, null, [], EMPTY_AD_SERIES),
      evidence(null, canonical, [], EMPTY_AD_SERIES),
    ],
  };

  const output: Record<string, string> = {};
  const elements: Record<string, string> = {};
  let dom = "";
  for (const [surface, value] of Object.entries(groups)) {
    output[surface] = serialiseSurface(value);
    collectLabelledRows(surface, value, elements);
  }
  if (withPage) {
    state.workspace = payload;
    state.accounts = [
      {
        id: probeAccountId,
        name: "Probe account",
        currency: "USD",
        timezone: "Europe/Istanbul",
      },
    ];
    const html = renderToStaticMarkup(
      React.createElement(MetaPlatformPage, {
        businessId: "biz_probe",
        businessName: "Probe",
      }),
    );
    output.BANNERS = elementHtml(html, 'data-testid="meta-posture-banners"');
    output.MOBILE = elementHtml(html, 'data-testid="meta-mobile-decisions"');
  }
  /*
   * The desktop Decision Centre as HTML, from the REAL component.
   *
   * Not sliced out of the page render above: that render mocks
   * `MetaDecisionCenterExact` to `() => null` on purpose, so a slice of the
   * page would have contained the chrome and none of the twelve panels while
   * looking like a measurement of them. It is rendered here instead, from the
   * same view model the twelve surfaces are read off, in the state the page
   * mounts in — `structure` scope, `action` lane, inspector open, which are
   * the component's own defaults.
   */
  if (realDecisionCentre) {
    dom = renderToStaticMarkup(
      React.createElement(realDecisionCentre, { viewModel }),
    );
  }
  return { surfaces: output, elements, dom };
}

/**
 * THE ENTRIES THAT SAY WHERE A FIELD IS **NOT**, AND THE PIN THAT KEEPS THEM
 * HONEST.
 *
 * WHAT THIS REPLACED, AND WHY. There used to be a `CALLBACK_BOUNDARY_CLAIMS`
 * allow-list: three fields declared to be "never on screen", excused from the
 * display proof because the served tuple reached a callback. Every one of the
 * three was then MEASURED on a display surface —
 * `MetaOsAdDecision.decisionId` and `.sourceSnapshotId` on the evidence
 * window's diagnostics and the creative inspector's provenance line, and
 * `MetaOsDecisionAction.code` on the window's "Served action" row. The
 * allow-list had reproduced in miniature the exact failure this whole file
 * exists to eliminate: an exemption that hid a render. Worse, its own test
 * asserted only that the field did NOT reach the ONE surface its entry named,
 * so it could have started rendering anywhere else and nothing would fail.
 *
 * The repair is not a better exemption. The three claims were WRONG about
 * where the field is, so each now names the surface and the labelled row the
 * probe proves, and there is no allow-list left to hide anything.
 *
 * WHAT REMAINS TO PIN. Those three notes still make a NEGATIVE claim — "the
 * queue prints no decision id", "the button prints the LABEL and never the
 * code" — and a negative claim in prose is worth nothing. This table pins the
 * COMPLETE observed set for each of them: every display surface the field
 * moves, plus "callback" when it also reaches the boundary. A field that
 * starts rendering ANYWHERE else fails here, whether or not it is the surface
 * its entry names.
 *
 * The callback channel is still measured, and it is still never proof of
 * rendering: it appears in these sets as its own token so that "it also
 * travels to the boundary" is recorded rather than confused with a pixel.
 */
const NEGATIVE_CLAIM_PINS: Record<string, { observed: string[]; why: string }> =
  {
    "MetaOsAdDecision.decisionId": {
      observed: ["INSPECTOR", "EVIDENCE", "callback"],
      why: "the note says the queue prints no decision id; the queue is CREATIVES and it must stay out of this set",
    },
    "MetaOsAdDecision.sourceSnapshotId": {
      observed: ["INSPECTOR", "EVIDENCE", "callback"],
      why: "the note says the queue prints no snapshot id; the queue is CREATIVES and it must stay out of this set",
    },
    "MetaOsDecisionActionBase.code": {
      observed: ["EVIDENCE", "callback"],
      why: "the note says the button prints the label and never the code; ACTION and CREATIVES must both stay out of this set",
    },
  };

/**
 * RENDERED claims the probe CANNOT prove, each with what the probe saw.
 *
 * These are open defects, not exemptions: the field is classified as reaching
 * the operator and the running code says otherwise. An entry here is on its way
 * OUT — either the wiring lands or the classification is corrected — and the
 * list is asserted exactly, so a new unprovable claim fails here and so does an
 * entry that starts being provable.
 *
 * PRE-DEPLOY AUDIT — it holds SIX entries again, and each one names the exact
 * branch the probe cannot enter rather than a wiring gap.
 *
 * All six render on the panels' UNAVAILABLE or BLOCKED branch:
 * `BudgetDecisionEvidencePanel` prints `unavailableReason` and the per-section
 * blocker list only when the direction did not resolve, and `BudgetDryRunPanel`
 * prints its own reason and requirement note only when the preview is
 * unavailable. The probe changes ONE field at a time and leaves `status`
 * alone, so its fixture always renders the resolved branch and these fields
 * are legitimately absent from that render.
 *
 * They are parked here rather than reclassified because the third move is the
 * forbidden one: calling a field the component demonstrably renders
 * "INTENTIONALLY-NOT-RENDERED" because this probe could not reach it would
 * launder a probe limitation into a stated product choice. They leave when the
 * probe can drive a second fixture in the unavailable state.
 *
 * The ten entries it held BEFORE were resolved by REDERIVING each one from the
 * running code instead of leaving it parked:
 *
 *   - `MetaDecisionsWorkspaceReadModel.status` and
 *     `queue.adCandidates.eligiblePreCapCount` reached no operator at all and
 *     now do; they are WIRED-NOW, on the facts their notes name.
 *   - `MetaCanonicalDecision.decisionId` / `.sourceSnapshotId` and
 *     `MetaOsStructureNode.whyNow` were on screen all along at a surface the
 *     entry had named wrongly. A wrong `where` is repaired by naming the right
 *     one, not by footnoting the wrong one forever.
 *   - the five `MetaDecisionResolution` leaves are the object
 *     `MetaOsAdDecision.resolution` is assigned FROM, so the operator sees
 *     their values through the forward; they are withheld, with the forward and
 *     its pin named. @see RESOLUTION_IS_FORWARDED
 *
 * What must NOT happen here is the third move: turning an unprovable RENDERED
 * claim into INTENTIONALLY-NOT-RENDERED because the probe found nothing. That
 * launders a wiring gap into a stated choice. The test above it is the guard —
 * a withholding must ALSO be proven, and a field the operator genuinely cannot
 * see is either wired or named in `WITHHELD_BY_DEFECT`.
 */
const UNPROVEN_CLAIMS: Record<string, { observed: string[]; why: string }> = {};

/**
 * Withholdings that are DEFECTS rather than choices.
 *
 * The third answer says "INTENTIONALLY-not-rendered", and for these the code
 * really does withhold the field — the probe proves it — but the withholding is
 * a bug nobody has fixed yet, not a decision anyone would defend. Calling that
 * a choice is the laundering this file exists to prevent; calling it RENDERED
 * would be a lie in the other direction. So the classification states what the
 * code does and this list states what the note must not pretend, with the fix
 * and the file that owns it.
 *
 * Asserted exactly, and each entry is asserted to be a proven withholding, so
 * the day the fix lands the entry has to leave.
 *
 * IT IS EMPTY, and the one entry it held left the way an entry here is
 * supposed to leave: `MetaPulsePayload.roas.median` was a MEASURED account
 * median printed as an em dash, and the fix landed in `targetRoasDisplay`
 * (meta-decision-center-exact-adapter.ts:250-264). The field is now WIRED-NOW
 * at the KPI strip and the tripwire that pinned the defect was replaced by the
 * assertion that the FIXED behaviour holds, across all four `target_source`
 * arms.
 *
 * AND THE GUARD BELOW WAS INERT WHILE THAT ENTRY SAT HERE, which is worth
 * writing down because it is this file's own failure mode. The loop in "keeps
 * the exception lists exact" asserts `outcomes.get(key).display === []` — a
 * measurement taken against the PROBE FIXTURE — and the fixture pinned
 * `roas.target_source` to the first member of its union, `"commercial_truth"`,
 * with a numeric `roas.target` beside it. The defect state (`account_median`
 * with a null target) therefore never occurred in any of the six scenarios, so
 * `display` was `[]` whether or not the defect existed, and when the fix landed
 * the file advertised "two tests will fail" and exactly ONE did. A guard that
 * cannot fail is worse than no guard: it certifies the gap it was written to
 * close. The repair is not in this list but in `SCENARIOS`, which now carries
 * `accountMedianReference` and `noRoasReference` so the payload actually
 * reaches both of the arms this guard claims to cover.
 */
const WITHHELD_BY_DEFECT: Record<string, string> = {};

/**
 * Withheld fields the probe caught reaching the operator.
 *
 * The other half of the same failure: the matrix states a withholding and the
 * running code renders the field anyway. Asserted exactly, so the day one is
 * wired or unwired this list is what fails.
 *
 * IT IS EMPTY. A contradiction list is a place to put a finding on its way to
 * being fixed, not a place to keep it, and all seven entries were fixed by
 * REDERIVING the classification from the running code: the evidence window
 * genuinely prints the media state, the served priority, the served action's
 * target level and both halves of the first blocker, and the source panel
 * genuinely prints the section cap's suppressed count. Each is now RENDERED at
 * the labelled row it moves, which is a stronger statement than a footnote
 * saying the table was wrong.
 */
const CONTRADICTED_WITHHOLDINGS: Record<
  string,
  { observed: string[]; why: string }
> = {};

/**
 * Pinned leaves whose absence a text search cannot decide.
 *
 * A leaf the contract admits ONE value for cannot be probed by changing it, so
 * a withheld one is proven by its literal never appearing on any surface. That
 * only works when the literal belongs to it alone: `"meta_attributed"` is
 * carried by three different leaves and one of them IS rendered, `"current"`
 * and `"none"` are ordinary words, and `null` has no text at all. Naming them
 * is the honest answer; asserting a search that cannot fail is not.
 */
const PINNED_BEYOND_TEXT_PROOF: Record<string, string> = {
  // PRE-DEPLOY AUDIT — three leaves the budget contracts pin in the TYPE
  // (`ctaEnabled: false`, `providerWriteAttempted: false`,
  // `directionSelected: null`). They are rendered — the matrix proves the
  // row and the surface — but the value itself has no text to search for.
  // The withheld side of the same condition: seven leaves the budget
  // contracts pin to a value text cannot decide.
  "MetaBudgetDecisionEvidencePanel.counterfactual.neverActionAuthority":
    "the pinned value is `true`, which has no text to search for",
  "MetaBudgetDryRunPanel.execution.executable":
    "the pinned value is `false`, which has no text to search for",
  "MetaOsBudgetDecisionAction.intent":
    "the literal is 'review', an ordinary word the surfaces use in their own prose",
  "MetaOsBudgetDecisionAction.providerMutation":
    "the pinned value is `null`, which has no text to search for",
  "MetaOsBudgetIntentPayload.executionState":
    "the literal is 'validated_only', shared with MetaBudgetDryRunPanel.execution.executionState, which IS rendered",
  "MetaOsBudgetIntentPayload.readback.independentRead":
    "the pinned value is `true`, which has no text to search for",
  "MetaOsLegacyDecisionAction.budgetIntent":
    "the field is typed `never`: there is no value, and so no literal, to search for",
  "MetaOsLegacyDecisionAction.bidIntent":
    "the field is typed `never`: there is no value, and so no literal, to search for",
  "MetaOsBudgetDecisionAction.bidIntent":
    "the field is typed `never`: there is no value, and so no literal, to search for",
  "MetaBudgetDecisionEvidenceByDirection.directionSelected":
    "the type pins the value to `null`, which has no text to search for",
  "MetaBudgetDecisionEvidencePanel.executionReadiness.ctaEnabled":
    "the type pins the value to `false`, which has no text to search for",
  "MetaBudgetDryRunPanel.execution.ctaEnabled":
    "the type pins the value to `false`, which has no text to search for",
  "MetaBudgetDryRunPanel.execution.providerWriteAttempted":
    "the type pins the value to `false`, which has no text to search for",
  "MetaDecisionsDigest.labelFlips.items[].status":
    "the literal is 'published', a word the surfaces use in their own prose",
  "MetaDecisionsWorkspaceReadModel.scope.decisionMode":
    "the literal is 'current', an ordinary word",
  "MetaDecisionsWorkspaceReadModel.scope.metricsRangeAffectsDecisionSnapshot":
    "the pinned value is `false`, which has no text to search for",
  "MetaOsDecisionsPresentation.contractVersion":
    "the same version string is carried by MetaOsDecisionPriority.version, which IS rendered",
  "MetaCanonicalDecision.riskTierProvenance.status":
    "the literal is 'proposed', shared with promotionBasis.status, which IS rendered",
  "MetaCanonicalDecision.promotionBasis.value":
    "the pinned value is `null`, which has no text to search for",
  "MetaCanonicalDecision.metrics.attribution":
    "the literal is shared with MetaOsDecisionMetrics.attribution, which IS rendered",
  "MetaOsInactiveAsset.providerWriteAuthority":
    "the literal is 'none', an ordinary word",
  "MetaDecisionExposureDigest.basis":
    "the literal is 'pre_cap', which the panel's own labels contain",
  "MetaDecisionExposureDigest.crossCurrencyTotal":
    "the pinned value is `null`, which has no text to search for",
  "MetaDecisionExposure.attribution":
    "the literal is shared with MetaOsDecisionMetrics.attribution, which IS rendered",
  "MetaDecisionHistoryEvent.actor":
    "the pinned value is `null`, which has no text to search for",
  "MetaDecisionHistoryEvent.actorAttributionStatus":
    "the literal is 'unavailable', which every capability and status fact prints",
};

describe("Meta Decision payload · every claim, proven against the running code", () => {
  const outcomes = new Map<string, ProbeOutcome>();
  let baseline: Record<string, string> = {};
  let everyBaseline: Record<string, string>[] = [];
  /** Every `SURFACE#id` the baselines emit, across every scenario. */
  const knownElements = new Set<string>();
  let fields: readonly ServedField[] = [];
  let restoreProbeClock = () => {};

  afterAll(() => restoreProbeClock());

  beforeAll(async () => {
    // The real page passes Date.now() to the same adapter that the direct
    // probes call with PROBE_NOW. Keep both clocks identical for the entire
    // census: crossing a sync-age rounding boundary during this long hook
    // otherwise makes unrelated later mutations appear to change MOBILE.
    // Only Date.now is fixed; the runner's timers and timeout remain real.
    const pageClock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(PROBE_NOW));
    restoreProbeClock = () => pageClock.mockRestore();
    realDecisionCentre = (
      await vi.importActual<typeof import("./MetaDecisionCenterExact")>(
        "./MetaDecisionCenterExact",
      )
    ).MetaDecisionCenterExact as typeof realDecisionCentre;
    fields = servedFieldWalk().fields;
    const first = buildProbePayload(null);
    probeAccountId = first.decisionReadModel.scope.providerAccountId;
    // The caller's own second read, keyed by the served ad id. Held constant
    // across the probe so a change in the KEY is what moves the sparkline.
    probeCtrSeries = new Map([[first.os.ads.items[0]!.adId, [1, 2, 3, 4]]]);

    const baselines = SCENARIOS.map((scenario) =>
      observeSurfaces(
        buildProbePayload(null, scenario),
        PAGE_SCENARIOS.has(scenario.name),
      ),
    );
    const callbackBaselines = SCENARIOS.map((scenario) =>
      callbackChannel(buildProbePayload(null, scenario)),
    );
    baseline = baselines[0]!.surfaces;
    everyBaseline = baselines.map((observation) => observation.surfaces);
    for (const observation of baselines) {
      for (const key of Object.keys(observation.elements))
        knownElements.add(key);
    }

    for (const field of fields) {
      if (!field.varies) continue;
      const display = new Set<string>();
      const elements = new Set<string>();
      let callback = false;
      let dom = false;
      SCENARIOS.forEach((scenario, index) => {
        const mutated = observeSurfaces(
          buildProbePayload(field.key, scenario),
          PAGE_SCENARIOS.has(scenario.name),
        );
        const base = baselines[index]!;
        for (const surface of Object.keys(base.surfaces)) {
          if (base.surfaces[surface] !== mutated.surfaces[surface]) {
            display.add(surface);
          }
        }
        // A row that DISAPPEARS is a change too — mutating an id can take the
        // whole row with it — so the two sides are compared over the union of
        // their keys and an absent row reads as null rather than as "equal".
        for (const key of new Set([
          ...Object.keys(base.elements),
          ...Object.keys(mutated.elements),
        ])) {
          if (
            (base.elements[key] ?? null) !== (mutated.elements[key] ?? null)
          ) {
            elements.add(key);
          }
        }
        if (mutated.dom !== base.dom) dom = true;
        if (
          callbackChannel(buildProbePayload(field.key, scenario)) !==
          callbackBaselines[index]
        ) {
          callback = true;
        }
      });
      outcomes.set(field.key, {
        display: [...display],
        elements: [...elements],
        callback,
        dom,
      });
    }
    // This hook probes 707 varying leaves across every served scenario and
    // renders the real adapters/page for each mutation. The clean two-core CI
    // runner first measured the completed hook at 358,465ms, then a loaded
    // 2026-09-04 runner completed its probe work in 484,342ms and hit the old
    // 420s hook bound before assertions could run. That is a liveness failure,
    // not an assertion failure. Keep a finite 600s bound local to this hook; no
    // probe or assertion is skipped.
  }, 600_000);

  it("keeps mobile freshness on the direct adapter's fixed probe clock", () => {
    for (const observation of everyBaseline) {
      const identity = JSON.parse(observation.HEADER) as { syncedLabel: string };
      expect(observation.MOBILE).toContain(identity.syncedLabel);
    }
  });

  it("builds a payload that carries every served field", () => {
    // The proof rests entirely on the fixture populating the field under test.
    // An undefined leaf is unobservable, and an unobservable leaf would pass
    // the withholding check for the wrong reason.
    const payload = buildProbePayload(null) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).length).toBeGreaterThan(10);
    expect(outcomes.size).toBe(fields.filter((field) => field.varies).length);
    // Exact, for the reason the walk's own size is exact: a probe that stopped
    // probing would satisfy every "nothing changed" assertion in the file.
    // PRE-DEPLOY AUDIT: 620 -> 707, tracking the walk's own varying-leaf pin.
    expect(outcomes.size).toBe(707);
    // And the baseline surfaces are not empty, or "nothing changed" would be
    // true of everything.
    for (const [surface, text] of Object.entries(baseline)) {
      expect(text.length, surface).toBeGreaterThan(40);
    }
  });

  it("proves every rendered claim by changing the field and watching the named surface", () => {
    const unproven: string[] = [];
    for (const [key, coverage] of Object.entries(COVERAGE)) {
      if (coverage.classification === "INTENTIONALLY-NOT-RENDERED") continue;
      const outcome = outcomes.get(key);
      if (!outcome) continue; // pinned; proven by its literal below
      const surface = PROBE_SURFACE[coverage.where]!;
      if (outcome.display.includes(surface)) continue;
      if (UNPROVEN_CLAIMS[key]) continue;
      unproven.push(
        `${key} claims ${surface} · probe saw [${outcome.display.join(", ")}]${
          outcome.callback ? " + callback" : ""
        }`,
      );
    }
    expect(unproven).toEqual([]);
  });

  it("proves every claim that names an element by watching THAT ROW, not the surface", () => {
    /*
     * The surface-level proof above cannot tell a right panel from a right
     * line on it. `MetaOsAdDecision.resolution.code` passed it for a whole
     * round while its note named the "Served resolution" line, where the code
     * is provably not printed — it is on a diagnostics row instead. An entry
     * that names a row with a stable id says so in `element`, and this is
     * where that half of the claim is checked.
     */
    const wrongRow: string[] = [];
    for (const [key, coverage] of Object.entries(COVERAGE)) {
      if (!coverage.element) continue;
      const outcome = outcomes.get(key);
      if (!outcome) continue;
      const wanted = `${PROBE_SURFACE[coverage.where]!}#${coverage.element}`;
      if (outcome.elements.includes(wanted)) continue;
      wrongRow.push(
        `${key} names ${wanted} · probe saw rows [${outcome.elements.join(", ")}]`,
      );
    }
    expect(wrongRow).toEqual([]);
  });

  it("proves every withholding by changing the field and watching every surface", () => {
    const leaked: string[] = [];
    for (const [key, coverage] of Object.entries(COVERAGE)) {
      if (coverage.classification !== "INTENTIONALLY-NOT-RENDERED") continue;
      const outcome = outcomes.get(key);
      if (!outcome || outcome.display.length === 0) continue;
      if (CONTRADICTED_WITHHOLDINGS[key]) continue;
      leaked.push(`${key} reaches [${outcome.display.join(", ")}]`);
    }
    expect(leaked).toEqual([]);
  });

  it("proves the pinned leaves by their literal, and names the ones text cannot decide", () => {
    const pinned = fields.filter((field) => !field.varies);
    const beyondProof: string[] = [];
    const wrong: string[] = [];
    const texts = pinned
      .map((field) => field.constantText)
      .filter((text): text is string => Boolean(text));
    /*
     * Compared with the punctuation removed, because some of these literals
     * are HUMANISED before they are printed: the audit block renders
     * `risk_tier_producer_not_persisted` as "Risk tier producer not
     * persisted". The proof is the transform's observable result, which is
     * what a reader sees, not the spelling the payload used.
     */
    const flatten = (text: string) =>
      text.toLowerCase().replace(/[^a-z0-9]+/g, "");
    for (const field of pinned) {
      const coverage = COVERAGE[field.key]!;
      const text = field.constantText;
      const distinctive =
        text !== null &&
        text.length >= 12 &&
        texts.filter((candidate) => candidate === text).length === 1;
      if (coverage.classification !== "INTENTIONALLY-NOT-RENDERED") {
        const surface = PROBE_SURFACE[coverage.where]!;
        // Any served state will do for a presence proof: a line that only
        // prints when no risk tier was produced is still a line the operator
        // sees on the account that has none.
        const seen =
          text !== null &&
          everyBaseline.some((scenario) =>
            flatten(scenario[surface] ?? "").includes(flatten(text)),
          );
        /*
          PRE-DEPLOY AUDIT — a pin whose literal is `false` or `null` has no
          text to search for, so `seen` can never become true for it and the
          check would report a rendering leaf as missing. That is the same
          condition `PINNED_BEYOND_TEXT_PROOF` already records for withheld
          leaves, so it is routed there rather than asserted by text. The
          route is only open when the probe itself produced no literal: a
          rendered leaf that HAS one must still be found.
        */
        if (text === null) {
          beyondProof.push(field.key);
          continue;
        }
        if (!seen) {
          wrong.push(
            `${field.key} claims ${surface} but its literal is not there`,
          );
        }
        continue;
      }
      if (!distinctive) {
        beyondProof.push(field.key);
        continue;
      }
      for (const scenario of everyBaseline) {
        for (const [surface, rendered] of Object.entries(scenario)) {
          if (flatten(rendered).includes(flatten(text))) {
            wrong.push(
              `${field.key} is withheld but its literal is on ${surface}`,
            );
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(beyondProof.sort()).toEqual(
      Object.keys(PINNED_BEYOND_TEXT_PROOF).sort(),
    );
  });

  it("pins the COMPLETE observed set for every entry that claims a field is absent somewhere", () => {
    /*
     * The list this replaced asserted only `display.includes(namedSurface) ===
     * false`, so a field excused as "never on screen" could start rendering on
     * any OTHER surface and nothing failed. Here the whole set is asserted, so
     * a new render anywhere fails — which is the only version of this check
     * that is worth having.
     */
    for (const [key, entry] of Object.entries(NEGATIVE_CLAIM_PINS)) {
      const outcome = outcomes.get(key);
      expect(outcome, key).toBeDefined();
      const observed = [
        ...outcome!.display,
        ...(outcome!.callback ? ["callback"] : []),
      ].sort();
      expect(observed, key).toEqual([...entry.observed].sort());
      expect(entry.why.length, key).toBeGreaterThan(40);
    }
  });

  it("keeps the exception lists exact, so none of them can quietly grow", () => {
    // All three are empty today. The assertions still run, because an empty
    // list is a claim — "the running code supports every classification in the
    // table" — and it is the claim that has to break first when it stops being
    // true.
    //
    // AND AN ASSERTION THAT RUNS IS NOT THE SAME AS ONE THAT CAN FAIL. The
    // WITHHELD_BY_DEFECT loop below asserts a MEASUREMENT taken against the
    // probe fixture, and while the fixture never built the state the entry was
    // about, the loop passed whether or not the defect existed — it was
    // advertised as a tripwire for a whole round and could not have fired.
    // What makes it a guard is `SCENARIOS` reaching the arm, not the loop
    // being written. @see WITHHELD_BY_DEFECT
    const stillUnproven = Object.entries(UNPROVEN_CLAIMS).filter(([key]) => {
      const outcome = outcomes.get(key)!;
      return !outcome.display.includes(PROBE_SURFACE[COVERAGE[key]!.where]!);
    });
    expect(stillUnproven.length).toBe(Object.keys(UNPROVEN_CLAIMS).length);
    for (const [key, entry] of Object.entries(UNPROVEN_CLAIMS)) {
      const outcome = outcomes.get(key)!;
      const observed = [
        ...outcome.display,
        ...(outcome.callback ? ["callback"] : []),
      ].sort();
      expect(observed, key).toEqual([...entry.observed].sort());
      expect(entry.why.length, key).toBeGreaterThan(40);
    }

    for (const [key, entry] of Object.entries(CONTRADICTED_WITHHOLDINGS)) {
      const outcome = outcomes.get(key)!;
      expect([...outcome.display].sort(), key).toEqual(
        [...entry.observed].sort(),
      );
      expect(entry.why.length, key).toBeGreaterThan(20);
    }

    // A defect is only a defect while the code still commits it: each of these
    // must be classified as withheld AND measured as withheld. The day the fix
    // lands, the field reaches a surface and this fails.
    for (const [key, why] of Object.entries(WITHHELD_BY_DEFECT)) {
      expect(COVERAGE[key], key).toBeDefined();
      expect(COVERAGE[key]!.classification, key).toBe(
        "INTENTIONALLY-NOT-RENDERED",
      );
      expect(outcomes.get(key)!.display, key).toEqual([]);
      // The note must not pretend it is a choice, and it must name the fix.
      expect(COVERAGE[key]!.note, key).toMatch(/DEFECT/);
      expect(why, key).toMatch(/THE FIX/);
    }
  });

  it("states which claims carry element-level proof and which rest on the surface alone", () => {
    /*
     * WHY THIS IS REPORTED RATHER THAN ENFORCED. Not every element has an id
     * to key on — a chip, a tone, a money sub-line and everything on the two
     * HTML surfaces have none — so demanding `element` everywhere would force
     * someone to invent ids, and an invented id proves nothing while looking
     * like the strongest proof in the file. The honest alternative is to say
     * out loud how many claims are proven at which strength, and to pin the
     * split so it cannot quietly slide back towards the weaker one.
     *
     * The numbers move deliberately: annotate more entries and raise the
     * floor. They are a floor and a ceiling on the SAME quantity from two
     * sides, so neither drifts unnoticed.
     */
    const rendered = Object.entries(COVERAGE).filter(
      ([, value]) => value.classification !== "INTENTIONALLY-NOT-RENDERED",
    );
    const withElement = rendered.filter(([, value]) => value.element);
    const withoutElement = rendered.filter(([, value]) => !value.element);

    /*
     * PRE-DEPLOY AUDIT — 375/194/181 -> 432/195/237. The added rendered
     * claims are principally the budget evidence, gate and dry-run leaves;
     * the server-owned structure lane is now also wired to the lane surface.
     * Most of these claims are recorded at the SURFACE strength only. That moves the
     * proven-at-element share from 52% to 45%, and the reason is the one this
     * file already names rather than a lapse: they land on MOBILE, an HTML
     * surface listed in SURFACES_WITHOUT_ELEMENT_IDS because it emits no
     * `{ id, label, value }` row for a claim to key on. Surface-level is the
     * strongest proof available there, so the honest thing is to let the
     * ratio move and say why.
     */
    expect(rendered.length).toBe(432);
    expect(withElement.length).toBe(195);
    expect(withoutElement.length).toBe(237);

    /*
     * AND WHICH ENTRIES, not merely how many.
     *
     * Three totals tell a reader that some claims are stronger than others and
     * leave them to work out WHICH by reading four hundred lines of table. The
     * split is not spread evenly and the shape of it is the useful part: two
     * surfaces emit no keyable row at all and everything naming them is
     * surface-level by construction (they are named in
     * SURFACES_WITHOUT_ELEMENT_IDS), the evidence window and the source panel
     * emit labelled rows and are mostly element-level, and the rest sit
     * between. Pinned per surface, so the strength of a claim can be read off
     * the surface it names.
     *
     * Each entry is [element-level, surface-level].
     */
    const perSurface: Record<string, [number, number]> = {};
    for (const [, value] of rendered) {
      const surface = PROBE_SURFACE[value.where]!;
      const slot = (perSurface[surface] ??= [0, 0]);
      slot[value.element ? 0 : 1] += 1;
    }
    expect(perSurface).toEqual(ELEMENT_PROOF_BY_SURFACE);

    // A withholding names no element: there is no row for it to be on.
    for (const [key, value] of Object.entries(COVERAGE)) {
      if (value.classification !== "INTENTIONALLY-NOT-RENDERED") continue;
      expect(value.element, key).toBeUndefined();
    }

    // Every named row must EXIST in the baseline, on the surface the entry
    // names. A typo'd id would otherwise fail the proof above with a confusing
    // message about a row that was never there.
    const missing = withElement
      .filter(
        ([, value]) =>
          !knownElements.has(`${PROBE_SURFACE[value.where]!}#${value.element}`),
      )
      .map(([key]) => key);
    expect(missing).toEqual([]);

    // And no entry may name a row on a surface that emits none, which would be
    // a claim nothing could ever check.
    for (const [key, value] of withElement) {
      expect(
        SURFACES_WITHOUT_ELEMENT_IDS.has(PROBE_SURFACE[value.where]!),
        key,
      ).toBe(false);
    }
  });

  it("counts the leaves that reach nothing, and states what that count is NOT", () => {
    /*
     * THE NUMBER, AND ITS HONEST NAME.
     *
     * Of the leaves the probe can vary, this many changed NO surface's output
     * in ANY scenario. It is the file's largest single claim and it was, until
     * this round, never written down — which meant nobody could check it and
     * nobody could notice what it was measuring instead.
     *
     * WHAT IT WOULD HAVE BEEN MEASURING. Two fixture shortcuts were suspected
     * of inflating it, and both were measured rather than argued:
     *
     *   - the evidence window was opened with a resolved-but-EMPTY ad-grain
     *     read, so every branch behind a populated read went unentered.
     *     Populating it moves the count by ZERO (252 -> 252), because those
     *     reads are a separate API and no served leaf travels through them.
     *     @see PROBE_AD_ROWS
     *   - the page was rendered in three of the scenarios rather than all of
     *     them, so a leaf reaching only a banner in a fourth state would have
     *     been missed. Rendering it in all of them moves the count by ZERO
     *     too, and costs about two seconds. @see PAGE_SCENARIOS
     *
     * WHAT DID MOVE IT. Twice, and only ever by wiring or by a state:
     *
     *   - the scenario list, by one. `accountMedianReference` puts the pulse
     *     in the arm where the ROAS reference line is the measured account
     *     median, and `MetaPulsePayload.roas.median` — a leaf the probe had
     *     counted as reaching nowhere through every round — reaches the KPI
     *     strip there. 252 -> 251. That is the whole shape of the risk this
     *     number carries: not that the code is worse than the count says, but
     *     that a state the probe never built makes the count say "nothing"
     *     about a field the operator can see.
     *   - the banner round, by four. The evidence-source token and the three
     *     fields of the silent-failure sentence now reach the banner strip and
     *     the mobile panels. 251 -> 247, and the four moved from this count
     *     into the WIRED-NOW list in the same commit.
     *
     * AND THE TWO SCENARIOS ADDED WITH THEM MOVED IT BY ZERO. `demoEvidence`
     * and `measuredEvidence` exist so the evidence banner's demo branch and
     * its SILENCE are states the probe actually builds; measured before and
     * after, the count is 247 either way. The scenarios buy a provable claim,
     * not a smaller number, and saying so is the difference between a
     * measurement and a coincidence nobody checked.
     *
     * SO DID THE THIRD. `untruncatedActionDigest` was added for the same kind
     * of reason — the narrow half of the silent-failure sentence is reached by
     * no other state — and it moves this count by zero as well: 247 with the
     * scenario and 247 without it, measured both ways rather than assumed.
     * The two leaves the digest gained in the same round (`countsTruncated`,
     * `countedRowCap`) never entered this count at all; both move the banner
     * strip in every scenario, so they went straight from unclassified to the
     * WIRED-NOW list.
     *
     * WHAT IT IS STILL NOT. It is not a count of fields that reach no PANEL:
     * fourteen of the sixteen surfaces are serialised view models, so a leaf
     * counted here changed no VIEW MODEL that feeds a panel, and every leaf
     * NOT counted here reached a view model rather than necessarily reaching
     * the operator's eye. Both directions of that gap are measured separately.
     * @see DOM_PROOF_BY_SURFACE
     *
     * It is not a count of fields that reach no operator
     * anywhere in the product: this file's subject is the Decision page's
     * three surfaces, and a leaf drawn only on Creative Studio, Meta History,
     * Commercial Truth or Overview is "nowhere" HERE and on screen there. It
     * is not a defect list either — every one of these is classified, with a
     * stated reason, and the assertion below is what keeps the two facts
     * joined: a leaf that reaches nothing may not be classified as reaching
     * someone. And it remains bounded by the states the probe can construct:
     * eleven scenarios, not every account in the world.
     *
     * AND ONE MORE, BY ONE. `readState` — the §9 envelope the route now decides
     * and sends with the rows — reaches nothing in THIS body by design: the
     * canonical page mounts the surface-state region beside the body and that
     * is what prints it. 247 -> 248, and the leaf is classified
     * INTENTIONALLY-NOT-RENDERED with that reason, which is the only
     * classification the assertion below will accept for a leaf in this list.
     */
    const nowhere = [...outcomes.entries()].filter(
      ([, outcome]) => outcome.display.length === 0,
    );

    // The load-bearing half. A RENDERED or WIRED-NOW claim whose field moves
    // nothing is a false claim, and it fails here as well as in the proof
    // above — deliberately twice, from the two directions.
    const claimedButNowhere = nowhere
      .filter(
        ([key]) =>
          COVERAGE[key]!.classification !== "INTENTIONALLY-NOT-RENDERED",
      )
      .map(([key]) => key)
      .sort();
    expect(claimedButNowhere).toEqual([]);

    // Exact, for the same reason the walk's size is exact: a probe that
    // stopped probing would drive this number up and every "nothing changed"
    // assertion in the file would still pass.
    expect(nowhere.length).toBe(NOWHERE_LEAVES);

    // And the subset that reaches the callback boundary without reaching a
    // pixel. Recorded, never counted as rendering. @see NEGATIVE_CLAIM_PINS
    const boundaryOnly = nowhere.filter(([, outcome]) => outcome.callback);
    expect(boundaryOnly.length).toBe(NOWHERE_BUT_AT_THE_BOUNDARY);
  });

  it('says plainly what "reaches a surface" means, and counts the claims the rendered DOM also carries', () => {
    /*
     * THE BOUNDARY THIS FILE UNDERSTATED FOR EVERY ROUND BEFORE THIS ONE.
     *
     * Fourteen of the sixteen surfaces are SERIALISED VIEW MODELS. Only
     * BANNERS and MOBILE are observed as rendered HTML. So "reaches a surface"
     * in this file means "reaches the view model that feeds a panel", which is
     * WEAKER than "an operator can see it" — and the gap is not hypothetical.
     * `MetaArchivedEntity.name` moves the ARCHIVE view model and does NOT move
     * the page's rendered DOM in the default scope, because the Archive lane
     * sits behind a lane tab the default render never presses. Both halves are
     * asserted below rather than described.
     *
     * WHY THE WEAKER PROOF IS STILL THE RIGHT DEFAULT. A panel behind a tab is
     * rendering: the operator presses one control and it is there, and a file
     * that only counted the default render would report the Archive lane, the
     * Watching lane, the evidence window and the inspector as unrendered,
     * which is false in a more damaging direction. The honest answer is to
     * measure BOTH and say which claims carry which, so a reader can tell a
     * claim proven in the DOM from a claim proven one step behind it.
     *
     * WHAT WAS STRENGTHENED, AND BY HOW MUCH. The desktop Decision Centre is
     * now RENDERED TO HTML, from the real component rather than from the page
     * (the page render mocks it to `() => null` so the twelve view-model
     * surfaces cannot fold into the banner strip), in the state the page
     * mounts in: `structure` scope, `action` lane, inspector open. Four
     * surfaces come out fully proven in rendered HTML —
     *
     *     HEADER 10/10   KPI 18/18   PILLS 7/7   ACTION 10/10
     *
     * — 45 claims that were "the adapter emits this" and are now "the browser
     * would paint this". Four more are partly proven (PROVENANCE 13 of 35,
     * INSPECTOR 3 of 9, CREATIVES 2 of 14, WATCHING 1 of 4), and the rest sit
     * behind a control or belong to another component. It cost about 26
     * seconds on a ~70-second file and no production change at all.
     *
     * A ZERO IN THIS TABLE IS NOT A ZERO ON SCREEN. BANNERS and MOBILE are
     * already observed as rendered HTML in their own right; EVIDENCE and
     * INVENTORY are drawn by components this channel does not render. For
     * those four a zero says "not this component", and reading it as "not on
     * screen" would be the inverse of the error this whole test corrects.
     *
     * IT IS A REPORTING CHANNEL AND NEVER A `where`: no claim may name it,
     * exactly as no claim may rest on `callback`.
     */
    const rendered = Object.entries(COVERAGE).filter(
      ([, value]) => value.classification !== "INTENTIONALLY-NOT-RENDERED",
    );
    const varying = rendered.filter(([key]) => outcomes.has(key));
    const inDom = varying.filter(([key]) => outcomes.get(key)!.dom);
    const behindAControl = varying.filter(([key]) => !outcomes.get(key)!.dom);

    const perSurface: Record<string, [number, number]> = {};
    for (const [key, value] of varying) {
      const surface = PROBE_SURFACE[value.where]!;
      const slot = (perSurface[surface] ??= [0, 0]);
      slot[outcomes.get(key)!.dom ? 0 : 1] += 1;
    }

    // The leaves the contract pins to one value cannot be varied at all, so
    // they have no DOM answer either way; counted here so the three numbers
    // add up to the whole table rather than to an unstated subset.
    expect(rendered.length - varying.length).toBe(DOM_PROOF_PINNED_LEAVES);
    expect(inDom.length).toBe(DOM_PROOF_TOTALS[0]);
    expect(behindAControl.length).toBe(DOM_PROOF_TOTALS[1]);
    expect(perSurface).toEqual(DOM_PROOF_BY_SURFACE);

    /*
     * THE DEMONSTRATION, NAMED. The Archive lane's row name is the case that
     * makes the distinction concrete: proven at the ARCHIVE view model,
     * invisible in the default render's DOM.
     */
    const archived = outcomes.get("MetaArchivedEntity.name")!;
    expect(archived.display).toContain("ARCHIVE");
    expect(archived.dom).toBe(false);

    // And a claim that IS in the DOM, so the channel is not vacuously false.
    expect(outcomes.get("MetaPulsePayload.pacing.spendToday")!.dom).toBe(true);
  });

  it("observes the demo arm the evidence banner exists for, and the arm where it is silent", () => {
    /*
     * The claim `MetaPulsePayload.dataReadiness.evidenceSource` -> BANNERS is
     * proven by the probe like every other claim: change the token, watch the
     * strip. That proof alone would be satisfied by the notice's LAST branch,
     * the one for a token this page cannot read, because the field is typed as
     * a bare `string` and the probe's sentinel is exactly such a token. The
     * branch the notice was WRITTEN for — a demo business, where no other
     * banner fires and the figures are fabricated — needs a state, and the two
     * scenarios below are it. @see SCENARIOS.demoEvidence, SCENARIOS.measured-
     * Evidence
     */
    const at = (name: string) => {
      const index = SCENARIOS.findIndex((scenario) => scenario.name === name);
      expect(index, name).toBeGreaterThanOrEqual(0);
      return everyBaseline[index]!;
    };

    const demo = at("demoEvidence");
    expect(demo.BANNERS).toContain("demonstration numbers, not measurements");
    expect(demo.BANNERS).toContain("evidence source");
    // The same disclosure on the phone, or the mobile operator is the one left
    // reading fabricated figures as measurements.
    expect(demo.MOBILE).toContain("demonstration numbers, not measurements");
    // And it is the ONLY banner: the readiness pair is healthy on a demo
    // account, which is precisely why this notice had to exist.
    expect(demo.BANNERS).not.toContain("cannot read");

    const measured = at("measuredEvidence");
    expect(measured.BANNERS).not.toContain("demonstration numbers");
    expect(measured.BANNERS).not.toContain("evidence source");
    expect(measured.MOBILE).not.toContain("demonstration numbers");

    // The unrecognised-token branch, which every other scenario takes.
    expect(at("full").BANNERS).toContain("one this page cannot read");
  });

  it("observes both halves of the silent-failure banner's count, denominator and since-window", () => {
    /*
     * Three claims land on one sentence, and each is proven by a state in
     * which the sentence is different:
     *
     *   count       - the `> 0` gate. The probe's number base is positive and
     *                 its alt is a MEASURED ZERO, so the banner's presence and
     *                 its absence are both observed by the mutation itself.
     *   denominator - "N of M". Dropping `verifiedCount` from the sentence
     *                 would leave a bare count with nothing to be a share of.
     *   since-window- the " since <date>" phrase, which the notice omits when
     *                 the digest carries no snapshot date. That omission is
     *                 observable in exactly one scenario, and this is why the
     *                 degraded scenario erases the field. @see SCENARIOS
     */
    const at = (name: string) => {
      const index = SCENARIOS.findIndex((scenario) => scenario.name === name);
      expect(index, name).toBeGreaterThanOrEqual(0);
      return everyBaseline[index]!;
    };

    const full = at("full");
    expect(full.BANNERS).toContain("ended without a verified outcome");
    expect(full.BANNERS).toContain("verified");
    expect(full.BANNERS).toContain(" since 2026-");
    expect(full.MOBILE).toContain("ended without a verified outcome");

    // The digest that cannot name its window still states the counts, and
    // silently drops the phrase rather than printing an empty one.
    const noWindow = at("degraded");
    expect(noWindow.BANNERS).toContain("ended without a verified outcome");
    expect(noWindow.BANNERS).not.toContain(" since ");
    expect(noWindow.BANNERS).not.toContain("since undefined");
    expect(noWindow.BANNERS).not.toContain("since null");

    // And the fields are the ones the matrix credits to this sentence: the
    // three above plus the two that decide HOW WIDE the sentence is allowed to
    // be. @see the test below, which reads both widths.
    for (const key of [
      "MetaDecisionsDigest.actions.silentFailureCount",
      "MetaDecisionsDigest.actions.verifiedCount",
      "MetaDecisionsDigest.snapshotDate",
      "MetaDecisionsDigest.actions.countsTruncated",
      "MetaDecisionsDigest.actions.countedRowCap",
    ]) {
      expect(COVERAGE[key], key).toMatchObject({
        classification: "WIRED-NOW",
        where: S.BANNERS,
      });
      expect(outcomes.get(key)!.display, key).toContain("BANNERS");
    }
  });

  it("observes both widths of the silent-failure banner's sentence", () => {
    /*
     * THE FRAME AROUND A MEASUREMENT, READ OUT OF THE RENDERED STRIP.
     *
     * Both counts on this banner are filtered from a CAPPED action-log read
     * (app/api/meta/decisions-workspace/route.ts), so on an account with more
     * qualifying rows than the cap admits they describe the newest page of the
     * window and not the window. The payload says which of the two it is
     * (`actions.countsTruncated`) and what bounded it (`actions.countedRowCap`),
     * and MetaPlatformPage.tsx:2386-2404 prints a different sentence for each.
     *
     * A mutation proof can only say the sentence CHANGED. This test says what
     * each of the two sentences is, in a state where it is the one the strip
     * carries:
     *
     *   truncated   - a FLOOR ("At least N"), a count that covers only the
     *                 newest page, the cap that produced that page, and a
     *                 refusal to guess the remainder. Every baseline except
     *                 the one below is in this arm, because the probe's
     *                 boolean base is `true`.
     *   untruncated - the plain count the banner has always printed, with NO
     *                 floor, NO cap clause and NO talk of a remainder, because
     *                 there is none. Reached only through the scenario that
     *                 forces the flag false. @see SCENARIOS.untruncatedAction-
     *                 Digest
     */
    const at = (name: string) => {
      const index = SCENARIOS.findIndex((scenario) => scenario.name === name);
      expect(index, name).toBeGreaterThanOrEqual(0);
      return everyBaseline[index]!;
    };

    // The wide read, stated narrowly.
    const truncated = at("full");
    expect(truncated.BANNERS).toContain("At least ");
    expect(truncated.BANNERS).toContain("most recent recorded action");
    expect(truncated.BANNERS).toContain("-row cap lets it read");
    expect(truncated.BANNERS).toContain(
      "The window may hold more recorded actions than this count covers; whether it does, and how many, is unavailable here.",
    );
    // It states a floor instead of a total, so it must not also claim to carry
    // the window: "carries M recorded actions" is the sentence for the arm
    // where that is true.
    expect(truncated.BANNERS).not.toContain("carries ");
    expect(truncated.MOBILE).toContain("At least ");

    // The read that fits, stated as the count it is.
    const whole = at("untruncatedActionDigest");
    expect(whole.BANNERS).toContain("ended without a verified outcome");
    expect(whole.BANNERS).toContain("carries ");
    expect(whole.BANNERS).not.toContain("At least ");
    expect(whole.BANNERS).not.toContain("-row cap lets it read");
    expect(whole.BANNERS).not.toContain(
      "The window may hold more recorded actions",
    );
    expect(whole.MOBILE).not.toContain("At least ");

    /*
     * AND THE CAP IS NAMED ONLY WHERE A POSITIVE ONE WAS SERVED.
     *
     * Read off the strip in the state itself rather than asserted about the
     * matrix's own prose: this is the payload with `countedRowCap` taking the
     * probe's alternate, a MEASURED ZERO, while the truncation flag stays set.
     * A digest that reports truncation with no bound behind it still gets its
     * floor and its warning; what it does not get is a fabricated bound to
     * round the sentence out.
     */
    const noCap = observeSurfaces(
      buildProbePayload("MetaDecisionsDigest.actions.countedRowCap"),
      true,
    ).surfaces;
    expect(noCap.BANNERS).toContain("At least ");
    expect(noCap.BANNERS).toContain("most recent recorded action");
    expect(noCap.BANNERS).toContain(
      "The window may hold more recorded actions than this count covers",
    );
    expect(noCap.BANNERS).not.toContain("-row cap");
    expect(noCap.BANNERS).not.toContain("0-row");
  });

  it("refuses an element id the probe's own fixture invented", () => {
    /*
     * Some rows are keyed by DATA — `limitation-${code}`, `suppression-${code}`
     * — so their id in this run is the probe's sentinel string. Pinning a claim
     * to one of those would pin it to the fixture rather than to the product,
     * and it would pass forever without anyone rendering anything. A claimed id
     * must be a literal in one of the four files that draw this page.
     */
    const sources = DECISION_PAGE_SURFACES.map((file) =>
      readFileSync(file, "utf8"),
    ).join("\n");
    const invented = Object.entries(COVERAGE)
      .filter(([, value]) => value.element)
      .filter(([, value]) => !sources.includes(JSON.stringify(value.element!)))
      .map(([key, value]) => `${key} -> ${value.element}`);
    expect(invented).toEqual([]);
  });
});

/**
 * The classifications the operator asked about by name, checked against the
 * running code rather than against this file's own prose.
 *
 * A matrix that only agrees with itself is a document with a test harness
 * bolted on. These assertions build the real view models and read the real
 * producer sources, so a classification that stops being true fails here.
 */
const DECISION_PAGE_SURFACES = [
  "components/meta/decision-center/meta-decision-center-exact-adapter.ts",
  "components/meta/decision-center/MetaDecisionCenterExact.tsx",
  "components/meta/redesign/MetaPlatformPage.tsx",
  "components/creatives/creative-evidence-window-exact-adapter.ts",
] as const;

function inventoryEntity(
  overrides: Partial<MetaStructureInventoryEntity> & {
    id: string;
    level: "campaign" | "adset";
  },
): MetaStructureInventoryEntity {
  return {
    name: `entity ${overrides.id}`,
    campaignId: overrides.level === "campaign" ? overrides.id : "camp_1",
    campaignName: overrides.level === "campaign" ? "Parent" : "Parent",
    campaignKind: "main",
    status: "ACTIVE",
    statusLabel: "Active",
    metrics: {
      spend: 1200,
      purchases: 40,
      roas: 3.2,
      cpa: 30,
      ctr: 2.41,
      frequency: 1.17,
    },
    entityConfiguration: {
      source: "account_scoped_campaign_row",
      budgetOwner: "campaign",
      budgetMode: "campaign_budget",
      controlOwner: "campaign",
      status: "ACTIVE",
      optimizationGoal: "Offsite Conversions",
      bidStrategyType: "lowest_cost",
      bidStrategyLabel: "Lowest Cost",
      dailyBudget: 1_000_000,
      lifetimeBudget: null,
      budgetUtilization: null,
    },
    ...overrides,
  } as MetaStructureInventoryEntity;
}

function inventoryWorkspace(
  entities: MetaStructureInventoryEntity[],
): MetaDecisionsWorkspacePayload {
  return {
    lanes: { structureInventory: entities },
  } as unknown as MetaDecisionsWorkspacePayload;
}

describe("Meta Decision payload · the named starting points", () => {
  it("renders the inventory's served CPA as money in the account currency", () => {
    expect(COVERAGE["MetaStructureInventoryEntity.metrics.cpa"]).toMatchObject({
      classification: "WIRED-NOW",
      where: S.INVENTORY,
    });

    const [row] = buildMetaStructureInventoryViewModel({
      workspace: inventoryWorkspace([
        inventoryEntity({ id: "camp_1", level: "campaign" }),
        inventoryEntity({
          id: "camp_2",
          level: "campaign",
          metrics: {
            spend: 0,
            purchases: 0,
            roas: null,
            // The server withholds CPA when there were no purchases to divide
            // by. That absence stays an em dash; it never becomes a zero.
            cpa: null,
            ctr: 0,
            frequency: null,
          },
        }),
      ]),
      fallbackCurrency: "USD",
    }).rows;

    expect(row!.cpa).toBe("$30");
  });

  it("keeps an unserved CPA an em dash and a measured zero CTR a zero", () => {
    const rows = buildMetaStructureInventoryViewModel({
      workspace: inventoryWorkspace([
        inventoryEntity({
          id: "camp_2",
          level: "campaign",
          metrics: {
            spend: 0,
            purchases: 0,
            roas: null,
            cpa: null,
            // Impressions with no clicks is a real, measured zero rate.
            ctr: 0,
            frequency: null,
          },
        }),
      ]),
      fallbackCurrency: "USD",
    }).rows;

    expect(rows[0]!.cpa).toBe("—");
    expect(rows[0]!.ctr).toBe("0.00%");
  });

  it("prints the served CTR as the percentage it already is, never rescaled", () => {
    expect(COVERAGE["MetaStructureInventoryEntity.metrics.ctr"]).toMatchObject({
      classification: "WIRED-NOW",
      where: S.INVENTORY,
    });

    const [row] = buildMetaStructureInventoryViewModel({
      workspace: inventoryWorkspace([
        inventoryEntity({ id: "camp_1", level: "campaign" }),
      ]),
      fallbackCurrency: "USD",
    }).rows;

    // 2.41 is already "2.41%" — the warehouse multiplies by 100 before it
    // serves the field (lib/meta/serving.ts) and Meta's own insight.ctr is a
    // percentage too. Printing "241.00%" is the failure this pins.
    expect(row!.ctr).toBe("2.41%");
    expect(row!.ctr).not.toContain("241");
  });

  it("still withholds the inventory's frequency, and says so in one place", () => {
    const coverage = COVERAGE["MetaStructureInventoryEntity.metrics.frequency"];
    expect(coverage.classification).toBe("INTENTIONALLY-NOT-RENDERED");
    expect(coverage.note).toMatch(/summed across days/);

    const [row] = buildMetaStructureInventoryViewModel({
      workspace: inventoryWorkspace([
        inventoryEntity({ id: "camp_1", level: "campaign" }),
      ]),
      fallbackCurrency: "USD",
    }).rows;

    // The served 1.17 must not appear anywhere on the row: a frequency derived
    // from reach summed over 28 days counts one person up to 28 times, so the
    // ratio it produces is systematically below the truth.
    expect(JSON.stringify(row)).not.toContain("1.17");
  });

  it("gives the two new metric columns no action, no lane and no decision", () => {
    // Inventory visibility is not recommendation or execution eligibility
    // (INVARIANTS.md). Adding measures to a census row must not smuggle
    // authority onto it.
    const [row] = buildMetaStructureInventoryViewModel({
      workspace: inventoryWorkspace([
        inventoryEntity({ id: "camp_1", level: "campaign" }),
      ]),
      fallbackCurrency: "USD",
    }).rows;

    expect(JSON.stringify(row)).not.toMatch(
      /action|lane|decision|launchpad|priority|urgency/i,
    );
    for (const value of Object.values(row!)) {
      expect(typeof value).toBe("string");
    }
  });

  it("withholds deduplicationGrain only while it restates the served authority", () => {
    const coverage =
      COVERAGE["MetaDecisionsWorkspaceReadModel.queue.deduplicationGrain"];
    expect(coverage.classification).toBe("INTENTIONALLY-NOT-RENDERED");

    /*
     * The whole reason for withholding it is an equivalence: every producer
     * sets the grain to "ad" exactly when it sets the authority to native_ad,
     * and to "creative" otherwise. The source panel prints the authority, so
     * the grain would be the same fact in a second vocabulary, and if a
     * producer stops honouring the pairing the classification has to be made
     * again rather than inherited.
     *
     * The equivalence is proven by PAIRING, not by counting: counting 4 writes
     * / 2 "ad" / 2 "creative" passes unchanged if a producer serves "ad" under
     * a non-native authority while another serves "creative" under native_ad,
     * because the totals are symmetric. That proof now lives in
     * lib/meta/decisions-workspace-grain-authority-pairing.test.ts, which runs
     * every producer and reads BOTH fields off the returned model.
     */
    expect(
      readFileSync(
        "lib/meta/decisions-workspace-grain-authority-pairing.test.ts",
        "utf8",
      ),
    ).toContain("expectGrainPairsWithAuthority");

    // And it really is unrendered: any mention on a Decision surface is a
    // comment about the choice, never a read.
    for (const file of DECISION_PAGE_SURFACES) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.includes("deduplicationGrain")) continue;
        expect(line.trim(), file).toMatch(/^(\*|\/\/|\/\*)/);
      }
    }
  });

  it("keeps the suppression envelope and the pre-cap counts on the source panel", () => {
    // Both were named as unrendered and both now reach the operator through
    // the source provenance panel, which is not gated on the queue being
    // empty. The matrix records them as RENDERED, and the adapter that builds
    // that panel is what makes the claim true.
    for (const key of [
      "MetaDecisionsWorkspaceReadModel.queue.omittedFromQueue.count",
      "MetaDecisionSuppressionReason.code",
      "MetaDecisionSuppressionReason.count",
      "MetaDecisionsWorkspaceReadModel.queue.sourcePreCapCount",
      "MetaDecisionsWorkspaceReadModel.queue.queuedPreCapCount",
      "MetaOsDecisionsPresentation.ads.eligiblePreCapCount",
    ]) {
      expect(COVERAGE[key], key).toMatchObject({
        classification: "RENDERED",
        where: S.PROVENANCE,
      });
    }

    const adapter = readFileSync(DECISION_PAGE_SURFACES[0], "utf8");
    expect(adapter).toContain('fact("suppressed-count", "Withheld"');
    expect(adapter).toContain('"Decision source (pre-cap)"');
    expect(adapter).toContain('"Queued (pre-cap)"');
    /*
     * TWO eligible pre-cap numbers, each under a label naming WHICH it is.
     * `queue.adCandidates.eligiblePreCapCount` is what the read model measured;
     * `os.ads.eligiblePreCapCount` is a derived maximum. The bare name belongs
     * to the served field and must never again be worn by the derived one —
     * that is the law this last line pins, and it is why the label had to grow
     * a qualifier rather than being reused.
     */
    expect(adapter).toContain('"Eligible (pre-cap) · read model"');
    expect(adapter).toContain('"Eligible (pre-cap) · derived maximum"');
    expect(adapter).not.toContain('"Eligible (pre-cap)"');
  });

  it("says out loud that the section cap's suppressed count now reaches the panel", () => {
    /*
     * WHAT THIS TEST USED TO SAY, AND WHY IT WAS WRONG. Its name was "says out
     * loud that the section suppression receipt is still unrendered" and it
     * asserted `classification === "INTENTIONALLY-NOT-RENDERED"` — which passed
     * only because it interrogated the TABLE. The probe in this same file had
     * already measured the field moving the source panel, and recorded the
     * contradiction two hundred lines above. A test that reads the
     * classification instead of the code can only ever confirm what the table
     * says, including when the table is wrong; that is the failure mode this
     * whole file exists to remove, committed inside the file itself.
     *
     * So it now asserts the thing that is true, against the adapter that makes
     * it true. The field's consequence on this screen is unchanged and it is
     * why the count is worth printing: a decision the section cap held back is
     * one fewer canonical envelope, and a row without an envelope is a row that
     * cannot open its evidence.
     */
    expect(
      COVERAGE["MetaDecisionSuppressionReceipt.suppressedCount"],
    ).toMatchObject({
      classification: "RENDERED",
      where: S.PROVENANCE,
      element: "section-cap-held-back",
    });

    const adapter = readFileSync(DECISION_PAGE_SURFACES[0], "utf8");
    expect(adapter).toContain('"Section cap · envelopes held back"');
    // Two withholdings, counted separately and never summed: one population is
    // taken before the sections, the other inside them.
    expect(adapter).toContain('fact("suppressed-count", "Withheld"');
  });

  it("counts every read of queue.sections on the Decision page", () => {
    /*
     * The five receipt fields are withheld because no section SELECTS or
     * ORDERS anything on this screen. That is a claim about the reads, and a
     * claim about reads has to be counted rather than asserted in prose — an
     * earlier version of this note said there were two reads when there are
     * three, and the third is on the page itself.
     *
     * All three read the sections into a LOOKUP: two build the canonical
     * envelope table (deduped by decisionId + snapshotId, selecting nothing and
     * ordering nothing) and the third reads only each section's suppression
     * receipt. A FOURTH read, or any of these three growing into a selection,
     * fails here and the withholding has to be argued again.
     */
    const reads: string[] = [];
    for (const file of DECISION_PAGE_SURFACES) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (!/(?:\?\.|\.)sections\b/.test(line)) return;
          // A mention inside a comment is prose about the choice, not a read.
          if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
          reads.push(`${file}:${index + 1}`);
        });
    }
    expect(reads).toHaveLength(3);
    expect(
      reads.filter((read) => read.startsWith(DECISION_PAGE_SURFACES[0])),
    ).toHaveLength(2);
    expect(
      reads.filter((read) => read.startsWith(DECISION_PAGE_SURFACES[2])),
    ).toHaveLength(1);

    // And each of the five entries states that, in the note they share.
    for (const key of [
      "MetaDecisionSuppressionReceipt.receiptId",
      "MetaDecisionSuppressionReceipt.selectionVersion",
      "MetaDecisionSuppressionReceipt.topN",
      "MetaDecisionSuppressionReceipt.preCapCount",
      "MetaDecisionSuppressionReceipt.selectedCount",
    ]) {
      expect(COVERAGE[key]!.classification, key).toBe(
        "INTENTIONALLY-NOT-RENDERED",
      );
      expect(COVERAGE[key]!.note, key).toBe(SECTION_RECEIPT_IS_NOT_DRAWN);
    }
    expect(SECTION_RECEIPT_IS_NOT_DRAWN).toMatch(/exactly three places/);
  });

  it("prints the ROAS reference the server named, under that reference's own noun", () => {
    /*
     * WHAT THIS REPLACED. A tripwire named "the ROAS tile still prints an em
     * dash for a median the server measured", which pinned a DEFECT: the
     * server serves `target: null`, `median: <measured>` and
     * `target_source: "account_median"` for a business unit with no commercial
     * truth (app/api/meta/account-pulse/route.ts:199-207), and
     * `targetRoasDisplay` formatted the null target — so the tile said "we
     * could not tell" about a number the server did tell. The fix landed
     * (meta-decision-center-exact-adapter.ts:250-264), the tripwire went red
     * by design, and this is the assertion that the FIXED behaviour holds.
     *
     * ALL FOUR ARMS, because the fix is a branch on `target_source` and a
     * branch is only correct if every leg of it is. Two of the four are the
     * ones a fix like this breaks:
     *
     *   - "none" must STILL read as an em dash. That arm is the only one where
     *     the server measured nothing (route.ts:209-214), and a fix that
     *     printed a number there would be the inverse defect.
     *   - "commercial_truth_stale" must NOT read as fresh. The qualifier is
     *     the whole difference between a target the operator set last week and
     *     one they set last quarter.
     *
     * AND THE MEDIAN IS NOT A TARGET. The queue's "vs N target" comes from
     * each decision's own `effectiveTargetRoas` and the mobile decision line
     * from `roas.target`, which is null on this arm — so a median wearing the
     * target's noun would contradict both surfaces at once. Both failures are
     * pinned here, not just the old one.
     */
    const workspace = buildProbePayload(null);
    const withRoas = (
      roas: Partial<MetaDecisionsWorkspacePayload["pulse"]["roas"]>,
    ) =>
      buildMetaDecisionCenterExactViewModel({
        workspace: {
          ...workspace,
          pulse: {
            ...workspace.pulse,
            roas: { ...workspace.pulse.roas, ...roas },
          },
        } as MetaDecisionsWorkspacePayload,
        now: PROBE_NOW,
      });

    // 1. The arm the fix is about: a measured median, named as a median.
    const median = withRoas({
      target: null,
      median: 2.1,
      target_source: "account_median",
      targetFreshness: "unknown",
    });
    expect(median.kpis?.roas?.target).toBe("account median 2.10");
    expect(median.kpis?.roas?.target).not.toBe(EM_DASH);
    // Never the target's noun, on any tile of the strip.
    expect(JSON.stringify(median.kpis)).not.toContain("target 2.10");

    // 2. A fresh commercial-truth target: the target's own noun, no qualifier.
    const fresh = withRoas({
      target: 3.4,
      median: 2.1,
      target_source: "commercial_truth",
      targetFreshness: "fresh",
    });
    expect(fresh.kpis?.roas?.target).toBe("target 3.40");
    // The median is served here too and must not be printed beside it.
    expect(fresh.kpis?.roas?.target).not.toContain("2.10");

    // 3. A stale one still states the target, and still says it is stale.
    const stale = withRoas({
      target: 3.4,
      median: 2.1,
      target_source: "commercial_truth_stale",
      targetFreshness: "stale",
    });
    expect(stale.kpis?.roas?.target).toBe("target 3.40 · stale");
    expect(stale.kpis?.roas?.target).not.toBe("target 3.40");

    // 4. Nothing measured at all: the em dash is CORRECT here and stays.
    const none = withRoas({
      target: null,
      median: null,
      target_source: "none",
      targetFreshness: "unknown",
    });
    expect(none.kpis?.roas?.target).toBe(`target ${EM_DASH}`);
    expect(none.kpis?.roas?.target).not.toContain("account median");

    // And the matrix agrees with the code it just watched.
    expect(COVERAGE["MetaPulsePayload.roas.median"]).toMatchObject({
      classification: "WIRED-NOW",
      where: S.KPI,
    });
    expect(WITHHELD_BY_DEFECT["MetaPulsePayload.roas.median"]).toBeUndefined();
  });

  it("checks every other screen a withholding defers to, because a name is not a screen", () => {
    /*
     * The sweep the pacing repair called for. A reason that names another
     * screen is only as good as that screen's existence, so each name is
     * pinned to a file and to the string in it that does the thing the note
     * credits the screen with.
     */
    const withheld = Object.values(COVERAGE)
      .filter((value) => value.classification === "INTENTIONALLY-NOT-RENDERED")
      .map((value) => value.note);

    for (const [screen, pin] of Object.entries(OTHER_SCREENS_NAMED)) {
      // No dead entries: a screen nobody defers to any more leaves this table.
      expect(
        withheld.some((note) => note.includes(screen)),
        `${screen} is pinned but no withholding names it`,
      ).toBe(true);
      expect(existsSync(pin.file), `${screen} -> ${pin.file}`).toBe(true);
      expect(
        readFileSync(pin.file, "utf8"),
        `${screen} -> ${pin.file}`,
      ).toContain(pin.proves);
    }

    /*
     * AND NO UNCHECKED NAME MAY APPEAR. The candidate list is the dashboard's
     * own route segments, title-cased, so a withholding that starts deferring
     * to "Insights" or "Integrations" fails here until someone opens that
     * screen and pins what it does.
     */
    const segments = readdirSync("app/(dashboard)", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        entry.name
          .split("-")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" "),
      );
    const unchecked = segments.filter(
      (screen) =>
        !(screen in OTHER_SCREENS_NAMED) &&
        withheld.some((note) => new RegExp(`\\b${screen}\\b`).test(note)),
    );
    expect(unchecked).toEqual([]);

    /*
     * AND THE EXACT FALSE SENTENCE MAY NOT COME BACK: no withholding may put
     * month-to-date pacing on Overview again.
     */
    for (const note of withheld) {
      if (!/Overview/.test(note)) continue;
      expect(note, note).not.toMatch(/month-to-date|pacing/i);
    }
  });

  it("proves the pacing withholding from the route's arithmetic, not from another screen's name", () => {
    /*
     * The reason these four are withheld used to name the Overview surface. A
     * reason that names another screen is only as good as that screen's
     * existence, and this one was false: Overview exists and draws Spend,
     * Revenue, ROAS and CPA with a previous-period comparison, but it draws no
     * month-to-date pacing at all. @see PACING_IS_EXTRAPOLATED_FROM_SPEND
     *
     * So the reason is now proven the way this file's better entries are
     * proven: off the producer's own source, and off a walk of the repo.
     */
    for (const key of PACING_IS_EXTRAPOLATED_FROM_SPEND) {
      expect(COVERAGE[key], key).toMatchObject({
        classification: "INTENTIONALLY-NOT-RENDERED",
      });
      expect(COVERAGE[key]!.note, key).not.toMatch(/Overview/);
      expect(COVERAGE[key]!.note, key).toMatch(
        /PACING_IS_EXTRAPOLATED_FROM_SPEND/,
      );
    }

    // 1. The three formulas, read off the route that writes them.
    const pulseRoute = readFileSync(
      "app/api/meta/account-pulse/route.ts",
      "utf8",
    );
    expect(pulseRoute).toContain(
      "const mtdTarget = Math.max(mtdTotals.spend, (mtdTotals.spend / currentDayOfMonth) * 30);",
    );
    expect(pulseRoute).toContain(
      "dayPace: mtdTarget > 0 ? mtdTotals.spend / mtdTarget : 0,",
    );
    expect(pulseRoute).toContain("dailyTarget: mtdTarget / 30,");
    // And no operator-set budget anywhere in the derivation.
    expect(pulseRoute).not.toMatch(
      /mtdTarget\s*=\s*[^;]*(budget|commercialTarget|target_source)/,
    );

    /*
     * 2. THE DEGENERACY, BY ARITHMETIC. `dayPace` divides month-to-date spend
     * by an extrapolation OF month-to-date spend, so the spend cancels: on
     * every day before the 30th it is the fraction of the month elapsed, and
     * on the 30th and 31st it is 1 — for any account, at any spend. A ratio
     * that cannot tell an overspending account from a stopped one is not a
     * pace, and printing it as one would be the fabricated-measurement defect.
     */
    const dayPaceFor = (spend: number, dayOfMonth: number) => {
      const mtdTarget = Math.max(spend, (spend / dayOfMonth) * 30);
      return mtdTarget > 0 ? spend / mtdTarget : 0;
    };
    for (const day of [1, 7, 15, 29]) {
      for (const spend of [12.5, 4_000, 1_250_000]) {
        expect(dayPaceFor(spend, day), `day ${day} spend ${spend}`).toBeCloseTo(
          day / 30,
          10,
        );
      }
    }
    for (const day of [30, 31]) {
      for (const spend of [12.5, 4_000, 1_250_000]) {
        expect(dayPaceFor(spend, day), `day ${day} spend ${spend}`).toBeCloseTo(
          1,
          10,
        );
      }
    }
    // A measured zero stays a zero rather than becoming a NaN or a 1.
    expect(dayPaceFor(0, 12)).toBe(0);

    /*
     * 3. THE COMPLETE SET OF NON-TEST FILES THAT NAME THESE FIELDS AT ALL.
     *
     * This is the assertion the old note needed and did not have. It walks
     * `app`, `components` and `lib` — every `.ts`/`.tsx` that is not a test —
     * and pins every file mentioning any of the four names, with what it does
     * with it. There is no renderer among them. The day one appears, this
     * fails and the withholding has to be argued again rather than inherited.
     */
    const walk = (dir: string, sink: string[]) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith("."))
            continue;
          if (entry.name === "archive") continue;
          walk(path, sink);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        sink.push(path);
      }
      return sink;
    };
    const named = walk("app", walk("components", walk("lib", [])))
      .filter((file) =>
        /\b(mtdSpend|mtdTarget|dayPace|dailyTarget)\b/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .sort();
    expect(named).toEqual(Object.keys(PACING_FIELD_MENTIONS).sort());
  });

  it("renders the served mixed-bid flag exactly where the value it qualifies is", () => {
    expect(COVERAGE["MetaHealthyEntity.isBidStrategyMixed"]).toMatchObject({
      classification: "WIRED-NOW",
      where: S.HEALTHY,
    });
    // The three flags whose value the Healthy lane does not print stay
    // withheld, and each says that is the reason.
    for (const key of [
      "MetaHealthyEntity.isOptimizationGoalMixed",
      "MetaHealthyEntity.isCustomEventTypeMixed",
      "MetaHealthyEntity.isBidValueMixed",
    ]) {
      expect(COVERAGE[key], key).toMatchObject({
        classification: "INTENTIONALLY-NOT-RENDERED",
      });
      expect(COVERAGE[key]!.note, key).toMatch(
        /mixed flag is rendered exactly where/,
      );
    }
  });

  it("counts what this round changed, so the report and the matrix agree", () => {
    /*
     * WIRED-NOW is the fields a wiring lane in THIS round put on screen and
     * named in its handoff. It is not "younger than the deployed release" —
     * almost every surface this matrix names is younger than that, and a rule
     * that swept two hundred entries in here would say nothing about anything.
     * This round also wires the OS structure lane into the visible lane totals
     * and recommendation routing; that single entry is listed with the budget
     * and pipeline surface work below.
     */
    const wired = Object.entries(COVERAGE)
      .filter(([, value]) => value.classification === "WIRED-NOW")
      .map(([key]) => key)
      .sort();
    expect(wired).toEqual([
      /*
        PRE-DEPLOY AUDIT — the budget wiring lane of THIS round: the
        directional evidence panel, the gate verdict it publishes and the
        dry-run preview, all three mounted by `MetaPlatformPage`. Every entry
        below is measured on the MOBILE surface by the probe, and the five
        that only render on an unavailable panel or a not-clear section are
        measured in the two scenarios added for exactly that.
      */
      "DryRunPanelFact.label",
      "DryRunPanelFact.value",
      "EvidencePanelSection.blockerCodes",
      "EvidencePanelSection.clear",
      "EvidencePanelSection.reasons",
      "EvidencePanelSection.section",
      "MetaBudgetDecisionEvidenceByDirection.directionSelected",
      "MetaBudgetDecisionEvidenceByDirection.directionSelectedWhy",
      "MetaBudgetDecisionEvidenceByDirection.directionToAction.decrease",
      "MetaBudgetDecisionEvidenceByDirection.directionToAction.increase",
      "MetaBudgetDecisionEvidencePanel.authority",
      "MetaBudgetDecisionEvidencePanel.commercialLineage.anchorExplanation",
      "MetaBudgetDecisionEvidencePanel.commercialLineage.availability.status",
      "MetaBudgetDecisionEvidencePanel.commercialLineage.code",
      "MetaBudgetDecisionEvidencePanel.commercialLineage.contractVersion",
      "MetaBudgetDecisionEvidencePanel.commercialLineage.eligible",
      "MetaBudgetDecisionEvidencePanel.commercialLineage.reason",
      "MetaBudgetDecisionEvidencePanel.commercialLineage.selectedAction",
      "MetaBudgetDecisionEvidencePanel.executionReadiness.ctaEnabled",
      "MetaBudgetDecisionEvidencePanel.executionReadiness.state",
      "MetaBudgetDecisionEvidencePanel.executionReadiness.why",
      "MetaBudgetDecisionEvidencePanel.primaryBlocker.code",
      "MetaBudgetDecisionEvidencePanel.primaryBlocker.reason",
      "MetaBudgetDecisionEvidencePanel.status",
      "MetaBudgetDecisionEvidencePanel.unavailableReason",
      "MetaBudgetDryRunPanel.contractVersion",
      "MetaBudgetDryRunPanel.execution.ctaEnabled",
      "MetaBudgetDryRunPanel.execution.ctaLabel",
      "MetaBudgetDryRunPanel.execution.executionState",
      "MetaBudgetDryRunPanel.execution.nextRequirement",
      "MetaBudgetDryRunPanel.execution.providerOutcome",
      "MetaBudgetDryRunPanel.execution.providerWriteAttempted",
      "MetaBudgetDryRunPanel.execution.readbackClassification",
      "MetaBudgetDryRunPanel.fingerprints.input",
      "MetaBudgetDryRunPanel.fingerprints.policy",
      "MetaBudgetDryRunPanel.fingerprints.preflight",
      "MetaBudgetDryRunPanel.headline",
      "MetaBudgetDryRunPanel.observed.note",
      "MetaBudgetDryRunPanel.observed.title",
      "MetaBudgetDryRunPanel.proposed.available",
      "MetaBudgetDryRunPanel.proposed.note",
      "MetaBudgetDryRunPanel.proposed.title",
      "MetaBudgetDryRunPanel.required.blockers[].code",
      "MetaBudgetDryRunPanel.required.blockers[].why",
      "MetaBudgetDryRunPanel.required.note",
      "MetaBudgetDryRunPanel.required.readbackRequirement",
      "MetaBudgetDryRunPanel.required.title",
      "MetaBudgetDryRunPanel.required.writeSafetyMissing",
      "MetaBudgetDryRunPanel.simulated.available",
      "MetaBudgetDryRunPanel.simulated.note",
      "MetaBudgetDryRunPanel.simulated.title",
      "MetaBudgetDryRunPanel.status",
      "MetaBudgetDryRunPanel.unavailableReason",
      "MetaCampaignRoleCoverage.actionAuthoritativeCampaigns",
      "MetaCampaignRoleCoverage.unresolvedCampaigns",
      "MetaCanonicalDecision.sourceDecision.computedAt",
      // D073's pipeline-health envelope: the exact decision-generation clock,
      // the generation manifest, and the four operational facts (successful
      // sync activity, finalized warehouse cutoff, growth-fence admission with
      // its exact offender, and the overall/executionReady verdict). All 38
      // leaves landed on the source-provenance panel and blocking banner in
      // this round.
      "MetaDecisionPipelineHealth.decisionGeneration.ageHours",
      "MetaDecisionPipelineHealth.decisionGeneration.computedAt",
      "MetaDecisionPipelineHealth.decisionGeneration.engineVersion",
      "MetaDecisionPipelineHealth.decisionGeneration.maxAgeHours",
      "MetaDecisionPipelineHealth.decisionGeneration.reason",
      "MetaDecisionPipelineHealth.decisionGeneration.status",
      "MetaDecisionPipelineHealth.manifest.authority",
      "MetaDecisionPipelineHealth.manifest.expectedAdCount",
      "MetaDecisionPipelineHealth.manifest.jobRunId",
      "MetaDecisionPipelineHealth.manifest.manifestHash",
      "MetaDecisionPipelineHealth.manifest.reason",
      "MetaDecisionPipelineHealth.manifest.status",
      "MetaDecisionPipelineOperationalHealth.admission.allowed",
      "MetaDecisionPipelineOperationalHealth.admission.evaluatedAt",
      "MetaDecisionPipelineOperationalHealth.admission.offender.budget",
      "MetaDecisionPipelineOperationalHealth.admission.offender.bytes",
      "MetaDecisionPipelineOperationalHealth.admission.offender.overByBytes",
      "MetaDecisionPipelineOperationalHealth.admission.offender.table",
      "MetaDecisionPipelineOperationalHealth.admission.reason",
      "MetaDecisionPipelineOperationalHealth.admission.status",
      "MetaDecisionPipelineOperationalHealth.blockers",
      "MetaDecisionPipelineOperationalHealth.contractVersion",
      "MetaDecisionPipelineOperationalHealth.evaluatedAt",
      "MetaDecisionPipelineOperationalHealth.executionReady",
      "MetaDecisionPipelineOperationalHealth.overall",
      "MetaDecisionPipelineOperationalHealth.syncActivity.ageMinutes",
      "MetaDecisionPipelineOperationalHealth.syncActivity.latestAt",
      "MetaDecisionPipelineOperationalHealth.syncActivity.latestJobStatus",
      "MetaDecisionPipelineOperationalHealth.syncActivity.latestRunStatus",
      "MetaDecisionPipelineOperationalHealth.syncActivity.maxAgeMinutes",
      "MetaDecisionPipelineOperationalHealth.syncActivity.reason",
      "MetaDecisionPipelineOperationalHealth.syncActivity.status",
      "MetaDecisionPipelineOperationalHealth.warehouse.accountTimeZone",
      "MetaDecisionPipelineOperationalHealth.warehouse.expectedFinalizedDate",
      "MetaDecisionPipelineOperationalHealth.warehouse.lagDays",
      "MetaDecisionPipelineOperationalHealth.warehouse.latestFinalizedDate",
      "MetaDecisionPipelineOperationalHealth.warehouse.reason",
      "MetaDecisionPipelineOperationalHealth.warehouse.status",
      "MetaDecisionSourceAuthority.decisionFreshness.ageHours",
      "MetaDecisionSourceAuthority.decisionFreshness.maxAgeHours",
      "MetaDecisionSourceAuthority.decisionFreshness.status",
      "MetaDecisionSourceAuthority.executionReadiness",
      // The five fields of one sentence on the silent-failure banner: the
      // count, the denominator it is a share of, the window it covers, whether
      // that count is capped, and the cap that capped it. The last two are the
      // sentence's WIDTH — both counts are filtered from a bounded action-log
      // read, so without them a page of the window reads as the window.
      "MetaDecisionsDigest.actions.countedRowCap",
      "MetaDecisionsDigest.actions.countsTruncated",
      "MetaDecisionsDigest.actions.silentFailureCount",
      "MetaDecisionsDigest.actions.verifiedCount",
      "MetaDecisionsDigest.snapshotDate",
      "MetaDecisionsWorkspacePayload.endDate",
      "MetaDecisionsWorkspaceReadModel.queue.adCandidates.eligiblePreCapCount",
      "MetaDecisionsWorkspaceReadModel.status",
      "MetaHealthyEntity.isBidStrategyMixed",
      // The evidence inspector's provenance band: the window every figure on
      // the panel covers, the moment the engine wrote the snapshot, and the
      // metrics the payload did not serve at this row's grain. All three were
      // in the payload and on no screen.
      "MetaLanePayload.endDate",
      "MetaLanePayload.snapshotCreatedAt",
      "MetaLanePayload.startDate",
      // D074b/D076: the automatic campaign-role explanation the workspace
      // serves per campaign — rendered verbatim on the evidence window.
      "MetaOsCampaignRoleExplanation.confidenceClass",
      "MetaOsCampaignRoleExplanation.confidenceScore",
      "MetaOsCampaignRoleExplanation.conflictReasons",
      "MetaOsCampaignRoleExplanation.evidence",
      "MetaOsCampaignRoleExplanation.kind",
      "MetaOsCampaignRoleExplanation.lastEvaluatedAt",
      "MetaOsCampaignRoleExplanation.resolverVersion",
      "MetaOsCampaignRoleExplanation.unresolvedReason",
      "MetaOsDecisionMetrics.cpa",
      "MetaOsDecisionMetrics.ctr",
      "MetaOsStructureNode.lane",
      // The token that says whether the figures on this page measure this
      // account at all, which until this round reached nothing on a demo
      // business — the one state where it is the only thing that would.
      "MetaPulsePayload.dataReadiness.evidenceSource",
      // The account median, which this round moved off the WITHHELD_BY_DEFECT
      // list and onto the ROAS tile under its own noun.
      "MetaPulsePayload.roas.median",
      "MetaSnapshotHealth.engineVersion",
      "MetaStructureInventoryEntity.metrics.cpa",
      "MetaStructureInventoryEntity.metrics.ctr",
    ]);
  });
});
