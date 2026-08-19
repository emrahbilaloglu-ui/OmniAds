"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { MetaPlatformPage } from "@/components/meta/redesign/MetaPlatformPage";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store/app-store";

interface MetaPageProps {
  businessId?: string | null;
  businessName?: string | null;
  currency?: string | null;
  // The canonical route already resolves the provider account on the server.
  // Forwarding it lets the body fall back to that answer when the client-side
  // accounts read is down, instead of leaving the whole surface empty behind an
  // error for a value the server had already established. It can only fill in,
  // never widen: the resolver refuses an unassigned id and refuses to choose on
  // behalf of a multi-account business.
  serverProviderAccountId?: string | null;
}

/**
 * The route refuses rather than answering for two workspaces at once.
 *
 * `/platforms/meta` has no `[businessId]` segment, so the only business this
 * page can be authorized for is the session's — the one the switcher, the rail,
 * the freshness pill and every shell query already use. When the link names a
 * different one, there is no honest render: showing the link's business puts
 * one workspace's numbers under another workspace's switcher (the observed
 * defect: topbar "IwaStore", body "Grandmix", requests split between the two),
 * and showing the session's business answers a question nobody asked.
 *
 * So it states the disagreement and asks. The switch is performed by the server
 * — `POST /api/auth/switch-business` re-checks reviewer scope and active
 * membership and moves the session itself — which is the only thing that can
 * make the topbar, this body and every request name the same workspace. The
 * query parameter never moves it on its own.
 */
function MetaBusinessScopeRefusal({
  requestedBusinessId,
  requestedBusinessName,
  activeBusinessName,
  canSwitchSession,
}: {
  requestedBusinessId: string;
  requestedBusinessName: string | null;
  activeBusinessName: string | null;
  canSwitchSession: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/platforms/meta";
  const searchParams = useSearchParams();
  const selectBusiness = useAppStore((state) => state.selectBusiness);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);

  const linkedLabel = requestedBusinessName ?? "another workspace";
  const activeLabel = activeBusinessName ?? "the active workspace";

  function continueInActiveWorkspace() {
    const params = new URLSearchParams(
      typeof window === "undefined"
        ? (searchParams?.toString() ?? "")
        : window.location.search,
    );
    params.delete("businessId");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  async function switchSession() {
    if (switching) return;
    setSwitching(true);
    setFailed(false);
    const response = await fetch("/api/auth/switch-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: requestedBusinessId }),
    }).catch(() => null);
    if (!response?.ok) {
      // A refused switch stays refused. The store is not moved to a business
      // the session was not moved to, because that is the split this screen
      // exists to prevent.
      setFailed(true);
      setSwitching(false);
      return;
    }
    selectBusiness(requestedBusinessId);
    setSwitching(false);
    router.refresh();
  }

  return (
    <div
      className="grid min-h-[60vh] place-items-center px-4 py-8"
      data-testid="meta-business-scope-refusal"
    >
      <div className="w-full max-w-xl rounded-xl border border-neutral-200 bg-white p-6 text-center">
        <h2 className="text-[18px] font-semibold tracking-tight text-neutral-950">
          This link names a different workspace
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-neutral-500">
          {canSwitchSession
            ? `The link is scoped to ${linkedLabel}, and ${activeLabel} is active. Nothing is shown until they agree — one workspace's decisions must never be read under another's name.`
            : `The link is scoped to a workspace this account cannot open. ${activeLabel} stays active; nothing from the linked workspace is shown.`}
        </p>
        {failed ? (
          <p className="mx-auto mt-3 max-w-sm text-sm leading-5 text-neutral-500">
            The workspace switch was refused. Nothing changed.
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {canSwitchSession ? (
            <Button
              className="rounded-md"
              disabled={switching}
              onClick={() => void switchSession()}
            >
              {switching ? "Switching…" : `Switch to ${linkedLabel}`}
            </Button>
          ) : null}
          <Button
            variant="outline"
            className="rounded-md"
            onClick={continueInActiveWorkspace}
          >
            {`Continue in ${activeLabel}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function MetaPage({
  businessId: authorizedBusinessId = null,
  businessName: authorizedBusinessName = null,
  currency: authorizedCurrency = null,
  serverProviderAccountId = null,
}: MetaPageProps = {}) {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceResolved = useAppStore((state) => state.workspaceResolved);
  const searchParams = useSearchParams();

  /**
   * Scope comes from the server, never from the query.
   *
   * `authorizedBusinessId` is the canonical route's own server answer. Where
   * there is none — this legacy path — the store is the client copy of one:
   * `/api/auth/me` resolves it from the session, `selectBusiness` refuses any
   * id outside that membership list, and the switcher only writes it after the
   * server has moved the session. A `?businessId=` cannot enter here, so a URL
   * cannot select a workspace, and it cannot desynchronise this body from the
   * switcher above it.
   */
  const businessId = authorizedBusinessId ?? selectedBusinessId;
  const business = businesses.find((item) => item.id === businessId) ?? null;
  const requestedBusinessId = searchParams?.get("businessId")?.trim() || null;

  if (!businessId) return <BusinessEmptyState />;

  if (requestedBusinessId && requestedBusinessId !== businessId) {
    // Before the workspace list has arrived, "you cannot open that" would be a
    // claim made from an empty list. Hold the surface instead of asserting it.
    if (!workspaceResolved && businesses.length === 0) {
      return <div data-meta-scope-binding="pending" aria-hidden="true" />;
    }
    return (
      <MetaBusinessScopeRefusal
        requestedBusinessId={requestedBusinessId}
        requestedBusinessName={
          businesses.find((item) => item.id === requestedBusinessId)?.name ??
          null
        }
        activeBusinessName={authorizedBusinessName ?? business?.name ?? null}
        canSwitchSession={
          authorizedBusinessId === null &&
          businesses.some((item) => item.id === requestedBusinessId)
        }
      />
    );
  }

  return (
    <MetaPlatformPage
      businessId={businessId}
      businessName={authorizedBusinessName ?? business?.name ?? null}
      currency={authorizedCurrency ?? business?.currency ?? null}
      serverProviderAccountId={serverProviderAccountId}
    />
  );
}
