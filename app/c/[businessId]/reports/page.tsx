import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import LegacyReportsPage from "@/app/(dashboard)/reports/legacy-page";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/reports`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  return <LegacyReportsPage />;
}
