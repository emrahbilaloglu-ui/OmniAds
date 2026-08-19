"use client";

/**
 * The account choice, offered ONLY where History could not resolve a scope.
 *
 * The design draws no account control on this screen, and when the scope IS
 * resolved this component is never rendered — the surface is byte-identical to
 * what it was. It exists because the unresolved state was a dead end: a
 * business with two assigned Meta accounts, opened directly at
 * `/c/<id>/meta/history`, printed "Select one to read its journal" with nothing
 * to select. The only way to actually choose was to hand-edit the address bar.
 *
 * The client may only REQUEST an account. Choosing one writes
 * `providerAccountId` into the URL and the server re-resolves it against this
 * business's current assignment on the next render, so an id this business does
 * not hold is still refused. A URL parameter therefore never becomes authority
 * — it becomes a question the server answers.
 *
 * Every other parameter on the URL is preserved, the date window above all.
 * Rebuilding the query from scratch would drop `startDate`/`endDate` and the
 * first thing the operator saw after picking an account would be a journal
 * measured over a different window than the one the shell states.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type { MetaHistoryAccount } from "@/lib/meta/history-contract";

export function HistoryAccountPicker({
  accounts,
}: {
  accounts: readonly MetaHistoryAccount[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (accounts.length === 0) return null;

  const select = (providerAccountId: string) => {
    if (!providerAccountId) return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("providerAccountId", providerAccountId);
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <label
      data-control="account-picker"
      style={{ fontSize: 12, display: "grid", gap: 4, marginTop: 12, maxWidth: 280 }}
    >
      Meta ad account
      <select
        aria-label="Meta ad account for History"
        // No pre-selection. Picking the first of several assigned accounts on
        // the operator's behalf is exactly the silent scope this screen must
        // never invent — it is what printed one account's journal under another
        // account's name.
        value=""
        onChange={(event) => select(event.currentTarget.value)}
        style={{ minHeight: 44, padding: "6px 8px" }}
      >
        <option value="">Select account</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name ?? account.id}
            {account.currency ? ` · ${account.currency}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
