// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  GoogleAdvisorView,
  GoogleCollectionView,
  GoogleOverviewView,
} from "@/components/zero-base/google/google-views";
import {
  containsForbiddenVocabulary,
  googleValue,
  resolveGoogleScope,
} from "@/lib/zero-base/google/google-contract";

afterEach(cleanup);

const ACCOUNTS = [
  { id: "a1", name: "Main", currency: "USD", timezone: "UTC" },
  { id: "a2", name: "Second", currency: "TRY", timezone: "Europe/Istanbul" },
];

describe("scope is always on the surface", () => {
  it("names a single account", () => {
    render(
      <GoogleOverviewView
        scope={resolveGoogleScope([ACCOUNTS[0]])}
        source={{ kind: "serving", observedAt: "t" }}
        rows={[]}
      />,
    );
    expect(document.querySelector('[data-google-scope="single"]')!.textContent).toContain("Main · USD · UTC");
  });

  it("warns that a mixed portfolio is not summed", () => {
    render(
      <GoogleOverviewView
        scope={resolveGoogleScope(ACCOUNTS)}
        source={{ kind: "serving", observedAt: null }}
        rows={[]}
      />,
    );
    expect(document.querySelector("[data-google-unsummable]")!.textContent).toMatch(
      /currencies and .* time zones/,
    );
  });

  it("shows per-account rows rather than one merged number", () => {
    render(
      <GoogleOverviewView
        scope={resolveGoogleScope(ACCOUNTS)}
        source={{ kind: "serving", observedAt: null }}
        rows={ACCOUNTS.map((a) => ({
          id: a.id,
          account: a.name!,
          spend: googleValue(10, (v) => v.toFixed(2)),
          conversions: googleValue(1, String),
          pulse: "Steady",
        }))}
      />,
    );
    // Scope is preserved by keeping the accounts apart.
    expect(document.querySelectorAll("tbody tr").length).toBe(2);
  });
});

describe("source states", () => {
  const scope = resolveGoogleScope([ACCOUNTS[0]]);

  it("distinguishes partial from serving", () => {
    render(
      <GoogleOverviewView
        scope={scope}
        source={{ kind: "partial", reason: "Two campaigns are still importing.", observedAt: null }}
        rows={[]}
      />,
    );
    expect(document.querySelector('[data-google-source="partial"]')!.textContent).toMatch(
      /still importing/,
    );
  });

  it("names a rate limit with its retry window", () => {
    render(
      <GoogleOverviewView
        scope={scope}
        source={{ kind: "rate_limited", reason: "Google throttled this read.", retryAfterSeconds: 30 }}
        rows={[]}
      />,
    );
    expect(document.querySelector('[data-google-source="rate_limited"]')!.textContent).toMatch(
      /Retry in 30s/,
    );
  });

  it("prints an unavailable metric as not served, never as 0", () => {
    render(
      <GoogleOverviewView
        scope={scope}
        source={{ kind: "serving", observedAt: null }}
        rows={[
          {
            id: "a1",
            account: "Main",
            spend: googleValue(null, String),
            conversions: googleValue(0, String),
            pulse: "Steady",
          },
        ]}
      />,
    );
    expect(document.querySelector('[data-google-unavailable="spend"]')!.textContent).toMatch(/Not served/);
    // A measured zero is still a measurement.
    expect(document.querySelector('[data-google-metric="conversions"]')!.getAttribute("data-google-raw")).toBe("0");
  });
});

describe("advisor", () => {
  const card = {
    id: "c1",
    title: "Raise a bid",
    reason: "The signal has not stabilized.",
    fingerprint: "sha:abc",
    dependency: "Conversion import freshness",
    stabilization: "14 days",
    unverified: "Incremental lift",
  };

  function advisor(cards = [card]) {
    render(
      <GoogleAdvisorView
        scope={resolveGoogleScope([ACCOUNTS[0]])}
        source={{ kind: "serving", observedAt: null }}
        items={[
          { id: "1", title: "Fix tracking", rationale: null, urgency: "high" },
          { id: "2", title: "Review budgets", rationale: null },
        ]}
        referenceCards={cards}
      />,
    );
  }

  it("renders all three horizons", () => {
    advisor();
    for (const horizon of ["do_now", "next", "later"]) {
      expect(document.querySelector(`[data-advisor-horizon="${horizon}"]`), horizon).not.toBeNull();
    }
    expect(document.querySelectorAll('[data-advisor-item="do_now"]').length).toBe(1);
    expect(document.querySelectorAll('[data-advisor-item="later"]').length).toBe(1);
    expect(document.querySelector('[data-advisor-empty="next"]')).not.toBeNull();
  });

  it("renders every required field on a default-off card", () => {
    advisor();
    for (const field of ["reason", "fingerprint", "dependency", "stabilization", "unverified"]) {
      expect(document.querySelector(`[data-card-${field}]`), field).not.toBeNull();
    }
  });

  it("does not render an incomplete card at all", () => {
    advisor([{ ...card, dependency: "" }]);
    // A card missing its dependency looks like a feature awaiting a switch.
    expect(document.querySelector('[data-reference-card="c1"]')).toBeNull();
  });

  it("says the reference proposals are not pending a switch", () => {
    advisor();
    expect(document.body.textContent).toMatch(/not because a switch is pending/);
  });
});

describe("collections", () => {
  it("discloses a served cap and says when none was supplied", () => {
    render(
      <GoogleCollectionView
        title="Google search"
        scope={resolveGoogleScope([ACCOUNTS[0]])}
        source={{ kind: "serving", observedAt: null }}
        rows={[]}
        columns={[{ id: "term", header: "Term" }]}
        capText="The backend did not supply a row cap."
      />,
    );
    expect(document.querySelector("[data-google-cap]")!.textContent).toMatch(/did not supply/);
  });
});

describe("no Meta vocabulary reaches a Google surface", () => {
  it("renders none of the forbidden words", () => {
    render(
      <GoogleAdvisorView
        scope={resolveGoogleScope(ACCOUNTS)}
        source={{ kind: "partial", reason: "Still importing.", observedAt: null }}
        items={[{ id: "1", title: "Fix tracking", rationale: "Conversions dropped.", urgency: "high" }]}
        referenceCards={[]}
      />,
    );
    expect(containsForbiddenVocabulary(document.body.textContent ?? "")).toEqual([]);
  });
});
