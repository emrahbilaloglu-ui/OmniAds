// @vitest-environment jsdom

/**
 * The mobile Decisions card can APPLY, through the server's own ceremony.
 *
 * WHAT WAS WRONG. Below 720px `app/globals.css` hides every sibling of
 * `.meta-mobile-decision-stage`, and the manual write ceremony lived inside
 * `.metaOsDesktop` — one of those siblings. Driven at 390px against the
 * decision-card-apply harness, the card carrying an authorised bid intent
 * (`operatorApply {action: "bid", entityId: "9000000000201",
 * bidAmountMinor: 1320}`) rendered exactly one control:
 *
 *     rowControls:               [{ tag: "BUTTON", text: "Read evidence →" }]
 *     applyControlsInMobileStage: 0
 *     ceremonyAnywhere:           0
 *     desktopPaneBox:            { w: 0, h: 0, display: "none" }
 *     stageFooter:               "Writes are desktop-only — rows here open
 *                                 evidence, never a pause button."
 *
 * The defence — "the operator's mobile route to the same write is the
 * Automation confirmation queue" — does not hold: in MANUAL bid mode
 * `projectMetaBidProposals` returns `candidates: 0, projected: 0,
 * refusals: {bid_mode_manual: 1}`, so there is no queue row to approve. The
 * phone had no path at all.
 *
 * WHAT THIS PINS. One truth, two renders: the same `operatorApply` verb, the
 * same `toDecisionRow(rec).decisionKey`, the same `buildMutationCeremonySeed`
 * bindings, the same `MutationCeremonyPanel`, the same server-named endpoint.
 * The surfaces differ only in the DOM id they carry.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ZeroBasePortalHost,
  isInsideCanonicalPortal,
} from "@/components/zero-base/portal/portal-host";
import { ZeroBaseDialog } from "@/components/zero-base/primitives/overlays";

import {
  metaAnomaly,
  metaHealthy,
  metaLanePayload,
  metaPulse,
  metaRec,
} from "@/components/meta/redesign/test-fixtures";

const CAPPED_ADSET = "9000000000201";
const CAPPED_CAMPAIGN = "9000000000101";

/**
 * An ad-set row carrying a validated bid intent — the shape the harness's real
 * snapshot produces. `annotateMetaRecPresentation` runs inside `metaRec`, so
 * `operatorApply` is stamped by the SHIPPED `serverOperatorApplyForRec` rather
 * than asserted here.
 */
function bidRec() {
  return metaRec({
    id: "scenario_e1_frequency_fatigue-9000000000201",
    level: "adset",
    adsetId: CAPPED_ADSET,
    campaignId: CAPPED_CAMPAIGN,
    campaignName: "Prospecting CBO",
    type: "scenario_e1_frequency_fatigue",
    proposedAction: { kind: "apply_bid", bidAmountMinor: 1320 },
  });
}

/** The read-model envelope the adapter dereferences before anything else. */
function canonicalSection(key: string): any {
  return {
    key,
    label: key,
    topN: 5,
    preCapCount: 0,
    selectedCount: 0,
    rankablePreCapCount: 0,
    unrankablePreCapCount: 0,
    items: [],
    exposureDigest: {
      basis: "pre_cap",
      byCurrency: [],
      unavailableCount: 0,
      crossCurrencyTotal: null,
    },
    suppressionReceipt: {
      receiptId: `receipt_${key}`,
      selectionVersion: "meta-decisions-section-selection.v1",
      topN: 5,
      preCapCount: 0,
      selectedCount: 0,
      suppressedCount: 0,
      reasons: [],
    },
  };
}

function decisionReadModel(): any {
  return {
    contractVersion: "meta-decisions-workspace.read.v1",
    status: "available",
    generatedAt: "2026-09-04T12:00:00.000Z",
    scope: {
      businessId: "b0000000-0000-4000-8000-0000000009a1",
      providerAccountId: "act_9000000000001",
      decisionMode: "current",
      metricsRangeAffectsDecisionSnapshot: false,
    },
    unavailable: null,
    source: {
      status: "available",
      authority: "legacy_creative",
      table: "engine_v3_decision_snapshots_daily",
      snapshotAsOf: "2026-09-04",
      computedAt: "2026-09-04T06:00:00.000Z",
      engineVersion: "v3-test",
      fallbackReason: "native_generation_unavailable",
      generation: null,
    },
    queue: {
      deduplicationGrain: "creative",
      sourcePreCapCount: 0,
      queuedPreCapCount: 0,
      sections: {
        integrity_fires: canonicalSection("integrity_fires"),
        money_moves: canonicalSection("money_moves"),
        creative_rotation: canonicalSection("creative_rotation"),
      },
      omittedFromQueue: { count: 0, reasons: [] },
    },
    capabilities: {},
  };
}

const state = vi.hoisted(() => ({
  viewer: null as unknown,
  killSwitch: false,
  killSwitchReason: null as string | null,
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.routerPush, replace: state.routerReplace }),
  usePathname: () => "/platforms/meta",
  useSearchParams: () => new URLSearchParams("window=28d"),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (input: unknown) => unknown) =>
    selector({ businesses: [], selectBusiness: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: (input: { queryKey: unknown[] }) => {
    const key = String(input.queryKey[0]);
    const answer = (data: unknown) => ({
      data,
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
    });
    if (key === "meta-decisions-workspace") {
      const pulse = metaPulse();
      const lanes = metaLanePayload({
        actionNow: [bidRec()],
        watching: [],
        healthy: [metaHealthy()],
        counts: {
          actionNow: 1,
          watching: 0,
          healthy: 1,
          nonSales: 0,
          archive: 0,
        },
      });
      return answer({
        businessId: pulse.businessId,
        window: pulse.window,
        statusFilter: pulse.statusFilter,
        startDate: pulse.startDate,
        endDate: pulse.endDate,
        pulse,
        lanes,
        queue: { groups: [], actionStates: {} },
        system: {
          trackingBlocked: false,
          dataReadiness: pulse.dataReadiness ?? null,
          snapshotHealth: null,
          laneSnapshotDate: lanes.snapshotDate,
          laneSnapshotCreatedAt: null,
          engineVersion: pulse.engineVersion,
          currency: pulse.currency ?? null,
          killSwitchEngaged: state.killSwitch,
          killSwitchReason: state.killSwitchReason,
        },
        viewer: state.viewer,
        banners: [],
        decisionReadModel: decisionReadModel(),
      });
    }
    if (key === "meta-provider-accounts") {
      return answer([{ id: "act_9000000000001", name: "Harness", currency: "USD" }]);
    }
    if (key === "meta-anomalies") {
      return answer({ anomalies: [metaAnomaly()], snapshotDate: "2026-05-07", count: 1 });
    }
    return answer(null);
  },
}));

const { MetaPlatformPage } = await import(
  "@/components/meta/redesign/MetaPlatformPage"
);

/** The one row the mobile stage renders for the bid decision. */
function mobileRow() {
  const row = document.querySelector(
    `[data-mobile-row-id="scenario_e1_frequency_fatigue-${CAPPED_ADSET}"]`,
  );
  if (!row) throw new Error("the mobile stage rendered no row for the bid decision");
  return row as HTMLElement;
}

function mobileApply() {
  return document.querySelector(
    `[data-mobile-apply="scenario_e1_frequency_fatigue-${CAPPED_ADSET}"]`,
  ) as HTMLButtonElement | null;
}

function mount(props: { mutationUiEnabled?: boolean } = {}) {
  return render(
    <MetaPlatformPage
      businessId="b0000000-0000-4000-8000-0000000009a1"
      businessName="Decision card apply harness"
      currency="USD"
      mutationUiEnabled={props.mutationUiEnabled ?? true}
    />,
  );
}

beforeEach(() => {
  state.viewer = {
    role: "admin",
    isReviewer: false,
    readOnly: false,
    readOnlyReason: null,
  };
  state.killSwitch = false;
  state.killSwitchReason = null;
  state.routerPush.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the mobile decision card's manual apply", () => {
  it("offers the server's own verb on the card, inside the mobile stage", () => {
    mount();
    const apply = mobileApply();
    expect(apply, "the card offers no apply control").not.toBeNull();
    // The server's token, not a label invented here.
    expect(apply?.textContent).toBe("Apply · bid");
    expect(apply?.closest(".meta-mobile-decision-stage")).not.toBeNull();
    expect(mobileRow().contains(apply!)).toBe(true);
  });

  it("mounts the ceremony INSIDE the mobile stage, under a surface-scoped id", () => {
    mount();
    fireEvent.click(mobileApply()!);

    const mobileSheet = document.querySelector("#meta-manual-ceremony-mobile");
    const desktopSheet = document.querySelector("#meta-manual-ceremony");
    expect(mobileSheet).not.toBeNull();
    expect(desktopSheet).not.toBeNull();
    // Both panes are in the DOM at every width; only CSS hides one. An
    // unsuffixed id would be a real duplicate.
    expect(document.querySelectorAll("#meta-manual-ceremony-mobile")).toHaveLength(1);
    expect(document.querySelectorAll("#meta-manual-ceremony")).toHaveLength(1);
    expect(mobileSheet?.getAttribute("data-surface")).toBe("mobile");
    expect(desktopSheet?.getAttribute("data-surface")).toBe("desktop");
    expect(mobileSheet?.closest(".meta-mobile-decision-stage")).not.toBeNull();
    expect(desktopSheet?.closest(".meta-mobile-decision-stage")).toBeNull();

    // Same row, same served verb, on both.
    for (const sheet of [mobileSheet, desktopSheet]) {
      expect(sheet?.getAttribute("data-meta-manual-ceremony")).toBe(
        `scenario_e1_frequency_fatigue-${CAPPED_ADSET}`,
      );
      expect(
        [...sheet!.querySelectorAll("[data-mutation-action]")].map((node) =>
          node.getAttribute("data-mutation-action"),
        ),
      ).toEqual(["bid"]);
    }
  });

  it("drives the shipped preflight and dispatch contract from the mobile card", async () => {
    /*
      No mobile endpoint and no second seed: the requests below are the ones
      `buildMutationCeremonySeed` makes, and the dispatch path is the one the
      SERVER named in its own descriptor — this test never assembles it.
    */
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes("/api/meta/decision-action/preflight")) {
        return new Response(
          JSON.stringify({
            receipt: {
              verdict: "ready",
              detail: "Checked against persisted state.",
              checkedAt: new Date().toISOString(),
            },
            target: {
              grain: "adset",
              entityId: CAPPED_ADSET,
              providerAccountId: "act_9000000000001",
              status: "ACTIVE",
            },
            dispatch: {
              path: `/api/meta/adsets/${CAPPED_ADSET}/apply-bid`,
              body: { businessId: "b0000000-0000-4000-8000-0000000009a1" },
              operatorFields: [
                {
                  name: "bidAmountMinor",
                  kind: "minor_amount",
                  label: "Bid amount",
                  currency: "USD",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          outcome: "verified",
          durable: true,
          reference: "log_1",
          message: "HTTP 200",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    mount();
    fireEvent.click(mobileApply()!);
    const sheet = () => document.querySelector("#meta-manual-ceremony-mobile")!;
    fireEvent.click(sheet().querySelector('[data-mutation-action="bid"]')!);

    await waitFor(() =>
      expect(
        sheet().querySelector('[data-mutation-step="collect"]'),
      ).not.toBeNull(),
    );
    fireEvent.change(sheet().querySelector("[data-mutation-field]")!, {
      target: { value: "1320" },
    });
    fireEvent.click(sheet().querySelector("[data-mutation-review]")!);

    // The typed confirmation, in the shipped dialog.
    const phrase = await screen.findByLabelText(/Type\s+CHANGE BID\s+to confirm/i);
    fireEvent.change(phrase, { target: { value: "CHANGE BID" } });
    fireEvent.click(screen.getByRole("button", { name: "bid" }));

    await waitFor(() =>
      expect(
        sheet().querySelector('[data-mutation-outcome]')?.getAttribute("data-mutation-outcome"),
      ).toBe("verified"),
    );

    const preflights = calls.filter((call) =>
      call.url.includes("/api/meta/decision-action/preflight"),
    );
    // Once to open, once again immediately before the write.
    expect(preflights).toHaveLength(2);
    expect(preflights[0].body).toMatchObject({
      contract: "zero-base.decision.v1",
      decisionKey: `adset:${CAPPED_ADSET}`,
      action: "bid",
    });
    const dispatched = calls.filter((call) => call.url.includes("apply-bid"));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].url).toBe(`/api/meta/adsets/${CAPPED_ADSET}/apply-bid`);
    expect(dispatched[0].body).toMatchObject({
      businessId: "b0000000-0000-4000-8000-0000000009a1",
      bidAmountMinor: 1320,
    });
    expect(sheet().textContent).toContain("Applied and verified");
  });

  it("refuses on the phone when the STOP is engaged, and says why", () => {
    state.killSwitch = true;
    state.killSwitchReason = "Engaged from the Automation control plane.";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mount();
    const apply = mobileApply();
    // Present and refusing: a control that disappears takes the reason with it.
    expect(apply).not.toBeNull();
    expect(apply?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(apply!);
    expect(document.querySelector("#meta-manual-ceremony-mobile")).toBeNull();
    expect(
      document.querySelector("[data-mobile-apply-refusal]")?.textContent,
    ).toBe(
      "Meta writes are stopped for this workspace, so no manual action can be prepared.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a guest read-only on the phone, with the served reason", () => {
    state.viewer = {
      role: "guest",
      isReviewer: false,
      readOnly: true,
      readOnlyReason:
        "Your workspace role is Guest: all evidence is visible, write controls are downgraded to review.",
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mount();
    const apply = mobileApply();
    expect(apply?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(apply!);
    expect(document.querySelector("#meta-manual-ceremony-mobile")).toBeNull();
    expect(
      document.querySelector("[data-mobile-apply-refusal]")?.textContent,
    ).toBe(
      "Your workspace role is Guest: all evidence is visible, write controls are downgraded to review.",
    );
    expect(
      document.querySelector('[data-mobile-posture="viewer"]')?.textContent,
    ).toContain("executes none of them");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("states the gate rather than a device law when the sheet is not enabled", () => {
    mount({ mutationUiEnabled: false });
    expect(mobileApply()?.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.querySelector("[data-mobile-apply-refusal]")?.textContent,
    ).toContain("not enabled on this workspace yet");
    expect(document.querySelector("#meta-manual-ceremony-mobile")).toBeNull();
  });

  it("no longer tells the operator that writes are desktop-only", () => {
    mount();
    const stage = document.querySelector(".meta-mobile-decision-stage")!;
    expect(stage.textContent).not.toContain("Writes are desktop-only");
    expect(stage.textContent).not.toContain(
      "This device is read-only by design",
    );
    expect(stage.textContent).toContain(
      "the same manual action sheet the desktop carries",
    );
  });
});

/* --------------------------------------------- the phone's 44px promise */

/**
 * The ceremony's typed confirmation keeps a 44px target wherever it portals.
 *
 * WHAT WAS WRONG. The rule that raised the confirm dialog's controls to 44px
 * was written as `body > [role="dialog"] button`, which is a statement about
 * WHERE the dialog happens to land, not about WHICH dialog it is. It held only
 * because neither Meta route mounts `ZeroBasePortalHost`, so Radix fell back to
 * `document.body`. `components/zero-base/primitives/overlays.tsx` calls that
 * container "non-negotiable" and every zero-base overlay is meant to portal
 * into the host instead — so the codebase's own stated direction was the thing
 * that would break the promise. Driven with the ceremony mounted inside a
 * `ZeroBasePortalHost` (which is exactly how
 * `components/zero-base/interactions/interactions-meta-reports.test.tsx`
 * already mounts it), the shipped selector matched:
 *
 *     shipped selector:            body > [role="dialog"] button
 *     confirm control matched:     false
 *     cancel control matched:      false
 *     unrelated body dialog hit:   true
 *
 * The same selector also resized the buttons of EVERY body-level dialog under
 * 720px — Google's plan view, the workflow overlay, every other
 * `ZeroBaseDialog` — none of which asked for a phone hit target.
 *
 * WHAT THIS PINS. The rule is now scoped by the dialog's own IDENTITY: the
 * ceremony's confirm control is the only thing in the product that carries
 * `data-ctl="gated:META-WRITE-02 submit"` (`mutation-ceremony-panel.tsx`), so
 * `:has()` finds the ceremony's dialog and nothing else, at either portal
 * destination. The selector below is not copied — it is extracted from the
 * shipped `app/globals.css` at run time, so an edit to the stylesheet is run by
 * this test rather than described by it.
 */

/**
 * The shipped rule that promises a 44px target inside a dialog.
 *
 * Found by its DECLARATION, not by its selector text, so the test cannot be
 * satisfied by a rule that merely looks familiar: it is the rule under the
 * phone breakpoint whose selector list mentions `[role="dialog"]` and whose
 * body sets `min-height: 44px !important`.
 */
export function extractDialogHitTargetSelector(css: string): string {
  const rules = [...css.matchAll(/([^{}]*\[role="dialog"\][^{}]*)\{([^{}]*)\}/g)].filter(
    (match) => /min-height:\s*44px\s*!important/.test(match[2]),
  );
  if (rules.length !== 1) {
    throw new Error(
      `expected exactly one 44px dialog hit-target rule in app/globals.css, found ${rules.length}`,
    );
  }
  return rules[0][1].trim().replace(/\s+/g, " ");
}

/** Drives the shipped ceremony to its typed-confirmation dialog. */
async function openCeremonyConfirmDialog(wrap: (node: React.ReactNode) => React.ReactElement) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/meta/decision-action/preflight")) {
        return new Response(
          JSON.stringify({
            receipt: {
              verdict: "ready",
              detail: "Checked against persisted state.",
              checkedAt: new Date().toISOString(),
            },
            target: {
              grain: "adset",
              entityId: CAPPED_ADSET,
              providerAccountId: "act_9000000000001",
              status: "ACTIVE",
            },
            dispatch: {
              path: `/api/meta/adsets/${CAPPED_ADSET}/apply-bid`,
              body: { businessId: "b0000000-0000-4000-8000-0000000009a1" },
              operatorFields: [
                {
                  name: "bidAmountMinor",
                  kind: "minor_amount",
                  label: "Bid amount",
                  currency: "USD",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, outcome: "verified", durable: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

  render(
    wrap(
      <MetaPlatformPage
        businessId="b0000000-0000-4000-8000-0000000009a1"
        businessName="Decision card apply harness"
        currency="USD"
        mutationUiEnabled
      />,
    ),
  );
  fireEvent.click(mobileApply()!);
  const sheet = document.querySelector("#meta-manual-ceremony-mobile")!;
  fireEvent.click(sheet.querySelector('[data-mutation-action="bid"]')!);
  await waitFor(() =>
    expect(sheet.querySelector('[data-mutation-step="collect"]')).not.toBeNull(),
  );
  fireEvent.change(sheet.querySelector("[data-mutation-field]")!, {
    target: { value: "1320" },
  });
  fireEvent.click(sheet.querySelector("[data-mutation-review]")!);
  await screen.findByLabelText(/Type\s+CHANGE BID\s+to confirm/i);

  const confirm = document.querySelector<HTMLElement>(
    '[data-ctl="gated:META-WRITE-02 submit"]',
  );
  if (!confirm) throw new Error("the ceremony's confirm control never rendered");
  const dialog = confirm.closest('[role="dialog"]');
  if (!dialog) throw new Error("the confirm control is not inside a dialog");
  return { confirm, dialog: dialog as HTMLElement };
}

describe("the ceremony's confirm dialog keeps its 44px target wherever it portals", () => {
  const selector = extractDialogHitTargetSelector(
    readFileSync(join(process.cwd(), "app/globals.css"), "utf8"),
  );

  it("matches the confirm control when Radix falls back to document.body", async () => {
    const { confirm, dialog } = await openCeremonyConfirmDialog((node) => <>{node}</>);
    // The precondition this case is about: no host, so body is the parent.
    expect(dialog.parentElement).toBe(document.body);
    expect([...document.querySelectorAll(selector)]).toContain(confirm);
  });

  it("matches the confirm control when the dialog portals into ZeroBasePortalHost", async () => {
    const { confirm, dialog } = await openCeremonyConfirmDialog((node) => (
      <ZeroBasePortalHost>{node}</ZeroBasePortalHost>
    ));
    // The precondition: the canonical host, which overlays.tsx calls
    // non-negotiable and which every interactions test already mounts.
    expect(isInsideCanonicalPortal(dialog)).toBe(true);
    expect(dialog.parentElement).not.toBe(document.body);
    expect([...document.querySelectorAll(selector)]).toContain(confirm);
  });

  it("also raises the dialog's Cancel, which sits beside the control that writes", async () => {
    const { dialog } = await openCeremonyConfirmDialog((node) => <>{node}</>);
    const cancel = dialog.querySelector<HTMLElement>('[data-ctl="live:cancel"]')!;
    expect(cancel).not.toBeNull();
    expect([...document.querySelectorAll(selector)]).toContain(cancel);
  });

  it("leaves every unrelated body-level dialog alone", async () => {
    // A real `ZeroBaseDialog` — the same primitive Google's plan view and the
    // workflow overlay use — with its own contract key and no portal host, so
    // it lands at body exactly where the old selector caught it.
    render(
      <ZeroBaseDialog
        open
        onOpenChange={() => {}}
        title="An unrelated overlay"
        confirmLabel="Continue"
        confirmCtl="gated:META-WRITE-02 continue"
        onConfirm={() => {}}
      />,
    );
    const other = document.querySelector<HTMLElement>(
      '[data-ctl="gated:META-WRITE-02 continue"]',
    )!;
    expect(other).not.toBeNull();
    expect(other.closest('[role="dialog"]')?.parentElement).toBe(document.body);
    expect([...document.querySelectorAll(selector)]).not.toContain(other);
  });
});
