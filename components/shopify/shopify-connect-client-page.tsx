"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthBootstrap } from "@/components/layout/auth-bootstrap";
import { BusinessForm } from "@/components/business/BusinessForm";
import { Button } from "@/components/ui/button";
import { ProductSection, StateBanner } from "@/components/ui/product-surface";
import { useAppStore } from "@/store/app-store";
import { applyAuthenticatedWorkspace } from "@/lib/client-auth-state";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { normalizeBindAllOriginForBrowser } from "@/lib/public-url";

const SHOPIFY_APP_STORE_URL = "https://apps.shopify.com/adsecute";

/**
 * Exactly what `GET /api/oauth/shopify/context` still discloses.
 *
 * It used to hand back the context token, the return path, and the created /
 * expiry timestamps as well. This page reads the token from its own URL and the
 * return path from its own query string, and never rendered the timestamps, so
 * none of it was ever consumed — it was disclosure for its own sake, on a route
 * that at the time required no authentication at all.
 */
interface ContextPayload {
  context?: {
    shopDomain: string;
    shopName: string | null;
    preferredBusinessId: string | null;
    currency: string | null;
  };
  message?: string;
}

interface AuthPayload {
  authenticated: boolean;
  user?: {
    id: string;
  };
  businesses?: Array<{
    id: string;
    name: string;
    timezone: string | null;
    timezoneSource?: "shopify" | "ga4" | null;
    currency: string;
    isDemoBusiness?: boolean;
    industry?: string;
    platform?: string;
  }>;
  activeBusinessId?: string | null;
}

function AuthPrompt({ nextPath }: { nextPath: string }) {
  return (
    <ProductSection
      title="Sign in to continue"
      description="Shopify returned an install context. Choose the workspace only after authentication."
    >
      <div className="flex flex-wrap gap-3">
        <Link href={`/login?next=${encodeURIComponent(nextPath)}`}>
          <Button>Sign in</Button>
        </Link>
        <Link href={`/signup?next=${encodeURIComponent(nextPath)}`}>
          <Button variant="outline">Create account</Button>
        </Link>
      </div>
    </ProductSection>
  );
}

export function ShopifyConnectClientPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const businesses = useAppStore((state) => state.businesses);

  const [auth, setAuth] = useState<AuthPayload | null>(null);
  const [contextPayload, setContextPayload] = useState<ContextPayload | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [contextLoading, setContextLoading] = useState(false);
  const [pendingBusinessId, setPendingBusinessId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoFinalizeBusinessIdRef = useRef<string | null>(null);

  const contextToken = searchParams.get("context") ?? "";
  const queryReturnTo = sanitizeNextPath(searchParams.get("returnTo")) ?? "/integrations";
  const nextPath = useMemo(() => {
    const qs = searchParams.toString();
    return qs ? `/shopify/connect?${qs}` : "/shopify/connect";
  }, [searchParams]);
  const context = contextPayload?.context;
  const isAuthenticated = auth?.authenticated === true;
  /** Shopify redirected here with an install, and nobody has proved who they are yet. */
  const awaitingSignIn = Boolean(contextToken) && !authLoading && !isAuthenticated;

  useEffect(() => {
    if (!hasHydrated) return;
    let cancelled = false;
    setAuthLoading(true);
    fetch("/api/auth/me", { cache: "no-store" })
      .then((res) => res.json().catch(() => null).then((payload) => ({ ok: res.ok, payload })))
      .then(({ ok, payload }) => {
        if (cancelled) return;
        if (!ok || !payload?.authenticated) {
          setAuth({ authenticated: false });
          return;
        }
        setAuth(payload as AuthPayload);
        if (payload?.user?.id) {
          applyAuthenticatedWorkspace({
            userId: payload.user.id,
            businesses: payload.businesses ?? [],
            activeBusinessId: payload.activeBusinessId ?? null,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuth({ authenticated: false });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAuthLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasHydrated]);

  // The context read is authenticated now, so asking for it before the session
  // is known would only produce a 401 and an error banner telling a merchant who
  // is one click from signing in that their install had failed.
  useEffect(() => {
    if (!contextToken || !isAuthenticated) {
      setContextPayload(null);
      return;
    }
    let cancelled = false;
    setContextLoading(true);
    fetch(`/api/oauth/shopify/context?token=${encodeURIComponent(contextToken)}`, {
      cache: "no-store",
    })
      .then((res) => res.json().catch(() => null).then((payload) => ({ ok: res.ok, payload })))
      .then(({ ok, payload }) => {
        if (cancelled) return;
        if (!ok) {
          setContextPayload(payload as ContextPayload);
          // Every refusal looks identical from here by design — the route will
          // not tell someone who does not own a token whether it exists — so the
          // copy names the one recovery that works for all of them.
          setError(
            "This Shopify install could not be opened here. It may have expired, or it was started in a different browser or account. Start the install again from Shopify.",
          );
          return;
        }
        setContextPayload(payload as ContextPayload);
        const preferred = (payload as ContextPayload).context?.preferredBusinessId ?? null;
        if (preferred) {
          setPendingBusinessId(preferred);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not load Shopify install context.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setContextLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contextToken, isAuthenticated]);

  useEffect(() => {
    if (!context || !auth?.authenticated || busy) return;
    if (businesses.length !== 1) return;

    const onlyBusiness = businesses[0];
    if (!onlyBusiness) return;
    if (autoFinalizeBusinessIdRef.current === onlyBusiness.id) return;
    autoFinalizeBusinessIdRef.current = onlyBusiness.id;
    setPendingBusinessId(onlyBusiness.id);
    void finalizeConnection(onlyBusiness.id);
  }, [auth?.authenticated, businesses, busy, context]);

  async function refreshWorkspaceState() {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as AuthPayload | null;
    if (!response.ok || !payload?.authenticated || !payload.user?.id) {
      return null;
    }
    applyAuthenticatedWorkspace({
      userId: payload.user.id,
      businesses: payload.businesses ?? [],
      activeBusinessId: payload.activeBusinessId ?? null,
    });
    setAuth(payload);
    return payload;
  }

  async function finalizeConnection(targetBusinessId: string) {
    if (!contextToken) return;
    setBusy(true);
    setError(null);
    const response = await fetch("/api/oauth/shopify/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: contextToken,
        businessId: targetBusinessId,
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          status?: string;
          businessId?: string;
          returnTo?: string;
          integration?: { id: string };
          message?: string;
        }
      | null;
    setBusy(false);

    if (!response.ok || payload?.status !== "success" || !payload.businessId) {
      setError(payload?.message ?? "Could not finalize Shopify connection.");
      return;
    }

    await refreshWorkspaceState();
    const callbackUrl = new URL(
      "/integrations/callback/shopify",
      normalizeBindAllOriginForBrowser(window.location.origin),
    );
    callbackUrl.searchParams.set("status", "success");
    callbackUrl.searchParams.set("businessId", payload.businessId);
    if (payload.integration?.id) {
      callbackUrl.searchParams.set("integrationId", payload.integration.id);
    }
    callbackUrl.searchParams.set("returnTo", payload.returnTo ?? queryReturnTo);
    router.replace(`${callbackUrl.pathname}?${callbackUrl.searchParams.toString()}`);
  }

  async function createBusinessAndFinalize(input: {
    name: string;
    currency: string;
  }) {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/businesses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          business?: { id: string };
          message?: string;
        }
      | null;
    if (!response.ok || !payload?.business?.id) {
      setBusy(false);
      setError(payload?.message ?? "Could not create workspace.");
      return;
    }
    await refreshWorkspaceState();
    await finalizeConnection(payload.business.id);
  }

  return (
    <>
      <AuthBootstrap />
      <main className="min-h-screen bg-neutral-50 px-4 py-10 text-neutral-950">
        <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-3xl items-center">
        <div className="w-full space-y-5">
          <div className="border-b border-neutral-200 pb-4">
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
              Shopify Connect
            </p>
            <h1 className="mt-1 text-[24px] font-semibold tracking-tight">
              {context
                ? "Choose a workspace for this Shopify store"
                : awaitingSignIn
                  ? "Sign in to finish connecting your Shopify store"
                  : "Connect a Shopify store"}
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-neutral-500">
              {context
                ? "Your Shopify install reached Adsecute successfully. Pick the workspace that should own this store connection."
                : awaitingSignIn
                  ? // Nothing about the pending install may be named here: this
                    // is rendered off the token in the visitor's own URL, before
                    // anyone has proved they are entitled to see the store.
                    "Shopify sent you back to Adsecute. Sign in and we will show you the store that is waiting to be connected."
                  : "Shopify installation must start from Shopify App Store or Shopify Admin. Come back here only after Shopify redirects back with an install context."}
            </p>
          </div>

          {error ? (
            <StateBanner tone="danger" title="Connection needs attention">
              {error}
            </StateBanner>
          ) : null}

          {authLoading || !hasHydrated ? (
            <ProductSection>
            <div className="text-sm text-neutral-500">
              Preparing Shopify connection context...
            </div>
            </ProductSection>
          ) : awaitingSignIn ? (
            // The install exists — Shopify redirected here with a token — but
            // nothing about it may be shown before the viewer has an identity to
            // check it against. Sign-in comes first, and the sign-in prompt is
            // rendered off the TOKEN rather than off a loaded context, because
            // the context can no longer be loaded to decide what to render.
            <AuthPrompt nextPath={nextPath} />
          ) : contextLoading ? (
            <ProductSection>
            <div className="text-sm text-neutral-500">
              Preparing Shopify connection context...
            </div>
            </ProductSection>
          ) : context ? (
            isAuthenticated ? (
              <div className="space-y-4">
                <ProductSection>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-semibold text-neutral-950">{context.shopName ?? context.shopDomain}</h2>
                      <p className="text-sm text-neutral-500">{context.shopDomain}</p>
                    </div>
                    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs font-medium text-neutral-600">
                      {context.currency ? `Currency: ${context.currency}` : "Awaiting workspace selection"}
                    </div>
                  </div>
                </ProductSection>

                {businesses.length === 0 ? (
                  <ProductSection
                    title="Create a workspace first"
                    description="We need one workspace to attach this Shopify install."
                  >
                    <div className="mt-4">
                      <BusinessForm onSubmit={createBusinessAndFinalize} />
                    </div>
                  </ProductSection>
                ) : (
                  <ProductSection
                    title="Available workspaces"
                    description="Choose exactly one owner for this store connection."
                  >
                    <div className="mt-4 grid gap-3">
                      {businesses.map((business) => {
                        const recommended =
                          context.preferredBusinessId &&
                          context.preferredBusinessId === business.id;
                        return (
                          <button
                            key={business.id}
                            type="button"
                            onClick={() => {
                              setPendingBusinessId(business.id);
                              void finalizeConnection(business.id);
                            }}
                            disabled={busy}
                            className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white px-4 py-3 text-left transition hover:border-neutral-400 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <div>
                              <p className="font-medium text-neutral-950">{business.name}</p>
                              <p className="text-sm text-neutral-500">
                                {business.timezone ?? "Timezone pending"} · {business.currency}
                              </p>
                            </div>
                            <div className="text-xs text-neutral-500">
                              {busy && pendingBusinessId === business.id
                                ? "Connecting..."
                                : recommended
                                  ? "Recommended"
                                  : "Use workspace"}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </ProductSection>
                )}
              </div>
            ) : (
              <AuthPrompt nextPath={nextPath} />
            )
          ) : (
            <ProductSection
              title="Start from Shopify"
              description="Install Adsecute from a Shopify-owned surface first. After Shopify redirects back, this page will let the merchant log in and choose the workspace that should receive the store connection."
            >
              <div className="flex flex-wrap gap-3">
                <a
                  href={SHOPIFY_APP_STORE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
                >
                  Open App Store listing
                </a>
              </div>
              <p className="mt-4 text-sm text-neutral-500">
                If the install already finished but this page does not show a pending store, the install context may have expired and should be restarted from Shopify.
              </p>
            </ProductSection>
          )}
        </div>
        </div>
      </main>
    </>
  );
}
