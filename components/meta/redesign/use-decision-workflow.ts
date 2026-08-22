"use client";

/**
 * The workflow overlay, on the Decisions body an operator actually reaches.
 *
 * `/api/meta/decision-workflow` has carried all seven transitions with
 * `expectedVersion` optimistic concurrency for some time, and the only caller
 * lived in `components/zero-base/meta/decisions/decisions-client.tsx` — a body
 * no route mounts. The route mounts `MetaPlatformPage`. That is the master
 * plan's §5.1 finding 14, and D2's answer is to port the behaviour into the
 * production visual owner rather than mount the zero-base body (§17.3).
 *
 * The network calls are `lib/meta/decision-workflow-client.ts`, shared with the
 * zero-base body so the two cannot drift about what a 409 means.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { WorkflowRecord, WorkflowState } from "@/lib/decision-workflow";
import {
  readDecisionWorkflow,
  submitDecisionWorkflow,
  type CanonicalWorkflowAction,
  type WorkflowSubmitOutcome,
} from "@/lib/meta/decision-workflow-client";

export type DecisionWorkflowReadState = "idle" | "loading" | "ready" | "unavailable";

export interface DecisionWorkflowOverlay {
  readState: DecisionWorkflowReadState;
  unavailableReason: string | null;
  recordFor: (decisionKey: string) => WorkflowRecord | null;
  submit: (
    decisionKey: string,
    action: CanonicalWorkflowAction,
    record: WorkflowRecord,
  ) => Promise<WorkflowSubmitOutcome>;
  /** Set after a submit that did not apply. Cleared by the next attempt. */
  lastMessage: string | null;
}

/**
 * The transitions each state permits, mirroring `lib/decision-workflow.ts`.
 *
 * Duplicated deliberately and narrowly: this decides which buttons are OFFERED,
 * while the server decides what is ALLOWED and refuses anything else on its own
 * authority. A surface that offered every action regardless would teach the
 * operator that the product is unreliable; one that computed permission would
 * be a second rule that can disagree with the first. Offering is presentation;
 * permitting is not.
 */
const OFFERED_BY_STATE: Readonly<Record<WorkflowState, readonly CanonicalWorkflowAction[]>> = {
  open: ["assign", "acknowledge", "defer", "snooze", "reject", "resolve"],
  acknowledged: ["assign", "defer", "snooze", "reject", "resolve"],
  deferred: ["assign", "acknowledge", "snooze", "reject", "resolve", "reopen"],
  snoozed: ["assign", "acknowledge", "defer", "reject", "resolve", "reopen"],
  rejected: ["reopen"],
  resolved: ["reopen"],
};

export function offeredWorkflowActions(
  state: WorkflowState,
): readonly CanonicalWorkflowAction[] {
  return OFFERED_BY_STATE[state];
}

export const WORKFLOW_ACTION_LABELS: Readonly<Record<CanonicalWorkflowAction, string>> = {
  assign: "Assign",
  acknowledge: "Acknowledge",
  defer: "Defer",
  snooze: "Snooze",
  reject: "Reject",
  resolve: "Resolve",
  reopen: "Reopen",
};

export function useDecisionWorkflow(input: {
  businessId: string;
  /** Every decision id the surface served, in a stable order. */
  servedDecisionKeys: readonly string[];
  selectedDecisionKey: string | null;
  /** Off by default; the actions are refused while it is closed. */
  enabled: boolean;
}): DecisionWorkflowOverlay {
  const [records, setRecords] = useState<WorkflowRecord[]>([]);
  const [readState, setReadState] = useState<DecisionWorkflowReadState>("idle");
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // A stable key, so a re-render with the same ids does not re-fetch.
  const servedKey = useMemo(
    () => [...input.servedDecisionKeys].join(","),
    [input.servedDecisionKeys],
  );

  useEffect(() => {
    /**
     * No read while the gate is closed.
     *
     * The gate governs the whole overlay, not only its buttons. Reading it
     * anyway would spend a request per selection to render a section whose
     * every control is refused, and — because the design draws no ownership
     * panel — to show state the operator cannot act on.
     *
     * Nothing the design draws is lost by this: its "Deferred N" watch segment
     * comes from the workspace payload's own `deferredCount`, not from here.
     */
    if (!input.enabled || !input.businessId || !servedKey) {
      setReadState("idle");
      setRecords([]);
      return;
    }
    const controller = new AbortController();
    setReadState("loading");
    void readDecisionWorkflow({
      businessId: input.businessId,
      decisionKeys: servedKey.split(","),
      selectedDecisionKey: input.selectedDecisionKey,
      signal: controller.signal,
    }).then((outcome) => {
      if (controller.signal.aborted) return;
      if (!outcome.ok) {
        setRecords([]);
        setUnavailableReason(outcome.reason);
        setReadState("unavailable");
        return;
      }
      setRecords(outcome.workflows);
      setUnavailableReason(null);
      setReadState("ready");
    });
    return () => controller.abort();
  }, [input.businessId, input.enabled, input.selectedDecisionKey, servedKey, nonce]);

  const byKey = useMemo(
    () => new Map(records.map((record) => [record.decisionKey, record])),
    [records],
  );

  const recordFor = useCallback(
    (decisionKey: string) => byKey.get(decisionKey) ?? null,
    [byKey],
  );

  const submit = useCallback(
    async (
      decisionKey: string,
      action: CanonicalWorkflowAction,
      record: WorkflowRecord,
    ): Promise<WorkflowSubmitOutcome> => {
      setLastMessage(null);
      const outcome = await submitDecisionWorkflow({
        businessId: input.businessId,
        decisionKey,
        submit: {
          action,
          // The version the operator was looking at. The server refuses a stale
          // one with 409 rather than overwriting a newer decision.
          expectedVersion: record.stateVersion,
          mutationId:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `${decisionKey}:${action}:${record.stateVersion}`,
          assigneeUserId: null,
          dueAt: null,
          snoozeUntil: null,
          reasonCode: null,
        },
      });

      if (outcome.ok) {
        // Replace from the server's own record rather than patching locally: a
        // local guess at the next state is a second state machine.
        setRecords((prev) =>
          prev.map((item) =>
            item.decisionKey === decisionKey ? outcome.workflow : item,
          ),
        );
        return outcome;
      }

      if (outcome.kind === "conflict") {
        // Nothing was applied, and the server told us what the decision IS now.
        // Showing that beats telling the operator to reload and guess.
        setRecords((prev) =>
          prev.map((item) =>
            item.decisionKey === decisionKey ? outcome.current : item,
          ),
        );
      } else {
        // Re-read rather than assume: a failed submit may or may not have
        // landed, and the overlay must not display a state nobody confirmed.
        setNonce((value) => value + 1);
      }
      setLastMessage(outcome.message);
      return outcome;
    },
    [input.businessId],
  );

  return { readState, unavailableReason, recordFor, submit, lastMessage };
}
