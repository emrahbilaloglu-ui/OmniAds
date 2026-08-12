// @vitest-environment jsdom

/**
 * The mounted report surfaces.
 *
 * The load-bearing assertions: the canonical UI has zero mint/share controls,
 * a coming-soon source is disabled rather than hidden, CSV is offered only on
 * tables, one failing widget does not blank its neighbours, and the builder is
 * fully operable from the keyboard.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import React from "react";

import type { RenderedReportWidget } from "@/lib/custom-reports";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ReportBuilderView,
  ReportLibraryView,
  ReportShareDisabled,
  RenderedWidgetCard,
} from "@/components/zero-base/reports/report-views";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { COMING_SOON_SOURCES, RENDERABLE_SOURCES } from "@/lib/zero-base/reports/report-catalog";

afterEach(cleanup);

const ROOT = process.cwd();

describe("the source picker shows all nine, disabling four", () => {
  it("offers every renderable source and disables every coming-soon one", () => {
    render(
      <ZeroBasePortalHost>
        <ReportBuilderView initial={{ widgets: [] }} name="Weekly" />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelectorAll("[data-source-add]").length).toBe(RENDERABLE_SOURCES.length);
    expect(document.querySelectorAll("[data-source-unavailable]").length).toBe(
      COMING_SOON_SOURCES.length,
    );
    // Disabled, never hidden.
    for (const source of COMING_SOON_SOURCES) {
      expect(document.querySelector(`[data-source-unavailable="${source.id}"]`), source.id).not.toBeNull();
    }
  });

  it("keeps Search Console and Klaviyo visibly separate", () => {
    render(
      <ZeroBasePortalHost>
        <ReportBuilderView initial={{ widgets: [] }} name="Weekly" />
      </ZeroBasePortalHost>,
    );
    expect(screen.getByText("Search Console")).toBeTruthy();
    expect(screen.getByText("Klaviyo")).toBeTruthy();
  });
});

describe("the builder is operable from the keyboard", () => {
  function builder() {
    render(
      <ZeroBasePortalHost>
        <ReportBuilderView
          initial={{ widgets: [{ id: "w1", sourceId: "meta_campaigns", x: 2, y: 0, w: 4, h: 2 }] }}
          name="Weekly"
        />
      </ZeroBasePortalHost>,
    );
  }

  it("moves, resizes and undoes with the keyboard alone", async () => {
    builder();
    const user = userEvent.setup();
    const canvas = document.querySelector("[data-builder-canvas]") as HTMLElement;
    canvas.focus();

    await user.keyboard("{ArrowRight}");
    expect(document.querySelector('[data-widget="w1"]')!.getAttribute("data-widget-x")).toBe("3");
    expect(document.querySelector("[data-builder-live]")!.textContent).toBe("Widget moved.");

    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(document.querySelector('[data-widget="w1"]')!.getAttribute("data-widget-w")).toBe("5");

    await user.keyboard("z");
    expect(document.querySelector('[data-widget="w1"]')!.getAttribute("data-widget-w")).toBe("4");
    expect(document.querySelector("[data-builder-live]")!.textContent).toBe("Undone.");
  });

  it("undoes back to the original position", async () => {
    builder();
    const user = userEvent.setup();
    (document.querySelector("[data-builder-canvas]") as HTMLElement).focus();
    await user.keyboard("{ArrowRight}");
    await user.click(document.querySelector("[data-builder-undo]") as HTMLElement);
    expect(document.querySelector('[data-widget="w1"]')!.getAttribute("data-widget-x")).toBe("2");
  });
});

/**
 * These exercise the REAL `RenderedReportWidget`. The renderer emits no
 * `dataSource`, so nothing below invents one.
 */
function rendered(overrides: Partial<RenderedReportWidget>): RenderedReportWidget {
  return {
    id: "w1",
    slot: 0,
    colSpan: 2,
    rowSpan: 2,
    type: "table",
    title: "Top Meta Campaigns",
    ...overrides,
  };
}

describe("a failing widget keeps its neighbours", () => {
  it("shows its own error and retry", async () => {
    const onRetry = vi.fn();
    render(
      <ZeroBasePortalHost>
        <div>
          <RenderedWidgetCard
            widget={rendered({ id: "wA", errorMessage: "Meta campaigns could not be read.", retryable: true })}
            sourceId="meta_campaigns"
            onRetry={onRetry}
          />
          <RenderedWidgetCard
            widget={rendered({
              id: "wB",
              title: "Channel Attribution",
              rows: [{ channel: "Meta", spend: 10 }],
              columns: ["channel", "spend"],
            })}
            sourceId="channel_attribution"
          />
        </div>
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector('[data-report-widget="wA"] [data-widget-state="error"]')).not.toBeNull();
    // The neighbour still rendered.
    expect(document.querySelector('[data-report-widget="wB"] [data-widget-state="ready"]')).not.toBeNull();

    await userEvent.setup().click(document.querySelector('[data-widget-retry="wA"]') as HTMLElement);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("withholds retry when the renderer did not mark the failure retryable", () => {
    render(
      <RenderedWidgetCard
        widget={rendered({ id: "wC", errorMessage: "Upstream refused.", retryable: false })}
        sourceId="meta_campaigns"
      />,
    );
    expect(document.querySelector('[data-widget-retry="wC"]')).toBeNull();
    expect(document.querySelector('[data-widget-retry-blocked="wC"]')).not.toBeNull();
  });

  it("renders the renderer's own empty message rather than zeros", () => {
    render(
      <RenderedWidgetCard
        widget={rendered({ id: "wD", emptyMessage: "No Meta campaigns served in this period." })}
        sourceId="meta_campaigns"
      />,
    );
    expect(document.querySelector('[data-widget-state="empty"]')!.textContent).toMatch(
      /No Meta campaigns served/,
    );
  });
});

describe("each widget type renders as the type it is", () => {
  it("renders a metric's value and delta, not an empty table", () => {
    render(
      <RenderedWidgetCard
        widget={rendered({ id: "m1", type: "metric", title: "Spend", value: "1,204.50 USD", deltaLabel: "+8.1% vs previous" })}
        sourceId="overview_summary"
      />,
    );
    expect(document.querySelector('[data-widget-value="m1"]')!.textContent).toBe("1,204.50 USD");
    expect(document.querySelector('[data-widget-delta="m1"]')!.textContent).toMatch(/\+8\.1%/);
    expect(document.querySelector('[data-report-widget="m1"] table')).toBeNull();
  });

  it("renders trend points", () => {
    render(
      <RenderedWidgetCard
        widget={rendered({
          id: "t1",
          type: "trend",
          title: "Blended Spend Trend",
          points: [
            { label: "2026-07-01", value: 120 },
            { label: "2026-07-02", value: 140 },
          ],
        })}
        sourceId="overview_trend"
      />,
    );
    expect(document.querySelectorAll('[data-widget-points="t1"] [data-point]').length).toBe(2);
  });

  it("renders multi-series trends", () => {
    render(
      <RenderedWidgetCard
        widget={rendered({
          id: "t2",
          type: "trend",
          title: "Channel Revenue",
          series: [{ key: "meta", label: "Meta", color: "#3b5bdb", points: [{ label: "d1", value: 5 }] }],
        })}
        sourceId="overview_trend"
      />,
    );
    expect(document.querySelector('[data-widget-series="meta"]')).not.toBeNull();
  });

  it("renders text content", () => {
    render(
      <RenderedWidgetCard
        widget={rendered({ id: "x1", type: "text", title: "Note", text: "Reviewed with the client." })}
        sourceId={null}
      />,
    );
    expect(document.querySelector('[data-widget-text="x1"]')!.textContent).toBe("Reviewed with the client.");
  });

  it("renders a table on the served columns", () => {
    render(
      <RenderedWidgetCard
        widget={rendered({
          id: "tb1",
          rows: [{ name: "Campaign A", spend: 12 }],
          columns: ["name", "spend"],
        })}
        sourceId="meta_campaigns"
      />,
    );
    const headers = Array.from(document.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(headers).toEqual(["name", "spend"]);
  });

  it("surfaces a warning alongside content rather than instead of it", () => {
    render(
      <RenderedWidgetCard
        widget={rendered({ id: "w9", type: "metric", value: "10", warning: "Partial data for this window." })}
        sourceId="overview_summary"
      />,
    );
    expect(document.querySelector('[data-widget-warning="w9"]')).not.toBeNull();
    expect(document.querySelector('[data-widget-value="w9"]')!.textContent).toBe("10");
  });
});

describe("CSV is offered only on tables", () => {
  it("offers export on a table source", () => {
    render(
      <RenderedWidgetCard widget={rendered({ id: "c1", rows: [{ name: "A" }] })} sourceId="meta_campaigns" />,
    );
    expect(document.querySelector('[data-widget-csv="c1"]')).not.toBeNull();
  });

  it("refuses on a metric card, with the reason", () => {
    render(
      <RenderedWidgetCard widget={rendered({ id: "c2", type: "metric", value: "3" })} sourceId="overview_summary" />,
    );
    expect(document.querySelector('[data-widget-csv="c2"]')).toBeNull();
    // The route would answer 400 table_widget_required; say exactly that.
    expect(document.querySelector('[data-widget-csv-blocked="c2"]')!.textContent).toMatch(
      /not a table/,
    );
  });

  it("fails the guard closed when the definition could not be read", () => {
    render(<RenderedWidgetCard widget={rendered({ id: "c3", rows: [{ name: "A" }] })} sourceId={null} />);
    expect(document.querySelector('[data-widget-csv="c3"]')).toBeNull();
    expect(document.querySelector('[data-widget-csv-blocked="c3"]')!.textContent).toMatch(/withheld/);
  });
});

describe("the canonical report UI has no mint or share control", () => {
  it("renders prerequisites instead of a button", () => {
    render(<ReportShareDisabled />);
    expect(document.querySelector('[data-report-share="disabled"]')).not.toBeNull();
    expect(document.querySelectorAll("button").length).toBe(0);
    expect(document.querySelector("[data-share-prerequisites]")!.textContent).toMatch(
      /written operator authorization recorded in Appendix C/,
    );
  });

  it("has zero call sites to the report share mint endpoint", () => {
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
      }
      return out;
    }
    const files = [
      ...walk(path.join(ROOT, "components", "zero-base", "reports")),
      ...walk(path.join(ROOT, "lib", "zero-base", "reports")),
    ];
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
      expect(/\/share/.test(source) && /fetch\(/.test(source), path.basename(file)).toBe(false);
    }
  });
});

describe("library", () => {
  it("offers create and duplicate but never share", async () => {
    const onCreate = vi.fn();
    const onDuplicate = vi.fn();
    render(
      <ZeroBasePortalHost>
        <ReportLibraryView
          reports={[{ id: "r1", name: "Weekly", updatedAt: "2026-08-01" }]}
          onCreate={onCreate}
          onDuplicate={onDuplicate}
        />
      </ZeroBasePortalHost>,
    );
    const user = userEvent.setup();
    await user.click(document.querySelector("[data-report-create]") as HTMLElement);
    await user.click(document.querySelector('[data-report-duplicate="r1"]') as HTMLElement);
    expect(onCreate).toHaveBeenCalled();
    expect(onDuplicate).toHaveBeenCalledWith("r1");
    expect(document.body.textContent).not.toMatch(/share/i);
  });

  it("states an empty library rather than rendering nothing", () => {
    render(
      <ZeroBasePortalHost>
        <ReportLibraryView reports={[]} />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector('[data-reports="empty"]')).not.toBeNull();
  });
});


describe("the builder refuses to save without a name", () => {
  it("disables save until one is given, because both routes require it", () => {
    render(
      <ZeroBasePortalHost>
        <ReportBuilderView initial={{ widgets: [] }} name="" />
      </ZeroBasePortalHost>,
    );
    const button = document.querySelector("[data-builder-save]") as HTMLButtonElement;
    expect(button.getAttribute("aria-disabled") ?? button.disabled).toBeTruthy();
  });

  it("collects the name on the surface", () => {
    render(
      <ZeroBasePortalHost>
        <ReportBuilderView initial={{ widgets: [] }} name="Weekly" />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector("[data-report-name]")).not.toBeNull();
  });
});
