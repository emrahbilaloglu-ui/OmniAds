"use client";

import { useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDropdownBehavior } from "@/hooks/use-dropdown-behavior";

export default function SelectBusinessPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const selectBusiness = useAppStore((state) => state.selectBusiness);
  const deleteBusiness = useAppStore((state) => state.deleteBusiness);
  const byBusinessId = useIntegrationsStore((state) => state.byBusinessId);
  const assignedAccountsByBusiness = useIntegrationsStore((state) => state.assignedAccountsByBusiness);
  const removeBusinessData = useIntegrationsStore((state) => state.removeBusinessData);
  const [menuBusinessId, setMenuBusinessId] = useState<string | null>(null);
  const [confirmBusinessId, setConfirmBusinessId] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  useDropdownBehavior({
    id: "business-actions-menu",
    open: Boolean(menuBusinessId),
    setOpen: (open) => {
      if (!open) setMenuBusinessId(null);
    },
    containerRef: menuWrapRef,
    triggerRef: menuTriggerRef,
  });

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
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Select business</h2>
        <p className="text-sm text-muted-foreground">
          Pick a business to continue with integrations and linked accounts.
        </p>
        {feedback ? (
          <p
            className={cn(
              "text-xs",
              feedback.type === "success" ? "text-emerald-600" : "text-destructive"
            )}
          >
            {feedback.message}
          </p>
        ) : null}
      </div>

      {businesses.length > 0 ? (
        <div className="grid gap-3">
          {businesses.map((business) => {
            const isSelected = business.id === selectedBusinessId;
            const isMenuOpen = menuBusinessId === business.id;

            return (
              <div
                key={business.id}
                className={cn(
                  "flex items-center gap-4 rounded-xl border border-neutral-200 bg-white p-4 transition-colors",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "hover:border-border hover:bg-accent"
                )}
              >
                <button
                  type="button"
                  onClick={() => void handleSelect(business.id)}
                  className="flex min-w-0 flex-1 items-center gap-4 text-left"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-bold text-primary">
                    {business.name
                      .split(" ")
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((part) => part[0]?.toUpperCase() ?? "")
                      .join("")}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {business.name}
                      {business.isDemoBusiness ? (
                        <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                          Demo
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {business.timezone ?? "Timezone pending"} • {business.currency}
                    </p>
                  </div>
                  {isSelected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
                </button>

                <div
                  ref={(node) => {
                    if (isMenuOpen) menuWrapRef.current = node;
                  }}
                  className="relative"
                >
                  <button
                    ref={(node) => {
                      if (isMenuOpen) menuTriggerRef.current = node;
                    }}
                    type="button"
                    aria-label={`More actions for ${business.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuBusinessId((prev) => (prev === business.id ? null : business.id));
                    }}
                    className="rounded-md border p-1.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>

                  {isMenuOpen && !business.isDemoBusiness && (
                    <div className="absolute right-0 top-9 z-40 w-44 rounded-lg border bg-background p-1.5 shadow-lg">
                      <button
                        type="button"
                        onClick={() => {
                          setMenuBusinessId(null);
                          setConfirmBusinessId(business.id);
                          setConfirmInput("");
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete business
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-6 text-center">
          <h3 className="text-base font-semibold">No businesses yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first business to start integrations.
          </p>
        </div>
      )}

      {!isDemoOnlyWorkspace ? (
        <Button variant="outline" className="gap-2" onClick={() => router.push("/businesses/new")}>
          <Plus className="h-4 w-4" />
          Create new business
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          This account is restricted to the Adsecute demo workspace.
        </p>
      )}

      {confirmBusiness ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-5 shadow-lg">
            <h3 className="text-base font-semibold">Delete business?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This will remove <span className="font-medium text-foreground">{confirmBusiness.name}</span> and its linked workspace context.
            </p>
            {hasLinkedData ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Connected integrations, assigned accounts, and related share snapshots for this business will also be removed.
              </p>
            ) : null}

            {hasLinkedData ? (
              <div className="mt-4 space-y-1.5">
                <label className="text-xs font-medium">
                  Type <span className="font-semibold">{confirmBusiness.name}</span> to confirm
                </label>
                <input
                  value={confirmInput}
                  onChange={(event) => setConfirmInput(event.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                />
              </div>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  if (deleteLoading) return;
                  setConfirmBusinessId(null);
                  setConfirmInput("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={
                  deleteLoading ||
                  (hasLinkedData && confirmInput.trim() !== confirmBusiness.name)
                }
                onClick={handleDeleteBusiness}
              >
                {deleteLoading ? "Deleting business..." : "Delete business"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
