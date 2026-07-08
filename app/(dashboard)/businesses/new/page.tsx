"use client";

import { useState } from "react";
import { AuthOnboardingArc } from "@/components/auth/onboarding-arc";
import { BusinessForm } from "@/components/business/BusinessForm";
import { AuthSurface } from "@/components/auth/auth-surface";
import { useAppStore } from "@/store/app-store";
import { useRouter } from "next/navigation";

export default function NewBusinessPage() {
  const router = useRouter();
  const setWorkspaceSnapshot = useAppStore((state) => state.setWorkspaceSnapshot);
  const [error, setError] = useState<string | null>(null);

  return (
    <AuthSurface
      title="Create business"
      description="Add a business workspace before connecting integrations and linked accounts."
      width="lg"
      embedded
    >
      <div className="ad-auth-split">
        <div>
          <BusinessForm
            onSubmit={async ({ name, currency }) => {
              setError(null);
              const res = await fetch("/api/businesses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, currency }),
              });
              const payload = (await res.json().catch(() => null)) as
                | {
                    message?: string;
                    business?: { id: string; name: string; timezone: string | null; timezoneSource?: "shopify" | "ga4" | null; currency: string };
                  }
                | null;
              if (!res.ok || !payload?.business) {
                setError(payload?.message ?? "Could not create business.");
                return;
              }
              const allRes = await fetch("/api/businesses", { cache: "no-store" });
              const allPayload = (await allRes.json().catch(() => null)) as
                | {
                    businesses?: Array<{
                      id: string;
                      name: string;
                      timezone: string | null;
                      timezoneSource?: "shopify" | "ga4" | null;
                      currency: string;
                    }>;
                    activeBusinessId?: string | null;
                  }
                | null;
              const workspaceOwnerId = useAppStore.getState().workspaceOwnerId;
              if (allRes.ok && allPayload?.businesses && workspaceOwnerId) {
                setWorkspaceSnapshot(
                  workspaceOwnerId,
                  allPayload.businesses,
                  allPayload.activeBusinessId ?? payload.business.id
                );
              }
              router.push("/integrations");
            }}
          />
          {error ? <p className="ad-auth-alert ad-auth-alert-danger">{error}</p> : null}
        </div>
        <AuthOnboardingArc compact />
      </div>
    </AuthSurface>
  );
}
