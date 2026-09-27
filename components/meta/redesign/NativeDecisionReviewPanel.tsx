"use client";

import { useId, useState } from "react";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import { offeredWorkflowActions, type DecisionWorkflowOverlay } from "./use-decision-workflow";

export function nativeDecisionReviewKey(decision: MetaCanonicalDecision | null): string | null {
  return decision?.identityGrain === "ad" && decision.sourceAuthority?.snapshotId && decision.sourceAuthority.evaluationId
    ? `native-ad:${decision.sourceAuthority.snapshotId}:${decision.sourceAuthority.evaluationId}` : null;
}

/** Internal response, provider receipt and measured outcome are separate facts. */
export function NativeDecisionReviewPanel({ decision, workflow, refusedReason, onRefreshEvidence }: {
  decision: MetaCanonicalDecision;
  workflow: DecisionWorkflowOverlay;
  refusedReason: string | null;
  onRefreshEvidence?: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const key = nativeDecisionReviewKey(decision);
  if (!key) return null;
  const record = workflow.recordFor(key);
  const authority = decision.sourceAuthority!;
  const allowed = record ? offeredWorkflowActions(record.state) : [];
  const disabled = Boolean(refusedReason || !record || workflow.readState !== "ready" || workflow.pendingKey);
  const untilMs = Date.parse(until);
  const submit = (action: "acknowledge" | "snooze" | "reject" | "reopen" | "resolve") => {
    if (disabled || !record || !allowed.includes(action)) return;
    void workflow.submit(key, action, record, {
      sourceEvaluationId: authority.evaluationId!, sourceSnapshotId: authority.snapshotId, entityType: "ad",
      entityId: decision.parentChain.ad!.id, providerAccountId: decision.providerAccountId,
      ...(action === "resolve" ? {reasonCode:"operator_reports_manual_application",comment:"Operator reports a manual action. Provider execution remains unverified until a linked receipt is observed."} : {}),
      ...(action === "reject" ? { reasonCode: reason.trim() } : {}),
      ...(action === "snooze" && Number.isFinite(untilMs) ? { snoozeUntil: new Date(untilMs).toISOString() } : {}),
    });
  };
  return <section aria-label="Operator review" data-native-decision-review style={{ padding: 16 }}>
    <h3>Operator review</h3>
    <p>Your response records this decision evaluation. It does not change Meta ads, decision authority or measured outcomes.</p>
    <p role="status">Review state: {workflow.readState === "ready" && record ? record.state : "unknown"}
      {record?.snoozeUntil ? ` · Deferred until ${record.snoozeUntil}` : ""}
      {record?.reasonCode ? ` · Reason: ${record.reasonCode}` : ""}</p>
    {refusedReason || workflow.unavailableReason ? <p>{refusedReason ?? workflow.unavailableReason}</p> : null}
    {workflow.lastMessage ? <p role="alert">{workflow.lastMessage}</p> : null}
    {workflow.conflict ? <p>The latest server state is shown. Review it before making another response.</p> : null}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {allowed.includes("acknowledge") ? <button className="btn" disabled={disabled} onClick={() => submit("acknowledge")}>Acknowledge review</button> : null}
      {allowed.includes("resolve") ? <button className="btn" disabled={disabled} onClick={() => submit("resolve")}>Report manual action taken</button> : null}
      {allowed.includes("reopen") ? <button className="btn" disabled={disabled} onClick={() => submit("reopen")}>Reopen review</button> : null}
    </div>
    {allowed.includes("snooze") ? <div>
      <label htmlFor={`${id}-until`}>Defer review until (your local time)</label>
      <input id={`${id}-until`} type="datetime-local" value={until} onChange={e => setUntil(e.target.value)} disabled={disabled} />
      <button className="btn" disabled={disabled || !Number.isFinite(untilMs) || untilMs <= Date.now()} onClick={() => submit("snooze")}>Defer review</button>
    </div> : null}
    {allowed.includes("reject") ? <div>
      <label htmlFor={`${id}-reason`}>Reason for disagreeing</label>
      <select id={`${id}-reason`} value={reason} onChange={e => setReason(e.target.value)} disabled={disabled}>
        <option value="">Choose a reason</option>
        <option value="insufficient_evidence">Insufficient evidence</option>
        <option value="attribution_lag">Attribution may still mature</option>
        <option value="wrong_business_context">Business context is incorrect</option>
        <option value="disagree_economics">Economic interpretation is incorrect</option>
      </select>
      <button className="btn" disabled={disabled || !reason} onClick={() => submit("reject")}>Disagree with decision</button>
    </div> : null}
    <details><summary>Response, execution and outcome evidence</summary>
      <p>Snapshot: {authority.snapshotId} · Engine: {authority.engineVersion}</p>
      <p>Evaluation: {authority.evaluationId ?? "unavailable"}</p>
      <p style={{ overflowWrap: "anywhere" }}>Input: {authority.inputHash ?? "unavailable"} · Decision: {authority.decisionHash ?? "unavailable"}</p>
      {(workflow.events ?? []).map((event, index) => <p key={`${event.stateVersion}:${index}`}>
        Review: {event.event} · {event.actorName ?? event.actorUserId ?? "actor unavailable"} · {event.occurredAt}
        {event.reasonCode ? ` · ${event.reasonCode}` : ""}
      </p>)}
      <p>Provider execution evidence: {decision.history?.providerWrites?.status === "available" ? "linked receipt available" : "not verified"}. An acknowledgment is not proof of execution.</p>
      {onRefreshEvidence ? <button className="btn" onClick={onRefreshEvidence}>Reload execution evidence</button> : null}
      <p>Outcome source: {decision.history?.outcomes?.status ?? "unavailable"}.</p>
      {[3, 7, 14].map(days => {
        const items = (decision.history?.outcomes?.items ?? []).filter(item => item.outcomeWindowDays === days);
        return <p key={days}>{days}-day outcome: {decision.history?.outcomes?.status === "available" && items.length
          ? items.map(item => `${item.realizedOutcome} (${item.evaluationDate})`).join("; ") : "not observed"}. This is an observational assessment, not causal lift.</p>;
      })}
    </details>
  </section>;
}
