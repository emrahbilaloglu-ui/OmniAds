import { notFound, redirect } from "next/navigation";

import LegacyCreativeAudiencesPage from "@/app/(dashboard)/platforms/meta/audiences/legacy-page";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { getSessionFromCookies } from "@/lib/auth";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import {
  defaultCreativeWindow,
  scopeFromSearchParams,
} from "@/lib/zero-base/creative/route-scope";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import { MetaSurfaceStateLive } from "@/components/meta/meta-surface-state-live";
import { resolveMetaPageSurfaceState } from "@/lib/meta/surface-read-state-server";

export const dynamic = "force-dynamic";

export default async function CreativeAudiencesPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/creative/audiences`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const scope = scopeFromSearchParams(
    await searchParams,
    defaultCreativeWindow(new Date()),
  );
  const providerAccountId = await resolveProviderAccountId({
    businessId,
    provider: "meta",
    requestedAccountId: scope.providerAccountId,
  });

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
    surfaceId: "creative-audiences",
    businessId,
    requestedAccountId: scope.providerAccountId,
    permissions: {
      role: access.context.role,
      reviewerReadOnly: access.context.reviewerReadOnly,
      demo: access.context.demo,
    },
  });

  return (
    <>
    <MetaSurfaceStateLive initial={readState} surfaceId="creative-audiences" />
    <LegacyCreativeAudiencesPage
      businessId={businessId}
      providerAccountId={providerAccountId}
    />
    </>
  );
}
