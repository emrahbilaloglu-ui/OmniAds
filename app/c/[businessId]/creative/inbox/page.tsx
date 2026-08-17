import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { defaultCreativeWindow, scopeFromSearchParams } from "@/lib/zero-base/creative/route-scope";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import LegacyCreativeInboxPage from "@/app/(dashboard)/platforms/meta/creative-inbox/legacy-page";

export const dynamic = "force-dynamic";

export default async function CreativeInboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/creative/inbox`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const scope = scopeFromSearchParams(await searchParams, defaultCreativeWindow(new Date()));
  const providerAccountId = await resolveProviderAccountId({ businessId, provider: "meta", requestedAccountId: scope.providerAccountId });

  return (
    <LegacyCreativeInboxPage
      businessId={businessId}
      providerAccountId={providerAccountId}
    />
  );
}
