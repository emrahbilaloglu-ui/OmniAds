"use client";

/**
 * The Manage surfaces (H41–H47).
 *
 * Provider rows are per provider, ceremonies show their read-back outcome
 * rather than a response, and the plan panel states that it gates nothing.
 */
import { useEffect, useState } from "react";

import { DataTable } from "@/components/zero-base/collections/data-table";
import { Button } from "@/components/zero-base/primitives/button";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import {
  DELETE_CEREMONY_NOTE,
  NO_UNIVERSAL_HEALTH,
  PLAN_GATES_NOTHING,
  RECOMMENDED_MODE_READ_ONLY,
  economicsDivergence,
  type CeremonyOutcome,
  type EconomicsField,
  type ProviderHealth,
} from "@/lib/zero-base/manage/manage-contract";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import { CommercialTruthSettingsSection } from "@/components/settings/commercial-truth-settings";
import type { AdaptedCostModel } from "@/lib/zero-base/manage/manage-contract";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div data-manage-surface={title.toLowerCase().replace(/\s+/g, "-")}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{title}</h1>
      {children}
    </div>
  );
}

export function CeremonyResult({ outcome, name }: { outcome: CeremonyOutcome; name: string }) {
  if (outcome.kind === "unstarted") return null;
  if (outcome.kind === "submitted") {
    return (
      <p role="status" data-ceremony={`${name}:submitted`} style={{ margin: "6px 0 0", fontSize: 12 }}>
        Applying, then reading the result back…
      </p>
    );
  }
  const tone =
    outcome.kind === "confirmed" ? "var(--ledger-semantic-ok)" : "var(--ledger-semantic-warn)";
  return (
    <p
      role="status"
      data-ceremony={`${name}:${outcome.kind}`}
      // An unknown outcome is the reconciliation state: the write was sent and
      // the confirming read did not settle it either way.
      data-el={outcome.kind === "unknown" ? "reconciliation-state" : undefined}
      style={{ margin: "6px 0 0", fontSize: 12, color: tone }}
    >
      {outcome.detail}
    </p>
  );
}

/* --------------------------------------------------------- integrations */

export interface SelectionPanelProps {
  /** What the independent re-read observed. Null means not readable. */
  selected: string | null;
  /** Options served by the discovery route. */
  options: readonly { value: string; label: string; detail?: string | null }[];
  discoveryError: string | null;
  permission: { ok: boolean; reason?: string };
  state: { pending: boolean; error: string | null; confirmed: string | null };
  onSave?: (value: string) => void;
}

/**
 * One provider-scoped selection (GA4 property, Search Console site).
 *
 * The selected value shown is always the one the re-read observed, never the
 * one this session just submitted — a write response says what the server
 * accepted, not what is now stored.
 */
export function SelectionPanel({
  kind,
  title,
  selected,
  options,
  discoveryError,
  permission,
  state,
  onSave,
}: SelectionPanelProps & { kind: string; title: string }) {
  const copy = useCopy();
  const [draft, setDraft] = useState(selected ?? "");
  useEffect(() => {
    setDraft(selected ?? "");
  }, [selected]);

  return (
    <section data-selection-panel={kind} aria-label={title} style={{ marginTop: 20 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h3>

      <p data-selection-current={kind} style={{ margin: "4px 0 0", fontSize: 12 }}>
        {selected
          ? `Currently selected: ${selected}`
          : "Nothing is selected, or the current selection could not be read."}
      </p>

      {discoveryError ? (
        <p data-selection-unavailable={kind} style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
          {discoveryError}
        </p>
      ) : !permission.ok ? (
        <p data-selection-blocked={kind} style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
          {permission.reason}
        </p>
      ) : (
        <>
          <select
            data-selection-options={kind}
            aria-label={title}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            style={{ minHeight: 44, padding: "8px 10px", marginTop: 6, maxWidth: 420, width: "100%" }}
          >
            <option value="">Choose&hellip;</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
                {option.detail ? ` — ${option.detail}` : ""}
              </option>
            ))}
          </select>

          <p role="status" aria-live="polite" data-selection-progress={kind} style={{ margin: "6px 0 0", fontSize: 12, minHeight: 16 }}>
            {state.pending ? "Saving…" : state.confirmed ?? ""}
          </p>
          {state.error ? (
            <p data-selection-error={kind} style={{ margin: 0, fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
              {state.error}
            </p>
          ) : null}

          <div style={{ marginTop: 6 }}>
            <Button
              variant="secondary"
              data-selection-save={kind}
              state={
                state.pending
                  ? { kind: "busy", label: "Saving…" }
                  : draft
                    ? { kind: "enabled" }
                    : { kind: "disabled", reason: "Choose an option first." }
              }
              onClick={() => onSave?.(draft)}
            >
              {copy.saveSelection}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export const CONNECT_UNSUPPORTED =
  "No authorization flow exists for this provider yet, so it cannot be connected here.";

export interface AssignmentPanelProps {
  provider: string;
  accounts: readonly { id: string; name: string; assigned: boolean; isManager: boolean }[];
  notice: string | null;
  unavailable: string | null;
  state: { pending: boolean; error: string | null; confirmed: string | null };
  permission: { ok: boolean; reason?: string };
  onProviderChange?: (provider: string) => void;
  onSave?: (accountIds: string[]) => void;
  /** Discards the draft without touching what is assigned. */
  onCancel?: () => void;
}

/**
 * What a connected provider row offers.
 *
 * The design draws a different primary action per provider, because "reassign"
 * does not mean the same thing for an ad account as it does for a GA4 property
 * or a Search Console site — and Shopify has no reassignment at all, only what
 * the connection currently covers. The disconnect is last, quiet, and gated:
 * taking a provider off drops evidence that rows elsewhere still cite.
 */
const PROVIDER_PRIMARY: Record<string, { ctl: string; label: string }> = {
  ga4: { ctl: "live:SCOPE-05", label: "Reassign property" },
  search_console: { ctl: "live:SCOPE-06", label: "Change site" },
  shopify: { ctl: "live:SHOPIFY-01", label: "Details" },
};

const PROVIDER_PRIMARY_DEFAULT = { ctl: "live:INTEGRATION-07", label: "Reassign" };

function ProviderRowActions({
  provider,
  disconnectPermission,
  onReassign,
  onDetails,
  onDisconnect,
}: {
  provider: string;
  disconnectPermission?: { ok: boolean; reason?: string };
  onReassign?: (provider: string) => void;
  onDetails?: (provider: string) => void;
  onDisconnect?: (provider: string) => void;
}) {
  const primary = PROVIDER_PRIMARY[provider] ?? PROVIDER_PRIMARY_DEFAULT;
  // Shopify's primary action reads the connection rather than moving it.
  const primaryHandler = provider === "shopify" ? onDetails : onReassign;
  const canDisconnect = disconnectPermission ? disconnectPermission.ok : true;

  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      {primaryHandler ? (
        <Button
          variant="quiet"
          data-provider-primary={provider}
          data-ctl={primary.ctl}
          onClick={() => primaryHandler(provider)}
        >
          {primary.label}
        </Button>
      ) : null}
      {onDisconnect ? (
        <Button
          variant="quiet"
          data-provider-disconnect={provider}
          data-ctl="gated:INTEGRATION-09"
          state={
            canDisconnect
              ? { kind: "enabled" }
              : {
                  kind: "disabled",
                  reason:
                    disconnectPermission?.reason ??
                    "Only a business admin can disconnect a provider.",
                }
          }
          onClick={() => onDisconnect(provider)}
        >
          {"Disconnect\u2026"}
        </Button>
      ) : null}
    </span>
  );
}

export function IntegrationsView({
  providers,
  onReconnect,
  onConnect,
  onReassignProvider,
  onProviderDetails,
  onDisconnectProvider,
  /**
   * True only where a real OAuth start route exists for this provider.
   *
   * A provider whose start route intentionally refuses (Klaviyo answers 501)
   * must stay unavailable rather than being given a control that can only fail.
   */
  connectSupported,
  /** Mirrors the start routes' own collaborator gate. */
  authorizePermission,
  /** Shopify's real entry, which is not a generic OAuth start. */
  shopifyEntry,
  outcome,
  unavailableReason,
  assignment,
  ga4Selection,
  searchConsoleSelection,
}: {
  providers: readonly ProviderHealth[];
  onReconnect?: (provider: string) => void;
  onConnect?: (provider: string) => void;
  /** Move a connected provider to a different account, property or site. */
  onReassignProvider?: (provider: string) => void;
  /** Open what the product actually knows about this connection. */
  onProviderDetails?: (provider: string) => void;
  /** Take a provider off. Gated: it drops evidence the reader may still need. */
  onDisconnectProvider?: (provider: string) => void;
  connectSupported?: (provider: string) => boolean;
  authorizePermission?: { ok: boolean; reason?: string };
  shopifyEntry?: { kind: string; href: string; label: string; note?: string; shopDomain?: string };
  outcome: CeremonyOutcome;
  unavailableReason?: string | null;
  assignment?: AssignmentPanelProps;
  ga4Selection?: SelectionPanelProps;
  searchConsoleSelection?: SelectionPanelProps;
}) {
  const copy = useCopy();
  return (
    <Shell title={copy.integrations}>
      {unavailableReason ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      ) : (
        <>
          <div data-el="provider-states">
          <p data-no-universal-health="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            {NO_UNIVERSAL_HEALTH}
          </p>
          <div style={{ marginTop: 12 }}>
            <DataTable
              collection="providers"
              caption={copy.providerConnections}
              rows={[...providers]}
              rowKey={(row) => row.provider}
              columns={[
                { id: "provider", header: "Provider", render: (row) => row.label },
                {
                  id: "state",
                  header: "Connection",
                  render: (row) => (
                    <span data-provider-state={row.provider}>
                      {row.state.kind === "connected"
                        ? `Connected${row.state.accountLabel ? ` · ${row.state.accountLabel}` : ""}`
                        : row.state.kind === "not_connected"
                          ? "Not connected"
                          : row.state.kind === "needs_reconnect"
                            ? row.state.reason
                            : row.state.reason}
                    </span>
                  ),
                },
                {
                  id: "action",
                  header: "Action",
                  render: (row) => {
                    const supported = connectSupported ? connectSupported(row.provider) : true;
                    const needsAction =
                      row.state.kind === "needs_reconnect" || row.state.kind === "not_connected";

                    // Role first, for every provider.
                    //
                    // Shopify's own start route is session-authenticated, but
                    // its callback and finalize handlers both require
                    // collaborator — so a guest sent into the install would be
                    // refused at the end of a long external round trip. The
                    // refusal belongs here, before anything leaves the product.
                    if (needsAction && authorizePermission && !authorizePermission.ok) {
                      return (
                        <span data-authorize-blocked={row.provider} style={{ color: "var(--ledger-ink-tertiary)", fontSize: 12 }}>
                          {authorizePermission.reason}
                        </span>
                      );
                    }

                    // Shopify is entered through Shopify, not through a generic
                    // OAuth start this product can begin.
                    if (row.provider === "shopify" && shopifyEntry && needsAction) {
                      return (
                        <span data-shopify-entry={shopifyEntry.kind} style={{ display: "grid", gap: 2 }}>
                          <a
                            data-shopify-action=""
                            href={shopifyEntry.href}
                            style={{ color: "var(--ledger-accent-action)", fontWeight: 600, minHeight: 44, display: "inline-flex", alignItems: "center" }}
                          >
                            {shopifyEntry.label}
                          </a>
                          {shopifyEntry.note ? (
                            <span data-shopify-note="" style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                              {shopifyEntry.note}
                            </span>
                          ) : null}
                        </span>
                      );
                    }

                    if (row.state.kind === "needs_reconnect") {
                      return supported ? (
                        <Button
                          variant="secondary"
                          data-reconnect={row.provider}
                          data-ctl="live:INTEGRATION-02"
                          onClick={() => onReconnect?.(row.provider)}
                        >
                          {copy.reconnect}
                        </Button>
                      ) : (
                        <span data-connect-unavailable={row.provider} style={{ color: "var(--ledger-ink-tertiary)", fontSize: 12 }}>
                          {CONNECT_UNSUPPORTED}
                        </span>
                      );
                    }
                    // First-time connection. Without this the only path to a
                    // never-connected provider was a dash: Flow H had no entry
                    // point at all on the canonical surface.
                    if (row.state.kind === "not_connected") {
                      return supported ? (
                        <Button
                          variant="secondary"
                          data-connect={row.provider}
                          data-ctl="live:INTEGRATION-03 connect"
                          onClick={() => onConnect?.(row.provider)}
                        >
                          {copy.connect}
                        </Button>
                      ) : (
                        <span data-connect-unavailable={row.provider} style={{ color: "var(--ledger-ink-tertiary)", fontSize: 12 }}>
                          {CONNECT_UNSUPPORTED}
                        </span>
                      );
                    }
                    // A connected provider used to render an em dash — the
                    // one state where the reader has something to do (move the
                    // account, change the property or site, take it off) and
                    // the row offered nothing at all.
                    if (row.state.kind === "connected") {
                      return (
                        <ProviderRowActions
                          provider={row.provider}
                          disconnectPermission={authorizePermission}
                          onReassign={onReassignProvider}
                          onDetails={onProviderDetails}
                          onDisconnect={onDisconnectProvider}
                        />
                      );
                    }
                    return <span style={{ color: "var(--ledger-ink-tertiary)" }}>—</span>;
                  },
                },
              ]}
            />
          </div>
          </div>
          <CeremonyResult outcome={outcome} name="reconnect" />
          {assignment ? <AssignmentPanel {...assignment} /> : null}
          {ga4Selection ? (
            <SelectionPanel kind="ga4_property" title={copy.ga4Property} {...ga4Selection} />
          ) : null}
          {searchConsoleSelection ? (
            <SelectionPanel kind="search_console_site" title={copy.searchConsoleSite} {...searchConsoleSelection} />
          ) : null}
        </>
      )}
    </Shell>
  );
}

/**
 * Account assignment and reassignment.
 *
 * The selection is seeded from the **served** `assigned` flags and re-seeded
 * whenever they change, so what is ticked is what the backend says is assigned
 * rather than what this session last clicked.
 */
function AssignmentPanel({
  provider,
  accounts,
  notice,
  unavailable,
  state,
  permission,
  onProviderChange,
  onSave,
  onCancel,
}: AssignmentPanelProps) {
  const copy = useCopy();
  const served = accounts.filter((account) => account.assigned).map((account) => account.id);
  const servedKey = served.join(",");
  const [draft, setDraft] = useState<string[]>(served);

  /**
   * Who owns the draft, and when ownership ends.
   *
   * The panel started by re-seeding from the served set on every change, so a
   * read landing after the operator had ticked a box silently replaced their
   * selection and Save sent the old set. The first fix stopped that but never
   * gave ownership back: one tick made the panel deaf to every later served
   * change, for the rest of its life.
   *
   * Ownership now has a beginning and an end. It begins at the first tick. It
   * ends only in three ways, and each is a thing the operator actually did:
   *
   *  - **A save the server confirmed by re-reading.** `state.confirmed` is that
   *    read-back, and it is the only success signal used here — the write
   *    returning is not evidence that anything was stored.
   *  - **Cancel**, which puts the served set back before the caller is told.
   *  - **Changing provider**, which is a different question about a different
   *    account list.
   *
   * A save that failed, or that has not been confirmed yet, keeps the draft, so
   * the operator can correct it and retry instead of retyping it.
   *
   * `baseKey` is what makes this race-free. It records the served set the draft
   * currently corresponds to, so re-seeding is driven by "the served truth has
   * moved" rather than by an effect firing. On a confirmed save it is set to
   * what was saved, so the fresh read arriving a moment later is recognised as
   * agreement and does not flicker the selection back through the old value.
   */
  const [dirty, setDirty] = useState(false);
  const [baseKey, setBaseKey] = useState(servedKey);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (dirty || servedKey === baseKey) return;
    setDraft(servedKey ? servedKey.split(",") : []);
    setBaseKey(servedKey);
  }, [dirty, servedKey, baseKey]);

  // A different provider is a different question, so the answer starts over
  // from that provider's served truth rather than carrying an edit across.
  useEffect(() => {
    setDirty(false);
    setSubmitted(false);
    setDraft(servedKey ? servedKey.split(",") : []);
    setBaseKey(servedKey);
    // Deliberately keyed on the provider alone: this is the reset, and it must
    // not re-run every time the served set moves underneath it.
  }, [provider]);

  // The end of a save, judged by the read-back and never by the write.
  useEffect(() => {
    if (!submitted || state.pending) return;
    if (state.confirmed) {
      setSubmitted(false);
      setDirty(false);
      // What was saved is now the base, so the fresh read that follows is
      // agreement rather than a change to adopt.
      setBaseKey(draft.join(","));
      return;
    }
    if (state.error) {
      // Nothing landed. The draft stays exactly as the operator left it.
      setSubmitted(false);
    }
  }, [submitted, state.pending, state.confirmed, state.error, draft]);

  const restoreServed = () => {
    setDraft(servedKey ? servedKey.split(",") : []);
    setBaseKey(servedKey);
    setDirty(false);
    setSubmitted(false);
  };

  return (
    <section data-assignment-panel={provider} data-el="assignment-sheet" aria-label={copy.accountAssignment} style={{ marginTop: 24 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.assignedAccounts}</h2>

      <label htmlFor="assignment-provider" style={{ display: "block", fontSize: 12, fontWeight: 600, margin: "8px 0 4px" }}>
        {copy.provider}
      </label>
      <select
        id="assignment-provider"
        data-assignment-provider=""
        value={provider}
        onChange={(event) => onProviderChange?.(event.target.value)}
        style={{ minHeight: 44, padding: "8px 10px", maxWidth: 240 }}
      >
        <option value="meta">Meta</option>
        <option value="google">Google Ads</option>
      </select>

      {notice ? (
        <p data-assignment-notice="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
          {notice}
        </p>
      ) : null}

      {unavailable ? (
        <p data-assignment-unavailable="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
          {unavailable}
        </p>
      ) : !permission.ok ? (
        <p data-assignment-blocked="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
          {permission.reason}
        </p>
      ) : (
        <>
          <ul data-assignment-accounts="" data-collection="accounts" style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
            {accounts.map((account) => (
              <li key={account.id} style={{ fontSize: 12 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
                  <input
                    type="checkbox"
                    data-assignment-account={account.id}
                    data-ctl="live:INTEGRATION-07 assign"
                    checked={draft.includes(account.id)}
                    onChange={(event) => {
                      setDirty(true);
                      setDraft((current) =>
                        event.target.checked
                          ? [...current, account.id]
                          : current.filter((id) => id !== account.id),
                      );
                    }}
                  />
                  <span>
                    {account.name}
                    {account.isManager ? " (manager)" : ""}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <p role="status" aria-live="polite" data-assignment-progress="" style={{ margin: "6px 0 0", fontSize: 12, minHeight: 16 }}>
            {state.pending ? "Saving\u2026" : state.confirmed ?? ""}
          </p>
          {state.error ? (
            <p data-assignment-error="" style={{ margin: 0, fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
              {state.error}
            </p>
          ) : null}

          <div style={{ marginTop: 6 }}>
            <Button
              variant="secondary"
              data-assignment-save=""
              data-ctl="live:INTEGRATION-07 save"
              state={state.pending ? { kind: "busy", label: "Saving\u2026" } : { kind: "enabled" }}
              onClick={() => {
                setSubmitted(true);
                onSave?.(draft);
              }}
            >
              {copy.saveAssignment}
            </Button>
            {onCancel ? (
              <Button
                variant="quiet"
                data-assignment-cancel=""
                data-ctl="live:cancel"
                onClick={() => {
                  // Restored first, so the caller is never told to discard
                  // something the panel is still showing.
                  restoreServed();
                  onCancel();
                }}
                style={{ marginLeft: 6 }}
              >
                {copy.cancel}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- team */

export interface TeamWriteState {
  /** Which control is mid-flight, so the surface can show progress. */
  pending: string | null;
  error: string | null;
  /** Set after the independent re-read confirmed the change landed. */
  confirmed: string | null;
}

export function TeamView({
  members,
  invites,
  accessRequests,
  workspaces,
  permissions,
  write,
  onChangeRole,
  onRemove,
  onInvite,
  onRevokeInvite,
  onResendInvite,
  onAccessRequest,
  onAssignWorkspaces,
  unavailableReason,
}: {
  members: readonly import("@/lib/zero-base/manage/team-contract").TeamMember[];
  invites: readonly import("@/lib/zero-base/manage/team-contract").TeamInvite[];
  accessRequests: readonly import("@/lib/zero-base/manage/team-contract").AccessRequest[];
  workspaces: readonly import("@/lib/zero-base/manage/team-contract").Workspace[];
  permissions: {
    membersWrite: { ok: boolean; reason?: string };
    invitesWrite: { ok: boolean; reason?: string };
    accessRequests: { ok: boolean; reason?: string };
  };
  write: TeamWriteState;
  onChangeRole?: (membershipId: string, role: string) => void;
  onRemove?: (membershipId: string) => void;
  onInvite?: (emails: string, role: string) => void;
  onRevokeInvite?: (inviteId: string) => void;
  /** Send the same invitation again. Absent where re-sending is not wired. */
  onResendInvite?: (inviteId: string) => void;
  onAccessRequest?: (membershipId: string, action: "approve" | "reject") => void;
  onAssignWorkspaces?: (memberUserId: string, workspaceIds: string[]) => void;
  unavailableReason?: string | null;
}) {
  const copy = useCopy();
  const [emails, setEmails] = useState("");
  const [inviteRole, setInviteRole] = useState("collaborator");

  if (unavailableReason) {
    return (
      <Shell title={copy.teamTitle}>
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={copy.teamTitle}>
      {/* One live region for every write on this surface. */}
      <p role="status" aria-live="polite" data-team-progress={write.pending ?? ""} style={{ margin: "8px 0 0", fontSize: 12, minHeight: 16 }}>
        {write.pending ? "Working\u2026" : write.confirmed ? write.confirmed : ""}
      </p>
      {write.error ? (
        <p data-team-error="" style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
          {write.error}
        </p>
      ) : null}

      {permissions.membersWrite.ok ? null : (
        <p data-team-blocked="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
          {permissions.membersWrite.reason}
        </p>
      )}

      <div data-team-layout="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(260px, 1fr)", gap: 14, alignItems: "start" }}>
      <section data-team-invite="" aria-label={copy.invitations} style={{ marginTop: 20, gridColumn: 2, gridRow: 1 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.invitations}</h2>
        {permissions.invitesWrite.ok ? (
          <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
            <TextInput
              label={copy.emailAddresses}
              data-invite-emails=""
              value={emails}
              onChange={(event) => setEmails(event.target.value)}
              hint={copy.emailsHint}
            />
            <select
              data-invite-role=""
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value)}
              style={{ minHeight: 44, padding: "6px 8px", maxWidth: 200 }}
            >
              {["admin", "collaborator", "reviewer", "guest"].map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <div>
              <Button
                variant="secondary"
                data-invite-send=""
                data-ctl="gated:TEAM-04 invite"
                state={write.pending === "invite" ? { kind: "busy", label: "Sending\u2026" } : { kind: "enabled" }}
                onClick={() => onInvite?.(emails, inviteRole)}
              >
                {copy.sendInvitations}
              </Button>
            </div>
          </div>
        ) : (
          <p data-invite-blocked="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
            {permissions.invitesWrite.reason}
          </p>
        )}
      </section>

      <section aria-label={copy.members} data-el="role-permission-state" style={{ marginTop: 16, gridColumn: 1, gridRow: "1 / span 2" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.members}</h2>
        <div style={{ marginTop: 8 }}>
          <DataTable
            collection="members"
            density="dense"
            caption={copy.teamMembers}
            rows={[...members]}
            rowKey={(row) => row.membershipId}
            columns={[
              { id: "name", header: "Member", render: (row) => row.name },
              { id: "email", header: "Email", render: (row) => row.email ?? "Not served" },
              {
                id: "role",
                header: "Role",
                render: (row) =>
                  permissions.membersWrite.ok ? (
                    <select
                      data-member-role={row.membershipId}
                      data-ctl="gated:TEAM-02 role"
                      value={row.role}
                      onChange={(event) => onChangeRole?.(row.membershipId, event.target.value)}
                      style={{ minHeight: 44, padding: "6px 8px" }}
                    >
                      {["admin", "collaborator", "reviewer", "guest"].map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span data-member-role-readonly={row.membershipId} data-el="role-permission-state">
                      {row.role}
                    </span>
                  ),
              },
              { id: "status", header: "Status", render: (row) => row.status },
              {
                id: "workspaces",
                header: "Workspaces",
                render: (row) =>
                  permissions.membersWrite.ok && row.userId && workspaces.length > 0 ? (
                    <select
                      multiple
                      data-member-workspaces={row.userId}
                      onChange={(event) =>
                        onAssignWorkspaces?.(
                          row.userId as string,
                          Array.from(event.target.selectedOptions).map((option) => option.value),
                        )
                      }
                      style={{ minHeight: 44 }}
                    >
                      {workspaces.map((workspace) => (
                        <option key={workspace.id} value={workspace.id}>
                          {workspace.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span style={{ color: "var(--ledger-ink-tertiary)" }}>&mdash;</span>
                  ),
              },
              {
                id: "remove",
                header: "Remove",
                render: (row) =>
                  permissions.membersWrite.ok ? (
                    <Button
                      variant="quiet"
                      data-member-remove={row.membershipId}
                      data-ctl="gated:TEAM-03"
                      state={write.pending === row.membershipId ? { kind: "busy", label: "Removing\u2026" } : { kind: "enabled" }}
                      onClick={() => onRemove?.(row.membershipId)}
                    >
                      {copy.remove}
                    </Button>
                  ) : (
                    <span style={{ color: "var(--ledger-ink-tertiary)" }}>&mdash;</span>
                  ),
              },
            ]}
          />
        </div>
      </section>

      <section aria-label={copy.invitations} style={{ marginTop: 20, gridColumn: 2, gridRow: 2 }}>
        <div style={{ marginTop: 12 }}>
          <DataTable
            density="dense"
            caption={copy.pendingInvitations}
            rows={[...invites]}
            rowKey={(row) => row.id}
            columns={[
              { id: "email", header: "Email", render: (row) => row.email },
              { id: "role", header: "Role", render: (row) => row.role },
              { id: "status", header: "Status", render: (row) => row.status },
              {
                id: "revoke",
                header: "Actions",
                // A pending invitation has two answers, not one: send it again
                // because it was never received, or withdraw it. Offering only
                // "revoke" made the common case — a mail that went to spam —
                // reachable solely by withdrawing and starting over.
                render: (row) =>
                  permissions.invitesWrite.ok ? (
                    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 8 }}>
                      {onResendInvite ? (
                        <Button
                          variant="quiet"
                          data-invite-resend={row.id}
                          data-ctl="gated:TEAM-04"
                          state={
                            write.pending === row.id
                              ? { kind: "busy", label: "Sending\u2026" }
                              : { kind: "enabled" }
                          }
                          onClick={() => onResendInvite(row.id)}
                        >
                          {copy.resend}
                        </Button>
                      ) : null}
                      <Button
                        variant="quiet"
                        data-invite-revoke={row.id}
                        data-ctl="gated:TEAM-04"
                        state={write.pending === row.id ? { kind: "busy", label: "Withdrawing\u2026" } : { kind: "enabled" }}
                        onClick={() => onRevokeInvite?.(row.id)}
                      >
                        {copy.withdraw}
                      </Button>
                    </span>
                  ) : (
                    <span style={{ color: "var(--ledger-ink-tertiary)" }}>&mdash;</span>
                  ),
              },
            ]}
          />
        </div>
      </section>

      <section aria-label={copy.accessRequests} style={{ marginTop: 20, gridColumn: 2, gridRow: 3 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.accessRequests}</h2>
        {permissions.accessRequests.ok ? (
          <div style={{ marginTop: 8 }}>
            <DataTable
              density="dense"
              caption={copy.accessRequests}
              rows={[...accessRequests]}
              rowKey={(row) => row.membershipId}
              columns={[
                { id: "name", header: "Person", render: (row) => row.name },
                { id: "role", header: "Requested role", render: (row) => row.role },
                {
                  id: "decide",
                  header: "Decision",
                  render: (row) => (
                    <span style={{ display: "flex", gap: 6 }}>
                      <Button
                        variant="secondary"
                        data-access-approve={row.membershipId}
                        data-ctl="gated:TEAM-05 approve"
                        onClick={() => onAccessRequest?.(row.membershipId, "approve")}
                      >
                        {copy.approve}
                      </Button>
                      <Button
                        variant="quiet"
                        data-access-reject={row.membershipId}
                        data-ctl="gated:TEAM-05 deny"
                        onClick={() => onAccessRequest?.(row.membershipId, "reject")}
                      >
                        {copy.reject}
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          </div>
        ) : (
          <p data-access-blocked="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
            {permissions.accessRequests.reason}
          </p>
        )}
      </section>
      </div>
      <style>{`@media(max-width:980px){[data-team-layout]{grid-template-columns:1fr!important}[data-team-layout]>section{grid-column:1!important;grid-row:auto!important}}`}</style>
    </Shell>
  );
}

/* ------------------------------------------------------------- business */

export function BusinessView({
  businessId,
  economics,
  costModel,
  costPermission,
  costState,
  onSaveCostModel,
  recommendedMode,
  deleteOutcome,
  onDelete,
  canDelete,
  settings,
  settingsPermission,
  settingsState,
  onSaveSettings,
}: {
  businessId?: string;
  economics: readonly EconomicsField[];
  costModel?: AdaptedCostModel | null;
  costPermission?: { ok: boolean; reason?: string };
  costState?: { pending: boolean; error: string | null; confirmed: string | null };
  onSaveCostModel?: (next: {
    cogsPercent: number;
    shippingPercent: number;
    feePercent: number;
    fixedCost: number;
  }) => void;
  recommendedMode: string | null;
  deleteOutcome: CeremonyOutcome;
  onDelete?: () => void;
  canDelete: boolean;
  /** Current stored values, or null when they could not be read. */
  settings: { name: string; currency: string } | null;
  settingsPermission: { ok: boolean; reason?: string };
  settingsState: { pending: boolean; error: string | null; confirmed: string | null };
  onSaveSettings?: (next: { name: string; currency: string }) => void;
}) {
  const copy = useCopy();
  const divergence = economicsDivergence(economics);
  const [name, setName] = useState(settings?.name ?? "");
  const [currency, setCurrency] = useState(settings?.currency ?? "");
  const [costDraft, setCostDraft] = useState({
    cogsPercent: String((costModel?.cogsPercent ?? 0) * 100),
    shippingPercent: String((costModel?.shippingPercent ?? 0) * 100),
    feePercent: String((costModel?.feePercent ?? 0) * 100),
    fixedCost: String(costModel?.fixedCost ?? 0),
  });

  // The stored values arrive after the read; adopt them once they do.
  useEffect(() => {
    setName(settings?.name ?? "");
    setCurrency(settings?.currency ?? "");
  }, [settings]);
  useEffect(() => {
    if (!costModel) return;
    setCostDraft({
      cogsPercent: String(costModel.cogsPercent === null ? 0 : costModel.cogsPercent * 100),
      shippingPercent: String(costModel.shippingPercent === null ? 0 : costModel.shippingPercent * 100),
      feePercent: String(costModel.feePercent === null ? 0 : costModel.feePercent * 100),
      fixedCost: String(costModel.fixedCost ?? 0),
    });
  }, [costModel]);

  const parsedCostDraft = {
    cogsPercent: Number(costDraft.cogsPercent) / 100,
    shippingPercent: Number(costDraft.shippingPercent) / 100,
    feePercent: Number(costDraft.feePercent) / 100,
    fixedCost: Number(costDraft.fixedCost),
  };
  const costDraftValid =
    [
      parsedCostDraft.cogsPercent,
      parsedCostDraft.shippingPercent,
      parsedCostDraft.feePercent,
      parsedCostDraft.fixedCost,
    ].every(Number.isFinite) &&
    parsedCostDraft.cogsPercent >= 0 &&
    parsedCostDraft.cogsPercent <= 1 &&
    parsedCostDraft.shippingPercent >= 0 &&
    parsedCostDraft.shippingPercent <= 1 &&
    parsedCostDraft.feePercent >= 0 &&
    parsedCostDraft.feePercent <= 1 &&
    parsedCostDraft.fixedCost >= 0;

  return (
    <Shell title={copy.business}>
      <section aria-label={copy.workspaceSettings} style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.workspaceSettings}</h2>
        {settings === null ? (
          <p data-settings-unavailable="" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
            {copy.settingsUnreadable}
          </p>
        ) : settingsPermission.ok ? (
          <div data-el="biz-settings-form" style={{ marginTop: 8, display: "grid", gap: 6, maxWidth: 360 }}>
            <TextInput
              label={copy.workspaceName}
              data-business-name=""
              data-ctl="live:ECON-01 edit"
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint={copy.workspaceNameHint}
            />
            <TextInput
              label={copy.currency}
              data-business-currency=""
              data-ctl="live:ECON-03 edit"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              hint={copy.currencyHint}
            />
            <p
              role="status"
              aria-live="polite"
              data-settings-progress=""
              // Until the re-read lands, nothing is confirmed; saying so is the
              // difference between "sent" and "true".
              style={{ margin: 0, fontSize: 12, minHeight: 16 }}
            >
              {settingsState.pending ? "Saving\u2026" : settingsState.confirmed ?? ""}
            </p>
            {settingsState.error ? (
              <p data-settings-error="" style={{ margin: 0, fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
                {settingsState.error}
              </p>
            ) : null}
            <div>
              <Button
                variant="secondary"
                data-settings-save=""
                state={settingsState.pending ? { kind: "busy", label: "Saving\u2026" } : { kind: "enabled" }}
                onClick={() => onSaveSettings?.({ name, currency })}
              >
                {copy.saveSettings}
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <p data-settings-readonly="" style={{ margin: 0, fontSize: 12 }}>
              {settings.name} &middot; {settings.currency || "currency not served"}
            </p>
            <p data-settings-blocked="" style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
              {settingsPermission.reason}
            </p>
          </div>
        )}
      </section>

      <section aria-label={copy.economics} style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.economics}</h2>
        {divergence.diverged ? (
          <p data-economics-divergence="" data-el="econ-divergence" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
            {divergence.message}
          </p>
        ) : (
          <p data-economics-agree="" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            {copy.economicsAgree}
          </p>
        )}
        {businessId ? (
          <>
            <section data-cost-model-editor="" style={{ marginTop: 12, padding: 14, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Overview cost model</h3>
              <p style={{ margin: "4px 0 10px", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
                Used by overview profit estimates and reports. Percentages are stored as ratios and confirmed by a fresh read.
              </p>
              {costModel === null ? (
                <p data-cost-model-unavailable="" style={{ fontSize: 12, color: "var(--ledger-semantic-warn)" }}>The current cost model could not be read.</p>
              ) : (
                <div data-cost-model-grid="" style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(120px,1fr))", gap: 10 }}>
                  {([
                    ["cogsPercent", "COGS %"],
                    ["shippingPercent", "Shipping %"],
                    ["feePercent", "Fees %"],
                    ["fixedCost", `Fixed cost (${settings?.currency || "currency"})`],
                  ] as const).map(([key, label]) => (
                    <TextInput
                      key={key}
                      label={label}
                      data-cost-field={key}
                      inputMode="decimal"
                      value={costDraft[key]}
                      disabled={costPermission?.ok === false}
                      onChange={(event) => setCostDraft((current) => ({ ...current, [key]: event.target.value }))}
                    />
                  ))}
                </div>
              )}
              {costPermission?.ok === false ? <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>{costPermission.reason}</p> : null}
              {costState?.error ? <p role="alert" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>{costState.error}</p> : null}
              <p role="status" style={{ margin: "8px 0 0", minHeight: 16, fontSize: 12 }}>{costState?.pending ? "Saving…" : costState?.confirmed ?? ""}</p>
              {costModel !== null && costPermission?.ok !== false ? (
                <Button
                  variant="secondary"
                  data-cost-model-save=""
                  state={
                    costState?.pending
                      ? { kind: "busy", label: "Saving…" }
                      : !costDraftValid
                        ? {
                            kind: "disabled",
                            reason: "Percentages must be between 0 and 100. Fixed cost must be 0 or higher.",
                          }
                        : { kind: "enabled" }
                  }
                  onClick={() => {
                    if (costDraftValid) onSaveCostModel?.(parsedCostDraft);
                  }}
                >
                  Save cost model
                </Button>
              ) : null}
            </section>
            <div style={{ marginTop: 16 }} data-commercial-truth-editor="">
              <CommercialTruthSettingsSection businessId={businessId} />
            </div>
          </>
        ) : (
        <div data-collection="economics" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12, marginTop: 10 }}>
          {[...new Set(economics.map((row) => row.source))].map((source) => {
            const rows = economics.filter((row) => row.source === source);
            return (
              <section key={source} style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
                <h3 style={{ margin: 0, fontSize: 13 }}>{source}</h3>
                <p style={{ margin: "3px 0 8px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                  consumed by {rows.flatMap((row) => row.consumers).filter((value, index, all) => all.indexOf(value) === index).join(" + ") || "no surface"}
                </p>
                <dl style={{ margin: 0, display: "grid" }}>
                  {rows.map((row) => (
                    <div key={`${row.key}:${row.source}`} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, padding: "7px 0", borderTop: "1px solid var(--ledger-border-subtle)" }}>
                      <dt style={{ fontSize: 12 }}>{row.label}</dt>
                      <dd data-economics-consumers={row.key} title={`Read by ${row.consumers.join(", ") || "nothing"}`} style={{ margin: 0, minWidth: 56, padding: "1px 6px", border: "1px solid var(--ledger-border-control)", borderRadius: 4, textAlign: "right", fontFamily: "var(--font-adc-mono), monospace", fontSize: 12 }}>{row.value ?? "Not set"}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
        )}
      </section>
      <style>{`@media(max-width:900px){[data-cost-model-grid]{grid-template-columns:repeat(2,minmax(0,1fr))!important}}@media(max-width:560px){[data-cost-model-grid],[data-collection="economics"]{grid-template-columns:1fr!important}}`}</style>

      <section aria-label={copy.operatingMode} style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.recommendedMode}</h2>
        <p data-recommended-mode="" style={{ margin: "4px 0 0", fontSize: 13 }}>
          {recommendedMode ?? "Not served"}
        </p>
        {/* Read only: displayed, never editable. */}
        <p data-recommended-mode-note="" style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {RECOMMENDED_MODE_READ_ONLY}
        </p>
      </section>

      <section aria-label={copy.deleteBusiness} style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.deleteThisBusiness}</h2>
        <p data-delete-note="" style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
          {DELETE_CEREMONY_NOTE}
        </p>
        {/* Deleting is the one action here whose result the product cannot
            read back: the business it would re-read is gone. The warning is
            therefore the region the control lives in, not a line beside it. */}
        <div data-el={deleteOutcome.kind === "confirmed" ? undefined : "no-readback-warning"}>
        <Button
          variant="danger"
          data-business-delete=""
          data-ctl="gated:SCOPE-01 delete"
          state={canDelete ? { kind: "enabled" } : { kind: "disabled", reason: "Only a business admin can delete it." }}
          onClick={onDelete}
        >
          {copy.deleteBusiness}
        </Button>
        <CeremonyResult outcome={deleteOutcome} name="delete" />
        </div>
      </section>
    </Shell>
  );
}

/* ------------------------------------------------------------------ plan */

export function PlanView({
  planName,
  planId = null,
  monthlyPrice = null,
  status = null,
  storeName = null,
  source = null,
  managedPricingUrl = null,
  features,
}: {
  planName: string | null;
  planId?: string | null;
  monthlyPrice?: number | null;
  status?: string | null;
  storeName?: string | null;
  source?: string | null;
  managedPricingUrl?: string | null;
  features: readonly string[];
}) {
  const copy = useCopy();
  return (
    <Shell title={copy.planAndBilling}>
      <section style={{ maxWidth: 900, marginTop: 12, display: "grid", gap: 12 }}>
      <div style={{ border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)", padding: "14px 18px" }}>
        <p data-plan-name="" style={{ margin: 0, fontSize: 13 }}>
          <strong>Current plan: {planName ?? "Not served"}</strong>{" "}
          <span style={{ marginLeft: 8, padding: "3px 8px", borderRadius: 999, background: "var(--ledger-bg-inset)", color: "var(--ledger-ink-secondary)", font: "12px/1.2 var(--font-mono, monospace)" }}>
            {status ?? "status not served"}
          </span>
        </p>
        <p style={{ margin: "8px 0 0", fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-secondary)" }}>
          {monthlyPrice === null ? "Price not served" : `$${monthlyPrice}/month`} · {storeName ?? "No Shopify store attached"} · source {source ?? "not served"} · id {planId ?? "not served"}
        </p>
        <p style={{ margin: "8px 0 0", fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-secondary)" }}>Includes: {features.join(" · ")}.</p>
      </div>
      {/* Static presentation. No billing control, and no gating. */}
      <p
        data-plan-gates-nothing=""
        data-el="plan-presentation-chip"
        style={{ margin: 0, padding: "14px 18px", border: "1px dashed var(--ledger-border-control)", borderRadius: "var(--ledger-radius-card)", fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-secondary)" }}
      >
        <strong>{copy.featureAccessNotBillingGated}</strong> {PLAN_GATES_NOTHING}
      </p>
      {managedPricingUrl ? (
        <a
          data-el="billing-manage"
          href={managedPricingUrl}
          target="_blank"
          rel="noreferrer"
          style={{ display: "inline-flex", alignItems: "center", width: "fit-content", minHeight: 44, padding: "0 14px", border: "1px solid var(--ledger-border-control)", borderRadius: "var(--ledger-radius-button)", color: "var(--ledger-accent-action)", textDecoration: "none", fontSize: 13, fontWeight: 600 }}
        >
          Manage billing in Shopify
        </a>
      ) : (
        <p data-el="billing-unavailable" style={{ margin: 0, padding: "14px 18px", border: "1px dashed var(--ledger-border-control)", borderRadius: "var(--ledger-radius-card)", fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-secondary)" }}>
          Billing is not attached to a Shopify store for this business.
        </p>
      )}
      </section>
    </Shell>
  );
}
