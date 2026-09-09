/**
 * "NO EDIT WAS FOUND" AND "WE COULD NOT LOOK" ARE NOT THE SAME FACT.
 *
 * ── ROUND 12 ────────────────────────────────────────────────────────────────
 * Round 11 scoped the config-history read to the entity's own provider account
 * and bounded it by that account's own calendar. It then claimed that an
 * account whose timezone could not be established would FAIL CLOSED, because
 * withholding its history leaves `lastSignificantEditAt` null, and null was
 * said to keep `qualityStatusFor` off "ready".
 *
 * That claim was false, and this module exists because of it.
 *
 *   - `qualityStatusFor` counts SIX candidate signals — learning state,
 *     frequency p80, CTR decay, creative age, last significant edit, tracking
 *     status — and calls the pack "ready" at ANY THREE non-null. An ad set with
 *     a learning state, a frequency and a CTR decay is therefore "ready" with
 *     `lastSignificantEditAt` null.
 *   - `blocksPurchaseHardAction` then reads
 *     `daysSinceSignificantEdit != null && < 7`. Null is not `< 7`, so it
 *     passes.
 *   - `recentEditCooldownActive` in the campaign emitters reads the same field
 *     the same way.
 *
 * So an account with a missing or unusable timezone, no physical account
 * binding, or a failed history read produced a signal that looked fully ready
 * and authorised Scale / Cut / Refresh on evidence nobody had. The window was
 * correct; the conclusion drawn from an absent window was not.
 *
 * ## What this module fixes, and what it deliberately does not
 *
 * The ambiguity is semantic, so the fix is to stop overloading one null field
 * with two meanings and to record the distinction explicitly:
 *
 *   READY       a trusted IANA zone was resolved for the entity's own provider
 *               account, the account-scoped config-history read SUCCEEDED, AND
 *               a fresh COMPLETE current-config observation receipt for that
 *               exact account/entity-type/endpoint exists at or before the
 *               provider-local cutoff with this entity present in it.
 *
 *               ── ROUND 13 ──────────────────────────────────────────────────
 *               The receipt clause is not decoration. Round 12 treated a
 *               config-history SELECT that did not throw as an observation, but
 *               those tables are TRANSITION-ONLY: an incomplete capture appends
 *               nothing and an unchanged complete capture appends nothing
 *               either. "Zero rows" is therefore written identically by
 *               "nothing changed", "we never looked" and "we looked and
 *               failed", and only the first of those is an observation.
 *
 *               Zero significant edits under a COMPLETE, FRESH capture that saw
 *               this entity is still a READY answer — it is an observation, not
 *               a failure, and it must keep authorising actions.
 *
 *   UNAVAILABLE the entity has no resolvable provider account; or that account
 *               has no trusted IANA timezone (checked on the WRITE side and
 *               again on the READ side, so a hand-written or legacy row cannot
 *               smuggle "+03:00" or "PST" through); or the history read threw;
 *               or there is no capture receipt, or the newest one at the cutoff
 *               is stale / partial / point_lookup / failed, or the entity was
 *               absent from it or had exited. In every one of those the edit
 *               age is unknown, so a recent-edit veto cannot be evaluated at
 *               all and every purchase-budget hard action must HOLD.
 *
 * ABSENCE IS UNAVAILABLE, ON PURPOSE. A signal row written before this contract
 * existed carries no authority record. It is not evidence that the authority
 * was ready — it is evidence that nobody wrote one down — so it reads as
 * `not_recorded` and holds. The backfill rewrites the current as-of day on
 * every run, so a row self-heals on the next cycle; a permissive default would
 * instead preserve exactly the defect this module was written to close.
 *
 * ## Scope
 *
 * This gates PURCHASE-BUDGET HARD ACTIONS only. Diagnostic, watch and test
 * decisions are untouched: they exist to describe an account whose evidence is
 * incomplete, and making them conditional on complete evidence would turn a
 * missing timezone into total silence rather than into a held action. The
 * cooldown WATCH emitter is likewise untouched — it must not fire on an unknown
 * edit age, because "we could not look" is not a cooldown.
 */
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import { isSupportedIanaTimeZone } from "@/lib/meta/provider-local-day";

/**
 * The `sourceJson` key this authority is carried under.
 *
 * `source_json` is an existing JSONB column that already round-trips verbatim
 * through `readMetaEntityDecisionSignals` and `upsertMetaEntityDecisionSignals`
 * (`lib/meta/entity-signals.ts`), and it already carries three sibling status
 * records — `tracking_quality`, `monthly_pacing`, `placement_mix` — read by the
 * same shape. Recording the authority here is therefore the smallest change
 * that persists and serves it: no migration, no new column, no contract
 * version, and older rows stay readable.
 */
export const META_RECENT_EDIT_AUTHORITY_KEY = "config_history_authority";

export type MetaRecentEditAuthorityStatus = "ready" | "unavailable";

export type MetaRecentEditAuthorityReason =
  /**
   * A trusted zone, a config-history read that succeeded, AND a fresh COMPLETE
   * current-config observation receipt naming this exact entity.
   */
  | "observed"
  /** No provider account could be attached to this entity's daily rows. */
  | "provider_account_unresolved"
  /** The account has no binding, a null zone, or a zone this runtime rejects. */
  | "provider_timezone_untrusted"
  /** The account-scoped config-history query threw. */
  | "config_history_read_failed"
  /*
    ── ROUND 13: THE RECEIPT REASONS ─────────────────────────────────────────
    A successful SELECT against a TRANSITION-ONLY table is not an observation.
    `meta_campaign_config_history` and `meta_adset_config_history` are appended
    to only when a complete capture sees a CHANGE: an incomplete capture writes
    nothing, and an unchanged complete capture writes nothing either. So "zero
    rows" is produced identically by "nothing changed", "we never looked" and
    "we looked and failed" — and Round 12 read all three as an observation.

    What makes zero rows mean "no edit" is separate, durable evidence that a
    complete capture of this entity's CURRENT CONFIG actually happened at or
    before the cutoff. These are the ways that evidence can be missing.
  */
  /** No capture attempt for this account/entity type/endpoint at the cutoff. */
  | "observation_receipt_missing"
  /**
   * The newest attempt at/before the cutoff was `partial`, `point_lookup` or
   * `failed`. Never stepped over to reach an older success.
   */
  | "observation_capture_not_complete"
  /** The newest complete attempt is older than the source-freshness contract. */
  | "observation_receipt_stale"
  /** The capture happened but this entity was not in it. */
  | "entity_absent_from_observation"
  /**
   * The entity's latest truth at the cutoff is a tombstone: it exited.
   * ROUND 14: membership now subsumes this — a scope-exit recorded after the
   * applicable re-observation removes the entity from the manifest, so it
   * surfaces as `entity_absent_from_observation`. Retained because persisted
   * rows carry it and because it remains the truthful cause when known.
   */
  | "entity_exited"
  /* ── ROUND 14, CONTRACT 1: THE EXACT SYNC ATTEMPT ─────────────────────── */
  /** The receipt predates `sync_run_id`. Legacy, and not proof of anything. */
  | "sync_run_unlinked"
  /** The linked attempt row is gone. */
  | "sync_run_missing"
  /** The attempt names a different partition, business or account. */
  | "sync_run_mismatched"
  /** The attempt is still running, or failed, or was cancelled. */
  | "sync_run_not_succeeded"
  /** Succeeded but with no finish clock, which is not a terminal record. */
  | "sync_run_unfinished"
  /**
   * ROUND 15: the attempt finished at or after the knowledge bound. A success
   * recorded after the cutoff cannot authorise a decision AT that cutoff.
   */
  | "sync_run_finished_after_knowledge"
  /**
   * ROUND 15: the receipt occurrence clock falls outside its own attempt's
   * lifecycle, so the two do not describe the same work.
   */
  | "sync_run_lifecycle_mismatch"
  /** The attempt's partition was dead-lettered. */
  | "sync_partition_dead_letter"
  /* ── ROUND 14, CONTRACT 2: MANIFEST MEMBERSHIP ────────────────────────── */
  /** The receipt's observation run could not establish a usable manifest. */
  | "observation_manifest_unusable"
  /* ── ROUND 14, CONTRACT 3: THE KNOWLEDGE CLOCK ────────────────────────── */
  /** The provider-local day has not happened yet. */
  | "provider_local_day_in_future"
  /** The receipt clock is unusable or ahead of the knowledge bound. */
  | "receipt_clock_invalid"
  /** The signal predates this contract. Not proof of readiness. */
  | "not_recorded"
  /** The key is present but malformed, which is untrusted evidence. */
  | "malformed";

export interface MetaRecentEditAuthority {
  status: MetaRecentEditAuthorityStatus;
  reason: MetaRecentEditAuthorityReason;
  /** The zone the window was actually computed in, or null when there was none. */
  timeZone: string | null;
}

/** The persisted shape, snake_cased to match its `source_json` siblings. */
export interface MetaRecentEditAuthorityRecord {
  status: MetaRecentEditAuthorityStatus;
  reason: MetaRecentEditAuthorityReason;
  time_zone: string | null;
  /**
   * ROUND 14: the specific sub-cause when the reason is a family rather than a
   * single fact — e.g. which manifest check failed. Diagnostic only: no gate
   * reads it, and its absence never makes an unavailable authority ready.
   */
  detail?: string | null;
}

const READY_REASONS: ReadonlySet<string> = new Set(["observed"]);

const KNOWN_REASONS: ReadonlySet<string> = new Set([
  "observed",
  "sync_run_unlinked",
  "sync_run_missing",
  "sync_run_mismatched",
  "sync_run_not_succeeded",
  "sync_run_unfinished",
  "sync_run_finished_after_knowledge",
  "sync_run_lifecycle_mismatch",
  "sync_partition_dead_letter",
  "observation_manifest_unusable",
  "provider_local_day_in_future",
  "receipt_clock_invalid",
  "provider_account_unresolved",
  "provider_timezone_untrusted",
  "config_history_read_failed",
  "observation_receipt_missing",
  "observation_capture_not_complete",
  "observation_receipt_stale",
  "entity_absent_from_observation",
  "entity_exited",
  "not_recorded",
  "malformed",
]);

/** The producer's constructor, so the two sides cannot disagree on the shape. */
export function metaRecentEditAuthorityRecord(input: {
  status: MetaRecentEditAuthorityStatus;
  reason: MetaRecentEditAuthorityReason;
  timeZone: string | null;
  detail?: string | null;
}): MetaRecentEditAuthorityRecord {
  return {
    status: input.status,
    reason: input.reason,
    time_zone: input.timeZone,
    ...(input.detail == null ? {} : { detail: input.detail }),
  };
}

/**
 * Read one signal's recent-edit authority.
 *
 * Never throws and never guesses: anything it cannot read as a well-formed
 * ready record is `unavailable` with the reason it could not.
 */
export function metaRecentEditAuthority(
  signal: MetaEntityDecisionSignal | null | undefined,
): MetaRecentEditAuthority {
  if (!signal) {
    return { status: "unavailable", reason: "not_recorded", timeZone: null };
  }
  const raw = signal.sourceJson?.[META_RECENT_EDIT_AUTHORITY_KEY];
  if (raw == null) {
    return { status: "unavailable", reason: "not_recorded", timeZone: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "unavailable", reason: "malformed", timeZone: null };
  }
  const record = raw as Record<string, unknown>;
  const status = String(record.status ?? "").trim();
  const reason = String(record.reason ?? "").trim();
  /*
    ── ROUND 13, DEFECT 3: THE PERSISTED ZONE IS VALIDATED HERE TOO ──────────

    This accepted ANY non-empty string. The producer validates with
    `isSupportedIanaTimeZone` before it writes, but a reader that trusts the
    column re-opens the hole from the other side: a row written by an older
    build, by a repair script, or by hand could carry "+03:00", "PST" or
    "Mars/Olympus" — none of which is a calendar — and read as READY.

    The same shared predicate the window itself is built from is applied to the
    value that comes back, so the two sides cannot disagree about what a zone
    is. A fixed offset cannot express a DST rule and an abbreviation is
    ambiguous across regions; both are refused rather than approximated.
  */
  const timeZone = isSupportedIanaTimeZone(record.time_zone)
    ? String(record.time_zone).trim()
    : null;

  if (!KNOWN_REASONS.has(reason)) {
    // An unrecognised reason is evidence written by something this build does
    // not understand. It is not readable as ready.
    return { status: "unavailable", reason: "malformed", timeZone };
  }
  /*
    READY IS THE NARROW CASE, and it needs BOTH halves to agree. A record that
    says `ready` under a reason that is not an observation — or with no zone at
    all, which is the exact condition that makes the window unknowable — is
    self-contradictory, and a contradiction is untrusted evidence.
  */
  if (status === "ready" && READY_REASONS.has(reason) && timeZone !== null) {
    return { status: "ready", reason: "observed", timeZone };
  }
  if (status === "ready") {
    return { status: "unavailable", reason: "malformed", timeZone };
  }
  if (status !== "unavailable") {
    return { status: "unavailable", reason: "malformed", timeZone };
  }
  return {
    status: "unavailable",
    reason: reason as MetaRecentEditAuthorityReason,
    timeZone,
  };
}

/**
 * May a purchase-budget hard action read this entity's edit age at all?
 *
 * The one predicate every hard-action gate consults. False means the age is
 * unknown — NOT that an edit was recent — so the caller must hold rather than
 * treat the absent day count as a passing one.
 */
export function metaRecentEditAuthorityReady(
  signal: MetaEntityDecisionSignal | null | undefined,
): boolean {
  return metaRecentEditAuthority(signal).status === "ready";
}

/**
 * ── ROUND 15, DEFECT 5: THE LEGACY-RECEIPT BLACKOUT ─────────────────────────
 *
 * Every receipt written before `sync_run_id` existed reads `sync_run_unlinked`
 * and correctly holds. That is the right refusal, and it is self-healing —
 * *provided something writes a new, linked receipt.*
 *
 * Nothing does, on an account that is already up to date. Current-config
 * receipts are written only by the current-inventory path inside
 * `syncMetaAccountCoreWarehouseDay`, and `syncMetaPartitionDay` skips the whole
 * account-core sync when `coverageState.productCoreComplete` is true. So a
 * healthy account with complete daily coverage would never re-observe, never
 * write a linked receipt, and hold every purchase-budget hard action
 * indefinitely — a permanent blackout produced by a correct refusal.
 *
 * THE SMALLEST SAFE CONTRACT is a bounded, self-terminating bypass: on the
 * CURRENT provider-local day only, if the account has no fresh linked
 * campaign+adset authority receipt, allow one scoped current-inventory refetch
 * even though daily metric coverage is complete. The moment such receipts
 * exist, this answers false and ordinary short-circuiting resumes, so it cannot
 * become an every-refresh provider-call loop.
 *
 * IT NEVER FABRICATES A LINK. Legacy rows keep their null `sync_run_id`; the
 * bypass exists so a NEW receipt can be written beside them, not so an old one
 * can be relabelled.
 */
export interface MetaAuthorityBootstrapProbe {
  /**
   * True when the newest status-blind receipt for this endpoint satisfies the
   * FULL recent-edit authority contract. Not a weaker "linked" shortcut.
   * @see attestMetaConfigObservation
   */
  campaignReceiptLinked: boolean;
  adsetReceiptLinked: boolean;
  /**
   * ── ROUND 17, ITEM 2 ─────────────────────────────────────────────────────
   * Attempts already spent on this exact business/account in the current
   * PROVIDER-LOCAL day, read from the durable attempt ledger.
   *
   * NOT inferred from receipts. Round 16 halved a receipt count, which
   * undercounted a campaign-only commit, missed a pre-receipt failure entirely,
   * and reset to zero on a read error. `null` means the ledger could not be
   * read, which FAILS CLOSED: an uncounted attempt is how a bounded retry
   * becomes a provider-call loop.
   */
  attemptsSpent: number | null;
}

/** How many bootstrap refetches one account/day may spend before it waits. */
export const META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS = 3;

export function shouldBootstrapRecentEditAuthority(input: {
  truthState: "provisional" | "finalized";
  probe: MetaAuthorityBootstrapProbe | null;
}): boolean {
  // CURRENT DAY ONLY. A historical partition must never refetch current
  // inventory: that is the amplification the current-evidence gate exists to
  // prevent, and a receipt written there would attest the wrong day.
  if (input.truthState !== "provisional") return false;
  if (!input.probe) return false;
  // BOTH endpoints must be linked. The authority reads campaign and adset
  // independently, so one linked pair does not unblock the other.
  if (input.probe.campaignReceiptLinked && input.probe.adsetReceiptLinked) {
    return false;
  }
  /*
    ROUND 17: an unreadable ledger is not an empty one. Without a trustworthy
    count the bound cannot be enforced, so no provider call is made — the
    account stays on HOLD, which it already was.
  */
  if (input.probe.attemptsSpent === null) return false;
  return input.probe.attemptsSpent < META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS;
}
