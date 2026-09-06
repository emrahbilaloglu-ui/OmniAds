// Child of ephemeral-postgres-migrations-check. It runs only against the
// throwaway database URL force-set by the parent and never calls Meta.
//
// The chain this proves, end to end, from an ELIGIBLE DECISION rather than
// from a hand-written queue row or a finished intent:
//
//   creative decision (scale)
//     -> the brief a person reviewed  +  the draft they composed
//       -> a staged launch intent          (launch-intent-producer)
//         -> a `launch` queue row          (launch-proposal-producer)
//           -> the operator approves it    (the real proposals route)
//             -> ONE provider ad create, PAUSED
//               -> a `resume` queue row    (activation-proposal-producer)
//                 -> a separately authorized activation
//
// and then the same chain with NOBODY at the queue, which is the arm the
// producer used to refuse outright as `creative_mode_auto_operator_staging_required`:
//
//   creative mode `auto`  +  the account-bound scheduled authority
//     -> the producer stages under launchpad_decision_staged_v1
//       -> a `launch` queue row
//         -> runMetaBudgetAutomationSweepIfDue()  (no operator, no HTTP handler)
//           -> ONE provider ad create, PAUSED, journalled as launchpad_scheduled_v1
//              with no operator confirmation anywhere in the row
//   ... and the same again for a `refresh` decision, whose operator-composed
//   draft is a whole test launch: campaign + ad set + ad, every one PAUSED.
//
// Both arms then have to hold the line the authority was protecting: activation
// stays a separate approval, a family taken off `auto` mid-flight creates
// nothing and destroys nothing, a missing or revoked approval reaches the
// provider with zero writes, and a rerun duplicates neither an intent nor a
// provider entity.
//
// Nothing here mints a payload the production code should have produced. The
// intent is written by the shipped store through the shipped producer, the
// queue rows by the shipped projections, the attended provider legs by the
// shipped route handlers under a real session, and the unattended ones by the
// shipped sweep. This file seeds fixtures, replaces globalThis.fetch with a
// controlled provider, and reads the database back.
//
// The rerun legs are the ones that matter most: they run everything a SECOND
// time and assert that no second intent, no second queue row and no second
// provider entity exist. A producer that stages from a decision is exactly the
// kind that can create a duplicate ad every tick.
import { NextRequest } from "next/server";

import { createSession } from "@/lib/auth";
import { getDb, resetDbClientCache, runDbTransaction } from "@/lib/db";
import { verifyScheduledQueuePageFixtures } from "@/scripts/scheduled-queue-page-fixtures";
import { verifyNativeProposalLifecycleFixtures } from "@/scripts/native-proposal-lifecycle-fixtures";
import { verifyLaunchZeroWriteClaimFixtures } from "@/scripts/launch-zero-write-claim-fixtures";
import { verifyDailyBriefLedgerWindowFixtures } from "@/scripts/daily-brief-ledger-window-fixtures";
import {
  deleteMetaLaunchDraft,
  upsertMetaLaunchDraft,
} from "@/lib/launchpad/meta-store";
import { getMetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent-store";
import { handleMetaAddToExistingAction } from "@/lib/launchpad/meta-launch-route-handlers";
import {
  parseCreateMetaCreativeBriefRequest,
  parsePatchMetaCreativeBriefRequest,
} from "@/lib/meta/creative-brief-contract";
import {
  createMetaCreativeBrief,
  patchMetaCreativeBrief,
} from "@/lib/meta/creative-brief-store";
import {
  insertActivationProposalRow,
  projectMetaActivationProposals,
} from "@/lib/meta/activation-proposal-producer";
import {
  listStageableLaunchDecisions,
  projectMetaLaunchIntents,
} from "@/lib/meta/launch-intent-producer";
import {
  insertLaunchProposalRow,
  projectMetaLaunchProposals,
} from "@/lib/meta/launch-proposal-producer";
import { runMetaBudgetAutomationSweepIfDue } from "@/lib/meta/budget-automation-scheduled";

const LABEL = "decision-launch-chain-seam";
const AUTH_COOKIE = "omniads_session";

const USER_ID = "b2a10000-0000-4000-8000-0000000000a1";
const BUSINESS_ID = "b2a10000-0000-4000-8000-0000000000b1";
const ACCOUNT_ID = "act_2081000000001";
const ACCOUNT_NUMERIC = ACCOUNT_ID.replace(/^act_/, "");
const WINNER_CREATIVE_ID = "2081000000301";
const SOURCE_AD_ID = "2081000000401";
const SOURCE_ADSET_ID = "2081000000501";
const TARGET_CAMPAIGN_ID = "2081000000601";
const TARGET_ADSET_ID = "2081000000701";
const NEW_AD_ID = "2081000000801";
const ACCESS_TOKEN = "seam-token-decision-launch";
const SNAPSHOT_DATE = "2026-09-05";
const DECISION_AS_OF = "2026-09-04";

/*
  The UNATTENDED chapter's own fixtures.

  A second winner, promoted into the same live ad set by the sweep rather than
  by an operator; a `refresh` decision whose operator-composed draft is a whole
  test launch; and two decisions whose approval is missing or has been revoked,
  which must reach no provider at all.
*/
const AUTO_CREATIVE_ID = "2081000000311";
const AUTO_SOURCE_AD_ID = "2081000000411";
const AUTO_NEW_AD_ID = "2081000000811";

const TEST_CREATIVE_ID = "2081000000321";
const TEST_SOURCE_AD_ID = "2081000000421";
const TEST_PIXEL_ID = "2081000009001";
const TEST_NEW_CAMPAIGN_ID = "2081000000901";
const TEST_NEW_ADSET_ID = "2081000001001";
const TEST_NEW_AD_ID = "2081000001101";

const MISSING_CREATIVE_ID = "2081000000331";
const MISSING_SOURCE_AD_ID = "2081000000431";
const REVOKED_CREATIVE_ID = "2081000000341";
const REVOKED_SOURCE_AD_ID = "2081000000441";

/*
  The WITHDRAWN-AFTER-STAGING fixtures.

  `7d` and `7e` withdraw an approval before anything is staged, which the
  producer's own candidate query already sees. These three withdraw it after the
  intent exists and the queue row has been raised — the interval between the
  staging and the provider POST, where the intent stores the brief's ID and
  nothing re-asked whether that brief was still reviewed.

  One withdrawal lands before the sweep, one inside the window between the
  runtime's gate check and the first POST, and one after the first POST of a
  three-POST create.
*/
const STAGED_WITHDRAWAL_CREATIVE_ID = "2081000000351";
const STAGED_WITHDRAWAL_SOURCE_AD_ID = "2081000000451";
const STAGED_WITHDRAWAL_NEW_AD_ID = "2081000000821";

const PREFLIGHT_WITHDRAWAL_CREATIVE_ID = "2081000000361";
const PREFLIGHT_WITHDRAWAL_SOURCE_AD_ID = "2081000000461";
const PREFLIGHT_WITHDRAWAL_NEW_AD_ID = "2081000000831";

const MIDSEQUENCE_CREATIVE_ID = "2081000000371";
const MIDSEQUENCE_SOURCE_AD_ID = "2081000000471";
const MIDSEQUENCE_NEW_CAMPAIGN_ID = "2081000000911";
const MIDSEQUENCE_NEW_ADSET_ID = "2081000001011";
const MIDSEQUENCE_NEW_AD_ID = "2081000001111";

/*
  And the one that is NOT a withdrawal.

  `patchMetaCreativeBrief` moves a brief to `draft` on a content edit that does
  not re-state `reviewed`, and leaves it `reviewed` when the edit does. The
  second is an operator tidying the words of an approval they still stand
  behind, and it must not stop the launch.
*/
/*
  And the operator-approved mid-sequence case, which is chapter 9's.

  The same withdrawal, on the arm a person presses Approve on: the queue row is
  dispatched by `executeMetaAutomationProposal` into the Launchpad handler, and
  the brief is un-reviewed once that handler's campaign create is answered.
*/
const MANUAL_MIDSEQUENCE_CREATIVE_ID = "2081000000391";
const MANUAL_MIDSEQUENCE_SOURCE_AD_ID = "2081000000491";
const MANUAL_MIDSEQUENCE_NEW_CAMPAIGN_ID = "2081000000921";
const MANUAL_MIDSEQUENCE_NEW_ADSET_ID = "2081000001021";
const MANUAL_MIDSEQUENCE_NEW_AD_ID = "2081000001121";

const COSMETIC_CREATIVE_ID = "2081000000381";
const COSMETIC_SOURCE_AD_ID = "2081000000481";
const COSMETIC_NEW_AD_ID = "2081000000841";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

function log(message: string) {
  console.log(`[${LABEL}] ${message}`);
}

/** The provider paths a slice of recorded calls POSTed to, in order. */
function postPaths(calls: Recorded[]) {
  return calls
    .filter((call) => call.method === "POST")
    .map((call) => new URL(call.url).pathname.split("/").slice(2).join("/"));
}

// ---------------------------------------------------------------------------
// The controlled provider. Every read answers from the fixture's own ids, so a
// create that duplicated the wrong ad or landed in the wrong ad set would be
// refused by the shipped identity checks rather than by this file.
// ---------------------------------------------------------------------------
type Recorded = { method: string; url: string; body: string | null };

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * What the account holds before anything is created: the winners' source ads,
 * their creatives, and the live campaign and ad set an operator picked as a
 * destination. Answers are derived from this map, so a create that named the
 * wrong ad set or duplicated the wrong ad is refused by the shipped identity
 * checks rather than by a hand-written branch here.
 */
const SOURCE_ADS: Record<string, { creativeId: string; name: string }> = {
  [SOURCE_AD_ID]: { creativeId: WINNER_CREATIVE_ID, name: "Winner — hero 9x16" },
  [AUTO_SOURCE_AD_ID]: { creativeId: AUTO_CREATIVE_ID, name: "Winner — carousel" },
  [TEST_SOURCE_AD_ID]: { creativeId: TEST_CREATIVE_ID, name: "Refresh — hook B" },
  [MISSING_SOURCE_AD_ID]: { creativeId: MISSING_CREATIVE_ID, name: "Unapproved" },
  [REVOKED_SOURCE_AD_ID]: { creativeId: REVOKED_CREATIVE_ID, name: "Revoked" },
  [STAGED_WITHDRAWAL_SOURCE_AD_ID]: {
    creativeId: STAGED_WITHDRAWAL_CREATIVE_ID,
    name: "Withdrawn after staging",
  },
  [PREFLIGHT_WITHDRAWAL_SOURCE_AD_ID]: {
    creativeId: PREFLIGHT_WITHDRAWAL_CREATIVE_ID,
    name: "Withdrawn during preflight",
  },
  [MIDSEQUENCE_SOURCE_AD_ID]: {
    creativeId: MIDSEQUENCE_CREATIVE_ID,
    name: "Withdrawn mid-sequence",
  },
  [COSMETIC_SOURCE_AD_ID]: {
    creativeId: COSMETIC_CREATIVE_ID,
    name: "Edited but still reviewed",
  },
  [MANUAL_MIDSEQUENCE_SOURCE_AD_ID]: {
    creativeId: MANUAL_MIDSEQUENCE_CREATIVE_ID,
    name: "Withdrawn mid-sequence, operator-approved",
  },
};

type CreatedAd = {
  adsetId: string;
  campaignId: string;
  creativeId: string;
  name: string;
  status: "PAUSED" | "ACTIVE";
};

type ProviderState = {
  ads: Map<string, CreatedAd>;
  /** `${adsetId}:${creativeId}` -> adId. A repeat here is a duplicated ad. */
  adSlots: Map<string, string>;
  campaigns: Map<string, { name: string; status: string; objective: string }>;
  /**
   * Campaign NAME -> id, and ad set `${campaignId}:${name}` -> id.
   *
   * The duplicate trap used to be "this file creates at most one campaign and
   * one ad set", which stopped being sayable the moment a second test launch
   * existed. A name is what identifies a create to the operator who composed
   * it, so a repeat of one is a duplicate no matter how many launches the file
   * grows — and unlike a pool of ids, this catches the duplicate even while
   * spare ids remain.
   */
  campaignSlots: Map<string, string>;
  adsetSlots: Map<string, string>;
  adsets: Map<
    string,
    {
      campaignId: string;
      name: string;
      status: string;
      optimizationGoal: string;
      pixelId: string;
      customEventType: string;
    }
  >;
};

/**
 * The ids a create is answered with, in the order the fixture expects them.
 *
 * The first five are the creates this file expects to really happen, in the
 * order the chapters make them — the fourth being the RECOVERY of the launch
 * whose approval was withdrawn during its preflight, which the operator re-runs
 * from Launchpad after re-reviewing the brief. The last two belong to
 * withdrawal chapters that must reach no provider at all, or reach it once and
 * stop; they exist so that a regression produces a REAL created entity the
 * assertions can name, rather than the double running out of ids and failing
 * for a reason that hides which guard lapsed.
 *
 * Running out of ids is not the duplicate trap — `adSlots`, `campaignSlots` and
 * `adsetSlots` are, and they fire on the repeat itself however many ids remain.
 */
const NEXT_AD_IDS = [
  NEW_AD_ID,
  AUTO_NEW_AD_ID,
  TEST_NEW_AD_ID,
  PREFLIGHT_WITHDRAWAL_NEW_AD_ID,
  COSMETIC_NEW_AD_ID,
  STAGED_WITHDRAWAL_NEW_AD_ID,
  MIDSEQUENCE_NEW_AD_ID,
  MANUAL_MIDSEQUENCE_NEW_AD_ID,
];
/** Same, for the three new-campaign launches and the ad sets under them. */
const NEXT_CAMPAIGN_IDS = [
  TEST_NEW_CAMPAIGN_ID,
  MIDSEQUENCE_NEW_CAMPAIGN_ID,
  MANUAL_MIDSEQUENCE_NEW_CAMPAIGN_ID,
];
const NEXT_ADSET_IDS = [
  TEST_NEW_ADSET_ID,
  MIDSEQUENCE_NEW_ADSET_ID,
  MANUAL_MIDSEQUENCE_NEW_ADSET_ID,
];

function providerPayloadFor(
  objectId: string,
  state: ProviderState,
): unknown | null {
  const sourceAd = SOURCE_ADS[objectId];
  if (sourceAd) {
    return {
      id: objectId,
      name: sourceAd.name,
      account_id: ACCOUNT_NUMERIC,
      status: "ACTIVE",
      effective_status: "ACTIVE",
      creative: { id: sourceAd.creativeId },
      adset_id: SOURCE_ADSET_ID,
    };
  }
  if (
    Object.values(SOURCE_ADS).some((ad) => ad.creativeId === objectId)
  ) {
    return { id: objectId, account_id: ACCOUNT_NUMERIC };
  }
  if (objectId === TARGET_ADSET_ID) {
    return {
      id: TARGET_ADSET_ID,
      account_id: ACCOUNT_NUMERIC,
      campaign_id: TARGET_CAMPAIGN_ID,
      status: "ACTIVE",
      effective_status: "ACTIVE",
    };
  }
  if (objectId === TARGET_CAMPAIGN_ID) {
    return {
      id: TARGET_CAMPAIGN_ID,
      account_id: ACCOUNT_NUMERIC,
      status: "ACTIVE",
      effective_status: "ACTIVE",
    };
  }
  const campaign = state.campaigns.get(objectId);
  if (campaign) {
    return {
      id: objectId,
      account_id: ACCOUNT_NUMERIC,
      status: campaign.status,
      effective_status: campaign.status,
      objective: campaign.objective,
    };
  }
  const adset = state.adsets.get(objectId);
  if (adset) {
    return {
      id: objectId,
      account_id: ACCOUNT_NUMERIC,
      campaign_id: adset.campaignId,
      status: adset.status,
      effective_status: adset.status,
      optimization_goal: adset.optimizationGoal,
      promoted_object: {
        pixel_id: adset.pixelId,
        custom_event_type: adset.customEventType,
      },
    };
  }
  const ad = state.ads.get(objectId);
  if (ad) {
    const parentCampaign = state.campaigns.get(ad.campaignId);
    const parentAdset = state.adsets.get(ad.adsetId);
    const campaignStatus = parentCampaign?.status ?? "ACTIVE";
    const adsetStatus = parentAdset?.status ?? "ACTIVE";
    return {
      id: objectId,
      name: ad.name,
      account_id: ACCOUNT_NUMERIC,
      status: ad.status,
      effective_status: ad.status,
      adset_id: ad.adsetId,
      campaign: {
        id: ad.campaignId,
        status: campaignStatus,
        effective_status: campaignStatus,
      },
      adset: {
        id: ad.adsetId,
        status: adsetStatus,
        effective_status: adsetStatus,
      },
      creative: { id: ad.creativeId },
    };
  }
  return null;
}

function bodyField(body: string | null, key: string): string {
  return new URLSearchParams(body ?? "").get(key) ?? "";
}

function bodyCreativeId(body: string | null): string {
  const raw = bodyField(body, "creative");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { creative_id?: string };
    return typeof parsed.creative_id === "string" ? parsed.creative_id : "";
  } catch {
    return "";
  }
}

function installProvider(): {
  calls: Recorded[];
  state: ProviderState;
  restore: () => void;
  /**
   * Run something the moment a chosen provider call has been ANSWERED.
   *
   * The withdrawal chapters need a revocation committed at an exact point of a
   * live sequence — during the preflight read, or between the campaign create
   * and the ad set create. Nothing else can place it there: the sweep is one
   * `await`, and a revocation written before or after it would prove a
   * different thing entirely. The hook fires after the first call that matches,
   * and disarms itself.
   */
  armWhen: (
    match: (call: Recorded) => boolean,
    hook: (call: Recorded) => Promise<void>,
  ) => void;
} {
  const calls: Recorded[] = [];
  const state: ProviderState = {
    ads: new Map(),
    adSlots: new Map(),
    campaigns: new Map(),
    campaignSlots: new Map(),
    adsetSlots: new Map(),
    adsets: new Map(),
  };
  let armed: {
    match: (call: Recorded) => boolean;
    hook: (call: Recorded) => Promise<void>;
  } | null = null;
  const original = globalThis.fetch;

  const answer = (input: {
    method: string;
    path: string;
    body: string | null;
  }): Response => {
    const { method, path, body } = input;
    // A duplicated ad (creative reuse / winner promotion).
    if (method === "POST" && path === `act_${ACCOUNT_NUMERIC}/ads`) {
      const adsetId = bodyField(body, "adset_id");
      const creativeId = bodyCreativeId(body);
      return createAdOnDouble({ state, adsetId, creativeId, body });
    }
    // A brand new campaign, for a test launch.
    if (method === "POST" && path === `act_${ACCOUNT_NUMERIC}/campaigns`) {
      const campaignName = bodyField(body, "name");
      if (state.campaignSlots.has(campaignName)) {
        fail(
          "provider double",
          `a second campaign create reached the provider for ${campaignName}`,
        );
      }
      const campaignId = NEXT_CAMPAIGN_IDS[state.campaigns.size];
      if (!campaignId) {
        fail("provider double", "more campaign creates than the fixture expects");
      }
      state.campaigns.set(campaignId, {
        name: campaignName,
        status: bodyField(body, "status") || "PAUSED",
        objective: bodyField(body, "objective"),
      });
      state.campaignSlots.set(campaignName, campaignId);
      return json({ id: campaignId });
    }
    if (
      method === "POST"
      && path.endsWith("/adsets")
      && state.campaigns.has(path.split("/")[0]!)
    ) {
      const campaignId = path.split("/")[0]!;
      const adsetName = bodyField(body, "name");
      const adsetSlot = `${campaignId}:${adsetName}`;
      if (state.adsetSlots.has(adsetSlot)) {
        fail(
          "provider double",
          `a second ad set create reached the provider for ${adsetSlot}`,
        );
      }
      const adsetId = NEXT_ADSET_IDS[state.adsets.size];
      if (!adsetId) {
        fail("provider double", "more ad set creates than the fixture expects");
      }
      let promoted: { pixel_id?: string; custom_event_type?: string } = {};
      try {
        promoted = JSON.parse(bodyField(body, "promoted_object") || "{}");
      } catch {
        promoted = {};
      }
      state.adsets.set(adsetId, {
        campaignId,
        name: adsetName,
        status: bodyField(body, "status") || "PAUSED",
        optimizationGoal: bodyField(body, "optimization_goal"),
        pixelId: promoted.pixel_id ?? "",
        customEventType: promoted.custom_event_type ?? "",
      });
      state.adsetSlots.set(adsetSlot, adsetId);
      return json({ id: adsetId });
    }
    // The ad inside a newly created ad set.
    if (method === "POST" && path.endsWith("/ads") && state.adsets.has(path.split("/")[0]!)) {
      const adsetId = path.split("/")[0]!;
      return createAdOnDouble({
        state,
        adsetId,
        creativeId: bodyCreativeId(body),
        body,
      });
    }
    // A status write, which only the separately approved activation makes.
    const activated = state.ads.get(path);
    if (method === "POST" && activated) {
      activated.status =
        bodyField(body, "status") === "ACTIVE" ? "ACTIVE" : activated.status;
      return json({ success: true });
    }
    if (method === "GET" && path === `act_${ACCOUNT_NUMERIC}`) {
      /*
        The account itself. Two readers ask for it and they ask for different
        fields: the new-campaign validator reads `account_status` (1 is
        "active"), and the account-context loader reads the currency, timezone
        and name it needs before any unattended write may name an amount.
      */
      return json({
        id: ACCOUNT_ID,
        account_status: 1,
        currency: "USD",
        timezone_name: "UTC",
        name: "Decision launch seam account",
      });
    }
    if (method === "GET" && path === `act_${ACCOUNT_NUMERIC}/adspixels`) {
      return json({ data: [{ id: TEST_PIXEL_ID, name: "Seam pixel" }] });
    }
    if (method === "GET") {
      const payload = providerPayloadFor(path, state);
      if (payload) return json(payload);
    }
    return json(
      { error: { code: 100, message: `unmapped provider path ${method} ${path}` } },
      400,
    );
  };

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (!url.startsWith("https://graph.facebook.com/")) {
      fail("provider double", `unexpected non-provider request to ${url}`);
    }
    // The write primitives send `URLSearchParams`, so the body is read through
    // its own serializer rather than assumed to be a string.
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : init?.body == null
            ? null
            : String(init.body);
    const record: Recorded = { method, url, body };
    calls.push(record);
    const path = new URL(url).pathname.split("/").filter(Boolean).slice(1).join("/");
    const response = answer({ method, path, body });
    if (armed?.match(record)) {
      const { hook } = armed;
      armed = null;
      await hook(record);
    }
    return response;
  }) as typeof fetch;
  return {
    calls,
    state,
    restore: () => { globalThis.fetch = original; },
    armWhen: (match, hook) => { armed = { match, hook }; },
  };
}

/**
 * One created ad, and the duplicate check that makes the rerun assertions mean
 * something.
 *
 * A second create for the same ad set and creative is the exact failure this
 * seam exists to disprove, and answering it with a NEW id would hide it — so
 * the double refuses outright, and the call-count assertions below still read
 * the recorded requests either way.
 */
function createAdOnDouble(input: {
  state: ProviderState;
  adsetId: string;
  creativeId: string;
  body: string | null;
}) {
  const slot = `${input.adsetId}:${input.creativeId}`;
  if (input.state.adSlots.has(slot)) {
    fail(
      "provider double",
      `a second ad create reached the provider for ${slot}`,
    );
  }
  const adId = NEXT_AD_IDS[input.state.ads.size];
  if (!adId) fail("provider double", "more ad creates than the fixture expects");
  const campaignId =
    input.state.adsets.get(input.adsetId)?.campaignId ?? TARGET_CAMPAIGN_ID;
  input.state.ads.set(adId, {
    adsetId: input.adsetId,
    campaignId,
    creativeId: input.creativeId,
    name: bodyField(input.body, "name") || "Created ad",
    status: bodyField(input.body, "status") === "ACTIVE" ? "ACTIVE" : "PAUSED",
  });
  input.state.adSlots.set(slot, adId);
  return json({ id: adId });
}

// ---------------------------------------------------------------------------
// Fixtures: exactly the rows a real account has when a person has reviewed a
// winner's brief and composed the launch for it.
// ---------------------------------------------------------------------------
async function seed() {
  const db = getDb();
  await db.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1::uuid, 'Decision launch seam', 'decision-launch-seam@adsecute.local', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  await db.query(
    `INSERT INTO businesses (id, name, owner_id)
     VALUES ($1::uuid, 'Decision launch seam', $2::uuid)
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID, USER_ID],
  );
  await db.query(
    `INSERT INTO memberships (user_id, business_id, role, status)
     VALUES ($1::uuid, $2::uuid, 'admin', 'active')
     ON CONFLICT (user_id, business_id)
     DO UPDATE SET role = 'admin', status = 'active'`,
    [USER_ID, BUSINESS_ID],
  );
  /*
    A LIVE business, stated rather than defaulted: `dryRunOnly` ships as
    rehearsal and a create cannot be rehearsed, so an unstated control row would
    make this seam prove a refusal while claiming to prove a create.
  */
  await db.query(
    `INSERT INTO meta_automation_business_controls
       (business_id, kill_switch_engaged, auto_execution_enabled, readiness_tier,
        guardrails_json)
     VALUES ($1::uuid, FALSE, FALSE, 'manual_review', $2::jsonb)
     ON CONFLICT (business_id) DO UPDATE
       SET kill_switch_engaged = FALSE, guardrails_json = EXCLUDED.guardrails_json`,
    [BUSINESS_ID, JSON.stringify({ dryRunOnly: false })],
  );
  /*
    A note for whoever adds the next unattended chapter: `dailyAutoActionCap`
    is left at its default of 3, and this file already settles exactly three
    dispatches `approved` (7a, 7c and 8e). `claimScheduledMetaAutomationProposal`
    refuses at `used >= cap`, so a FOURTH successful dispatch would never be
    claimed — and the chapter would then pass for the wrong reason. The
    withdrawal chapters settle `failed`, which that count does not include.
  */
  /*
    The standing creative mode. `semi_auto` is the only mode this producer
    stages under: the operator approves each queue row and supplies the
    confirmation the create requires, which is a confirmation the producer
    itself cannot give.
  */
  await db.query(
    `INSERT INTO meta_automation_decision_type_modes
       (business_id, decision_type, mode, updated_by)
     VALUES ($1::uuid, 'creative', 'semi_auto', $2::uuid)
     ON CONFLICT (business_id, decision_type)
     DO UPDATE SET mode = 'semi_auto'`,
    [BUSINESS_ID, USER_ID],
  );

  const accountRows = (await db.query(
    `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone)
     VALUES ('meta', $1, 'Decision launch seam account', 'USD', 'UTC')
     ON CONFLICT (provider, external_account_id)
     DO UPDATE SET account_name = EXCLUDED.account_name
     RETURNING id::text AS id`,
    [ACCOUNT_ID],
  )) as Array<{ id: string }>;
  await db.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
     VALUES ($1::uuid, 'meta', $2::uuid, $3, 0, TRUE)
     ON CONFLICT (business_id, provider, provider_account_ref_id)
     DO UPDATE SET is_selected = TRUE`,
    [BUSINESS_ID, accountRows[0]!.id, ACCOUNT_ID],
  );
  const connectionRows = (await db.query(
    `INSERT INTO provider_connections (business_id, provider, status, connection_generation)
     VALUES ($1::uuid, 'meta', 'connected', 1)
     ON CONFLICT (business_id, provider)
     DO UPDATE SET status = 'connected', connection_generation = 1
     RETURNING id::text AS id`,
    [BUSINESS_ID],
  )) as Array<{ id: string }>;
  await db.query(
    `INSERT INTO integration_credentials (provider_connection_id, access_token)
     VALUES ($1::uuid, $2)
     ON CONFLICT (provider_connection_id)
     DO UPDATE SET access_token = EXCLUDED.access_token`,
    [connectionRows[0]!.id, ACCESS_TOKEN],
  );

  // The winning creative, as the warehouse holds it: in this account, live, and
  // carrying the exact source ad a reuse duplicates.
  await db.query(
    `INSERT INTO meta_creative_dimensions
       (business_id, provider_account_id, creative_id, creative_name, ad_id)
     VALUES ($1::uuid, $2, $3, 'Winner — hero 9x16', $4)
     ON CONFLICT DO NOTHING`,
    [BUSINESS_ID, ACCOUNT_ID, WINNER_CREATIVE_ID, SOURCE_AD_ID],
  );
  await db.query(
    `INSERT INTO meta_creative_daily
       (business_id, provider_account_id, date, creative_id, creative_name,
        ad_id, effective_status, account_timezone, account_currency)
     VALUES ($1::uuid, $2, $3::date, $4, 'Winner — hero 9x16', $5, 'ACTIVE',
             'UTC', 'USD')
     ON CONFLICT DO NOTHING`,
    [BUSINESS_ID, ACCOUNT_ID, DECISION_AS_OF, WINNER_CREATIVE_ID, SOURCE_AD_ID],
  );
  // The destination the operator chose: a live campaign and a live ad set.
  await db.query(
    `INSERT INTO meta_campaign_dimensions
       (business_id, provider_account_id, campaign_id, campaign_name_current)
     VALUES ($1::uuid, $2, $3, 'Main · purchase')
     ON CONFLICT DO NOTHING`,
    [BUSINESS_ID, ACCOUNT_ID, TARGET_CAMPAIGN_ID],
  );
  await db.query(
    `INSERT INTO meta_adset_dimensions
       (business_id, provider_account_id, campaign_id, adset_id,
        adset_name_current, adset_status)
     VALUES ($1::uuid, $2, $3, $4, 'Broad · purchase', 'ACTIVE')
     ON CONFLICT DO NOTHING`,
    [BUSINESS_ID, ACCOUNT_ID, TARGET_CAMPAIGN_ID, TARGET_ADSET_ID],
  );

  const snapshots = (await db.query(
    `INSERT INTO engine_v3_decision_snapshots_daily (
       business_ref_id, business_id, creative_id, as_of_date, engine_version,
       scope_type, scope_id, label, confidence, truth_source,
       effective_target_roas, ratio_to_target, badges, reason
     ) VALUES (
       $1::uuid, $1, $2, $3::date, 'v3-decision-launch-seam',
       'account', $4, 'scale', 88, 'commercial_truth',
       2.2, 1.62, '[]'::jsonb, 'Sustained ROAS above target on a mature creative'
     ) RETURNING id::text AS id`,
    [BUSINESS_ID, WINNER_CREATIVE_ID, DECISION_AS_OF, ACCOUNT_ID],
  )) as Array<{ id: string }>;
  const snapshotId = snapshots[0]!.id;

  // The approval: a brief a named person reviewed, written against this exact
  // snapshot through the shipped contract parser and store.
  const brief = await createMetaCreativeBrief({
    request: parseCreateMetaCreativeBriefRequest({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      idempotencyKey: "decision-launch-seam-brief",
      sourceDecision: { snapshotId, trigger: "decision_card" },
      content: {
        keep: "Keep the opening product shot",
        change: "Nothing — this one is working",
        next: "Add it to the main purchase ad set",
      },
      status: "reviewed",
    }),
    createdBy: USER_ID,
  });

  // The exactness: the operator's own composed launch, through the shipped
  // draft store, naming this creative and this destination and nothing else.
  const draft = await upsertMetaLaunchDraft({
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT_ID,
    name: "Promote winner into Broad · purchase",
    payload: {
      mode: "add_to_existing",
      targetCampaignId: TARGET_CAMPAIGN_ID,
      targetAdsetId: TARGET_ADSET_ID,
      targetAdsetName: "Broad · purchase",
      copyMode: "reuse_creative",
      targets: [
        {
          targetCampaignId: TARGET_CAMPAIGN_ID,
          targetAdsetId: TARGET_ADSET_ID,
          targetAdsetName: "Broad · purchase",
        },
      ],
      creativeIds: [WINNER_CREATIVE_ID],
      creatives: [
        { creativeId: WINNER_CREATIVE_ID, sourceAdId: SOURCE_AD_ID, name: "Winner — hero 9x16" },
      ],
    },
    createdBy: USER_ID,
  });

  const session = await createSession({
    userId: USER_ID,
    activeBusinessId: BUSINESS_ID,
  });
  return { snapshotId, briefId: brief.brief.id, draftId: draft.id, token: session.token };
}

/**
 * Two more approved decisions whose launch is NOT fully approved.
 *
 * One has a reviewed brief and no composed launch at all — nobody has said
 * where the ad would go. The other has a composed launch naming a destination
 * that does not exist in this account. Neither may become an intent, and each
 * must say which of the three approvals is missing.
 */
async function seedUnstagedDecisions() {
  const db = getDb();
  const cases = [
    { creativeId: "2081000000302", sourceAdId: "2081000000402", withDraft: false },
    { creativeId: "2081000000303", sourceAdId: "2081000000403", withDraft: true },
  ] as const;
  for (const testCase of cases) {
    await db.query(
      `INSERT INTO meta_creative_dimensions
         (business_id, provider_account_id, creative_id, creative_name, ad_id)
       VALUES ($1::uuid, $2, $3, 'Runner-up', $4)
       ON CONFLICT DO NOTHING`,
      [BUSINESS_ID, ACCOUNT_ID, testCase.creativeId, testCase.sourceAdId],
    );
    const snapshot = (await db.query(
      `INSERT INTO engine_v3_decision_snapshots_daily (
         business_ref_id, business_id, creative_id, as_of_date, engine_version,
         scope_type, scope_id, label, confidence, truth_source,
         effective_target_roas, ratio_to_target, badges, reason
       ) VALUES (
         $1::uuid, $1, $2, $3::date, 'v3-decision-launch-seam',
         'account', $4, 'scale', 71, 'commercial_truth',
         2.2, 1.24, '[]'::jsonb, 'Above target on a second creative'
       ) RETURNING id::text AS id`,
      [BUSINESS_ID, testCase.creativeId, DECISION_AS_OF, ACCOUNT_ID],
    )) as Array<{ id: string }>;
    await createMetaCreativeBrief({
      request: parseCreateMetaCreativeBriefRequest({
        businessId: BUSINESS_ID,
        providerAccountId: ACCOUNT_ID,
        idempotencyKey: `decision-launch-seam-brief-${testCase.creativeId}`,
        sourceDecision: { snapshotId: snapshot[0]!.id, trigger: "decision_card" },
        content: { keep: "Keep it", change: "Nothing", next: "Consider promoting" },
        status: "reviewed",
      }),
      createdBy: USER_ID,
    });
    if (!testCase.withDraft) continue;
    await upsertMetaLaunchDraft({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      name: "Promote runner-up into an ad set that is not here",
      payload: {
        mode: "add_to_existing",
        targetCampaignId: "2081000000699",
        targetAdsetId: "2081000000799",
        copyMode: "reuse_creative",
        targets: [
          { targetCampaignId: "2081000000699", targetAdsetId: "2081000000799" },
        ],
        creativeIds: [testCase.creativeId],
        creatives: [
          { creativeId: testCase.creativeId, sourceAdId: testCase.sourceAdId },
        ],
      },
      createdBy: USER_ID,
    });
  }
}

/**
 * One decision, with exactly the approvals it is supposed to have.
 *
 * Every row goes through the shipped writer for its kind — the brief contract
 * parser and store, the draft store — so a fixture that could not exist in
 * production cannot exist here either.
 */
async function seedApprovedDecision(input: {
  creativeId: string;
  sourceAdId: string;
  creativeName: string;
  label: "scale" | "refresh";
  briefStatus: "draft" | "reviewed";
  draftName: string;
  draftPayload: Record<string, unknown> | null;
}) {
  const db = getDb();
  await db.query(
    `INSERT INTO meta_creative_dimensions
       (business_id, provider_account_id, creative_id, creative_name, ad_id)
     VALUES ($1::uuid, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [BUSINESS_ID, ACCOUNT_ID, input.creativeId, input.creativeName, input.sourceAdId],
  );
  await db.query(
    `INSERT INTO meta_creative_daily
       (business_id, provider_account_id, date, creative_id, creative_name,
        ad_id, effective_status, account_timezone, account_currency)
     VALUES ($1::uuid, $2, $3::date, $4, $5, $6, 'ACTIVE', 'UTC', 'USD')
     ON CONFLICT DO NOTHING`,
    [
      BUSINESS_ID, ACCOUNT_ID, DECISION_AS_OF, input.creativeId,
      input.creativeName, input.sourceAdId,
    ],
  );
  const snapshots = (await db.query(
    `INSERT INTO engine_v3_decision_snapshots_daily (
       business_ref_id, business_id, creative_id, as_of_date, engine_version,
       scope_type, scope_id, label, confidence, truth_source,
       effective_target_roas, ratio_to_target, badges, reason
     ) VALUES (
       $1::uuid, $1, $2, $3::date, 'v3-decision-launch-seam',
       'account', $4, $5, 84, 'commercial_truth',
       2.2, 1.48, '[]'::jsonb, 'Published by the engine for this creative'
     ) RETURNING id::text AS id`,
    [BUSINESS_ID, input.creativeId, DECISION_AS_OF, ACCOUNT_ID, input.label],
  )) as Array<{ id: string }>;
  const snapshotId = snapshots[0]!.id;

  const brief = await createMetaCreativeBrief({
    request: parseCreateMetaCreativeBriefRequest({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      idempotencyKey: `decision-launch-seam-brief-${input.creativeId}`,
      sourceDecision: { snapshotId, trigger: "decision_card" },
      content: {
        keep: "Keep the opening frame",
        change: "Nothing",
        next:
          input.label === "scale"
            ? "Promote it into the main purchase ad set"
            : "Run it as a fresh test",
      },
      status: input.briefStatus,
    }),
    createdBy: USER_ID,
  });

  let draftId: string | null = null;
  if (input.draftPayload) {
    const draft = await upsertMetaLaunchDraft({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      name: input.draftName,
      payload: input.draftPayload,
      createdBy: USER_ID,
    });
    draftId = draft.id;
  }
  return {
    snapshotId,
    briefId: brief.brief.id,
    briefVersion: brief.brief.version,
    draftId,
  };
}

/** The operator's composed creative reuse, aimed at the live Main ad set. */
function reuseDraftPayload(creativeId: string, sourceAdId: string) {
  return {
    mode: "add_to_existing",
    targetCampaignId: TARGET_CAMPAIGN_ID,
    targetAdsetId: TARGET_ADSET_ID,
    targetAdsetName: "Broad · purchase",
    copyMode: "reuse_creative",
    targets: [
      {
        targetCampaignId: TARGET_CAMPAIGN_ID,
        targetAdsetId: TARGET_ADSET_ID,
        targetAdsetName: "Broad · purchase",
      },
    ],
    creativeIds: [creativeId],
    creatives: [{ creativeId, sourceAdId, name: "Promoted winner" }],
  };
}

/** The operator's composed TEST LAUNCH: a whole new campaign, all of it theirs. */
/**
 * `names` is what makes the double's duplicate trap exact.
 *
 * Two test launches composed with the same campaign and ad set names produce
 * byte-identical create bodies, so the double could not tell a second launch
 * from a second create OF a launch. Every test launch here names itself.
 */
function testLaunchDraftPayload(
  creativeId: string,
  sourceAdId: string,
  names: { campaign: string; adSet: string } = {
    campaign: "Test · refresh hook B",
    adSet: "Test · broad",
  },
) {
  return {
    mode: "new_campaign",
    currencyCode: "USD",
    campaign: { name: names.campaign },
    budget: {
      mode: "CBO",
      amountMinor: 5000,
      currency: "USD",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    },
    creativeIds: [creativeId],
    creatives: [{ creativeId, sourceAdId, name: "Refresh — hook B" }],
    adSets: [
      {
        clientId: "adset-1",
        name: names.adSet,
        optimizationGoal: "OFFSITE_CONVERSIONS",
        pixelId: TEST_PIXEL_ID,
        customEventType: "PURCHASE",
        targeting: { countries: ["US"], ageMin: 18, ageMax: 65 },
        attributionSpec: [{ eventType: "CLICK_THROUGH", windowDays: 7 }],
      },
    ],
  };
}

/**
 * The account-bound scheduled authority, persisted the way an operator's own
 * activation persists it: enabled for THIS account, by an admin who is really
 * an active admin of this business.
 */
async function armScheduledExecution() {
  await getDb().query(
    `UPDATE meta_automation_business_controls
        SET auto_execution_enabled = TRUE,
            auto_execution_provider_account_id = $2,
            auto_execution_enabled_by = $3::uuid
      WHERE business_id = $1::uuid`,
    [BUSINESS_ID, ACCOUNT_ID, USER_ID],
  );
  clearServerCache();
}

async function setCreativeMode(mode: "manual" | "semi_auto" | "auto") {
  await getDb().query(
    `UPDATE meta_automation_decision_type_modes SET mode = $2
      WHERE business_id = $1::uuid AND decision_type = 'creative'`,
    [BUSINESS_ID, mode],
  );
  clearServerCache();
}

/**
 * The control plane memoizes its answer for a business, and this run stands in
 * for many ticks. Clearing the store is how a mode change made a line earlier
 * is the mode the next read sees.
 */
function clearServerCache() {
  (globalThis as typeof globalThis & {
    __omniadsServerCache?: { entries: Map<string, unknown> };
  }).__omniadsServerCache?.entries.clear();
}

async function runScheduledSweep() {
  const result = await runMetaBudgetAutomationSweepIfDue();
  if (result.skipped) return { executed: 0, withheld: 0, failed: 0, skipped: result.reason };
  const reports = result.reports ?? [];
  return {
    executed: reports.reduce((sum, report) => sum + report.executed, 0),
    withheld: reports.reduce((sum, report) => sum + report.withheld, 0),
    failed: reports.reduce((sum, report) => sum + report.failed, 0),
    skipped: null as string | null,
  };
}

async function readAdsActionLog() {
  return (await getDb().query(
    `SELECT action, source, requested_by::text AS requested_by, ad_id,
            launch_intent_id::text AS launch_intent_id, payload_request
       FROM meta_ads_action_log
      WHERE business_id = $1::uuid
      ORDER BY created_at, id`,
    [BUSINESS_ID],
  )) as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// The shipped producers and the shipped routes.
// ---------------------------------------------------------------------------
async function stageIntents() {
  return projectMetaLaunchIntents({
    businessId: BUSINESS_ID,
    snapshotDate: SNAPSHOT_DATE,
  });
}

async function projectLaunchRows() {
  return projectMetaLaunchProposals({
    businessId: BUSINESS_ID,
    snapshotDate: SNAPSHOT_DATE,
    insertProposal: async (insert) =>
      insertLaunchProposalRow({
        candidate: insert.candidate,
        snapshotDate: SNAPSHOT_DATE,
        actionLabel: insert.actionLabel,
      }),
  });
}

async function projectActivationRows() {
  return projectMetaActivationProposals({
    businessId: BUSINESS_ID,
    snapshotDate: SNAPSHOT_DATE,
    insertProposal: async (insert) =>
      insertActivationProposalRow({
        candidate: insert.candidate,
        snapshotDate: SNAPSHOT_DATE,
        actionLabel: insert.actionLabel,
      }),
  });
}

async function approveProposal(input: { token: string; proposalId: string }) {
  const { POST } = await import("@/app/api/meta/automation/proposals/route");
  const url =
    `http://localhost/api/meta/automation/proposals`
    + `?businessId=${BUSINESS_ID}&providerAccountId=${ACCOUNT_ID}`;
  const request = new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${AUTH_COOKIE}=${input.token}`,
    },
    body: JSON.stringify({
      action: "approve",
      proposalId: input.proposalId,
      manualConfirmation: "explicit_operator_confirmation",
    }),
  });
  const response = await POST(request);
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return { status: response.status, body };
}

async function readProposals() {
  return (await getDb().query(
    `SELECT id::text AS id, proposed_action, origin, status, decision_key,
            scope_type, scope_id, entity_label, launch_intent_id::text AS launch_intent_id
       FROM meta_automation_proposals
      WHERE business_id = $1::uuid
      ORDER BY created_at, id`,
    [BUSINESS_ID],
  )) as Array<Record<string, unknown>>;
}

/** The launch row for one intent, with the receipt the sweep settled it under. */
async function readLaunchRowFor(intentId: string) {
  const rows = (await getDb().query(
    `SELECT id::text AS id, status, receipt_json
       FROM meta_automation_proposals
      WHERE business_id = $1::uuid
        AND launch_intent_id = $2::uuid
        AND proposed_action = 'launch'
      ORDER BY created_at DESC, id
      LIMIT 1`,
    [BUSINESS_ID, intentId],
  )) as Array<{
    id: string;
    status: string;
    receipt_json: Record<string, unknown> | null;
  }>;
  return rows[0] ?? null;
}

/** The refusal code inside a settled receipt's response envelope, if it has one. */
function receiptErrorCode(receipt: Record<string, unknown> | null | undefined) {
  const response = receipt?.response;
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const error = (response as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

/**
 * The withdrawal itself, through the writer an operator's own edit goes
 * through. `patchMetaCreativeBrief` clears `reviewed_by` and `reviewed_at` by
 * its own SQL whenever the resulting status is not `reviewed`.
 */
async function revokeBriefReview(input: { briefId: string; version: number }) {
  const brief = await patchMetaCreativeBrief({
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT_ID,
    id: input.briefId,
    patch: parsePatchMetaCreativeBriefRequest({
      expectedVersion: input.version,
      status: "draft",
    }),
    updatedBy: USER_ID,
  });
  expectEqual(brief.status, "draft", "the brief really left `reviewed`");
  return brief;
}

async function readIntents() {
  return (await getDb().query(
    `SELECT id::text AS id, status, requested_status, idempotency_key, operation,
            source_decision_id, source_decision_snapshot_id::text AS snapshot_id,
            creative_brief_id::text AS brief_id, source_draft_id::text AS draft_id,
            request_payload_json, result_receipt_json, activation_receipt_json
       FROM meta_launch_intents
      WHERE business_id = $1::uuid
      ORDER BY created_at, id`,
    [BUSINESS_ID],
  )) as Array<Record<string, unknown>>;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (databaseUrl.includes(":15432/") || databaseUrl.includes(":5432/")) {
    fail("port guard", "DATABASE_URL points at a protected port");
  }
  /*
    Both environment capabilities, stated rather than assumed. With either shut
    every route below answers a refusal and the chain could not be exercised at
    all — which is the correct production behaviour and is why they are named
    here instead of being left to whatever the shell happened to carry.
  */
  process.env.META_AUTOMATION_LIVE_WRITES = "true";
  process.env.META_LAUNCHPAD_EXECUTION = "true";

  const queuePageCases = await runDbTransaction(() =>
    verifyScheduledQueuePageFixtures((text, params) => getDb().query(text, params)),
  );
  console.log(`[${LABEL}] scheduled queue page: ${queuePageCases} PostgreSQL cases passed`);
  const nativeLifecycleCases = await runDbTransaction(() =>
    verifyNativeProposalLifecycleFixtures((text, params) => getDb().query(text, params)),
  );
  console.log(`[${LABEL}] native proposal lifecycle: ${nativeLifecycleCases} PostgreSQL cases passed`);
  const launchClaimCases = await runDbTransaction(() =>
    verifyLaunchZeroWriteClaimFixtures((text, params) => getDb().query(text, params)),
  );
  console.log(`[${LABEL}] launch zero-write claims: ${launchClaimCases} PostgreSQL cases passed`);
  const ledgerWindowCases = await runDbTransaction(() =>
    verifyDailyBriefLedgerWindowFixtures((text, params) => getDb().query(text, params)),
  );
  console.log(`[${LABEL}] daily brief ledger windows: ${ledgerWindowCases} PostgreSQL cases passed`);

  const fixture = await seed();
  const provider = installProvider();
  try {
    // --------------------------------------------------- 0. the defect itself
    /*
      Before anything stages, the queue producer is run against a fully approved
      decision and finds NOTHING. That is R2 in one line: the `launch` row, its
      executor and its separately authorized activation all shipped, and no
      producer ever wrote the intent they select on, so the whole family was
      unreachable no matter how correct it was.
    */
    const beforeStaging = await projectLaunchRows();
    expectEqual(beforeStaging.candidates, 0, "no launch candidate before staging");
    expectEqual(
      (await readIntents()).length,
      0,
      "an approved decision alone stages nothing",
    );

    // ------------------------------------------------------------- 1. intent
    const staging = await stageIntents();
    expectEqual(staging.candidates, 1, "one eligible decision");
    expectEqual(staging.staged, 1, "one staged intent");
    expectEqual(staging.refusals, {}, "no refusal on the eligible decision");

    let intents = await readIntents();
    expectEqual(intents.length, 1, "exactly one persisted intent");
    const intent = intents[0]!;
    expectEqual(intent.status, "prepared", "intent rests prepared");
    expectEqual(intent.requested_status, "PAUSED", "PAUSED-only invariant");
    expectEqual(intent.operation, "add_to_existing", "creative reuse operation");
    expectEqual(intent.snapshot_id, fixture.snapshotId, "decision snapshot lineage");
    expectEqual(intent.brief_id, fixture.briefId, "reviewed brief lineage");
    expectEqual(intent.draft_id, fixture.draftId, "operator draft lineage");
    const payload = intent.request_payload_json as Record<string, unknown>;
    expectEqual(payload.targetAdsetId, TARGET_ADSET_ID, "the operator's destination");
    expectEqual(payload.creativeIds, [WINNER_CREATIVE_ID], "the decision's own creative");
    expectEqual(payload.copyMode, "reuse_creative", "approved copy is reused, not rebuilt");
    expectEqual(provider.calls.length, 0, "staging made no provider request");
    const intentId = String(intent.id);
    const firstIdempotencyKey = String(intent.idempotency_key);

    // -------------------------------------------------------- 2. queue row
    const launchRows = await projectLaunchRows();
    expectEqual(launchRows.candidates, 1, "one launch candidate");
    expectEqual(launchRows.projected, 1, "one launch row");
    let proposals = await readProposals();
    expectEqual(proposals.length, 1, "exactly one queue row");
    const launchRow = proposals[0]!;
    expectEqual(launchRow.proposed_action, "launch", "the row is a launch");
    expectEqual(launchRow.origin, "operator_action", "operator origin");
    expectEqual(launchRow.launch_intent_id, intentId, "the row points at the intent");
    expectEqual(launchRow.entity_label, "Broad · purchase", "the row names its destination");

    // ------------------------------------------ 3. the operator approves it
    const approval = await approveProposal({
      token: fixture.token,
      proposalId: String(launchRow.id),
    });
    if (approval.status !== 200 || approval.body?.ok !== true) {
      fail("launch approval", JSON.stringify(approval));
    }
    const adCreatePosts = provider.calls.filter(
      (call) => call.method === "POST" && call.url.includes(`act_${ACCOUNT_NUMERIC}/ads`),
    );
    expectEqual(adCreatePosts.length, 1, "exactly one provider ad create");
    if (!adCreatePosts[0]!.body?.includes(`adset_id=${TARGET_ADSET_ID}`)) {
      fail("create target", adCreatePosts[0]!.body ?? "no body");
    }
    if (!adCreatePosts[0]!.body?.includes("status=PAUSED")) {
      fail("create status", "the create did not ask for PAUSED");
    }

    intents = await readIntents();
    expectEqual(intents.length, 1, "still exactly one intent after the create");
    expectEqual(intents[0]!.status, "succeeded", "intent settled succeeded");
    const receipt = intents[0]!.result_receipt_json as {
      adIds?: string[];
      executionAuthority?: unknown;
    } | null;
    expectEqual(receipt?.adIds, [NEW_AD_ID], "durable creation receipt");
    /*
      Both authorities, side by side, on a launch the PRODUCER staged and an
      OPERATOR approved.

      The receipt records what the payload was staged under — the producer's own
      authority, which is what the request fingerprint covers — and the action
      log records who ran it, which here really was a person pressing Approve.
      A reader who could not tell those apart could not tell an operator-staged
      launch from a producer-staged one, which is the whole reason the second
      origin exists.
    */
    expectEqual(
      receipt?.executionAuthority,
      {
        actionOrigin: "launchpad_decision_staged_v1",
        manualConfirmation: "decision_staged_approval",
      },
      "the receipt names the authority the payload was staged under",
    );
    const manualLog = (await readAdsActionLog()).filter(
      (row) => row.launch_intent_id === intentId,
    );
    expectEqual(manualLog.length, 1, "one action-log row for the approved create");
    const manualLogPayload = manualLog[0]!.payload_request as Record<string, unknown>;
    expectEqual(
      [manualLogPayload.action_origin, manualLogPayload.manual_confirmation],
      ["launchpad_manual_v1", "explicit_operator_confirmation"],
      "the operator's own confirmation is what ran it",
    );
    expectEqual(
      manualLogPayload.staged_execution_authority,
      {
        actionOrigin: "launchpad_decision_staged_v1",
        manualConfirmation: "decision_staged_approval",
      },
      "and the journal still says the payload was producer-staged",
    );
    expectEqual(
      manualLog[0]!.requested_by,
      USER_ID,
      "with the approving operator named as the requester",
    );

    // ------------------------------- 4. the separately authorized activation
    const activationRows = await projectActivationRows();
    expectEqual(activationRows.candidates, 1, "one activation candidate");
    expectEqual(activationRows.projected, 1, "one activation row");
    proposals = await readProposals();
    const activationRow = proposals.find(
      (row) => row.proposed_action === "resume",
    );
    if (!activationRow) fail("activation row", "no resume row was raised");
    expectEqual(
      activationRow.launch_intent_id,
      intentId,
      "the activation row names the same intent",
    );
    expectEqual(activationRow.scope_id, NEW_AD_ID, "it points at what was created");

    const activation = await approveProposal({
      token: fixture.token,
      proposalId: String(activationRow.id),
    });
    if (activation.status !== 200 || activation.body?.ok !== true) {
      fail("activation approval", JSON.stringify(activation));
    }
    intents = await readIntents();
    const activationReceipt = intents[0]!.activation_receipt_json as {
      delivering?: boolean;
      steps?: unknown[];
    } | null;
    if (!activationReceipt) fail("activation receipt", "nothing was recorded");
    expectEqual(activationReceipt.delivering, true, "the new ad is delivering");
    expectEqual(
      provider.calls.filter(
        (call) => call.method === "POST" && call.url.includes(`/${NEW_AD_ID}`),
      ).length,
      1,
      "one provider status write for the activation",
    );

    // --------------------------------------------------- 5. the rerun
    /*
      The whole point. A producer that stages from a decision is exactly the
      kind that can create one more ad on every tick, so the tick is run again
      against the same decision, the same brief and the same draft.
    */
    const createPostsBeforeRerun = provider.calls.filter(
      (call) => call.method === "POST" && call.url.includes(`act_${ACCOUNT_NUMERIC}/ads`),
    ).length;
    const restaging = await stageIntents();
    expectEqual(restaging.staged, 0, "the rerun stages no second intent");
    const rerunLaunchRows = await projectLaunchRows();
    expectEqual(rerunLaunchRows.projected, 0, "the rerun raises no second launch row");
    const rerunActivationRows = await projectActivationRows();
    expectEqual(
      rerunActivationRows.candidates,
      0,
      "a delivering launch is no longer an activation candidate",
    );

    intents = await readIntents();
    expectEqual(intents.length, 1, "still exactly one intent");
    expectEqual(intents[0]!.idempotency_key, firstIdempotencyKey, "same decision, same key");
    expectEqual(
      provider.calls.filter(
        (call) => call.method === "POST" && call.url.includes(`act_${ACCOUNT_NUMERIC}/ads`),
      ).length,
      createPostsBeforeRerun,
      "the rerun made no provider request at all",
    );
    proposals = await readProposals();
    expectEqual(proposals.length, 2, "still exactly two queue rows");

    // ------------------------------------------ 6. the refusals, on real SQL
    /*
      The binding constraint, proved rather than asserted: a decision whose
      approval is incomplete produces NO intent and a NAMED reason. Both cases
      go through the same producer, the same candidate query and the same
      shipped validator as the one that succeeded above.
    */
    await seedUnstagedDecisions();
    const refused = await stageIntents();
    expectEqual(refused.staged, 0, "no intent from an incomplete approval");
    expectEqual(
      /*
        Sorted, because the two decisions share an as-of date and the candidate
        query breaks that tie on a generated id — the ORDER of the refusals is
        not a fact worth pinning, only which ones were raised.

        One decision names a destination that is not in the account; the other
        has no composed launch at all, so nobody has said where its ad would go.
      */
      Object.entries(refused.refusals).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      [
        ["launch_payload_not_composed", 1],
        ["target_adset_not_found", 1],
      ],
      "each incomplete approval is refused by name",
    );
    expectEqual(
      (await readIntents()).length,
      1,
      "still exactly one intent after both refusals",
    );

    // ==================================================================
    // 7. THE UNATTENDED ARM
    // ==================================================================
    /*
      Everything above needed an operator at the queue. This is the arm that
      does not, and the one that used to be refused at the very first step:
      `projectMetaLaunchIntents` returned `creative_mode_auto_operator_staging_required`
      for every `auto` run, because the only authority a stored payload could
      carry claimed an operator had confirmed the write.

      The producer now stages under its own authority, so the chain runs. What
      must NOT change is everything the authority was protecting: the entity is
      still created PAUSED, activation is still a separate approval, a missing
      or revoked approval still reaches no provider, and the action log still
      says which authority acted.
    */
    await armScheduledExecution();
    await setCreativeMode("auto");

    // ------------------------------------ 7a. the positive automatic case
    const autoFixture = await seedApprovedDecision({
      creativeId: AUTO_CREATIVE_ID,
      sourceAdId: AUTO_SOURCE_AD_ID,
      creativeName: "Winner — carousel",
      label: "scale",
      briefStatus: "reviewed",
      draftName: "Promote the carousel winner into Broad · purchase",
      draftPayload: reuseDraftPayload(AUTO_CREATIVE_ID, AUTO_SOURCE_AD_ID),
    });
    const autoStaging = await stageIntents();
    expectEqual(autoStaging.staged, 1, "the auto mode stages the approved decision");
    expectEqual(
      Object.entries(autoStaging.refusals).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      [
        // The two incomplete approvals from step 6, still refused by name.
        ["launch_payload_not_composed", 1],
        ["target_adset_not_found", 1],
      ],
      "and refuses nothing else it should have staged",
    );
    const autoIntentId = autoStaging.stagedIntentIds[0]!;
    const autoIntent = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: autoIntentId,
    });
    if (!autoIntent) fail("auto intent", "the staged intent could not be read back");
    expectEqual(autoIntent.requestedStatus, "PAUSED", "PAUSED-only invariant");
    expectEqual(
      (autoIntent.requestPayload as Record<string, unknown>).executionAuthority,
      {
        actionOrigin: "launchpad_decision_staged_v1",
        manualConfirmation: "decision_staged_approval",
      },
      "the stored authority is the producer's own, not a fabricated operator confirmation",
    );

    const autoRows = await projectLaunchRows();
    expectEqual(autoRows.projected, 1, "one unattended launch row");

    const beforeAutoSweep = provider.calls.length;
    const autoSweep = await runScheduledSweep();
    expectEqual(
      { executed: autoSweep.executed, failed: autoSweep.failed, skipped: autoSweep.skipped },
      { executed: 1, failed: 0, skipped: null },
      "the sweep executed exactly the one launch row",
    );
    const autoCreates = provider.calls
      .slice(beforeAutoSweep)
      .filter((call) => call.method === "POST" && call.url.includes(`act_${ACCOUNT_NUMERIC}/ads`));
    expectEqual(autoCreates.length, 1, "exactly one unattended provider ad create");
    if (!autoCreates[0]!.body?.includes(`adset_id=${TARGET_ADSET_ID}`)) {
      fail("unattended create target", autoCreates[0]!.body ?? "no body");
    }
    if (!autoCreates[0]!.body?.includes("status=PAUSED")) {
      fail("unattended create status", "the unattended create did not ask for PAUSED");
    }
    const autoSettled = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: autoIntentId,
    });
    expectEqual(autoSettled?.status, "succeeded", "the unattended intent settled succeeded");
    expectEqual(
      (autoSettled?.resultReceipt as { adIds?: string[] } | null)?.adIds,
      [AUTO_NEW_AD_ID],
      "durable unattended creation receipt",
    );

    /*
      The whole point of the new authority, read back out of the journal.

      An unattended create must never be readable as an operator's own. The
      row's `source` is this runtime's origin, nobody is named as the requester,
      and the payload the create replayed says it was STAGED by a decision
      rather than confirmed by a person.
    */
    const autoLog = (await readAdsActionLog()).filter(
      (row) => row.launch_intent_id === autoIntentId,
    );
    expectEqual(autoLog.length, 1, "one action-log row for the unattended create");
    const autoLogRow = autoLog[0]!;
    expectEqual(autoLogRow.source, "launchpad_scheduled_v1", "journalled as scheduled");
    expectEqual(autoLogRow.requested_by, null, "nobody requested it");
    const autoLogPayload = autoLogRow.payload_request as Record<string, unknown>;
    expectEqual(
      autoLogPayload.action_origin,
      "launchpad_scheduled_v1",
      "the action origin is the sweep's, not the operator's",
    );
    expectEqual(
      autoLogPayload.staged_execution_authority,
      {
        actionOrigin: "launchpad_decision_staged_v1",
        manualConfirmation: "decision_staged_approval",
      },
      "and it names the staged authority the payload actually carries",
    );
    if ("manual_confirmation" in autoLogPayload) {
      fail(
        "unattended action log",
        `an unattended create claimed manual_confirmation=${String(autoLogPayload.manual_confirmation)}`,
      );
    }
    if (JSON.stringify(autoLogPayload).includes("explicit_operator_confirmation")) {
      fail(
        "unattended action log",
        "an unattended create's journal claims an explicit operator confirmation",
      );
    }
    expectEqual(
      (autoLogPayload.scheduled_authority as Record<string, unknown>)
        .enablingActorUserId,
      USER_ID,
      "the enabling admin is named instead",
    );

    // ---------------------------- 7b. it is PAUSED, and stays that way
    expectEqual(
      provider.state.ads.get(AUTO_NEW_AD_ID)?.status,
      "PAUSED",
      "the unattended create left the ad PAUSED",
    );
    const autoActivationRows = await projectActivationRows();
    expectEqual(autoActivationRows.projected, 1, "an activation row is raised for it");
    const beforeIdleSweep = provider.calls.length;
    const idleSweep = await runScheduledSweep();
    expectEqual(
      { executed: idleSweep.executed, failed: idleSweep.failed },
      { executed: 0, failed: 0 },
      "the sweep does not activate what it created",
    );
    expectEqual(
      provider.calls.slice(beforeIdleSweep).filter((call) => call.method === "POST").length,
      0,
      "and makes no provider write at all",
    );
    expectEqual(
      provider.state.ads.get(AUTO_NEW_AD_ID)?.status,
      "PAUSED",
      "the ad is still paused",
    );
    const pendingActivation = (await readProposals()).find(
      (row) => row.proposed_action === "resume" && row.scope_id === AUTO_NEW_AD_ID,
    );
    expectEqual(
      pendingActivation?.status,
      "pending",
      "the activation row waits for its own approval instead of being destroyed",
    );

    // ------------------------ 7c. the test launch, and a revoked authority
    /*
      The third case in the accepted creative matrix: a `refresh` decision whose
      operator composed a whole new campaign in the wizard. Reuse and winner
      promotion are the same operation aimed at an existing ad set; this one
      creates the campaign, the ad set and the ad, and every one of them PAUSED.
    */
    const testFixture = await seedApprovedDecision({
      creativeId: TEST_CREATIVE_ID,
      sourceAdId: TEST_SOURCE_AD_ID,
      creativeName: "Refresh — hook B",
      label: "refresh",
      briefStatus: "reviewed",
      draftName: "Test launch for the refreshed hook",
      draftPayload: testLaunchDraftPayload(TEST_CREATIVE_ID, TEST_SOURCE_AD_ID),
    });
    const testStaging = await stageIntents();
    expectEqual(testStaging.staged, 1, "the refresh decision stages a test launch");
    const testIntentId = testStaging.stagedIntentIds[0]!;
    const testIntent = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: testIntentId,
    });
    expectEqual(testIntent?.operation, "new_campaign", "staged as a new campaign");
    expectEqual(testIntent?.requestedStatus, "PAUSED", "PAUSED-only invariant");
    expectEqual(
      (testIntent?.requestPayload as { campaign?: { name?: string } })?.campaign?.name,
      "Test · refresh hook B",
      "the campaign is the operator's own, not one composed here",
    );
    const testRows = await projectLaunchRows();
    expectEqual(testRows.projected, 1, "one test-launch row");

    /*
      REVOKED AUTOMATIC AUTHORITY, with the row already staged and queued.

      The operator moves the creative family off `auto` between the queue row
      and the sweep. Nothing may be created, and — just as importantly — the row
      they could still approve by hand must survive: withholding after a claim
      settles a row `failed`, which would destroy it every ten minutes.
    */
    await setCreativeMode("semi_auto");
    const beforeRevokedSweep = provider.calls.length;
    const revokedSweep = await runScheduledSweep();
    expectEqual(
      { executed: revokedSweep.executed, failed: revokedSweep.failed },
      { executed: 0, failed: 0 },
      "a family taken off auto executes nothing",
    );
    expectEqual(
      provider.calls.slice(beforeRevokedSweep).filter((call) => call.method === "POST").length,
      0,
      "and reaches the provider with no write",
    );
    const heldRow = (await readProposals()).find(
      (row) => row.launch_intent_id === testIntentId && row.proposed_action === "launch",
    );
    expectEqual(heldRow?.status, "pending", "the row is held, not destroyed");
    expectEqual(
      (await getMetaLaunchIntent({ businessId: BUSINESS_ID, id: testIntentId }))?.status,
      "prepared",
      "and the intent still rests prepared",
    );

    await setCreativeMode("auto");
    const beforeTestSweep = provider.calls.length;
    const testSweep = await runScheduledSweep();
    expectEqual(
      { executed: testSweep.executed, failed: testSweep.failed, skipped: testSweep.skipped },
      { executed: 1, failed: 0, skipped: null },
      "re-armed, the sweep executes the test launch",
    );
    const testWrites = provider.calls
      .slice(beforeTestSweep)
      .filter((call) => call.method === "POST");
    expectEqual(
      testWrites.map((call) => new URL(call.url).pathname.split("/").slice(2).join("/")),
      [
        `act_${ACCOUNT_NUMERIC}/campaigns`,
        `${TEST_NEW_CAMPAIGN_ID}/adsets`,
        `${TEST_NEW_ADSET_ID}/ads`,
      ],
      "campaign, ad set and ad — each created exactly once, in order",
    );
    expectEqual(
      [
        provider.state.campaigns.get(TEST_NEW_CAMPAIGN_ID)?.status,
        provider.state.adsets.get(TEST_NEW_ADSET_ID)?.status,
        provider.state.ads.get(TEST_NEW_AD_ID)?.status,
      ],
      ["PAUSED", "PAUSED", "PAUSED"],
      "the whole new hierarchy is PAUSED; activating it is a separate decision",
    );
    const testSettled = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: testIntentId,
    });
    expectEqual(testSettled?.status, "succeeded", "the test launch settled succeeded");
    expectEqual(
      (testSettled?.resultReceipt as { campaignId?: string; adsetIds?: string[]; adIds?: string[] } | null)
        ?.adIds,
      [TEST_NEW_AD_ID],
      "durable identities for the created ad",
    );
    const testLog = (await readAdsActionLog()).filter(
      (row) => row.launch_intent_id === testIntentId,
    );
    if (testLog.length === 0) fail("test launch log", "nothing was journalled");
    testLog.forEach((row) => {
      expectEqual(row.source, "launchpad_scheduled_v1", "test launch journalled as scheduled");
      expectEqual(row.requested_by, null, "nobody requested the test launch");
      const payload = row.payload_request as Record<string, unknown>;
      expectEqual(
        payload.staged_execution_authority,
        {
          actionOrigin: "launchpad_decision_staged_v1",
          manualConfirmation: "decision_staged_approval",
        },
        "the test launch names the staged authority",
      );
    });

    // ------------------------------------------ 7d. missing approval
    /*
      A decision the engine published, an asset in the account, an operator who
      composed the exact destination — and a brief nobody reviewed. That is one
      approval short, and it must reach no provider.
    */
    const missingFixture = await seedApprovedDecision({
      creativeId: MISSING_CREATIVE_ID,
      sourceAdId: MISSING_SOURCE_AD_ID,
      creativeName: "Unapproved",
      label: "scale",
      briefStatus: "draft",
      draftName: "A launch whose brief nobody reviewed",
      draftPayload: reuseDraftPayload(MISSING_CREATIVE_ID, MISSING_SOURCE_AD_ID),
    });
    const beforeMissing = provider.calls.length;
    const missingStaging = await stageIntents();
    expectEqual(missingStaging.staged, 0, "an unreviewed brief stages nothing");
    expectEqual(
      missingStaging.refusals.creative_brief_not_reviewed,
      1,
      "and is refused by name",
    );
    expectEqual(
      provider.calls.slice(beforeMissing).filter((call) => call.method === "POST").length,
      0,
      "with zero provider writes",
    );
    expectEqual(
      (await readIntents()).some(
        (row) => row.snapshot_id === missingFixture.snapshotId,
      ),
      false,
      "and no intent for it at all",
    );

    // ------------------------------------------ 7e. revoked approval
    /*
      The same decision, fully approved and then UN-approved.

      It is first shown to be a real candidate — reviewed brief, composed draft —
      so the refusal below is a consequence of the revocation and not of a
      fixture that was never eligible. Both revocations go through the shipped
      writers: `patchMetaCreativeBrief` moves the brief off `reviewed` (which
      clears `reviewed_by` and `reviewed_at` by its own SQL), and
      `deleteMetaLaunchDraft` withdraws the composed destination.
    */
    const revokedFixture = await seedApprovedDecision({
      creativeId: REVOKED_CREATIVE_ID,
      sourceAdId: REVOKED_SOURCE_AD_ID,
      creativeName: "Revoked",
      label: "scale",
      briefStatus: "reviewed",
      draftName: "A launch whose approvals are about to be withdrawn",
      draftPayload: reuseDraftPayload(REVOKED_CREATIVE_ID, REVOKED_SOURCE_AD_ID),
    });
    const eligibleBefore = (await listStageableLaunchDecisions(BUSINESS_ID, SNAPSHOT_DATE)).find(
      (row) => row.snapshotId === revokedFixture.snapshotId,
    );
    expectEqual(
      {
        briefStatus: eligibleBefore?.briefStatus,
        reviewed: Boolean(eligibleBefore?.briefReviewedBy),
        composed: Boolean(eligibleBefore?.draftId),
      },
      { briefStatus: "reviewed", reviewed: true, composed: true },
      "the decision really was fully approved before the revocation",
    );

    await patchMetaCreativeBrief({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      id: revokedFixture.briefId,
      patch: parsePatchMetaCreativeBriefRequest({
        expectedVersion: revokedFixture.briefVersion,
        status: "draft",
      }),
      updatedBy: USER_ID,
    });
    await deleteMetaLaunchDraft({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      id: revokedFixture.draftId!,
    });

    const beforeRevoked = provider.calls.length;
    const revokedStaging = await stageIntents();
    expectEqual(revokedStaging.staged, 0, "a revoked approval stages nothing");
    expectEqual(
      revokedStaging.refusals.creative_brief_not_reviewed,
      2,
      "the revoked brief is refused by the same name as the never-reviewed one",
    );
    expectEqual(
      provider.calls.slice(beforeRevoked).filter((call) => call.method === "POST").length,
      0,
      "with zero provider writes",
    );
    expectEqual(
      (await readIntents()).some(
        (row) => row.snapshot_id === revokedFixture.snapshotId,
      ),
      false,
      "and no intent for the revoked decision",
    );
    /*
      Partial identities preserved honestly: a refusal here must not touch what
      earlier legs really did create.
    */
    expectEqual(
      (await getMetaLaunchIntent({ businessId: BUSINESS_ID, id: autoIntentId }))
        ?.resultReceipt?.adIds,
      [AUTO_NEW_AD_ID],
      "the earlier unattended creation receipt is untouched",
    );
    expectEqual(
      provider.state.ads.get(AUTO_NEW_AD_ID)?.status,
      "PAUSED",
      "and what it created is still exactly where it was",
    );

    // ------------------------------------------ 7f. the unattended rerun
    const postsBeforeRerun = provider.calls.filter(
      (call) => call.method === "POST",
    ).length;
    const intentsBeforeRerun = (await readIntents()).length;
    const rerunStaging = await stageIntents();
    expectEqual(rerunStaging.staged, 0, "the unattended rerun stages no new intent");
    const rerunRows = await projectLaunchRows();
    expectEqual(rerunRows.projected, 0, "and raises no new launch row");
    const rerunSweep = await runScheduledSweep();
    expectEqual(
      { executed: rerunSweep.executed, failed: rerunSweep.failed },
      { executed: 0, failed: 0 },
      "and the sweep has nothing left to execute",
    );
    expectEqual(
      provider.calls.filter((call) => call.method === "POST").length,
      postsBeforeRerun,
      "the unattended rerun made no provider write",
    );
    expectEqual(
      (await readIntents()).length,
      intentsBeforeRerun,
      "and wrote no second intent",
    );

    // ------------------------------------------ 7g. manual still refuses
    await setCreativeMode("manual");
    const manualStaging = await stageIntents();
    expectEqual(
      {
        staged: manualStaging.staged,
        candidates: manualStaging.candidates,
        refusals: manualStaging.refusals,
      },
      { staged: 0, candidates: 0, refusals: { creative_mode_manual: 1 } },
      "the manual creative mode still refuses by name and stages nothing",
    );
    await setCreativeMode("auto");
    expectEqual(
      autoFixture.snapshotId !== testFixture.snapshotId,
      true,
      "the unattended chapter really used two distinct decisions",
    );

    // ============================================================
    // 8. THE APPROVAL WITHDRAWN AFTER THE INTENT WAS STAGED
    // ============================================================
    /*
      7d and 7e withdraw an approval before anything is staged, which the
      producer's candidate query sees for itself. The interval those two do not
      cover is the one BETWEEN the staging and the provider POST.

      An intent stores the brief's ID, not its status, so every immutability
      check on the way to a create — the account, the operation, the idempotency
      key, the request fingerprint, the four lineage ids — still matches after
      the brief has been moved off `reviewed`. Nothing re-asked whether the
      approval those ids point at still stood.
    */

    // ---------------- 8a. withdrawn after staging, before the sweep
    const stagedWithdrawal = await seedApprovedDecision({
      creativeId: STAGED_WITHDRAWAL_CREATIVE_ID,
      sourceAdId: STAGED_WITHDRAWAL_SOURCE_AD_ID,
      creativeName: "Withdrawn after staging",
      label: "scale",
      briefStatus: "reviewed",
      draftName: "A launch whose brief is withdrawn once it is already staged",
      draftPayload: reuseDraftPayload(
        STAGED_WITHDRAWAL_CREATIVE_ID,
        STAGED_WITHDRAWAL_SOURCE_AD_ID,
      ),
    });
    const stagedWithdrawalStaging = await stageIntents();
    expectEqual(
      stagedWithdrawalStaging.staged,
      1,
      "the fully approved decision stages, so the refusal below is the withdrawal's",
    );
    const withdrawnIntentId = stagedWithdrawalStaging.stagedIntentIds[0]!;
    expectEqual(
      (await projectLaunchRows()).projected,
      1,
      "and its launch row is raised",
    );

    await revokeBriefReview({
      briefId: stagedWithdrawal.briefId,
      version: stagedWithdrawal.briefVersion,
    });

    const beforeWithdrawnSweep = provider.calls.length;
    const withdrawnSweep = await runScheduledSweep();
    expectEqual(
      postPaths(provider.calls.slice(beforeWithdrawnSweep)),
      [],
      "a launch whose approval was withdrawn after staging reaches the provider with no write",
    );
    /*
      And no provider request about this launch at all, not merely no write.

      A withdrawal already committed before the sweep is caught where the
      sequence FIRST asks — in `prepareMetaLaunchIntentForExecution`, ahead of
      the write-context resolution, the validation and the preflight. The only
      call the sweep still makes is the account context every tick loads before
      it routes anything, which belongs to no particular row.
    */
    expectEqual(
      provider.calls
        .slice(beforeWithdrawnSweep)
        .filter((call) => !call.url.includes(`act_${ACCOUNT_NUMERIC}?`))
        .map((call) => `${call.method} ${new URL(call.url).pathname}`),
      [],
      "and reads nothing about this launch either",
    );
    expectEqual(
      { executed: withdrawnSweep.executed, skipped: withdrawnSweep.skipped },
      { executed: 0, skipped: null },
      "and the sweep executed nothing",
    );
    const withdrawnRow = await readLaunchRowFor(withdrawnIntentId);
    expectEqual(
      withdrawnRow?.status,
      "failed",
      "the queue row is settled rather than left dangling",
    );
    expectEqual(
      receiptErrorCode(withdrawnRow?.receipt_json),
      "creative_brief_not_reviewed",
      "and the receipt names the approval that was withdrawn",
    );
    expectEqual(
      withdrawnRow?.receipt_json?.providerMutationAttempted,
      false,
      "a refused-authority row is not reported as a provider contact",
    );
    const withdrawnIntent = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: withdrawnIntentId,
    });
    expectEqual(
      [withdrawnIntent?.status, withdrawnIntent?.validationReceipt],
      ["prepared", null],
      "and the intent is refused rather than consumed — still prepared, still unvalidated",
    );

    // --------------- 8b. withdrawn INSIDE the preflight, before the first POST
    /*
      The interval the once-before-the-sequence read cannot cover.

      8a's revocation lands before the sweep, so the check inside
      `prepareMetaLaunchIntentForExecution` sees it. This one lands after that
      check has already passed: the sweep has read its gates, prepared the
      intent, resolved the write context and is in the middle of the fresh
      provider preflight when the operator un-reviews the brief. Only a re-read
      taken after the preflight can still prevent the create — and WHERE it is
      taken decides what the refusal costs, which is 8c below.

      The revocation is placed there by the provider double — it fires when the
      preflight's own read of the source ad is answered — because nothing else
      can put a committed write inside a single `await`.
    */
    const preflightWithdrawal = await seedApprovedDecision({
      creativeId: PREFLIGHT_WITHDRAWAL_CREATIVE_ID,
      sourceAdId: PREFLIGHT_WITHDRAWAL_SOURCE_AD_ID,
      creativeName: "Withdrawn during preflight",
      label: "scale",
      briefStatus: "reviewed",
      draftName: "A launch whose brief is withdrawn while the preflight runs",
      draftPayload: reuseDraftPayload(
        PREFLIGHT_WITHDRAWAL_CREATIVE_ID,
        PREFLIGHT_WITHDRAWAL_SOURCE_AD_ID,
      ),
    });
    const preflightStaging = await stageIntents();
    expectEqual(preflightStaging.staged, 1, "the preflight case stages while approved");
    const preflightIntentId = preflightStaging.stagedIntentIds[0]!;
    expectEqual((await projectLaunchRows()).projected, 1, "and raises its launch row");

    let withdrewInsidePreflight = false;
    let preflightWithdrawnVersion = 0;
    provider.armWhen(
      (call) =>
        call.method === "GET"
        && call.url.includes(PREFLIGHT_WITHDRAWAL_SOURCE_AD_ID),
      async () => {
        const withdrawn = await revokeBriefReview({
          briefId: preflightWithdrawal.briefId,
          version: preflightWithdrawal.briefVersion,
        });
        preflightWithdrawnVersion = withdrawn.version;
        withdrewInsidePreflight = true;
      },
    );
    const beforePreflightSweep = provider.calls.length;
    await runScheduledSweep();
    expectEqual(
      withdrewInsidePreflight,
      true,
      "the revocation really landed inside the sweep's own provider preflight",
    );
    expectEqual(
      postPaths(provider.calls.slice(beforePreflightSweep)),
      [],
      "an approval withdrawn during the preflight still reaches no provider write",
    );
    const preflightRow = await readLaunchRowFor(preflightIntentId);
    expectEqual(preflightRow?.status, "failed", "its queue row is settled too");
    expectEqual(
      receiptErrorCode(preflightRow?.receipt_json),
      "creative_brief_not_reviewed",
      "and names the withdrawn approval rather than a gate nobody closed",
    );
    expectEqual(
      preflightRow?.receipt_json?.providerMutationAttempted,
      false,
      "with no provider contact claimed",
    );
    /*
      And the INTENT is exactly where the sweep found it.

      This is the half that decides whether the refusal above was a save or a
      trap. `recordMetaLaunchIntentValidation` moves an intent `prepared ->
      ready`, and `prepared` is the only state any caller may start a create
      from — so a refusal taken after that write leaves a launch that reached
      no provider and can never be run again either. The question is asked once
      more immediately before that write for this reason: nothing was recorded,
      nothing moved, and 8c is what that is worth.
    */
    const strandedIntent = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: preflightIntentId,
    });
    expectEqual(
      [
        strandedIntent?.status,
        strandedIntent?.startedAt,
        strandedIntent?.validationReceipt,
      ],
      ["prepared", null, null],
      "the refused intent is left prepared, unstarted and unvalidated",
    );

    // ---------------- 8c. and the launch it refused is still runnable after
    /*
      The operator un-reviewed the brief by accident, and re-reviews it.

      Nothing in the queue brings a settled row back — a claimed row is always
      settled, by contract — so recovery is the operator running the same
      launch again from Launchpad, through the handler their own screen posts
      to, with the intent the producer staged. It has to complete: one provider
      ad, PAUSED, under the SAME intent rather than a replacement one, because
      the producer will never stage a replacement for a decision it has already
      staged.

      Both authorities stay distinguishable through the recovery: the payload
      still carries the producer's `decision_staged_approval`, and the action
      log records the operator who ran it. Neither is invented from the other.
    */
    const rereviewed = await patchMetaCreativeBrief({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      id: preflightWithdrawal.briefId,
      patch: parsePatchMetaCreativeBriefRequest({
        expectedVersion: preflightWithdrawnVersion,
        status: "reviewed",
      }),
      updatedBy: USER_ID,
    });
    expectEqual(rereviewed.status, "reviewed", "the operator re-reviews that brief");

    const recoveryIntent = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: preflightIntentId,
    });
    const recoveryRequest = new NextRequest(
      new URL(
        "/api/launchpad/meta/add-to-existing",
        "http://localhost",
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: `${AUTH_COOKIE}=${fixture.token}`,
        },
        // The stored payload, replayed field for field. Anything composed here
        // would be refused as `launch_intent_contract_mismatch`, because the
        // fingerprint is taken over the whole payload.
        body: JSON.stringify({
          actionOrigin: "launchpad_manual_v1",
          manualConfirmation: "explicit_operator_confirmation",
          businessId: BUSINESS_ID,
          providerAccountId: ACCOUNT_ID,
          idempotencyKey: recoveryIntent?.idempotencyKey,
          launchIntentId: preflightIntentId,
          ...(recoveryIntent?.requestPayload as Record<string, unknown>),
        }),
      },
    );
    const beforeRecovery = provider.calls.length;
    const recoveryResponse = await handleMetaAddToExistingAction(recoveryRequest);
    const recoveryBody = (await recoveryResponse.json().catch(() => null)) as
      | { ok?: boolean }
      | null;
    if (recoveryResponse.status !== 200 || recoveryBody?.ok !== true) {
      fail(
        "withdrawal recovery",
        JSON.stringify({ status: recoveryResponse.status, body: recoveryBody }),
      );
    }
    expectEqual(
      postPaths(provider.calls.slice(beforeRecovery)),
      [`act_${ACCOUNT_NUMERIC}/ads`],
      "the re-run creates exactly one provider ad",
    );
    const recovered = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: preflightIntentId,
    });
    expectEqual(
      recovered?.status,
      "succeeded",
      "the SAME intent settles succeeded, without a replacement being staged",
    );
    expectEqual(
      (recovered?.resultReceipt as { adIds?: string[] } | null)?.adIds,
      [PREFLIGHT_WITHDRAWAL_NEW_AD_ID],
      "with the durable identity of the ad the recovery created",
    );
    expectEqual(
      provider.state.ads.get(PREFLIGHT_WITHDRAWAL_NEW_AD_ID)?.status,
      "PAUSED",
      "and it is PAUSED, as every launch is",
    );
    expectEqual(
      (recovered?.resultReceipt as { executionAuthority?: unknown } | null)
        ?.executionAuthority,
      {
        actionOrigin: "launchpad_decision_staged_v1",
        manualConfirmation: "decision_staged_approval",
      },
      "the payload still carries the approval it was staged under",
    );
    const recoveryLog = (await readAdsActionLog()).filter(
      (row) => row.launch_intent_id === preflightIntentId,
    );
    expectEqual(recoveryLog.length, 1, "one action-log row for the recovered create");
    const recoveryLogPayload = recoveryLog[0]!.payload_request as Record<
      string,
      unknown
    >;
    expectEqual(
      [recoveryLogPayload.action_origin, recoveryLogPayload.manual_confirmation],
      ["launchpad_manual_v1", "explicit_operator_confirmation"],
      "and an operator really ran it, which is what recovery is",
    );

    // ------------- 8d. withdrawn AFTER the first POST of a three-POST create
    /*
      A test launch is a campaign, then an ad set, then an ad. The withdrawal
      lands once the campaign exists.

      What must be true is all three at once: nothing below the campaign is
      created, the campaign that DOES exist is reported and persisted, and the
      intent settles `partially_succeeded` rather than claiming either a clean
      success or a clean refusal.
    */
    const midSequence = await seedApprovedDecision({
      creativeId: MIDSEQUENCE_CREATIVE_ID,
      sourceAdId: MIDSEQUENCE_SOURCE_AD_ID,
      creativeName: "Withdrawn mid-sequence",
      label: "refresh",
      briefStatus: "reviewed",
      draftName: "A test launch whose brief is withdrawn after the campaign exists",
      draftPayload: testLaunchDraftPayload(
        MIDSEQUENCE_CREATIVE_ID,
        MIDSEQUENCE_SOURCE_AD_ID,
        { campaign: "Test · mid-sequence hook C", adSet: "Test · mid-sequence broad" },
      ),
    });
    const midStaging = await stageIntents();
    expectEqual(midStaging.staged, 1, "the mid-sequence case stages while approved");
    const midIntentId = midStaging.stagedIntentIds[0]!;
    expectEqual((await projectLaunchRows()).projected, 1, "and raises its launch row");

    let withdrewAfterFirstPost = false;
    provider.armWhen(
      (call) =>
        call.method === "POST"
        && call.url.includes(`act_${ACCOUNT_NUMERIC}/campaigns`),
      async () => {
        await revokeBriefReview({
          briefId: midSequence.briefId,
          version: midSequence.briefVersion,
        });
        withdrewAfterFirstPost = true;
      },
    );
    const beforeMidSweep = provider.calls.length;
    await runScheduledSweep();
    expectEqual(
      withdrewAfterFirstPost,
      true,
      "the revocation really landed after the campaign create was answered",
    );
    expectEqual(
      postPaths(provider.calls.slice(beforeMidSweep)),
      [`act_${ACCOUNT_NUMERIC}/campaigns`],
      "the campaign is created and every POST below it is withheld",
    );
    expectEqual(
      provider.state.campaigns.get(MIDSEQUENCE_NEW_CAMPAIGN_ID)?.status,
      "PAUSED",
      "what did get created is the PAUSED campaign, and nothing else",
    );
    expectEqual(
      provider.state.adsets.has(MIDSEQUENCE_NEW_ADSET_ID),
      false,
      "no ad set was created under it",
    );
    const midSettled = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: midIntentId,
    });
    expectEqual(
      midSettled?.status,
      "partially_succeeded",
      "the intent settles partially_succeeded, honestly",
    );
    expectEqual(
      (midSettled?.resultReceipt as { campaignId?: string | null } | null)?.campaignId,
      MIDSEQUENCE_NEW_CAMPAIGN_ID,
      "the identity that really exists is durable",
    );
    const midError = midSettled?.errorReceipt as
      | { code?: string; message?: string; failedAt?: string }
      | null;
    expectEqual(
      [midError?.code, midError?.failedAt],
      ["provider_mutation_withheld", "adset:1"],
      "and the durable error names the step that was never asked for",
    );
    if (!midError?.message?.includes("creative_brief_not_reviewed")) {
      fail(
        "mid-sequence receipt",
        `the reason did not name the withdrawal: ${String(midError?.message)}`,
      );
    }
    const midRow = await readLaunchRowFor(midIntentId);
    expectEqual(midRow?.status, "failed", "the queue row is settled, not parked");
    expectEqual(
      midRow?.receipt_json?.providerMutationAttempted,
      true,
      "and it reports the provider contact that really happened",
    );

    // ------------------ 8e. an edit that leaves the brief reviewed is not this
    /*
      The other half of the rule, and the one a fix can get wrong by refusing
      everything.

      `patchMetaCreativeBrief` is asked to change the brief's words AND to
      re-state `reviewed`, which is what an operator does when they tidy an
      approval they still stand behind. The status stays `reviewed`, the source
      decision is untouched, and the launch must still run: exactly one PAUSED
      ad, under the staged authority, with no operator confirmation.
    */
    const cosmetic = await seedApprovedDecision({
      creativeId: COSMETIC_CREATIVE_ID,
      sourceAdId: COSMETIC_SOURCE_AD_ID,
      creativeName: "Edited but still reviewed",
      label: "scale",
      briefStatus: "reviewed",
      draftName: "A launch whose brief is edited and re-reviewed",
      draftPayload: reuseDraftPayload(COSMETIC_CREATIVE_ID, COSMETIC_SOURCE_AD_ID),
    });
    const cosmeticStaging = await stageIntents();
    expectEqual(cosmeticStaging.staged, 1, "the edited-but-reviewed case stages");
    const cosmeticIntentId = cosmeticStaging.stagedIntentIds[0]!;
    expectEqual((await projectLaunchRows()).projected, 1, "and raises its launch row");

    const editedBrief = await patchMetaCreativeBrief({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      id: cosmetic.briefId,
      patch: parsePatchMetaCreativeBriefRequest({
        expectedVersion: cosmetic.briefVersion,
        content: { keep: "Keep the opening frame — tightened wording" },
        status: "reviewed",
      }),
      updatedBy: USER_ID,
    });
    expectEqual(
      [editedBrief.status, editedBrief.version > cosmetic.briefVersion],
      ["reviewed", true],
      "the brief really was edited and really is still reviewed",
    );

    const beforeCosmeticSweep = provider.calls.length;
    const cosmeticSweep = await runScheduledSweep();
    expectEqual(
      { executed: cosmeticSweep.executed, failed: cosmeticSweep.failed },
      { executed: 1, failed: 0 },
      "an edit that kept the review does not stop the launch",
    );
    expectEqual(
      postPaths(provider.calls.slice(beforeCosmeticSweep)),
      [`act_${ACCOUNT_NUMERIC}/ads`],
      "and it is exactly one provider ad create",
    );
    const cosmeticSettled = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: cosmeticIntentId,
    });
    expectEqual(cosmeticSettled?.status, "succeeded", "the intent settled succeeded");
    const cosmeticAdIds =
      (cosmeticSettled?.resultReceipt as { adIds?: string[] } | null)?.adIds ?? [];
    expectEqual(cosmeticAdIds.length, 1, "one durable created identity");
    expectEqual(
      provider.state.ads.get(cosmeticAdIds[0]!)?.status,
      "PAUSED",
      "and what it created is PAUSED, as every launch is",
    );
    const cosmeticLog = (await readAdsActionLog()).filter(
      (row) => row.launch_intent_id === cosmeticIntentId,
    );
    expectEqual(cosmeticLog.length, 1, "one action-log row for it");
    const cosmeticLogPayload = cosmeticLog[0]!.payload_request as Record<string, unknown>;
    expectEqual(
      [cosmeticLog[0]!.source, cosmeticLog[0]!.requested_by],
      ["launchpad_scheduled_v1", null],
      "journalled as the sweep's own, with nobody named as requester",
    );
    if (JSON.stringify(cosmeticLogPayload).includes("explicit_operator_confirmation")) {
      fail(
        "cosmetic edit action log",
        "an unattended create's journal claims an explicit operator confirmation",
      );
    }

    // ------------------------------ 8f. the rerun after all three refusals
    /*
      A refusal must not become a duplicate on the next tick. Nothing may stage
      a second intent for any of the three withdrawn decisions, and nothing may
      create a second provider entity for the campaign that already exists.
    */
    const postsBeforeWithdrawalRerun = provider.calls.filter(
      (call) => call.method === "POST",
    ).length;
    const intentsBeforeWithdrawalRerun = (await readIntents()).length;
    const adsBeforeWithdrawalRerun = provider.state.ads.size;
    const withdrawalRerunStaging = await stageIntents();
    expectEqual(
      withdrawalRerunStaging.staged,
      0,
      "the rerun stages no second intent for a withdrawn approval",
    );
    expectEqual(
      (await projectLaunchRows()).projected,
      0,
      "and raises no second launch row",
    );
    const withdrawalRerunSweep = await runScheduledSweep();
    expectEqual(
      { executed: withdrawalRerunSweep.executed, failed: withdrawalRerunSweep.failed },
      { executed: 0, failed: 0 },
      "and the sweep has nothing left to execute",
    );
    expectEqual(
      [
        provider.calls.filter((call) => call.method === "POST").length,
        (await readIntents()).length,
        provider.state.ads.size,
      ],
      [
        postsBeforeWithdrawalRerun,
        intentsBeforeWithdrawalRerun,
        adsBeforeWithdrawalRerun,
      ],
      "no second provider write, no second intent, no second entity",
    );
    expectEqual(
      (await getMetaLaunchIntent({ businessId: BUSINESS_ID, id: midIntentId }))
        ?.resultReceipt?.campaignId,
      MIDSEQUENCE_NEW_CAMPAIGN_ID,
      "and the partial identity from the interrupted launch is still exactly where it was",
    );

    // ==================================================================
    // 9. THE SAME BOUNDARY, ON THE ARM AN OPERATOR APPROVES A ROW THROUGH
    // ==================================================================
    /*
      Chapter 8 is the unattended arm. This is the attended one, and it had the
      coverage 8b proves insufficient: `executeMetaAutomationProposal` handed
      the Launchpad handler the dispatch marker alone, so the only approval read
      on that path was the one inside `prepareMetaLaunchIntentForExecution` —
      taken before the write context, the validation and a live provider
      preflight, and then relied on for three or more POSTs.

      A test launch is a campaign, then an ad set, then an ad. The operator
      approves the row, and the brief is un-reviewed the moment the campaign
      create is answered. What must be true is what 8d proved for the sweep:
      the campaign exists and is reported, nothing below it is created, and the
      intent settles partially_succeeded rather than claiming either outcome.
    */
    const manualMidSequence = await seedApprovedDecision({
      creativeId: MANUAL_MIDSEQUENCE_CREATIVE_ID,
      sourceAdId: MANUAL_MIDSEQUENCE_SOURCE_AD_ID,
      creativeName: "Withdrawn mid-sequence, operator-approved",
      label: "refresh",
      briefStatus: "reviewed",
      draftName: "A test launch an operator approves, withdrawn after its campaign",
      draftPayload: testLaunchDraftPayload(
        MANUAL_MIDSEQUENCE_CREATIVE_ID,
        MANUAL_MIDSEQUENCE_SOURCE_AD_ID,
        { campaign: "Test · approved hook D", adSet: "Test · approved broad" },
      ),
    });
    const approvedArmStaging = await stageIntents();
    expectEqual(
      approvedArmStaging.staged,
      1,
      "the operator-approved case stages while approved",
    );
    const manualIntentId = approvedArmStaging.stagedIntentIds[0]!;
    expectEqual((await projectLaunchRows()).projected, 1, "and raises its launch row");
    const manualRowBefore = await readLaunchRowFor(manualIntentId);

    let withdrewAfterManualFirstPost = false;
    provider.armWhen(
      (call) =>
        call.method === "POST"
        && call.url.includes(`act_${ACCOUNT_NUMERIC}/campaigns`),
      async () => {
        await revokeBriefReview({
          briefId: manualMidSequence.briefId,
          version: manualMidSequence.briefVersion,
        });
        withdrewAfterManualFirstPost = true;
      },
    );
    const beforeManualApproval = provider.calls.length;
    const manualApproval = await approveProposal({
      token: fixture.token,
      proposalId: String(manualRowBefore?.id),
    });
    expectEqual(
      withdrewAfterManualFirstPost,
      true,
      "the revocation really landed after the operator's own campaign create",
    );
    /*
      The route's own `ok` is about the REQUEST — it answers with the refreshed
      queue — so the launch's outcome is read from the row it settled.
    */
    expectEqual(manualApproval.status, 200, "the approve request itself is answered");
    expectEqual(
      postPaths(provider.calls.slice(beforeManualApproval)),
      [`act_${ACCOUNT_NUMERIC}/campaigns`],
      "the campaign is created and every POST below it is withheld",
    );
    expectEqual(
      provider.state.adsets.has(MANUAL_MIDSEQUENCE_NEW_ADSET_ID),
      false,
      "no ad set was created under it",
    );
    const manualSettled = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: manualIntentId,
    });
    expectEqual(
      manualSettled?.status,
      "partially_succeeded",
      "the intent settles partially_succeeded, honestly",
    );
    expectEqual(
      (manualSettled?.resultReceipt as { campaignId?: string | null } | null)
        ?.campaignId,
      MANUAL_MIDSEQUENCE_NEW_CAMPAIGN_ID,
      "the identity that really exists is durable",
    );
    const manualError = manualSettled?.errorReceipt as
      | { code?: string; message?: string; failedAt?: string }
      | null;
    expectEqual(
      [manualError?.code, manualError?.failedAt],
      ["provider_mutation_withheld", "adset:1"],
      "and the durable error names the step that was never asked for",
    );
    if (!manualError?.message?.includes("creative_brief_not_reviewed")) {
      fail(
        "operator-approved mid-sequence receipt",
        `the reason did not name the withdrawal: ${String(manualError?.message)}`,
      );
    }
    /*
      And the operator's own authority is untouched by the check that refused.
      The row was approved with an explicit confirmation, and the campaign that
      DID get created is journalled under it.
    */
    const manualLogRows = (await readAdsActionLog()).filter(
      (row) => row.launch_intent_id === manualIntentId,
    );
    if (manualLogRows.length === 0) {
      fail("operator-approved mid-sequence log", "the campaign create was not journalled");
    }
    const manualLogFirst = manualLogRows[0]!.payload_request as Record<string, unknown>;
    expectEqual(
      [manualLogFirst.action_origin, manualLogFirst.manual_confirmation],
      ["launchpad_manual_v1", "explicit_operator_confirmation"],
      "the arm's own authority is unchanged: an operator confirmed this launch",
    );
    const manualRowAfter = await readLaunchRowFor(manualIntentId);
    expectEqual(manualRowAfter?.status, "failed", "the queue row is settled, not parked");
    expectEqual(
      [
        manualRowAfter?.receipt_json?.httpStatus,
        (manualRowAfter?.receipt_json?.response as Record<string, unknown> | null)
          ?.withheldReason,
      ],
      [409, "creative_brief_not_reviewed"],
      "and its receipt names the withdrawal that stopped the rest of the launch",
    );

    log(
      "PASS: an eligible decision with a reviewed brief and an operator-composed draft "
      + "stages one PAUSED launch intent, raises one launch row, creates exactly one "
      + "provider ad through the real approval route, activates it through a separate "
      + "approval, and reruns to no second intent, no second row and no second ad; "
      + "an approval missing its destination stages nothing and says which one is missing. "
      + "Under the AUTO creative mode the same producer stages under its own "
      + "launchpad_decision_staged_v1 authority, the sweep creates one PAUSED ad and one "
      + "PAUSED test-launch hierarchy with no operator confirmation anywhere in the "
      + "journal, activation still waits for its own approval, a family taken off auto "
      + "and a missing or revoked approval each reach the provider with zero writes, and "
      + "the rerun duplicates neither an intent nor a provider entity. "
      + "An approval WITHDRAWN after the intent was already staged reaches no "
      + "provider either — before the sweep, inside the sweep's own preflight, "
      + "and after the first POST of a three-POST create, where the campaign "
      + "that exists stays reported and the intent settles partially_succeeded. "
      + "A refusal that reached no provider leaves the intent prepared, "
      + "unstarted and unvalidated, so re-reviewing the brief and re-running the "
      + "SAME launch from Launchpad completes it — one PAUSED ad, the producer's "
      + "staged approval still on the payload and the operator's own "
      + "confirmation in the journal. A brief that was edited and re-reviewed "
      + "still launches; and the rerun after all three refusals duplicates "
      + "nothing. The same boundary binds on the arm an OPERATOR approves a "
      + "queue row through: a brief un-reviewed the moment that launch's "
      + "campaign create is answered leaves the campaign reported and every "
      + "POST below it unmade, with the operator's own confirmation still the "
      + "authority on the row.",
    );
  } finally {
    provider.restore();
  }
  resetDbClientCache();
}

main().catch((error) => {
  console.error(error);
  try {
    resetDbClientCache();
  } catch {
    // Best-effort cleanup after the original seam failure.
  }
  process.exitCode = 1;
});
