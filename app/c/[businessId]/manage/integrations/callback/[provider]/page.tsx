import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";

export const dynamic = "force-dynamic";

/**
 * OAuth landing for a provider reconnect.
 *
 * This page performs no exchange of its own — the provider callback routes own
 * that. It authorizes the business, then returns the operator to Integrations,
 * where the connection state is read fresh rather than assumed from the
 * redirect having happened.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ businessId: string; provider: string }>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/manage/integrations`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  redirect(`/c/${businessId}/manage/integrations`);
}
