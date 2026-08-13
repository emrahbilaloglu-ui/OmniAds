import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import LegacyIntegrationsPage from "@/app/(dashboard)/integrations/legacy-page";
import { LegacyInteriorBridge } from "@/components/legacy/legacy-interior-bridge";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/manage`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  return (
    <LegacyInteriorBridge>
      <LegacyIntegrationsPage />
    </LegacyInteriorBridge>
  );
}
