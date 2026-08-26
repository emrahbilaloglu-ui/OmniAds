// @vitest-environment jsdom

/**
 * The preserved legacy mount, `/platforms/meta/launchpad`.
 *
 * `lib/zero-base/compatibility-page.tsx` mounts this body with the shim's own
 * `params`/`searchParams` and nothing else — no `viewer` prop — so the surface
 * has no server-resolved role, no reviewer posture, and no read of
 * `businesses.is_demo_business`. It used to treat that as permission and render
 * ACTIVE Save template / Save draft / Launch controls; every one of those
 * clicks is a 403 the write routes were always going to return.
 *
 * The mount is not hypothetical. `decideCompatibility` renders the legacy body
 * for `uiMode: "off"` (the default when ZERO_BASE_UI_MODE is unset), for every
 * business-scoped path under `internal`, for a non-allowlisted business under
 * `allowlist`, and — under `on` — whenever `authorizeBusiness` answers
 * `schema_unavailable`, which `applyDecision` maps to the legacy body. That last
 * case is the sharp one: it is exactly the state in which the canonical route's
 * `readLaunchpadWriteAuthority` would answer `unverified` and hold the write.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mounts = vi.hoisted(() => ({
  fetchCreatives: vi.fn(),
  fetchDecisions: vi.fn(),
  query: "",
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
  useSearchParams: () => new URLSearchParams(mounts.query),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/app/(dashboard)/platforms/meta/creatives/page-support", () => ({
  fetchCreativeDecisionEngineV3: mounts.fetchDecisions,
  fetchMetaCreatives: mounts.fetchCreatives,
  mapApiRowToUiRow: (row: unknown) => row,
}));

const MetaLaunchpadPage = (await import("./legacy-page")).default;
const {
  LAUNCHPAD_LIBRARY_REFUSED_MESSAGE,
  LAUNCHPAD_LIBRARY_UNAVAILABLE_MESSAGE,
} = await import("./legacy-page");

beforeEach(() => {
  vi.clearAllMocks();
  mounts.query = "";
  mounts.fetchCreatives.mockResolvedValue({ rows: [] });
  mounts.fetchDecisions.mockResolvedValue({ decisions: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ASSIGNED_ACCOUNTS = [
  { id: "act_1", name: "Account One", currency: "USD", timezone: null },
];

/** One section, read. The composed route stamps every section it reached. */
const SECTION_READ = {
  status: "complete",
  errorCode: null,
  observedAt: "2026-08-26T00:00:00.000Z",
};

/** The composed first-load read, answering everything, and answering empty. */
function stubReadableLibrary() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/launchpad/meta/workspace"))
        return {
          ok: true,
          json: async () => ({
            ok: true,
            accounts: ASSIGNED_ACCOUNTS,
            sections: {
              accounts: SECTION_READ,
              templates: SECTION_READ,
              recentTemplates: SECTION_READ,
              drafts: SECTION_READ,
              intents: SECTION_READ,
              recentAdActions: SECTION_READ,
              targetCpa: SECTION_READ,
            },
            capability: {},
            templates: [],
            recentTemplates: [],
            drafts: [],
            intents: [],
            recentAdActions: [],
            targetCpa: null,
          }),
        };
      return { ok: true, json: async () => ({}) };
    }),
  );
}

/**
 * The composed read as the server answers it for a viewer below `collaborator`.
 *
 * `/api/launchpad/meta/workspace` enforces two floors, because the routes it
 * folded in do: the account list is `guest`-readable and the six library
 * sections are not. So a refusal arrives as a 200 that carries the accounts and
 * names the refusal per section — not as a 403 for the whole surface.
 */
function stubRefusedLibrary() {
  stubWorkspace((section) => ({
    status: "unavailable",
    errorCode: "capability_read_denied",
    observedAt: "2026-08-26T00:00:00.000Z",
    section,
  }));
}

/** The same shape, but the reads FAILED rather than being refused. */
function stubUnavailableLibrary() {
  stubWorkspace((section) => ({
    status: "unavailable",
    errorCode: `${section}_failed`,
    observedAt: "2026-08-26T00:00:00.000Z",
    section,
  }));
}

function stubWorkspace(
  librarySection: (section: string) => Record<string, unknown>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/launchpad/meta/workspace"))
        return {
          ok: true,
          json: async () => ({
            ok: true,
            accounts: ASSIGNED_ACCOUNTS,
            sections: {
              accounts: SECTION_READ,
              ...Object.fromEntries(
                [
                  "templates",
                  "recentTemplates",
                  "drafts",
                  "intents",
                  "recentAdActions",
                  "targetCpa",
                ].map((section) => [section, librarySection(section)]),
              ),
            },
          }),
        };
      return { ok: true, json: async () => ({}) };
    }),
  );
}

/** Opens the manual wizard, where the write controls live. */
async function openManualWizard() {
  const start = await screen.findByTestId("launchpad-start-manual");
  fireEvent.click(start.querySelector("button")!);
  return screen.findByRole("button", { name: /Save template/ });
}

describe("the legacy mount holds writes it cannot authorize", () => {
  // LAW: a fact nobody forwards is not permission. The legacy mount forwards
  // no viewer, so `LAUNCHPAD_VIEWER_NOT_ESTABLISHED` applies, and it now
  // refuses. Restating a refusal the routes already hold is not the same as
  // inventing one — `requireLaunchpadBusinessAccess` demands `collaborator` and
  // `rejectIfLaunchpadDemoWrite` refuses a demo workspace regardless of what
  // this surface renders.
  it("renders Save template disabled with the reason, not active", async () => {
    stubReadableLibrary();
    render(<MetaLaunchpadPage businessId="biz_1" providerAccountId="act_1" />);

    const saveTemplate = await openManualWizard();

    expect(saveTemplate).toHaveProperty("disabled", true);
    expect(saveTemplate.getAttribute("title")).toContain(
      "did not establish who is looking",
    );
  });

  // The control stays on screen. Fail-closed here means "disabled with a
  // reason", not "removed" — a control that vanishes explains nothing, and
  // removing it would be a layout change this surface is not allowed to make.
  it("keeps the control rendered rather than hiding it", async () => {
    stubReadableLibrary();
    render(<MetaLaunchpadPage businessId="biz_1" providerAccountId="act_1" />);

    const saveTemplate = await openManualWizard();

    expect(saveTemplate).toBeTruthy();
    expect(saveTemplate.textContent).toContain("Save template");
  });

  // A server-resolved viewer still wins: this is a fallback for an absent
  // envelope, never an override of a present one.
  it("does not hold writes when the server did resolve a collaborator", async () => {
    stubReadableLibrary();
    const { buildLaunchpadViewerEnvelope } = await import("./viewer-envelope");
    render(
      <MetaLaunchpadPage
        businessId="biz_1"
        providerAccountId="act_1"
        viewer={buildLaunchpadViewerEnvelope({
          role: "collaborator",
          reviewerReadOnly: false,
          writeAuthority: "live",
        })}
      />,
    );

    const saveTemplate = await openManualWizard();

    expect(saveTemplate.getAttribute("title") ?? "").not.toContain(
      "did not establish who is looking",
    );
  });
});

describe("a library that was not read is not a library that is empty", () => {
  // LAW: missing or unreadable data must never become 0 or success. A MEASURED
  // zero stays 0 — that distinction is the point.
  //
  // `readLaunchpadJson` returned `null` for every non-OK response and `null`
  // flows into `isLaunchpadArrayPayload`, which answers `[]`. And 403 is the
  // ORDINARY answer for a guest here, not an edge case: all four library GETs
  // go through `requireLaunchpadBusinessAccess`, hardcoded to
  // `minRole: "collaborator"` (app/api/launchpad/meta/route-utils.ts line 49).
  // There is no guest-read contract for drafts, templates or intents — so a
  // guest was shown the same em dashes a genuinely empty account shows.
  it("says the library was refused instead of showing an empty table", async () => {
    stubRefusedLibrary();
    render(<MetaLaunchpadPage businessId="biz_1" providerAccountId="act_1" />);

    const empty = await screen.findByTestId("launchpad-draft-empty");
    await waitFor(() => {
      expect(empty.getAttribute("data-unread")).toBe("true");
    });
    expect(empty.textContent).toContain(LAUNCHPAD_LIBRARY_REFUSED_MESSAGE);
  });

  // A 5xx is not a refusal and must not be reported as one — the operator is
  // told the read failed, not that they lack access.
  it("distinguishes an unavailable read from a refused one", async () => {
    stubUnavailableLibrary();
    render(<MetaLaunchpadPage businessId="biz_1" providerAccountId="act_1" />);

    const empty = await screen.findByTestId("launchpad-draft-empty");
    await waitFor(() => {
      expect(empty.getAttribute("data-unread")).toBe("true");
    });
    expect(empty.textContent).toContain(LAUNCHPAD_LIBRARY_UNAVAILABLE_MESSAGE);
  });

  // The other half of the law: a read that ANSWERED with nothing still means
  // nothing. An account with no drafts must keep looking like an account with
  // no drafts, not like a failure.
  it("leaves a measured empty library alone", async () => {
    stubReadableLibrary();
    render(<MetaLaunchpadPage businessId="biz_1" providerAccountId="act_1" />);

    const empty = await screen.findByTestId("launchpad-draft-empty");
    await waitFor(() => {
      expect(empty.getAttribute("data-unread")).toBeNull();
    });
    expect(empty.textContent).not.toContain("not readable");
    expect(empty.textContent).not.toContain("could not be read");
  });
});
