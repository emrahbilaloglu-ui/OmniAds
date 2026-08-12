"use client";

/**
 * The scope sheet — eight facts, always all eight.
 *
 * At narrow widths the context bar compresses to two ellipsized lines, so the
 * full scope has to live somewhere reachable. This sheet is that somewhere, and
 * it renders every one of the eight named facts unconditionally: context,
 * business, provider, account, currency *with its proof state*, timezone,
 * evidence window, and freshness.
 *
 * "Unconditionally" is the requirement. A fact that is missing renders as an
 * explicit unknown rather than being dropped — a sheet that silently omits
 * timezone is indistinguishable from one where timezone agrees.
 *
 * Four of the rows carry a picker. They are rendered only when the caller can
 * actually service them: per AUTH-10 an actor with no agency membership sees no
 * scope segment at all rather than a disabled teaser, and the same rule applies
 * to the rest. Absence over theatre.
 */
import { ZeroBaseSheet } from "@/components/zero-base/primitives/overlays";
import type {
  CurrencyProof,
  EvidenceFreshness,
  TimezoneProof,
} from "@/lib/workspace/workspace-context";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export interface ScopeFacts {
  /** Agency, Client or Ops — and, when it applies, where it was entered from. */
  scopeContext: string | null;
  enteredFrom: string | null;
  businessName: string | null;
  /** Which provider is in scope, and which others are assigned. */
  providerLabel: string | null;
  providerAccountLabel: string | null;
  evidenceWindowLabel: string | null;
  configuredCurrency: string | null;
  currencyProof: CurrencyProof;
  businessTimezone: string | null;
  timezoneProof: TimezoneProof;
  freshness: EvidenceFreshness;
  snapshotAt: string | null;
}

/** The eight facts, in the order the design names them. */
export const SCOPE_FACT_IDS = [
  "context",
  "business",
  "provider",
  "account",
  "currency",
  "timezone",
  "window",
  "freshness",
] as const;

export type ScopeFactId = (typeof SCOPE_FACT_IDS)[number];

const CURRENCY_WORDS: Record<CurrencyProof, string> = {
  proven: "proven per row",
  "configured-only": "configured, not yet observed",
  mixed: "sources disagree",
  unknown: "unknown",
};

const TIMEZONE_WORDS: Record<TimezoneProof, string> = {
  aligned: "matches business",
  missing: "not set",
  disagreement: "disagrees with the account",
  unknown: "unknown",
};

const FRESHNESS_WORDS: Record<EvidenceFreshness, string> = {
  fresh: "fresh",
  stale: "stale",
  unknown: "unknown",
};

export function scopeFactRows(
  facts: ScopeFacts,
): Array<{ id: ScopeFactId; label: string; value: string }> {
  return [
    {
      id: "context",
      label: "Context",
      value: facts.enteredFrom
        ? `${facts.scopeContext ?? "Unknown"} — entered from ${facts.enteredFrom}`
        : (facts.scopeContext ?? "Unknown"),
    },
    { id: "business", label: "Business", value: facts.businessName ?? "None selected" },
    { id: "provider", label: "Provider", value: facts.providerLabel ?? "None connected" },
    {
      id: "account",
      label: "Account",
      value: facts.providerAccountLabel ?? "None selected",
    },
    {
      id: "currency",
      // The proof state travels with the value; a bare "USD" would imply we had
      // observed it when we may only have been told it.
      label: "Currency",
      value: `${facts.configuredCurrency ?? "Unknown"} · ${CURRENCY_WORDS[facts.currencyProof]}`,
    },
    {
      id: "timezone",
      label: "Timezone",
      value: `TZ ${facts.businessTimezone ?? "Unknown"} · ${TIMEZONE_WORDS[facts.timezoneProof]}`,
    },
    {
      id: "window",
      label: "Window",
      value: `${facts.evidenceWindowLabel ?? "Unknown"} · evidence window`,
    },
    {
      id: "freshness",
      label: "Freshness",
      value: facts.snapshotAt
        ? `source ${FRESHNESS_WORDS[facts.freshness]} · snapshot ${facts.snapshotAt}`
        : `source ${FRESHNESS_WORDS[facts.freshness]}`,
    },
  ];
}

/** Which rows carry a picker, and the contract each picker satisfies. */
const ROW_PICKER: Partial<Record<ScopeFactId, { ctl: string; label: string }>> = {
  context: { ctl: "live:AUTH-10 scope-switch", label: "Switch scope" },
  business: { ctl: "live:AUTH-10 business-switcher", label: "Switch business" },
  account: { ctl: "live:SCOPE-03 account-picker", label: "Choose account" },
  window: { ctl: "live:SCOPE-10 window-picker", label: "Change evidence window" },
};

export interface ScopePickers {
  /** Omitted handlers mean the actor genuinely cannot do it; the row has no
   *  picker at all rather than a disabled one. */
  onSwitchScope?: () => void;
  onSwitchBusiness?: () => void;
  onPickAccount?: () => void;
  onPickWindow?: () => void;
}

export function ScopeSheet({
  open,
  onOpenChange,
  facts,
  pickers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facts: ScopeFacts;
  pickers?: ScopePickers;
}) {
  const copy = useCopy();

  const handlerFor = (id: ScopeFactId): (() => void) | undefined => {
    switch (id) {
      case "context":
        return pickers?.onSwitchScope;
      case "business":
        return pickers?.onSwitchBusiness;
      case "account":
        return pickers?.onPickAccount;
      case "window":
        return pickers?.onPickWindow;
      default:
        return undefined;
    }
  };

  return (
    <ZeroBaseSheet
      open={open}
      onOpenChange={onOpenChange}
      title={copy.scope}
      regionEl="scope-sheet-open"
      side="bottom"
    >
      <div>
        <dl style={{ margin: "12px 0 0", display: "grid", gap: 2 }}>
          {scopeFactRows(facts).map((row) => {
            const picker = ROW_PICKER[row.id];
            const handler = handlerFor(row.id);
            return (
              <div
                key={row.id}
                data-scope-fact={row.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  // 44px rows: these are tap targets on the surface where the
                  // scope sheet exists at all.
                  minHeight: 44,
                  padding: "4px 0",
                  borderBottom: "1px solid var(--ledger-border-subtle)",
                }}
              >
                {/* The fact carries the region marker; the picker is a sibling,
                    so it belongs to the sheet rather than to one row's label. */}
                <div data-el={`scope-f-${row.id}`} style={{ minWidth: 0 }}>
                  <dt
                    style={{
                      fontSize: 12,
                      lineHeight: "16px",
                      color: "var(--ledger-ink-tertiary)",
                    }}
                  >
                    {row.label}
                  </dt>
                  <dd
                    style={{
                      margin: 0,
                      fontSize: 13,
                      lineHeight: "19px",
                      color: "var(--ledger-ink-primary)",
                    }}
                  >
                    {row.value}
                  </dd>
                </div>
                {picker && handler ? (
                  <button
                    type="button"
                    data-ctl={picker.ctl}
                    aria-label={`${picker.label} — ${row.value}`}
                    onClick={handler}
                    style={{
                      flex: "0 0 auto",
                      minWidth: 44,
                      minHeight: 44,
                      background: "none",
                      border: "1px solid var(--ledger-border-control)",
                      borderRadius: "var(--ledger-radius-button)",
                      color: "var(--ledger-ink-secondary)",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    ▾
                  </button>
                ) : null}
              </div>
            );
          })}
        </dl>
        <p
          style={{
            margin: "12px 0 0",
            fontSize: 12,
            lineHeight: "16px",
            color: "var(--ledger-ink-tertiary)",
          }}
        >
          {copy.scopeServedNote}
        </p>
      </div>
    </ZeroBaseSheet>
  );
}
