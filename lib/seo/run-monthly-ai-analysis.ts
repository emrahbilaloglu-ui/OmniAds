import { computePreviousPeriod } from "@/lib/geo-momentum";
import { getDb } from "@/lib/db";
import { getAnalyticsOverviewData } from "@/lib/analytics-overview";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoSearchConsoleAnalytics } from "@/lib/demo-business";
import type { SeoTechnicalFindingsPayload } from "@/lib/seo/findings";
import { buildDemoTechnicalFindings, buildSeoTechnicalFindings } from "@/lib/seo/findings";
import {
  buildAiAnalysis,
  buildAiContextBlocks,
  buildAiDataLayers,
  buildAiRequestedOutputs,
  buildDemoPreviousRows,
  buildSeoOverviewPayload,
  fetchSearchConsoleAnalyticsRows,
  type SeoAiAnalysis,
  type SeoOverviewPayload,
} from "@/lib/seo/intelligence";
import {
  buildCrawlDataString,
  buildGa4DataString,
  buildGscDataString,
  type SeoPromptSiteContext,
} from "@/lib/seo/seo-prompts";
import { resolveSearchConsoleContext } from "@/lib/search-console";
import {
  getSeoMonthlyAiAnalysis,
  saveSeoMonthlyAiAnalysisFailure,
  saveSeoMonthlyAiAnalysisSuccess,
} from "@/lib/seo/monthly-ai-analysis-store";

export interface SeoMonthlyAiAnalysisResponse {
  monthKey: string;
  monthLabel?: string;
  generatedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  status: "available" | "not_generated" | "failed";
  canGenerate: boolean;
  unavailableReason?: string;
  overviewData: SeoOverviewPayload["aiWorkspace"] | null;
  analysis: SeoAiAnalysis | null;
}

const DEMO_SNAPSHOT_REUSE_INTERVAL_MS = 10 * 60 * 1000;

function toAnalysisMonth(date: string) {
  return `${date.slice(0, 7)}-01`;
}

function toMonthLabel(analysisMonth: string) {
  const date = new Date(`${analysisMonth}T00:00:00.000Z`);
  return date.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function hasStoredDemoSnapshot(rawResponse: unknown) {
  return Boolean(
    rawResponse &&
      typeof rawResponse === "object" &&
      "mode" in rawResponse &&
      rawResponse.mode === "demo_snapshot",
  );
}

function getDemoSnapshotAvailability(updatedAt: string | null, rawResponse?: unknown) {
  if (!updatedAt || !hasStoredDemoSnapshot(rawResponse)) {
    return {
      canGenerate: true,
      nextAvailableAt: null,
    };
  }

  const updatedAtMs = new Date(updatedAt).getTime();
  if (Number.isNaN(updatedAtMs)) {
    return {
      canGenerate: true,
      nextAvailableAt: null,
    };
  }

  const nextAvailableAt = new Date(updatedAtMs + DEMO_SNAPSHOT_REUSE_INTERVAL_MS).toISOString();
  return {
    canGenerate: Date.now() >= updatedAtMs + DEMO_SNAPSHOT_REUSE_INTERVAL_MS,
    nextAvailableAt,
  };
}

function buildOverviewWorkspace(params: {
  siteUrl: string;
  overview: SeoOverviewPayload;
}): SeoOverviewPayload["aiWorkspace"] {
  return {
    dataLayers: buildAiDataLayers(),
    contextBlocks: buildAiContextBlocks({
      siteUrl: params.siteUrl,
      summary: params.overview.summary,
      allPages: [
        ...params.overview.leaders.pages,
        ...params.overview.movers.decliningPages,
        ...params.overview.movers.improvingPages,
      ],
      decliningPages: params.overview.movers.decliningPages,
    }),
    requestedOutputs: buildAiRequestedOutputs(),
  };
}

function normalizeDemoAffectedArea(value: string): "category" | "product" | "editorial" | "mixed" {
  if (value === "Category") return "category";
  if (value === "Product") return "product";
  if (value === "Editorial") return "editorial";
  return "mixed";
}

function buildDemoSnapshotAnalysis(params: {
  siteUrl: string;
  overview: SeoOverviewPayload;
  technicalFindings: SeoTechnicalFindingsPayload;
}): SeoAiAnalysis {
  const allPages = [
    ...params.overview.leaders.pages,
    ...params.overview.movers.decliningPages,
    ...params.overview.movers.improvingPages,
  ];
  const productPages = allPages.filter((page) => page.classificationTone === "product").length;
  const categoryPages = allPages.filter((page) => page.classificationTone === "category").length;
  const editorialPages = allPages.filter((page) => page.classificationTone === "editorial").length;
  const topDecliningPage = params.overview.movers.decliningPages[0];
  const topDecliningQuery = params.overview.movers.decliningQueries[0];
  const topExcludedPage = params.technicalFindings.confirmedExcludedPages[0];
  // A passing verdict is neither a root cause nor a priority.
  const failingFindings = params.technicalFindings.findings.filter(
    (finding) => finding.severity !== "passed",
  );
  const dominantAffectedArea: SeoAiAnalysis["rootCauses"][number]["affectedArea"] = topDecliningPage
    ? topDecliningPage.classificationTone === "category"
      ? "category"
      : topDecliningPage.classificationTone === "product"
        ? "product"
        : topDecliningPage.classificationTone === "editorial"
          ? "editorial"
          : "mixed"
    : "mixed";

  const summaryParts = [
    params.overview.summary.clicks.deltaPercent !== null
      ? `Organic clicks are tracking ${Math.abs(params.overview.summary.clicks.deltaPercent * 100).toFixed(0)}% ${
          params.overview.summary.clicks.deltaPercent >= 0 ? "up" : "down"
        } versus the previous period`
      : "Organic performance shifted versus the previous period",
    topDecliningPage
      ? `the sharpest page-level pressure is on ${topDecliningPage.label}`
      : null,
    topExcludedPage
      ? `${topExcludedPage.path} is still carrying an indexation warning in the demo crawl snapshot`
      : null,
  ].filter(Boolean);

  const rootCauses: SeoAiAnalysis["rootCauses"] = [
    topExcludedPage
      ? {
          title: "Priority landing pages are still exposed to indexation blockers",
          detail: `${topExcludedPage.path} is flagged as ${topExcludedPage.coverageState ?? "excluded"}, which keeps important category or product demand from turning into stable search visibility.`,
          confidence: "high" as const,
          affectedArea: normalizeDemoAffectedArea(topExcludedPage.pageType),
        }
      : null,
    ...failingFindings.slice(0, 2).map((finding) => ({
      title: finding.title,
      detail: `${finding.description} Recommended next move: ${finding.recommendation}`,
      confidence:
        finding.severity === "critical"
          ? ("high" as const)
          : finding.severity === "warning"
            ? ("medium" as const)
            : ("medium" as const),
      affectedArea: normalizeDemoAffectedArea(finding.pageType) as SeoAiAnalysis["rootCauses"][number]["affectedArea"],
    })),
    ...params.overview.causes.slice(0, 1).map((cause) => ({
      title: cause.title,
      detail: cause.explanation,
      confidence: cause.confidence,
      affectedArea: dominantAffectedArea,
    })),
  ].filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, 3);

  const priorities = [
    ...failingFindings.slice(0, 2).map((finding) => ({
      title: finding.recommendation,
      detail: `Snapshot-backed priority from ${finding.pageType.toLowerCase()} pages. ${finding.affectedPages[0]?.path ?? finding.title}`,
      impact: finding.severity === "critical" ? ("high" as const) : ("medium" as const),
      effort:
        finding.category === "metadata"
          ? ("low" as const)
          : finding.category === "structured-data"
            ? ("medium" as const)
            : ("medium" as const),
      owner:
        finding.category === "metadata"
          ? "Content"
          : finding.category === "structured-data"
            ? "Developer"
            : "SEO",
    })),
    ...params.overview.recommendations.slice(0, 2).map((recommendation) => ({
      title: recommendation.title,
      detail: recommendation.rationale,
      impact: recommendation.impact,
      effort: recommendation.effort,
      owner:
        recommendation.effort === "high"
          ? "Developer"
          : recommendation.impact === "high"
            ? "SEO"
            : "Content",
    })),
  ].slice(0, 4);

  const actionPlan = [
    {
      window: "Days 1-3",
      focus: "Stabilize indexation coverage",
      tasks: [
        topExcludedPage
          ? `Review template directives and canonical logic affecting ${topExcludedPage.path}.`
          : "Review product and category template directives for hidden noindex behavior.",
        "Validate the highest-risk product and category URLs in Search Console URL Inspection.",
        "Capture the before/after state in the reviewer demo notes.",
      ],
      successMetric: "Priority URLs become indexable and no new critical exclusions appear.",
    },
    {
      window: "Week 1",
      focus: "Recover snippet efficiency on losing pages",
      tasks: [
        params.technicalFindings.findings[1]?.recommendation ??
          "Refresh title and meta coverage on the largest editorial losers.",
        topDecliningQuery
          ? `Map ${topDecliningQuery.label} to the best-fit landing page and tighten intent alignment.`
          : "Tighten landing-page alignment for the largest declining queries.",
        "Re-check CTR trend after the metadata refresh snapshot.",
      ],
      successMetric: "CTR on the biggest losers begins to recover from the current baseline.",
    },
    {
      window: "Week 2-4",
      focus: "Improve product-page search understanding",
      tasks: [
        "Add or validate Product and BreadcrumbList schema on revenue-driving product templates.",
        "Prioritize pages with both impression volume and negative click delta.",
        "Refresh the snapshot again after 10 minutes when demonstrating the flow.",
      ],
      successMetric: "High-impression product pages retain coverage while rich-result readiness improves.",
    },
  ];

  return {
    source: "ai",
    summary: `${summaryParts.join("; ")}. This demo overview is served from a saved snapshot, so no live AI request is sent when the button is used.`,
    ecommerceContext: `${params.siteUrl.replace(/^sc-domain:/, "")} is being evaluated as an ecommerce catalog with ${productPages} product pages, ${categoryPages} category pages, and ${editorialPages} editorial pages in the visible search footprint. Demo mode reuses deterministic snapshot output so reviewers always see a stable plan.`,
    rootCauses,
    priorities,
    actionPlan,
  };
}

async function resolveSeoPromptSiteContext(params: {
  businessId: string;
  siteUrl: string;
  allPages: SeoOverviewPayload["leaders"]["pages"];
  allMoverPages: SeoOverviewPayload["movers"]["decliningPages"];
}) {
  const sql = getDb();
  const rows = (await sql`
    SELECT industry, metadata
    FROM businesses
    WHERE id = ${params.businessId}::uuid
    LIMIT 1
  `) as Array<{ industry?: string | null; metadata?: Record<string, unknown> | null }>;
  const row = rows[0];
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : null;
  const domain = params.siteUrl.replace(/^sc-domain:/, "");
  const categoryCount = params.allPages.filter((page) => page.classificationTone === "category").length;
  const productCount = params.allPages.filter((page) => page.classificationTone === "product").length;
  const editorialCount = params.allPages.filter((page) => page.classificationTone === "editorial").length;

  return {
    domain: domain || null,
    sector: row?.industry ?? null,
    scale: `${productCount} product pages, ${categoryCount} category pages, ${editorialCount} editorial pages in the visible search footprint`,
    constraints:
      metadata && typeof metadata.team_constraints === "string"
        ? metadata.team_constraints
        : null,
    recentChanges:
      metadata && typeof metadata.recent_changes === "string"
        ? metadata.recent_changes
        : null,
  } satisfies SeoPromptSiteContext;
}

export async function getSeoMonthlyAiAnalysisForPeriod(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<SeoMonthlyAiAnalysisResponse> {
  const analysisMonth = toAnalysisMonth(params.endDate);
  const demoBusiness = await isDemoBusiness(params.businessId);
  const record = await getSeoMonthlyAiAnalysis({
    businessId: params.businessId,
    analysisMonth,
  });

  if (demoBusiness) {
    if (!record) {
      return {
        monthKey: analysisMonth,
        generatedAt: null,
        periodStart: params.startDate,
        periodEnd: params.endDate,
        status: "not_generated" as const,
        canGenerate: true,
        overviewData: null,
        analysis: null,
      };
    }

    const availability = getDemoSnapshotAvailability(record.updated_at, record.raw_response);
    if (record.status === "success" && record.analysis && availability.canGenerate) {
      return {
        monthKey: analysisMonth,
        generatedAt: null,
        periodStart: params.startDate,
        periodEnd: params.endDate,
        status: "not_generated" as const,
        canGenerate: true,
        overviewData: null,
        analysis: null,
      };
    }

    return {
      monthKey: analysisMonth,
      generatedAt: record.updated_at,
      periodStart: record.period_start,
      periodEnd: record.period_end,
      status: record.status === "success" && record.analysis ? "available" : "failed",
      canGenerate: record.status === "success" ? availability.canGenerate : true,
      unavailableReason: record.status === "failed" ? record.error_message ?? "Generation failed." : undefined,
      overviewData: null,
      analysis: record.analysis,
    } satisfies SeoMonthlyAiAnalysisResponse;
  }

  if (!record) {
    return {
      monthKey: analysisMonth,
      generatedAt: null,
      periodStart: params.startDate,
      periodEnd: params.endDate,
      status: "not_generated" as const,
      canGenerate: Boolean(process.env.OPENAI_API_KEY),
      unavailableReason: process.env.OPENAI_API_KEY
        ? undefined
        : "OpenAI is not configured on this environment.",
      overviewData: null,
      analysis: null,
    };
  }

  return {
    monthKey: analysisMonth,
    generatedAt: record.updated_at,
    periodStart: record.period_start,
    periodEnd: record.period_end,
    status: record.status === "success" && record.analysis ? "available" : "failed",
    canGenerate:
      record.status !== "success" &&
      Boolean(process.env.OPENAI_API_KEY),
    unavailableReason: record.status === "failed" ? record.error_message ?? "Generation failed." : undefined,
    overviewData:
      record.analysis && typeof record.analysis === "object" && "ecommerceContext" in record.analysis
        ? null
        : null,
    analysis: record.analysis,
  } satisfies SeoMonthlyAiAnalysisResponse;
}

async function buildSeoMonthlyAnalysisInputs(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<{
  siteUrl: string;
  overview: SeoOverviewPayload;
  technicalFindings: SeoTechnicalFindingsPayload;
}> {
  if (await isDemoBusiness(params.businessId)) {
    const siteUrl = "sc-domain:urbantrail.co";
    const currentRows = getDemoSearchConsoleAnalytics().rows;
    const previousRows = buildDemoPreviousRows(currentRows);
    const overview = await buildSeoOverviewPayload({
      siteUrl,
      startDate: params.startDate,
      endDate: params.endDate,
      currentRows,
      previousRows,
      businessId: params.businessId,
      preferRuleBasedBrief: true,
    });

    return {
      siteUrl,
      overview,
      technicalFindings: buildDemoTechnicalFindings(siteUrl),
    };
  }

  const context = await resolveSearchConsoleContext({
    businessId: params.businessId,
    requireSite: true,
  });
  const siteUrl = context.siteUrl ?? "";
  const { prevStart, prevEnd } = computePreviousPeriod(params.startDate, params.endDate);
  const [currentRows, previousRows] = await Promise.all([
    fetchSearchConsoleAnalyticsRows({
      accessToken: context.accessToken,
      siteUrl,
      startDate: params.startDate,
      endDate: params.endDate,
      rowLimit: 500,
    }),
    fetchSearchConsoleAnalyticsRows({
      accessToken: context.accessToken,
      siteUrl,
      startDate: prevStart,
      endDate: prevEnd,
      rowLimit: 500,
    }),
  ]);

  const overview = await buildSeoOverviewPayload({
    siteUrl,
    startDate: params.startDate,
    endDate: params.endDate,
    currentRows,
    previousRows,
  });

  return {
    siteUrl,
    overview,
    technicalFindings: await buildSeoTechnicalFindings({
      siteUrl,
      accessToken: context.accessToken,
      currentRows,
      previousRows,
    }),
  };
}

export async function generateSeoMonthlyAiAnalysis(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<{
  alreadyGenerated: boolean;
  payload: SeoMonthlyAiAnalysisResponse;
}> {
  const analysisMonth = toAnalysisMonth(params.endDate);
  const demoBusiness = await isDemoBusiness(params.businessId);
  const existing = await getSeoMonthlyAiAnalysis({
    businessId: params.businessId,
    analysisMonth,
  });

  if (demoBusiness) {
    const availability = existing
      ? getDemoSnapshotAvailability(existing.updated_at, existing.raw_response)
      : { canGenerate: true, nextAvailableAt: null };

    if (existing?.status === "success" && existing.analysis && !availability.canGenerate) {
      return {
        alreadyGenerated: true,
        payload: {
          monthKey: analysisMonth,
          generatedAt: existing.updated_at,
          periodStart: existing.period_start,
          periodEnd: existing.period_end,
          status: "available" as const,
          canGenerate: false,
          overviewData: null,
          analysis: existing.analysis,
        },
      };
    }

    const { siteUrl, overview, technicalFindings } = await buildSeoMonthlyAnalysisInputs({
      businessId: params.businessId,
      startDate: params.startDate,
      endDate: params.endDate,
    });
    const analysis = buildDemoSnapshotAnalysis({
      siteUrl,
      overview,
      technicalFindings,
    });
    const stored = await saveSeoMonthlyAiAnalysisSuccess({
      businessId: params.businessId,
      analysisMonth,
      periodStart: params.startDate,
      periodEnd: params.endDate,
      analysis,
      rawResponse: {
        mode: "demo_snapshot",
        generatedWithoutAi: true,
        reuseIntervalMs: DEMO_SNAPSHOT_REUSE_INTERVAL_MS,
        snapshotVersion: 1,
      },
    });
    const refreshedAvailability = getDemoSnapshotAvailability(stored.updated_at, {
      mode: "demo_snapshot",
    });

    return {
      alreadyGenerated: false,
      payload: {
        monthKey: analysisMonth,
        generatedAt: stored.updated_at,
        periodStart: stored.period_start,
        periodEnd: stored.period_end,
        status: "available" as const,
        canGenerate: refreshedAvailability.canGenerate,
        overviewData: buildOverviewWorkspace({ siteUrl, overview }),
        analysis,
      },
    };
  }

  if (existing?.status === "success" && existing.analysis) {
    return {
      alreadyGenerated: true,
      payload: {
        monthKey: analysisMonth,
        generatedAt: existing.updated_at,
        periodStart: existing.period_start,
        periodEnd: existing.period_end,
        status: "available" as const,
        canGenerate: false,
        overviewData: null,
        analysis: existing.analysis,
      },
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      alreadyGenerated: false,
      payload: {
        monthKey: analysisMonth,
        generatedAt: null,
        periodStart: params.startDate,
        periodEnd: params.endDate,
        status: "failed" as const,
        canGenerate: false,
        unavailableReason: "OpenAI is not configured on this environment.",
        overviewData: null,
        analysis: null,
      },
    };
  }

  const { siteUrl, overview, technicalFindings } = await buildSeoMonthlyAnalysisInputs({
    businessId: params.businessId,
    startDate: params.startDate,
    endDate: params.endDate,
  });

  const siteContext = await resolveSeoPromptSiteContext({
    businessId: params.businessId,
    siteUrl,
    allPages: overview.leaders.pages,
    allMoverPages: overview.movers.decliningPages,
  });

  let ga4Data: string | null = null;
  try {
    const ga4Overview = await getAnalyticsOverviewData({
      businessId: params.businessId,
      startDate: params.startDate,
      endDate: params.endDate,
    });
    ga4Data = buildGa4DataString({
      overview: ga4Overview,
      landingPages: null,
    });
  } catch {
    ga4Data = null;
  }

  try {
    const analysis = await buildAiAnalysis({
      siteUrl,
      siteContext,
      gscData: buildGscDataString({
        siteUrl,
        summary: overview.summary,
        leaders: overview.leaders,
        movers: overview.movers,
        causes: overview.causes,
        recommendations: overview.recommendations,
      }),
      crawlData: buildCrawlDataString(technicalFindings),
      ga4Data,
      summary: overview.summary,
      allPages: [...overview.leaders.pages, ...overview.movers.decliningPages, ...overview.movers.improvingPages],
      causes: [
        ...overview.causes,
        ...buildTechnicalCauseCandidates(technicalFindings),
      ].slice(0, 6),
      recommendations: overview.recommendations,
      decliningQueries: overview.movers.decliningQueries,
      decliningPages: overview.movers.decliningPages,
    });

    if (analysis.source !== "ai") {
      throw new Error(analysis.unavailableReason ?? "AI analysis was not generated.");
    }

    const stored = await saveSeoMonthlyAiAnalysisSuccess({
      businessId: params.businessId,
      analysisMonth,
      periodStart: params.startDate,
      periodEnd: params.endDate,
      analysis,
      rawResponse: {
        technicalSummary: technicalFindings.summary,
        excludedCount: technicalFindings.confirmedExcludedPages.length,
      },
    });

    return {
      alreadyGenerated: false,
      payload: {
        monthKey: analysisMonth,
        generatedAt: stored.updated_at,
        periodStart: stored.period_start,
        periodEnd: stored.period_end,
        status: "available" as const,
        canGenerate: false,
        overviewData: buildOverviewWorkspace({ siteUrl, overview }),
        analysis,
      } satisfies SeoMonthlyAiAnalysisResponse,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "SEO AI analysis failed.";
    const stored = await saveSeoMonthlyAiAnalysisFailure({
      businessId: params.businessId,
      analysisMonth,
      periodStart: params.startDate,
      periodEnd: params.endDate,
      errorMessage: message,
    });

    return {
      alreadyGenerated: false,
      payload: {
        monthKey: analysisMonth,
        generatedAt: stored.updated_at,
        periodStart: stored.period_start,
        periodEnd: stored.period_end,
        status: "failed" as const,
        canGenerate: false,
        unavailableReason: message,
        overviewData: null,
        analysis: null,
      } satisfies SeoMonthlyAiAnalysisResponse,
    };
  }
}

function buildTechnicalCauseCandidates(findings: SeoTechnicalFindingsPayload) {
  if (!findings.summary.critical && !findings.summary.warning) return [];

  const candidates = [];
  if (findings.confirmedExcludedPages.length) {
    candidates.push({
      key: "inspection-exclusion",
      title: "Confirmed indexation exclusions are affecting priority URLs",
      explanation:
        "Search Console URL Inspection is already confirming excluded or blocked URLs, which is a stronger root-cause signal than generic visibility loss.",
      confidence: "high" as const,
      severity: "high" as const,
    });
  }

  if (findings.summary.critical > 0) {
    candidates.push({
      key: "technical-criticals",
      title: "Critical technical issues are likely amplifying the drop",
      explanation:
        "Critical crawl or indexation findings suggest the site is losing visibility due to technical blockers, not only ranking pressure.",
      confidence: "high" as const,
      severity: "high" as const,
    });
  }

  if (findings.summary.warning > 0) {
    candidates.push({
      key: "technical-warnings",
      title: "Template-level technical quality is weakening performance",
      explanation:
        "Warnings across metadata, canonical, or content structure can reduce organic efficiency even when pages remain indexed.",
      confidence: "medium" as const,
      severity: "medium" as const,
    });
  }

  return candidates;
}

export function getSeoMonthlyLabel(monthKey: string) {
  return toMonthLabel(monthKey);
}
