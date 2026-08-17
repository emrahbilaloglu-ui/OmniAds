import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import LegacyCommercialTruthPage from "@/app/(dashboard)/commercial-truth/legacy-page";
import { LegacyInteriorBridge } from "@/components/legacy/legacy-interior-bridge";

export const dynamic = "force-dynamic";

/**
 * Commercial Truth — one screen in every route family.
 *
 * `/commercial-truth` redirects here (`lib/zero-base/generated-contracts.ts`),
 * and `lib/dashboard-v2/screen-registry.ts` binds both spellings to the same
 * `commercial-truth` screen, so this leaf mounts the same exact body. It used
 * to render a zero-base business ledger that embedded Commercial Truth as a
 * headerless fragment underneath a cost-model form, an economics grid, a
 * recommended-mode block and a delete ceremony — five sections the design does
 * not draw on this screen. The screen owns its own header again, which is what
 * the design specifies.
 *
 * Nothing removed here is the only way to perform its action: the target
 * pack's cost structure and the monthly fixed base are editable on the screen
 * itself, and deleting a workspace lives on `/select-business`, which is an
 * alias route and therefore unaffected by the rollout mode.
 */
export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/manage`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  return (
    <LegacyInteriorBridge>
      <LegacyCommercialTruthPage />
    </LegacyInteriorBridge>
  );
}
