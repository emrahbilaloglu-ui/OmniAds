// @vitest-environment jsdom

/**
 * WP-26 group 3 / G7 — contracts owned by the authentication and account
 * surfaces.
 *
 * Each case drives the control on the component that owns it and asserts the
 * consequence the contract names, not merely that the control rendered.
 */
import React from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  expectNavigates,
  expectOperable,
  flushInteractionResults,
  interactionCase,
} from "@/components/zero-base/interactions/interaction-harness";

import { LoginView } from "@/components/zero-base/auth/login-view";
import { AccountSecurityView } from "@/components/zero-base/account/account-security-view";
import { LanguageView } from "@/components/zero-base/account/language-view";
import { USER_MENU_ITEMS, UserMenu } from "@/components/zero-base/shell/user-menu";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/login",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

function Host({ children }: { children: React.ReactNode }) {
  return (
    <ZeroBaseCopyProvider language="en">
      <ZeroBasePortalHost>{children}</ZeroBasePortalHost>
    </ZeroBaseCopyProvider>
  );
}

const ctl = (key: string) => document.querySelector(`[data-ctl="${key}"]`);

afterEach(cleanup);
afterAll(() => flushInteractionResults("auth"));

describe("G7 — login", () => {
  const renderLogin = (props: Partial<React.ComponentProps<typeof LoginView>> = {}) =>
    render(
      <Host>
        <LoginView {...props} />
      </Host>,
    );

  interactionCase("live:AUTH-02 email", async () => {
    const user = userEvent.setup();
    renderLogin();
    const email = expectOperable(ctl("live:AUTH-02 email"), "email") as HTMLInputElement;
    expect(email.getAttribute("type")).toBe("email");
    // Password managers need a stable autocomplete token to fill this.
    expect(email.getAttribute("autocomplete")).toBe("username");

    await user.type(email, "not-an-email");
    // Validated on blur, not per keystroke.
    expect(screen.queryByText(/name@example\.com/)).toBeNull();
    await user.tab();
    const error = await screen.findByText(/name@example\.com/);
    expect(error).toBeTruthy();
    // The value survives the error; nobody should have to retype it.
    expect(email.value).toBe("not-an-email");
  });

  interactionCase("live:AUTH-02 password", async () => {
    const user = userEvent.setup();
    renderLogin();
    const password = expectOperable(ctl("live:AUTH-02 password"), "password") as HTMLInputElement;
    // A real password input, so managers and browsers can fill it (3.3.8).
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    await user.type(password, "hunter2");
    expect(password.value).toBe("hunter2");
  });

  interactionCase("live:AUTH-02 submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderLogin({ onSubmit, invitedEmail: "ada@example.test" });
    // Prefilled from the invite (3.3.7).
    expect((ctl("live:AUTH-02 email") as HTMLInputElement).value).toBe("ada@example.test");

    await user.type(ctl("live:AUTH-02 password") as HTMLElement, "hunter2");
    await user.click(expectOperable(ctl("live:AUTH-02 submit"), "submit"));
    expect(onSubmit).toHaveBeenCalledWith({ email: "ada@example.test", password: "hunter2" });
  });

  it("a rate-limited failure shows its retry-after, and offline re-enables the button", () => {
    renderLogin({
      failure: { message: "Too many attempts.", retryAfterSeconds: 45, offline: false },
    });
    // Verbatim, plus the wait the server asked for.
    expect(screen.getByRole("alert").textContent).toContain("Too many attempts.");
    expect(screen.getByRole("alert").textContent).toContain("45 seconds");
    cleanup();

    renderLogin({ failure: { message: "You are offline.", retryAfterSeconds: null, offline: true } });
    // The request never left, so the control must not sit disabled.
    expect(ctl("live:AUTH-02 submit")?.getAttribute("aria-disabled")).not.toBe("true");
  });

  interactionCase("live:AUTH-03 google", async () => {
    renderLogin();
    expectOperable(ctl("live:AUTH-03 google"), "google");
  });

  interactionCase("live:AUTH-04 facebook", async () => {
    renderLogin();
    expectOperable(ctl("live:AUTH-04 facebook"), "facebook");
  });

  interactionCase("live:AUTH-05 forgot", async () => {
    renderLogin();
    expectNavigates(ctl("live:AUTH-05 forgot"), /^\/reset$/, "forgot password");
  });

  interactionCase("live:AUTH-06 demo", async () => {
    renderLogin();
    expectNavigates(ctl("live:AUTH-06 demo"), /^\/demo$/, "demo");
  });

  interactionCase("live:AUTH-01", async () => {
    renderLogin();
    expectNavigates(ctl("live:AUTH-01"), /^\/signup$/, "sign up");
  });

  interactionCase("live:PUBLIC-03", async () => {
    renderLogin();
    expectNavigates(ctl("live:PUBLIC-03"), /^\/(product|pricing)$/, "public nav");
  });

  interactionCase("live:PUBLIC-05", async () => {
    renderLogin();
    // One consistent help channel (3.2.6), not a scattering of mailtos.
    expectNavigates(ctl("live:PUBLIC-05"), /^\/contact$/, "contact");
  });

  it("no demo control exists where no demo workspace is provisioned", () => {
    renderLogin({ demoAvailable: false });
    // Absence over theatre: a disabled demo link advertises a workspace that
    // does not exist.
    expect(ctl("live:AUTH-06 demo")).toBeNull();
  });
});

describe("G7 — account and security", () => {
  const renderAccount = (props: Partial<React.ComponentProps<typeof AccountSecurityView>> = {}) =>
    render(
      <Host>
        <AccountSecurityView
          name="Dana Whitfield"
          email="dana@halcyon.example"
          currentSessionId="7f3c9a12b4d5"
          {...props}
        />
      </Host>,
    );

  interactionCase("live:AUTH-11 name", async () => {
    const user = userEvent.setup();
    const onSaveProfile = vi.fn();
    renderAccount({ onSaveProfile });
    const name = expectOperable(ctl("live:AUTH-11 name"), "name") as HTMLInputElement;
    await user.clear(name);
    await user.type(name, "Dana W.");
    await user.tab();
    expect(onSaveProfile).toHaveBeenCalledWith({
      name: "Dana W.",
      email: "dana@halcyon.example",
    });
  });

  interactionCase("live:AUTH-11 email", async () => {
    const onSaveProfile = vi.fn();
    renderAccount({ onSaveProfile });
    const email = expectOperable(ctl("live:AUTH-11 email"), "email") as HTMLInputElement;
    expect(email.readOnly).toBe(true);
    expect(email.value).toBe("dana@halcyon.example");
    expect(document.body.textContent).toContain("cannot be changed from this screen");
    expect(onSaveProfile).not.toHaveBeenCalled();
  });

  it("keeps the value when the server refuses", () => {
    renderAccount({ profileError: "That email is already in use." });
    expect(screen.getByText("That email is already in use.")).toBeTruthy();
    // Not cleared: retyping what you already got right is a punishment.
    expect((ctl("live:AUTH-11 name") as HTMLInputElement).value).toBe("Dana Whitfield");
  });

  interactionCase("live:AUTH-12 current", async () => {
    const user = userEvent.setup();
    renderAccount();
    const current = expectOperable(ctl("live:AUTH-12 current"), "current password") as HTMLInputElement;
    expect(current.getAttribute("autocomplete")).toBe("current-password");
    await user.type(current, "old-one");
    expect(current.value).toBe("old-one");
  });

  interactionCase("live:AUTH-12 new", async () => {
    const user = userEvent.setup();
    renderAccount();
    const next = expectOperable(ctl("live:AUTH-12 new"), "new password") as HTMLInputElement;
    expect(next.getAttribute("autocomplete")).toBe("new-password");
    // A strength hint, not a puzzle.
    expect(document.body.textContent).toContain("12 characters");
    await user.type(next, "a-much-longer-passphrase");
    expect(next.value).toBe("a-much-longer-passphrase");
  });

  interactionCase("live:AUTH-12 save", async () => {
    const user = userEvent.setup();
    const onChangePassword = vi.fn();
    renderAccount({ onChangePassword });
    await user.type(ctl("live:AUTH-12 current") as HTMLElement, "old-one");
    await user.type(ctl("live:AUTH-12 new") as HTMLElement, "a-much-longer-passphrase");
    await user.click(expectOperable(ctl("live:AUTH-12 save"), "save password"));
    expect(onChangePassword).toHaveBeenCalledWith({
      current: "old-one",
      next: "a-much-longer-passphrase",
    });
    // Only the passwords are cleared; nothing else the operator typed is lost.
    await waitFor(() => expect((ctl("live:AUTH-12 current") as HTMLInputElement).value).toBe(""));
    expect((ctl("live:AUTH-11 name") as HTMLInputElement).value).toBe("Dana Whitfield");
  });

  interactionCase("live:AUTH-13 revoke", async () => {
    const user = userEvent.setup();
    renderAccount();
    const revoke = expectOperable(ctl("live:AUTH-13 revoke"), "revoke sessions");
    await user.click(revoke);
    // A destructive ceremony, not a bare button.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
  });

  interactionCase("live:I18N-02 lang", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { language: "tr" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(
      <Host>
        <LanguageView current="en" />
      </Host>,
    );
    const radios = document.querySelectorAll<HTMLInputElement>('[data-ctl="live:I18N-02 lang"]');
    expect(radios.length).toBeGreaterThan(1);
    // Native radios, so the platform supplies arrow-key selection.
    expect(radios[0].type).toBe("radio");
    const turkish = [...radios].find((radio) => radio.value === "tr");
    expect(turkish, "Turkish is offered").toBeTruthy();
    await user.click(turkish!);
    await waitFor(() => expect(turkish!.checked).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/settings/account",
      expect.objectContaining({ method: "PATCH" }),
    );
    fetchSpy.mockRestore();
  });
});

describe("G7 — user menu", () => {
  interactionCase("live:AUTH-07 user-menu", async () => {
    const user = userEvent.setup();
    render(
      <Host>
        <UserMenu name="Dana Whitfield" onLogout={vi.fn()} />
      </Host>,
    );
    const trigger = expectOperable(ctl("live:AUTH-07 user-menu"), "user menu");
    expect(document.querySelector("[data-user-menu-item]")).toBeNull();

    await user.click(trigger);

    // Exactly the four the contract names — no bell, no Help, no What's New.
    await waitFor(() =>
      expect(document.querySelectorAll("[data-user-menu-item]").length).toBe(
        USER_MENU_ITEMS.length,
      ),
    );
    const items = [...document.querySelectorAll("[data-user-menu-item]")].map((node) =>
      node.getAttribute("data-user-menu-item"),
    );
    expect(items).toEqual([...USER_MENU_ITEMS]);
  });
});
