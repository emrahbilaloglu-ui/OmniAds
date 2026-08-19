import {
  isExactActiveMetaDecisionDeliveryScope,
  type MetaCanonicalDecision,
} from "@/lib/meta/decisions-workspace-contract";

/**
 * The Decisions -> Launchpad handoff CONTRACT: types, policy, encoding.
 *
 * Split out of the persistence module on purpose. The refusal vocabulary and
 * the sentence that explains each refusal have to be renderable by the
 * Decisions surface, which is a client component; importing the module that
 * opens a database connection would drag `pg` into the browser bundle. So the
 * law lives here, pure and testable with no I/O, and
 * `lib/meta/launchpad-handoff.ts` re-exports all of it alongside the reads and
 * writes.
 *
 * It also deliberately imports nothing from `node:crypto`. The Decisions
 * surface is a client component; a single `node:crypto` import here would put
 * a Node builtin into the browser bundle. Token hashing and comparison live
 * with the database code that needs them.
 *
 * Nothing in this file grants anything. `authorizeLaunchpadHandoff` decides
 * whether a decision the SERVER already read may open Launchpad; it is never
 * to be called against a decision a client supplied.
 */

export const LAUNCHPAD_HANDOFF_KIND = "meta_launchpad_decision_handoff" as const;
export const LAUNCHPAD_HANDOFF_ENVELOPE_VERSION = "v1" as const;

/**
 * Short on purpose. A handoff is the gap between clicking Rebuild and landing
 * on Launchpad; anything longer is a durable capability nobody asked for.
 */
export const LAUNCHPAD_HANDOFF_TTL_MS = 15 * 60_000;

/**
 * How long a CONSUMED handoff can still prefill the wizard.
 *
 * The bearer token is single-use and is burned the moment the Launchpad route
 * reads it, so the reference cannot survive into the address bar. But the
 * wizard the burn opens has to survive a browser reload, and re-minting from
 * Decisions on every refresh is not a draft. So the burned record stays
 * READABLE — by the same user, in the same business, in the same
 * assignment-verified account — for this long after it was consumed, and
 * reading it grants nothing: it prefills a draft and every Launchpad write
 * route still refuses on its own authority.
 *
 * Bounded rather than permanent, because a draft that never expires is a
 * durable capability nobody asked for, and because the selections inside it
 * were authorized against a decision that is re-read at consume time and never
 * again.
 */
export const LAUNCHPAD_HANDOFF_PREFILL_TTL_MS = 30 * 60_000;

/**
 * `rebuild` and `duplicate` come from a canonical decision's authorized action.
 * `copy_draft` does NOT: it carries a copy line from the Copies surface, which
 * the canonical contract classes as discovery evidence only, and it therefore
 * arrives with no authorized action and no execution eligibility at all.
 */
export type LaunchpadHandoffMode = "rebuild" | "duplicate" | "copy_draft";

export type LaunchpadHandoffAuthorizedAction = "scale" | "cut" | "refresh";

/** What kind of thing was on screen when the operator asked for a launch. */
export type LaunchpadHandoffOrigin = "decision" | "copy";

/**
 * `native_exact` is the only status that can carry an authorized action.
 *
 * `warehouse_discovery` exists so a Copies row can travel WITHOUT pretending to
 * be a decision. The canonical contract is explicit: "Warehouse entity rows,
 * recommendation payloads, and synthetic IDs are discovery evidence only." A
 * copies row is a warehouse aggregate; it has no decision id and no snapshot
 * id, so it is labelled for what it is rather than given a fabricated lineage.
 */
export type LaunchpadHandoffSourceAuthorityStatus =
  | "native_exact"
  | "warehouse_discovery";

/**
 * Every reason a decision does not become a Launchpad handoff.
 *
 * Named individually because "it didn't work" is not a refusal an operator can
 * act on, and because each one is a separate law with a separate test.
 */
export type LaunchpadHandoffRefusalCode =
  | "provider_account_mismatch"
  | "source_authority_missing"
  | "source_authority_review_only"
  | "demo_synthetic_review_only"
  | "action_not_eligible"
  | "no_authorized_action"
  | "decision_state_not_act"
  | "decision_held"
  | "decision_blocked"
  | "authorized_action_has_no_launchpad_mode"
  | "lineage_incomplete";

export interface LaunchpadHandoffLineage {
  sourceDecisionId: string;
  sourceSnapshotId: string;
  episodeId: string | null;
  engineVersion: string;
  snapshotAsOf: string | null;
  decisionHash: string | null;
  inputHash: string | null;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  creativeId: string | null;
}

/**
 * The provider objects the launch is ABOUT, in the shape the wizard selects in.
 *
 * Held separately from `lineage` because these two answer different questions.
 * Lineage answers "which server verdict authorized this" and is evidence.
 * Selection answers "which campaign / ad set / creative should already be
 * ticked when the wizard opens" and is a prefill. Before this existed the
 * envelope carried the ids only inside lineage and the Launchpad body received
 * none of them, so a verified handoff opened an empty picker.
 */
export interface LaunchpadHandoffSelection {
  campaignIds: string[];
  adsetIds: string[];
  adIds: string[];
  creativeIds: string[];
}

/**
 * The window the evidence behind this handoff was measured over, frozen.
 *
 * Immutable on purpose: the operator may change the dashboard range between
 * minting and landing, and the launch must still be able to say what it was
 * decided from. Every field is nullable and a null means UNKNOWN — never
 * "today", never a default range. A window nobody recorded is not a window.
 *
 * `decision_snapshot` records the engine's own as-of date and computation time;
 * a decision is not evaluated over an operator-chosen range, so inventing
 * start/end dates for it would state a fact the engine never produced.
 * `requested_metrics_window` is the explicit start/end a metrics surface (the
 * Copies table) was actually showing.
 */
export interface LaunchpadHandoffEvidenceWindow {
  basis: "decision_snapshot" | "requested_metrics_window";
  startDate: string | null;
  endDate: string | null;
  snapshotAsOf: string | null;
  computedAt: string | null;
}

/**
 * A copy line carried out of the Copies drawer.
 *
 * `alternateText` is the line the operator picked; `sourceText` is the line it
 * would replace. Both are recorded because a rewrite that cannot say what it
 * rewrote is not lineage.
 */
export interface LaunchpadHandoffCopyIdentity {
  copyId: string;
  alternateId: string | null;
  alternateText: string;
  sourceText: string | null;
  assetType: string | null;
}

export interface LaunchpadHandoffEnvelope {
  version: typeof LAUNCHPAD_HANDOFF_ENVELOPE_VERSION;
  handoffId: string;
  /** SHA-256 of the bearer token. The token itself is never persisted. */
  tokenHash: string;
  businessId: string;
  providerAccountId: string;
  createdByUserId: string | null;
  origin: LaunchpadHandoffOrigin;
  /**
   * The server's own verdict, copied — never recomputed by a client. Null for
   * a `copy` origin, which authorizes no action at all.
   */
  authorizedAction: LaunchpadHandoffAuthorizedAction | null;
  mode: LaunchpadHandoffMode;
  actionEligible: boolean;
  /**
   * Evidence only. False whenever the current served hierarchy is not exactly
   * ACTIVE at every level, and false when it could not be reconciled at all —
   * an unknown status fails closed, it does not read as active.
   */
  exactAdExecutionEligible: boolean;
  sourceAuthorityStatus: LaunchpadHandoffSourceAuthorityStatus;
  /** Present only for a `decision` origin. A copy row has no decision lineage. */
  lineage: LaunchpadHandoffLineage | null;
  selection: LaunchpadHandoffSelection;
  evidenceWindow: LaunchpadHandoffEvidenceWindow;
  /** Present only for a `copy` origin. */
  copy: LaunchpadHandoffCopyIdentity | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface LaunchpadHandoffAuthorization {
  mode: LaunchpadHandoffMode;
  authorizedAction: LaunchpadHandoffAuthorizedAction;
  exactAdExecutionEligible: boolean;
  lineage: LaunchpadHandoffLineage;
  selection: LaunchpadHandoffSelection;
  evidenceWindow: LaunchpadHandoffEvidenceWindow;
}

export type LaunchpadHandoffAuthorizationResult =
  | { ok: true; authorization: LaunchpadHandoffAuthorization }
  | { ok: false; refusal: LaunchpadHandoffRefusalCode };

/**
 * The canonical action -> Launchpad mode map, and the only one.
 *
 * `cut` is deliberately absent. Cutting is not a launch, and mapping it to any
 * Launchpad mode is exactly the failure the canonical invariant names: "a held
 * Cut with compatibility label test_more must never appear as Fresh Test". A
 * Cut therefore has no Launchpad destination at all, held or not.
 */
export function launchpadModeForAuthorizedAction(
  action: LaunchpadHandoffAuthorizedAction,
): LaunchpadHandoffMode | null {
  if (action === "refresh") return "rebuild";
  if (action === "scale") return "duplicate";
  return null;
}

/**
 * Where in the wizard a verified handoff lands.
 *
 * One function, so the route that redirects and the body that renders cannot
 * disagree about what "rebuild" opens. `copy_draft` lands on the same picker as
 * `rebuild` because a copy line is drafted against a NEW ad, never bolted onto
 * an existing one.
 */
export function launchpadWizardTargetForHandoffMode(mode: LaunchpadHandoffMode): {
  launchpadMode: "new_campaign" | "add_to_existing";
  launchpadStep: "creatives";
} {
  return {
    launchpadMode: mode === "duplicate" ? "add_to_existing" : "new_campaign",
    launchpadStep: "creatives",
  };
}

/** Distinct, deduplicated, blank-free — the only ids that reach the wizard. */
function idList(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

export function buildLaunchpadHandoffSelection(input: {
  campaignIds?: ReadonlyArray<string | null | undefined>;
  adsetIds?: ReadonlyArray<string | null | undefined>;
  adIds?: ReadonlyArray<string | null | undefined>;
  creativeIds?: ReadonlyArray<string | null | undefined>;
}): LaunchpadHandoffSelection {
  return {
    campaignIds: idList(input.campaignIds ?? []),
    adsetIds: idList(input.adsetIds ?? []),
    adIds: idList(input.adIds ?? []),
    creativeIds: idList(input.creativeIds ?? []),
  };
}

export const EMPTY_LAUNCHPAD_HANDOFF_SELECTION: LaunchpadHandoffSelection =
  buildLaunchpadHandoffSelection({});

/**
 * Does this served decision authorize opening Launchpad at all?
 *
 * Pure, so the law is readable and testable without a database. The order of
 * the gates matters: identity and authority first, then state, then the mode
 * map, then lineage. A decision that fails an earlier gate must not be able to
 * be "rescued" by a later field.
 *
 * The canonical invariant this enforces, verbatim: "A blocked, held,
 * review-only, or action-ineligible canonical decision must not map to any
 * Launchpad mode."
 */
export function authorizeLaunchpadHandoff(input: {
  decision: MetaCanonicalDecision;
  providerAccountId: string;
}): LaunchpadHandoffAuthorizationResult {
  const decision = input.decision;

  // Cross-account: the decision must belong to the account being acted in.
  if (decision.providerAccountId !== input.providerAccountId) {
    return { ok: false, refusal: "provider_account_mismatch" };
  }

  const authority = decision.sourceAuthority;
  if (!authority) return { ok: false, refusal: "source_authority_missing" };

  // Demo first and by itself, because the invariant is absolute: "Demo
  // businesses have zero Meta write authority even if a presentation defect
  // supplies an action." A demo envelope that somehow arrives with
  // actionEligible true and an authorizedAction must still be refused, and
  // refused under its own name so the defect is visible in the receipt.
  if (authority.status === "demo_synthetic_review_only") {
    return { ok: false, refusal: "demo_synthetic_review_only" };
  }
  if (authority.status !== "native_exact") {
    return { ok: false, refusal: "source_authority_review_only" };
  }
  if (authority.actionEligible !== true) {
    return { ok: false, refusal: "action_not_eligible" };
  }
  if (!authority.authorizedAction) {
    return { ok: false, refusal: "no_authorized_action" };
  }

  const classification = decision.classification;
  if (classification.decisionState !== "act") {
    return {
      ok: false,
      refusal:
        classification.decisionState === "blocked"
          ? "decision_blocked"
          : "decision_state_not_act",
    };
  }
  // A held action is a decision the engine reached and then withheld. It is
  // not a smaller version of an authorized action.
  if (classification.heldAction !== null) {
    return { ok: false, refusal: "decision_held" };
  }
  if (classification.blockers.length > 0) {
    return { ok: false, refusal: "decision_blocked" };
  }

  const mode = launchpadModeForAuthorizedAction(authority.authorizedAction);
  if (!mode) {
    return { ok: false, refusal: "authorized_action_has_no_launchpad_mode" };
  }

  const sourceDecisionId = decision.decisionId?.trim() || "";
  const sourceSnapshotId = decision.sourceSnapshotId?.trim() || "";
  if (!sourceDecisionId || !sourceSnapshotId) {
    return { ok: false, refusal: "lineage_incomplete" };
  }

  const campaignId = decision.parentChain.campaign?.id?.trim() || null;
  const adsetId = decision.parentChain.adset?.id?.trim() || null;
  const adId = decision.parentChain.ad?.id?.trim() || null;
  const creativeId = decision.parentChain.creative?.id?.trim() || null;

  return {
    ok: true,
    authorization: {
      mode,
      authorizedAction: authority.authorizedAction,
      // Recorded, not granted. `isExactActiveMetaDecisionDeliveryScope`
      // returns false for an unknown reconciliation, which is the fail-closed
      // answer the canonical contract requires.
      exactAdExecutionEligible: isExactActiveMetaDecisionDeliveryScope(
        decision.deliveryScope,
      ),
      lineage: {
        sourceDecisionId,
        sourceSnapshotId,
        episodeId: decision.episodeId?.trim() || null,
        engineVersion: authority.engineVersion,
        snapshotAsOf: decision.sourceDecision.snapshotAsOf ?? null,
        decisionHash: authority.decisionHash ?? null,
        inputHash: authority.inputHash ?? null,
        campaignId,
        adsetId,
        adId,
        creativeId,
      },
      // The same ids, in the shape the wizard actually selects in. A `rebuild`
      // preselects the creative it is rebuilding; a `duplicate` additionally
      // preselects the campaign and ad set it is duplicating INTO, which is
      // what makes "add to existing" land on a target instead of an empty list.
      selection: buildLaunchpadHandoffSelection({
        creativeIds: [creativeId],
        adIds: [adId],
        campaignIds: mode === "duplicate" ? [campaignId] : [],
        adsetIds: mode === "duplicate" ? [adsetId] : [],
      }),
      // A decision is evaluated against a snapshot, not against an
      // operator-chosen range, so start/end stay null rather than being
      // back-filled from whatever the dashboard happened to be showing.
      evidenceWindow: {
        basis: "decision_snapshot",
        startDate: null,
        endDate: null,
        snapshotAsOf: decision.sourceDecision.snapshotAsOf ?? null,
        computedAt: decision.sourceDecision.computedAt ?? null,
      },
    },
  };
}

/** `<handoffId>.<token>` — the only thing that ever rides in a URL. */
export function formatLaunchpadHandoffReference(input: {
  handoffId: string;
  token: string;
}): string {
  return `${input.handoffId}.${input.token}`;
}

export function parseLaunchpadHandoffReference(
  raw: string | null | undefined,
): { handoffId: string; token: string } | null {
  const value = raw?.trim() ?? "";
  if (!value || value.length > 256) return null;
  const separator = value.indexOf(".");
  if (separator <= 0) return null;
  const handoffId = value.slice(0, separator);
  const token = value.slice(separator + 1);
  // UUID shape for the id and an opaque base64url token. Anything else cannot
  // be one of ours, and refusing it here keeps malformed input out of SQL.
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      handoffId,
    )
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  return { handoffId, token };
}

export type LaunchpadHandoffConsumeRefusal =
  | "malformed_reference"
  | "not_found"
  | "token_mismatch"
  | "business_mismatch"
  | "provider_account_mismatch"
  | "actor_mismatch"
  | "expired"
  | "already_consumed"
  | "read_failed";

/**
 * Refusals that only the LANDING side can issue.
 *
 * These are re-checks, not repeats: the record was authorized against the world
 * as it stood when it was minted, and the request that lands is a different
 * request. Between the two the operator may have lost collaborator access, the
 * workspace may have been flagged demo, the account may have been unassigned,
 * or the engine may have re-run and withdrawn the decision entirely.
 */
export type LaunchpadHandoffLandingRefusal =
  | "write_authority_revoked"
  | "decision_not_served"
  | "decision_source_unavailable"
  | "decision_authority_changed"
  | "prefill_expired";

export type LaunchpadHandoffAnyRefusal =
  | LaunchpadHandoffRefusalCode
  | LaunchpadHandoffConsumeRefusal
  | LaunchpadHandoffLandingRefusal
  | "copy_identity_missing"
  | "persist_failed";

const ALL_LAUNCHPAD_HANDOFF_REFUSALS: readonly LaunchpadHandoffAnyRefusal[] = [
  "provider_account_mismatch",
  "source_authority_missing",
  "source_authority_review_only",
  "demo_synthetic_review_only",
  "action_not_eligible",
  "no_authorized_action",
  "decision_state_not_act",
  "decision_held",
  "decision_blocked",
  "authorized_action_has_no_launchpad_mode",
  "lineage_incomplete",
  "malformed_reference",
  "not_found",
  "token_mismatch",
  "business_mismatch",
  "actor_mismatch",
  "expired",
  "already_consumed",
  "read_failed",
  "persist_failed",
  "write_authority_revoked",
  "decision_not_served",
  "decision_source_unavailable",
  "decision_authority_changed",
  "prefill_expired",
  "copy_identity_missing",
];

/**
 * Reads a refusal code back off a URL.
 *
 * A refusal travels from the Launchpad read site back to Decisions as a code,
 * and Decisions turns it into the sentence below. The code is validated
 * against the closed vocabulary rather than echoed, so a hand-edited URL
 * cannot put arbitrary text on the screen — an unknown code is simply not a
 * refusal this system issued.
 */
export function parseLaunchpadHandoffRefusal(
  raw: string | null | undefined,
): LaunchpadHandoffAnyRefusal | null {
  const value = raw?.trim() ?? "";
  return (
    ALL_LAUNCHPAD_HANDOFF_REFUSALS.find((code) => code === value) ?? null
  );
}

/**
 * The operator-facing sentence for a refusal.
 *
 * A refused handoff must say what happened. "Nothing opened" with no reason is
 * indistinguishable from a broken button, which is the state this whole seam
 * was in before.
 */
export function describeLaunchpadHandoffRefusal(
  refusal: LaunchpadHandoffAnyRefusal,
): string {
  switch (refusal) {
    case "provider_account_mismatch":
      return "That decision belongs to a different Meta ad account than the one in scope.";
    case "business_mismatch":
      return "That handoff was created for a different business.";
    case "actor_mismatch":
      return "That handoff was created by a different user.";
    case "source_authority_missing":
    case "source_authority_review_only":
      return "The decision is review-only: its source carries no execution authority.";
    case "demo_synthetic_review_only":
      return "Demo decisions have no Meta write authority, so they cannot open a launch.";
    case "action_not_eligible":
      return "The server did not mark this decision action-eligible.";
    case "no_authorized_action":
      return "The server authorized no action for this decision.";
    case "decision_state_not_act":
      return "The decision is not in an actionable state.";
    case "decision_held":
      return "The decision is held, so it maps to no launch.";
    case "decision_blocked":
      return "The decision is blocked, so it maps to no launch.";
    case "authorized_action_has_no_launchpad_mode":
      return "The authorized action does not open Launchpad.";
    case "lineage_incomplete":
      return "The source is missing the lineage a launch must record.";
    case "malformed_reference":
      return "The handoff reference is not readable.";
    case "not_found":
      return "That handoff no longer exists.";
    case "token_mismatch":
      return "The handoff reference did not verify.";
    case "expired":
      return "The handoff expired; start it again from Decisions.";
    case "already_consumed":
      return "That handoff was already used; start it again from Decisions.";
    case "persist_failed":
    case "read_failed":
      return "The handoff store could not be reached.";
    case "write_authority_revoked":
      return "This workspace no longer authorizes launch drafts for you, so nothing was opened.";
    case "decision_not_served":
      return "That decision is no longer in the current served universe for this account.";
    case "decision_source_unavailable":
      return "The canonical decision source could not be re-read, so nothing was opened.";
    case "decision_authority_changed":
      return "The decision changed since the handoff was created, so it no longer opens this launch.";
    case "prefill_expired":
      return "The prepared draft expired; start it again from where you launched it.";
    case "copy_identity_missing":
      return "That copy line is not in the current served universe for this account and window.";
  }
}

/**
 * The Copies -> Launchpad handoff, and why it is NOT a decision handoff.
 *
 * A copies row is a warehouse aggregate over ad-level text. The canonical
 * contract classes exactly that as discovery evidence: "Warehouse entity rows,
 * recommendation payloads, and synthetic IDs are discovery evidence only.
 * Provider execution additionally needs an explicit origin contract and a fresh
 * exact provider GET." It has no `decisionId` and no `sourceSnapshotId`, so the
 * only two ways to route it through `authorizeLaunchpadHandoff` would be to
 * invent them or to widen the decision contract until it accepted anything.
 *
 * Neither happens here. A copy handoff is minted under its own origin, carries
 * `sourceAuthorityStatus: "warehouse_discovery"`, `authorizedAction: null`,
 * `actionEligible: false` and `exactAdExecutionEligible: false`, and therefore
 * cannot be mistaken for execution authority by anything downstream — including
 * by `consumeLaunchpadHandoff`, which checks those four fields against the
 * origin rather than trusting them.
 */
export interface LaunchpadCopyHandoffAuthorization {
  mode: "copy_draft";
  selection: LaunchpadHandoffSelection;
  evidenceWindow: LaunchpadHandoffEvidenceWindow;
  copy: LaunchpadHandoffCopyIdentity;
}

export type LaunchpadCopyHandoffAuthorizationResult =
  | { ok: true; authorization: LaunchpadCopyHandoffAuthorization }
  | { ok: false; refusal: LaunchpadHandoffAnyRefusal };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface LaunchpadCopyHandoffCandidate {
  copyId: string;
  /** The account the copies request was actually served for. */
  providerAccountId: string;
  assetType: string | null;
  sourceText: string | null;
  /** The exact lines the server returned for this copy row. */
  alternates: readonly string[];
  campaignIds: readonly string[];
  adIds: readonly string[];
  creativeIds: readonly string[];
}

/**
 * Pure, and deliberately strict about the alternate.
 *
 * The alternate text is NOT taken from the caller. The caller names WHICH
 * alternate it wants and the text is read out of the server-served row, because
 * a client-supplied string would let a URL (or a hand-rolled POST) put arbitrary
 * ad copy into a draft that claims to have come from Meta's own served lines.
 */
export function authorizeLaunchpadCopyHandoff(input: {
  candidate: LaunchpadCopyHandoffCandidate;
  providerAccountId: string;
  requestedAlternateText: string;
  window: { startDate: string; endDate: string };
}): LaunchpadCopyHandoffAuthorizationResult {
  const candidate = input.candidate;
  if (candidate.providerAccountId !== input.providerAccountId) {
    return { ok: false, refusal: "provider_account_mismatch" };
  }
  const copyId = candidate.copyId?.trim() || "";
  if (!copyId) return { ok: false, refusal: "copy_identity_missing" };

  const requested = input.requestedAlternateText.trim();
  const alternates = candidate.alternates
    .map((line) => line?.trim() ?? "")
    .filter(Boolean);
  const alternateIndex = alternates.findIndex((line) => line === requested);
  if (!requested || alternateIndex < 0) {
    return { ok: false, refusal: "copy_identity_missing" };
  }

  // A window the server cannot restate is not a window. It is refused rather
  // than defaulted, because "the last 30 days" invented here would be a claim
  // about evidence nobody measured.
  if (
    !ISO_DATE.test(input.window.startDate) ||
    !ISO_DATE.test(input.window.endDate) ||
    input.window.startDate > input.window.endDate
  ) {
    return { ok: false, refusal: "lineage_incomplete" };
  }

  return {
    ok: true,
    authorization: {
      mode: "copy_draft",
      selection: buildLaunchpadHandoffSelection({
        campaignIds: candidate.campaignIds,
        adIds: candidate.adIds,
        creativeIds: candidate.creativeIds,
      }),
      evidenceWindow: {
        basis: "requested_metrics_window",
        startDate: input.window.startDate,
        endDate: input.window.endDate,
        snapshotAsOf: null,
        computedAt: null,
      },
      copy: {
        copyId,
        alternateId: `alt-${alternateIndex + 1}`,
        alternateText: alternates[alternateIndex]!,
        sourceText: candidate.sourceText?.trim() || null,
        assetType: candidate.assetType?.trim() || null,
      },
    },
  };
}

/**
 * What the Launchpad BODY receives. A view-model, not a capability.
 *
 * Every field here was decided by the server and re-verified at consume time.
 * The body renders it and preselects from it; it must never re-derive the mode,
 * the action, or the eligibility, and nothing in it is read from the URL.
 */
export interface LaunchpadHandoffPrefill {
  handoffId: string;
  origin: LaunchpadHandoffOrigin;
  mode: LaunchpadHandoffMode;
  launchpadMode: "new_campaign" | "add_to_existing";
  launchpadStep: "creatives";
  providerAccountId: string;
  authorizedAction: LaunchpadHandoffAuthorizedAction | null;
  actionEligible: boolean;
  exactAdExecutionEligible: boolean;
  sourceAuthorityStatus: LaunchpadHandoffSourceAuthorityStatus;
  selection: LaunchpadHandoffSelection;
  evidenceWindow: LaunchpadHandoffEvidenceWindow;
  lineage: LaunchpadHandoffLineage | null;
  copy: LaunchpadHandoffCopyIdentity | null;
  /** One sentence naming what was carried. Composed here, never in the UI. */
  summary: string;
  /**
   * Non-null when part of what was carried CANNOT be applied by this wizard.
   *
   * This is the honest half of the copy handoff: the envelope carries the
   * alternate line, and the Launchpad payload
   * (`MetaLaunchPayload` / `MetaAddToExistingPayload`, lib/launchpad/meta.ts)
   * has no primary-text, headline or description field at any level, so no
   * wizard step can accept it. Saying so beats a draft that silently drops it.
   */
  unsupported: string | null;
}

export type LaunchpadHandoffPrefillEnvelope =
  | { status: "none" }
  | { status: "prefilled"; prefill: LaunchpadHandoffPrefill }
  | {
      status: "unavailable";
      refusal: LaunchpadHandoffAnyRefusal;
      message: string;
    };

export const LAUNCHPAD_HANDOFF_PREFILL_NONE: LaunchpadHandoffPrefillEnvelope = {
  status: "none",
};

export function launchpadHandoffPrefillUnavailable(
  refusal: LaunchpadHandoffAnyRefusal,
): LaunchpadHandoffPrefillEnvelope {
  return {
    status: "unavailable",
    refusal,
    message: describeLaunchpadHandoffRefusal(refusal),
  };
}

function describeEvidenceWindow(window: LaunchpadHandoffEvidenceWindow): string {
  if (window.basis === "requested_metrics_window") {
    return window.startDate && window.endDate
      ? `window ${window.startDate} → ${window.endDate}`
      : "window unrecorded";
  }
  return window.snapshotAsOf
    ? `snapshot ${window.snapshotAsOf}`
    : "snapshot date unrecorded";
}

/** The one place a prefill sentence is written. */
export function buildLaunchpadHandoffPrefill(
  envelope: LaunchpadHandoffEnvelope,
): LaunchpadHandoffPrefill {
  const target = launchpadWizardTargetForHandoffMode(envelope.mode);
  const selection = envelope.selection ?? EMPTY_LAUNCHPAD_HANDOFF_SELECTION;
  const window = envelope.evidenceWindow ?? {
    basis: "decision_snapshot" as const,
    startDate: null,
    endDate: null,
    snapshotAsOf: null,
    computedAt: null,
  };
  const creativeCount = selection.creativeIds.length;
  const summary =
    envelope.origin === "copy"
      ? [
          "Copy handoff",
          "discovery evidence · no execution authority",
          describeEvidenceWindow(window),
          `${creativeCount} creative${creativeCount === 1 ? "" : "s"} preselected`,
        ].join(" · ")
      : [
          `Decision handoff · ${envelope.mode}`,
          envelope.authorizedAction
            ? `server-authorized ${envelope.authorizedAction}`
            : "no authorized action",
          describeEvidenceWindow(window),
          `${creativeCount} creative${creativeCount === 1 ? "" : "s"} preselected`,
        ].join(" · ");

  return {
    handoffId: envelope.handoffId,
    origin: envelope.origin,
    mode: envelope.mode,
    launchpadMode: target.launchpadMode,
    launchpadStep: target.launchpadStep,
    providerAccountId: envelope.providerAccountId,
    authorizedAction: envelope.authorizedAction ?? null,
    actionEligible: envelope.actionEligible === true,
    exactAdExecutionEligible: envelope.exactAdExecutionEligible === true,
    sourceAuthorityStatus: envelope.sourceAuthorityStatus,
    selection,
    evidenceWindow: window,
    lineage: envelope.lineage ?? null,
    copy: envelope.copy ?? null,
    summary,
    unsupported:
      envelope.origin === "copy"
        ? "Launchpad has no copy field, so the selected alternate line is carried in the draft record only and will not be written to an ad."
        : null,
  };
}
