import { notFound, redirect } from "next/navigation";

import { listUserBusinesses } from "@/lib/access";
import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import LegacyMetaPage from "@/app/(dashboard)/platforms/meta/legacy-page";
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import { MetaSurfaceStateLive } from "@/components/meta/meta-surface-state-live";
import { resolveMetaPageSurfaceState } from "@/lib/meta/surface-read-state-server";

export const dynamic = "force-dynamic";

/**
 * Meta Decisions.
 *
 * The workspace payload is fetched client-side from the existing
 * `/api/meta/decisions-workspace`, which already owns authorization, the
 * decision universe and every verdict string — this route duplicates none of
 * it. The body is the shared Decision Center body: every route family
 * (`/platforms/meta`, `/app/meta/decisions`, `/c/:id/meta/decisions`)
 * converges on it, which is pinned by
 * `components/creatives/creative-evidence-window-wiring.test.ts`.
 *
 * `resolveProviderAccountId` runs here under the session and is the only
 * assignment-verified answer in the request. It now reaches the body as
 * `serverProviderAccountId`, forwarded through the shared shim at
 * `app/(dashboard)/platforms/meta/legacy-page.tsx`; the body prefers its own
 * picker selection and falls back to this, so one failing
 * `/api/meta/history/accounts` read no longer empties a surface whose account
 * this route had already resolved. The value is NOT substituted from the URL
 * here or in the client.
 *
 * CORRECTION — an earlier version of this comment said
 * `/api/meta/decisions-workspace` does not re-check the requested account.
 * That was false. `canonicalDecisionReadModel()` in
 * `app/api/meta/decisions-workspace/route.ts` reads
 * `getProviderAccountAssignments(businessId, "meta")` and returns
 * `403 provider_account_not_assigned` when the requested id is absent from
 * `account_ids`, and the GET handler returns that status for the whole
 * response; an unreadable assignment source degrades to the
 * `provider_account_scope_unverified` unavailable model instead of reading.
 * The endpoint therefore fails closed on its own. The reason this route still
 * refuses to forward the raw URL id is independent of that: this page's
 * resolver is the surface's scope of record, and a scope nobody verified here
 * would present as verified to every client-side reader downstream — a false
 * security claim is worse than a missing one, which is exactly the defect this
 * comment used to carry.
 *
 * There is deliberately no `mutationUiEnabled` computation here any more. It
 * was computed and voided, and a gate that is read and dropped is worse than
 * no gate — it reads as protection that does not exist. Write authority on
 * this surface is server-owned and served in the workspace payload's `viewer`.
 *
 * The retired `parseDecisionsUrlState` call is gone for the same reason: it
 * parsed the old `lane=act|test|watch` + `levels`/`q`/`row` contract and threw
 * the result away. The screen now reads the one live contract itself
 * (`components/meta/redesign/MetaPlatformPage.tsx`), including the legacy
 * `row=ad:<id>` / `creativeId` links that are still minted today.
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
  const businesses = await listUserBusinesses(access.context.session.user.id);
  const business = businesses.find((item) => item.id === businessId) ?? null;

  const raw = (await searchParams) ?? {};
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value) && value[0]) query.set(key, value[0]);
  }

  const providerAccountId = await resolveProviderAccountId({
    businessId,
    provider: "meta",
    requestedAccountId: query.get("providerAccountId"),
  });

  /**
   * The §9 envelope for this surface, resolved before any data is read.
   *
   * Decisions fetches its workspace client-side, so what this page can decide
   * is the half that does not need data: whether this request was scoped at
   * all, and whether the actor may write. That half is where the collapse
   * mattered most — an unscoped Decision Center rendered an empty queue, and an
   * empty queue and a queue that was never asked look identical.
   *
   * The served half arrives with the payload, from the same resolver, and
   * `laterMetaSurfaceState` decides which one the screen shows.
   */
  const readState = await resolveMetaPageSurfaceState({
    surfaceId: "meta-decisions",
    businessId,
    requestedAccountId: query.get("providerAccountId"),
    permissions: {
      role: access.context.role,
      reviewerReadOnly: access.context.reviewerReadOnly,
      demo: access.context.demo,
    },
  });

  // The only assignment-verified account in the request. The body prefers its
  // own picker selection and falls back to this, so a failing accounts read no
  // longer empties the surface for a value the server already established.
  return (
    <>
    {/*
      The live region: this surface reads its workspace in the browser, so the
      envelope above is only the half the server knew before the fetch. The
      body forwards the payload's envelope and this shows whichever is later.
    */}
    <MetaSurfaceStateLive initial={readState} surfaceId="meta-decisions" />
    <LegacyMetaPage
      businessId={businessId}
      businessName={business?.name ?? null}
      currency={business?.currency ?? null}
      serverProviderAccountId={providerAccountId}
      /*
       * Read on the server and forwarded. The workflow STATE is rendered
       * regardless — the design already draws its output as a "Deferred" watch
       * segment and a "Let cook until …" row note — but the seven transitions
       * are controls the design does not draw, so §18 keeps them refused until
       * the owner's separately approved round. Defaults off.
       */
      decisionWorkflowUiEnabled={readMetaReleaseGates().decisionWorkflowUi}
    />
    </>
  );
}
