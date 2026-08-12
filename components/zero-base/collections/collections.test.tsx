// @vitest-environment jsdom

/**
 * WP-05B proofs: table semantics, collection disclosure, chart/table parity.
 *
 * The through-line is that a missing value must never be rendered as zero, in
 * any of the three surfaces — a table cell, a chart point, or a count line.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Collection } from "@/components/zero-base/collections/collection";
import { DataTable, MetricCell } from "@/components/zero-base/collections/data-table";
import { Chart } from "@/components/zero-base/charts/chart";
import {
  SURFACE_STATE_KINDS,
  truncationDisclosure,
  type CollectionEnvelope,
} from "@/lib/zero-base/state-types";

afterEach(cleanup);

interface Row {
  id: string;
  name: string;
  spend: number;
}

const rows: Row[] = [
  { id: "1", name: "Prospecting", spend: 8214 },
  { id: "2", name: "Retargeting", spend: 3120 },
];

function envelope(overrides: Partial<CollectionEnvelope<Row>> = {}): CollectionEnvelope<Row> {
  return {
    items: rows,
    servedCount: 2,
    totalCount: 2,
    cap: 50,
    nextCursor: null,
    truncated: false,
    disclosure: null,
    ...overrides,
  };
}

describe("DataTable", () => {
  it("renders a real table with column and row scopes", () => {
    render(
      <DataTable
        caption="Campaigns"
        rows={rows}
        rowKey={(row) => row.id}
        columns={[
          { id: "name", header: "Campaign", render: (row) => row.name },
          { id: "spend", header: "Spend", numeric: true, render: (row) => row.spend },
        ]}
      />,
    );
    const table = screen.getByRole("table", { name: "Campaigns" });
    // Column headers must be real <th scope=col>, not styled divs.
    const columnHeaders = within(table).getAllByRole("columnheader");
    expect(columnHeaders.map((h) => h.textContent)).toEqual(["Campaign", "Spend"]);
    for (const header of columnHeaders) expect(header).toHaveAttribute("scope", "col");

    // The first column is the row header, so cells announce with their row.
    const rowHeaders = within(table).getAllByRole("rowheader");
    expect(rowHeaders.map((h) => h.textContent)).toEqual(["Prospecting", "Retargeting"]);
    for (const header of rowHeaders) expect(header).toHaveAttribute("scope", "row");
  });

  it("changes padding but never type size between densities", () => {
    const { rerender } = render(
      <DataTable
        caption="Campaigns"
        rows={rows}
        rowKey={(row) => row.id}
        density="comfortable"
        columns={[{ id: "name", header: "Campaign", render: (row) => row.name }]}
      />,
    );
    const comfortable = screen.getByRole("table").style.fontSize;
    rerender(
      <DataTable
        caption="Campaigns"
        rows={rows}
        rowKey={(row) => row.id}
        density="dense"
        columns={[{ id: "name", header: "Campaign", render: (row) => row.name }]}
      />,
    );
    expect(screen.getByRole("table").style.fontSize).toBe(comfortable);
    expect(Number.parseInt(comfortable, 10)).toBeGreaterThanOrEqual(12);
  });
});

describe("MetricCell", () => {
  it("renders an unavailable metric as an em dash with its reason, never 0", () => {
    render(<MetricCell metric={{ state: "unavailable", reason: "CPA not served at ad grain." }} />);
    const cell = screen.getByText("—", { exact: false });
    expect(cell).toBeVisible();
    expect(screen.getByText(/CPA not served at ad grain/)).toBeInTheDocument();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("labels a configured-but-unproven currency instead of implying it was observed", () => {
    render(
      <MetricCell
        metric={{
          state: "available",
          value: 8214,
          unit: "currency",
          currency: "USD",
          currencyProven: false,
          sourceAsOf: null,
        }}
      />,
    );
    expect(screen.getByText("(configured)")).toBeVisible();
  });

  it("does not label a proven currency", () => {
    render(
      <MetricCell
        metric={{
          state: "available",
          value: 8214,
          unit: "currency",
          currency: "USD",
          currencyProven: true,
          sourceAsOf: null,
        }}
      />,
    );
    expect(screen.queryByText("(configured)")).toBeNull();
  });
});

describe("Collection disclosure", () => {
  it("states X of Y when the server truncated", () => {
    render(
      <Collection envelope={envelope({ servedCount: 50, totalCount: 214, truncated: true })} state={{ kind: "ready" }}>
        <p>rows</p>
      </Collection>,
    );
    expect(screen.getByText(/Showing 50 of 214/)).toBeVisible();
    expect(screen.getByText(/Capped at 50/)).toBeVisible();
  });

  it("says the total is unknown rather than implying the served count is it", () => {
    expect(truncationDisclosure({ servedCount: 50, totalCount: null, cap: 50, truncated: true })).toBe(
      "Showing 50. More exist than can be counted here.",
    );
    // Not truncated ⇒ no disclosure, so nothing reassuring is invented.
    expect(truncationDisclosure({ servedCount: 3, totalCount: 3, cap: 50, truncated: false })).toBeNull();
  });

  it("disables Load more at the end of the projection, with the reason", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    render(
      <Collection envelope={envelope({ nextCursor: null })} state={{ kind: "ready" }} onLoadMore={onLoadMore}>
        <p>rows</p>
      </Collection>,
    );
    const button = screen.getByRole("button", { name: "Load more" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(screen.getByText("All 2 are shown.")).toBeVisible();
  });

  it("renders each blocking state instead of the rows", () => {
    for (const kind of SURFACE_STATE_KINDS.filter((k) => k !== "ready" && k !== "loading")) {
      cleanup();
      render(
        <Collection
          envelope={envelope()}
          state={{ kind, reason: `reason for ${kind}` } as never}
        >
          <p>rows should not appear</p>
        </Collection>,
      );
      expect(screen.queryByText("rows should not appear")).toBeNull();
      expect(screen.getByTestId(`state-${kind}`)).toBeVisible();
    }
  });
});

describe("Chart / table parity", () => {
  const series = [
    {
      id: "spend",
      label: "Spend",
      points: [
        { label: "Mon", value: 100 },
        { label: "Tue", value: null },
        { label: "Wed", value: 300 },
      ],
    },
  ];

  it("shows the same values in the table view as the chart plots", async () => {
    const user = userEvent.setup();
    render(<Chart title="Daily spend" series={series} />);

    await user.click(screen.getByRole("button", { name: "View as table" }));
    const table = screen.getByRole("table", { name: /Daily spend — table view/ });
    const cells = within(table).getAllByRole("cell");
    // 100, gap, 300 — exactly the plotted points, from the same array.
    expect(cells.map((cell) => cell.textContent)).toEqual(["100", "—", "300"]);
  });

  it("renders a gap rather than a zero for a missing point", async () => {
    const user = userEvent.setup();
    const { container } = render(<Chart title="Daily spend" series={series} />);

    // Two separate polylines: the null breaks the line instead of dragging it
    // to the axis, which would read as a day of zero spend.
    expect(container.querySelectorAll("polyline")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "View as table" }));
    expect(within(screen.getByRole("table")).getByText("—")).toBeVisible();
  });

  it("exposes the toggle as a pressed-state button and swaps in real table markup", async () => {
    const user = userEvent.setup();
    render(<Chart title="Daily spend" series={series} />);
    const toggle = screen.getByRole("button", { name: "View as table" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("table")).toBeNull();

    await user.click(toggle);
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("button", { name: "View as chart" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders the unavailable panel instead of an empty chart", () => {
    render(<Chart title="Daily spend" series={[]} unavailableReason="No spend series at this grain." />);
    expect(screen.getByTestId("state-unavailable")).toHaveTextContent("No spend series at this grain.");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
