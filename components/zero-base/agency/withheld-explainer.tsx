"use client";

/**
 * Why the Agency surface shows no totals.
 *
 * The absence of cross-client money is a deliberate decision, so it is
 * explained rather than left as a gap the operator has to interpret. An
 * unexplained absence reads as "not built yet"; this reads as "not safe to
 * show, and here is what would make it safe".
 */
import Link from "next/link";

import { WithheldState } from "@/components/zero-base/states/surface-state";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export const WITHHELD_REASONS = [
  {
    id: "currency",
    title: "Rows lack per-row currency proof",
    body:
      "Clients are configured in different currencies, and a configured currency is not an observed one. " +
      "Summing them would produce a total that mixes units without saying so.",
    unlock: "every source row carries the currency it was recorded in.",
  },
  {
    id: "freshness",
    title: "Clients are fresh to different times",
    body:
      "One client may have synced an hour ago and another three days ago. A single total across them " +
      "would present one number as though it described one moment.",
    unlock: "cross-client totals can state the window every row actually covers.",
  },
  {
    id: "ranking",
    title: "No client is ranked by inferred urgency",
    body:
      "Ordering clients by severity would require a severity we cannot derive without the two facts above. " +
      "The directory is alphabetical because that is the only order the data supports.",
    unlock: "the same evidence that unlocks totals.",
  },
] as const;

export function WithheldExplainer() {
  const copy = useCopy();
  return (
    <section>
      <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: "26px", margin: 0 }}>
        Why Agency shows no totals
      </h2>
      <p style={{ fontSize: 13, lineHeight: "19px", color: "var(--ledger-ink-secondary)", marginTop: 8 }}>
        Three specific facts are missing. Each is listed with what would unlock it, so this is a
        state with an exit rather than a permanent gap.
      </p>

      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {WITHHELD_REASONS.map((reason) => (
          <div key={reason.id} data-withheld-reason={reason.id}>
            <WithheldState reason={`${reason.title}. ${reason.body}`} unlock={reason.unlock} />
          </div>
        ))}
      </div>

      <p style={{ fontSize: 13, lineHeight: "19px", marginTop: 16 }}>
        <Link href="/a/desk/clients" style={{ color: "var(--ledger-accent-action)" }}>
          {copy.backToClients}
        </Link>
      </p>
    </section>
  );
}
