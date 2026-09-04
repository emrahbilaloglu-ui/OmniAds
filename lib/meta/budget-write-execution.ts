/**
 * D087 — the budget write orchestrator: preflight, journal, dispatch, verify,
 * and a guarded rollback.
 *
 * Every dependency is injected. That is deliberate: a duplicate request, a lost
 * unique race and an intervening operator change are the states that decide
 * whether this is safe, and none of them can be produced on demand against a
 * live provider. Injecting them makes each one a test rather than a hope.
 *
 * The orchestrator never enables anything. It asks the preflight, and the
 * preflight's default answer in this slice is `automation_disabled`.
 */
import { createHash } from "node:crypto";

import type {
  MetaAdsWriteFailure,
  MetaEntityBudgetWriteSuccess,
  MetaEntityExecutionScope,
} from "@/lib/meta/ads-write";
import type { BudgetField, BudgetOwnerGrain } from "@/lib/meta/budget-intent-contract";
import type { ProviderCapabilityContract } from "@/lib/meta/budget-proposal-dry-run";
import {
  parseBudgetWriteRequest,
  type BudgetWriteRequest,
} from "@/lib/meta/budget-write-request";
import {
  evaluateBudgetWritePreflight,
  type BudgetWriteActorContext,
  type BudgetWriteGovernance,
  type BudgetWriteHistory,
  type BudgetWritePolicy,
  type BudgetWritePreflightBlocker,
  type BudgetWriteProviderBaseline,
} from "@/lib/meta/budget-write-preflight";

export const BUDGET_WRITE_JOURNAL_CONTRACT = "meta.budget-write-journal.v1" as const;

/**
 * What happened, in one word, with no word that means "probably".
 *
 * `unknown` is its own class and is never rolled back automatically: a timeout
 * or a transport reset may have mutated the account, and guessing either way
 * would be a second unreviewed write.
 */
export const BUDGET_WRITE_RESULT_CLASSES = [
  "in_flight",
  "verified",
  "failed",
  "unknown",
  "already_applied",
  "refused_request",
  "refused_preflight",
  "refused_idempotency_collision",
  "refused_not_eligible",
  "refused_scope",
  "refused_governance",
  "refused_intervening_change",
] as const;
export type BudgetWriteResultClass = (typeof BUDGET_WRITE_RESULT_CLASSES)[number];

export interface BudgetWriteJournalRow {
  id: string;
  contract: string;
  proposalId: string;
  idempotencyKey: string;
  /** A hash of the sanitized request. Never the request itself. */
  requestFingerprint: string;
  businessId: string;
  providerAccountId: string;
  ownerGrain: BudgetOwnerGrain;
  entityId: string;
  parentCampaignId: string | null;
  budgetField: BudgetField;
  currency: string;
  currencyExponent: number;
  actorUserId: string;
  beforeAmountMinor: number | null;
  intendedAmountMinor: number;
  readbackAmountMinor: number | null;
  providerAttempted: boolean;
  providerHttpStatus: number | null;
  resultClass: BudgetWriteResultClass;
  blockers: readonly string[];
  rollbackEligible: boolean;
  rolledBackAt: number | null;
  requestedAtMs: number;
  completedAtMs: number | null;
}

export interface BudgetWriteJournal {
  findByIdempotency(
    key: string, businessId: string, providerAccountId: string,
  ): Promise<BudgetWriteJournalRow | null>;
  findById(id: string): Promise<BudgetWriteJournalRow | null>;
  /** Must enforce the unique occurrence key and THROW on collision. */
  open(row: BudgetWriteJournalRow): Promise<BudgetWriteJournalRow>;
  complete(
    id: string, patch: Partial<BudgetWriteJournalRow>,
  ): Promise<BudgetWriteJournalRow>;
}

export interface BudgetWriteDeps {
  journal: BudgetWriteJournal;
  nowMs(): number;
  newId(): string;
  actor: BudgetWriteActorContext;
  governance: BudgetWriteGovernance;
  /**
   * The ad account's VERIFIED currency, carried from the account profile the
   * budget write context holds.
   *
   * PR #272 review: the orchestrator used to hand `request.currency` to the
   * adapter as the currency to verify against, which let a proposal's own
   * claim about itself stand in for a fact about the account. REQUIRED, and
   * empty when unknown — an empty value refuses inside the adapter rather
   * than being quietly substituted.
   */
  accountCurrency: string;
  automationEnabled: boolean;
  capability: ProviderCapabilityContract;
  policy: BudgetWritePolicy | null;
  history: BudgetWriteHistory | null;
  /** A FRESH provider read for this attempt. */
  readProviderBaseline(input: {
    scope: MetaEntityExecutionScope; entityId: string; budgetField: BudgetField;
  }): Promise<BudgetWriteProviderBaseline | null>;
  writeBudget(input: {
    scope: MetaEntityExecutionScope; entityId: string; budgetField: BudgetField;
    amountMinor: number; expectedCurrency: string;
    /**
     * D087 C1: the value the account must STILL hold when the adapter POSTs.
     *
     * The orchestrator's compare-and-set ran against a read taken earlier; this
     * becomes the adapter's last application-level provider observation before
     * the mutation. Meta exposes no versioned/conditional budget update, so the
     * separate GET and POST cannot be a provider-atomic CAS.
     */
    expectedPreviousAmountMinor: number;
    /** Durably marks write intent before the adapter's final provider CAS. */
    beforeProviderPost?: () => Promise<boolean>;
  }): Promise<MetaEntityBudgetWriteSuccess | MetaAdsWriteFailure>;
}

export interface BudgetWriteOutcome {
  ok: boolean;
  resultClass: BudgetWriteResultClass;
  blockers: readonly (BudgetWritePreflightBlocker | string)[];
  journalId: string | null;
  readbackAmountMinor: number | null;
  message: string | null;
  /** Exact for this execution; a durable intent marker is not a provider POST. */
  providerAttempted?: boolean;
}

/** Fields that must never reach the journal, whatever a caller attaches. */
const REDACTED_KEYS = new Set([
  "accessToken", "access_token", "authorization", "Authorization",
  "headers", "cookie", "token", "appsecret_proof", "secret",
]);

export interface SanitizedBudgetWriteRequest {
  fingerprint: string;
  fields: Record<string, unknown>;
}

/**
 * The journalled shape of a request: the decision-relevant fields, a stable
 * fingerprint, and nothing that could authenticate anybody.
 */
export function sanitizeBudgetWriteRequestForJournal(
  raw: Record<string, unknown>,
): SanitizedBudgetWriteRequest {
  const scope = (raw?.scope ?? {}) as Record<string, unknown>;
  const baseline = (raw?.baseline ?? {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = {
    contractVersion: raw?.contractVersion ?? null,
    proposalId: raw?.proposalId ?? null,
    idempotencyKey: raw?.idempotencyKey ?? null,
    businessId: scope.businessId ?? null,
    providerAccountId: scope.providerAccountId ?? null,
    ownerGrain: scope.ownerGrain ?? null,
    entityId: scope.entityId ?? null,
    parentCampaignId: scope.parentCampaignId ?? null,
    ownerMode: raw?.ownerMode ?? null,
    budgetField: raw?.budgetField ?? null,
    intendedAmountMinor: raw?.intendedAmountMinor ?? null,
    currency: raw?.currency ?? null,
    currencyExponent: raw?.currencyExponent ?? null,
    currencyRegistryVersion: raw?.currencyRegistryVersion ?? null,
    baselineAmountMinor: baseline.amountMinor ?? null,
    baselineSourceRunId: baseline.sourceRunId ?? null,
    baselineSourceSnapshotId: baseline.sourceSnapshotId ?? null,
    evidenceAsOf: raw?.evidenceAsOf ?? null,
  };
  // Belt and braces: even a renamed secret cannot ride in on a key we copied.
  for (const key of Object.keys(fields)) {
    if (REDACTED_KEYS.has(key)) delete fields[key];
  }
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))),
  );
  return {
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
    fields,
  };
}

const scopeOf = (grain: BudgetOwnerGrain): MetaEntityExecutionScope =>
  grain === "campaign" ? "campaign" : "adset";

const isSuccess = (
  result: MetaEntityBudgetWriteSuccess | MetaAdsWriteFailure,
): result is MetaEntityBudgetWriteSuccess => result.ok === true;

/**
 * An outcome the provider could not resolve. r-class discipline from
 * `ads-write`: ambiguous transport states are UNKNOWN, and unknown never
 * becomes eligible for an automatic reversal.
 */
const classifyFailure = (failure: MetaAdsWriteFailure): "failed" | "unknown" => {
  if (failure.providerOutcome === "outcome_ambiguous") return "unknown";
  const code = failure.error?.code ?? "";
  if (code === "provider_timeout" || code === "transport_error") return "unknown";
  return "failed";
};

const failureBlockers = (failure: MetaAdsWriteFailure): string[] =>
  [...new Set([
    failure.error?.code ?? "provider_failed",
    failure.verificationFailure?.code ?? null,
  ].filter((code): code is string => Boolean(code)))];

export async function executeBudgetWrite(
  deps: BudgetWriteDeps,
  rawRequest: unknown,
  options?: { beforeProviderPost?: () => Promise<boolean> },
): Promise<BudgetWriteOutcome> {
  const parsed = parseBudgetWriteRequest(rawRequest);
  if (!parsed.ok) {
    // Nothing is journalled for a request that is not a request: there is no
    // identity to journal it under.
    return {
      ok: false, resultClass: "refused_request", blockers: [parsed.code],
      journalId: null, readbackAmountMinor: null, message: parsed.message,
      providerAttempted: false,
    };
  }
  const request: BudgetWriteRequest = parsed.request;
  const sanitized = sanitizeBudgetWriteRequestForJournal(
    rawRequest as Record<string, unknown>,
  );
  const nowMs = deps.nowMs();

  // --- idempotency, before anything else ----------------------------------
  const existing = await deps.journal.findByIdempotency(
    request.idempotencyKey, request.scope.businessId, request.scope.providerAccountId,
  );
  if (existing) {
    if (existing.requestFingerprint !== sanitized.fingerprint) {
      return {
        ok: false, resultClass: "refused_idempotency_collision",
        blockers: ["idempotency_key_reused_with_different_payload"],
        journalId: existing.id, readbackAmountMinor: null,
        message: "This idempotency key already names a different budget change.",
        providerAttempted: existing.providerAttempted,
      };
    }
    return {
      ok: existing.resultClass === "verified",
      resultClass: existing.resultClass === "verified" ? "already_applied" : existing.resultClass,
      blockers: existing.blockers,
      journalId: existing.id,
      readbackAmountMinor: existing.readbackAmountMinor,
      message: "This exact budget change has already been attempted.",
      providerAttempted: existing.providerAttempted,
    };
  }

  // --- the fresh provider baseline this attempt compares against -----------
  let providerBaseline: BudgetWriteProviderBaseline | null = null;
  try {
    providerBaseline = await deps.readProviderBaseline({
      scope: scopeOf(request.scope.ownerGrain),
      entityId: request.scope.entityId,
      budgetField: request.budgetField,
    });
  } catch {
    providerBaseline = null;
  }

  const preflight = evaluateBudgetWritePreflight({
    request,
    actor: deps.actor,
    governance: deps.governance,
    automationEnabled: deps.automationEnabled,
    capability: deps.capability,
    providerBaseline,
    policy: deps.policy,
    history: deps.history,
    nowMs,
  });

  const baseRow: BudgetWriteJournalRow = {
    id: deps.newId(),
    contract: BUDGET_WRITE_JOURNAL_CONTRACT,
    proposalId: request.proposalId,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: sanitized.fingerprint,
    businessId: request.scope.businessId,
    providerAccountId: request.scope.providerAccountId,
    ownerGrain: request.scope.ownerGrain,
    entityId: request.scope.entityId,
    parentCampaignId: request.scope.parentCampaignId,
    budgetField: request.budgetField,
    currency: request.currency,
    currencyExponent: request.currencyExponent,
    actorUserId: request.actor.userId,
    beforeAmountMinor: providerBaseline?.amountMinor ?? null,
    intendedAmountMinor: request.intendedAmountMinor,
    readbackAmountMinor: null,
    providerAttempted: false,
    providerHttpStatus: null,
    resultClass: preflight.ok ? "in_flight" : "refused_preflight",
    blockers: preflight.blockers,
    rollbackEligible: false,
    rolledBackAt: null,
    requestedAtMs: nowMs,
    completedAtMs: preflight.ok ? null : nowMs,
  };

  let opened: BudgetWriteJournalRow;
  try {
    opened = await deps.journal.open(baseRow);
  } catch {
    /*
      The unique occurrence key lost a race: another transaction committed the
      same attempt between the lookup and the insert. Refusing here is the
      point — the alternative is a second provider mutation for one intent.
    */
    return {
      ok: false, resultClass: "refused_idempotency_collision",
      blockers: ["idempotency_race_lost"],
      journalId: null, readbackAmountMinor: null,
      message: "Another attempt for this idempotency key committed first.",
      providerAttempted: false,
    };
  }

  if (!preflight.ok) {
    return {
      ok: false, resultClass: "refused_preflight", blockers: preflight.blockers,
      journalId: opened.id, readbackAmountMinor: null,
      message: "The budget write preflight refused this attempt.",
      providerAttempted: false,
    };
  }

  let result: MetaEntityBudgetWriteSuccess | MetaAdsWriteFailure;
  try {
    result = await deps.writeBudget({
      scope: scopeOf(request.scope.ownerGrain),
      entityId: request.scope.entityId,
      budgetField: request.budgetField,
      amountMinor: request.intendedAmountMinor,
      /*
        The ACCOUNT's verified currency, not `request.currency`. The preflight
        above has already refused this attempt if the two disagree — the
        baseline it compares carries the same verified value — so reaching
        here means they match, and the adapter is told the one that was
        proven rather than the one that was asserted.
      */
      expectedCurrency: deps.accountCurrency,
      // The ACCEPTED baseline, carried to the adapter's own last-word check.
      expectedPreviousAmountMinor: request.baseline.amountMinor,
      beforeProviderPost: options?.beforeProviderPost,
    });
  } catch (error) {
    // A throw is not a failure: the request may or may not have landed.
    await deps.journal.complete(opened.id, {
      providerAttempted: true, resultClass: "unknown",
      blockers: ["provider_outcome_unknown"], rollbackEligible: false,
      completedAtMs: deps.nowMs(),
    });
    return {
      ok: false, resultClass: "unknown", blockers: ["provider_outcome_unknown"],
      journalId: opened.id, readbackAmountMinor: null,
      message: error instanceof Error ? error.name : "provider outcome unknown",
      providerAttempted: true,
    };
  }

  if (!isSuccess(result)) {
    const resultClass = classifyFailure(result);
    const blockers = failureBlockers(result);
    await deps.journal.complete(opened.id, {
      providerAttempted: result.providerMutationAttempted === true,
      providerHttpStatus: result.httpStatus ?? null,
      resultClass,
      blockers,
      rollbackEligible: false,
      completedAtMs: deps.nowMs(),
    });
    return {
      ok: false, resultClass, blockers,
      journalId: opened.id, readbackAmountMinor: null,
      message: result.error?.message ?? null,
      providerAttempted: result.providerMutationAttempted === true,
    };
  }

  await deps.journal.complete(opened.id, {
    providerAttempted: true,
    resultClass: "verified",
    readbackAmountMinor: result.verifiedAmountMinor,
    beforeAmountMinor: result.previousAmountMinor ?? opened.beforeAmountMinor,
    // Only a VERIFIED write has an exact prior value to restore.
    rollbackEligible: (result.previousAmountMinor ?? opened.beforeAmountMinor) !== null,
    completedAtMs: deps.nowMs(),
  });
  return {
    ok: true, resultClass: "verified", blockers: [],
    journalId: opened.id, readbackAmountMinor: result.verifiedAmountMinor,
    message: null,
    providerAttempted: true,
  };
}

export interface BudgetRollbackInput {
  journalId: string;
  actorUserId: string;
}

/**
 * Restore the exact prior value — and only if the account still holds what this
 * execution wrote.
 *
 * Rollback is a second write, so it earns the same suspicion as the first. If
 * anything moved the budget after us, the value we would restore is no longer
 * the value that was there before us, and reverting would overwrite somebody
 * else's decision.
 */
export async function rollbackBudgetWrite(
  deps: BudgetWriteDeps,
  input: BudgetRollbackInput,
): Promise<BudgetWriteOutcome> {
  const row = await deps.journal.findById(input.journalId);
  if (!row) {
    return {
      ok: false, resultClass: "refused_not_eligible", blockers: ["journal_row_absent"],
      journalId: null, readbackAmountMinor: null, message: "No such execution.",
    };
  }
  /*
    D087 C1: a rollback is a NEW provider write, so it earns the whole gate a
    forward write earns. The previous version checked only the journal row's
    business and account, never the caller's identity, never the CURRENT write
    scope and never governance — so a revoked scope or an engaged kill switch
    could still have been reverted through. All of it is checked before any
    provider read, because refusing after a read has already told the provider
    we are interested.
  */
  if (deps.actor?.authenticated !== true
    || deps.actor?.userId !== input.actorUserId
    || deps.actor?.writeScopeBound !== true
    || deps.actor?.businessId !== row.businessId
    || deps.actor?.selectedProviderAccountId !== row.providerAccountId) {
    return {
      ok: false, resultClass: "refused_scope", blockers: ["rollback_scope_mismatch"],
      journalId: row.id, readbackAmountMinor: null,
      message:
        "A rollback requires the authenticated actor, a current write-scope binding, "
        + "and the business and account this execution belongs to.",
    };
  }
  if (deps.governance?.verified !== true
    || deps.governance?.writeBlocked === true
    || deps.governance?.killSwitchEngaged === true) {
    return {
      ok: false, resultClass: "refused_governance", blockers: ["rollback_write_blocked"],
      journalId: row.id, readbackAmountMinor: null,
      message: "Provider writes are blocked, so nothing may be reverted either.",
    };
  }
  if (row.resultClass !== "verified" || !row.rollbackEligible
    || row.rolledBackAt !== null || row.beforeAmountMinor === null) {
    return {
      ok: false, resultClass: "refused_not_eligible",
      blockers: ["rollback_not_eligible"],
      journalId: row.id, readbackAmountMinor: null,
      message: "Only a verified, not-yet-reverted execution can be rolled back.",
    };
  }

  let current: BudgetWriteProviderBaseline | null = null;
  try {
    current = await deps.readProviderBaseline({
      scope: scopeOf(row.ownerGrain), entityId: row.entityId, budgetField: row.budgetField,
    });
  } catch {
    current = null;
  }
  if (!current) {
    return {
      ok: false, resultClass: "refused_intervening_change",
      blockers: ["rollback_baseline_unknown"],
      journalId: row.id, readbackAmountMinor: null,
      message: "The current budget could not be read, so nothing may be reverted.",
    };
  }
  if (current.entityId !== row.entityId
    || current.providerAccountId !== row.providerAccountId
    || current.budgetField !== row.budgetField
    || current.currency !== row.currency
    || current.amountMinor !== row.readbackAmountMinor) {
    return {
      ok: false, resultClass: "refused_intervening_change",
      blockers: ["rollback_intervening_change"],
      journalId: row.id, readbackAmountMinor: current.amountMinor,
      message:
        "The budget no longer holds the value this execution wrote; reverting would "
        + "overwrite a later change.",
    };
  }

  let result: MetaEntityBudgetWriteSuccess | MetaAdsWriteFailure;
  try {
    result = await deps.writeBudget({
      scope: scopeOf(row.ownerGrain), entityId: row.entityId,
      budgetField: row.budgetField, amountMinor: row.beforeAmountMinor,
      expectedCurrency: row.currency,
      /*
        The value THIS execution wrote. The guard read above and this POST are
        separated by the same gap the forward write had; the adapter's own
        pre-POST check closes it, but only because it is told what to expect.
      */
      expectedPreviousAmountMinor: row.readbackAmountMinor ?? Number.NaN,
    });
  } catch {
    return {
      ok: false, resultClass: "unknown", blockers: ["provider_outcome_unknown"],
      journalId: row.id, readbackAmountMinor: null,
      message: "The rollback outcome is unknown.",
    };
  }
  if (!isSuccess(result)) {
    return {
      ok: false, resultClass: classifyFailure(result),
      blockers: failureBlockers(result),
      journalId: row.id, readbackAmountMinor: null,
      message: result.error?.message ?? null,
    };
  }

  await deps.journal.complete(row.id, {
    rolledBackAt: deps.nowMs(), rollbackEligible: false,
  });
  return {
    ok: true, resultClass: "verified", blockers: [],
    journalId: row.id, readbackAmountMinor: result.verifiedAmountMinor, message: null,
  };
}
