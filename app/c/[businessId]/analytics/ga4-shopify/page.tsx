import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { AnalyticsSourceClient } from "@/components/zero-base/analytics/analytics-clients";

export const dynamic = "force-dynamic";

export default async function AnalyticsGa4ShopifyPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/analytics/ga4-shopify`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  return <AnalyticsSourceClient businessId={businessId} />;
}
