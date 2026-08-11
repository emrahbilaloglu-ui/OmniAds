// @vitest-environment jsdom

/**
 * WP-24 Flow J, mounted.
 *
 * The production defect: `OpsIncidentSurface` was mounted with no `businessId`
 * on both `/ops` and `/ops/integrations`, while the Shopify handler reads
 * `businessId` from the PATCH body and from the GET query. Every click on the
 * shipped button was a 400, and the re-read stamped "Health re-read at …"
 * regardless.
 *
 * SAFETY: `verify_webhooks` may call Shopify. Nothing here runs it — `fetch` is
 * stubbed at the network boundary for every test in this file, so no request
 * leaves the process. The stub records what *would* have been sent.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import {
  OpsIncidentSurface,
  fetchAllAdminBusinesses,
  readHealthBody,
} from "@/components/zero-base/ops/ops-incident-surface";

const BIZ_A = "33333333-3333-4333-8333-333333333333";
const BIZ_B = "44444444-4444-4444-8444-444444444444";

const ADMIN_BUSINESSES = {
  businesses: [
    { id: BIZ_A, name: "Grandmix" },
    { id: BIZ_B, name: "Second Workspace" },
  ],
  total: 2,
  page: 1,
  limit: 200,
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];

/** Stub every request. Nothing reaches Shopify or any real handler. */
function stub(routes: {
  patch?: { ok?: boolean; body?: unknown };
  healthGet?: { ok?: boolean; body?: unknown };
  list?: { ok?: boolean; body?: unknown };
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });

      if (url.startsWith("/api/admin/businesses")) {
        const route = routes.list ?? { body: ADMIN_BUSINESSES };
        return { ok: route.ok ?? true, status: route.ok === false ? 500 : 200, json: async () => route.body } as Response;
      }
      if (method === "PATCH") {
        const route = routes.patch ?? { body: { ok: true, action: "verify_webhooks" } };
        return { ok: route.ok ?? true, status: route.ok === false ? 400 : 200, json: async () => route.body } as Response;
      }
      // Default: a valid producer-shaped health body for whichever business
      // was asked about. Tests needing a mismatch or a malformed core say so.
      const asked = new URL(url, "https://example.test").searchParams.get("businessId") ?? BIZ_A;
      const route = routes.healthGet ?? { body: validHealth(asked) };
      return { ok: route.ok ?? true, status: route.ok === false ? 400 : 200, json: async () => route.body } as Response;
    }),
  );
}

/** The minimum shape `getShopifyStatus` + the health route actually produce. */
function validHealth(businessId: string, overrides: Record<string, unknown> = {}) {
  return {
    businessId,
    status: { state: "ready", connected: true, shopId: "x.myshopify.com" },
    auth: { shopDomain: "x.myshopify.com", tokenValid: true, missingRequiredScopes: [] },
    ...overrides,
  };
}

async function selectWorkspace(value: string) {
  const select = document.querySelector("[data-ops-workspace-select]") as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => expect(select.value).toBe(value));
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WP-24 the repair is scoped to a real workspace", () => {
  it("REGRESSION: nothing is enabled until a workspace is chosen", async () => {
    stub({});
    render(<OpsIncidentSurface />);
    await waitFor(() => {
      expect(document.querySelector("[data-ops-workspace-select]")).not.toBeNull();
    });
    expect(document.querySelector('[data-repair-blocked="verify_webhooks"]')).not.toBeNull();
    // The shipped button used to be live and 400 on every click.
    const button = document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLButtonElement;
    button.click();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("lists the workspaces from the admin authority", async () => {
    stub({});
    render(<OpsIncidentSurface />);
    await waitFor(() => {
      expect(document.querySelectorAll("[data-ops-workspace-select] option").length).toBe(3);
    });
    expect(calls[0].url).toContain("/api/admin/businesses");
  });

  it("refuses when the workspace list cannot be read", async () => {
    stub({ list: { ok: false } });
    render(<OpsIncidentSurface />);
    await waitFor(() => {
      expect(document.querySelector("[data-ops-workspace-error]")).not.toBeNull();
    });
    expect(document.querySelector('[data-repair-blocked="verify_webhooks"]')).not.toBeNull();
  });

  it("REGRESSION: the PATCH carries the selected businessId", async () => {
    stub({});
    render(<OpsIncidentSurface />);
    await waitFor(() => expect(document.querySelector("[data-ops-workspace-select]")).not.toBeNull());
    await selectWorkspace(BIZ_B);

    (document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => {
      expect(document.querySelector('[data-repair-confirm="verify_webhooks"]')).not.toBeNull();
    });
    (document.querySelector('[data-repair-confirm-yes="verify_webhooks"]') as HTMLElement).click();

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect((patch.body as { businessId: string }).businessId).toBe(BIZ_B);
    expect((patch.body as { action: string }).action).toBe("verify_webhooks");
    expect(patch.url).toContain(`businessId=${BIZ_B}`);
  });
});

describe("WP-24 a consequential provider action is confirmed in scope", () => {
  it("names the workspace, provider and action before it runs", async () => {
    stub({});
    render(<OpsIncidentSurface />);
    await waitFor(() => expect(document.querySelector("[data-ops-workspace-select]")).not.toBeNull());
    await selectWorkspace(BIZ_A);

    (document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => {
      expect(document.querySelector("[data-repair-confirm-scope]")).not.toBeNull();
    });
    const text = document.querySelector("[data-repair-confirm-scope]")!.textContent ?? "";
    expect(text).toContain("Grandmix");
    expect(text).toContain("Shopify");
    expect(text).toContain("verify_webhooks");
    // Still nothing sent — confirmation gates the call.
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("cancelling sends nothing", async () => {
    stub({});
    render(<OpsIncidentSurface />);
    await waitFor(() => expect(document.querySelector("[data-ops-workspace-select]")).not.toBeNull());
    await selectWorkspace(BIZ_A);
    (document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => expect(document.querySelector("[data-repair-confirm-scope]")).not.toBeNull());
    (document.querySelector('[data-repair-confirm-cancel="verify_webhooks"]') as HTMLElement).click();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("still discloses that the endpoint performs no read-back", async () => {
    stub({});
    render(<OpsIncidentSurface />);
    await waitFor(() => expect(document.querySelector("[data-ops-workspace-select]")).not.toBeNull());
    await selectWorkspace(BIZ_A);
    expect(document.querySelector("[data-repair-no-receipt]")).not.toBeNull();
  });
});

describe("WP-24 the re-read only claims what it observed", () => {
  async function runToOutcome() {
    render(<OpsIncidentSurface />);
    await waitFor(() => expect(document.querySelector("[data-ops-workspace-select]")).not.toBeNull());
    await selectWorkspace(BIZ_A);
    (document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => expect(document.querySelector("[data-repair-confirm-scope]")).not.toBeNull());
    (document.querySelector('[data-repair-confirm-yes="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => {
      expect(document.querySelector('[data-repair-recheck="verify_webhooks"]')).not.toBeNull();
    });
  }

  it("stamps a re-read only after a readable health body", async () => {
    stub({ healthGet: { body: validHealth(BIZ_A, { canaryKey: "k" }) } });
    await runToOutcome();
    (document.querySelector('[data-repair-recheck="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => expect(document.querySelector("[data-ops-rechecked]")).not.toBeNull());
  });

  it("REGRESSION: says nothing was re-read after a failed GET", async () => {
    stub({ healthGet: { ok: false, body: { error: "businessId is required." } } });
    await runToOutcome();
    (document.querySelector('[data-repair-recheck="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => expect(document.querySelector("[data-ops-recheck-failed]")).not.toBeNull());
    // The previous version stamped "Health re-read at …" on a 400.
    expect(document.querySelector("[data-ops-rechecked]")).toBeNull();
    expect(document.querySelector("[data-ops-recheck-failed]")!.textContent).toMatch(/unknown/i);
  });

  it("REGRESSION: refuses a 200 whose body is not a health body", async () => {
    stub({ healthGet: { body: { unrelated: true } } });
    await runToOutcome();
    (document.querySelector('[data-repair-recheck="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => expect(document.querySelector("[data-ops-recheck-failed]")).not.toBeNull());
    expect(document.querySelector("[data-ops-rechecked]")).toBeNull();
  });

  it("clears a stale re-read when the workspace changes", async () => {
    stub({});
    await runToOutcome();
    (document.querySelector('[data-repair-recheck="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => expect(document.querySelector("[data-ops-rechecked]")).not.toBeNull());
    await selectWorkspace(BIZ_B);
    expect(document.querySelector("[data-ops-rechecked]")).toBeNull();
  });

  it("REGRESSION: a matching tenant id alone is not a health result", () => {
    // This used to return a non-null object and be stamped as a successful
    // re-read, claiming a condition nobody had observed.
    expect(readHealthBody({ businessId: BIZ_A }, BIZ_A)).toBeNull();
    // A real producer-shaped body is read.
    expect(readHealthBody(validHealth(BIZ_A), BIZ_A)).not.toBeNull();
    // A body for a different workspace is not this workspace's health.
    expect(readHealthBody(validHealth(BIZ_B), BIZ_A)).toBeNull();
    expect(readHealthBody({ error: "businessId is required." }, BIZ_A)).toBeNull();
    expect(readHealthBody(null, BIZ_A)).toBeNull();
  });

  it("REGRESSION: a malformed health core is unknown, not a reading", () => {
    // status present but not an object.
    expect(readHealthBody({ businessId: BIZ_A, status: "ready" }, BIZ_A)).toBeNull();
    // state missing, or the wrong type.
    expect(readHealthBody({ businessId: BIZ_A, status: { connected: true } }, BIZ_A)).toBeNull();
    expect(readHealthBody({ businessId: BIZ_A, status: { state: 7, connected: true } }, BIZ_A)).toBeNull();
    expect(readHealthBody({ businessId: BIZ_A, status: { state: "  ", connected: true } }, BIZ_A)).toBeNull();
    // connected missing, or the wrong type.
    expect(readHealthBody({ businessId: BIZ_A, status: { state: "ready" } }, BIZ_A)).toBeNull();
    expect(
      readHealthBody({ businessId: BIZ_A, status: { state: "ready", connected: "yes" } }, BIZ_A),
    ).toBeNull();
  });

  it("distinguishes an absent optional field from a malformed one", () => {
    // Absent is ordinary: auth may simply not be there.
    const bare = readHealthBody({ businessId: BIZ_A, status: { state: "stale", connected: false } }, BIZ_A);
    expect(bare).not.toBeNull();
    expect(bare!.shopDomain).toBeNull();
    expect(bare!.tokenValid).toBeNull();
    expect(bare!.state).toBe("stale");
    expect(bare!.connected).toBe(false);

    // Present-but-wrong-type must not be silently downgraded to "not reported".
    const core = { businessId: BIZ_A, status: { state: "ready", connected: true } };
    expect(readHealthBody({ ...core, auth: "nope" }, BIZ_A)).toBeNull();
    expect(readHealthBody({ ...core, auth: { shopDomain: 42 } }, BIZ_A)).toBeNull();
    expect(readHealthBody({ ...core, auth: { tokenValid: "true" } }, BIZ_A)).toBeNull();
    expect(readHealthBody({ ...core, auth: { productionMode: 1 } }, BIZ_A)).toBeNull();
    expect(readHealthBody({ ...core, auth: { missingRequiredScopes: "read_orders" } }, BIZ_A)).toBeNull();
    expect(readHealthBody({ ...core, auth: { missingRequiredScopes: [1] } }, BIZ_A)).toBeNull();
  });
});

describe("WP-24 the surface holds at every width", () => {
  for (const width of [1280, 768, 390]) {
    it(`mounts the full flow at ${width}`, async () => {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
      stub({});
      render(<OpsIncidentSurface />);
      await waitFor(() => expect(document.querySelector("[data-ops-workspace-select]")).not.toBeNull());
      await selectWorkspace(BIZ_A);
      (document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement).click();
      await waitFor(() => expect(document.querySelector("[data-repair-confirm-scope]")).not.toBeNull());
      // Incident path, selector, confirmation and disclosure are all present.
      expect(document.querySelector("[data-incident-path]")).not.toBeNull();
      expect(document.querySelector("[data-repair-no-receipt]")).not.toBeNull();
    });
  }
});

describe("WP-24 every workspace is findable", () => {
  /** The route hardcodes limit=30 and ignores any limit we ask for. */
  const PAGE_SIZE = 30;
  const TOTAL = 74;

  function page(n: number) {
    const start = (n - 1) * PAGE_SIZE;
    return {
      businesses: Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, TOTAL - start)) }, (_, i) => ({
        id: `biz-${start + i}`,
        name: `Workspace ${start + i}`,
      })),
      total: TOTAL,
      page: n,
      limit: PAGE_SIZE,
    };
  }

  function stubPaged(failPage?: number) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push({ url, method: "GET", body: null });
        if (url.startsWith("/api/admin/businesses")) {
          const n = Number(new URL(url, "https://example.test").searchParams.get("page") ?? 1);
          if (failPage === n) return { ok: false, status: 500, json: async () => ({}) } as Response;
          return { ok: true, status: 200, json: async () => page(n) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ businessId: "x" }) } as Response;
      }),
    );
  }

  it("REGRESSION: a workspace past the first page can be selected", async () => {
    stubPaged();
    render(<OpsIncidentSurface />);
    await waitFor(() => {
      // 74 workspaces plus the placeholder option.
      expect(document.querySelectorAll("[data-ops-workspace-select] option").length).toBe(TOTAL + 1);
    });
    // The 31st workspace exists only on page 2; ?limit=200 returned 30 rows.
    await selectWorkspace("biz-30");
    expect((document.querySelector("[data-ops-workspace-select]") as HTMLSelectElement).value).toBe("biz-30");
  });

  it("walks pages using the route's own total and limit", async () => {
    stubPaged();
    render(<OpsIncidentSurface />);
    await waitFor(() =>
      expect(document.querySelectorAll("[data-ops-workspace-select] option").length).toBe(TOTAL + 1),
    );
    const pages = calls
      .filter((call) => call.url.startsWith("/api/admin/businesses"))
      .map((call) => new URL(call.url, "https://example.test").searchParams.get("page"));
    expect(pages).toEqual(["1", "2", "3"]);
  });

  it("REGRESSION: discloses a partial list rather than looking complete", async () => {
    stubPaged(2);
    render(<OpsIncidentSurface />);
    await waitFor(() => {
      expect(document.querySelector("[data-ops-workspace-error]")).not.toBeNull();
    });
    expect(document.querySelector("[data-ops-workspace-error]")!.textContent).toMatch(/incomplete/i);
    // What was read is still offered; only the claim of completeness is dropped.
    expect(document.querySelectorAll("[data-ops-workspace-select] option").length).toBeGreaterThan(1);
  });

  it("reports a first-page failure as unreadable, not as an empty estate", async () => {
    stubPaged(1);
    render(<OpsIncidentSurface />);
    await waitFor(() => {
      expect(document.querySelector("[data-ops-workspace-error]")!.textContent).toMatch(/could not be read/);
    });
    expect(document.querySelector('[data-repair-blocked="verify_webhooks"]')).not.toBeNull();
  });

  it("fetchAllAdminBusinesses reports partial and failed reads distinctly", async () => {
    const okAll = await fetchAllAdminBusinesses(async (url) => {
      const n = Number(new URL(url, "https://e.test").searchParams.get("page") ?? 1);
      return page(n);
    });
    expect(okAll.businesses).toHaveLength(TOTAL);
    expect(okAll.partial).toBe(false);
    expect(okAll.readFailed).toBe(false);

    const failedFirst = await fetchAllAdminBusinesses(async () => null);
    expect(failedFirst.readFailed).toBe(true);
    expect(failedFirst.businesses).toHaveLength(0);
  });
});

describe("WP-24 the health re-read is this workspace's own", () => {
  const HEALTH = (businessId: string) => ({
    businessId,
    status: { state: "action_required", connected: true, shopId: "grandmix.myshopify.com" },
    auth: {
      shopDomain: "grandmix.myshopify.com",
      tokenPresent: true,
      tokenValid: false,
      tokenValidationError: "The token was rejected by Shopify.",
      missingRequiredScopes: ["read_all_orders"],
      missingOptionalScopes: [],
      historicalCoverageBlockedByMissingReadAllOrders: true,
      returnsRepairBlockedByMissingReadReturns: false,
      productionMode: "disabled",
    },
  });

  async function runToRecheck(healthGet: { ok?: boolean; body?: unknown }, workspace = BIZ_A) {
    stub({ healthGet });
    render(<OpsIncidentSurface />);
    await waitFor(() => expect(document.querySelector("[data-ops-workspace-select]")).not.toBeNull());
    await selectWorkspace(workspace);
    (document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => expect(document.querySelector("[data-repair-confirm-scope]")).not.toBeNull());
    (document.querySelector('[data-repair-confirm-yes="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() =>
      expect(document.querySelector('[data-repair-recheck="verify_webhooks"]')).not.toBeNull(),
    );
    (document.querySelector('[data-repair-recheck="verify_webhooks"]') as HTMLElement).click();
  }

  it("REGRESSION: shows the state this GET returned, not a pointer to another board", async () => {
    await runToRecheck({ body: HEALTH(BIZ_A) });
    await waitFor(() => expect(document.querySelector("[data-ops-health]")).not.toBeNull());
    expect(document.querySelector("[data-health-state]")!.textContent).toContain("action_required");
    expect(document.querySelector("[data-health-shop]")!.textContent).toContain("grandmix.myshopify.com");
    expect(document.querySelector("[data-health-token]")!.textContent).toMatch(/invalid/);
    expect(document.querySelector("[data-health-mode]")!.textContent).toContain("disabled");
    const blockers = document.querySelector("[data-ops-health-blockers]")!.textContent ?? "";
    expect(blockers).toMatch(/read_all_orders/);
    // The old copy sent the operator to a board this GET did not update.
    expect(document.querySelector("[data-ops-rechecked]")!.textContent).not.toMatch(/board above/);
  });

  it("says so plainly when a read reports no blockers", async () => {
    await runToRecheck({
      body: {
        businessId: BIZ_A,
        status: { state: "ready", connected: true },
        auth: { shopDomain: "x.myshopify.com", tokenValid: true, missingRequiredScopes: [] },
      },
    });
    await waitFor(() => expect(document.querySelector("[data-ops-health-clear]")).not.toBeNull());
    expect(document.querySelector("[data-ops-health-blockers]")).toBeNull();
  });

  it("REGRESSION: a body for a different workspace is not this workspace's health", async () => {
    // 200, well-formed, but about another business entirely.
    await runToRecheck({ body: HEALTH(BIZ_B) }, BIZ_A);
    await waitFor(() => expect(document.querySelector("[data-ops-recheck-failed]")).not.toBeNull());
    expect(document.querySelector("[data-ops-rechecked]")).toBeNull();
    expect(document.querySelector("[data-ops-health]")).toBeNull();
    expect(document.querySelector("[data-ops-recheck-failed]")!.textContent).toMatch(/unknown/i);
  });

  it("REGRESSION: changing workspace drops the previous workspace's health", async () => {
    await runToRecheck({ body: HEALTH(BIZ_A) });
    await waitFor(() => expect(document.querySelector("[data-ops-health]")).not.toBeNull());
    await selectWorkspace(BIZ_B);
    expect(document.querySelector("[data-ops-health]")).toBeNull();
    expect(document.querySelector("[data-ops-rechecked]")).toBeNull();
  });
});

describe("WP-24 a health claim needs a health core, mounted", () => {
  async function recheckWith(body: unknown) {
    stub({ healthGet: { body } });
    render(<OpsIncidentSurface />);
    await waitFor(() => expect(document.querySelector("[data-ops-workspace-select]")).not.toBeNull());
    await selectWorkspace(BIZ_A);
    (document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => expect(document.querySelector("[data-repair-confirm-scope]")).not.toBeNull());
    (document.querySelector('[data-repair-confirm-yes="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() =>
      expect(document.querySelector('[data-repair-recheck="verify_webhooks"]')).not.toBeNull(),
    );
    (document.querySelector('[data-repair-recheck="verify_webhooks"]') as HTMLElement).click();
  }

  it("REGRESSION: a {businessId}-only 200 does not stamp a successful re-read", async () => {
    await recheckWith({ businessId: BIZ_A });
    await waitFor(() => expect(document.querySelector("[data-ops-recheck-failed]")).not.toBeNull());
    expect(document.querySelector("[data-ops-rechecked]")).toBeNull();
    expect(document.querySelector("[data-ops-health]")).toBeNull();
  });

  it("REGRESSION: a malformed status is unknown, not a reading", async () => {
    await recheckWith({ businessId: BIZ_A, status: { connected: true } });
    await waitFor(() => expect(document.querySelector("[data-ops-recheck-failed]")).not.toBeNull());
    expect(document.querySelector("[data-ops-rechecked]")).toBeNull();
  });

  it("a malformed optional field is unknown rather than shown as not reported", async () => {
    await recheckWith({
      businessId: BIZ_A,
      status: { state: "ready", connected: true },
      auth: { shopDomain: 42 },
    });
    await waitFor(() => expect(document.querySelector("[data-ops-recheck-failed]")).not.toBeNull());
    expect(document.querySelector("[data-health-shop]")).toBeNull();
  });

  it("renders the visible fields of a real producer-shaped payload", async () => {
    await recheckWith({
      businessId: BIZ_A,
      status: { state: "partial", connected: true, shopId: "grandmix.myshopify.com" },
      auth: {
        shopDomain: "grandmix.myshopify.com",
        tokenValid: true,
        missingRequiredScopes: [],
        productionMode: "enabled",
      },
    });
    await waitFor(() => expect(document.querySelector("[data-ops-health]")).not.toBeNull());
    expect(document.querySelector("[data-health-state]")!.textContent).toContain("partial");
    expect(document.querySelector("[data-health-shop]")!.textContent).toContain("grandmix.myshopify.com");
    expect(document.querySelector("[data-health-token]")!.textContent).toMatch(/valid/);
    expect(document.querySelector("[data-health-mode]")!.textContent).toContain("enabled");
    expect(document.querySelector("[data-ops-health-clear]")).not.toBeNull();
  });
});
