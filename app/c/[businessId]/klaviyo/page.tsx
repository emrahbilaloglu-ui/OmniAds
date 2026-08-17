import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { KlaviyoClient } from "@/components/klaviyo/klaviyo-client";

export const dynamic = "force-dynamic";

/**
 * Business-scoped twin of `/platforms/klaviyo`.
 *
 * The screen registry has always claimed `/c/{businessId}/klaviyo` and
 * `/app/klaviyo` as the canonical Klaviyo route family, but no page existed at
 * either address, so the rail's Klaviyo entry resolved to a 404 on the canonical
 * shell. Both now converge on the same exact component.
 */
export default async function KlaviyoBusinessPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/klaviyo`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  return <KlaviyoClient businessId={businessId} />;
}
