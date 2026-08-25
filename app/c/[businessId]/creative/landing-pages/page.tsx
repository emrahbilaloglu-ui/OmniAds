import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import {
  requestedProviderAccountFromSearchParams,
  windowFromSearchParams,
} from "@/lib/zero-base/creative/route-scope";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import { MetaSurfaceStateLive } from "@/components/meta/meta-surface-state-live";
import { resolveMetaPageSurfaceState } from "@/lib/meta/surface-read-state-server";
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

  /**
   * The §9 envelope for this tab.
   *
   * WP6 wired the six hub surfaces and stopped there, so the four Studio tabs
   * and its two sub-surfaces had no read state at all: an unscoped Copies and
   * an account with no copies rendered the same empty table, which is the
   * distinction §9 exists to keep. Each tab is separately account-scoped and
   * separately refusable, so each one resolves and states its own.
   */
  const readState = await resolveMetaPageSurfaceState({
    surfaceId: "creative-landing-pages",
    businessId,
    requestedAccountId: requestedProviderAccountFromSearchParams(raw),
    permissions: {
      role: access.context.role,
      reviewerReadOnly: access.context.reviewerReadOnly,
      demo: access.context.demo,
    },
    evidence: serverDateWindow
      ? { window: { startDate: serverDateWindow.start, endDate: serverDateWindow.end } }
      : undefined,
  });

  return (
    <>
    <MetaSurfaceStateLive initial={readState} surfaceId="creative-landing-pages" />
    <LegacyCreativeLandingPagesPage
      businessId={businessId}
      providerAccountId={providerAccountId}
      serverDateWindow={serverDateWindow}
    />
    </>
  );
}
