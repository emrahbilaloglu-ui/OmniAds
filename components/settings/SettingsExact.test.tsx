import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsExact } from "@/components/settings/SettingsExact";
import {
  buildSettingsExactModel,
  type SettingsAdapterInput,
} from "@/components/settings/settings-exact-adapter";

function input(overrides: Partial<SettingsAdapterInput> = {}): SettingsAdapterInput {
  return {
    account: { name: "Emrah B.", email: "emrah@grandmix.co" },
    language: "en",
    workspace: { timezone: "Europe/Istanbul", timezoneSource: "shopify" },
    billing: {
      planName: "Growth",
      monthlyPrice: 49,
      upgradeAvailable: true,
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
          planName: null,
          monthlyPrice: null,
          upgradeAvailable: false,
          unavailable: true,
        },
      }),
    );
    expect(model.plan.title).toBe("Plan —");
    expect(model.plan.action).toBeNull();
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
      "Unlocks Commercial Truth. Reports &amp; Insights need Pro; Team seats need Scale.",
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
