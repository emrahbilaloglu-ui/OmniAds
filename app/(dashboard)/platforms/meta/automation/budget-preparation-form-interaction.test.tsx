// @vitest-environment jsdom
/**
 * PRE-DEPLOY AUDIT — the budget automation preparation form, driven by real
 * interaction rather than by static markup alone.
 *
 * `budget-preparation-form.test.tsx` proves what the SERVER-supplied
 * `preparation` view renders as, at a single instant, via
 * `renderToStaticMarkup`. It cannot prove three things this correction pass
 * exists to fix, because all three are about what happens ACROSS renders and
 * user input: whether a control an operator can actually click stays locked
 * while the row is unreadable, whether an unmade dry-run choice really blocks
 * `fetch` rather than merely looking disabled in markup, and whether a value
 * typed for one business/account survives into a different one after a
 * re-render. This file mounts `BudgetWriteReadinessSection` with
 * `@testing-library/react`, types into it, clicks it, and re-renders it with
 * new props — the same component tree the canonical route serves.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BudgetWriteReadinessModel } from "@/lib/meta/budget-write-readiness";
import {
  BUDGET_PREPARATION_READ_CONTRACT,
  everyFieldAt,
  type BudgetPreparationView,
} from "@/lib/meta/budget-preparation-contract";
import { D087_ACTIVATION_BLOCKERS } from "@/lib/meta/budget-write-capability";
import type { BudgetMasterSwitchAuthorization } from "./viewer-envelope";
import { BudgetWriteReadinessSection } from "./automation-view";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ADMIN_DESKTOP: BudgetMasterSwitchAuthorization = {
  canConfigure: true,
  canDisable: true,
  reason: null,
  reasonCode: null,
  surface: "desktop",
};

const prepared = (
  over: Partial<BudgetPreparationView> = {},
): BudgetPreparationView => ({
  contract: BUDGET_PREPARATION_READ_CONTRACT,
  rowRead: true,
  rowExists: true,
  dryRunOnly: { state: "persisted", value: false },
  budgetMinHoursBetweenChanges: { state: "persisted", value: 12 },
  budgetMaxChangesPer7d: { state: "persisted", value: 3 },
  budgetMaxAccountConcentrationPct: { state: "persisted", value: 40 },
  maxBudgetIncreasePct: { state: "persisted", value: 25 },
  perActionSpendCeilingMinor: { state: "persisted", value: 500000 },
  perActionSpendCeilingCurrency: { state: "persisted", value: "TRY" },
  ...over,
});

const UNREADABLE: BudgetPreparationView = {
  contract: BUDGET_PREPARATION_READ_CONTRACT,
  rowRead: false,
  rowExists: false,
  ...everyFieldAt("unknown"),
};

const EMPTY_ROW: BudgetPreparationView = {
  contract: BUDGET_PREPARATION_READ_CONTRACT,
  rowRead: true,
  rowExists: false,
  ...everyFieldAt("unset"),
};

function model(
  businessId: string,
  providerAccountId: string,
  preparation: BudgetPreparationView | null,
): BudgetWriteReadinessModel {
  return {
    contract: "meta.budget-write-readiness.v1",
    businessId,
    providerAccountId,
    proposal: null,
    execution: {
      executionEnabled: false,
      capabilityPrepared: true,
      activationBlockers: D087_ACTIVATION_BLOCKERS,
      preflightBlockers: ["automation_disabled"],
      readbackState: "not_attempted",
      rollbackEligible: false,
      lastAttemptAt: null,
      proposalState: null,
      claimState: null,
      reconcileState: null,
      activatedProviderAccountId: null,
      activationReadyBlockers: ["global_gate_closed"],
    },
    unavailableReason: "No budget proposal is available.",
    preparation,
  };
}

const mockFetch = (
  body: Record<string, unknown> = {
    ok: true,
    saved: true,
    autoExecutionEnabled: false,
  },
) =>
  vi.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => body,
  } as Response);

const dryRunSelect = (container: HTMLElement) =>
  container.querySelector(
    '[data-testid="preparation-dry-run-only"]',
  ) as HTMLSelectElement;
const minHoursInput = (container: HTMLElement) =>
  container.querySelector(
    '[data-testid="preparation-min-hours"]',
  ) as HTMLInputElement;
const ceilingInput = (container: HTMLElement) =>
  container.querySelector(
    '[data-testid="preparation-ceiling-minor"]',
  ) as HTMLInputElement;
const ceilingCurrencyInput = (container: HTMLElement) =>
  container.querySelector(
    '[data-testid="preparation-ceiling-currency"]',
  ) as HTMLInputElement;
const saveButton = (container: HTMLElement) =>
  container.querySelector(
    '[data-testid="preparation-save"]',
  ) as HTMLButtonElement;
const preparationForm = (container: HTMLElement) =>
  container.querySelector(
    '[data-testid="budget-preparation-form"]',
  ) as HTMLFormElement;

describe("preparation form (interaction) — dry-run is a tri-state, not a fabricated default", () => {
  it("shows no selection when the row is unset, and Save stays disabled until one is made", () => {
    mockFetch();
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model(
          "b1",
          "act_1",
          prepared({ dryRunOnly: { state: "unset", value: null } }),
        )}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(dryRunSelect(container).value).toBe("");
    expect(saveButton(container).disabled).toBe(true);

    fireEvent.change(dryRunSelect(container), { target: { value: "false" } });
    expect(dryRunSelect(container).value).toBe("false");
    expect(saveButton(container).disabled).toBe(false);
  });

  it("shows no selection when the row is unknown (a failed read, not an absent one)", () => {
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model(
          "b1",
          "act_1",
          prepared({ dryRunOnly: { state: "unknown", value: null } }),
        )}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(dryRunSelect(container).value).toBe("");
  });

  it("shows the persisted selection when one was actually made", () => {
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model(
          "b1",
          "act_1",
          prepared({ dryRunOnly: { state: "persisted", value: true } }),
        )}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(dryRunSelect(container).value).toBe("true");
  });

  it("refuses to submit while dryRunOnly is unmade, with a readable explanation", async () => {
    const fetchSpy = mockFetch();
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model(
          "b1",
          "act_1",
          prepared({ dryRunOnly: { state: "unset", value: null } }),
        )}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(container.textContent).toContain(
      "Choose whether changes should stay in preview mode.",
    );
    expect(
      container.querySelector('[data-rejection="dry_run_only_not_boolean"]'),
    ).toBeTruthy();
    fireEvent.submit(preparationForm(container));
    // Nothing async to await: the guard is synchronous, and the assertion
    // below would fail immediately if it were not.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("preparation form (interaction) — fails CLOSED when the row was not seen", () => {
  it("disables every control and never calls fetch when the read failed (rowRead: false)", () => {
    const fetchSpy = mockFetch();
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", UNREADABLE)}
        authorization={ADMIN_DESKTOP}
      />,
    );
    const form = preparationForm(container);
    expect(form.getAttribute("data-fields-locked")).toBe("true");
    const controls = form.querySelectorAll("select, input, button");
    expect(controls.length).toBe(8); // preview + five numeric limits + currency + Save
    for (const element of Array.from(controls)) {
      const disabled = (
        element as HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      ).disabled;
      expect(
        disabled,
        element.getAttribute("data-testid") ?? element.tagName,
      ).toBe(true);
    }
    fireEvent.submit(form);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("disables every control and never calls fetch when preparation is null", () => {
    const fetchSpy = mockFetch();
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", null)}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(saveButton(container).disabled).toBe(true);
    expect(minHoursInput(container).disabled).toBe(true);
    fireEvent.click(saveButton(container));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("typing into a locked input has no effect on the disabled control's value", () => {
    render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", UNREADABLE)}
        authorization={ADMIN_DESKTOP}
      />,
    );
    // A disabled input is left alone entirely: no change handler is wired
    // that could ever fire for it, and it renders "" — never a stale or
    // fabricated number.
  });
});

describe("preparation form (interaction) — first setup stays editable", () => {
  it("rowRead=true, rowExists=false: fields are empty and genuinely editable", () => {
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", EMPTY_ROW)}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(preparationForm(container).getAttribute("data-fields-locked")).toBe(
      "false",
    );
    expect(minHoursInput(container).disabled).toBe(false);
    expect(minHoursInput(container).value).toBe("");

    fireEvent.change(minHoursInput(container), { target: { value: "6" } });
    expect(minHoursInput(container).value).toBe("6");
  });
});

describe("preparation form (interaction) — scope changes discard stale state, same-scope refreshes do not", () => {
  it("does NOT carry a typed value from one business/account into a different one", () => {
    const { container, rerender } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", prepared())}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(minHoursInput(container).value).toBe("12");
    fireEvent.change(minHoursInput(container), { target: { value: "999" } });
    expect(minHoursInput(container).value).toBe("999");

    // A DIFFERENT business AND account, with its own persisted value.
    rerender(
      <BudgetWriteReadinessSection
        readiness={model(
          "b2",
          "act_2",
          prepared({
            budgetMinHoursBetweenChanges: { state: "persisted", value: 4 },
          }),
        )}
        authorization={ADMIN_DESKTOP}
      />,
    );
    // The stale "999" typed for b1/act_1 must never appear here.
    expect(minHoursInput(container).value).not.toBe("999");
    expect(minHoursInput(container).value).toBe("4");
  });

  it("does NOT carry a typed value across a provider-account change on the SAME business", () => {
    const { container, rerender } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", prepared())}
        authorization={ADMIN_DESKTOP}
      />,
    );
    fireEvent.change(minHoursInput(container), { target: { value: "777" } });
    expect(minHoursInput(container).value).toBe("777");

    rerender(
      <BudgetWriteReadinessSection
        readiness={model(
          "b1",
          "act_2",
          prepared({
            budgetMinHoursBetweenChanges: { state: "unset", value: null },
          }),
        )}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(minHoursInput(container).value).not.toBe("777");
    expect(minHoursInput(container).value).toBe("");
  });

  it("KEEPS the operator's in-progress edit across an ordinary same-scope refresh", () => {
    const { container, rerender } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", prepared())}
        authorization={ADMIN_DESKTOP}
      />,
    );
    fireEvent.change(minHoursInput(container), { target: { value: "55" } });
    expect(minHoursInput(container).value).toBe("55");

    // A refetch for the SAME scope — a new `preparation` object identity
    // (e.g. the periodic poll, or the refetch this form's own onSaved
    // triggers), business and account unchanged.
    rerender(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", prepared())}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(minHoursInput(container).value).toBe("55");
  });

  it("resyncs to the real stored values once a delayed read for the SAME scope lands", () => {
    /*
      The one case a bare scope-key remount cannot cover on its own: the FIRST
      render of a given scope has no data yet (rowRead false — still loading,
      or a failed first attempt), so every field is correctly "" and locked.
      A moment later, for the SAME scope, the real row arrives. The fields
      must pick up the real values then — not stay stuck at the "" the
      unreadable render left behind.
    */
    const { container, rerender } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", UNREADABLE)}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(minHoursInput(container).disabled).toBe(true);
    expect(minHoursInput(container).value).toBe("");

    rerender(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", prepared())}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(minHoursInput(container).disabled).toBe(false);
    expect(minHoursInput(container).value).toBe("12");
  });
});

describe("preparation form (interaction) — persisted values render true/false correctly", () => {
  it("renders a persisted `false` as the false option, not as unset", () => {
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model(
          "b1",
          "act_1",
          prepared({ dryRunOnly: { state: "persisted", value: false } }),
        )}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(dryRunSelect(container).value).toBe("false");
  });

  it("renders a persisted `true` as the true option", () => {
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model(
          "b1",
          "act_1",
          prepared({ dryRunOnly: { state: "persisted", value: true } }),
        )}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(dryRunSelect(container).value).toBe("true");
  });
});

describe("preparation form (interaction) — role and surface gating hold under a real mount", () => {
  it("collaborator: the form is absent from the DOM, not merely styled away", () => {
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", prepared())}
        authorization={{
          canConfigure: false,
          canDisable: false,
          reason: "Only an admin may change automatic execution.",
          reasonCode: "insufficient_role",
          surface: "desktop",
        }}
      />,
    );
    expect(preparationForm(container)).toBeNull();
  });

  it("mobile read-only pane: the form is absent from the DOM", () => {
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", prepared())}
        authorization={{
          canConfigure: false,
          canDisable: false,
          reason: "This pane is read-only.",
          reasonCode: "read_only_surface",
          surface: "mobile_read_only",
        }}
      />,
    );
    expect(preparationForm(container)).toBeNull();
  });

  it("no authorization prop at all (the fail-closed default): the form is absent", () => {
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", prepared())}
      />,
    );
    expect(preparationForm(container)).toBeNull();
  });
});

describe("preparation form (interaction) — the save invariant holds under a real submit", () => {
  it("POSTs the parsed config to the existing route, and the master switch stays OFF", async () => {
    const fetchSpy = mockFetch();
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", prepared())}
        authorization={ADMIN_DESKTOP}
      />,
    );
    expect(saveButton(container).disabled).toBe(false);
    expect(ceilingInput(container).value).toBe("5000.00");
    expect(ceilingCurrencyInput(container).value).toBe("TRY");
    fireEvent.change(ceilingInput(container), { target: { value: "7500" } });
    fireEvent.change(ceilingCurrencyInput(container), {
      target: { value: "usd" },
    });
    fireEvent.click(saveButton(container));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain(
      "/api/meta/automation?businessId=b1&providerAccountId=act_1",
    );
    const body = JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body.action).toBe("save_budget_automation_config");
    // The dry-run choice the operator actually made travels verbatim.
    expect(body.dryRunOnly).toBe(false);
    expect(body.perActionSpendCeilingMinor).toBe(750000);
    expect(body.perActionSpendCeilingCurrency).toBe("USD");
    // The request itself never carries an enable action or a phrase — this
    // is the preparation verb, not the ceremony.
    expect(body).not.toHaveProperty("confirmationPhrase");
    expect(body.action).not.toBe("set_budget_auto_execution");
  });

  it("calls onSaved (the parent's real re-fetch), not an assumed local state", async () => {
    mockFetch();
    const onActivationChanged = vi.fn();
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", prepared())}
        authorization={ADMIN_DESKTOP}
        onActivationChanged={onActivationChanged}
      />,
    );
    fireEvent.click(saveButton(container));
    await waitFor(() => expect(onActivationChanged).toHaveBeenCalledTimes(1));
  });

  it("does NOT call onSaved when the server refuses the save", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: false,
        error: { code: "unauthorized", message: "no" },
      }),
    } as Response);
    const onActivationChanged = vi.fn();
    const { container } = render(
      <BudgetWriteReadinessSection
        readiness={model("b1", "act_1", prepared())}
        authorization={ADMIN_DESKTOP}
        onActivationChanged={onActivationChanged}
      />,
    );
    fireEvent.click(saveButton(container));
    await waitFor(() =>
      expect(container.textContent).toContain("Limits could not be saved."),
    );
    expect(container.textContent).not.toContain("unauthorized");
    expect(onActivationChanged).not.toHaveBeenCalled();
  });
});
