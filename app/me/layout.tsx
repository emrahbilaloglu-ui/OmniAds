import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/access";
import {
  isZeroBaseUiEnabledForInternal,
  readZeroBaseRolloutConfig,
} from "@/lib/zero-base/rollout";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import { AccountShell } from "@/components/zero-base/shell/account-shell";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

/**
 * Account scope.
 *
 * Deliberately business-independent: a user must be able to change their
 * password or revoke a session even when they have no membership, or an
 * account left with no business becomes unrecoverable.
 */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const rollout = readZeroBaseRolloutConfig();
  if (!isZeroBaseUiEnabledForInternal(rollout)) notFound();

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor("/me/account-security"));

  const businesses = await listUserBusinesses(session.user.id);

  const envelope: WorkspaceContextEnvelope = {
    actor: {
      userId: session.user.id,
      name: session.user.name,
      language: session.user.language,
      membershipRole: null,
      reviewerReadOnly: false,
      demo: false,
    },
    mode: "account",
    business: null,
    provider: null,
    evidence: { windowLabel: null, snapshotAt: null, sourceUpdatedAt: null, freshness: "unknown" },
    proof: { currency: "unknown", timezone: "unknown" },
    rollout: { zeroBaseEnabled: true, mutationUiEnabled: rollout.mutationUiEnabled },
  };

  return (
    <AccountShell envelope={envelope} businessCount={businesses.length}>
      {children}
    </AccountShell>
  );
}
