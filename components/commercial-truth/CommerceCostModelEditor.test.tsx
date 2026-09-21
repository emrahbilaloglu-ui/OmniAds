// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommerceCostModelEditor } from "@/components/commercial-truth/CommerceCostModelEditor";
import type {
  CommerceCostComponent,
  CommerceCostStructure,
} from "@/src/types/commerce-cost";

const NOW = "2026-09-17T00:00:00.000Z";

function structure(components: CommerceCostComponent[] = []): CommerceCostStructure {
  return {
    businessId: "biz_1",
    version: 0,
    origin: "operator",
    confirmed: false,
    reportingCurrency: "USD",
    effectiveFrom: NOW,
    recordedAt: NOW,
    components,
  };
}

function component(overrides: Partial<CommerceCostComponent> = {}): CommerceCostComponent {
  return {
    id: "cost_1",
    version: 1,
    family: "product_purchase",
    slot: "default",
    label: "Product cost",
    scope: [],
    basis: { kind: "percent_of_base", percent: 40, base: "order_net_product_sales" },
    currency: "USD",
    taxTreatment: "unknown",
    effectiveFrom: NOW,
    recordedAt: NOW,
    recognition: "on_order",
    refundBehaviour: "reverse_on_restock",
    evidence: "operator_estimate",
    source: { kind: "manual" },
    decisionClass: "contribution",
    status: "active",
    ...overrides,
  };
}

function renderEditor(overrides: Partial<React.ComponentProps<typeof CommerceCostModelEditor>> = {}) {
  const onChange = vi.fn();
  const onSave = vi.fn();
  render(
    <CommerceCostModelEditor
      structure={structure()}
      source="empty"
      canEdit
      saving={false}
      dirty={false}
      onChange={onChange}
      onSave={onSave}
      onDiscard={vi.fn()}
      {...overrides}
    />,
  );
  return { onChange, onSave };
}

afterEach(cleanup);

describe("CommerceCostModelEditor", () => {
  it("shows legacy percentages without floating-point tails in summaries and edit fields", async () => {
    const user = userEvent.setup();
    renderEditor({
      structure: structure([
        component({ basis: { kind: "percent_of_base", percent: 3.5000000000000004, base: "order_net_product_sales" } }),
      ]),
    });

    expect(screen.getByText("3.5% of order net product sales")).toBeTruthy();
    expect(screen.queryByText(/3\.5000000000000004/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Edit Product cost" }));
    expect(screen.getByLabelText("Percentage")).toHaveValue("3.5");
  });

  it("formats legacy source differences and leaves missing values unknown", () => {
    renderEditor({
      structure: {
        ...structure(),
        conflicts: [{
          family: "product_purchase",
          slot: "legacy_cogs",
          detail: "Legacy sources disagree.",
          candidates: [
            { source: { kind: "legacy_import", ref: "business_cost_models" }, value: 28.999999999999996 },
            { source: { kind: "legacy_import", ref: "business_target_packs" }, value: null },
          ],
        }],
      },
    });

    expect(screen.getByText("Current cost model: 29% · Commercial Truth target pack: unknown")).toBeTruthy();
    expect(screen.queryByText(/28\.999999999999996|unknown%/)).toBeNull();
  });

  it("compares the draft model break-even with the manual Target Pack without applying it", () => {
    renderEditor({
      dirty: true,
      targetPackBreakEvenRoas: 2.1,
      breakEvenPreview: {
        status: "ready",
        breakEvenRoas: 2.5,
        variableCostRate: 0.6,
        contributionMarginRate: 0.4,
        window: { startDate: "2026-08-25", endDate: "2026-09-21", days: 28 },
        reportingCurrency: "USD",
        contributions: [],
        blockers: [],
        assumptions: [
          "Current Shopify catalog costs are applied to the 28-day product sales mix; this is a scenario estimate, not historical COGS.",
        ],
      },
    });

    expect(screen.getByText("2.50x")).toBeTruthy();
    expect(screen.getByText("60.0%")).toBeTruthy();
    expect(screen.getByText("40.0%")).toBeTruthy();
    expect(screen.getByText("2.10x")).toBeTruthy();
    expect(screen.getByText(/does not update the Target Pack/i)).toBeTruthy();
    expect(screen.getByText(/not historical COGS/i)).toBeTruthy();
  });

  it("withholds a model threshold and explains incomplete inputs", () => {
    renderEditor({
      targetPackBreakEvenRoas: 2.1,
      breakEvenPreview: {
        status: "incomplete",
        breakEvenRoas: null,
        variableCostRate: null,
        contributionMarginRate: null,
        window: { startDate: "2026-08-25", endDate: "2026-09-21", days: 28 },
        reportingCurrency: "USD",
        contributions: [],
        blockers: ["Payment processing has no stated cost or explicit zero."],
        assumptions: [],
      },
    });

    expect(screen.getByText(/Complete the missing inputs/i)).toBeTruthy();
    expect(screen.getByText(/Payment processing has no stated cost/i)).toBeTruthy();
    expect(screen.getByText("2.10x")).toBeTruthy();
    expect(screen.queryByText("1.00x")).toBeNull();
  });

  it("shows a known-cost floor without presenting it as complete break-even", () => {
    renderEditor({
      breakEvenPreview: {
        status: "provisional",
        breakEvenRoas: 1.68,
        variableCostRate: 0.405,
        contributionMarginRate: 0.595,
        window: { startDate: "2026-08-25", endDate: "2026-09-21", days: 28 },
        reportingCurrency: "USD",
        contributions: [],
        blockers: [
          "100.00 USD of sold product revenue has no compatible Shopify unit cost, so the shown value is a known-cost floor.",
        ],
        assumptions: [],
      },
    });

    expect(screen.getByText("1.68x")).toBeTruthy();
    expect(screen.getByText("KNOWN-COST ROAS FLOOR")).toBeTruthy();
    expect(screen.getByText(/Missing costs can only raise this threshold/i)).toBeTruthy();
    expect(screen.getByText(/no compatible Shopify unit cost/i)).toBeTruthy();
  });

  it("keeps missing costs visibly distinct from a real zero", () => {
    renderEditor({
      sourceWarnings: [
        "Some zeroes from the old cost form were left as gaps because that form could not distinguish a default from a real zero.",
      ],
    });

    expect(screen.getByText(/Missing costs remain unknown/i)).toBeTruthy();
    expect(screen.getByText(/Use an explicit 0 cost for a real zero/i)).toBeTruthy();
    expect(screen.getByText(/could not distinguish a default from a real zero/i)).toBeTruthy();
  });

  it("does not turn an untouched required value into a real zero", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();

    await user.click(screen.getByRole("button", { name: "Add cost" }));
    await user.click(screen.getAllByRole("button", { name: "Add cost" }).at(-1)!);

    expect(screen.getByText("Percentage is required.")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps an incomplete scope condition in the editor instead of sending an invalid payload", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();

    await user.click(screen.getByRole("button", { name: "Add cost" }));
    fireEvent.change(screen.getByLabelText("Percentage"), { target: { value: "10" } });
    await user.click(screen.getByRole("button", { name: /Accounting, refunds and scope/i }));
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.click(screen.getAllByRole("button", { name: "Add cost" }).at(-1)!);

    expect(screen.getByText("Scope condition 1 needs at least one value.")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("captures a fully loaded percentage and the families already included in it", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();

    await user.click(screen.getByRole("button", { name: "Add cost" }));
    await user.type(screen.getByLabelText("Name"), "Fully loaded product cost");
    fireEvent.change(screen.getByLabelText("Percentage"), { target: { value: "42" } });
    await user.click(screen.getByRole("button", { name: /Accounting, refunds and scope/i }));
    expect(screen.queryByText(/JSON/i)).toBeNull();
    await user.click(screen.getByLabelText("Outbound shipping"));
    await user.click(screen.getByLabelText("Payment processing"));
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    fireEvent.change(screen.getByLabelText("Values"), { target: { value: "US, CA" } });
    await user.click(screen.getAllByRole("button", { name: "Add cost" }).at(-1)!);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as CommerceCostStructure;
    expect(next.components).toHaveLength(1);
    expect(next.components[0]).toMatchObject({
      label: "Fully loaded product cost",
      family: "product_purchase",
      basis: {
        kind: "percent_of_base",
        percent: 42,
        base: "line_net_sales",
      },
      embeds: ["outbound_shipping", "payment_processing"],
      scope: [{ dimension: "market", operator: "in", values: ["US", "CA"] }],
      source: { kind: "manual" },
      evidence: "operator_estimate",
    });
  });

  it("offers generalized business scenarios as editable starting points", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();

    await user.click(screen.getByRole("button", { name: /Landed product cost/i }));
    expect(screen.getByRole("dialog", { name: "Add a cost component" })).toBeTruthy();
    expect(screen.getByLabelText("Name")).toHaveValue("Landed product cost");
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "18.50" } });
    await user.click(screen.getAllByRole("button", { name: "Add cost" }).at(-1)!);

    const next = onChange.mock.calls[0]?.[0] as CommerceCostStructure;
    expect(next.components[0]).toMatchObject({
      family: "product_purchase",
      basis: { kind: "amount_per_unit", amount: 18.5 },
      embeds: ["inbound_logistics", "duties_import"],
      source: { kind: "supplier_invoice" },
      refundBehaviour: "reverse_on_restock",
    });
  });

  it("turns a scenario into a guided main-input task with field explanations", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("button", { name: /Loaded all-in ratio/i }));

    expect(screen.getByText(/Enter the share of sales consumed by your combined per-sale costs/i)).toBeTruthy();
    expect(screen.getByText(/enter 42 for a 42%/i)).toBeTruthy();

    const help = screen.getByRole("button", { name: "Explain cost percentage" });
    await user.click(help);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/whole number/i);
    expect(help).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(help).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("dialog", { name: "Add a cost component" })).toBeTruthy();
  });

  it("captures a blended all-expense percentage as reference-only truth", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();

    await user.click(screen.getByRole("button", { name: /All-expense ratio/i }));
    fireEvent.change(screen.getByLabelText("Percentage"), { target: { value: "41.5" } });
    await user.click(screen.getAllByRole("button", { name: "Add cost" }).at(-1)!);

    const next = onChange.mock.calls[0]?.[0] as CommerceCostStructure;
    expect(next.components[0]).toMatchObject({
      label: "All-expense ratio (reference)",
      slot: "all-expense-reference",
      basis: { kind: "percent_of_base", percent: 41.5, base: "line_net_sales" },
      decisionClass: "informational",
      refundBehaviour: "non_recoverable",
      reason: expect.stringMatching(/must not drive marginal decisions/i),
      audit: { note: expect.stringMatching(/Reference-only composite/i) },
    });
  });

  it("closes the cost editor with Escape and returns focus to its launcher", async () => {
    const user = userEvent.setup();
    renderEditor();
    const launcher = screen.getByRole("button", { name: "Add cost" });

    await user.click(launcher);
    expect(screen.getByRole("dialog", { name: "Add a cost component" })).toBeTruthy();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(launcher);
  });

  it("requires an explicit owner confirmation after the cost composition changes", async () => {
    const user = userEvent.setup();
    const editable = { ...structure([component()]), origin: "legacy_import" as const };
    const { onChange } = renderEditor({ structure: editable, source: "legacy_preview" });

    const confirmation = screen.getByRole("checkbox", {
      name: /I confirm what these costs include/i,
    });
    expect(confirmation).not.toBeChecked();
    await user.click(confirmation);

    expect(onChange).toHaveBeenCalledWith({ ...editable, origin: "operator", confirmed: true });
  });

  it("records an explicit conversion policy for a cost in another currency", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();

    await user.click(screen.getByRole("button", { name: "Add cost" }));
    fireEvent.change(screen.getByLabelText("Percentage"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "EUR" } });
    fireEvent.change(screen.getByLabelText("Currency conversion"), {
      target: { value: "fixed_rate" },
    });
    fireEvent.change(screen.getByLabelText("USD per 1 EUR"), { target: { value: "1.18" } });
    await user.click(screen.getAllByRole("button", { name: "Add cost" }).at(-1)!);

    const next = onChange.mock.calls[0]?.[0] as CommerceCostStructure;
    expect(next.components[0]).toMatchObject({
      currency: "EUR",
      fx: { policy: "fixed_rate", fixedRate: 1.18 },
    });
  });

  it("preserves editable source provenance when an imported component is revised", async () => {
    const user = userEvent.setup();
    const imported = component({
      source: { kind: "supplier_invoice", ref: "INV-2026-41" },
      evidence: "observed_exact",
    });
    const { onChange } = renderEditor({ structure: structure([imported]), source: "stored" });

    await user.click(screen.getByRole("button", { name: "Edit Product cost" }));
    await user.click(screen.getByRole("button", { name: /Accounting, refunds and scope/i }));
    expect(screen.getByLabelText("Source")).toHaveValue("supplier_invoice");
    expect(screen.getByLabelText("Source reference (optional)")).toHaveValue("INV-2026-41");
    await user.click(screen.getByRole("button", { name: "Update cost" }));

    const next = onChange.mock.calls[0]?.[0] as CommerceCostStructure;
    expect(next.components[0]?.source).toEqual({
      kind: "supplier_invoice",
      ref: "INV-2026-41",
    });
  });

  it("preserves advanced replacement, override and rate conditions while editing", async () => {
    const user = userEvent.setup();
    const target = component({ id: "old-rate", label: "Old shipping rate", family: "outbound_shipping", slot: "carrier" });
    const revised = component({
      id: "new-rate",
      label: "Current shipping rate",
      family: "outbound_shipping",
      slot: "carrier",
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [
          {
            when: [{ dimension: "market", operator: "in", values: ["US"] }],
            weightMaxKg: 2,
            amount: 9,
          },
        ],
        fallbackAmount: 15,
        allocation: "revenue",
      },
      replacesEmbedded: true,
      overrideOf: "old-rate",
      reason: "New carrier contract",
      audit: { note: "Valid for the 2026 contract year" },
    });
    const { onChange } = renderEditor({
      structure: structure([target, revised]),
      source: "stored",
    });

    await user.click(screen.getByRole("button", { name: "Edit Current shipping rate" }));
    await user.click(screen.getByRole("button", { name: "Update cost" }));

    const next = onChange.mock.calls[0]?.[0] as CommerceCostStructure;
    const saved = next.components.find((entry) => entry.id === "new-rate");
    expect(saved).toMatchObject({
      replacesEmbedded: true,
      overrideOf: "old-rate",
      reason: "New carrier contract",
      audit: { note: "Valid for the 2026 contract year" },
    });
    expect(saved?.basis).toMatchObject({
      kind: "rate_table",
      rows: [
        {
          when: [{ dimension: "market", operator: "in", values: ["US"] }],
          weightMaxKg: 2,
          amount: 9,
        },
      ],
    });
  });

  it("blocks persistence when the structure contains an invalid cost authority", () => {
    const invalid = structure([
      component({ family: "marketing_paid", label: "Duplicate ad spend" }),
    ]);
    const { onSave } = renderEditor({ structure: invalid, source: "stored", dirty: true });

    expect(screen.getByText("Resolve before saving")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save cost model" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("blocks the single save path when Shopify and a direct cost own the same family", () => {
    const invalid = structure([component()]);
    invalid.sourcePolicy = {
      productCostAuthority: "shopify_unit_cost",
      shopifyUnitCost: {
        meaning: "product_purchase_only",
        includedFamilies: ["product_purchase"],
        minimumCoveragePercent: 95,
        missingCostPolicy: "leave_unknown",
        historicalPolicy: "unknown_before_first_observation",
      },
    };
    const { onSave } = renderEditor({ structure: invalid, source: "stored", dirty: true });

    expect(screen.getByText(/already inside Shopify unit cost/i)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save cost model" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });
});
