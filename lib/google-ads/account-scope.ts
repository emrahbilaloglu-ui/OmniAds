/**
 * Which Google account the dashboard is answering for.
 *
 * With more than one account assigned, the surface previously summed them into
 * one set of numbers with no account filter, one timezone applied to all, and a
 * single currency symbol over potentially mixed-currency spend. Nothing on
 * screen said so. Deep links also vanished, because the code that builds them
 * needs a single account and quietly gave up when there was more than one.
 *
 * Blending is not removed — an agency may genuinely want the portfolio — but it
 * is now a stated mode rather than an accident, and it refuses to present a
 * single money figure across currencies it cannot convert.
 */

export type GoogleAccountScopeMode = "none" | "single" | "blended";

export interface GoogleAccountScope {
  mode: GoogleAccountScopeMode;
  /** Set only in single mode; deep links and writes need exactly one account. */
  accountId: string | null;
  accountIds: string[];
  /** True when a blended view spans currencies with no conversion available. */
  mixedCurrency: boolean;
  /** What the reader must be told, or null when there is nothing to disclose. */
  notice: string | null;
  /** Whether money may be presented as one figure across the scope. */
  moneyComparable: boolean;
}

function normalizeCurrency(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

export function resolveGoogleAccountScope(input: {
  assignedAccountIds: string[];
  /** Operator's explicit choice, when they have made one. */
  selectedAccountId?: string | null;
  /** Currency per account id, where known. */
  currencyByAccountId?: Record<string, string | null>;
}): GoogleAccountScope {
  const assigned = input.assignedAccountIds.filter((id) => id.trim().length > 0);

  if (assigned.length === 0) {
    return {
      mode: "none",
      accountId: null,
      accountIds: [],
      mixedCurrency: false,
      notice: "No Google account is assigned to this workspace yet.",
      moneyComparable: false,
    };
  }

  const selected =
    input.selectedAccountId && assigned.includes(input.selectedAccountId)
      ? input.selectedAccountId
      : null;

  if (assigned.length === 1 || selected) {
    const accountId = selected ?? assigned[0]!;
    return {
      mode: "single",
      accountId,
      accountIds: [accountId],
      mixedCurrency: false,
      notice: null,
      moneyComparable: true,
    };
  }

  const currencies = new Set(
    assigned.map((id) => normalizeCurrency(input.currencyByAccountId?.[id])),
  );
  const mixedCurrency = currencies.size > 1 || currencies.has(null);

  return {
    mode: "blended",
    accountId: null,
    accountIds: assigned,
    mixedCurrency,
    notice: mixedCurrency
      ? `Blended across ${assigned.length} accounts that do not share one currency. Totals are not comparable — select an account to see money you can act on.`
      : `Blended across ${assigned.length} accounts. Select one to scope this view.`,
    moneyComparable: !mixedCurrency,
  };
}

/** Deep links and any write path need exactly one account. */
export function scopeSupportsAccountLinks(scope: GoogleAccountScope): boolean {
  return scope.mode === "single" && Boolean(scope.accountId);
}
