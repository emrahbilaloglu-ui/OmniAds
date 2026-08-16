"use client";

/**
 * Container for the Decision Center body.
 *
 * Reads the same endpoint the existing Decisions surface reads
 * (`/api/meta/decisions-workspace`), whose route already builds the canonical
 * presentation with `buildMetaOsDecisionsPresentation`. No new backend, and no
 * second decision path: `payload.os` is the server's word and this only hands
 * it to the body.
 */
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { DecisionCenterBody } from "@/components/meta/decision-center/DecisionCenterBody";
import type { DecisionCenterItem } from "@/components/meta/decision-center/decision-center-contract";
import type { MetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-contract";

interface WorkspaceResponse {
  os?: MetaOsDecisionsPresentation;
  pulse?: { lastSyncAt?: string | null; currency?: string | null } | null;
  scope?: { providerAccountId?: string | null } | null;
  window?: string | null;
  viewer?: { canRunSnapshot?: boolean } | null;
}

function relativeLabel(iso: string | null | undefined) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function DecisionCenterView({
  businessId,
  currency,
}: {
  businessId: string;
  currency?: string | null;
}) {
  const router = useRouter();

  const query = useQuery({
    queryKey: ["meta-decision-center", businessId],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ businessId, surface: "os" });
      const response = await fetch(`/api/meta/decisions-workspace?${params.toString()}`, {
        signal,
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(`decisions-workspace responded ${response.status}`);
      }
      return (await response.json()) as WorkspaceResponse;
    },
  });

  const onCommand = useCallback(
    (item: DecisionCenterItem) => {
      // The server routes the action; the UI only follows where it points.
      if (item.actionIntent === "launchpad") {
        router.push(`/platforms/meta/launchpad?decision=${encodeURIComponent(item.id)}`);
      }
    },
    [router],
  );

  if (query.isPending) {
    return (
      <p className="m-0 text-[12.5px] text-[var(--adv-ink-3)]" role="status">
        Loading the decision snapshot…
      </p>
    );
  }

  if (query.isError || !query.data?.os) {
    // Fail closed and say so: an unreadable snapshot must never render as an
    // empty queue, which would read as "nothing to do".
    return (
      <div className="rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-4">
        <p className="m-0 text-[12.5px] font-semibold text-[var(--adv-ink)]">
          The decision snapshot could not be read.
        </p>
        <p className="m-0 mt-1 text-[12.5px] text-[var(--adv-ink-3)]">
          This is not an empty queue. Nothing is being withheld or approved on your behalf while it is
          unreadable.
        </p>
      </div>
    );
  }

  const payload = query.data;
  const account = payload.scope?.providerAccountId ?? null;

  return (
    <DecisionCenterBody
      presentation={payload.os!}
      accountLabel={account ? `Ad account ${account}` : null}
      currency={payload.pulse?.currency ?? currency ?? null}
      windowLabel={payload.window ?? null}
      lastSyncLabel={relativeLabel(payload.pulse?.lastSyncAt)}
      canRunSnapshot={payload.viewer?.canRunSnapshot ?? false}
      onRunSnapshot={() => void query.refetch()}
      onNewCampaign={() => router.push("/platforms/meta/launchpad")}
      onCommand={onCommand}
    />
  );
}
