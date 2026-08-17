"use client";

/**
 * `/settings` — the Dashboard v2 Settings screen.
 *
 * The design defines one field card, one plan band and exactly three action
 * rows. Password change is a row with one button, so it navigates to the
 * account-security surface instead of unfolding a form the design never draws;
 * the destructive workspace actions the app used to keep here belong to the
 * workspace-management surface, not to a preferences screen.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { SettingsExact } from "@/components/settings/SettingsExact";
import {
  buildSettingsExactModel,
  type SettingsRowId,
} from "@/components/settings/settings-exact-adapter";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { clearAuthScopedClientState } from "@/lib/client-auth-state";
import { isDemoBusinessId } from "@/lib/demo-business";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { type PlanId } from "@/lib/pricing/plans";
import { fetchSettingsAccount } from "@/app/(dashboard)/settings/settings-support";
import { useAppStore } from "@/store/app-store";
import { usePreferencesStore } from "@/store/preferences-store";

interface BillingResponse {
  planId?: PlanId;
  planName?: string;
  monthlyPrice?: number;
  managedPricingUrl?: string | null;
}

export default function SettingsPage() {
  const router = useRouter();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const language = usePreferencesStore((state) => state.language);
  const setLanguage = usePreferencesStore((state) => state.setLanguage);

  const activeBusiness =
    businesses.find((business) => business.id === selectedBusinessId) ?? null;

  const [accountName, setAccountName] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [billing, setBilling] = useState<BillingResponse | null>(null);
  const [billingUnavailable, setBillingUnavailable] = useState(false);
  const [flash, setFlash] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busyRow, setBusyRow] = useState<SettingsRowId | null>(null);

  /**
   * When this page's reads last resolved.
   *
   * Settings has no single upstream timestamp, so the honest as-of is the age
   * of the read itself. It is stamped only on success: a failed reload must not
   * refresh the age of data it did not replace.
   */
  const [settingsReadAt, setSettingsReadAt] = useState<string | null>(null);
  const [settingsReadError, setSettingsReadError] = useState<string | null>(null);

  useEffect(() => {
    if (!flash) return;
    const timeout = setTimeout(() => setFlash(null), 3200);
    return () => clearTimeout(timeout);
  }, [flash]);

  const loadAccount = useCallback(async () => {
    try {
      const user = await fetchSettingsAccount();
      setSettingsReadError(null);
      setAccountName(user.name ?? "");
      setAccountEmail(user.email ?? "");
      setSettingsReadAt(new Date().toISOString());
    } catch (error: unknown) {
      setSettingsReadError(
        error instanceof Error ? error.message : "Could not load account settings.",
      );
    }
  }, []);

  const loadBilling = useCallback(async () => {
    if (!selectedBusinessId) return;
    try {
      const response = await fetch(
        `/api/billing?businessId=${encodeURIComponent(selectedBusinessId)}`,
      );
      const data = (await response.json().catch(() => null)) as BillingResponse | null;
      if (response.ok && data) {
        setBilling(data);
        setBillingUnavailable(false);
      } else {
        setBillingUnavailable(true);
      }
    } catch {
      setBillingUnavailable(true);
    }
  }, [selectedBusinessId]);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  useEffect(() => {
    if (!selectedBusinessId) return;
    void loadBilling();
  }, [loadBilling, selectedBusinessId]);

  useTierZeroFreshness({
    surface: "settings",
    isLoading: settingsReadAt === null && settingsReadError === null,
    error: settingsReadError,
    asOf: measuredAsOf(settingsReadAt),
    partialReason: billingUnavailable
      ? "Plan and billing could not be read; this view is incomplete"
      : null,
    businessId: selectedBusinessId || null,
    onRetry: () => {
      void loadAccount();
      if (!selectedBusinessId) return;
      void loadBilling();
    },
  });

  const model = useMemo(
    () =>
      buildSettingsExactModel({
        account: { name: accountName, email: accountEmail },
        language,
        workspace: {
          timezone: activeBusiness?.timezone ?? null,
          timezoneSource: activeBusiness?.timezoneSource ?? null,
        },
        billing: {
          planId: billing?.planId ?? null,
          planName: billing?.planName ?? null,
          monthlyPrice: billing?.monthlyPrice ?? null,
          managedPricingAvailable: Boolean(billing?.managedPricingUrl),
          unavailable: billingUnavailable,
        },
      }),
    [
      accountEmail,
      accountName,
      activeBusiness?.timezone,
      activeBusiness?.timezoneSource,
      billing?.managedPricingUrl,
      billing?.monthlyPrice,
      billing?.planId,
      billing?.planName,
      billingUnavailable,
      language,
    ],
  );

  async function commitName() {
    try {
      const response = await fetch("/api/settings/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: accountName }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { user?: { name?: string }; message?: string }
        | null;
      if (!response.ok || !payload?.user) {
        throw new Error(payload?.message ?? "Could not update account settings.");
      }
      setAccountName(payload.user.name ?? accountName);
      setFlash({ tone: "success", text: "Account settings updated." });
      router.refresh();
    } catch (error: unknown) {
      setFlash({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not update account settings.",
      });
    }
  }

  async function runRow(row: SettingsRowId) {
    if (row === "password") {
      router.push("/me/account-security");
      return;
    }
    setBusyRow(row);
    try {
      if (row === "sessions") {
        const response = await fetch("/api/settings/security/revoke-sessions", {
          method: "POST",
        });
        if (!response.ok) throw new Error("Could not revoke sessions.");
        clearAuthScopedClientState();
        window.location.assign("/login");
        return;
      }
      if (!selectedBusinessId) return;
      if (isDemoBusinessId(selectedBusinessId)) {
        setFlash({
          tone: "success",
          text: "Demo workspace already uses fixture-backed data.",
        });
        return;
      }
      await fetch(`/api/integrations?businessId=${encodeURIComponent(selectedBusinessId)}`, {
        cache: "no-store",
      });
      setFlash({ tone: "success", text: "Warehouse resync requested." });
    } catch (error: unknown) {
      setFlash({
        tone: "error",
        text: error instanceof Error ? error.message : "Action failed.",
      });
    } finally {
      setBusyRow(null);
    }
  }

  return (
    <SettingsExact
      model={model}
      flash={flash}
      busyRow={busyRow}
      onNameChange={setAccountName}
      onNameCommit={() => void commitName()}
      onLanguageChange={(value) => setLanguage(value)}
      onRowAction={(row) => void runRow(row)}
      onUpgrade={() => {
        if (billing?.managedPricingUrl) window.location.href = billing.managedPricingUrl;
      }}
    />
  );
}
