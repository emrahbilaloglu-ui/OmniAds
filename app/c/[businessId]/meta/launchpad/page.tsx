import { notFound, redirect } from "next/navigation";

import { listUserBusinesses } from "@/lib/access";
import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import LegacyMetaLaunchpadPage from "@/app/(dashboard)/platforms/meta/launchpad/legacy-page";

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

  const raw = (await searchParams) ?? {};
  const requestedProviderAccountId = Array.isArray(raw.providerAccountId)
    ? raw.providerAccountId[0]
    : raw.providerAccountId;
  const [providerAccountId, businesses] = await Promise.all([
    resolveProviderAccountId({
      businessId,
      provider: "meta",
      requestedAccountId: requestedProviderAccountId,
    }),
    listUserBusinesses(access.context.session.user.id),
  ]);
  const business = businesses.find((item) => item.id === businessId) ?? null;

  return (
    <LegacyMetaLaunchpadPage
      businessId={businessId}
      businessName={business?.name ?? null}
      providerAccountId={providerAccountId}
    />
  );
}
