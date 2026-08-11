import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { CreativeBriefsClient } from "@/components/zero-base/creative/studio-clients";
import { defaultCreativeWindow, scopeFromSearchParams } from "@/lib/zero-base/creative/route-scope";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return null;
}

export default async function CreativeBriefsPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/creative/briefs`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const raw = (await searchParams) ?? {};
  const scope = scopeFromSearchParams(raw, defaultCreativeWindow(new Date()));

  return (
    <CreativeBriefsClient
      businessId={businessId}
      providerAccountId={scope.providerAccountId}
      start={scope.start}
      end={scope.end}
      // Lineage from the URL: a brief is derived from a decision snapshot, and
      // without one the client blocks creation before any POST.
      creativeId={first(raw.creativeId)}
      snapshotId={first(raw.snapshotId)}
      trigger={first(raw.trigger)}
    />
  );
}
