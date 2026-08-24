import { notFound, redirect } from "next/navigation";

import { listUserBusinesses } from "@/lib/access";
import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import {
  landLaunchpadHandoff,
  readLaunchpadHandoffPrefill,
} from "@/lib/meta/launchpad-handoff-server";
import { launchpadWizardTargetForHandoffMode } from "@/lib/meta/launchpad-handoff-contract";
import { readLaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";
import { buildLaunchpadViewerEnvelope } from "@/app/(dashboard)/platforms/meta/launchpad/viewer-envelope";
import LegacyMetaLaunchpadPage from "@/app/(dashboard)/platforms/meta/launchpad/legacy-page";
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import { MetaSurfaceStateLive } from "@/components/meta/meta-surface-state-live";
import { resolveMetaPageSurfaceState } from "@/lib/meta/surface-read-state-server";

export const dynamic = "force-dynamic";

function firstValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MetaLaunchpadPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/meta/launchpad`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  const raw = (await searchParams) ?? {};
  const requestedProviderAccountId = firstValue(raw.providerAccountId);
  const [providerAccountId, businesses, writeAuthority] = await Promise.all([
    resolveProviderAccountId({
      businessId,
      provider: "meta",
      requestedAccountId: requestedProviderAccountId,
    }),
    listUserBusinesses(access.context.session.user.id),
    // The same read the write routes gate on, so the control the operator sees
    // and the endpoint that answers the click cannot disagree about whether
    // this workspace has any Meta write authority. Read here rather than reused
    // from `access.context.demo`, which only compares the well-known demo id
    // and would miss a workspace flagged `is_demo_business` in the table.
    readLaunchpadWriteAuthority(businessId),
  ]);
  const business = businesses.find((item) => item.id === businessId) ?? null;

  // Every Launchpad write route rejects a reviewer (403 reviewer_read_only),
  // anything below collaborator, and a demo workspace (403
  // demo_business_read_only). The server decides all of that once, here; the
  // surface renders the decision and never recomputes it.
  const viewer = buildLaunchpadViewerEnvelope({
    role: access.context.role,
    reviewerReadOnly: access.context.reviewerReadOnly,
    writeAuthority,
  });

  /**
   * The handoff is re-read HERE, server-side, in two hops.
   *
   * HOP 1 — `?handoff=<id>.<token>` is a reference, not a claim: it names a
   * record `lib/meta/launchpad-handoff.ts` wrote under a session after the
   * server read the source itself. This is the request that has to be
   * satisfied, not the one that minted it, so `landLaunchpadHandoff` runs every
   * check again against THIS request — this viewer's role/reviewer/demo write
   * authority, same business, same assignment-verified provider account, same
   * signed-in user, not expired, not already used — and then, for a decision
   * handoff, RE-READS the canonical decision and re-runs the same pure
   * authorization law over today's verdict. Held, blocked, review-only,
   * withdrawn or re-labelled all refuse. The token is single-use and is burned
   * by the read.
   *
   * Cross-business, cross-account, expired, consumed and every refusal above
   * fail closed: nothing opens and the operator is sent back to Decisions with
   * the refusal code, which the Decisions surface turns into a sentence. A
   * refusal that opened Launchpad anyway — even an empty one — would read as
   * "it worked", which is the exact failure the old URL handoff produced.
   *
   * On success the burned reference is stripped and the redirect carries only
   * the server's own mode/step plus `handoffDraft`, the id of the record.
   *
   * HOP 2 — `?handoffDraft=<id>` is read back under this request's business,
   * assignment-verified account and signed-in user, and only while the record
   * is already consumed and recently so. That read cannot open a handoff (an
   * unconsumed one is refused) and grants nothing; it exists so the prefilled
   * wizard survives a browser reload without the single-use token ever
   * re-entering the address bar.
   */
  const requestedHandoff = firstValue(raw.handoff);
  if (typeof requestedHandoff === "string" && requestedHandoff.trim()) {
    const landed = await landLaunchpadHandoff({
      reference: requestedHandoff,
      businessId,
      providerAccountId,
      actorUserId: access.context.session.user.id,
      canMutate: viewer.canMutate,
    });
    const nextQuery = new URLSearchParams();
    if (providerAccountId) {
      nextQuery.set("providerAccountId", providerAccountId);
    }
    if (landed.ok) {
      const target = launchpadWizardTargetForHandoffMode(landed.envelope.mode);
      nextQuery.set("launchpadMode", target.launchpadMode);
      nextQuery.set("launchpadStep", target.launchpadStep);
      // The record, named. Not the selection, not the lineage, not the mode's
      // justification — those are read back out of the record server-side on
      // the next pass, because a URL is never verified lineage. A record with
      // no id cannot be re-read, so it is omitted rather than written as the
      // string "undefined", which would name nothing and refuse on hop 2.
      if (landed.envelope.handoffId) {
        nextQuery.set("handoffDraft", landed.envelope.handoffId);
      }
      redirect(`/c/${businessId}/meta/launchpad?${nextQuery.toString()}`);
    }
    nextQuery.set("handoffRefused", landed.refusal);
    redirect(`/c/${businessId}/meta/decisions?${nextQuery.toString()}`);
  }

  const handoffPrefill = await readLaunchpadHandoffPrefill({
    handoffId: firstValue(raw.handoffDraft),
    businessId,
    providerAccountId,
    actorUserId: access.context.session.user.id,
  });
  /**
   * A named record that cannot be honoured refuses here, exactly like hop 1.
   *
   * The alternative was to mount Launchpad and print the reason, but the
   * surface a hop-2 failure lands on is the LANDING, which has no slot for a
   * sentence — so the operator would have been shown an ordinary blank
   * Launchpad, which is indistinguishable from success and is precisely the
   * failure this seam exists to remove. Sending them back to where the handoff
   * started, carrying the code, puts the reason on a surface that renders it.
   */
  if (handoffPrefill.status === "unavailable") {
    const refusedQuery = new URLSearchParams();
    if (providerAccountId) {
      refusedQuery.set("providerAccountId", providerAccountId);
    }
    refusedQuery.set("handoffRefused", handoffPrefill.refusal);
    redirect(`/c/${businessId}/meta/decisions?${refusedQuery.toString()}`);
  }

  /**
   * The §9 envelope. Launchpad reads its drafts client-side, so what the page
   * decides is scope and authority — and on a guarded write surface that is the
   * half that matters: a Launchpad that was never scoped must not present a
   * draft table as though a validated launch could follow it.
   */
  const readState = await resolveMetaPageSurfaceState({
    surfaceId: "meta-launchpad",
    businessId,
    requestedAccountId: requestedProviderAccountId,
    permissions: {
      role: access.context.role,
      reviewerReadOnly: access.context.reviewerReadOnly,
      demo: access.context.demo,
    },
  });

  return (
    <>
    <MetaSurfaceStateLive initial={readState} surfaceId="meta-launchpad" />
    <LegacyMetaLaunchpadPage
      businessId={businessId}
      businessName={business?.name ?? null}
      providerAccountId={providerAccountId}
      viewer={viewer}
      handoffPrefill={handoffPrefill}
      /*
       * Read here, on the server, and forwarded — the same gate
       * `rejectIfLaunchpadExecutionGated` enforces in the write routes. The
       * surface restates it so the refusal is visible before the click; it
       * never decides it. See `docs/adr-003-launchpad-execution-posture.md`.
       */
      executionEnabled={readMetaReleaseGates().launchpadExecution}
    />
    </>
  );
}
