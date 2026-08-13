import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { readHomePageModel } from "@/lib/zero-base/home/home-server";
import { HomeView } from "@/components/zero-base/home/home-view";
import type { RangePreset } from "@/components/date-range/DateRangePicker";
import { getBusinessTimezone } from "@/lib/account-store";
import { getTodayIsoForTimeZoneServer } from "@/lib/provider-platform-date";

export const dynamic = "force-dynamic";

/**
 * Client Home.
 *
 * The layout has already authorized this business; this reads and composes.
 * The legacy `/overview` body is deliberately not mounted — the contract, not
 * the old markup, is what makes the numbers honest.
 */
export default async function ClientHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;
  const query = await searchParams;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/home`));

  // Re-authorized here as well as in the layout: a page is its own boundary.
  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const allowedRanges = new Set<RangePreset>([
    "today", "yesterday", "3d", "7d", "14d", "28d", "30d", "90d", "365d", "thisMonth", "lastMonth", "custom",
  ]);
  const requestedRange = typeof query.range === "string" ? query.range : "30d";
  const rangePreset = allowedRanges.has(requestedRange as RangePreset)
    ? requestedRange as RangePreset
    : "30d";
  const isIsoDate = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timeZone = (await getBusinessTimezone(businessId).catch(() => null)) ?? "UTC";
  const referenceDate = getTodayIsoForTimeZoneServer(timeZone);
  const customStart = isIsoDate(query.startDate) ? query.startDate : "";
  const customEnd = isIsoDate(query.endDate) ? query.endDate : "";
  const fallbackEnd = new Date(`${referenceDate}T00:00:00.000Z`);
  const fallbackStart = new Date(fallbackEnd);
  fallbackStart.setUTCDate(fallbackStart.getUTCDate() - 29);
  const resolvedRange = customStart && customEnd && customStart <= customEnd
    ? { start: customStart, end: customEnd }
    : { start: fallbackStart.toISOString().slice(0, 10), end: referenceDate };
  const model = await readHomePageModel({
    businessId,
    startDate: resolvedRange.start,
    endDate: resolvedRange.end,
  });

  return (
    <HomeView
      contract={model.contract}
      businessId={businessId}
      connectHref="/app/manage/integrations"
      trend={model.trend}
      economics={model.economics}
      dateRange={{
        rangePreset,
        customStart: resolvedRange.start,
        customEnd: resolvedRange.end,
        comparisonPreset: "none",
        comparisonStart: "",
        comparisonEnd: "",
      }}
      referenceDate={referenceDate}
      timeZone={timeZone}
    />
  );
}
