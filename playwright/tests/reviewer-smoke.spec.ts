import { expect, test } from "@playwright/test";

async function commandCenterViewCandidates(page: import("@playwright/test").Page) {
  const candidates = [page.getByRole("button", { name: "Default queue", exact: true })];
  const savedViews = page.locator('[data-testid^="command-center-view-"]');
  const savedViewCount = await savedViews.count();
  for (let index = 0; index < savedViewCount; index += 1) {
    candidates.push(savedViews.nth(index));
  }
  return candidates;
}

async function selectFirstReviewerCommandCenterViewWithActions(page: import("@playwright/test").Page) {
  const viewCandidates = await commandCenterViewCandidates(page);

  for (const candidate of viewCandidates) {
    await candidate.click();
    const queueActions = page.locator('[data-testid^="command-center-action-"]');
    if ((await queueActions.count()) > 0) {
      return queueActions;
    }
  }

  throw new Error("No Command Center actions were visible for the reviewer smoke flow.");
}

async function expectVisibleIfPresent(locator: import("@playwright/test").Locator) {
  if ((await locator.count()) > 0) {
    await expect(locator).toBeVisible();
  }
}

async function openDetailsIfNeeded(details: import("@playwright/test").Locator) {
  await expect(details).toBeVisible();
  const isOpen = await details.evaluate((element) => element.hasAttribute("open"));
  if (!isOpen) {
    await details.locator("summary").click();
  }
}

async function runMetaAnalysis(page: import("@playwright/test").Page) {
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

test("reviewer smoke covers Meta recommendations and creative dashboard", async ({ page }, testInfo) => {
  await page.goto("/platforms/meta");
  await page.getByText("Loading campaign performance").waitFor({ state: "hidden", timeout: 45_000 }).catch(() => {});

  await runMetaAnalysis(page);
  await expect(page.getByTestId("meta-authority-readiness")).toBeVisible();
  await expect(page.getByTestId("meta-operator-plan-summary")).toBeVisible();
  await expect(page.getByTestId("meta-top-action-core")).toBeVisible();
  await expect(page.getByTestId("meta-watchlist-degraded")).toBeVisible();
  await expectVisibleIfPresent(page.getByTestId("meta-no-touch-list"));
  await expect(page.getByTestId("meta-supporting-context")).toBeVisible();
  await openDetailsIfNeeded(page.getByTestId("meta-supporting-context"));
  await expect(page.getByTestId("meta-recommendations-panel")).toBeVisible();
  await expect(page.getByTestId("meta-recommendations-panel")).toContainText("Supporting Context");
  await expect(page.getByTestId("meta-recommendations-run")).toContainText(
    /Run Analysis|Check all items before re-running/,
  );

  await expect(page.locator('[data-testid^="meta-list-item-"]').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("meta-smoke.png"), fullPage: true });

  await page.goto("/command-center");
  await expect(page.getByTestId("command-center-page")).toBeVisible();
  await expect(page.getByTestId("command-center-read-only-banner")).toBeVisible();
  await expect(page.getByTestId("command-center-budget-summary")).toBeVisible();
  await expect(page.getByTestId("command-center-owner-workload")).toBeVisible();
  await expect(page.getByTestId("command-center-feedback-summary")).toBeVisible();
  await expect(page.getByTestId("command-center-historical-intelligence")).toBeVisible();
  const reviewerBatchToolbar = page.getByTestId("command-center-batch-toolbar");
  await expect(reviewerBatchToolbar).toBeVisible();
  await expect(
    reviewerBatchToolbar.getByRole("button", { name: "Batch approve" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Report missing action" }),
  ).toBeDisabled();
  await expect(page.getByTestId("command-center-journal")).toBeVisible();
  await expect(page.getByTestId("command-center-handoffs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save view" })).toBeDisabled();
  const reviewerQueueActions = await selectFirstReviewerCommandCenterViewWithActions(page);
  await expect(reviewerQueueActions.first()).toBeVisible();
  await reviewerQueueActions.first().click();
  const reviewerExecutionPanel = page.getByTestId("command-center-execution-panel");
  await expect(reviewerExecutionPanel).toBeVisible();
  await expect(reviewerExecutionPanel).toContainText(/Preview first, apply second|Execution preview failed/);
  await expect(
    reviewerExecutionPanel.getByTestId("command-center-execution-support-matrix"),
  ).toBeVisible();
  await expect(
    reviewerExecutionPanel.getByTestId("command-center-execution-selected-support"),
  ).toBeVisible();
  const reviewerFeedbackPanel = page.getByTestId("command-center-action-feedback");
  await expect(reviewerFeedbackPanel).toBeVisible();
  await expect(
    reviewerFeedbackPanel.getByRole("button", { name: "Mark false positive" }),
  ).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("command-center-reviewer.png"), fullPage: true });

  await page.goto("/platforms/meta/creatives");
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
  await creativeRows.first().click();
  await expect(page).toHaveURL(/creative=/);
  await expect(page.getByTestId("creative-detail-performance")).toBeVisible();
  await expect(page.getByTestId("creative-detail-deterministic-decision")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-preview-truth")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-command-center")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-deployment-matrix")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-benchmark-evidence")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-fatigue-evidence")).toHaveCount(0);
  await expect(page.getByTestId("creative-detail-ai-commentary")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("creatives-smoke.png"), fullPage: true });
});
