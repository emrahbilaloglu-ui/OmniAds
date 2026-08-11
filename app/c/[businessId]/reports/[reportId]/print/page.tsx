import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { ReportViewerClient } from "@/components/zero-base/reports/report-clients";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ businessId: string; reportId: string }> }) {
  const { businessId, reportId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/reports`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  return <ReportViewerClient businessId={businessId} reportId={reportId} print />;
}
