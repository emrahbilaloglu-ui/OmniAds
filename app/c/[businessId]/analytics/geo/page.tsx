import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { GeoClient } from "@/components/zero-base/analytics/analytics-clients";
import { InsightsChrome } from "@/components/insights/InsightsChrome";

export const dynamic = "force-dynamic";

export default async function AnalyticsGeoPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/analytics/geo`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  // Outer chrome only. The AI-visibility body is untouched — another batch's.
  return (
    <InsightsChrome businessId={businessId} pathname={`/c/${businessId}/analytics/geo`}>
      <GeoClient businessId={businessId} />
    </InsightsChrome>
  );
}
