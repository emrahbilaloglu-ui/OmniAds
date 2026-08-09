"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";

/**
 * The mobile Tier-0 task: triage a decision from a phone.
 *
 * D5 keeps provider mutation off mobile, and this respects that completely —
 * nothing here writes to a provider. But "no unsafe mutation" is not the same as
 * "no task": the permitted phone job is to read a decision, see its evidence,
 * and take ownership of it, and that job either gets finished or it does not.
 * Measuring it is the only way to know whether the phone experience actually
 * works, which is exactly what section 9's mobile Tier-0 metric is for.
 *
 * Capability-gated on two axes. It renders only at phone widths, because a task
 * defined by its context should not appear outside it. And it renders the
 * ownership controls only when the caller says ownership is available — a
 * disabled control with no explanation is worse than an absent one.
 *
 * Started fires once when the task actually begins; completed fires when
 * ownership is recorded. A task that is opened and abandoned records a start
 * with no completion, which is the honest signal — silently dropping it would
 * make the completion rate a measure of finished tasks over finished tasks.
 */
export type MobileTier0Outcome = "completed" | "abandoned";

export function MobileTier0Triage({
  businessId,
  decisionKey,
  ownershipAvailable,
  children,
  maxWidth = 767,
}: {
  businessId: string;
  decisionKey: string;
  /** False when workflow state cannot be read; the task cannot be finished. */
  ownershipAvailable: boolean;
  children?: React.ReactNode;
  maxWidth?: number;
}) {
  const [isPhone, setIsPhone] = useState(false);
  const started = useRef(false);
  const completed = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const apply = () => setIsPhone(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [maxWidth]);

  useEffect(() => {
    if (!isPhone || started.current || !decisionKey) return;
    started.current = true;
    emitProductInstrumentation({
      eventName: "mobile_tier0_started",
      surface: "mobile",
      outcome: "ok",
      scope: "business",
      businessId,
    });
  }, [isPhone, businessId, decisionKey]);

  const complete = useCallback(
    (outcome: MobileTier0Outcome) => {
      if (completed.current) return;
      completed.current = true;
      emitProductInstrumentation({
        eventName: "mobile_tier0_completed",
        surface: "mobile",
        outcome: outcome === "completed" ? "ok" : "withheld",
        scope: "business",
        businessId,
      });
    },
    [businessId],
  );

  if (!isPhone) return null;

  return (
    <section
      data-testid="mobile-tier0-triage"
      data-tier0-state={ownershipAvailable ? "available" : "read_only"}
      aria-label="Triage this decision"
      className="mt-3 rounded-lg border border-[var(--adc-b1,#e4e4e0)] p-3"
    >
      <h3 className="text-[13px] font-semibold text-[var(--adc-ink,#1a1c1f)]">
        Triage on mobile
      </h3>
      <p className="mt-1 text-[12px] text-[var(--adc-ink2,#4a4f56)]">
        {ownershipAvailable
          ? "Read the evidence and take this on. Provider changes stay on desktop."
          : "Ownership tracking is unavailable, so this decision can be read here but not claimed."}
      </p>

      {ownershipAvailable ? (
        <div
          onClickCapture={() => complete("completed")}
          data-testid="mobile-tier0-controls"
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}
