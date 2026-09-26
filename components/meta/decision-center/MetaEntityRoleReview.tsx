"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Check, CheckCheck, ChevronDown, GitBranch, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import type { MetaOsStructureGroup, MetaOsStructureNode } from "@/lib/meta/decisions-os-contract";
import { entityRoleNameSuggestion } from "./entity-role-name-suggestion";
import styles from "./MetaEntityRoleReview.module.css";

type Role = "main" | "test" | "mixed";
type RoleChoice = "main" | "test" | "revoke" | "";
type ExceptionChoice = "main" | "test" | "inherit";
type CampaignGroup = { campaign: RoleRow; adsets: RoleRow[] };
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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "unverified" | "selected">("all");
  const [choices, setChoices] = useState<Record<string, RoleChoice>>({});
  const [exceptions, setExceptions] = useState<Record<string, ExceptionChoice>>({});
  const [exceptionCampaign, setExceptionCampaign] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [savedProgress, setSavedProgress] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewState, setReviewState] = useState<Record<string, RoleReviewState>>({});
  const [historyStatus, setHistoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const historyRequestVersion = useRef(0);
  const campaigns = useMemo<CampaignGroup[]>(() => groups.flatMap((group) => {
    const campaign = roleRow(group.campaign, null);
    if (!campaign) return [];
    const adsets = group.adsets.map((node) => roleRow(node, group.campaign.name))
      .filter((row): row is RoleRow => row !== null);
    return [{ campaign, adsets }];
  }), [groups]);
  const rows = useMemo(() => campaigns.flatMap(({ campaign, adsets }) => [campaign, ...adsets]), [campaigns]);

  function confirmedRole({ key, node }: RoleRow): Role | null {
    const recorded = reviewState[key];
    if (recorded) return recorded.event === "declare" ? recorded.role : null;
    return node.roleBasis === "declared" &&
      (node.lifecycleRole === "main" || node.lifecycleRole === "test" || node.lifecycleRole === "mixed")
      ? node.lifecycleRole : null;
  }
  function campaignDefault(group: CampaignGroup): "main" | "test" | null {
    const choice = choices[group.campaign.key];
    if (choice === "revoke") return null;
    const role = choice || confirmedRole(group.campaign);
    return role === "main" || role === "test" ? role : null;
  }
  function exceptionRole(group: CampaignGroup, adset: RoleRow): "main" | "test" | null {
    const draft = exceptions[adset.key];
    if (draft) return draft === "inherit" ? null : draft;
    const saved = confirmedRole(adset);
    const previousDefault = confirmedRole(group.campaign);
    // Keep existing, explicitly confirmed differences. Names and parent
    // suggestions never silently create an exception.
    return (saved === "main" || saved === "test") && saved !== previousDefault ? saved : null;
  }
  function activeExceptions(group: CampaignGroup) {
    return group.adsets.filter((adset) => {
      const role = exceptionRole(group, adset);
      return role && role !== campaignDefault(group);
    });
  }
  function needsReview(group: CampaignGroup) {
    const role = confirmedRole(group.campaign);
    return (role !== "main" && role !== "test") || group.adsets.some((row) => !confirmedRole(row));
  }
  function hasDraft(group: CampaignGroup) {
    return Boolean(choices[group.campaign.key]) || group.adsets.some(({ key }) => Boolean(exceptions[key]));
  }
  const unresolvedCount = campaigns.filter(needsReview).length;
  const selectedCampaigns = campaigns.filter(hasDraft);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCampaigns = campaigns.filter((group) =>
    (filter !== "unverified" || needsReview(group)) &&
    (filter !== "selected" || hasDraft(group)) &&
    (!normalizedQuery || `${group.campaign.node.name} ${group.campaign.node.providerEntityId}`
      .toLocaleLowerCase().includes(normalizedQuery)),
  );
  const namedSuggestions = visibleCampaigns.flatMap((group) => {
    const { key, node } = group.campaign;
    const current = reviewState[key];
    if (choices[key] || !needsReview(group) || (current && current.event !== "declare")) return [];
    const suggestion = confirmedRole(group.campaign) ?? entityRoleNameSuggestion(node.name);
    return suggestion === "main" || suggestion === "test" ? [{ key, role: suggestion }] : [];
  });
  const controlsDisabled = readOnly || pending || historyStatus !== "ready";

  function chooseCampaign(group: CampaignGroup, role: RoleChoice) {
    if (controlsDisabled) return;
    // Selecting even an already-confirmed campaign can confirm its current
    // undeclared ad sets together, without a separate selection for each one.
    setChoices((old) => ({ ...old, [group.campaign.key]: old[group.campaign.key] === role ? "" : role }));
  }
  function chooseException(group: CampaignGroup, adset: RoleRow, role: ExceptionChoice) {
    if (controlsDisabled) return;
    setExceptions((old) => ({ ...old, [adset.key]: role === campaignDefault(group) ? "inherit" : role }));
  }
  function clearDrafts() { setChoices({}); setExceptions({}); }
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
      if (historyRefresh > 0) setNotice("Saved roles reloaded. You can continue your review.");
    }).catch(() => {
      if (version === historyRequestVersion.current) setHistoryStatus("error");
    });
    return () => { ++historyRequestVersion.current; };
  }, [open, businessId, providerAccountId, rows, today, historyRefresh]);

  function selectNamedRoles() {
    if (controlsDisabled) return;
    setChoices((previous) => ({ ...previous, ...Object.fromEntries(namedSuggestions.map(({ key, role }) => [key, role])) }));
  }

  // Campaign-first review is expanded into explicit entity declarations. The
  // existing source, account, parent and decision-run authority checks still
  // apply to every ad set. This is an assertion about the CURRENT listed set,
  // not automatic authority for unseen/future ad sets or historical runs.
  const requests = selectedCampaigns.flatMap((group) => {
    const choice = choices[group.campaign.key];
    const role = campaignDefault(group);
    const previousDefault = confirmedRole(group.campaign);
    const changed: Array<{ key: string; entityType: "campaign" | "adset"; entityId: string; event: "declare" | "revoke"; role: Role | null; effectiveFrom: string; reason: string }> = [];
    function add(row: RoleRow, value: Role | null, reason: string) {
      if (confirmedRole(row) === value) return;
      changed.push({ key: row.key, entityType: row.node.level as "campaign" | "adset", entityId: row.node.providerEntityId!,
        event: value ? "declare" : "revoke", role: value, effectiveFrom, reason });
    }
    if (choice) add(group.campaign, choice === "revoke" ? null : choice, "Operator confirmed campaign role and its current ad set defaults");
    for (const adset of group.adsets) {
      if (choice === "revoke") {
        if (confirmedRole(adset) === previousDefault) add(adset, null, "Operator removed campaign role and matching current ad set defaults");
      } else if (role && (choice || exceptions[adset.key])) {
        const exception = exceptionRole(group, adset);
        add(adset, exception ?? role, exception && exception !== role
          ? "Operator selected an explicit ad set exception"
          : "Operator confirmed the campaign role for this current ad set");
      }
    }
    return changed;
  });
  const missingDefaults = selectedCampaigns.some((group) => choices[group.campaign.key] !== "revoke" && !campaignDefault(group));
  const affectedAdsetCount = requests.filter((request) => request.entityType === "adset").length;

  async function save() {
    if (pending || readOnly || historyStatus !== "ready" || requests.length === 0 || missingDefaults) return;
    setPending(true);
    setNotice(null);
    setSavedProgress(0);
    let verifiedCount = 0;
    let submissionUncertain = false;
    try {
      let finalReviewState = reviewState;
      for (let offset = 0; offset < requests.length; offset += 200) {
        const batch = requests.slice(offset, offset + 200);
        const response = await fetch("/api/meta/entity-role-declarations", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          cache: "no-store",
          body: JSON.stringify({ businessId, providerAccountId, declarations: batch.map(({ key: _key, ...request }) => request) }),
        }).catch((error) => {
          submissionUncertain = true;
          throw error;
        });
        const payload = await response.json().catch(() => null) as
          | { ok?: boolean; error?: { message?: string }; declarations?: Array<{ id: string; entityType: string; entityId: string; event: string; declaredRole: string | null }> }
          | null;
        const acknowledgementMatches = Boolean(payload?.ok &&
          payload.declarations?.length === batch.length &&
          payload.declarations.every((item, index) =>
              item.entityType === batch[index]!.entityType &&
              item.entityId === batch[index]!.entityId &&
              item.event === batch[index]!.event &&
              item.declaredRole === batch[index]!.role));
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
        if (!batch.every((requested) => {
          const recorded = nextReviewState[requested.key];
          return requested.event === "revoke"
            ? recorded?.event === "revoke"
            : recorded?.event === "declare" && recorded.role === requested.role;
        })) {
          throw new Error("Roles were submitted, but their current account and campaign binding could not be verified. Refresh role history before retrying.");
        }
        finalReviewState = { ...finalReviewState, ...nextReviewState };
        verifiedCount += batch.length;
        setSavedProgress(verifiedCount);
        submissionUncertain = false;
      }
      ++historyRequestVersion.current;
      setReviewState(finalReviewState);
      clearDrafts();
      submissionUncertain = false;
      const confirmed = `${selectedCampaigns.length} campaign${selectedCampaigns.length === 1 ? "" : "s"} saved, including ${affectedAdsetCount} ad set${affectedAdsetCount === 1 ? "" : "s"}. New decisions will use these roles.`;
      try {
        await onSaved();
        setNotice(confirmed);
      } catch {
        setNotice(`${confirmed} The screen did not refresh; reload it to see the saved roles.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Role review failed.";
      if (submissionUncertain || verifiedCount > 0) {
        clearDrafts();
        setHistoryStatus("error");
      }
      setNotice(verifiedCount > 0
        ? `${verifiedCount} entity roles were verified before the remaining save stopped. ${message} Reload role history before retrying.`
        : submissionUncertain ? `${message} Submission status is uncertain; check role history before retrying.` : message);
    } finally {
      setPending(false);
    }
  }

  if (campaigns.length === 0) return null;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
      <Dialog.Trigger asChild>
        <button className={styles.trigger} type="button" data-meta-entity-role-review>
          <SlidersHorizontal size={16} aria-hidden="true" />
          <span>Main / Test roles</span>
          <span className={styles.triggerCount}>{selectedCampaigns.length ? `${selectedCampaigns.length} selected` : `${unresolvedCount} to review`}</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} onInteractOutside={(event) => event.preventDefault()}>
          <header className={styles.header}>
            <div className={styles.heading}>
              <span className={styles.headerIcon}><GitBranch size={22} aria-hidden="true" /></span>
              <div>
                <Dialog.Title className={styles.title}>Main / Test roles</Dialog.Title>
                <Dialog.Description className={styles.description}>Set the campaign role. Only choose ad sets when there is an exception.</Dialog.Description>
              </div>
            </div>
            <Dialog.Close className={styles.iconButton} disabled={pending} aria-label="Close role review"><X size={20} aria-hidden="true" /></Dialog.Close>
          </header>
          <div className={styles.toolbar}>
            <div className={styles.searchRow}>
              <label className={styles.search}>
                <Search size={17} aria-hidden="true" />
                <input aria-label="Search campaigns" placeholder="Search campaigns…" value={query} onChange={(event) => setQuery(event.target.value)} />
                {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X size={16} aria-hidden="true" /></button> : null}
              </label>
              <div className={styles.filters} role="group" aria-label="Filter campaigns">
                {([["all", "All", campaigns.length], ["unverified", "To review", unresolvedCount], ["selected", "Selected", selectedCampaigns.length]] as const).map(([value, label, count]) => (
                  <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} <span>{count}</span></button>
                ))}
              </div>
            </div>
            <p className={styles.contextNote}>Confirming a campaign applies its role to its current ad sets. Existing exceptions are kept.</p>
          </div>
          {namedSuggestions.length > 0 ? <div className={styles.suggestions}>
            <div><CheckCheck size={19} aria-hidden="true" /><span>
              <strong>{namedSuggestions.length} campaign {namedSuggestions.length === 1 ? "suggestion" : "suggestions"}</strong>
              <small>Use the suggested campaign roles, then adjust any exceptions.</small>
            </span></div>
            <button type="button" className={styles.secondaryButton} disabled={controlsDisabled} onClick={selectNamedRoles}>Use {namedSuggestions.length} suggested {namedSuggestions.length === 1 ? "role" : "roles"}</button>
          </div> : null}
          {readOnly ? <p className={styles.notice}>This account is read-only for you.</p> : null}
          {historyStatus === "loading" ? <p className={styles.notice} role="status">Loading saved roles…</p> : null}
          {historyStatus === "error" ? <div className={styles.error} role="alert"><span>Saved roles could not be verified. Reload them before confirming.</span><button type="button" className={styles.secondaryButton} disabled={pending} onClick={() => setHistoryRefresh((value) => value + 1)}>Refresh role history</button></div> : null}
          <div className={styles.list} aria-label="Campaign roles" aria-busy={historyStatus === "loading" || pending}>
            <div className={styles.columnHead} aria-hidden="true"><span>Campaign</span><span>Default role & exceptions</span></div>
            {visibleCampaigns.map((group) => {
              const { campaign, adsets } = group;
              const { key, node } = campaign;
              const choice = choices[key] ?? "";
              const role = campaignDefault(group);
              const confirmed = confirmedRole(campaign);
              const overrides = activeExceptions(group);
              const expanded = exceptionCampaign === key;
              const suggestion = entityRoleNameSuggestion(node.name);
              const unconfirmedAdsets = adsets.filter((adset) => !confirmedRole(adset)).length;
              const selectableAdsets = adsets.filter((adset) => !overrides.some((row) => row.key === adset.key));
              return (
                <section className={styles.campaign} key={key} data-role-entity={key} data-selected={hasDraft(group)}>
                  <div className={styles.row}>
                    <div className={styles.identity}>
                      <div className={styles.entityName}><GitBranch size={16} aria-hidden="true" /><strong>{node.name}</strong></div>
                      <small>{adsets.length} ad sets{role ? ` · default: ${role === "main" ? "Main" : "Test"}` : " · choose a default role"}{overrides.length ? ` · ${overrides.length} ${overrides.length === 1 ? "exception" : "exceptions"}` : ""}</small>
                      <div className={styles.evidence}>
                        {choice ? <span>{choice === "revoke" ? "Removal selected" : "Ready to confirm"}</span> : confirmed ? <span className={styles.confirmed}><Check size={13} aria-hidden="true" />{currentRole(node, reviewState[key])}</span> : <span>{currentRole(node, reviewState[key])}</span>}
                        {!choice && confirmed && unconfirmedAdsets > 0 ? <span>{unconfirmedAdsets} {unconfirmedAdsets === 1 ? "ad set needs" : "ad sets need"} confirmation</span> : null}
                        {!confirmed && (suggestion === "main" || suggestion === "test") ? <span className={styles.nameHint}>Name suggests {suggestion.toUpperCase()}</span> : null}
                        {suggestion === "conflict" ? <span className={styles.conflict}>Name contains MAIN and TEST · choose a default</span> : null}
                      </div>
                    </div>
                    <div className={styles.selection}>
                      <div className={styles.campaignControls}>
                        <div className={styles.roleButtons} role="group" aria-label={`Default role for ${node.name}`}>
                          {(["main", "test"] as const).map((value) => <button key={value} type="button" disabled={controlsDisabled} aria-pressed={role === value} onClick={() => chooseCampaign(group, value)}>{value === "main" ? "Main" : "Test"}</button>)}
                        </div>
                        <button className={styles.exceptionButton} type="button" aria-label={`Exceptions for ${node.name}`} aria-expanded={expanded} aria-controls={`exceptions-${node.providerEntityId}`} onClick={() => setExceptionCampaign(expanded ? null : key)} disabled={adsets.length === 0}>
                          Exceptions{overrides.length ? <span>{overrides.length}</span> : null}<ChevronDown size={14} aria-hidden="true" />
                        </button>
                      </div>
                      <div className={styles.rowActions}>
                        {choice ? <button type="button" disabled={controlsDisabled} onClick={() => chooseCampaign(group, "")}>Undo campaign change</button> : confirmed ? <button type="button" disabled={controlsDisabled} onClick={() => chooseCampaign(group, "revoke")}>Remove confirmation</button> : null}
                      </div>
                    </div>
                  </div>
                  {expanded ? <div className={styles.exceptionsPanel} id={`exceptions-${node.providerEntityId}`}>
                    <div className={styles.exceptionsHeading}><div><strong>Ad set exceptions</strong><p>{role ? `Everything else uses ${role === "main" ? "Main" : "Test"}. Select only the ad sets that need a different role.` : "Choose the campaign's Main or Test role first."}</p></div><span>{overrides.length} {overrides.length === 1 ? "exception" : "exceptions"}</span></div>
                    {overrides.map((adset) => <div className={styles.exceptionRow} key={adset.key} data-role-entity={adset.key}>
                      <div><strong>{adset.node.name}</strong><small>{exceptions[adset.key] ? "Selected exception" : "Saved exception"}</small></div>
                      <div className={styles.exceptionActions}>
                        <div className={styles.roleButtons} role="group" aria-label={`Exception role for ${adset.node.name}`}>
                          {(["main", "test"] as const).map((value) => <button key={value} type="button" disabled={controlsDisabled || !role} aria-pressed={exceptionRole(group, adset) === value} onClick={() => chooseException(group, adset, value)}>{value === "main" ? "Main" : "Test"}</button>)}
                        </div>
                        <button className={styles.textButton} type="button" disabled={controlsDisabled || !role} onClick={() => chooseException(group, adset, "inherit")}>Use campaign role</button>
                      </div>
                    </div>)}
                    {overrides.length === 0 && role ? <p className={styles.noExceptions}>No exceptions. All current ad sets use the campaign selection.</p> : null}
                    {selectableAdsets.length ? <label className={styles.addException}><Plus size={16} aria-hidden="true" /><select aria-label={`Add exception to ${node.name}`} disabled={controlsDisabled || !role} value="" onChange={(event) => {
                      const adset = selectableAdsets.find((row) => row.key === event.target.value);
                      if (adset && role) chooseException(group, adset, role === "main" ? "test" : "main");
                    }}><option value="">Choose an ad set to add an exception…</option>{selectableAdsets.map((adset) => <option value={adset.key} key={adset.key}>{adset.node.name}</option>)}</select></label> : null}
                  </div> : null}
                </section>
              );
            })}
            {!visibleCampaigns.length ? <div className={styles.empty}><Search size={24} aria-hidden="true" /><strong>{filter === "selected" && !query ? "No campaigns selected yet" : "No matching campaigns"}</strong><button className={styles.secondaryButton} type="button" onClick={() => { setQuery(""); setFilter("all"); }}>Show all campaigns</button></div> : null}
          </div>
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
          {missingDefaults ? <p className={styles.error} role="alert">Choose a Main or Test default for each changed campaign before confirming its exceptions.</p> : null}
          <footer className={styles.footer}>
            <div className={styles.selectionSummary}><strong>{selectedCampaigns.length ? `${selectedCampaigns.length} ${selectedCampaigns.length === 1 ? "campaign" : "campaigns"} selected` : "Select campaign roles to confirm"}</strong><span>{requests.length ? `Includes ${affectedAdsetCount} current ad sets` : `${campaigns.length - unresolvedCount} confirmed · ${unresolvedCount} to review`}</span></div>
            <div className={styles.footerActions}>
              {selectedCampaigns.length ? <button type="button" className={styles.textButton} disabled={pending} onClick={clearDrafts}>Clear selection</button> : null}
              <Dialog.Close className={styles.secondaryButton} disabled={pending}>Close</Dialog.Close>
              <button type="button" className={styles.primaryButton} disabled={controlsDisabled || requests.length === 0 || missingDefaults} onClick={() => void save()}>{pending ? `Saving & verifying… ${savedProgress}/${requests.length}` : "Confirm campaign roles"}</button>
            </div>
            <p className={styles.effectiveNote}>Applies to the current ad sets from {effectiveFrom} · Used in the next decision run.</p>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
