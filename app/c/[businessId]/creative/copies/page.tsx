import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import {
  requestedProviderAccountFromSearchParams,
  windowFromSearchParams,
} from "@/lib/zero-base/creative/route-scope";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import LegacyCreativeCopiesPage from "@/app/(dashboard)/platforms/meta/copies/legacy-page";

export const dynamic = "force-dynamic";

/**
 * Creative Studio — Copies.
 *
 * `?start`/`?end` are parsed here and forwarded as `serverDateWindow`; the
 * route used to parse them and forward nothing, so a link naming a window
 * rendered a different one. This matters more on Copies than on its siblings:
 * the body resolves its preset without a reference date, i.e. against the
 * browser's clock, so two operators could open the same "28d" link on
 * different days. A window the link states removes that guesswork entirely.
 *
 * When the URL names no usable window this forwards `null` — not a server
 * default — so the shell's range stays the window and stays adjustable.
 */
export default async function CreativeCopiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/creative/copies`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const raw = await searchParams;
  const providerAccountId = await resolveProviderAccountId({
    businessId,
    provider: "meta",
    requestedAccountId: requestedProviderAccountFromSearchParams(raw),
  });
  const serverDateWindow = windowFromSearchParams(raw);

  return (
    <LegacyCreativeCopiesPage
      businessId={businessId}
      providerAccountId={providerAccountId}
      serverDateWindow={serverDateWindow}
    />
  );
}
