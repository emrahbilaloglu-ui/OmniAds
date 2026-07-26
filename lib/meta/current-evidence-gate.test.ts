import { describe, expect, it } from "vitest";

import {
  decideMetaCurrentEvidence,
  type MetaEvidenceTruthState,
} from "@/lib/meta/current-evidence-gate";

const TODAY = "2026-07-26";

describe("decideMetaCurrentEvidence", () => {
  it("admits only the account's own local today, declared provisional", () => {
    const decision = decideMetaCurrentEvidence({
      truthState: "provisional",
      normalizedDay: TODAY,
      accountToday: TODAY,
    });
    expect(decision).toEqual({
      persistsCurrentConfigEvidence: true,
      appendConfigHistory: true,
      persistsEntityObservations: true,
      reason: "current_provisional_day",
    });
  });

  it.each<MetaEvidenceTruthState>([
    "provisional",
    "finalized",
    "repair_pending",
    "repair_failed",
  ])("refuses every current-evidence writer on a historical day (%s)", (truthState) => {
    const decision = decideMetaCurrentEvidence({
      truthState,
      normalizedDay: "2026-04-03",
      accountToday: TODAY,
    });
    // All three must move together. A historical day that withheld the config
    // snapshot but still appended config history or an entity observation run
    // is exactly the state this gate exists to make impossible.
    expect(decision.persistsCurrentConfigEvidence).toBe(false);
    expect(decision.appendConfigHistory).toBe(false);
    expect(decision.persistsEntityObservations).toBe(false);
    expect(decision.reason).toBe("historical_day");
  });

  it.each<MetaEvidenceTruthState>(["finalized", "repair_pending", "repair_failed"])(
    "refuses a non-provisional replay of today (%s)",
    (truthState) => {
      // Re-running today as a repair or replay fetches the inventory as it is
      // NOW, which does not describe the state those facts were produced from.
      const decision = decideMetaCurrentEvidence({
        truthState,
        normalizedDay: TODAY,
        accountToday: TODAY,
      });
      expect(decision.persistsCurrentConfigEvidence).toBe(false);
      expect(decision.reason).toBe("non_provisional_replay_of_today");
    },
  );

  it("keeps a full backfill wave at zero current-evidence writes", () => {
    // The incident shape: 761 historical days per account, each of which used
    // to write three config surfaces plus an entity observation run.
    const days = Array.from({ length: 761 }, (_, index) => {
      const date = new Date(Date.UTC(2024, 0, 1) + index * 86_400_000);
      return date.toISOString().slice(0, 10);
    });
    const persisting = days
      .map((day) =>
        decideMetaCurrentEvidence({
          truthState: "finalized",
          normalizedDay: day,
          accountToday: TODAY,
        }),
      )
      .filter((decision) => decision.persistsCurrentConfigEvidence);
    expect(persisting).toHaveLength(0);
  });
});
