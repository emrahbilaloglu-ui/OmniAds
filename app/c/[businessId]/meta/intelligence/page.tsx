import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { getIntegrationStatusByBusiness } from "@/lib/integration-status";
import { IntelligenceView } from "@/components/zero-base/meta/intelligence/intelligence-view";

export const dynamic = "force-dynamic";

export default async function MetaIntelligencePage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/meta/intelligence`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const integrations = await getIntegrationStatusByBusiness(businessId).catch(() => null);

  if (!integrations) {
    return <IntelligenceView sources={[]} unavailableReason="Integration status could not be read for this business." />;
  }

  return (
    <IntelligenceView
      sources={[
        {
          key: "meta",
          label: "Meta Ads",
          state: integrations.meta ? "serving" : "unavailable",
          reason: integrations.meta ? null : "Meta is not connected for this business.",
          observedAt: null,
        },
      ]}
    />
  );
}
