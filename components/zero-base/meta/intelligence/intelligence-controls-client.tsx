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

  const onRespond = useCallback(
    async (_sourceKey: string, action: string) => {
      if (!action || busy || !respondControl?.control?.enabled) return;
      /*
       * `/api/meta/recommendations/respond` needs a `recId`, and a section key
       * is not one.
       *
       * The section reports how many recommendations are in scope; responding
       * to a SPECIFIC one is done from the Decision Center, which lists them
       * with their ids. Rather than invent an id or post a request the route
       * would refuse with `missing_params`, this states where the action lives.
       * That is a smaller product than WP9 describes, and it is the honest
       * shape of what this section can offer without a per-recommendation list
       * on the screen.
       */
      setNotice(
        `Responding "${action}" is recorded against one recommendation. Open the decision in Decision Center to record it there — this section reports how many are in scope, not which.`,
      );
    },
    [busy, respondControl],
  );

  return (
    <>
      <IntelligenceView
        sources={sources}
        unavailableReason={unavailableReason}
        window={windowProp}
        onRunSnapshot={() => void onRunSnapshot()}
        onRespond={(key, action) => void onRespond(key, action)}
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
