"use client";

/**
 * Container for the Decision Center body.
 *
 * Reads the same canonical endpoint the existing Decisions surface reads
 * (`/api/meta/decisions-workspace?surface=os`), whose route already builds the
 * presentation with `buildMetaOsDecisionsPresentation`. No new backend and no
 * second decision path: `payload.os` is the server's word and this hands it to
 * the body unchanged.
 *
 * ## Why the account has to be resolved before the read
 *
 * `canonicalDecisionReadModel` refuses without a `providerAccountId` — it
 * returns an *unavailable* model coded `provider_account_required` rather than
 * throwing. A container that omitted the account would therefore get a
 * perfectly successful 200 carrying an empty presentation, and the queue would
 * render as "nothing to do" while the real account went unread. So the scope is
 * resolved first, from the accounts actually assigned to this business, and the
 * read is not issued at all until it exists.
 */
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import { DecisionCenterBody } from "@/components/meta/decision-center/DecisionCenterBody";
import type { DecisionCenterItem } from "@/components/meta/decision-center/decision-center-contract";
import type {
  MetaDecisionsOsWorkspacePayload,
  MetaWindowKey,
} from "@/components/meta/redesign/types";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";

const WINDOW_KEYS = ["7d", "14d", "28d", "90d"] as const;
type FixedWindowKey = (typeof WINDOW_KEYS)[number];

const WINDOW_LABELS: Record<FixedWindowKey, string> = {
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "28d": "Last 28 days",
  "90d": "Last 90 days",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "synced 12m ago", or nothing.
 *
 * Computed here rather than in the body because the body also renders on the
 * server in tests; a clock read during render is the classic way to make the
 * same markup differ between the two passes.
 */
function relativeLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * The metrics window, as the URL states it.
 *
 * Mirrors what the existing Decisions surface reads from the same query string
 * so both surfaces answer for the same days; an unrecognised value falls back
 * to 28d rather than being forwarded to the API as-is.
 */
export function readDecisionWindow(params: {
  get(name: string): string | null;
}): { key: MetaWindowKey; startDate: string | null; endDate: string | null; label: string } {
  const raw = params.get("window");
  if (raw === "custom") {
    const startDate = params.get("startDate") ?? "";
    const endDate = params.get("endDate") ?? "";
    if (ISO_DATE.test(startDate) && ISO_DATE.test(endDate)) {
      return { key: "custom", startDate, endDate, label: `${startDate} – ${endDate}` };
    }
    // A custom window without usable bounds is not a custom window. Falling
    // back is safer than asking the API to answer for an unparseable range.
    return { key: "28d", startDate: null, endDate: null, label: WINDOW_LABELS["28d"] };
  }
  const key = (WINDOW_KEYS as readonly string[]).includes(raw ?? "")
    ? (raw as FixedWindowKey)
    : "28d";
  return { key, startDate: null, endDate: null, label: WINDOW_LABELS[key] };
}

/**
 * Which assigned account this view is scoped to.
 *
 * An explicit `providerAccountId` wins, but only if it is one of the accounts
 * assigned to this business — a URL naming a foreign account resolves to none
 * and the read is withheld, rather than being sent for the API to reject. With
 * exactly one assigned account there is nothing to choose, so it is selected.
 */
export function resolveDecisionAccount(
  accounts: MetaHistoryAccount[],
  requestedId: string | null,
): MetaHistoryAccount | null {
  if (requestedId) return accounts.find((account) => account.id === requestedId) ?? null;
  return accounts.length === 1 ? accounts[0]! : null;
}

async function readWorkspace(
  url: string,
  signal: AbortSignal,
): Promise<MetaDecisionsOsWorkspacePayload> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as MetaDecisionsOsWorkspacePayload;
}

function Notice({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-4"
      data-testid="decision-center-notice"
      role="status"
    >
      <p className="m-0 text-[12.5px] font-semibold text-[var(--adv-ink)]">{title}</p>
      <p className="m-0 mt-1 text-[12.5px] leading-[1.5] text-[var(--adv-ink-3)]">{detail}</p>
      {children}
    </div>
  );
}

export function DecisionCenterView({
  businessId,
  currency: businessCurrency,
}: {
  businessId: string;
  businessName?: string | null;
  currency?: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const requestedAccountId = searchParams.get("providerAccountId")?.trim() || null;
  const window = useMemo(() => readDecisionWindow(searchParams), [searchParams]);

  const accountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled: Boolean(businessId),
    queryFn: ({ signal }) => fetchMetaHistoryAccounts({ businessId, signal }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const account = useMemo(
    () => resolveDecisionAccount(accounts, requestedAccountId),
    [accounts, requestedAccountId],
  );
  const providerAccountId = account?.id ?? null;

  const workspaceQuery = useQuery({
    queryKey: [
      "meta-decision-center",
      businessId,
      providerAccountId,
      window.key,
      window.startDate,
      window.endDate,
    ],
    // Withheld until the scope exists: see the note at the top of this file.
    enabled: Boolean(businessId && providerAccountId),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        businessId,
        providerAccountId: providerAccountId!,
        window: window.key,
        status_filter: "all",
        surface: "os",
      });
      if (window.key === "custom" && window.startDate && window.endDate) {
        params.set("startDate", window.startDate);
        params.set("endDate", window.endDate);
      }
      return readWorkspace(`/api/meta/decisions-workspace?${params.toString()}`, signal);
    },
    retry: 2,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const selectAccount = useCallback(
    (accountId: string) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set("providerAccountId", accountId);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const onCommand = useCallback(
    (item: DecisionCenterItem) => {
      // The server routes the action; the UI only follows where it points.
      if (item.actionIntent === "launchpad") {
        router.push(`/platforms/meta/launchpad?decision=${encodeURIComponent(item.id)}`);
      }
    },
    [router],
  );

  if (accountsQuery.isPending) {
    return (
      <p className="m-0 text-[12.5px] text-[var(--adv-ink-3)]" role="status">
        Resolving the Meta ad account for this business…
      </p>
    );
  }

  if (accountsQuery.isError) {
    return (
      <Notice
        title="The assigned Meta ad accounts could not be read."
        detail="Without the account assignment the decision snapshot is not requested at all. This is not an empty queue — nothing has been read, and nothing is being withheld or approved on your behalf."
      />
    );
  }

  if (accounts.length === 0) {
    return (
      <Notice
        title="No Meta ad account is assigned to this business."
        detail="Decisions are account-scoped, so there is nothing to read yet. Connect and assign a Meta ad account in Integrations."
      />
    );
  }

  if (!providerAccountId) {
    // Several accounts are assigned and the URL names none (or names one that
    // is not assigned here). Guessing would silently show one account's money
    // under another's name, so the choice is asked for instead.
    return (
      <Notice
        title="Choose which Meta ad account to read."
        detail={
          requestedAccountId
            ? "The requested account is not assigned to this business, so no decisions were read for it."
            : "More than one Meta ad account is assigned to this business. Decisions and money are account-scoped."
        }
      >
        <ul className="m-0 mt-3 flex list-none flex-wrap gap-2 p-0">
          {accounts.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => selectAccount(item.id)}
                data-testid="decision-center-account-option"
                className="h-[32px] rounded-[9px] border border-[var(--adv-border)] bg-[var(--adv-fill)] px-3 text-[12.5px] font-semibold text-[var(--adv-ink-2)]"
              >
                {item.name ?? item.id}
                <span className="ml-2 font-normal text-[var(--adv-ink-4)]">
                  {item.id}
                  {item.currency ? ` · ${item.currency}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Notice>
    );
  }

  if (workspaceQuery.isPending) {
    return (
      <p className="m-0 text-[12.5px] text-[var(--adv-ink-3)]" role="status">
        Loading the decision snapshot…
      </p>
    );
  }

  const workspace = workspaceQuery.data ?? null;

  if (workspaceQuery.isError || !workspace?.os) {
    // Fail closed and say so: an unreadable snapshot must never render as an
    // empty queue, which would read as "nothing to do".
    return (
      <Notice
        title="The decision snapshot could not be read."
        detail={`${
          workspaceQuery.error instanceof Error
            ? `${workspaceQuery.error.message}. `
            : ""
        }This is not an empty queue. Nothing is being withheld or approved on your behalf while it is unreadable.`}
      />
    );
  }

  const currency = account?.currency ?? workspace.system.currency ?? businessCurrency ?? null;

  return (
    <DecisionCenterBody
      presentation={workspace.os}
      accountLabel={`Ad account ${providerAccountId}`}
      currency={currency}
      windowLabel={window.label}
      windowShortLabel={window.key === "custom" ? null : window.key.toUpperCase()}
      pulse={{
        pacing: workspace.pulse.pacing,
        roas: workspace.pulse.roas,
        roasHistory: workspace.pulse.roasHistory,
        labelCoverage: workspace.pulse.labelCoverage,
        operatingMode: workspace.pulse.operatingMode,
        seasonalRegime: workspace.pulse.seasonalRegime,
        trackingHealth: workspace.pulse.trackingHealth,
      }}
      snapshotHealth={workspace.system.snapshotHealth ?? null}
      lastSyncLabel={relativeLabel(workspace.pulse.lastSyncAt)}
      readOnlyReason={workspace.viewer?.readOnly ? workspace.viewer.readOnlyReason : null}
      unavailableReason={
        workspace.decisionReadModel.status === "unavailable"
          ? (workspace.decisionReadModel.unavailable?.message ?? "The canonical decision sources were not readable.")
          : null
      }
      canRunSnapshot={!workspaceQuery.isFetching}
      onRunSnapshot={() => void workspaceQuery.refetch()}
      onNewCampaign={() => router.push("/platforms/meta/launchpad")}
      onCommand={onCommand}
    />
  );
}
