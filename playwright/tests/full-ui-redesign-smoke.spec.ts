import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { seedReviewerAccount } from "../helpers/reviewer-auth";

const DEMO_BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const SMOKE_UUID = "00000000-0000-4000-8000-000000000000";
// Single source of truth for the request contexts' base URL. Mirrors the value
// playwright.full-ui-redesign.config.ts derives, avoiding the untyped
// testInfo.config.use access (FullConfig does not expose `use` in its types).
const SMOKE_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3107";
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
  { actor: "dashboard", path: "/platforms/meta/creatives", name: "creative-studio" },
  { actor: "dashboard", path: "/platforms/meta/launchpad", name: "launchpad" },
  { actor: "dashboard", path: "/platforms/meta/automation", name: "automation" },
  { actor: "dashboard", path: "/reports", name: "reports" },
  { actor: "dashboard", path: "/settings", name: "settings" },
  { actor: "admin", path: "/admin", name: "admin" },
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
    : SCREENSHOT_ROUTES.filter((shot) => SELECTED_SCREENSHOT_NAMES.has(shot.name));

async function seedAdminAccount(): Promise<SmokeActor> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for full UI smoke admin seed.");

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
  if (!databaseUrl) throw new Error("DATABASE_URL is required for full UI smoke decision seed.");

  const snapshotDate = new Date().toISOString().slice(0, 10);
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
    summary: "The ad set has enough spend and purchase evidence to review for pause.",
    recommendedAction: "Pause adset",
    expectedImpact: "Stops current waste while evidence is rechecked in the inspector.",
    evidence: [
      { label: "Spend", value: "$1,180", tone: "neutral" },
      { label: "ROAS", value: "2.36x", tone: "warning" },
      { label: "Purchases", value: "28", tone: "neutral" },
    ],
    timeframeContext: {
      coreVerdict: "Below target with material spend.",
      selectedRangeOverlay: "28d demo smoke row for visual verification.",
      historicalSupport: "Seeded for UI smoke only; production data is not touched.",
      seasonalityFlag: "none",
      note: null,
    },
    targetValue: { action: "pause", spend: 1180, roas: 2.36 },
    proposedAction: { kind: "pause" },
    predictiveOverlay: "Decision row is present to verify reference-fidelity screenshots.",
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
      [DEMO_BUSINESS_ID, campaignId, "demo-meta-1", "Backpack Video Ads"],
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
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  const loginResponse = await page.evaluate(
    async ({ email, password }) => {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
      };
    },
    actor,
  );

  expect(loginResponse, `login failed for ${actor.email}`).toMatchObject({ ok: true });
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const response = await fetch("/api/auth/me", {
          credentials: "include",
          cache: "no-store",
        });
        return response.status;
      }),
    )
    .toBe(200);
}

async function signInRequest(context: APIRequestContext, actor: SmokeActor) {
  const response = await context.post("/api/auth/login", {
    data: actor,
  });
  expect(response.ok(), `request login failed for ${actor.email}: ${response.status()}`).toBe(true);
}

async function assertRouteResponseHealthy(context: APIRequestContext, path: string) {
  const response = await context.get(path, {
    maxRedirects: 5,
    timeout: 60_000,
  });
  expect(response.status(), `${path} returned ${response.status()}`).toBeLessThan(500);
  const contentType = response.headers()["content-type"] ?? "";
  if (contentType.includes("text/html")) {
    const body = await response.text();
    expect(body, `${path} server HTML still exposes old Pulse product language`).not.toMatch(/\bPulse\b/);
    expect(body, `${path} server HTML rendered a fatal app error`).not.toMatch(
      /Application error|Unhandled Runtime Error|Hydration failed/i,
    );
  }
}

async function smokeRouteResponses(context: APIRequestContext, routes: readonly string[]) {
  for (const route of routes) {
    await assertRouteResponseHealthy(context, route);
  }
}

async function assertRouteHealthy(page: Page, path: string) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto(path, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const status = response?.status() ?? 200;
  expect(status, `${path} returned ${status}`).toBeLessThan(500);

  await page.waitForTimeout(250);
  await expect(page.locator("body"), `${path} body`).toBeVisible();

  const bodyText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  expect(bodyText, `${path} rendered a client/runtime crash`).not.toMatch(
    /Application error|Unhandled Runtime Error|Hydration failed/i,
  );
  expect(bodyText, `${path} still exposes old Pulse product language`).not.toMatch(/\bPulse\b/);

  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
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

  await expect(page.getByTestId("business-guard-loading"), `${path} business guard`).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByText(/Loading workspace/i), `${path} workspace loader`).toHaveCount(0, {
    timeout: 30_000,
  });
  if (path === "/platforms/meta") {
    const viewportWidth = page.viewportSize()?.width ?? 1440;
    if (viewportWidth >= 900) {
      await expect(page.getByTestId("meta-overnight-digest"), `${path} decisions digest`).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(/Action Now/i).first(), `${path} action queue`).toBeVisible({
        timeout: 30_000,
      });
    } else {
      await expect(page.locator(".meta-mobile-decision-stage"), `${path} mobile read-only surface`).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(/Writes are desktop-only/i), `${path} mobile write suppression`).toBeVisible({
        timeout: 30_000,
      });
    }
  } else if (path === "/platforms/meta/automation" || path === "/platforms/meta/launchpad") {
    const viewportWidth = page.viewportSize()?.width ?? 1440;
    if (viewportWidth < 900) {
      const testId = path.endsWith("/automation") ? "meta-mobile-automation" : "meta-mobile-launchpad";
      await expect(page.getByTestId(testId), `${path} page-owned mobile read-only surface`).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(/Mobile is read-only/i), `${path} mobile write suppression`).toBeVisible({
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
      async () => page.locator("body").innerText({ timeout: 10_000 }).catch(() => ""),
      {
        message: `${path} representative screenshot still contains generic loading copy; render a truthful loaded empty/data state before screenshotting`,
        timeout: 30_000,
      },
    )
    .not.toMatch(/\bLoading\b|briefing loading|queue is loading|Waiting for .* payload/i);
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
  test("covers every in-scope route and captures representative visuals", async ({ page, playwright }, testInfo) => {
    test.setTimeout(900_000);

    const reviewerSeed = await seedReviewerAccount();
    const reviewer = {
      email: reviewerSeed.reviewer.email,
      password: reviewerSeed.reviewer.password,
    };
    await seedMetaDecisionDemoData();
    const admin = await seedAdminAccount();

    if (testInfo.project.name === "full-ui-desktop" && !VISUAL_ONLY) {
      const publicRequest = await playwright.request.newContext({ baseURL: SMOKE_BASE_URL });
      const dashboardRequest = await playwright.request.newContext({ baseURL: SMOKE_BASE_URL });
      const adminRequest = await playwright.request.newContext({ baseURL: SMOKE_BASE_URL });
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
        await shotPage.screenshot({
          path: testInfo.outputPath(`${testInfo.project.name}-${shot.name}.png`),
          fullPage: true,
        });
        if (shot.name === "meta-decisions" && testInfo.project.name === "full-ui-desktop") {
          const digestToggle = shotPage.getByRole("button", { name: /Since last snapshot/i });
          await expect(digestToggle, "Meta Decisions digest toggle").toBeVisible({
            timeout: 30_000,
          });
          await digestToggle.click();
          await expect(shotPage.getByText(/Label flips:/i), "Meta Decisions digest label details").toBeVisible();
          await expect(shotPage.getByText(/Actions:/i), "Meta Decisions digest action details").toBeVisible();
          await expect(shotPage.getByText(/Deferrals due back:/i), "Meta Decisions digest deferral details").toBeVisible();
          await digestToggle.click();
          const evidenceTrigger = shotPage.getByRole("button", { name: /Open evidence/i }).first();
          await expect(evidenceTrigger, "Meta Decisions evidence affordance").toBeVisible({
            timeout: 30_000,
          });
          await evidenceTrigger.click();
          await expect(shotPage.locator('[data-drawer="meta-drill"]'), "Meta Decisions inspector").toBeVisible({
            timeout: 30_000,
          });
          await expect(shotPage.locator('[data-inspector-section="raw-json"]'), "Meta Decisions raw JSON section").toBeVisible();
          await shotPage.screenshot({
            path: testInfo.outputPath(`${testInfo.project.name}-${shot.name}-inspector.png`),
            fullPage: true,
          });
        } else if (shot.name === "meta-decisions" && testInfo.project.name === "full-ui-mobile") {
          const mobileEvidenceTrigger = shotPage.getByRole("button", { name: /Read evidence/i }).first();
          await expect(mobileEvidenceTrigger, "Meta Decisions mobile evidence affordance").toBeVisible({
            timeout: 30_000,
          });
          await mobileEvidenceTrigger.click();
          await expect(shotPage.getByTestId("meta-mobile-evidence"), "Meta Decisions mobile evidence view").toBeVisible({
            timeout: 30_000,
          });
          await expect(shotPage.getByText(/Act on desktop/i), "Meta Decisions mobile desktop-only notice").toBeVisible();
        } else if (
          (shot.name === "automation" || shot.name === "launchpad") &&
          testInfo.project.name === "full-ui-mobile"
        ) {
          const testId = shot.name === "automation" ? "meta-mobile-automation" : "meta-mobile-launchpad";
          await expect(shotPage.getByTestId(testId), `${shot.name} mobile read-only surface`).toBeVisible({
            timeout: 30_000,
          });
          await expect(shotPage.getByText(/Mobile is read-only/i), `${shot.name} mobile desktop-only notice`).toBeVisible();
        }
      } finally {
        await shotPage.close();
      }
    }
  });
});
