// @vitest-environment jsdom

/**
 * WP-23 mounted Manage flows.
 *
 * Every write here must show progress, surface its own error, and confirm only
 * after an independent re-read of the collection it touched — a 200 is what the
 * server said, not what the collection now contains.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";

/**
 * These flows are two round trips deep — a write, then an independent re-read —
 * behind stubbed promises. Under a parallel batch the default 1s `waitFor`
 * budget occasionally expired before the second setState landed, which showed up
 * as an intermittent failure in an otherwise deterministic test. The product
 * path is unchanged; the harness just needed a budget that matches the number of
 * awaits it is actually waiting on.
 */
configure({ asyncUtilTimeout: 5000 });

import {
  BusinessClient,
  IntegrationsClient,
  TeamClient,
} from "@/components/zero-base/manage/manage-clients";
import { IntegrationsView } from "@/components/zero-base/manage/manage-views";
import { oauthStartUrl } from "@/lib/zero-base/manage/manage-contract";
import { sanitizeNextPath } from "@/lib/auth-routing";

const BIZ = "55555555-5555-4555-8555-555555555555";

interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[] = [];

type Responder = (call: Call, index: number) => { ok?: boolean; body: unknown } | null;

function stub(responder: Responder) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: (init?.method ?? "GET").toUpperCase(),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(call);
      const result = responder(call, calls.length - 1) ?? { body: {} };
      return {
        ok: result.ok ?? true,
        status: result.ok === false ? 403 : 200,
        json: async () => result.body,
      } as Response;
    }),
  );
}

/** React tracks a controlled input's value; a raw assignment is ignored. */
/**
 * Type into a controlled input.
 *
 * Through `fireEvent`, not a hand-dispatched event: a raw `dispatchEvent` runs
 * outside React's `act`, so the state update it triggers may not have flushed
 * before the next line reads it. That made these tests intermittently save
 * stale values — a flake whose cause was in the helper, not in the product.
 */
function type(selector: string, value: string) {
  const input = document.querySelector(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  fireEvent.input(input, { target: { value } });
}

/** Click through fireEvent for the same reason. */
function click(selector: string) {
  fireEvent.click(document.querySelector(selector) as HTMLElement);
}

const MEMBER = {
  membership_id: "m1",
  user_id: "u1",
  role: "collaborator",
  status: "active",
  name: "Ada",
  email: "ada@x.test",
};

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WP-23 team members", () => {
  it("REGRESSION: renders rows keyed by membership_id", async () => {
    stub((call) => {
      if (call.url.startsWith("/api/team/members")) return { body: { members: [MEMBER] } };
      if (call.url.startsWith("/api/team/invites")) return { body: { invites: [] } };
      if (call.url.startsWith("/api/team/access-requests")) return { body: { requests: [] } };
      return { body: { workspaces: [] } };
    });
    render(<TeamClient businessId={BIZ} role="admin" />);
    await waitFor(() => {
      expect(document.querySelector('[data-member-role="m1"]')).not.toBeNull();
    });
  });

  it("a role change re-reads and confirms only what the re-read shows", async () => {
    let role = "collaborator";
    stub((call) => {
      if (call.url.startsWith("/api/team/members") && call.method === "PATCH") {
        role = (call.body as { role: string }).role;
        return { body: { status: "ok" } };
      }
      if (call.url.startsWith("/api/team/members")) return { body: { members: [{ ...MEMBER, role }] } };
      if (call.url.startsWith("/api/team/invites")) return { body: { invites: [] } };
      if (call.url.startsWith("/api/team/access-requests")) return { body: { requests: [] } };
      return { body: { workspaces: [] } };
    });
    render(<TeamClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-member-role="m1"]')).not.toBeNull());

    const select = document.querySelector('[data-member-role="m1"]') as HTMLSelectElement;
    select.value = "admin";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      expect(document.querySelector("[data-team-progress]")!.textContent).toMatch(/confirmed by a fresh read/);
    });
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.body).toEqual({ businessId: BIZ, membershipId: "m1", role: "admin" });
  });

  it("REGRESSION: refuses to claim success when the re-read disagrees", async () => {
    stub((call) => {
      if (call.method === "PATCH") return { body: { status: "ok" } };
      // The re-read still shows the old role.
      if (call.url.startsWith("/api/team/members")) return { body: { members: [MEMBER] } };
      if (call.url.startsWith("/api/team/invites")) return { body: { invites: [] } };
      if (call.url.startsWith("/api/team/access-requests")) return { body: { requests: [] } };
      return { body: { workspaces: [] } };
    });
    render(<TeamClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-member-role="m1"]')).not.toBeNull());
    const select = document.querySelector('[data-member-role="m1"]') as HTMLSelectElement;
    select.value = "admin";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      expect(document.querySelector("[data-team-error]")!.textContent).toMatch(/does not show it/);
    });
  });

  it("surfaces the handler's own refusal", async () => {
    stub((call) => {
      if (call.method === "DELETE") return { ok: false, body: { message: "Only an admin can remove a member." } };
      if (call.url.startsWith("/api/team/members")) return { body: { members: [MEMBER] } };
      if (call.url.startsWith("/api/team/invites")) return { body: { invites: [] } };
      if (call.url.startsWith("/api/team/access-requests")) return { body: { requests: [] } };
      return { body: { workspaces: [] } };
    });
    render(<TeamClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-member-remove="m1"]')).not.toBeNull());
    (document.querySelector('[data-member-remove="m1"]') as HTMLElement).click();
    await waitFor(() => {
      expect(document.querySelector("[data-team-error]")!.textContent).toMatch(/Only an admin/);
    });
  });

  it("a reviewer sees read-only roles and no write controls", async () => {
    stub((call) => {
      if (call.url.startsWith("/api/team/members")) return { body: { members: [MEMBER] } };
      if (call.url.startsWith("/api/team/invites")) return { body: { invites: [] } };
      return { body: { workspaces: [] } };
    });
    render(<TeamClient businessId={BIZ} role="reviewer" />);
    await waitFor(() => expect(document.querySelector('[data-member-role-readonly="m1"]')).not.toBeNull());
    expect(document.querySelector('[data-member-role="m1"]')).toBeNull();
    expect(document.querySelector('[data-member-remove="m1"]')).toBeNull();
    expect(document.querySelector("[data-invite-send]")).toBeNull();
    expect(document.querySelector("[data-access-blocked]")).not.toBeNull();
    // A reviewer must not even ask for access requests.
    expect(calls.some((call) => call.url.startsWith("/api/team/access-requests"))).toBe(false);
  });

  it("a guest sees the same refusals", async () => {
    stub((call) => {
      if (call.url.startsWith("/api/team/members")) return { body: { members: [MEMBER] } };
      if (call.url.startsWith("/api/team/invites")) return { body: { invites: [] } };
      return { body: { workspaces: [] } };
    });
    render(<TeamClient businessId={BIZ} role="guest" />);
    await waitFor(() => expect(document.querySelector("[data-team-blocked]")).not.toBeNull());
    expect(document.querySelector("[data-invite-blocked]")).not.toBeNull();
  });

  it("an invite with no addresses is refused without a request", async () => {
    stub((call) => {
      if (call.url.startsWith("/api/team/members")) return { body: { members: [MEMBER] } };
      if (call.url.startsWith("/api/team/invites")) return { body: { invites: [] } };
      if (call.url.startsWith("/api/team/access-requests")) return { body: { requests: [] } };
      return { body: { workspaces: [] } };
    });
    render(<TeamClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector("[data-invite-send]")).not.toBeNull());
    click("[data-invite-send]");
    await waitFor(() => {
      expect(document.querySelector("[data-team-error]")!.textContent).toMatch(/at least one email/i);
    });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("approving an access request re-reads the queue", async () => {
    let pending = [{ membership_id: "m9", name: "Bo", role: "guest" }];
    stub((call) => {
      if (call.url.startsWith("/api/team/access-requests") && call.method === "POST") {
        pending = [];
        return { body: { status: "ok" } };
      }
      if (call.url.startsWith("/api/team/access-requests")) return { body: { requests: pending } };
      if (call.url.startsWith("/api/team/members")) return { body: { members: [MEMBER] } };
      if (call.url.startsWith("/api/team/invites")) return { body: { invites: [] } };
      return { body: { workspaces: [] } };
    });
    render(<TeamClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-access-approve="m9"]')).not.toBeNull());
    (document.querySelector('[data-access-approve="m9"]') as HTMLElement).click();
    await waitFor(() => {
      expect(document.querySelector("[data-team-progress]")!.textContent).toMatch(/Access approved/);
    });
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.body).toEqual({ businessId: BIZ, membershipId: "m9", action: "approve" });
  });
});

describe("WP-23 business settings", () => {
  function stubBusiness(current: { name: string; currency: string }, patched?: { name: string; currency: string }) {
    let state = current;
    stub((call) => {
      if (call.method === "PATCH") {
        if (patched) state = patched;
        return { body: { business: state } };
      }
      if (call.url === "/api/businesses") return { body: { businesses: [{ id: BIZ, ...state }] } };
      if (call.url.includes("business-cost-model")) return { body: { costModel: {} } };
      if (call.url.includes("business-commercial-settings")) {
        return { body: { snapshot: {}, revision: 1, permissions: { canEdit: false, reason: "", role: "admin" } } };
      }
      if (call.url.includes("business-operating-mode")) return { body: { recommendedMode: "profit_first" } };
      return { body: {} };
    });
  }

  it("REGRESSION: shows the stored name and currency", async () => {
    stubBusiness({ name: "Grandmix", currency: "TRY" });
    render(<BusinessClient businessId={BIZ} role="admin" />);
    await waitFor(() => {
      expect((document.querySelector("[data-business-name]") as HTMLInputElement)?.value).toBe("Grandmix");
    });
    expect((document.querySelector("[data-business-currency]") as HTMLInputElement).value).toBe("TRY");
  });

  it("saves both fields together and confirms by re-read", async () => {
    stubBusiness({ name: "Grandmix", currency: "TRY" }, { name: "Grandmix EU", currency: "EUR" });
    render(<BusinessClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector("[data-business-name]")).not.toBeNull());

    type("[data-business-name]", "Grandmix EU");
    type("[data-business-currency]", "EUR");

    click("[data-settings-save]");
    await waitFor(() => {
      expect(document.querySelector("[data-settings-progress]")!.textContent).toMatch(/confirmed by a fresh read/);
    });
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.body).toEqual({ name: "Grandmix EU", currency: "EUR" });
  });

  it("refuses a too-short name without a request, as the route would", async () => {
    stubBusiness({ name: "Grandmix", currency: "TRY" });
    render(<BusinessClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector("[data-business-name]")).not.toBeNull());
    type("[data-business-name]", "A");
    click("[data-settings-save]");
    await waitFor(() => {
      expect(document.querySelector("[data-settings-error]")!.textContent).toMatch(/two characters/);
    });
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("a non-admin sees the values read-only with the reason", async () => {
    stubBusiness({ name: "Grandmix", currency: "TRY" });
    render(<BusinessClient businessId={BIZ} role="reviewer" />);
    await waitFor(() => expect(document.querySelector("[data-settings-readonly]")).not.toBeNull());
    expect(document.querySelector("[data-settings-blocked]")!.textContent).toMatch(/admin role/);
    expect(document.querySelector("[data-settings-save]")).toBeNull();
  });
});

describe("WP-23 account assignment", () => {
  function stubAssignment(options: { saveOk?: boolean; landsAs?: string[] } = {}) {
    let assigned = ["act_1"];
    stub((call) => {
      if (call.url.includes("assign-accounts")) {
        if (options.saveOk === false) return { ok: false, body: { message: "That lane is busy." } };
        assigned = options.landsAs ?? (call.body as { account_ids: string[] }).account_ids;
        return { body: { success: true, assigned_accounts: assigned } };
      }
      if (call.url.includes("ad-accounts") || call.url.includes("accessible-accounts")) {
        return {
          body: {
            data: [
              { id: "act_1", name: "Main", assigned: assigned.includes("act_1") },
              { id: "act_2", name: "Second", assigned: assigned.includes("act_2") },
            ],
            notice: null,
          },
        };
      }
      return { body: { integrations: [] } };
    });
  }

  it("seeds the selection from the served assigned flags", async () => {
    stubAssignment();
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => {
      expect(document.querySelector('[data-assignment-account="act_1"]')).not.toBeNull();
    });
    expect((document.querySelector('[data-assignment-account="act_1"]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('[data-assignment-account="act_2"]') as HTMLInputElement).checked).toBe(false);
  });

  it("sends account_ids and confirms after the re-read", async () => {
    stubAssignment();
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-assignment-account="act_2"]')).not.toBeNull());
    (document.querySelector('[data-assignment-account="act_2"]') as HTMLElement).click();
    click("[data-assignment-save]");

    await waitFor(() => {
      expect(document.querySelector("[data-assignment-progress]")!.textContent).toMatch(/confirmed by a fresh read/);
    });
    const save = calls.find((call) => call.url.includes("assign-accounts"))!;
    expect(save.body).toEqual({ account_ids: ["act_1", "act_2"] });
  });

  it("REGRESSION: does not claim success when the re-read disagrees", async () => {
    // The save reports ok but nothing actually changed.
    stubAssignment({ landsAs: ["act_1"] });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-assignment-account="act_2"]')).not.toBeNull());
    (document.querySelector('[data-assignment-account="act_2"]') as HTMLElement).click();
    click("[data-assignment-save]");
    await waitFor(() => {
      expect(document.querySelector("[data-assignment-error]")!.textContent).toMatch(/does not show it/);
    });
  });

  it("surfaces a lane refusal rather than a success", async () => {
    stubAssignment({ saveOk: false });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector("[data-assignment-save]")).not.toBeNull());
    click("[data-assignment-save]");
    await waitFor(() => {
      expect(document.querySelector("[data-assignment-error]")!.textContent).toMatch(/lane is busy/);
    });
  });

  it("withholds assignment from a reviewer, with the reason", async () => {
    stubAssignment();
    render(<IntegrationsClient businessId={BIZ} role="reviewer" />);
    await waitFor(() => expect(document.querySelector("[data-assignment-blocked]")).not.toBeNull());
    expect(document.querySelector("[data-assignment-save]")).toBeNull();
  });

  it("refuses an unreadable discovery response rather than showing no accounts", async () => {
    stub((call) => {
      if (call.url.includes("ad-accounts")) return { body: { accounts: [] } };
      return { body: { integrations: [] } };
    });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => {
      expect(document.querySelector("[data-assignment-unavailable]")).not.toBeNull();
    });
    expect(document.querySelector("[data-assignment-accounts]")).toBeNull();
  });
});

describe("WP-23 Flow H — first-time connection is reachable", () => {
  /** `/api/integrations/status` answers a flat provider→boolean map. */
  function stubStatus(status: Record<string, boolean>) {
    stub((call) => {
      if (call.url.startsWith("/api/integrations/status")) return { body: status };
      if (call.url.includes("ad-accounts") || call.url.includes("accessible-accounts")) {
        return { body: { data: [], notice: null } };
      }
      return { body: {} };
    });
  }

  const ALL_OFF = {
    meta: false,
    google: false,
    shopify: false,
    ga4: false,
    search_console: false,
  };

  it("REGRESSION: a never-connected provider offers Connect, not a dash", async () => {
    stubStatus(ALL_OFF);
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => {
      expect(document.querySelector('[data-connect="meta"]')).not.toBeNull();
    });
    // Shopify is deliberately excluded: its start route cannot begin a round
    // trip without a shop, so it gets its own entry rather than a Connect.
    for (const provider of ["meta", "google", "ga4", "search_console"]) {
      expect(document.querySelector(`[data-connect="${provider}"]`), provider).not.toBeNull();
    }
    expect(document.querySelector('[data-connect="shopify"]')).toBeNull();
    expect(document.querySelector("[data-shopify-action]")).not.toBeNull();
  });

  it("Connect starts the real OAuth route with the sanitized returnTo", async () => {
    stubStatus(ALL_OFF);
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign, search: "" },
      writable: true,
      configurable: true,
    });

    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-connect="ga4"]')).not.toBeNull());
    (document.querySelector('[data-connect="ga4"]') as HTMLElement).click();

    expect(assign).toHaveBeenCalledTimes(1);
    const url = new URL(assign.mock.calls[0][0] as string, "https://example.test");
    // The real start route on disk, not an invented one.
    expect(url.pathname).toBe("/api/oauth/google-analytics/start");
    expect(url.searchParams.get("businessId")).toBe(BIZ);
    expect(sanitizeNextPath(url.searchParams.get("returnTo"))).toBe(url.searchParams.get("returnTo"));
  });

  it("every supported provider's Connect targets its own start route", async () => {
    stubStatus(ALL_OFF);
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign, search: "" },
      writable: true,
      configurable: true,
    });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-connect="meta"]')).not.toBeNull());

    const expected: Record<string, string> = {
      meta: "/api/oauth/meta/start",
      google: "/api/oauth/google/start",
      ga4: "/api/oauth/google-analytics/start",
      search_console: "/api/oauth/search_console/start",
    };
    for (const [provider, path] of Object.entries(expected)) {
      assign.mockClear();
      (document.querySelector(`[data-connect="${provider}"]`) as HTMLElement).click();
      const url = new URL(assign.mock.calls[0][0] as string, "https://example.test");
      expect(url.pathname, provider).toBe(path);
    }
  });

  it("reconnect still appears, and only for a connection that needs it", async () => {
    stub((call) => {
      if (call.url.startsWith("/api/integrations/status")) {
        return {
          body: {
            ...ALL_OFF,
            meta: { status: "expired", message: "Meta needs re-authorization." },
            google: { status: "connected", accountName: "Grandmix" },
          },
        };
      }
      if (call.url.includes("ad-accounts") || call.url.includes("accessible-accounts")) {
        return { body: { data: [], notice: null } };
      }
      return { body: {} };
    });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-reconnect="meta"]')).not.toBeNull());
    // Connected providers offer neither control.
    expect(document.querySelector('[data-connect="google"]')).toBeNull();
    expect(document.querySelector('[data-reconnect="google"]')).toBeNull();
    // A not_connected provider still offers Connect alongside.
    expect(document.querySelector('[data-connect="ga4"]')).not.toBeNull();
  });

  it("a provider with no real start route stays unavailable and non-clickable", () => {
    render(
      <IntegrationsView
        providers={[
          { provider: "klaviyo" as never, label: "Klaviyo", state: { kind: "not_connected" } },
        ]}
        outcome={{ kind: "unstarted" }}
        connectSupported={(provider) => oauthStartUrl({ provider, businessId: BIZ }) !== null}
      />,
    );
    expect(document.querySelector('[data-connect="klaviyo"]')).toBeNull();
    expect(document.querySelector('[data-connect-unavailable="klaviyo"]')!.textContent).toMatch(
      /cannot be connected here/,
    );
  });
});

describe("WP-23 GA4 property and Search Console site selection", () => {
  const PROPERTY = {
    propertyId: "properties/12345",
    propertyName: "Grandmix GA4",
    accountId: "accounts/9",
    accountName: "Grandmix",
  };
  const OTHER = {
    propertyId: "properties/67890",
    propertyName: "Second GA4",
    accountId: "accounts/9",
    accountName: "Grandmix",
  };

  function stubSelection(options: {
    ga4Selected?: string | null;
    ga4ListOk?: boolean;
    ga4SaveOk?: boolean;
    /** What the GA4 re-read reports after a save. */
    ga4LandsAs?: string | null;
    scSelected?: string | null;
    scListOk?: boolean;
    scSaveOk?: boolean;
    scSaveMessage?: string;
    scLandsAs?: string | null;
  } = {}) {
    let ga4 = options.ga4Selected ?? null;
    let sc = options.scSelected ?? null;
    stub((call) => {
      if (call.url.startsWith("/api/google-analytics/select-property")) {
        if (options.ga4SaveOk === false) return { ok: false, body: { message: "GA4 refused that property." } };
        ga4 = options.ga4LandsAs !== undefined ? options.ga4LandsAs : (call.body as { propertyId: string }).propertyId;
        return { body: { success: true } };
      }
      if (call.url.startsWith("/api/google-analytics/properties")) {
        if (options.ga4ListOk === false) return { ok: false, body: { message: "GA4 discovery failed." } };
        return { body: { data: [PROPERTY, OTHER], selectedPropertyId: ga4 } };
      }
      if (call.url.startsWith("/api/google-search-console/select-site")) {
        if (options.scSaveOk === false) {
          return { ok: false, body: { message: options.scSaveMessage ?? "Search Console refused that site." } };
        }
        sc = options.scLandsAs !== undefined ? options.scLandsAs : (call.body as { siteUrl: string }).siteUrl;
        return { body: { success: true, integration: { provider_account_id: sc } } };
      }
      if (call.url.startsWith("/api/google-search-console/sites")) {
        if (options.scListOk === false) return { ok: false, body: { message: "Search Console discovery failed." } };
        return {
          body: {
            sites: [
              { siteUrl: "https://grandmix.example/", permissionLevel: "siteOwner", siteType: "url-prefix" },
              { siteUrl: "sc-domain:grandmix.example", permissionLevel: "siteOwner", siteType: "domain" },
            ],
          },
        };
      }
      if (call.url.includes("provider=search_console")) {
        return { body: { integration: sc ? { provider_account_id: sc } : null } };
      }
      if (call.url.includes("ad-accounts") || call.url.includes("accessible-accounts")) {
        return { body: { data: [], notice: null } };
      }
      return { body: {} };
    });
  }

  /**
   * Choose an option, then save.
   *
   * `fireEvent.change` is what React's synthetic onChange listens for, and the
   * wait is on the *option* React re-rendered as selected — not on the DOM
   * value the test just assigned. Waiting on the assigned value proved nothing
   * about React state, so under load the save could fire with a stale draft and
   * the assertion would fail intermittently.
   */
  async function save(kind: string, value: string) {
    const select = document.querySelector(`[data-selection-options="${kind}"]`) as HTMLSelectElement;
    // The options arrive from the discovery fetch, so wait for the one being
    // chosen to exist before choosing it. Firing change against an option the
    // select does not yet carry is a no-op that leaves the draft empty.
    await waitFor(() => {
      expect(
        select.querySelector(`option[value="${value}"]`),
        `${kind}: ${value} was never offered`,
      ).not.toBeNull();
    });
    fireEvent.change(select, { target: { value } });
    await waitFor(() => {
      const chosen = select.querySelector(`option[value="${value}"]`) as HTMLOptionElement | null;
      expect(chosen?.selected, `${kind}: React did not adopt ${value}`).toBe(true);
    });
    (document.querySelector(`[data-selection-save="${kind}"]`) as HTMLElement).click();
  }

  it("REGRESSION: GA4 property selection is reachable and shows the stored property", async () => {
    stubSelection({ ga4Selected: "properties/12345" });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => {
      expect(document.querySelector('[data-selection-panel="ga4_property"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-selection-current="ga4_property"]')!.textContent).toContain(
      "properties/12345",
    );
  });

  it("sends the exact select-property body and confirms only after the re-read", async () => {
    stubSelection({ ga4Selected: "properties/12345" });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-selection-options="ga4_property"]')).not.toBeNull());
    await save("ga4_property", "properties/67890");

    await waitFor(() => {
      expect(document.querySelector('[data-selection-progress="ga4_property"]')!.textContent).toMatch(
        /confirmed by a fresh read/,
      );
    });
    const post = calls.find((call) => call.url.includes("select-property"))!;
    expect(post.body).toEqual({
      businessId: BIZ,
      propertyId: "properties/67890",
      propertyName: "Second GA4",
      accountId: "accounts/9",
      accountName: "Grandmix",
    });
    // The visible value came from the re-read, not the write.
    expect(document.querySelector('[data-selection-current="ga4_property"]')!.textContent).toContain(
      "properties/67890",
    );
  });

  it("REGRESSION: a stale or mismatched read-back is not reported as success", async () => {
    // The save reports ok, but the re-read still shows the old property.
    stubSelection({ ga4Selected: "properties/12345", ga4LandsAs: "properties/12345" });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-selection-options="ga4_property"]')).not.toBeNull());
    await save("ga4_property", "properties/67890");
    await waitFor(() => {
      expect(document.querySelector('[data-selection-error="ga4_property"]')!.textContent).toMatch(
        /different property/,
      );
    });
    expect(document.querySelector('[data-selection-progress="ga4_property"]')!.textContent).not.toMatch(
      /confirmed/,
    );
  });

  it("surfaces a failed write without claiming success", async () => {
    stubSelection({ ga4SaveOk: false });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-selection-options="ga4_property"]')).not.toBeNull());
    await save("ga4_property", "properties/67890");
    await waitFor(() => {
      expect(document.querySelector('[data-selection-error="ga4_property"]')!.textContent).toMatch(
        /GA4 refused that property/,
      );
    });
  });

  it("refuses unreadable discovery rather than offering an empty list", async () => {
    stubSelection({ ga4ListOk: false });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => {
      expect(document.querySelector('[data-selection-unavailable="ga4_property"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-selection-options="ga4_property"]')).toBeNull();
  });

  it("withholds selection from a reviewer, with the reason", async () => {
    stubSelection({ ga4Selected: "properties/12345", scSelected: "https://grandmix.example/" });
    render(<IntegrationsClient businessId={BIZ} role="reviewer" />);
    await waitFor(() => {
      expect(document.querySelector('[data-selection-blocked="ga4_property"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-selection-blocked="search_console_site"]')!.textContent).toMatch(
      /collaborator role/,
    );
    expect(document.querySelector('[data-selection-save="ga4_property"]')).toBeNull();
    // A reviewer may still SEE the stored selection; the sites route admits guest.
    expect(document.querySelector('[data-selection-current="ga4_property"]')!.textContent).toContain("12345");
  });

  it("REGRESSION: Search Console selection re-reads the integration, not the write response", async () => {
    stubSelection({ scSelected: "https://grandmix.example/" });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() =>
      expect(document.querySelector('[data-selection-options="search_console_site"]')).not.toBeNull(),
    );
    await save("search_console_site", "sc-domain:grandmix.example");

    await waitFor(() => {
      expect(document.querySelector('[data-selection-progress="search_console_site"]')!.textContent).toMatch(
        /confirmed by a fresh read/,
      );
    });
    const post = calls.find((call) => call.url.includes("select-site"))!;
    expect(post.body).toEqual({ businessId: BIZ, siteUrl: "sc-domain:grandmix.example" });
    // The confirming read went to the integration record.
    expect(calls.some((call) => call.url.includes("provider=search_console"))).toBe(true);
  });

  it("treats a trailing-slash difference as the same site, not a mismatch", async () => {
    stubSelection({ scSelected: null, scLandsAs: "https://grandmix.example/" });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() =>
      expect(document.querySelector('[data-selection-options="search_console_site"]')).not.toBeNull(),
    );
    await save("search_console_site", "https://grandmix.example/");
    await waitFor(() => {
      expect(document.querySelector('[data-selection-progress="search_console_site"]')!.textContent).toMatch(
        /confirmed/,
      );
    });
  });

  it("REGRESSION: reports a 409 connection_changed rather than a success", async () => {
    stubSelection({
      scSaveOk: false,
      scSaveMessage: "The connection changed while this property was being validated. Nothing was saved; try again.",
    });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() =>
      expect(document.querySelector('[data-selection-options="search_console_site"]')).not.toBeNull(),
    );
    await save("search_console_site", "sc-domain:grandmix.example");
    await waitFor(() => {
      expect(document.querySelector('[data-selection-error="search_console_site"]')!.textContent).toMatch(
        /Nothing was saved/,
      );
    });
  });

  it("reassignment from one site to another is confirmed by the re-read", async () => {
    stubSelection({ scSelected: "https://grandmix.example/" });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() =>
      expect(document.querySelector('[data-selection-current="search_console_site"]')!.textContent).toContain(
        "grandmix.example",
      ),
    );
    await save("search_console_site", "sc-domain:grandmix.example");
    await waitFor(() => {
      expect(document.querySelector('[data-selection-current="search_console_site"]')!.textContent).toContain(
        "sc-domain:grandmix.example",
      );
    });
  });
});

describe("WP-23 authorization is gated by the role the start routes require", () => {
  function stubStatusFor(status: Record<string, unknown>) {
    stub((call) => {
      if (call.url.startsWith("/api/integrations/status")) return { body: status };
      if (call.url.includes("provider=shopify")) return { body: { integration: null } };
      if (call.url.includes("ad-accounts") || call.url.includes("accessible-accounts")) {
        return { body: { data: [], notice: null } };
      }
      return { body: {} };
    });
  }

  const OFF = { meta: false, google: false, shopify: false, ga4: false, search_console: false };
  const EXPIRED = { ...OFF, meta: { status: "expired", message: "Meta needs re-authorization." } };

  it("REGRESSION: a guest gets a stated reason, not an enabled Connect", async () => {
    stubStatusFor(OFF);
    render(<IntegrationsClient businessId={BIZ} role="guest" />);
    await waitFor(() => {
      expect(document.querySelector('[data-authorize-blocked="meta"]')).not.toBeNull();
    });
    // The start routes answer a guest with a JSON 403, which is not a surface.
    expect(document.querySelector('[data-connect="meta"]')).toBeNull();
    expect(document.querySelector('[data-authorize-blocked="meta"]')!.textContent).toMatch(
      /collaborator role/,
    );
  });

  it("REGRESSION: a guest cannot reconnect an expired connection either", async () => {
    stubStatusFor(EXPIRED);
    render(<IntegrationsClient businessId={BIZ} role="guest" />);
    await waitFor(() => {
      expect(document.querySelector('[data-authorize-blocked="meta"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-reconnect="meta"]')).toBeNull();
  });

  it("a guest clicking anywhere in the row starts no navigation", async () => {
    stubStatusFor(OFF);
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign, search: "" },
      writable: true,
      configurable: true,
    });
    render(<IntegrationsClient businessId={BIZ} role="guest" />);
    await waitFor(() => expect(document.querySelector('[data-authorize-blocked="meta"]')).not.toBeNull());
    (document.querySelector('[data-authorize-blocked="meta"]') as HTMLElement).click();
    expect(assign).not.toHaveBeenCalled();
  });

  it("a collaborator may connect", async () => {
    stubStatusFor(OFF);
    render(<IntegrationsClient businessId={BIZ} role="collaborator" />);
    await waitFor(() => expect(document.querySelector('[data-connect="meta"]')).not.toBeNull());
    expect(document.querySelector('[data-authorize-blocked="meta"]')).toBeNull();
  });

  it("an admin may reconnect", async () => {
    stubStatusFor(EXPIRED);
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector('[data-reconnect="meta"]')).not.toBeNull());
    expect(document.querySelector('[data-authorize-blocked="meta"]')).toBeNull();
  });
});

describe("WP-23 Shopify is entered the way Shopify actually allows", () => {
  function stubShopify(integration: unknown) {
    stub((call) => {
      if (call.url.startsWith("/api/integrations/status")) {
        return { body: { meta: false, google: false, shopify: false, ga4: false, search_console: false } };
      }
      if (call.url.includes("provider=shopify")) return { body: { integration } };
      if (call.url.includes("ad-accounts") || call.url.includes("accessible-accounts")) {
        return { body: { data: [], notice: null } };
      }
      return { body: {} };
    });
  }

  it("REGRESSION: with no known shop, the control leads to setup and says why", async () => {
    stubShopify(null);
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector("[data-shopify-action]")).not.toBeNull());
    const anchor = document.querySelector("[data-shopify-action]") as HTMLAnchorElement;
    // Not a generic OAuth start: that redirects to /shopify/connect and drops
    // businessId and returnTo on the way.
    expect(anchor.getAttribute("href")).toBe("/shopify/connect");
    expect(document.querySelector('[data-shopify-entry="external_install"]')).not.toBeNull();
    expect(document.querySelector("[data-shopify-note]")!.textContent).toMatch(
      /starts in Shopify/i,
    );
    // No automatic return or read-back is claimed.
    expect(document.querySelector("[data-shopify-note]")!.textContent).toMatch(/cannot confirm/i);
  });

  it("with an authoritative shop domain, it starts the real handler", async () => {
    stubShopify({ provider_account_id: "grandmix.myshopify.com" });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() =>
      expect(document.querySelector('[data-shopify-entry="reauthorize"]')).not.toBeNull(),
    );
    const anchor = document.querySelector("[data-shopify-action]") as HTMLAnchorElement;
    const url = new URL(anchor.getAttribute("href")!, "https://example.test");
    expect(url.pathname).toBe("/api/oauth/shopify/start");
    // The handler only completes when a shop is supplied.
    expect(url.searchParams.get("shop")).toBe("grandmix.myshopify.com");
    expect(url.searchParams.get("businessId")).toBe(BIZ);
    expect(sanitizeNextPath(url.searchParams.get("returnTo"))).toBe(url.searchParams.get("returnTo"));
  });

  it("a shop domain that is not a myshopify domain is not trusted", async () => {
    stubShopify({ provider_account_id: "grandmix.example.com" });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() =>
      expect(document.querySelector('[data-shopify-entry="external_install"]')).not.toBeNull(),
    );
    expect((document.querySelector("[data-shopify-action]") as HTMLAnchorElement).getAttribute("href")).toBe(
      "/shopify/connect",
    );
  });
});

describe("WP-23 Shopify follows the same role posture as every other provider", () => {
  function stubShopifyFor(integration: unknown) {
    stub((call) => {
      if (call.url.startsWith("/api/integrations/status")) {
        return { body: { meta: false, google: false, shopify: false, ga4: false, search_console: false } };
      }
      if (call.url.includes("provider=shopify")) return { body: { integration } };
      if (call.url.includes("ad-accounts") || call.url.includes("accessible-accounts")) {
        return { body: { data: [], notice: null } };
      }
      return { body: {} };
    });
  }

  it("REGRESSION: a guest gets no actionable Shopify link with no known domain", async () => {
    stubShopifyFor(null);
    render(<IntegrationsClient businessId={BIZ} role="guest" />);
    await waitFor(() => {
      expect(document.querySelector('[data-authorize-blocked="shopify"]')).not.toBeNull();
    });
    // The Shopify branch used to run before the role check.
    expect(document.querySelector("[data-shopify-action]")).toBeNull();
    expect(document.querySelector('[data-shopify-entry="external_install"]')).toBeNull();
    expect(document.querySelector('[data-authorize-blocked="shopify"]')!.textContent).toMatch(
      /collaborator role/,
    );
  });

  it("REGRESSION: a guest gets no actionable Shopify link even with a verified domain", async () => {
    stubShopifyFor({ provider_account_id: "grandmix.myshopify.com" });
    render(<IntegrationsClient businessId={BIZ} role="guest" />);
    await waitFor(() => {
      expect(document.querySelector('[data-authorize-blocked="shopify"]')).not.toBeNull();
    });
    expect(document.querySelector("[data-shopify-action]")).toBeNull();
    expect(document.querySelector('[data-shopify-entry="reauthorize"]')).toBeNull();
  });

  it("no navigation can start for a guest in either Shopify state", async () => {
    for (const integration of [null, { provider_account_id: "grandmix.myshopify.com" }]) {
      cleanup();
      stubShopifyFor(integration);
      render(<IntegrationsClient businessId={BIZ} role="guest" />);
      await waitFor(() =>
        expect(document.querySelector('[data-authorize-blocked="shopify"]')).not.toBeNull(),
      );
      // There is no anchor at all, so there is no href to follow.
      const anchors = Array.from(document.querySelectorAll("a[href]")).map((a) =>
        a.getAttribute("href"),
      );
      expect(anchors.some((href) => href?.includes("shopify"))).toBe(false);
    }
  });

  it("a collaborator still gets the honest external-install action", async () => {
    stubShopifyFor(null);
    render(<IntegrationsClient businessId={BIZ} role="collaborator" />);
    await waitFor(() =>
      expect(document.querySelector('[data-shopify-entry="external_install"]')).not.toBeNull(),
    );
    expect((document.querySelector("[data-shopify-action]") as HTMLAnchorElement).getAttribute("href")).toBe(
      "/shopify/connect",
    );
    expect(document.querySelector("[data-shopify-note]")!.textContent).toMatch(/starts in Shopify/i);
    expect(document.querySelector('[data-authorize-blocked="shopify"]')).toBeNull();
  });

  it("an admin still gets verified-domain reauthorization", async () => {
    stubShopifyFor({ provider_account_id: "grandmix.myshopify.com" });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() =>
      expect(document.querySelector('[data-shopify-entry="reauthorize"]')).not.toBeNull(),
    );
    const url = new URL(
      (document.querySelector("[data-shopify-action]") as HTMLAnchorElement).getAttribute("href")!,
      "https://example.test",
    );
    expect(url.searchParams.get("shop")).toBe("grandmix.myshopify.com");
  });
});
