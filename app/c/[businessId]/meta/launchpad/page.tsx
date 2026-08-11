import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { LaunchpadClient } from "@/components/zero-base/launchpad/launchpad-client";
import { isMutationUiEnabled } from "@/lib/zero-base/meta/mutation-ceremony";
import { defaultCreativeWindow, scopeFromSearchParams } from "@/lib/zero-base/creative/route-scope";

export const dynamic = "force-dynamic";

export default async function MetaLaunchpadPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/meta/launchpad`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const scope = scopeFromSearchParams(await searchParams, defaultCreativeWindow(new Date()));

  // Server-read, and it can only narrow: a reviewer or demo viewer never gets
  // the bulk control whatever the flag says.
  const mutationUiEnabled =
    isMutationUiEnabled() && !access.context.reviewerReadOnly && !access.context.demo;

  return (
    <LaunchpadClient
      businessId={businessId}
      providerAccountId={scope.providerAccountId}
      mutationUiEnabled={mutationUiEnabled}
    />
  );
}
