// @vitest-environment jsdom

/**
 * WP-05C proofs, plus the WP-05 acceptance check.
 *
 * The acceptance criterion is that every component in the vendored
 * `spec/semantics.js` maps to a production primitive or to an explicitly
 * documented native element. The map lives in `component-map.ts`; this asserts
 * it covers the vendored list exactly, so a component added to the design
 * cannot be quietly skipped.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WidgetGrid, UNDO_DEPTH, type WidgetPlacement } from "@/components/zero-base/collections/widget-grid";
import { MediaPlayer } from "@/components/zero-base/states/live-region";
import { ScopeSheet, SCOPE_FACT_IDS } from "@/components/zero-base/primitives/scope-sheet";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { ZERO_BASE_ROOT_ATTRIBUTE, ZERO_BASE_ROOT_VALUE } from "@/lib/design/ledger-tokens";
import { readFileSync } from "node:fs";
import path from "node:path";

import { COMPONENT_MAP } from "@/components/zero-base/component-map";

/** Component names as declared in the vendored spec, read fresh from disk. */
function vendoredComponentNames(): string[] {
  const source = readFileSync(
    path.join(process.cwd(), "docs", "zero-base-design", "v3", "spec", "semantics.js"),
    "utf8",
  );
  // Each entry is `S("Component name", "<native>", ...)`.
  return [...source.matchAll(/^S\("((?:[^"\\]|\\.)*)"/gm)].map((match) => match[1]);
}

afterEach(cleanup);

function Canonical({ children }: { children: React.ReactNode }) {
  return (
    <div {...{ [ZERO_BASE_ROOT_ATTRIBUTE]: ZERO_BASE_ROOT_VALUE }}>
      <ZeroBasePortalHost>{children}</ZeroBasePortalHost>
    </div>
  );
}

describe("WidgetGrid", () => {
  const initial: WidgetPlacement[] = [
    { id: "a", title: "Spend", row: 1, column: 1, width: 1, height: 1 },
    { id: "b", title: "ROAS", row: 1, column: 2, width: 1, height: 1 },
  ];

  function Harness({ onChange }: { onChange?: (next: WidgetPlacement[]) => void }) {
    const [widgets, setWidgets] = React.useState(initial);
    return (
      <WidgetGrid
        widgets={widgets}
        columns={3}
        rows={3}
        onChange={(next) => {
          setWidgets(next);
          onChange?.(next);
        }}
      />
    );
  }

  it("names each widget with its position", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Spend — row 1, col 1, 1×1" })).toBeVisible();
  });

  it("moves one cell with an arrow key and announces the new position", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const widget = screen.getByRole("button", { name: /^Spend/ });
    widget.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("button", { name: "Spend — row 1, col 2, 1×1" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Spend — row 1, col 2, 1×1");
  });

  it("resizes with Shift and an arrow key", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("button", { name: /^Spend/ }).focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(screen.getByRole("button", { name: "Spend — row 1, col 1, 2×1" })).toBeVisible();
  });

  it("announces the edge rather than failing silently", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("button", { name: /^Spend/ }).focus();
    await user.keyboard("{ArrowLeft}");
    // Silence here is indistinguishable from a broken control.
    expect(screen.getByRole("status")).toHaveTextContent("Edge reached");
    expect(screen.getByRole("button", { name: "Spend — row 1, col 1, 1×1" })).toBeVisible();
  });

  it("undoes a move with Ctrl/Cmd+Z", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("button", { name: /^Spend/ }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Spend — row 1, col 2, 1×1" })).toBeVisible();

    await user.keyboard("{Control>}z{/Control}");
    expect(screen.getByRole("button", { name: "Spend — row 1, col 1, 1×1" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Undone.");
  });

  it("reverts the whole edit on Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("button", { name: /^Spend/ }).focus();
    await user.keyboard("{ArrowRight}{ArrowDown}");
    expect(screen.getByRole("button", { name: "Spend — row 2, col 2, 1×1" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Spend — row 1, col 1, 1×1" })).toBeVisible();
  });

  it("says so when there is nothing left to undo", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("button", { name: /^Spend/ }).focus();
    await user.keyboard("{Control>}z{/Control}");
    expect(screen.getByRole("status")).toHaveTextContent("Nothing to undo.");
  });

  it("bounds the undo history at 50 steps", () => {
    expect(UNDO_DEPTH).toBe(50);
  });

  it("offers pointer equivalents at mobile target size", () => {
    render(<Harness />);
    const nudge = screen.getByRole("button", { name: "Move Spend left one column" });
    expect(nudge.style.minHeight).toBe("44px");
  });
});

describe("MediaPlayer", () => {
  it("names the creative in the play control", () => {
    render(
      <MediaPlayer name="Summer hook v3" state="poster" onPlay={vi.fn()} onRetry={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Play — Summer hook v3" })).toBeVisible();
  });

  it("shows the verbatim code and a retry on failure, never a silent frame", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <MediaPlayer
        name="Summer hook v3"
        state="failed"
        errorCode="(#2108) media transcode failed"
        onPlay={vi.fn()}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("(#2108) media transcode failed")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("ScopeSheet", () => {
  const facts = {
    scopeContext: "Client",
    enteredFrom: null,
    providerLabel: "Meta",
    businessName: "Grandmix",
    providerAccountLabel: "act_298410771",
    evidenceWindowLabel: "Last 7 days",
    configuredCurrency: "USD",
    currencyProof: "configured-only" as const,
    businessTimezone: "Europe/Istanbul",
    timezoneProof: "disagreement" as const,
    freshness: "stale" as const,
    snapshotAt: "2026-08-10T14:02:00Z",
  };

  it("renders all eight named facts", async () => {
    render(
      <Canonical>
        <ScopeSheet open onOpenChange={vi.fn()} facts={facts} />
      </Canonical>,
    );
    const sheet = await screen.findByRole("dialog");
    for (const id of SCOPE_FACT_IDS) {
      expect(sheet.querySelector(`[data-scope-fact="${id}"]`), id).not.toBeNull();
    }
    // Eight, per the accepted design's H63: the sheet separates which provider
    // is in scope from which account, and names the scope context itself.
    expect(SCOPE_FACT_IDS).toHaveLength(8);
  });

  it("carries the proof state with the value, not just the value", async () => {
    render(
      <Canonical>
        <ScopeSheet open onOpenChange={vi.fn()} facts={facts} />
      </Canonical>,
    );
    const sheet = await screen.findByRole("dialog");
    // A bare "USD" would imply we observed it when we were only told it.
    expect(within(sheet).getByText(/USD · configured, not yet observed/)).toBeVisible();
    expect(within(sheet).getByText(/disagrees with the account/)).toBeVisible();
  });

  it("renders a missing fact as an explicit unknown rather than omitting it", async () => {
    render(
      <Canonical>
        <ScopeSheet
          open
          onOpenChange={vi.fn()}
          facts={{
            ...facts,
            businessTimezone: null,
            timezoneProof: "missing",
            providerAccountLabel: null,
          }}
        />
      </Canonical>,
    );
    const sheet = await screen.findByRole("dialog");
    // Eight rows either way — a dropped row reads as "this fact agrees".
    expect(sheet.querySelectorAll("[data-scope-fact]")).toHaveLength(8);
    expect(within(sheet).getByText(/TZ Unknown · not set/)).toBeVisible();
    expect(within(sheet).getByText("None selected")).toBeVisible();
  });
});

describe("WP-05 acceptance — semantics coverage", () => {
  it("maps every vendored component to a primitive or a documented native element", () => {
    const vendored = vendoredComponentNames();
    expect(vendored.length).toBeGreaterThan(0);

    const mapped = new Set(COMPONENT_MAP.map((entry) => entry.component));
    const missing = vendored.filter((name) => !mapped.has(name));
    expect(missing, "components in semantics.js with no mapping").toEqual([]);
  });

  it("has no mapping for a component the design does not define", () => {
    const vendored = new Set(vendoredComponentNames());
    const extra = COMPONENT_MAP.filter((entry) => !vendored.has(entry.component));
    expect(extra.map((entry) => entry.component), "mappings with no vendored component").toEqual([]);
  });

  it("states an implementation for every mapping, and a reason for each native one", () => {
    for (const entry of COMPONENT_MAP) {
      expect(entry.implementation, entry.component).toBeTruthy();
      if (entry.kind === "native") {
        // A native element is a legitimate answer, but it has to be argued.
        expect(entry.note, `${entry.component} is native without a reason`).toBeTruthy();
      }
    }
  });
});
