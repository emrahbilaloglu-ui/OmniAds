// @vitest-environment jsdom

/**
 * The mobile scope sheet changes scope, and changes it through the topbar.
 *
 * The sheet listed eight facts and could act on none of them: `ScopePickers`
 * was never passed, so every picker slot rendered nothing. A phone could read
 * the scope and not move it.
 *
 * What is proven here is the arrangement, not a second implementation: the
 * sheet's picker invokes the handle the real control registered, so the click
 * lands on the topbar's own trigger and every writer stays where it was. A
 * parallel picker would pass a "can change scope" test just as well and would
 * be the defect.
 */
import React, { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MobileScope } from "@/components/layout/v2/mobile-scope";
import {
  ScopeControlsProvider,
  useRegisterScopeControl,
} from "@/components/layout/v2/scope-controls";
import type { ScopeFacts } from "@/components/zero-base/primitives/scope-sheet";

vi.mock("@/components/layout/v2/use-narrow", () => ({
  // The sheet only exists on a narrow screen; at desktop the topbar states
  // scope and a second bar would be a second answer.
  useIsNarrow: () => true,
}));

afterEach(cleanup);

const FACTS: ScopeFacts = {
  contextLabel: "Client workspace",
  businessName: "IwaStore",
  accountLabel: "act_1000000000000001",
  windowLabel: "Last 28 days",
  currencyProof: "served",
  currencyLabel: "USD",
  timezoneProof: "agreement",
  timezoneLabel: "Europe/Istanbul",
  freshness: "fresh",
  observedAt: "2026-08-26T06:00:00.000Z",
  snapshotAt: "2026-08-26T05:00:00.000Z",
} as unknown as ScopeFacts;

/** Stands in for a topbar control: a real trigger, registered as itself. */
function FakeControl({
  id,
  onOpen,
  refusalReason = null,
  mounted = true,
}: {
  id: "business" | "account" | "window";
  onOpen?: () => void;
  refusalReason?: string | null;
  mounted?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  useRegisterScopeControl(id, { trigger, mounted, refusalReason });
  return (
    <button ref={trigger} type="button" data-testid={`topbar-${id}`} onClick={onOpen}>
      {id}
    </button>
  );
}

function mount(controls: React.ReactNode) {
  return render(
    <ScopeControlsProvider>
      {controls}
      <MobileScope facts={FACTS} />
    </ScopeControlsProvider>,
  );
}

async function openSheet() {
  await userEvent.click(screen.getByRole("button", { name: /^Scope — / }));
}

describe("the sheet's pickers are the topbar's controls", () => {
  it("clicks the real business trigger rather than switching anything itself", async () => {
    const opened = vi.fn();
    mount(<FakeControl id="business" onOpen={opened} />);

    await openSheet();
    await userEvent.click(
      screen.getByRole("button", { name: /^Switch business — / }),
    );

    expect(opened).toHaveBeenCalledTimes(1);
    // The trigger has focus, so what opened is where the operator now is.
    expect(document.activeElement).toBe(screen.getByTestId("topbar-business"));
  });

  it("hands over the account and window controls the same way", async () => {
    const account = vi.fn();
    const evidenceWindow = vi.fn();
    mount(
      <>
        <FakeControl id="account" onOpen={account} />
        <FakeControl id="window" onOpen={evidenceWindow} />
      </>,
    );

    await openSheet();
    await userEvent.click(
      screen.getByRole("button", { name: /^Choose account — / }),
    );
    expect(account).toHaveBeenCalledTimes(1);

    await openSheet();
    await userEvent.click(
      screen.getByRole("button", { name: /^Change evidence window — / }),
    );
    expect(evidenceWindow).toHaveBeenCalledTimes(1);
  });

  it("closes the sheet before the control opens, so focus is not trapped", async () => {
    mount(<FakeControl id="business" onOpen={vi.fn()} />);

    await openSheet();
    expect(screen.queryByRole("dialog")).not.toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: /^Switch business — / }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no picker for a control that is not on the screen", async () => {
    // Nothing registered: a surface with no provider family has no account
    // question, and a picker would say a decision is owed when none is.
    mount(<FakeControl id="account" mounted={false} onOpen={vi.fn()} />);

    await openSheet();

    expect(
      screen.queryByRole("button", { name: /^Choose account — / }),
    ).toBeNull();
  });
});

describe("a held control says why, in the words that held it", () => {
  it("renders the account picker's gate refusal and does not act", async () => {
    const account = vi.fn();
    mount(
      <FakeControl
        id="account"
        onOpen={account}
        refusalReason="Changing the Meta ad account is not enabled yet."
      />,
    );

    await openSheet();
    const picker = screen.getByRole("button", { name: /^Choose account — / });
    expect(picker.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText("Changing the Meta ad account is not enabled yet."),
    ).toBeTruthy();

    await userEvent.click(picker);
    expect(account).not.toHaveBeenCalled();
  });

  it("renders the window's own note on a current-state screen", async () => {
    const evidenceWindow = vi.fn();
    mount(
      <FakeControl
        id="window"
        onOpen={evidenceWindow}
        refusalReason="This screen shows the current state, not a reporting period. The date range is not applied here."
      />,
    );

    await openSheet();
    await userEvent.click(
      screen.getByRole("button", { name: /^Change evidence window — / }),
    );

    expect(evidenceWindow).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "This screen shows the current state, not a reporting period. The date range is not applied here.",
      ),
    ).toBeTruthy();
  });
});
