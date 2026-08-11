import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { isReviewerEmail } from "@/lib/reviewer-access";
import { countAgencyClients } from "@/lib/zero-base/agency-directory-store";
import {
  isZeroBaseUiEnabledForInternal,
  readZeroBaseRolloutConfig,
} from "@/lib/zero-base/rollout";
import { AgencyShell } from "@/components/zero-base/shell/agency-shell";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

/**
 * Agency scope.
 *
 * Agency has no single business, so the scope is the actor's own membership
 * set. A user with no Agency context does not get a disabled teaser — the
 * route is simply not there, because a locked door still advertises the room.
 */
export default async function AgencyLayout({ children }: { children: React.ReactNode }) {
  const rollout = readZeroBaseRolloutConfig();
  if (!isZeroBaseUiEnabledForInternal(rollout)) notFound();

  const session = await getSessionFromCookies();
  if (!session) redirect(`/login?next=${encodeURIComponent("/a/desk")}`);

  // A bounded count, not a materialised list: the gate only needs to know
  // whether there are at least two clients, and the directory does its own
  // paged read afterwards.
  const clientCount = await countAgencyClients({
    userId: session.user.id,
    email: session.user.email,
  });
  // Agency is a multi-client surface. One client is not an agency.
  if (clientCount < 2) notFound();

  const envelope: WorkspaceContextEnvelope = {
    actor: {
      userId: session.user.id,
      name: session.user.name,
      language: session.user.language,
      membershipRole: null,
      reviewerReadOnly: isReviewerEmail(session.user.email),
      demo: false,
    },
    mode: "agency",
    business: null,
    provider: null,
    evidence: { windowLabel: null, snapshotAt: null, sourceUpdatedAt: null, freshness: "unknown" },
    proof: { currency: "unknown", timezone: "unknown" },
    rollout: { zeroBaseEnabled: true, mutationUiEnabled: rollout.mutationUiEnabled },
  };

  return <AgencyShell envelope={envelope}>{children}</AgencyShell>;
}
