"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAppStore } from "@/store/app-store";
import { usePreferencesStore } from "@/store/preferences-store";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { normalizeBindAllOriginForBrowser } from "@/lib/public-url";
import { applyAuthenticatedWorkspace, clearAuthScopedClientState } from "@/lib/client-auth-state";
import type { AppLanguage } from "@/lib/i18n";

interface MeResponse {
  authenticated: boolean;
  user?: {
    id: string;
    language?: AppLanguage;
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

type BootstrapFailureReason =
  | "unauthenticated"
  | "server_error"
  | "network_error"
  | "invalid_payload";

const TRANSIENT_BOOTSTRAP_RETRY_DELAYS_MS = [250, 800];

function isAuthenticatedPayload(
  payload: MeResponse | null,
): payload is MeResponse & { authenticated: true; user: { id: string } } {
  return Boolean(payload?.authenticated && payload.user?.id && Array.isArray(payload.businesses));
}

export function AuthBootstrap() {
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const authBootstrapStatus = useAppStore((state) => state.authBootstrapStatus);
  const setAuthBootstrapStatus = useAppStore((state) => state.setAuthBootstrapStatus);
  const setWorkspaceResolved = useAppStore((state) => state.setWorkspaceResolved);
  const setLanguage = usePreferencesStore((state) => state.setLanguage);
  const pathname = usePathname();
  const latestRequestIdRef = useRef(0);

  useEffect(() => {
    if (!hasHydrated) return;

    let mounted = true;
    const controller = new AbortController();
    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;

    function isStaleRequest() {
      return !mounted || latestRequestIdRef.current !== requestId;
    }

    async function waitBeforeRetry(ms: number) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function load() {
      setAuthBootstrapStatus("loading");
      try {
        for (let attempt = 0; attempt <= TRANSIENT_BOOTSTRAP_RETRY_DELAYS_MS.length; attempt += 1) {
          let payload: MeResponse | null = null;
          let failureReason: BootstrapFailureReason | null = null;
          let failureStatus: number | null = null;

          try {
            const res = await fetch("/api/auth/me", {
              cache: "no-store",
              signal: controller.signal,
              headers: { "Cache-Control": "no-store" },
            });
            payload = (await res.json().catch(() => null)) as MeResponse | null;
            if (isStaleRequest()) {
              logClientAuthEvent("bootstrap_stale_response_ignored", {
                pathname,
                attempt,
                status: res.status,
              });
              return;
            }

            if (res.status === 401 || payload?.authenticated === false) {
              failureReason = "unauthenticated";
              failureStatus = res.status;
            } else if (!res.ok) {
              failureReason = "server_error";
              failureStatus = res.status;
            } else if (!isAuthenticatedPayload(payload)) {
              failureReason = "invalid_payload";
            }
          } catch (error: unknown) {
            if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
              return;
            }
            if (isStaleRequest()) {
              logClientAuthEvent("bootstrap_stale_response_ignored", {
                pathname,
                attempt,
                reason: "network_error",
              });
              return;
            }
            failureReason = "network_error";
            failureStatus = null;
          }

          if (failureReason === "unauthenticated") {
            logClientAuthEvent("bootstrap_cleared_client_state", {
              pathname,
              reason: failureReason,
              status: failureStatus,
            });
            clearAuthScopedClientState();
            return;
          }

          if (!failureReason && payload && isAuthenticatedPayload(payload)) {
            const authenticatedPayload = payload;
            const businesses = (authenticatedPayload.businesses ?? []).map((item) => ({
              id: item.id,
              name: item.name,
              timezone: item.timezone,
              timezoneSource: item.timezoneSource ?? null,
              currency: item.currency,
              isDemoBusiness: item.isDemoBusiness,
              industry: item.industry,
              platform: item.platform,
            }));
            const userId = authenticatedPayload.user?.id;
            if (!userId) {
              logClientAuthEvent("bootstrap_preserved_workspace_after_transient_failure", {
                pathname,
                reason: "invalid_payload",
                status: failureStatus,
              });
              return;
            }
            applyAuthenticatedWorkspace({
              userId,
              businesses,
              activeBusinessId: authenticatedPayload.activeBusinessId ?? null,
            });
            setWorkspaceResolved(true);
            if (authenticatedPayload.user.language) {
              setLanguage(authenticatedPayload.user.language);
            }
            logClientAuthEvent("bootstrap_applied_workspace", {
              pathname,
              userId,
              membershipCount: businesses.length,
              activeBusinessId: authenticatedPayload.activeBusinessId ?? null,
            });
            return;
          }

          logClientAuthEvent("bootstrap_retrying_after_transient_failure", {
            pathname,
            attempt,
            reason: failureReason,
            status: failureStatus,
          });

          if (attempt < TRANSIENT_BOOTSTRAP_RETRY_DELAYS_MS.length) {
            await waitBeforeRetry(TRANSIENT_BOOTSTRAP_RETRY_DELAYS_MS[attempt]);
            if (controller.signal.aborted || isStaleRequest()) return;
            continue;
          }

          logClientAuthEvent("bootstrap_preserved_workspace_after_transient_failure", {
            pathname,
            reason: failureReason,
            status: failureStatus,
          });
          return;
        }
      } catch (error: unknown) {
        if (!mounted || controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        logClientAuthEvent("bootstrap_request_failed", {
          pathname,
          reason: "network_error",
          message: error instanceof Error ? error.message : "unknown_error",
        });
      } finally {
        if (mounted) {
          setAuthBootstrapStatus("ready");
        }
      }
    }
    void load().catch(() => {});
    return () => {
      mounted = false;
      if (!controller.signal.aborted) {
        try {
          controller.abort(new DOMException("auth-bootstrap cleanup", "AbortError"));
        } catch (error: unknown) {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            throw error;
          }
        }
      }
    };
  }, [hasHydrated, pathname, setAuthBootstrapStatus, setLanguage, setWorkspaceResolved]);

  useEffect(() => {
    if (!hasHydrated || authBootstrapStatus !== "ready") return;
    if (pathname === "/shopify/connect") return;

    let cancelled = false;
    async function resumePendingShopifyInstall() {
      const response = await fetch("/api/oauth/shopify/pending", {
        cache: "no-store",
        headers: { "Cache-Control": "no-store" },
      }).catch(() => null);
      if (!response?.ok) return;
      const payload = (await response.json().catch(() => null)) as
        | {
            context?: { token: string; returnTo?: string | null };
          }
        | null;
      const token = payload?.context?.token;
      if (!token || cancelled) return;

      const nextUrl = new URL(
        "/shopify/connect",
        normalizeBindAllOriginForBrowser(window.location.origin),
      );
      nextUrl.searchParams.set("context", token);
      if (payload?.context?.returnTo) {
        nextUrl.searchParams.set("returnTo", payload.context.returnTo);
      }
      window.location.replace(nextUrl.toString());
    }

    void resumePendingShopifyInstall();
    return () => {
      cancelled = true;
    };
  }, [authBootstrapStatus, hasHydrated, pathname]);

  return null;
}
