"use client";

import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";
import { Suspense, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAppStore } from "@/store/app-store";
import {
  INTEGRATION_PROVIDERS,
  IntegrationProvider,
  useIntegrationsStore,
} from "@/store/integrations-store";
import { getProviderLabel } from "@/components/integrations/oauth";
import { ProductPageShell, ProductSection, StateBanner } from "@/components/ui/product-surface";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { sanitizeNextPath } from "@/lib/auth-routing";

function IntegrationCallbackPageClient() {
  const router = useRouter();
  const params = useParams<{ provider: string }>();
  const searchParams = useSearchParams();

  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const selectBusiness = useAppStore((state) => state.selectBusiness);
  const businessId = searchParams.get("businessId") ?? selectedBusinessId;
  const returnTo = sanitizeNextPath(searchParams.get("returnTo")) ?? "/integrations";

  const ensureBusiness = useIntegrationsStore((state) => state.ensureBusiness);
  const setConnected = useIntegrationsStore((state) => state.setConnected);
  const setError = useIntegrationsStore((state) => state.setError);
  const setToast = useIntegrationsStore((state) => state.setToast);

  const providerParam = params.provider;
  const provider = (
    INTEGRATION_PROVIDERS.includes(providerParam as IntegrationProvider)
      ? providerParam
      : "meta"
  ) as IntegrationProvider;
  const providerLabel = getProviderLabel(provider);
  const statusParam = searchParams.get("status");
  const errorParam = searchParams.get("error");

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    async function applyCallbackState() {
      if (!businessId) {
        router.replace(businesses.length > 0 ? returnTo : "/businesses/new");
        return;
      }

      selectBusiness(businessId);
      ensureBusiness(businessId);
      const switchResponse = await fetch("/api/auth/switch-business", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId }),
      }).catch(() => null);

      if (!switchResponse?.ok) {
        logClientAuthEvent("oauth_callback_business_sync_failed", {
          businessId,
          provider,
        });
      }

      if (cancelled) return;

      const integrationId = searchParams.get("integrationId") ?? undefined;

      if (statusParam === "success") {
        // Section 9: recovery completed. Paired with the started event on the
        // Integrations card, this is what makes a recovery rate measurable.
        emitProductInstrumentation({
          eventName: "provider_health_recovery_completed",
          surface: "integrations",
          outcome: "ok",
          scope: "business",
          businessId,
          provider: provider === "google" ? "google" : "meta",
        });
        const integrationResponse = await fetch(
          `/api/integrations?businessId=${encodeURIComponent(businessId)}&provider=${encodeURIComponent(provider)}`,
          { cache: "no-store", headers: { "Cache-Control": "no-store" } }
        ).catch(() => null);
        const integrationPayload = (await integrationResponse?.json().catch(() => null)) as
          | {
              integration?: {
                id?: string;
                status?: string;
                connected_at?: string | null;
                updated_at?: string | null;
                provider_account_id?: string | null;
                provider_account_name?: string | null;
              } | null;
            }
          | null;
        const integration = integrationPayload?.integration;
        if (!integrationResponse?.ok || integration?.status !== "connected") {
          const message = `${providerLabel} connection could not be verified. Please refresh and try again.`;
          setError(businessId, provider, message);
          setToast({
            type: "error",
            message,
          });
          timeoutId = setTimeout(() => router.replace(returnTo), 1200);
          return;
        }

        setConnected(businessId, provider, integration.id ?? integrationId, {
          connectedAt: integration.connected_at ?? undefined,
          lastSyncAt: integration.updated_at ?? undefined,
          providerAccountId: integration.provider_account_id ?? null,
          providerAccountName: integration.provider_account_name ?? null,
        });
        setToast({
          type: "success",
          message: `${providerLabel} connected successfully.`,
        });
        logClientAuthEvent("oauth_callback_succeeded", {
          businessId,
          provider,
          integrationId,
          returnTo,
        });
        timeoutId = setTimeout(() => router.replace(returnTo), 800);
        return;
      }

      const message = errorParam ?? "OAuth connection failed. Please try again.";
      setError(businessId, provider, message);
      setToast({
        type: "error",
        message: `${providerLabel} connection failed: ${message}`,
      });
      logClientAuthEvent("oauth_callback_failed", {
        businessId,
        provider,
        message,
        returnTo,
      });
      timeoutId = setTimeout(() => router.replace(returnTo), 1200);
    }

    void applyCallbackState();
    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [
    businessId,
    businesses.length,
    ensureBusiness,
    provider,
    providerLabel,
    returnTo,
    router,
    selectBusiness,
    statusParam,
    errorParam,
    searchParams,
    setConnected,
    setError,
    setToast,
  ]);

  return (
    <ProductPageShell
      eyebrow="Integration callback"
      title="Processing authorization"
      description={`Applying the ${providerLabel} authorization result to the selected workspace.`}
      className="max-w-3xl"
    >
      <StateBanner
        tone={statusParam === "success" ? "success" : "danger"}
        title={statusParam === "success" ? "Connection verified" : "Connection failed"}
      >
        {statusParam === "success"
          ? `${providerLabel} connected successfully.`
          : `${providerLabel} connection failed${errorParam ? `: ${errorParam}` : "."}`}
      </StateBanner>
      <ProductSection title="OAuth callback" description="You will be redirected when the provider state is saved.">
        <p className="text-sm text-neutral-500">
          Processing {providerLabel} authorization result...
        </p>
      </ProductSection>
    </ProductPageShell>
  );
}

function IntegrationCallbackFallback() {
  return (
    <ProductPageShell
      eyebrow="Integration callback"
      title="OAuth callback"
      description="Preparing authorization context..."
      className="max-w-3xl"
    >
      <ProductSection>
        <div className="h-2 rounded-full bg-neutral-100" />
      </ProductSection>
    </ProductPageShell>
  );
}

export default function IntegrationCallbackPage() {
  return (
    <Suspense fallback={<IntegrationCallbackFallback />}>
      <IntegrationCallbackPageClient />
    </Suspense>
  );
}
