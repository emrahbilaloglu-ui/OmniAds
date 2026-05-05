// Creative v2 hardening file: read-only safety gate; behavior unchanged.
// Public Raw verification marker: multiline LF formatting required.
import { chromium, expect, type Page } from "@playwright/test";

const forbiddenActionTerms = [
  /\bApply\b/i,
  /\bQueue\b/i,
  /\bPush\b/i,
  /\bAuto\b/i,
  /Scale now/i,
  /Cut now/i,
  /\bApprove\b/i,
];

const forbiddenInternalTerms = [
  /\bgold\b/i,
  /\bfixture\b/i,
  /\bPR\b/,
  /ChatGPT/i,
  /Claude/i,
  /Codex/i,
  /\bWIP\b/,
  /internal evaluation/i,
  /labels this row/i,
];

const writeMethods = ["POST", "PUT", "PATCH", "DELETE"];
const previewFlagQuery = "creativeDecisionOsV2Preview=1";
const previewOffQuery = "creativeDecisionOsV2Preview=0";
const previewSurfaceTestId = "creative-v2-preview-surface";
const previewVisibilityTimeoutMs = 45_000;
const previewRoutes = {
  default: "/creatives",
  offFlag: `/creatives?${previewOffQuery}`,
  withFlag: `/creatives?${previewFlagQuery}`,
} as const;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required locally to run the self-hosted smoke. ` +
        "Do not paste or commit domains, tokens, cookies, DB URLs, or credentials.",
    );
  }
  return value;
}

function pathOnly(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search ? "?<query>" : ""}`;
  } catch {
    return "<unparseable>";
  }
}

function hasForbidden(text: string, patterns: RegExp[]) {
  return patterns
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
}

function assertEmpty(label: string, values: unknown[]) {
  if (values.length === 0) return;
  throw new Error(`Creative v2 self-hosted smoke failed: ${label}.`);
}

async function expectPreviewSurfaceVisible(page: Page) {
  await expect(page.getByTestId(previewSurfaceTestId)).toBeVisible({
    timeout: previewVisibilityTimeoutMs,
  });
  const aboveFold = page.getByTestId("creative-v2-above-fold");
  await expect(aboveFold).toBeVisible({ timeout: previewVisibilityTimeoutMs });
  await expect(page.getByTestId("creative-v2-today-priority")).toBeVisible({
    timeout: previewVisibilityTimeoutMs,
  });
  await expect(aboveFold.getByText("Scale-ready", { exact: true })).toBeVisible({
    timeout: previewVisibilityTimeoutMs,
  });
  await expect(
    page.getByTestId("creative-v2-ready-confirmation"),
  ).toBeVisible({ timeout: previewVisibilityTimeoutMs });
  await expect(page.getByTestId("creative-v2-diagnose-first")).toBeVisible({
    timeout: previewVisibilityTimeoutMs,
  });
  await expect(page.getByTestId("creative-v2-inactive-review")).toBeVisible({
    timeout: previewVisibilityTimeoutMs,
  });
}

async function main() {
  const baseUrl = requiredEnv("CREATIVE_V2_SMOKE_BASE_URL").replace(/\/$/, "");
  const storageState = process.env.CREATIVE_V2_SMOKE_STORAGE_STATE?.trim();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...(storageState ? { storageState } : {}),
  });
  const page = await context.newPage();
  const mutationRequests: Array<{
    method: string;
    path: string;
    phase: string;
  }> = [];
  let phase = "setup";

  page.on("request", (request) => {
    const method = request.method().toUpperCase();
    if (!writeMethods.includes(method)) return;
    mutationRequests.push({
      method,
      path: pathOnly(request.url()),
      phase,
    });
  });

  phase = "default";
  await page.goto(`${baseUrl}${previewRoutes.default}`, {
    waitUntil: "domcontentloaded",
  });
  await expectPreviewSurfaceVisible(page);

  phase = "off_flag";
  await page.goto(`${baseUrl}${previewRoutes.offFlag}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId(previewSurfaceTestId)).toHaveCount(0);

  phase = "with_flag";
  await page.goto(`${baseUrl}${previewRoutes.withFlag}`, {
    waitUntil: "domcontentloaded",
  });
  await expectPreviewSurfaceVisible(page);

  const bodyText = await page.locator("body").innerText();
  const actionViolations = hasForbidden(bodyText, forbiddenActionTerms);
  const internalViolations = hasForbidden(bodyText, forbiddenInternalTerms);

  phase = "detail_open";
  const firstReadOnlyButton = page
    .getByTestId(previewSurfaceTestId)
    .getByRole("button")
    .first();
  if ((await firstReadOnlyButton.count()) > 0) {
    await firstReadOnlyButton.click();
    await page.waitForTimeout(500);
  }

  await browser.close();

  const result = {
    selfHostedRuntimeSmoke: "completed",
    domainRecorded: false,
    defaultV2PreviewVisible: true,
    offFlagV2PreviewVisible: false,
    withFlagV2PreviewVisible: true,
    todayPriorityVisible: true,
    scaleReadyCopyVisible: true,
    readyConfirmationVisible: true,
    diagnoseVisible: true,
    inactiveVisible: true,
    forbiddenActionViolations: actionViolations,
    forbiddenInternalViolations: internalViolations,
    mutationRequests,
  };

  console.log(JSON.stringify(result, null, 2));

  assertEmpty("forbidden action language visible", actionViolations);
  assertEmpty("forbidden internal language visible", internalViolations);
  assertEmpty("write-like network requests captured", mutationRequests);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
