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
import { readMetaAutomationProposalQueue } from "@/lib/meta/automation-proposals";
import { readLatestMetaDecisionSnapshot } from "@/lib/meta/snapshot";
import { resolveEffectiveMetaModes } from "@/lib/meta/automation-control-plane";

export const META_DAILY_BRIEF_CONTRACT = "meta.daily-brief.v1" as const;

export type BriefSectionState = "read" | "unavailable";

export interface MetaDailyBrief {
  contract: typeof META_DAILY_BRIEF_CONTRACT;
  businessId: string;
  providerAccountId: string | null;
  asOf: string;
  /** How this business is being managed today, per action family. */
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
    /** Decisions the engine considers actionable, not the whole list. */
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

export async function buildMetaDailyBrief(input: {
  businessId: string;
  providerAccountId?: string | null;
  asOf?: string;
}): Promise<MetaDailyBrief> {
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  const providerAccountId = input.providerAccountId ?? null;

  const [modes, anomalies, snapshot, queue, ledger] = await Promise.all([
    resolveEffectiveMetaModes(input.businessId).catch(() => null),
    readMetaAnomaliesForBusiness({
      businessId: input.businessId,
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
    }).catch(() => null),
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
    providerAccountId
      ? readMetaAutomationProposalQueue({
        businessId: input.businessId,
        providerAccountId,
      }).catch(() => null)
      : Promise.resolve(null),
    readOvernightLedger(input.businessId, asOf),
  ]);

  const anomalyRows = (anomalies as {
    anomalies?: Array<Record<string, string>>;
  } | null)?.anomalies ?? null;

  /*
    "Actionable" is the engine's own word, read from the decision label. This
    module does not re-decide which recommendations matter — that judgement is
    made once, upstream, with the evidence.
  */
  const recommendations = snapshot?.recommendations ?? null;
  const actionable = recommendations?.filter((rec) =>
    rec.decisionLabel === "cut" || rec.decisionLabel === "scale") ?? null;

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
      // A business with no bound account has no queue to read, which is not
      // the same as an empty one.
      state: queue?.readCompleteness === "complete" ? "read" : UNAVAILABLE,
      pending: queue?.proposals.length ?? 0,
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
 * that cannot drift as more rows arrive. The anchor is still the `$2::date`
 * boundary the query already used, so the fix bounds the window without moving
 * the day basis underneath it. Both bounds are stable expressions, so this
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
        AND created_at >= LEAST(now(), $2::date + INTERVAL '1 day') - INTERVAL '24 hours'
        AND created_at < LEAST(now(), $2::date + INTERVAL '1 day')
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
