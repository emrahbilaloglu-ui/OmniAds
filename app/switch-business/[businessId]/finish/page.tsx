import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { CompleteBusinessSwitch } from "./switch-business-completion";

export const dynamic = "force-dynamic";

export default async function SwitchBusinessFinishPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { businessId } = await params;
  const query = await searchParams;
  const requestedNext = Array.isArray(query.next) ? query.next[0] : query.next;
  const destination = sanitizeNextPath(requestedNext) ?? "/overview";
  const session = await getSessionFromCookies();
  if (!session) {
    const resume = `/switch-business/${encodeURIComponent(businessId)}/finish?next=${encodeURIComponent(destination)}`;
    redirect(`/login?next=${encodeURIComponent(resume)}`);
  }
  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  return (
    <CompleteBusinessSwitch
      businessId={businessId}
      destination={destination}
      alreadyActive={session.activeBusinessId === businessId}
    />
  );
}
