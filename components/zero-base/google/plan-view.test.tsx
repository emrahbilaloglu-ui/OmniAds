// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { GooglePlanView } from "@/components/zero-base/google/plan-view";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { resolveGoogleScope } from "@/lib/zero-base/google/google-contract";
import { buildPlan, pendingCopyIsClean, type ServedRecommendation } from "@/lib/zero-base/google/manual-plan";

afterEach(cleanup);

function rec(o: Partial<ServedRecommendation> = {}): ServedRecommendation {
  return {
    id: "r1",
    rank: 1,
    title: "Raise budget on Brand",
    rationale: "Impression share lost to budget.",
    accountId: "123-456-7890",
    entityType: "campaign",
    entityId: "c-1",
    entityName: "Brand",
    ...o,
  };
}

function plan(items = [rec()], statuses: string[] = []) {
  render(
    <ZeroBasePortalHost>
      <GooglePlanView
        scope={resolveGoogleScope([{ id: "a1", name: "Main", currency: "USD", timezone: "UTC" }])}
        source={{ kind: "serving", observedAt: null }}
        steps={buildPlan(items)}
        servedStatuses={statuses}
      />
    </ZeroBasePortalHost>,
  );
}

describe("the manual path is primary", () => {
  it("states that nothing here changes Google, above the reference states", () => {
    plan();
    const text = document.querySelector("[data-manual-primary]")!.textContent ?? "";
    expect(text).toMatch(/Carry these out in Google Ads yourself/);
    expect(text).toMatch(/Nothing on this page changes anything in Google/);
  });

  it("offers copy and CSV on the manual plan", () => {
    plan();
    expect(document.querySelector("[data-plan-copy]")).not.toBeNull();
    expect(document.querySelector("[data-plan-csv]")).not.toBeNull();
  });

  it("copies the plan text to the clipboard", async () => {
    plan();
    // The button reads the clipboard API off `navigator` at click time, and
    // jsdom has none by default; define it explicitly and click directly rather
    // than through userEvent, which installs a stub of its own.
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    (document.querySelector("[data-plan-copy]") as HTMLElement).click();
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("1. Raise budget on Brand");
  });

  it("links each step to its exact entity", () => {
    plan();
    const href = document.querySelector('[data-plan-link="r1"]')!.getAttribute("href")!;
    expect(href).toContain("__e=1234567890");
    expect(href).toContain("id=c-1");
  });

  it("shows dependency and stabilization weaknesses on the step", () => {
    plan([rec({ dependencyReadiness: "not_ready", stabilizationNote: "14 days" })]);
    const weaknesses = [...document.querySelectorAll('[data-plan-weakness="r1"]')].map((n) => n.textContent);
    expect(weaknesses.join(" ")).toMatch(/Dependency not ready/);
    expect(weaknesses.join(" ")).toMatch(/Stabilization: 14 days/);
  });
});

describe("pending copy and partially applied", () => {
  it("never says reconciliation", () => {
    plan();
    const pending = document.querySelector("[data-google-pending]")!.textContent ?? "";
    expect(pendingCopyIsClean(pending)).toBe(true);
    expect(pending).toMatch(/change history in Google Ads/);
  });

  it("shows the partially-applied specimen only when the contract carries it", () => {
    plan([rec()], ["applied", "partially_applied"]);
    expect(document.querySelector("[data-partially-applied]")).not.toBeNull();
    cleanup();
    plan([rec()], ["applied"]);
    expect(document.querySelector("[data-partially-applied]")).toBeNull();
  });
});

describe("reference write states", () => {
  it("keeps both disabled with reasons and no executable control", () => {
    plan();
    expect(document.querySelector('[data-reference-write="single"]')).not.toBeNull();
    expect(document.querySelector('[data-reference-write="batch"]')).not.toBeNull();
    expect(document.body.textContent).toMatch(/No Google mutation layer exists/);
  });

  it("has no pause control at all", () => {
    plan();
    expect(document.body.textContent).not.toMatch(/pause/i);
  });

  it("validates a batch selection without executing anything", async () => {
    plan([rec({ id: "a", entityType: "campaign" }), rec({ id: "b", rank: 2, entityType: "keyword" })]);
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-plan-select="a"]') as HTMLElement);
    await user.click(document.querySelector('[data-plan-select="b"]') as HTMLElement);
    await user.click(document.querySelector("[data-batch-validate]") as HTMLElement);
    expect(document.querySelector("[data-batch-error]")!.textContent).toMatch(/one entity type/);
  });

  it("states the batch shape including the 250 cap", () => {
    plan();
    expect(document.body.textContent).toMatch(/one entity type in one account, up to 250 items/);
  });
});
