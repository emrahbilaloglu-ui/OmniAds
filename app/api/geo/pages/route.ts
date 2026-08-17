import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import { getDemoGeoPages } from "@/lib/demo-business";
import {
  getGA4TokenAndProperty,
  runGA4Report,
  GA4AuthError,
} from "@/lib/google-analytics-reporting";
import { GA4_AI_SOURCE_FILTER, classifyAiSource } from "@/lib/geo-intelligence";
import {
  scorePageGeo,
  scoreAiTrafficValue,
  scorePageReadiness,
  assignPriority,
  assignEffort,
  assignConfidence,
} from "@/lib/geo-scoring";
import { computeMomentum, computePreviousPeriod } from "@/lib/geo-momentum";
import { resolveRequestLanguage } from "@/lib/request-language";

export async function GET(request: NextRequest) {
  const language = await resolveRequestLanguage(request);
  const businessId = request.nextUrl.searchParams.get("businessId");
  const startDate =
    request.nextUrl.searchParams.get("startDate") ?? "30daysAgo";
  const endDate = request.nextUrl.searchParams.get("endDate") ?? "yesterday";

  if (!businessId) {
    return NextResponse.json({ error: "missing_business_id" }, { status: 400 });
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "collaborator" });
  if ("error" in access) return access.error;
  if (await isDemoBusiness(businessId)) {
    return NextResponse.json(getDemoGeoPages());
  }

  let accessToken: string;
  let propertyId: string;
  try {
    ({ accessToken, propertyId } = await getGA4TokenAndProperty(businessId));
  } catch (err) {
    if (err instanceof GA4AuthError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.code === "integration_not_found" ? 404 : 401 }
      );
    }
    throw err;
  }

  const { prevStart, prevEnd } = computePreviousPeriod(startDate, endDate);

  const [aiPagesReport, totalPagesReport, prevAiPagesReport, aiPageSourceReport] =
    await Promise.all([
    // Current: AI-origin traffic by landing page
    runGA4Report({
      propertyId, accessToken,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "landingPage" }],
      metrics: [
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "engagementRate" },
        { name: "ecommercePurchases" },
        { name: "purchaseRevenue" },
      ],
      dimensionFilter: GA4_AI_SOURCE_FILTER,
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 100,
    }),
    // All traffic (for total sessions + site avg CVR)
    runGA4Report({
      propertyId, accessToken,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "landingPage" }],
      metrics: [{ name: "sessions" }, { name: "ecommercePurchases" }, { name: "engagementRate" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 100,
    }),
    // Previous period: AI-origin traffic (for momentum)
    runGA4Report({
      propertyId, accessToken,
      dateRanges: [{ startDate: prevStart, endDate: prevEnd }],
      dimensions: [{ name: "landingPage" }],
      metrics: [{ name: "sessions" }],
      dimensionFilter: GA4_AI_SOURCE_FILTER,
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 100,
    }),
    // Current: AI-origin sessions by landing page AND engine, so each row can
    // name the engines that referred it (the design's "Sourced by" column).
    runGA4Report({
      propertyId, accessToken,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "landingPage" }, { name: "sessionSource" }],
      metrics: [{ name: "sessions" }],
      dimensionFilter: GA4_AI_SOURCE_FILTER,
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 500,
    }),
  ]);

  // Engines per landing page, strongest first — duplicate engines (one per
  // referring domain) collapse to a single name.
  const sourcedByMap = new Map<string, Map<string, number>>();
  for (const row of aiPageSourceReport.rows) {
    const path = row.dimensions[0] ?? "/";
    const engine = classifyAiSource(row.dimensions[1] ?? "");
    if (!engine) continue;
    const sessions = parseFloat(row.metrics[0] ?? "0");
    const engines = sourcedByMap.get(path) ?? new Map<string, number>();
    engines.set(engine, (engines.get(engine) ?? 0) + sessions);
    sourcedByMap.set(path, engines);
  }

  // Build lookup maps
  const totalSessionsMap = new Map<string, number>();
  const siteEngMap = new Map<string, number>();
  for (const row of totalPagesReport.rows) {
    totalSessionsMap.set(row.dimensions[0], parseFloat(row.metrics[0] ?? "0"));
    siteEngMap.set(row.dimensions[0], parseFloat(row.metrics[2] ?? "0"));
  }

  const prevAiSessionsMap = new Map<string, number>();
  for (const row of prevAiPagesReport.rows) {
    prevAiSessionsMap.set(row.dimensions[0], parseFloat(row.metrics[0] ?? "0"));
  }

  // Site averages
  const totalSiteSessions = totalPagesReport.rows.reduce(
    (s, r) => s + parseFloat(r.metrics[0] ?? "0"), 0
  );
  const totalSitePurchases = totalPagesReport.rows.reduce(
    (s, r) => s + parseFloat(r.metrics[1] ?? "0"), 0
  );
  const siteAvgCvr = totalSiteSessions > 0 ? totalSitePurchases / totalSiteSessions : 0;
  const siteAvgEngagement = totalSiteSessions > 0
    ? totalPagesReport.rows.reduce((s, r) => s + parseFloat(r.metrics[2] ?? "0") * parseFloat(r.metrics[0] ?? "0"), 0) / totalSiteSessions
    : 0;

  const pages = aiPagesReport.rows.map((row) => {
    const path = row.dimensions[0] ?? "/";
    const aiSessions = parseFloat(row.metrics[0] ?? "0");
    const engagedSessions = parseFloat(row.metrics[1] ?? "0");
    const engagementRate = parseFloat(row.metrics[2] ?? "0");
    const purchases = parseFloat(row.metrics[3] ?? "0");
    const revenue = parseFloat(row.metrics[4] ?? "0");
    const totalSessions = totalSessionsMap.get(path) ?? 0;
    const purchaseCvr = aiSessions > 0 ? purchases / aiSessions : 0;

    // GEO score with breakdown
    const geoScored = scorePageGeo({
      aiSessions, totalSessions, aiEngagementRate: engagementRate, aiPurchaseCvr: purchaseCvr,
    });
    const geoScore = geoScored.total;

    // AI traffic value score
    const valueScored = scoreAiTrafficValue({
      sessions: aiSessions,
      engagementRate,
      purchaseCvr,
      revenue,
      siteAvgEngagementRate: siteAvgEngagement,
      siteAvgPurchaseCvr: siteAvgCvr,
    });

    // Page readiness score (heuristic — GA4-only, SC enrichment not available here)
    const readinessScored = scorePageReadiness({
      path,
      aiEngagementRate: engagementRate,
    });

    // Momentum
    const prevAiSessions = prevAiSessionsMap.get(path) ?? 0;
    const momentum = computeMomentum(aiSessions, prevAiSessions, 3);

    const priority = assignPriority(geoScore, aiSessions, purchaseCvr - siteAvgCvr);
    const effort = assignEffort(purchaseCvr < siteAvgCvr * 0.5 ? "add_faq" : "expand_guide");
    const confidence = assignConfidence(true, false, Math.round(aiSessions));

    // Strongest signal
    let strongestSignal: string;
    if (momentum.status === "breakout") strongestSignal = language === "tr" ? "Patlayan büyüme" : "Breakout growth";
    else if (purchaseCvr >= 0.03) strongestSignal = language === "tr" ? "Güçlü AI CVR" : "Strong AI CVR";
    else if (engagementRate >= 0.7) strongestSignal = language === "tr" ? "Yüksek engagement" : "High engagement";
    else if (aiSessions >= 50) strongestSignal = language === "tr" ? "Yüksek AI trafiği" : "High AI traffic";
    else strongestSignal = language === "tr" ? "Yukselen AI sayfası" : "Emerging AI page";

    // Recommendation — more targeted with readiness + value context
    let recommendation: string | null = null;
    if (readinessScored.score < 30 && aiSessions > 10)
      recommendation = language === "tr" ? "Hazirlik düşük — FAQ / answer-first yapı ekleyin" : "Low readiness — add FAQ / answer-first structure";
    else if (engagementRate < 0.4 && aiSessions > 20)
      recommendation = language === "tr" ? "Engagement zayıf — answer intent için yeniden yapılandırın" : "Poor engagement — restructure for answer intent";
    else if (purchaseCvr < 0.01 && aiSessions > 30)
      recommendation = language === "tr" ? "Conversion düşük — ticari CTA'lar veya comparison table ekleyin" : "Low conversion — add commercial CTAs or comparison table";
    else if (valueScored.label === "elite" || valueScored.label === "strong")
      recommendation = language === "tr" ? "Yüksek degerli AI kanali — içerik stratejisini burada ölçekle" : "High-value AI channel — scale content strategy here";
    else if (engagementRate >= 0.7)
      recommendation = language === "tr" ? "Güçlü engagement — konu derinligini genişlet" : "Strong engagement — expand topic depth";

    return {
      path,
      sourcedBy: Array.from(sourcedByMap.get(path)?.entries() ?? [])
        .sort((a, b) => b[1] - a[1])
        .map(([engine]) => engine),
      aiSessions,
      engagedSessions,
      engagementRate,
      purchases,
      revenue,
      purchaseCvr,
      totalSessions,
      // GEO score + breakdown
      geoScore,
      geoScoreBreakdown: geoScored.components,
      // AI traffic value
      aiTrafficValueScore: valueScored.score,
      aiTrafficValueLabel: valueScored.label,
      // Page readiness
      pageReadinessScore: readinessScored.score,
      pageReadinessLabel: readinessScored.label,
      readinessBreakdown: readinessScored.breakdown,
      // Momentum
      momentum: {
        status: momentum.status,
        label: momentum.label,
        score: momentum.score,
        growthRate: momentum.growthRate,
      },
      priority,
      effort,
      confidence,
      strongestSignal,
      recommendation,
    };
  });

  // Sort: breakout/rising pages bumped up, then geoScore
  pages.sort((a, b) => {
    const aMomentumBoost = a.momentum.status === "breakout" ? 15 : a.momentum.status === "rising" ? 7 : 0;
    const bMomentumBoost = b.momentum.status === "breakout" ? 15 : b.momentum.status === "rising" ? 7 : 0;
    return (b.geoScore + bMomentumBoost) - (a.geoScore + aMomentumBoost);
  });

  return NextResponse.json({ pages });
}
