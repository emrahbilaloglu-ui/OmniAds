import { notFound, redirect } from "next/navigation";

import { listUserBusinesses } from "@/lib/access";
import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { readMetaIntelligence } from "@/lib/zero-base/meta/intelligence-server";
import { resolveIntelligenceWindow } from "@/lib/zero-base/meta/intelligence-window";
import { getTodayIsoForTimeZone } from "@/lib/dashboard/date-window-presets";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import { IntelligenceView } from "@/components/zero-base/meta/intelligence/intelligence-view";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined) {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return null;
}

/**
 * `searchParams` as the shared window reader expects to see them.
 *
 * Next hands a plain object whose values may repeat; the reader takes anything
 * with a `get`. A repeated parameter answers with its first value, which is what
 * every other reader of this URL does.
 */
function asSearchParamsLike(raw: Record<string, string | string[] | undefined>) {
  return { get: (name: string) => first(raw[name]) };
}

export default async function MetaIntelligencePage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/meta/intelligence`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const raw = (await searchParams) ?? {};

  // The account the operator selected, resolved the same way every other
  // canonical Meta route resolves it. Ignoring the URL made a surface the
  // operator had in fact scoped report itself as unscoped, with every
  // account-scoped section saying "no Meta account is selected".
  //
  // `resolveProviderAccountId` refuses an id this business is not assigned and
  // refuses to pick one of several, so the "null means unresolved" law the
  // sections rely on is unchanged — it is only now also satisfiable.
  const providerAccountId = await resolveProviderAccountId({
    businessId,
    provider: "meta",
    requestedAccountId: first(raw.providerAccountId),
  });

  const businesses = await listUserBusinesses(access.context.session.user.id).catch(
    () => [],
  );
  const workspaceTimeZone =
    businesses.find((item) => item.id === businessId)?.timezone ?? "UTC";
  // The window is the shell's, read through the shared URL authority — the same
  // resolver and now the same clock reader the topbar itself calls
  // (`getTodayIsoForTimeZone`, `components/layout/v2/app-topbar.tsx`). This page
  // owns neither a default nor an expansion: see
  // `lib/zero-base/meta/intelligence-window` for the three cases and for why the
  // private copies it used to carry are gone.
  const { startDate, endDate } = resolveIntelligenceWindow({
    searchParams: asSearchParamsLike(raw),
    referenceDate: getTodayIsoForTimeZone(workspaceTimeZone),
  });

  const intelligence = await readMetaIntelligence({
    businessId,
    providerAccountId,
    startDate,
    endDate,
  }).catch((error: unknown) => ({
    providerAccountId: null,
    sections: [],
    unavailableReason:
      error instanceof Error
        ? error.message
        : "Account intelligence could not be composed for this business.",
  }));

  return (
    <IntelligenceView
      sources={intelligence.sections.map((item) => ({
        key: item.key,
        label: item.label,
        state: item.state,
        reason: item.reason,
        observedAt: item.observedAt,
        facts: item.facts,
      }))}
      unavailableReason={intelligence.unavailableReason}
      window={{ startDate, endDate }}
    />
  );
}
