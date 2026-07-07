"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  getOAuthStartUrl,
  getProviderLabel,
  OAUTH_PERMISSIONS,
} from "@/components/integrations/oauth";
import { IntegrationProvider } from "@/store/integrations-store";
import { X } from "lucide-react";

interface ConnectModalProps {
  provider: IntegrationProvider | null;
  businessId: string;
  onClose: () => void;
  onContinue: (provider: IntegrationProvider) => void;
}

export function ConnectModal({
  provider,
  businessId,
  onClose,
  onContinue,
}: ConnectModalProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (!provider) return null;

  // Local const so TypeScript narrows the type inside closures too.
  const activeProvider: IntegrationProvider = provider;

  const isShopify = activeProvider === "shopify";
  const providerLabel = getProviderLabel(activeProvider);
  const permissions = OAUTH_PERMISSIONS[activeProvider];
  const currentSearch = searchParams.toString();
  const returnTo =
    pathname === "/"
      ? "/integrations"
      : `${pathname}${currentSearch ? `?${currentSearch}` : ""}`;

  function handleContinue() {
    const startUrl = isShopify
      ? "https://apps.shopify.com/adsecute"
      : getOAuthStartUrl(activeProvider, businessId, returnTo);
    onContinue(activeProvider);
    window.location.href = startUrl;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-5 shadow-lg">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Connect {providerLabel}</h3>
            <p className="text-sm text-muted-foreground">
              {isShopify
                ? "Shopify installation starts on a Shopify-owned surface. After install, Adsecute will bring the merchant back to finalize workspace selection."
                : `You will be redirected to ${providerLabel} to authorize your account.`}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close modal"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isShopify ? (
          <div className="mb-4 rounded-lg border bg-muted/25 p-4">
            <p className="text-sm font-medium">How to connect Shopify</p>
            <p className="mt-1 text-sm text-muted-foreground">
              This opens the Shopify App Store listing. Shopify handles install first, then Adsecute completes the workspace association after the callback returns.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border bg-muted/25 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Requested permissions
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {permissions.map((permission) => (
                <li key={permission}>- {permission}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleContinue}>Continue</Button>
        </div>
      </div>
    </div>
  );
}
