// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LaunchpadView } from "@/components/zero-base/launchpad/launchpad-view";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";

afterEach(cleanup);

const TEMPLATES = [{ id: "t1", name: "Prospecting template", createdAt: "2026-08-01" }];

function view(props: Partial<React.ComponentProps<typeof LaunchpadView>> = {}) {
  render(
    <ZeroBasePortalHost>
      <LaunchpadView templates={TEMPLATES} drafts={[]} findings={[]} {...props} />
    </ZeroBasePortalHost>,
  );
}

describe("execution is disabled with visible reasons", () => {
  it("disables both actions", () => {
    view();
    expect(document.querySelector('[data-launch-disabled="launch"]')).not.toBeNull();
    expect(document.querySelector('[data-launch-disabled="add_to_existing"]')).not.toBeNull();
  });

  it("shows every prerequisite, not just a bare Unavailable", () => {
    view();
    for (const id of ["rollback", "origin", "confirmation"]) {
      expect(document.querySelectorAll(`[data-prerequisite="${id}"]`).length).toBeGreaterThan(0);
    }
    // "Unavailable" with no reason teaches an operator the product is broken.
    expect(document.body.textContent).toMatch(/no rollback for that today/);
  });

  it("states what does not exist, including Google parity", () => {
    view();
    const text = document.querySelector("[data-what-does-not-exist]")!.textContent ?? "";
    expect(text).toMatch(/no rollback for a launch/);
    expect(text).toMatch(/no Google Launchpad/);
  });

  it("says plainly that nothing on the page changes Meta", () => {
    view();
    expect(document.querySelector("[data-what-works]")!.textContent).toMatch(
      /Nothing on this page creates, changes or launches/,
    );
  });
});

describe("templates", () => {
  it("offers duplicate and delete but no edit", () => {
    view();
    expect(document.querySelector('[data-template-duplicate="t1"]')).not.toBeNull();
    expect(document.querySelector('[data-template-delete="t1"]')).not.toBeNull();
    expect(document.querySelector('[data-template-edit="t1"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bEdit\b/);
  });

  it("says why a template cannot be edited", () => {
    view();
    expect(document.querySelector("[data-template-note]")!.textContent).toMatch(
      /Duplicate one to change it/,
    );
  });
});

describe("validation", () => {
  const findings = [
    { id: "1", field: "name", severity: "error" as const, message: "Ad name is required." },
    { id: "2", field: null, severity: "warning" as const, message: "Headline is long." },
  ];

  it("lists findings by severity", () => {
    view({ findings });
    expect(document.querySelectorAll('[data-finding="error"]').length).toBe(1);
    expect(document.querySelectorAll('[data-finding="warning"]').length).toBe(1);
  });

  it("moves focus to the first blocking field", async () => {
    view({ findings });
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-validation-focus="name"]') as HTMLElement);
    expect(document.activeElement).toBe(document.querySelector('[data-draft-field="name"]'));
  });

  it("says validation was clean rather than rendering nothing", () => {
    view();
    expect(document.querySelector('[data-validation="clean"]')).not.toBeNull();
  });
});

describe("bulk ad status is withheld with a reason", () => {
  it("renders no bulk control at all", () => {
    view();
    // Withheld even with the mutation flag on: this page cannot build the
    // handler's exact per-item contract, so a button could only 400.
    expect(document.querySelector("[data-bulk-apply]")).toBeNull();
    expect(document.querySelector("[data-bulk-candidates]")).toBeNull();
    expect(document.querySelector("[data-bulk-select]")).toBeNull();
  });

  it("states why, naming the missing exact contract", () => {
    view();
    const reason = document.querySelector("[data-bulk-withheld]")!.textContent ?? "";
    expect(reason).toMatch(/exact per-item ad and creative identity/);
    expect(reason).toMatch(/canonical action origin/);
  });

  it("lists the withholding among the things that do not work", () => {
    view();
    expect(document.querySelector("[data-what-does-not-exist]")!.textContent).toMatch(
      /Bulk ad status is not available from this page/,
    );
  });
});

describe("drafts and validation are really wired", () => {
  it("creates a draft with a name through the supplied handler", async () => {
    const onCreateDraft = vi.fn();
    view({ onCreateDraft });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New draft name"), "Spring test");
    await user.click(document.querySelector("[data-draft-create]") as HTMLElement);
    expect(onCreateDraft).toHaveBeenCalledWith("Spring test", { name: "Spring test" });
  });

  it("refuses to save a draft with no name", () => {
    view();
    const button = document.querySelector("[data-draft-create]") as HTMLButtonElement;
    expect(button.getAttribute("aria-disabled") ?? button.disabled).toBeTruthy();
  });

  it("says when no drafts exist rather than rendering nothing", () => {
    view();
    expect(document.querySelector('[data-drafts="empty"]')).not.toBeNull();
  });

  it("lists served drafts", () => {
    view({ drafts: [{ id: "d1", name: "Existing draft" }] });
    expect(document.querySelector('[data-draft="d1"]')!.textContent).toBe("Existing draft");
  });

  it("runs validation through the supplied handler", async () => {
    const onValidate = vi.fn();
    view({ onValidate });
    await userEvent.setup().click(document.querySelector("[data-validate-run]") as HTMLElement);
    expect(onValidate).toHaveBeenCalledTimes(1);
  });

  it("duplicates a template by name, since the API has no update", async () => {
    const onDuplicateTemplate = vi.fn();
    view({ onDuplicateTemplate });
    await userEvent.setup().click(document.querySelector('[data-template-duplicate="t1"]') as HTMLElement);
    expect(onDuplicateTemplate).toHaveBeenCalledWith("t1", "Prospecting template (copy)");
  });

  it("surfaces a failure verbatim", () => {
    view({ error: "Template name is required." });
    expect(document.querySelector("[data-launchpad-error]")!.textContent).toBe("Template name is required.");
  });
});
