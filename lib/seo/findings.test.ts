import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDemoTechnicalFindings,
  buildSeoTechnicalFindings,
  type SeoTechnicalFinding,
  type SeoTechnicalFindingsPayload,
} from "@/lib/seo/findings";
import type { SearchConsoleAnalyticsRow } from "@/lib/seo/intelligence";

const SITE_URL = "https://shop.example";

function row(page: string, clicks: number, impressions: number): SearchConsoleAnalyticsRow {
  return { query: "tote", page, clicks, impressions, ctr: 0.02, position: 6 };
}

/** A page that clears every check the audit can run on a Product URL. */
function cleanProductHtml(path: string) {
  return `<!doctype html><html><head>
    <title>A deliberately long product title that clears the length check</title>
    <meta name="description" content="A real meta description.">
    <link rel="canonical" href="${SITE_URL}${path}">
    <script type="application/ld+json">{"@type":"Product"}</script>
  </head><body><h1>Product</h1></body></html>`;
}

function htmlResponse(body: string, status = 200, url = "https://shop.example/x") {
  return {
    ok: status < 400,
    status,
    url,
    text: async () => body,
    json: async () => ({}),
  } as unknown as Response;
}

/**
 * Routes every URL the builder fetches. The sitemap and homepage both 404 so
 * discovery contributes no extra pages and the candidate set is exactly the
 * Search Console rows.
 */
function stubFetch(
  pages: Record<string, { body: string; status?: number }>,
  inspectionVerdict?: string,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://searchconsole.googleapis.com/")) {
      if (!inspectionVerdict) return htmlResponse("", 404, url);
      return {
        ok: true,
        status: 200,
        url,
        text: async () => "",
        json: async () => ({
          inspectionResult: {
            indexStatusResult: {
              verdict: inspectionVerdict,
              coverageState:
                inspectionVerdict === "PASS"
                  ? "Submitted and indexed"
                  : "Excluded by ‘noindex’ tag",
              indexingState: inspectionVerdict === "PASS" ? "INDEXING_ALLOWED" : "BLOCKED_BY_META_TAG",
              pageFetchState: "SUCCESSFUL",
              robotsTxtState: "ALLOWED",
            },
          },
        }),
      } as unknown as Response;
    }
    if (url === `${SITE_URL}/sitemap.xml` || url === SITE_URL || url === `${SITE_URL}/`) {
      return htmlResponse("", 404, url);
    }
    const page = pages[new URL(url).pathname];
    if (!page) return htmlResponse("", 404, url);
    return htmlResponse(page.body, page.status ?? 200, url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function findingsOfSeverity(payload: SeoTechnicalFindingsPayload, severity: string) {
  return payload.findings.filter((finding) => finding.severity === severity);
}

/** Distinct pages carrying at least one non-passing finding. */
function flaggedPageCount(findings: SeoTechnicalFinding[]) {
  const paths = new Set<string>();
  for (const finding of findings) {
    if (finding.severity === "passed") continue;
    for (const page of finding.affectedPages) paths.add(page.path);
  }
  return paths.size;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildSeoTechnicalFindings — passed verdict", () => {
  it("emits one passing finding per page that cleared every check that ran", async () => {
    stubFetch({
      "/products/clean": { body: cleanProductHtml("/products/clean") },
      // Same clean shape minus the title, so it fails one check and nothing else.
      "/products/untitled": {
        body: cleanProductHtml("/products/untitled").replace(
          /<title>[\s\S]*?<\/title>/,
          "",
        ),
      },
    });

    const payload = await buildSeoTechnicalFindings({
      siteUrl: SITE_URL,
      currentRows: [row("/products/clean", 40, 900), row("/products/untitled", 30, 800)],
      previousRows: [row("/products/clean", 38, 880), row("/products/untitled", 29, 790)],
    });

    const passed = findingsOfSeverity(payload, "passed");
    expect(passed).toHaveLength(1);
    expect(passed[0].affectedPages.map((page) => page.path)).toEqual(["/products/clean"]);
    expect(payload.summary.passed).toBe(1);
    expect(payload.summary.warning).toBe(1);

    // The failing page is on no passing finding.
    const passedPaths = passed.flatMap((finding) =>
      finding.affectedPages.map((page) => page.path),
    );
    expect(passedPaths).not.toContain("/products/untitled");
  });

  it("names the checks that ran instead of claiming a clean bill of health", async () => {
    stubFetch({ "/products/clean": { body: cleanProductHtml("/products/clean") } });

    const payload = await buildSeoTechnicalFindings({
      siteUrl: SITE_URL,
      currentRows: [row("/products/clean", 40, 900)],
      previousRows: [row("/products/clean", 38, 880)],
    });

    const [passed] = findingsOfSeverity(payload, "passed");
    expect(passed.title).toBe("Pages cleared every technical check that ran");
    expect(passed.description).toContain("Checks that ran on these pages:");
    expect(passed.description).toContain("structured data");
    // No access token was supplied, so Google was never asked about this URL
    // and the finding says so rather than implying an index verdict.
    expect(passed.description).toContain(
      "Search Console URL Inspection did not run for these URLs",
    );
    expect(passed.description).not.toContain("URL Inspection verdict");
  });

  it("never marks a page that could not be crawled as passing", async () => {
    stubFetch({ "/products/gone": { body: "", status: 503 } });

    const payload = await buildSeoTechnicalFindings({
      siteUrl: SITE_URL,
      currentRows: [row("/products/gone", 10, 400)],
      previousRows: [row("/products/gone", 12, 420)],
    });

    expect(findingsOfSeverity(payload, "passed")).toHaveLength(0);
    expect(payload.summary.passed).toBe(0);
    expect(payload.summary.critical).toBe(1);
  });

  it("keeps a page whose only fault is an opportunity off the Passed count", async () => {
    // Clean but for the meta description, which is an `opportunity`.
    stubFetch({
      "/products/thin": {
        body: cleanProductHtml("/products/thin").replace(
          /<meta name="description"[^>]*>/,
          "",
        ),
      },
    });

    const payload = await buildSeoTechnicalFindings({
      siteUrl: SITE_URL,
      currentRows: [row("/products/thin", 20, 600)],
      previousRows: [row("/products/thin", 21, 610)],
    });

    expect(payload.summary.opportunity).toBe(1);
    expect(payload.summary.passed).toBe(0);
    expect(payload.summary.critical + payload.summary.warning).toBe(0);
    // The design's subtraction would have called this page passing.
    expect(
      payload.meta.auditedPageCount - payload.summary.critical - payload.summary.warning,
    ).toBe(1);
  });

  it("accounts for every audited page exactly once across the four cards", async () => {
    stubFetch({
      "/products/clean": { body: cleanProductHtml("/products/clean") },
      "/products/clean-two": { body: cleanProductHtml("/products/clean-two") },
      "/products/untitled": {
        body: cleanProductHtml("/products/untitled").replace(/<title>[\s\S]*?<\/title>/, ""),
      },
      "/products/thin": {
        body: cleanProductHtml("/products/thin").replace(/<meta name="description"[^>]*>/, ""),
      },
    });

    const payload = await buildSeoTechnicalFindings({
      siteUrl: SITE_URL,
      currentRows: [
        row("/products/clean", 40, 900),
        row("/products/clean-two", 35, 850),
        row("/products/untitled", 30, 800),
        row("/products/thin", 20, 600),
      ],
      previousRows: [
        row("/products/clean", 38, 880),
        row("/products/clean-two", 34, 840),
        row("/products/untitled", 29, 790),
        row("/products/thin", 21, 610),
      ],
    });

    expect(payload.meta.auditedPageCount).toBe(4);
    expect(payload.summary.passed).toBe(2);
    // The builder's invariant: audited = passed + pages carrying at least one
    // critical, warning or opportunity finding. Nothing is counted twice and
    // no audited page falls outside the four cards.
    expect(payload.summary.passed + flaggedPageCount(payload.findings)).toBe(
      payload.meta.auditedPageCount,
    );
  });

  it("folds a PASS verdict into the checks the finding says it cleared", async () => {
    stubFetch({ "/products/clean": { body: cleanProductHtml("/products/clean") } }, "PASS");

    const payload = await buildSeoTechnicalFindings({
      siteUrl: SITE_URL,
      accessToken: "token",
      currentRows: [row("/products/clean", 40, 900)],
      previousRows: [row("/products/clean", 38, 880)],
    });

    const [passed] = findingsOfSeverity(payload, "passed");
    expect(passed.title).toBe(
      "Pages cleared every technical check that ran, including URL Inspection",
    );
    expect(passed.description).toContain("Search Console URL Inspection verdict");
    expect(passed.description).toContain(
      "Search Console URL Inspection returns a PASS verdict",
    );
  });

  it("never passes a page Google reports as excluded, however clean its markup", async () => {
    // The HTML clears every crawl-side check; only URL Inspection dissents.
    stubFetch(
      { "/collections/clean": { body: cleanProductHtml("/collections/clean") } },
      "NEUTRAL",
    );

    const payload = await buildSeoTechnicalFindings({
      siteUrl: SITE_URL,
      accessToken: "token",
      currentRows: [row("/collections/clean", 40, 900)],
      previousRows: [row("/collections/clean", 38, 880)],
    });

    expect(findingsOfSeverity(payload, "passed")).toHaveLength(0);
    expect(payload.summary.passed).toBe(0);
    expect(payload.summary.critical).toBe(1);
    expect(payload.confirmedExcludedPages.map((page) => page.path)).toEqual([
      "/collections/clean",
    ]);
  });

  it("sorts passing findings last", async () => {
    stubFetch({
      "/products/clean": { body: cleanProductHtml("/products/clean") },
      "/products/untitled": {
        body: cleanProductHtml("/products/untitled").replace(/<title>[\s\S]*?<\/title>/, ""),
      },
    });

    const payload = await buildSeoTechnicalFindings({
      siteUrl: SITE_URL,
      currentRows: [row("/products/clean", 40, 900), row("/products/untitled", 30, 800)],
      previousRows: [row("/products/clean", 38, 880), row("/products/untitled", 29, 790)],
    });

    expect(payload.findings.at(-1)?.severity).toBe("passed");
  });
});

describe("buildDemoTechnicalFindings", () => {
  it("reconciles its own four cards", () => {
    const payload = buildDemoTechnicalFindings("sc-domain:urbantrail.co");
    expect(payload.summary.passed).toBe(2);
    expect(payload.summary.passed + flaggedPageCount(payload.findings)).toBe(
      payload.meta.auditedPageCount,
    );
  });

  it("keeps the passing finding out of the two findings the AI snapshot reads", () => {
    const payload = buildDemoTechnicalFindings("sc-domain:urbantrail.co");
    expect(payload.findings.slice(0, 2).map((finding) => finding.severity)).toEqual([
      "critical",
      "warning",
    ]);
  });
});
