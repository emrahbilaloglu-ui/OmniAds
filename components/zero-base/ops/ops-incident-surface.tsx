"use client";

/**
 * The production Flow J surface.
 *
 * Mounted on the Ops overview and on Ops integrations, so the incident path and
 * the repair ceremony are reachable rather than test-only. The repair here
 * calls the real Shopify health handler — the admin integrations page does not
 * call it, so this exposes an existing endpoint rather than duplicating a
 * mutation somebody else owns.
 *
 * Both handlers require a `businessId`: the PATCH reads it from the body, the
 * GET from the query string. Ops is a superadmin console with no business in
 * its route, so this surface asks which workspace to act on and refuses to
 * enable anything until one is chosen. Without that the button was a guaranteed
 * 400 on every click.
 */
import { useCallback, useEffect, useState } from "react";

import { CriticalIncidentPath, OpsRepairPanel } from "@/components/zero-base/ops/repair-panel";
import { REPAIR_ENDPOINTS } from "@/lib/zero-base/ops/repair-ceremony";

interface AdminBusiness {
  id: string;
  name: string;
}

/** `GET /api/admin/businesses` returns `{businesses: [...], total, page, limit}`. */
function adaptAdminBusinesses(raw: unknown): AdminBusiness[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as { businesses?: unknown }).businesses;
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => {
      const record = row as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : String(record.id ?? "");
      const name = typeof record.name === "string" && record.name.trim() ? record.name : id;
      return { id, name };
    })
    .filter((row) => row.id);
}

/**
 * Did the health GET actually return a readable health body?
 *
 * The handler echoes the `businessId` it read for. A 200 that does not is not
 * something to stamp a re-read against.
 */
export function isReadableHealthBody(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && "businessId" in (body as Record<string, unknown>));
}

type RecheckState =
  | { kind: "idle" }
  | { kind: "confirmed"; at: string }
  | { kind: "failed"; detail: string };

export function OpsIncidentSurface({ businessId }: { businessId?: string }) {
  const contract = REPAIR_ENDPOINTS.shopify_integration;
  const [businesses, setBusinesses] = useState<AdminBusiness[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(businessId ?? "");
  const [recheck, setRecheck] = useState<RecheckState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/businesses?limit=200", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (cancelled) return;
        if (!json) {
          setListError("The workspace list could not be read, so no repair can be scoped.");
          setBusinesses([]);
          return;
        }
        setBusinesses(adaptAdminBusinesses(json));
      })
      .catch(() => {
        if (!cancelled) {
          setListError("The workspace list could not be read, so no repair can be scoped.");
          setBusinesses([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedName = businesses?.find((row) => row.id === selected)?.name ?? selected;

  const run = useCallback(async () => {
    try {
      const response = await fetch(`${contract.path}?businessId=${encodeURIComponent(selected)}`, {
        method: contract.method,
        headers: { "Content-Type": "application/json" },
        // The handler reads businessId from the body. Omitting it was a 400.
        body: JSON.stringify({ businessId: selected, action: "verify_webhooks" }),
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
  }, [contract.method, contract.path, selected]);

  const runRecheck = useCallback(async () => {
    setRecheck({ kind: "idle" });
    const response = await fetch(
      `${contract.path}?businessId=${encodeURIComponent(selected)}`,
      { cache: "no-store" },
    ).catch(() => null);

    if (!response?.ok) {
      // Never "Health re-read" after a failed GET: the previous version stamped
      // a timestamp unconditionally, so a 400 read as a completed re-read.
      setRecheck({
        kind: "failed",
        detail: `The health check did not complete (HTTP ${response?.status ?? "no response"}). The current state is unknown.`,
      });
      return;
    }
    const body = await response.json().catch(() => null);
    if (!isReadableHealthBody(body)) {
      setRecheck({
        kind: "failed",
        detail: "The health check returned a response this surface could not read. The current state is unknown.",
      });
      return;
    }
    setRecheck({ kind: "confirmed", at: new Date().toISOString() });
  }, [contract.path, selected]);

  const blockedReason = !selected
    ? listError ?? "Choose the workspace to repair before running anything."
    : null;

  return (
    <section data-ops-incident-surface="" style={{ display: "grid", gap: 20, marginTop: 24 }}>
      <CriticalIncidentPath />
      <div>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Shopify webhook repair</h2>
        <p style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {/* Named so an operator knows which endpoint and which semantics. */}
          {contract.method} {contract.path} — this endpoint performs no read-back.
        </p>

        <label
          htmlFor="ops-repair-workspace"
          style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}
        >
          Workspace
        </label>
        <select
          id="ops-repair-workspace"
          data-ops-workspace-select=""
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            // A stale re-read from the previous workspace would be a lie here.
            setRecheck({ kind: "idle" });
          }}
          style={{
            minHeight: 44,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid var(--ledger-border-control)",
            background: "var(--ledger-bg-surface)",
            color: "var(--ledger-ink-primary)",
            maxWidth: 360,
            width: "100%",
          }}
        >
          <option value="">Select a workspace…</option>
          {(businesses ?? []).map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        {listError ? (
          <p data-ops-workspace-error="" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
            {listError}
          </p>
        ) : null}

        <div style={{ marginTop: 12 }}>
          <OpsRepairPanel
            action="verify_webhooks"
            onRun={run}
            onRecheck={() => void runRecheck()}
            blockedReason={blockedReason}
            confirmation={{ workspace: selectedName, provider: "Shopify" }}
          />
        </div>

        {recheck.kind === "confirmed" ? (
          <p role="status" data-ops-rechecked="" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
            Health re-read at {recheck.at}. Read the board above for the current state.
          </p>
        ) : recheck.kind === "failed" ? (
          <p role="status" data-ops-recheck-failed="" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ledger-semantic-warn)" }}>
            {recheck.detail}
          </p>
        ) : null}
      </div>
    </section>
  );
}
