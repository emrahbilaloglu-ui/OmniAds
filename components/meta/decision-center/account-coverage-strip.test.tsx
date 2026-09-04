// D078 R4 (correction 2) rendered proof: the Decision Center's
// account-coverage panel makes every ASSIGNED account state explicit with
// ALL required evidence AVAILABLE in an operator-openable disclosure — id/name, selection state, currency,
// timezone, own-window spend, fact freshness, latest generation with
// produced/authorized counts, and the operator policy implication as plain
// text (never hover-only). Tri-state: `null` (read FAILED) renders a
// visible warning; `[]` (read proved zero) renders a distinct anomalous
// state; populated renders the panel; `undefined` (legacy payload) renders
// nothing. Display-only throughout.
//
// Fail-first: correction 1 rendered a compressed one-line strip with the
// policy hidden in a title attribute, dropped the timezone entirely, and
// PINNED that `null` renders nothing — these assertions fail on that code.
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

describe("Decision Center · assigned-account coverage panel (D078 R4, correction 2)", () => {
  it("keeps every required account fact and policy in one operator-openable disclosure", () => {
    const html = renderToStaticMarkup(
      <MetaDecisionCenterExact viewModel={{ assignedAccountStates: STATES }} />,
    );
    const panel = html.match(
      /<details[^>]*data-testid="assigned-account-coverage"[\s\S]*?<\/details>/,
    )?.[0];
    expect(panel).toBeTruthy();
    expect(panel).not.toMatch(/^<details[^>]*\sopen(?:=|\s|>)/);
    expect(panel).toContain("2 assigned Meta accounts");
    expect(panel).toContain(
      "Warning: 1 deselected account has recorded 14-day spend; it is read-only and excluded from served decisions.",
    );
    // Identity + state.
    expect(panel).toContain("TheSwaf-Main | act_main");
    expect(panel).toContain("selected · serving");
    expect(panel).toContain("TheSwaf-NonTesvik | act_second");
    expect(panel).toContain("deselected · read-only history");
    // Currency AND timezone, visibly.
    expect(panel).toContain("currency USD");
    expect(panel).toContain("timezone America/Chicago");
    // Own-window spend + freshness + generation evidence.
    expect(panel).toContain("spend 14d 1,652 USD");
    expect(panel).toContain("facts to 2026-08-20");
    expect(panel).toContain("latest decisions 2026-08-21");
    expect(panel).toContain("126 decision rows (2 authorized) — unserved");
    // The policy implication is body text, not a title attribute.
    const policySpan = panel!.match(
      /<span[^>]*data-account-coverage-policy[^>]*>([^<]*)<\/span>/g,
    );
    expect(policySpan?.length).toBe(2);
    expect(panel).toContain(
      "Re-selecting it (or stopping its production) is an explicit operator decision.",
    );
    expect(panel).not.toMatch(/title="[^"]*Deselected/);
    // Display-only: no control on any row.
    expect(panel).not.toMatch(/<(button|a|input|select|form)\b/);
  });

  it("null (read FAILED) renders a visible coverage-unavailable warning — never silence", () => {
    const html = renderToStaticMarkup(
      <MetaDecisionCenterExact viewModel={{ assignedAccountStates: null }} />,
    );
    expect(html).toContain(
      'data-testid="assigned-account-coverage-unavailable"',
    );
    expect(html).toContain("Assigned-account coverage unavailable");
    expect(html).toContain("Do not assume there is only one account");
    expect(html).not.toContain('data-testid="assigned-account-coverage"');
  });

  it("[] (read proved zero) renders a distinct anomalous-empty state", () => {
    const html = renderToStaticMarkup(
      <MetaDecisionCenterExact viewModel={{ assignedAccountStates: [] }} />,
    );
    expect(html).toContain('data-testid="assigned-account-coverage-empty"');
    expect(html).toContain("ZERO assigned Meta identities");
    expect(html).not.toContain("coverage unavailable");
  });

  it("undefined (legacy payload) renders nothing — compatibility only", () => {
    const html = renderToStaticMarkup(
      <MetaDecisionCenterExact viewModel={{}} />,
    );
    expect(html).not.toContain("assigned-account-coverage");
  });
});
