import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { readMetaIntelligence } from "@/lib/zero-base/meta/intelligence-server";
import { IntelligenceView } from "@/components/zero-base/meta/intelligence/intelligence-view";

export const dynamic = "force-dynamic";

/** Same 28-day window every windowed source is scoped to. */
function defaultWindow(now: Date): { startDate: string; endDate: string } {
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 27);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

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

  const { startDate, endDate } = defaultWindow(new Date());
  const intelligence = await readMetaIntelligence({ businessId, startDate, endDate }).catch(
    (error: unknown) => ({
      providerAccountId: null,
      sections: [],
      unavailableReason:
        error instanceof Error
          ? error.message
          : "Account intelligence could not be composed for this business.",
    }),
  );

  return (
    <IntelligenceView
      sources={intelligence.sections.map((item) => ({
        key: item.key,
        label: item.label,
        state: item.state,
        reason: item.reason,
        observedAt: item.observedAt,
        facts: item.facts,
      }))}
      unavailableReason={intelligence.unavailableReason}
      window={{ startDate, endDate }}
    />
  );
}
