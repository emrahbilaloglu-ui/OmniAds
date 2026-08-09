import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TierZeroFreshness } from "@/components/states/TierZeroFreshness";
import {
  TierZeroFreshnessBar,
  tierZeroFreshnessBarProps,
} from "@/components/states/TierZeroFreshnessBar";
import { useTierZeroFreshnessStore } from "@/store/tier-zero-freshness-store";

/**
 * The freshness contract, exercised as rendered output rather than as types.
 *
 * The bugs this guards against are all of one shape: a surface that knows less
 * than it is showing. A zero rendered during load, a stale number left on
 * screen after a failed refresh, a retry button that does not retry. Each is
 * indistinguishable from the healthy case to the person reading it.
 */
describe("TierZeroFreshness rendered states", () => {
  it("shows no figure at all while the first read is in flight", () => {
    const html = renderToStaticMarkup(
      <TierZeroFreshness state="loading" asOf={null} surface="meta_decisions" />,
    );
    expect(html).toContain('data-freshness-state="loading"');
    expect(html).toContain("Loading — no figures yet");
    // The specific thing that must not happen.
    expect(html).not.toMatch(/>0</);
  });

  it("names a terminal failure instead of leaving old numbers looking current", () => {
    const html = renderToStaticMarkup(
      <TierZeroFreshness
        state="error"
        asOf="2026-08-01T00:00:00.000Z"
        errorCode="upstream_unavailable"
        surface="google_ads"
      />,
    );
    expect(html).toContain('data-freshness-error="upstream_unavailable"');
    expect(html).toContain("Could not load — figures withheld");
    // The as-of is not rendered as if the figures were fine.
    expect(html).not.toContain("2026");
  });

  it("offers a retry only when there is something to retry", () => {
    const withRetry = renderToStaticMarkup(
      <TierZeroFreshness
        state="error"
        asOf={null}
        onRetry={() => {}}
        surface="reports"
      />,
    );
    expect(withRetry).toContain("Try again");

    const without = renderToStaticMarkup(
      <TierZeroFreshness state="error" asOf={null} surface="reports" />,
    );
    // A dead button is worse than no button: it claims the system is trying.
    expect(without).not.toContain("Try again");
  });

  it("says which part is missing rather than presenting a partial total as whole", () => {
    const html = renderToStaticMarkup(
      <TierZeroFreshness
        state="partial"
        asOf="2026-08-08T00:00:00.000Z"
        partialReason="Google could not be read; totals exclude it"
        surface="integrations"
      />,
    );
    expect(html).toContain('data-freshness-partial="true"');
    expect(html).toContain("Google could not be read; totals exclude it");
  });

  it("keeps existing figures visible while refreshing, labelled as such", () => {
    const html = renderToStaticMarkup(
      <TierZeroFreshness
        state="refreshing"
        asOf="2026-08-08T00:00:00.000Z"
        surface="meta_decisions"
      />,
    );
    expect(html).toContain('data-freshness-state="refreshing"');
  });
});

describe("the shared bar reports the active surface", () => {
  beforeEach(() => {
    useTierZeroFreshnessStore.setState({ active: null, retryHandlers: {} });
  });

  it("renders nothing when no surface has reported", () => {
    expect(tierZeroFreshnessBarProps(null, () => {})).toBeNull();
    expect(renderToStaticMarkup(<TierZeroFreshnessBar />)).toBe("");
  });

  it("renders the reading the active surface reported", () => {
    useTierZeroFreshnessStore.getState().report({
      surface: "reports",
      state: "error",
      asOf: null,
      errorCode: "upstream_unavailable",
    });
    const props = tierZeroFreshnessBarProps(
      useTierZeroFreshnessStore.getState().active,
      () => {},
    );
    const html = renderToStaticMarkup(<TierZeroFreshness {...props!} />);
    expect(html).toContain('data-freshness-error="upstream_unavailable"');
  });

  it("offers a retry only for a surface that registered one", () => {
    const refetch = vi.fn();
    const store = useTierZeroFreshnessStore.getState();
    store.registerRetry("tier0:reports", refetch);
    store.report({
      surface: "reports",
      state: "error",
      asOf: null,
      retryKey: "tier0:reports",
    });
    const props = tierZeroFreshnessBarProps(
      useTierZeroFreshnessStore.getState().active,
      store.runRetry,
    );
    props!.onRetry!();
    expect(refetch).toHaveBeenCalledTimes(1);

    store.report({ surface: "google_ads", state: "error", asOf: null });
    const noRetry = tierZeroFreshnessBarProps(
      useTierZeroFreshnessStore.getState().active,
      store.runRetry,
    );
    expect(noRetry!.onRetry).toBeUndefined();
  });

  it("clears when the surface unmounts, so one page cannot speak for the next", () => {
    const store = useTierZeroFreshnessStore.getState();
    store.report({ surface: "reports", state: "ready", asOf: null });
    store.clear("reports");
    expect(useTierZeroFreshnessStore.getState().active).toBeNull();
  });

  it("does not clear when a different surface has taken over", () => {
    const store = useTierZeroFreshnessStore.getState();
    store.report({ surface: "reports", state: "ready", asOf: null });
    store.report({ surface: "google_ads", state: "ready", asOf: null });
    // Reports unmounting after Google mounted must not blank Google's reading.
    store.clear("reports");
    expect(useTierZeroFreshnessStore.getState().active?.surface).toBe(
      "google_ads",
    );
  });

  it("runs the surface's own refetch when retry is pressed", () => {
    const refetch = vi.fn();
    const store = useTierZeroFreshnessStore.getState();
    store.registerRetry("tier0:reports", refetch);
    store.runRetry("tier0:reports");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not pretend to retry a surface that registered no handler", () => {
    expect(() =>
      useTierZeroFreshnessStore.getState().runRetry("tier0:nothing"),
    ).not.toThrow();
  });
});
