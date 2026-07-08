"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";

type OnboardingStepTone = "done" | "active" | "waiting" | "blocked";

export interface AuthOnboardingStep {
  id: "connect" | "accounts" | "sync" | "targets";
  eyebrow: string;
  title: string;
  body: string;
  status: string;
  tone: OnboardingStepTone;
  href?: string;
  action?: string;
}

export function buildAuthOnboardingSteps(input: {
  hasBusiness: boolean;
  metaConnected: boolean;
  assignedAccountCount: number;
  lastSyncValue?: string | null;
}): AuthOnboardingStep[] {
  const hasAssignedAccounts = input.assignedAccountCount > 0;
  const hasKnownSync =
    Boolean(input.lastSyncValue) &&
    input.lastSyncValue !== "—" &&
    input.lastSyncValue?.toLowerCase() !== "ready";

  return [
    {
      id: "connect",
      eyebrow: "STEP 1 OF 4",
      title: "Connect Meta",
      body: "Adsecute reads performance and ranks decisions with evidence. Writes stay confirmation-gated.",
      status: !input.hasBusiness
        ? "Create business first"
        : input.metaConnected
          ? "Connected"
          : "Not connected",
      tone: !input.hasBusiness ? "blocked" : input.metaConnected ? "done" : "active",
      href: input.hasBusiness ? "/integrations" : undefined,
      action: input.metaConnected ? "Review connection" : "Connect in Integrations",
    },
    {
      id: "accounts",
      eyebrow: "STEP 2 OF 4",
      title: "Pick ad accounts",
      body: "Multiple Meta accounts can live under one business. Currencies are shown per account and never merged in totals.",
      status: hasAssignedAccounts
        ? `${input.assignedAccountCount} assigned`
        : input.metaConnected
          ? "Needs account selection"
          : "Waiting for Meta",
      tone: hasAssignedAccounts ? "done" : input.metaConnected ? "active" : "blocked",
      href: input.metaConnected ? "/integrations" : undefined,
      action: hasAssignedAccounts ? "Manage accounts" : "Pick accounts",
    },
    {
      id: "sync",
      eyebrow: "STEP 3 OF 4",
      title: "First sync",
      body: "No fake progress bar, counts, or ETA. This step lights up only from provider/server sync state.",
      status: hasKnownSync ? `Last sync ${input.lastSyncValue}` : "Server status not ready",
      tone: hasKnownSync ? "done" : hasAssignedAccounts ? "waiting" : "blocked",
      href: hasAssignedAccounts ? "/integrations" : undefined,
      action: hasKnownSync ? "Review sync" : "Wait for server report",
    },
    {
      id: "targets",
      eyebrow: "STEP 4 OF 4",
      title: "Set economics",
      body: "Target ROAS and break-even settings are the same commercial truth records the engine reads.",
      status: hasAssignedAccounts ? "Open Targets & Economics" : "Waiting for setup",
      tone: hasAssignedAccounts ? "active" : "blocked",
      href: hasAssignedAccounts ? "/commercial-truth" : undefined,
      action: "Set target ROAS",
    },
  ];
}

export function AuthOnboardingArc({ compact = false }: { compact?: boolean }) {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const selectedBusiness = useMemo(
    () => businesses.find((business) => business.id === selectedBusinessId) ?? null,
    [businesses, selectedBusinessId],
  );
  const metaView = useIntegrationsStore((state) =>
    selectedBusinessId ? state.getProviderViewState(selectedBusinessId, "meta") : null,
  );

  const steps = buildAuthOnboardingSteps({
    hasBusiness: Boolean(selectedBusiness),
    metaConnected: Boolean(metaView?.isConnected),
    assignedAccountCount: metaView?.assignedCount ?? 0,
    lastSyncValue: metaView?.lastSyncValue,
  });

  return (
    <div className={compact ? "ad-auth-onboarding ad-auth-onboarding-compact" : "ad-auth-onboarding"}>
      <div className="ad-auth-onboarding-header">
        <div>
          <div className="ad-auth-eyebrow">ONBOARDING ARC</div>
          <h2>Connect → accounts → first sync → targets</h2>
        </div>
        <span className="ad-auth-onboarding-business">
          {selectedBusiness ? `${selectedBusiness.name} · ${selectedBusiness.currency}` : "No business yet"}
        </span>
      </div>
      <div className="ad-auth-step-grid">
        {steps.map((step) => (
          <section key={step.id} className="ad-auth-step-card" data-tone={step.tone}>
            <div className="ad-auth-step-topline">
              <span>{step.eyebrow}</span>
              <b>{step.status}</b>
            </div>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
            {step.href ? (
              <Link href={step.href} className="ad-auth-step-link">
                {step.action}
              </Link>
            ) : (
              <span className="ad-auth-step-link ad-auth-step-link-disabled">{step.action ?? "Unavailable"}</span>
            )}
          </section>
        ))}
      </div>
      <p className="ad-auth-mono">
        Lands on Decisions with the honest 7-day/no-decisions state until the engine has enough data.
      </p>
    </div>
  );
}
