import { notFound, redirect } from "next/navigation";

import MetaAutomationPage from "@/app/(dashboard)/platforms/meta/automation/automation-view";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { getSessionFromCookies } from "@/lib/auth";
import { getMetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined) {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return null;
}

export default async function MetaAutomationRoute({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/meta/automation`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const raw = (await searchParams) ?? {};
  const providerAccountId = await resolveProviderAccountId({
    businessId,
    provider: "meta",
    requestedAccountId: first(raw.providerAccountId),
  });
  const control = await getMetaAutomationControlPlane({
    businessId,
    providerAccountId,
  }).catch(() => null);

  // When several assigned accounts require an explicit choice, the business
  // control remains readable but account-owned provider action rows do not.
  // This prevents a missing selection from becoming an implicit all-account
  // activity scope while preserving real business-wide control ledger rows.
  const scopedControl =
    control && !providerAccountId
      ? {
          ...control,
          activityLedger: control.activityLedger.filter(
            (item) => item.source === "automation_ledger",
          ),
        }
      : control;

  return (
    <MetaAutomationPage
      businessId={businessId}
      providerAccountId={providerAccountId}
      initialPayload={scopedControl}
    />
  );
}
