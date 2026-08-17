// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { buildDefaultProviderDomains } from "@/store/integrations-support";

const routing = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

const appState = vi.hoisted(() => ({ selectedBusinessId: "biz_1" as string | null }));

const integrationsState = vi.hoisted(() => ({
  domainsByBusinessId: {} as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
  notFound: routing.notFound,
  redirect: routing.redirect,
}));

vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: vi.fn(),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));

vi.mock("@/store/integrations-store", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/store/integrations-store",
  );
  return {
    ...actual,
    useIntegrationsStore: (selector: (state: typeof integrationsState) => unknown) =>
      selector(integrationsState),
  };
});

vi.mock("@/hooks/use-business-integrations-bootstrap", () => ({
  useBusinessIntegrationsBootstrap: () => ({ isBootstrapping: false }),
}));

const PlatformsKlaviyoPage = (
  await import("@/app/(dashboard)/platforms/klaviyo/page")
).default;
const BusinessKlaviyoPage = (await import("@/app/c/[businessId]/klaviyo/page"))
  .default;
const auth = await import("@/lib/auth");
const access = await import("@/lib/access/require-business-page-context");

beforeEach(() => {
  vi.clearAllMocks();
  integrationsState.domainsByBusinessId = { biz_1: buildDefaultProviderDomains() };
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue({
    sessionId: "session_1",
    activeBusinessId: "biz_1",
  } as never);
  vi.mocked(access.requireBusinessPageContext).mockResolvedValue({
    kind: "ok",
    context: { role: "owner" },
  } as never);
});

afterEach(() => cleanup());

function expectKlaviyoScreen() {
  expect(screen.getByRole("heading", { level: 1, name: "Lifecycle" })).toBeTruthy();
  expect(screen.getByText("BETA — read-only analysis")).toBeTruthy();
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Flows",
    "Campaigns",
    "Templates",
    "Segments",
  ]);
}

describe("Klaviyo route family", () => {
  it("renders the one exact screen at /platforms/klaviyo", () => {
    render(<PlatformsKlaviyoPage />);
    expectKlaviyoScreen();
  });

  it("renders the same exact screen at /c/{businessId}/klaviyo", async () => {
    const element = await BusinessKlaviyoPage({
      params: Promise.resolve({ businessId: "biz_1" }),
    });
    render(element);
    expectKlaviyoScreen();
  });

  it("keeps the business-scoped twin behind session and access checks", async () => {
    vi.mocked(auth.getSessionFromCookies).mockResolvedValue(null as never);
    await expect(
      BusinessKlaviyoPage({ params: Promise.resolve({ businessId: "biz_1" }) }),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    vi.mocked(auth.getSessionFromCookies).mockResolvedValue({
      sessionId: "session_1",
      activeBusinessId: "biz_1",
    } as never);
    vi.mocked(access.requireBusinessPageContext).mockResolvedValue({
      kind: "forbidden",
    } as never);
    await expect(
      BusinessKlaviyoPage({ params: Promise.resolve({ businessId: "biz_1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows an em-dash row rather than seeded flow names", () => {
    const { container } = render(<PlatformsKlaviyoPage />);
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(
      Array.from(rows[0]!.querySelectorAll("td")).map((cell) => cell.textContent),
    ).toEqual(["—", "—", "—", "—", "—"]);
    expect(container.textContent).not.toContain("Welcome Series");
    expect(container.textContent).not.toContain("Abandoned Cart");
  });
});
