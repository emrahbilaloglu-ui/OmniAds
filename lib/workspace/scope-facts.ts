/**
 * The workspace envelope, restated as the eight facts a scope sheet shows.
 *
 * The mapping already existed — in `components/zero-base/shell/client-shell.tsx`,
 * a shell no route mounts. So the console that every operator opens had no way
 * to state its own scope on a phone, and the only implementation sat behind a
 * component nobody renders. Moving it here rather than copying it keeps one
 * answer to "what is in scope", which is the entire point of the sheet.
 *
 * Nothing here decides anything: every value is read off the envelope the
 * server resolved, and the two proofs — currency and timezone — are carried
 * rather than inferred, because "configured" and "observed" are different
 * claims and a sheet that flattened them would be inventing confidence.
 */
import type { ScopeFacts } from "@/components/zero-base/primitives/scope-sheet";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

const WORKSPACE_MODE_LABEL: Record<string, string> = {
  agency: "Agency",
  client: "Client",
  ops: "Ops",
  account: "Account",
};

const PROVIDER_LABEL: Record<string, string> = {
  meta: "Meta",
  google: "Google Ads",
  shopify: "Shopify",
  klaviyo: "Klaviyo",
};

export function scopeFactsFromEnvelope(
  envelope: WorkspaceContextEnvelope,
  selectedAccount?: { currency?: string | null; timezone?: string | null } | null,
): ScopeFacts {
  return {
    scopeContext: WORKSPACE_MODE_LABEL[envelope.mode] ?? envelope.mode,
    /*
     * Nothing records which surface a client scope was entered from, so this
     * stays null rather than guessing "Agency Desk" for somebody who navigated
     * straight to a bookmark.
     */
    enteredFrom: null,
    providerLabel: envelope.provider ? (PROVIDER_LABEL[envelope.provider.id] ?? envelope.provider.id) : null,
    businessName: envelope.business?.name ?? null,
    providerAccountLabel: envelope.provider?.selectedAccountLabel ?? null,
    evidenceWindowLabel: envelope.evidence.windowLabel,
    /*
     * An account's own currency and timezone are OBSERVED facts and outrank the
     * business's configured ones; when one is present the proof rises with it.
     */
    configuredCurrency:
      selectedAccount?.currency ?? envelope.business?.configuredCurrency ?? null,
    currencyProof: selectedAccount?.currency ? "proven" : envelope.proof.currency,
    businessTimezone:
      selectedAccount?.timezone ?? envelope.business?.businessTimezone ?? null,
    timezoneProof: selectedAccount?.timezone ? "aligned" : envelope.proof.timezone,
    freshness: envelope.evidence.freshness,
    snapshotAt: envelope.evidence.snapshotAt,
  };
}
