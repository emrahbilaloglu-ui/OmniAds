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

import { OpsIncidentSurface, isReadableHealthBody } from "@/components/zero-base/ops/ops-incident-surface";

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
      const route = routes.healthGet ?? { body: { businessId: BIZ_A } };
      return { ok: route.ok ?? true, status: route.ok === false ? 400 : 200, json: async () => route.body } as Response;
    }),
  );
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
    stub({ healthGet: { body: { businessId: BIZ_A, canaryKey: "k" } } });
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

  it("reads a health body by the field the handler actually echoes", () => {
    expect(isReadableHealthBody({ businessId: BIZ_A })).toBe(true);
    expect(isReadableHealthBody({ error: "businessId is required." })).toBe(false);
    expect(isReadableHealthBody(null)).toBe(false);
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
