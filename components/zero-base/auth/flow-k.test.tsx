// @vitest-environment jsdom

/**
 * Flow K, exercised through the real components.
 *
 * Covers the arc the plan names — signup/login → invite states → first
 * business → OAuth return → canonical Home — plus the two properties that are
 * easy to claim and hard to keep: rollout OFF renders the legacy frame
 * byte-for-byte, and `next` never becomes an open redirect or a way to reach
 * another tenant.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { AuthSurface } from "@/components/auth/auth-surface";
import { ZeroBaseRolloutProvider } from "@/components/zero-base/rollout-provider";
import {
  InviteStatePanel,
  LoginFailurePanel,
  OAuthCallbackErrorPanel,
  PostureNotice,
  ResetDeliveryPanel,
} from "@/components/zero-base/auth/auth-states";
import { USER_MENU_ITEMS } from "@/components/zero-base/shell/user-menu";
import {
  inviteStateFromResponse,
  oauthCallbackErrorFrom,
  REVIEWER_READ_ONLY_COPY,
} from "@/lib/zero-base/auth-states";
import { resolveCanonicalPostLoginDestination } from "@/lib/zero-base/auth-routing";
import { ZERO_BASE_ROOT_ATTRIBUTE } from "@/lib/design/ledger-tokens";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

afterEach(cleanup);

function renderSurface(canonical: boolean, children: React.ReactNode = <p>body</p>) {
  return render(
    <ZeroBaseRolloutProvider value={{ canonical }}>
      <AuthSurface title="Sign in" description="Welcome back" eyebrow="Account">
        {children}
      </AuthSurface>
    </ZeroBaseRolloutProvider>,
  );
}

describe("rollout OFF preserves the legacy auth composition", () => {
  it("renders the legacy frame and no canonical root", () => {
    const { container } = renderSurface(false);
    expect(container.querySelector(".ad-auth-page")).not.toBeNull();
    expect(container.querySelector(".ad-auth-card")).not.toBeNull();
    expect(container.querySelector(`[${ZERO_BASE_ROOT_ATTRIBUTE}]`)).toBeNull();
  });

  it("defaults to legacy when no provider wraps the tree", () => {
    // An unwrapped auth page must not silently adopt canonical chrome.
    const { container } = render(
      <AuthSurface title="Sign in">
        <p>body</p>
      </AuthSurface>,
    );
    expect(container.querySelector(".ad-auth-page")).not.toBeNull();
    expect(container.querySelector(`[${ZERO_BASE_ROOT_ATTRIBUTE}]`)).toBeNull();
  });
});

describe("rollout ON renders the canonical auth composition", () => {
  it("wraps the screen in the canonical root and drops the legacy classes", () => {
    const { container } = renderSurface(true);
    expect(container.querySelector(`[${ZERO_BASE_ROOT_ATTRIBUTE}="zero-base"]`)).not.toBeNull();
    expect(container.querySelector(".ad-auth-page")).toBeNull();
  });

  it("keeps the route home and the page content unchanged", () => {
    renderSurface(true, <p>form body</p>);
    expect(screen.getByRole("link", { name: "Adsecute home" })).toHaveAttribute("href", "/");
    expect(screen.getByText("form body")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  it("provides a portal host, so a dialog on an auth screen is scoped", () => {
    const { container } = renderSurface(true);
    expect(container.querySelector(".adc-portal-host")).not.toBeNull();
  });
});

describe("Flow K — invite states", () => {
  it("renders each of the five server outcomes distinctly", () => {
    const outcomes = [
      { status: 401, code: "login_required" },
      { status: 403, code: "email_mismatch" },
      { status: 409, code: "invite_closed" },
      { status: 410, code: "invite_expired" },
      { status: 200, code: null },
    ];
    const titles = new Set<string>();
    for (const outcome of outcomes) {
      cleanup();
      const state = inviteStateFromResponse(outcome);
      render(<InviteStatePanel state={state} token="tok_1" invitedEmail="ada@example.com" />);
      const panel = document.querySelector(`[data-invite-state="${state}"]`);
      expect(panel, state).not.toBeNull();
      titles.add(panel!.querySelector("p")!.textContent ?? "");
    }
    expect(titles.size).toBe(5);
  });

  it("offers login as the next step when an account already exists", () => {
    render(<InviteStatePanel state="login_required" token="tok_1" invitedEmail="ada@example.com" />);
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute(
      "href",
      "/login?next=%2Finvite%2Ftok_1",
    );
  });

  it("renders no action for a closed or expired invite", () => {
    for (const state of ["invite_closed", "invite_expired"] as const) {
      cleanup();
      render(<InviteStatePanel state={state} token="tok_1" />);
      expect(document.querySelector("[data-invite-action]"), state).toBeNull();
    }
  });
});

describe("Flow K — first business, then canonical Home", () => {
  it("sends a brand-new account to create its first business", () => {
    expect(resolveCanonicalPostLoginDestination({ businesses: [] })).toBe("/businesses/new");
  });

  it("lands on canonical Home once one active business exists", () => {
    expect(
      resolveCanonicalPostLoginDestination({
        businesses: [{ id: "biz_1", membershipStatus: "active" }],
      }),
    ).toBe("/app/home");
  });

  it("holds an invited-only account at select-business", () => {
    expect(
      resolveCanonicalPostLoginDestination({
        businesses: [{ id: "biz_1", membershipStatus: "invited" }],
      }),
    ).toBe("/select-business");
  });

  it("sends a multi-client account to the Agency desk", () => {
    expect(
      resolveCanonicalPostLoginDestination({
        businesses: [
          { id: "biz_1", membershipStatus: "active" },
          { id: "biz_2", membershipStatus: "active" },
        ],
      }),
    ).toBe("/a/desk");
  });

  it("never follows a next that escapes the site or reaches another tenant", () => {
    const businesses = [{ id: "biz_1", membershipStatus: "active" as const }];
    for (const next of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/c/biz_other/home",
      "/ops",
    ]) {
      expect(resolveCanonicalPostLoginDestination({ businesses, next }), next).toBe("/app/home");
    }
  });
});

describe("Flow K — OAuth return", () => {
  it("renders the provider's refusal verbatim and says nothing was linked", () => {
    const error = oauthCallbackErrorFrom(
      new URLSearchParams("error=access_denied&error_description=Merchant+declined"),
      "Shopify",
    )!;
    render(<OAuthCallbackErrorPanel error={error} />);
    const panel = screen.getByRole("alert");
    expect(within(panel).getByText(/nothing was linked/i)).toBeVisible();
    expect(within(panel).getByText(/access_denied — Merchant declined/)).toBeVisible();
  });
});

describe("required auth states render", () => {
  it("shows a login failure as an alert", () => {
    render(<LoginFailurePanel state="rate_limited" retryAfterSeconds={30} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Try again in 30 seconds.");
  });

  it("shows reset delivery failure as its own state", () => {
    render(<ResetDeliveryPanel state="delivery_unavailable" />);
    expect(document.querySelector('[data-reset-delivery="delivery_unavailable"]')).not.toBeNull();
  });

  it("states reviewer posture", () => {
    render(<PostureNotice text={REVIEWER_READ_ONLY_COPY} />);
    expect(screen.getByText(REVIEWER_READ_ONLY_COPY)).toBeVisible();
  });
});

describe("canonical user menu", () => {
  it("exposes only profile, language, theme and logout", () => {
    expect([...USER_MENU_ITEMS]).toEqual(["profile", "language", "theme", "logout"]);
  });
});
