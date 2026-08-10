import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DecisionWorkflowControls } from "@/components/meta/os/DecisionWorkflowControls";

const source = readFileSync("components/meta/os/DecisionWorkflowControls.tsx", "utf8");
const view = readFileSync("components/meta/os/DecisionsOsView.tsx", "utf8");

function render() {
  return renderToStaticMarkup(
    <DecisionWorkflowControls
      businessId="biz-1"
      decisionKey="dec-1"
      entityType="ad"
      entityId="ad-1"
      providerAccountId="act_1"
    />,
  );
}

describe("ownership is visible where the decision is", () => {
  it("is mounted in the decision inspector", () => {
    expect(view).toContain("<DecisionWorkflowControls");
  });

  it("renders nothing until state is known, rather than claiming unclaimed", () => {
    // Server render has no fetched state yet; showing "Unclaimed" here would be
    // asserting something we have not read.
    expect(render()).toBe("");
  });

  it("offers claiming, deferring and disagreeing", () => {
    expect(source).toContain("I've got this");
    expect(source).toContain("Not this week");
    expect(source).toContain("Disagree");
  });
});

describe("the controls tell the truth about what happened", () => {
  it("sends the version it read, so a stale change cannot overwrite a newer one", () => {
    expect(source).toContain("expectedVersion: record.stateVersion");
  });

  it("shows the server's message on conflict and reloads the current state", () => {
    expect(source).toContain("That change was not recorded.");
    expect(source).toContain("current: WorkflowRecord");
  });

  it("requires a reason before disagreeing can be pressed", () => {
    expect(source).toContain("needsReason ? reason.trim().length === 0 : false");
    expect(source).toContain("Disagreeing requires a reason");
  });

  it("says when ownership tracking is unavailable rather than showing no owner", () => {
    expect(source).toContain('data-workflow-state="unavailable"');
    expect(source).toContain("shows no owner");
  });

  it("never sends a field that could change the decision itself", () => {
    // Only the request body matters here; button copy legitimately uses "label".
    const body = source.slice(
      source.indexOf("body: JSON.stringify({"),
      source.indexOf("});", source.indexOf("body: JSON.stringify({")),
    );
    for (const forbidden of [
      "buyerAction",
      "label",
      "authority",
      "riskTier",
      "providerMutation",
      "confidence",
    ]) {
      expect(body, `${forbidden} must not be sent from a workflow control`).not.toContain(
        forbidden,
      );
    }
  });
});
