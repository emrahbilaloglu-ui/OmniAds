// @vitest-environment jsdom

/**
 * WP-26 group 3 / G7 — Meta decisions, the write ceremony, intelligence,
 * history, automation, reports, launchpad, team and SEO.
 */
import React from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  expectNavigates,
  expectOperable,
  flushInteractionResults,
  interactionCase,
} from "@/components/zero-base/interactions/interaction-harness";

import { DecisionsView } from "@/components/zero-base/_reference/meta-decisions-view";
import { buildDecisionsViewModel } from "@/lib/zero-base/meta/decisions-presentation";
import {
  MutationCeremonyPanel,
  type Step as CeremonyStep,
} from "@/components/zero-base/meta/decisions/mutation-ceremony-panel";
import { IntelligenceView } from "@/components/zero-base/meta/intelligence/intelligence-view";
import { HistoryView } from "@/components/zero-base/meta/history/history-view";
import { MetaAutomationView } from "@/app/(dashboard)/platforms/meta/automation/automation-view";
import {
  AUTOMATION_HARNESS_VIEWER,
  automationControlPlaneFixture,
} from "@/scripts/zero-base/fixtures/automation-control-plane";
import {
  ReportBuilderView,
  ReportLibraryView,
} from "@/components/zero-base/reports/report-views";
import { LaunchpadView } from "@/components/zero-base/launchpad/launchpad-view";
import { TeamView } from "@/components/zero-base/manage/manage-views";
import { SeoView } from "@/components/zero-base/analytics/analytics-views";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/c/biz/meta/decisions",
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
const allCtl = (key: string) => [...document.querySelectorAll(`[data-ctl="${key}"]`)];

/* ------------------------------------------------------------- decisions */

const rec = (index: number) => ({
  id: `d${index}`,
  level: "campaign",
  type: "campaign_state",
  lens: "profitability",
  priority: "high",
  confidence: "high",
  decisionState: "act",
  decision: "Scale up",
  title: `Prospecting ${index}`,
  why: "ROAS above target.",
  summary: "",
  recommendedAction: "Raise the budget.",
  expectedImpact: "",
  evidence: [],
  timeframeContext: {},
  campaignName: `Prospecting ${index}`,
});

const lane = (rows: ReturnType<typeof rec>[]) => ({
  businessId: "biz",
  startDate: "2026-07-13",
  endDate: "2026-08-09",
  sourceModel: "v3",
  snapshotDate: "2026-08-09",
  snapshotCreatedAt: "2026-08-09T06:00:00Z",
  actionNow: rows,
  watching: [],
  healthy: [],
  nonSales: [],
  archive: [],
  deferredIds: [],
  counts: { actionNow: rows.length, watching: 0, healthy: 0, nonSales: 0, archive: 0 },
});

const VIEWER = { role: "collaborator" as const, isReviewer: false, readOnly: false, readOnlyReason: null };
const BASE_STATE = { lane: "act" as const, levels: [], search: "", selected: null };

const WORKFLOW_RECORD = {
  businessId: "biz",
  decisionKey: "d1",
  state: "open" as const,
  assigneeUserId: null,
  dueAt: null,
  snoozeUntil: null,
  reasonCode: null,
  stateVersion: 3,
};

function renderDecisions(options: Record<string, unknown> = {}) {
  const state = { ...BASE_STATE, ...(options.state as object) };
  const onStateChange = options.onStateChange ?? vi.fn();
  render(
    <Host>
      <DecisionsView
        model={buildDecisionsViewModel({
          lane: lane([rec(1), rec(2)]) as never,
          banners: [],
          viewer: VIEWER,
          state,
        })}
        state={state}
        demo={false}
        onStateChange={onStateChange as never}
        adsManagerHref="https://adsmanager.facebook.com/"
        workflow={{
          records: new Map([["d1", WORKFLOW_RECORD]]),
          events: [],
          loadState: { kind: "ready" },
          onSubmit: async () => ({ ok: true }),
          newMutationId: () => "wf_1",
          initialConflict: options.conflict
            ? {
                current: { ...WORKFLOW_RECORD, state: "acknowledged", stateVersion: 4 },
                attempted: { action: "resolve", fromVersion: 3 },
                message: "This decision changed while you were reading it.",
              }
            : null,
        } as never}
        {...(options.props as object)}
      />
    </Host>,
  );
  return onStateChange as ReturnType<typeof vi.fn>;
}

/* ---------------------------------------------------------- ceremony seed */

const TARGET = {
  grain: "adset" as const,
  entityId: "238",
  providerAccountId: "act_1",
  status: "ACTIVE",
};
const DISPATCH = {
  path: "/api/meta/adsets/238/apply-bid",
  body: {},
  operatorFields: [
    {
      name: "bidAmountMinor" as const,
      kind: "minor_amount" as const,
      label: "Bid",
      currency: "USD",
      required: true as const,
    },
  ],
  issuedAt: "2026-08-09T07:10:00Z",
  note: null,
};
const CEREMONY_ROW = {
  id: "d1",
  level: "adset" as const,
  title: "Prospecting",
  decision: "Scale",
  why: "ROAS.",
  recommendedAction: "Raise.",
  confidence: "high" as const,
  confidenceReason: null,
  decisionState: "act" as const,
  campaignName: "Prospecting",
  adsetName: "Broad",
  held: false,
  heldReason: null,
};
const seed = () => ({
  businessId: "biz",
  enabled: true as const,
  viewer: { isReviewer: false, demo: false, role: "admin" as const },
  preflight: async () => ({
    ok: true as const,
    target: TARGET,
    verdict: "ready" as const,
    detail: "Ready.",
    checkedAt: "2026-08-09T07:10:00Z",
    dispatch: DISPATCH,
  }),
  dispatch: async () => ({
    outcome: "verified" as const,
    durable: true,
    reference: "mut_1",
    detail: "Confirmed.",
  }),
  newMutationId: () => "mut_1",
  now: () => new Date("2026-08-09T07:12:00Z"),
});

const ceremony = (initialStep?: CeremonyStep) =>
  render(
    <Host>
      <MutationCeremonyPanel row={CEREMONY_ROW} seed={seed()} initialStep={initialStep} />
    </Host>,
  );

const COLLECT: CeremonyStep = {
  kind: "collect",
  action: "bid",
  dispatch: DISPATCH,
  target: TARGET,
  checkedAt: "2026-08-09T07:10:00Z",
};

afterEach(cleanup);
afterAll(() => flushInteractionResults("meta-reports"));

describe("G7 — Meta decisions", () => {
  interactionCase("live:META-DEC-01 lane", async () => {
    const user = userEvent.setup();
    const onStateChange = renderDecisions();
    const tabs = allCtl("live:META-DEC-01 lane");
    expect(tabs.length).toBeGreaterThan(1);
    await user.click(tabs[1]);
    expect(onStateChange).toHaveBeenCalled();
    // Changing lane clears the selection: a row from one lane is not a row in
    // another, and keeping it would open an inspector on nothing.
    expect(onStateChange.mock.calls[0][0].selected).toBeNull();
  });

  interactionCase("live:META-DEC-02 level", async () => {
    const user = userEvent.setup();
    const onStateChange = renderDecisions();
    const level = expectOperable(ctl("live:META-DEC-02 level"), "level filter") as HTMLSelectElement;
    await user.selectOptions(level, "campaign");
    expect(onStateChange).toHaveBeenCalled();
    expect(onStateChange.mock.calls[0][0].levels.length).toBe(1);
  });

  interactionCase("live:META-DEC-17 search", async () => {
    const user = userEvent.setup();
    const onStateChange = renderDecisions();
    await user.type(expectOperable(ctl("live:META-DEC-17 search"), "search"), "Pro");
    expect(onStateChange).toHaveBeenCalled();
    expect(onStateChange.mock.calls.at(-1)![0].search).toBe("Pro");
  });

  interactionCase("live:META-DEC-05 open-inspector", async () => {
    const user = userEvent.setup();
    const onStateChange = renderDecisions();
    await user.click(expectOperable(ctl("live:META-DEC-05 open-inspector"), "open inspector"));
    expect(onStateChange.mock.calls[0][0].selected).toBe("d1");
  });

  interactionCase("live:META-DEC-13 open", async () => {
    renderDecisions();
    const link = expectOperable(ctl("live:META-DEC-13 open"), "ads manager");
    // A link out, explicitly, never dressed as something that happened here.
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  interactionCase("live:INV-18 share-view", async () => {
    renderDecisions({ props: { shareViewHref: "/c/biz/meta/decisions?lane=act" } });
    expectNavigates(ctl("live:INV-18 share-view"), /lane=act/, "share view");
  });

  interactionCase("live:close", async () => {
    const user = userEvent.setup();
    const onStateChange = renderDecisions({ state: { selected: "d1" } });
    const close = expectOperable(ctl("live:close"), "close inspector");
    await user.click(close);
    // The selection is what closes it, and it survives in the URL state the
    // caller owns rather than being discarded here.
    await waitFor(() => expect(onStateChange).toHaveBeenCalled());
    expect(onStateChange.mock.calls.at(-1)![0].selected).toBeNull();
  });

  interactionCase("live:lane", async () => {
    renderDecisions();
    expect(ctl("live:lane"), "the lane region is present").not.toBeNull();
  });

  interactionCase("gated:META-WRITE-01", async () => {
    const user = userEvent.setup();
    const onOpenManual = vi.fn();
    renderDecisions({
      state: { selected: "d1" },
      props: { stickyBar: { metaStopHref: "/c/biz/meta/automation", onOpenManual } },
    });
    // At narrow widths the decision detail is the end of Flow A, so the write
    // sheet and the Meta-stop path both stay one tap away (INV-17).
    await user.click(expectOperable(ctl("gated:META-WRITE-01"), "open write sheet"));
    expect(onOpenManual).toHaveBeenCalledTimes(1);
    expectNavigates(ctl("live:nav"), /\/meta\/automation$/, "meta stop");
  });

  it("the terminus bar exists only where the rail does not", () => {
    renderDecisions({ state: { selected: "d1" } });
    // No sticky bar at desktop widths: the rail already carries the path, and
    // a duplicate would be a second, competing way to the same surface.
    expect(document.querySelector("[data-decision-sticky-bar]")).toBeNull();
  });

  interactionCase("gated:META-WF-02..08 menu", async () => {
    const user = userEvent.setup();
    renderDecisions({ state: { selected: "d1" } });
    const actions = allCtl("gated:META-WF-02..08 menu");
    expect(actions.length).toBeGreaterThan(0);
    await user.click(actions[0]);
    // The transition form opens rather than firing straight into a write.
    expect(document.querySelector("[data-workflow-panel]")).not.toBeNull();
  });

  interactionCase("live:META-WF-11 reapply", async () => {
    renderDecisions({ state: { selected: "d1" }, conflict: true });
    expectOperable(ctl("live:META-WF-11 reapply"), "reapply");
    // The conflict states both versions so the operator can see what moved.
    expect(document.querySelector("[data-workflow-conflict-current]")).not.toBeNull();
  });

  interactionCase("live:META-WF-11 keep", async () => {
    const user = userEvent.setup();
    renderDecisions({ state: { selected: "d1" }, conflict: true });
    const keep = expectOperable(ctl("live:META-WF-11 keep"), "keep current");
    await user.click(keep);
    // Accepting the current state ends the conflict without writing.
    await waitFor(() => expect(document.querySelector("[data-workflow-conflict]")).toBeNull());
  });
});

describe("G7 — manual write ceremony", () => {
  interactionCase("gated:META-WRITE-01 open-manual", async () => {
    ceremony();
    expectOperable(ctl("gated:META-WRITE-01 open-manual"), "open manual write");
  });

  interactionCase("gated:META-WRITE-02 continue", async () => {
    const user = userEvent.setup();
    ceremony(COLLECT);
    // The preflight's age is stated before it goes stale, not only after.
    expect(document.querySelector('[data-el="preflight-age"]')?.textContent).toContain(
      "Meta was not contacted",
    );
    await user.click(expectOperable(ctl("gated:META-WRITE-02 continue"), "continue"));
    // Missing operator input stops it here rather than at the provider.
    await waitFor(() => expect(document.querySelector("[data-mutation-problems]")).not.toBeNull());
  });

  interactionCase("live:META-WRITE-06 rerun", async () => {
    ceremony(COLLECT);
    expectOperable(ctl("live:META-WRITE-06 rerun"), "re-check");
  });

  interactionCase("gated:META-WRITE-02 submit", async () => {
    // "pause" is acknowledged rather than typed-phrase, so the confirm is
    // enabled without a phrase; the typed-phrase path is covered by the
    // ceremony's own tests.
    ceremony({ ...COLLECT, kind: "confirm", action: "pause" });
    const submit = expectOperable(ctl("gated:META-WRITE-02 submit"), "submit");
    // The confirmation restates scope before anything is sent.
    expect(document.querySelector('[data-el="confirm-restate"]')?.textContent).toContain("act_1");
    expect(submit).toBeTruthy();
  });

  interactionCase("live:META-WRITE-08 copy-receipt", async () => {
    ceremony({
      kind: "terminal",
      action: "bid",
      answer: { outcome: "verified", durable: true, reference: "mut_1", detail: "Confirmed." },
    });
    expectOperable(ctl("live:META-WRITE-08 copy-receipt"), "copy receipt");
  });

  interactionCase("live:done", async () => {
    const user = userEvent.setup();
    ceremony({
      kind: "terminal",
      action: "bid",
      answer: { outcome: "verified", durable: true, reference: "mut_1", detail: "Confirmed." },
    });
    await user.click(expectOperable(ctl("live:done"), "done"));
    await waitFor(() => expect(document.querySelector("[data-mutation-step]")).toBeNull());
  });

  it("withholds a receipt when nothing is durably settled", () => {
    ceremony({
      kind: "terminal",
      action: "bid",
      answer: {
        outcome: "provider_outcome_ambiguous",
        durable: false,
        reference: null,
        detail: "Unsettled.",
      },
    });
    expect(ctl("live:META-WRITE-08 copy-receipt")).toBeNull();
    expect(document.querySelector("[data-mutation-receipt-withheld]")).not.toBeNull();
  });
});

describe("G7 — intelligence, history, automation", () => {
  interactionCase("gated:META-INTEL-09 run-snapshot", async () => {
    const user = userEvent.setup();
    const onRunSnapshot = vi.fn();
    render(
      <Host>
        <IntelligenceView
          sources={[{ key: "s", label: "Meta", state: "serving", reason: null, observedAt: null }]}
          snapshot={{ canRun: true, reason: null, queued: false }}
          onRunSnapshot={onRunSnapshot}
          onRespond={vi.fn()}
        />
      </Host>,
    );
    await user.click(expectOperable(ctl("gated:META-INTEL-09 run-snapshot"), "run snapshot"));
    expect(onRunSnapshot).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:META-INTEL-07 respond", async () => {
    /*
     * On the section that OWNS the control, and with the server's own state.
     *
     * This used to render the control on any section whenever an `onRespond`
     * prop was passed — which no page ever did — so the case graded an
     * affordance nothing mounted. The control now appears where the composer
     * said there is one, and its availability comes from the same `control`
     * the server authored.
     *
     * It also used to hand the handler a SECTION key, which the respond route
     * has no use for: it writes one row per `rec_id`. The served targets are
     * on the control now, and the first is what an untouched picker aims at.
     */
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(
      <Host>
        <IntelligenceView
          sources={[
            {
              key: "recommendations",
              label: "Recommendations",
              state: "serving",
              reason: null,
              observedAt: null,
              control: {
                kind: "respond",
                enabled: true,
                refusalCode: null,
                refusalMessage: null,
                targets: [{ recId: "rec_1", label: "Scale the winning ad set" }],
              },
            },
          ]}
          onRespond={onRespond}
        />
      </Host>,
    );
    await user.selectOptions(
      expectOperable(ctl("live:META-INTEL-07 respond"), "respond") as HTMLSelectElement,
      "acted",
    );
    expect(onRespond).toHaveBeenCalledWith("rec_1", "acted");
  });

  it("refuses the respond control with the server's §9.1 reason", () => {
    render(
      <Host>
        <IntelligenceView
          sources={[
            {
              key: "recommendations",
              label: "Recommendations",
              state: "serving",
              reason: null,
              observedAt: null,
              readState: "refused",
              readFailureCode: "reviewer_read_only",
              control: {
                kind: "respond",
                enabled: false,
                refusalCode: "reviewer_read_only",
                refusalMessage: "Reviewer access is read-only.",
              },
            },
          ]}
          onRespond={vi.fn()}
        />
      </Host>,
    );
    const control = ctl("live:META-INTEL-07 respond") as HTMLSelectElement;
    expect(control.disabled).toBe(true);
    expect(
      document.querySelector('[data-section-control-reason="respond"]')?.textContent,
    ).toContain("read-only");
    expect(
      document
        .querySelector('[data-section-control="respond"]')
        ?.getAttribute("data-section-control-refusal"),
    ).toBe("reviewer_read_only");
  });

  const history = (props: Record<string, unknown> = {}) =>
    render(
      <Host>
        <HistoryView
          rows={[
            {
              id: "h1",
              occurredAt: "2026-08-09",
              action: "Budget raised",
              outcome: "Confirmed",
              actor: "Dana",
              replayed: false,
            },
          ]}
          onQueryChange={vi.fn()}
          onOutcomeFilterChange={vi.fn()}
          onLoadMore={vi.fn()}
          onReplay={vi.fn()}
          onClose={vi.fn()}
          {...props}
        />
      </Host>,
    );

  interactionCase("live:META-HIST-05 search", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    history({ onQueryChange });
    await user.type(expectOperable(ctl("live:META-HIST-05 search"), "history search"), "b");
    expect(onQueryChange).toHaveBeenCalledWith("b");
    // Says it searches everything, not only the loaded page.
    expect(document.body.textContent).toMatch(/not only the rows loaded here/i);
  });

  interactionCase("live:META-HIST-05 filter", async () => {
    const user = userEvent.setup();
    const onOutcomeFilterChange = vi.fn();
    history({ onOutcomeFilterChange });
    await user.selectOptions(
      expectOperable(ctl("live:META-HIST-05 filter"), "history filter") as HTMLSelectElement,
      "failed",
    );
    expect(onOutcomeFilterChange).toHaveBeenCalledWith("failed");
  });

  interactionCase("live:META-HIST-05 cursor", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    history({ onLoadMore });
    await user.click(expectOperable(ctl("live:META-HIST-05 cursor"), "history cursor"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:META-HIST-06 replay", async () => {
    const user = userEvent.setup();
    const onReplay = vi.fn();
    history({ onReplay });
    await user.click(expectOperable(ctl("live:META-HIST-06 replay"), "replay"));
    expect(onReplay).toHaveBeenCalledWith("h1");
  });

  /**
   * The MOUNTED Automation body, from the served control plane.
   *
   * These three keys grade controls an operator can reach, and every route that
   * shows Automation renders `MetaAutomationView`. Grading the archived
   * presenter meant the contract could be satisfied by a component nobody could
   * open — and it hid a real mismatch: the archived body's mode control offered
   * `observe|suggest|act`, a vocabulary the server has never accepted.
   *
   * `killSwitchEngaged` is the only fact separating the two stop cases, exactly
   * as it separates H19 from H20.
   *
   * The reading is stamped NOW rather than at the fixture's frozen instant.
   * The mounted body refuses a confirmation made against a reading older than
   * five minutes — the operator would be acting on a state that may have moved
   * — and the fixture's instant is frozen so the frame harness can screenshot
   * it deterministically. These cases grade the control an operator can reach
   * when nothing refuses it, so they supply a reading that is not stale.
   */
  const automation = (
    intent: "engage" | "release",
    props: Record<string, unknown> = {},
  ) =>
    render(
      <Host>
        <MetaAutomationView
          payload={automationControlPlaneFixture({
            killSwitchEngaged: intent === "release",
            businessControlObservedAt: new Date().toISOString(),
          })}
          businessId="biz"
          providerAccountId="act_1"
          viewer={AUTOMATION_HARNESS_VIEWER}
          {...props}
        />
      </Host>,
    );

  interactionCase("gated:AUTO-01A engage", async () => {
    automation("engage");
    expectOperable(ctl("gated:AUTO-01A engage"), "engage stop");
  });

  interactionCase("gated:AUTO-02 release", async () => {
    automation("release");
    expectOperable(ctl("gated:AUTO-02 release"), "release stop");
  });

  interactionCase("gated:AUTO-03 mode", async () => {
    /**
     * Against the MOUNTED body, and against the wire.
     *
     * This case used to drive the archived presenter's `<select>` and assert a
     * callback was called with `"suggest"` — a vocabulary the server has never
     * had. `MetaAutomationDecisionMode` is `manual | semi_auto | auto`, and the
     * route takes `{action: "set_decision_type_mode", decisionType, mode}`. The
     * old assertion could not have failed if the product were broken, because
     * it was not measuring the product.
     */
    const user = userEvent.setup();
    const posts: { url: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      // The re-read the control performs before it believes anything.
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: automationControlPlaneFixture() }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <Host>
          <MetaAutomationView
            payload={automationControlPlaneFixture()}
            businessId="biz"
            providerAccountId="act_1"
            viewer={AUTOMATION_HARNESS_VIEWER}
          />
        </Host>,
      );

      const group = ctl("gated:AUTO-03 mode") as HTMLElement;
      expect(group.getAttribute("role")).toBe("radiogroup");
      // The accessible name is the operator's own sentence now, not a rung on
      // an internal readiness ladder they never see.
      const segment = within(group).getByRole("radio", {
        name: "Automatic · applied within your guardrails",
      });
      expectOperable(segment, "automation mode");
      await user.click(segment);

      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]!.url).toContain("/api/meta/automation");
      expect(posts[0]!.body).toMatchObject({
        action: "set_decision_type_mode",
        mode: "auto",
      });
      expect((posts[0]!.body as { decisionType: string }).decisionType).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses the mode control for a viewer who may not write", () => {
    /** A viewer who may not write gets the control refused, with the server's reason. */
    render(
      <Host>
        <MetaAutomationView
          payload={automationControlPlaneFixture()}
          businessId="biz"
          providerAccountId="act_1"
          viewer={{
            role: "guest",
            reviewerReadOnly: true,
            demo: false,
            canMutate: false,
            reason: "Reviewer sessions are read-only.",
            reasonCode: "reviewer_read_only",
          }}
        />
      </Host>,
    );
    const group = ctl("gated:AUTO-03 mode") as HTMLElement;
    expect(group.getAttribute("data-mode-refused")).toBe("");
    for (const radio of within(group).getAllByRole("radio")) {
      expect(radio).toBeDisabled();
      expect(radio.getAttribute("title")).toBe("Reviewer sessions are read-only.");
    }
  });
});

describe("G7 — reports", () => {
  const library = (props: Record<string, unknown> = {}) =>
    render(
      <Host>
        <ReportLibraryView
          reports={[{ id: "r1", name: "Weekly", updatedAt: "2026-08-11" }]}
          businessId="biz"
          totalCount={9}
          onCreate={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
          onLoadMore={vi.fn()}
          {...props}
        />
      </Host>,
    );

  const builder = (props: Record<string, unknown> = {}) =>
    render(
      <Host>
        <ReportBuilderView
          initial={{
            widgets: [{ id: "w1", sourceId: "overview_summary", label: "Spend", x: 0, y: 0, w: 4, h: 2 }],
          }}
          name="Weekly"
          onNameChange={vi.fn()}
          onSave={vi.fn()}
          onExportCsv={vi.fn()}
          onRetryWidgets={vi.fn()}
          {...props}
        />
      </Host>,
    );

  interactionCase("live:REPORT-13 new", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    library({ onCreate });
    await user.click(expectOperable(ctl("live:REPORT-13 new"), "new report"));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:REPORT-08 open", async () => {
    library();
    expectNavigates(ctl("live:REPORT-08 open"), /\/reports\/r1$/, "open report");
  });

  interactionCase("live:REPORT-02 edit", async () => {
    library();
    expectNavigates(ctl("live:REPORT-02 edit"), /\/reports\/r1\/edit$/, "edit report");
  });

  interactionCase("live:REPORT-01 duplicate", async () => {
    const user = userEvent.setup();
    const onDuplicate = vi.fn();
    library({ onDuplicate });
    await user.click(expectOperable(ctl("live:REPORT-01 duplicate"), "duplicate"));
    expect(onDuplicate).toHaveBeenCalledWith("r1");
  });

  interactionCase("gated:REPORT-01 delete", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    library({ onDelete });
    await user.click(expectOperable(ctl("gated:REPORT-01 delete"), "delete report"));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(expectOperable(ctl("gated:REPORT-01 delete-confirm"), "confirm report deletion"));
    expect(onDelete).toHaveBeenCalledWith("r1");
  });

  it("states why delete is unavailable rather than hiding it", () => {
    library({ onDelete: undefined });
    const del = ctl("gated:REPORT-01 delete");
    expect(del?.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(del!.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toMatch(/admin/i);
  });

  interactionCase("live:REPORT-01 load-more", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    library({ onLoadMore });
    // The disclosure restates how many of how many, so paging is a decision.
    expect(document.body.textContent).toContain("Showing 1 of 9 reports.");
    await user.click(expectOperable(ctl("live:REPORT-01 load-more"), "load more"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:REPORT-03 widget-select", async () => {
    const user = userEvent.setup();
    builder();
    await user.click(expectOperable(ctl("live:REPORT-03 widget-select"), "widget"));
    // Selecting attaches the nudge toolbar below the canvas.
    await waitFor(() => expect(document.querySelector("[data-builder-nudge-toolbar]")).not.toBeNull());
  });

  interactionCase("live:REPORT-03 nudge-move", async () => {
    const user = userEvent.setup();
    builder();
    const before = document.querySelector("[data-widget]")?.getAttribute("data-widget-x");
    await user.click(allCtl("live:REPORT-03 nudge-move")[1]);
    await waitFor(() =>
      expect(document.querySelector("[data-widget]")?.getAttribute("data-widget-x")).not.toBe(before),
    );
  });

  interactionCase("live:REPORT-03 nudge-resize", async () => {
    const user = userEvent.setup();
    builder();
    const before = document.querySelector("[data-widget]")?.getAttribute("data-widget-w");
    await user.click(allCtl("live:REPORT-03 nudge-resize")[1]);
    await waitFor(() =>
      expect(document.querySelector("[data-widget]")?.getAttribute("data-widget-w")).not.toBe(before),
    );
  });

  interactionCase("live:REPORT-03 undo", async () => {
    const user = userEvent.setup();
    builder();
    const before = document.querySelector("[data-widget]")?.getAttribute("data-widget-x");
    await user.click(allCtl("live:REPORT-03 nudge-move")[1]);
    await waitFor(() =>
      expect(document.querySelector("[data-widget]")?.getAttribute("data-widget-x")).not.toBe(before),
    );
    await user.click(expectOperable(ctl("live:REPORT-03 undo"), "undo"));
    await waitFor(() =>
      expect(document.querySelector("[data-widget]")?.getAttribute("data-widget-x")).toBe(before),
    );
  });

  interactionCase("live:REPORT-03 keyboard-mode", async () => {
    const user = userEvent.setup();
    builder();
    const toggle = expectOperable(ctl("live:REPORT-03 keyboard-mode"), "keyboard mode");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
  });

  interactionCase("live:REPORT-03 exit", async () => {
    const user = userEvent.setup();
    builder();
    await user.click(expectOperable(ctl("live:REPORT-03 exit"), "exit"));
    // Committing the layout retires the toolbar with it.
    await waitFor(() => expect(document.querySelector("[data-builder-nudge-toolbar]")).toBeNull());
  });

  interactionCase("live:REPORT-04 csv", async () => {
    const user = userEvent.setup();
    const onExportCsv = vi.fn();
    builder({ onExportCsv });
    await user.click(expectOperable(ctl("live:REPORT-04 csv"), "csv"));
    expect(onExportCsv).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:REPORT-07 breakdown", async () => {
    const user = userEvent.setup();
    builder();
    await user.selectOptions(
      expectOperable(ctl("live:REPORT-07 breakdown"), "breakdown") as HTMLSelectElement,
      "campaign",
    );
    await waitFor(() =>
      expect((ctl("live:REPORT-07 breakdown") as HTMLSelectElement).value).toBe("campaign"),
    );
  });

  interactionCase("live:REPORT-08 retry", async () => {
    const user = userEvent.setup();
    const onRetryWidgets = vi.fn();
    builder({ onRetryWidgets });
    await user.click(expectOperable(ctl("live:REPORT-08 retry"), "retry widgets"));
    expect(onRetryWidgets).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:REPORT-05 source-toggle", async () => {
    const user = userEvent.setup();
    builder();
    const add = document.querySelector("[data-source-add]");
    expect(add, "a source can be added").not.toBeNull();
    const before = document.querySelectorAll("[data-widget]").length;
    await user.click(add as HTMLElement);
    await waitFor(() =>
      expect(document.querySelectorAll("[data-widget]").length).toBeGreaterThan(before),
    );
  });

  interactionCase("disabled:REPORT-06 source-unavailable", async () => {
    builder();
    const unavailable = document.querySelector("[data-source-unavailable]");
    // Disabled, never hidden: hidden reads as "this data does not exist"
    // rather than "not wired yet".
    expect(unavailable).not.toBeNull();
    expect(unavailable!.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("G7 — launchpad, team and SEO", () => {
  const launchpad = (props: Record<string, unknown> = {}) =>
    render(
      <Host>
        <LaunchpadView
          templates={[{ id: "t1", name: "Prospecting", createdAt: "2026-08-09" }]}
          drafts={[]}
          findings={[
            { id: "f1", field: "dailyBudget", severity: "error", message: "Below minimum." },
            { id: "f2", field: "audience", severity: "warning", message: "Overlaps." },
          ]}
          onCreateDraft={vi.fn()}
          onValidate={vi.fn()}
          onDuplicateTemplate={vi.fn()}
          onDeleteTemplate={vi.fn()}
          {...props}
        />
      </Host>,
    );

  interactionCase("live:LAUNCH-01 fix", async () => {
    launchpad();
    expectOperable(allCtl("live:LAUNCH-01 fix")[0], "fix error");
  });

  interactionCase("live:LAUNCH-02 fix", async () => {
    launchpad();
    expectOperable(allCtl("live:LAUNCH-02 fix")[0], "fix warning");
  });

  interactionCase("live:LAUNCH-03 duplicate", async () => {
    const user = userEvent.setup();
    const onDuplicateTemplate = vi.fn();
    launchpad({ onDuplicateTemplate });
    await user.click(expectOperable(ctl("live:LAUNCH-03 duplicate"), "duplicate template"));
    expect(onDuplicateTemplate).toHaveBeenCalled();
  });

  interactionCase("gated:LAUNCH-03 delete", async () => {
    const user = userEvent.setup();
    const onDeleteTemplate = vi.fn();
    launchpad({ onDeleteTemplate });
    await user.click(expectOperable(ctl("gated:LAUNCH-03 delete"), "delete template"));
    expect(onDeleteTemplate).toHaveBeenCalledWith("t1");
  });

  interactionCase("live:LAUNCH-05 validate", async () => {
    launchpad();
    // Needs a name before it can save a draft; the reason is stated.
    const validate = ctl("live:LAUNCH-05 validate");
    expect(validate).not.toBeNull();
  });

  interactionCase("disabled:LAUNCH-06 launch", async () => {
    launchpad();
    const launch = ctl("disabled:LAUNCH-06 launch");
    expect(launch?.getAttribute("aria-disabled")).toBe("true");
    // The prerequisites are listed, not summarised as "coming soon".
    expect(document.querySelector("[data-launch-prerequisites]")).not.toBeNull();
  });

  interactionCase("disabled:LAUNCH-07 add", async () => {
    launchpad();
    expect(ctl("disabled:LAUNCH-07 add")?.getAttribute("aria-disabled")).toBe("true");
  });

  const ALLOWED = { ok: true };
  const team = (permissions: Record<string, unknown>, props: Record<string, unknown> = {}) =>
    render(
      <Host>
        <TeamView
          members={[
            {
              membershipId: "m1",
              name: "Ada",
              email: "ada@x.test",
              role: "collaborator",
              status: "active",
            },
          ] as never}
          invites={(props.invites ?? []) as never}
          accessRequests={
            [
              { membershipId: "m9", name: "Rae", email: "rae@x.test", role: "collaborator", status: "pending" },
            ] as never
          }
          workspaces={[]}
          permissions={permissions as never}
          write={{ pending: null, error: null, confirmed: null } as never}
          {...props}
        />
      </Host>,
    );

  interactionCase("gated:TEAM-02 role", async () => {
    const user = userEvent.setup();
    const onChangeRole = vi.fn();
    team({ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED }, { onChangeRole });
    await user.selectOptions(
      expectOperable(ctl("gated:TEAM-02 role"), "role") as HTMLSelectElement,
      "admin",
    );
    expect(onChangeRole).toHaveBeenCalledWith("m1", "admin");
  });

  interactionCase("gated:TEAM-05 approve", async () => {
    const user = userEvent.setup();
    const onAccessRequest = vi.fn();
    team({ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED }, { onAccessRequest });
    await user.click(expectOperable(ctl("gated:TEAM-05 approve"), "approve"));
    expect(onAccessRequest).toHaveBeenCalledWith("m9", "approve");
  });

  interactionCase("gated:TEAM-05 deny", async () => {
    const user = userEvent.setup();
    const onAccessRequest = vi.fn();
    team({ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED }, { onAccessRequest });
    await user.click(expectOperable(ctl("gated:TEAM-05 deny"), "deny"));
    expect(onAccessRequest).toHaveBeenCalledWith("m9", "reject");
  });

  interactionCase("gated:TEAM-03", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    team({ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED }, { onRemove });
    await user.click(expectOperable(ctl("gated:TEAM-03"), "remove member"));
    expect(onRemove).toHaveBeenCalledWith("m1");
  });

  interactionCase("gated:TEAM-04", async () => {
    const user = userEvent.setup();
    const onRevokeInvite = vi.fn();
    team(
      { membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED },
      {
        onRevokeInvite,
        invites: [
          { id: "i1", email: "new@x.test", role: "collaborator", status: "pending", expiresAt: "2026-09-01" },
        ],
      },
    );
    await user.click(expectOperable(ctl("gated:TEAM-04"), "revoke invite"));
    expect(onRevokeInvite).toHaveBeenCalledWith("i1");
  });

  interactionCase("gated:TEAM-04 invite", async () => {
    team({ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED });
    expectOperable(ctl("gated:TEAM-04 invite"), "invite");
  });

  interactionCase("gated:SEO-04 run", async () => {
    const user = userEvent.setup();
    const onRunAnalysis = vi.fn();
    render(
      <Host>
        <SeoView
          panels={[]}
          role={{ allowed: true }}
          seo={{
            siteUrl: "https://x.test",
            rowCount: 10,
            summary: [],
            leaderQueries: [],
            decliningQueries: [],
            causes: [],
            recommendations: [],
            aiBriefHeadline: null,
          }}
          onRunAnalysis={onRunAnalysis}
          onLoadMore={vi.fn()}
        />
      </Host>,
    );
    await user.click(expectOperable(ctl("gated:SEO-04 run"), "run analysis"));
    expect(onRunAnalysis).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:SEO-01 load-more", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    render(
      <Host>
        <SeoView
          panels={[]}
          role={{ allowed: true }}
          seo={{
            siteUrl: "https://x.test",
            rowCount: 10,
            summary: [],
            leaderQueries: [],
            decliningQueries: [],
            causes: [],
            recommendations: [],
            aiBriefHeadline: null,
          }}
          onLoadMore={onLoadMore}
        />
      </Host>,
    );
    await user.click(expectOperable(ctl("live:SEO-01 load-more"), "seo load more"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
