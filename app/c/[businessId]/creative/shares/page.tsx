import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { CreativeSharesClient } from "@/components/zero-base/creative/studio-clients";
import { defaultCreativeWindow, scopeFromSearchParams } from "@/lib/zero-base/creative/route-scope";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import { MetaSurfaceStateLive } from "@/components/meta/meta-surface-state-live";
import { resolveMetaPageSurfaceState } from "@/lib/meta/surface-read-state-server";
import { readMetaGateRefusal } from "@/lib/meta/release-gate-guard";

export const dynamic = "force-dynamic";

export default async function CreativeSharesPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/creative/shares`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const scope = scopeFromSearchParams(await searchParams, defaultCreativeWindow(new Date()));
  const providerAccountId = await resolveProviderAccountId({ businessId, provider: "meta", requestedAccountId: scope.providerAccountId });

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
    surfaceId: "creative-shares",
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
    <MetaSurfaceStateLive initial={readState} surfaceId="creative-shares" />
    <CreativeSharesClient
      businessId={businessId}
      providerAccountId={providerAccountId}
      start={scope.start}
      end={scope.end}
      shareMintRefusalReason={readMetaGateRefusal("publicShareMint")?.message ?? null}
    />
    </>
  );
}
