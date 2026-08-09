import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { seedReviewerAccount } from "../helpers/reviewer-auth";

const DEMO_BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const SMOKE_UUID = "00000000-0000-4000-8000-000000000000";
// Single source of truth for the request contexts' base URL. Mirrors the value
// playwright.full-ui-redesign.config.ts derives, avoiding the untyped
// testInfo.config.use access (FullConfig does not expose `use` in its types).
const SMOKE_BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3107";
const ADMIN_EMAIL = "full-ui-admin@adsecute.local";
const ADMIN_PASSWORD = "FullUiRedesignSmoke!2026";

type SmokeActor = {
  email: string;
  password: string;
};

const PUBLIC_ROUTES = [
  "/login",
  "/signup",
  "/invite/smoke-token",
  "/select-language",
  "/shopify/connect",
  "/share/report/smoke-token",
  "/share/creative/smoke-token",
] as const;

const DASHBOARD_ROUTES = [
  "/businesses/new",
  "/commercial-truth",
  "/insights",
  "/insights/analytics",
  "/insights/ai-visibility",
  "/insights/seo",
  "/integrations",
  "/integrations/callback/meta?status=success&returnTo=/integrations",
  "/platforms/meta",
  "/platforms/meta/history",
  "/platforms/meta/creatives",
  "/platforms/meta/copies",
  "/platforms/meta/landing-pages",
  "/platforms/meta/creative-inbox",
  "/platforms/meta/audiences",
  "/platforms/meta/launchpad",
  "/platforms/meta/automation",
  "/platforms/google",
  "/platforms/google/pulse",
  "/platforms/google/launchpad",
  "/platforms/google/ads",
  "/platforms/google/keywords",
  "/platforms/google/audiences",
  "/platforms/klaviyo",
  "/platforms/klaviyo/flows",
  "/platforms/klaviyo/campaigns",
  "/platforms/klaviyo/templates",
  "/platforms/klaviyo/segments",
  "/platforms/tiktok",
  "/platforms/pinterest",
  "/platforms/snapchat",
  "/reports",
  "/reports/new",
  `/reports/${SMOKE_UUID}`,
  `/reports/${SMOKE_UUID}/edit`,
  `/reports/${SMOKE_UUID}/print`,
  "/select-business",
  "/settings",
  "/team",
] as const;

const ADMIN_ROUTES = [
  "/admin",
  "/admin/activity",
  "/admin/auth-health",
  "/admin/businesses",
  `/admin/businesses/${DEMO_BUSINESS_ID}`,
  "/admin/discounts",
  "/admin/discounts/new",
  `/admin/discounts/${SMOKE_UUID}`,
  "/admin/integrations",
  "/admin/release-authority",
  "/admin/revenue-risk",
  "/admin/subscriptions",
  "/admin/sync-health",
  "/admin/system-capacity",
  "/admin/users",
  `/admin/users/${SMOKE_UUID}`,
] as const;

const SCREENSHOT_ROUTES = [
  { actor: "public", path: "/login", name: "login" },
  { actor: "dashboard", path: "/platforms/meta", name: "meta-decisions" },
  { actor: "dashboard", path: "/platforms/meta/history", name: "meta-history" },
  {
    actor: "dashboard",
    path: "/platforms/meta/creatives",
    name: "creative-studio",
  },
  { actor: "dashboard", path: "/platforms/meta/copies", name: "studio-copy" },
  {
    actor: "dashboard",
    path: "/platforms/meta/landing-pages",
    name: "studio-landing-pages",
  },
  {
    actor: "dashboard",
    path: "/platforms/meta/creative-inbox",
    name: "studio-inbox",
  },
  {
    actor: "dashboard",
    path: "/platforms/meta/audiences",
    name: "studio-audiences",
  },
  { actor: "dashboard", path: "/platforms/meta/launchpad", name: "launchpad" },
  {
    actor: "dashboard",
    path: "/platforms/meta/automation",
    name: "automation",
  },
  { actor: "dashboard", path: "/reports", name: "reports" },
  // Explicit Tier-0 surfaces the earlier matrix never captured.
  { actor: "dashboard", path: "/overview", name: "overview" },
  { actor: "dashboard", path: "/integrations", name: "integrations" },
  { actor: "dashboard", path: "/settings", name: "settings" },
  { actor: "admin", path: "/admin", name: "admin" },
  {
    actor: "admin",
    path: "/admin/discounts/new",
    name: "admin-discount-new",
  },
] as const;

const VISUAL_ONLY = process.env.FULL_UI_SMOKE_VISUAL_ONLY === "1";
const SELECTED_SCREENSHOT_NAMES = new Set(
  (process.env.FULL_UI_SMOKE_SCREENSHOTS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);

const ACTIVE_SCREENSHOT_ROUTES =
  SELECTED_SCREENSHOT_NAMES.size === 0
    ? SCREENSHOT_ROUTES
    : SCREENSHOT_ROUTES.filter((shot) =>
        SELECTED_SCREENSHOT_NAMES.has(shot.name),
      );

async function seedAdminAccount(): Promise<SmokeActor> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required for full UI smoke admin seed.");

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash, is_superadmin)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (email)
       DO UPDATE SET
         name = EXCLUDED.name,
         password_hash = EXCLUDED.password_hash,
         is_superadmin = true
       RETURNING id`,
      ["Full UI Smoke Admin", ADMIN_EMAIL, passwordHash],
    );
    const adminId = result.rows[0]?.id;
    if (!adminId) throw new Error("Admin smoke seed did not return a user id.");

    await client.query(
      `INSERT INTO memberships (user_id, business_id, role, status)
       VALUES ($1, $2, 'admin', 'active')
       ON CONFLICT (user_id, business_id)
       DO UPDATE SET role = 'admin', status = 'active'`,
      [adminId, DEMO_BUSINESS_ID],
    );
  } finally {
    await client.end();
  }

  return { email: ADMIN_EMAIL, password: ADMIN_PASSWORD };
}

async function seedMetaDecisionDemoData() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error(
      "DATABASE_URL is required for full UI smoke decision seed.",
    );

  const snapshotDate = new Date().toISOString().slice(0, 10);
  const providerAccountId = "act_210009998877";
  const campaignId = "m-c1";
  const adsetId = "m-as-2";
  const recommendation = {
    id: "smoke_cut_m_as_2",
    level: "adset",
    campaignId,
    campaignName: "Backpack Video Ads",
    adsetId,
    adsetName: "Prospecting Hook Tests",
    type: "adset_cut_spend",
    lens: "profitability",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.86,
    confidenceReason: null,
    decisionLabel: "cut",
    decisionState: "act",
    decision: "Cut candidate",
    title: "Prospecting Hook Tests is below the commercial floor",
    why: "Spend is material while ROAS remains under the account target.",
    summary:
      "The ad set has enough spend and purchase evidence to review for pause.",
    recommendedAction: "Pause adset",
    expectedImpact:
      "Stops current waste while evidence is rechecked in the inspector.",
    evidence: [
      { label: "Spend", value: "$1,180", tone: "neutral" },
      { label: "ROAS", value: "2.36x", tone: "warning" },
      { label: "Purchases", value: "28", tone: "neutral" },
    ],
    timeframeContext: {
      coreVerdict: "Below target with material spend.",
      selectedRangeOverlay: "28d demo smoke row for visual verification.",
      historicalSupport:
        "Seeded for UI smoke only; production data is not touched.",
      seasonalityFlag: "none",
      note: null,
    },
    targetValue: { action: "pause", spend: 1180, roas: 2.36 },
    proposedAction: { kind: "pause" },
    predictiveOverlay:
      "Decision row is present to verify reference-fidelity screenshots.",
    engineVersion: "v3-full-ui-smoke",
    evidenceTrail: {
      roas_history: [3.1, 2.8, 2.36],
      peer_comparison: { p10: 1.2, p50: 2.7, p90: 4.2, this_value: 2.36 },
      regime_stability: 0.74,
      age_days: 9,
      recent_changes: [],
    },
    campaignRole: "prospecting_test",
    bidRegime: "cost_cap",
    cohort: "purchase",
    calibrationScope: { type: "account", source: "demo_smoke" },
    signalQuality: { quality_status: "ready", label_status: "labeled" },
  };

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const providerAccount = await client.query<{ id: string }>(
      `INSERT INTO provider_accounts (
         provider,
         external_account_id,
         account_name,
         currency,
         timezone,
         updated_at
       ) VALUES ('meta', $1, 'UrbanTrail DTC', 'USD', 'America/Los_Angeles', now())
       ON CONFLICT (provider, external_account_id)
       DO UPDATE SET
         account_name = EXCLUDED.account_name,
         currency = EXCLUDED.currency,
         timezone = EXCLUDED.timezone,
         updated_at = now()
       RETURNING id::text AS id`,
      [providerAccountId],
    );
    await client.query(
      // is_selected must be set explicitly. It defaults to FALSE on purpose, so
      // that deploying code can never silently select an account on a business's
      // behalf; a row without it is present but unassigned, and every account
      // -scoped Meta route answers 403 provider_account_not_assigned.
      `INSERT INTO business_provider_accounts (
         business_id,
         provider,
         provider_account_ref_id,
         provider_account_id,
         position,
         is_selected,
         updated_at
       ) VALUES ($1, 'meta', $2::uuid, $3, 0, TRUE, now())
       ON CONFLICT (business_id, provider, provider_account_ref_id)
       DO UPDATE SET
         provider_account_id = EXCLUDED.provider_account_id,
         position = 0,
         is_selected = TRUE,
         updated_at = now()`,
      [DEMO_BUSINESS_ID, providerAccount.rows[0]!.id, providerAccountId],
    );
    await client.query(
      `INSERT INTO meta_account_daily (
         business_id,
         provider_account_id,
         date,
         account_name,
         account_timezone,
         account_currency,
         spend,
         impressions,
         clicks,
         conversions,
         revenue,
         roas,
         updated_at
       ) VALUES (
         $1, $2, $3::date, 'UrbanTrail DTC', 'America/Los_Angeles', 'USD',
         1180, 82000, 2460, 28, 2784.8, 2.36, now()
       )
       ON CONFLICT (business_id, provider_account_id, date)
       DO UPDATE SET
         account_name = EXCLUDED.account_name,
         account_timezone = EXCLUDED.account_timezone,
         account_currency = EXCLUDED.account_currency,
         spend = EXCLUDED.spend,
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         conversions = EXCLUDED.conversions,
         revenue = EXCLUDED.revenue,
         roas = EXCLUDED.roas,
         updated_at = now()`,
      [DEMO_BUSINESS_ID, providerAccountId, snapshotDate],
    );
    await client.query(
      `INSERT INTO meta_campaign_dimensions (
         business_id,
         provider_account_id,
         campaign_id,
         campaign_name_current,
         campaign_status,
         updated_at
       ) VALUES ($1, $2, $3, 'Backpack Video Ads', 'ACTIVE', now())
       ON CONFLICT (business_id, provider_account_id, campaign_id)
       DO UPDATE SET
         campaign_name_current = EXCLUDED.campaign_name_current,
         campaign_status = EXCLUDED.campaign_status,
         updated_at = now()`,
      [DEMO_BUSINESS_ID, providerAccountId, campaignId],
    );
    await client.query(
      `INSERT INTO meta_adset_dimensions (
         business_id,
         provider_account_id,
         campaign_id,
         adset_id,
         adset_name_current,
         adset_status,
         updated_at
       ) VALUES ($1, $2, $3, $4, 'Prospecting Hook Tests', 'ACTIVE', now())
       ON CONFLICT (business_id, provider_account_id, adset_id)
       DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id,
         adset_name_current = EXCLUDED.adset_name_current,
         adset_status = EXCLUDED.adset_status,
         updated_at = now()`,
      [DEMO_BUSINESS_ID, providerAccountId, campaignId, adsetId],
    );

    // The mounted Decisions workspace builds its evidence from creatives that
    // carry an engine_v3 snapshot, not from the legacy
    // meta_decision_snapshots_daily table this seed was originally written
    // against. These rows populate what readSnapshotRows actually joins: an
    // account-scoped creative, its ad, and a snapshot row.
    const creativeId = "m-cr-1";
    const adId = "m-ad-1";

    await client.query(
      `INSERT INTO meta_creative_dimensions (
         business_id,
         provider_account_id,
         creative_id,
         creative_name,
         campaign_id,
         adset_id,
         updated_at
       ) VALUES ($1, $2, $3, 'Backpack Hook A', $4, $5, now())
       ON CONFLICT DO NOTHING`,
      [DEMO_BUSINESS_ID, providerAccountId, creativeId, campaignId, adsetId],
    );

    await client.query(
      `INSERT INTO meta_ad_dimensions (
         business_id,
         provider_account_id,
         campaign_id,
         adset_id,
         ad_id,
         ad_name_current,
         ad_status,
         creative_id,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'Backpack Hook A - Ad', 'ACTIVE', $6, now())
       ON CONFLICT DO NOTHING`,
      [DEMO_BUSINESS_ID, providerAccountId, campaignId, adsetId, adId, creativeId],
    );

    await client.query(
      `INSERT INTO engine_v3_decision_snapshots_daily (
         business_ref_id,
         business_id,
         creative_id,
         as_of_date,
         engine_version,
         scope_type,
         scope_id,
         label,
         confidence,
         truth_source,
         effective_target_roas,
         ratio_to_target,
         reason,
         spend,
         purchases,
         roas,
         computed_at
       ) VALUES ($1::uuid, $1, $2, $3::date, 'v3-full-ui-smoke', 'account', '*',
                 'cut', 86, 'commercial_truth', 3.5, 0.67,
                 'Spend is material while ROAS remains under the account target.',
                 1180, 28, 2.36, now())
       ON CONFLICT DO NOTHING`,
      [DEMO_BUSINESS_ID, creativeId, snapshotDate],
    );

    await client.query(
      `INSERT INTO meta_campaign_labels (
         business_id,
         campaign_id,
         provider_account_id,
         campaign_name,
         campaign_kind,
         test_dimension,
         source,
         labeled_by,
         labeled_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, 'main', NULL, 'user', 'full-ui-smoke', now(), now())
       ON CONFLICT (business_id, campaign_id)
       DO UPDATE SET
         provider_account_id = EXCLUDED.provider_account_id,
         campaign_name = EXCLUDED.campaign_name,
         campaign_kind = EXCLUDED.campaign_kind,
         test_dimension = EXCLUDED.test_dimension,
         source = EXCLUDED.source,
         labeled_by = EXCLUDED.labeled_by,
         updated_at = now()`,
      [DEMO_BUSINESS_ID, campaignId, providerAccountId, "Backpack Video Ads"],
    );

    await client.query(
      `INSERT INTO meta_decision_snapshots_daily (
         scope_type,
         scope_id,
         business_id,
         snapshot_date,
         rec_id,
         rec_type,
         level,
         decision_state,
         confidence_score,
         evidence,
         recommended_action,
         target_value,
         expected_impact,
         reasoning,
         predictive_overlay,
         engine_version,
         kind,
         evidence_trail,
         campaign_role,
         bid_regime,
         decision_label,
         state_reason,
         calibration_scope,
         signal_quality
       ) VALUES (
         'adset',
         $1,
         $2,
         $3::date,
         $4,
         'adset_cut_spend',
         'adset',
         'act',
         0.86,
         $5::jsonb,
         'Pause adset',
         $6::jsonb,
         'Stops current waste while evidence is rechecked in the inspector.',
         'Spend is material while ROAS remains under the account target.',
         'Decision row is present to verify reference-fidelity screenshots.',
         'v3-full-ui-smoke',
         'recommendation',
         $7::jsonb,
         'prospecting_test',
         'cost_cap',
         'cut',
         NULL,
         $8::jsonb,
         $9::jsonb
       )
       ON CONFLICT (scope_type, scope_id, snapshot_date, rec_type)
       DO UPDATE SET
         business_id = EXCLUDED.business_id,
         rec_id = EXCLUDED.rec_id,
         level = EXCLUDED.level,
         decision_state = EXCLUDED.decision_state,
         confidence_score = EXCLUDED.confidence_score,
         evidence = EXCLUDED.evidence,
         recommended_action = EXCLUDED.recommended_action,
         target_value = EXCLUDED.target_value,
         expected_impact = EXCLUDED.expected_impact,
         reasoning = EXCLUDED.reasoning,
         predictive_overlay = EXCLUDED.predictive_overlay,
         engine_version = EXCLUDED.engine_version,
         kind = EXCLUDED.kind,
         evidence_trail = EXCLUDED.evidence_trail,
         campaign_role = EXCLUDED.campaign_role,
         bid_regime = EXCLUDED.bid_regime,
         decision_label = EXCLUDED.decision_label,
         state_reason = EXCLUDED.state_reason,
         calibration_scope = EXCLUDED.calibration_scope,
         signal_quality = EXCLUDED.signal_quality,
         created_at = now()`,
      [
        adsetId,
        DEMO_BUSINESS_ID,
        snapshotDate,
        recommendation.id,
        JSON.stringify({ items: recommendation.evidence, recommendation }),
        JSON.stringify(recommendation.targetValue),
        JSON.stringify(recommendation.evidenceTrail),
        JSON.stringify(recommendation.calibrationScope),
        JSON.stringify(recommendation.signalQuality),
      ],
    );
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, actor: SmokeActor) {
  // BrowserContext.request shares its cookie jar with every page in the
  // context. Authenticating here avoids a pending /login UI redirect racing
  // the representative route navigation.
  //
  // The login endpoint is rate-limited, and it should be. Running the extended
  // width matrix means several projects authenticating the same reviewer in
  // quick succession, which is exactly the pattern the limiter exists to stop.
  // Backing off and retrying keeps the limiter intact rather than weakening a
  // real protection to make a test convenient.
  let loginResponse = await page.request.post("/api/auth/login", { data: actor });
  for (let attempt = 1; attempt <= 6 && loginResponse.status() === 429; attempt += 1) {
    await page.waitForTimeout(attempt * 1_500);
    loginResponse = await page.request.post("/api/auth/login", { data: actor });
  }
  expect(
    loginResponse.ok(),
    `login failed for ${actor.email}: ${loginResponse.status()} ${await loginResponse.text()}`,
  ).toBe(true);
  await expect
    .poll(async () => (await page.request.get("/api/auth/me")).status())
    .toBe(200);
}

async function signInRequest(context: APIRequestContext, actor: SmokeActor) {
  let response = await context.post("/api/auth/login", {
    data: actor,
  });
    for (let attempt = 1; attempt <= 6 && response.status() === 429; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
    response = await context.post("/api/auth/login", { data: actor });
  }
  expect(
    response.ok(),
    `request login failed for ${actor.email}: ${response.status()}`,
  ).toBe(true);
}

async function assertRouteResponseHealthy(
  context: APIRequestContext,
  path: string,
) {
  const response = await context.get(path, {
    maxRedirects: 5,
    timeout: 60_000,
  });
  expect(
    response.status(),
    `${path} returned ${response.status()}`,
  ).toBeLessThan(500);
  const contentType = response.headers()["content-type"] ?? "";
  if (contentType.includes("text/html")) {
    const body = await response.text();
    expect(
      body,
      `${path} server HTML still exposes old Pulse product language`,
    ).not.toMatch(/\bPulse\b/);
    expect(body, `${path} server HTML rendered a fatal app error`).not.toMatch(
      /Application error|Unhandled Runtime Error|Hydration failed/i,
    );
  }
}

async function smokeRouteResponses(
  context: APIRequestContext,
  routes: readonly string[],
) {
  for (const route of routes) {
    await assertRouteResponseHealthy(context, route);
  }
}

async function assertRouteHealthy(page: Page, path: string) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  const status = response?.status() ?? 200;
  expect(status, `${path} returned ${status}`).toBeLessThan(500);

  await page.waitForTimeout(250);
  await expect(page.locator("body"), `${path} body`).toBeVisible();

  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 10_000 })
    .catch(() => "");
  expect(bodyText, `${path} rendered a client/runtime crash`).not.toMatch(
    /Application error|Unhandled Runtime Error|Hydration failed/i,
  );
  expect(
    bodyText,
    `${path} still exposes old Pulse product language`,
  ).not.toMatch(/\bPulse\b/);

  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    document:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  }));
  expect(
    Math.max(overflow.body, overflow.document),
    `${path} has horizontal body overflow: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(2);

  expect(pageErrors, `${path} page errors`).toEqual([]);
}

async function waitForDashboardWorkspaceReady(page: Page, path: string) {
  if (!path.startsWith("/")) return;
  if (
    path.startsWith("/login") ||
    path.startsWith("/signup") ||
    path.startsWith("/invite/") ||
    path.startsWith("/select-language") ||
    path.startsWith("/share/") ||
    path.startsWith("/shopify/connect")
  ) {
    return;
  }

  await expect(
    page.getByTestId("business-guard-loading"),
    `${path} business guard`,
  ).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(
    page.getByText(/Loading workspace/i),
    `${path} workspace loader`,
  ).toHaveCount(0, {
    timeout: 30_000,
  });
  if (path === "/platforms/meta") {
    const decisions = page.getByTestId("meta-decisions-v2");
    await expect(decisions, `${path} responsive Decisions workspace`).toBeVisible({
      timeout: 30_000,
    });
    await expect(decisions, `${path} server-composed workspace query`).toHaveAttribute(
      "data-workspace-query-status",
      /success|error/,
      { timeout: 120_000 },
    );
    await expect(decisions, `${path} provider write suppression`).toHaveAttribute(
      "data-provider-writes",
      "none",
    );
    await expect(
      page.getByText(/Loading decision workspace/i),
      `${path} decision loading state`,
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.getByRole("tab", { name: /Structure/i }),
      `${path} Structure layer`,
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: /Ads/i }),
      `${path} Ads layer`,
    ).toBeVisible();
  } else if (path === "/platforms/meta/history") {
    await expect(
      page.getByLabel("Meta account for History"),
      `${path} explicit provider account`,
    ).toHaveValue("act_210009998877", { timeout: 30_000 });
    await expect(page.getByTestId("meta-history-page"), `${path} history state`).toHaveAttribute(
      "data-history-state",
      /ready|error/,
      { timeout: 30_000 },
    );
  } else if (path === "/platforms/meta/creatives") {
    const studio = page.getByTestId("creative-studio-os");
    await expect(studio, `${path} Studio operating surface`).toBeVisible({
      timeout: 30_000,
    });
    const studioAccount = studio.getByRole("button", {
      name: "Meta ad account for Creative Studio",
    });
    await expect(studioAccount, `${path} explicit provider account`).toBeVisible({
      timeout: 30_000,
    });
    await expect(studioAccount).toContainText("act_210009998877");
    const studioPage = page.getByTestId("creative-studio-page");
    await expect(studioPage, `${path} creative query`).toHaveAttribute(
      "data-creatives-query-status",
      "success",
      { timeout: 30_000 },
    );
    await expect(studioPage, `${path} creative fetch`).toHaveAttribute(
      "data-creatives-fetch-status",
      "idle",
      { timeout: 30_000 },
    );
    await expect(
      page.getByTestId("loading-skeleton"),
      `${path} page loading skeletons`,
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(studio).toHaveAttribute("data-responsive-studio", "true");
    await expect(studio).toHaveAttribute("data-provider-writes", "none");
    await expect(studio.getByText("$840.00", { exact: true })).toBeVisible();
    await expect(studio.getByText("4.00x", { exact: true })).toBeVisible();

    const studioImages = studio.locator(".studio-table-media img");
    const studioImageCount = await studioImages.count();
    for (let index = 0; index < studioImageCount; index += 1) {
      await studioImages.nth(index).scrollIntoViewIfNeeded();
    }
    if (studioImageCount > 0) {
      await expect
        .poll(
          () =>
            studioImages.evaluateAll(
              (images) =>
                images.filter(
                  (image) =>
                    (image as HTMLImageElement).complete &&
                    (image as HTMLImageElement).naturalWidth > 0,
                ).length,
            ),
          {
            message: `${path} did not render every visible creative asset`,
            timeout: 30_000,
          },
        )
        .toBe(studioImageCount);
      await studio.locator(".studio-table-scroll").evaluate((element) => {
        element.scrollTop = 0;
        element.scrollLeft = 0;
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    }
  } else if (path === "/platforms/meta/copies") {
    await expect(
      page.getByLabel("Meta ad account for Copy analysis"),
      `${path} explicit provider account`,
    ).toHaveValue("act_210009998877", { timeout: 30_000 });
    const copiesPage = page.getByTestId("copies-studio-page");
    await expect(copiesPage, `${path} copies query`).toHaveAttribute(
      "data-copies-query-status",
      /success|error/,
      { timeout: 30_000 },
    );
    await expect(copiesPage, `${path} copies fetch`).toHaveAttribute(
      "data-copies-fetch-status",
      "idle",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("loading-skeleton"), `${path} loading skeletons`).toHaveCount(0, {
      timeout: 30_000,
    });
  } else if (path === "/platforms/meta/landing-pages") {
    await expect(
      page.getByTestId("landing-pages-studio-page"),
      `${path} landing source state`,
    ).toHaveAttribute("data-landing-state", /integration_required|ready|error/, {
      timeout: 30_000,
    });
  } else if (path === "/platforms/meta/creative-inbox") {
    await expect(
      page.getByLabel("Select Meta account for Creative Inbox"),
      `${path} explicit provider account`,
    ).toHaveValue("act_210009998877", { timeout: 30_000 });
    await expect(
      page.getByTestId("creative-inbox-studio-page"),
      `${path} inbox state`,
    ).toHaveAttribute("data-inbox-state", /ready|error/, { timeout: 30_000 });
  } else if (path === "/platforms/meta/audiences") {
    await expect(page.getByTestId("audience-readiness-ledger"), `${path} readiness ledger`).toBeVisible({
      timeout: 30_000,
    });
  } else if (
    path === "/platforms/meta/automation" ||
    path === "/platforms/meta/launchpad"
  ) {
    const viewportWidth = page.viewportSize()?.width ?? 1440;
    if (viewportWidth <= 720) {
      const testId = path.endsWith("/automation")
        ? "meta-mobile-automation"
        : "meta-mobile-launchpad";
      const readOnlyCopy = path.endsWith("/automation")
        ? /Read-only status/i
        : /Launchpad · read-only/i;
      await expect(
        page.getByTestId(testId),
        `${path} page-owned mobile read-only surface`,
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByText(readOnlyCopy),
        `${path} mobile write suppression`,
      ).toBeVisible({
        timeout: 30_000,
      });
    }
  }
}

async function assertRepresentativeVisualSettled(page: Page, path: string) {
  if (
    path.startsWith("/login") ||
    path.startsWith("/signup") ||
    path.startsWith("/invite/") ||
    path.startsWith("/select-language") ||
    path.startsWith("/share/") ||
    path.startsWith("/shopify/connect")
  ) {
    return;
  }

  await expect
    .poll(
      async () =>
        page
          .locator("body")
          .innerText({ timeout: 10_000 })
          .catch(() => ""),
      {
        message: `${path} representative screenshot still contains generic loading copy; render a truthful loaded empty/data state before screenshotting`,
        timeout: 30_000,
      },
    )
    .not.toMatch(
      /\bLoading\b|briefing loading|queue is loading|Waiting for .* payload/i,
    );
}

async function assertDarkConsoleContrast(page: Page, path: string) {
  const logo = page
    .locator('.ad-console-topbar img[alt="Adsecute logo"]')
    .first();
  if (await logo.isVisible().catch(() => false)) {
    await expect
      .poll(() => logo.evaluate((element) => getComputedStyle(element).filter), {
        message: `${path} leaves the black Adsecute mark unadjusted on the dark topbar`,
        timeout: 10_000,
      })
      .not.toBe("none");
  }

  const primaryActions = page.locator(".ad-final .btn--primary:visible");
  if ((await primaryActions.count()) === 0) return;

  const contrastRatios = await primaryActions.evaluateAll((elements) => {
    const rgb = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      if (channels.length !== 3) return null;
      return channels.map((channel) => channel / 255);
    };
    const luminance = (channels: number[]) =>
      channels
        .map((channel) =>
          channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce(
          (sum, channel, index) =>
            sum + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0),
          0,
        );

    return elements.map((element) => {
      const style = getComputedStyle(element);
      const foreground = rgb(style.color);
      const background = rgb(style.backgroundColor);
      if (!foreground || !background) return 0;
      const light = Math.max(luminance(foreground), luminance(background));
      const dark = Math.min(luminance(foreground), luminance(background));
      return (light + 0.05) / (dark + 0.05);
    });
  });

  expect(
    Math.min(...contrastRatios),
    `${path} dark primary action contrast ratios: ${contrastRatios
      .map((ratio) => ratio.toFixed(2))
      .join(", ")}`,
  ).toBeGreaterThanOrEqual(4.5);
}

async function smokeRoutes(context: BrowserContext, routes: readonly string[]) {
  for (const route of routes) {
    const routePage = await context.newPage();
    try {
      await assertRouteHealthy(routePage, route);
    } finally {
      await routePage.close();
    }
  }
}

test.describe("full UI redesign route and visual smoke", () => {
  test("covers every in-scope route and captures representative visuals", async ({
    page,
    playwright,
  }, testInfo) => {
    test.setTimeout(900_000);

    const darkProject = testInfo.project.name.endsWith("-dark");
    if (darkProject) {
      await page.context().addInitScript(() => {
        const enableDark = () => document.documentElement?.classList.add("dark");
        enableDark();
        document.addEventListener("DOMContentLoaded", enableDark, { once: true });
      });
    }

    const reviewerSeed = await seedReviewerAccount();
    const reviewer = {
      email: reviewerSeed.reviewer.email,
      password: reviewerSeed.reviewer.password,
    };
    await seedMetaDecisionDemoData();
    const admin = await seedAdminAccount();

    if (testInfo.project.name === "full-ui-desktop" && !VISUAL_ONLY) {
      const publicRequest = await playwright.request.newContext({
        baseURL: SMOKE_BASE_URL,
      });
      const dashboardRequest = await playwright.request.newContext({
        baseURL: SMOKE_BASE_URL,
      });
      const adminRequest = await playwright.request.newContext({
        baseURL: SMOKE_BASE_URL,
      });
      try {
        await smokeRouteResponses(publicRequest, PUBLIC_ROUTES);
        await signInRequest(dashboardRequest, reviewer);
        await smokeRouteResponses(dashboardRequest, DASHBOARD_ROUTES);
        await signInRequest(adminRequest, admin);
        await smokeRouteResponses(adminRequest, ADMIN_ROUTES);
      } finally {
        await publicRequest.dispose();
        await dashboardRequest.dispose();
        await adminRequest.dispose();
      }
    }

    for (const shot of ACTIVE_SCREENSHOT_ROUTES) {
      if (shot.actor === "admin") {
        await signIn(page, admin);
      } else if (shot.actor === "dashboard") {
        await signIn(page, reviewer);
      }

      const shotPage = await page.context().newPage();
      try {
        await assertRouteHealthy(shotPage, shot.path);
        await waitForDashboardWorkspaceReady(shotPage, shot.path);
        await assertRepresentativeVisualSettled(shotPage, shot.path);

        // No surface may scroll the page sideways on a phone. A single
        // overflowing child does it, and it is exactly how the assessment
        // column ended up off-screen in the 390px Studio artifact. A passing
        // screenshot is not acceptance if content is pushed out of frame, so
        // this is asserted rather than eyeballed.
        if ((shotPage.viewportSize()?.width ?? 1440) <= 480) {
          const overflow = await shotPage.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          }));
          expect(
            overflow.scrollWidth,
            `${shot.path} scrolls horizontally at ${overflow.innerWidth}px (scrollWidth ${overflow.scrollWidth})`,
          ).toBeLessThanOrEqual(overflow.innerWidth);
        }

        // Page-level overflow is not enough: a frame with overflow:auto keeps
        // the page from scrolling while its own content is still cut off, which
        // is exactly how the assessment column stayed off-screen at 390px while
        // every page-level check passed. Assert no scroller hides content.
        if ((shotPage.viewportSize()?.width ?? 1440) <= 480) {
          const clipped = await shotPage.evaluate(() => {
            const offenders: string[] = [];
            for (const element of Array.from(
              document.body.querySelectorAll<HTMLElement>("*"),
            )) {
              const style = window.getComputedStyle(element);
              const scrolls =
                style.overflowX === "auto" || style.overflowX === "scroll";
              if (!scrolls) continue;
              const hidden = element.scrollWidth - element.clientWidth;
              // Tab strips and toolbars are deliberately swipeable; a data
              // frame hiding a column is not the same thing, so only flag
              // scrollers that actually contain tabular content.
              if (hidden > 4 && element.querySelector("table")) {
                offenders.push(
                  `${element.className || element.tagName} hides ${hidden}px`,
                );
              }
            }
            return offenders.slice(0, 5);
          });
          expect(
            clipped,
            `${shot.path} clips tabular content inside a scroller`,
          ).toEqual([]);
        }

        // Live accessibility checks. These need a real browser: focus
        // visibility, Escape behaviour and zoom cannot be read off markup.
        {
          // 1. Every focusable control has a visible focus indicator. A focus
          //    ring removed for aesthetics makes keyboard navigation invisible.
          const focusInvisible = await shotPage.evaluate(() => {
            const offenders: string[] = [];
            const focusables = Array.from(
              document.querySelectorAll<HTMLElement>(
                "a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex='-1'])",
              ),
            ).slice(0, 40);
            for (const element of focusables) {
              element.focus();
              if (document.activeElement !== element) continue;
              const style = window.getComputedStyle(element);
              const hasRing =
                style.outlineStyle !== "none" ||
                style.boxShadow !== "none" ||
                style.borderColor !== "";
              if (!hasRing) offenders.push(element.tagName.toLowerCase());
            }
            return offenders.slice(0, 5);
          });
          expect(
            focusInvisible,
            `${shot.path} has focusable controls with no visible focus`,
          ).toEqual([]);

          // 2. No positive tabindex. It reorders the whole page's tab sequence
          //    and is nearly always a bug rather than an intent.
          const positiveTabindex = await shotPage.evaluate(
            () =>
              Array.from(document.querySelectorAll("[tabindex]")).filter(
                (element) =>
                  Number.parseInt(element.getAttribute("tabindex") ?? "0", 10) > 0,
              ).length,
          );
          expect(
            positiveTabindex,
            `${shot.path} uses a positive tabindex`,
          ).toBe(0);

          // 3. Every image is either described or explicitly decorative. An
          //    undescribed image is announced as its file name.
          const undescribedImages = await shotPage.evaluate(
            () =>
              Array.from(document.querySelectorAll("img")).filter(
                (image) =>
                  image.getAttribute("alt") === null &&
                  image.getAttribute("aria-hidden") !== "true" &&
                  image.getAttribute("role") !== "presentation",
              ).length,
          );
          expect(
            undescribedImages,
            `${shot.path} has images with neither alt nor aria-hidden`,
          ).toBe(0);

          // 4. Reduced motion is honoured: no element may animate when the
          //    viewer has asked for stillness.
          await shotPage.emulateMedia({ reducedMotion: "reduce" });
          const animating = await shotPage.evaluate(() => {
            return Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
              (element) => {
                const style = window.getComputedStyle(element);
                const duration = Number.parseFloat(style.animationDuration);
                return (
                  style.animationName !== "none" &&
                  Number.isFinite(duration) &&
                  duration > 0.05
                );
              },
            ).length;
          });
          await shotPage.emulateMedia({ reducedMotion: null });
          expect(
            animating,
            `${shot.path} keeps animating under prefers-reduced-motion`,
          ).toBe(0);
        }

        // The typography floor, checked on what the browser actually computed
        // rather than on the stylesheet: a cascade or an inline style can
        // still land under it.
        const tinyText = await shotPage.evaluate(() => {
          const offenders: string[] = [];
          for (const element of Array.from(document.body.querySelectorAll("*"))) {
            const text = (element.textContent ?? "").trim();
            if (!text || element.children.length > 0) continue;
            const size = Number.parseFloat(
              window.getComputedStyle(element).fontSize,
            );
            if (Number.isFinite(size) && size < 11) {
              const cls =
                typeof element.className === "string"
                  ? element.className.slice(0, 60)
                  : "";
              offenders.push(
                `${element.tagName.toLowerCase()}.${cls} @ ${size}px :: ${text.slice(0, 24)}`,
              );
            }
          }
          return offenders.slice(0, 10);
        });
        expect(
          tinyText,
          `${shot.path} renders text below the 11px floor`,
        ).toEqual([]);
        if (darkProject && shot.actor !== "public") {
          await expect
            .poll(
              () =>
                shotPage.locator(".ad-console-shell").evaluate((element) =>
                  getComputedStyle(element).getPropertyValue("--adc-s1").trim(),
                ),
              {
                message: `${shot.path} did not activate the dark console token set`,
                timeout: 10_000,
              },
            )
            .toBe("#111315");
          await assertDarkConsoleContrast(shotPage, shot.path);
        }
        await shotPage.screenshot({
          path: testInfo.outputPath(
            `${testInfo.project.name}-${shot.name}.png`,
          ),
          fullPage: true,
        });

        const advancedCalendarTestId =
          shot.name === "meta-decisions"
            ? "meta-decisions-date-range-picker-trigger"
            : shot.name === "creative-studio"
              ? "creative-studio-date-range-picker-trigger"
              : null;
        if (advancedCalendarTestId) {
          const calendarTrigger = shotPage.getByTestId(advancedCalendarTestId);
          const calendarRoot = shotPage.getByTestId(
            advancedCalendarTestId.replace(/-trigger$/, ""),
          );
          await expect(calendarTrigger, `${shot.name} advanced calendar trigger`).toBeVisible();
          await expect(calendarRoot).toHaveAttribute("data-hydrated", "true");
          await calendarTrigger.click();
          await expect(
            shotPage.getByText("Quick Select", { exact: true }),
            `${shot.name} quick ranges`,
          ).toBeVisible();
          const visibleCalendars = shotPage.locator(
            'section[aria-label$=" calendar"]:visible',
          );
          // The calendar collapses to a single month on narrow viewports. Key
          // the expectation off the actual width, not off one project name --
          // otherwise every new width added to the matrix inherits the wrong
          // expectation and fails for a reason that has nothing to do with it.
          const calendarViewport = shotPage.viewportSize();
          await expect(visibleCalendars).toHaveCount(
            (calendarViewport?.width ?? 1440) < 640 ? 1 : 2,
          );
          await expect
            .poll(() =>
              shotPage.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
              ),
            )
            .toBe(true);
          await shotPage.screenshot({
            path: testInfo.outputPath(
              `${testInfo.project.name}-${shot.name}-calendar.png`,
            ),
            fullPage: true,
          });
          await shotPage.keyboard.press("Escape");
        }

        const singleDatePickerTestId =
          shot.name === "meta-history"
            ? "meta-history-from-date-trigger"
            : shot.name === "admin-discount-new"
              ? "discount-valid-from-trigger"
              : null;
        if (singleDatePickerTestId) {
          const dateTrigger = shotPage.getByTestId(singleDatePickerTestId);
          const datePickerRoot = shotPage.getByTestId(
            singleDatePickerTestId.replace(/-trigger$/, ""),
          );
          await expect(dateTrigger, `${shot.name} date picker trigger`).toBeVisible();
          await expect(datePickerRoot).toHaveAttribute("data-hydrated", "true");
          await dateTrigger.click();
          await expect(
            shotPage.locator('section[aria-label$=" calendar"]:visible'),
            `${shot.name} calendar`,
          ).toHaveCount(1);
          await expect
            .poll(() =>
              shotPage.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
              ),
            )
            .toBe(true);
          await shotPage.screenshot({
            path: testInfo.outputPath(
              `${testInfo.project.name}-${shot.name}-calendar.png`,
            ),
            fullPage: true,
          });
          await shotPage.keyboard.press("Escape");
        }

        if (
          shot.name === "meta-decisions" &&
          testInfo.project.name === "full-ui-desktop"
        ) {
          const primarySidebar = shotPage.locator("[data-shell-sidebar]");
          await expect(
            primarySidebar,
            "Meta Decisions must keep the single global application sidebar",
          ).toHaveCount(1);
          await expect
            .poll(() => primarySidebar.evaluate((element) => element.getBoundingClientRect().width))
            .toBe(196);

          const collapseNavigation = shotPage.getByRole("button", {
            name: "Collapse navigation",
          });
          await expect(collapseNavigation).toBeVisible();
          await collapseNavigation.click();
          await expect
            .poll(() => primarySidebar.evaluate((element) => element.getBoundingClientRect().width))
            .toBe(56);
          await expect(shotPage.getByRole("button", { name: "Expand navigation" })).toBeVisible();
          await shotPage.screenshot({
            path: testInfo.outputPath(
              `${testInfo.project.name}-${shot.name}-navigation-collapsed.png`,
            ),
            fullPage: true,
          });
          await shotPage.getByRole("button", { name: "Expand navigation" }).click();
          await expect
            .poll(() => primarySidebar.evaluate((element) => element.getBoundingClientRect().width))
            .toBe(196);

          const evidenceTrigger = shotPage
            .getByTestId("structure-decision-list")
            .locator("button[data-child]")
            .first();
          await expect(
            evidenceTrigger,
            "Meta Decisions evidence affordance",
          ).toBeVisible({
            timeout: 30_000,
          });
          await evidenceTrigger.click();
          await expect(
            shotPage.getByRole("complementary", { name: "Decision inspector" }),
            "Meta Decisions inspector",
          ).toBeVisible({
            timeout: 30_000,
          });
          await shotPage.getByRole("button", { name: /How this was decided/i }).click();
          // The disclosure names the engine record the decision came from. For a
          // structure node that is the source recommendation and its version; the
          // ad-level trail shows a post-authority raw label and engine version
          // instead. Assert the version is actually populated, not merely that a
          // heading rendered — an empty version is the failure worth catching.
          await expect(
            shotPage.getByText("Source recommendation", { exact: true }),
            "Meta Decisions versioned engine evidence",
          ).toBeVisible();
          await expect(
            shotPage
              .locator("dt", { hasText: /^Recommendation version$/ })
              .locator("xpath=following-sibling::dd[1]"),
            "Meta Decisions engine evidence must carry a version",
          ).not.toBeEmpty();
          await shotPage.screenshot({
            path: testInfo.outputPath(
              `${testInfo.project.name}-${shot.name}-inspector.png`,
            ),
            fullPage: true,
          });
        } else if (
          shot.name === "meta-decisions" &&
          testInfo.project.name === "full-ui-mobile"
        ) {
          const mobileEvidenceTrigger = shotPage
            .getByTestId("structure-decision-list")
            .locator("button[data-child]")
            .first();
          await expect(
            mobileEvidenceTrigger,
            "Meta Decisions mobile evidence affordance",
          ).toBeVisible({
            timeout: 30_000,
          });
          await mobileEvidenceTrigger.click();
          await expect(
            shotPage.getByRole("complementary", { name: "Decision inspector" }),
            "Meta Decisions mobile evidence view",
          ).toBeVisible({
            timeout: 30_000,
          });
          await expect(
            shotPage.getByText(
              /^(Monitoring · no provider write|Action blocked)$/,
            ),
            "Meta Decisions mobile write suppression",
          ).toBeVisible();
        } else if (shot.name === "creative-studio") {
          const usageTrigger = shotPage
            .getByTitle("Open exact ad usage performance")
            .first();
          await expect(usageTrigger, "Creative Studio exact-ad usage trigger").toBeVisible();
          await usageTrigger.click();
          const usageDrawer = shotPage.getByRole("complementary", {
            name: "Creative ad usage performance",
          });
          await expect(usageDrawer, "Creative Studio exact-ad usage drawer").toBeVisible({
            timeout: 30_000,
          });
          await expect(
            usageDrawer.getByText("Ad m-ad-1", { exact: true }),
            "Creative Studio verified ad identity",
          ).toBeVisible({ timeout: 30_000 });
          await shotPage.screenshot({
            path: testInfo.outputPath(
              `${testInfo.project.name}-${shot.name}-usage.png`,
            ),
            fullPage: true,
          });
        } else if (
          (shot.name === "automation" || shot.name === "launchpad") &&
          testInfo.project.name === "full-ui-mobile"
        ) {
          const testId =
            shot.name === "automation"
              ? "meta-mobile-automation"
              : "meta-mobile-launchpad";
          const readOnlyCopy =
            shot.name === "automation"
              ? /Read-only status/i
              : /Launchpad · read-only/i;
          await expect(
            shotPage.getByTestId(testId),
            `${shot.name} mobile read-only surface`,
          ).toBeVisible({
            timeout: 30_000,
          });
          await expect(
            shotPage.getByText(readOnlyCopy),
            `${shot.name} mobile desktop-only notice`,
          ).toBeVisible();
        }
      } finally {
        await shotPage.close();
      }
    }
  });
});
