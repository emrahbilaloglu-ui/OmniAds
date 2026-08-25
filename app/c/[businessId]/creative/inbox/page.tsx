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
import LegacyCreativeInboxPage from "@/app/(dashboard)/platforms/meta/creative-inbox/legacy-page";

export const dynamic = "force-dynamic";

/**
 * Creative Studio — Inbox.
 *
 * The inbox read itself is not windowed — `/api/creatives/inbox` is asked for a
 * business and an account and nothing else — so the forwarded window is not a
 * filter here and is not presented as one. It is forwarded because this surface
 * is a waypoint: its Studio tab links used to be built with `start: ""` and
 * `end: ""`, so walking Assets → Inbox → Copies silently discarded the window
 * the operator arrived with. Carrying the link's own window through keeps the
 * range intact across the walk instead of resetting it in the middle.
 */
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
    surfaceId: "creative-inbox",
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
    <MetaSurfaceStateLive initial={readState} surfaceId="creative-inbox" />
    <LegacyCreativeInboxPage
      businessId={businessId}
      providerAccountId={providerAccountId}
      serverDateWindow={serverDateWindow}
    />
    </>
  );
}
