import { notFound, redirect } from "next/navigation";

import { GoogleWorkspaceScreen } from "@/components/google-ads/GoogleWorkspaceScreen";
import { listUserBusinesses } from "@/lib/access";
import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import {
  readProviderScopeCatalog,
  resolveProviderAccountId,
} from "@/lib/zero-base/provider-scope-server";

export const dynamic = "force-dynamic";

export default async function GoogleOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/google/overview`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const raw = (await searchParams) ?? {};
  const requestedProviderAccountId = Array.isArray(raw.providerAccountId)
    ? raw.providerAccountId[0]?.trim() || null
    : raw.providerAccountId?.trim() || null;
  const [catalog, businesses] = await Promise.all([
    readProviderScopeCatalog(businessId, "google"),
    listUserBusinesses(access.context.session.user.id),
  ]);
  const providerAccountId = await resolveProviderAccountId({
    businessId,
    provider: "google",
    requestedAccountId: requestedProviderAccountId,
    catalog,
  });

  // A URL-selected account that is not assigned is a foreign scope, not an
  // invitation to fall back to the first account. Keep the response
  // indistinguishable from any other out-of-scope business resource.
  if (requestedProviderAccountId && !providerAccountId) notFound();

  const account =
    catalog.accounts.find((candidate) => candidate.id === providerAccountId) ??
    null;
  const business = businesses.find((candidate) => candidate.id === businessId) ?? null;

  return (
    <GoogleWorkspaceScreen
      panel="summary"
      title="Overview"
      authorizedScope={{
        businessId,
        businessName: business?.name ?? null,
        providerAccountId,
        accountLabel: account?.label ?? null,
        currency: account?.currency ?? null,
        timezone: account?.timezone ?? null,
        viewerReadOnly:
          access.context.role === "guest" ||
          access.context.reviewerReadOnly ||
          access.context.demo,
        demo: access.context.demo,
      }}
    />
  );
}
