"use client";

/**
 * Automation data boundary — the Meta stop's actual engage and release.
 *
 * The rule this component exists to enforce: **a POST response never creates a
 * success banner.** After the write it issues a separate GET against the
 * automation authority and uses only that to decide what to claim. If the
 * re-read disagrees, or fails, the surface says the state is unknown — because
 * an operator told "stopped" believes spend has halted, and if it has not, that
 * belief costs money for as long as it lasts.
 */
import { useCallback, useState } from "react";

import { AutomationView } from "@/components/zero-base/meta/automation/automation-view";
import type { ProviderPosture, StopCeremonyInput } from "@/lib/zero-base/meta/automation-posture";

export interface AutomationReadBack {
  engaged: boolean | null;
  readAt: string;
  error?: string | null;
}

export function AutomationClient({
  businessId,
  providerAccountId,
  postures,
  guardrails,
  ceremony,
}: {
  businessId: string;
  providerAccountId: string | null;
  postures: readonly ProviderPosture[];
  guardrails: Record<string, unknown>;
  ceremony: StopCeremonyInput;
}) {
  const [readBack, setReadBack] = useState<AutomationReadBack | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const query = useCallback(() => {
    const params = new URLSearchParams({ businessId });
    if (providerAccountId) params.set("providerAccountId", providerAccountId);
    return params.toString();
  }, [businessId, providerAccountId]);

  const run = useCallback(async () => {
    setPending(true);
    setFailure(null);
    setReadBack(null);

    try {
      const response = await fetch(`/api/meta/automation?${query()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action:
            ceremony.intent === "engage" ? "engage_kill_switch" : "release_kill_switch",
          reason: "Zero-base Meta stop",
        }),
      });

      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        // A refused write changed nothing; that is a failure, not an unknown.
        setFailure(
          json?.error?.message ?? `The automation change was refused (HTTP ${response.status}).`,
        );
        setPending(false);
        return;
      }
    } catch (error) {
      // The request may or may not have reached the server, so the state is
      // unknown rather than unchanged — the read-back below decides.
      setFailure(null);
      setReadBack({
        engaged: null,
        readAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "the request did not complete",
      });
      setPending(false);
      return;
    }

    // Independent re-read. The POST already returns a control plane, but using
    // its own response to confirm itself is not an observation of state.
    try {
      const verify = await fetch(`/api/meta/automation?${query()}`, { cache: "no-store" });
      const json = (await verify.json().catch(() => null)) as {
        automation?: { businessControl?: { killSwitchEngaged?: boolean } };
      } | null;
      const engaged = json?.automation?.businessControl?.killSwitchEngaged;
      setReadBack(
        verify.ok && typeof engaged === "boolean"
          ? { engaged, readAt: new Date().toISOString() }
          : {
              engaged: null,
              readAt: new Date().toISOString(),
              error: `the confirming read returned HTTP ${verify.status}`,
            },
      );
    } catch (error) {
      setReadBack({
        engaged: null,
        readAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "the confirming read failed",
      });
    }
    setPending(false);
  }, [ceremony.intent, query]);

  return (
    <>
      <AutomationView
        postures={postures}
        guardrails={guardrails}
        ceremony={{ ...ceremony, readBack }}
        onEngage={() => void run()}
      />
      {pending ? (
        <p role="status" data-stop-pending="" style={{ fontSize: 12.5, marginTop: 8 }}>
          Applying the change, then reading the state back…
        </p>
      ) : null}
      {failure ? (
        <p
          role="status"
          data-stop-failed=""
          style={{ fontSize: 12.5, marginTop: 8, color: "var(--ledger-semantic-warn)" }}
        >
          {failure} Nothing was changed.
        </p>
      ) : null}
    </>
  );
}
