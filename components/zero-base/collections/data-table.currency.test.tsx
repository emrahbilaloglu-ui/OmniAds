import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetricCell } from "./data-table";
import type { MetricValue } from "@/lib/zero-base/state-types";

/**
 * INVARIANTS.md: "Provider-money copy must use the canonical account currency.
 * Missing currency must not silently become USD, $, TRY, or EUR; presentation
 * may say account currency without changing the underlying numeric decision."
 *
 * `MetricValue.currency` is declared `string | null`, so null is a state the
 * contract expects — yet this cell formatted it as USD. Every zero-base surface
 * this table feeds (Meta decisions, Meta history, Launchpad, Manage, Google,
 * Agency) therefore printed an unknown unit as dollars. The number is real, so
 * it is still rendered; only the invented unit is withheld.
 */
const money = (over: Partial<Extract<MetricValue, { state: "available" }>>) =>
  ({
    state: "available",
    value: 1234.5,
    unit: "currency",
    currency: null,
    currencyProven: false,
    sourceAsOf: null,
    ...over,
  }) as MetricValue;

describe("MetricCell never invents a currency", () => {
  it("renders an unknown currency as a bare number, never as dollars", () => {
    const html = renderToStaticMarkup(<MetricCell metric={money({})} />);
    expect(html).not.toContain("$");
    expect(html).not.toContain("USD");
    expect(html).toContain("1,234.50");
    expect(html).toContain("account currency");
  });

  it("still formats a known currency with its own symbol", () => {
    const html = renderToStaticMarkup(
      <MetricCell metric={money({ currency: "TRY", currencyProven: true })} />,
    );
    expect(html).toContain("1,234.50");
    expect(html).not.toContain("account currency");
  });

  it("keeps the existing configured-but-unobserved label for a known currency", () => {
    const html = renderToStaticMarkup(
      <MetricCell metric={money({ currency: "USD", currencyProven: false })} />,
    );
    // A real configured USD is still USD — the fix withholds the GUESS, not a
    // stated currency that simply has not been observed on the wire.
    expect(html).toContain("(configured)");
    expect(html).not.toContain("account currency");
  });

  it("leaves a genuinely unavailable metric as an em dash", () => {
    const html = renderToStaticMarkup(
      <MetricCell metric={{ state: "unavailable", reason: "not measured" }} />,
    );
    expect(html).toContain("—");
    expect(html).not.toContain("0.00");
  });
});
