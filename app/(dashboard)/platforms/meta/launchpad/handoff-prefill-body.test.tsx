// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LaunchpadHandoffPrefillEnvelope } from "@/lib/meta/launchpad-handoff-contract";

/**
 * What a VERIFIED handoff actually does to the Launchpad body.
 *
 * The defect this file pins: consuming a handoff used to set nothing but a
 * generic wizard mode. The creative it was minted for, the campaign and ad set
 * a Duplicate targets, the frozen evidence window and the lineage all stopped
 * at the route. An operator who clicked Rebuild on one creative landed on an
 * empty picker and had to find it again by hand — which is indistinguishable
 * from the button doing nothing.
 *
 * The law, asserted against the real mounted surface (the wizard only renders
 * once an assigned account AND a currency exist, which is a fail-closed rule
 * this file honours rather than weakens):
 *
 *   - the wizard opens, at the server's mode and step, not the URL's;
 *   - the creative the handoff names is already selected;
 *   - the chip states what was carried, including the evidence window;
 *   - a copy handoff additionally states the part that is NOT true — Launchpad
 *     has no copy field, so the alternate line does not become ad copy;
 *   - a named handoff that could not be honoured says so instead of rendering
 *     an ordinary blank wizard.
 *
 * None of it is read from the URL: every assertion below runs with an empty
 * query string.
 */

const appState = {
  selectedBusinessId: "biz",
  businesses: [{ id: "biz", name: "IwaStore", currency: "USD" }],
};
const navigationState = vi.hoisted(() => ({ query: "" }));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(appState),
}));

vi.mock("@/app/(dashboard)/platforms/meta/creatives/page-support", () => ({
  fetchCreativeDecisionEngineV3: vi.fn(async () => ({ decisions: [] })),
  fetchMetaCreatives: vi.fn(async () => ({ rows: [] })),
  mapApiRowToUiRow: (row: unknown) => row,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigationState.query),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// The account scope has to be real for the wizard to mount at all: the surface
// refuses to render it without an assigned account AND a currency, which is the
// correct fail-closed behaviour and not something this file may weaken.
vi.mock("@/lib/meta/history-client", () => ({
  fetchMetaHistoryAccounts: vi.fn(async () => [
    { id: "act_1", name: "Main", currency: "USD" },
  ]),
}));

const { default: MetaLaunchpadPage } = await import("./legacy-page");

function decisionPrefill(
  overrides: Record<string, unknown> = {},
): LaunchpadHandoffPrefillEnvelope {
  return {
    status: "prefilled",
    prefill: {
      handoffId: "0f1e2d3c-4b5a-4c7d-8e9f-a0b1c2d3e4f5",
      origin: "decision",
      mode: "rebuild",
      launchpadMode: "new_campaign",
      launchpadStep: "creatives",
      providerAccountId: "act_1",
      authorizedAction: "refresh",
      actionEligible: true,
      exactAdExecutionEligible: true,
      sourceAuthorityStatus: "native_exact",
      selection: {
        campaignIds: [],
        adsetIds: [],
        adIds: ["ad_1"],
        creativeIds: ["creative_from_decision"],
      },
      evidenceWindow: {
        basis: "decision_snapshot",
        startDate: null,
        endDate: null,
        snapshotAsOf: "2026-08-17",
        computedAt: "2026-08-17T06:00:00.000Z",
      },
      lineage: {
        sourceDecisionId: "dec_1",
        sourceSnapshotId: "snap_1",
        episodeId: null,
        engineVersion: "engine-v3",
        snapshotAsOf: "2026-08-17",
        decisionHash: null,
        inputHash: null,
        campaignId: "camp_1",
        adsetId: "adset_1",
        adId: "ad_1",
        creativeId: "creative_from_decision",
      },
      copy: null,
      summary:
        "Decision handoff · rebuild · server-authorized refresh · snapshot 2026-08-17 · 1 creative preselected",
      unsupported: null,
      ...overrides,
    },
  } as LaunchpadHandoffPrefillEnvelope;
}

beforeEach(() => {
  navigationState.query = "";
  appState.selectedBusinessId = "biz";
  // The library/store reads are not what this file is about; they must simply
  // not throw. No provider call is made by any of them.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount(handoffPrefill?: LaunchpadHandoffPrefillEnvelope) {
  const view = render(
    <MetaLaunchpadPage
      businessId="biz"
      providerAccountId="act_1"
      handoffPrefill={handoffPrefill}
    />,
  );
  // The account read is asynchronous; nothing about the surface is assertable
  // until the scope it fails closed on has actually resolved.
  await screen.findByTestId("meta-launchpad-page");
  return view;
}

function desktopHref(container: HTMLElement) {
  return (
    container.querySelector<HTMLAnchorElement>(
      'a[href*="/platforms/meta/launchpad?"]',
    )?.getAttribute("href") ?? ""
  );
}

describe("Launchpad body · verified handoff prefill", () => {
  it("opens the wizard at the server's mode and step with no query string at all", async () => {
    const { container } = await mount(decisionPrefill());

    expect(await screen.findByTestId("launchpad-wizard")).toBeTruthy();
    // The landing is not what a verified handoff lands on.
    expect(screen.queryByText("Start from scratch")).toBeNull();
    const href = desktopHref(container);
    expect(href).toContain("launchpadMode=new_campaign");
    expect(href).toContain("launchpadStep=creatives");
  });

  it("preselects the creative the handoff was minted for", async () => {
    const { container } = await mount(decisionPrefill());

    // Read off the mobile facts list, which states the surface's own selection
    // count. Seeded from the prefill on the FIRST render rather than by an
    // effect, so it is never briefly empty.
    const facts = container.textContent ?? "";
    expect(facts).toContain("Selected");
    expect(
      container.querySelector('[data-testid="meta-mobile-launchpad"]')
        ?.textContent,
    ).toContain("1");
  });

  it("states what was carried, including the frozen evidence window", async () => {
    await mount(decisionPrefill());
    await screen.findByTestId("launchpad-wizard");

    expect(screen.getByText(/server-authorized refresh/)).toBeTruthy();
    expect(screen.getByText(/snapshot 2026-08-17/)).toBeTruthy();
    // The lineage line names the snapshot the launch is answerable to.
    expect(screen.getAllByText(/snap_1/).length).toBeGreaterThan(0);
  });

  it("routes a Scale handoff into add-to-existing, from the prop and not the URL", async () => {
    const { container } = await mount(
      decisionPrefill({
          mode: "duplicate",
          launchpadMode: "add_to_existing",
          authorizedAction: "scale",
          selection: {
            campaignIds: ["camp_1"],
            adsetIds: ["adset_1"],
            adIds: ["ad_1"],
            creativeIds: ["creative_from_decision"],
          },
        summary: "Decision handoff · duplicate · server-authorized scale",
      }),
    );

    await screen.findByTestId("launchpad-wizard");
    expect(desktopHref(container)).toContain("launchpadMode=add_to_existing");
    expect(screen.getAllByText("Add to existing").length).toBeGreaterThan(0);
  });

  // The honest half of item 19. The record carries the line; the wizard cannot
  // apply it, and the operator is told so in the same breath.
  it("carries a copy handoff and says the line will not become ad copy", async () => {
    await mount(
      decisionPrefill({
          origin: "copy",
          mode: "copy_draft",
          launchpadMode: "new_campaign",
          authorizedAction: null,
          actionEligible: false,
          exactAdExecutionEligible: false,
          sourceAuthorityStatus: "warehouse_discovery",
          lineage: null,
          evidenceWindow: {
            basis: "requested_metrics_window",
            startDate: "2026-07-19",
            endDate: "2026-08-17",
            snapshotAsOf: null,
            computedAt: null,
          },
          copy: {
            copyId: "copy:cre_1",
            alternateId: "alt-2",
            alternateText: "The other line Meta served",
            sourceText: "The line that is running",
            assetType: "primary_text",
          },
          summary:
            "Copy handoff · discovery evidence · no execution authority · window 2026-07-19 → 2026-08-17 · 1 creative preselected",
        unsupported:
          "Launchpad has no copy field, so the selected alternate line is carried in the draft record only and will not be written to an ad.",
      }),
    );

    await screen.findByTestId("launchpad-wizard");
    expect(screen.getByText(/no execution authority/)).toBeTruthy();
    expect(screen.getByText(/Launchpad has no copy field/)).toBeTruthy();
    expect(screen.getAllByText(/Copy line · copy:cre_1/).length).toBeGreaterThan(
      0,
    );
  });

  // A named handoff that could not be honoured must not render as an ordinary
  // blank wizard: that is indistinguishable from success.
  /**
   * An unhonourable record prefills NOTHING here.
   *
   * The canonical route refuses it before this body is ever mounted — it
   * redirects to Decisions carrying the refusal code, because the surface a
   * hop-2 failure lands on is the landing, which has no slot for a sentence and
   * would therefore have shown an ordinary blank Launchpad. That redirect is
   * proven in `app/c/[businessId]/meta/launchpad/handoff-read.test.tsx`.
   *
   * What this asserts is the body's own half of the same law: an `unavailable`
   * envelope must never be widened into a prefill. No mode is moved, no
   * creative is selected, and no lineage is claimed.
   */
  it("claims nothing at all from a handoff that could not be honoured", async () => {
    await mount({
      status: "unavailable",
      refusal: "prefill_expired",
      message:
        "The prepared draft expired; start it again from where you launched it.",
    });

    await screen.findByTestId("launchpad-exact");
    expect(screen.queryByTestId("launchpad-wizard")).toBeNull();
    expect(screen.queryByText(/creative preselected/)).toBeNull();
    expect(screen.queryByText(/Decision snapshot ·/)).toBeNull();
  });

  // The legacy mount establishes no handoff. An absent prop must never be read
  // as "the operator arrived without one" and widened into a prefill.
  it("prefills nothing when no server established a handoff", async () => {
    await mount();

    await screen.findByTestId("launchpad-exact");
    expect(screen.queryByText(/creative preselected/)).toBeNull();
    expect(screen.getByText("Start from scratch")).toBeTruthy();
  });
});
