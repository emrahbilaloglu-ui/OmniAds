import { describe, expect, it } from "vitest";

import {
  resolveCurrencyProof,
  resolveEvidenceFreshness,
  resolveProviderScopeMode,
  resolveTimezoneProof,
} from "@/lib/workspace/workspace-context";

describe("resolveProviderScopeMode", () => {
  it("never reports a single account when several are selected", () => {
    expect(resolveProviderScopeMode([])).toBe("none");
    expect(resolveProviderScopeMode(["act_1"])).toBe("single");
    expect(resolveProviderScopeMode(["act_1", "act_2"])).toBe("portfolio");
  });
});

describe("resolveCurrencyProof", () => {
  it("does not call a configured currency proven", () => {
    expect(
      resolveCurrencyProof({ configuredCurrency: "USD", observedCurrencies: [] }),
    ).toBe("configured-only");
  });

  it("is proven only when the observed currency matches what is configured", () => {
    expect(
      resolveCurrencyProof({ configuredCurrency: "USD", observedCurrencies: ["USD"] }),
    ).toBe("proven");
    expect(
      resolveCurrencyProof({ configuredCurrency: "USD", observedCurrencies: ["USD", "USD"] }),
    ).toBe("proven");
  });

  it("reports a disagreement or several observed currencies as mixed", () => {
    expect(
      resolveCurrencyProof({ configuredCurrency: "USD", observedCurrencies: ["TRY"] }),
    ).toBe("mixed");
    expect(
      resolveCurrencyProof({ configuredCurrency: "USD", observedCurrencies: ["USD", "TRY"] }),
    ).toBe("mixed");
  });

  it("is unknown when there is nothing to compare", () => {
    expect(
      resolveCurrencyProof({ configuredCurrency: null, observedCurrencies: [] }),
    ).toBe("unknown");
    expect(
      resolveCurrencyProof({ configuredCurrency: null, observedCurrencies: ["USD"] }),
    ).toBe("unknown");
  });
});

describe("resolveTimezoneProof", () => {
  it("distinguishes aligned, missing and disagreement", () => {
    expect(
      resolveTimezoneProof({ businessTimezone: "Europe/Istanbul", accountTimezone: "Europe/Istanbul" }),
    ).toBe("aligned");
    expect(
      resolveTimezoneProof({ businessTimezone: "Europe/Istanbul", accountTimezone: "UTC" }),
    ).toBe("disagreement");
    expect(resolveTimezoneProof({ businessTimezone: null, accountTimezone: "UTC" })).toBe(
      "missing",
    );
    expect(
      resolveTimezoneProof({ businessTimezone: "UTC", accountTimezone: null }),
    ).toBe("missing");
  });
});

describe("resolveEvidenceFreshness", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");

  it("is unknown rather than fresh when there is no usable snapshot time", () => {
    expect(resolveEvidenceFreshness({ snapshotAt: null, now })).toBe("unknown");
    expect(resolveEvidenceFreshness({ snapshotAt: "not a date", now })).toBe("unknown");
    // A snapshot in the future is a clock problem, not freshness.
    expect(
      resolveEvidenceFreshness({ snapshotAt: "2026-08-12T12:00:00.000Z", now }),
    ).toBe("unknown");
  });

  it("goes stale past the window", () => {
    expect(
      resolveEvidenceFreshness({ snapshotAt: "2026-08-11T11:00:00.000Z", now }),
    ).toBe("fresh");
    expect(
      resolveEvidenceFreshness({ snapshotAt: "2026-08-09T12:00:00.000Z", now }),
    ).toBe("stale");
    expect(
      resolveEvidenceFreshness({
        snapshotAt: "2026-08-11T11:00:00.000Z",
        now,
        staleAfterMinutes: 30,
      }),
    ).toBe("stale");
  });
});
