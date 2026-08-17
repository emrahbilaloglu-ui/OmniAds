import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import ReportsPage from "@/app/(dashboard)/reports/legacy-page";
import { LegacyInteriorBridge } from "@/components/legacy/legacy-interior-bridge";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;
  const rawTemplate = (await searchParams)?.template;
  const templateId = typeof rawTemplate === "string" ? rawTemplate : (rawTemplate?.[0] ?? null);

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/reports`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  return (
    <LegacyInteriorBridge>
      <ReportsPage initialTab="builder" initialTemplateId={templateId} />
    </LegacyInteriorBridge>
  );
}
