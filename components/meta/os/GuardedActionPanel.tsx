"use client";

import { useState } from "react";
import type { MetaOsAdDecision, MetaOsDecisionAction } from "@/lib/meta/decisions-os-contract";
import {
  describeGuardedCapability,
  resolveGuardedActionCapability,
} from "@/lib/meta/guarded-action-capability";
import {
  describePreflightVerdict,
  type PreflightReceipt,
} from "@/lib/meta/guarded-action-preflight";

/**
 * What this decision's command may do, and whether its target still holds.
 *
 * The capability is rendered, never derived here. Preflight is offered because
 * an operator deciding whether to act in Ads Manager still needs to know the
 * decision has not gone stale — and it costs nothing, since it contacts no
 * provider.
 */
export function GuardedActionPanel({
  businessId,
  providerAccountId,
  action,
  ad,
  killSwitchEngaged,
}: {
  businessId: string;
  providerAccountId: string | null;
  action: MetaOsDecisionAction;
  ad: MetaOsAdDecision | null;
  killSwitchEngaged: boolean;
}) {
  const [receipt, setReceipt] = useState<PreflightReceipt | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const capability = resolveGuardedActionCapability({
    action,
    killSwitchEngaged,
    // Server permission governs the write; this only asks for a check.
    viewerCanWrite: true,
    hasPersistedAuthority: Boolean(ad?.decisionId),
    isSynthetic: false,
    // D065 derives the permitted mutation from the published decision, not from
    // the action the payload happens to carry.
    publishedLabel: ad?.publishedLabel ?? null,
  });

  const canPreflight =
    Boolean(ad?.adId) &&
    Boolean(providerAccountId) &&
    capability.capability !== "hidden" &&
    capability.capability !== "blocked";

  async function runPreflight() {
    if (!ad?.adId || !providerAccountId) return;
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/meta/decision-action/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          providerAccountId,
          entityType: "ad",
          entityId: ad.adId,
          // The decision contract carries no expected status, so none is
          // asserted: preflight verifies identity, account and creative rather
          // than inventing a status the decision never recorded.
          expectedStatus: null,
          expectedCreativeId: ad.creativeId ?? null,
          killSwitchEngaged,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(
          (payload as { message?: string } | null)?.message ?? "Preflight could not run.",
        );
        return;
      }
      setReceipt((payload as { receipt: PreflightReceipt }).receipt);
    } catch {
      setError("Preflight could not run.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div data-guarded-action={capability.capability}>
      <span>
        <strong>{describeGuardedCapability(capability.capability)}</strong>
        {capability.reason ? ` — ${capability.reason}` : null}
      </span>

      {canPreflight ? (
        <button type="button" onClick={() => void runPreflight()} disabled={running}>
          {running ? "Checking target" : "Check target"}
        </button>
      ) : null}

      {error ? <span data-preflight-error="true">{error}</span> : null}

      {receipt ? (
        <span data-preflight-verdict={receipt.verdict}>
          {describePreflightVerdict(receipt.verdict)} — {receipt.detail}
          {receipt.drift.length > 0 ? ` (${receipt.drift.join("; ")})` : null}
        </span>
      ) : null}
    </div>
  );
}
