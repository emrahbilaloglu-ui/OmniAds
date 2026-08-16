import type { SearchConsoleAnalyticsRow } from "@/lib/seo/intelligence";

export type SeoFindingSeverity = "critical" | "warning" | "opportunity";
export type SeoFindingCategory =
  | "crawl"
  | "indexation"
  | "canonical"
  | "metadata"
  | "content"
  | "structured-data";

export type SeoFindingPageType =
  | "Homepage"
  | "Product"
  | "Category"
  | "Editorial"
  | "Utility"
  | "General";

export interface SeoTechnicalFindingPage {
  path: string;
  url: string;
  pageType: SeoFindingPageType;
  clicksDelta: number;
  impressions: number;
}

export interface SeoTechnicalFinding {
  id: string;
  severity: SeoFindingSeverity;
  category: SeoFindingCategory;
  pageType: SeoFindingPageType;
  title: string;
  description: string;
  recommendation: string;
  affectedPages: SeoTechnicalFindingPage[];
}

export type SeoUrlInspectionStatus =
  "not_requested" | "complete" | "partial" | "failed";

export type SeoUrlInspectionFailureKind =
  | "timeout"
  | "provider"
  | "transport"
  | "invalid_response"
  | "quota_exhausted"
  | "quota_state_unavailable"
  | "cooldown"
  | "governance_state_unavailable";

export interface SeoUrlInspectionFailure {
  path: string;
  kind: SeoUrlInspectionFailureKind;
  status: number | null;
}

/**
 * Per-run evidence for the URL Inspection pass. Optional because this builder
 * does not emit it yet — the panel that reads it renders its absent state
 * rather than showing counts that were never measured.
 */
export interface SeoUrlInspectionEvidence {
  status: SeoUrlInspectionStatus;
  attempted: number;
  succeeded: number;
  failed: number;
  failures: SeoUrlInspectionFailure[];
}

export interface SeoTechnicalFindingsPayload {
  meta: {
    siteUrl: string;
    auditedPageCount: number;
    generatedAt: string;
    urlInspection?: SeoUrlInspectionEvidence;
  };
  summary: {
    critical: number;
    warning: number;
    opportunity: number;
  };
  confirmedExcludedPages: Array<
    SeoTechnicalFindingPage & {
      inspectionVerdict: string | null;
      coverageState: string | null;
      indexingState: string | null;
      pageFetchState: string | null;
      robotsTxtState: string | null;
    }
  >;
  findings: SeoTechnicalFinding[];
}

interface PageMetrics {
  path: string;
  url: string;
  pageType: SeoFindingPageType;
  seenInSearchConsole: boolean;
  clicks: number;
  previousClicks: number;
  clicksDelta: number;
  impressions: number;
  previousImpressions: number;
}

interface PageAuditResult {
  page: SeoTechnicalFindingPage;
  seenInSearchConsole: boolean;
  status: number | null;
  finalUrl: string | null;
  html: string | null;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robots: string | null;
  h1Count: number;
  schemaTypes: string[];
  fetchError: string | null;
}

interface UrlInspectionSummary {
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: string | null;
}

export function buildDemoTechnicalFindings(siteUrl: string): SeoTechnicalFindingsPayload {
  const findings: SeoTechnicalFinding[] = [
    {
      id: "noindex-product-pages",
      severity: "critical",
      category: "indexation",
      pageType: "Product",
      title: "Indexable product pages appear blocked from search indexing",
      description:
        "High-value product URLs are behaving like they may be excluded from indexable search inventory.",
      recommendation:
        "Check robots meta, X-Robots-Tag, canonical targets, and any template logic that marks product pages as noindex.",
      affectedPages: [
        {
          path: "/products/waterproof-backpack",
          url: "https://urbantrail.co/products/waterproof-backpack",
          pageType: "Product",
          clicksDelta: -41,
          impressions: 9830,
        },
      ],
    },
    {
      id: "editorial-metadata-gap",
      severity: "warning",
      category: "metadata",
      pageType: "Editorial",
      title: "Editorial pages need stronger title and meta coverage",
      description:
        "The biggest organic drop is concentrated on editorial pages whose snippets likely need stronger positioning.",
      recommendation:
        "Refresh titles and meta descriptions on declining blog pages with clearer value propositions and target query coverage.",
      affectedPages: [
        {
          path: "/blog/best-travel-backpacks",
          url: "https://urbantrail.co/blog/best-travel-backpacks",
          pageType: "Editorial",
          clicksDelta: -27,
          impressions: 12240,
        },
      ],
    },
    {
      id: "product-schema-gap",
      severity: "opportunity",
      category: "structured-data",
      pageType: "Product",
      title: "Product pages are missing strong structured data coverage",
      description:
        "Product templates should expose machine-readable product signals to strengthen search understanding and rich result eligibility.",
      recommendation:
        "Add Product and BreadcrumbList schema to priority product pages and validate the generated markup.",
      affectedPages: [
        {
          path: "/products/carry-on-backpack",
          url: "https://urbantrail.co/products/carry-on-backpack",
          pageType: "Product",
          clicksDelta: -14,
          impressions: 7310,
        },
      ],
    },
  ];

  return {
    meta: {
      siteUrl,
      auditedPageCount: 3,
      generatedAt: new Date().toISOString(),
    },
    summary: summarizeFindings(findings),
    confirmedExcludedPages: [
      {
        path: "/collections/backpacks",
        url: "https://urbantrail.co/collections/backpacks",
        pageType: "Category",
        clicksDelta: -62,
        impressions: 0,
        inspectionVerdict: "NEUTRAL",
        coverageState: "Excluded by 'noindex' tag",
        indexingState: "BLOCKED_BY_META_TAG",
        pageFetchState: "SUCCESSFUL",
        robotsTxtState: "ALLOWED",
      },
    ],
    findings,
  };
}

export async function buildSeoTechnicalFindings(params: {
  siteUrl: string;
  accessToken?: string;
  currentRows: SearchConsoleAnalyticsRow[];
  previousRows: SearchConsoleAnalyticsRow[];
}): Promise<SeoTechnicalFindingsPayload> {
  const discoveredPaths = await discoverIndexablePaths(params.siteUrl);
  const pages = buildCandidatePages(
    params.siteUrl,
    params.currentRows,
    params.previousRows,
    discoveredPaths,
  );
  const audits = await Promise.all(pages.map((page) => auditPage(page)));
  const inspectionMap = params.accessToken
    ? await inspectPriorityPages(params.accessToken, params.siteUrl, pages, discoveredPaths)
    : new Map<string, UrlInspectionSummary>();
  const findings = aggregateFindings(audits, pages, discoveredPaths, inspectionMap);
  const confirmedExcludedPages = buildConfirmedExcludedPages(pages, inspectionMap);

  return {
    meta: {
      siteUrl: params.siteUrl,
      auditedPageCount: audits.length,
      generatedAt: new Date().toISOString(),
    },
    summary: summarizeFindings(findings),
    confirmedExcludedPages,
    findings,
  };
}

function buildCandidatePages(
  siteUrl: string,
  currentRows: SearchConsoleAnalyticsRow[],
  previousRows: SearchConsoleAnalyticsRow[],
  discoveredPaths: string[],
): PageMetrics[] {
  const previousMap = aggregatePages(previousRows, siteUrl);
  const currentMap = aggregatePages(currentRows, siteUrl);
  const keys = new Set<string>([...currentMap.keys(), ...previousMap.keys(), ...discoveredPaths]);

  return Array.from(keys)
    .map((key) => {
      const current = currentMap.get(key);
      const previous = previousMap.get(key);
      const path = current?.path ?? previous?.path ?? key;
      const url = current?.url ?? previous?.url ?? key;
      const pageType = getPageType(path);
      const clicks = current?.clicks ?? 0;
      const previousClicks = previous?.clicks ?? 0;
      const impressions = current?.impressions ?? 0;
      const previousImpressions = previous?.impressions ?? 0;
      return {
        path,
        url,
        pageType,
        seenInSearchConsole: Boolean(current || previous),
        clicks,
        previousClicks,
        clicksDelta: clicks - previousClicks,
        impressions,
        previousImpressions,
      };
    })
    .filter((row) => isEligibleIndexablePath(row.path))
    .filter((row) => {
      if (row.pageType === "Category" || row.pageType === "Product" || row.pageType === "Editorial") {
        return true;
      }
      if (row.pageType === "Utility") {
        return shouldAuditSupportPage(row);
      }
      if (row.pageType === "Homepage") {
        return shouldAuditSupportPage(row);
      }
      return row.pageType === "General" ? shouldAuditSupportPage(row) : false;
    })
    .sort((a, b) => {
      const aScore = inspectionPriorityScore(a, discoveredPaths);
      const bScore = inspectionPriorityScore(b, discoveredPaths);
      return bScore - aScore;
    })
    .slice(0, 60);
}

function aggregatePages(
  rows: SearchConsoleAnalyticsRow[],
  siteUrl: string,
): Map<string, { path: string; url: string; clicks: number; impressions: number }> {
  const map = new Map<string, { path: string; url: string; clicks: number; impressions: number }>();
  for (const row of rows) {
    const normalized = normalizePageUrl(siteUrl, row.page);
    if (!isEligibleIndexablePath(normalized.path)) continue;
    const existing = map.get(normalized.path) ?? {
      path: normalized.path,
      url: normalized.url,
      clicks: 0,
      impressions: 0,
    };
    existing.clicks += row.clicks;
    existing.impressions += row.impressions;
    map.set(normalized.path, existing);
  }
  return map;
}

function normalizePageUrl(siteUrl: string, page: string): { path: string; url: string } {
  if (/^https?:\/\//i.test(page)) {
    const url = new URL(page);
    return { path: `${url.pathname}${url.search}` || "/", url: url.toString() };
  }

  const base = getSiteBaseUrl(siteUrl);
  const normalizedPath = page.startsWith("/") ? page : `/${page}`;
  return {
    path: normalizedPath,
    url: new URL(normalizedPath, base).toString(),
  };
}

function getSiteBaseUrl(siteUrl: string): string {
  if (siteUrl.startsWith("sc-domain:")) {
    return `https://${siteUrl.replace("sc-domain:", "")}`;
  }
  return siteUrl;
}

function getPageType(path: string): SeoFindingPageType {
  if (path === "/" || path === "") return "Homepage";
  if (path.startsWith("/products/")) return "Product";
  if (path.startsWith("/collections/") || path.startsWith("/category/")) return "Category";
  if (path.startsWith("/blog/") || path.startsWith("/guides/")) return "Editorial";
  if (path.startsWith("/pages/")) return "Utility";
  return "General";
}

async function auditPage(page: PageMetrics): Promise<PageAuditResult> {
  const pageRef: SeoTechnicalFindingPage = {
    path: page.path,
    url: page.url,
    pageType: page.pageType,
    clicksDelta: page.clicksDelta,
    impressions: page.impressions,
  };

  try {
    const response = await fetch(page.url, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "Adsecute SEO Intelligence Bot/1.0",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    const html = await response.text().catch(() => "");
    const finalUrl = response.url || page.url;
    return {
      page: pageRef,
      seenInSearchConsole: page.seenInSearchConsole,
      status: response.status,
      finalUrl,
      html,
      title: extractTagContent(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
      metaDescription: extractMetaContent(html, "description"),
      canonical: extractCanonicalHref(html),
      robots: extractMetaContent(html, "robots"),
      h1Count: (html.match(/<h1\b[^>]*>/gi) ?? []).length,
      schemaTypes: extractSchemaTypes(html),
      fetchError: null,
    };
  } catch (error) {
    return {
      page: pageRef,
      seenInSearchConsole: page.seenInSearchConsole,
      status: null,
      finalUrl: null,
      html: null,
      title: null,
      metaDescription: null,
      canonical: null,
      robots: null,
      h1Count: 0,
      schemaTypes: [],
      fetchError: error instanceof Error ? error.message : "Unknown fetch error",
    };
  }
}

function aggregateFindings(
  audits: PageAuditResult[],
  pages: PageMetrics[],
  discoveredPaths: string[],
  inspectionMap: Map<string, UrlInspectionSummary>,
): SeoTechnicalFinding[] {
  const grouped = new Map<string, SeoTechnicalFinding>();

  for (const finding of buildInspectionFindings(pages, inspectionMap)) {
    grouped.set(
      `${finding.severity}:${finding.category}:${finding.pageType}:${finding.title}`,
      finding,
    );
  }

  for (const finding of buildTemplateRiskFindings(pages, discoveredPaths, inspectionMap)) {
    grouped.set(
      `${finding.severity}:${finding.category}:${finding.pageType}:${finding.title}`,
      finding,
    );
  }

  for (const audit of audits) {
    for (const finding of buildFindingsForPage(audit)) {
      const key = `${finding.severity}:${finding.category}:${finding.pageType}:${finding.title}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.affectedPages.push(...finding.affectedPages);
      } else {
        grouped.set(key, finding);
      }
    }
  }

  return Array.from(grouped.values())
    .map((finding) => ({
      ...finding,
      affectedPages: finding.affectedPages
        .sort((a, b) => Math.abs(b.clicksDelta) - Math.abs(a.clicksDelta) || b.impressions - a.impressions),
    }))
    .sort(compareFindings);
}

function buildFindingsForPage(audit: PageAuditResult): SeoTechnicalFinding[] {
  const findings: SeoTechnicalFinding[] = [];
  const { page } = audit;

  if (
    !audit.seenInSearchConsole &&
    page.pageType !== "Homepage" &&
    page.pageType !== "Utility" &&
    page.pageType !== "Category" &&
    page.pageType !== "Product" &&
    page.pageType !== "Editorial"
  ) {
    return findings;
  }

  if (audit.fetchError || audit.status === null) {
    findings.push(
      createFinding({
        id: `${page.path}-crawl-failed`,
        severity: "critical",
        category: "crawl",
        pageType: page.pageType,
        title: "Priority pages could not be crawled",
        description:
          "The audit could not fetch this page, which blocks technical validation and may signal crawl instability.",
        recommendation:
          "Check origin availability, firewall rules, rate limiting, and whether the page is publicly reachable to bots.",
        page,
      }),
    );
    return findings;
  }

  if ((audit.status ?? 0) >= 400) {
    findings.push(
      createFinding({
        id: `${page.path}-http-error`,
        severity: "critical",
        category: "crawl",
        pageType: page.pageType,
        title: "High-value pages are returning HTTP errors",
        description: `This page returned status ${audit.status}, which can remove it from healthy search visibility.`,
        recommendation:
          "Restore a 200 response or a deliberate canonical redirect for any page that should rank.",
        page,
      }),
    );
  }

  if (audit.finalUrl && normalizeComparableUrl(audit.finalUrl) !== normalizeComparableUrl(page.url)) {
    findings.push(
      createFinding({
        id: `${page.path}-redirected`,
        severity: "warning",
        category: "canonical",
        pageType: page.pageType,
        title: "Priority pages redirect away from their indexed URL",
        description:
          "Search-facing URLs are redirecting to a different destination, which can dilute consistency if not intentional.",
        recommendation:
          "Verify the redirect target is the intended canonical destination and update internal links and sitemaps accordingly.",
        page,
      }),
    );
  }

  const robots = (audit.robots ?? "").toLowerCase();
  if (shouldBeIndexable(page.pageType) && robots.includes("noindex")) {
    findings.push(
      createFinding({
        id: `${page.path}-noindex`,
        severity: "critical",
        category: "indexation",
        pageType: page.pageType,
        title: "Indexable templates are marked noindex",
        description:
          "Pages that should contribute to search growth are explicitly blocked from indexing.",
        recommendation:
          "Remove unintended noindex directives from product, category, and editorial templates that are meant to rank.",
        page,
      }),
    );
  }

  if (shouldHaveCanonical(page.pageType) && !audit.canonical) {
    findings.push(
      createFinding({
        id: `${page.path}-missing-canonical`,
        severity: "warning",
        category: "canonical",
        pageType: page.pageType,
        title: "Priority pages are missing canonical tags",
        description:
          "Missing canonicals make it harder to consolidate the preferred version of an indexable page.",
        recommendation:
          "Add self-referencing canonicals on indexable product, category, editorial, and utility pages.",
        page,
      }),
    );
  }

  if (audit.canonical && normalizeComparableUrl(audit.canonical) !== normalizeComparableUrl(page.url)) {
    findings.push(
      createFinding({
        id: `${page.path}-canonical-mismatch`,
        severity: "warning",
        category: "canonical",
        pageType: page.pageType,
        title: "Canonical targets point away from the audited page",
        description:
          "This page declares a different canonical URL, which can suppress the current URL from indexing if unintended.",
        recommendation:
          "Verify canonical targets match the page you want indexed, especially on declining templates.",
        page,
      }),
    );
  }

  if (!audit.title) {
    findings.push(
      createFinding({
        id: `${page.path}-missing-title`,
        severity: "warning",
        category: "metadata",
        pageType: page.pageType,
        title: "Priority pages are missing title tags",
        description:
          "Missing titles weaken how pages compete in search snippets and can reduce click-through rate.",
        recommendation:
          "Add unique, keyword-aligned title tags to pages carrying meaningful search impressions.",
        page,
      }),
    );
  } else if (audit.title.trim().length < 25) {
    findings.push(
      createFinding({
        id: `${page.path}-weak-title`,
        severity: "opportunity",
        category: "metadata",
        pageType: page.pageType,
        title: "Some titles look too short to win competitive CTR",
        description:
          "Very short titles often under-explain value and can underperform on SERP click-through rate.",
        recommendation:
          "Rewrite short titles to better reflect the query, value proposition, and page intent.",
        page,
      }),
    );
  }

  if (!audit.metaDescription) {
    findings.push(
      createFinding({
        id: `${page.path}-missing-meta-description`,
        severity: "opportunity",
        category: "metadata",
        pageType: page.pageType,
        title: "Pages are missing meta descriptions",
        description:
          "Missing meta descriptions reduce your control over snippet messaging for high-impression URLs.",
        recommendation:
          "Write compelling meta descriptions for pages with meaningful impressions or recent CTR deterioration.",
        page,
      }),
    );
  }

  if (audit.h1Count === 0) {
    findings.push(
      createFinding({
        id: `${page.path}-missing-h1`,
        severity: "warning",
        category: "content",
        pageType: page.pageType,
        title: "Pages are missing a visible H1 heading",
        description:
          "A missing H1 can make content structure weaker for both users and search engines.",
        recommendation:
          "Ensure every indexable page template renders one clear H1 aligned to the primary topic.",
        page,
      }),
    );
  }

  if (shouldHaveStructuredData(page.pageType) && !hasRelevantStructuredData(page.pageType, audit.schemaTypes)) {
    findings.push(
      createFinding({
        id: `${page.path}-missing-structured-data`,
        severity: "opportunity",
        category: "structured-data",
        pageType: page.pageType,
        title: "Important templates are missing relevant structured data",
        description:
          "Structured data helps search engines and AI systems understand the page entity and its content role.",
        recommendation:
          "Add schema markup appropriate to the template, such as Product, Article, FAQPage, HowTo, or BreadcrumbList.",
        page,
      }),
    );
  }

  return findings;
}

function buildInspectionFindings(
  pages: PageMetrics[],
  inspectionMap: Map<string, UrlInspectionSummary>,
): SeoTechnicalFinding[] {
  const findings: SeoTechnicalFinding[] = [];

  for (const pageType of ["Category", "Product", "Editorial"] as const) {
    const affectedPages = pages
      .filter((page) => page.pageType === pageType)
      .filter((page) => page.seenInSearchConsole || inspectionMap.has(page.path))
      .filter((page) => isEligibleIndexablePath(page.path))
      .filter((page) => shouldSurfaceInspectionPage(page, inspectionMap))
      .filter((page) => isInspectionExcluded(inspectionMap.get(page.path)))
      .sort((a, b) => importanceScore(b) - importanceScore(a))
      .map(toFindingPage);

    if (!affectedPages.length) continue;

    findings.push({
      id: `${pageType.toLowerCase()}-inspection-excluded`,
      severity: pageType === "Category" ? "critical" : "warning",
      category: "indexation",
      pageType,
      title:
        pageType === "Category"
          ? "Important category pages are confirmed as excluded or not indexed"
          : pageType === "Product"
            ? "Important product pages are confirmed as excluded or not indexed"
            : "Important editorial pages are confirmed as excluded or not indexed",
      description:
        pageType === "Category"
          ? "Search Console URL Inspection shows that important category URLs are excluded, blocked, or otherwise not indexed by Google."
          : pageType === "Product"
            ? "Search Console URL Inspection shows that important product URLs are excluded, blocked, or otherwise not indexed by Google."
            : "Search Console URL Inspection shows that important editorial URLs are excluded, blocked, or otherwise not indexed by Google.",
      recommendation:
        pageType === "Category"
          ? "Check category template noindex logic, canonical targets, sitemap coverage, robots rules, and any recent collection routing changes."
          : pageType === "Product"
            ? "Check product template noindex logic, canonical targets, internal links, sitemap inclusion, and Product schema integrity."
            : "Check article template indexability, canonical targets, sitemap inclusion, and whether recent publishing changes removed these URLs from discoverable navigation.",
      affectedPages,
    });
  }

  return findings;
}

function createFinding(input: Omit<SeoTechnicalFinding, "affectedPages"> & { page: SeoTechnicalFindingPage }): SeoTechnicalFinding {
  return {
    id: input.id,
    severity: input.severity,
    category: input.category,
    pageType: input.pageType,
    title: input.title,
    description: input.description,
    recommendation: input.recommendation,
    affectedPages: [input.page],
  };
}

function buildTemplateRiskFindings(
  pages: PageMetrics[],
  discoveredPaths: string[],
  inspectionMap: Map<string, UrlInspectionSummary>,
): SeoTechnicalFinding[] {
  const findings: SeoTechnicalFinding[] = [];
  const categoryPages = pages.filter((page) => page.pageType === "Category" && page.seenInSearchConsole);
  const editorialPages = pages.filter((page) => page.pageType === "Editorial" && page.seenInSearchConsole);
  const productPages = pages.filter((page) => page.pageType === "Product" && page.seenInSearchConsole);

  const categoryDiscoveryCount = discoveredPaths.filter((path) => getPageType(path) === "Category").length;
  const editorialDiscoveryCount = discoveredPaths.filter((path) => getPageType(path) === "Editorial").length;

  const categoryCollapse = detectTemplateCollapse(categoryPages, Math.max(2, Math.min(4, categoryDiscoveryCount || 2)));
  if (categoryCollapse) {
    const confirmedCategories = categoryCollapse.filter((page) => isInspectionExcluded(inspectionMap.get(page.path)));
    findings.push({
      id: confirmedCategories.length >= 1 ? "category-index-confirmed" : "category-index-risk",
      severity: "critical",
      category: "indexation",
      pageType: "Category",
      title:
        confirmedCategories.length >= 1
          ? "Main category pages are confirmed as excluded or not indexed"
          : "Main category pages may have dropped out of indexable search visibility",
      description:
        confirmedCategories.length >= 1
          ? "URL Inspection confirms that one or more important category pages are excluded, blocked, or not indexed in Google."
          : "Several category URLs that should be index-driving are showing near-zero current visibility compared with the previous period. This often points to deindexation, canonical drift, or template-level crawl/index issues.",
      recommendation:
        "Validate category templates for noindex, canonical targets, robots rules, sitemap inclusion, and any recent template changes affecting collection/category pages.",
      affectedPages: confirmedCategories.length >= 1 ? confirmedCategories : categoryCollapse,
    });
  }

  const editorialCollapse = detectTemplateCollapse(editorialPages, Math.max(2, Math.min(4, editorialDiscoveryCount || 2)));
  if (editorialCollapse) {
    findings.push({
      id: "editorial-index-risk",
      severity: "warning",
      category: "indexation",
      pageType: "Editorial",
      title: "Editorial pages show a cluster-level visibility collapse",
      description:
        "A group of blog or guide pages lost most of their prior search footprint, which can indicate indexation or canonical consistency problems beyond a single article.",
      recommendation:
        "Audit editorial templates, recent publishing changes, canonical tags, and whether important guides remain linked and included in sitemaps.",
      affectedPages: editorialCollapse,
    });
  }

  const productUnderexposed = productPages
    .filter((page) => page.impressions === 0 && page.previousImpressions === 0)
    .filter((page) => page.clicksDelta <= 0)
    .map(toFindingPage);
  if (productUnderexposed.length >= 3) {
    findings.push({
      id: "product-discovery-gap",
      severity: "opportunity",
      category: "indexation",
      pageType: "Product",
      title: "Multiple product pages have little or no search footprint",
      description:
        "Important product URLs are present but are not building meaningful organic visibility, which may signal discoverability or template signal gaps.",
      recommendation:
        "Confirm product pages are linked internally, in sitemap coverage, canonicalized correctly, and enriched with Product schema and unique metadata.",
      affectedPages: productUnderexposed,
    });
  }

  return findings;
}

async function inspectPriorityPages(
  accessToken: string,
  siteUrl: string,
  pages: PageMetrics[],
  discoveredPaths: string[],
): Promise<Map<string, UrlInspectionSummary>> {
  const discoveredSet = new Set(discoveredPaths);
  const priorityPages = pages
    .filter((page) => page.pageType === "Category" || page.pageType === "Editorial" || page.pageType === "Product")
    .sort((a, b) => inspectionPriorityScore(b, discoveredPaths) - inspectionPriorityScore(a, discoveredPaths))
    .filter((page, index, collection) => collection.findIndex((entry) => entry.path === page.path) === index);

  const categoryPages = priorityPages
    .filter((page) => page.pageType === "Category")
    .slice(0, 24);
  const editorialPages = priorityPages
    .filter((page) => page.pageType === "Editorial")
    .slice(0, 12);
  const productPages = priorityPages
    .filter((page) => page.pageType === "Product")
    .slice(0, 24);
  const discoveredCategoryPages = priorityPages
    .filter((page) => page.pageType === "Category")
    .filter((page) => discoveredSet.has(page.path))
    .slice(0, 20);
  const discoveredProductPages = priorityPages
    .filter((page) => page.pageType === "Product")
    .filter((page) => discoveredSet.has(page.path))
    .slice(0, 20);
  const discoveredEditorialPages = priorityPages
    .filter((page) => page.pageType === "Editorial")
    .filter((page) => discoveredSet.has(page.path))
    .slice(0, 12);

  const inspectionQueue = Array.from(
    new Map(
      [
        ...categoryPages,
        ...discoveredCategoryPages,
        ...productPages,
        ...discoveredProductPages,
        ...editorialPages,
        ...discoveredEditorialPages,
      ].map((page) => [page.path, page]),
    ).values(),
  ).slice(0, 48);

  const inspections = await Promise.all(
    inspectionQueue.map(async (page) => {
      const inspection = await inspectUrl(accessToken, siteUrl, page.url).catch(() => null);
      return [page.path, inspection] as const;
    }),
  );

  return new Map(
    inspections.filter((entry): entry is readonly [string, UrlInspectionSummary] => Boolean(entry[1])),
  );
}

async function inspectUrl(
  accessToken: string,
  siteUrl: string,
  inspectionUrl: string,
): Promise<UrlInspectionSummary> {
  const response = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      inspectionUrl,
      siteUrl,
      languageCode: "en-US",
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        inspectionResult?: {
          indexStatusResult?: {
            verdict?: string;
            coverageState?: string;
            indexingState?: string;
            robotsTxtState?: string;
            pageFetchState?: string;
            googleCanonical?: string;
            userCanonical?: string;
            lastCrawlTime?: string;
          };
        };
      }
    | null;

  if (!response.ok) {
    throw new Error("URL Inspection request failed.");
  }

  const result = payload?.inspectionResult?.indexStatusResult;
  return {
    verdict: result?.verdict ?? null,
    coverageState: result?.coverageState ?? null,
    indexingState: result?.indexingState ?? null,
    robotsTxtState: result?.robotsTxtState ?? null,
    pageFetchState: result?.pageFetchState ?? null,
    googleCanonical: result?.googleCanonical ?? null,
    userCanonical: result?.userCanonical ?? null,
    lastCrawlTime: result?.lastCrawlTime ?? null,
  };
}

function isInspectionExcluded(inspection: UrlInspectionSummary | undefined): boolean {
  if (!inspection) return false;
  if (inspection.verdict === "NEUTRAL" || inspection.verdict === "FAIL") return true;
  if (
    inspection.indexingState === "BLOCKED_BY_META_TAG" ||
    inspection.indexingState === "BLOCKED_BY_HTTP_HEADER"
  ) {
    return true;
  }
  if (
    inspection.pageFetchState &&
    inspection.pageFetchState !== "SUCCESSFUL"
  ) {
    return true;
  }
  return false;
}

function buildConfirmedExcludedPages(
  pages: PageMetrics[],
  inspectionMap: Map<string, UrlInspectionSummary>,
): SeoTechnicalFindingsPayload["confirmedExcludedPages"] {
  return pages
    .filter((page) => page.pageType === "Category" || page.pageType === "Product" || page.pageType === "Editorial")
    .filter((page) => page.seenInSearchConsole || inspectionMap.has(page.path))
    .filter((page) => isEligibleIndexablePath(page.path))
    .filter((page) => shouldSurfaceInspectionPage(page, inspectionMap))
    .map((page) => ({
      page,
      inspection: inspectionMap.get(page.path),
    }))
    .filter((entry): entry is { page: PageMetrics; inspection: UrlInspectionSummary } => Boolean(entry.inspection))
    .filter((entry) => isInspectionExcluded(entry.inspection))
    .sort((a, b) => importanceScore(b.page) - importanceScore(a.page))
    .map(({ page, inspection }) => ({
      ...toFindingPage(page),
      inspectionVerdict: inspection.verdict,
      coverageState: inspection.coverageState,
      indexingState: inspection.indexingState,
      pageFetchState: inspection.pageFetchState,
      robotsTxtState: inspection.robotsTxtState,
    }));
}

function detectTemplateCollapse(
  pages: PageMetrics[],
  minCount: number,
): SeoTechnicalFindingPage[] | null {
  const collapsing = pages
    .filter((page) => page.previousImpressions >= 20)
    .filter((page) => page.impressions <= Math.max(2, page.previousImpressions * 0.15))
    .sort((a, b) => b.previousImpressions - a.previousImpressions)
    .map(toFindingPage);

  return collapsing.length >= minCount ? collapsing : null;
}

function isImportantIndexablePage(page: PageMetrics): boolean {
  return (
    page.impressions >= 50 ||
    page.previousImpressions >= 50 ||
    Math.abs(page.clicksDelta) >= 10 ||
    page.previousClicks >= 10
  );
}

function shouldInspectAsImportant(page: PageMetrics): boolean {
  if (page.pageType === "Category") {
    return (
      page.previousImpressions >= 10 ||
      page.impressions >= 10 ||
      page.previousClicks >= 3 ||
      Math.abs(page.clicksDelta) >= 3
    );
  }

  return isImportantIndexablePage(page);
}

function shouldSurfaceInspectionPage(
  page: PageMetrics,
  inspectionMap: Map<string, UrlInspectionSummary>,
) {
  return shouldInspectAsImportant(page) || inspectionMap.has(page.path);
}

function isEligibleIndexablePath(path: string) {
  if (path.includes("?")) return false;
  if (path.endsWith(".atom")) return false;
  if (path.startsWith("/services/")) return false;
  if (path.startsWith("/search")) return false;
  if (path.startsWith("/cart")) return false;
  if (path.startsWith("/account")) return false;
  return true;
}

function importanceScore(page: PageMetrics) {
  return (
    Math.max(page.impressions, page.previousImpressions) +
    Math.max(0, -page.clicksDelta) * 20 +
    page.previousClicks * 10
  );
}

function inspectionPriorityScore(page: PageMetrics, discoveredPaths: string[]) {
  const discoveredBoost = discoveredPaths.includes(page.path) ? 400 : 0;
  const pageTypeBoost =
    page.pageType === "Category"
      ? 800
      : page.pageType === "Editorial"
        ? 350
        : page.pageType === "Product"
          ? 250
          : page.pageType === "Utility"
            ? 120
            : page.pageType === "Homepage"
              ? 80
          : 0;

  return (
    pageTypeBoost +
    discoveredBoost +
    Math.max(page.impressions, page.previousImpressions) +
    Math.max(0, page.previousImpressions - page.impressions) * 3 +
    Math.max(0, -page.clicksDelta) * 40 +
    page.previousClicks * 15
  );
}

function shouldAuditSupportPage(page: PageMetrics) {
  return (
    page.impressions >= 25 ||
    page.previousImpressions >= 25 ||
    page.clicks >= 5 ||
    page.previousClicks >= 5 ||
    Math.abs(page.clicksDelta) >= 5
  );
}

function toFindingPage(page: PageMetrics): SeoTechnicalFindingPage {
  return {
    path: page.path,
    url: page.url,
    pageType: page.pageType,
    clicksDelta: page.clicksDelta,
    impressions: page.impressions,
  };
}

async function discoverIndexablePaths(siteUrl: string): Promise<string[]> {
  const [sitemapPaths, homepagePaths] = await Promise.all([
    fetchSitemapPaths(siteUrl),
    fetchHomepagePaths(siteUrl),
  ]);

  return Array.from(
    new Set(
      [...sitemapPaths, ...homepagePaths].filter((path) => {
        if (!isEligibleIndexablePath(path)) return false;
        const pageType = getPageType(path);
        return pageType === "Category" || pageType === "Product" || pageType === "Editorial";
      }),
    ),
  );
}

async function fetchSitemapPaths(siteUrl: string): Promise<string[]> {
  try {
    const base = getSiteBaseUrl(siteUrl);
    const sitemapUrl = new URL("/sitemap.xml", base).toString();
    return await fetchSitemapPathsRecursive(siteUrl, sitemapUrl, new Set<string>(), 0);
  } catch {
    return [];
  }
}

async function fetchSitemapPathsRecursive(
  siteUrl: string,
  sitemapUrl: string,
  visited: Set<string>,
  depth: number,
): Promise<string[]> {
  if (visited.has(sitemapUrl) || depth > 2 || visited.size >= 15) return [];
  visited.add(sitemapUrl);

  const response = await fetch(sitemapUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
    headers: {
      "User-Agent": "Adsecute SEO Intelligence Bot/1.0",
      Accept: "application/xml,text/xml",
    },
  });
  if (!response.ok) return [];

  const xml = await response.text();
  const locs = parseLocsFromXml(xml);
  const isSitemapIndex = /<sitemapindex[\s>]/i.test(xml);

  if (isSitemapIndex) {
    const nested = await Promise.all(
      locs
        .filter((loc) => /\.xml($|\?)/i.test(loc))
        .slice(0, 12)
        .map((loc) => fetchSitemapPathsRecursive(siteUrl, loc, visited, depth + 1)),
    );
    return nested.flat().slice(0, 2000);
  }

  return locs
    .map((loc) => normalizePageUrl(siteUrl, loc).path)
    .filter((path) => Boolean(path) && isEligibleIndexablePath(path))
    .slice(0, 2000);
}

async function fetchHomepagePaths(siteUrl: string): Promise<string[]> {
  try {
    const base = getSiteBaseUrl(siteUrl);
    const response = await fetch(base, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "Adsecute SEO Intelligence Bot/1.0",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) return [];
    const html = await response.text();
    return Array.from(
      new Set(
        Array.from(html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi))
          .map((match) => match[1])
          .filter((href) => !href.startsWith("mailto:") && !href.startsWith("tel:") && !href.startsWith("javascript:"))
          .map((href) => normalizePageUrl(siteUrl, href).path),
      ),
    ).slice(0, 200);
  } catch {
    return [];
  }
}

function parseLocsFromXml(xml: string): string[] {
  return Array.from(xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi))
    .map((match) => decodeXmlEntities(match[1].trim()))
    .filter(Boolean);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTagContent(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern);
  const value = match?.[1]?.replace(/\s+/g, " ").trim();
  return value ? value : null;
}

function extractMetaContent(html: string, name: string): string | null {
  const metaPattern = new RegExp(
    `<meta[^>]+(?:name|property)=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const reversePattern = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escapeRegExp(name)}["'][^>]*>`,
    "i",
  );
  return extractTagContent(html, metaPattern) ?? extractTagContent(html, reversePattern);
}

function extractCanonicalHref(html: string): string | null {
  const canonicalPattern = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i;
  const reversePattern = /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i;
  return extractTagContent(html, canonicalPattern) ?? extractTagContent(html, reversePattern);
}

function extractSchemaTypes(html: string): string[] {
  return Array.from(
    new Set(
      Array.from(html.matchAll(/"@type"\s*:\s*"([^"]+)"/gi))
        .map((match) => match[1])
        .filter(Boolean),
    ),
  );
}

function shouldBeIndexable(pageType: SeoFindingPageType) {
  return pageType === "Product" || pageType === "Category" || pageType === "Editorial";
}

function shouldHaveCanonical(pageType: SeoFindingPageType) {
  return pageType !== "Homepage";
}

function shouldHaveStructuredData(pageType: SeoFindingPageType) {
  return pageType === "Product" || pageType === "Category" || pageType === "Editorial";
}

function hasRelevantStructuredData(pageType: SeoFindingPageType, schemaTypes: string[]) {
  const types = schemaTypes.map((type) => type.toLowerCase());
  if (pageType === "Product") return types.includes("product") || types.includes("breadcrumblist");
  if (pageType === "Category") return types.includes("breadcrumblist") || types.includes("collectionpage");
  if (pageType === "Editorial") {
    return (
      types.includes("article") ||
      types.includes("blogposting") ||
      types.includes("faqpage") ||
      types.includes("howto") ||
      types.includes("breadcrumblist")
    );
  }
  return true;
}

function normalizeComparableUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function summarizeFindings(findings: SeoTechnicalFinding[]) {
  const buckets: Record<SeoFindingSeverity, Set<string>> = {
    critical: new Set<string>(),
    warning: new Set<string>(),
    opportunity: new Set<string>(),
  };

  for (const finding of findings) {
    for (const page of finding.affectedPages) {
      buckets[finding.severity].add(page.path);
    }
  }

  return {
    critical: buckets.critical.size,
    warning: buckets.warning.size,
    opportunity: buckets.opportunity.size,
  };
}

function compareFindings(a: SeoTechnicalFinding, b: SeoTechnicalFinding) {
  const severityRank: Record<SeoFindingSeverity, number> = {
    critical: 0,
    warning: 1,
    opportunity: 2,
  };
  return (
    severityRank[a.severity] - severityRank[b.severity] ||
    b.affectedPages.length - a.affectedPages.length ||
    a.title.localeCompare(b.title)
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
