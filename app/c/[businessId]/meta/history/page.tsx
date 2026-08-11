import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { HistoryView } from "@/components/zero-base/meta/history/history-view";

export const dynamic = "force-dynamic";

export default async function MetaHistoryPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/meta/history`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  // History rows are read client-side from the existing /api/meta/history
  // endpoint in a later slice; the surface renders whatever it is given and
  // adds no provenance of its own.
  return <HistoryView rows={[]} />;
}
