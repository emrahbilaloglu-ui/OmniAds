import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import {
  requestedProviderAccountFromSearchParams,
  windowFromSearchParams,
} from "@/lib/zero-base/creative/route-scope";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import LegacyCreativeLandingPagesPage from "@/app/(dashboard)/platforms/meta/landing-pages/legacy-page";

export const dynamic = "force-dynamic";

/**
 * Creative Studio — Landers.
 *
 * `?start`/`?end` are parsed here and forwarded as `serverDateWindow`, so the
 * destinations read this surface runs is the window the link names. The route
 * previously parsed the pair and passed only the account, which made every
 * lander deep link a link to "whatever range this browser last stored".
 *
 * No window in the URL means no window forwarded; the shell's range keeps the
 * surface, rather than a server-side 28 UTC days silently replacing it.
 */
export default async function CreativeLandingPagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/creative/landing-pages`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const raw = await searchParams;
  const providerAccountId = await resolveProviderAccountId({
    businessId,
    provider: "meta",
    requestedAccountId: requestedProviderAccountFromSearchParams(raw),
  });
  const serverDateWindow = windowFromSearchParams(raw);

  return (
    <LegacyCreativeLandingPagesPage
      businessId={businessId}
      providerAccountId={providerAccountId}
      serverDateWindow={serverDateWindow}
    />
  );
}
