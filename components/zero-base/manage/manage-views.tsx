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
      <p role="status" data-ceremony={`${name}:submitted`} style={{ margin: "6px 0 0", fontSize: 12.5 }}>
        Applying, then reading the result back…
      </p>
    );
  }
  const tone =
    outcome.kind === "confirmed" ? "var(--ledger-semantic-ok)" : "var(--ledger-semantic-warn)";
  return (
    <p role="status" data-ceremony={`${name}:${outcome.kind}`} style={{ margin: "6px 0 0", fontSize: 12.5, color: tone }}>
      {outcome.detail}
    </p>
  );
}

/* --------------------------------------------------------- integrations */

export interface AssignmentPanelProps {
  provider: string;
  accounts: readonly { id: string; name: string; assigned: boolean; isManager: boolean }[];
  notice: string | null;
  unavailable: string | null;
  state: { pending: boolean; error: string | null; confirmed: string | null };
  permission: { ok: boolean; reason?: string };
  onProviderChange?: (provider: string) => void;
  onSave?: (accountIds: string[]) => void;
}

export function IntegrationsView({
  providers,
  onReconnect,
  outcome,
  unavailableReason,
  assignment,
}: {
  providers: readonly ProviderHealth[];
  onReconnect?: (provider: string) => void;
  outcome: CeremonyOutcome;
  unavailableReason?: string | null;
  assignment?: AssignmentPanelProps;
}) {
  return (
    <Shell title="Integrations">
      {unavailableReason ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      ) : (
        <>
          <p data-no-universal-health="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            {NO_UNIVERSAL_HEALTH}
          </p>
          <div style={{ marginTop: 12 }}>
            <DataTable
              caption="Provider connections"
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
                  render: (row) =>
                    row.state.kind === "needs_reconnect" ? (
                      <Button variant="secondary" data-reconnect={row.provider} onClick={() => onReconnect?.(row.provider)}>
                        Reconnect
                      </Button>
                    ) : (
                      <span style={{ color: "var(--ledger-ink-tertiary)" }}>—</span>
                    ),
                },
              ]}
            />
          </div>
          <CeremonyResult outcome={outcome} name="reconnect" />
          {assignment ? <AssignmentPanel {...assignment} /> : null}
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
}: AssignmentPanelProps) {
  const served = accounts.filter((account) => account.assigned).map((account) => account.id);
  const [draft, setDraft] = useState<string[]>(served);
  const servedKey = served.join(",");
  useEffect(() => {
    setDraft(servedKey ? servedKey.split(",") : []);
  }, [servedKey]);

  return (
    <section data-assignment-panel={provider} aria-label="Account assignment" style={{ marginTop: 24 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Assigned accounts</h2>

      <label htmlFor="assignment-provider" style={{ display: "block", fontSize: 12, fontWeight: 600, margin: "8px 0 4px" }}>
        Provider
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
        <p data-assignment-unavailable="" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
          {unavailable}
        </p>
      ) : !permission.ok ? (
        <p data-assignment-blocked="" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
          {permission.reason}
        </p>
      ) : (
        <>
          <ul data-assignment-accounts="" style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
            {accounts.map((account) => (
              <li key={account.id} style={{ fontSize: 12.5 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
                  <input
                    type="checkbox"
                    data-assignment-account={account.id}
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
            <p data-assignment-error="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
              {state.error}
            </p>
          ) : null}

          <div style={{ marginTop: 6 }}>
            <Button
              variant="secondary"
              data-assignment-save=""
              state={state.pending ? { kind: "busy", label: "Saving\u2026" } : { kind: "enabled" }}
              onClick={() => onSave?.(draft)}
            >
              Save assignment
            </Button>
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
  const [emails, setEmails] = useState("");
  const [inviteRole, setInviteRole] = useState("collaborator");

  if (unavailableReason) {
    return (
      <Shell title="Team">
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Team">
      {/* One live region for every write on this surface. */}
      <p role="status" aria-live="polite" data-team-progress={write.pending ?? ""} style={{ margin: "8px 0 0", fontSize: 12.5, minHeight: 16 }}>
        {write.pending ? "Working\u2026" : write.confirmed ? write.confirmed : ""}
      </p>
      {write.error ? (
        <p data-team-error="" style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
          {write.error}
        </p>
      ) : null}

      {permissions.membersWrite.ok ? null : (
        <p data-team-blocked="" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
          {permissions.membersWrite.reason}
        </p>
      )}

      <section aria-label="Members" style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Members</h2>
        <div style={{ marginTop: 8 }}>
          <DataTable
            caption="Team members"
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
                    <span data-member-role-readonly={row.membershipId}>{row.role}</span>
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
                      state={write.pending === row.membershipId ? { kind: "busy", label: "Removing\u2026" } : { kind: "enabled" }}
                      onClick={() => onRemove?.(row.membershipId)}
                    >
                      Remove
                    </Button>
                  ) : (
                    <span style={{ color: "var(--ledger-ink-tertiary)" }}>&mdash;</span>
                  ),
              },
            ]}
          />
        </div>
      </section>

      <section aria-label="Invitations" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Invitations</h2>
        {permissions.invitesWrite.ok ? (
          <div style={{ marginTop: 8, display: "grid", gap: 6, maxWidth: 420 }}>
            <TextInput
              label="Email addresses"
              data-invite-emails=""
              value={emails}
              onChange={(event) => setEmails(event.target.value)}
              hint="Comma separated. The route refuses an empty list."
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
                state={write.pending === "invite" ? { kind: "busy", label: "Sending\u2026" } : { kind: "enabled" }}
                onClick={() => onInvite?.(emails, inviteRole)}
              >
                Send invitations
              </Button>
            </div>
          </div>
        ) : (
          <p data-invite-blocked="" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
            {permissions.invitesWrite.reason}
          </p>
        )}
        <div style={{ marginTop: 12 }}>
          <DataTable
            caption="Pending invitations"
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
                      state={write.pending === row.id ? { kind: "busy", label: "Revoking\u2026" } : { kind: "enabled" }}
                      onClick={() => onRevokeInvite?.(row.id)}
                    >
                      Revoke
                    </Button>
                  ) : (
                    <span style={{ color: "var(--ledger-ink-tertiary)" }}>&mdash;</span>
                  ),
              },
            ]}
          />
        </div>
      </section>

      <section aria-label="Access requests" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Access requests</h2>
        {permissions.accessRequests.ok ? (
          <div style={{ marginTop: 8 }}>
            <DataTable
              caption="Access requests"
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
                        onClick={() => onAccessRequest?.(row.membershipId, "approve")}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="quiet"
                        data-access-reject={row.membershipId}
                        onClick={() => onAccessRequest?.(row.membershipId, "reject")}
                      >
                        Reject
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          </div>
        ) : (
          <p data-access-blocked="" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
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
  const divergence = economicsDivergence(economics);
  const [name, setName] = useState(settings?.name ?? "");
  const [currency, setCurrency] = useState(settings?.currency ?? "");

  // The stored values arrive after the read; adopt them once they do.
  useEffect(() => {
    setName(settings?.name ?? "");
    setCurrency(settings?.currency ?? "");
  }, [settings]);

  return (
    <Shell title="Business">
      <section aria-label="Workspace settings" style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Workspace settings</h2>
        {settings === null ? (
          <p data-settings-unavailable="" style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
            The current name and currency could not be read, so they are not shown.
          </p>
        ) : settingsPermission.ok ? (
          <div style={{ marginTop: 8, display: "grid", gap: 6, maxWidth: 360 }}>
            <TextInput
              label="Workspace name"
              data-business-name=""
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint="At least two characters — the route refuses anything shorter."
            />
            <TextInput
              label="Currency"
              data-business-currency=""
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              hint="Required on every save; the route takes name and currency together."
            />
            <p role="status" aria-live="polite" data-settings-progress="" style={{ margin: 0, fontSize: 12, minHeight: 16 }}>
              {settingsState.pending ? "Saving\u2026" : settingsState.confirmed ?? ""}
            </p>
            {settingsState.error ? (
              <p data-settings-error="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
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
                Save settings
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <p data-settings-readonly="" style={{ margin: 0, fontSize: 12.5 }}>
              {settings.name} &middot; {settings.currency || "currency not served"}
            </p>
            <p data-settings-blocked="" style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
              {settingsPermission.reason}
            </p>
          </div>
        )}
      </section>

      <section aria-label="Economics" style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Economics</h2>
        {divergence.diverged ? (
          <p data-economics-divergence="" style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
            {divergence.message}
          </p>
        ) : (
          <p data-economics-agree="" style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>
            The economics sources in scope agree.
          </p>
        )}
        <DataTable
          caption="Economics sources"
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

      <section aria-label="Operating mode" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Recommended mode</h2>
        <p data-recommended-mode="" style={{ margin: "4px 0 0", fontSize: 13 }}>
          {recommendedMode ?? "Not served"}
        </p>
        {/* Read only: displayed, never editable. */}
        <p data-recommended-mode-note="" style={{ margin: "4px 0 0", fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
          {RECOMMENDED_MODE_READ_ONLY}
        </p>
      </section>

      <section aria-label="Delete business" style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Delete this business</h2>
        <p data-delete-note="" style={{ margin: "4px 0 8px", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
          {DELETE_CEREMONY_NOTE}
        </p>
        <Button
          variant="danger"
          data-business-delete=""
          state={canDelete ? { kind: "enabled" } : { kind: "disabled", reason: "Only a business admin can delete it." }}
          onClick={onDelete}
        >
          Delete business
        </Button>
        <CeremonyResult outcome={deleteOutcome} name="delete" />
      </section>
    </Shell>
  );
}

/* ------------------------------------------------------------------ plan */

export function PlanView({ planName, features }: { planName: string | null; features: readonly string[] }) {
  return (
    <Shell title="Plan">
      <p data-plan-name="" style={{ margin: "12px 0 0", fontSize: 13 }}>
        {planName ?? "Not served"}
      </p>
      <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
        {features.map((feature) => (
          <li key={feature} style={{ fontSize: 12.5 }}>
            {feature}
          </li>
        ))}
      </ul>
      {/* Static presentation. No billing control, and no gating. */}
      <p data-plan-gates-nothing="" style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
        {PLAN_GATES_NOTHING}
      </p>
    </Shell>
  );
}
