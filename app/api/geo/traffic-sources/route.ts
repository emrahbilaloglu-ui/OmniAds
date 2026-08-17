import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import { getDemoGeoTrafficSources } from "@/lib/demo-business";
import {
  getGA4TokenAndProperty,
  runGA4Report,
  GA4AuthError,
} from "@/lib/google-analytics-reporting";
import {
  GA4_AI_SOURCE_FILTER,
  classifyAiSource,
  type GeoEngine,
} from "@/lib/geo-intelligence";
import { scoreAiTrafficValue } from "@/lib/geo-scoring";
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
    return NextResponse.json(getDemoGeoTrafficSources());
  }

  let accessToken: string;
  let propertyId: string;
  // The unit the `purchaseRevenue` metric requested below is denominated in.
  let currencyCode: string | null;
  try {
    ({ accessToken, propertyId, currencyCode } =
      await getGA4TokenAndProperty(businessId));
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

  const [report, prevReport, totalReport] = await Promise.all([
    // Current: AI sources
    runGA4Report({
      propertyId, accessToken,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "sessionSource" }],
      metrics: [
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "engagementRate" },
        { name: "ecommercePurchases" },
        { name: "purchaseRevenue" },
      ],
      dimensionFilter: GA4_AI_SOURCE_FILTER,
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 50,
    }),
    // Previous period: for momentum
    runGA4Report({
      propertyId, accessToken,
      dateRanges: [{ startDate: prevStart, endDate: prevEnd }],
      dimensions: [{ name: "sessionSource" }],
      metrics: [{ name: "sessions" }],
      dimensionFilter: GA4_AI_SOURCE_FILTER,
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 50,
    }),
    // Site-wide totals for relative scoring
    runGA4Report({
      propertyId, accessToken,
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: "sessions" }, { name: "engagementRate" }, { name: "ecommercePurchases" }],
    }),
  ]);

  // Site averages
  const siteRow = totalReport.totals?.[0] ?? totalReport.rows[0];
  const siteTotalSessions = parseFloat(siteRow?.metrics[0] ?? "0");
  const siteAvgEngagementRate = parseFloat(siteRow?.metrics[1] ?? "0");
  const siteTotalPurchases = parseFloat(siteRow?.metrics[2] ?? "0");
  const siteAvgCvr = siteTotalSessions > 0 ? siteTotalPurchases / siteTotalSessions : 0;

  // Previous period map by engine
  const prevEngineMap = new Map<string, number>();
  for (const row of prevReport.rows) {
    const engine = classifyAiSource(row.dimensions[0]) ?? "Other AI";
    prevEngineMap.set(engine, (prevEngineMap.get(engine) ?? 0) + parseFloat(row.metrics[0] ?? "0"));
  }

  // Aggregate current by engine
  const engineMap = new Map<
    GeoEngine | "Other AI",
    { engine: string; sessions: number; engagedSessions: number; engagementRate: number; purchases: number; revenue: number; sources: string[] }
  >();

  for (const row of report.rows) {
    const source = row.dimensions[0];
    const engine = classifyAiSource(source) ?? "Other AI";
    const sessions = parseFloat(row.metrics[0] ?? "0");
    const engagedSessions = parseFloat(row.metrics[1] ?? "0");
    const engagementRate = parseFloat(row.metrics[2] ?? "0");
    const purchases = parseFloat(row.metrics[3] ?? "0");
    const revenue = parseFloat(row.metrics[4] ?? "0");

    const existing = engineMap.get(engine);
    if (existing) {
      const newSessions = existing.sessions + sessions;
      existing.engagementRate = (existing.engagementRate * existing.sessions + engagementRate * sessions) / Math.max(1, newSessions);
      existing.sessions = newSessions;
      existing.engagedSessions += engagedSessions;
      existing.purchases += purchases;
      existing.revenue += revenue;
      existing.sources.push(source);
    } else {
      engineMap.set(engine, { engine, sessions, engagedSessions, engagementRate, purchases, revenue, sources: [source] });
    }
  }

  const sources = Array.from(engineMap.values())
    .map((s) => {
      const purchaseCvr = s.sessions > 0 ? s.purchases / s.sessions : 0;

      // AI traffic value score
      const valueScored = scoreAiTrafficValue({
        sessions: s.sessions,
        engagementRate: s.engagementRate,
        purchaseCvr,
        revenue: s.revenue,
        siteAvgEngagementRate,
        siteAvgPurchaseCvr: siteAvgCvr,
      });

      // Momentum
      const prevSessions = prevEngineMap.get(s.engine) ?? 0;
      const momentum = computeMomentum(s.sessions, prevSessions, 3);

      // Targeted recommendation
      let recommendation: string | null = null;
      if (valueScored.label === "elite" || valueScored.label === "strong") {
        recommendation = language === "tr" ? "Yüksek degerli kanal — answer-first içerikle ölçekle" : "High-value channel — scale with answer-first content";
      } else if (momentum.status === "breakout") {
        recommendation = language === "tr" ? "Patlayan büyüme — bu motor için içeriğe öncelik ver" : "Breakout growth — prioritise content for this engine";
      } else if (momentum.status === "rising" && valueScored.label === "promising") {
        recommendation = language === "tr" ? "Yukseliyor — FAQ/guide formatina yatirim yap" : "Growing — invest in FAQ/guide format content";
      } else if (valueScored.label === "weak" && s.sessions > 20) {
        recommendation = language === "tr" ? "Bu motorun kullanıcılari için landing deneyimini iyileştir" : "Improve landing experience for this engine's users";
      }

      return {
        engine: s.engine,
        sessions: s.sessions,
        engagedSessions: s.engagedSessions,
        engagementRate: s.engagementRate,
        purchases: s.purchases,
        revenue: s.revenue,
        purchaseCvr,
        sources: s.sources,
        aiTrafficValueScore: valueScored.score,
        aiTrafficValueLabel: valueScored.label,
        momentum: {
          status: momentum.status,
          label: momentum.label,
          score: momentum.score,
          growthRate: momentum.growthRate,
        },
        recommendation,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);

  return NextResponse.json({ sources, currency: currencyCode });
}
