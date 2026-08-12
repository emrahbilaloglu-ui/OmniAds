import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { readHomeContract } from "@/lib/zero-base/home/home-server";
import { HomeView } from "@/components/zero-base/home/home-view";

export const dynamic = "force-dynamic";

/**
 * Client Home.
 *
 * The layout has already authorized this business; this reads and composes.
 * The legacy `/overview` body is deliberately not mounted — the contract, not
 * the old markup, is what makes the numbers honest.
 */
export default async function ClientHomePage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/home`));

  // Re-authorized here as well as in the layout: a page is its own boundary.
  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const contract = await readHomeContract({ businessId });

  return (
    <HomeView
      contract={contract}
      scopeLine={access.context.demo ? "Demo business" : businessId}
    />
  );
}
