"use client";

import { useState } from "react";
import { Check, Copy, Loader2, Share2, X } from "lucide-react";

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
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const share = async () => {
    setState("working");
    setError(null);
    setUrl(null);
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
          name: `${businessName ?? "Workspace"} snapshot · ${stamp}`,
          description: "Overview snapshot shared from the dashboard.",
          templateId: "one-click-paid-media",
          definition: { version: 1, dateRangePreset: rangePreset, compareMode },
        }),
      });
      const createdPayload = (await created.json().catch(() => null)) as
        | { report?: { id: string }; message?: string }
        | null;
      if (!created.ok || !createdPayload?.report?.id) {
        throw new Error(createdPayload?.message ?? "Snapshot could not be saved.");
      }

      const shared = await fetch(`/api/reports/${createdPayload.report.id}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiryDays: 7 }),
      });
      const sharedPayload = (await shared.json().catch(() => null)) as
        | { url?: string; message?: string }
        | null;
      if (!shared.ok || !sharedPayload?.url) {
        throw new Error(sharedPayload?.message ?? "Share link could not be created.");
      }
      setUrl(new URL(sharedPayload.url, window.location.origin).toString());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Share failed.");
    } finally {
      setState("idle");
    }
  };

  return (
    <>
      <button
        type="button"
        className="adv-btn adv-btn--primary"
        onClick={share}
        disabled={state === "working" || !businessId}
      >
        {state === "working" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        Share snapshot
      </button>

      {url || error ? (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 z-50 flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-[var(--adv-r-tile)] border px-4 py-3 shadow-[0_16px_40px_rgba(14,21,38,0.16)]"
          style={{
            borderColor: error ? "var(--adc-danger-bd)" : "var(--adv-border)",
            background: error ? "var(--adc-danger-bg)" : "var(--adv-surface)",
          }}
        >
          {error ? (
            <p className="m-0 flex-1 text-[12.5px]" style={{ color: "var(--adc-danger-fg)" }}>
              {error}
            </p>
          ) : (
            <>
              <p
                className="adv-mono m-0 min-w-0 flex-1 truncate text-[11.5px]"
                style={{ color: "var(--adv-ink-2)" }}
              >
                {url}
              </p>
              <button
                type="button"
                className="adv-btn"
                onClick={async () => {
                  if (!url) return;
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy link"}
              </button>
            </>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            className="adv-icon-btn"
            onClick={() => {
              setUrl(null);
              setError(null);
            }}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
}
