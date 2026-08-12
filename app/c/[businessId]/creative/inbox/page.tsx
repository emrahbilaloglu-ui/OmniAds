import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { CreativeInboxClient } from "@/components/zero-base/creative/studio-clients";
import { defaultCreativeWindow, scopeFromSearchParams } from "@/lib/zero-base/creative/route-scope";

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

  return (
    <CreativeInboxClient
      businessId={businessId}
      providerAccountId={scope.providerAccountId}
      start={scope.start}
      end={scope.end}
    />
  );
}
