// @vitest-environment jsdom

/**
 * WP-26 step 7 — mounted proof that a Turkish surface renders Turkish.
 *
 * The catalogue tests prove the strings exist and keep the glossary. This file
 * proves the wiring: a component under a Turkish provider must render Turkish
 * copy, not English, and must still render the non-translatable identifiers
 * exactly as the provider spells them.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";
import {
  ErrorState,
  LoadingState,
  UnavailableState,
} from "@/components/zero-base/states/surface-state";
import { ZERO_BASE_COPY } from "@/lib/zero-base/copy";

function renderIn(language: "en" | "tr", node: React.ReactNode) {
  return render(<ZeroBaseCopyProvider language={language}>{node}</ZeroBaseCopyProvider>);
}

afterEach(cleanup);

describe("the state grammar renders in the active language", () => {
  it("REGRESSION: an unavailable surface says so in Turkish", () => {
    renderIn("tr", <UnavailableState reason="GA4 okunamadı." />);
    expect(screen.getByText(ZERO_BASE_COPY.tr.unavailable)).toBeTruthy();
    // The English word must not be on a Turkish surface.
    expect(screen.queryByText(ZERO_BASE_COPY.en.unavailable)).toBeNull();
  });

  it("renders English when the provider says English", () => {
    renderIn("en", <UnavailableState reason="GA4 could not be read." />);
    expect(screen.getByText(ZERO_BASE_COPY.en.unavailable)).toBeTruthy();
  });

  it("translates the retry affordance", () => {
    renderIn("tr", <ErrorState reason="Okuma başarısız." onRetry={() => {}} />);
    expect(screen.getByRole("button", { name: ZERO_BASE_COPY.tr.retry })).toBeTruthy();
  });

  it("translates the loading label but honours an explicit one", () => {
    const { unmount } = renderIn("tr", <LoadingState />);
    expect(screen.getByText(ZERO_BASE_COPY.tr.loading)).toBeTruthy();
    unmount();
    // A caller-supplied label is content, not grammar, and is left alone.
    renderIn("tr", <LoadingState label="Kararlar yükleniyor" />);
    expect(screen.getByText("Kararlar yükleniyor")).toBeTruthy();
  });

  it("falls back to English with no provider rather than rendering blanks", () => {
    render(<UnavailableState reason="No provider above this." />);
    expect(screen.getByText(ZERO_BASE_COPY.en.unavailable)).toBeTruthy();
  });
});

describe("non-translatable terms survive on a Turkish surface", () => {
  it("keeps provider and metric identifiers exactly", () => {
    renderIn("tr", <UnavailableState reason="ROAS ve CPA için Meta verisi yok." />);
    const text = document.body.textContent ?? "";
    for (const term of ["ROAS", "CPA", "Meta"]) {
      expect(text, `${term} was altered on a Turkish surface`).toContain(term);
    }
  });
});

/* ------------------------------------------------- per-family EN/TR proof */

import { IntegrationsView, TeamView } from "@/components/zero-base/manage/manage-views";
import { ReportLibraryView } from "@/components/zero-base/reports/report-views";
import { WithheldExplainer } from "@/components/zero-base/agency/withheld-explainer";
import { MetaDecisionCenterExact } from "@/components/meta/decision-center/MetaDecisionCenterExact";
import { OpsRepairPanel } from "@/components/zero-base/ops/repair-panel";

const NO_WRITE = { pending: null, error: null, confirmed: null };
const ALLOWED = { ok: true } as const;

/**
 * One surface per family, rendered in both languages.
 *
 * Turkish runs longer than English for the same idea, so each case also asserts
 * the Turkish string is genuinely present rather than the English fallback —
 * a family that silently falls back would otherwise look translated.
 */
describe("every surface family renders EN and TR", () => {
  /**
   * `where` says how the string reaches the user: as visible text, or as an
   * accessible name. Both must be translated — an aria-label left in English on
   * a Turkish surface is exactly what a screen-reader user would hit.
   */
  const families: Array<{
    name: string;
    node: React.ReactNode;
    key: keyof typeof ZERO_BASE_COPY.en;
    where?: "text" | "aria";
  }> = [
    {
      name: "reports",
      key: "reportsTitle",
      node: <ReportLibraryView reports={[]} />,
    },
    {
      name: "manage/integrations",
      key: "integrations",
      node: <IntegrationsView providers={[]} outcome={{ kind: "unstarted" }} />,
    },
    {
      name: "manage/team",
      key: "teamTitle",
      node: (
        <TeamView
          members={[]}
          invites={[]}
          accessRequests={[]}
          workspaces={[]}
          permissions={{ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED }}
          write={NO_WRITE}
        />
      ),
    },
    {
      name: "agency",
      key: "whyAgencyNoTotals",
      node: <WithheldExplainer />,
    },
    {
      /*
       * The mounted Meta Decision Center.
       *
       * The one body in this list that an operator reaches on a canonical
       * route: every other family here is a zero-base surface. It is included
       * because the Turkish artboards P06/P07 grade THIS body, and their
       * `turkish-strings` marker used to come from a paragraph pasted into the
       * frame registry — which the anatomy gate, a substring match over the
       * rendered HTML, cannot tell from a component that has actually been
       * translated. This can.
       */
      name: "meta/decisions",
      key: "decisionCenter",
      node: <MetaDecisionCenterExact viewModel={{}} />,
    },
    {
      name: "ops",
      key: "repair",
      where: "aria",
      node: <OpsRepairPanel action="verify_webhooks" onRun={async () => ({ httpOk: true, status: 200, body: {}, transportFailed: false })} />,
    },
  ];

  for (const family of families) {
    const read = () =>
      family.where === "aria"
        ? Array.from(document.querySelectorAll("[aria-label]"))
            .map((element) => element.getAttribute("aria-label") ?? "")
            .join(" | ")
        : document.body.textContent ?? "";

    it(`${family.name} renders English`, () => {
      renderIn("en", family.node);
      expect(read()).toContain(ZERO_BASE_COPY.en[family.key]);
    });

    it(`${family.name} renders Turkish, with its real length`, () => {
      renderIn("tr", family.node);
      expect(read(), `${family.name} fell back to English`).toContain(ZERO_BASE_COPY.tr[family.key]);
      expect(read()).not.toContain(ZERO_BASE_COPY.en[family.key]);
    });
  }
});
