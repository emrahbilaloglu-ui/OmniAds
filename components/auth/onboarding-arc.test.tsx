// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * This test deliberately uses the REAL zustand stores.
 *
 * The defect it pins is not about what the arc renders -- it is about how it
 * subscribes. `getProviderViewState` builds a fresh object on every call, and
 * zustand 5 passes the selector straight to `useSyncExternalStore`, which
 * compares snapshots by identity. Calling a deriving getter inside the selector
 * therefore reports a changed store on every render and loops until React gives
 * up with "Maximum update depth exceeded". A mocked store returns whatever the
 * mock returns and cannot see that, which is why this file mocks nothing.
 *
 * The arc renders on /select-business, /businesses/new, /login and /signup, so
 * the loop takes out the surfaces an operator needs in order to recover.
 */

import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { AuthOnboardingArc } from "@/components/auth/onboarding-arc";

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function selectBusiness() {
  useAppStore.setState({
    selectedBusinessId: BUSINESS_ID,
    businesses: [{ id: BUSINESS_ID, name: "Aurora", currency: "USD" }],
  } as never);
}

describe("AuthOnboardingArc subscribes without re-rendering itself to death", () => {
  it("renders with a business selected", () => {
    selectBusiness();

    // React reports the loop by throwing during render; console.error carries
    // the same message. Failing on either means a silent regression cannot pass
    // by rendering an empty tree.
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const { container } = render(<AuthOnboardingArc />);
    expect(errors.join("\n")).not.toContain("Maximum update depth exceeded");
    // All four arc steps render, so a regression cannot pass by mounting an
    // empty tree that simply never loops.
    expect(container.querySelectorAll(".ad-auth-step-card")).toHaveLength(4);
    expect(screen.getByText("Aurora · USD")).toBeTruthy();
  });

  it("renders with a business selected and provider domains present", () => {
    selectBusiness();
    useIntegrationsStore.setState({
      domainsByBusinessId: {
        [BUSINESS_ID]: undefined,
      },
    } as never);

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    expect(() => render(<AuthOnboardingArc compact />)).not.toThrow();
    expect(errors.join("\n")).not.toContain("Maximum update depth exceeded");
  });

  it("renders with no business selected", () => {
    useAppStore.setState({ selectedBusinessId: null, businesses: [] } as never);

    expect(() => render(<AuthOnboardingArc />)).not.toThrow();
  });
});
