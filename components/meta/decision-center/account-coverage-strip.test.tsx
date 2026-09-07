// Account assignment diagnostics remain available to the adapter but do not
// belong in the primary buyer queue. They are intentionally omitted here so a
// buyer sees decisions and remedies instead of ids, source dates and policy
// prose.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/zero-base/language", () => ({
  useZeroBaseLanguage: () => "en",
}));

const { MetaDecisionCenterExact } =
  await import("@/components/meta/decision-center/MetaDecisionCenterExact");

const STATES = [
  {
    providerAccountId: "act_main",
    accountName: "TheSwaf-Main",
    selectionState: "selected" as const,
    accountCurrency: "USD",
    accountTimezone: "America/Chicago",
    latestFactDate: "2026-08-21",
    spend14d: 33887.25,
    latestDecisionAsOf: "2026-08-22",
    latestDecisionRows: 750,
    latestDecisionAuthorizedRows: 7,
    policy:
      "Selected — serving decisions; in write scope subject to every write gate.",
  },
  {
    providerAccountId: "act_second",
    accountName: "TheSwaf-NonTesvik",
    selectionState: "deselected_historical" as const,
    accountCurrency: "USD",
    accountTimezone: "America/Chicago",
    latestFactDate: "2026-08-20",
    spend14d: 1652.29,
    latestDecisionAsOf: "2026-08-21",
    latestDecisionRows: 126,
    latestDecisionAuthorizedRows: 2,
    policy:
      "Deselected — read-only historical evidence; excluded from serving and from every write control. Re-selecting it (or stopping its production) is an explicit operator decision.",
  },
];

describe("Decision Center · assigned-account diagnostics", () => {
  it("does not mount the diagnostic panel or expose raw account facts", () => {
    const html = renderToStaticMarkup(
      <MetaDecisionCenterExact viewModel={{ assignedAccountStates: STATES }} />,
    );
    expect(html).not.toContain("assigned-account-coverage");
    expect(html).not.toContain("act_main");
    expect(html).not.toContain("act_second");
    expect(html).not.toContain("America/Chicago");
    expect(html).not.toContain("decision rows");
    expect(html).not.toContain("explicit operator decision");
  });

  it.each([
    ["failed", null],
    ["proved empty", []],
    ["legacy", undefined],
  ] as const)(
    "omits the %s diagnostic state",
    (_label, assignedAccountStates) => {
      const html = renderToStaticMarkup(
        <MetaDecisionCenterExact viewModel={{ assignedAccountStates }} />,
      );
      expect(html).not.toContain("assigned-account-coverage");
      expect(html).not.toContain("Assigned-account coverage unavailable");
      expect(html).not.toContain("ZERO assigned Meta identities");
    },
  );
});
