// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreativeEvidenceWindowExact } from "./CreativeEvidenceWindowExact";
import {
  buildCreativeEvidenceWindowExactViewModel,
  type CreativeEvidenceWindowExactAdRow,
} from "./creative-evidence-window-exact-adapter";
import { META_AD_EVENTS_NOTE, META_AD_EVENTS_TITLE } from "./meta-ad-events-copy";

/*
 * Checkout and purchase are Meta events attributed to the Ad independently, so
 * the evidence drawer prints their counts as reported and never a step rate
 * between them. The Grandmix shape — checkouts 0, purchases 3 on one Ad — is
 * the negative control: it used to print "Checkout 0.0%", and one more checkout
 * would have printed "CVR 300.0%".
 */

afterEach(() => {
  cleanup();
});

function adRow(
  overrides: Partial<CreativeEvidenceWindowExactAdRow> = {},
): CreativeEvidenceWindowExactAdRow {
  return {
    id: "row_1",
    adsetId: "set_1",
    adsetName: "Prospecting",
    spend: 240,
    purchaseValue: 610,
    roas: 2.54,
    impressions: 20_000,
    linkClicks: 500,
    linkClicksObserved: true,
    landingPageViews: 400,
    landingPageViewsObserved: true,
    addToCart: 12,
    addToCartObserved: true,
    initiateCheckout: 0,
    initiateCheckoutObserved: true,
    purchases: 3,
    purchasesObserved: true,
    thumbstop: null,
    launchDate: "2026-07-01",
    ...overrides,
  };
}

function step(model: ReturnType<typeof buildCreativeEvidenceWindowExactViewModel>, id: string) {
  const found = model.funnel?.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing funnel step ${id}`);
  return found;
}

describe("Meta-reported checkout and purchase events carry no step rate", () => {
  it("prints checkouts 0 and purchases 3 as reported, with no rate between them", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({ adRows: [adRow()] });
    expect(step(model, "initiate-checkout")).toMatchObject({ value: "0", sub: "" });
    expect(step(model, "purchases")).toMatchObject({ value: "3", sub: "" });
    const serialized = JSON.stringify(model.funnel);
    expect(serialized).not.toContain("Checkout 0.0%");
    expect(serialized).not.toContain("CVR");
  });

  it("never prints a purchase rate above 100% when purchases exceed checkouts", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      adRows: [adRow({ initiateCheckout: 1 })],
    });
    expect(step(model, "initiate-checkout")).toMatchObject({ value: "1", sub: "" });
    expect(step(model, "purchases")).toMatchObject({ value: "3", sub: "" });
    expect(JSON.stringify(model.funnel)).not.toContain("300.0%");
  });

  it("keeps an unmeasured checkout unknown rather than zero", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      adRows: [adRow({ initiateCheckout: 0, initiateCheckoutObserved: false })],
    });
    expect(step(model, "initiate-checkout").value).toBe("—");
    expect(step(model, "purchases").value).toBe("3");
  });

  it("keeps the rates that do not cross independently attributed events", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({ adRows: [adRow()] });
    expect(step(model, "link-clicks").sub).toBe("CTR 2.50%");
    expect(step(model, "landing-page-views").sub).toBe("LPV 80.0%");
    expect(step(model, "add-to-cart").sub).toBe("ATC 3.0%");
  });

  it("renders the Grandmix shape on the desktop drawer with the event title and note", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({ adRows: [adRow()] });
    render(<CreativeEvidenceWindowExact onClose={vi.fn()} viewModel={model} />);
    expect(screen.getByText(new RegExp(`^${META_AD_EVENTS_TITLE} ·`))).toBeInTheDocument();
    expect(screen.getByText(META_AD_EVENTS_NOTE)).toBeInTheDocument();
    const checkoutRow = screen.getByText("Checkout initiated").parentElement!;
    const purchaseRow = screen.getByText("Purchases").parentElement!;
    expect(within(checkoutRow).getByText("0")).toBeInTheDocument();
    expect(within(purchaseRow).getByText("3")).toBeInTheDocument();
    expect(checkoutRow.textContent).not.toContain("%");
    expect(purchaseRow.textContent).not.toContain("%");
    expect(document.body.textContent).not.toContain("CVR");
  });
});
