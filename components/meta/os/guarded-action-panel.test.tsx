import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GuardedActionPanel } from "@/components/meta/os/GuardedActionPanel";
import type { MetaOsDecisionAction } from "@/lib/meta/decisions-os-contract";

const source = readFileSync("components/meta/os/GuardedActionPanel.tsx", "utf8");
const view = readFileSync("components/meta/os/DecisionsOsView.tsx", "utf8");

function action(overrides: Partial<MetaOsDecisionAction> = {}): MetaOsDecisionAction {
  return {
    code: "pause_ad",
    label: "Pause ad",
    intent: "execute",
    targetLevel: "ad",
    providerMutation: "pause",
    scopeNote: "single ad",
    ...overrides,
  } as MetaOsDecisionAction;
}

function render(props: Partial<React.ComponentProps<typeof GuardedActionPanel>> = {}) {
  return renderToStaticMarkup(
    <GuardedActionPanel
      businessId="biz-1"
      providerAccountId="act_1"
      action={action()}
      ad={{ adId: "ad-1", creativeId: "cr-1", decisionId: "dec-1" } as never}
      killSwitchEngaged={false}
      {...props}
    />,
  );
}

describe("the card renders the capability it was given", () => {
  it("is mounted in the decision inspector", () => {
    expect(view).toContain("<GuardedActionPanel");
  });

  it("shows a dry-run ceiling rather than an execute button by default", () => {
    const html = render();
    expect(html).toContain('data-guarded-action="dry_run_eligible"');
    expect(html).not.toContain(">Execute<");
  });

  it("shows blocked, and offers no check, when the kill switch is engaged", () => {
    const html = render({ killSwitchEngaged: true });
    expect(html).toContain('data-guarded-action="blocked"');
    expect(html).not.toContain("Check target");
  });

  it("falls back to review-only for a non-execute intent", () => {
    const html = render({ action: action({ intent: "review", providerMutation: null }) });
    expect(html).toContain('data-guarded-action="review_only"');
  });

  it("states why the action is limited", () => {
    expect(render()).toContain("stops before the provider");
  });
});

describe("the panel cannot act, only check", () => {
  it("calls the preflight route and nothing else", () => {
    expect(source).toContain('"/api/meta/decision-action/preflight"');
    expect(source).not.toContain("entity-actions");
    expect(source).not.toContain("/pause");
    expect(source).not.toContain("/resume");
  });

  it("does not assert a status the decision never recorded", () => {
    expect(source).toContain("expectedStatus: null");
    expect(source).toContain("inventing a status the decision never recorded");
  });

  it("surfaces a failed check rather than leaving the operator guessing", () => {
    expect(source).toContain("Preflight could not run.");
    expect(source).toContain("data-preflight-error");
  });

  it("renders the verdict and any drift it found", () => {
    expect(source).toContain("data-preflight-verdict");
    expect(source).toContain("receipt.drift.join");
  });
});
