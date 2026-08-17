import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import LegacyOverviewPage from "@/app/(dashboard)/overview/legacy-page";
import { LegacyInteriorBridge } from "@/components/legacy/legacy-interior-bridge";

export const dynamic = "force-dynamic";

/**
 * Client Home — the Dashboard v2 Overview screen.
 *
 * The layout has already authorized this business; this page re-authorizes
 * because a page is its own boundary, and then mounts the one Overview body
 * the design defines. `/overview`, `/app/home` and `/c/{id}/home` therefore
 * render the same component, so the legacy and canonical families cannot show
 * two different front doors depending on which URL the operator arrived by.
 *
 * The window is not read from the URL here: the exact Overview owns its own
 * range through the shared persistent date-range preference, exactly as it
 * does on `/overview`. Reading `?range=` server-side would give this family a
 * second, divergent source for the same window.
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

  return (
    <LegacyInteriorBridge>
      <LegacyOverviewPage />
    </LegacyInteriorBridge>
  );
}
