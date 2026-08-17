import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { InsightsGeoScreen } from "@/components/geo/InsightsGeoScreen";
import { InsightsChrome } from "@/components/insights/InsightsChrome";

export const dynamic = "force-dynamic";

/**
 * The canonical twin of `/insights/ai-visibility`.
 *
 * Both route families mount the same exact screen; only the authorization in
 * front of it differs, and that stays server-side.
 */
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

  return (
    <InsightsChrome businessId={businessId} pathname={`/c/${businessId}/analytics/geo`}>
      <InsightsGeoScreen businessId={businessId} />
    </InsightsChrome>
  );
}
