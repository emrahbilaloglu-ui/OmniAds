import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { DecisionsClient } from "@/components/zero-base/meta/decisions/decisions-client";
import { parseDecisionsUrlState } from "@/lib/zero-base/meta/decisions-url-state";

export const dynamic = "force-dynamic";

/**
 * Meta Decisions.
 *
 * URL state is parsed on the server so a pasted link renders the same view for
 * whoever opens it. The workspace payload itself is fetched client-side from
 * the existing `/api/meta/decisions-workspace`, which already owns
 * authorization, the decision universe and every verdict string — this route
 * duplicates none of it.
 */
export default async function MetaDecisionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/meta/decisions`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const raw = (await searchParams) ?? {};
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value) && value[0]) query.set(key, value[0]);
  }

  return (
    <DecisionsClient
      businessId={businessId}
      initialState={parseDecisionsUrlState(query)}
      demo={access.context.demo}
    />
  );
}
