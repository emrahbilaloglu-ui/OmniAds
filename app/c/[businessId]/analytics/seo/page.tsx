import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { SeoClient } from "@/components/zero-base/analytics/analytics-clients";
import { InsightsChrome } from "@/components/insights/InsightsChrome";

export const dynamic = "force-dynamic";

export default async function AnalyticsSeoPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/analytics/seo`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  // Outer chrome only. The SEO body is untouched — it is another batch's.
  return (
    <InsightsChrome businessId={businessId} pathname={`/c/${businessId}/analytics/seo`}>
      <SeoClient businessId={businessId} role={access.context.role} />
    </InsightsChrome>
  );
}
