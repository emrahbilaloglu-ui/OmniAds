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

/** Guard against a runaway loop if the route ever reports a nonsense total. */
const MAX_WORKSPACE_PAGES = 50;

/**
 * Every workspace, not just the first page.
 *
 * The route **hardcodes `limit = 30`** and ignores any `limit` in the query, so
 * the previous `?limit=200` silently returned 30 rows and a superadmin could
 * not select the 31st workspace at all. Pages are walked using the route's own
 * reported `total`/`limit`.
 *
 * A page that fails is disclosed rather than swallowed: a short list that looks
 * complete is how an operator concludes a workspace does not exist.
 */
export async function fetchAllAdminBusinesses(
  get: (url: string) => Promise<unknown | null>,
): Promise<{ businesses: AdminBusiness[]; partial: boolean; readFailed: boolean }> {
  const first = await get("/api/admin/businesses?page=1");
  if (!first || typeof first !== "object") {
    return { businesses: [], partial: false, readFailed: true };
  }
  const head = first as { total?: unknown; limit?: unknown };
  const businesses = adaptAdminBusinesses(first);
  const total = typeof head.total === "number" ? head.total : businesses.length;
  // The route's own page size, never a number we asked for.
  const limit = typeof head.limit === "number" && head.limit > 0 ? head.limit : 30;
  const pages = Math.min(Math.ceil(total / limit), MAX_WORKSPACE_PAGES);

  let partial = pages < Math.ceil(total / limit);
  for (let page = 2; page <= pages; page += 1) {
    const body = await get(`/api/admin/businesses?page=${page}`);
    if (!body) {
      partial = true;
      continue;
    }
    businesses.push(...adaptAdminBusinesses(body));
  }
  return { businesses, partial, readFailed: false };
}

export interface ShopifyHealthView {
  businessId: string;
  /** `ShopifyStatusResponse.state` — the authoritative condition. */
  state: string;
  connected: boolean;
  shopDomain: string | null;
  tokenValid: boolean | null;
  tokenValidationError: string | null;
  productionMode: string | null;
  /** Named blockers, from the handler's own fields. */
  blockers: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read the health body, and only when it really is health for this business.
 *
 * Two independent requirements, both learned the hard way:
 *
 * - The echoed `businessId` must equal the selected one. The operator switches
 *   workspaces here, so a response for the previous selection would otherwise
 *   be rendered as this one's health.
 * - The body must carry a **health core**: a `status` object with the
 *   authoritative `state` and `connected` fields in valid types. A matching
 *   tenant id alone is not a health result — `{businessId}` used to satisfy
 *   this and be stamped as a successful re-read, which claimed a condition
 *   nobody had observed.
 *
 * Optional fields may be absent; that is ordinary. They may not be present and
 * malformed — a rendered field silently downgraded to "not reported" under a
 * successful receipt would be a fabricated reading. Anything failing returns
 * null, which the caller renders as unknown.
 */
export function readHealthBody(body: unknown, expectedBusinessId: string): ShopifyHealthView | null {
  const root = record(body);
  if (!root) return null;
  if (typeof root.businessId !== "string" || root.businessId !== expectedBusinessId) return null;

  // The health core. Without it there is no claim to make.
  const status = record(root.status);
  if (!status) return null;
  if (typeof status.state !== "string" || !status.state.trim()) return null;
  if (typeof status.connected !== "boolean") return null;

  // `auth` is optional, but if present it must be an object.
  const authRaw = root.auth;
  if (authRaw !== undefined && authRaw !== null && !record(authRaw)) return null;
  const auth = record(authRaw);

  /** Absent is fine; present-but-wrong-type is malformed, not "not reported". */
  const optionalString = (value: unknown): string | null | undefined =>
    value === undefined || value === null ? null : typeof value === "string" ? value : undefined;
  const optionalBoolean = (value: unknown): boolean | null | undefined =>
    value === undefined || value === null ? null : typeof value === "boolean" ? value : undefined;

  const shopDomain = optionalString(auth?.shopDomain);
  const tokenValid = optionalBoolean(auth?.tokenValid);
  const tokenValidationError = optionalString(auth?.tokenValidationError);
  const productionMode = optionalString(auth?.productionMode);
  if (
    shopDomain === undefined ||
    tokenValid === undefined ||
    tokenValidationError === undefined ||
    productionMode === undefined
  ) {
    return null;
  }

  const missingRequiredRaw = auth?.missingRequiredScopes;
  if (missingRequiredRaw !== undefined && !Array.isArray(missingRequiredRaw)) return null;
  const missingRequired = Array.isArray(missingRequiredRaw) ? missingRequiredRaw : [];
  if (missingRequired.some((scope) => typeof scope !== "string")) return null;

  const blockers: string[] = [];
  for (const scope of missingRequired) {
    blockers.push(`Missing required scope: ${String(scope)}`);
  }
  if (auth?.historicalCoverageBlockedByMissingReadAllOrders === true) {
    blockers.push("Historical coverage is blocked by a missing read_all_orders scope.");
  }
  if (auth?.returnsRepairBlockedByMissingReadReturns === true) {
    blockers.push("Returns repair is blocked by a missing read_returns scope.");
  }
  if (tokenValid === false) {
    blockers.push("The stored access token did not validate.");
  }

  return {
    businessId: root.businessId,
    state: status.state,
    connected: status.connected,
    shopDomain,
    tokenValid,
    tokenValidationError,
    productionMode,
    blockers,
  };
}

type RecheckState =
  | { kind: "idle" }
  | { kind: "confirmed"; at: string; health: ShopifyHealthView }
  | { kind: "failed"; detail: string };

export function OpsIncidentSurface({ businessId }: { businessId?: string }) {
  const contract = REPAIR_ENDPOINTS.shopify_integration;
  const [businesses, setBusinesses] = useState<AdminBusiness[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(businessId ?? "");
  const [recheck, setRecheck] = useState<RecheckState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchAllAdminBusinesses(async (url) => {
        const response = await fetch(url, { cache: "no-store" }).catch(() => null);
        if (!response?.ok) return null;
        return response.json().catch(() => null);
      });
      if (cancelled) return;
      if (result.readFailed) {
        setListError("The workspace list could not be read, so no repair can be scoped.");
        setBusinesses([]);
        return;
      }
      setBusinesses(result.businesses);
      setListError(
        result.partial
          ? "Some pages of the workspace list could not be read, so this list is incomplete."
          : null,
      );
    })();
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
    // Must be this workspace's health. A body for another business — or one
    // this surface cannot read — leaves the current state unknown.
    const health = readHealthBody(body, selected);
    if (!health) {
      setRecheck({
        kind: "failed",
        detail:
          "The health check did not return readable health for the selected workspace. The current state is unknown.",
      });
      return;
    }
    setRecheck({ kind: "confirmed", at: new Date().toISOString(), health });
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
          <div role="status" data-ops-rechecked="" style={{ marginTop: 8 }}>
            <p style={{ margin: 0, fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
              Health re-read at {recheck.at} for {selectedName}.
            </p>
            {/* The state this GET actually returned. Pointing the operator at a
                separate legacy board would be pointing them at something this
                read did not update. */}
            <dl data-ops-health="" style={{ margin: "4px 0 0", fontSize: 12.5, display: "grid", gap: 2 }}>
              <div>
                <dt style={{ display: "inline", fontWeight: 600 }}>Condition: </dt>
                <dd data-health-state="" style={{ display: "inline", margin: 0 }}>
                  {recheck.health.state}
                  {recheck.health.connected ? "" : " (not connected)"}
                </dd>
              </div>
              <div>
                <dt style={{ display: "inline", fontWeight: 600 }}>Shop: </dt>
                <dd data-health-shop="" style={{ display: "inline", margin: 0 }}>
                  {recheck.health.shopDomain ?? "not reported"}
                </dd>
              </div>
              <div>
                <dt style={{ display: "inline", fontWeight: 600 }}>Token: </dt>
                <dd data-health-token="" style={{ display: "inline", margin: 0 }}>
                  {recheck.health.tokenValid === null
                    ? "not reported"
                    : recheck.health.tokenValid
                      ? "valid"
                      : `invalid — ${recheck.health.tokenValidationError ?? "no reason reported"}`}
                </dd>
              </div>
              <div>
                <dt style={{ display: "inline", fontWeight: 600 }}>Serving mode: </dt>
                <dd data-health-mode="" style={{ display: "inline", margin: 0 }}>
                  {recheck.health.productionMode ?? "not reported"}
                </dd>
              </div>
            </dl>
            {recheck.health.blockers.length > 0 ? (
              <ul data-ops-health-blockers="" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {recheck.health.blockers.map((blocker) => (
                  <li key={blocker} style={{ fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
                    {blocker}
                  </li>
                ))}
              </ul>
            ) : (
              <p data-ops-health-clear="" style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                This read reported no blockers.
              </p>
            )}
          </div>
        ) : recheck.kind === "failed" ? (
          <p role="status" data-ops-recheck-failed="" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ledger-semantic-warn)" }}>
            {recheck.detail}
          </p>
        ) : null}
      </div>
    </section>
  );
}
