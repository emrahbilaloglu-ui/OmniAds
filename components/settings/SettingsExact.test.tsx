import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsExact } from "@/components/settings/SettingsExact";
import {
  buildSettingsExactModel,
  type SettingsAdapterInput,
} from "@/components/settings/settings-exact-adapter";
import { PLAN_LABELS, PRICING_PLANS, type PlanId } from "@/lib/pricing/plans";

function input(overrides: Partial<SettingsAdapterInput> = {}): SettingsAdapterInput {
  return {
    account: { name: "Emrah B.", email: "emrah@grandmix.co" },
    language: "en",
    workspace: { timezone: "Europe/Istanbul", timezoneSource: "shopify" },
    billing: {
      planId: "growth",
      planName: "Growth",
      monthlyPrice: 49,
      managedPricingAvailable: true,
      unavailable: false,
    },
    ...overrides,
  };
}

function render(model = buildSettingsExactModel(input())) {
  return renderToStaticMarkup(
    React.createElement(SettingsExact, {
      model,
      flash: null,
      busyRow: null,
      onNameChange: () => {},
      onNameCommit: () => {},
      onLanguageChange: () => {},
      onRowAction: () => {},
      onUpgrade: () => {},
    }),
  );
}

const source = readFileSync("components/settings/SettingsExact.tsx", "utf8");
const routeSource = readFileSync("app/(dashboard)/settings/legacy-page.tsx", "utf8");

describe("buildSettingsExactModel", () => {
  it("defines exactly three action rows, in the design's order", () => {
    const model = buildSettingsExactModel(input());
    expect(model.rows.map((row) => row.title)).toEqual([
      "Change password",
      "Active sessions",
      "Resync warehouse",
    ]);
    expect(model.rows.map((row) => row.button)).toEqual([
      "Update",
      "Revoke others",
      "Run resync",
    ]);
  });

  it("keeps the design's resync reassurance clause verbatim", () => {
    const model = buildSettingsExactModel(input());
    expect(model.rows[2].detail).toBe(
      "Rebuild read models from provider data. Safe, may take minutes.",
    );
  });

  it("states a plan it could not read as unknown instead of unconnected", () => {
    const model = buildSettingsExactModel(
      input({
        billing: {
          planId: null,
          planName: null,
          monthlyPrice: null,
          managedPricingAvailable: false,
          unavailable: true,
        },
      }),
    );
    expect(model.plan.title).toBe("Plan —");
    expect(model.plan.action).toBeNull();
  });

  it("derives the entitlement sentence from the plan the workspace is on", () => {
    const detail = (planId: PlanId) =>
      buildSettingsExactModel(
        input({
          billing: {
            planId,
            planName: PLAN_LABELS[planId],
            monthlyPrice: PRICING_PLANS[planId].monthlyPrice,
            managedPricingAvailable: true,
            unavailable: false,
          },
        }),
      ).plan.detail;

    // /reports and /insights are both `PlanGate requiredPlan="pro"`, team seats
    // are gated on "scale", and Commercial Truth is gated on nothing.
    expect(detail("starter")).toBe(
      "Includes Commercial Truth. Reports & Insights need Pro; Team seats need Scale.",
    );
    expect(detail("pro")).toBe(
      "Includes Commercial Truth and Reports & Insights. Team seats need Scale.",
    );
    // On the top plan nothing is still owed, so nothing is claimed to be.
    expect(detail("scale")).toBe(
      "Includes Commercial Truth, Reports & Insights and Team seats.",
    );
    expect(detail("scale")).not.toContain("need");
  });

  it("names the plan above this one on the button, never the one already held", () => {
    const action = (planId: PlanId, managedPricingAvailable = true) =>
      buildSettingsExactModel(
        input({
          billing: {
            planId,
            planName: PLAN_LABELS[planId],
            monthlyPrice: PRICING_PLANS[planId].monthlyPrice,
            managedPricingAvailable,
            unavailable: false,
          },
        }),
      ).plan.action;

    expect(action("starter")).toBe("Upgrade to Growth");
    expect(action("growth")).toBe("Upgrade to Pro");
    expect(action("pro")).toBe("Upgrade to Scale");
    // Scale is the top plan; telling its operator to upgrade to it would be a lie.
    expect(action("scale")).toBe("Manage plan");
    // No managed-pricing URL means the button would go nowhere, so it is absent.
    expect(action("pro", false)).toBeNull();
  });

  it("shows the derived timezone and its source, never an operator choice", () => {
    expect(buildSettingsExactModel(input()).timezone).toBe("Europe/Istanbul · from shopify");
    expect(
      buildSettingsExactModel(input({ workspace: { timezone: null, timezoneSource: null } }))
        .timezone,
    ).toBe("—");
  });
});

describe("SettingsExact", () => {
  it("renders exactly one field card of the design's four fields", () => {
    const html = render();
    for (const label of ["Full name", "Email", "Interface language", "Workspace timezone"]) {
      expect(html).toContain(label);
    }
    for (const absent of [
      "Workspace name",
      "Reporting currency",
      "Default date range",
      "Metric display",
      "Table density",
      "Heatmap cells",
      "Save profile",
      "Save workspace",
    ]) {
      expect(html).not.toContain(absent);
    }
  });

  it("renders the navy plan band with a single upgrade button", () => {
    const html = render();
    expect(html).toContain("Growth plan · $49/mo");
    expect(html).toContain(
      "Includes Commercial Truth. Reports &amp; Insights need Pro; Team seats need Scale.",
    );
    expect(html.match(/Upgrade to Pro/g)).toHaveLength(1);
  });

  it("renders exactly three action rows and no danger zone", () => {
    const html = render();
    expect(html).toContain("Change password");
    expect(html).toContain("Active sessions");
    expect(html).toContain("Resync warehouse");
    for (const absent of [
      "Refresh provider snapshots",
      "Clear cached provider accounts",
      "Disconnect all integrations",
      "Delete workspace",
    ]) {
      expect(html).not.toContain(absent);
    }
  });

  it("has no inline password form and no confirmation overlays", () => {
    const html = render();
    expect(html).not.toContain("Current password");
    expect(html).not.toContain("New password");
    expect(source).not.toContain("ConfirmOverlay");
    expect(routeSource).not.toContain("ConfirmOverlay");
    expect(routeSource).not.toContain("deleteWorkspace");
  });
});
