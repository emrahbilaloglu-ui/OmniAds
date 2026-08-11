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
import { cleanup, render, waitFor } from "@testing-library/react";

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
function type(selector: string, value: string) {
  const input = document.querySelector(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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
    (document.querySelector("[data-invite-send]") as HTMLElement).click();
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

    (document.querySelector("[data-settings-save]") as HTMLElement).click();
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
    (document.querySelector("[data-settings-save]") as HTMLElement).click();
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
    (document.querySelector("[data-assignment-save]") as HTMLElement).click();

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
    (document.querySelector("[data-assignment-save]") as HTMLElement).click();
    await waitFor(() => {
      expect(document.querySelector("[data-assignment-error]")!.textContent).toMatch(/does not show it/);
    });
  });

  it("surfaces a lane refusal rather than a success", async () => {
    stubAssignment({ saveOk: false });
    render(<IntegrationsClient businessId={BIZ} role="admin" />);
    await waitFor(() => expect(document.querySelector("[data-assignment-save]")).not.toBeNull());
    (document.querySelector("[data-assignment-save]") as HTMLElement).click();
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
    for (const provider of Object.keys(ALL_OFF)) {
      expect(document.querySelector(`[data-connect="${provider}"]`), provider).not.toBeNull();
    }
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
      shopify: "/api/oauth/shopify/start",
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
    expect(document.querySelector('[data-connect="shopify"]')).not.toBeNull();
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
