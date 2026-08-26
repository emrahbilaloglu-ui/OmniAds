/**
 * The one client-side implementation of the decision workflow overlay.
 *
 * `/api/meta/decision-workflow` has carried all seven transitions
 * (assign / acknowledge / defer / snooze / reject / resolve / reopen) with
 * `expectedVersion` optimistic concurrency since before this file existed. What
 * it did not have was a caller on the surface an operator actually reaches:
 * the read and submit logic lived inside
 * `components/zero-base/meta/decisions/decisions-client.tsx`, and **no route
 * mounts that body**. The route mounts `MetaPlatformPage`.
 *
 * That is the master plan's §5.1 finding 14 — "Decisions workflow ve mutation
 * ceremony endpoint'leri bulunmasına rağmen production gövdede tam
 * tüketilmiyor" — and D2's answer is to port the behaviour into the production
 * visual owner rather than mount the zero-base body wholesale (§17.3).
 *
 * So the logic moved here, and both bodies call it. One implementation means
 * the two cannot drift into disagreeing about what a 409 means or which field
 * carries the version.
 *
 * ## What this does not do
 *
 * It cannot change a decision's label, its authority, or whether a provider
 * action is permitted. Deferring hides a decision from a queue; it never makes
 * the recommendation less true and never grants permission to act. That
 * separation is `lib/decision-workflow.ts`'s, and this file only carries its
 * results across the wire.
 */
import type { WorkflowRecord } from "@/lib/decision-workflow";
import type { WorkflowEvent } from "@/lib/decision-workflow-store";

/** Canonical workflow actions, minus `comment` which has its own path. */
export type CanonicalWorkflowAction =
  | "assign"
  | "acknowledge"
  | "defer"
  | "snooze"
  | "reject"
  | "resolve"
  | "reopen";

export interface WorkflowSubmitRequest {
  action: CanonicalWorkflowAction;
  /** The version the operator was looking at when they decided. */
  expectedVersion: number;
  /** One id per attempt, stable across retries of the same attempt. */
  mutationId: string;
  assigneeUserId?: string | null;
  /**
   * Optional, and the distinction is load-bearing.
   *
   * `lib/decision-workflow.ts` treats `undefined` as "do not touch" and `null`
   * as "clear it". The only caller sent `dueAt: null` on every action, so an
   * unrelated acknowledge or defer silently destroyed a stored due date. An
   * omitted key is `undefined` after `JSON.stringify`, which is what a
   * transition that has nothing to say about a field should send.
   */
  dueAt?: string | null;
  snoozeUntil?: string | null;
  reasonCode?: string | null;
}

export type WorkflowSubmitOutcome =
  | { ok: true; workflow: WorkflowRecord; replayed: boolean }
  /**
   * Someone else moved this decision since it was read. Carries the server's
   * CURRENT record so the surface can show what it actually is now, rather than
   * telling the operator to reload and guess.
   */
  | { ok: false; kind: "conflict"; current: WorkflowRecord; message: string }
  | { ok: false; kind: "error"; message: string };

export type WorkflowReadOutcome =
  | { ok: true; workflows: WorkflowRecord[]; events: WorkflowEvent[] }
  /**
   * Never falls back to "open".
   *
   * An unread overlay is *unknown*, and rendering the default state would claim
   * nobody owns these decisions — which is a statement about other people's
   * work, made on no evidence.
   */
  | { ok: false; reason: string };

export const WORKFLOW_READ_UNAVAILABLE =
  "Workflow state could not be read, so ownership is shown as unknown rather than open.";

export async function readDecisionWorkflow(input: {
  businessId: string;
  decisionKeys: readonly string[];
  selectedDecisionKey?: string | null;
  signal?: AbortSignal;
}): Promise<WorkflowReadOutcome> {
  if (input.decisionKeys.length === 0) {
    return { ok: true, workflows: [], events: [] };
  }
  const params = new URLSearchParams({
    contract: "zero-base.v1",
    businessId: input.businessId,
    decisionKeys: input.decisionKeys.join(","),
  });
  if (input.selectedDecisionKey) {
    params.set("decisionKey", input.selectedDecisionKey);
  }
  try {
    const response = await fetch(
      `/api/meta/decision-workflow?${params.toString()}`,
      { cache: "no-store", signal: input.signal },
    );
    if (!response.ok) return { ok: false, reason: WORKFLOW_READ_UNAVAILABLE };
    const json = (await response.json().catch(() => null)) as {
      workflows?: WorkflowRecord[];
      events?: WorkflowEvent[];
    } | null;
    // A 200 whose body cannot be read is not a read. Falling through to empty
    // arrays here would render "nobody owns these" off an unparseable response.
    if (!json || !Array.isArray(json.workflows)) {
      return { ok: false, reason: WORKFLOW_READ_UNAVAILABLE };
    }
    return { ok: true, workflows: json.workflows, events: json.events ?? [] };
  } catch {
    return { ok: false, reason: WORKFLOW_READ_UNAVAILABLE };
  }
}

export async function submitDecisionWorkflow(input: {
  businessId: string;
  decisionKey: string;
  submit: WorkflowSubmitRequest;
}): Promise<WorkflowSubmitOutcome> {
  try {
    const response = await fetch("/api/meta/decision-workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: input.businessId,
        decisionKey: input.decisionKey,
        ...input.submit,
      }),
    });
    const json = (await response.json().catch(() => null)) as {
      workflow?: WorkflowRecord;
      replayed?: boolean;
      current?: WorkflowRecord;
      message?: string;
      error?: string;
    } | null;

    // 409 is the optimistic-concurrency answer, and it is NOT an error state:
    // nothing was applied, and the server is telling the surface what the
    // decision is now so the operator can decide again against the truth.
    if (response.status === 409 && json?.current) {
      return {
        ok: false,
        kind: "conflict",
        current: json.current,
        message:
          json.message ?? "This decision changed while you were looking at it.",
      };
    }
    if (!response.ok || !json?.workflow) {
      return {
        ok: false,
        kind: "error",
        message:
          json?.message ??
          `The workflow change was not recorded (HTTP ${response.status}).`,
      };
    }
    return { ok: true, workflow: json.workflow, replayed: json.replayed === true };
  } catch {
    return {
      ok: false,
      kind: "error",
      // The request left the browser and no answer came back. Whether it landed
      // is unknown, and the surface must say so rather than assume either way.
      message:
        "The workflow change could not be sent, so whether it was recorded is unknown. Reload before trying again.",
    };
  }
}
