"use client";

import { useMemo, useState } from "react";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { AuthSurface } from "@/components/auth/auth-surface";
import { AuthOnboardingArc } from "@/components/auth/onboarding-arc";
import { useZeroBaseUi } from "@/components/zero-base/rollout-provider";

export default function SelectBusinessPage() {
  const router = useRouter();
  const { canonical } = useZeroBaseUi();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const selectBusiness = useAppStore((state) => state.selectBusiness);
  const deleteBusiness = useAppStore((state) => state.deleteBusiness);
  const byBusinessId = useIntegrationsStore((state) => state.byBusinessId);
  const assignedAccountsByBusiness = useIntegrationsStore((state) => state.assignedAccountsByBusiness);
  const removeBusinessData = useIntegrationsStore((state) => state.removeBusinessData);
  const [confirmBusinessId, setConfirmBusinessId] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const confirmBusiness = useMemo(
    () => businesses.find((business) => business.id === confirmBusinessId) ?? null,
    [businesses, confirmBusinessId]
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
    // Canonicalise onto the business just chosen. The legacy helper returns a
    // surface-preserving path, which is right for legacy but wrong here: the
    // canonical scope lives in the URL, so the destination must name it.
    const requestedNext = sanitizeNextPath(searchParams.get("next"));
    const destination = canonical
      ? (requestedNext?.startsWith("/app") ? requestedNext : "/app/home")
      : getPostSwitchDestination();
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
                {!business.isDemoBusiness ? (
                  <button
                    type="button"
                    className="ad-auth-secondary shrink-0 px-3"
                    onClick={() => {
                      setConfirmBusinessId(business.id);
                      setConfirmInput("");
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
