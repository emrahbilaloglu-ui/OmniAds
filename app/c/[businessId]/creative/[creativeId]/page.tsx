import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { CreativeDetailClient } from "@/components/zero-base/creative/detail-client";
import { defaultCreativeWindow, scopeFromSearchParams } from "@/lib/zero-base/creative/route-scope";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";

export const dynamic = "force-dynamic";

/**
 * Creative detail (H22/H23).
 *
 * The business comes from the path and is authorized here. The account also
 * comes from the URL and is passed down so the client can prove the creative
 * belongs to it — a creative id on its own carries no ownership.
 */
export default async function CreativeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string; creativeId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId, creativeId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/creative/${creativeId}`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const scope = scopeFromSearchParams(await searchParams, defaultCreativeWindow(new Date()));
  const providerAccountId = await resolveProviderAccountId({ businessId, provider: "meta", requestedAccountId: scope.providerAccountId });

  return (
    <CreativeDetailClient
      businessId={businessId}
      creativeId={creativeId}
      providerAccountId={providerAccountId}
      start={scope.start}
      end={scope.end}
    />
  );
}
