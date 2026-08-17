import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from "@playwright/test";

import {
  DASHBOARD_V2_REFERENCE_DIR,
  DASHBOARD_V2_REFERENCE_FONT_RESPONSES,
  assertReferenceFiles,
  referenceFileUrl,
  sha256,
} from "./dashboard-v2/reference-contract";

const APP_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const APP_ORIGIN = requireLoopbackOrigin(APP_URL);
const STORAGE_STATE =
  process.env.DASHBOARD_V2_STORAGE_STATE ??
  path.resolve("playwright/.auth/reviewer.json");
const ARTIFACT_DIR =
  process.env.DASHBOARD_V2_SHELL_ARTIFACT_DIR ??
  "/tmp/adsecute-dashboard-v2-batch-01-shell";

const VIEWPORTS = [
  { width: 1024, height: 900 },
  { width: 1280, height: 900 },
  { width: 1440, height: 900 },
  { width: 1728, height: 1000 },
] as const;

type ControlSnapshot = {
  tag: string;
  text: string;
  display: string;
  width: number;
  height: number;
  padding: string;
  borderRadius: string;
  borderColor: string;
  background: string;
  color: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
};

type ShellSnapshot = {
  rail: ControlSnapshot;
  header: ControlSnapshot;
  mainTop: number;
  footer: ControlSnapshot;
  visibleTopbarTags: string[];
  business: ControlSnapshot;
  date: ControlSnapshot;
  compare: ControlSnapshot;
  search: ControlSnapshot;
  freshness: ControlSnapshot;
  bell: ControlSnapshot;
  avatar: ControlSnapshot;
  metaParent: Pick<ControlSnapshot, "color" | "fontWeight" | "lineHeight">;
  googleParent: Pick<ControlSnapshot, "color" | "fontWeight" | "lineHeight">;
  compareTitle: string | null;
  compareActive: string | null;
  hasInlineSearchInput: boolean;
  footerInteractive: boolean;
  commandPaletteMounted: boolean;
};

type ResourceDigest = {
  url: string;
  sha256: string;
};

type AuthorizedWorkspace = {
  activeBusinessId: string;
  activeBusinessName: string;
  authMePayload: Record<string, unknown>;
};

type RouteTargetSnapshot = {
  pathname: string;
  businessId: string | null;
};

function requireLoopbackOrigin(rawUrl: string): string {
  const url = new URL(rawUrl);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !loopbackHosts.has(url.hostname) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(
      `Dashboard v2 shell acceptance is local-only; refusing PLAYWRIGHT_BASE_URL ${rawUrl}`,
    );
  }
  return url.origin;
}

class DigestCollector {
  readonly entries: ResourceDigest[] = [];
  private readonly pending = new Set<Promise<void>>();

  attach(page: Page, predicate: (response: Response) => boolean) {
    page.on("response", (response) => {
      if (!predicate(response)) return;
      const task = response
        .body()
        .then((body) => {
          this.entries.push({ url: response.url(), sha256: sha256(body) });
        })
        .catch(() => undefined)
        .finally(() => this.pending.delete(task));
      this.pending.add(task);
    });
  }

  async flush() {
    await Promise.all([...this.pending]);
  }
}

async function verifyReferenceFonts(context: BrowserContext) {
  const collector = new DigestCollector();
  const page = await context.newPage();
  collector.attach(page, (response) => {
    const hostname = new URL(response.url()).hostname;
    return (
      hostname === "fonts.googleapis.com" || hostname === "fonts.gstatic.com"
    );
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(referenceFileUrl(DASHBOARD_V2_REFERENCE_DIR), {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 16px "Instrument Sans"'),
      document.fonts.load('400 16px "IBM Plex Mono"'),
      document.fonts.load('500 16px "IBM Plex Mono"'),
      document.fonts.load('600 16px "Space Grotesk"'),
    ]);
    await document.fonts.ready;
  });
  await collector.flush();
  await page.close();

  for (const expected of DASHBOARD_V2_REFERENCE_FONT_RESPONSES) {
    const actual = collector.entries.find(
      (entry) => entry.url === expected.url,
    );
    if (!actual || actual.sha256 !== expected.sha256) {
      throw new Error(
        `Canonical font response changed: ${expected.url}\n` +
          `expected ${expected.sha256}, got ${actual?.sha256 ?? "missing"}`,
      );
    }
  }
}

async function installReadOnlyRequestGuard(
  context: BrowserContext,
  blockedRequests: string[],
  fulfilledApiReads: string[],
  authMePayload: Record<string, unknown>,
) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = new URL(request.url());
    const pathname = url.pathname;

    // Canonical fonts are fetched only in the isolated reference context. The
    // application context is local-only: an unexpected provider/CDN request is
    // both a fidelity leak and a potential side effect, so it never dispatches.
    if (url.origin !== APP_ORIGIN) {
      blockedRequests.push(`EXTERNAL ${method} ${url.origin}${pathname}`);
      await route.abort("blockedbyclient");
      return;
    }

    // Page-view telemetry is not provider behavior and must not write to the
    // local acceptance database. Fulfil it in-memory. Every other non-read
    // request is blocked before it can mutate local or provider state.
    if (pathname === "/api/instrumentation/event") {
      fulfilledApiReads.push(`${method} ${pathname} -> 204`);
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    if (method === "GET" && pathname === "/api/auth/me") {
      fulfilledApiReads.push(`${method} ${pathname} -> 200 captured`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(authMePayload),
      });
      return;
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (!["GET", "HEAD"].includes(method)) {
        blockedRequests.push(`${method} ${pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      // The target page must mount its real production body, but its live
      // summary fan-out can call providers. A typed, value-free response keeps
      // the production component mounted while representing every datum as
      // unavailable; it supplies no prototype number or name.
      if (method === "GET" && pathname === "/api/overview-summary") {
        const businessId = url.searchParams.get("businessId") ?? "";
        const startDate = url.searchParams.get("startDate") ?? "";
        const endDate = url.searchParams.get("endDate") ?? "";
        const mode =
          url.searchParams.get("compareMode") === "none"
            ? "none"
            : "previous_period";
        fulfilledApiReads.push(`${method} ${pathname} -> 200 empty`);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            summary: {
              businessId,
              dateRange: { startDate, endDate },
              comparison: { mode, startDate: null, endDate: null },
              pins: [],
              storeMetrics: [],
              attribution: [],
              ltv: [],
              platforms: [],
              expenses: [],
              costModel: { configured: false, values: null },
              customMetrics: [],
              webAnalytics: [],
              insights: [],
              shopifyServing: null,
            },
          }),
        });
        return;
      }
      if (method === "GET" && pathname === "/api/overview-sparklines") {
        fulfilledApiReads.push(`${method} ${pathname} -> 200 empty`);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sparklines: {
              combined: [],
              providerTrends: {},
              ga4Daily: [],
            },
          }),
        });
        return;
      }
      fulfilledApiReads.push(`${method} ${pathname} -> 503`);
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body:
          method === "HEAD"
            ? ""
            : JSON.stringify({ error: "acceptance_read_only" }),
      });
      return;
    }

    if (!["GET", "HEAD"].includes(method)) {
      blockedRequests.push(`${method} ${pathname}`);
      await route.abort("blockedbyclient");
      return;
    }

    await route.continue();
  });
}

async function readAuthorizedWorkspace(
  context: BrowserContext,
): Promise<AuthorizedWorkspace> {
  const response = await context.request.get(
    new URL("/api/auth/me", APP_ORIGIN).toString(),
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok()) {
    throw new Error(
      `Authenticated shell acceptance could not read /api/auth/me: HTTP ${response.status()}. ` +
        "Refresh DASHBOARD_V2_STORAGE_STATE with a valid local authenticated session.",
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    authenticated?: unknown;
    activeBusinessId?: unknown;
    businesses?: unknown;
  } | null;
  if (payload?.authenticated !== true) {
    throw new Error(
      "Authenticated shell acceptance received an unauthenticated /api/auth/me payload.",
    );
  }
  if (
    typeof payload.activeBusinessId !== "string" ||
    payload.activeBusinessId.trim().length === 0
  ) {
    throw new Error(
      "Authenticated shell acceptance requires /api/auth/me to return a non-empty activeBusinessId; none was available.",
    );
  }
  if (!Array.isArray(payload.businesses) || payload.businesses.length === 0) {
    throw new Error(
      "Authenticated shell acceptance requires at least one authorized business membership from /api/auth/me; none was available.",
    );
  }

  const activeBusinessId = payload.activeBusinessId.trim();
  const activeBusiness = payload.businesses.find(
    (candidate): candidate is { id: string; name: string } =>
      Boolean(
        candidate &&
        typeof candidate === "object" &&
        "id" in candidate &&
        candidate.id === activeBusinessId &&
        "name" in candidate &&
        typeof candidate.name === "string" &&
        candidate.name.trim().length > 0,
      ),
  );
  if (!activeBusiness) {
    throw new Error(
      `Authenticated shell acceptance activeBusinessId ${activeBusinessId} is not present in the authorized /api/auth/me memberships.`,
    );
  }

  return {
    activeBusinessId,
    activeBusinessName: activeBusiness.name.trim(),
    authMePayload: payload as Record<string, unknown>,
  };
}

function closeEnough(actual: number, expected: number, tolerance = 0.05) {
  return Math.abs(actual - expected) <= tolerance;
}

function expectValue(
  failures: string[],
  label: string,
  actual: string | number | boolean | null,
  expected: string | number | boolean | null,
) {
  const matches =
    typeof actual === "number" && typeof expected === "number"
      ? closeEnough(actual, expected)
      : actual === expected;
  if (!matches)
    failures.push(
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
}

async function waitForShell(page: Page, selector: string) {
  await page.locator(selector).waitFor({ state: "visible", timeout: 30_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function referenceSnapshot(page: Page): Promise<ShellSnapshot> {
  return page.evaluate(() => {
    Reflect.set(
      globalThis,
      "__name",
      Reflect.get(globalThis, "__name") ?? Function("value", "return value"),
    );
    const pick = (element: Element): ControlSnapshot => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        display: style.display,
        width: Number(box.width.toFixed(3)),
        height: Number(box.height.toFixed(3)),
        padding: style.padding,
        borderRadius: style.borderRadius,
        borderColor: style.borderColor,
        background: style.backgroundColor,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
      };
    };
    const aside = document.querySelector("aside")!;
    const header = document.querySelector("header")!;
    const main = document.querySelector("main")!;
    const children = Array.from(header.children).filter(
      (element) => getComputedStyle(element).display !== "none",
    );
    const navChildren = Array.from(aside.querySelector("nav")!.children).filter(
      (element) => getComputedStyle(element).display !== "none",
    );
    const platformParents = navChildren.filter((element) =>
      ["Meta", "Google Ads"].includes((element.textContent ?? "").trim()),
    );
    const footer = aside.lastElementChild!;
    const compare = children[3]!;
    return {
      rail: pick(aside),
      header: pick(header),
      mainTop: Number(main.getBoundingClientRect().top.toFixed(3)),
      footer: pick(footer),
      visibleTopbarTags: children.map((element) =>
        element.tagName.toLowerCase(),
      ),
      business: pick(children[0]!),
      date: pick(children[2]!),
      compare: pick(compare),
      search: pick(children[5]!),
      freshness: pick(children[6]!),
      bell: pick(children[7]!),
      avatar: pick(children[8]!),
      metaParent: pick(platformParents[0]!),
      googleParent: pick(platformParents[1]!),
      compareTitle: compare.getAttribute("title"),
      compareActive: null,
      hasInlineSearchInput: Boolean(
        header.querySelector('input[type="search"]'),
      ),
      footerInteractive:
        footer.matches("button, a") ||
        Boolean(footer.querySelector("button, a")),
      commandPaletteMounted: false,
    };
  });
}

async function appSnapshot(page: Page): Promise<ShellSnapshot> {
  return page.evaluate(() => {
    Reflect.set(
      globalThis,
      "__name",
      Reflect.get(globalThis, "__name") ?? Function("value", "return value"),
    );
    const pick = (element: Element): ControlSnapshot => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        display: style.display,
        width: Number(box.width.toFixed(3)),
        height: Number(box.height.toFixed(3)),
        padding: style.padding,
        borderRadius: style.borderRadius,
        borderColor: style.borderColor,
        background: style.backgroundColor,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
      };
    };
    const required = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing shell selector: ${selector}`);
      return element;
    };
    const rail = required(".adv-rail");
    const header = required(".adv-topbar");
    const main = required(".adv-main");
    const footer = required(".adv-rail-foot");
    const children = Array.from(header.children).filter(
      (element) => getComputedStyle(element).display !== "none",
    );
    const compare = required(".adv-date-comparison-trigger");
    const metaParent = required('[data-platform="meta"]');
    const googleParent = required('[data-platform="google"]');
    return {
      rail: pick(rail),
      header: pick(header),
      mainTop: Number(main.getBoundingClientRect().top.toFixed(3)),
      footer: pick(footer),
      visibleTopbarTags: children.map((element) =>
        element.tagName.toLowerCase(),
      ),
      business: pick(required(".adv-topbar > .adv-btn")),
      date: pick(required(".adv-date-range-trigger")),
      compare: pick(compare),
      search: pick(required(".adv-search")),
      freshness: pick(required(".adv-topbar > .adv-pill")),
      bell: pick(required(".adv-notification-bell")),
      avatar: pick(
        header.lastElementChild ?? required(".adv-topbar > span:last-child"),
      ),
      metaParent: pick(metaParent),
      googleParent: pick(googleParent),
      compareTitle: compare.getAttribute("title"),
      compareActive: compare.getAttribute("data-active"),
      hasInlineSearchInput: Boolean(
        header.querySelector('input[type="search"]'),
      ),
      footerInteractive:
        footer.matches("button, a") ||
        Boolean(footer.querySelector("button, a")),
      commandPaletteMounted: Boolean(
        document.querySelector("#dashboard-command-palette"),
      ),
    };
  });
}

function compareContract(reference: ShellSnapshot, app: ShellSnapshot) {
  const failures: string[] = [];
  expectValue(failures, "rail.width", app.rail.width, 248);
  expectValue(failures, "rail.height", app.rail.height, reference.rail.height);
  expectValue(
    failures,
    "rail.background",
    app.rail.background,
    reference.rail.background,
  );
  expectValue(
    failures,
    "footer.height",
    app.footer.height,
    reference.footer.height,
  );
  expectValue(failures, "footer.tag", app.footer.tag, "div");
  expectValue(failures, "footer.interactive", app.footerInteractive, false);
  expectValue(
    failures,
    "footer.width",
    app.footer.width,
    reference.footer.width,
  );
  expectValue(
    failures,
    "footer.padding",
    app.footer.padding,
    reference.footer.padding,
  );
  expectValue(
    failures,
    "topbar.padding",
    app.header.padding,
    reference.header.padding,
  );
  expectValue(
    failures,
    "topbar.background",
    app.header.background,
    reference.header.background,
  );
  expectValue(
    failures,
    "topbar.fontSize",
    app.header.fontSize,
    reference.header.fontSize,
  );
  expectValue(
    failures,
    "topbar.lineHeight",
    app.header.lineHeight,
    reference.header.lineHeight,
  );
  expectValue(failures, "main.top", app.mainTop, app.header.height);
  expectValue(
    failures,
    "topbar.visible-tags",
    app.visibleTopbarTags.join(","),
    reference.visibleTopbarTags.join(","),
  );
  expectValue(
    failures,
    "compare.title",
    app.compareTitle,
    reference.compareTitle,
  );
  expectValue(failures, "compare.tag", app.compare.tag, reference.compare.tag);
  expectValue(failures, "search.tag", app.search.tag, reference.search.tag);
  expectValue(
    failures,
    "freshness.tag",
    app.freshness.tag,
    reference.freshness.tag,
  );
  expectValue(failures, "avatar.tag", app.avatar.tag, reference.avatar.tag);
  expectValue(failures, "search.input", app.hasInlineSearchInput, false);
  expectValue(failures, "palette.closed", app.commandPaletteMounted, false);
  for (const name of [
    "business",
    "date",
    "compare",
    "search",
    "freshness",
    "bell",
    "avatar",
  ] as const) {
    for (const property of [
      "height",
      "padding",
      "borderRadius",
      "fontSize",
      "fontWeight",
      "lineHeight",
    ] as const) {
      expectValue(
        failures,
        `${name}.${property}`,
        app[name][property],
        reference[name][property],
      );
    }
  }
  for (const name of ["business", "date", "search", "bell"] as const) {
    for (const property of ["borderColor", "background", "color"] as const) {
      expectValue(
        failures,
        `${name}.${property}`,
        app[name][property],
        reference[name][property],
      );
    }
  }
  for (const name of ["search", "bell", "avatar"] as const) {
    expectValue(
      failures,
      `${name}.width`,
      app[name].width,
      reference[name].width,
    );
  }
  expectValue(
    failures,
    "avatar.background",
    app.avatar.background,
    reference.avatar.background,
  );
  expectValue(
    failures,
    "avatar.color",
    app.avatar.color,
    reference.avatar.color,
  );
  const comparisonPaint =
    app.compareActive === "true"
      ? {
          background: reference.compare.background,
          color: reference.compare.color,
        }
      : { background: "rgb(241, 244, 249)", color: "rgb(122, 134, 158)" };
  expectValue(
    failures,
    "compare.background",
    app.compare.background,
    comparisonPaint.background,
  );
  expectValue(
    failures,
    "compare.color",
    app.compare.color,
    comparisonPaint.color,
  );
  expectValue(
    failures,
    "metaParent.color",
    app.metaParent.color,
    reference.metaParent.color,
  );
  expectValue(
    failures,
    "metaParent.weight",
    app.metaParent.fontWeight,
    reference.metaParent.fontWeight,
  );
  expectValue(
    failures,
    "metaParent.lineHeight",
    app.metaParent.lineHeight,
    reference.metaParent.lineHeight,
  );
  expectValue(
    failures,
    "googleParent.color",
    app.googleParent.color,
    reference.googleParent.color,
  );
  expectValue(
    failures,
    "googleParent.weight",
    app.googleParent.fontWeight,
    reference.googleParent.fontWeight,
  );
  expectValue(
    failures,
    "googleParent.lineHeight",
    app.googleParent.lineHeight,
    reference.googleParent.lineHeight,
  );
  return failures;
}

function routeTargetSnapshot(page: Page): RouteTargetSnapshot {
  const url = new URL(page.url());
  return {
    pathname: url.pathname,
    businessId: url.searchParams.get("businessId"),
  };
}

async function followRouteFamilyTarget(input: {
  page: Page;
  failures: string[];
  caseId: string;
  navId: string;
  expectedPathname: string;
  expectedBusinessId?: string | null;
}): Promise<RouteTargetSnapshot> {
  const selector = `[data-nav="${input.navId}"]`;
  const target = input.page.locator(selector);
  try {
    await target.waitFor({ state: "visible", timeout: 15_000 });
    const beforeUrl = input.page.url();
    await Promise.all([
      input.page.waitForURL((url) => url.toString() !== beforeUrl, {
        timeout: 30_000,
        waitUntil: "commit",
      }),
      target.click(),
    ]);
    await waitForShell(input.page, ".adv-topbar");
    await input.page.locator(".adv-main .adv-page > *").first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
  } catch (error: unknown) {
    input.failures.push(
      `${input.caseId}.nav.${input.navId}: could not reach ${input.expectedPathname} from ${selector}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const snapshot = routeTargetSnapshot(input.page);
  expectValue(
    input.failures,
    `${input.caseId}.nav.${input.navId}.pathname`,
    snapshot.pathname,
    input.expectedPathname,
  );
  if (input.expectedBusinessId !== undefined) {
    expectValue(
      input.failures,
      `${input.caseId}.nav.${input.navId}.businessId`,
      snapshot.businessId,
      input.expectedBusinessId,
    );
  }
  return snapshot;
}

async function runAuthenticatedRouteFamilyAcceptance(
  browser: Browser,
  reference: ShellSnapshot,
  workspace: AuthorizedWorkspace,
): Promise<boolean> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    storageState: STORAGE_STATE,
  });
  const blockedRequests: string[] = [];
  const fulfilledApiReads: string[] = [];
  await installReadOnlyRequestGuard(
    context,
    blockedRequests,
    fulfilledApiReads,
    workspace.authMePayload,
  );
  const scopedBusinessSegment = encodeURIComponent(workspace.activeBusinessId);
  const cases = [
    {
      kind: "app",
      id: "app-home",
      entryPath: "/app/home",
      expectedEntryPath: "/app/home",
      metaPath: "/app/meta/decisions",
      googlePath: "/app/google/advisor",
      settingsPath: "/app/manage/plan",
      homePath: "/app/home",
    },
    {
      kind: "compatibility",
      id: "business-home",
      entryPath: `/c/${scopedBusinessSegment}/home`,
      expectedEntryPath: "/app/home",
    },
  ] as const;
  let failed = false;

  for (const routeCase of cases) {
    const page = await context.newPage();
    const caseBlockedStart = blockedRequests.length;
    const caseFulfilledStart = fulfilledApiReads.length;
    const observedBusinessIds = new Set<string>();
    const failures: string[] = [];
    let compatibilityRedirect: {
      status: number;
      origin: string | null;
      pathname: string | null;
      next: string | null;
    } | null = null;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== APP_ORIGIN) return;
      const businessId = url.searchParams.get("businessId");
      if (businessId !== null) observedBusinessIds.add(businessId);
    });

    if (routeCase.kind === "compatibility") {
      const redirectResponse = await context.request.get(
        `${APP_ORIGIN}${routeCase.entryPath}`,
        { maxRedirects: 0 },
      );
      const location = redirectResponse.headers().location ?? null;
      const target = location ? new URL(location, APP_ORIGIN) : null;
      compatibilityRedirect = {
        status: redirectResponse.status(),
        origin: target?.origin ?? null,
        pathname: target?.pathname ?? null,
        next: target?.searchParams.get("next") ?? null,
      };
      expectValue(
        failures,
        `${routeCase.id}.compatibility.status`,
        compatibilityRedirect.status,
        307,
      );
      expectValue(
        failures,
        `${routeCase.id}.compatibility.origin`,
        compatibilityRedirect.origin,
        APP_ORIGIN,
      );
      expectValue(
        failures,
        `${routeCase.id}.compatibility.pathname`,
        compatibilityRedirect.pathname,
        `/switch-business/${scopedBusinessSegment}`,
      );
      expectValue(
        failures,
        `${routeCase.id}.compatibility.next`,
        compatibilityRedirect.next,
        "/app/home",
      );
      const caseBlockedRequests = blockedRequests.slice(caseBlockedStart);
      if (caseBlockedRequests.length > 0) {
        failures.push(
          `${routeCase.id}.read-only: blocked unexpected requests: ${caseBlockedRequests.join(", ")}`,
        );
      }
      if (failures.length > 0) failed = true;
      console.log(
        JSON.stringify({
          routeFamily: routeCase.id,
          entryPath: routeCase.entryPath,
          activeBusinessVerified: true,
          compatibilityRedirect,
          fulfilledApiReads: fulfilledApiReads.slice(caseFulfilledStart),
          blockedRequests: caseBlockedRequests,
          failures,
          pass: failures.length === 0,
        }),
      );
      await page.close();
      continue;
    }

    const response = await page.goto(`${APP_ORIGIN}${routeCase.entryPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitForShell(page, ".adv-topbar");
    await page.locator(".adv-topbar > .adv-btn").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.locator(".adv-main .adv-page > *").first().waitFor({
      state: "visible",
      timeout: 30_000,
    });

    const app = await appSnapshot(page);
    failures.push(
      ...compareContract(reference, app).map(
        (failure) => `${routeCase.id}.${failure}`,
      ),
    );
    if (!response?.ok()) {
      failures.push(
        `${routeCase.id}.response: expected success, received ${response?.status() ?? "none"}`,
      );
    }
    expectValue(
      failures,
      `${routeCase.id}.entry.pathname`,
      routeTargetSnapshot(page).pathname,
      routeCase.expectedEntryPath,
    );
    expectValue(
      failures,
      `${routeCase.id}.business.text`,
      app.business.text,
      workspace.activeBusinessName,
    );

    await page.screenshot({
      path: `${ARTIFACT_DIR}/${routeCase.id}-app.png`,
      fullPage: false,
    });

    const navTargets =
      routeCase.kind === "app"
        ? {
            meta: await followRouteFamilyTarget({
              page,
              failures,
              caseId: routeCase.id,
              navId: "meta-pulse",
              expectedPathname: routeCase.metaPath,
              expectedBusinessId: workspace.activeBusinessId,
            }),
            google: await followRouteFamilyTarget({
              page,
              failures,
              caseId: routeCase.id,
              navId: "google-google-advisor",
              expectedPathname: routeCase.googlePath,
            }),
            settings: await followRouteFamilyTarget({
              page,
              failures,
              caseId: routeCase.id,
              navId: "settings",
              expectedPathname: routeCase.settingsPath,
            }),
            home: await followRouteFamilyTarget({
              page,
              failures,
              caseId: routeCase.id,
              navId: "overview",
              expectedPathname: routeCase.homePath,
            }),
          }
        : {};

    const finalShell = await appSnapshot(page);
    expectValue(
      failures,
      `${routeCase.id}.business.after-navigation`,
      finalShell.business.text,
      workspace.activeBusinessName,
    );
    const foreignBusinessIds = [...observedBusinessIds].filter(
      (businessId) => businessId !== workspace.activeBusinessId,
    );
    if (foreignBusinessIds.length > 0) {
      failures.push(
        `${routeCase.id}.scope: requests escaped active business ${workspace.activeBusinessId}: ${foreignBusinessIds.join(", ")}`,
      );
    }
    const caseBlockedRequests = blockedRequests.slice(caseBlockedStart);
    if (caseBlockedRequests.length > 0) {
      failures.push(
        `${routeCase.id}.read-only: blocked unexpected mutations: ${caseBlockedRequests.join(", ")}`,
      );
    }
    if (failures.length > 0) failed = true;

    console.log(
      JSON.stringify({
        routeFamily: routeCase.id,
        entryPath: routeCase.entryPath,
        activeBusinessVerified: true,
        compatibilityRedirect,
        fixedShell: app,
        navTargets,
        observedBusinessIds: [...observedBusinessIds],
        fulfilledApiReads: fulfilledApiReads.slice(caseFulfilledStart),
        blockedRequests: caseBlockedRequests,
        failures,
        pass: failures.length === 0,
      }),
    );
    await page.close();
  }

  await context.close();
  return failed;
}

async function main() {
  const referenceFiles = assertReferenceFiles(DASHBOARD_V2_REFERENCE_DIR);
  if (!existsSync(STORAGE_STATE)) {
    throw new Error(
      `Authenticated storage state is missing: ${STORAGE_STATE}. ` +
        "Set DASHBOARD_V2_STORAGE_STATE to the local reviewer state file.",
    );
  }
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const fontContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  await verifyReferenceFonts(fontContext);
  await fontContext.close();
  const authContext = await browser.newContext({ storageState: STORAGE_STATE });
  const workspace = await readAuthorizedWorkspace(authContext);
  await authContext.close();
  console.log(
    JSON.stringify({
      referencePackage: "verified",
      referenceFiles: referenceFiles.length,
      referenceFonts: DASHBOARD_V2_REFERENCE_FONT_RESPONSES.length,
    }),
  );
  let failed = false;
  let routeFamilyReference: ShellSnapshot | null = null;

  for (const viewport of VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;
    const referenceContext = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
    });
    const appContext = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      storageState: STORAGE_STATE,
    });
    const blockedRequests: string[] = [];
    const fulfilledApiReads: string[] = [];
    await installReadOnlyRequestGuard(
      appContext,
      blockedRequests,
      fulfilledApiReads,
      workspace.authMePayload,
    );
    const referencePage = await referenceContext.newPage();
    const appPage = await appContext.newPage();

    await referencePage.goto(referenceFileUrl(DASHBOARD_V2_REFERENCE_DIR), {
      waitUntil: "domcontentloaded",
    });
    const response = await appPage.goto(`${APP_ORIGIN}/overview`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitForShell(referencePage, "header");
    await waitForShell(appPage, ".adv-topbar");
    await appPage.locator(".adv-topbar > .adv-btn").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await appPage
      .getByRole("heading", { name: "Overview", exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });

    const reference = await referenceSnapshot(referencePage);
    const app = await appSnapshot(appPage);
    if (viewport.width === 1440 && viewport.height === 900) {
      routeFamilyReference = reference;
    }
    const failures = compareContract(reference, app);
    if (!response?.ok())
      failures.push(`app response: ${response?.status() ?? "none"}`);
    if (blockedRequests.length > 0)
      failures.push(
        `blocked unexpected mutations: ${blockedRequests.join(", ")}`,
      );
    if (failures.length > 0) failed = true;

    await referencePage.screenshot({
      path: `${ARTIFACT_DIR}/${label}-reference.png`,
      fullPage: false,
    });
    await appPage.screenshot({
      path: `${ARTIFACT_DIR}/${label}-app.png`,
      fullPage: false,
    });

    console.log(
      JSON.stringify({
        viewport: label,
        reference,
        app,
        fulfilledApiReads,
        blockedRequests,
        failures,
        pass: failures.length === 0,
      }),
    );
    await referenceContext.close();
    await appContext.close();
  }

  if (!routeFamilyReference) {
    throw new Error(
      "Authenticated route-family acceptance requires the preserved 1440x900 reference snapshot.",
    );
  }
  if (
    await runAuthenticatedRouteFamilyAcceptance(
      browser,
      routeFamilyReference,
      workspace,
    )
  ) {
    failed = true;
  }

  await browser.close();
  if (failed) process.exitCode = 1;
}

void main();
