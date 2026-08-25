import { notFound, redirect } from "next/navigation";

import { listUserBusinesses } from "@/lib/access";
import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { readMetaIntelligence } from "@/lib/zero-base/meta/intelligence-server";
import { resolveIntelligenceWindow } from "@/lib/zero-base/meta/intelligence-window";
import { getTodayIsoForTimeZone } from "@/lib/dashboard/date-window-presets";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import { classifySourceFailure } from "@/lib/meta/source-failure-classifier";
import { IntelligenceControlsClient } from "@/components/zero-base/meta/intelligence/intelligence-controls-client";
import { MetaSurfaceState } from "@/components/meta/MetaSurfaceState";
import { resolveMetaPageSurfaceState } from "@/lib/meta/surface-read-state-server";
import {
  resolveMetaSurfaceReadState,
  type MetaSurfaceSource,
} from "@/lib/meta/surface-read-state";
import { isMetaFailureCode } from "@/lib/meta/read-state-contract";

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
    /*
     * Who is asking, so the composer can author the two control sections'
     * refusals on the server.
     *
     * The same context the page already authorized with; not a second read and
     * not a second opinion. Without it the composer refuses both controls,
     * which is the correct answer for a caller that never said who is asking.
     */
    actor: {
      role: access.context.role,
      reviewerReadOnly: access.context.reviewerReadOnly,
      demo: access.context.demo,
    },
  }).catch((error: unknown) => {
    /**
     * Classified, not printed.
     *
     * This rendered the thrown error's own text as the page's unavailable
     * reason — the same leak `section()` used to have one level down. A driver
     * error carries the failing SQL and table names; a fetch error carries the
     * URL, which for a provider call can carry an access token. The raw text is
     * logged here and the operator reads a sentence they can act on.
     */
    const failure = classifySourceFailure(error);
    console.error("[meta-intelligence] surface could not be composed", {
      businessId,
      code: failure.code,
      detail: failure.detail,
    });
    return {
      providerAccountId: null,
      sections: [],
      unavailableReason: failure.message,
    };
  });

  /**
   * The §9 envelope, resolved on the server from the read that just happened.
   *
   * This page already composes every section server-side, so it knows exactly
   * which sources answered and which did not — and until now it threw that
   * away, handing the view eleven independent section states and no statement
   * about the surface. A reader could not tell a screen where every source
   * answered with nothing from one where none of them answered at all.
   *
   * The mapping is the section vocabulary onto the source vocabulary, and it is
   * the only place the two meet. `partial` stays partial rather than collapsing
   * into `served`, because a capped section presented as whole is the defect.
   */
  const sources: MetaSurfaceSource[] = intelligence.sections.map((section) => ({
    id: section.key,
    outcome:
      section.state === "serving"
        ? section.facts.length > 0
          ? ("served" as const)
          : ("empty" as const)
        : section.state === "partial"
          ? ("partial" as const)
          : section.state === "unavailable"
            ? ("not-ready" as const)
            : ("failed" as const),
    rowCount: section.facts.length,
    failureCode: isMetaFailureCode(section.failureCode) ? section.failureCode : undefined,
  }));

  const pageState = await resolveMetaPageSurfaceState({
    surfaceId: "meta-intelligence",
    businessId,
    requestedAccountId: first(raw.providerAccountId),
    permissions: {
      role: access.context.role,
      reviewerReadOnly: access.context.reviewerReadOnly,
      demo: access.context.demo,
    },
    evidence: { window: { startDate, endDate } },
  });

  // The page's refusal outranks the read — an unscoped surface's sections were
  // never asked — so the served envelope is only built when the scope held.
  const readState =
    pageState.state === "refused"
      ? pageState
      : resolveMetaSurfaceReadState({
          businessId,
          providerAccountId,
          requiresProviderAccount: true,
          permissions: pageState.permissions,
          capability: {
            canRead: intelligence.unavailableReason === null,
            canWrite: pageState.capability.canWrite,
            readBlockedBy:
              intelligence.unavailableReason === null ? undefined : "source_read_failed",
          },
          sources,
          evidence: { window: { startDate, endDate } },
        });

  return (
    <>
    <MetaSurfaceState envelope={readState} surfaceId="meta-intelligence" />
    <IntelligenceControlsClient
      businessId={businessId}
      sources={intelligence.sections.map((item) => ({
        key: item.key,
        label: item.label,
        state: item.state,
        /*
         * Composed AND forwarded. These two were resolved by the server and
         * dropped here, so WP9's per-section §9 acceptance was unobservable on
         * the route that mounts it: the markers rendered only for callers that
         * happened to build `sources` by hand.
         */
        readState: item.readState,
        readFailureCode: item.readFailureCode,
        control: item.control,
        reason: item.reason,
        observedAt: item.observedAt,
        facts: item.facts,
      }))}
      unavailableReason={intelligence.unavailableReason}
      window={{ startDate, endDate }}
      /*
       * No `snapshot` prop, and no `onRunSnapshot`/`onRespond` handler here.
       *
       * Both controls now take their state from the composed sections, where
       * the server authored them — this page used to hand in `canRun: false`
       * with two sentences written in this file, so the refusal an operator
       * read was invented at the route rather than resolved from the §9.1
       * dictionary, and it said "not enabled yet" about capabilities that are
       * shipped and tested.
       *
       * The handlers live in `IntelligenceControlsClient`, which is a client
       * component because a POST needs one; this page stays a server component
       * and passes it nothing but what the server decided.
       */
    />
    </>
  );
}
