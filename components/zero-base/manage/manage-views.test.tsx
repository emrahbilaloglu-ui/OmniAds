// @vitest-environment jsdom

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
import { adaptProviderHealth } from "@/lib/zero-base/manage/manage-contract";

afterEach(cleanup);

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
          settings={{ name: "Grandmix", currency: "TRY" }}
          settingsPermission={{ ok: true }}
          settingsState={{ pending: false, error: null, confirmed: null }}
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
    render(
      <TeamView
        members={[]}
        invites={[]}
        accessRequests={[]}
        workspaces={[]}
        permissions={{
          membersWrite: { ok: false, reason: "This needs the admin role. Your role on this workspace is reviewer." },
          invitesWrite: { ok: false, reason: "This needs the admin role. Your role on this workspace is reviewer." },
          accessRequests: { ok: false, reason: "This needs the admin role. Your role on this workspace is reviewer." },
        }}
        write={{ pending: null, error: null, confirmed: null }}
      />,
    );
    expect(document.querySelector("[data-team-blocked]")!.textContent).toMatch(/admin role/);
  });
});

describe("plan truth", () => {
  it("shows served billing facts without using them as feature gates", () => {
    render(
      <PlanView
        planName="Growth"
        planId="growth"
        monthlyPrice={99}
        status="active"
        storeName="store.myshopify.com"
        source="shopify"
        managedPricingUrl="https://admin.shopify.com/store/store/settings/billing"
        features={["Reports"]}
      />,
    );
    expect(document.querySelector("[data-plan-gates-nothing]")!.textContent).toMatch(
      /No route or control in this product is gated by it/,
    );
    expect(document.querySelector("[data-plan-name]")!.textContent).toMatch(/Growth.*active/);
    expect(document.querySelector("[data-el='billing-manage']")).toHaveAttribute(
      "href",
      "https://admin.shopify.com/store/store/settings/billing",
    );
    expect(document.querySelectorAll("button").length).toBe(0);
  });
});
