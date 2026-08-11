"use client";

/**
 * Data boundaries for the Manage routes.
 *
 * Reconnect and delete each end with an independent read of the resulting
 * state — the POST's own response is never treated as an observation. There is
 * no billing call anywhere here, asserted by a call-site scan.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  BusinessView,
  IntegrationsView,
  PlanView,
  TeamView,
} from "@/components/zero-base/manage/manage-views";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import {
  adaptCommercialTarget,
  adaptCostModel,
  businessFromList,
  businessSettingsBody,
  type BusinessSettings,
  adaptProviderHealth,
  adaptRecommendedMode,
  confirmDeletionFromList,
  oauthStartUrl,
  resolveCeremony,
  type CeremonyOutcome,
  type EconomicsField,
  type ProviderHealth,
  type ProviderId,
} from "@/lib/zero-base/manage/manage-contract";
import type { SurfaceState } from "@/lib/zero-base/state-types";
import {
  adaptAccessRequests,
  adaptInvites,
  adaptMembers,
  adaptWorkspaces,
  accessRequestBody,
  inviteBody,
  memberRoleBody,
  memberWorkspacesBody,
  removeMemberBody,
  revokeInviteBody,
  teamPermission,
  type AccessRequest,
  type TeamInvite,
  type TeamMember,
  type Workspace,
} from "@/lib/zero-base/manage/team-contract";
import type { TeamWriteState } from "@/components/zero-base/manage/manage-views";
import {
  adaptAccessibleAccounts,
  getProviderFetchPath,
  isAssignableProvider,
  saveProviderAssignments,
  type AssignableProvider,
  type AssignmentAccount,
} from "@/lib/zero-base/manage/assignment-contract";

/** A read that yields null on any failure, so callers can tell "unknown" apart. */
async function getJson(path: string): Promise<unknown | null> {
  const response = await fetch(path, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return null;
  return response.json().catch(() => null);
}

function toPermission(result: { ok: true } | { ok: false; reason: string }) {
  return result.ok ? { ok: true as const } : { ok: false as const, reason: result.reason };
}

const PROVIDERS: ProviderId[] = ["meta", "google", "shopify", "ga4", "search_console"];

export function IntegrationsClient({ businessId, role }: { businessId: string; role?: string | null }) {
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CeremonyOutcome>({ kind: "unstarted" });
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading integrations" });
  const [nonce, setNonce] = useState(0);

  const read = useCallback(async () => {
    const response = await fetch(
      `/api/integrations/status?businessId=${encodeURIComponent(businessId)}`,
      { cache: "no-store" },
    ).catch(() => null);
    if (!response?.ok) return null;
    return (await response.json().catch(() => null)) as unknown;
  }, [businessId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const body = await read();
      if (cancelled) return;
      if (body === null) {
        setReason("Integration status could not be read for this business.");
      } else {
        setProviders(adaptProviderHealth(body, PROVIDERS));
      }
      setSurface({ kind: "ready" });
    })();
    return () => {
      cancelled = true;
    };
  }, [read, nonce]);

  /**
   * Reconnecting is an OAuth round trip, not a POST.
   *
   * `/api/integrations` has GET and DELETE only — the previous POST answered
   * 405 every time. The operator leaves for the provider and comes back, so
   * this navigates rather than mutating.
   */
  /**
   * Begin an authorization round trip.
   *
   * First-time connect and reconnect are the same OAuth start with the same
   * sanitized returnTo — the provider does not distinguish them, and giving
   * them separate paths would mean two chances to get the return wrong.
   */
  const beginOauth = useCallback(
    (provider: string) => {
      const url = oauthStartUrl({ provider, businessId });
      if (!url) {
        setOutcome({
          kind: "failed",
          detail: `There is no OAuth start route for ${provider}, so a reconnect cannot begin here.`,
        });
        return;
      }
      window.location.assign(url);
    },
    [businessId],
  );

  /**
   * On return from the provider, re-read status and report only what was
   * observed. The redirect having happened is not evidence of anything.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const returned = params.get("reconnected");
    if (!returned) return;
    let cancelled = false;
    (async () => {
      const body = await read();
      if (cancelled) return;
      const rows = body === null ? null : adaptProviderHealth(body, PROVIDERS);
      const observed =
        rows === null ? null : rows.find((r) => r.provider === returned)?.state.kind === "connected";
      setOutcome(
        resolveCeremony({
          accepted: true,
          acceptError: null,
          observed,
          observeError: body === null ? "The confirming read failed." : null,
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [read]);

  /* ------------------------------------------------------------ assignment */

  const [assignProvider, setAssignProvider] = useState<AssignableProvider>("meta");
  const [accounts, setAccounts] = useState<AssignmentAccount[]>([]);
  const [assignNotice, setAssignNotice] = useState<string | null>(null);
  const [assignUnavailable, setAssignUnavailable] = useState<string | null>(null);
  const [assignState, setAssignState] = useState<{ pending: boolean; error: string | null; confirmed: string | null }>({
    pending: false,
    error: null,
    confirmed: null,
  });

  const readAccounts = useCallback(async () => {
    const path = getProviderFetchPath(assignProvider, businessId);
    if (!path) {
      setAssignUnavailable(`There is no account discovery route for ${assignProvider}.`);
      return null;
    }
    const response = await fetch(path, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) {
      setAssignUnavailable(
        `Accessible accounts could not be read (HTTP ${response?.status ?? "no response"}).`,
      );
      return null;
    }
    const adapted = adaptAccessibleAccounts(await response.json().catch(() => null));
    if (!adapted.ok) {
      setAssignUnavailable(adapted.reason);
      return null;
    }
    setAssignUnavailable(null);
    setAssignNotice(adapted.notice);
    setAccounts(adapted.accounts);
    return adapted.accounts;
  }, [assignProvider, businessId]);

  useEffect(() => {
    void readAccounts();
  }, [readAccounts]);

  /**
   * Save, then re-read the discovery route.
   *
   * `saveProviderAssignments` echoes the draft back when the request fails, so
   * its return value is never treated as evidence — the error field decides,
   * and only the independent re-read confirms.
   */
  const saveAssignment = useCallback(
    async (accountIds: string[]) => {
      setAssignState({ pending: true, error: null, confirmed: null });
      const result = await saveProviderAssignments({
        provider: assignProvider,
        businessId,
        draftIds: accountIds,
      });
      if (result.error) {
        setAssignState({ pending: false, error: result.error, confirmed: null });
        return;
      }
      const observed = await readAccounts();
      if (!observed) {
        setAssignState({
          pending: false,
          error: "The assignment was accepted but the confirming read failed, so the current state is unknown.",
          confirmed: null,
        });
        return;
      }
      const now = new Set(observed.filter((account) => account.assigned).map((account) => account.id));
      const matches = accountIds.every((id) => now.has(id)) && now.size === accountIds.length;
      setAssignState(
        matches
          ? { pending: false, error: null, confirmed: "Assignment saved and confirmed by a fresh read." }
          : {
              pending: false,
              error: "The assignment was accepted but the re-read does not show it. Treat it as unresolved.",
              confirmed: null,
            },
      );
    },
    [assignProvider, businessId, readAccounts],
  );

  return (
    <SurfaceStateBoundary state={surface}>
      <IntegrationsView
        providers={providers}
        outcome={outcome}
        assignment={{
          provider: assignProvider,
          accounts,
          notice: assignNotice,
          unavailable: assignUnavailable,
          state: assignState,
          permission:
            role === "admin" || role === "collaborator"
              ? { ok: true }
              : {
                  ok: false,
                  reason: `Assigning accounts needs the collaborator role. Your role on this workspace is ${role ?? "not reported"}.`,
                },
          onProviderChange: (next) => {
            if (isAssignableProvider(next)) {
              setAssignProvider(next);
              // A confirmation from the previous provider would be a lie here.
              setAssignState({ pending: false, error: null, confirmed: null });
            }
          },
          onSave: (ids) => void saveAssignment(ids),
        }}
        unavailableReason={reason}
        onReconnect={(provider) => beginOauth(provider)}
        onConnect={(provider) => beginOauth(provider)}
        connectSupported={(provider) => oauthStartUrl({ provider, businessId }) !== null}
      />
    </SurfaceStateBoundary>
  );
}

export function TeamClient({ businessId, role }: { businessId: string; role: string | null }) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading team" });
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [write, setWrite] = useState<TeamWriteState>({ pending: null, error: null, confirmed: null });

  const permissions = useMemo(
    () => ({
      membersWrite: toPermission(teamPermission({ role, operation: "membersWrite" })),
      invitesWrite: toPermission(teamPermission({ role, operation: "invitesWrite" })),
      accessRequests: toPermission(teamPermission({ role, operation: "accessRequestsRead" })),
    }),
    [role],
  );

  /** Reads each collection independently; a 403 on one must not blank the rest. */
  const readMembers = useCallback(async () => {
    const body = await getJson(`/api/team/members?businessId=${encodeURIComponent(businessId)}`);
    const rows = adaptMembers(body);
    if (rows) setMembers(rows);
    return rows;
  }, [businessId]);

  const readInvites = useCallback(async () => {
    const body = await getJson(`/api/team/invites?businessId=${encodeURIComponent(businessId)}`);
    const rows = adaptInvites(body);
    if (rows) setInvites(rows);
    return rows;
  }, [businessId]);

  const readRequests = useCallback(async () => {
    if (!permissions.accessRequests.ok) return null;
    const body = await getJson(`/api/team/access-requests?businessId=${encodeURIComponent(businessId)}`);
    const rows = adaptAccessRequests(body);
    if (rows) setRequests(rows);
    return rows;
  }, [businessId, permissions.accessRequests.ok]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const memberRows = await readMembers();
      if (cancelled) return;
      if (memberRows === null) {
        setUnavailable("The team could not be read for this workspace.");
        setSurface({ kind: "ready" });
        return;
      }
      await Promise.all([readInvites(), readRequests()]);
      if (cancelled) return;
      const workspaceRows = adaptWorkspaces(await getJson("/api/team/workspaces"));
      if (cancelled) return;
      if (workspaceRows) setWorkspaces(workspaceRows);
      setSurface({ kind: "ready" });
    })();
    return () => {
      cancelled = true;
    };
  }, [readMembers, readInvites, readRequests]);

  /**
   * One write, then an **independent re-read** of the collection it touched.
   *
   * A 200 is what the server said, not what the collection now contains, so
   * nothing is confirmed until the re-read shows it.
   */
  const perform = useCallback(
    async (input: {
      key: string;
      path: string;
      method: "POST" | "PATCH" | "DELETE";
      body: unknown;
      confirmedLabel: string;
      reread: () => Promise<unknown>;
      /** Reads the re-read result and says whether the change is visible. */
      landed: (rows: unknown) => boolean;
    }) => {
      setWrite({ pending: input.key, error: null, confirmed: null });
      const response = await fetch(input.path, {
        method: input.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.body),
      }).catch(() => null);

      if (!response?.ok) {
        const json = (await response?.json().catch(() => null)) as { message?: string } | null;
        setWrite({ pending: null, error: json?.message ?? "That change was refused.", confirmed: null });
        return;
      }

      const rows = await input.reread();
      if (rows === null || rows === undefined) {
        setWrite({
          pending: null,
          error: "The change was accepted but the confirming read failed, so the current state is unknown.",
          confirmed: null,
        });
        return;
      }
      if (!input.landed(rows)) {
        setWrite({
          pending: null,
          error: "The change was accepted but the re-read does not show it. Treat it as unresolved.",
          confirmed: null,
        });
        return;
      }
      setWrite({ pending: null, error: null, confirmed: input.confirmedLabel });
    },
    [],
  );

  return (
    <SurfaceStateBoundary state={surface}>
      <TeamView
        members={members}
        invites={invites}
        accessRequests={requests}
        workspaces={workspaces}
        permissions={permissions}
        write={write}
        unavailableReason={unavailable}
        onChangeRole={(membershipId, nextRole) =>
          void perform({
            key: membershipId,
            path: "/api/team/members",
            method: "PATCH",
            body: memberRoleBody({ businessId, membershipId, role: nextRole }),
            confirmedLabel: "Role updated and confirmed by a fresh read.",
            reread: readMembers,
            landed: (rows) =>
              (rows as TeamMember[]).some((row) => row.membershipId === membershipId && row.role === nextRole),
          })
        }
        onRemove={(membershipId) =>
          void perform({
            key: membershipId,
            path: "/api/team/members",
            method: "DELETE",
            body: removeMemberBody({ businessId, membershipId }),
            confirmedLabel: "Member removed and confirmed by a fresh read.",
            reread: readMembers,
            landed: (rows) => !(rows as TeamMember[]).some((row) => row.membershipId === membershipId),
          })
        }
        onAssignWorkspaces={(memberUserId, workspaceIds) =>
          void perform({
            key: memberUserId,
            path: "/api/team/members",
            method: "PATCH",
            body: memberWorkspacesBody({ businessId, memberUserId, workspaceIds }),
            confirmedLabel: "Workspace access updated and confirmed by a fresh read.",
            reread: async () =>
              adaptWorkspaces(
                await getJson(
                  `/api/team/members?businessId=${encodeURIComponent(businessId)}&memberUserId=${encodeURIComponent(memberUserId)}`,
                ),
              ),
            landed: (rows) => {
              const ids = new Set((rows as Workspace[]).map((row) => row.id));
              return workspaceIds.every((id) => ids.has(id));
            },
          })
        }
        onInvite={(emails, inviteRole) => {
          const body = inviteBody({
            businessId,
            emails: emails.split(",").map((email) => email.trim()),
            role: inviteRole,
          });
          if ("error" in body) {
            setWrite({ pending: null, error: body.error, confirmed: null });
            return;
          }
          const wanted = body.emails.map((email) => email.toLowerCase());
          void perform({
            key: "invite",
            path: "/api/team/invites",
            method: "POST",
            body,
            confirmedLabel: "Invitations sent and confirmed by a fresh read.",
            reread: readInvites,
            landed: (rows) => {
              const present = new Set((rows as TeamInvite[]).map((row) => row.email.toLowerCase()));
              return wanted.every((email) => present.has(email));
            },
          });
        }}
        onRevokeInvite={(inviteId) =>
          void perform({
            key: inviteId,
            path: "/api/team/invites",
            method: "PATCH",
            body: revokeInviteBody({ businessId, inviteId }),
            confirmedLabel: "Invitation revoked and confirmed by a fresh read.",
            reread: readInvites,
            landed: (rows) =>
              !(rows as TeamInvite[]).some((row) => row.id === inviteId && row.status !== "revoked"),
          })
        }
        onAccessRequest={(membershipId, action) =>
          void perform({
            key: membershipId,
            path: "/api/team/access-requests",
            method: "POST",
            body: accessRequestBody({ businessId, membershipId, action }),
            confirmedLabel:
              action === "approve"
                ? "Access approved and confirmed by a fresh read."
                : "Access rejected and confirmed by a fresh read.",
            reread: readRequests,
            landed: (rows) => !(rows as AccessRequest[]).some((row) => row.membershipId === membershipId),
          })
        }
      />
    </SurfaceStateBoundary>
  );
}

export function BusinessClient({ businessId, role }: { businessId: string; role: string | null }) {
  const [economics, setEconomics] = useState<EconomicsField[]>([]);
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [settingsState, setSettingsState] = useState<{ pending: boolean; error: string | null; confirmed: string | null }>({
    pending: false,
    error: null,
    confirmed: null,
  });
  const [recommendedMode, setMode] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CeremonyOutcome>({ kind: "unstarted" });
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading business" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const q = `businessId=${encodeURIComponent(businessId)}`;
      // No GET on the business route, so current values come from the list.
      const current = businessFromList(await getJson("/api/businesses"), businessId);
      if (!cancelled && current) setSettings(current);
      // Three different authorities. The cost model carries no target ROAS and
      // no recommended mode; reading them off it produced empty rows forever.
      const [costRaw, commercialRaw, modeRaw] = await Promise.all([
        fetch(`/api/business-cost-model?${q}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch(`/api/business-commercial-settings?${q}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch(`/api/business-operating-mode?${q}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (cancelled) return;

      const cost = adaptCostModel(costRaw);
      const commercial = adaptCommercialTarget(commercialRaw);
      const fields: EconomicsField[] = [];

      if (cost) {
        for (const [key, label] of [
          ["cogsPercent", "COGS %"],
          ["shippingPercent", "Shipping %"],
          ["feePercent", "Fees %"],
          ["fixedCost", "Fixed cost"],
        ] as const) {
          fields.push({
            key,
            label,
            source: "Cost model",
            consumers: ["Decision engine", "Reports"],
            value: cost[key] === null ? null : String(cost[key]),
          });
        }
      }
      fields.push({
        key: "targetRoas",
        label: "Target ROAS",
        source: "Commercial settings",
        consumers: ["Decision engine"],
        value: commercial?.targetRoas === null || commercial === null ? null : String(commercial.targetRoas),
      });

      setEconomics(fields);
      setMode(adaptRecommendedMode(modeRaw));
      setSurface({ kind: "ready" });
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const remove = useCallback(async () => {
    setOutcome({ kind: "submitted" });
    const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    }).catch(() => null);

    // Separate read from the LIST endpoint. `/api/businesses/[businessId]` has
    // no GET, so re-reading it answered 405 every time and the ceremony could
    // never confirm. Absence from the list is the read that can answer.
    const check = await fetch("/api/businesses", { cache: "no-store" }).catch(() => null);
    const listBody = check?.ok ? await check.json().catch(() => null) : null;
    const observed = confirmDeletionFromList({
      listOk: Boolean(check?.ok) && listBody !== null,
      businesses: (listBody as { businesses?: unknown } | null)?.businesses,
      deletedId: businessId,
    });

    setOutcome(
      resolveCeremony({
        accepted: Boolean(response?.ok),
        acceptError: response?.ok ? null : `The delete was refused (HTTP ${response?.status ?? "no response"}).`,
        observed,
        observeError: observed === null ? "The confirming read failed." : null,
      }),
    );
  }, [businessId]);

  /**
   * Save name and currency.
   *
   * The route takes both together and refuses a name under two characters, so
   * the body is validated first. It has no GET, so the confirming read goes
   * back to the collection the session can see.
   */
  const saveSettings = useCallback(
    async (next: { name: string; currency: string }) => {
      const body = businessSettingsBody(next);
      if ("error" in body) {
        setSettingsState({ pending: false, error: body.error, confirmed: null });
        return;
      }
      setSettingsState({ pending: true, error: null, confirmed: null });
      const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);

      if (!response?.ok) {
        const json = (await response?.json().catch(() => null)) as { message?: string } | null;
        setSettingsState({
          pending: false,
          error: json?.message ?? "The workspace settings were refused.",
          confirmed: null,
        });
        return;
      }

      const observed = businessFromList(await getJson("/api/businesses"), businessId);
      if (!observed) {
        setSettingsState({
          pending: false,
          error: "The change was accepted but the confirming read failed, so the stored values are unknown.",
          confirmed: null,
        });
        return;
      }
      if (observed.name !== body.name || observed.currency !== body.currency) {
        setSettingsState({
          pending: false,
          error: "The change was accepted but the re-read still shows the previous values.",
          confirmed: null,
        });
        return;
      }
      setSettings(observed);
      setSettingsState({ pending: false, error: null, confirmed: "Saved and confirmed by a fresh read." });
    },
    [businessId],
  );

  return (
    <SurfaceStateBoundary state={surface}>
      <BusinessView
        economics={economics}
        recommendedMode={recommendedMode}
        deleteOutcome={outcome}
        canDelete={role === "admin"}
        onDelete={() => void remove()}
        settings={settings}
        settingsPermission={
          role === "admin"
            ? { ok: true }
            : { ok: false, reason: "This needs the admin role. Your role on this workspace is " + (role ?? "not reported") + "." }
        }
        settingsState={settingsState}
        onSaveSettings={(next) => void saveSettings(next)}
      />
    </SurfaceStateBoundary>
  );
}

/** Static presentation. No billing read, no gating. */
export function PlanClient() {
  return (
    <PlanView
      planName="Adsecute"
      features={[
        "Meta and Google read surfaces",
        "Creative decision surfaces",
        "Reports",
      ]}
    />
  );
}
