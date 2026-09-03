/**
 * The exact request contract each existing Meta action handler requires.
 *
 * Acceptance review found the previous version claiming an endpoint that does
 * not exist (`/api/meta/adsets/[adsetId]/bid`; the real route is `apply-bid`)
 * and posting a generic `{businessId, mutationId}` body that every one of these
 * handlers would have refused. The mistake was possible because the tests
 * mocked a generic dispatch function, so nothing ever compared the body to a
 * real handler.
 *
 * This module is the single place that knows what each handler needs, derived
 * by reading the handlers themselves:
 *
 * - **campaign pause/resume, ad-set pause/resume** (`prepareEntityAction`)
 *   require the canonical manual origin, explicit manual confirmation and the
 *   server-presented `providerAccountId`.
 * - **ad-set apply-bid** additionally requires `bidAmountMinor` as a positive
 *   integer, and refuses the legacy `bidValue`/`bidValueMinor` fields outright.
 * - **ad pause/resume** (`parseDecisionOriginRequest` → `prepareAction`) require
 *   the same manual origin and confirmation, **plus** the exact identity:
 *   `providerAccountId`, an `adId` that matches the route path exactly, and a
 *   `creativeId` that still matches the resolved target.
 * - **ad duplicate** additionally requires `targetAdsetId`, and **refuses
 *   `activateAfterCreate: true`**: duplicates are created paused and resumed
 *   separately.
 *
 * The browser invents none of it. The server builds the descriptor, names the
 * concrete path, and the client posts that body verbatim; the only things it
 * may add are the genuine operator choices declared in `operatorFields`. Every
 * handler then re-resolves the true target from the warehouse and refuses on
 * any mismatch, so a tampered descriptor fails closed rather than landing on
 * somebody else's account.
 */
import type { DecisionBoundGrain } from "@/lib/zero-base/meta/decision-bound-target";

/**
 * D088 adds `budget`. It is a canonical PROPOSAL action, not a ceremony action:
 * `MUTATION_ENDPOINTS` below deliberately names no path for it, so
 * `buildDispatchDescriptor` cannot produce a browser-postable budget
 * descriptor. A budget proposal is executed server-side through the D087
 * executor, where the UI chooses no entity, field or magnitude.
 */
export type MutationAction = "pause" | "resume" | "bid" | "duplicate" | "budget";

/**
 * Every endpoint the ceremony may call, keyed by grain and action.
 *
 * These are the real route files. `bid` maps to **apply-bid**, which is the
 * path that exists — the previous `/bid` would have 404'd on every attempt.
 */
export const MUTATION_ENDPOINTS: Readonly<
  Partial<Record<DecisionBoundGrain, Partial<Record<MutationAction, string>>>>
> = {
  campaign: {
    pause: "/api/meta/campaigns/[campaignId]/pause",
    resume: "/api/meta/campaigns/[campaignId]/resume",
  },
  adset: {
    pause: "/api/meta/adsets/[adsetId]/pause",
    resume: "/api/meta/adsets/[adsetId]/resume",
    bid: "/api/meta/adsets/[adsetId]/apply-bid",
  },
  ad: {
    pause: "/api/meta/ads/[adId]/pause",
    resume: "/api/meta/ads/[adId]/resume",
    duplicate: "/api/meta/ads/[adId]/duplicate",
  },
};

export function endpointFor(
  grain: DecisionBoundGrain,
  action: MutationAction,
): string | null {
  return MUTATION_ENDPOINTS[grain]?.[action] ?? null;
}

/** Values the campaign/ad-set handlers compare against, character for character. */
export const MANUAL_ACTION_ORIGIN = "manual_operator_v1";
export const MANUAL_CONFIRMATION = "explicit_operator_confirmation";

/**
 * Fields the descriptor must never contain.
 *
 * The handlers refuse a manual request carrying native decision lineage or an
 * action-origin alias, because origin must never be inferred from optional
 * field presence (D065). The legacy bid units are refused for executable
 * writes. Asserting their absence here means a future edit to the builder
 * cannot quietly reintroduce one.
 */
export const FORBIDDEN_DISPATCH_FIELDS = [
  "contractVersion",
  "contract_version",
  "snapshotId",
  "snapshot_id",
  "evaluationId",
  "evaluation_id",
  "engineVersion",
  "engine_version",
  "decisionHash",
  "decision_hash",
  "decisionAction",
  "decision_action",
  "lineage",
  "decisionOrigin",
  "action_origin",
  "executionOrigin",
  "execution_origin",
  "bidValue",
  "bidValueMinor",
] as const;

/** A genuine operator choice the UI must collect before confirmation. */
export type OperatorField =
  | {
      name: "bidAmountMinor";
      kind: "minor_amount";
      label: string;
      /** Canonical account currency, for display only. Never converted here. */
      currency: string;
      required: true;
    }
  | { name: "targetAdsetId"; kind: "text"; label: string; required: true }
  | { name: "name"; kind: "text"; label: string; required: false };

export interface DispatchDescriptor {
  /** Concrete path. The placeholder was substituted server-side. */
  path: string;
  /** Exactly what the handler requires, with no field it would refuse. */
  body: Record<string, unknown>;
  /** What the operator must still choose. Merged into the body at dispatch. */
  operatorFields: OperatorField[];
  /** When the server issued it. The client re-preflights rather than reusing. */
  issuedAt: string;
  /** Stated plainly where a route constrains what an operator may ask for. */
  note: string | null;
}

export type WithholdReason =
  | "unsupported_action"
  | "creative_identity_unavailable"
  | "account_currency_unavailable"
  | "parent_adset_unknown";

export const WITHHOLD_MESSAGE: Record<WithholdReason, string> = {
  unsupported_action: "That action is not available at this grain.",
  creative_identity_unavailable:
    "This ad's exact creative identity is not recorded, and the action endpoint requires it. Nothing can be attempted until a sync records it.",
  account_currency_unavailable:
    "The account's currency could not be verified, and a bid cannot be entered without knowing its unit.",
  parent_adset_unknown:
    "The ad set this ad belongs to is not recorded, so a duplicate has no proven destination to offer.",
};

export interface DispatchTarget {
  grain: DecisionBoundGrain;
  entityId: string;
  providerAccountId: string;
  creativeId: string | null;
  parentId: string | null;
}

export type BuildDispatchResult =
  | { ok: true; descriptor: DispatchDescriptor }
  | { ok: false; reason: WithholdReason; message: string };

function substitute(endpoint: string, provenEntityId: string): string {
  return endpoint.replace(/\[[^\]]+\]/, encodeURIComponent(provenEntityId));
}

/**
 * Build the descriptor for one proven target and action.
 *
 * Withholds rather than producing a body a handler would certainly refuse: an
 * ad with no recorded creative identity, or a bid on an account whose currency
 * could not be read. Rendering those controls would put a button on screen that
 * can only fail.
 */
export function buildDispatchDescriptor(input: {
  businessId: string;
  target: DispatchTarget;
  action: MutationAction;
  /** Canonical account currency. Null when it could not be verified. */
  accountCurrency: string | null;
  issuedAt: string;
}): BuildDispatchResult {
  const { businessId, target, action } = input;
  const endpoint = endpointFor(target.grain, action);
  if (!endpoint) {
    return {
      ok: false,
      reason: "unsupported_action",
      message: WITHHOLD_MESSAGE.unsupported_action,
    };
  }
  const path = substitute(endpoint, target.entityId);

  if (target.grain === "campaign" || target.grain === "adset") {
    // The manual-operator contract these two handlers demand, exactly.
    const body: Record<string, unknown> = {
      actionOrigin: MANUAL_ACTION_ORIGIN,
      manualConfirmation: MANUAL_CONFIRMATION,
      businessId,
      providerAccountId: target.providerAccountId,
    };

    if (action === "bid") {
      if (!input.accountCurrency) {
        return {
          ok: false,
          reason: "account_currency_unavailable",
          message: WITHHOLD_MESSAGE.account_currency_unavailable,
        };
      }
      return {
        ok: true,
        descriptor: {
          path,
          body,
          operatorFields: [
            {
              name: "bidAmountMinor",
              kind: "minor_amount",
              label: "Bid amount",
              currency: input.accountCurrency,
              required: true,
            },
          ],
          issuedAt: input.issuedAt,
          note: `Entered in minor units of ${input.accountCurrency}, the account's own currency.`,
        },
      };
    }

    return { ok: true, descriptor: { path, body, operatorFields: [], issuedAt: input.issuedAt, note: null } };
  }

  // Ad grain. The manual branch of the ad origin parser demands the same
  // origin and confirmation as the entity routes, and then the exact identity:
  // the handler resolves the true target and refuses unless the creative
  // identity it finds still matches the one presented.
  if (!target.creativeId) {
    return {
      ok: false,
      reason: "creative_identity_unavailable",
      message: WITHHOLD_MESSAGE.creative_identity_unavailable,
    };
  }
  const body: Record<string, unknown> = {
    actionOrigin: MANUAL_ACTION_ORIGIN,
    manualConfirmation: MANUAL_CONFIRMATION,
    businessId,
    providerAccountId: target.providerAccountId,
    // Must equal the route's own ad id exactly; the path above is built from
    // this same proven value, so they cannot drift apart.
    adId: target.entityId,
    creativeId: target.creativeId,
  };

  if (action === "duplicate") {
    if (!target.parentId) {
      return {
        ok: false,
        reason: "parent_adset_unknown",
        message: WITHHOLD_MESSAGE.parent_adset_unknown,
      };
    }
    return {
      ok: true,
      descriptor: {
        path,
        body,
        operatorFields: [
          { name: "targetAdsetId", kind: "text", label: "Destination ad set", required: true },
          { name: "name", kind: "text", label: "Name for the copy (optional)", required: false },
        ],
        issuedAt: input.issuedAt,
        // Not an option we withhold by choice: the route refuses activation
        // outright, so offering a toggle would be offering a guaranteed failure.
        note: "The copy is always created paused. Resuming it is a separate, deliberate action.",
      },
    };
  }

  return { ok: true, descriptor: { path, body, operatorFields: [], issuedAt: input.issuedAt, note: null } };
}

export interface OperatorValues {
  bidAmountMinor?: string;
  targetAdsetId?: string;
  name?: string;
}

/** Validation failures, in the operator's terms. */
export function validateOperatorValues(
  descriptor: DispatchDescriptor,
  values: OperatorValues,
): string[] {
  const problems: string[] = [];
  for (const field of descriptor.operatorFields) {
    const raw = (values[field.name] ?? "").trim();
    if (!raw) {
      if (field.required) problems.push(`${field.label} is required.`);
      continue;
    }
    if (field.name === "bidAmountMinor") {
      // The handler takes a positive integer of minor units and refuses
      // anything else; catching it here keeps the refusal in the form rather
      // than after a provider round trip.
      if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        problems.push(`${field.label} must be a whole number of minor units above zero.`);
      }
    }
  }
  return problems;
}

/**
 * Merge validated operator values into the server-built body.
 *
 * Only declared fields are merged, so a value the descriptor did not ask for
 * cannot reach a handler.
 */
export function composeDispatchBody(
  descriptor: DispatchDescriptor,
  values: OperatorValues,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...descriptor.body };
  for (const field of descriptor.operatorFields) {
    const raw = (values[field.name] ?? "").trim();
    if (!raw) continue;
    body[field.name] = field.name === "bidAmountMinor" ? Number(raw) : raw;
  }
  return body;
}
