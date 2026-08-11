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
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ReportBuilderView,
  ReportLibraryView,
  ReportShareDisabled,
  ReportWidget,
} from "@/components/zero-base/reports/report-views";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { COMING_SOON_SOURCES, RENDERABLE_SOURCES } from "@/lib/zero-base/reports/report-catalog";

afterEach(cleanup);

const ROOT = process.cwd();

describe("the source picker shows all nine, disabling four", () => {
  it("offers every renderable source and disables every coming-soon one", () => {
    render(
      <ZeroBasePortalHost>
        <ReportBuilderView initial={{ widgets: [] }} />
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
        <ReportBuilderView initial={{ widgets: [] }} />
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

describe("a failing widget keeps its neighbours", () => {
  it("shows its own error and retry", async () => {
    const onRetry = vi.fn();
    render(
      <ZeroBasePortalHost>
        <div>
          <ReportWidget sourceId="meta_campaigns" loaded failed rows={[]} onRetry={onRetry} />
          <ReportWidget sourceId="channel_attribution" loaded failed={false} rows={[{ id: "1", channel: "Meta" }]} />
        </div>
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector('[data-report-widget="meta_campaigns"] [data-widget-state="error"]')).not.toBeNull();
    // The neighbour still rendered.
    expect(
      document.querySelector('[data-report-widget="channel_attribution"] [data-widget-state="ready"]'),
    ).not.toBeNull();

    await userEvent.setup().click(document.querySelector('[data-widget-retry="meta_campaigns"]') as HTMLElement);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the empty grammar rather than zeros", () => {
    render(<ReportWidget sourceId="meta_campaigns" loaded failed={false} rows={[]} />);
    expect(document.querySelector('[data-widget-state="empty"]')!.textContent).toMatch(
      /No Meta campaigns served/,
    );
  });
});

describe("CSV is offered only on tables", () => {
  it("offers export on a table source", () => {
    render(<ReportWidget sourceId="meta_campaigns" loaded failed={false} rows={[{ id: "1" }]} />);
    expect(document.querySelector('[data-widget-csv="meta_campaigns"]')).not.toBeNull();
  });

  it("refuses on a metric card, with the reason", () => {
    render(<ReportWidget sourceId="overview_summary" loaded failed={false} rows={[{ id: "1" }]} />);
    expect(document.querySelector('[data-widget-csv="overview_summary"]')).toBeNull();
    expect(document.querySelector('[data-widget-csv-blocked="overview_summary"]')!.textContent).toMatch(
      /does not match what you are looking at/,
    );
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
