// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scopeMocks = vi.hoisted(() => ({
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
vi.mock("@/app/(dashboard)/platforms/meta/creatives/page-support", () => ({
  fetchCreativeDecisionEngineV3: scopeMocks.fetchDecisions,
  fetchMetaCreatives: scopeMocks.fetchCreatives,
  mapApiRowToUiRow: (row: unknown) => row,
}));

const MetaLaunchpadPage = (await import("./legacy-page")).default;
const { buildLaunchpadViewerEnvelope } = await import("./viewer-envelope");

const ASSIGNED_ACCOUNTS = [
  { id: "act_1", name: "Same name", currency: "USD", timezone: null },
  { id: "act_2", name: "Same name", currency: "USD", timezone: null },
];

const SECTION_READ = {
  status: "complete",
  errorCode: null,
  observedAt: "2026-08-26T00:00:00.000Z",
};

/**
 * The composed first-load read. The account list now arrives through the same
 * response as the library, so this is where the assigned accounts come from —
 * and the request's own query string is what proves which scope was asked for.
 */
function workspaceBody() {
  return {
    ok: true,
    accounts: ASSIGNED_ACCOUNTS,
    sections: Object.fromEntries(
      [
        "accounts",
        "templates",
        "recentTemplates",
        "drafts",
        "intents",
        "recentAdActions",
        "targetCpa",
      ].map((section) => [section, SECTION_READ]),
    ),
    capability: {},
    templates: [],
    recentTemplates: [],
    drafts: [],
    intents: [],
    recentAdActions: [],
    targetCpa: null,
  };
}

function stubWorkspace(body: Record<string, unknown> = workspaceBody()) {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).startsWith("/api/launchpad/meta/workspace")
      ? { ok: true, status: 200, json: async () => body }
      : { ok: true, status: 200, json: async () => ({}) },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  scopeMocks.query = "providerAccountId=act_unassigned";
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
    const providerFetch = stubWorkspace();
    const { container } = render(
      <MetaLaunchpadPage
        businessId="route_business"
        businessName="Route Business"
        providerAccountId={null}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector("[data-testid='launchpad-exact']"),
      ).not.toBeNull();
    });

    // An id the server refused is never restored, and nothing account-scoped is
    // read while the scope is null. The shared topbar owns the next selection;
    // this surface reads assignments only to explain the blocked state.
    expect(scopeMocks.fetchCreatives).not.toHaveBeenCalled();
    expect(scopeMocks.fetchDecisions).not.toHaveBeenCalled();
    // The first-load read now carries the account list too, so the proof moved
    // from "no request at all" to "no request carrying a scope". Every request
    // this surface issues must be free of the id the server refused.
    for (const call of providerFetch.mock.calls) {
      const url = String(call[0]);
      expect(url.startsWith("/api/launchpad/meta/workspace?")).toBe(true);
      expect(url).not.toContain("providerAccountId");
      expect(url).not.toContain("act_unassigned");
    }
    expect(container.textContent).not.toContain("act_unassigned");
  });

  it("leaves account selection to the shared topbar on desktop and mobile", async () => {
    stubWorkspace();
    const { container, rerender } = render(
      <MetaLaunchpadPage
        businessId="route_business"
        businessName="Route Business"
        providerAccountId={null}
      />,
    );

    await waitFor(() => {
      expect(container.textContent).toContain(
        "Select a Meta ad account in the top bar to use Launchpad.",
      );
    });
    expect(screen.queryByLabelText("Meta ad account for Launchpad")).toBeNull();
    expect(
      screen.getByTestId("meta-mobile-launchpad").querySelector("select"),
    ).toBeNull();
    expect(scopeMocks.replace).not.toHaveBeenCalled();

    // A topbar choice returns as a server-authorized prop. Launchpad consumes
    // that scope directly and still does not grow its own account control.
    rerender(
      <MetaLaunchpadPage
        businessId="route_business"
        businessName="Route Business"
        providerAccountId="act_2"
      />,
    );
    await waitFor(() => {
      expect(
        scopeMocks.fetchCreatives.mock.calls.some(
          ([input]) => input.providerAccountId === "act_2",
        ),
      ).toBe(true);
    });

    const start = await screen.findByTestId("launchpad-start-manual");
    fireEvent.click(start.querySelector("button")!);
    await screen.findByTestId("launchpad-wizard");
    expect(screen.queryByLabelText("Meta ad account for Launchpad")).toBeNull();
    expect(scopeMocks.replace).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("meta-mobile-launchpad").querySelector("select"),
    ).toBeNull();
  });

  it("keeps legacy desktop and mobile account recovery selectable", async () => {
    scopeMocks.query = "";
    stubWorkspace();
    const { container } = render(<MetaLaunchpadPage />);

    const desktopPicker = await screen.findByLabelText(
      "Meta ad account for Launchpad",
    );
    const mobilePicker = await screen.findByLabelText(
      "Meta ad account for Launchpad mobile",
    );
    expect(desktopPicker).toHaveValue("");
    expect(mobilePicker).toHaveValue("");
    expect(
      Array.from((desktopPicker as HTMLSelectElement).options).map(
        (option) => option.value,
      ),
    ).toEqual(["", "act_1", "act_2"]);
    expect(
      Array.from((desktopPicker as HTMLSelectElement).options).map(
        (option) => option.text,
      ),
    ).toEqual([
      "Select account",
      "Same name · ID act_1 · USD",
      "Same name · ID act_2 · USD",
    ]);
    expect(
      Array.from((mobilePicker as HTMLSelectElement).options).map(
        (option) => option.text,
      ),
    ).toEqual([
      "Select account",
      "Same name · ID act_1 · USD",
      "Same name · ID act_2 · USD",
    ]);
    expect(container.textContent).toContain(
      "Select a Meta ad account below to use Launchpad.",
    );

    fireEvent.change(mobilePicker, { target: { value: "act_2" } });

    await waitFor(() => {
      expect(
        scopeMocks.fetchCreatives.mock.calls.some(
          ([input]) => input.providerAccountId === "act_2",
        ),
      ).toBe(true);
    });
    expect(window.location.search).toContain("providerAccountId=act_2");

    const start = await screen.findByTestId("launchpad-start-manual");
    fireEvent.click(start.querySelector("button")!);
    await screen.findByTestId("launchpad-wizard");
    expect(screen.getByLabelText("Meta ad account for Launchpad")).toHaveValue(
      "act_2",
    );
  });

  it.each([
    {
      label: "no assigned accounts",
      accountsSection: SECTION_READ,
      message: "No Meta ad account is assigned to this business.",
    },
    {
      label: "an unavailable assignment catalog",
      accountsSection: {
        status: "failed",
        errorCode: "source_read_failed",
        observedAt: "2026-08-26T00:00:00.000Z",
      },
      message: "Meta ad accounts are temporarily unavailable.",
    },
  ])(
    "does not offer a false legacy choice with $label",
    async ({ accountsSection, message }) => {
      scopeMocks.query = "";
      const body = workspaceBody();
      stubWorkspace({
        ...body,
        accounts: [],
        sections: { ...body.sections, accounts: accountsSection },
      });

      render(<MetaLaunchpadPage />);

      await screen.findAllByText(message);
      expect(
        screen.queryByLabelText("Meta ad account for Launchpad"),
      ).toBeNull();
      expect(
        screen.queryByLabelText("Meta ad account for Launchpad mobile"),
      ).toBeNull();
    },
  );

  it("retains the legacy account choice when the selected account lacks currency", async () => {
    scopeMocks.query = "providerAccountId=act_1";
    const body = workspaceBody();
    stubWorkspace({
      ...body,
      accounts: [
        { id: "act_1", name: "No Currency", currency: null, timezone: null },
        { id: "act_2", name: "Ready", currency: "USD", timezone: null },
      ],
    });

    render(<MetaLaunchpadPage />);

    expect(
      await screen.findByText(
        "The selected Meta account needs a currency before launching.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Meta ad account for Launchpad")).toHaveValue(
      "act_1",
    );
    expect(
      screen.getByLabelText("Meta ad account for Launchpad mobile"),
    ).toHaveValue("act_1");
  });
});

describe("Meta Launchpad reviewer write boundary", () => {
  async function renderWithViewer(
    viewer: ReturnType<typeof buildLaunchpadViewerEnvelope>,
  ) {
    scopeMocks.query = "";
    stubWorkspace();
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
    expect(saveTemplate.getAttribute("title")).toBe(
      "Changes are unavailable for this workspace.",
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
    expect(saveTemplate.getAttribute("title")).toBe(
      "Changes are unavailable for this workspace.",
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
    expect(saveTemplate.getAttribute("title")).toBe(
      "Changes are unavailable for this workspace.",
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
    expect(saveTemplate.getAttribute("title")).toBe(
      "Changes are unavailable for this workspace.",
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
