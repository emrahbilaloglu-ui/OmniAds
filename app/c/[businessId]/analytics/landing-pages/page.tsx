import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { InsightsAnalyticsScreen } from "@/components/analytics/InsightsAnalyticsScreen";
import { InsightsChrome } from "@/components/insights/InsightsChrome";

export const dynamic = "force-dynamic";

/**
 * Contract leaf L-C-AN-LP. The design has no separate landing-pages screen —
 * it is the third sub-tab of Analytics — so this route opens the same exact
 * screen pinned to that tab rather than drawing a second, different table.
 */
export default async function AnalyticsLandingPagesPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/analytics/landing-pages`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  return (
    <InsightsChrome
      businessId={businessId}
      pathname={`/c/${businessId}/analytics/landing-pages`}
    >
      <InsightsAnalyticsScreen businessId={businessId} initialTab="landing" />
    </InsightsChrome>
  );
}
