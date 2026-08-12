"use client";

/**
 * Agency ⇄ Client switch, and the states it can be in (H65/H07).
 *
 * Five states, drawn together because they are easy to confuse and expensive to
 * confuse: eligible, denied, loading, empty and error. The distinctions that
 * matter:
 *
 * - **Denied is not empty.** "You have no agency membership" and "your agency
 *   has no clients" lead to completely different next actions, and collapsing
 *   them into one blank panel leaves the operator guessing which applies.
 * - **Error is not empty either.** A failed lookup must not render as "no
 *   clients", because that reads as a fact about the account when it is a fact
 *   about the request.
 * - **Denied shows no switch control at all.** AUTH-10 is explicit: an actor
 *   with no agency membership sees the segment absent, never a disabled teaser
 *   that advertises a capability they do not have.
 *
 * Switching business keeps the surface and resets what cannot travel with it —
 * a provider account that belongs to the old business is not silently carried
 * into the new one. `ContextResetNotice` states exactly what was dropped.
 */
import { Button } from "@/components/zero-base/primitives/button";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import { UnavailableState } from "@/components/zero-base/states/surface-state";

export type SwitchState =
  | { kind: "eligible"; businesses: ReadonlyArray<{ id: string; name: string }> }
  /** No agency membership. There is nothing to switch to and no control. */
  | { kind: "denied"; reason: string }
  | { kind: "loading" }
  /** Membership exists; the agency simply has no clients yet. */
  | { kind: "empty"; reason: string }
  | { kind: "error"; reason: string };

export function ScopeSwitchPanel({
  state,
  onSwitchScope,
  onOpenBusinessSwitcher,
}: {
  state: SwitchState;
  onSwitchScope?: () => void;
  onOpenBusinessSwitcher?: () => void;
}) {
  const copy = useCopy();
  if (state.kind === "loading") {
    return (
      <section data-el="switch-loading" aria-busy="true" style={{ fontSize: 13 }}>
        <p style={{ margin: 0, color: "var(--ledger-ink-secondary)" }}>
          Checking which workspaces you can reach…
        </p>
      </section>
    );
  }

  if (state.kind === "denied") {
    return (
      <section data-el="switch-denied" style={{ fontSize: 13 }}>
        {/* No control: absence over theatre. */}
        <UnavailableState reason={state.reason} />
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section data-el="switch-error" style={{ fontSize: 13 }}>
        <p role="alert" style={{ margin: 0, color: "var(--ledger-semantic-danger)" }}>
          {state.reason}
        </p>
      </section>
    );
  }

  if (state.kind === "empty") {
    return (
      <section data-el="switch-empty" style={{ display: "grid", gap: 6, fontSize: 13 }}>
        {/* Distinct from denied: the membership is fine, the list is not. */}
        <p style={{ margin: 0, color: "var(--ledger-ink-secondary)" }}>{state.reason}</p>
        {/* An empty list still has somewhere to go: the desk is where a client
            gets added. Without this the panel states a problem and offers no
            way to act on it. */}
        <a
          href="/a/desk"
          data-ctl="live:nav"
          style={{ display: "inline-flex", alignItems: "center", minHeight: 24, fontSize: 12, color: "var(--ledger-accent-action)" }}
        >
          {copy.agencyDesk}
        </a>
      </section>
    );
  }

  return (
    <section data-el="switch-eligible" style={{ display: "grid", gap: 8, fontSize: 13 }}>
      <div role="radiogroup" aria-label={copy.scopeLabel} style={{ display: "flex", gap: 6 }}>
        <Button variant="secondary" data-ctl="live:AUTH-10 scope-switch" onClick={onSwitchScope}>
          {copy.agency}
        </Button>
        <Button variant="secondary" data-ctl="live:AUTH-10 scope-switch" onClick={onSwitchScope}>
          {copy.client}
        </Button>
      </div>
      <a href="/a/desk" data-ctl="live:nav" style={{ fontSize: 12, color: "var(--ledger-accent-action)" }}>
        {copy.agencyDesk}
      </a>
      <Button
        variant="secondary"
        data-ctl="live:AUTH-10 business-switcher"
        aria-haspopup="listbox"
        onClick={onOpenBusinessSwitcher}
      >
        Switch business ({state.businesses.length})
      </Button>
    </section>
  );
}

/**
 * What a switch dropped, said out loud (H07).
 *
 * A provider account selected under the previous business does not exist under
 * the new one. Carrying it silently would scope the surface to an account the
 * operator cannot see, so it is reset and the reset is stated — with the way to
 * put it right in reach.
 */
export function ContextResetNotice({
  droppedLabel,
  onAssign,
}: {
  droppedLabel: string;
  onAssign?: () => void;
}) {
  const copy = useCopy();
  return (
    <section
      data-el="context-reset"
      role="status"
      style={{
        border: "1px solid var(--ledger-semantic-warn)",
        borderRadius: "var(--ledger-radius-card)",
        padding: "10px 14px",
        display: "grid",
        gap: 8,
        fontSize: 12,
        lineHeight: "18px",
      }}
    >
      <p style={{ margin: 0 }}>
        {droppedLabel} does not exist under this business, so the account scope was
        reset. Nothing was changed on either business.
      </p>
      <div>
        <Button variant="secondary" data-ctl="live:SCOPE-03 assign" onClick={onAssign}>
          {copy.chooseAnAccount}
        </Button>
      </div>
    </section>
  );
}
