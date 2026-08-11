// @vitest-environment jsdom

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  BusinessView,
  IntegrationsView,
  PlanView,
  TeamView,
} from "@/components/zero-base/manage/manage-views";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { BILLING_ENDPOINT, adaptProviderHealth } from "@/lib/zero-base/manage/manage-contract";

afterEach(cleanup);
const ROOT = process.cwd();

describe("integrations are per provider", () => {
  it("shows each provider's own state, including unknown", () => {
    render(
      <ZeroBasePortalHost>
        <IntegrationsView
          providers={adaptProviderHealth(
            { meta: { status: "expired", message: "Token expired." }, google: true },
            ["meta", "google", "shopify"],
          )}
          outcome={{ kind: "unstarted" }}
        />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector('[data-provider-state="meta"]')!.textContent).toBe("Token expired.");
    expect(document.querySelector('[data-provider-state="google"]')!.textContent).toMatch(/Connected/);
    expect(document.querySelector('[data-provider-state="shopify"]')!.textContent).toMatch(/not reported/);
    expect(document.querySelector("[data-no-universal-health]")).not.toBeNull();
  });

  it("offers reconnect only where one is needed", async () => {
    const onReconnect = vi.fn();
    render(
      <ZeroBasePortalHost>
        <IntegrationsView
          providers={adaptProviderHealth({ meta: { status: "expired" }, google: true }, ["meta", "google"])}
          outcome={{ kind: "unstarted" }}
          onReconnect={onReconnect}
        />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector('[data-reconnect="google"]')).toBeNull();
    await userEvent.setup().click(document.querySelector('[data-reconnect="meta"]') as HTMLElement);
    expect(onReconnect).toHaveBeenCalledWith("meta");
  });

  it("reports an unconfirmed reconnect as unknown", () => {
    render(
      <ZeroBasePortalHost>
        <IntegrationsView
          providers={[]}
          outcome={{ kind: "unknown", detail: "The confirming read failed. Treat the result as unknown." }}
        />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector('[data-ceremony="reconnect:unknown"]')!.textContent).toMatch(/unknown/);
  });
});

describe("business", () => {
  const economics = [
    { key: "targetRoas", label: "Target ROAS", source: "Cost model", consumers: ["Decision engine"], value: "2.0" },
    { key: "targetRoas", label: "Target ROAS", source: "Commercial targets", consumers: ["Reports"], value: "2.6" },
  ];

  function business(props: Partial<React.ComponentProps<typeof BusinessView>> = {}) {
    render(
      <ZeroBasePortalHost>
        <BusinessView
          economics={economics}
          recommendedMode="profit_first"
          deleteOutcome={{ kind: "unstarted" }}
          canDelete
          {...props}
        />
      </ZeroBasePortalHost>,
    );
  }

  it("names the diverging sources and their consumers", () => {
    business();
    const text = document.querySelector("[data-economics-divergence]")!.textContent ?? "";
    expect(text).toMatch(/Cost model says 2\.0 \(read by Decision engine\)/);
    expect(text).toMatch(/Commercial targets says 2\.6 \(read by Reports\)/);
  });

  it("shows recommended mode with no control to change it", () => {
    business();
    expect(document.querySelector("[data-recommended-mode]")!.textContent).toBe("profit_first");
    expect(document.querySelector("[data-recommended-mode-note]")!.textContent).toMatch(/cannot be set here/);
    const section = document.querySelector('[aria-label="Operating mode"]')!;
    expect(section.querySelectorAll("input, select, button").length).toBe(0);
  });

  it("never claims deletion succeeded from a response", () => {
    business({ deleteOutcome: { kind: "unknown", detail: "The change was submitted but could not be confirmed." } });
    expect(document.querySelector('[data-ceremony="delete:unknown"]')).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/business deleted/i);
    expect(document.querySelector("[data-delete-note]")!.textContent).toMatch(/never 'deleted'/);
  });

  it("blocks deletion for a non-admin with a stated reason", () => {
    business({ canDelete: false });
    const button = document.querySelector("[data-business-delete]") as HTMLButtonElement;
    expect(button.getAttribute("aria-disabled") ?? button.disabled).toBeTruthy();
  });
});

describe("team permissions are visible", () => {
  it("states why a non-admin cannot manage", () => {
    render(<TeamView members={[]} canManage={false} blockedReason="Only a business admin can change team membership." />);
    expect(document.querySelector("[data-team-blocked]")!.textContent).toMatch(/business admin/);
  });
});

describe("plan gates nothing and has no billing control", () => {
  it("says so on the surface", () => {
    render(<PlanView planName="Adsecute" features={["Reports"]} />);
    expect(document.querySelector("[data-plan-gates-nothing]")!.textContent).toMatch(
      /No route or control in this product is gated by it/,
    );
    expect(document.querySelectorAll("button").length).toBe(0);
  });

  it("has zero call sites to /api/billing in the shipped Manage bundle", () => {
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
      }
      return out;
    }
    const files = [
      ...walk(path.join(ROOT, "components", "zero-base", "manage")),
      ...walk(path.join(ROOT, "lib", "zero-base", "manage")),
      ...walk(path.join(ROOT, "app", "c", "[businessId]", "manage")),
    ];
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      // The contract module names the endpoint in a constant for this test.
      if (file.endsWith("manage-contract.ts")) continue;
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
      expect(source.includes(BILLING_ENDPOINT), path.basename(file)).toBe(false);
      expect(source.includes("billing"), path.basename(file)).toBe(false);
    }
  });
});
