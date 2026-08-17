import { expect, test, type Page } from "@playwright/test";

const STANDARD_DATE_RANGE = {
  rangePreset: "30d",
  customStart: "",
  customEnd: "",
  comparisonPreset: "none",
  comparisonStart: "",
  comparisonEnd: "",
} as const;

const BROWSER_DECISION_RANGES = [
  {
    label: "last 30d",
    standard: STANDARD_DATE_RANGE,
    creative: {
      preset: "last30Days",
      customStart: "",
      customEnd: "",
      lastDays: 30,
      sinceDate: "",
    },
  },
  {
    label: "today",
    standard: {
      rangePreset: "today",
      customStart: "",
      customEnd: "",
      comparisonPreset: "none",
      comparisonStart: "",
      comparisonEnd: "",
    },
    creative: {
      preset: "today",
      customStart: "",
      customEnd: "",
      lastDays: 30,
      sinceDate: "",
    },
  },
  {
    label: "last 7d",
    standard: {
      rangePreset: "7d",
      customStart: "",
      customEnd: "",
      comparisonPreset: "none",
      comparisonStart: "",
      comparisonEnd: "",
    },
    creative: {
      preset: "last7Days",
      customStart: "",
      customEnd: "",
      lastDays: 30,
      sinceDate: "",
    },
  },
  {
    label: "previous month",
    standard: {
      rangePreset: "lastMonth",
      customStart: "",
      customEnd: "",
      comparisonPreset: "none",
      comparisonStart: "",
      comparisonEnd: "",
    },
    creative: {
      preset: "lastMonth",
      customStart: "",
      customEnd: "",
      lastDays: 30,
      sinceDate: "",
    },
  },
  {
    label: "custom past range",
    standard: {
      rangePreset: "custom",
      customStart: "2026-02-01",
      customEnd: "2026-02-10",
      comparisonPreset: "none",
      comparisonStart: "",
      comparisonEnd: "",
    },
    creative: {
      preset: "custom",
      customStart: "2026-02-01",
      customEnd: "2026-02-10",
      lastDays: 30,
      sinceDate: "",
    },
  },
] as const;

function normalizeText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function metaOperatingModeCard(page: Page) {
  return page.locator('section[data-testid="meta-operating-mode-card"]:visible').first();
}

async function openMetaSupportingContext(page: Page) {
  const supportingContext = page.getByTestId("meta-supporting-context");
  await expect(supportingContext).toBeVisible();
  const isOpen = await supportingContext.evaluate((element) =>
    element.hasAttribute("open"),
  );
  if (!isOpen) {
    await supportingContext.locator("summary").click();
  }
}

async function runMetaAnalysis(page: Page) {
  await expect(page.getByTestId("meta-analysis-status-card")).toBeVisible();
  await expect(page.getByTestId("meta-decision-os-empty")).toBeVisible();

  const decisionOsResponse = page.waitForResponse((response) =>
    response.url().includes("/api/meta/decision-os") &&
    response.request().method() === "GET",
  );
  const recommendationsResponse = page.waitForResponse((response) =>
    response.url().includes("/api/meta/recommendations") &&
    response.request().method() === "GET",
  );

  await page.getByRole("button", { name: /^Run analysis$/i }).first().click();
  const [decisionOs, recommendations] = await Promise.all([
    decisionOsResponse,
    recommendationsResponse,
  ]);
  expect(decisionOs.ok()).toBeTruthy();
  expect(recommendations.ok()).toBeTruthy();

  await expect(page.getByTestId("meta-analysis-status-card")).toContainText(
    "Last successful analysis",
    { timeout: 60_000 },
  );
  await expect(page.getByTestId("meta-decision-os-overview")).toBeVisible({
    timeout: 60_000,
  });
}

async function openMetaCampaignReasoning(page: Page) {
  const campaignReasoning = page.getByTestId("meta-campaign-reasoning");
  if ((await campaignReasoning.count()) === 0) {
    return false;
  }
  await expect(campaignReasoning).toBeVisible();
  const isOpen = await campaignReasoning.evaluate((element) =>
    element.hasAttribute("open"),
  );
  if (!isOpen) {
    await campaignReasoning.locator("summary").click();
  }
  return true;
}

async function setStoredDateRange(
  page: Page,
  key: "metaDateRange" | "commandCenterDateRange" | "creativeDateRange",
  value: Record<string, unknown>,
) {
  await page.evaluate(({ key, value }) => {
    const storageKey = "omniads-preferences-store-v1";
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : { state: {}, version: 0 };
    parsed.state = {
      ...(parsed.state ?? {}),
      [key]: value,
    };
    window.localStorage.setItem(storageKey, JSON.stringify(parsed));
  }, { key, value });
}

async function captureMetaDecisionSignature(
  page: Page,
) {
  return {
    authority: normalizeText(
      await page.getByTestId("meta-authority-readiness").textContent(),
    ),
    decisionOs: normalizeText(
      await page.getByTestId("meta-decision-os-overview").textContent(),
    ),
    topActionCore: normalizeText(
      await page.getByTestId("meta-top-action-core").textContent(),
    ),
    watchlist: normalizeText(
      await page.getByTestId("meta-watchlist-degraded").textContent(),
    ),
    protected: normalizeText(
      await page.getByTestId("meta-no-touch-list").textContent(),
    ),
  };
}

async function captureCommandCenterDecisionSignature(
  page: Page,
) {
  const budgetSummary = normalizeText(
    await page.getByTestId("command-center-budget-summary").textContent(),
  );
  const shiftDigest = normalizeText(
    await page.getByTestId("command-center-shift-digest").textContent(),
  );
  const cards = page.locator('[data-testid^="command-center-action-"]');
  const count = Math.min(await cards.count(), 3);
  const entries: string[] = [];
  for (let index = 0; index < count; index += 1) {
    entries.push(normalizeText(await cards.nth(index).textContent()));
  }
  return {
    budgetSummary,
    shiftDigest,
    entries,
  };
}

async function captureCommandCenterHistoricalSignature(page: Page) {
  return normalizeText(
    await page.getByTestId("command-center-historical-intelligence").textContent(),
  );
}

async function expectCreativeDashboardWithoutDecisionUi(page: Page) {
  await expect(page.getByRole("heading", { name: "Creatives", exact: true })).toBeVisible();
  await expect(page.getByText("Top Creatives").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add filter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeVisible();
  await expect(page.getByText("Spend").first()).toBeVisible();
  await expect(page.getByText("Purchase value").first()).toBeVisible();
  await expect(page.getByText("ROAS (return on ad spend)").first()).toBeVisible();
  await expect(page.getByText("Cost per purchase").first()).toBeVisible();
  await expect(page.getByText("Link CTR").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Table settings" })).toBeVisible();
  await expect(page.getByText("AI tags").first()).toBeVisible();

  await expect(page.getByRole("button", { name: /Decision/ })).toHaveCount(0);
  await expect(page.getByText("Decision OS")).toHaveCount(0);
  await expect(page.getByText("Decision Center")).toHaveCount(0);
  await expect(page.getByText("Today Brief")).toHaveCount(0);
  await expect(page.getByText("Action Board")).toHaveCount(0);
  await expect(page.getByTestId("creative-decision-os-drawer")).toHaveCount(0);
  await expect(page.getByTestId("creative-decision-os-overview")).toHaveCount(0);
  await expect(page.getByTestId("creative-preview-truth-contract")).toHaveCount(0);
  await expect(page.getByTestId("creative-quick-filters-panel")).toHaveCount(0);
  await expect(page.getByTestId("creative-quick-filters")).toHaveCount(0);

  const creativeRows = page.locator('[data-testid^="creative-row-"]');
  await expect(creativeRows.first()).toBeVisible();
}

async function commandCenterViewCandidates(page: Page) {
  const candidates = [page.getByRole("button", { name: "Default queue", exact: true })];
  const savedViews = page.locator('[data-testid^="command-center-view-"]');
  const savedViewCount = await savedViews.count();
  for (let index = 0; index < savedViewCount; index += 1) {
    candidates.push(savedViews.nth(index));
  }
  return candidates;
}

async function selectFirstCommandCenterViewWithActions(page: Page) {
  const viewCandidates = await commandCenterViewCandidates(page);

  for (const candidate of viewCandidates) {
    await candidate.click();
    const queueActions = page.locator('[data-testid^="command-center-action-"]');
    if ((await queueActions.count()) > 0) {
      return queueActions;
    }
  }

  throw new Error("No Command Center action cards were visible in any fallback view.");
}

async function selectFirstCommandCenterViewWithBatchReadyActions(page: Page) {
  const viewCandidates = await commandCenterViewCandidates(page);

  for (const candidate of viewCandidates) {
    await candidate.click();
    const batchToggles = page.locator('[data-testid^="command-center-batch-toggle-"]');
    if ((await batchToggles.count()) > 0) {
      return batchToggles;
    }
  }

  return null;
}

async function openFirstCampaignAwareMetaCommandCenterAction(page: Page) {
  const viewCandidates = await commandCenterViewCandidates(page);

  for (const candidate of viewCandidates) {
    await candidate.click();
    const metaActions = page
      .locator('[data-testid^="command-center-action-"]')
      .filter({ hasText: "Meta Decision OS" });
    const count = await metaActions.count();
    for (let index = 0; index < count; index += 1) {
      const metaAction = metaActions.nth(index);
      await metaAction.click();
      const metaWorkflowDialog = page.getByRole("dialog");
      await expect(metaWorkflowDialog).toBeVisible();
      const href = await metaWorkflowDialog
        .getByRole("link", { name: "Open source surface" })
        .getAttribute("href");
      if (href?.includes("campaignId=")) {
        return metaWorkflowDialog;
      }
      await metaWorkflowDialog.getByRole("button", { name: "Close", exact: true }).click();
    }
  }

  throw new Error("No campaign-aware Meta-backed Command Center action was visible in fallback views.");
}

test("commercial truth navigation relocation keeps Commercial Truth under Main and out of Settings", async ({ page }) => {
  await page.goto("/commercial-truth");
  await expect(page).toHaveURL(/\/commercial-truth$/);
  await expect(
    page.locator("main").getByRole("heading", { name: "Commercial Truth", level: 1 }),
  ).toBeVisible();

  const commercialTruthNavLink = page.locator('aside a[href="/commercial-truth"]').first();
  await expect(commercialTruthNavLink).toBeVisible();
  await expect(commercialTruthNavLink).toHaveClass(/bg-primary/);

  await expect(page.getByTestId("commercial-truth-settings")).toBeVisible();
  await page.getByTestId("commercial-target-roas").fill("3.1");
  await page.getByTestId("commercial-break-even-roas").fill("1.85");
  await page.getByTestId("commercial-gross-margin").fill("70%");
  await page.getByTestId("commercial-cost-shipping").fill("8%");
  await page.getByTestId("commercial-cost-processing").fill("3%");

  const [saveResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/api/business-commercial-settings") &&
      response.request().method() === "PUT",
    ),
    page.getByTestId("commercial-settings-save").click(),
  ]);
  expect(saveResponse.ok()).toBeTruthy();

  await page.reload();
  await expect(page.getByTestId("commercial-truth-settings")).toBeVisible();
  await expect(page.getByTestId("commercial-target-roas")).toHaveValue("3.10");
  await expect(page.getByTestId("commercial-break-even-roas")).toHaveValue("1.85");
  await expect(page.getByTestId("commercial-gross-margin")).toHaveValue("70%");
  await expect(page.getByTestId("commercial-cost-shipping")).toHaveValue("8%");
  await expect(page.getByTestId("commercial-cost-processing")).toHaveValue("3%");

  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("commercial-truth-settings")).toHaveCount(0);
});

test("commercial truth smoke covers the dedicated page, Meta operating mode, and Creative dashboard", async ({ page }, testInfo) => {
  test.slow();

  await page.goto("/commercial-truth");
  await expect(page).toHaveURL(/\/commercial-truth$/);
  await expect(
    page.locator("main").getByRole("heading", { name: "Commercial Truth", level: 1 }),
  ).toBeVisible();
  const commercialTruthNavLink = page.locator('aside a[href="/commercial-truth"]').first();
  await expect(commercialTruthNavLink).toBeVisible();
  await expect(commercialTruthNavLink).toHaveClass(/bg-primary/);

  await expect(page.getByTestId("commercial-truth-settings")).toBeVisible();
  await page.getByTestId("commercial-target-roas").fill("3.1");
  await page.getByTestId("commercial-break-even-roas").fill("1.9");
  const [saveResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/api/business-commercial-settings") &&
      response.request().method() === "PUT",
    ),
    page.getByTestId("commercial-settings-save").click(),
  ]);
  expect(saveResponse.ok()).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("commercial-truth-page.png"),
    fullPage: true,
  });

  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("commercial-truth-settings")).toHaveCount(0);

  await page.goto("/platforms/meta");
  await page.getByText("Loading campaign performance").waitFor({ state: "hidden", timeout: 45_000 }).catch(() => {});
  await openMetaSupportingContext(page);
  const operatingModeCard = metaOperatingModeCard(page);
  await expect(operatingModeCard).toBeVisible();
  await expect(operatingModeCard).toContainText("Operating Mode");
  await expect(operatingModeCard).toContainText(/Current Mode|Recommended Mode/);
  await expect(operatingModeCard).toContainText("Decisions use live windows");
  await expect(operatingModeCard).toContainText("Selected period affects analysis only");
  await expect(operatingModeCard).not.toContainText("Loading operating mode...");
  const metaOverview = page.getByTestId("meta-decision-os-overview").first();
  await expect(page.getByTestId("meta-decision-os-empty")).toBeVisible();
  await runMetaAnalysis(page);
  await expect(metaOverview).toBeVisible();
  await expect(page.getByTestId("meta-authority-readiness")).toBeVisible();
  await expect(page.getByTestId("meta-operator-plan-summary")).toBeVisible();
  await expect(page.getByTestId("meta-top-action-core")).toBeVisible();
  await expect(page.getByTestId("meta-watchlist-degraded")).toBeVisible();
  await expect(page.getByTestId("meta-no-touch-list")).toBeVisible();
  let metaBaseline: Awaited<ReturnType<typeof captureMetaDecisionSignature>> | null = null;
  for (const range of BROWSER_DECISION_RANGES) {
    await setStoredDateRange(page, "metaDateRange", range.standard);
    await page.reload();
    await page.getByText("Loading campaign performance").waitFor({ state: "hidden", timeout: 45_000 }).catch(() => {});
    await openMetaSupportingContext(page);
    await runMetaAnalysis(page);
    await expect(metaOperatingModeCard(page)).not.toContainText("Loading operating mode...");
    const signature = await captureMetaDecisionSignature(page);
    if (!metaBaseline) {
      metaBaseline = signature;
    } else {
      expect(signature).toEqual(metaBaseline);
    }
  }
  await setStoredDateRange(page, "metaDateRange", STANDARD_DATE_RANGE);
  await page.reload();
  await page.getByText("Loading campaign performance").waitFor({ state: "hidden", timeout: 45_000 }).catch(() => {});
  const campaignListItems = page.locator('[data-testid^="meta-list-item-"]');
  await expect(campaignListItems.first()).toBeVisible();
  await campaignListItems.first().click();
  await expect(page.getByTestId("meta-campaign-detail")).toBeVisible();
  const hasCampaignReasoning = await openMetaCampaignReasoning(page);
  if (hasCampaignReasoning) {
    await expect
      .poll(async () =>
        page.getByTestId("meta-campaign-reasoning").evaluate((element) => element.hasAttribute("open")),
      )
      .toBe(true);
    const metaCampaignDecisionPanel = page.getByTestId("meta-campaign-decision-panel");
    await expect(metaCampaignDecisionPanel).toContainText("Campaign Role");
  }
  const metaCampaignAdsetActions = page.getByTestId("meta-campaign-adset-actions");
  if ((await metaCampaignAdsetActions.count()) > 0) {
    await expect(metaCampaignAdsetActions).toContainText(/Ad Set Actions|No ad set actions are available|ROAS/);
  }
  await expect(page.getByTestId("meta-adsets-section")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("commercial-meta-mode.png"),
    fullPage: true,
  });

  await page.goto("/command-center");
  await expect(page.getByTestId("command-center-page")).toBeVisible();
  await expect(page.getByTestId("command-center-page")).toContainText("Decisions use live windows");
  await expect(page.getByTestId("command-center-page")).toContainText("Selected period affects analysis only");
  await expect(page.getByTestId("command-center-historical-intelligence")).toBeVisible();
  let commandCenterBaseline: Awaited<ReturnType<typeof captureCommandCenterDecisionSignature>> | null = null;
  let commandCenterHistoricalBaseline: string | null = null;
  let commandCenterHistoricalChanged = false;
  for (const range of BROWSER_DECISION_RANGES) {
    await setStoredDateRange(page, "commandCenterDateRange", range.standard);
    await page.reload();
    await expect(page.getByTestId("command-center-page")).toBeVisible();
    await expect(page.getByTestId("command-center-budget-summary")).toBeVisible({
      timeout: 45_000,
    });
    const signature = await captureCommandCenterDecisionSignature(page);
    const historicalSignature = await captureCommandCenterHistoricalSignature(page);
    if (!commandCenterBaseline) {
      commandCenterBaseline = signature;
      commandCenterHistoricalBaseline = historicalSignature;
    } else {
      expect(signature).toEqual(commandCenterBaseline);
      if (historicalSignature !== commandCenterHistoricalBaseline) {
        commandCenterHistoricalChanged = true;
      }
    }
  }
  expect(commandCenterHistoricalChanged).toBeTruthy();
  await setStoredDateRange(page, "commandCenterDateRange", STANDARD_DATE_RANGE);
  await page.reload();
  await expect(page.getByTestId("command-center-page")).toBeVisible();
  await expect(page.getByTestId("command-center-budget-summary")).toBeVisible();
  await expect(page.getByTestId("command-center-shift-digest")).toBeVisible();
  await expect(page.getByTestId("command-center-feedback-summary")).toBeVisible();
  await expect(page.getByTestId("command-center-historical-intelligence")).toBeVisible();
  await expect(page.getByTestId("command-center-owner-workload")).toBeVisible();
  const queueActions = await selectFirstCommandCenterViewWithActions(page);
  await expect(queueActions.first()).toBeVisible();
  const batchToolbar = page.getByTestId("command-center-batch-toolbar");
  const batchToggles = await selectFirstCommandCenterViewWithBatchReadyActions(page);
  if (batchToggles) {
    const batchSelectionCount = Math.min(await batchToggles.count(), 2);
    for (let index = 0; index < batchSelectionCount; index += 1) {
      await batchToggles.nth(index).click();
    }
    await expect(batchToolbar).toContainText(`${batchSelectionCount} selected`);
    await batchToolbar.getByRole("button", { name: "Batch approve" }).click();
    await expect(batchToolbar).toContainText("0 selected");
    for (let index = 0; index < batchSelectionCount; index += 1) {
      await batchToggles.nth(index).click();
    }
    await batchToolbar.getByRole("button", { name: "Batch reopen" }).click();
    await expect(batchToolbar).toContainText("0 selected");
  } else {
    await expect(batchToolbar).toContainText("0 visible action(s) are batch-ready in this queue.");
    await expect(
      batchToolbar.getByRole("button", { name: "Batch approve" }),
    ).toBeDisabled();
  }

  const queueGapInput = page.getByPlaceholder("What action is missing from this queue?");
  await queueGapInput.fill("Missing donor-campaign queue item for manual reallocation.");
  await page.getByRole("button", { name: "Report missing action" }).click();
  await expect(queueGapInput).toHaveValue("");

  await queueActions.first().click();
  const workflowDialog = page.getByRole("dialog");
  await expect(workflowDialog.getByTestId("command-center-execution-panel")).toBeVisible();
  await expect(workflowDialog.getByTestId("command-center-execution-support-mode")).toBeVisible();
  await expect(workflowDialog.getByTestId("command-center-execution-support-matrix")).toBeVisible();
  await expect(workflowDialog.getByTestId("command-center-execution-selected-support")).toBeVisible();
  await expect(
    workflowDialog.getByTestId("command-center-execution-selected-rollback-kind"),
  ).toBeVisible();
  await expect(workflowDialog.getByTestId("command-center-execution-audit")).toBeVisible();
  await expect(workflowDialog.getByTestId("command-center-execution-apply")).toBeDisabled();
  const feedbackPanel = workflowDialog.getByTestId("command-center-action-feedback");
  await expect(feedbackPanel).toBeVisible();
  await expect(workflowDialog.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await workflowDialog.getByRole("button", { name: "Approve", exact: true }).click();
  await workflowDialog.getByRole("button", { name: "Reopen", exact: true }).click();
  await workflowDialog.getByRole("button", { name: "Complete manual", exact: true }).click();
  await workflowDialog.getByRole("button", { name: "Reopen", exact: true }).click();
  await workflowDialog.getByRole("button", { name: "Reject", exact: true }).click();
  await workflowDialog.getByRole("button", { name: "Reopen", exact: true }).click();
  await workflowDialog.locator('label:has-text("Assign to") select').selectOption({ index: 1 });
  await workflowDialog.locator('label:has-text("Snooze until") input[type="datetime-local"]').fill("2026-04-12T09:00");
  await workflowDialog.getByPlaceholder("Add operator context, blockers, or approval rationale").fill("Smoke note from operator.");
  await workflowDialog.getByRole("button", { name: "Add note", exact: true }).click();
  await feedbackPanel
    .getByPlaceholder("Why was this a false positive or bad recommendation?")
    .fill("Smoke operator feedback on queue prioritization.");
  await feedbackPanel.getByRole("button", { name: "Mark false positive" }).click();
  await expect(feedbackPanel).toContainText("Smoke operator feedback on queue prioritization.");
  await workflowDialog.getByRole("button", { name: "Close", exact: true }).click();

  const metaWorkflowDialog = await openFirstCampaignAwareMetaCommandCenterAction(page);
  await metaWorkflowDialog.getByRole("link", { name: "Open source surface" }).click();
  await page.waitForURL(/\/platforms\/meta\?.*campaignId=/, { timeout: 45_000 });
  const metaDetailVisible = await page
    .getByTestId("meta-campaign-detail")
    .isVisible()
    .catch(() => false);
  if (!metaDetailVisible) {
    await expect(page.locator('[data-testid^="meta-list-item-"]').first()).toBeVisible();
  }
  await page.goBack();
  await expect(page.getByTestId("command-center-page")).toBeVisible();

  await page.getByPlaceholder("Save current view").fill("Smoke saved view");
  await page.getByRole("button", { name: "Save view" }).click();
  await page.getByTestId("command-center-handoffs").getByRole("button", { name: "Prefill from digest" }).click();
  await expect(
    page.getByTestId("command-center-handoffs").getByPlaceholder("Summary for the next shift"),
  ).not.toHaveValue("");
  await page.getByTestId("command-center-handoffs").getByRole("button", { name: "Save handoff" }).click();
  const handoffCard = page.locator('[data-testid^="command-center-handoff-"]').first();
  await expect(handoffCard).toBeVisible();
  await handoffCard.getByRole("button", { name: "Acknowledge" }).click();
  await page.screenshot({
    path: testInfo.outputPath("commercial-command-center.png"),
    fullPage: true,
  });

  await page.goto("/platforms/meta/creatives");
  await expectCreativeDashboardWithoutDecisionUi(page);
  for (const range of BROWSER_DECISION_RANGES) {
    await setStoredDateRange(page, "creativeDateRange", range.creative);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectCreativeDashboardWithoutDecisionUi(page);
  }

  const creativeRows = page.locator('[data-testid^="creative-row-"]');
  await expect(creativeRows.first()).toBeVisible();
  await creativeRows.first().click();

  await expect(page.getByTestId("creative-detail-performance")).toBeVisible();
  await expect(page.getByTestId("creative-detail-deterministic-decision")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-preview-truth")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-command-center")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-deployment-matrix")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-benchmark-evidence")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-fatigue-evidence")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-commercial-context")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-ai-commentary")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("commercial-creative-context.png"),
    fullPage: true,
  });
});

test("commercial execution canary smoke applies and rolls back a supported ad set when configured", async ({
  page,
}) => {
  const executionBusinessId =
    process.env.PLAYWRIGHT_EXECUTION_CANARY_BUSINESS_ID ??
    process.env.COMMERCIAL_SMOKE_OPERATOR_EXECUTION_BUSINESS_ID;
  test.skip(
    !executionBusinessId,
    "Execution canary smoke requires COMMERCIAL_SMOKE_OPERATOR_EXECUTION_BUSINESS_ID.",
  );
  test.slow();

  await page.goto("/command-center");
  const switchResponse = await page.evaluate(async (businessId) => {
    const response = await fetch("/api/auth/switch-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ businessId }),
    });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  }, executionBusinessId);
  expect(switchResponse.ok, switchResponse.text).toBeTruthy();

  await page.goto("/command-center");
  const queueActions = page.locator('[data-testid^="command-center-action-"]');
  await expect(queueActions.first()).toBeVisible({ timeout: 45_000 });

  let supportedActionFound = false;
  const totalActions = await queueActions.count();
  const maxActionsToScan = Math.min(totalActions, 40);

  for (let index = 0; index < maxActionsToScan; index += 1) {
    await queueActions.nth(index).click();
    const workflowDialog = page.getByRole("dialog");
    await expect(workflowDialog.getByTestId("command-center-execution-panel")).toBeVisible();
    await expect(workflowDialog.getByTestId("command-center-execution-support-matrix")).toBeVisible();
    const supportText = (
      await workflowDialog
        .getByTestId("command-center-execution-support-mode")
        .textContent()
    )?.trim()
      .toLowerCase();
    if (supportText !== "supported") continue;

    supportedActionFound = true;
    await workflowDialog.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(workflowDialog.getByTestId("command-center-execution-apply")).toBeEnabled({
      timeout: 45_000,
    });
    await workflowDialog.getByTestId("command-center-execution-apply").click();
    await expect(workflowDialog).toContainText(/executed/i, { timeout: 45_000 });
    await expect(workflowDialog.getByTestId("command-center-execution-rollback")).toBeEnabled({
      timeout: 45_000,
    });
    await workflowDialog.getByTestId("command-center-execution-rollback").click();
    await expect(workflowDialog).toContainText(/rolled back/i, { timeout: 45_000 });
    await expect(workflowDialog.getByTestId("command-center-execution-audit")).toContainText(
      /apply|rollback/i,
    );
    break;
  }

  expect(supportedActionFound).toBeTruthy();
});
