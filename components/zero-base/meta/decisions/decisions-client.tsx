"use client";

/**
 * Decisions data boundary.
 *
 * Reads the existing workspace endpoint and keeps URL state in sync. It adds no
 * decision logic: every verdict, count and banner comes from the payload, and
 * this component's only judgement is which lane and level the operator asked
 * for.
 *
 * It also wires the two overlays that sit on top of a decision without changing
 * it:
 *
 * - the **workflow overlay**, read for the whole served page in one batched
 *   request rather than one request per row;
 * - the **manual write ceremony**, which exists only when the server said the
 *   mutation UI is enabled. There is no client flag here to read: if the server
 *   did not say enabled, the ceremony is not constructed, so no preflight and
 *   no dispatch request can be made from this page at all.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  DecisionsView,
  type DecisionsWorkflow,
} from "@/components/zero-base/_reference/meta-decisions-view";
import { buildMutationCeremonySeed } from "@/components/zero-base/meta/decisions/mutation-ceremony-seed";
import type { MutationCeremonySeed } from "@/components/zero-base/meta/decisions/mutation-ceremony-panel";
import type { WorkflowSubmit, WorkflowSubmitResult } from "@/components/zero-base/meta/decisions/workflow-overlay";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import { buildOsDecisionsViewModel } from "@/lib/zero-base/meta/decisions-presentation";
import {
  decisionsHref,
  type DecisionsUrlState,
} from "@/lib/zero-base/meta/decisions-url-state";
import { indexWorkflows, type WorkflowLoadState } from "@/lib/zero-base/meta/workflow-view-model";
import type { WorkflowRecord } from "@/lib/decision-workflow";
import {
  readDecisionWorkflow,
  submitDecisionWorkflow,
} from "@/lib/meta/decision-workflow-client";
import type { WorkflowEvent } from "@/lib/decision-workflow-store";
import type { MutationAction, TerminalOutcome } from "@/lib/zero-base/meta/mutation-ceremony";
import type { DispatchDescriptor } from "@/lib/zero-base/meta/dispatch-contract";
import type { SurfaceState } from "@/lib/zero-base/state-types";
import type { MetaDecisionsOsWorkspacePayload } from "@/components/meta/redesign/types";

function newMutationId(): string {
  return crypto.randomUUID();
}

export function DecisionsClient({
  businessId,
  initialState,
  providerAccountId,
  demo,
  mutationUiEnabled,
}: {
  businessId: string;
  initialState: DecisionsUrlState;
  providerAccountId: string | null;
  demo: boolean;
  /** Server-read. Absent or false means the ceremony is never constructed. */
  mutationUiEnabled?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [payload, setPayload] = useState<MetaDecisionsOsWorkspacePayload | null>(null);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading decisions" });
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [workflowState, setWorkflowState] = useState<WorkflowLoadState>({ kind: "loading" });
  const [workflowNonce, setWorkflowNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const query = new URLSearchParams({
          businessId,
          surface: "os",
          status_filter: "active",
        });
        if (providerAccountId) query.set("providerAccountId", providerAccountId);
        const response = await fetch(`/api/meta/decisions-workspace?${query.toString()}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          // A failed read is a failure, not an empty lane — otherwise the
          // operator concludes there is nothing to do today.
          if (!cancelled) {
            setSurface({
              kind: "error",
              reason: "The decisions workspace could not be read for this business.",
              verbatim: `HTTP ${response.status}`,
              retry: true,
            });
          }
          return;
        }
        const json = (await response.json()) as MetaDecisionsOsWorkspacePayload;
        if (cancelled) return;
        setPayload(json);
        setSurface({ kind: "ready" });
      } catch (error: unknown) {
        if (cancelled) return;
        setSurface({
          kind: "error",
          reason: "The decisions workspace could not be reached.",
          verbatim: error instanceof Error ? error.message : undefined,
          retry: true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, providerAccountId]);

  const model = useMemo(
    () =>
      payload
        ? buildOsDecisionsViewModel({
            os: payload.os,
            banners: payload.banners ?? [],
            viewer: payload.viewer ?? null,
            state,
            evidenceWindow: {
              startDate: payload.startDate,
              endDate: payload.endDate,
            },
          })
        : null,
    [payload, state],
  );

  // One batched overlay read for the whole served universe, plus the journal
  // for the one decision that is open. A per-row read would be an N+1 that
  // grows with the page.
  const servedKey = model ? model.servedIds.join(",") : "";
  useEffect(() => {
    if (!servedKey) return;
    const controller = new AbortController();
    setWorkflowState({ kind: "loading" });
    void readDecisionWorkflow({
      businessId,
      decisionKeys: servedKey.split(","),
      selectedDecisionKey: state.selected,
      signal: controller.signal,
    }).then((outcome) => {
      if (controller.signal.aborted) return;
      if (!outcome.ok) {
        // Never falls back to "open": an unread overlay is unknown, and showing
        // the default would claim nobody owns these decisions.
        setWorkflowState({ kind: "error", reason: outcome.reason });
        return;
      }
      setWorkflows(outcome.workflows);
      setEvents(outcome.events);
      setWorkflowState({ kind: "ready" });
    });
    return () => controller.abort();
  }, [businessId, servedKey, state.selected, workflowNonce]);

  const onStateChange = useCallback(
    (next: DecisionsUrlState) => {
      setState(next);
      // Every filter and the selection live in the URL, so the view is
      // linkable and survives a reload.
      router.replace(decisionsHref(businessId, next, providerAccountId), { scroll: false });
    },
    [businessId, providerAccountId, router],
  );

  const submitWorkflow = useCallback(
    async (decisionKey: string, submit: WorkflowSubmit): Promise<WorkflowSubmitResult> =>
      // One implementation, shared with the production Decisions body. Both
      // surfaces therefore agree about what a 409 means and which field carries
      // the version — they used to have separate copies of that reasoning.
      submitDecisionWorkflow({ businessId, decisionKey, submit }),
    [businessId],
  );

  const workflow: DecisionsWorkflow | undefined = model
    ? {
        records: indexWorkflows({ businessId, decisionKeys: model.servedIds, workflows }),
        events,
        loadState: workflowState,
        onSubmit: submitWorkflow,
        onRefresh: () => setWorkflowNonce((value) => value + 1),
        newMutationId,
      }
    : undefined;

  // Constructed only when the server said so. Not a disabled control, not a
  // hidden one — absent, along with every request it could have made.
  const mutation: MutationCeremonySeed | undefined =
    mutationUiEnabled && model
      ? buildMutationCeremonySeed({
          businessId,
          viewer: {
            isReviewer: model.viewer?.isReviewer ?? false,
            demo,
            role: model.viewer?.role ?? null,
          },
          newMutationId,
        })
      : undefined;

  return (
    <SurfaceStateBoundary state={surface}>
      {model ? (
        <DecisionsView
          model={model}
          state={state}
          demo={demo}
          onStateChange={onStateChange}
          workflow={workflow}
          mutation={mutation}
        />
      ) : null}
    </SurfaceStateBoundary>
  );
}

export type { MutationAction };
