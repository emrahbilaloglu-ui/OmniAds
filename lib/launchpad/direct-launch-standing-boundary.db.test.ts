import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

/**
 * The DIRECT Launchpad create routes, and the approval standing they never
 * re-asked.
 *
 * `app/api/launchpad/meta/launch/route.ts` and its add-to-existing sibling call
 * their shared handler with no options at all. Until the composition this file
 * pins, `options.beforeProviderMutation` was therefore `undefined` all the way
 * down to `askProviderMutationBoundary`, whose first line answered `allowed`
 * for an absent hook — so on the operator's own path the campaign POST, the ad
 * set POST and every ad POST below it ran under an approval that was read once,
 * before the write context, the validation and a live provider preflight. An
 * operator who un-reviewed the brief in any of those gaps had the rest of their
 * launch built anyway.
 *
 * WHY MOST OF THESE CASES DRIVE THE ROUTES AND INJECT NOTHING. A test that
 * supplies its own `beforeProviderMutation` proves something about a caller
 * that passes one; it cannot prove anything about a production route that
 * passes none. FIVE of the seven cases below call the exported `POST` of the
 * real route module, exactly as Next.js does, and the withdrawal is written by
 * the shipped `patchMetaCreativeBrief` at a chosen point in a live provider
 * sequence.
 *
 * The remaining TWO call `handleMetaLaunchAction` directly WITH an injected
 * hook, and they say so at their own describe block: they exist to prove the
 * composition — that a caller's own boundary is asked in addition to the
 * mandatory standing read, not instead of it — which is the one thing a route
 * passing no options cannot exercise. Saying "every case" here would be the
 * kind of comment that outlives its truth.
 *
 * WHY A REAL DATABASE. The whole question is whether the CURRENT rows still
 * say the brief is reviewed. The intent stores the brief's id, not its status;
 * `patchMetaCreativeBrief` is an UPDATE; `readMetaLaunchIntentApprovalStanding`
 * is a SELECT through the same verifier `createMetaLaunchIntent` used. Mocking
 * either side would replace the fact under test with a value handed to it.
 *
 * HOW IT RUNS. A parent harness boots a throwaway PostgreSQL cluster on a
 * random free port (never 5432, the local volume; never 15432, the production
 * tunnel), migrates it from zero with the repo's own entry point, points
 * `DATABASE_URL` at it and sets `ADSECUTE_EPHEMERAL_DB_SEAM=1`. Without that
 * flag every case SKIPS rather than run against whatever `DATABASE_URL`
 * happens to be — which, in this working copy, is production over an SSH
 * tunnel. A skip is not a pass; the harness is what turns it into one.
 *
 * Real provider writes performed: zero. `globalThis.fetch` is replaced for the
 * duration of the file with an in-process double that refuses any request that
 * is not a Graph API call.
 */

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

if (SEAM && (DATABASE_URL.includes(":15432") || DATABASE_URL.includes(":5432"))) {
  throw new Error(
    "direct launch standing seam refused: DATABASE_URL points at a protected port",
  );
}

const suite = SEAM ? describe : describe.skip;

const AUTH_COOKIE = "omniads_session";
const USER_ID = "c3b10000-0000-4000-8000-0000000000a1";
const BUSINESS_ID = "c3b10000-0000-4000-8000-0000000000b1";
const ACCOUNT_ID = "act_3091000000001";
const ACCOUNT_NUMERIC = ACCOUNT_ID.replace(/^act_/, "");
const ACCESS_TOKEN = "seam-token-direct-launch-standing";
const PIXEL_ID = "3091000009001";
const AS_OF = "2026-09-05";

/** The live destinations an add-to-existing launch aims at. */
const TARGET_CAMPAIGN_ID = "3091000000601";
const TARGET_ADSET_A = "3091000000701";
const TARGET_ADSET_B = "3091000000702";

/**
 * The staged approval a producer writes, kept distinguishable from an
 * operator's own confirmation.
 *
 * The payload carries `launchpad_decision_staged_v1` /
 * `decision_staged_approval`; the REQUEST carries the operator's
 * `launchpad_manual_v1` / `explicit_operator_confirmation`. That is exactly the
 * shape of an operator running a producer-staged launch from Launchpad, and
 * nothing here invents one authority from the other.
 */
const STAGED_AUTHORITY = {
  actionOrigin: "launchpad_decision_staged_v1",
  manualConfirmation: "decision_staged_approval",
} as const;

type Recorded = { method: string; url: string; body: string | null };

type ProviderState = {
  /** Source ads the account already holds: id -> its creative and name. */
  sourceAds: Map<string, { creativeId: string; name: string }>;
  campaigns: Map<string, { name: string; status: string; objective: string }>;
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
  ads: Map<
    string,
    { adsetId: string; campaignId: string; creativeId: string; name: string; status: string }
  >;
  /** `${adsetId}:${creativeId}` -> adId. A repeat here is a duplicated ad. */
  adSlots: Map<string, string>;
  /** Campaign name -> id. A repeat is a duplicated campaign. */
  campaignSlots: Map<string, string>;
  /** `${campaignId}:${name}` -> id. A repeat is a duplicated ad set. */
  adsetSlots: Map<string, string>;
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

/** The POST paths, in order, as `act_x/ads`, `<campaign>/adsets`, … */
function postPaths(calls: Recorded[]) {
  return calls
    .filter((call) => call.method === "POST")
    .map((call) => new URL(call.url).pathname.split("/").slice(2).join("/"));
}

suite("direct Launchpad create routes — mandatory approval standing", () => {
  let getDb: typeof import("@/lib/db").getDb;
  let closeDb: (() => Promise<void>) | null = null;
  let createSession: typeof import("@/lib/auth").createSession;
  let createMetaCreativeBrief: typeof import("@/lib/meta/creative-brief-store").createMetaCreativeBrief;
  let patchMetaCreativeBrief: typeof import("@/lib/meta/creative-brief-store").patchMetaCreativeBrief;
  let parseCreateMetaCreativeBriefRequest: typeof import("@/lib/meta/creative-brief-contract").parseCreateMetaCreativeBriefRequest;
  let parsePatchMetaCreativeBriefRequest: typeof import("@/lib/meta/creative-brief-contract").parsePatchMetaCreativeBriefRequest;
  let createMetaLaunchIntent: typeof import("@/lib/launchpad/meta-launch-intent-store").createMetaLaunchIntent;
  let getMetaLaunchIntent: typeof import("@/lib/launchpad/meta-launch-intent-store").getMetaLaunchIntent;
  let normalizeMetaLaunchPayload: typeof import("@/lib/launchpad/meta").normalizeMetaLaunchPayload;
  let normalizeMetaAddToExistingPayload: typeof import("@/lib/launchpad/meta").normalizeMetaAddToExistingPayload;
  let bindMetaLaunchExecutionAuthorityToPayload: typeof import("@/lib/launchpad/meta-manual-authority").bindMetaLaunchExecutionAuthorityToPayload;
  let launchPost: (request: NextRequest) => Promise<Response>;
  let addToExistingPost: (request: NextRequest) => Promise<Response>;
  let handleMetaLaunchAction: typeof import("@/lib/launchpad/meta-launch-route-handlers").handleMetaLaunchAction;

  let sessionToken = "";
  let calls: Recorded[] = [];
  let state: ProviderState;
  let armed:
    | { match: (call: Recorded) => boolean; hook: (call: Recorded) => Promise<void> }
    | null = null;
  let originalFetch: typeof globalThis.fetch;
  let idCounter = 0;

  function nextId(kind: string) {
    idCounter += 1;
    return `309100000${kind}${String(idCounter).padStart(3, "0")}`;
  }

  /**
   * Run something the moment a chosen provider call has been ANSWERED.
   *
   * The withdrawal has to land at an exact point of a live sequence — after the
   * campaign create is answered and before the ad set create is asked for.
   * Nothing else can place it there: the route is one `await`, and a revocation
   * written before or after it would prove a different thing entirely.
   */
  function armWhen(
    match: (call: Recorded) => boolean,
    hook: (call: Recorded) => Promise<void>,
  ) {
    armed = { match, hook };
  }

  function providerPayloadFor(objectId: string): unknown | null {
    const sourceAd = state.sourceAds.get(objectId);
    if (sourceAd) {
      return {
        id: objectId,
        name: sourceAd.name,
        account_id: ACCOUNT_NUMERIC,
        status: "ACTIVE",
        effective_status: "ACTIVE",
        creative: { id: sourceAd.creativeId },
        adset_id: TARGET_ADSET_A,
      };
    }
    for (const ad of state.sourceAds.values()) {
      if (ad.creativeId === objectId) return { id: objectId, account_id: ACCOUNT_NUMERIC };
    }
    if (objectId === TARGET_ADSET_A || objectId === TARGET_ADSET_B) {
      return {
        id: objectId,
        account_id: ACCOUNT_NUMERIC,
        campaign_id: TARGET_CAMPAIGN_ID,
        status: "ACTIVE",
        effective_status: "ACTIVE",
      };
    }
    if (objectId === TARGET_CAMPAIGN_ID) {
      return {
        id: objectId,
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
      const parentCampaignStatus = state.campaigns.get(ad.campaignId)?.status ?? "ACTIVE";
      const parentAdsetStatus = state.adsets.get(ad.adsetId)?.status ?? "ACTIVE";
      return {
        id: objectId,
        name: ad.name,
        account_id: ACCOUNT_NUMERIC,
        status: ad.status,
        effective_status: ad.status,
        adset_id: ad.adsetId,
        campaign: {
          id: ad.campaignId,
          status: parentCampaignStatus,
          effective_status: parentCampaignStatus,
        },
        adset: {
          id: ad.adsetId,
          status: parentAdsetStatus,
          effective_status: parentAdsetStatus,
        },
        creative: { id: ad.creativeId },
      };
    }
    return null;
  }

  /**
   * One created ad, with the duplicate trap that makes a POST count mean
   * something. A second create for the same ad set and creative is answered
   * with a REFUSAL rather than a new id, so a regression that re-entered the
   * matrix shows up as itself instead of as a fresh success.
   */
  function createAdOnDouble(input: {
    adsetId: string;
    creativeId: string;
    body: string | null;
  }) {
    const slot = `${input.adsetId}:${input.creativeId}`;
    if (state.adSlots.has(slot)) {
      return json(
        { error: { code: 100, message: `duplicate ad create for ${slot}` } },
        400,
      );
    }
    const adId = nextId("8");
    const campaignId = state.adsets.get(input.adsetId)?.campaignId ?? TARGET_CAMPAIGN_ID;
    state.ads.set(adId, {
      adsetId: input.adsetId,
      campaignId,
      creativeId: input.creativeId,
      name: bodyField(input.body, "name") || "Created ad",
      status: bodyField(input.body, "status") === "ACTIVE" ? "ACTIVE" : "PAUSED",
    });
    state.adSlots.set(slot, adId);
    return json({ id: adId });
  }

  function answer(input: { method: string; path: string; body: string | null }) {
    const { method, path, body } = input;
    if (method === "POST" && path === `act_${ACCOUNT_NUMERIC}/ads`) {
      return createAdOnDouble({
        adsetId: bodyField(body, "adset_id"),
        creativeId: bodyCreativeId(body),
        body,
      });
    }
    if (method === "POST" && path === `act_${ACCOUNT_NUMERIC}/campaigns`) {
      const campaignName = bodyField(body, "name");
      if (state.campaignSlots.has(campaignName)) {
        return json(
          { error: { code: 100, message: `duplicate campaign create ${campaignName}` } },
          400,
        );
      }
      const campaignId = nextId("6");
      state.campaigns.set(campaignId, {
        name: campaignName,
        status: bodyField(body, "status") || "PAUSED",
        objective: bodyField(body, "objective"),
      });
      state.campaignSlots.set(campaignName, campaignId);
      return json({ id: campaignId });
    }
    if (method === "POST" && path.endsWith("/adsets") && state.campaigns.has(path.split("/")[0]!)) {
      const campaignId = path.split("/")[0]!;
      const adsetName = bodyField(body, "name");
      const slot = `${campaignId}:${adsetName}`;
      if (state.adsetSlots.has(slot)) {
        return json(
          { error: { code: 100, message: `duplicate ad set create ${slot}` } },
          400,
        );
      }
      const adsetId = nextId("7");
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
      state.adsetSlots.set(slot, adsetId);
      return json({ id: adsetId });
    }
    if (method === "POST" && path.endsWith("/ads") && state.adsets.has(path.split("/")[0]!)) {
      return createAdOnDouble({
        adsetId: path.split("/")[0]!,
        creativeId: bodyCreativeId(body),
        body,
      });
    }
    if (method === "GET" && path === `act_${ACCOUNT_NUMERIC}`) {
      return json({
        id: ACCOUNT_ID,
        account_status: 1,
        currency: "USD",
        timezone_name: "UTC",
        name: "Direct launch standing seam account",
      });
    }
    if (method === "GET" && path === `act_${ACCOUNT_NUMERIC}/adspixels`) {
      return json({ data: [{ id: PIXEL_ID, name: "Seam pixel" }] });
    }
    if (method === "GET") {
      const payload = providerPayloadFor(path);
      if (payload) return json(payload);
    }
    return json(
      { error: { code: 100, message: `unmapped provider path ${method} ${path}` } },
      400,
    );
  }

  function installProvider() {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (!url.startsWith("https://graph.facebook.com/")) {
        throw new Error(`direct launch standing seam: unexpected request to ${url}`);
      }
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
  }

  async function seedAccount() {
    const db = getDb();
    await db.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1::uuid, 'Direct launch standing seam', 'direct-launch-standing@adsecute.local', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    );
    await db.query(
      `INSERT INTO businesses (id, name, owner_id)
       VALUES ($1::uuid, 'Direct launch standing seam', $2::uuid)
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
      A LIVE business, stated rather than defaulted. `dryRunOnly` ships as
      rehearsal and a create cannot be rehearsed, so an unstated control row
      would make this file prove refusals while claiming to prove creates.
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
    const accountRows = (await db.query(
      `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone)
       VALUES ('meta', $1, 'Direct launch standing seam account', 'USD', 'UTC')
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
    // The live destinations an add-to-existing launch aims at.
    await db.query(
      `INSERT INTO meta_campaign_dimensions
         (business_id, provider_account_id, campaign_id, campaign_name_current)
       VALUES ($1::uuid, $2, $3, 'Main · purchase')
       ON CONFLICT DO NOTHING`,
      [BUSINESS_ID, ACCOUNT_ID, TARGET_CAMPAIGN_ID],
    );
    for (const [adsetId, name] of [
      [TARGET_ADSET_A, "Broad · purchase"],
      [TARGET_ADSET_B, "Lookalike · purchase"],
    ] as const) {
      await db.query(
        `INSERT INTO meta_adset_dimensions
           (business_id, provider_account_id, campaign_id, adset_id,
            adset_name_current, adset_status)
         VALUES ($1::uuid, $2, $3, $4, $5, 'ACTIVE')
         ON CONFLICT DO NOTHING`,
        [BUSINESS_ID, ACCOUNT_ID, TARGET_CAMPAIGN_ID, adsetId, name],
      );
    }
    const session = await createSession({
      userId: USER_ID,
      activeBusinessId: BUSINESS_ID,
    });
    sessionToken = session.token;
  }

  /** One creative the account really holds, with the source ad a reuse copies. */
  async function seedCreative(input: {
    creativeId: string;
    sourceAdId: string;
    name: string;
  }) {
    const db = getDb();
    await db.query(
      `INSERT INTO meta_creative_dimensions
         (business_id, provider_account_id, creative_id, creative_name, ad_id)
       VALUES ($1::uuid, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [BUSINESS_ID, ACCOUNT_ID, input.creativeId, input.name, input.sourceAdId],
    );
    await db.query(
      `INSERT INTO meta_creative_daily
         (business_id, provider_account_id, date, creative_id, creative_name,
          ad_id, effective_status, account_timezone, account_currency)
       VALUES ($1::uuid, $2, $3::date, $4, $5, $6, 'ACTIVE', 'UTC', 'USD')
       ON CONFLICT DO NOTHING`,
      [BUSINESS_ID, ACCOUNT_ID, AS_OF, input.creativeId, input.name, input.sourceAdId],
    );
    state.sourceAds.set(input.sourceAdId, {
      creativeId: input.creativeId,
      name: input.name,
    });
  }

  /**
   * A reviewed brief, written by the shipped store against a real published
   * snapshot — the approval a staged launch is bound to.
   */
  async function seedReviewedBrief(input: { creativeId: string; key: string }) {
    const db = getDb();
    const snapshots = (await db.query(
      `INSERT INTO engine_v3_decision_snapshots_daily (
         business_ref_id, business_id, creative_id, as_of_date, engine_version,
         scope_type, scope_id, label, confidence, truth_source,
         effective_target_roas, ratio_to_target, badges, reason
       ) VALUES (
         $1::uuid, $1, $2, $3::date, 'v3-direct-launch-standing-seam',
         'account', $4, 'scale', 86, 'commercial_truth',
         2.2, 1.5, '[]'::jsonb, 'Published by the engine for this creative'
       ) RETURNING id::text AS id`,
      [BUSINESS_ID, input.creativeId, AS_OF, ACCOUNT_ID],
    )) as Array<{ id: string }>;
    const created = await createMetaCreativeBrief({
      request: parseCreateMetaCreativeBriefRequest({
        businessId: BUSINESS_ID,
        providerAccountId: ACCOUNT_ID,
        idempotencyKey: `direct-launch-standing-brief-${input.key}`,
        sourceDecision: { snapshotId: snapshots[0]!.id, trigger: "decision_card" },
        content: {
          keep: "Keep the opening frame",
          change: "Nothing",
          next: "Run it",
        },
        status: "reviewed",
      }),
      createdBy: USER_ID,
    });
    return { briefId: created.brief.id, briefVersion: created.brief.version };
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
    expect(brief.status).toBe("draft");
    return brief;
  }

  /** The operator's composed test launch: a whole new campaign, all of it theirs. */
  function newCampaignPayload(input: {
    creativeIds: string[];
    campaignName: string;
    adSetName: string;
  }) {
    return {
      mode: "new_campaign",
      currencyCode: "USD",
      campaign: { name: input.campaignName },
      budget: {
        mode: "CBO",
        amountMinor: 5000,
        currency: "USD",
        bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      },
      creativeIds: input.creativeIds,
      creatives: input.creativeIds.map((creativeId, index) => ({
        creativeId,
        name: `Creative ${index + 1}`,
      })),
      adSets: [
        {
          clientId: "adset-1",
          name: input.adSetName,
          optimizationGoal: "OFFSITE_CONVERSIONS",
          pixelId: PIXEL_ID,
          customEventType: "PURCHASE",
          targeting: { countries: ["US"], ageMin: 18, ageMax: 65 },
          attributionSpec: [{ eventType: "CLICK_THROUGH", windowDays: 7 }],
        },
      ],
    };
  }

  function addToExistingBody(input: {
    creatives: Array<{ creativeId: string; sourceAdId: string; name: string }>;
    adsetIds: string[];
  }) {
    return {
      targetCampaignId: TARGET_CAMPAIGN_ID,
      targetAdsetId: input.adsetIds[0]!,
      copyMode: "reuse_creative" as const,
      targets: input.adsetIds.map((adsetId) => ({
        targetCampaignId: TARGET_CAMPAIGN_ID,
        targetAdsetId: adsetId,
      })),
      creativeIds: input.creatives.map((creative) => creative.creativeId),
      creatives: input.creatives,
    };
  }

  /**
   * The intent a producer stages: bound to the reviewed brief, carrying the
   * staged authority, and written by the shipped store — which runs the same
   * lineage verification the standing re-read later goes through.
   */
  async function stageIntent(input: {
    operation: "new_campaign" | "add_to_existing";
    idempotencyKey: string;
    payload: Record<string, unknown>;
    creativeBriefId: string | null;
  }) {
    const normalized =
      input.operation === "new_campaign"
        ? normalizeMetaLaunchPayload(input.payload)
        : normalizeMetaAddToExistingPayload({
            mode: "add_to_existing",
            ...input.payload,
          });
    const created = await createMetaLaunchIntent({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestPayload: bindMetaLaunchExecutionAuthorityToPayload(
        normalized,
        STAGED_AUTHORITY,
      ),
      creativeBriefId: input.creativeBriefId,
      createdBy: USER_ID,
    });
    expect(created.created).toBe(true);
    return created.intent;
  }

  function launchRequest(body: Record<string, unknown>) {
    return new NextRequest(new URL("/api/launchpad/meta/launch", "http://localhost"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${AUTH_COOKIE}=${sessionToken}`,
      },
      body: JSON.stringify({
        actionOrigin: "launchpad_manual_v1",
        manualConfirmation: "explicit_operator_confirmation",
        businessId: BUSINESS_ID,
        providerAccountId: ACCOUNT_ID,
        ...body,
      }),
    });
  }

  function addToExistingRequest(body: Record<string, unknown>) {
    return new NextRequest(
      new URL("/api/launchpad/meta/add-to-existing", "http://localhost"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: `${AUTH_COOKIE}=${sessionToken}`,
        },
        body: JSON.stringify({
          actionOrigin: "launchpad_manual_v1",
          manualConfirmation: "explicit_operator_confirmation",
          businessId: BUSINESS_ID,
          providerAccountId: ACCOUNT_ID,
          ...body,
        }),
      },
    );
  }

  beforeAll(async () => {
    /*
      Both environment capabilities, stated rather than assumed. With either
      shut every route below answers a refusal, and the file would pass while
      proving nothing about a create.
    */
    process.env.META_AUTOMATION_LIVE_WRITES = "true";
    process.env.META_LAUNCHPAD_EXECUTION = "true";

    const db = await import("@/lib/db");
    const auth = await import("@/lib/auth");
    const briefStore = await import("@/lib/meta/creative-brief-store");
    const briefContract = await import("@/lib/meta/creative-brief-contract");
    const intentStore = await import("@/lib/launchpad/meta-launch-intent-store");
    const launchpadMeta = await import("@/lib/launchpad/meta");
    const manualAuthority = await import("@/lib/launchpad/meta-manual-authority");
    const launchRoute = await import("@/app/api/launchpad/meta/launch/route");
    const addToExistingRoute = await import(
      "@/app/api/launchpad/meta/add-to-existing/route"
    );
    const routeHandlers = await import("@/lib/launchpad/meta-launch-route-handlers");

    getDb = db.getDb;
    closeDb =
      "closeDb" in db && typeof db.closeDb === "function"
        ? (db.closeDb as () => Promise<void>)
        : null;
    createSession = auth.createSession;
    createMetaCreativeBrief = briefStore.createMetaCreativeBrief;
    patchMetaCreativeBrief = briefStore.patchMetaCreativeBrief;
    parseCreateMetaCreativeBriefRequest = briefContract.parseCreateMetaCreativeBriefRequest;
    parsePatchMetaCreativeBriefRequest = briefContract.parsePatchMetaCreativeBriefRequest;
    createMetaLaunchIntent = intentStore.createMetaLaunchIntent;
    getMetaLaunchIntent = intentStore.getMetaLaunchIntent;
    normalizeMetaLaunchPayload = launchpadMeta.normalizeMetaLaunchPayload;
    normalizeMetaAddToExistingPayload = launchpadMeta.normalizeMetaAddToExistingPayload;
    bindMetaLaunchExecutionAuthorityToPayload =
      manualAuthority.bindMetaLaunchExecutionAuthorityToPayload;
    launchPost = launchRoute.POST as unknown as (r: NextRequest) => Promise<Response>;
    addToExistingPost = addToExistingRoute.POST as unknown as (
      r: NextRequest,
    ) => Promise<Response>;
    handleMetaLaunchAction = routeHandlers.handleMetaLaunchAction;

    state = {
      sourceAds: new Map(),
      campaigns: new Map(),
      adsets: new Map(),
      ads: new Map(),
      adSlots: new Map(),
      campaignSlots: new Map(),
      adsetSlots: new Map(),
    };
    installProvider();
    await seedAccount();
  }, 120_000);

  afterAll(async () => {
    if (originalFetch) globalThis.fetch = originalFetch;
    if (closeDb) await closeDb();
  });

  /**
   * (a) and (b): the defect itself, at the operator's own endpoint.
   *
   * A three-POST create — campaign, ad set, ad — whose reviewed brief is
   * withdrawn the instant the campaign create is answered. Nothing below the
   * campaign may be asked for; the campaign that DOES exist has to stay
   * reported and durable; and the intent has to settle `partially_succeeded`
   * naming the withdrawal, rather than claiming either a clean success or a
   * clean refusal.
   */
  it("withholds every POST below the campaign when the review is withdrawn mid-sequence", async () => {
    const creativeId = "3091000000301";
    await seedCreative({
      creativeId,
      sourceAdId: "3091000000401",
      name: "Withdrawn mid-sequence",
    });
    const brief = await seedReviewedBrief({ creativeId, key: "midsequence" });
    const payload = newCampaignPayload({
      creativeIds: [creativeId],
      campaignName: "Direct · mid-sequence withdrawal",
      adSetName: "Direct · mid-sequence broad",
    });
    const intent = await stageIntent({
      operation: "new_campaign",
      idempotencyKey: "direct-standing-midsequence",
      payload,
      creativeBriefId: brief.briefId,
    });

    let withdrew = false;
    armWhen(
      (call) =>
        call.method === "POST" && call.url.includes(`act_${ACCOUNT_NUMERIC}/campaigns`),
      async () => {
        await revokeBriefReview({ briefId: brief.briefId, version: brief.briefVersion });
        withdrew = true;
      },
    );

    const before = calls.length;
    const response = await launchPost(
      launchRequest({
        payload,
        idempotencyKey: intent.idempotencyKey,
        launchIntentId: intent.id,
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(withdrew).toBe(true);
    // Exactly one provider POST: the campaign. The ad set and the ad below it
    // were never asked for.
    expect(postPaths(calls.slice(before))).toEqual([`act_${ACCOUNT_NUMERIC}/campaigns`]);
    expect(state.adsets.size).toBe(0);
    expect(state.ads.size).toBe(0);

    expect(response.status).toBe(409);
    expect(body.ok).toBe(false);
    // (b) the identity that really exists is still reported…
    expect(typeof body.campaignId).toBe("string");
    expect(body.adsetIds).toEqual([]);
    expect(body.adIds).toEqual([]);
    expect(body.failedAt).toBe("adset:1");
    expect(body.withheldReason).toBe("creative_brief_not_reviewed");
    expect((body.error as { code?: string }).code).toBe("provider_mutation_withheld");
    expect((body.error as { message?: string }).message).toContain(
      "creative_brief_not_reviewed",
    );
    expect(body.launchIntentStatus).toBe("partially_succeeded");

    // …and it is durable, on the intent, with the reason the rest was withheld.
    const settled = await getMetaLaunchIntent({ businessId: BUSINESS_ID, id: intent.id });
    expect(settled?.status).toBe("partially_succeeded");
    expect(settled?.resultReceipt?.campaignId).toBe(body.campaignId);
    expect(settled?.errorReceipt?.code).toBe("provider_mutation_withheld");
    expect(settled?.errorReceipt?.failedAt).toBe("adset:1");
    expect(settled?.errorReceipt?.message).toContain("creative_brief_not_reviewed");
    // The campaign really is PAUSED, as every launch is.
    expect(state.campaigns.get(String(body.campaignId))?.status).toBe("PAUSED");
  }, 120_000);

  /**
   * (c) the same at the add-to-existing endpoint, whose sequence is a
   * target x creative matrix rather than a hierarchy.
   */
  it("withholds the rest of the matrix when the review is withdrawn after the first duplicate", async () => {
    const first = { creativeId: "3091000000311", sourceAdId: "3091000000411" };
    const second = { creativeId: "3091000000312", sourceAdId: "3091000000412" };
    await seedCreative({ ...first, name: "Matrix winner A" });
    await seedCreative({ ...second, name: "Matrix winner B" });
    const brief = await seedReviewedBrief({
      creativeId: first.creativeId,
      key: "matrix",
    });
    const body = addToExistingBody({
      creatives: [
        { creativeId: first.creativeId, sourceAdId: first.sourceAdId, name: "Matrix winner A" },
        { creativeId: second.creativeId, sourceAdId: second.sourceAdId, name: "Matrix winner B" },
      ],
      adsetIds: [TARGET_ADSET_A, TARGET_ADSET_B],
    });
    const intent = await stageIntent({
      operation: "add_to_existing",
      idempotencyKey: "direct-standing-matrix",
      payload: body,
      creativeBriefId: brief.briefId,
    });

    let withdrew = false;
    armWhen(
      (call) => call.method === "POST" && call.url.includes(`act_${ACCOUNT_NUMERIC}/ads`),
      async () => {
        await revokeBriefReview({ briefId: brief.briefId, version: brief.briefVersion });
        withdrew = true;
      },
    );

    const before = calls.length;
    const adsBefore = state.ads.size;
    const response = await addToExistingPost(
      addToExistingRequest({
        ...body,
        idempotencyKey: intent.idempotencyKey,
        launchIntentId: intent.id,
      }),
    );
    const responseBody = (await response.json()) as Record<string, unknown>;

    expect(withdrew).toBe(true);
    // Four cells were approved. One POST was made; the other three were never
    // asked for.
    expect(postPaths(calls.slice(before))).toEqual([`act_${ACCOUNT_NUMERIC}/ads`]);
    expect(state.ads.size - adsBefore).toBe(1);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(responseBody.ok).toBe(false);
    expect((responseBody.adIds as string[]).length).toBe(1);
    const steps = responseBody.steps as Array<Record<string, unknown>>;
    const withheld = steps.filter(
      (step) =>
        (step.error as { code?: string } | undefined)?.code ===
        "provider_mutation_withheld",
    );
    expect(withheld.length).toBeGreaterThan(0);
    expect((withheld[0]!.error as { message?: string }).message).toContain(
      "creative_brief_not_reviewed",
    );

    const settled = await getMetaLaunchIntent({ businessId: BUSINESS_ID, id: intent.id });
    expect(settled?.status).toBe("partially_succeeded");
    expect(settled?.resultReceipt?.adIds?.length).toBe(1);
  }, 120_000);

  /**
   * (d) the positive path, at both endpoints. The mandatory check must not turn
   * a healthy approval into a refusal — the failure mode a naive fix has.
   */
  it("still creates a whole campaign through the direct launch endpoint when the approval is untouched", async () => {
    const creativeId = "3091000000321";
    await seedCreative({
      creativeId,
      sourceAdId: "3091000000421",
      name: "Untouched approval",
    });
    const brief = await seedReviewedBrief({ creativeId, key: "healthy-launch" });
    const payload = newCampaignPayload({
      creativeIds: [creativeId],
      campaignName: "Direct · untouched approval",
      adSetName: "Direct · untouched broad",
    });
    const intent = await stageIntent({
      operation: "new_campaign",
      idempotencyKey: "direct-standing-healthy-launch",
      payload,
      creativeBriefId: brief.briefId,
    });

    const before = calls.length;
    const response = await launchPost(
      launchRequest({
        payload,
        idempotencyKey: intent.idempotencyKey,
        launchIntentId: intent.id,
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    const posts = postPaths(calls.slice(before));
    expect(posts.length).toBe(3);
    expect(posts[0]).toBe(`act_${ACCOUNT_NUMERIC}/campaigns`);
    expect(posts[1]).toMatch(/\/adsets$/);
    expect(posts[2]).toMatch(/\/ads$/);
    expect(body.launchIntentStatus).toBe("succeeded");
    expect(state.campaigns.get(String(body.campaignId))?.status).toBe("PAUSED");
    for (const adId of body.adIds as string[]) {
      expect(state.ads.get(adId)?.status).toBe("PAUSED");
    }
    // The staged approval is what the receipt records; the operator ran it.
    const settled = await getMetaLaunchIntent({ businessId: BUSINESS_ID, id: intent.id });
    expect(settled?.resultReceipt?.executionAuthority).toEqual(STAGED_AUTHORITY);
  }, 120_000);

  it("still creates every matrix cell through add-to-existing when the approval is untouched", async () => {
    const creative = { creativeId: "3091000000331", sourceAdId: "3091000000431" };
    await seedCreative({ ...creative, name: "Untouched matrix" });
    const brief = await seedReviewedBrief({
      creativeId: creative.creativeId,
      key: "healthy-matrix",
    });
    const body = addToExistingBody({
      creatives: [{ ...creative, name: "Untouched matrix" }],
      adsetIds: [TARGET_ADSET_A, TARGET_ADSET_B],
    });
    const intent = await stageIntent({
      operation: "add_to_existing",
      idempotencyKey: "direct-standing-healthy-matrix",
      payload: body,
      creativeBriefId: brief.briefId,
    });

    const before = calls.length;
    const response = await addToExistingPost(
      addToExistingRequest({
        ...body,
        idempotencyKey: intent.idempotencyKey,
        launchIntentId: intent.id,
      }),
    );
    const responseBody = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(responseBody.ok).toBe(true);
    expect(postPaths(calls.slice(before))).toEqual([
      `act_${ACCOUNT_NUMERIC}/ads`,
      `act_${ACCOUNT_NUMERIC}/ads`,
    ]);
    expect((responseBody.adIds as string[]).length).toBe(2);
    for (const adId of responseBody.adIds as string[]) {
      expect(state.ads.get(adId)?.status).toBe("PAUSED");
    }
  }, 120_000);

  /**
   * (e) the standalone case, which has no staged approval to withdraw.
   *
   * An intent composed and confirmed on the Launchpad screen binds neither a
   * brief nor a decision snapshot. Its authority is the operator confirmation
   * inside its own payload, and that payload still hashing to
   * `request_fingerprint`. The standing question must be a NO-OP for it — the
   * other way a fix here goes wrong is refusing every healthy operator launch
   * because it cannot find an approval that was never staged.
   */
  it("leaves a standalone operator launch with no staged lineage unaffected", async () => {
    const creativeId = "3091000000341";
    await seedCreative({
      creativeId,
      sourceAdId: "3091000000441",
      name: "Composed on the screen",
    });
    const payload = newCampaignPayload({
      creativeIds: [creativeId],
      campaignName: "Direct · standalone operator launch",
      adSetName: "Direct · standalone broad",
    });

    const before = calls.length;
    // No `launchIntentId`: the route creates the intent itself, exactly as the
    // Launchpad wizard's own POST does, and that intent binds no lineage.
    const response = await launchPost(
      launchRequest({ payload, idempotencyKey: "direct-standing-standalone" }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(postPaths(calls.slice(before)).length).toBe(3);
    const settled = await getMetaLaunchIntent({
      businessId: BUSINESS_ID,
      id: String(body.launchIntentId),
    });
    expect(settled?.status).toBe("succeeded");
    expect(settled?.lineage).toEqual({
      sourceDecisionId: null,
      sourceDecisionSnapshotId: null,
      creativeBriefId: null,
      sourceDraftId: null,
    });
    // The operator's own confirmation is what authorized it, and it is not the
    // staged pair.
    expect(settled?.resultReceipt?.executionAuthority).toEqual({
      actionOrigin: "launchpad_manual_v1",
      manualConfirmation: "explicit_operator_confirmation",
    });
  }, 120_000);

  /**
   * (f) the caller that DOES hold a claim — the Automation queue.
   *
   * These two cases are the only ones in the file that hand the handler a
   * `beforeProviderMutation`, and deliberately: they are about the queue-shaped
   * caller, not about the direct route. What they pin is that composing the
   * mandatory standing read did not swallow the caller's own hook, and did not
   * reorder it.
   */
  it("still asks the caller's dispatch marker, and a marker that cannot be written still vetoes", async () => {
    const creativeId = "3091000000351";
    await seedCreative({
      creativeId,
      sourceAdId: "3091000000451",
      name: "Marker veto",
    });
    const brief = await seedReviewedBrief({ creativeId, key: "marker-veto" });
    const payload = newCampaignPayload({
      creativeIds: [creativeId],
      campaignName: "Direct · marker veto",
      adSetName: "Direct · marker veto broad",
    });
    const intent = await stageIntent({
      operation: "new_campaign",
      idempotencyKey: "direct-standing-marker-veto",
      payload,
      creativeBriefId: brief.briefId,
    });

    const marker = [] as boolean[];
    const before = calls.length;
    const response = await handleMetaLaunchAction(
      launchRequest({
        payload,
        idempotencyKey: intent.idempotencyKey,
        launchIntentId: intent.id,
      }),
      {
        beforeProviderMutation: async () => {
          marker.push(true);
          return false;
        },
      },
    );
    const body = (await response.json()) as Record<string, unknown>;

    // The approval stands, so the composed boundary went on to ask the caller.
    expect(marker.length).toBe(1);
    expect(postPaths(calls.slice(before))).toEqual([]);
    expect(response.status).toBe(409);
    expect((body.error as { code?: string }).code).toBe("dispatch_marker_unavailable");
    // A bare `false` names no gate, so the message stays the dispatch sentence.
    expect((body.error as { message?: string }).message).toContain(
      "could not record dispatch intent",
    );
    expect(body.withheldReason).toBeNull();
  }, 120_000);

  it("refuses a withdrawn approval before the caller's marker is ever fired", async () => {
    /*
      The ordering claim, tested rather than asserted in a comment: a withdrawn
      approval must not leave write-ahead dispatch intent for a call that will
      not be made. The withdrawal lands during the route's own creative
      preflight — after `prepareMetaLaunchIntentForExecution` has already asked
      and been satisfied — so the first pre-POST ask is where it is caught.
    */
    const creativeId = "3091000000361";
    await seedCreative({
      creativeId,
      sourceAdId: "3091000000461",
      name: "Withdrawn during preflight",
    });
    const brief = await seedReviewedBrief({ creativeId, key: "preflight" });
    const payload = newCampaignPayload({
      creativeIds: [creativeId],
      campaignName: "Direct · withdrawn during preflight",
      adSetName: "Direct · withdrawn preflight broad",
    });
    const intent = await stageIntent({
      operation: "new_campaign",
      idempotencyKey: "direct-standing-preflight",
      payload,
      creativeBriefId: brief.briefId,
    });

    let withdrew = false;
    armWhen(
      (call) => call.method === "GET" && call.url.includes(`/${creativeId}`),
      async () => {
        await revokeBriefReview({ briefId: brief.briefId, version: brief.briefVersion });
        withdrew = true;
      },
    );

    const marker = [] as boolean[];
    const before = calls.length;
    const response = await handleMetaLaunchAction(
      launchRequest({
        payload,
        idempotencyKey: intent.idempotencyKey,
        launchIntentId: intent.id,
      }),
      {
        beforeProviderMutation: async () => {
          marker.push(true);
          return true;
        },
      },
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(withdrew).toBe(true);
    expect(marker.length).toBe(0);
    expect(postPaths(calls.slice(before))).toEqual([]);
    expect(response.status).toBe(409);
    expect(body.withheldReason).toBe("creative_brief_not_reviewed");
    expect((body.error as { message?: string }).message).toContain(
      "creative_brief_not_reviewed",
    );

    /*
      And the launch is not dead. The refusal happened before
      `markMetaLaunchIntentExecuting`, so the intent is `ready` with no
      `started_at` — the structurally proven non-attempt a re-review can run
      again. Losing that would be the trap an earlier round closed.
    */
    const settled = await getMetaLaunchIntent({ businessId: BUSINESS_ID, id: intent.id });
    expect(settled?.status).toBe("ready");
    expect(settled?.startedAt).toBeNull();
  }, 120_000);
});
