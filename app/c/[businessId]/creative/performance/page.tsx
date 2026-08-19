import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import {
  requestedProviderAccountFromSearchParams,
  windowFromSearchParams,
} from "@/lib/zero-base/creative/route-scope";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import LegacyCreativePerformancePage from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";

export const dynamic = "force-dynamic";

/**
 * Creative Studio — Assets.
 *
 * The window in the URL is parsed here, on the server, and handed to the body
 * as `serverDateWindow`, the same way this family's provider account reaches
 * the Decision Center body as `serverProviderAccountId`. Before that the route
 * parsed `?start`/`?end` and dropped the result on the floor, so a link naming
 * a window rendered whatever range happened to be in the operator's browser
 * storage and a reload could not reproduce what the link said.
 *
 * Absence stays absence: when the URL names no usable window this forwards
 * `null` rather than the 28 UTC days `defaultCreativeWindow` would mint, so the
 * shell's own range — resolved against the account's clock, which a server
 * default cannot be — remains the window and the shell date control keeps
 * meaning what it shows.
 */
export default async function CreativePerformancePage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/creative/performance`));

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
    <LegacyCreativePerformancePage
      businessId={businessId}
      providerAccountId={providerAccountId}
      serverDateWindow={serverDateWindow}
    />
  );
}
