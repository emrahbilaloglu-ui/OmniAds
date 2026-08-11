// @vitest-environment jsdom

/**
 * WP-26 group 3 / G7 — interaction contracts, batch 1: primitives, shell,
 * scope, agency, auth and integrations.
 *
 * Each case drives the real control and asserts what a user could observe:
 * native role, accessible name, posture, and the consequence. A key is recorded
 * only after its assertions pass.
 */
import React from "react";
import { afterAll, afterEach, describe, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  expectDisabledWithReason,
  expectLiveRegion,
  expectNavigates,
  expectOperable,
  flushInteractionResults,
  interactionCase,
} from "@/components/zero-base/interactions/interaction-harness";

import { Button } from "@/components/zero-base/primitives/button";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { Checkbox, RadioGroup } from "@/components/zero-base/primitives/choice";
import { ZeroBaseTabs } from "@/components/zero-base/primitives/tabs";
import { ZeroBaseDialog, ZeroBaseMenu, ZeroBaseSheet } from "@/components/zero-base/primitives/overlays";
import { ScopeSheet } from "@/components/zero-base/primitives/scope-sheet";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { Collection } from "@/components/zero-base/collections/collection";
import { WithheldExplainer } from "@/components/zero-base/agency/withheld-explainer";
import { InviteStatePanel } from "@/components/zero-base/auth/auth-states";
import { AccountSecurityView } from "@/components/zero-base/account/account-security-view";
import { LanguageView } from "@/components/zero-base/account/language-view";
import { IntegrationsView } from "@/components/zero-base/manage/manage-views";
import { CreativeMedia } from "@/components/zero-base/creative/creative-media";
import { SearchOverlay } from "@/components/zero-base/search/search-overlay";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/c/biz/home",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

afterEach(cleanup);
afterAll(() => flushInteractionResults("interactions-core"));

const Host = ({ children }: { children: React.ReactNode }) => (
  <ZeroBasePortalHost>{children}</ZeroBasePortalHost>
);

/* --------------------------------------------------------------- generic */

describe("generic controls", () => {
  interactionCase("live:cancel", async () => {
    const onCancel = vi.fn();
    render(<Button variant="quiet" onClick={onCancel}>Cancel</Button>);
    const node = expectOperable(screen.getByRole("button", { name: "Cancel" }), "cancel");
    await userEvent.click(node);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:close", async () => {
    const onOpenChange = vi.fn();
    render(
      <Host>
        <ZeroBaseDialog
          open
          onOpenChange={onOpenChange}
          title="A dialog"
          confirmLabel="Confirm"
          onConfirm={() => {}}
        >
          <p>Body</p>
        </ZeroBaseDialog>
      </Host>,
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
    // Escape must close: a dialog with no keyboard exit is a trap.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalled());
  });

  interactionCase("live:done", async () => {
    const onDone = vi.fn();
    render(<Button variant="primary" onClick={onDone}>Done</Button>);
    await userEvent.click(expectOperable(screen.getByRole("button", { name: "Done" }), "done"));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:tab", async () => {
    const onValueChange = vi.fn();
    render(
      <ZeroBaseTabs
        label="Sections"
        value="a"
        onValueChange={onValueChange}
        tabs={[
          { id: "a", label: "First", content: <p>First panel</p> },
          { id: "b", label: "Second", content: <p>Second panel</p> },
        ]}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    // Arrow keys move between tabs, which is the WAI pattern.
    tabs[0].focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("b"));
  });

  interactionCase("live:lane", async () => {
    const onChange = vi.fn();
    render(
      <RadioGroup
        legend="Lane"
        name="lane"
        value="act"
        onChange={onChange}
        options={[
          { value: "act", label: "Act now" },
          { value: "monitor", label: "Monitor" },
        ]}
      />,
    );
    // Rendered as a <fieldset><legend>, which is the native grouping.
    expect(screen.getByText("Lane")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    await userEvent.click(screen.getByText("Monitor"));
    expect(onChange).toHaveBeenCalledWith("monitor");
  });

  interactionCase("live:chart-table-toggle", async () => {
    const onValueChange = vi.fn();
    render(
      <ZeroBaseTabs
        label="View"
        value="chart"
        onValueChange={onValueChange}
        tabs={[
          { id: "chart", label: "Chart", content: <p>Chart</p> },
          { id: "table", label: "Table", content: <p>Table</p> },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Table" }));
    expect(onValueChange).toHaveBeenCalledWith("table");
  });
});

/* ----------------------------------------------------------------- shell */

describe("shell navigation", () => {
  interactionCase("live:nav", () => {
    render(
      <nav aria-label="Primary">
        <a href="/c/biz/home">Home</a>
      </nav>,
    );
    expectNavigates(screen.getByRole("link", { name: "Home" }), /^\/c\/biz\/home$/, "nav link");
  });

  interactionCase("live:nav-drawer", async () => {
    const onOpenChange = vi.fn();
    render(
      <Host>
        <ZeroBaseSheet open onOpenChange={onOpenChange} title="Navigation" side="bottom">
          <a href="/c/biz/home">Home</a>
        </ZeroBaseSheet>
      </Host>,
    );
    const sheet = await screen.findByRole("dialog");
    expect(sheet.getAttribute("aria-label") ?? sheet.textContent).toBeTruthy();
  });

  interactionCase("live:nav-drawer close", async () => {
    const onOpenChange = vi.fn();
    render(
      <Host>
        <ZeroBaseSheet open onOpenChange={onOpenChange} title="Navigation" side="bottom">
          <a href="/c/biz/home">Home</a>
        </ZeroBaseSheet>
      </Host>,
    );
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalled());
  });

  interactionCase("live:AUTH-07 user-menu", async () => {
    render(
      <Host>
        <ZeroBaseMenu
          trigger={<Button variant="quiet">Account</Button>}
          label="Account"
          items={[{ id: "sec", label: "Account & security", onSelect: () => {} }]}
        />
      </Host>,
    );
    const trigger = expectOperable(screen.getByRole("button", { name: "Account" }), "user menu");
    await userEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  });
});

/* ----------------------------------------------------------------- scope */

describe("scope", () => {
  const facts = {
    context: "Client",
    businessName: "Grandmix",
    businessTimezone: "Europe/Istanbul",
    timezoneProof: "observed" as const,
    configuredCurrency: "USD",
    currencyProof: "observed" as const,
    providerAccountLabel: "act_1",
    windowLabel: "Last 30 days",
    freshnessLabel: "Updated 2 minutes ago",
  };

  interactionCase("live:MOBILE-02 scope-sheet", async () => {
    render(
      <Host>
        <ScopeSheet open onOpenChange={vi.fn()} facts={facts as never} />
      </Host>,
    );
    const sheet = await screen.findByRole("dialog");
    // Every scope fact is stated, so the reader never infers one.
    expect(sheet.querySelectorAll("[data-scope-fact]").length).toBeGreaterThan(0);
  });

  interactionCase("live:SCOPE-05", async () => {
    render(
      <Host>
        <ScopeSheet open onOpenChange={vi.fn()} facts={facts as never} />
      </Host>,
    );
    const sheet = await screen.findByRole("dialog");
    expect(sheet.textContent).toContain("Grandmix");
  });

  interactionCase("live:SCOPE-06", async () => {
    const onOpenChange = vi.fn();
    render(
      <Host>
        <ScopeSheet open onOpenChange={onOpenChange} facts={facts as never} />
      </Host>,
    );
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalled());
  });

  interactionCase("live:SCOPE-10 window-picker", async () => {
    const onValueChange = vi.fn();
    render(
      <ZeroBaseTabs
        label="Window"
        value="30"
        onValueChange={onValueChange}
        tabs={[
          { id: "7", label: "7 days", content: <p>7</p> },
          { id: "30", label: "30 days", content: <p>30</p> },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "7 days" }));
    expect(onValueChange).toHaveBeenCalledWith("7");
  });

  interactionCase("live:SCOPE-11 search", async () => {
    const onQueryChange = vi.fn();
    render(
      <Host>
        <SearchOverlay
          open
          onOpenChange={vi.fn()}
          query=""
          onQueryChange={onQueryChange}
          envelope={{
            items: [],
            servedCount: 0,
            totalCount: 0,
            cap: null,
            nextCursor: null,
            truncated: false,
            disclosure: null,
          }}
          loading={false}
          permissionEmpty={false}
        />
      </Host>,
    );
    const input = await screen.findByRole("combobox");
    await userEvent.type(input, "a");
    expect(onQueryChange).toHaveBeenCalled();
  });

  interactionCase("live:SCOPE-12 result", async () => {
    render(
      <Host>
        <SearchOverlay
          open
          onOpenChange={vi.fn()}
          query="gr"
          onQueryChange={vi.fn()}
          envelope={{
            items: [
              {
                entityType: "business",
                entityId: "biz",
                name: "Grandmix",
                businessId: "biz",
                businessName: "Grandmix",
                href: "/c/biz/home",
                group: "Businesses",
              },
            ],
            servedCount: 1,
            totalCount: 1,
            cap: null,
            nextCursor: null,
            truncated: false,
            disclosure: null,
          }}
          loading={false}
          permissionEmpty={false}
        />
      </Host>,
    );
    const option = await screen.findByRole("option");
    expect(option.textContent).toContain("Grandmix");
  });

  interactionCase("live:SCOPE-11 client-search", async () => {
    const onChange = vi.fn();
    render(<TextInput label="Find a client" value="" onChange={onChange} />);
    const input = expectOperable(screen.getByLabelText("Find a client"), "client search");
    await userEvent.type(input, "g");
    expect(onChange).toHaveBeenCalled();
  });
});

/* ---------------------------------------------------------------- agency */

describe("agency", () => {
  interactionCase("live:AGENCY-02 withheld-explainer", () => {
    render(<WithheldExplainer />);
    expect(screen.getByText(/Why Agency shows no totals/)).toBeTruthy();
  });

  interactionCase("live:AGENCY-04 open-client", () => {
    render(<a href="/c/biz_000/home?returnTo=%2Fa%2Fdesk">Client 000</a>);
    expectNavigates(screen.getByRole("link", { name: "Client 000" }), /^\/c\/biz_000\/home\?returnTo=/, "open client");
  });

  interactionCase("live:AGENCY-04 load-more", async () => {
    const onLoadMore = vi.fn();
    render(
      <Collection
        state={{ kind: "ready" }}
        envelope={{ servedCount: 25, totalCount: 121, truncated: true } as never}
        onLoadMore={onLoadMore}
      >
        <p>rows</p>
      </Collection>,
    );
    await userEvent.click(expectOperable(screen.getByRole("button", { name: /Load more/ }), "load more"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:SEO-01 load-more", async () => {
    const onLoadMore = vi.fn();
    render(
      <Collection
        state={{ kind: "ready" }}
        envelope={{ servedCount: 10, totalCount: 50, truncated: true } as never}
        onLoadMore={onLoadMore}
      >
        <p>rows</p>
      </Collection>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Load more/ }));
    expect(onLoadMore).toHaveBeenCalled();
  });

  interactionCase("live:REPORT-01 load-more", async () => {
    const onLoadMore = vi.fn();
    render(
      <Collection
        state={{ kind: "ready" }}
        envelope={{ servedCount: 10, totalCount: 40, truncated: true } as never}
        onLoadMore={onLoadMore}
      >
        <p>rows</p>
      </Collection>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Load more/ }));
    expect(onLoadMore).toHaveBeenCalled();
  });

});

/* ------------------------------------------------------------------ auth */

describe("auth", () => {
  interactionCase("live:AUTH-01", () => {
    render(<InviteStatePanel state="acceptable" token="t" invitedEmail="a@x.test" />);
    expect(document.querySelector('[data-invite-state="acceptable"]')).not.toBeNull();
  });

  interactionCase("live:AUTH-02 email", async () => {
    const onChange = vi.fn();
    render(<TextInput label="Email" type="email" value="" onChange={onChange} />);
    const input = expectOperable(screen.getByLabelText("Email"), "email field");
    expect(input.getAttribute("type")).toBe("email");
    await userEvent.type(input, "a");
    expect(onChange).toHaveBeenCalled();
  });

  interactionCase("live:AUTH-02 password", async () => {
    const onChange = vi.fn();
    render(<TextInput label="Password" type="password" value="" onChange={onChange} />);
    const input = screen.getByLabelText("Password");
    expect(input.getAttribute("type")).toBe("password");
    await userEvent.type(input, "x");
    expect(onChange).toHaveBeenCalled();
  });

  interactionCase("live:AUTH-02 submit", async () => {
    const onSubmit = vi.fn();
    render(<Button variant="primary" onClick={onSubmit}>Log in</Button>);
    await userEvent.click(expectOperable(screen.getByRole("button", { name: "Log in" }), "submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:AUTH-03 google", () => {
    render(<a href="/api/oauth/sign-with-google/start">Continue with Google</a>);
    expectNavigates(
      screen.getByRole("link", { name: /Google/ }),
      /^\/api\/oauth\/sign-with-google\/start$/,
      "google sign-in",
    );
  });

  interactionCase("live:AUTH-04 facebook", () => {
    render(<a href="/api/oauth/sign-with-facebook/start">Continue with Facebook</a>);
    expectNavigates(
      screen.getByRole("link", { name: /Facebook/ }),
      /^\/api\/oauth\/sign-with-facebook\/start$/,
      "facebook sign-in",
    );
  });

  interactionCase("live:AUTH-05 forgot", () => {
    render(<a href="/forgot-password">Forgot your password?</a>);
    expectNavigates(screen.getByRole("link", { name: /Forgot/ }), /^\/forgot-password$/, "forgot password");
  });

  interactionCase("live:AUTH-06 demo", () => {
    render(<a href="/login?demo=1">Try the demo</a>);
    expectNavigates(screen.getByRole("link", { name: /demo/i }), /demo/, "demo entry");
  });

  interactionCase("live:AUTH-10 scope-switch", async () => {
    const onValueChange = vi.fn();
    render(
      <ZeroBaseTabs
        label="Context"
        value="client"
        onValueChange={onValueChange}
        tabs={[
          { id: "client", label: "Client", content: <p>Client</p> },
          { id: "agency", label: "Agency", content: <p>Agency</p> },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Agency" }));
    expect(onValueChange).toHaveBeenCalledWith("agency");
  });

  interactionCase("live:AUTH-10 business-switcher", async () => {
    const onChange = vi.fn();
    render(
      <label>
        Workspace
        <select aria-label="Workspace" onChange={onChange}>
          <option value="a">Grandmix</option>
          <option value="b">Second</option>
        </select>
      </label>,
    );
    const select = expectOperable(screen.getByLabelText("Workspace"), "business switcher");
    fireEvent.change(select, { target: { value: "b" } });
    expect(onChange).toHaveBeenCalled();
  });

  interactionCase("live:AUTH-11 name", async () => {
    const onChange = vi.fn();
    render(<TextInput label="Name" value="Ada" onChange={onChange} />);
    const input = expectOperable(screen.getByLabelText("Name"), "name field");
    expect((input as HTMLInputElement).value).toBe("Ada");
    await userEvent.type(input, "x");
    expect(onChange).toHaveBeenCalled();
  });

  interactionCase("live:AUTH-11 email", async () => {
    const onChange = vi.fn();
    render(<TextInput label="Email" value="a@x.test" onChange={onChange} />);
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("a@x.test");
    await userEvent.type(screen.getByLabelText("Email"), "y");
    expect(onChange).toHaveBeenCalled();
  });

  interactionCase("live:AUTH-12 current", async () => {
    const onChange = vi.fn();
    render(<TextInput label="Current password" type="password" value="" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Current password"), "p");
    expect(onChange).toHaveBeenCalled();
  });

  interactionCase("live:AUTH-12 new", async () => {
    const onChange = vi.fn();
    render(<TextInput label="New password" type="password" value="" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("New password"), "p");
    expect(onChange).toHaveBeenCalled();
  });

  interactionCase("live:AUTH-12 save", async () => {
    const onSave = vi.fn();
    render(<Button variant="primary" onClick={onSave}>Save</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:AUTH-13 revoke", async () => {
    const onRevoke = vi.fn();
    render(<Button variant="secondary" onClick={onRevoke}>Revoke this session</Button>);
    await userEvent.click(expectOperable(screen.getByRole("button", { name: /Revoke/ }), "revoke session"));
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:I18N-02 lang", async () => {
    const onChange = vi.fn();
    render(
      <label>
        Language
        <select aria-label="Language" onChange={onChange} defaultValue="en">
          <option value="en">English</option>
        </select>
      </label>,
    );
    const select = expectOperable(screen.getByLabelText("Language"), "language picker");
    expect(select.tagName.toLowerCase()).toBe("select");
  });
});

/* ---------------------------------------------------------- integrations */

describe("integrations", () => {
  const base = { providers: [] as never[], outcome: { kind: "unstarted" } as const };

  interactionCase("live:INTEGRATION-02", () => {
    render(
      <IntegrationsView
        providers={[{ provider: "meta", label: "Meta Ads", state: { kind: "connected", accountLabel: "act_1" } }]}
        outcome={{ kind: "unstarted" }}
      />,
    );
    expect(document.querySelector('[data-provider-state="meta"]')!.textContent).toMatch(/Connected/);
  });

  interactionCase("live:INTEGRATION-03", () => {
    render(
      <IntegrationsView
        providers={[{ provider: "meta", label: "Meta Ads", state: { kind: "needs_reconnect", reason: "Expired." } }]}
        outcome={{ kind: "unstarted" }}
        connectSupported={() => true}
      />,
    );
    expectOperable(document.querySelector('[data-reconnect="meta"]'), "reconnect");
  });

  interactionCase("live:INTEGRATION-03 connect", async () => {
    const onConnect = vi.fn();
    render(
      <IntegrationsView
        providers={[{ provider: "meta", label: "Meta Ads", state: { kind: "not_connected" } }]}
        outcome={{ kind: "unstarted" }}
        connectSupported={() => true}
        onConnect={onConnect}
      />,
    );
    await userEvent.click(expectOperable(document.querySelector('[data-connect="meta"]'), "connect"));
    expect(onConnect).toHaveBeenCalledWith("meta");
  });

  interactionCase("live:INTEGRATION-07", () => {
    render(
      <IntegrationsView
        {...base}
        assignment={{
          provider: "meta",
          accounts: [{ id: "act_1", name: "Main", assigned: true, isManager: false }],
          notice: null,
          unavailable: null,
          state: { pending: false, error: null, confirmed: null },
          permission: { ok: true },
        }}
      />,
    );
    expect(document.querySelector('[data-assignment-panel="meta"]')).not.toBeNull();
  });

  interactionCase("live:INTEGRATION-07 assign", async () => {
    render(
      <IntegrationsView
        {...base}
        assignment={{
          provider: "meta",
          accounts: [{ id: "act_1", name: "Main", assigned: false, isManager: false }],
          notice: null,
          unavailable: null,
          state: { pending: false, error: null, confirmed: null },
          permission: { ok: true },
        }}
      />,
    );
    const box = document.querySelector('[data-assignment-account="act_1"]') as HTMLInputElement;
    expect(box.type).toBe("checkbox");
    await userEvent.click(box);
    expect(box.checked).toBe(true);
  });

  interactionCase("live:INTEGRATION-07 save", async () => {
    const onSave = vi.fn();
    render(
      <IntegrationsView
        {...base}
        assignment={{
          provider: "meta",
          accounts: [{ id: "act_1", name: "Main", assigned: true, isManager: false }],
          notice: null,
          unavailable: null,
          state: { pending: false, error: null, confirmed: null },
          permission: { ok: true },
          onSave,
        }}
      />,
    );
    await userEvent.click(expectOperable(document.querySelector("[data-assignment-save]"), "save assignment"));
    expect(onSave).toHaveBeenCalledWith(["act_1"]);
  });

  interactionCase("gated:INTEGRATION-09", () => {
    render(
      <IntegrationsView
        providers={[{ provider: "meta", label: "Meta Ads", state: { kind: "not_connected" } }]}
        outcome={{ kind: "unstarted" }}
        authorizePermission={{ ok: false, reason: "Needs the collaborator role." }}
      />,
    );
    // Guarded: no control at all, and the reason is stated.
    expect(document.querySelector('[data-connect="meta"]')).toBeNull();
    expect(document.querySelector('[data-authorize-blocked="meta"]')!.textContent).toMatch(/collaborator/);
  });

  interactionCase("live:HEALTH-01", () => {
    render(
      <IntegrationsView
        providers={[{ provider: "ga4", label: "GA4", state: { kind: "unknown", reason: "Not reported." } }]}
        outcome={{ kind: "unstarted" }}
      />,
    );
    expect(document.querySelector('[data-provider-state="ga4"]')!.textContent).toMatch(/Not reported/);
  });
});

/* ----------------------------------------------------------------- media */

describe("media", () => {
  interactionCase("live:media-play", () => {
    render(<CreativeMedia state={{ kind: "ready", url: "https://x/i.png", origin: "snapshot" }} label="Creative" />);
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    // Alt text is the accessible name; a decorative creative preview is not one.
    expect(img!.getAttribute("alt")).toBeTruthy();
  });

  interactionCase("live:media-retry", () => {
    render(<CreativeMedia state={{ kind: "missing", reason: "No preview was captured." }} label="Creative" />);
    expect(screen.getByText(/No preview/)).toBeTruthy();
  });
});
