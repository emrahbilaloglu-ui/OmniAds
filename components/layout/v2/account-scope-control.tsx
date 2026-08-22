"use client";

/**
 * The one shared provider-account control, in the topbar's existing context slot.
 *
 * Decisions, History and Automation each grew their own account picker;
 * Account Intelligence and the whole Creative Studio family grew none, so on
 * those surfaces a business with several assigned Meta accounts had no way to
 * say which one it meant — and no way out of the resulting refusal. That is the
 * `account_required` dead-end WP4 exists to remove.
 *
 * D1 permits "mevcut context alanında picker": a control in the context area
 * that already exists, in the row's own style. It is a sibling of the business
 * switcher and the date picker and introduces no new layout, card or hierarchy.
 *
 * ## It selects. It never grants.
 *
 * Choosing here writes `?providerAccountId=` and nothing else. The server
 * re-runs `resolveProviderAccountId` against this business's assignments on the
 * next render, so an id that is not assigned comes back null and the surface
 * stays refused. That is why this is a URL write rather than local state: a
 * client-held selection would be a scope nobody verified.
 *
 * ## 0 / 1 / N (D6)
 *
 * - **0 assigned** — no picker. A link to Integrations, because the action that
 *   resolves this is assignment, not selection.
 * - **1 assigned** — the account is named, not offered. There is nothing to
 *   choose, and a one-option dropdown reads as a choice the operator has to make.
 * - **N assigned, none chosen** — the picker shows an explicit "Select an
 *   account" state. It never auto-picks the first: a figure attributed to an
 *   account nobody chose is worse than a surface that refuses.
 * - **N assigned, one chosen** — the chosen account is named and changeable.
 */
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ChevronsUpDown, CircleSlash } from "lucide-react";
import { useCallback } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOptionalWorkspaceContext } from "@/components/workspace/workspace-context-provider";
import type { ProviderScopeCatalog } from "@/lib/zero-base/provider-scope-server";
import { accountSwitchQuery } from "@/lib/dashboard/account-scope-url";

const PROVIDER_LABEL: Record<string, string> = {
  meta: "Meta ad account",
  google: "Google Ads account",
};

export function AccountScopeControl({
  providerCatalogs,
}: {
  providerCatalogs: readonly ProviderScopeCatalog[];
}) {
  const workspace = useOptionalWorkspaceContext();
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();

  const provider = workspace?.provider ?? null;

  const select = useCallback(
    (accountId: string) => {
      /**
       * Written through the URL, and every account-scoped parameter dropped.
       *
       * A selected row, an open inspector, a cursor or a Launchpad handoff are
       * all facts about the account being left. Carrying one into the next
       * account names an entity that does not exist there — or, on a business
       * that happens to hold both, one that does and should not be shown.
       */
      const next = accountSwitchQuery(
        typeof window !== "undefined"
          ? window.location.search
          : (searchParams?.toString() ?? ""),
        accountId,
      );
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [pathname, router, searchParams],
  );

  // Surfaces with no provider family — Overview, Reports, Settings — get no
  // control at all rather than a disabled one. There is no account question to
  // answer there, and a disabled control implies there is.
  if (!provider) return null;

  const catalog =
    providerCatalogs.find((item) => item.provider === provider.id) ?? null;
  const accounts = catalog?.accounts ?? [];
  const label = PROVIDER_LABEL[provider.id] ?? "Ad account";
  const selectedId = provider.selectedAccountIds[0] ?? null;
  const selected = accounts.find((account) => account.id === selectedId) ?? null;

  if (accounts.length === 0) {
    return (
      <button
        type="button"
        className="adv-btn"
        data-testid="shell-account-scope"
        data-account-scope-state="none"
        onClick={() => router.push(scopedIntegrationsHref(pathname))}
        title={`No ${label} is assigned to this workspace yet.`}
      >
        <CircleSlash
          className="h-[13px] w-[13px] shrink-0 text-[var(--adv-ink-3)]"
          aria-hidden="true"
        />
        <span>No {label}</span>
      </button>
    );
  }

  if (accounts.length === 1) {
    // Named, not offered. Nothing to choose, and a one-option dropdown reads as
    // a decision the operator still owes.
    return (
      <span
        className="adv-btn"
        data-testid="shell-account-scope"
        data-account-scope-state="single"
        data-account-id={accounts[0]!.id}
        title={`${label}: ${accounts[0]!.label}`}
      >
        <span className="truncate">{accounts[0]!.label}</span>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="adv-btn"
          data-testid="shell-account-scope"
          data-account-scope-state={selected ? "selected" : "required"}
          data-account-id={selected?.id ?? ""}
          aria-label={label}
        >
          <span className="truncate">
            {selected ? selected.label : `Select a ${label}`}
          </span>
          <ChevronsUpDown
            className="h-[13px] w-[13px] shrink-0 text-[var(--adv-ink-3)]"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {selected
            ? `Switch ${label}`
            : `This workspace has ${accounts.length} assigned accounts. Choose one to see its data.`}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {accounts.map((account) => (
          <DropdownMenuItem
            key={account.id}
            onClick={() => select(account.id)}
            className="cursor-pointer gap-2"
            data-account-option={account.id}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {account.label}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {/* Stated only where it is known. An account whose currency or
                    timezone we have not observed shows neither rather than a
                    plausible default — §8.3 and D8. */}
                {[account.id, account.currency, account.timezone]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            {account.id === selectedId ? (
              <span className="adv-pill-dot bg-[var(--adv-accent)]" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Integrations inside whichever route family the operator is already in. */
function scopedIntegrationsHref(pathname: string): string {
  const scoped = pathname.match(/^\/c\/([^/?#]+)(?:\/|$)/);
  if (scoped) return `/c/${scoped[1]}/manage/integrations`;
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    return "/app/manage/integrations";
  }
  return "/integrations";
}
