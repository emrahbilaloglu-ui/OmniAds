/**
 * The morning read: what happened, what is waiting, and whether to trust it.
 *
 * Everything here is already produced somewhere. What was missing was the one
 * place an operator can open first — the Home card said nothing, so the only
 * way to find out whether the automation had done anything overnight was to
 * visit four screens and know which four.
 *
 * Two rules shape it. Nothing is computed here that a producer already
 * computes: this is a read, and a second opinion about ROAS would be a second
 * engine. And a read that fails says so. "No alerts" and "the alert query did
 * not answer" look identical on a card and mean opposite things, so every
 * section carries whether it was actually read.
 */
import { getDb } from "@/lib/db";
import { readMetaAnomaliesForBusiness } from "@/lib/meta/anomalies";
import { readLatestMetaDecisionSnapshot } from "@/lib/meta/snapshot";
import { resolveEffectiveMetaModes } from "@/lib/meta/automation-control-plane";

export const META_DAILY_BRIEF_CONTRACT = "meta.daily-brief.v1" as const;

export type BriefSectionState = "read" | "unavailable";

export interface MetaDailyBrief {
  contract: typeof META_DAILY_BRIEF_CONTRACT;
  businessId: string;
  providerAccountId: string | null;
  asOf: string;
  /**
   * How this business is being managed RIGHT NOW, per action family.
   *
   * The one section deliberately not bounded to `asOf`, and it says so here so
   * a historical brief is not read as a record of that day's settings. The
   * control plane stores one standing mode per business and action family
   * (`meta_automation_decision_type_modes`, keyed `(business_id,
   * decision_type)`) with no history table, so what a mode WAS on a past
   * morning is not recorded anywhere to be read back.
   */
  modes: {
    state: BriefSectionState;
    pause: string | null;
    budget: string | null;
    bid: string | null;
    creative: string | null;
  };
  alerts: {
    state: BriefSectionState;
    high: number;
    total: number;
    top: Array<{ type: string; scopeLabel: string; title: string; detail: string }>;
  };
  decisions: {
    state: BriefSectionState;
    /** Rows the server is serving as act-now, not the whole list. */
    actionable: number;
    top: Array<{ scopeType: string; scopeId: string; label: string; title: string }>;
    snapshotDate: string | null;
  };
  queue: {
    state: BriefSectionState;
    pending: number;
  };
  appliedYesterday: {
    state: BriefSectionState;
    applied: number;
    failed: number;
  };
  /**
   * Whether the data behind all of this is current.
   *
   * A brief built on a three-day-old snapshot is not wrong, but reading it as
   * this morning's picture would be. The date is stated so it cannot be.
   */
  freshness: {
    state: BriefSectionState;
    lastSnapshotDate: string | null;
    staleDays: number | null;
  };
}

const UNAVAILABLE = "unavailable" as const;

function dayBefore(asOf: string): string {
  const date = new Date(`${asOf}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/*
  WHAT THIS CARD CANNOT SAY, enumerated once so the next reader does not have to
  re-derive it.

  Every read in the builder below is bounded to `asOf` and scoped to the
  resolved provider account, EXCEPT these two, and both exceptions are
  structural rather than oversights:

  1. "Applied overnight" (`readOvernightLedger`) is asOf-bounded but
     BUSINESS-WIDE. `meta_automation_activity_ledger` has no
     `provider_account_id` column at all — the later ALTERs added only
     `actor_kind`, `entity_type`, `entity_id`, `result_status` and
     `result_receipt_id` — so it cannot be account-scoped without a schema
     change. On a business with two or more assigned Meta accounts, this number
     is business-wide on a card whose other sections are account-scoped.
  2. `modes` is business-keyed by primary key —
     `meta_automation_decision_type_modes` is `PRIMARY KEY (business_id,
     decision_type)` — so the same applies, and it has no date dimension to
     bound either.

  Alerts were the third entry here, recorded as an open judgement call rather
  than a settled limit: read business-wide while every other surface that
  serves anomalies scopes them. That one IS fixable inside this file and now
  is — see the alert read below, which scopes to the resolved account or
  withholds the section, the same shape decisions and the queue already use.

  Neither of the two that remain is fixable inside this file. They are limits
  of the card, not defects in it, and they are written down so a future reader
  does not mistake a business-wide number for an account-scoped one.
*/
export async function buildMetaDailyBrief(input: {
  businessId: string;
  /** A calendar day, `YYYY-MM-DD`. The caller validates it; see the route. */
  asOf?: string;
  providerAccountId?: string | null;
}): Promise<MetaDailyBrief> {
  /*
    One clock read for the whole brief.

    The day the payload is stamped with and the day it is compared against
    below have to be the same day, and two `new Date()` calls are two chances
    for them not to be.
  */
  const today = new Date().toISOString().slice(0, 10);
  const asOf = input.asOf ?? today;
  const providerAccountId = input.providerAccountId?.trim() || null;

  const [modes, anomalies, snapshot, queuePending, ledger] = await Promise.all([
    resolveEffectiveMetaModes(input.businessId).catch(() => null),
    /*
      The alert count is one account's, or it is not read.

      `readMetaAnomaliesForBusiness` reads a missing `providerAccountId` as "no
      account FILTER", not as "no account" — its filter step is `if
      (!providerAccountId) return true` — so omitting it served every assigned
      account's anomalies beside decisions and a queue that are one account's.
      The consequence was observable rather than theoretical: Home's "Alerts"
      number could exceed the Alerts screen's for the same business, on a card
      whose whole premise is that its sections agree with the screens behind
      them. The two account-scoped surfaces that serve anomalies —
      `app/api/meta/anomalies/route.ts` and the intelligence server's anomalies
      authority — both pass the account and refuse the read outright when there
      is none; this card did neither.

      Not the only other caller, and the qualifier matters: the notification
      producer also reads business-wide. It was a worse case, because it STAMPS
      each emitted notification with a provider account while reading across
      all of them — labelling another account's anomaly as this one's. That is
      corrected in the same batch as this, so the two account-shaped readers of
      this function now agree.

      Scoping was held back once because that filter is built from dimension
      allow-sets (`meta_campaign_dimensions`, `meta_adset_dimensions`), so a
      thin dimension table can turn real anomalies into a confident `0`. It is
      taken now because the Alerts screen reads through exactly that filter:
      thin dimensions already produce that `0` on the screen this card claims
      to agree with, so sharing the blind spot keeps the two numbers one fact,
      while not sharing it made them two facts under one label.

      And with zero or several assigned accounts there is no account to scope
      to, so the section reports itself unread rather than serving a
      business-wide count as one account's — the shape the decision read below
      and the queue count already use, so the card has one rule for this and
      not a fourth.
    */
    providerAccountId
      ? readMetaAnomaliesForBusiness({
        businessId: input.businessId,
        providerAccountId,
        activeOnly: true,
        /*
          The same ceiling the rest of the brief hangs off.

          Unbounded, this read takes `MAX(snapshot_date)` over all time — its
          own doc says so — so a brief for last Tuesday carried today's alerts
          beside last Tuesday's decisions and ledger, all under one `asOf`. The
          card would have said "3 high alerts as of 2026-09-01" about anomalies
          detected days later. `asOf` is that ceiling everywhere else here (the
          decision snapshot's ceiling, the overnight window's anchor), so it
          is the ceiling here too: one notion of "as of" per brief.
        */
        endDate: asOf,
      }).catch(() => null)
      : Promise.resolve(null),
    /*
      The decision read is account-scoped and as-of bounded, or it is skipped.

      Two separate leaks met here. Passing a null `providerAccountId` did not
      mean "no account" to the reader — null is its no-filter case — so a
      business with zero or several assigned accounts got business-wide rows
      served as if they were one account's, including a disconnected account's,
      with nothing in the top-item shape to say which action belonged to where.
      The queue below has always refused that read for the same reason; this
      one now refuses it the same way, and the route's own promise — "with
      several, the account-scoped sections report unavailable" — becomes true.

      And `startDate`/`endDate` never bounded which snapshot is "latest": that
      read takes MAX(snapshot_date) over all time unless given a ceiling, so a
      brief for last Tuesday labelled TODAY's actionable decisions and
      freshness date with last Tuesday's `asOf`. The ceiling is the same `asOf`
      the alerts and the overnight window already hang off — one notion of "as
      of" per brief, not a third.
    */
    providerAccountId
      ? readLatestMetaDecisionSnapshot({
        businessId: input.businessId,
        startDate: dayBefore(dayBefore(asOf)),
        endDate: asOf,
        providerAccountId,
        snapshotDateCeiling: asOf,
      }).catch(() => null)
      : Promise.resolve(null),
    /*
      The queue count is a READ, and only for a brief about today.

      Two defects met on this one line, and the second is the worse of them.

      `readMetaAutomationProposalQueue` is the Automation screen's reader, and
      its first two statements are UPDATEs.
      `expireStaleMetaAutomationProposals` runs `UPDATE
      meta_automation_proposals SET status = 'expired', updated_at = NOW()
      WHERE business_id = $1 AND status = 'pending' AND expires_at <= $2`, and
      `sweepStaleMetaAutomationProposalClaims` runs `UPDATE ... SET status =
      CASE ... 'reconcile' / 'expired' / 'pending' END, claim_token = ...,
      claimed_by = ..., claimed_at = ..., updated_at = NOW() WHERE business_id
      = $1 AND status = 'claimed' AND claimed_at <= $3`. Both are business-wide
      — neither is narrowed to the account this brief is about — so merely
      rendering the Home card expired proposals and released claim leases
      across every account of the business. Opening a dashboard is not a
      decision, and a GET must not make one.

      And the number that came back was never bounded to `asOf`: the sweeps and
      the select all use the real current time, while alerts, decisions, the
      ledger window and freshness are bounded to the requested day. A brief for
      last Tuesday counted proposals raised days after it as "waiting for you"
      under Tuesday's date.

      The bound is refused rather than approximated, because it cannot be
      reconstructed. A proposal's `status` is overwritten in place — there is
      no per-row history — and the snapshot's `ON CONFLICT ... DO UPDATE`
      refresh rewrites `expires_at` on the row it touches, so nothing stored
      says which rows were pending on a past morning: `created_at` cannot
      exclude a row decided since, and `updated_at` is one last-touch stamp
      with no before value. A count assembled from those columns would look
      bounded and be wrong, which on this card is worse than "not read".
    */
    providerAccountId && asOf === today
      ? readPendingProposalCount(input.businessId, providerAccountId)
      : Promise.resolve(null),
    readOvernightLedger(input.businessId, asOf),
  ]);

  const anomalyRows = (anomalies as {
    anomalies?: Array<Record<string, string>>;
  } | null)?.anomalies ?? null;

  /*
    "Actionable" is the state the server served, not the verdict label.

    Those are two different facts and this read path is where they part. The
    decision reader hands every row to `enforceMetaCommercialActionAuthority`
    and then to the campaign-role guard, and the LABEL survives both in ways
    that make it unreliable in either direction:

      - `enforceMetaCommercialActionAuthority` sets `decisionState: "watch"` and
        strips `proposedAction`, leaving `decisionLabel` exactly as the engine
        wrote it. A scale whose commercial target is missing still reads
        `decisionLabel: "scale"`.
      - the campaign-role guard never touches `proposedAction` at all, and its
        two downgrades disagree with each other: `restrictAutomaticContextToReview`
        preserves the label, while `downgradeToSoftOnly` REWRITES it to
        `"diagnose"` and `kind` to `"state"`.

    So the label is preserved on one refusal path and rewritten on another,
    which is a stronger reason to stop reading it than either path alone.
    Filtering on it counted a withheld scale under "Decisions to act on", the
    one number this card exists to answer, when the server had already refused
    to serve it as one.

    It cut the other way too. Every act-state row the engine labelled something
    other than scale or cut — `rebuild_with_constraints` and `campaign_structure`
    (rebuild), `geo_cluster_for_signal_density` (swap), `bid_band_from_history`
    (tune) — was dropped from the count and the top list alike.

    This is still not a second opinion: `decisionState` is the field the rest of
    the release reads for this question, and the judgement is made once,
    upstream — this only reads the answer.

    Two limits worth stating rather than implying. `isHeld` in the decisions
    presentation is TWO fields, `recommendedAction.trim() === "" ||
    decisionState === "watch"`, so this count and that predicate already
    disagree at the edges in both directions; they are close, not identical.
    And because `decisionLabelForMetaRec` falls back to `"keep"` for any
    act-state type it does not enumerate, some counted rows will read `keep`.
    That is the correct outcome under this filter — the server served them as
    actionable — but it is a visible consequence of no longer reading the
    label, so it is named here rather than discovered.
  */
  const recommendations = snapshot?.recommendations ?? null;
  const actionable = recommendations?.filter(
    (rec) => rec.decisionState === "act") ?? null;

  const lastSnapshotDate = snapshot?.snapshotDate ?? null;
  const staleDays = lastSnapshotDate
    ? Math.max(0, Math.round(
      (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${lastSnapshotDate}T00:00:00Z`))
      / 86_400_000,
    ))
    : null;

  return {
    contract: META_DAILY_BRIEF_CONTRACT,
    businessId: input.businessId,
    providerAccountId,
    asOf,
    modes: {
      state: modes ? "read" : UNAVAILABLE,
      pause: modes?.pause ?? null,
      budget: modes?.budget ?? null,
      bid: modes?.bid ?? null,
      creative: modes?.creative ?? null,
    },
    alerts: {
      // Two things that are not "no alerts", and both say so: no resolved
      // account to scope the read to, and a read that did not answer.
      state: anomalyRows ? "read" : UNAVAILABLE,
      high: anomalyRows?.filter((row) => row.severity === "high").length ?? 0,
      total: anomalyRows?.length ?? 0,
      top: (anomalyRows ?? []).slice(0, 3).map((row) => ({
        type: String(row.type ?? ""),
        scopeLabel: String(row.scopeLabel ?? ""),
        title: String(row.title ?? ""),
        detail: String(row.detail ?? ""),
      })),
    },
    decisions: {
      state: recommendations ? "read" : UNAVAILABLE,
      actionable: actionable?.length ?? 0,
      top: (actionable ?? []).slice(0, 3).map((rec) => ({
        scopeType: String(rec.level ?? ""),
        // The id of the entity this decision is about, at its own grain.
        scopeId: String(
          (rec.level === "adset" ? rec.adsetId : rec.campaignId) ?? "",
        ),
        label: String(rec.decisionLabel ?? ""),
        title: String(rec.title ?? ""),
      })),
      snapshotDate: lastSnapshotDate,
    },
    queue: {
      // Three things that are not an empty queue, and all three say so: no
      // bound account to read, a brief about a day whose pending set cannot be
      // reconstructed, and a read that did not answer.
      state: queuePending === null ? UNAVAILABLE : "read",
      pending: queuePending ?? 0,
    },
    appliedYesterday: ledger ?? { state: UNAVAILABLE, applied: 0, failed: 0 },
    freshness: {
      state: snapshot ? "read" : UNAVAILABLE,
      lastSnapshotDate,
      staleDays,
    },
  };
}

/**
 * How many proposals are waiting for this operator — without deciding any.
 *
 * The predicate is the queue reader's own — `pending`, not yet expired, in
 * this one account, the same rows `idx_meta_automation_proposals_queue` was
 * built for. What is dropped is the two stale sweeps that reader runs first,
 * which belong to a screen where the operator is about to act on the rows and
 * not to a card that reports a number. The difference they make is small,
 * one-directional, and worth stating rather than leaving to be discovered:
 *
 * - The expiry sweep changes nothing here. `expires_at > now()` already
 *   excludes every row that sweep would have flipped to `expired`.
 * - The claim sweep can. A claim past its lease whose dispatch never started
 *   is still `claimed` to this count, and is counted only once the Automation
 *   screen or the scheduled claim path returns it to `pending`. So the card
 *   can read one lower than that screen for a few minutes. That is the price
 *   of not writing from a read, and it is the right side to err on: a number
 *   on Home is not worth a status transition nobody asked for.
 *
 * Counting rather than hydrating is also why this needs no equivalent of the
 * queue reader's `withClaimColumnFallback`: `status` and `expires_at` predate
 * every later migration, so a database missing the claim, envelope or launch
 * columns answers this query instead of degrading through a 42703.
 *
 * Null is "not read", never zero. On a database without the table the query
 * raises and this returns null, because an empty queue and an unreadable one
 * are opposite facts on this card.
 */
async function readPendingProposalCount(
  businessId: string,
  providerAccountId: string,
): Promise<number | null> {
  const rows = (await getDb().query(
    `SELECT count(*)::int AS pending
       FROM meta_automation_proposals
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND status = 'pending'
        AND expires_at > now()`,
    [businessId, providerAccountId],
  ).catch(() => null)) as Array<{ pending: number }> | null;
  if (rows === null) return null;
  return rows[0]?.pending ?? 0;
}

/**
 * What the automation actually did in the last 24 hours.
 *
 * Read from the ledger's own result column rather than counted from
 * proposals: a row that was approved and then failed at the provider is not
 * an applied change, and the ledger is where that distinction lives.
 *
 * The window is closed at both ends. `created_at >= asOf - 1 day` on its own
 * was not a 24-hour window at all: opened at 09:00 it counted 33 hours, opened
 * at 23:00 it counted 47, so the card labelled "Applied overnight" grew all day
 * and yesterday afternoon's manual approvals landed in this morning's count.
 * For a past asOf it was worse — with no upper bound it swept in every ledger
 * row written since, so a brief for last Tuesday reported everything the
 * automation has done in the days after it.
 *
 * Both ends hang off the same anchor: the earlier of now() and the end of the
 * asOf day. Today that anchor is now(), giving the true rolling 24 hours the
 * card claims — this morning's 03:00 run counts, yesterday's 15:00 one does
 * not. For a past asOf it clamps to that day's midnight, giving a fixed window
 * that cannot drift as more rows arrive. The date boundary is explicitly UTC,
 * matching the builder's asOf date even when the database session uses another
 * time zone. Both bounds are stable expressions, so this
 * still range-scans idx_meta_automation_activity_ledger_business rather than
 * degrading into the kind of index-unusable predicate that has silently
 * exceeded the pool read timeout on this schema before.
 */
async function readOvernightLedger(
  businessId: string,
  asOf: string,
): Promise<MetaDailyBrief["appliedYesterday"] | null> {
  const rows = (await getDb().query(
    `SELECT result_status, count(*)::int AS count
       FROM meta_automation_activity_ledger
      WHERE business_id = $1::uuid
        AND created_at >= LEAST(now(), ($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC') - INTERVAL '24 hours'
        AND created_at < LEAST(now(), ($2::date + INTERVAL '1 day') AT TIME ZONE 'UTC')
      GROUP BY result_status`,
    [businessId, asOf],
  ).catch(() => null)) as Array<{
    result_status: string | null;
    count: number;
  }> | null;
  if (rows === null) return null;
  const by = new Map(rows.map((row) => [row.result_status ?? "", row.count]));
  return {
    state: "read",
    applied: by.get("applied") ?? 0,
    failed: by.get("failed") ?? 0,
  };
}
