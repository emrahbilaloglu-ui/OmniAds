import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import LegacySettingsPage from "@/app/(dashboard)/settings/legacy-page";
import { LegacyInteriorBridge } from "@/components/legacy/legacy-interior-bridge";

export const dynamic = "force-dynamic";

/**
 * Settings — one screen in every route family.
 *
 * `lib/dashboard-v2/screen-registry.ts` binds both `/settings` and
 * `/app/manage/plan` to the `settings` screen, so this leaf mounts the same
 * exact body the legacy path does. It previously rendered a zero-base plan
 * ledger, which meant switching `ZERO_BASE_UI_MODE` on silently replaced the
 * design's Settings screen with a different surface.
 *
 * The plan band the ledger used to own is part of `SettingsExact`; it reads
 * `/api/billing` for the same workspace, so nothing about plan visibility is
 * lost by converging here.
 */
export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/manage`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  return (
    <LegacyInteriorBridge>
      <LegacySettingsPage />
    </LegacyInteriorBridge>
  );
}
