// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CopyDetailDrawerExact,
  type CopyDetailDrawerExactViewModel,
} from "./CopyDetailDrawerExact";

afterEach(cleanup);

const CSS = readFileSync(
  join(process.cwd(), "components/creatives/CopyDetailDrawerExact.module.css"),
  "utf8",
);

function viewModel(
  over: Partial<CopyDetailDrawerExactViewModel> = {},
): CopyDetailDrawerExactViewModel {
  return {
    kind: "Primary Text · 24 chars",
    text: "fixture served copy line",
    angle: "—",
    angleTone: "neutral",
    stats: [
      { id: "see-more", label: "See more", value: "—", sub: "—" },
      { id: "ctr", label: "CTR", value: "1.72%", sub: "median 1.34%" },
      { id: "engage", label: "Engage", value: "—", sub: "—" },
      {
        id: "roas",
        label: "ROAS",
        value: "5.2",
        sub: "target 3.80",
        tone: "positive",
      },
    ],
    alternatesNote: "Used with this creative",
    alternates: [
      {
        id: "alt-1",
        angle: "—",
        angleTone: "neutral",
        text: "fixture alternate",
        why: "—",
        draftHref: null,
      },
    ],
    footnote: "fixture footnote",
    ...over,
  };
}

describe("CopyDetailDrawerExact geometry", () => {
  it("pins the design's 520px aside on the canvas with the 70px shadow", () => {
    expect(CSS).toContain("width: 520px");
    expect(CSS).toContain("background: #f3f5f9");
    expect(CSS).toContain("box-shadow: -28px 0 70px rgba(11, 16, 32, 0.35)");
    expect(CSS).toContain("background: rgba(11, 16, 32, 0.46)");
  });

  it("keeps the stat sub-line on the mono face, matching its label", () => {
    expect(CSS).toMatch(/\.statSub \{[^}]*IBM Plex Mono/);
    expect(CSS).toMatch(/\.statLabel \{[^}]*IBM Plex Mono/);
  });

  it("renders the footnote on the mono face at body level", () => {
    expect(CSS).toMatch(/\.footnote \{[^}]*IBM Plex Mono/);
    expect(CSS).toMatch(/\.footnote \{[^}]*font-size: 10px/);
  });

  it("tones the stat value rather than hard-coding one ink", () => {
    expect(CSS).toContain(".statValue.tonePositive");
    expect(CSS).toContain(".statValue.toneNegative");
  });
});

describe("CopyDetailDrawerExact composition", () => {
  it("renders the eyebrow with the asset type and the character count", () => {
    render(<CopyDetailDrawerExact onClose={vi.fn()} viewModel={viewModel()} />);
    expect(
      screen.getByText("Copy detail · Primary Text · 24 chars"),
    ).toBeInTheDocument();
  });

  it("renders the design's four stat tiles in order", () => {
    const { container } = render(
      <CopyDetailDrawerExact onClose={vi.fn()} viewModel={viewModel()} />,
    );
    const labels = Array.from(
      container.querySelectorAll('[class*="statLabel"]'),
    ).map((node) => node.textContent);
    expect(labels).toEqual(["See more", "CTR", "Engage", "ROAS"]);
  });

  it("shows alternate lines without an empty Read card", () => {
    render(<CopyDetailDrawerExact onClose={vi.fn()} viewModel={viewModel()} />);
    expect(screen.queryByText("Read")).not.toBeInTheDocument();
    expect(screen.getByText("Alternative lines")).toBeInTheDocument();
    expect(screen.getByText("Used with this creative")).toBeInTheDocument();
    expect(screen.getByText("fixture footnote")).toBeInTheDocument();
  });

  it("keeps only the working Close action in the footer", () => {
    render(<CopyDetailDrawerExact onClose={vi.fn()} viewModel={viewModel()} />);
    expect(screen.queryByText(/Draft all/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("keeps one em-dashed alternate row when the provider served none", () => {
    const { container } = render(
      <CopyDetailDrawerExact
        onClose={vi.fn()}
        viewModel={viewModel({ alternates: [] })}
      />,
    );
    expect(
      container.querySelector('[data-copy-alternate="none"]'),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Draft →" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the working single-line Launchpad draft callback", () => {
    const onDraftAlternate = vi.fn();
    render(
      <CopyDetailDrawerExact
        onClose={vi.fn()}
        onDraftAlternate={onDraftAlternate}
        viewModel={viewModel()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Draft →" }));
    expect(onDraftAlternate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "alt-1", text: "fixture alternate" }),
    );
  });

  it("closes on the backdrop, the close glyph, the footer Close and Escape", () => {
    const onClose = vi.fn();
    const { container } = render(
      <CopyDetailDrawerExact onClose={onClose} viewModel={viewModel()} />,
    );
    fireEvent.click(
      container.querySelector('[data-testid="copy-detail-drawer"]')!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close copy detail" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});
