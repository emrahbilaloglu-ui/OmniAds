"use client";

/**
 * The production Flow J surface.
 *
 * Mounted on the Ops overview and on Ops integrations, so the incident path and
 * the repair ceremony are reachable rather than test-only. The repair here
 * calls the real Shopify health handler — the admin integrations page does not
 * call it, so this exposes an existing endpoint rather than duplicating a
 * mutation somebody else owns.
 */
import { useCallback, useState } from "react";

import { CriticalIncidentPath, OpsRepairPanel } from "@/components/zero-base/ops/repair-panel";
import { REPAIR_ENDPOINTS } from "@/lib/zero-base/ops/repair-ceremony";

export function OpsIncidentSurface({ businessId }: { businessId?: string }) {
  const contract = REPAIR_ENDPOINTS.shopify_integration;
  const [recheckedAt, setRecheckedAt] = useState<string | null>(null);

  const run = useCallback(async () => {
    const query = businessId ? `?businessId=${encodeURIComponent(businessId)}` : "";
    try {
      const response = await fetch(`${contract.path}${query}`, {
        method: contract.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, action: "verify_webhooks" }),
      });
      return {
        httpOk: response.ok,
        status: response.status,
        body: await response.json().catch(() => null),
        transportFailed: false,
      };
    } catch {
      // The request may have reached the server and run.
      return { httpOk: false, status: null, body: null, transportFailed: true };
    }
  }, [businessId, contract.method, contract.path]);

  const recheck = useCallback(async () => {
    const query = businessId ? `?businessId=${encodeURIComponent(businessId)}` : "";
    await fetch(`${contract.path}${query}`, { cache: "no-store" }).catch(() => null);
    setRecheckedAt(new Date().toISOString());
  }, [businessId, contract.path]);

  return (
    <section data-ops-incident-surface="" style={{ display: "grid", gap: 20, marginTop: 24 }}>
      <CriticalIncidentPath />
      <div>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Shopify webhook repair</h2>
        <p style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {/* Named so an operator knows which endpoint and which semantics. */}
          {contract.method} {contract.path} — this endpoint performs no read-back.
        </p>
        <OpsRepairPanel action="verify_webhooks" onRun={run} onRecheck={() => void recheck()} />
        {recheckedAt ? (
          <p role="status" data-ops-rechecked="" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
            Health re-read at {recheckedAt}. Read the board above for the current state.
          </p>
        ) : null}
      </div>
    </section>
  );
}
