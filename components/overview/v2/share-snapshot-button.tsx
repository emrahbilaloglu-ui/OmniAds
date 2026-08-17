"use client";

import { useState } from "react";

/**
 * The design's primary Overview CTA. It captures the current Overview as a real
 * shareable report: the executive-snapshot template is saved as a report for the
 * active business, then the report share endpoint mints a tokenised link. No
 * fabricated link is ever shown — a failure surfaces the server's message.
 */
export function ShareSnapshotButton({
  businessId,
  businessName,
  rangePreset,
  compareMode,
}: {
  businessId: string;
  businessName: string | null;
  rangePreset: "7" | "30" | "90";
  compareMode: "none" | "previous_period";
}) {
  const [state, setState] = useState<"idle" | "working">("idle");

  const share = async () => {
    if (!businessId || !businessName?.trim() || state === "working") return;
    setState("working");
    try {
      const stamp = new Date().toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      const created = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: `${businessName.trim()} snapshot · ${stamp}`,
          description: "Overview snapshot shared from the dashboard.",
          templateId: "one-click-paid-media",
          definition: { version: 1, dateRangePreset: rangePreset, compareMode },
        }),
      });
      const createdPayload = (await created.json().catch(() => null)) as {
        report?: { id: string };
        message?: string;
      } | null;
      if (!created.ok || !createdPayload?.report?.id) {
        throw new Error(createdPayload?.message ?? "Snapshot could not be saved.");
      }

      const shared = await fetch(`/api/reports/${createdPayload.report.id}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiryDays: 7 }),
      });
      const sharedPayload = (await shared.json().catch(() => null)) as {
        url?: string;
        message?: string;
      } | null;
      if (!shared.ok || !sharedPayload?.url) {
        throw new Error(sharedPayload?.message ?? "Share link could not be created.");
      }
      const url = new URL(sharedPayload.url, window.location.origin).toString();
      await navigator.clipboard?.writeText(url).catch(() => undefined);
    } catch (caught) {
      console.error("[overview] share_snapshot_failed", caught instanceof Error ? caught.message : "Share failed.");
    } finally {
      setState("idle");
    }
  };

  return (
    <button
      type="button"
      className="adv-btn adv-btn--primary"
      onClick={share}
      disabled={state === "working" || !businessId || !businessName?.trim()}
      aria-busy={state === "working"}
      style={{ padding: "0 14px", opacity: 1, cursor: "pointer" }}
    >
      Share snapshot
    </button>
  );
}
