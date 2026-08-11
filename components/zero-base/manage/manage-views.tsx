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
  PLAN_BILLING_ELSEWHERE,
  PLAN_GATES_NOTHING,
  RECOMMENDED_MODE_READ_ONLY,
  economicsDivergence,
  type CeremonyOutcome,
  type EconomicsField,
  type ProviderHealth,
} from "@/lib/zero-base/manage/manage-contract";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

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

export function IntegrationsView({
  providers,
  onReconnect,
  onConnect,
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
                        <Button variant="secondary" data-reconnect={row.provider} onClick={() => onReconnect?.(row.provider)}>
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
  const [draft, setDraft] = useState<string[]>(served);
  const servedKey = served.join(",");
  useEffect(() => {
    setDraft(servedKey ? servedKey.split(",") : []);
  }, [servedKey]);

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
                    onChange={(event) =>
                      setDraft((current) =>
                        event.target.checked
                          ? [...current, account.id]
                          : current.filter((id) => id !== account.id),
                      )
                    }
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
              onClick={() => onSave?.(draft)}
            >
              {copy.saveAssignment}
            </Button>
            {onCancel ? (
              <Button
                variant="quiet"
                data-assignment-cancel=""
                data-ctl="live:cancel"
                onClick={onCancel}
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

      <section aria-label={copy.members} data-el="role-permission-state" style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.members}</h2>
        <div style={{ marginTop: 8 }}>
          <DataTable
            collection="members"
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

      <section aria-label={copy.invitations} style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.invitations}</h2>
        {permissions.invitesWrite.ok ? (
          <div style={{ marginTop: 8, display: "grid", gap: 6, maxWidth: 420 }}>
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
        <div style={{ marginTop: 12 }}>
          <DataTable
            caption={copy.pendingInvitations}
            rows={[...invites]}
            rowKey={(row) => row.id}
            columns={[
              { id: "email", header: "Email", render: (row) => row.email },
              { id: "role", header: "Role", render: (row) => row.role },
              { id: "status", header: "Status", render: (row) => row.status },
              {
                id: "revoke",
                header: "Revoke",
                render: (row) =>
                  permissions.invitesWrite.ok ? (
                    <Button
                      variant="quiet"
                      data-invite-revoke={row.id}
                      data-ctl="gated:TEAM-04"
                      state={write.pending === row.id ? { kind: "busy", label: "Revoking\u2026" } : { kind: "enabled" }}
                      onClick={() => onRevokeInvite?.(row.id)}
                    >
                      {copy.revoke}
                    </Button>
                  ) : (
                    <span style={{ color: "var(--ledger-ink-tertiary)" }}>&mdash;</span>
                  ),
              },
            ]}
          />
        </div>
      </section>

      <section aria-label={copy.accessRequests} style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.accessRequests}</h2>
        {permissions.accessRequests.ok ? (
          <div style={{ marginTop: 8 }}>
            <DataTable
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
    </Shell>
  );
}

/* ------------------------------------------------------------- business */

export function BusinessView({
  economics,
  recommendedMode,
  deleteOutcome,
  onDelete,
  canDelete,
  settings,
  settingsPermission,
  settingsState,
  onSaveSettings,
}: {
  economics: readonly EconomicsField[];
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

  // The stored values arrive after the read; adopt them once they do.
  useEffect(() => {
    setName(settings?.name ?? "");
    setCurrency(settings?.currency ?? "");
  }, [settings]);

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
              data-el={settingsState.confirmed ? undefined : "no-readback-warning"}
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
        <DataTable
          collection="economics"
          caption={copy.economicsSources}
          rows={[...economics]}
          rowKey={(row) => `${row.key}:${row.source}`}
          columns={[
            { id: "label", header: "Value", render: (row) => row.label },
            { id: "source", header: "Source", render: (row) => row.source },
            {
              id: "consumers",
              header: "Read by",
              render: (row) => (
                <span data-economics-consumers={row.key}>{row.consumers.join(", ") || "Nothing"}</span>
              ),
            },
            { id: "value", header: "Value", render: (row) => row.value ?? "Not set" },
          ]}
        />
      </section>

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
      </section>
    </Shell>
  );
}

/* ------------------------------------------------------------------ plan */

export function PlanView({ planName, features }: { planName: string | null; features: readonly string[] }) {
  const copy = useCopy();
  return (
    <Shell title={copy.plan}>
      <p
        data-el="billing-gated"
        style={{ margin: "12px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}
      >
        {/* Stated rather than implied by the absence of a button: an operator
            looking for an invoice needs to know where it is, not that it is
            missing here. */}
        {PLAN_BILLING_ELSEWHERE}
      </p>
      <p data-plan-name="" style={{ margin: "12px 0 0", fontSize: 13 }}>
        {planName ?? "Not served"}
      </p>
      <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
        {features.map((feature) => (
          <li key={feature} style={{ fontSize: 12 }}>
            {feature}
          </li>
        ))}
      </ul>
      {/* Static presentation. No billing control, and no gating. */}
      <p
        data-plan-gates-nothing=""
        data-el="plan-presentation-chip"
        style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}
      >
        {PLAN_GATES_NOTHING}
      </p>
    </Shell>
  );
}
