import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { IntegrationsClient } from "@/components/zero-base/manage/manage-clients";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/manage`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  return <IntegrationsClient businessId={businessId} role={access.context.role} />;
}
