import { describe, expect, it } from "vitest";

import {
  DEMO_BUSINESS_COPY,
  PUBLIC_LANGUAGE_SELECTOR_LIMITATION,
  REVIEWER_READ_ONLY_COPY,
  inviteStateCopy,
  inviteStateFromResponse,
  loginFailureCopy,
  loginFailureFromResponse,
  oauthCallbackCopy,
  oauthCallbackErrorFrom,
  resetDeliveryCopy,
  resetDeliveryFromResponse,
  type InviteState,
} from "@/lib/zero-base/auth-states";

/**
 * These pin the mapping to what `/api/invite/[token]` actually returns. The
 * five states are the server's vocabulary, not the UI's invention, so a change
 * on either side has to be a deliberate change to both.
 */
const SERVER_INVITE_OUTCOMES = [
  { status: 401, code: "login_required", state: "login_required" },
  { status: 403, code: "email_mismatch", state: "email_mismatch" },
  { status: 409, code: "invite_closed", state: "invite_closed" },
  { status: 410, code: "invite_expired", state: "invite_expired" },
  { status: 200, code: null, state: "accepted" },
] as const;

describe("the five invite states", () => {
  it("maps every outcome the invite endpoint produces", () => {
    for (const outcome of SERVER_INVITE_OUTCOMES) {
      expect(
        inviteStateFromResponse({ status: outcome.status, code: outcome.code }),
        outcome.code ?? String(outcome.status),
      ).toBe(outcome.state);
    }
    expect(SERVER_INVITE_OUTCOMES).toHaveLength(5);
  });

  it("prefers the server's code over the status", () => {
    // A shared status must not collapse two distinct outcomes.
    expect(inviteStateFromResponse({ status: 400, code: "invite_expired" })).toBe("invite_expired");
    expect(inviteStateFromResponse({ status: 500, code: "login_required" })).toBe("login_required");
  });

  it("falls back to the status when no code is present", () => {
    expect(inviteStateFromResponse({ status: 409 })).toBe("invite_closed");
    expect(inviteStateFromResponse({ status: 404 })).toBe("not_found");
    expect(inviteStateFromResponse({ status: 418 })).toBe("not_found");
  });

  it("gives each state its own distinct copy — no shared 'invalid or expired'", () => {
    const states: InviteState[] = [
      "acceptable",
      "login_required",
      "email_mismatch",
      "invite_closed",
      "invite_expired",
      "not_found",
      "accepted",
    ];
    const titles = states.map((state) => inviteStateCopy(state).title);
    expect(new Set(titles).size).toBe(states.length);
    for (const title of titles) expect(title).not.toMatch(/invalid or expired/i);
  });

  it("routes login_required back to the invite after logging in", () => {
    const copy = inviteStateCopy("login_required", { token: "tok_1" });
    expect(copy.action?.href).toBe("/login?next=%2Finvite%2Ftok_1");
  });

  it("names both addresses on a mismatch so the user can see the conflict", () => {
    const copy = inviteStateCopy("email_mismatch", {
      invitedEmail: "ada@example.com",
      signedInEmail: "bob@example.com",
    });
    expect(copy.body).toContain("ada@example.com");
    expect(copy.body).toContain("bob@example.com");
    expect(copy.action?.href).toBe("/logout");
  });

  it("offers no dead action where nothing can be done", () => {
    for (const state of ["invite_closed", "invite_expired", "not_found"] as const) {
      expect(inviteStateCopy(state).action, state).toBeNull();
    }
  });
});

describe("login failure states", () => {
  it("distinguishes validation, credentials, rate limiting and offline", () => {
    expect(loginFailureFromResponse({ status: 400 })).toBe("field_validation");
    expect(loginFailureFromResponse({ status: 401 })).toBe("invalid_credentials");
    expect(loginFailureFromResponse({ status: 429 })).toBe("rate_limited");
    expect(loginFailureFromResponse({ networkError: true })).toBe("offline");
    expect(loginFailureFromResponse({ status: 500 })).toBe("server_error");
  });

  it("treats a network error as offline regardless of any status", () => {
    expect(loginFailureFromResponse({ status: 401, networkError: true })).toBe("offline");
  });

  it("does not reveal whether an account exists for the address", () => {
    const copy = loginFailureCopy("invalid_credentials");
    expect(copy).not.toMatch(/no account|not found|wrong password|unknown email/i);
    expect(copy).toMatch(/did not match/i);
  });

  it("says nothing was submitted when offline", () => {
    expect(loginFailureCopy("offline")).toMatch(/nothing was submitted/i);
  });

  it("includes the retry window when the server supplies one", () => {
    expect(loginFailureCopy("rate_limited", 30)).toContain("30 seconds");
    expect(loginFailureCopy("rate_limited", null)).toMatch(/wait a moment/i);
  });

  it("gives every state its own copy", () => {
    const copies = (
      ["field_validation", "invalid_credentials", "rate_limited", "offline", "server_error"] as const
    ).map((state) => loginFailureCopy(state));
    expect(new Set(copies).size).toBe(5);
  });
});

describe("reset delivery", () => {
  it("separates 'sent' from 'could not send'", () => {
    expect(resetDeliveryFromResponse({ status: 200 })).toBe("sent");
    expect(resetDeliveryFromResponse({ status: 500 })).toBe("delivery_unavailable");
    expect(resetDeliveryFromResponse({ code: "delivery_unavailable" })).toBe("delivery_unavailable");
    expect(resetDeliveryFromResponse({ networkError: true })).toBe("delivery_unavailable");
  });

  it("tells the user the mail never left, rather than reassuring them", () => {
    const failed = resetDeliveryCopy("delivery_unavailable");
    expect(failed).toMatch(/could not send/i);
    expect(failed).toMatch(/our side/i);
    // The happy path keeps the account-existence-neutral wording.
    expect(resetDeliveryCopy("sent")).toMatch(/if an account exists/i);
  });
});

describe("OAuth callback", () => {
  it("returns null on a successful return so no error panel can render", () => {
    expect(oauthCallbackErrorFrom(new URLSearchParams("shop=acme.myshopify.com"), "Shopify")).toBeNull();
  });

  it("reads the provider's code and description verbatim", () => {
    const error = oauthCallbackErrorFrom(
      new URLSearchParams("error=access_denied&error_description=The+merchant+declined"),
      "Shopify",
    );
    expect(error).toEqual({
      provider: "Shopify",
      code: "access_denied",
      description: "The merchant declined",
    });
  });

  it("accepts the alternate parameter names providers use", () => {
    const error = oauthCallbackErrorFrom(
      new URLSearchParams("error_code=190&error_reason=token_expired"),
      "Meta",
    );
    expect(error?.code).toBe("190");
    expect(error?.description).toBe("token_expired");
  });

  it("states that nothing was linked", () => {
    const copy = oauthCallbackCopy({ provider: "Shopify", code: "access_denied", description: null });
    expect(copy.body).toMatch(/nothing was linked/i);
  });
});

describe("honest limitations and posture", () => {
  it("does not claim the public language selector works", () => {
    expect(PUBLIC_LANGUAGE_SELECTOR_LIMITATION).toMatch(/not active yet/i);
    expect(PUBLIC_LANGUAGE_SELECTOR_LIMITATION).toMatch(/still renders in English/i);
  });

  it("tells a reviewer that nothing reaches a provider", () => {
    expect(REVIEWER_READ_ONLY_COPY).toMatch(/read-only/i);
    expect(REVIEWER_READ_ONLY_COPY).toMatch(/no change .* will reach a provider/i);
  });

  it("tells a demo viewer the data is not a live account", () => {
    expect(DEMO_BUSINESS_COPY).toMatch(/not connected to a live ad account/i);
  });
});
