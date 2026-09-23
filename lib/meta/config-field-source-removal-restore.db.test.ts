/**
 * Removal and restore, through the EMITTED SQL, on real PostgreSQL.
 *
 * The bug this pins: a candidate filter of `field IS NOT NULL` makes a receipt
 * that asked for the field and came back WITHOUT it invisible, so the previous
 * day's value keeps standing as though the receipt that disproves it never
 * arrived. A stale PURCHASE surviving its own refutation is the concrete harm.
 *
 * Shape assertions cannot catch it — the filter reads perfectly reasonable — so
 * this drives the builders' own output over a fixture where the provider removes
 * a field and later restores it, and checks BOTH answers the contract gives:
 *
 *   as-of      what the run could have known at a cutoff, and
 *   restated   what today's warehouse says.
 *
 * Those two must DIVERGE at a cutoff between the removal and the restore. If a
 * future change collapses them, the divergence disappears and this fails.
 *
 * Runs only inside the ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import {
  buildMetaAdsetConfigFieldSourceSql,
  buildMetaConfigFieldSourceSql,
} from "@/lib/meta/config-field-source-contract";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const ACCOUNT_ID = "act_removal_restore_seam";
const OWNER_EMAIL = "config-field-removal-restore@seam.local";
const DAY = "2026-09-15";
const TZ = "UTC";
const ADSET = "as_removal_1";
/** A second ad set, used only for the competing-snapshot case. */
const RIVAL_ADSET = "as_rival_1";
/** A campaign on a UTC+3 account, for the local-day boundary case. */
const TZ_CAMPAIGN = "cmp_tz_1";
const TZ_NAME = "Europe/Istanbul";
/** 2026-09-15 in Istanbul runs from 2026-09-14T21:00Z to 2026-09-15T21:00Z. */
const TZ_DAY = "2026-09-15";
/** A campaign whose receipts span several pages, so their timing is unknowable. */
const MULTI_CAMPAIGN = "cmp_multi_1";
const MULTI_ADSET = "as_multi_1";
/*
  MULTI-PAGE RECEIPTS THAT RECORD WHEN THE FETCH RAN.

  Same shape as MULTI above — several pages, no run id, no per-entity clock —
  with one addition: `pagination.startedAt` and `pagination.completedAt`. That
  pair answers the only question the multi-page tier actually withholds, which is
  whether the fetch straddled a provider-local midnight. Each constant below is
  one answer to it, and five of the seven are refusals.
*/
/** Proven inside the day at BOTH ends, so the day can bracket. */
const PAGED_CAMPAIGN = "cmp_paged_1";
/** Proven inside the day, with no corroboration at all: the new tier by name. */
const PAGED_LONE_CAMPAIGN = "cmp_paged_lone_1";
/** The hazard itself: a fetch that began the previous local day. */
const STRADDLE_CAMPAIGN = "cmp_straddle_1";
/** Timings that belong to some other sighting than the one they sit beside. */
const MISMATCH_CAMPAIGN = "cmp_mismatch_1";
/** A start that lost its time, which local midnight would answer by default. */
const BAREDATE_CAMPAIGN = "cmp_baredate_1";
/** Half a window: the end recorded, the start never written. */
const HALFWINDOW_CAMPAIGN = "cmp_halfwindow_1";
/** A window that runs backwards, which proves nothing about anything. */
const REVERSED_CAMPAIGN = "cmp_reversed_1";
/** The ad-set grain of the proven case. */
const PAGED_ADSET = "as_paged_1";
/** A campaign whose receipts carry no readable pageCount at all. */
const BADPAGES_CAMPAIGN = "cmp_badpages_1";
/** A campaign that also carries a contemporaneous typed witness. */
const TIE_CAMPAIGN = "c_tie";
const MASK_CAMPAIGN = "cmp_mask_1";
const CAMPAIGN = "cmp_removal_1";

let businessId = "";
let accountRefId = "";

/** The selector every fixture receipt carries, so admission is never the variable. */
const ADSET_FIELDS = "id,optimization_goal,promoted_object,updated_time";
const CAMPAIGN_FIELDS = "id,objective,updated_time";
const PAGINATION = {
  complete: true,
  termination: "natural_end",
  pageCount: 1,
};
const UPDATED_TIME = "2026-09-01T00:00:00+0000";

async function seed() {
  const sql = getDb();
  const [owner] = await sql<{ id: string }>`
    INSERT INTO users (name, email, password_hash)
    VALUES ('Config field removal seam', ${OWNER_EMAIL}, 'unused')
    RETURNING id
  `;
  if (!owner?.id) throw new Error("Could not create the seam owner.");
  const [business] = await sql<{ id: string }>`
    INSERT INTO businesses (name, owner_id)
    VALUES ('Config field removal seam', ${owner.id})
    RETURNING id
  `;
  if (!business?.id) throw new Error("Could not create the seam business.");
  businessId = business.id;
  const [account] = await sql<{ id: string }>`
    INSERT INTO provider_accounts (provider, external_account_id, account_name)
    VALUES ('meta', ${ACCOUNT_ID}, 'Config field removal seam')
    RETURNING id
  `;
  if (!account?.id) throw new Error("Could not create the seam account.");
  accountRefId = account.id;
  await sql`
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (${businessId}, 'meta', ${account.id}, ${ACCOUNT_ID})
  `;

  /* One spending ad-day: the scope both contracts resolve against. */
  await sql`
    INSERT INTO meta_ad_daily (
      business_id, business_ref_id, provider_account_id, provider_account_ref_id,
      date, ad_id, campaign_id, adset_id, account_timezone, account_currency,
      spend, truth_state, validation_status
    ) VALUES (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_removal_1', ${CAMPAIGN}, ${ADSET}, ${TZ}, 'USD',
      10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_rival_1', ${CAMPAIGN}, ${RIVAL_ADSET}, ${TZ}, 'USD',
      10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${TZ_DAY}::date, 'ad_tz_1', ${TZ_CAMPAIGN}, 'as_tz_1', ${TZ_NAME}, 'USD',
      10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_multi_1', ${MULTI_CAMPAIGN}, 'as_multi_1', ${TZ}, 'USD',
      10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_badpages_1', ${BADPAGES_CAMPAIGN}, 'as_badpages_1', ${TZ}, 'USD',
      10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_mask_1', ${MASK_CAMPAIGN}, 'as_mask_1', ${TZ}, 'USD',
      10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_tie_1', ${TIE_CAMPAIGN}, 'as_tie_1', ${TZ}, 'USD',
      10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_paged_1', ${PAGED_CAMPAIGN}, ${PAGED_ADSET}, ${TZ}, 'USD',
      10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_paged_lone_1', ${PAGED_LONE_CAMPAIGN}, 'as_paged_lone_1',
      ${TZ}, 'USD', 10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_straddle_1', ${STRADDLE_CAMPAIGN}, 'as_straddle_1',
      ${TZ}, 'USD', 10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_mismatch_1', ${MISMATCH_CAMPAIGN}, 'as_mismatch_1',
      ${TZ}, 'USD', 10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_baredate_1', ${BAREDATE_CAMPAIGN}, 'as_baredate_1',
      ${TZ}, 'USD', 10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_reversed_1', ${REVERSED_CAMPAIGN}, 'as_reversed_1',
      ${TZ}, 'USD', 10, 'finalized', 'passed'
    ), (
      ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
      ${DAY}::date, 'ad_halfwindow_1', ${HALFWINDOW_CAMPAIGN}, 'as_halfwindow_1',
      ${TZ}, 'USD', 10, 'finalized', 'passed'
    )
  `;

  /*
    A contemporaneous typed witness for the masking case: a creative-day row
    written and last touched inside the provider-local day, carrying the OLD
    objective. It must not heal the absence the 18:00 receipt reports.
  */
  await sql`
    INSERT INTO meta_creative_daily (
      business_id, provider_account_id, campaign_id, date, creative_id,
      objective, spend, created_at, updated_at, account_timezone, account_currency,
      payload_json
    ) VALUES (
      ${businessId}, ${ACCOUNT_ID}, ${MASK_CAMPAIGN}, ${DAY}::date, 'cr_mask_1',
      'OBJ_WITNESS', 5, ${`${DAY}T09:00:00Z`}::timestamptz,
      ${`${DAY}T09:30:00Z`}::timestamptz, ${TZ}, 'USD',
      ${JSON.stringify({ real_ad_id: "ad_mask_1", associated_ads_count: 1 })}::jsonb
    )
  `;

  /*
    Four receipts across one provider-local day. The field is present, then a
    receipt comes back WITHOUT it (the removal), then it is restored, and a
    next-day receipt corroborates. Every receipt requests the same fields, so the
    only thing that changes is whether the provider supplied a value.
  */
  const receipts: Array<{
    at: string;
    endpoint: "adset_configs" | "campaign_configs";
    payload: unknown;
    /** Pages in the merged response; null means the field is absent entirely. */
    pages?: number | null;
    /**
     * When the fetch actually ran: first request out, last response in. Written
     * into `pagination` exactly as `lib/api/meta.ts` writes it. Omitted on every
     * pre-existing fixture on purpose — that is what a receipt captured before
     * this metadata existed looks like, and those must keep today's treatment.
     */
    paging?: { startedAt?: string; completedAt?: string };
    /**
     * Write a MODERN observation: a run id plus a per-entity page clock. Used by
     * the tie case, where two observations share an instant and the ordering has
     * to prefer the stronger clock deterministically.
     */
    modernEntityClock?: Record<string, string>;
  }> = [
    /*
      TWO RECEIPTS AT THE SAME INSTANT, same campaign, same provider-local day,
      naming DIFFERENT objectives. One is modern (its own per-entity page clock),
      one is legacy. Before the ordering had a final tie-break, PostgreSQL was
      free to return either, so the same query could answer differently across
      plans and runs.
    */
    {
      at: `${DAY}T11:00:00Z`,
      endpoint: "campaign_configs",
      payload: [
        { id: TIE_CAMPAIGN, objective: "OBJ_LEGACY", updated_time: UPDATED_TIME },
      ],
    },
    {
      at: `${DAY}T11:00:00Z`,
      endpoint: "campaign_configs",
      payload: [
        { id: TIE_CAMPAIGN, objective: "OBJ_MODERN", updated_time: UPDATED_TIME },
      ],
      modernEntityClock: { [TIE_CAMPAIGN]: `${DAY}T11:00:00Z` },
    },
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "adset_configs",
      payload: [
        {
          id: ADSET,
          optimization_goal: "OFFSITE_CONVERSIONS",
          updated_time: UPDATED_TIME,
          promoted_object: { custom_event_type: "PURCHASE" },
        },
      ],
    },
    {
      /* REMOVAL: same ad set, no promoted_object at all. */
      at: `${DAY}T18:00:00Z`,
      endpoint: "adset_configs",
      payload: [
        {
          id: ADSET,
          optimization_goal: "OFFSITE_CONVERSIONS",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      /* RESTORE. */
      at: `${DAY}T20:00:00Z`,
      endpoint: "adset_configs",
      payload: [
        {
          id: ADSET,
          optimization_goal: "OFFSITE_CONVERSIONS",
          updated_time: UPDATED_TIME,
          promoted_object: { custom_event_type: "PURCHASE" },
        },
      ],
    },
    /* The ad-set grain of the same multi-page case. */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "adset_configs",
      pages: 3,
      payload: [
        {
          id: MULTI_ADSET,
          optimization_goal: "GOAL_MULTI",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      at: "2026-09-16T04:00:00Z",
      endpoint: "adset_configs",
      pages: 3,
      payload: [
        {
          id: MULTI_ADSET,
          optimization_goal: "GOAL_MULTI",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      /* Next-day corroboration for the goal, which never changed. */
      at: "2026-09-16T04:00:00Z",
      endpoint: "adset_configs",
      payload: [
        {
          id: ADSET,
          optimization_goal: "OFFSITE_CONVERSIONS",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    /*
      COMPETING SNAPSHOTS, for the rival ad set. Snapshot A is observed three
      times (10:00, 14:00, 18:00) and a DIFFERENT snapshot B once, at 12:00, with
      a different value. At a 15:00 cutoff the right answer is A's 14:00 sighting.
      A compression that kept only each snapshot's first and last observation
      would drop A@14:00, leaving A@10:00 against B@12:00 — and B would win.
    */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "adset_configs",
      payload: [
        {
          id: RIVAL_ADSET,
          optimization_goal: "GOAL_A",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      at: `${DAY}T12:00:00Z`,
      endpoint: "adset_configs",
      payload: [
        {
          id: RIVAL_ADSET,
          optimization_goal: "GOAL_B_RIVAL",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      /* Same snapshot content as the 10:00 one, observed again at 14:00: this is
         the sighting a first/last compression loses. */
      at: `${DAY}T14:00:00Z`,
      endpoint: "adset_configs",
      payload: [
        {
          id: RIVAL_ADSET,
          optimization_goal: "GOAL_A",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      at: `${DAY}T18:00:00Z`,
      endpoint: "adset_configs",
      payload: [
        {
          id: RIVAL_ADSET,
          optimization_goal: "GOAL_A_LATE",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "campaign_configs",
      payload: [
        { id: CAMPAIGN, objective: "OUTCOME_SALES", updated_time: UPDATED_TIME },
      ],
    },
    /*
      LOCAL-DAY BOUNDARY, on a UTC+3 account. Istanbul's 2026-09-15 ends at
      2026-09-15T21:00Z, so these four sightings straddle it inside ONE UTC day:
      01:00 belongs to the 15th locally, and 21:30, 22:00 and 23:00 to the 16th.
      The corroboration for the 15th is therefore the FIRST sighting after
      21:00Z — snapshot A at 21:30 — and it agrees, so the day brackets.

      A compression that bucketed by the UTC date would keep only this UTC day's
      first and last (01:00 and 23:00), drop 21:30, and let the rival at 22:00
      become the first-after. That rival disagrees, so the day would stop
      bracketing. The assertion below is what makes that regression visible.
    */
    {
      at: "2026-09-15T01:00:00Z",
      endpoint: "campaign_configs",
      payload: [
        { id: TZ_CAMPAIGN, objective: "OBJ_A", updated_time: UPDATED_TIME },
      ],
    },
    {
      at: "2026-09-15T21:30:00Z",
      endpoint: "campaign_configs",
      payload: [
        { id: TZ_CAMPAIGN, objective: "OBJ_A", updated_time: UPDATED_TIME },
      ],
    },
    {
      /* The rival, observed between A's two surviving ends under a UTC bucket. */
      at: "2026-09-15T22:00:00Z",
      endpoint: "campaign_configs",
      payload: [
        { id: TZ_CAMPAIGN, objective: "OBJ_RIVAL", updated_time: UPDATED_TIME },
      ],
    },
    {
      at: "2026-09-15T23:00:00Z",
      endpoint: "campaign_configs",
      payload: [
        { id: TZ_CAMPAIGN, objective: "OBJ_A", updated_time: UPDATED_TIME },
      ],
    },
    /*
      MULTI-PAGE LEGACY. Two receipts that would bracket the day under any
      single-page reading: same value, same provider clock, one inside the day and
      one the next morning. They span several pages and carry no per-entity clock,
      so nothing says which page held this campaign — the value is real, the
      TIMING is not knowable, and the day must not bracket on them.
    */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "campaign_configs",
      pages: 3,
      payload: [
        { id: MULTI_CAMPAIGN, objective: "OBJ_MULTI", updated_time: UPDATED_TIME },
      ],
    },
    {
      at: "2026-09-16T04:00:00Z",
      endpoint: "campaign_configs",
      pages: 3,
      payload: [
        { id: MULTI_CAMPAIGN, objective: "OBJ_MULTI", updated_time: UPDATED_TIME },
      ],
    },
    /*
      ── MULTI-PAGE, WITH THE FETCH WINDOW RECORDED ─────────────────────────────

      Everything below is the MULTI fixture again, three pages and no per-entity
      clock, plus `startedAt` / `completedAt`. The account is UTC, so a local day
      is a UTC day and the arithmetic is readable by eye.

      PROVEN AT BOTH ENDS. The 15th's fetch ran 09:58 to 10:00 and the 16th's
      03:58 to 04:00, each inside its own local day. Nothing about the page count
      changed; what changed is that the straddled-midnight hazard is now measured
      and absent, so the day brackets.
    */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "campaign_configs",
      pages: 3,
      paging: {
        startedAt: `${DAY}T09:58:00Z`,
        completedAt: `${DAY}T10:00:00Z`,
      },
      payload: [
        { id: PAGED_CAMPAIGN, objective: "OBJ_PAGED", updated_time: UPDATED_TIME },
      ],
    },
    {
      at: "2026-09-16T04:00:00Z",
      endpoint: "campaign_configs",
      pages: 3,
      paging: {
        startedAt: "2026-09-16T03:58:00Z",
        completedAt: "2026-09-16T04:00:00Z",
      },
      payload: [
        { id: PAGED_CAMPAIGN, objective: "OBJ_PAGED", updated_time: UPDATED_TIME },
      ],
    },
    /* The ad-set grain of the same proof. */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "adset_configs",
      pages: 3,
      paging: {
        startedAt: `${DAY}T09:58:00Z`,
        completedAt: `${DAY}T10:00:00Z`,
      },
      payload: [
        { id: PAGED_ADSET, optimization_goal: "GOAL_PAGED", updated_time: UPDATED_TIME },
      ],
    },
    {
      at: "2026-09-16T04:00:00Z",
      endpoint: "adset_configs",
      pages: 3,
      paging: {
        startedAt: "2026-09-16T03:58:00Z",
        completedAt: "2026-09-16T04:00:00Z",
      },
      payload: [
        { id: PAGED_ADSET, optimization_goal: "GOAL_PAGED", updated_time: UPDATED_TIME },
      ],
    },
    /*
      PROVEN, AND ALONE. One receipt, no corroboration, ever. Read past the
      corroboration horizon this is the case the new tier exists to name: the day
      is proven and the bracket is genuinely absent, so it must report the proof
      under its own name rather than as one page or as uncertain.
    */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "campaign_configs",
      pages: 3,
      paging: {
        startedAt: `${DAY}T09:58:00Z`,
        completedAt: `${DAY}T10:00:00Z`,
      },
      payload: [
        {
          id: PAGED_LONE_CAMPAIGN,
          objective: "OBJ_PAGED_LONE",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    /*
      THE HAZARD ITSELF. The fetch began at 23:55 on the 14th and finished at
      00:05 on the 15th, so a row on page 1 and a row on page 9 belong to
      DIFFERENT local days and nothing says which page held this one. Its
      corroboration is proven, so the ONLY thing refusing the bracket is the
      straddling end — which is exactly the claim under test.
    */
    {
      at: `${DAY}T00:05:00Z`,
      endpoint: "campaign_configs",
      pages: 3,
      paging: {
        startedAt: "2026-09-14T23:55:00Z",
        completedAt: `${DAY}T00:05:00Z`,
      },
      payload: [
        {
          id: STRADDLE_CAMPAIGN,
          objective: "OBJ_STRADDLE",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      at: "2026-09-16T04:00:00Z",
      endpoint: "campaign_configs",
      pages: 3,
      paging: {
        startedAt: "2026-09-16T03:58:00Z",
        completedAt: "2026-09-16T04:00:00Z",
      },
      payload: [
        {
          id: STRADDLE_CAMPAIGN,
          objective: "OBJ_STRADDLE",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    /*
      TIMINGS FROM SOMEWHERE ELSE. Both ends sit on the 14th while the sighting
      they are attached to is on the 15th. Reading only start-against-end would
      call this proven — one local date, window forwards — and date the row to a
      day it was not observed on. The row's own clock has to agree.
    */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "campaign_configs",
      pages: 3,
      paging: {
        startedAt: "2026-09-14T22:00:00Z",
        completedAt: "2026-09-14T22:05:00Z",
      },
      payload: [
        {
          id: MISMATCH_CAMPAIGN,
          objective: "OBJ_MISMATCH",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      at: "2026-09-16T04:00:00Z",
      endpoint: "campaign_configs",
      pages: 3,
      paging: {
        startedAt: "2026-09-16T03:58:00Z",
        completedAt: "2026-09-16T04:00:00Z",
      },
      payload: [
        {
          id: MISMATCH_CAMPAIGN,
          objective: "OBJ_MISMATCH",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    /*
      HALF A WINDOW. The end was recorded and the start never was — the shape a
      writer produces when it projects one field and forgets the other. One
      instant describes no interval, and nothing can rescue this one: no cast, no
      timezone, no default. This is the case that pins the presence test itself.
    */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "campaign_configs",
      pages: 3,
      paging: { completedAt: `${DAY}T10:00:00Z` },
      payload: [
        {
          id: HALFWINDOW_CAMPAIGN,
          objective: "OBJ_HALFWINDOW",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      at: "2026-09-16T04:00:00Z",
      endpoint: "campaign_configs",
      pages: 3,
      paging: {
        startedAt: "2026-09-16T03:58:00Z",
        completedAt: "2026-09-16T04:00:00Z",
      },
      payload: [
        {
          id: HALFWINDOW_CAMPAIGN,
          objective: "OBJ_HALFWINDOW",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    /*
      A START THAT LOST ITS TIME. '2026-09-15' is accepted by PostgreSQL and
      becomes local midnight, which would put it on the same local date as the
      end and answer the question by construction. A date is not an instant.
    */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "campaign_configs",
      pages: 3,
      paging: { startedAt: DAY, completedAt: `${DAY}T10:00:00Z` },
      payload: [
        {
          id: BAREDATE_CAMPAIGN,
          objective: "OBJ_BAREDATE",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      at: "2026-09-16T04:00:00Z",
      endpoint: "campaign_configs",
      pages: 3,
      paging: {
        startedAt: "2026-09-16T03:58:00Z",
        completedAt: "2026-09-16T04:00:00Z",
      },
      payload: [
        {
          id: BAREDATE_CAMPAIGN,
          objective: "OBJ_BAREDATE",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    /*
      A WINDOW THAT RUNS BACKWARDS. Same local date at both ends and the same
      date as the sighting, so every date test passes; the pair still describes
      no interval. Without the ordering check this would read as proven.
    */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "campaign_configs",
      pages: 3,
      paging: {
        startedAt: `${DAY}T10:00:00Z`,
        completedAt: `${DAY}T09:58:00Z`,
      },
      payload: [
        {
          id: REVERSED_CAMPAIGN,
          objective: "OBJ_REVERSED",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    {
      at: "2026-09-16T04:00:00Z",
      endpoint: "campaign_configs",
      pages: 3,
      paging: {
        startedAt: "2026-09-16T03:58:00Z",
        completedAt: "2026-09-16T04:00:00Z",
      },
      payload: [
        {
          id: REVERSED_CAMPAIGN,
          objective: "OBJ_REVERSED",
          updated_time: UPDATED_TIME,
        },
      ],
    },
    /*
      MALFORMED pageCount. Absent or unparseable, so nothing PROVES this was a
      single page — and an unproven single page must be treated as multi-page,
      not as one. Both receipts otherwise look bracketable.
    */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "campaign_configs",
      pages: null,
      payload: [
        { id: BADPAGES_CAMPAIGN, objective: "OBJ_BAD", updated_time: UPDATED_TIME },
      ],
    },
    {
      at: "2026-09-16T04:00:00Z",
      endpoint: "campaign_configs",
      pages: null,
      payload: [
        { id: BADPAGES_CAMPAIGN, objective: "OBJ_BAD", updated_time: UPDATED_TIME },
      ],
    },
    /*
      MASKING. The 10:00 receipt carries the objective; the 18:00 one requests it
      and comes back WITHOUT it. A contemporaneous typed witness holds the old
      value for the same day. The absence must win: a provider saying "there is
      none" cannot be overwritten by a derived daily value from before it.
    */
    {
      at: `${DAY}T10:00:00Z`,
      endpoint: "campaign_configs",
      payload: [
        { id: MASK_CAMPAIGN, objective: "OBJ_MASK", updated_time: UPDATED_TIME },
      ],
    },
    {
      at: `${DAY}T18:00:00Z`,
      endpoint: "campaign_configs",
      payload: [{ id: MASK_CAMPAIGN, updated_time: UPDATED_TIME }],
    },
    {
      /* REMOVAL of objective. */
      at: `${DAY}T18:00:00Z`,
      endpoint: "campaign_configs",
      payload: [{ id: CAMPAIGN, updated_time: UPDATED_TIME }],
    },
    {
      /* RESTORE. */
      at: `${DAY}T20:00:00Z`,
      endpoint: "campaign_configs",
      payload: [
        { id: CAMPAIGN, objective: "OUTCOME_SALES", updated_time: UPDATED_TIME },
      ],
    },
  ];

  for (const [index, receipt] of receipts.entries()) {
    const scope = receipt.endpoint === "adset_configs" ? "adset" : "campaign";
    const fields =
      receipt.endpoint === "adset_configs" ? ADSET_FIELDS : CAMPAIGN_FIELDS;
    const context: Record<string, unknown> = {
      fields,
      source: "seam",
      pagination:
        receipt.pages === null
          ? { complete: true, termination: "natural_end", ...receipt.paging }
          : {
              ...PAGINATION,
              pageCount: receipt.pages ?? 1,
              ...receipt.paging,
            },
    };
    if (receipt.modernEntityClock) {
      context.rowObservedAtByEntityId = receipt.modernEntityClock;
    }
    const [snapshot] = await sql<{ id: string }>`
      INSERT INTO meta_raw_snapshots (
        business_id, business_ref_id, provider_account_id, provider_account_ref_id,
        endpoint_name, entity_scope, status, provider_http_status,
        start_date, end_date, payload_hash, request_context, payload_json, fetched_at
      ) VALUES (
        ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID}, ${accountRefId}::uuid,
        ${receipt.endpoint}, ${scope}, 'fetched', 200,
        ${DAY}::date, ${DAY}::date, ${`seam-${index}`},
        ${JSON.stringify(context)}::jsonb, ${JSON.stringify(receipt.payload)}::jsonb,
        ${receipt.at}::timestamptz
      ) RETURNING id
    `;
    if (!snapshot?.id) throw new Error("Could not create a seam snapshot.");
    /*
      A legacy-shaped observation: single page, no run id and no per-entity clock
      map, which is what every config observation on production actually looks
      like. Its own observed_at is therefore the row's page time.
    */
    await sql`
      INSERT INTO meta_raw_snapshot_observations (
        snapshot_id, business_id, provider_account_id, endpoint_name, entity_scope,
        status, provider_http_status, request_context, observed_at, run_id
      ) VALUES (
        ${snapshot.id}::uuid, ${businessId}, ${ACCOUNT_ID}, ${receipt.endpoint},
        ${scope}, 'fetched', 200, ${JSON.stringify(context)}::jsonb,
        ${receipt.at}::timestamptz,
        ${receipt.modernEntityClock ? "00000000-0000-4000-8000-0000000009e1" : null}
      )
    `;
  }
}

const adsetContract = buildMetaAdsetConfigFieldSourceSql({
  dayExpression: "d.date",
  timezoneExpression: "d.account_timezone",
  businessParam: "$1",
  scopeStartParam: "$2",
  scopeEndParam: "$3",
  evaluationCutoffParam: "$4",
  accountExpression: "d.provider_account_id",
  adsetExpression: "d.adset_id",
  adsetScopeSql: "SELECT DISTINCT adset_id FROM scope",
  scopeRelationSql:
    "SELECT provider_account_id, adset_id, date, account_timezone FROM scope",
  /* These cases assert the restated diagnostic itself. */
  includeRestated: true,
});

const campaignContract = buildMetaConfigFieldSourceSql({
  dayExpression: "d.date",
  timezoneExpression: "d.account_timezone",
  businessParam: "$1",
  scopeStartParam: "$2",
  scopeEndParam: "$3",
  evaluationCutoffParam: "$4",
  accountExpression: "d.provider_account_id",
  campaignExpression: "d.campaign_id",
  campaignScopeSql: "SELECT DISTINCT campaign_id FROM scope",
  scopeRelationSql:
    "SELECT provider_account_id, campaign_id, date, account_timezone FROM scope",
  /* These cases assert the restated diagnostic itself. */
  includeRestated: true,
});

const ADSET_QUERY = `WITH scope AS (
  SELECT DISTINCT provider_account_id, adset_id, date, account_timezone
  FROM meta_ad_daily
  WHERE business_id = $1 AND date BETWEEN $2::date AND $3::date AND spend > 0
    AND adset_id = '${ADSET}'
),
${adsetContract.withSql}
SELECT
  ${adsetContract.valueSql("custom_event_type")} AS as_of_event,
  ${adsetContract.restatedValueSql("custom_event_type")} AS restated_event,
  ${adsetContract.tierSql("custom_event_type")} AS event_tier,
  ${adsetContract.readinessSql("custom_event_type")} AS event_readiness,
  ${adsetContract.valueSql("optimization_goal")} AS as_of_goal,
  ${adsetContract.tierSql("optimization_goal")} AS goal_tier
FROM scope d${adsetContract.lateralSql}`;

const TIE_QUERY = `WITH scope AS (
  SELECT DISTINCT provider_account_id, campaign_id, date, account_timezone
  FROM meta_ad_daily
  WHERE business_id = $1 AND date BETWEEN $2::date AND $3::date AND spend > 0
    AND campaign_id = '${TIE_CAMPAIGN}'
),
${campaignContract.withSql}
SELECT
  ${campaignContract.valueSql("objective")} AS as_of_objective,
  ${campaignContract.tierSql("objective")} AS tier
FROM scope d${campaignContract.lateralSql}`;

const CAMPAIGN_QUERY = `WITH scope AS (
  SELECT DISTINCT provider_account_id, campaign_id, date, account_timezone
  FROM meta_ad_daily
  WHERE business_id = $1 AND date BETWEEN $2::date AND $3::date AND spend > 0
    AND campaign_id = '${CAMPAIGN}'
),
${campaignContract.withSql}
SELECT
  ${campaignContract.valueSql("objective")} AS as_of_objective,
  ${campaignContract.restatedValueSql("objective")} AS restated_objective,
  ${campaignContract.tierSql("objective")} AS tier,
  ${campaignContract.readinessSql("objective")} AS readiness
FROM scope d${campaignContract.lateralSql}`;

/** The same ad-set contract, read for the rival ad set only. */
const RIVAL_QUERY = `WITH scope AS (
  SELECT DISTINCT provider_account_id, adset_id, date, account_timezone
  FROM meta_ad_daily
  WHERE business_id = $1 AND date BETWEEN $2::date AND $3::date AND spend > 0
    AND adset_id = '${RIVAL_ADSET}'
),
${adsetContract.withSql}
SELECT
  ${adsetContract.valueSql("optimization_goal")} AS as_of_goal,
  ${adsetContract.restatedValueSql("optimization_goal")} AS restated_goal,
  ${adsetContract.tierSql("optimization_goal")} AS goal_tier
FROM scope d${adsetContract.lateralSql}`;

/** The campaign contract, read for the UTC+3 campaign only. */
const TZ_QUERY = `WITH scope AS (
  SELECT DISTINCT provider_account_id, campaign_id, date, account_timezone
  FROM meta_ad_daily
  WHERE business_id = $1 AND date BETWEEN $2::date AND $3::date AND spend > 0
    AND campaign_id = '${TZ_CAMPAIGN}'
),
${campaignContract.withSql}
SELECT
  ${campaignContract.valueSql("objective")} AS as_of_objective,
  ${campaignContract.tierSql("objective")} AS tier
FROM scope d${campaignContract.lateralSql}`;

/** The campaign contract, read for the multi-page campaign only. */
const MULTI_QUERY = `WITH scope AS (
  SELECT DISTINCT provider_account_id, campaign_id, date, account_timezone
  FROM meta_ad_daily
  WHERE business_id = $1 AND date BETWEEN $2::date AND $3::date AND spend > 0
    AND campaign_id = '${MULTI_CAMPAIGN}'
),
${campaignContract.withSql}
SELECT
  ${campaignContract.valueSql("objective")} AS as_of_objective,
  ${campaignContract.tierSql("objective")} AS tier,
  ${campaignContract.readinessSql("objective")} AS readiness,
  ${campaignContract.sourceClassSql("objective")} AS source_class
FROM scope d${campaignContract.lateralSql}`;

/** The ad-set contract, read for the multi-page ad set only. */
const MULTI_ADSET_QUERY = `WITH scope AS (
  SELECT DISTINCT provider_account_id, adset_id, date, account_timezone
  FROM meta_ad_daily
  WHERE business_id = $1 AND date BETWEEN $2::date AND $3::date AND spend > 0
    AND adset_id = '${MULTI_ADSET}'
),
${adsetContract.withSql}
SELECT
  ${adsetContract.valueSql("optimization_goal")} AS as_of_goal,
  ${adsetContract.tierSql("optimization_goal")} AS tier,
  ${adsetContract.readinessSql("optimization_goal")} AS readiness,
  ${adsetContract.sourceClassSql("optimization_goal")} AS source_class
FROM scope d${adsetContract.lateralSql}`;

/** The campaign contract, read for the malformed-pagination campaign only. */
const BADPAGES_QUERY = MULTI_QUERY.replace(MULTI_CAMPAIGN, BADPAGES_CAMPAIGN);
/*
  One query per fetch-window case, all the same shape as MULTI_QUERY so the only
  variable between them is the fixture's pagination metadata.
*/
const pagedQuery = (campaignId: string) =>
  MULTI_QUERY.replace(MULTI_CAMPAIGN, campaignId);
const PAGED_MISSING_TZ_QUERY = pagedQuery(PAGED_CAMPAIGN).replace(
  "SELECT DISTINCT provider_account_id, campaign_id, date, account_timezone",
  "SELECT DISTINCT provider_account_id, campaign_id, date, NULL::text AS account_timezone",
);
const PAGED_ADSET_QUERY = MULTI_ADSET_QUERY.replace(MULTI_ADSET, PAGED_ADSET);
const MASK_QUERY = `WITH scope AS (
  SELECT DISTINCT provider_account_id, campaign_id, date, account_timezone
  FROM meta_ad_daily
  WHERE business_id = $1 AND date BETWEEN $2::date AND $3::date AND spend > 0
    AND campaign_id = '${MASK_CAMPAIGN}'
),
${campaignContract.withSql}
SELECT
  ${campaignContract.valueSql("objective")} AS as_of_objective,
  ${campaignContract.restatedValueSql("objective")} AS restated_objective,
  ${campaignContract.tierSql("objective")} AS tier,
  ${campaignContract.readinessSql("objective")} AS readiness
FROM scope d${campaignContract.lateralSql}`;

const at = async (query: string, cutoff: string) => {
  const rows = (await getDb().query(query, [
    businessId,
    DAY,
    DAY,
    cutoff,
  ])) as Record<string, string | null>[];
  expect(rows, `one scope row expected at ${cutoff}`).toHaveLength(1);
  return rows[0] as Record<string, string | null>;
};

describe.skipIf(!SEAM)(
  "config-field source contract: removal and restore (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      await seed();
    });

    it("ad-set: a receipt without the field ENDS the value, it does not keep it", async () => {
      /* Before the removal the value is there. */
      const before = await at(ADSET_QUERY, `${DAY}T12:00:00Z`);
      expect(before.as_of_event).toBe("PURCHASE");

      /* After it, the provider has spoken and there is none. */
      const after = await at(ADSET_QUERY, `${DAY}T19:00:00Z`);
      expect(after.as_of_event).toBeNull();
      expect(after.event_tier).toBe("observed_absent");
      expect(after.event_readiness).toBe("none");
    });

    it("ad-set: as-of and restated DIVERGE between the removal and the restore", async () => {
      /*
        The whole point of two answers. At 19:00 the run could only know the
        removal; today's warehouse also holds the 20:00 restore.
      */
      const mid = await at(ADSET_QUERY, `${DAY}T19:00:00Z`);
      expect(mid.as_of_event).toBeNull();
      expect(mid.restated_event).toBe("PURCHASE");
    });

    it("ad-set: the restore brings the value back", async () => {
      const after = await at(ADSET_QUERY, "2026-09-17T00:00:00Z");
      expect(after.as_of_event).toBe("PURCHASE");
      expect(after.restated_event).toBe("PURCHASE");
    });

    it("ad-set: a field that never changed still brackets across the same receipts", async () => {
      /* optimization_goal is present in all four, with one unmoved clock, so the
         next-day corroboration brackets the day even while the sibling field was
         removed and restored. */
      const after = await at(ADSET_QUERY, "2026-09-17T00:00:00Z");
      expect(after.as_of_goal).toBe("OFFSITE_CONVERSIONS");
      expect(after.goal_tier).toBe("provider_receipt_legacy_bracketed");
    });

    it("picks the latest sighting BEFORE the cutoff, across competing snapshots", async () => {
      /*
        The acceptance gate for any future compression of the observation
        timeline. Sightings at 10:00, 12:00 (a different snapshot), 14:00 and
        18:00; cutoff 15:00. The answer must come from 14:00.

        Keeping only each snapshot's first and last observation would drop the
        14:00 sighting and let the 12:00 rival win — which is why first/last is
        not a sound reduction, and why this case exists before one is attempted.
      */
      const rows = (await getDb().query(RIVAL_QUERY, [
        businessId,
        DAY,
        DAY,
        `${DAY}T15:00:00Z`,
      ])) as Record<string, string | null>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.as_of_goal).toBe("GOAL_A");
      /* Not the rival observed earlier, and not the sighting after the cutoff. */
      expect(rows[0]?.as_of_goal).not.toBe("GOAL_B_RIVAL");
      expect(rows[0]?.as_of_goal).not.toBe("GOAL_A_LATE");
      /* The diagnostic ignores the cutoff and takes the day's last sighting. */
      expect(rows[0]?.restated_goal).toBe("GOAL_A_LATE");
    });

    it("brackets across a LOCAL day boundary that a UTC bucket would cut", async () => {
      /*
        The acceptance gate for any campaign-side compression. On a UTC+3 account
        the corroboration for the 15th is the 21:30Z sighting, which sits in the
        same UTC day as the 01:00Z one. A UTC-keyed bucket drops it and lets the
        22:00Z rival answer instead, which disagrees and un-brackets the day.
      */
      const rows = (await getDb().query(TZ_QUERY, [
        businessId,
        TZ_DAY,
        TZ_DAY,
        "2026-09-16T12:00:00Z",
      ])) as Record<string, string | null>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.as_of_objective).toBe("OBJ_A");
      expect(rows[0]?.tier).toBe("provider_receipt_legacy_bracketed");
    });

    it("reports a multi-page legacy receipt as interval-uncertain, never authority", async () => {
      /*
        Both receipts agree on value and on the provider clock, and one sits after
        the day's end — everything a bracket needs except a knowable page time.
        Granting authority here would mean inventing the observation instant, which
        is the one thing this tier exists to refuse. The value is still reported,
        so an account whose payload we hold is not zeroed out.
      */
      const rows = (await getDb().query(MULTI_QUERY, [
        businessId,
        DAY,
        DAY,
        "2026-09-17T00:00:00Z",
      ])) as Record<string, string | null>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.as_of_objective).toBe("OBJ_MULTI");
      expect(rows[0]?.tier).toBe("provider_receipt_legacy_interval_uncertain");
      expect(rows[0]?.readiness).toBe("review_only");
      expect(rows[0]?.source_class).toBe("legacy_multi_page");
    });

    it("ad-set: a multi-page legacy receipt is kept but never authoritative", async () => {
      /*
        The ad-set grain of the same refusal. The receipts agree on value and
        clock and straddle the day's end, so anything that ignored page count
        would bracket. The value survives; the authority does not.
      */
      const rows = (await getDb().query(MULTI_ADSET_QUERY, [
        businessId,
        DAY,
        DAY,
        "2026-09-17T00:00:00Z",
      ])) as Record<string, string | null>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.as_of_goal).toBe("GOAL_MULTI");
      expect(rows[0]?.tier).toBe("provider_receipt_legacy_interval_uncertain");
      expect(rows[0]?.readiness).toBe("review_only");
      expect(rows[0]?.source_class).toBe("legacy_multi_page");
    });

    /*
      ── THE FETCH WINDOW, READ BY REAL POSTGRESQL ────────────────────────────

      Every case below shares the MULTI fixture's shape — three pages, no run id,
      no per-entity clock — and differs only in `pagination.startedAt` /
      `completedAt`. The two cases directly above are the control: with no window
      recorded at all they stay interval-uncertain, which is what every receipt
      written before this metadata existed must keep doing.
    */
    const windowCase = async (
      campaignId: string,
      cutoff: string,
    ): Promise<Record<string, string | null>> => {
      const rows = (await getDb().query(pagedQuery(campaignId), [
        businessId,
        DAY,
        DAY,
        cutoff,
      ])) as Record<string, string | null>[];
      expect(rows, `one scope row expected for ${campaignId}`).toHaveLength(1);
      return rows[0] as Record<string, string | null>;
    };

    it("lets a multi-page receipt PROVEN inside the day bracket it", async () => {
      /*
        The positive half of the repair. This is the MULTI case with the fetch
        window recorded: same three pages, same agreeing value, same unmoved
        provider clock — and now the straddled-midnight hazard is measured and
        absent at both ends, so the bracket is real rather than invented.

        Without this, an account whose config list never fits on one page can
        never reach authority on any day, however good its evidence.
      */
      const row = await windowCase(PAGED_CAMPAIGN, "2026-09-17T00:00:00Z");
      expect(row.as_of_objective).toBe("OBJ_PAGED");
      expect(row.tier).toBe("provider_receipt_legacy_bracketed");
      expect(row.readiness).toBe("decision_authority");
      /* Still multi-page. The proof is about the interval, not the page count. */
      expect(row.source_class).toBe("legacy_multi_page");
    });

    it("withholds a timed receipt when its account timezone is missing", async () => {
      const rows = (await getDb().query(PAGED_MISSING_TZ_QUERY, [
        businessId,
        DAY,
        DAY,
        "2026-09-17T00:00:00Z",
      ])) as Record<string, string | null>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.as_of_objective).toBe("OBJ_PAGED");
      expect(rows[0]?.tier).toBe("unknown");
      expect(rows[0]?.readiness).toBe("none");
    });

    it("ad-set: the same proof brackets at ad-set grain", async () => {
      /* The two ladders drifted apart once already, so each one is driven. */
      const rows = (await getDb().query(PAGED_ADSET_QUERY, [
        businessId,
        DAY,
        DAY,
        "2026-09-17T00:00:00Z",
      ])) as Record<string, string | null>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.as_of_goal).toBe("GOAL_PAGED");
      expect(rows[0]?.tier).toBe("provider_receipt_legacy_bracketed");
      expect(rows[0]?.readiness).toBe("decision_authority");
      expect(rows[0]?.source_class).toBe("legacy_multi_page");
    });

    it("names a proven receipt that has no corroboration, and stops there", async () => {
      /*
        One receipt, never corroborated, read past the corroboration horizon so
        the pending tier cannot answer for it. The day is proven and the bracket
        is genuinely absent: it must say so under its own name, not claim one
        page it did not have and not claim an authority it did not earn.
      */
      const row = await windowCase(PAGED_LONE_CAMPAIGN, "2026-09-20T00:00:00Z");
      expect(row.as_of_objective).toBe("OBJ_PAGED_LONE");
      expect(row.tier).toBe("provider_receipt_legacy_paged_within_day");
      expect(row.readiness).toBe("review_only");
      expect(row.source_class).toBe("legacy_multi_page");
    });

    it("refuses a fetch that STRADDLED the provider-local midnight", async () => {
      /*
        The hazard the whole tier exists for, now visible instead of assumed. The
        corroborating end is proven, so if the straddling end were let through
        this would bracket — and would date a row to a day the fetch may not have
        been on. It stays uncertain.
      */
      const row = await windowCase(STRADDLE_CAMPAIGN, "2026-09-17T00:00:00Z");
      expect(row.as_of_objective).toBe("OBJ_STRADDLE");
      expect(row.tier).toBe("provider_receipt_legacy_interval_uncertain");
      expect(row.readiness).toBe("review_only");
    });

    it("refuses timings that do not agree with the sighting beside them", async () => {
      /*
        Both ends on the 14th, the observation on the 15th. Comparing start to
        end alone would call this proven; the row's own clock is the third date
        that has to agree, or a receipt could carry another fetch's window.
      */
      const row = await windowCase(MISMATCH_CAMPAIGN, "2026-09-17T00:00:00Z");
      expect(row.tier).toBe("provider_receipt_legacy_interval_uncertain");
    });

    it("refuses a window with only one end recorded", async () => {
      /*
        The end is there and the start never was. No cast, timezone or default
        can turn one instant into an interval, so this case cannot pass for any
        reason other than the presence test — which is what makes it the strict
        counterpart to the proven case above.
      */
      const row = await windowCase(HALFWINDOW_CAMPAIGN, "2026-09-17T00:00:00Z");
      expect(row.tier).toBe("provider_receipt_legacy_interval_uncertain");
    });

    it("refuses a start that is a DATE and not an instant", async () => {
      /*
        A page clock that lost its time is not a page clock: '2026-09-15' passes
        pg_input_is_valid and becomes midnight in whatever zone reads it.

        HONEST LIMIT OF THIS CASE. It pins the refusal, not the reason for it.
        A bare date is interpreted in the SERVER's TimeZone, so in a UTC+3
        session it also lands on the previous UTC date and the same-day test
        would refuse it even without the strict instant guard. The guard itself
        is pinned structurally instead, by the emitted-SQL assertion in
        config-field-source-contract.test.ts that the proof routes both timings
        through the shape check.
      */
      const row = await windowCase(BAREDATE_CAMPAIGN, "2026-09-17T00:00:00Z");
      expect(row.tier).toBe("provider_receipt_legacy_interval_uncertain");
    });

    it("refuses a window that runs backwards", async () => {
      /*
        Every date test passes here — one local date, matching the sighting — and
        the pair still describes no interval. The ordering check is what refuses
        it, and removing that check would make this case pass wrongly.
      */
      const row = await windowCase(REVERSED_CAMPAIGN, "2026-09-17T00:00:00Z");
      expect(row.tier).toBe("provider_receipt_legacy_interval_uncertain");
    });

    it("treats an UNPROVEN single page as multi-page, not as one", async () => {
      /*
        With pageCount absent, `pageCount = '1'` is NULL, not false. A guard
        written as `NOT COALESCE(flag, FALSE)` would then read true and hand this
        receipt the authority the multi-page tier exists to withhold. The flag is
        built with IS NOT TRUE so anything unproven falls to the safe side.
      */
      const rows = (await getDb().query(BADPAGES_QUERY, [
        businessId,
        DAY,
        DAY,
        "2026-09-17T00:00:00Z",
      ])) as Record<string, string | null>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.as_of_objective).toBe("OBJ_BAD");
      expect(rows[0]?.tier).toBe("provider_receipt_legacy_interval_uncertain");
      expect(rows[0]?.readiness).toBe("review_only");
    });

    it("does not let a typed witness heal an OBSERVED absence", async () => {
      /*
        Before the 18:00 receipt the value is there. After it the provider has
        said there is none, and the contemporaneous typed witness holding the old
        value must not overwrite that — in the as-of answer or the diagnostic.
      */
      const before = (await getDb().query(MASK_QUERY, [
        businessId,
        DAY,
        DAY,
        `${DAY}T12:00:00Z`,
      ])) as Record<string, string | null>[];
      expect(before[0]?.as_of_objective).toBe("OBJ_MASK");

      const after = (await getDb().query(MASK_QUERY, [
        businessId,
        DAY,
        DAY,
        `${DAY}T19:00:00Z`,
      ])) as Record<string, string | null>[];
      expect(after[0]?.as_of_objective).toBeNull();
      expect(after[0]?.tier).toBe("observed_absent");
      expect(after[0]?.readiness).toBe("none");
      /* And the witness does not leak into the diagnostic either. */
      expect(after[0]?.restated_objective).toBeNull();
    });

    it("campaign: the same removal, restore and divergence at campaign grain", async () => {
      const before = await at(CAMPAIGN_QUERY, `${DAY}T12:00:00Z`);
      expect(before.as_of_objective).toBe("OUTCOME_SALES");

      const mid = await at(CAMPAIGN_QUERY, `${DAY}T19:00:00Z`);
      expect(mid.as_of_objective).toBeNull();
      expect(mid.tier).toBe("observed_absent");
      expect(mid.readiness).toBe("none");
      /* Today's warehouse holds the restore. */
      expect(mid.restated_objective).toBe("OUTCOME_SALES");

      const after = await at(CAMPAIGN_QUERY, "2026-09-17T00:00:00Z");
      expect(after.as_of_objective).toBe("OUTCOME_SALES");
    });

    /*
      TWO ADMISSIBLE OBSERVATIONS AT ONE INSTANT, naming different objectives.

      Every DISTINCT ON in this contract ordered only by row_observed_at, with no
      final tie-break, so PostgreSQL was free to return either — the same query
      could answer differently across plans and runs. Non-determinism is bad on
      its own, and worse for anyone diffing this query against a rewrite: the
      flapping row looks like a defect in the rewrite.

      The ordering now ends on the stronger clock and then on identity. A modern
      receipt times the row itself, so at an equal instant it wins.
    */
    it("resolves two observations sharing an instant deterministically", async () => {
      const first = await at(TIE_QUERY, `${DAY}T23:00:00Z`);
      expect(first.as_of_objective).toBe("OBJ_MODERN");

      /*
        Repeated, because the defect was that the answer could VARY. One passing
        read proves nothing about a tie; the same answer every time does.
      */
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const again = await at(TIE_QUERY, `${DAY}T23:00:00Z`);
        expect(again.as_of_objective, `attempt ${attempt}`).toBe("OBJ_MODERN");
        expect(again.tier, `attempt ${attempt}`).toBe(first.tier);
      }
    });
  },
);
