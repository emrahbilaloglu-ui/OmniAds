// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scopeMocks = vi.hoisted(() => ({
  fetchAccounts: vi.fn(),
  fetchCreatives: vi.fn(),
  fetchDecisions: vi.fn(),
  replace: vi.fn(),
  query: "providerAccountId=act_unassigned",
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedBusinessId: "store_business",
      businesses: [
        { id: "store_business", name: "Store Business", currency: "USD" },
      ],
    }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(scopeMocks.query),
  useRouter: () => ({ replace: scopeMocks.replace, push: vi.fn() }),
}));
vi.mock("@/lib/meta/history-client", () => ({
  fetchMetaHistoryAccounts: scopeMocks.fetchAccounts,
}));
vi.mock("@/app/(dashboard)/platforms/meta/creatives/page-support", () => ({
  fetchCreativeDecisionEngineV3: scopeMocks.fetchDecisions,
  fetchMetaCreatives: scopeMocks.fetchCreatives,
  mapApiRowToUiRow: (row: unknown) => row,
}));

const MetaLaunchpadPage = (await import("./legacy-page")).default;
const { buildLaunchpadViewerEnvelope } = await import("./viewer-envelope");

const ASSIGNED_ACCOUNTS = [
  { id: "act_1", name: "Account One", currency: "USD", timezone: null },
  { id: "act_2", name: "Account Two", currency: "USD", timezone: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  scopeMocks.query = "providerAccountId=act_unassigned";
  scopeMocks.fetchAccounts.mockResolvedValue(ASSIGNED_ACCOUNTS);
  scopeMocks.fetchCreatives.mockResolvedValue({ rows: [] });
  scopeMocks.fetchDecisions.mockResolvedValue({ decisions: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Meta Launchpad authorized client scope", () => {
  it("does not restore an unassigned URL account or issue scoped reads when the server resolved null", async () => {
    const providerFetch = vi.spyOn(globalThis, "fetch");
    const { container } = render(
      <MetaLaunchpadPage
        businessId="route_business"
        businessName="Route Business"
        providerAccountId={null}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("[data-testid='launchpad-exact']")).not.toBeNull();
    });

    // The law is about the *chosen account*, not about presentation: an id the
    // server refused is never restored, and nothing account-scoped is read
    // while the scope is null. Reading the assignment list itself is allowed —
    // it is the very set `resolveProviderAccountId` authorizes against, so it
    // cannot widen scope, and without it a multi-account business would have
    // nothing to select and Launchpad would be a dead end (see below).
    expect(scopeMocks.fetchCreatives).not.toHaveBeenCalled();
    expect(scopeMocks.fetchDecisions).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("act_unassigned");
  });

  it("offers a multi-account business its assigned accounts and requests the choice through the URL", async () => {
    render(
      <MetaLaunchpadPage
        businessId="route_business"
        businessName="Route Business"
        providerAccountId={null}
      />,
    );

    // Without a control here the surface says "select one assigned Meta ad
    // account" while offering nothing to select, and the operator can only
    // proceed by hand-editing the address bar.
    const picker = (await screen.findByLabelText(
      "Meta ad account for Launchpad",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(
        Array.from(picker.options).map((option) => option.value),
      ).toEqual(["", "act_1", "act_2"]);
    });

    fireEvent.change(picker, { target: { value: "act_2" } });

    // The client may only *request* an account. It writes the id into the URL
    // and the server re-resolves it, so an unassigned id is still refused.
    expect(scopeMocks.replace).toHaveBeenCalledTimes(1);
    expect(String(scopeMocks.replace.mock.calls[0]?.[0])).toContain(
      "providerAccountId=act_2",
    );
  });
});

describe("Meta Launchpad reviewer write boundary", () => {
  function stubLibraryEndpoints() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/launchpad/meta/drafts"))
          return { ok: true, json: async () => ({ drafts: [] }) };
        if (url.startsWith("/api/launchpad/meta/templates"))
          return { ok: true, json: async () => ({ templates: [] }) };
        if (url.startsWith("/api/launchpad/meta/intents"))
          return { ok: true, json: async () => ({ intents: [] }) };
        if (url.startsWith("/api/launchpad/meta/recent-ad-actions"))
          return { ok: true, json: async () => ({ actions: [] }) };
        if (url.startsWith("/api/business-commercial-settings"))
          return { ok: true, json: async () => ({ snapshot: {} }) };
        return { ok: true, json: async () => ({}) };
      }),
    );
  }

  async function renderWithViewer(
    viewer: ReturnType<typeof buildLaunchpadViewerEnvelope>,
  ) {
    scopeMocks.query = "";
    stubLibraryEndpoints();
    render(
      <MetaLaunchpadPage
        businessId="route_business"
        businessName="Route Business"
        providerAccountId="act_1"
        viewer={viewer}
      />,
    );
    const start = await screen.findByTestId("launchpad-start-manual");
    fireEvent.click(start.querySelector("button")!);
    return screen.findByRole("button", { name: /Save template/ });
  }

  // LAW: the surface RENDERS the server's viewer decision, it never computes
  // one. Every Launchpad write route refuses a reviewer with 403
  // `reviewer_read_only`, a demo workspace with 403 `demo_business_read_only`,
  // and anything below collaborator, all before any provider call. Rendering an
  // active control makes the operator run the whole wizard to find out — and
  // because those 403s carry no counts, the receipt then reads as a partial
  // launch. Restating a refusal the server already holds is not the same as
  // granting one: the route still refuses on its own authority.
  it("refuses the write controls a reviewer's session can never use", async () => {
    const saveTemplate = await renderWithViewer(
      buildLaunchpadViewerEnvelope({
        role: "admin",
        reviewerReadOnly: true,
        writeAuthority: "live",
      }),
    );

    expect(saveTemplate).toHaveProperty("disabled", true);
    expect(saveTemplate.getAttribute("title")).toContain(
      "Reviewer access is read-only",
    );
  });

  // LAW (INVARIANTS.md): "Demo businesses have zero Meta write authority even
  // if a presentation defect supplies an action." A demo session arrives as an
  // ADMIN of the demo business under a non-reviewer email, so neither the role
  // check nor the reviewer check catches it. The refusal is server-decided
  // (`rejectIfLaunchpadDemoWrite`) and restated here.
  it("refuses the write controls in a demo workspace even for an admin", async () => {
    const saveTemplate = await renderWithViewer(
      buildLaunchpadViewerEnvelope({
        role: "admin",
        reviewerReadOnly: false,
        writeAuthority: "demo",
      }),
    );

    expect(saveTemplate).toHaveProperty("disabled", true);
    expect(saveTemplate.getAttribute("title")).toContain(
      "Demo workspaces have zero Meta write authority",
    );
  });

  // LAW: an unreadable demo flag is not "live". A read failure must never
  // become success, so the write is held and the reason says it is unverified
  // rather than pretending the workspace was confirmed real.
  it("holds the write controls when demo status could not be read", async () => {
    const saveTemplate = await renderWithViewer(
      buildLaunchpadViewerEnvelope({
        role: "admin",
        reviewerReadOnly: false,
        writeAuthority: "unverified",
      }),
    );

    expect(saveTemplate).toHaveProperty("disabled", true);
    expect(saveTemplate.getAttribute("title")).toContain(
      "could not be confirmed as a live",
    );
  });

  // LAW: `requireLaunchpadBusinessAccess` demands `collaborator`; a guest is
  // refused before any provider call.
  it("refuses the write controls for a guest", async () => {
    const saveTemplate = await renderWithViewer(
      buildLaunchpadViewerEnvelope({
        role: "guest",
        reviewerReadOnly: false,
        writeAuthority: "live",
      }),
    );

    expect(saveTemplate).toHaveProperty("disabled", true);
    expect(saveTemplate.getAttribute("title")).toContain(
      "require collaborator access",
    );
  });

  it("leaves the write controls to capability gating for a collaborator", async () => {
    const saveTemplate = await renderWithViewer(
      buildLaunchpadViewerEnvelope({
        role: "collaborator",
        reviewerReadOnly: false,
        writeAuthority: "live",
      }),
    );

    // Still disabled here — but by the template store capability, not by the
    // viewer, and the reason on the control says so.
    expect(saveTemplate.getAttribute("title") ?? "").not.toContain(
      "Reviewer access is read-only",
    );
    expect(saveTemplate.getAttribute("title") ?? "").not.toContain(
      "Demo workspaces",
    );
  });
});
