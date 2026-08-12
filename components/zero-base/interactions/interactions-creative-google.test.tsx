// @vitest-environment jsdom

/**
 * WP-26 group 3 / G7 — creative studio and Google surfaces.
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

import { CreativePerformanceView } from "@/components/zero-base/creative/performance-view";
import { CreativeDetailView } from "@/components/zero-base/creative/detail-view";
import { BriefsView, SharesView } from "@/components/zero-base/creative/studio-views";
import { buildPerformanceViewModel } from "@/lib/zero-base/creative/performance-adapter";
import { GoogleAdvisorView, GoogleOverviewView } from "@/components/zero-base/google/google-views";
import { GooglePlanView } from "@/components/zero-base/google/plan-view";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/c/biz/creative",
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

const row = (index: number) => ({
  id: `r${index}`,
  creative_id: `c${index}`,
  account_id: "act_1",
  name: `Creative ${index}`,
  spend: 1240.5,
  roas: 2.4,
  cpa: 18.2,
  purchases: 68,
});

const perfModel = () =>
  buildPerformanceViewModel({
    rows: [row(1), row(2)] as never,
    posture: "serving",
    totalAvailable: 12,
  });

const SHARE_ROWS = [
  {
    token: "tk_live",
    title: "August review",
    audience: "buyer" as const,
    createdAt: "2026-08-02",
    expiresAt: "2026-09-01",
    revokedAt: null,
    status: "active" as const,
    statusText: "Active",
  },
];

const GOOGLE_SCOPE = {
  kind: "single" as const,
  account: { id: "123", name: "Halcyon US", currency: "USD", timezone: "America/New_York" },
  label: "Halcyon US",
};
const GOOGLE_SERVING = { kind: "serving" as const, observedAt: "2026-08-09T06:00:00Z" };

const planStep = (index: number) => ({
  id: `g${index}`,
  position: index,
  rank: index,
  title: `Step ${index}`,
  rationale: null,
  entityId: `c${index}`,
  entityName: `Campaign ${index}`,
  executionTargetType: "campaign",
  executionTargetId: `c${index}`,
  deepLinkUrl: `https://ads.google.com/aw/campaigns?campaignId=c${index}`,
  executionStatus: null,
  dependencyReadiness: null,
  stabilizationNote: null,
  weaknesses: [],
});

afterEach(cleanup);
afterAll(() => flushInteractionResults("creative-google"));

describe("G7 — creative performance", () => {
  const renderPerf = (props: Record<string, unknown> = {}) =>
    render(
      <Host>
        <CreativePerformanceView
          model={perfModel()}
          businessId="biz"
          onPresetChange={vi.fn()}
          onSortChange={vi.fn()}
          onActionStateChange={vi.fn()}
          onLoadMore={vi.fn()}
          {...props}
        />
      </Host>,
    );

  interactionCase("live:CREATIVE-02 open", async () => {
    renderPerf();
    const link = expectOperable(ctl("live:CREATIVE-02 open"), "open creative");
    expectNavigates(link, /\/creative\//, "open creative");
  });

  interactionCase("live:CREATIVE-12 preset", async () => {
    const user = userEvent.setup();
    const onPresetChange = vi.fn();
    renderPerf({ onPresetChange });
    const select = expectOperable(ctl("live:CREATIVE-12 preset"), "preset") as HTMLSelectElement;
    await user.selectOptions(select, "scaling");
    expect(onPresetChange).toHaveBeenCalledWith("scaling");
  });

  interactionCase("live:CREATIVE-12 sort", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderPerf({ onSortChange });
    await user.selectOptions(
      expectOperable(ctl("live:CREATIVE-12 sort"), "sort") as HTMLSelectElement,
      "roas",
    );
    expect(onSortChange).toHaveBeenCalledWith("roas");
  });

  interactionCase("live:CREATIVE-13 filter", async () => {
    const user = userEvent.setup();
    const onActionStateChange = vi.fn();
    renderPerf({ onActionStateChange });
    const select = expectOperable(ctl("live:CREATIVE-13 filter"), "action state") as HTMLSelectElement;
    // The legacy null state is offered as a value of its own; rows recorded
    // before the engine assigned one are a cohort, not "any".
    expect([...select.options].map((option) => option.value)).toContain("unset");
    await user.selectOptions(select, "unset");
    expect(onActionStateChange).toHaveBeenCalledWith("unset");
  });

  interactionCase("live:META-DEC-05 load-more", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    renderPerf({ onLoadMore });
    await user.click(expectOperable(ctl("live:META-DEC-05 load-more"), "load more"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

describe("G7 — creative detail and studio", () => {
  const detail = (serving: boolean) =>
    render(
      <Host>
        <CreativeDetailView
          creativeId="c1"
          name="Summer hero"
          media={{ kind: "ready", url: "https://x/1.png", origin: "snapshot" }}
          evidence={[{ label: "Spend", value: "1,240.50 USD", source: "Meta Insights" }]}
          band={
            serving
              ? { kind: "band", label: "Scale", detail: "ROAS 3.4 vs target 2.6" }
              : { kind: "none", reason: "The engine is in shadow mode." }
          }
          decisionsHref={serving ? "/c/biz/meta/decisions?selected=c1" : null}
          shareHref={serving ? "/c/biz/creative/c1/shares" : null}
          history={[]}
          anyReplayed={false}
        />
      </Host>,
    );

  interactionCase("live:CREATIVE-07 brief", async () => {
    detail(true);
    expectNavigates(ctl("live:CREATIVE-07 brief"), /\/meta\/decisions/, "brief");
  });

  interactionCase("live:CREATIVE-10 share", async () => {
    detail(true);
    expectNavigates(ctl("live:CREATIVE-10 share"), /\/shares$/, "share creative");
  });

  it("a shadow creative offers neither, because there is nothing to act on", () => {
    detail(false);
    expect(ctl("live:CREATIVE-07 brief")).toBeNull();
    expect(ctl("live:CREATIVE-10 share")).toBeNull();
    expect(document.querySelector('[data-el="shadow-review-band"]')).not.toBeNull();
  });

  interactionCase("live:CREATIVE-02 back", async () => {
    render(
      <Host>
        <BriefsView rows={[]} backHref="/c/biz/creative" canCreate createBlockedReason={null} />
      </Host>,
    );
    expectNavigates(ctl("live:CREATIVE-02 back"), /^\/c\/biz\/creative$/, "back to creatives");
  });

  interactionCase("live:CREATIVE-07 status", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <Host>
        <BriefsView rows={[]} canCreate createBlockedReason={null} onCreate={onCreate} />
      </Host>,
    );
    await user.click(expectOperable(ctl("live:CREATIVE-07 status"), "create brief"));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});

describe("G7 — share ledger", () => {
  const shares = (props: Record<string, unknown> = {}) =>
    render(
      <Host>
        <SharesView
          rows={SHARE_ROWS}
          onRevoke={vi.fn()}
          onRotate={vi.fn()}
          onCreate={vi.fn()}
          {...props}
        />
      </Host>,
    );

  interactionCase("live:CREATIVE-11 tier", async () => {
    const user = userEvent.setup();
    shares();
    const buyer = allCtl("live:CREATIVE-11 tier").find(
      (node) => node.getAttribute("data-share-audience") === "buyer",
    );
    expect(buyer, "a buyer tier is offered").toBeTruthy();
    await user.click(buyer as HTMLElement);
    // Choosing buyer is what summons the financial acknowledgement.
    await waitFor(() => expect(ctl("live:CREATIVE-11 ack")).not.toBeNull());
  });

  interactionCase("live:CREATIVE-11 ack", async () => {
    const user = userEvent.setup();
    shares({ initialAudience: "buyer" });
    const ack = expectOperable(ctl("live:CREATIVE-11 ack"), "acknowledge") as HTMLInputElement;
    expect(ack.checked).toBe(false);
    await user.click(ack);
    await waitFor(() => expect(ack.checked).toBe(true));
  });

  interactionCase("live:CREATIVE-10 expiry", async () => {
    const user = userEvent.setup();
    shares();
    const expiry = expectOperable(ctl("live:CREATIVE-10 expiry"), "expiry") as HTMLInputElement;
    await user.type(expiry, "2026-10-01");
    expect(expiry.value).toBe("2026-10-01");
  });

  interactionCase("live:CREATIVE-10 mint", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    shares({
      onCreate,
      initialAudience: "buyer",
      initialTitle: "September review",
      initialExpiresAt: "2026-10-01",
      initialAcknowledged: true,
    });
    await user.click(expectOperable(ctl("live:CREATIVE-10 mint"), "mint"));
    expect(onCreate).toHaveBeenCalledWith({
      title: "September review",
      audience: "buyer",
      expiresAt: "2026-10-01",
    });
  });

  interactionCase("disabled:CREATIVE-10 mint", async () => {
    // A buyer share without the acknowledgement cannot be minted, and the
    // control says why rather than vanishing.
    shares({ initialAudience: "buyer", initialTitle: "x", initialExpiresAt: "2026-10-01" });
    const mint = ctl("disabled:CREATIVE-10 mint");
    expect(mint, "the disabled mint is present").not.toBeNull();
    expect(mint!.getAttribute("aria-disabled")).toBe("true");
    const describedBy = mint!.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy ?? "")?.textContent).toMatch(/acknowledgement/i);
  });

  interactionCase("live:CREATIVE-10 rotate", async () => {
    const user = userEvent.setup();
    const onRotate = vi.fn();
    shares({ onRotate });
    await user.click(expectOperable(ctl("live:CREATIVE-10 rotate"), "rotate"));
    expect(onRotate).toHaveBeenCalledWith("tk_live");
  });

  interactionCase("live:CREATIVE-10 revoke", async () => {
    const user = userEvent.setup();
    const onRevoke = vi.fn();
    shares({ onRevoke });
    await user.click(expectOperable(ctl("live:CREATIVE-10 revoke"), "revoke"));
    expect(onRevoke).toHaveBeenCalledWith("tk_live");
  });
});

describe("G7 — google", () => {
  const overview = (props: Record<string, unknown> = {}) =>
    render(
      <Host>
        <GoogleOverviewView
          scope={GOOGLE_SCOPE}
          source={GOOGLE_SERVING}
          rows={[
            {
              id: "a1",
              account: "Halcyon US",
              spend: { available: true, display: "4,210.40 USD", raw: 4210.4 },
              conversions: { available: true, display: "184", raw: 184 },
              pulse: "Steady",
            },
          ]}
          onPortfolioChange={vi.fn()}
          {...props}
        />
      </Host>,
    );

  const advisor = (props: Record<string, unknown> = {}) =>
    render(
      <Host>
        <GoogleAdvisorView
          scope={GOOGLE_SCOPE}
          source={GOOGLE_SERVING}
          items={[{ id: "a1", title: "Raise tROAS", rationale: null, urgency: "do now" }]}
          referenceCards={[]}
          onBucketChange={vi.fn()}
          onOpenCard={vi.fn()}
          {...props}
        />
      </Host>,
    );

  const plan = (props: Record<string, unknown> = {}) =>
    render(
      <Host>
        <GooglePlanView
          scope={GOOGLE_SCOPE}
          source={GOOGLE_SERVING}
          steps={[planStep(1), planStep(2)] as never}
          servedStatuses={["pending"]}
          journal={{ entries: [], hasGap: false, gapReason: null }}
          onMarkApplied={vi.fn()}
          onCopyStep={vi.fn()}
          onCsvStep={vi.fn()}
          onDismiss={vi.fn()}
          {...props}
        />
      </Host>,
    );

  interactionCase("live:GOOGLE-32 portfolio", async () => {
    const user = userEvent.setup();
    const onPortfolioChange = vi.fn();
    overview({ onPortfolioChange });
    const toggle = expectOperable(ctl("live:GOOGLE-32 portfolio"), "portfolio") as HTMLInputElement;
    // The rule travels with the control: mixed currency withholds totals.
    expect(document.body.textContent).toMatch(/withheld when accounts disagree on currency/i);
    await user.click(toggle);
    expect(onPortfolioChange).toHaveBeenCalledWith(true);
  });

  interactionCase("live:GOOGLE-13 bucket", async () => {
    const user = userEvent.setup();
    const onBucketChange = vi.fn();
    advisor({ onBucketChange });
    const bucket = expectOperable(ctl("live:GOOGLE-13 bucket"), "bucket");
    await user.click(bucket);
    expect(onBucketChange).toHaveBeenCalled();
  });

  interactionCase("live:GOOGLE-16 open-card", async () => {
    const user = userEvent.setup();
    const onOpenCard = vi.fn();
    advisor({ onOpenCard });
    await user.click(expectOperable(ctl("live:GOOGLE-16 open-card"), "open card"));
    expect(onOpenCard).toHaveBeenCalledWith("a1");
  });

  interactionCase("live:GOOGLE-28 mark-applied", async () => {
    const user = userEvent.setup();
    const onMarkApplied = vi.fn();
    plan({ onMarkApplied });
    const mark = expectOperable(ctl("live:GOOGLE-28 mark-applied"), "mark applied") as HTMLInputElement;
    await user.click(mark);
    expect(onMarkApplied).toHaveBeenCalledWith("g1", true);
  });

  it("a marked step reads as manual, never as verified", () => {
    plan({
      journal: {
        entries: [
          {
            id: "j1",
            at: "2026-08-09T07:00:00Z",
            actor: "Dana",
            action: "marked-applied" as const,
            stepId: "g1",
            detail: "",
          },
        ],
        hasGap: false,
        gapReason: null,
      },
    });
    // Nothing here read Google back, and the row says so.
    expect(screen.getAllByText(/applied \(manual\)/i).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/verified by Google/i);
  });

  interactionCase("live:GOOGLE-30 deeplink", async () => {
    plan();
    expectNavigates(ctl("live:GOOGLE-30 deeplink"), /^https:\/\/ads\.google\.com\//, "deeplink");
  });

  interactionCase("live:GOOGLE-26 dismiss", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    plan({ onDismiss });
    await user.click(expectOperable(ctl("live:GOOGLE-26 dismiss"), "dismiss"));
    expect(onDismiss).toHaveBeenCalledWith("g1");
  });

  interactionCase("live:GOOGLE-ESC-01 copy", async () => {
    const user = userEvent.setup();
    const onCopyStep = vi.fn();
    plan({ onCopyStep });
    await user.click(expectOperable(ctl("live:GOOGLE-ESC-01 copy"), "copy step"));
    expect(onCopyStep).toHaveBeenCalledWith("g1");
  });

  interactionCase("live:GOOGLE-ESC-01 csv", async () => {
    const user = userEvent.setup();
    const onCsvStep = vi.fn();
    plan({ onCsvStep });
    await user.click(expectOperable(ctl("live:GOOGLE-ESC-01 csv"), "csv step"));
    expect(onCsvStep).toHaveBeenCalledWith("g1");
  });

  interactionCase("live:GOOGLE-ESC-01 copy-all", async () => {
    plan();
    expectOperable(ctl("live:GOOGLE-ESC-01 copy-all"), "copy all");
  });

  interactionCase("live:GOOGLE-ESC-01 csv-all", async () => {
    plan();
    expectOperable(ctl("live:GOOGLE-ESC-01 csv-all"), "csv all");
  });

  it("a step Google served no link for is withheld, not guessed", () => {
    plan({ steps: [{ ...planStep(1), deepLinkUrl: null }] as never });
    expect(ctl("live:GOOGLE-30 deeplink")).toBeNull();
    expect(document.querySelector("[data-plan-link-withheld]")).not.toBeNull();
  });
});
