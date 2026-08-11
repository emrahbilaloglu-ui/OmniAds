// @vitest-environment jsdom

/**
 * WP-05A behaviour proofs.
 *
 * These assert the things that are easy to claim and hard to keep: that a
 * disabled control is *discoverable* rather than merely dead, that overlays
 * land inside the canonical portal host instead of an unscoped body, and that
 * every state carries a word rather than only a colour.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button, IconButton } from "@/components/zero-base/primitives/button";
import { Checkbox, RadioGroup } from "@/components/zero-base/primitives/choice";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { ZeroBaseTabs } from "@/components/zero-base/primitives/tabs";
import { Combobox } from "@/components/zero-base/primitives/combobox";
import {
  ZeroBaseDialog,
  ZeroBaseMenu,
  ZeroBaseSheet,
} from "@/components/zero-base/primitives/overlays";
import {
  PORTAL_HOST_CLASS,
  ZeroBasePortalHost,
  isInsideCanonicalPortal,
} from "@/components/zero-base/portal/portal-host";
import { ZERO_BASE_ROOT_ATTRIBUTE, ZERO_BASE_ROOT_VALUE } from "@/lib/design/ledger-tokens";

afterEach(cleanup);

/** Mounts inside a canonical root with a portal host, as the shell will. */
function Canonical({ children }: { children: React.ReactNode }) {
  return (
    <div {...{ [ZERO_BASE_ROOT_ATTRIBUTE]: ZERO_BASE_ROOT_VALUE }}>
      <ZeroBasePortalHost>{children}</ZeroBasePortalHost>
    </div>
  );
}

describe("Button — disabled with reason", () => {
  it("stays focusable so the reason is discoverable by keyboard", async () => {
    const user = userEvent.setup();
    render(
      <Button state={{ kind: "disabled", reason: "Connect Meta to launch." }}>Launch</Button>,
    );
    const button = screen.getByRole("button", { name: "Launch" });

    // aria-disabled, NOT the disabled attribute: `disabled` removes the
    // control from the tab order, which hides the explanation entirely.
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("disabled");

    await user.tab();
    expect(button).toHaveFocus();
  });

  it("renders the reason inline and links it with aria-describedby", () => {
    render(<Button state={{ kind: "disabled", reason: "Connect Meta to launch." }}>Launch</Button>);
    const button = screen.getByRole("button", { name: "Launch" });
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reason = document.getElementById(describedBy!);
    expect(reason).toHaveTextContent("Connect Meta to launch.");
    // Inline, not a tooltip: unreachable by keyboard and invisible on touch.
    expect(reason).toBeVisible();
  });

  it("suppresses activation while disabled or busy", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(
      <Button state={{ kind: "disabled", reason: "Not yet." }} onClick={onClick}>
        Go
      </Button>,
    );
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).not.toHaveBeenCalled();

    rerender(
      <Button state={{ kind: "busy", label: "Working…" }} onClick={onClick}>
        Go
      </Button>,
    );
    await user.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();

    rerender(<Button onClick={onClick}>Go</Button>);
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("gives an icon button a real accessible name", () => {
    render(
      <IconButton label="Move left one column">
        <span aria-hidden="true">←</span>
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Move left one column" })).toBeTruthy();
  });
});

describe("TextInput", () => {
  it("uses a real label rather than a placeholder", () => {
    render(<TextInput label="Business name" placeholder="Acme" />);
    const input = screen.getByLabelText("Business name");
    expect(input.tagName).toBe("INPUT");
  });

  it("announces the verbatim error without stealing focus", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TextInput label="Daily budget" />);
    const input = screen.getByLabelText("Daily budget");
    await user.click(input);
    expect(input).toHaveFocus();

    rerender(<TextInput label="Daily budget" error="(#100) budget below minimum" />);
    // Focus stays where the user put it.
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-invalid", "true");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("(#100) budget below minimum");
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);
  });
});

describe("Checkbox and RadioGroup", () => {
  it("makes the whole label row the target", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Mark as applied" onChange={onChange} />);
    await user.click(screen.getByText("Mark as applied"));
    expect(onChange).toHaveBeenCalled();
  });

  it("keeps a disabled checkbox inert but explained", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Mark as applied" disabledReason="Decision is not settled yet." onChange={onChange} />);
    await user.click(screen.getByText("Mark as applied"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Decision is not settled yet.")).toBeVisible();
  });

  it("names the radio group and moves selection with the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RadioGroup
        legend="Lane"
        name="lane"
        value="act"
        onChange={onChange}
        options={[
          { value: "act", label: "Act now" },
          { value: "resolve", label: "Needs resolution" },
          { value: "monitor", label: "Monitoring" },
        ]}
      />,
    );
    const group = screen.getByRole("group", { name: "Lane" });
    expect(group).toBeTruthy();

    await user.click(screen.getByLabelText("Act now"));
    await user.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenCalledWith("resolve");
  });

  it("explains a per-option refusal beside that option", () => {
    render(
      <RadioGroup
        legend="Lane"
        name="lane"
        value="act"
        onChange={vi.fn()}
        options={[
          { value: "act", label: "Act now" },
          { value: "monitor", label: "Monitoring", disabledReason: "No monitored entities." },
        ]}
      />,
    );
    expect(screen.getByLabelText("Monitoring")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("No monitored entities.")).toBeVisible();
  });
});

describe("Tabs", () => {
  it("keeps an unavailable tab visible and shows a truth-state panel", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = React.useState("overview");
      return (
        <ZeroBaseTabs
          label="Meta"
          value={value}
          onValueChange={setValue}
          tabs={[
            { id: "overview", label: "Overview", content: <p>Overview body</p> },
            {
              id: "history",
              label: "History",
              content: <p>never rendered</p>,
              unavailableReason: "Serving history is not served at ad grain for this account.",
              code: "META-DEC-06",
            },
          ]}
        />
      );
    }
    render(<Harness />);

    // The tab is present, not hidden — hiding it would imply the capability
    // does not exist.
    const historyTab = screen.getByRole("tab", { name: "History" });
    expect(historyTab).toBeVisible();

    await user.click(historyTab);
    expect(screen.getByTestId("state-unavailable")).toHaveTextContent(
      "Serving history is not served at ad grain",
    );
    expect(screen.queryByText("never rendered")).toBeNull();
    expect(screen.getByText("META-DEC-06")).toBeVisible();
  });

  it("roves between tabs with arrow keys", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = React.useState("a");
      return (
        <ZeroBaseTabs
          label="Set"
          value={value}
          onValueChange={setValue}
          tabs={[
            { id: "a", label: "A", content: <p>A body</p> },
            { id: "b", label: "B", content: <p>B body</p> },
          ]}
        />
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("tab", { name: "A" }));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "B" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("overlays portal into the canonical host", () => {
  it("renders a dialog inside the portal host, never an unscoped body", async () => {
    render(
      <Canonical>
        <ZeroBaseDialog
          open
          onOpenChange={vi.fn()}
          title="Pause this ad?"
          description="Ad 2384 will stop delivering."
          confirmLabel="Pause"
          onConfirm={vi.fn()}
        />
      </Canonical>,
    );

    const dialog = await screen.findByRole("dialog");
    expect(isInsideCanonicalPortal(dialog)).toBe(true);
    // Directly under body would mean legacy :root variables, not Ledger ones.
    expect(dialog.parentElement).not.toBe(document.body);
    expect(document.querySelector(`.${PORTAL_HOST_CLASS}`)).toContainElement(dialog);
  });

  it("focuses the least destructive control when a dialog opens", async () => {
    render(
      <Canonical>
        <ZeroBaseDialog
          open
          onOpenChange={vi.fn()}
          title="Delete report?"
          confirmLabel="Delete"
          destructive
          onConfirm={vi.fn()}
        />
      </Canonical>,
    );
    const dialog = await screen.findByRole("dialog");
    // Enter on open must not destroy anything.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("keeps confirm disabled until the exact phrase is typed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <Canonical>
        <ZeroBaseDialog
          open
          onOpenChange={vi.fn()}
          title="Delete report?"
          confirmLabel="Delete"
          confirmPhrase="DELETE"
          destructive
          onConfirm={onConfirm}
        />
      </Canonical>,
    );
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.type(within(dialog).getByRole("textbox"), "DELETE");
    expect(confirm).not.toHaveAttribute("aria-disabled");
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("closes a dialog on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <Canonical>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <ZeroBaseDialog
            open={open}
            onOpenChange={setOpen}
            title="Confirm"
            confirmLabel="Yes"
            onConfirm={vi.fn()}
          />
        </Canonical>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    // Radix restores focus in an unmount effect, so this settles a tick later.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("renders a menu inside the portal host and explains inert items", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Canonical>
        <ZeroBaseMenu
          label="Row actions"
          trigger={<button type="button">Actions</button>}
          items={[
            { id: "open", label: "Open", onSelect },
            {
              id: "duplicate",
              label: "Duplicate",
              onSelect,
              disabledReason: "Duplicate needs an ad account with write access.",
            },
          ]}
        />
      </Canonical>,
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const menu = await screen.findByRole("menu");
    expect(isInsideCanonicalPortal(menu)).toBe(true);

    const duplicate = within(menu).getByText("Duplicate").closest('[role="menuitem"]')!;
    expect(duplicate).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByText("Duplicate needs an ad account with write access.")).toBeVisible();
  });

  it("renders a sheet inside the portal host", async () => {
    render(
      <Canonical>
        <ZeroBaseSheet open onOpenChange={vi.fn()} title="Scope">
          <p>Sheet body</p>
        </ZeroBaseSheet>
      </Canonical>,
    );
    const sheet = await screen.findByRole("dialog");
    expect(isInsideCanonicalPortal(sheet)).toBe(true);
    expect(within(sheet).getByText("Sheet body")).toBeVisible();
  });
});

describe("Combobox", () => {
  it("filters, announces the active option and commits with Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Canonical>
        <Combobox
          label="Business"
          value={null}
          onChange={onChange}
          options={[
            { value: "b1", label: "Acme", detail: "act_1" },
            { value: "b2", label: "Grandmix", detail: "act_2" },
          ]}
        />
      </Canonical>,
    );
    const input = screen.getByRole("combobox", { name: "Business" });
    await user.click(input);
    await user.type(input, "grand");

    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("b2");
  });

  it("renders a real empty state with a way out, not a blank popup", async () => {
    const user = userEvent.setup();
    render(
      <Canonical>
        <Combobox
          label="Business"
          value={null}
          onChange={vi.fn()}
          options={[{ value: "b1", label: "Acme" }]}
        />
      </Canonical>,
    );
    const input = screen.getByRole("combobox", { name: "Business" });
    await user.click(input);
    await user.type(input, "zzz");
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText(/No matches/)).toBeVisible();
    expect(within(listbox).getByRole("button", { name: "Clear search" })).toBeVisible();
  });

  it("reads the selection back rather than assuming it", async () => {
    render(
      <Canonical>
        <Combobox
          label="Business"
          value="b1"
          status="saved"
          onChange={vi.fn()}
          options={[{ value: "b1", label: "Acme" }]}
        />
      </Canonical>,
    );
    expect(screen.getByText("Saved — Acme")).toBeVisible();
  });
});
