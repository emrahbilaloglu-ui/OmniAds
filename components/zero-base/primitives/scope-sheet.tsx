"use client";

/**
 * The scope sheet — six facts, always all six.
 *
 * At narrow widths the context bar compresses to two ellipsized lines, so the
 * full scope has to live somewhere reachable. This sheet is that somewhere,
 * and it renders every one of the six named facts unconditionally: business,
 * provider account, evidence window, currency *with its proof state*,
 * timezone, and freshness.
 *
 * "Unconditionally" is the requirement. A fact that is missing renders as an
 * explicit unknown rather than being dropped — a sheet that silently omits
 * timezone is indistinguishable from one where timezone agrees.
 */
import { ZeroBaseSheet } from "@/components/zero-base/primitives/overlays";
import type {
  CurrencyProof,
  EvidenceFreshness,
  TimezoneProof,
} from "@/lib/workspace/workspace-context";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export interface ScopeFacts {
  businessName: string | null;
  providerAccountLabel: string | null;
  evidenceWindowLabel: string | null;
  configuredCurrency: string | null;
  currencyProof: CurrencyProof;
  businessTimezone: string | null;
  timezoneProof: TimezoneProof;
  freshness: EvidenceFreshness;
  snapshotAt: string | null;
}

/** The six facts, in the order the design names them. */
export const SCOPE_FACT_IDS = [
  "business",
  "account",
  "window",
  "currency",
  "timezone",
  "freshness",
] as const;

export type ScopeFactId = (typeof SCOPE_FACT_IDS)[number];

const CURRENCY_WORDS: Record<CurrencyProof, string> = {
  proven: "observed on the account",
  "configured-only": "configured, not yet observed",
  mixed: "sources disagree",
  unknown: "unknown",
};

const TIMEZONE_WORDS: Record<TimezoneProof, string> = {
  aligned: "matches the account",
  missing: "not set",
  disagreement: "disagrees with the account",
  unknown: "unknown",
};

const FRESHNESS_WORDS: Record<EvidenceFreshness, string> = {
  fresh: "fresh",
  stale: "stale",
  unknown: "unknown",
};

export function scopeFactRows(facts: ScopeFacts): Array<{ id: ScopeFactId; label: string; value: string }> {
  return [
    { id: "business", label: "Business", value: facts.businessName ?? "None selected" },
    { id: "account", label: "Provider account", value: facts.providerAccountLabel ?? "None selected" },
    { id: "window", label: "Evidence window", value: facts.evidenceWindowLabel ?? "Unknown" },
    {
      id: "currency",
      // The proof state travels with the value; a bare "USD" would imply we
      // had observed it when we may only have been told it.
      label: "Currency",
      value: `${facts.configuredCurrency ?? "Unknown"} — ${CURRENCY_WORDS[facts.currencyProof]}`,
    },
    {
      id: "timezone",
      label: "Timezone",
      value: `${facts.businessTimezone ?? "Unknown"} — ${TIMEZONE_WORDS[facts.timezoneProof]}`,
    },
    {
      id: "freshness",
      label: "Freshness",
      value: facts.snapshotAt
        ? `${FRESHNESS_WORDS[facts.freshness]} — as of ${facts.snapshotAt}`
        : FRESHNESS_WORDS[facts.freshness],
    },
  ];
}

export function ScopeSheet({
  open,
  onOpenChange,
  facts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facts: ScopeFacts;
}) {
  const copy = useCopy();
  return (
    <ZeroBaseSheet open={open} onOpenChange={onOpenChange} title={copy.scope} side="bottom">
      <dl style={{ margin: "12px 0 0", display: "grid", gap: 10 }}>
        {scopeFactRows(facts).map((row) => (
          <div key={row.id} data-scope-fact={row.id}>
            <dt style={{ fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>
              {row.label}
            </dt>
            <dd style={{ margin: 0, fontSize: 13, lineHeight: "19px", color: "var(--ledger-ink-primary)" }}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </ZeroBaseSheet>
  );
}
