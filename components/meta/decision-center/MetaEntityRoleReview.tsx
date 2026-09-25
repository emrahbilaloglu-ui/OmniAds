"use client";

import { useMemo, useState } from "react";
import type { MetaOsStructureGroup, MetaOsStructureNode } from "@/lib/meta/decisions-os-contract";
import styles from "./MetaEntityRoleReview.module.css";

type Role = "main" | "test" | "mixed";
type RoleChoice = Role | "revoke" | "";
type RoleRow = {
  key: string;
  node: MetaOsStructureNode;
  campaignName: string | null;
};

function roleRow(node: MetaOsStructureNode, campaignName: string | null): RoleRow | null {
  const id = node.providerEntityId?.trim();
  if (!id || !/^\d+$/.test(id)) return null;
  return { key: `${node.level}:${id}`, node, campaignName };
}

function currentRole(node: MetaOsStructureNode): string {
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
  const rows = useMemo(() => groups.flatMap((group) => {
    const campaign = roleRow(group.campaign, null);
    const adsets = group.adsets
      .map((node) => roleRow(node, group.campaign.name))
      .filter((row): row is RoleRow => row !== null);
    return campaign ? [campaign, ...adsets] : adsets;
  }), [groups]);
  // A retained verdict may still be blocked by its old role authority after
  // the latest role was confirmed. Count role review state, not verdict state.
  const unresolvedCount = rows.filter(({ node }) =>
    node.roleBasis !== "declared" && node.campaignRoleTrustedForAction !== true,
  ).length;
  const selected = rows.filter((row) => Boolean(choices[row.key]));
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  // The server permits a one-day timezone bracket. When the latest generation
  // is dated yesterday, use that day so today's declaration can be considered
  // in a fresh recomputation. declaredAt remains today's true observation time.
  const effectiveFrom = decisionAsOf === yesterday ? yesterday : today;

  async function save() {
    if (pending || readOnly || selected.length === 0) return;
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
      if (response.ok && !acknowledgementMatches) submissionUncertain = true;
      if (!response.ok || !acknowledgementMatches) {
        throw new Error(payload?.error?.message ?? "Role declarations could not be saved.");
      }
      const savedDeclarations = payload!.declarations!;
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
      setChoices({});
      setNotice(`${requests.length} role${requests.length === 1 ? "" : "s"} confirmed. Refreshing decision context; existing verdicts keep their recorded authority until regenerated.`);
      await onSaved();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Role review failed.";
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
          <p>Meta does not supply a Main / Test field. Each campaign and ad set has its own role; a Main campaign can contain a Test ad set. Suggestions below are not confirmed roles.</p>
          <p>Selections take effect from {effectiveFrom}. The recorded confirmation time remains today; earlier point-in-time replays cannot use it.</p>
          {readOnly ? <p className={styles.notice}>This account is read-only for you.</p> : null}
          <div className={styles.rows}>
            {rows.map(({ key, node, campaignName }) => (
              <label className={styles.row} key={key} data-role-entity={key}>
                <span className={styles.identity}>
                  <strong>{node.name}</strong>
                  <small>{node.level === "adset" ? `Ad set · ${campaignName ?? "Campaign unknown"}` : "Campaign"} · {node.providerEntityId}</small>
                </span>
                <span className={styles.current}>{currentRole(node)}</span>
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
                  {node.roleBasis === "declared" ? <option value="revoke">Remove confirmed role</option> : null}
                </select>
              </label>
            ))}
          </div>
          <div className={styles.footer}>
            <span>{selected.length} role{selected.length === 1 ? "" : "s"} selected</span>
            <button type="button" disabled={readOnly || pending || selected.length === 0 || selected.length > 200} onClick={() => void save()}>
              {pending ? "Verifying…" : "Confirm selected roles"}
            </button>
          </div>
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
