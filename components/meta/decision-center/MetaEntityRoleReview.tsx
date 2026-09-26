"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MetaOsStructureGroup, MetaOsStructureNode } from "@/lib/meta/decisions-os-contract";
import { entityRoleNameSuggestion } from "./entity-role-name-suggestion";
import styles from "./MetaEntityRoleReview.module.css";

type Role = "main" | "test" | "mixed";
type RoleChoice = Role | "revoke" | "";
type RoleRow = {
  key: string;
  node: MetaOsStructureNode;
  campaignName: string | null;
};
type RoleHistoryEvent = {
  id: string;
  entityType: "campaign" | "adset";
  entityId: string;
  parentCampaignId: string | null;
  event: "declare" | "revoke";
  declaredRole: Role | null;
  effectiveFrom: string;
  declaredAt: string;
  contractVersion: string;
};
type RoleReviewState =
  | { event: "declare"; role: Role }
  | { event: "revoke" }
  | { event: "unverified" };
const ROLE_DECLARATION_VERSION = "meta-entity-role-declaration.v1";

function roleRow(node: MetaOsStructureNode, campaignName: string | null): RoleRow | null {
  const id = node.providerEntityId?.trim();
  if (!id || !/^\d+$/.test(id)) return null;
  return { key: `${node.level}:${id}`, node, campaignName };
}

function currentRole(node: MetaOsStructureNode, review?: RoleReviewState): string {
  if (review?.event === "declare") {
    const alreadyInDecision = node.roleBasis === "declared" && node.lifecycleRole === review.role;
    return `Confirmed ${review.role.toUpperCase()}${alreadyInDecision ? "" : " · pending decision run"}`;
  }
  if (review?.event === "revoke") {
    return "Confirmation removed · pending decision run";
  }
  if (review?.event === "unverified") {
    return "Declaration belongs to another campaign · unverified";
  }
  const role = node.lifecycleRole;
  if (node.roleBasis === "declared" && (role === "main" || role === "test" || role === "mixed")) {
    return `Confirmed ${role.toUpperCase()}`;
  }
  if (role === "main" || role === "test" || role === "mixed") {
    return node.level === "adset"
      ? `Unverified · parent suggests ${role.toUpperCase()}`
      : `Unverified · system suggests ${role.toUpperCase()}`;
  }
  return "Unverified · no role evidence";
}

/** Recent account-scoped history is for review display only; it never grants a decision. */
function reviewStateFromHistory(
  events: readonly RoleHistoryEvent[],
  rows: readonly RoleRow[],
  asOf: string,
): Record<string, RoleReviewState> {
  const byKey: Record<string, RoleReviewState> = {};
  const visible = new Map(rows.map((row) => [row.key, row]));
  for (const event of [...events].sort((a, b) =>
    String(b.declaredAt ?? "").localeCompare(String(a.declaredAt ?? "")) ||
    String(b.id ?? "").localeCompare(String(a.id ?? "")))) {
    const key = `${event.entityType}:${event.entityId}`;
    const row = visible.get(key);
    if (!row || byKey[key] || event.contractVersion !== ROLE_DECLARATION_VERSION ||
        event.effectiveFrom > asOf || !/^\d{4}-\d{2}-\d{2}$/.test(event.effectiveFrom) ||
        !Number.isFinite(Date.parse(event.declaredAt))) {
      continue;
    }
    if (event.entityType === "adset" &&
        (!row.node.campaignId || event.parentCampaignId !== row.node.campaignId)) {
      byKey[key] = { event: "unverified" };
      continue;
    }
    if (event.event === "revoke") {
      byKey[key] = { event: "revoke" };
    } else if (event.event === "declare" &&
      (event.declaredRole === "main" || event.declaredRole === "test" ||
        (event.entityType === "campaign" && event.declaredRole === "mixed"))) {
      byKey[key] = { event: "declare", role: event.declaredRole };
    }
  }
  return byKey;
}

/** Operator assertion only. The client never computes a decision or promotes a suggestion. */
export function MetaEntityRoleReview({
  businessId,
  providerAccountId,
  groups,
  decisionAsOf,
  readOnly,
  onSaved,
}: {
  businessId: string;
  providerAccountId: string;
  groups: readonly MetaOsStructureGroup[];
  decisionAsOf?: string | null;
  readOnly: boolean;
  onSaved: () => Promise<unknown> | void;
}) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Record<string, RoleChoice>>({});
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewState, setReviewState] = useState<Record<string, RoleReviewState>>({});
  const [historyStatus, setHistoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const historyRequestVersion = useRef(0);
  const rows = useMemo(() => groups.flatMap((group) => {
    const campaign = roleRow(group.campaign, null);
    const adsets = group.adsets
      .map((node) => roleRow(node, group.campaign.name))
      .filter((row): row is RoleRow => row !== null);
    return campaign ? [campaign, ...adsets] : adsets;
  }), [groups]);
  // A retained verdict may still be blocked by its old role authority after
  // the latest role was confirmed. Count role review state, not verdict state.
  const unresolvedCount = rows.filter(({ key, node }) =>
    reviewState[key]?.event === "revoke" || reviewState[key]?.event === "unverified" ||
    (reviewState[key]?.event !== "declare" &&
      node.roleBasis !== "declared" && node.campaignRoleTrustedForAction !== true),
  ).length;
  const selected = rows.filter((row) => Boolean(choices[row.key]));
  const namedSuggestions = rows.flatMap(({ key, node }) => {
    const suggestion = entityRoleNameSuggestion(node.name);
    const current = reviewState[key];
    // A current declaration, a deliberate revocation, a parent-binding
    // conflict or an operator's selection always wins over a name hint.
    if (current || choices[key] || node.roleBasis === "declared" ||
        node.campaignRoleTrustedForAction === true ||
        (suggestion !== "main" && suggestion !== "test")) return [];
    return [{ key, role: suggestion }];
  });
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  // The server permits a one-day timezone bracket. When the latest generation
  // is dated yesterday, use that day so today's declaration can be considered
  // in a fresh recomputation. declaredAt remains today's true observation time.
  const effectiveFrom = decisionAsOf === yesterday ? yesterday : today;

  useEffect(() => {
    if (!open) return;
    const version = ++historyRequestVersion.current;
    setHistoryStatus("loading");
    void fetch(
      `/api/meta/entity-role-declarations?businessId=${encodeURIComponent(businessId)}&providerAccountId=${encodeURIComponent(providerAccountId)}`,
      { cache: "no-store", headers: { Accept: "application/json" } },
    ).then(async (response) => {
      const payload = await response.json().catch(() => null) as
        | { ok?: boolean; declarations?: RoleHistoryEvent[] }
        | null;
      if (version !== historyRequestVersion.current) return;
      if (!response.ok || !payload?.ok || !Array.isArray(payload.declarations)) {
        setHistoryStatus("error");
        return;
      }
      setReviewState(reviewStateFromHistory(payload.declarations, rows, today));
      setHistoryStatus("ready");
    }).catch(() => {
      if (version === historyRequestVersion.current) setHistoryStatus("error");
    });
    return () => { ++historyRequestVersion.current; };
  }, [open, businessId, providerAccountId, rows, today, historyRefresh]);

  function selectNamedRoles() {
    if (readOnly || pending || historyStatus !== "ready") return;
    setChoices((previous) => ({
      ...previous,
      ...Object.fromEntries(namedSuggestions.slice(0, Math.max(0, 200 - selected.length))
        .map(({ key, role }) => [key, role])),
    }));
  }

  async function save() {
    if (pending || readOnly || historyStatus !== "ready" || selected.length === 0 || selected.length > 200) return;
    setPending(true);
    setNotice(null);
    let submissionUncertain = false;
    try {
      const requests = selected.map(({ node, key }) => ({
        entityType: node.level,
        entityId: node.providerEntityId!,
        event: choices[key] === "revoke" ? "revoke" as const : "declare" as const,
        role: choices[key] === "revoke" ? null : choices[key],
        effectiveFrom,
        reason: "Operator reviewed entity role in Meta Decisions",
      }));
      const response = await fetch("/api/meta/entity-role-declarations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ businessId, providerAccountId, declarations: requests }),
      }).catch((error) => {
        submissionUncertain = true;
        throw error;
      });
      const payload = await response.json().catch(() => null) as
        | { ok?: boolean; error?: { message?: string }; declarations?: Array<{ id: string; entityType: string; entityId: string; event: string; declaredRole: string | null }> }
        | null;
      const acknowledgementMatches = Boolean(payload?.ok &&
        payload.declarations?.length === requests.length &&
        payload.declarations.every((item, index) =>
            item.entityType === requests[index]!.entityType &&
            item.entityId === requests[index]!.entityId &&
            item.event === requests[index]!.event &&
            item.declaredRole === requests[index]!.role));
      if (response.status >= 500 || (response.ok && !acknowledgementMatches)) submissionUncertain = true;
      if (!response.ok || !acknowledgementMatches) {
        throw new Error(payload?.error?.message ?? "Role declarations could not be saved.");
      }
      const savedDeclarations = payload!.declarations!;
      // Any failure after acknowledgement needs a read-only reconciliation;
      // never leave the form ready to blindly repeat an append-only write.
      submissionUncertain = true;
      // A write response is not readback. Verify the same account's persisted
      // events before telling the operator that the roles are confirmed.
      const readback = await fetch(
        `/api/meta/entity-role-declarations?businessId=${encodeURIComponent(businessId)}&providerAccountId=${encodeURIComponent(providerAccountId)}`,
        { cache: "no-store", headers: { Accept: "application/json" } },
      );
      const history = await readback.json().catch(() => null) as
        | { ok?: boolean; declarations?: Array<{ id: string; entityType: string; entityId: string; event: string; declaredRole: string | null }> }
        | null;
      const persisted = new Map(history?.declarations?.map((item) => [item.id, item]) ?? []);
      if (!readback.ok || !history?.ok || !savedDeclarations.every((item) => {
        const stored = persisted.get(item.id);
        return stored?.entityType === item.entityType &&
          stored.entityId === item.entityId &&
          stored.event === item.event &&
          stored.declaredRole === item.declaredRole;
      })) {
        throw new Error("Roles were submitted, but their database readback could not be verified. Refresh before retrying.");
      }
      const nextReviewState = reviewStateFromHistory(
        history.declarations as RoleHistoryEvent[], rows, today,
      );
      if (!selected.every(({ key }, index) => {
        const recorded = nextReviewState[key];
        const requested = requests[index]!;
        return requested.event === "revoke"
          ? recorded?.event === "revoke"
          : recorded?.event === "declare" && recorded.role === requested.role;
      })) {
        throw new Error("Roles were submitted, but their current account and campaign binding could not be verified. Refresh role history before retrying.");
      }
      ++historyRequestVersion.current;
      setReviewState(nextReviewState);
      setChoices({});
      submissionUncertain = false;
      const confirmed = `${requests.length} role${requests.length === 1 ? "" : "s"} confirmed. Existing verdicts keep their recorded authority; the next native decision run will reassess them.`;
      try {
        await onSaved();
        setNotice(confirmed);
      } catch {
        setNotice(`${confirmed} The screen did not refresh; reload it to see the saved roles.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Role review failed.";
      if (submissionUncertain) {
        setChoices({});
        setHistoryStatus("error");
      }
      setNotice(submissionUncertain
        ? `${message} Submission status is uncertain; check role history before retrying.`
        : message);
    } finally {
      setPending(false);
    }
  }

  if (rows.length === 0) return null;
  return (
    <section className={styles.panel} data-meta-entity-role-review>
      <button className={styles.toggle} type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>Review Main / Test roles</span>
        <span>{unresolvedCount} unverified · {rows.length} campaign / ad set rows</span>
      </button>
      {open ? (
        <div className={styles.body}>
          <p>Confirm each campaign and ad set separately; a Main campaign can contain a Test ad set. Clear MAIN / TEST words in an entity's own name can fill your selections for review.</p>
          <p>Roles apply from {effectiveFrom}. Saved roles will be used in the next decision run.</p>
          {readOnly ? <p className={styles.notice}>This account is read-only for you.</p> : null}
          <div className={styles.suggestions}>
            <button type="button" disabled={readOnly || pending || historyStatus !== "ready" || namedSuggestions.length === 0 || selected.length >= 200} onClick={selectNamedRoles}>
              Select {Math.min(namedSuggestions.length, Math.max(0, 200 - selected.length))} roles from names
            </button>
            <span>Review the selections, then confirm. Ambiguous names remain unselected.</span>
          </div>
          {historyStatus === "loading" ? <p role="status">Loading saved roles…</p> : null}
          {historyStatus === "error" ? (
            <p className={styles.notice} role="alert">
              Saved roles could not be verified. Refresh role history before confirming.
              {" "}<button type="button" disabled={pending} onClick={() => setHistoryRefresh((value) => value + 1)}>Refresh role history</button>
            </p>
          ) : null}
          <div className={styles.rows}>
            {rows.map(({ key, node, campaignName }) => (
              <label className={styles.row} key={key} data-role-entity={key}>
                <span className={styles.identity}>
                  <strong>{node.name}</strong>
                  <small>{node.level === "adset" ? `Ad set · ${campaignName ?? "Campaign unknown"}` : "Campaign"} · {node.providerEntityId}</small>
                </span>
                <span className={styles.current}>
                  {currentRole(node, reviewState[key])}
                  {entityRoleNameSuggestion(node.name) === "conflict"
                    ? <small>Name contains MAIN and TEST · choose this entity's role</small>
                    : null}
                </span>
                <select
                  aria-label={`Confirm role for ${node.level} ${node.name}`}
                  disabled={readOnly || pending}
                  value={choices[key] ?? ""}
                  onChange={(event) => setChoices((old) => ({ ...old, [key]: event.target.value as RoleChoice }))}
                >
                  <option value="">No change</option>
                  <option value="main">Confirm Main</option>
                  <option value="test">Confirm Test</option>
                  {node.level === "campaign" ? <option value="mixed">Confirm Mixed</option> : null}
                  {reviewState[key]?.event === "declare" ||
                  (reviewState[key]?.event !== "revoke" && node.roleBasis === "declared")
                    ? <option value="revoke">Remove confirmed role</option> : null}
                </select>
              </label>
            ))}
          </div>
          <div className={styles.footer}>
            <span>{selected.length} role{selected.length === 1 ? "" : "s"} selected</span>
            <button type="button" disabled={readOnly || pending || historyStatus !== "ready" || selected.length === 0 || selected.length > 200} onClick={() => void save()}>
              {pending ? "Verifying…" : "Confirm selected roles"}
            </button>
          </div>
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
