import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import {
  requestedProviderAccountFromSearchParams,
  windowFromSearchParams,
} from "@/lib/zero-base/creative/route-scope";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import LegacyCreativePerformancePage from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";
import { MetaSurfaceStateLive } from "@/components/meta/meta-surface-state-live";
import { resolveMetaPageSurfaceState } from "@/lib/meta/surface-read-state-server";
import { readMetaGateRefusal } from "@/lib/meta/release-gate-guard";
import { EnginePostureNotice } from "@/components/meta/EnginePostureNotice";
import { readServerEnginePosture } from "@/lib/zero-base/creative/engine-posture-server";

export const dynamic = "force-dynamic";

/**
 * Creative Studio — Assets.
 *
 * The window in the URL is parsed here, on the server, and handed to the body
 * as `serverDateWindow`, the same way this family's provider account reaches
 * the Decision Center body as `serverProviderAccountId`. Before that the route
 * parsed `?start`/`?end` and dropped the result on the floor, so a link naming
 * a window rendered whatever range happened to be in the operator's browser
 * storage and a reload could not reproduce what the link said.
 *
 * Absence stays absence: when the URL names no usable window this forwards
 * `null` rather than the 28 UTC days `defaultCreativeWindow` would mint, so the
 * shell's own range — resolved against the account's clock, which a server
 * default cannot be — remains the window and the shell date control keeps
 * meaning what it shows.
 */
export default async function CreativePerformancePage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/creative/performance`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const raw = await searchParams;
  const providerAccountId = await resolveProviderAccountId({
    businessId,
    provider: "meta",
    requestedAccountId: requestedProviderAccountFromSearchParams(raw),
  });
  const serverDateWindow = windowFromSearchParams(raw);

  /**
   * The §9 envelope. Creative Studio reads its rows client-side, so the page
   * decides scope and authority. An unscoped Studio used to render five empty
   * tabs, which is indistinguishable from an account that genuinely has no
   * creatives.
   */
  const readState = await resolveMetaPageSurfaceState({
    surfaceId: "creative-studio",
    businessId,
    requestedAccountId: requestedProviderAccountFromSearchParams(raw),
    permissions: {
      role: access.context.role,
      reviewerReadOnly: access.context.reviewerReadOnly,
      demo: access.context.demo,
    },
    evidence: serverDateWindow
      ? { window: { startDate: serverDateWindow.start, endDate: serverDateWindow.end } }
      : undefined,
  });

  /**
   * WP10: which of the five Engine V3 postures this surface is in.
   *
   * Resolved on the server and stated before any decision is shown. The five
   * postures and their sentences have existed since WP10 was written; nothing
   * mounted called them, so a Studio in shadow mode and a Studio serving live
   * decisions looked the same. "Shadow decision authority gibi gösterilmez"
   * needs the surface to say which one it is.
   */
  const enginePosture = await readServerEnginePosture(businessId);

  return (
    <>
    <MetaSurfaceStateLive initial={readState} surfaceId="creative-studio" />
    <EnginePostureNotice posture={enginePosture.posture} surfaceId="creative-studio" />
    <LegacyCreativePerformancePage
      businessId={businessId}
      providerAccountId={providerAccountId}
      serverDateWindow={serverDateWindow}
      /*
       * The same answer `/api/creatives/share` would give, read here so the
       * refusal is visible before the click rather than after a filled-in form.
       * The screen restates the server's decision; it never makes one.
       */
      shareMintRefusalReason={readMetaGateRefusal("publicShareMint")?.message ?? null}
    />
    </>
  );
}
