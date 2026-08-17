import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { GooglePlanClient } from "@/components/zero-base/google/plan-client";
import {
  readProviderScopeCatalog,
  resolveProviderAccountId,
} from "@/lib/zero-base/provider-scope-server";

export const dynamic = "force-dynamic";

export default async function GooglePlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/google/plan`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const raw = (await searchParams) ?? {};
  const requestedProviderAccountId = Array.isArray(raw.providerAccountId)
    ? raw.providerAccountId[0]?.trim() || null
    : raw.providerAccountId?.trim() || null;
  const catalog = await readProviderScopeCatalog(businessId, "google");
  const providerAccountId = await resolveProviderAccountId({
    businessId,
    provider: "google",
    requestedAccountId: requestedProviderAccountId,
    catalog,
  });
  if (requestedProviderAccountId && !providerAccountId) notFound();
  const account =
    catalog.accounts.find((candidate) => candidate.id === providerAccountId) ?? null;

  return (
    <GooglePlanClient
      businessId={businessId}
      authorizedAccount={
        account
          ? {
              id: account.id,
              name: account.label,
              currency: account.currency,
              timezone: account.timezone,
            }
          : null
      }
    />
  );
}
