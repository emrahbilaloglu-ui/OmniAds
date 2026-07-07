"use client";

import { useState } from "react";
import { BusinessForm } from "@/components/business/BusinessForm";
import { useAppStore } from "@/store/app-store";
import { useRouter } from "next/navigation";

export default function NewBusinessPage() {
  const router = useRouter();
  const setWorkspaceSnapshot = useAppStore((state) => state.setWorkspaceSnapshot);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mx-auto w-full max-w-xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Create business</h1>
        <p className="text-sm text-muted-foreground">
          Add a business workspace before connecting integrations and linked accounts.
        </p>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-5">
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
        {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
