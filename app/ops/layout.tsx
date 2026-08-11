import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { isSuperadmin } from "@/lib/admin-auth";
import {
  isZeroBaseUiEnabledForInternal,
  readZeroBaseRolloutConfig,
} from "@/lib/zero-base/rollout";
import { OpsShell } from "@/components/zero-base/shell/ops-shell";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

/**
 * Ops scope — platform administration.
 *
 * Authorized by `is_superadmin` only. Buyer membership grants nothing here,
 * and no amount of business-level role reaches these routes; conversely no Ops
 * item ever appears in buyer navigation. A non-admin gets not-found rather
 * than forbidden, so the existence of the surface is not advertised.
 */
export default async function OpsLayout({ children }: { children: React.ReactNode }) {
  const rollout = readZeroBaseRolloutConfig();
  if (!isZeroBaseUiEnabledForInternal(rollout)) notFound();

  const session = await getSessionFromCookies();
  if (!session) redirect(`/login?next=${encodeURIComponent("/ops")}`);
  if (!(await isSuperadmin(session.user.id))) notFound();

  const envelope: WorkspaceContextEnvelope = {
    actor: {
      userId: session.user.id,
      name: session.user.name,
      language: session.user.language,
      membershipRole: null,
      reviewerReadOnly: false,
      demo: false,
    },
    mode: "ops",
    business: null,
    provider: null,
    evidence: { windowLabel: null, snapshotAt: null, sourceUpdatedAt: null, freshness: "unknown" },
    proof: { currency: "unknown", timezone: "unknown" },
    rollout: { zeroBaseEnabled: true, mutationUiEnabled: rollout.mutationUiEnabled },
  };

  return <OpsShell envelope={envelope}>{children}</OpsShell>;
}
