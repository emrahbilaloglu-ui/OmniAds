"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore, type Business } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { AuthSurface } from "@/components/auth/auth-surface";
import { AuthOnboardingArc } from "@/components/auth/onboarding-arc";
import { CURRENCY_OPTIONS } from "@/components/business/BusinessForm";

/** The same ISO 4217 shape `PATCH /api/businesses/{id}` refuses on the server. */
const ISO_4217_ALPHABETIC = /^[A-Z]{3}$/;

interface WorkspaceRow {
  id: string;
  name: string;
  timezone: string | null;
  timezoneSource?: Business["timezoneSource"];
  currency: string;
  isDemoBusiness?: boolean;
  /** Present on `/api/businesses`; the client store deliberately drops it. */
  role?: string;
}

export default function SelectBusinessPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceOwnerId = useAppStore((state) => state.workspaceOwnerId);
  const selectBusiness = useAppStore((state) => state.selectBusiness);
  const deleteBusiness = useAppStore((state) => state.deleteBusiness);
  const setWorkspaceSnapshot = useAppStore((state) => state.setWorkspaceSnapshot);
  const byBusinessId = useIntegrationsStore((state) => state.byBusinessId);
  const assignedAccountsByBusiness = useIntegrationsStore((state) => state.assignedAccountsByBusiness);
  const removeBusinessData = useIntegrationsStore((state) => state.removeBusinessData);
  const [confirmBusinessId, setConfirmBusinessId] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [roleByBusinessId, setRoleByBusinessId] = useState<Record<string, string>>({});
  const [editBusinessId, setEditBusinessId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCurrency, setEditCurrency] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  const confirmBusiness = useMemo(
    () => businesses.find((business) => business.id === confirmBusinessId) ?? null,
    [businesses, confirmBusinessId]
  );
  const editBusiness = useMemo(
    () => businesses.find((business) => business.id === editBusinessId) ?? null,
    [businesses, editBusinessId]
  );
  const isDemoOnlyWorkspace = businesses.length === 1 && Boolean(businesses[0]?.isDemoBusiness);

  const hasLinkedData = useMemo(() => {
    if (!confirmBusiness) return false;
    const integrations = byBusinessId[confirmBusiness.id];
    const hasConnectedIntegration = integrations
      ? Object.values(integrations).some((item) => item.status !== "disconnected")
      : false;
    const assignedCount = Object.values(assignedAccountsByBusiness[confirmBusiness.id] ?? {}).reduce(
      (sum, ids) => sum + (ids?.length ?? 0),
      0
    );
    return hasConnectedIntegration || assignedCount > 0;
  }, [assignedAccountsByBusiness, byBusinessId, confirmBusiness]);

  /**
   * Reads each workspace's membership role from the endpoint the store is built
   * from.
   *
   * `PATCH /api/businesses/{id}` requires `admin`, and the client store drops
   * `role` when the bootstrap maps the payload into it
   * (`components/layout/auth-bootstrap.tsx:143-153`), so the rename control asks
   * `/api/businesses` rather than assuming. A read that does not land leaves the
   * control hidden: the route is the authority either way, but an unread role is
   * not a permission.
   */
  const readWorkspaces = useCallback(async () => {
    const response = await fetch("/api/businesses", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return null;
    const payload = (await response.json().catch(() => null)) as {
      businesses?: WorkspaceRow[];
      activeBusinessId?: string | null;
    } | null;
    const rows = payload?.businesses;
    if (!Array.isArray(rows)) return null;
    setRoleByBusinessId(
      Object.fromEntries(rows.map((row) => [row.id, typeof row.role === "string" ? row.role : ""]))
    );
    return rows;
  }, []);

  useEffect(() => {
    void readWorkspaces();
  }, [readWorkspaces]);

  /**
   * The delete ceremony's own gate — a demo workspace is refused by the route
   * too — plus the role that route requires. `admin` is the top weight in
   * `ROLE_WEIGHT`, so this is exactly `hasRole("admin", role)`.
   */
  function canEditWorkspace(business: Business) {
    return !business.isDemoBusiness && roleByBusinessId[business.id] === "admin";
  }

  /**
   * The product's currency list, plus the workspace's own stored code when it
   * predates that list — so opening the form can never silently redenominate a
   * workspace. A stored value that is not an ISO 4217 code is not offered at
   * all; it has to be replaced with a real one before the form will save.
   */
  function currencyOptionsFor(business: Business) {
    const stored = business.currency?.trim().toUpperCase() ?? "";
    return ISO_4217_ALPHABETIC.test(stored) && !CURRENCY_OPTIONS.includes(stored)
      ? [stored, ...CURRENCY_OPTIONS]
      : CURRENCY_OPTIONS;
  }

  function getAssignedAccountCount(businessId: string) {
    return Object.values(assignedAccountsByBusiness[businessId] ?? {}).reduce(
      (sum, ids) => sum + (ids?.length ?? 0),
      0,
    );
  }

  function getStatusTone(businessId: string, isDemoBusiness?: boolean) {
    if (isDemoBusiness) return "pos";
    const accountCount = getAssignedAccountCount(businessId);
    if (accountCount > 0) return "pos";
    const integrations = byBusinessId[businessId];
    const hasConnectedIntegration = integrations
      ? Object.values(integrations).some((item) => item.status !== "disconnected")
      : false;
    return hasConnectedIntegration ? "caution" : "danger";
  }

  function getPostSwitchDestination() {
    const query = searchParams.toString();
    const candidate = `${pathname}${query ? `?${query}` : ""}`;
    const sanitized = sanitizeNextPath(candidate);
    if (!sanitized) return "/overview";
    if (
      sanitized === "/" ||
      sanitized.startsWith("/login") ||
      sanitized.startsWith("/signup") ||
      sanitized.startsWith("/select-language") ||
      sanitized.startsWith("/businesses/new") ||
      sanitized.startsWith("/select-business")
    ) {
      return "/overview";
    }
    return sanitized;
  }

  async function handleSelect(id: string) {
    if (id === selectedBusinessId || deleteLoading) return;

    const previousBusinessId = selectedBusinessId;
    const destination = getPostSwitchDestination();
    selectBusiness(id);

    const response = await fetch("/api/auth/switch-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: id }),
    }).catch(() => null);

    if (!response?.ok) {
      selectBusiness(previousBusinessId ?? null);
      setFeedback({ type: "error", message: "Could not switch business." });
      logClientAuthEvent("select_business_failed", {
        attemptedBusinessId: id,
        previousBusinessId,
      });
      return;
    }

    logClientAuthEvent("select_business_succeeded", { activeBusinessId: id });
    router.push(destination);
    router.refresh();
  }

  /**
   * The only surface that renames a workspace or changes its currency.
   *
   * Dashboard v2's Settings screen is Full name, Email, Interface language and
   * Workspace timezone; it defines no workspace name or currency field, so this
   * lives beside the delete ceremony — the other workspace-level operation this
   * page already owns — and calls the untouched `PATCH /api/businesses/{id}`.
   */
  async function handleSaveWorkspace() {
    if (!editBusiness) return;
    const name = editName.trim();
    const currency = editCurrency.trim().toUpperCase();
    if (name.length < 2) {
      setFeedback({ type: "error", message: "Workspace name needs at least two characters." });
      return;
    }
    if (!ISO_4217_ALPHABETIC.test(currency) || !currencyOptionsFor(editBusiness).includes(currency)) {
      setFeedback({ type: "error", message: "Choose a supported currency." });
      return;
    }

    setEditLoading(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/businesses/${encodeURIComponent(editBusiness.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, currency }),
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Could not save the workspace.");
      }

      // Nothing is claimed saved on the strength of the write alone: the list is
      // re-read, and what it serves is what the page then shows.
      const rows = await readWorkspaces();
      if (rows && workspaceOwnerId) {
        setWorkspaceSnapshot(workspaceOwnerId, rows, selectedBusinessId);
      }
      setEditBusinessId(null);
      setFeedback({ type: "success", message: "Workspace saved." });
    } catch (error: unknown) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Could not save the workspace.",
      });
    } finally {
      setEditLoading(false);
    }
  }

  async function handleDeleteBusiness() {
    if (!confirmBusiness) return;
    setDeleteLoading(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/businesses/${encodeURIComponent(confirmBusiness.id)}`, {
        method: "DELETE",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Could not delete business.");
      }

      const nextSelected = deleteBusiness(confirmBusiness.id);
      removeBusinessData(confirmBusiness.id);
      if (nextSelected && selectedBusinessId === confirmBusiness.id) {
        selectBusiness(nextSelected);
        await fetch("/api/auth/switch-business", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessId: nextSelected }),
        }).catch(() => null);
      }

      setConfirmBusinessId(null);
      setConfirmInput("");
      setFeedback({ type: "success", message: "Business deleted." });
    } catch (error: unknown) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Could not delete business.",
      });
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <AuthSurface
      title="Choose a business"
      description="Select the business scope before integrations, reports, and automation controls."
      width="lg"
      embedded
    >
      <div className="ad-auth-form">
        {feedback ? (
          <p className={`ad-auth-alert ${feedback.type === "success" ? "ad-auth-alert-positive" : "ad-auth-alert-danger"}`}>
            {feedback.message}
          </p>
        ) : null}

        {businesses.length > 0 ? (
          <>
          {businesses.map((business) => {
            const isSelected = business.id === selectedBusinessId;
            const accountCount = getAssignedAccountCount(business.id);
            const tone = getStatusTone(business.id, business.isDemoBusiness);

            return (
              <div key={business.id} className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleSelect(business.id)}
                  className="ad-auth-business-row"
                >
                  <span className="ad-auth-business-name">
                    <span className={`ad-auth-dot ad-auth-dot-${tone}`} aria-hidden="true" />
                    <span className="truncate">
                      {business.name}
                      {business.isDemoBusiness ? <span className="ad-auth-mono"> · demo</span> : null}
                    </span>
                  </span>
                  <span className="ad-auth-mono">
                    {business.currency} · {accountCount} {accountCount === 1 ? "account" : "accounts"}
                    {isSelected ? " · current" : ""}
                  </span>
                </button>
                {canEditWorkspace(business) ? (
                  <button
                    type="button"
                    className="ad-auth-secondary shrink-0 px-3"
                    data-workspace-edit={business.id}
                    onClick={() => {
                      const stored = business.currency?.trim().toUpperCase() ?? "";
                      setConfirmBusinessId(null);
                      setConfirmInput("");
                      setEditBusinessId(business.id);
                      setEditName(business.name);
                      setEditCurrency(ISO_4217_ALPHABETIC.test(stored) ? stored : "");
                      setFeedback(null);
                    }}
                  >
                    Edit
                  </button>
                ) : null}
                {!business.isDemoBusiness ? (
                  <button
                    type="button"
                    className="ad-auth-secondary shrink-0 px-3"
                    onClick={() => {
                      setConfirmBusinessId(business.id);
                      setConfirmInput("");
                      setEditBusinessId(null);
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            );
          })}
          </>
        ) : (
          <div className="ad-auth-alert ad-auth-alert-caution">
            Create your first business to start integrations.
          </div>
        )}

        {isDemoOnlyWorkspace ? (
          <p className="ad-auth-mono">
            This account is restricted to the Adsecute demo workspace.
          </p>
        ) : (
          <button type="button" className="ad-auth-dashed" onClick={() => router.push("/businesses/new")}>
            + Create business
          </button>
        )}

        {editBusiness ? (
          <div className="ad-auth-alert" data-workspace-edit-form="">
            <p>
              Rename <span className="font-semibold">{editBusiness.name}</span>, or change the
              currency its figures are denominated in.
            </p>
            <label className="ad-auth-label mt-3">
              Workspace name
              <input
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                className="ad-auth-input"
              />
            </label>
            <label className="ad-auth-label mt-3">
              Currency
              <select
                value={editCurrency}
                onChange={(event) => setEditCurrency(event.target.value)}
                className="ad-auth-select"
              >
                {editCurrency === "" ? <option value="">Select a currency</option> : null}
                {currencyOptionsFor(editBusiness).map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="ad-auth-secondary flex-1"
                onClick={() => {
                  if (editLoading) return;
                  setEditBusinessId(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ad-auth-primary flex-1"
                disabled={editLoading}
                onClick={handleSaveWorkspace}
              >
                {editLoading ? "Saving workspace..." : "Save workspace"}
              </button>
            </div>
          </div>
        ) : null}

        {confirmBusiness ? (
          <div className="ad-auth-alert ad-auth-alert-caution">
            <p>
              Delete requires typing <span className="font-semibold">{confirmBusiness.name}</span>.
              This removes the linked workspace context.
            </p>
            {hasLinkedData ? (
              <p className="mt-1">
                Connected integrations, assigned accounts, and related share snapshots for this business will also be removed.
              </p>
            ) : null}
            <label className="ad-auth-label mt-3">
              Type business name
              <input
                value={confirmInput}
                onChange={(event) => setConfirmInput(event.target.value)}
                className="ad-auth-input"
              />
            </label>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="ad-auth-secondary flex-1"
                onClick={() => {
                  if (deleteLoading) return;
                  setConfirmBusinessId(null);
                  setConfirmInput("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ad-auth-danger-button flex-1"
                disabled={
                  deleteLoading ||
                  confirmInput.trim() !== confirmBusiness.name
                }
                onClick={handleDeleteBusiness}
              >
                {deleteLoading ? "Deleting business..." : "Delete business"}
              </button>
            </div>
          </div>
        ) : null}

        <AuthOnboardingArc compact />
      </div>
    </AuthSurface>
  );
}
