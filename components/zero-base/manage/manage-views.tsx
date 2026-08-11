"use client";

/**
 * The Manage surfaces (H41–H47).
 *
 * Provider rows are per provider, ceremonies show their read-back outcome
 * rather than a response, and the plan panel states that it gates nothing.
 */
import { DataTable } from "@/components/zero-base/collections/data-table";
import { Button } from "@/components/zero-base/primitives/button";
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

export function IntegrationsView({
  providers,
  onReconnect,
  outcome,
  unavailableReason,
}: {
  providers: readonly ProviderHealth[];
  onReconnect?: (provider: string) => void;
  outcome: CeremonyOutcome;
  unavailableReason?: string | null;
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
        </>
      )}
    </Shell>
  );
}

/* ---------------------------------------------------------------- team */

export function TeamView({
  members,
  canManage,
  blockedReason,
}: {
  members: readonly { id: string; name: string; role: string; status: string }[];
  canManage: boolean;
  blockedReason: string | null;
}) {
  return (
    <Shell title="Team">
      {canManage ? null : (
        <p data-team-blocked="" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
          {blockedReason}
        </p>
      )}
      <div style={{ marginTop: 12 }}>
        <DataTable
          caption="Team members"
          rows={[...members]}
          rowKey={(row) => row.id}
          columns={[
            { id: "name", header: "Member", render: (row) => row.name },
            { id: "role", header: "Role", render: (row) => row.role },
            { id: "status", header: "Status", render: (row) => row.status },
          ]}
        />
      </div>
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
}: {
  economics: readonly EconomicsField[];
  recommendedMode: string | null;
  deleteOutcome: CeremonyOutcome;
  onDelete?: () => void;
  canDelete: boolean;
}) {
  const divergence = economicsDivergence(economics);
  return (
    <Shell title="Business">
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
