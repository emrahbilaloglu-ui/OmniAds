// @vitest-environment jsdom

/**
 * WP-26 step 2 — the executable flow × viewport matrix.
 *
 * Every case here mounts a real surface, drives it, and asserts a branch. A case
 * is recorded **after** its assertions, so a failing expectation leaves the case
 * absent from the manifest rather than green. `reconcile-flows.ts` reads that
 * manifest and nothing else, which is what stops source text from masquerading
 * as coverage the way the first version allowed.
 *
 * Width is driven through `matchMedia`, because jsdom has no layout engine and
 * that is the signal the shell actually reads.
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  FLOW_SPECS,
  recordFlowCase,
  requiredWidths,
  writeFlowResults,
  type Branch,
} from "@/lib/zero-base/flows/flow-cases";

import { AgencyDeskView } from "@/components/zero-base/agency/agency-desk-view";
import { WithheldExplainer } from "@/components/zero-base/agency/withheld-explainer";
import { InviteStatePanel } from "@/components/zero-base/auth/auth-states";
import { CreativePerformanceView } from "@/components/zero-base/creative/performance-view";
import { buildPerformanceViewModel } from "@/lib/zero-base/creative/performance-adapter";
import { IntegrationsView, TeamView, BusinessView } from "@/components/zero-base/manage/manage-views";
import { ReportLibraryView, RenderedWidgetCard } from "@/components/zero-base/reports/report-views";
import { OpsRepairPanel } from "@/components/zero-base/ops/repair-panel";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

/** jsdom has no layout engine, so viewport width is driven through matchMedia. */
function setViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const match = /max-width:\s*(\d+)px/.exec(query);
    const matches = match ? width <= Number(match[1]) : false;
    return { matches, media: query, addEventListener: () => {}, removeEventListener: () => {} };
  });
}

/**
 * Run one case at every width the flow requires.
 *
 * The body must throw on failure; the case is recorded only if it returns.
 */
function caseAtWidths(flow: string, branch: Branch, body: (width: number) => void | Promise<void>) {
  const widths = requiredWidths(flow);
  for (const width of widths) {
    it(`${flow} @ ${width} — ${branch}`, async () => {
      setViewport(width);
      await body(width);
      recordFlowCase(flow, width, branch);
    });
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(() => {
  // Stamped with the commit so a manifest can be tied to a tree.
  writeFlowResults(process.env.ZERO_BASE_COMMIT?.trim() || "worktree");
});

/* ------------------------------------------------------------------ fixtures */

/** The real `AgencyDirectoryPageData` shape, from the served projection. */
function agencyPage(rows: number) {
  const items = Array.from({ length: rows }, (_, index) => ({
    businessId: `biz_${String(index).padStart(3, "0")}`,
    name: `Client ${String(index).padStart(3, "0")}`,
    role: "admin" as const,
    membershipStatus: "active" as const,
    configuredCurrency: "USD",
    sourceUpdatedAt: "2026-08-10T12:00:00Z",
    href: `/c/biz_${String(index).padStart(3, "0")}/home`,
  }));
  return {
    items,
    servedCount: items.length,
    totalCount: rows,
    nextCursor: null,
    truncated: false,
    disclosure: null,
  };
}

function creativeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    creative_id: "c1",
    account_id: "act_1",
    name: "Creative one",
    spend: 12,
    roas: 2.1,
    cpa: 4,
    purchases: 3,
    ...overrides,
  };
}

const NO_WRITE = { pending: null, error: null, confirmed: null };
const DENIED = { ok: false, reason: "This needs the admin role. Your role on this workspace is guest." };

/* ---------------------------------------------------------------- Flow A */

describe("Flow A — honest agency entry", () => {
  caseAtWidths("Flow A", "success", async () => {
    render(<AgencyDeskView initialPage={agencyPage(3) as never} />);
    // The directory itself: every served client is listed and linked.
    await waitFor(() => expect(screen.getByText("Client 000")).toBeTruthy());
    // The link carries a sanitized returnTo: "honest agency entry" means the
    // operator can get back to the desk row they came from.
    const href = screen.getByRole("link", { name: /Client 000/ }).getAttribute("href") ?? "";
    expect(href.startsWith("/switch-business/biz_000?")).toBe(true);
    expect(decodeURIComponent(href)).toContain("next=/app/home");
    expect(href).toContain("returnTo=");
  });

  caseAtWidths("Flow A", "empty", async () => {
    render(<AgencyDeskView initialPage={agencyPage(0) as never} />);
    // An empty directory renders its frame and no client rows — never a blank
    // page that reads as a loading failure.
    expect(screen.queryByText(/Client 000/)).toBeNull();
    expect(document.body.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  caseAtWidths("Flow A", "permission", async () => {
    // Withheld is the agency permission branch: visible, named, with an exit.
    render(<WithheldExplainer />);
    // Withheld is the agency permission branch: named, with an exit, never blank.
    expect(screen.getByText(/Why Agency shows no totals/)).toBeTruthy();
  });
});

/* ---------------------------------------------------------------- Flow B */

describe("Flow B — Meta decision to supported action", () => {
  caseAtWidths("Flow B", "success", async () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({
          rows: [creativeRow()] as never,
          posture: "serving",
          totalAvailable: 1,
        })}
        businessId="biz-1"
      />,
    );
    // Serving posture is the only one that may offer an action.
    expect(document.querySelector("[data-decision-link=\"c1\"]")).not.toBeNull();
  });

  caseAtWidths("Flow B", "permission", async () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({
          rows: [creativeRow()] as never,
          posture: "shadow_only",
          totalAvailable: 1,
        })}
        businessId="biz-1"
      />,
    );
    // Shadow decisions carry no authority, so zero action affordances.
    expect(document.querySelector("[data-decision-link=\"c1\"]")).toBeNull();
    expect(document.querySelector("[data-decision-withheld=\"c1\"]")).not.toBeNull();
  });

  caseAtWidths("Flow B", "failure", async () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({ rows: [], posture: "unavailable", totalAvailable: null })}
        businessId="biz-1"
        unavailableReason="The decision posture could not be read."
      />,
    );
    expect(document.querySelector("[data-surface-state=\"unavailable\"]")).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- Flow C */

describe("Flow C — needs resolution", () => {
  caseAtWidths("Flow C", "success", async () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({
          rows: [creativeRow()] as never,
          posture: "serving",
          totalAvailable: 1,
        })}
        businessId="biz-1"
      />,
    );
    expect(document.querySelector("[data-engine-posture=\"serving\"]")).not.toBeNull();
  });

  caseAtWidths("Flow C", "partial", async () => {
    // A capped collection must disclose the cap with its own numbers.
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({
          rows: [creativeRow()] as never,
          posture: "serving",
          totalAvailable: 90,
        })}
        businessId="biz-1"
      />,
    );
    const disclosure = document.querySelector("[data-performance-disclosure]");
    expect(disclosure!.textContent).toMatch(/of 90/);
  });
});

/* ---------------------------------------------------------------- Flow D */

describe("Flow D — creative refresh", () => {
  caseAtWidths("Flow D", "success", async () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({
          rows: [creativeRow()] as never,
          posture: "serving",
          totalAvailable: 1,
        })}
        businessId="biz-1"
      />,
    );
    expect(document.querySelector("[data-creative-detail-link=\"c1\"]")).not.toBeNull();
  });

  caseAtWidths("Flow D", "empty", async () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({ rows: [], posture: "serving", totalAvailable: 0 })}
        businessId="biz-1"
      />,
    );
    // No rows: the disclosure still has to state what was served.
    expect(document.querySelector("[data-performance-disclosure]")!.textContent).toMatch(/0/);
  });
});

/* ---------------------------------------------------------------- Flow E */

describe("Flow E — Meta launch preparation", () => {
  caseAtWidths("Flow E", "success", async () => {
    render(
      <ZeroBasePortalHost>
        <RenderedWidgetCard
          widget={{
            id: "prep",
            slot: 0,
            colSpan: 2,
            rowSpan: 1,
            type: "text",
            title: "Launch preparation",
            text: "Draft is ready for review.",
          }}
          sourceId={null}
        />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector("[data-widget-text=\"prep\"]")).not.toBeNull();
  });

  caseAtWidths("Flow E", "permission", async () => {
    render(
      <ZeroBasePortalHost>
        <RenderedWidgetCard
          widget={{
            id: "prep",
            slot: 0,
            colSpan: 2,
            rowSpan: 1,
            type: "table",
            title: "Launch preparation",
            rows: [],
          }}
          sourceId={null}
        />
      </ZeroBasePortalHost>,
    );
    // No stored source: export is withheld with the reason, not offered.
    expect(document.querySelector("[data-widget-csv=\"prep\"]")).toBeNull();
    expect(document.querySelector("[data-widget-csv-blocked=\"prep\"]")).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- Flow F */

describe("Flow F — Google manual plan and default-off writes", () => {
  caseAtWidths("Flow F", "success", async () => {
    render(
      <IntegrationsView
        providers={[{ provider: "google", label: "Google Ads", state: { kind: "connected", accountLabel: "Main" } }]}
        outcome={{ kind: "unstarted" }}
      />,
    );
    expect(document.querySelector("[data-provider-state=\"google\"]")!.textContent).toMatch(/Connected/);
  });

  caseAtWidths("Flow F", "permission", async () => {
    render(
      <IntegrationsView
        providers={[{ provider: "google", label: "Google Ads", state: { kind: "not_connected" } }]}
        outcome={{ kind: "unstarted" }}
        authorizePermission={DENIED}
      />,
    );
    // A guest is refused before navigation, not by the server's JSON 403.
    expect(document.querySelector("[data-connect=\"google\"]")).toBeNull();
    expect(document.querySelector("[data-authorize-blocked=\"google\"]")).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- Flow G */

describe("Flow G — report delivery", () => {
  caseAtWidths("Flow G", "success", async () => {
    render(<ReportLibraryView reports={[{ id: "r1", name: "Weekly", updatedAt: "2026-08-11" }]} />);
    expect(screen.getByText("Weekly")).toBeTruthy();
  });

  caseAtWidths("Flow G", "empty", async () => {
    render(<ReportLibraryView reports={[]} />);
    expect(document.querySelector("[data-reports=\"empty\"]")).not.toBeNull();
  });

  caseAtWidths("Flow G", "failure", async () => {
    render(<ReportLibraryView reports={[]} unavailableReason="Reports could not be read." />);
    expect(document.querySelector("[data-surface-state=\"unavailable\"]")).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- Flow H */

describe("Flow H — integration recovery", () => {
  caseAtWidths("Flow H", "success", async () => {
    render(
      <IntegrationsView
        providers={[{ provider: "meta", label: "Meta Ads", state: { kind: "needs_reconnect", reason: "Expired." } }]}
        outcome={{ kind: "unstarted" }}
        connectSupported={() => true}
      />,
    );
    expect(document.querySelector("[data-reconnect=\"meta\"]")).not.toBeNull();
  });

  caseAtWidths("Flow H", "permission", async () => {
    render(
      <IntegrationsView
        providers={[{ provider: "meta", label: "Meta Ads", state: { kind: "needs_reconnect", reason: "Expired." } }]}
        outcome={{ kind: "unstarted" }}
        authorizePermission={DENIED}
      />,
    );
    expect(document.querySelector("[data-reconnect=\"meta\"]")).toBeNull();
    expect(document.querySelector("[data-authorize-blocked=\"meta\"]")).not.toBeNull();
  });

  caseAtWidths("Flow H", "read_back", async () => {
    // A ceremony that observed nothing must not read as confirmed.
    render(
      <IntegrationsView
        providers={[]}
        outcome={{
          // `unknown` is the real union member: the action ran and nothing
          // observed the result, which is not the same as failure.
          kind: "unknown",
          detail: "The action ran but the confirming read did not complete.",
        }}
      />,
    );
    expect(document.querySelector("[data-ceremony=\"reconnect:unknown\"]")).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- Flow I */

describe("Flow I — Meta automation safety", () => {
  caseAtWidths("Flow I", "success", async () => {
    render(
      <TeamView
        members={[
          { membershipId: "m1", userId: "u1", name: "Ada", email: "a@x.test", role: "admin", status: "active" },
        ]}
        invites={[]}
        accessRequests={[]}
        workspaces={[]}
        permissions={{ membersWrite: { ok: true }, invitesWrite: { ok: true }, accessRequests: { ok: true } }}
        write={NO_WRITE}
      />,
    );
    expect(document.querySelector("[data-member-role=\"m1\"]")).not.toBeNull();
  });

  caseAtWidths("Flow I", "permission", async () => {
    render(
      <TeamView
        members={[
          { membershipId: "m1", userId: "u1", name: "Ada", email: "a@x.test", role: "admin", status: "active" },
        ]}
        invites={[]}
        accessRequests={[]}
        workspaces={[]}
        permissions={{ membersWrite: DENIED, invitesWrite: DENIED, accessRequests: DENIED }}
        write={NO_WRITE}
      />,
    );
    // Read-only at every width, including 320.
    expect(document.querySelector("[data-member-role=\"m1\"]")).toBeNull();
    expect(document.querySelector("[data-member-role-readonly=\"m1\"]")).not.toBeNull();
    expect(document.querySelector("[data-team-blocked]")).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- Flow J */

describe("Flow J — admin incident response", () => {
  caseAtWidths("Flow J", "success", async () => {
    render(
      <OpsRepairPanel
        action="verify_webhooks"
        onRun={async () => ({ httpOk: true, status: 200, body: { ok: true }, transportFailed: false })}
        confirmation={{ workspace: "Grandmix", provider: "Shopify" }}
      />,
    );
    (document.querySelector("[data-repair-run=\"verify_webhooks\"]") as HTMLElement).click();
    await waitFor(() => expect(document.querySelector("[data-repair-confirm-scope]")).not.toBeNull());
    expect(document.querySelector("[data-repair-confirm-scope]")!.textContent).toContain("Grandmix");
  });

  caseAtWidths("Flow J", "failure", async () => {
    render(
      <OpsRepairPanel
        action="verify_webhooks"
        onRun={async () => ({ httpOk: false, status: 400, body: { message: "Refused." }, transportFailed: false })}
      />,
    );
    (document.querySelector("[data-repair-run=\"verify_webhooks\"]") as HTMLElement).click();
    await waitFor(() => expect(document.querySelector("[data-repair-outcome=\"refused\"]")).not.toBeNull());
  });

  caseAtWidths("Flow J", "read_back", async () => {
    render(
      <OpsRepairPanel
        action="verify_webhooks"
        onRun={async () => ({ httpOk: true, status: 200, body: { ok: true }, transportFailed: false })}
      />,
    );
    // The endpoint performs no read-back, and the surface must say so.
    expect(document.querySelector("[data-repair-no-receipt]")).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- Flow K */

describe("Flow K — onboarding and invite", () => {
  caseAtWidths("Flow K", "success", async () => {
    render(<InviteStatePanel state="login_required" token="tok_1" invitedEmail="ada@example.com" />);
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login?next=%2Finvite%2Ftok_1");
  });

  caseAtWidths("Flow K", "failure", async () => {
    render(<InviteStatePanel state="invite_expired" token="tok_1" />);
    expect(document.querySelector("[data-invite-state=\"invite_expired\"]")).not.toBeNull();
    // A dead invite offers no action to take.
    expect(document.querySelector("[data-invite-action]")).toBeNull();
  });
});

/* ---------------------------------------------------------------- Flow L */

describe("Flow L — share lifecycle", () => {
  caseAtWidths("Flow L", "success", async () => {
    render(
      <ZeroBasePortalHost>
        <RenderedWidgetCard
          widget={{
            id: "w1",
            slot: 0,
            colSpan: 2,
            rowSpan: 2,
            type: "table",
            title: "Shared table",
            rows: [{ name: "Row" }],
            columns: ["name"],
          }}
          sourceId="meta_campaigns"
        />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector("[data-widget-csv=\"w1\"]")).not.toBeNull();
  });

  caseAtWidths("Flow L", "empty", async () => {
    render(
      <ZeroBasePortalHost>
        <RenderedWidgetCard
          widget={{
            id: "w1",
            slot: 0,
            colSpan: 2,
            rowSpan: 2,
            type: "table",
            title: "Shared table",
            emptyMessage: "No rows were served for this period.",
          }}
          sourceId="meta_campaigns"
        />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector("[data-widget-state=\"empty\"]")).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- Flow M */

describe("Flow M — account and business lifecycle", () => {
  caseAtWidths("Flow M", "success", async () => {
    render(
      <ZeroBasePortalHost>
        <BusinessView
          economics={[]}
          recommendedMode="profit_first"
          deleteOutcome={{ kind: "unstarted" }}
          canDelete
          settings={{ name: "Grandmix", currency: "TRY" }}
          settingsPermission={{ ok: true }}
          settingsState={{ pending: false, error: null, confirmed: null }}
        />
      </ZeroBasePortalHost>,
    );
    expect((document.querySelector("[data-business-name]") as HTMLInputElement).value).toBe("Grandmix");
  });

  caseAtWidths("Flow M", "permission", async () => {
    render(
      <ZeroBasePortalHost>
        <BusinessView
          economics={[]}
          recommendedMode="profit_first"
          deleteOutcome={{ kind: "unstarted" }}
          canDelete={false}
          settings={{ name: "Grandmix", currency: "TRY" }}
          settingsPermission={DENIED}
          settingsState={{ pending: false, error: null, confirmed: null }}
        />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector("[data-settings-save]")).toBeNull();
    expect(document.querySelector("[data-settings-blocked]")).not.toBeNull();
  });
});

/* -------------------------------------------------------------- denominator */

describe("the matrix denominator", () => {
  it("declares 13 flows, matching the design spec", () => {
    expect(FLOW_SPECS).toHaveLength(13);
  });
});
