import React from "react";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mockAppState = {
  businesses: [
    {
      id: "biz_1",
      name: "Workspace One",
      currency: "USD",
      timezone: "Europe/Istanbul",
      timezoneSource: "shopify" as const,
    },
  ],
  selectedBusinessId: "biz_1" as string | null,
};

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: typeof mockAppState) => unknown) => selector(mockAppState),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (state: { language: "en"; setLanguage: () => void }) => unknown) =>
    selector({ language: "en", setLanguage: () => {} }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: () => {},
}));

const originalFetch = globalThis.fetch;

describe("/settings", () => {
  beforeEach(() => {
    mockAppState.selectedBusinessId = "biz_1";
    globalThis.fetch = (() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) })) as unknown as typeof fetch;
  });

  it("renders one field card, the plan band and three action rows", async () => {
    const { default: SettingsPage } = await import("@/app/(dashboard)/settings/legacy-page");
    const html = renderToStaticMarkup(React.createElement(SettingsPage));

    expect(html).toContain('data-screen-label="Settings"');
    expect(html).toContain("Full name");
    expect(html).toContain("Workspace timezone");
    expect(html).toContain("Change password");
    expect(html).toContain("Active sessions");
    expect(html).toContain("Resync warehouse");
    for (const absent of [
      "Workspace name",
      "Reporting currency",
      "Default date range",
      "Refresh provider snapshots",
      "Clear cached provider accounts",
      "Disconnect all integrations",
      "Delete workspace",
    ]) {
      expect(html).not.toContain(absent);
    }
    globalThis.fetch = originalFetch;
  });
});

describe("the Settings route keeps its freshness contract", () => {
  const source = readFileSync("app/(dashboard)/settings/legacy-page.tsx", "utf8");

  it("still reports its data age from the read it measured", () => {
    expect(source).toContain("useTierZeroFreshness(");
    expect(source).toContain("asOf: measuredAsOf(settingsReadAt)");
    expect(source).not.toContain("dataUpdatedAt");
  });

  it("mounts the exact screen and drops the deleted chrome", () => {
    expect(source).toContain("SettingsExact");
    expect(source).not.toContain("ConfirmOverlay");
    expect(source).not.toContain("FieldCard");
  });
});
