"use client";

import { useState } from "react";
import { PlayCircle, ShieldCheck } from "lucide-react";

/**
 * The control the launch receipt owed.
 *
 * A launch intent may only create PAUSED entities — the table's own CHECK says
 * so — and the receipt used to end with a flat sentence saying no activation
 * control was available. That sentence was true of the receipt and false of the
 * product: `POST /intents/[id]/activate` and
 * `POST /intents/[id]/activation-approval` were both complete, and no component
 * anywhere in the repository called either one. The only way to turn on what
 * Launchpad had just created was Ads Manager.
 *
 * Two decisions live here and they are deliberately separate. **Activate now**
 * is the operator turning this on, themselves, under their own confirmation.
 * **Approve for unattended activation** says something different: that this
 * exact payload may be turned on later, by the scheduler, with nobody present.
 * An intent with no approval is operator-only, and that is the default the
 * migration ships — an absent approval is never read as a granted one.
 *
 * ## The one thing this panel must never say
 *
 * An ad whose own status is ACTIVE under a paused campaign shows to nobody.
 * Meta will not deliver it, and its `effective_status` says so while its
 * `status` reads ACTIVE. So nothing here calls anything live except the
 * server's own `delivering` word, and a sequence that stopped renders as the
 * step it stopped at — "campaign is on, ad set is not" — rather than as a
 * failure or, far worse, as a launch.
 */

/** The same two words every other manual Meta write compares character for character. */
const MANUAL_ACTION_ORIGIN = "manual_operator_v1";
const MANUAL_CONFIRMATION = "explicit_operator_confirmation";

/**
 * Typed, not clicked.
 *
 * Both of these start money moving — one now, one later without anybody
 * watching — so they take the same typed phrase the decision ceremony takes
 * for a resume. Revoking takes none: it withdraws authority, and making the
 * safe direction harder than the spending one would be backwards.
 */
const ACTIVATE_PHRASE = "ACTIVATE";
const APPROVE_PHRASE = "APPROVE";

const DEFAULT_TTL_HOURS = 24;

type ActivationGrain = "campaign" | "adset" | "ad";

/** What the activate route reports for one grain, verbatim. */
export interface LaunchpadActivationStep {
  grain: ActivationGrain;
  entityId: string;
  outcome:
    | "activated"
    | "already_active"
    | "blocked"
    | "ambiguous"
    | "not_attempted";
  reason: string | null;
  verified: { status: string | null; effectiveStatus: string | null } | null;
  /** The `meta_ads_action_log` row this step was journalled in, when there is one. */
  actionLogId: string | null;
  claimOutcome: string | null;
}

export interface LaunchpadActivationOutcome {
  ok: boolean;
  /** The only word that means the operator's money is in front of people. */
  delivering?: boolean;
  blockedAt?: ActivationGrain | null;
  blockedReason?: string | null;
  steps?: LaunchpadActivationStep[];
  recordedAt?: string | null;
  authorization?: string | null;
  error?: { code: string; message: string } | null;
}

/** The stored approval, after a reader has checked it is the document it claims to be. */
export interface LaunchpadStandingApproval {
  approvedScope: "ad" | "hierarchy";
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  creativeId: string | null;
  assetVersion: string | null;
  policyVersion: string | null;
}

const APPROVAL_CONTRACT = "meta.launch-activation-approval.v1";
const ACTIVATION_RECEIPT_CONTRACT = "meta.launch-activation-receipt.v1";

const GRAIN_LABEL: Record<ActivationGrain, string> = {
  campaign: "campaign",
  adset: "ad set",
  ad: "ad",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Read the stored approval, or nothing.
 *
 * The column is `unknown` on the intent for a reason: it is a document written
 * by an older build as easily as by this one. A reader that trusted its shape
 * would render an authorization that the dispatch-time validator is about to
 * refuse, so anything that does not name this exact contract reads as absent.
 */
export function readStandingApproval(value: unknown): LaunchpadStandingApproval | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (text(raw.contractVersion) !== APPROVAL_CONTRACT) return null;
  const scope = text(raw.approvedScope);
  const approvedBy = text(raw.approvedBy);
  const approvedAt = text(raw.approvedAt);
  const expiresAt = text(raw.expiresAt);
  if (!approvedBy || !approvedAt || !expiresAt) return null;
  if (scope !== "ad" && scope !== "hierarchy") return null;
  const asset = (raw.approvedAsset ?? null) as Record<string, unknown> | null;
  return {
    approvedScope: scope,
    approvedBy,
    approvedAt,
    expiresAt,
    revokedAt: text(raw.revokedAt),
    creativeId: asset ? text(asset.creativeId) : null,
    assetVersion: asset ? text(asset.version) : null,
    policyVersion: text(raw.policyVersion),
  };
}

/**
 * Read the last stored activation attempt.
 *
 * A reload used to make a half-activated hierarchy look exactly like one that
 * had never been attempted — the worst possible thing to show about a campaign
 * that may already be spending. The intent carries its own receipt, so the
 * panel opens on what actually happened rather than on a blank slate.
 */
export function readStoredActivation(value: unknown): LaunchpadActivationOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (text(raw.contract) !== ACTIVATION_RECEIPT_CONTRACT) return null;
  const steps = Array.isArray(raw.steps) ? (raw.steps as LaunchpadActivationStep[]) : [];
  return {
    ok: true,
    delivering: raw.delivering === true,
    blockedAt: (text(raw.blockedAt) as ActivationGrain | null) ?? null,
    blockedReason: text(raw.blockedReason),
    steps,
    recordedAt: text(raw.recordedAt),
    authorization: text(raw.authorization),
  };
}

/**
 * The scopes this intent could truthfully be approved for.
 *
 * Not a preference. `buildActivationApproval` refuses a `hierarchy` approval on
 * an add-to-existing launch, because that launch put one ad inside somebody
 * else's campaign and approving "the hierarchy" would authorize turning on
 * structure it never made. `validateActivationApproval` refuses the mirror
 * case: an `ad`-scoped approval cannot turn on a campaign this launch itself
 * created paused. Offering the refused option would be offering a control that
 * records an approval nothing can ever use.
 */
export function approvableScopes(
  operation: "new_campaign" | "add_to_existing",
): Array<"ad" | "hierarchy"> {
  return operation === "new_campaign" ? ["hierarchy"] : ["ad"];
}

/**
 * What the hierarchy actually is now, in the operator's words.
 *
 * Composed from the steps that came back active and the step that blocked, so
 * a stopped sequence reads as the true, ordinary outcome it is. Nothing here
 * infers delivery: a campaign being on says nothing about the ad below it.
 */
export function describeBlockedHierarchy(
  steps: LaunchpadActivationStep[],
  blockedAt: ActivationGrain | null | undefined,
): string | null {
  if (!blockedAt) return null;
  const on = steps
    .filter(
      (step) => step.outcome === "activated" || step.outcome === "already_active",
    )
    .map((step) => GRAIN_LABEL[step.grain]);
  const blocked = GRAIN_LABEL[blockedAt];
  if (on.length === 0) return `${blocked} is not on`;
  const list =
    on.length === 1 ? on[0] : `${on.slice(0, -1).join(", ")} and ${on[on.length - 1]}`;
  return `${list} ${on.length === 1 ? "is" : "are"} on, ${blocked} is not`;
}

export function LaunchpadActivationPanel({
  businessId,
  intentId,
  intentStatus,
  operation,
  approval,
  approvalUnavailableReason,
  activationReceipt,
  canMutate,
  refusalReason,
  onResult,
}: {
  businessId: string;
  intentId: string;
  intentStatus: string | null | undefined;
  operation: "new_campaign" | "add_to_existing";
  /** The stored document, unvalidated, exactly as the intent carries it. */
  approval: unknown;
  /**
   * Why the stored approval could not be read, when it could not be.
   *
   * An intent read that failed is not an intent with no approval. Saying
   * "operator only" there would be inventing a fact about an authorization
   * this surface never saw, so the sentence is replaced and the two approval
   * controls are disabled — activating now is unaffected, because an operator
   * pressing Activate does not act under the stored approval at all.
   */
  approvalUnavailableReason?: string | null;
  /** The last attempt's stored receipt, unvalidated, or null. */
  activationReceipt: unknown;
  canMutate: boolean;
  /** The server's own sentence for why this viewer may not write. */
  refusalReason: string | null;
  onResult?: (event: { kind: "approval" | "activation" }) => void;
}) {
  const approvalUnreadable = Boolean(approvalUnavailableReason);
  const standing = approvalUnreadable ? null : readStandingApproval(approval);
  const stored = readStoredActivation(activationReceipt);
  const [outcome, setOutcome] = useState<LaunchpadActivationOutcome | null>(null);
  const [pending, setPending] = useState<null | "activate" | "approve" | "revoke">(null);
  const [phrase, setPhrase] = useState("");
  const [approvePhrase, setApprovePhrase] = useState("");
  const [assetVersion, setAssetVersion] = useState("v1");
  const [ttlHours, setTtlHours] = useState(String(DEFAULT_TTL_HOURS));
  const [approvalOutcome, setApprovalOutcome] = useState<
    { ok: boolean; code?: string; message?: string; revoked?: boolean } | null
  >(null);

  const shown = outcome ?? stored;
  const scopes = approvableScopes(operation);
  const scope = scopes[0]!;
  /*
    An intent that created nothing has nothing to turn on, and the route says
    so with `intent_not_succeeded`. Stating it here means the operator reads the
    reason before the click rather than after it — but the server still decides,
    and both refusals use the same words.
  */
  const statusActivatable =
    intentStatus === "succeeded" || intentStatus === "partially_succeeded";
  const disabledReason = !canMutate
    ? (refusalReason ?? "Launchpad writes are unavailable for this viewer.")
    : !statusActivatable
      ? "This launch did not create anything that can be activated."
      : null;
  const locked = Boolean(disabledReason) || pending !== null;

  async function post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await response
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body: parsed };
  }

  async function activateNow() {
    setPending("activate");
    setOutcome(null);
    try {
      const answer = await post(
        `/api/launchpad/meta/intents/${encodeURIComponent(intentId)}/activate`,
        {
          businessId,
          actionOrigin: MANUAL_ACTION_ORIGIN,
          manualConfirmation: MANUAL_CONFIRMATION,
        },
      );
      const body = answer.body ?? {};
      setOutcome({
        ok: body.ok === true,
        delivering: body.delivering === true,
        blockedAt: (text(body.blockedAt) as ActivationGrain | null) ?? null,
        blockedReason: text(body.blockedReason),
        steps: Array.isArray(body.steps) ? (body.steps as LaunchpadActivationStep[]) : [],
        error: (body.error as { code: string; message: string } | undefined) ?? null,
      });
      setPhrase("");
      onResult?.({ kind: "activation" });
    } catch (error) {
      /*
        A transport failure after the POST reached the server is not "nothing
        happened". The activation may have run; this panel simply never heard
        the answer, and it must not draw a conclusion the client cannot have.
      */
      setOutcome({
        ok: false,
        error: {
          code: "activation_request_failed",
          message:
            error instanceof Error
              ? `${error.message} — the outcome of this activation is unknown; reconcile in Audit Trail before retrying.`
              : "The activation request failed and its outcome is unknown.",
        },
      });
    } finally {
      setPending(null);
    }
  }

  async function writeApproval(revoke: boolean) {
    setPending(revoke ? "revoke" : "approve");
    setApprovalOutcome(null);
    try {
      const answer = await post(
        `/api/launchpad/meta/intents/${encodeURIComponent(intentId)}/activation-approval`,
        revoke
          ? {
              businessId,
              actionOrigin: MANUAL_ACTION_ORIGIN,
              manualConfirmation: MANUAL_CONFIRMATION,
              revoke: true,
            }
          : {
              businessId,
              actionOrigin: MANUAL_ACTION_ORIGIN,
              manualConfirmation: MANUAL_CONFIRMATION,
              approvedScope: scope,
              approvedAssetVersion: assetVersion.trim() || "v1",
              ttlHours: Number(ttlHours) || DEFAULT_TTL_HOURS,
            },
      );
      const body = answer.body ?? {};
      const error = body.error as { code?: string; message?: string } | undefined;
      setApprovalOutcome({
        ok: body.ok === true,
        code: error?.code,
        message: error?.message,
        revoked: body.revoked === true,
      });
      setApprovePhrase("");
      onResult?.({ kind: "approval" });
    } catch (error) {
      setApprovalOutcome({
        ok: false,
        code: "activation_approval_request_failed",
        message: error instanceof Error ? error.message : "The approval request failed.",
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      className="space-y-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4"
      data-testid="launchpad-activation-panel"
      data-activation-intent={intentId}
    >
      <div>
        <h3 className="text-[14px] font-semibold text-[var(--ink)]">
          Publish ACTIVE · activation
        </h3>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--muted)]">
          Everything created above is PAUSED. Activation is a separate write with its own
          confirmation: campaign, then ad set, then ad, each proved by reading the entity
          back and requiring both its own status and its effective status to be active. A
          step that does not come back active stops the sequence and is reported as a
          blocked step, never as a launch.
        </p>
      </div>

      {disabledReason ? (
        <p
          className="rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-3 text-[12px] text-[var(--warn)]"
          data-activation-refusal=""
        >
          {disabledReason}
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        {/* Activate now — the operator, present, under their own confirmation. */}
        <div className="rounded-[8px] border border-[var(--border)] p-3">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-[var(--ok-bg)] text-[var(--ok)]">
              <PlayCircle className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[var(--ink)]">Activate now</p>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--muted)]">
                {operation === "new_campaign"
                  ? "Turns on the campaign, the ad set and the ad this launch created, in that order."
                  : "Turns on the ad this launch created. The ad set and campaign it joined are not touched."}
              </p>
              <label className="mt-3 block text-[11px] text-[var(--muted)]">
                Type {ACTIVATE_PHRASE} to confirm
                <input
                  type="text"
                  className="mt-1 w-full rounded-[6px] border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[12px] text-[var(--ink)]"
                  value={phrase}
                  disabled={locked}
                  onChange={(event) => setPhrase(event.target.value)}
                  data-activation-phrase=""
                  aria-label={`Type ${ACTIVATE_PHRASE} to confirm activation`}
                />
              </label>
              <button
                type="button"
                className="btn btn--primary mt-3 w-full sm:w-auto"
                data-activation-run=""
                disabled={locked || phrase.trim().toUpperCase() !== ACTIVATE_PHRASE}
                onClick={() => void activateNow()}
              >
                <PlayCircle className="h-4 w-4" />
                {pending === "activate" ? "Activating..." : "Activate now"}
              </button>
            </div>
          </div>
        </div>

        {/* The standing approval — what may happen later, without anybody here. */}
        <div className="rounded-[8px] border border-[var(--border)] p-3">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-[var(--info-bg)] text-[var(--info)]">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[var(--ink)]">
                Unattended activation
              </p>
              {approvalUnreadable ? (
                <p
                  className="mt-1 text-[12px] leading-relaxed text-[var(--warn)]"
                  data-activation-approval="unknown"
                >
                  {approvalUnavailableReason}
                </p>
              ) : standing ? (
                <div
                  className="mt-1 space-y-0.5 text-[12px] text-[var(--muted)]"
                  data-activation-approval="present"
                >
                  <p>
                    Scope{" "}
                    <strong className="font-semibold text-[var(--ink)]">
                      {standing.approvedScope === "hierarchy"
                        ? "campaign, ad set and ad"
                        : "ad only"}
                    </strong>
                  </p>
                  <p className="break-all font-mono text-[11px]">
                    approved by {standing.approvedBy}
                  </p>
                  <p>
                    {standing.revokedAt
                      ? `withdrawn ${standing.revokedAt}`
                      : `expires ${standing.expiresAt}`}
                  </p>
                  {standing.revokedAt ? (
                    <p className="text-[var(--warn)]" data-activation-approval-revoked="">
                      Withdrawn. Unattended activation is refused; this intent is
                      operator-only again.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p
                  className="mt-1 text-[12px] leading-relaxed text-[var(--muted)]"
                  data-activation-approval="absent"
                >
                  No approval is stored, so this intent is <strong>operator only</strong>.
                  Nothing can turn it on unattended.
                </p>
              )}

              <div className="mt-3 space-y-2">
                <p className="text-[11px] leading-relaxed text-[var(--muted)]">
                  Approving records that this exact payload may be activated later without
                  you. Scope for this launch is{" "}
                  <strong className="text-[var(--ink)]">
                    {scope === "hierarchy" ? "campaign, ad set and ad" : "the ad alone"}
                  </strong>
                  {operation === "new_campaign"
                    ? " — an ad-only approval cannot turn on a campaign this launch created paused."
                    : " — this launch joined an existing campaign, so approving the hierarchy would authorize structure it never made."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <label className="min-w-0 flex-1 text-[11px] text-[var(--muted)]">
                    Asset version
                    <input
                      type="text"
                      className="mt-1 w-full rounded-[6px] border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[12px] text-[var(--ink)]"
                      value={assetVersion}
                      disabled={locked}
                      onChange={(event) => setAssetVersion(event.target.value)}
                      data-activation-asset-version=""
                      aria-label="Approved asset version"
                    />
                  </label>
                  <label className="min-w-0 flex-1 text-[11px] text-[var(--muted)]">
                    Stands for (hours)
                    <input
                      type="number"
                      min={1}
                      max={168}
                      className="mt-1 w-full rounded-[6px] border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[12px] text-[var(--ink)]"
                      value={ttlHours}
                      disabled={locked}
                      onChange={(event) => setTtlHours(event.target.value)}
                      data-activation-ttl=""
                      aria-label="Hours the approval stands"
                    />
                  </label>
                </div>
                <label className="block text-[11px] text-[var(--muted)]">
                  Type {APPROVE_PHRASE} to confirm
                  <input
                    type="text"
                    className="mt-1 w-full rounded-[6px] border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[12px] text-[var(--ink)]"
                    value={approvePhrase}
                    disabled={locked}
                    onChange={(event) => setApprovePhrase(event.target.value)}
                    data-activation-approve-phrase=""
                    aria-label={`Type ${APPROVE_PHRASE} to confirm the approval`}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn--primary"
                    data-activation-approve=""
                    disabled={
                      locked
                      || approvalUnreadable
                      || approvePhrase.trim().toUpperCase() !== APPROVE_PHRASE
                    }
                    onClick={() => void writeApproval(false)}
                  >
                    {pending === "approve" ? "Recording..." : "Approve for unattended activation"}
                  </button>
                  {/*
                    Revoking takes no typed phrase. It removes authority rather
                    than granting it, and the write sets `revokedAt` rather than
                    clearing the column, so the record still says who approved
                    what and when it was withdrawn.
                  */}
                  <button
                    type="button"
                    className="btn"
                    data-activation-revoke=""
                    disabled={
                      locked || approvalUnreadable || !standing || Boolean(standing.revokedAt)
                    }
                    onClick={() => void writeApproval(true)}
                  >
                    {pending === "revoke" ? "Withdrawing..." : "Revoke"}
                  </button>
                </div>
              </div>

              {approvalOutcome ? (
                <p
                  className={
                    approvalOutcome.ok
                      ? "mt-2 text-[11.5px] text-[var(--ok)]"
                      : "mt-2 text-[11.5px] text-[var(--danger)]"
                  }
                  data-activation-approval-outcome={approvalOutcome.ok ? "ok" : "refused"}
                >
                  {approvalOutcome.ok
                    ? approvalOutcome.revoked
                      ? "Approval withdrawn. This intent is operator-only again."
                      : "Approval recorded. Nothing was activated by this write."
                    : `${approvalOutcome.code ?? "activation_approval_failed"} — ${
                        approvalOutcome.message ?? "The approval was not recorded."
                      }`}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {shown ? (
        <div
          className="overflow-hidden rounded-[8px] border border-[var(--border)]"
          data-activation-receipt=""
          data-activation-delivering={shown.delivering === true ? "true" : "false"}
        >
          <div className="border-b border-[var(--border)] px-3 py-2">
            {shown.delivering === true ? (
              <p className="text-[13px] font-semibold text-[var(--ok)]">
                Delivering · every step read back active
              </p>
            ) : shown.blockedAt ? (
              <p className="text-[13px] font-semibold text-[var(--warn)]">
                Blocked step: {describeBlockedHierarchy(shown.steps ?? [], shown.blockedAt)}
                {shown.blockedReason ? ` (${shown.blockedReason})` : ""}
              </p>
            ) : shown.error ? (
              <p className="text-[13px] font-semibold text-[var(--danger)]">
                <span className="font-mono">{shown.error.code}</span> — {shown.error.message}
              </p>
            ) : (
              <p className="text-[13px] font-semibold text-[var(--ink)]">
                Activation attempted · not reported as delivering
              </p>
            )}
            {shown.recordedAt ? (
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                Recorded {shown.recordedAt}
                {shown.authorization ? ` · ${shown.authorization} authority` : ""}
              </p>
            ) : null}
          </div>
          <div className="divide-y divide-[var(--border)]">
            {(shown.steps ?? []).map((step) => (
              <div
                key={`${step.grain}-${step.entityId}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2"
                data-activation-step={step.grain}
                data-activation-step-outcome={step.outcome}
              >
                <div className="min-w-0">
                  <p className="text-[12.5px] font-medium text-[var(--ink)]">
                    {GRAIN_LABEL[step.grain]} · {step.outcome.replace(/_/g, " ")}
                    {step.reason ? (
                      <span className="font-mono text-[11px] text-[var(--danger)]">
                        {" "}
                        {step.reason}
                      </span>
                    ) : null}
                  </p>
                  <p className="break-all font-mono text-[10.5px] text-[var(--muted)]">
                    {step.entityId}
                    {step.verified
                      ? ` · status ${step.verified.status ?? "—"} · effective ${
                          step.verified.effectiveStatus ?? "—"
                        }`
                      : ""}
                  </p>
                </div>
                <p className="break-all font-mono text-[10.5px] text-[var(--muted)]">
                  {/*
                    The durable id, not a transient one. Each step names the
                    `meta_ads_action_log` row it was journalled in, so a blocked
                    ad set here is the same row History shows.
                  */}
                  {step.actionLogId ? `log ${step.actionLogId}` : "no action-log row"}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
