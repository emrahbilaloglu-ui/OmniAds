"use client";

/**
 * The two Account Intelligence controls, wired to the routes that own them.
 *
 * WP9 names Recommendations/respond and Snapshot/run-now as sections with a
 * role and capability gate. The gate is resolved on the SERVER — `readMetaIntelligence`
 * authors each section's `control` from the actor the page already authorized —
 * and this component does exactly two things with it: it renders the view, and
 * it posts when a control the server marked enabled is used.
 *
 * It decides nothing. There is no local check of role, reviewer status or demo
 * flag here, because a second opinion about who may act is how a refusal ends up
 * arriving as a 403 after the click instead of as a sentence before it. Both
 * routes re-check on their own authority regardless; this exists so the operator
 * is not surprised.
 */
import { useCallback, useState } from "react";

import {
  IntelligenceView,
  type IntelligenceSource,
} from "@/components/zero-base/meta/intelligence/intelligence-view";
import { interpretMetaSnapshotRunResponse } from "@/components/meta/redesign/MetaPlatformPage";

export function IntelligenceControlsClient({
  businessId,
  sources,
  unavailableReason,
  window: windowProp,
}: {
  businessId: string;
  sources: readonly IntelligenceSource[];
  unavailableReason?: string | null;
  window?: { startDate: string; endDate: string };
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const respondControl = sources.find((row) => row.control?.kind === "respond");
  const snapshotControl = sources.find((row) => row.control?.kind === "run-snapshot");

  const onRunSnapshot = useCallback(async () => {
    if (busy || !snapshotControl?.control?.enabled) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/meta/snapshot/run-now", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId }),
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      /*
       * The route's own three outcomes, read through the interpreter that
       * already exists rather than a second one written here. `already_running`
       * and `cooldown` are not failures — they are the engine saying it has
       * this in hand — and reporting them as errors would teach an operator to
       * retry something that is already happening.
       */
      const outcome = interpretMetaSnapshotRunResponse(response.ok, payload);
      setNotice(
        outcome.ok
          ? outcome.status === "ran"
            ? "A snapshot run was queued."
            : outcome.status === "already_running"
              ? "A snapshot run is already in progress."
              : "A snapshot ran recently; the engine is in its cooldown window."
          : outcome.message,
      );
    } catch {
      setNotice("The snapshot service could not be reached, so nothing was queued.");
    } finally {
      setBusy(false);
    }
  }, [businessId, busy, snapshotControl]);

  /**
   * One served recommendation, one served action, one route.
   *
   * `recId` arrives from the server's `control.targets` — the same `rec_id`
   * values the snapshot wrote — so the route records against a recommendation
   * that exists. It is never composed here, and an empty one posts nothing:
   * the route would answer `missing_params`, and the server has already said
   * why there is nothing to act on.
   */
  const onRespond = useCallback(
    async (recId: string, action: string) => {
      if (!recId || !action || busy || !respondControl?.control?.enabled) return;
      setBusy(true);
      setNotice(null);
      try {
        const response = await fetch("/api/meta/recommendations/respond", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recId, businessId, action }),
        });
        const payload = (await response.json().catch(() => null)) as {
          ok?: unknown;
          error?: unknown;
          message?: unknown;
          response?: { action?: unknown; timestamp?: unknown } | null;
        } | null;
        if (!response.ok || payload?.ok !== true) {
          /*
           * The route and the access layer answer in two different envelopes —
           * `{ok:false,error:{code,message}}` and `{error,message}` — so both
           * are read, and neither is paraphrased. When the server said nothing
           * readable, this says that rather than inventing a reason.
           */
          const nested =
            payload && typeof payload.error === "object" && payload.error !== null
              ? (payload.error as { message?: unknown }).message
              : null;
          const served =
            typeof nested === "string" && nested.trim()
              ? nested.trim()
              : typeof payload?.message === "string" && payload.message.trim()
                ? payload.message.trim()
                : null;
          setNotice(
            served ??
              "The response was not recorded, and the server gave no reason that could be read.",
          );
          return;
        }
        /*
         * The server's own row, read back. A 200 is not an observation of what
         * was written, and the operator is told the action and the instant the
         * database stamped — not the one this browser hoped for.
         */
        const recorded = payload.response;
        const recordedAction =
          typeof recorded?.action === "string" ? recorded.action : action;
        const recordedAt =
          typeof recorded?.timestamp === "string" ? recorded.timestamp : null;
        setNotice(
          recordedAt
            ? `Recorded "${recordedAction}" against ${recId} at ${recordedAt}.`
            : `Recorded "${recordedAction}" against ${recId}. The server returned no timestamp, so when it was written is unknown.`,
        );
      } catch {
        setNotice(
          "The decision service could not be reached, so nothing was recorded.",
        );
      } finally {
        setBusy(false);
      }
    },
    [businessId, busy, respondControl],
  );

  return (
    <>
      <IntelligenceView
        sources={sources}
        unavailableReason={unavailableReason}
        window={windowProp}
        onRunSnapshot={() => void onRunSnapshot()}
        onRespond={(recId, action) => void onRespond(recId, action)}
      />
      {notice ? (
        <p
          role="status"
          data-intelligence-control-notice=""
          style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}
        >
          {notice}
        </p>
      ) : null}
    </>
  );
}
